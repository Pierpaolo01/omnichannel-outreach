import type { CallAnswer } from "../../src/domain/sequence/attempt.ts";
import type { AccountStatus, AttemptRef, HandoverRequest, InviteWithdrawal, LookupResult, PresendRequest, PresendResult, ProviderEvent, SendPort, Transport } from "../../src/server/engine/ports.ts";
import type { RenderedCopy } from "../../src/domain/sequence/state.ts";

/**
 * A simulated LinkedIn provider for the engine's tests (ADR 0004). No LinkedIn session is connected (#28) and the
 * repository's rules allow none: this drives no browser, opens no page and makes no network call, and the running
 * application never registers it. Its sessions are labelled "Simulated LinkedIn (not a session)". Like the email and SMS
 * fakes it keeps its own logs (handovers, deliveries, acceptances, withdrawals), which the tests read instead of the
 * application's records. Every profile is fictitious; a test scripts each one.
 */

const MINUTE = 60_000;

export interface FakeSession {
  readonly id: string;
  readonly gapMs: number | null;
  readonly k: number;
  /** False: signed out at the provider. */
  healthy: boolean;
  /** The user's zone: a social account's allowances reset there (ADR 0004 1.1). */
  readonly resetZone: string;
  /** False: the port no longer lists the session at all. */
  listed?: boolean;
}

/** How one fictitious profile behaves, scripted by a test (ADR 0004 10.2). */
export interface ProfileScript {
  /** The sender is already connected to it before any invite. */
  readonly connected?: boolean;
  /** It accepts an invite this long after the invite was sent; absent or null: never. */
  readonly acceptAfterMs?: number | null;
  /** The platform reports the acceptance this long after it happened. */
  readonly acceptReportDelayMs?: number;
  /** Every action to it is refused: the profile does not exist or cannot be reached. */
  readonly unreachable?: boolean;
  /** Its next actions are refused for a limit (a rate limit at the platform), this many times. */
  rateLimited?: number;
  /** Its next actions are done but their answer is lost (`unknown`), this many times: only a lookup finds them. */
  loseAnswer?: number;
  /** Its next withdrawals answer `unknown`, this many times, before they take effect. */
  withdrawUnknown?: number;
  /** An invite to the profile is already pending, sent by hand outside this application (the pre-send check: `pending`). */
  pendingElsewhere?: boolean;
  /** The connection is removed after acceptance: a message is refused `not_connected`. */
  readonly connectionRemoved?: boolean;
}

export interface LinkedinDelivery {
  readonly at: number;
  readonly key: string;
  readonly subjectId: string;
  readonly trackId: string;
  readonly stepId: string;
  readonly sender: string;
  readonly destination: string;
  readonly action: "invite" | "message";
  readonly rendered: RenderedCopy;
  readonly providerRef: string;
  readonly visibleAt: number;
}

interface Invite {
  readonly key: string;
  readonly sender: string;
  readonly profile: string;
  readonly providerRef: string;
  readonly sentAt: number;
  acceptedAt: number | null;
  withdrawnAt: number | null;
}

export class FakeLinkedInPort implements SendPort {
  readonly channel = "linkedin";
  readonly handoverLog: { at: number; key: string; attemptId: string; sender: string; destination: string; subjectId: string; trackId: string; stepId: string; action: "invite" | "message"; rendered: RenderedCopy }[] = [];
  readonly deliveryLog: LinkedinDelivery[] = [];
  readonly acceptanceLog: { at: number; key: string; sender: string; profile: string }[] = [];
  readonly withdrawalLog: { at: number; key: string; answer: InviteWithdrawal["kind"] }[] = [];
  readonly presendLog: { at: number; sender: string; destination: string; answer: PresendResult["kind"] }[] = [];
  readonly lookupLog: { at: number; key: string; answer: LookupResult["kind"] }[] = [];
  readonly refusals: { at: number; key: string; destination: string; reason: string }[] = [];
  readonly sessions: Map<string, FakeSession>;
  readonly profiles = new Map<string, ProfileScript>();
  private readonly now: () => number;
  private readonly invites: Invite[] = [];
  private readonly events: { visibleAt: number; event: ProviderEvent }[] = [];
  private nextRef = 0;

  constructor(options: { readonly now: () => number; readonly sessions: readonly FakeSession[] }) {
    this.now = options.now;
    this.sessions = new Map(options.sessions.map((s) => [s.id, s]));
  }

  /** A browser session has no idempotency key: a repeat could act twice, so nothing is retried (ADR 0004 2.2). */
  transportFor(): Transport {
    return { retryable: false, notSentIsFinal: false };
  }

  accounts(): Promise<AccountStatus[]> {
    return Promise.resolve(
      [...this.sessions.values()]
        .filter((s) => s.listed !== false)
        // The port knows no allowance: the user's settings give the room (ADR 0004 1.2), so it reports none of its own.
        .map((s) => ({ id: s.id, channel: "linkedin" as const, label: `Simulated LinkedIn (not a session) ${s.id}`, capacity: 0, dailyLimit: 0, gapMs: s.gapMs, k: s.k, healthy: s.healthy, problem: s.healthy ? null : "signed_out", resetZone: s.resetZone, quotaAvailable: true })),
    );
  }

  private script(profile: string): ProfileScript {
    return this.profiles.get(profile) ?? {};
  }

  /** Whether the sender is connected to the profile now: scripted so, or an invite of its accepted by now. */
  connectedNow(sender: string, profile: string): boolean {
    const now = this.now();
    if (this.script(profile).connectionRemoved) return false;
    return this.script(profile).connected === true || this.invites.some((i) => i.sender === sender && i.profile === profile && i.acceptedAt !== null && i.acceptedAt <= now);
  }

  /** The pre-send check reads the connection (ADR 0004 2.3): never a reply. */
  presendCheck(request: PresendRequest): Promise<PresendResult> {
    const session = this.sessions.get(request.sender);
    const now = this.now();
    const outstanding = this.script(request.destination).pendingElsewhere === true || this.invites.some((i) => i.sender === request.sender && i.profile === request.destination && i.withdrawnAt === null && (i.acceptedAt === null || i.acceptedAt > now));
    const answer: PresendResult = !session?.healthy ? { kind: "unavailable" } : this.connectedNow(request.sender, request.destination) ? { kind: "connected" } : outstanding ? { kind: "pending" } : { kind: "clear" };
    this.presendLog.push({ at: this.now(), sender: request.sender, destination: request.destination, answer: answer.kind });
    return Promise.resolve(answer);
  }

  handover(request: HandoverRequest): Promise<CallAnswer> {
    const now = this.now();
    const action = request.action ?? "message";
    this.handoverLog.push({ at: now, key: request.idempotencyKey, attemptId: request.attemptId, sender: request.sender, destination: request.destination, subjectId: request.subjectId, trackId: request.trackId, stepId: request.stepId, action, rendered: request.rendered });
    const script = this.script(request.destination);
    const refuse = (reason: "invalid_destination" | "rate_limited" | "not_connected"): CallAnswer => {
      this.refusals.push({ at: now, key: request.idempotencyKey, destination: request.destination, reason });
      return { kind: "rejected", reason };
    };
    if (script.unreachable) return Promise.resolve(refuse("invalid_destination"));
    if ((script.rateLimited ?? 0) > 0) {
      script.rateLimited = (script.rateLimited ?? 1) - 1;
      return Promise.resolve(refuse("rate_limited"));
    }
    if (action === "message" && !this.connectedNow(request.sender, request.destination)) return Promise.resolve(refuse("not_connected"));
    const providerRef = `li-${++this.nextRef}`;
    const lost = (script.loseAnswer ?? 0) > 0;
    if (lost) script.loseAnswer = (script.loseAnswer ?? 1) - 1;
    this.deliveryLog.push({ at: now, key: request.idempotencyKey, subjectId: request.subjectId, trackId: request.trackId, stepId: request.stepId, sender: request.sender, destination: request.destination, action, rendered: request.rendered, providerRef, visibleAt: lost ? Infinity : now });
    if (!lost) this.emit(now, { id: `sent-${providerRef}`, kind: "sent", key: request.idempotencyKey, providerRef, sentAt: now });
    if (action === "invite") {
      const invite: Invite = { key: request.idempotencyKey, sender: request.sender, profile: request.destination, providerRef, sentAt: now, acceptedAt: null, withdrawnAt: null };
      this.invites.push(invite);
      if (script.acceptAfterMs != null) invite.acceptedAt = now + script.acceptAfterMs;
    }
    return Promise.resolve(lost ? { kind: "unknown" } : { kind: "accepted", providerRef });
  }

  private emit(visibleAt: number, event: ProviderEvent): void {
    this.events.push({ visibleAt: Math.max(visibleAt, this.now()), event });
  }

  /** Acceptances that have happened by now are logged and reported (after the profile's report delay). */
  advance(): void {
    const now = this.now();
    for (const i of this.invites) {
      if (i.acceptedAt === null || i.acceptedAt > now || i.withdrawnAt !== null && i.withdrawnAt <= i.acceptedAt) continue;
      if (this.acceptanceLog.some((a) => a.key === i.key)) continue;
      this.acceptanceLog.push({ at: i.acceptedAt, key: i.key, sender: i.sender, profile: i.profile });
      this.emit(i.acceptedAt + (this.script(i.profile).acceptReportDelayMs ?? 0), { id: `accepted-${i.providerRef}`, kind: "accepted", key: i.key, providerRef: i.providerRef, at: i.acceptedAt });
    }
  }

  nextActivityAt(): number | null {
    const now = this.now();
    const times = [
      ...this.invites.filter((i) => i.acceptedAt !== null && i.acceptedAt > now && i.withdrawnAt === null).map((i) => i.acceptedAt ?? Infinity),
      ...this.events.filter((e) => e.visibleAt > now && Number.isFinite(e.visibleAt)).map((e) => e.visibleAt),
    ];
    return times.length > 0 ? Math.min(...times) : null;
  }

  /** The person accepts the invite the user sent by hand outside the application: they are connected from now. */
  acceptElsewhere(profile: string): void {
    this.profiles.set(profile, { ...this.script(profile), pendingElsewhere: false, connected: true });
  }

  /** The user accepts a test invite on their own profile now (ADR 0004 section 8): what a person does by hand. */
  acceptNow(profile: string): boolean {
    const invite = this.invites.find((i) => i.profile === profile && i.acceptedAt === null && i.withdrawnAt === null);
    if (!invite) return false;
    invite.acceptedAt = this.now();
    this.advance();
    return true;
  }

  withdraw(): Promise<"unknown"> {
    // A sent invite or message cannot be called back by the quiesce path; an invite is withdrawn only by `withdrawInvite`.
    return Promise.resolve("unknown");
  }

  withdrawInvite(ref: AttemptRef): Promise<InviteWithdrawal> {
    const now = this.now();
    const invite = this.invites.find((i) => i.key === ref.idempotencyKey);
    const script = invite ? this.script(invite.profile) : {};
    let answer: InviteWithdrawal;
    if (!invite) answer = { kind: "unknown" };
    else if ((script.withdrawUnknown ?? 0) > 0) {
      script.withdrawUnknown = (script.withdrawUnknown ?? 1) - 1;
      answer = { kind: "unknown" };
    } else if (invite.acceptedAt !== null && invite.acceptedAt <= now) answer = { kind: "already_accepted", at: invite.acceptedAt };
    else {
      invite.withdrawnAt = invite.withdrawnAt ?? now;
      answer = { kind: "withdrawn" };
    }
    this.withdrawalLog.push({ at: now, key: ref.idempotencyKey, answer: answer.kind });
    return Promise.resolve(answer);
  }

  observe(checkpoint: string | null): Promise<{ events: ProviderEvent[]; checkpoint: string }> {
    const now = this.now();
    const since = checkpoint === null ? -Infinity : Number(checkpoint) - 60 * MINUTE;
    const events = this.events.filter((e) => e.visibleAt > since && e.visibleAt <= now).sort((a, b) => a.visibleAt - b.visibleAt).map((e) => e.event);
    return Promise.resolve({ events, checkpoint: String(now) });
  }

  /** The session reads the profile or the thread: the action done is `sent`; none is `not-sent`, which is not final. */
  lookup(ref: AttemptRef): Promise<LookupResult> {
    const d = this.deliveryLog.find((x) => x.key === ref.idempotencyKey);
    const answer: LookupResult = d ? { kind: "sent", sentAt: d.at, providerRef: d.providerRef } : { kind: "not-sent" };
    this.lookupLog.push({ at: this.now(), key: ref.idempotencyKey, answer: answer.kind });
    return Promise.resolve(answer);
  }
}
