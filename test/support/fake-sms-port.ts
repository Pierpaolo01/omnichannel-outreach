import type { CallAnswer } from "../../src/domain/sequence/attempt.ts";
import type { AccountStatus, AttemptRef, HandoverRequest, LookupResult, ProviderEvent, SendPort, Transport } from "../../src/server/engine/ports.ts";
import type { DeliveryLogEntry, HandoverLogEntry } from "./fake-email-port.ts";

/**
 * A fake SMS provider for the engine's tests and the scripted scenario (ADR 0003 5.3, ticket 13).
 * No SMS provider is provisioned or chosen (#28): this is not an adapter for any real service, it
 * makes no network call, and the running application never registers it. Its numbers are labelled
 * "Simulated SMS (not a provider)". Like the fake email port, it keeps its own handover log and
 * delivery log, which the tests read instead of the application's records. Data is fictitious.
 */

export const FAKE_SMS_MODES = [
  "honest",
  /** It sends after a delay, so the send time comes before the app observes it. */
  "late-send",
  /** The text is accepted but the answer never arrives; lookup finds it. */
  "lost-response",
  /** Answers that must be read as unknown: the text may or may not go. */
  "5xx",
] as const;
export type FakeSmsMode = (typeof FAKE_SMS_MODES)[number];

const MINUTE = 60_000;

export interface FakeNumber {
  readonly id: string;
  capacity: number;
  readonly gapMs: number | null;
  readonly k: number;
  /** False: the number is disconnected at the provider. */
  healthy: boolean;
  /** The user's zone: an SMS number's daily capacity resets there (ADR 0003 4.1). */
  readonly resetZone: string;
  /** False: the provider no longer lists the number at all. */
  listed?: boolean;
}

interface Text {
  readonly key: string;
  readonly request: HandoverRequest;
  readonly providerRef: string;
  readonly sendAt: number;
  sentAt: number | null;
  cancelled: boolean;
  readonly observeDelay: number;
}

export class FakeSmsPort implements SendPort {
  readonly channel = "sms";
  readonly handoverLog: HandoverLogEntry[] = [];
  readonly deliveryLog: DeliveryLogEntry[] = [];
  /** Every text a prospect sent back: from their mobile to one of the numbers. */
  readonly replyLog: { at: number; id: string; from: string; to: string; body: string }[] = [];
  readonly refusals: { at: number; attemptId: string; destination: string; reason: string }[] = [];
  readonly lookupLog: { at: number; key: string; answer: LookupResult["kind"] }[] = [];
  readonly numbers: Map<string, FakeNumber>;
  /** Mobiles the provider refuses as invalid at the call. */
  readonly invalid = new Set<string>();
  /** Mobiles a text is sent to and then reported undeliverable (a "failed" status after the send). */
  readonly undeliverable = new Set<string>();
  onHandover: ((entry: HandoverLogEntry) => Promise<void>) | null = null;

  private readonly now: () => number;
  private readonly random: () => number;
  private readonly modes: readonly FakeSmsMode[];
  private readonly texts: Text[] = [];
  private readonly events: { visibleAt: number; event: ProviderEvent }[] = [];
  private nextRef = 0;

  constructor(options: { readonly now: () => number; readonly random?: () => number; readonly numbers: readonly FakeNumber[]; readonly modes?: readonly FakeSmsMode[] }) {
    this.now = options.now;
    this.random = options.random ?? (() => 0.5);
    this.modes = options.modes ?? ["honest"];
    this.numbers = new Map(options.numbers.map((n) => [n.id, n]));
  }

  /** A text has no idempotency key here: a repeat call could send twice, so it is never retried. */
  transportFor(): Transport {
    return { retryable: false, notSentIsFinal: false };
  }

  accounts(): Promise<AccountStatus[]> {
    return Promise.resolve(
      [...this.numbers.values()]
        .filter((n) => n.listed !== false)
        .map((n) => ({ id: n.id, channel: "sms" as const, label: `Simulated SMS (not a provider) ${n.id}`, capacity: n.capacity, gapMs: n.gapMs, k: n.k, healthy: n.healthy, resetZone: n.resetZone, quotaAvailable: true })),
    );
  }

  /** Replies arrive through observation; there is nothing to check before a text. */
  presendCheck(): Promise<{ kind: "clear" }> {
    return Promise.resolve({ kind: "clear" });
  }

  private pick(): FakeSmsMode {
    return this.modes[Math.floor(this.random() * this.modes.length)] ?? "honest";
  }

  async handover(request: HandoverRequest): Promise<CallAnswer> {
    const now = this.now();
    const mode = this.pick();
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
      mode: "honest",
      retryable: false,
      healthy: this.numbers.get(request.sender)?.healthy ?? false,
    };
    this.handoverLog.push(entry);
    await this.onHandover?.(entry);
    if (this.invalid.has(request.destination)) {
      this.refusals.push({ at: now, attemptId: request.attemptId, destination: request.destination, reason: "invalid_destination" });
      return { kind: "rejected", reason: "invalid_destination" };
    }
    if (mode === "5xx" && this.random() < 0.5) return { kind: "unknown" };
    const providerRef = `sms-${++this.nextRef}`;
    const delay = mode === "late-send" ? Math.round((1 + this.random() * 59) * MINUTE) : 0;
    this.texts.push({ key: request.idempotencyKey, request, providerRef, sendAt: now + delay, sentAt: null, cancelled: false, observeDelay: mode === "late-send" ? Math.round(this.random() * 30 * MINUTE) : 0 });
    this.advance();
    return mode === "lost-response" || mode === "5xx" ? { kind: "unknown" } : { kind: "accepted", providerRef };
  }

  private emit(visibleAt: number, event: ProviderEvent): void {
    this.events.push({ visibleAt: Math.max(visibleAt, this.now()), event });
  }

  /** Sends whatever is due by now. */
  advance(): void {
    const now = this.now();
    for (const t of this.texts) {
      if (t.cancelled || t.sentAt !== null || t.sendAt > now) continue;
      t.sentAt = t.sendAt;
      this.deliveryLog.push({
        at: t.sentAt,
        key: t.key,
        subjectId: t.request.subjectId,
        stepId: t.request.stepId,
        sender: t.request.sender,
        destination: t.request.destination,
        rendered: t.request.rendered,
        providerRef: t.providerRef,
        visibleAt: t.sentAt + t.observeDelay,
      });
      this.emit(t.sentAt + t.observeDelay, { id: `sent-${t.providerRef}`, kind: "sent", key: t.key, providerRef: t.providerRef, sentAt: t.sentAt });
      if (this.undeliverable.has(t.request.destination)) {
        this.emit(t.sentAt + 2 * MINUTE, { id: `failed-${t.providerRef}`, kind: "bounced", key: t.key, providerRef: t.providerRef, at: t.sentAt + 2 * MINUTE });
      }
    }
  }

  nextActivityAt(): number | null {
    const now = this.now();
    const times = [...this.texts.filter((t) => !t.cancelled && t.sentAt === null && t.sendAt > now).map((t) => t.sendAt), ...this.events.filter((e) => e.visibleAt > now).map((e) => e.visibleAt)];
    return times.length > 0 ? Math.min(...times) : null;
  }

  /**
   * The prospect at `from` texts `to` back: by default the number that last texted them. An SMS
   * reply carries only the two numbers, never a campaign. False if no number ever texted them and
   * none is given.
   */
  prospectTexts(from: string, body = "Thanks, not now", to: string | null = null): boolean {
    const now = this.now();
    const number = to ?? this.deliveryLog.filter((d) => d.destination === from && d.at <= now).at(-1)?.sender ?? null;
    if (number === null) return false;
    const id = `text-${this.replyLog.length + 1}`;
    this.replyLog.push({ at: now, id, from, to: number, body });
    this.emit(now, { id, kind: "reply", providerRef: null, at: now, inbox: number, from });
    return true;
  }

  withdraw(attempt: AttemptRef): Promise<"withdrawn" | "too-late" | "unknown"> {
    const t = this.texts.find((x) => x.key === attempt.idempotencyKey);
    if (!t) return Promise.resolve("unknown");
    if (t.sentAt !== null) return Promise.resolve("too-late");
    t.cancelled = true;
    return Promise.resolve("withdrawn");
  }

  observe(checkpoint: string | null): Promise<{ events: ProviderEvent[]; checkpoint: string }> {
    const now = this.now();
    const since = checkpoint === null ? -Infinity : Number(checkpoint) - 60 * MINUTE;
    const events = this.events.filter((e) => e.visibleAt > since && e.visibleAt <= now).sort((a, b) => a.visibleAt - b.visibleAt).map((e) => e.event);
    return Promise.resolve({ events, checkpoint: String(now) });
  }

  lookup(attempt: AttemptRef): Promise<LookupResult> {
    const now = this.now();
    const t = this.texts.find((x) => x.key === attempt.idempotencyKey);
    const answer: LookupResult = !t || t.cancelled ? { kind: "not-sent" } : t.sentAt !== null && t.sentAt <= now ? { kind: "sent", sentAt: t.sentAt, providerRef: t.providerRef } : { kind: "queued" };
    this.lookupLog.push({ at: now, key: attempt.idempotencyKey, answer: answer.kind });
    return Promise.resolve(answer);
  }
}
