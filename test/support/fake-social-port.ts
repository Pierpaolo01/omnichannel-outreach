import type { CallAnswer } from "../../src/domain/sequence/attempt.ts";
import type { RenderedCopy } from "../../src/domain/sequence/state.ts";
import { SOCIAL_CHANNELS, type MessageRequestChannel, type SocialSenderKind } from "../../src/domain/social-channels.ts";
import type { AccountStatus, AttemptRef, HandoverRequest, LookupResult, PresendRequest, PresendResult, ProviderEvent, SendPort, Transport } from "../../src/server/engine/ports.ts";

/**
 * A simulated provider for a message-request channel (ADR 0004 13.1), Instagram now and Facebook with ticket 26, for the
 * engine's tests. No session is connected (#28) and the repository's rules allow none: this drives no browser, opens no
 * page and makes no network call, and the running application never registers it. Its sessions are labelled "Simulated
 * Instagram (not a session)" wherever a sender is named. It keeps its own logs (handovers, deliveries, refusals, lookups),
 * which the tests read instead of the application's records. Every account is fictitious; a test scripts each one.
 */

const MINUTE = 60_000;

export interface FakeSocialSession {
  readonly id: string;
  /** What the session is: a personal profile or a business account (a Page, on Facebook). */
  readonly kind: SocialSenderKind;
  readonly gapMs: number | null;
  readonly k: number;
  /** False: signed out at the platform. */
  healthy: boolean;
  /** The user's zone: a social account's allowances reset there (ADR 0004 1.1). */
  readonly resetZone: string;
  /** False: the port no longer lists the session at all. */
  listed?: boolean;
}

/** How one fictitious account behaves, scripted by a test (ADR 0004 13.9). */
export interface AccountScript {
  /** Every message to it is refused: the account does not exist or cannot be reached. */
  readonly unreachable?: boolean;
  /** Every message to it is refused as not allowed (requests turned off, or a sender that cannot start a conversation there). */
  readonly notAllowed?: boolean;
  /** Its next messages are refused for a limit (a rate limit at the platform), this many times. */
  rateLimited?: number;
  /** Its next messages are sent but their answer is lost (`unknown`), this many times: only a lookup finds them. */
  loseAnswer?: number;
  /** Lookups of messages to it answer `unknown` (the thread could not be read), this many times. */
  lookupUnknown?: number;
}

export interface SocialDelivery {
  readonly at: number;
  readonly key: string;
  readonly subjectId: string;
  readonly trackId: string;
  readonly stepId: string;
  readonly sender: string;
  readonly destination: string;
  readonly rendered: RenderedCopy;
  readonly providerRef: string;
  readonly visibleAt: number;
}

export class FakeSocialPort implements SendPort {
  readonly channel: MessageRequestChannel;
  readonly handoverLog: { at: number; key: string; attemptId: string; sender: string; destination: string; subjectId: string; trackId: string; stepId: string; action: "invite" | "message"; rendered: RenderedCopy }[] = [];
  readonly deliveryLog: SocialDelivery[] = [];
  readonly presendLog: { at: number; sender: string; destination: string; answer: PresendResult["kind"] }[] = [];
  readonly lookupLog: { at: number; key: string; answer: LookupResult["kind"] }[] = [];
  readonly refusals: { at: number; key: string; destination: string; reason: string }[] = [];
  readonly sessions: Map<string, FakeSocialSession>;
  readonly accountsScript = new Map<string, AccountScript>();
  private readonly now: () => number;
  private readonly events: { visibleAt: number; event: ProviderEvent }[] = [];
  private nextRef = 0;

  constructor(options: { readonly channel: MessageRequestChannel; readonly now: () => number; readonly sessions: readonly FakeSocialSession[] }) {
    this.channel = options.channel;
    this.now = options.now;
    this.sessions = new Map(options.sessions.map((s) => [s.id, s]));
  }

  /** The label every test names a simulated session by: it is not a session. */
  static label(channel: MessageRequestChannel, id: string): string {
    return `Simulated ${SOCIAL_CHANNELS[channel].name} (not a session) ${id}`;
  }

  /** A browser session has no idempotency key: a repeat could act twice, so nothing is retried (ADR 0004 2.2). */
  transportFor(): Transport {
    return { retryable: false, notSentIsFinal: false };
  }

  accounts(): Promise<AccountStatus[]> {
    return Promise.resolve(
      [...this.sessions.values()]
        .filter((s) => s.listed !== false)
        // The port knows no allowance: the user's setting gives the room (ADR 0004 13.7), so it reports none of its own.
        .map((s) => ({ id: s.id, channel: this.channel, label: FakeSocialPort.label(this.channel, s.id), capacity: 0, dailyLimit: 0, gapMs: s.gapMs, k: s.k, healthy: s.healthy, problem: s.healthy ? null : "signed_out", resetZone: s.resetZone, quotaAvailable: true, socialKind: s.kind })),
    );
  }

  private script(account: string): AccountScript {
    return this.accountsScript.get(account) ?? {};
  }

  /** The pre-send check: whether the session can act now. It reads no reply and no relation (ADR 0004 13.3). */
  presendCheck(request: PresendRequest): Promise<PresendResult> {
    const answer: PresendResult = this.sessions.get(request.sender)?.healthy === true ? { kind: "clear" } : { kind: "unavailable" };
    this.presendLog.push({ at: this.now(), sender: request.sender, destination: request.destination, answer: answer.kind });
    return Promise.resolve(answer);
  }

  handover(request: HandoverRequest): Promise<CallAnswer> {
    const now = this.now();
    const action = request.action ?? "message";
    this.handoverLog.push({ at: now, key: request.idempotencyKey, attemptId: request.attemptId, sender: request.sender, destination: request.destination, subjectId: request.subjectId, trackId: request.trackId, stepId: request.stepId, action, rendered: request.rendered });
    const script = this.script(request.destination);
    const refuse = (reason: "invalid_destination" | "rate_limited" | "not_allowed"): CallAnswer => {
      this.refusals.push({ at: now, key: request.idempotencyKey, destination: request.destination, reason });
      return { kind: "rejected", reason };
    };
    // A message-request channel has no invite: one is a broken engine, refused and logged.
    if (action !== "message") return Promise.resolve(refuse("invalid_destination"));
    if (script.unreachable) return Promise.resolve(refuse("invalid_destination"));
    if (script.notAllowed) return Promise.resolve(refuse("not_allowed"));
    if ((script.rateLimited ?? 0) > 0) {
      script.rateLimited = (script.rateLimited ?? 1) - 1;
      return Promise.resolve(refuse("rate_limited"));
    }
    const providerRef = `${this.channel}-${++this.nextRef}`;
    const lost = (script.loseAnswer ?? 0) > 0;
    if (lost) script.loseAnswer = (script.loseAnswer ?? 1) - 1;
    this.deliveryLog.push({ at: now, key: request.idempotencyKey, subjectId: request.subjectId, trackId: request.trackId, stepId: request.stepId, sender: request.sender, destination: request.destination, rendered: request.rendered, providerRef, visibleAt: lost ? Infinity : now });
    if (!lost) this.events.push({ visibleAt: now, event: { id: `sent-${providerRef}`, kind: "sent", key: request.idempotencyKey, providerRef, sentAt: now } });
    return Promise.resolve(lost ? { kind: "unknown" } : { kind: "accepted", providerRef });
  }

  nextActivityAt(): number | null {
    const now = this.now();
    const times = this.events.filter((e) => e.visibleAt > now && Number.isFinite(e.visibleAt)).map((e) => e.visibleAt);
    return times.length > 0 ? Math.min(...times) : null;
  }

  withdraw(): Promise<"unknown"> {
    // A message a session sent cannot be called back.
    return Promise.resolve("unknown");
  }

  observe(checkpoint: string | null): Promise<{ events: ProviderEvent[]; checkpoint: string }> {
    const now = this.now();
    const since = checkpoint === null ? -Infinity : Number(checkpoint) - 60 * MINUTE;
    const events = this.events.filter((e) => e.visibleAt > since && e.visibleAt <= now).sort((a, b) => a.visibleAt - b.visibleAt).map((e) => e.event);
    return Promise.resolve({ events, checkpoint: String(now) });
  }

  /** The session reads the thread: the message there is `sent`; none is `not-sent`, which is not final. */
  lookup(ref: AttemptRef): Promise<LookupResult> {
    const d = this.deliveryLog.find((x) => x.key === ref.idempotencyKey);
    const script = d ? this.accountsScript.get(d.destination) : undefined;
    const unknown = script?.lookupUnknown !== undefined && script.lookupUnknown > 0;
    if (script && unknown) script.lookupUnknown = (script.lookupUnknown ?? 0) - 1;
    const answer: LookupResult = unknown ? { kind: "unknown" } : d ? { kind: "sent", sentAt: d.at, providerRef: d.providerRef } : { kind: "not-sent" };
    this.lookupLog.push({ at: this.now(), key: ref.idempotencyKey, answer: answer.kind });
    return Promise.resolve(answer);
  }
}
