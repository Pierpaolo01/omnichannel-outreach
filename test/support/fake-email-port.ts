import type { CallAnswer } from "../../src/domain/sequence/attempt.ts";
import type { RenderedCopy } from "../../src/domain/sequence/state.ts";
import type { AccountStatus, AttemptRef, HandoverRequest, LookupResult, ProviderEvent, SendPort, Transport } from "../../src/server/engine/ports.ts";

/**
 * A fake email provider for the engine's tests and the scripted scenario (ADR 0003 9.2). It keeps
 * its own **handover log** (every send call it received) and **delivery log** (what it actually
 * sent, with the send time), which the tests read instead of the application's records. Each call
 * runs in one of the ADR's modes. Data is fictitious; nothing here reaches a real provider.
 */

export const FAKE_MODES = [
  "honest",
  "lost-response",
  "late-send",
  "duplicate-and-reorder",
  "withdraw-unknown",
  "same-key-replays",
  "always-unknown",
  "non-retryable",
  "5xx",
  "late-send-beyond-settling",
  "lookup-lags",
] as const;
export type FakeMode = (typeof FAKE_MODES)[number];

const MINUTE = 60_000;
const SETTLING = 15 * MINUTE;

export interface FakeAccount {
  readonly id: string;
  capacity: number;
  readonly gapMs: number;
  readonly k: number;
  healthy: boolean;
  quotaAvailable: boolean;
  readonly resetZone: string;
}

export interface HandoverLogEntry {
  readonly at: number;
  readonly attemptId: string;
  readonly key: string;
  readonly sender: string;
  readonly destination: string;
  readonly subjectId: string;
  readonly stepId: string;
  readonly rendered: RenderedCopy;
  readonly threadRef: string | null;
  readonly mode: FakeMode;
  readonly retryable: boolean;
  /** Whether the provider reported the sending account healthy when the call arrived. */
  readonly healthy: boolean;
}

export interface DeliveryLogEntry {
  readonly at: number;
  readonly key: string;
  readonly subjectId: string;
  readonly stepId: string;
  readonly sender: string;
  readonly destination: string;
  readonly rendered: RenderedCopy;
  readonly providerRef: string;
  /** When the provider's sent event becomes visible to the app. */
  readonly visibleAt: number;
}

interface Work {
  readonly key: string;
  readonly request: HandoverRequest;
  readonly mode: FakeMode;
  readonly providerRef: string;
  readonly acceptedAt: number;
  sendAt: number | null;
  sentAt: number | null;
  cancelled: boolean;
  readonly lookupNotSentUntil: number;
  readonly lookupUnknown: boolean;
  readonly observeDelay: number;
}

export interface FakeEmailOptions {
  readonly now: () => number;
  readonly random: () => number;
  readonly accounts: readonly FakeAccount[];
  /** Modes calls are drawn from. */
  readonly modes: readonly FakeMode[];
}

export class FakeEmailPort implements SendPort {
  readonly channel = "email";
  readonly handoverLog: HandoverLogEntry[] = [];
  readonly deliveryLog: DeliveryLogEntry[] = [];
  readonly replyLog: { at: number; destination: string; id: string; threadRef: string }[] = [];
  readonly withdrawLog: { at: number; key: string }[] = [];
  /** Every lookup the fake answered. */
  readonly lookupLog: { at: number; key: string; answer: LookupResult["kind"] }[] = [];
  /** Every call the fake refused, with the reason it gave. */
  readonly refusals: { at: number; attemptId: string; destination: string; reason: string }[] = [];
  /** Answers the duplicate-and-reorder mode will deliver again later. */
  readonly staleAnswers: { attemptId: string; answer: CallAnswer }[] = [];
  readonly accountsById: Map<string, FakeAccount>;
  /** Addresses that hard-bounce once sent to, refused as block-listed, invalid, or skipped without reason. */
  readonly bouncing = new Set<string>();
  readonly blocklisted = new Set<string>();
  readonly invalid = new Set<string>();
  readonly unexplainedSkip = new Set<string>();
  /** Accounts answering 429 until the instant given. */
  readonly rateLimitedUntil = new Map<string, number>();
  presendUnavailable = false;
  /** Runs at every send call before it is answered: the tests' probe of the app's state at that moment. */
  onHandover: ((entry: HandoverLogEntry) => Promise<void>) | null = null;

  private readonly now: () => number;
  private readonly random: () => number;
  private readonly modes: readonly FakeMode[];
  private readonly work: Work[] = [];
  private readonly events: { visibleAt: number; event: ProviderEvent }[] = [];
  private nextRef = 0;

  constructor(options: FakeEmailOptions) {
    this.now = options.now;
    this.random = options.random;
    this.modes = options.modes;
    this.accountsById = new Map(options.accounts.map((a) => [a.id, a]));
  }

  private get allNonRetryable(): boolean {
    return this.modes.includes("non-retryable");
  }

  transportFor(step: { readonly threading: "new_subject" | "continue_thread" }): Transport {
    // Openers go through the keyed add; follow-ups through a reply transport with no key (ADR 0002).
    return { retryable: step.threading === "new_subject" && !this.allNonRetryable, notSentIsFinal: false };
  }

  accounts(): Promise<AccountStatus[]> {
    return Promise.resolve(
      [...this.accountsById.values()].map((a) => ({ id: a.id, channel: "email" as const, label: `Fake inbox ${a.id}`, capacity: a.capacity, gapMs: a.gapMs, k: a.k, healthy: a.healthy, resetZone: a.resetZone, quotaAvailable: a.quotaAvailable })),
    );
  }

  presendCheck(request: { sender: string; destination: string; threadRefs: readonly string[] }) {
    if (this.presendUnavailable) return Promise.resolve({ kind: "unavailable" as const });
    const reply = this.replyLog.find((r) => r.destination === request.destination && request.threadRefs.includes(r.threadRef) && r.at <= this.now());
    return Promise.resolve(reply ? { kind: "reply" as const, providerRef: reply.id, at: reply.at } : { kind: "clear" as const });
  }

  private pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.random() * items.length)];
    if (item === undefined) throw new Error("nothing to pick from");
    return item;
  }

  private emit(visibleAt: number, event: ProviderEvent): void {
    this.events.push({ visibleAt: Math.max(visibleAt, this.now()), event });
  }

  async handover(request: HandoverRequest): Promise<CallAnswer> {
    const now = this.now();
    const mode = this.pick(this.modes);
    const retryable = request.threading === "new_subject" && !this.allNonRetryable;
    const entry: HandoverLogEntry = {
      at: now,
      attemptId: request.attemptId,
      key: request.idempotencyKey,
      sender: request.sender,
      destination: request.destination,
      subjectId: request.subjectId,
      stepId: request.stepId,
      rendered: request.rendered,
      threadRef: request.threadRef,
      mode,
      retryable,
      healthy: this.accountsById.get(request.sender)?.healthy ?? false,
    };
    this.handoverLog.push(entry);
    await this.onHandover?.(entry);
    return this.answer(request, mode, retryable);
  }

  private answer(request: HandoverRequest, mode: FakeMode, retryable: boolean): Promise<CallAnswer> {
    return this.decide(request, mode, retryable).then((answer) => {
      if (answer.kind === "rejected") this.refusals.push({ at: this.now(), attemptId: request.attemptId, destination: request.destination, reason: answer.reason });
      return answer;
    });
  }

  private decide(request: HandoverRequest, mode: FakeMode, retryable: boolean): Promise<CallAnswer> {
    const now = this.now();
    const account = this.accountsById.get(request.sender);
    if (!account?.quotaAvailable) return Promise.resolve({ kind: "rejected", reason: "payment_required" });
    const limited = this.rateLimitedUntil.get(request.sender);
    if (limited !== undefined && now < limited) return Promise.resolve({ kind: "rejected", reason: "rate_limited", retryAfterMs: limited - now });
    if (this.blocklisted.has(request.destination)) return Promise.resolve({ kind: "rejected", reason: "blocklisted" });
    if (this.invalid.has(request.destination)) return Promise.resolve({ kind: "rejected", reason: "invalid_destination" });

    // A keyed transport never takes the same key twice: it reports what it already holds.
    if (retryable) {
      const existing = this.work.find((w) => w.key === request.idempotencyKey);
      if (existing) return Promise.resolve(mode === "always-unknown" || mode === "5xx" ? { kind: "unknown" } : { kind: "accepted", providerRef: existing.providerRef });
    }

    const accept = !(mode === "5xx" || mode === "always-unknown") || this.random() < 0.5;
    if (!accept) return Promise.resolve({ kind: "unknown" });
    const providerRef = `msg-${++this.nextRef}`;
    // Whole milliseconds, like every instant the app stores.
    const delay = Math.round(
      mode === "late-send" ? (1 + this.random() * 59) * MINUTE
      : mode === "withdraw-unknown" ? (5 + this.random() * 115) * MINUTE
      : mode === "late-send-beyond-settling" ? SETTLING * (1.5 + this.random() * 20)
      : mode === "lookup-lags" ? this.random() * 30 * MINUTE
      : 0,
    );
    const skip = this.unexplainedSkip.has(request.destination);
    const w: Work = {
      key: request.idempotencyKey,
      request,
      mode,
      providerRef,
      acceptedAt: now,
      sendAt: skip ? null : now + delay,
      sentAt: null,
      cancelled: false,
      lookupNotSentUntil: mode === "lookup-lags" ? now + Math.round((20 + this.random() * 20) * MINUTE) : 0,
      lookupUnknown: mode === "always-unknown",
      observeDelay: mode === "late-send" ? Math.round(this.random() * 30 * MINUTE) : 0,
    };
    this.work.push(w);
    if (skip) this.emit(now + 10 * MINUTE, { id: `rej-${providerRef}`, kind: "rejected", key: w.key, providerRef, reason: "provider_skipped" });
    this.advance();

    const accepted: CallAnswer = { kind: "accepted", providerRef };
    switch (mode) {
      case "lost-response":
      case "same-key-replays":
      case "always-unknown":
      case "5xx":
      case "lookup-lags":
        return Promise.resolve({ kind: "unknown" });
      case "non-retryable":
        return Promise.resolve(this.random() < 0.5 ? { kind: "unknown" } : accepted);
      case "duplicate-and-reorder":
        this.staleAnswers.push({ attemptId: request.attemptId, answer: accepted });
        return Promise.resolve(accepted);
      default:
        return Promise.resolve(accepted);
    }
  }

  /** Sends whatever is due by now. Call before every engine tick. */
  advance(): void {
    const now = this.now();
    for (const w of this.work) {
      if (w.cancelled || w.sentAt !== null || w.sendAt === null || w.sendAt > now) continue;
      w.sentAt = w.sendAt;
      this.deliveryLog.push({
        at: w.sentAt,
        key: w.key,
        subjectId: w.request.subjectId,
        stepId: w.request.stepId,
        sender: w.request.sender,
        destination: w.request.destination,
        rendered: w.request.rendered,
        providerRef: w.providerRef,
        visibleAt: w.sentAt + w.observeDelay,
      });
      const sent: ProviderEvent = { id: `sent-${w.providerRef}`, kind: "sent", key: w.key, providerRef: w.providerRef, sentAt: w.sentAt };
      this.emit(w.sentAt + w.observeDelay, sent);
      if (w.mode === "duplicate-and-reorder") this.emit(w.sentAt + w.observeDelay + 5 * MINUTE, sent);
      if (this.bouncing.has(w.request.destination)) {
        const bounce: ProviderEvent = { id: `bounce-${w.providerRef}`, kind: "bounced", key: w.key, providerRef: w.providerRef, at: w.sentAt + 5 * MINUTE };
        this.emit(w.sentAt + 5 * MINUTE, bounce);
      }
    }
  }

  /** The next instant the fake will do something on its own. */
  nextActivityAt(): number | null {
    const now = this.now();
    const times = [
      ...this.work.filter((w) => !w.cancelled && w.sentAt === null && w.sendAt !== null && w.sendAt > now).map((w) => w.sendAt ?? 0),
      ...this.events.filter((e) => e.visibleAt > now).map((e) => e.visibleAt),
      ...this.work.filter((w) => w.lookupNotSentUntil > now).map((w) => w.lookupNotSentUntil),
    ];
    return times.length > 0 ? Math.min(...times) : null;
  }

  /** The prospect at `destination` replies to the latest message they received. False if they have none. */
  prospectReplies(destination: string): boolean {
    const now = this.now();
    const last = this.deliveryLog.filter((d) => d.destination === destination && d.at <= now).at(-1);
    if (!last) return false;
    const id = `reply-${this.replyLog.length + 1}`;
    this.replyLog.push({ at: now, destination, id, threadRef: last.providerRef });
    this.emit(now, { id, kind: "reply", providerRef: last.providerRef, at: now });
    return true;
  }

  withdraw(attempt: AttemptRef): Promise<"withdrawn" | "too-late" | "unknown"> {
    this.withdrawLog.push({ at: this.now(), key: attempt.idempotencyKey });
    const w = this.work.filter((x) => x.key === attempt.idempotencyKey && (attempt.providerRef === null || x.providerRef === attempt.providerRef)).at(-1);
    if (!w) return Promise.resolve("unknown");
    if (w.sentAt !== null) return Promise.resolve("too-late");
    w.cancelled = true;
    return Promise.resolve(w.mode === "withdraw-unknown" || w.mode === "always-unknown" ? "unknown" : "withdrawn");
  }

  observe(checkpoint: string | null): Promise<{ events: ProviderEvent[]; checkpoint: string }> {
    const now = this.now();
    const since = checkpoint === null ? -Infinity : Number(checkpoint) - 60 * MINUTE;
    const visible = this.events.filter((e) => e.visibleAt > since && e.visibleAt <= now);
    // Results may arrive out of order: newest first.
    const events = visible.sort((a, b) => b.visibleAt - a.visibleAt).map((e) => e.event);
    return Promise.resolve({ events, checkpoint: String(now) });
  }

  lookup(attempt: AttemptRef): Promise<LookupResult> {
    return this.lookupTruth(attempt).then((answer) => {
      this.lookupLog.push({ at: this.now(), key: attempt.idempotencyKey, answer: answer.kind });
      return answer;
    });
  }

  private lookupTruth(attempt: AttemptRef): Promise<LookupResult> {
    const now = this.now();
    const all = this.work.filter((w) => w.key === attempt.idempotencyKey);
    const sent = all.find((w) => w.sentAt !== null && w.sentAt <= now);
    const w = all.at(-1);
    if (w?.lookupUnknown) return Promise.resolve({ kind: "unknown" });
    if (sent) return Promise.resolve({ kind: "sent", sentAt: sent.sentAt ?? now });
    if (!w || w.cancelled || w.sendAt === null) return Promise.resolve({ kind: "not-sent" });
    if (now < w.lookupNotSentUntil) return Promise.resolve({ kind: "not-sent" });
    return Promise.resolve({ kind: "queued" });
  }
}
