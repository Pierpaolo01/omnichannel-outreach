import type { CallAnswer } from "../../src/domain/sequence/attempt.ts";
import type { AccountStatus, AttemptRef, HandoverRequest, LookupResult, ProviderEvent, SendPort, Transport } from "../../src/server/engine/ports.ts";

/**
 * A provider whose every answer a test scripts, for exact event orders in regression tests.
 * It keeps the same kind of call and delivery logs as the generated test's fake.
 */
export interface ScriptedWork {
  readonly key: string;
  readonly request: HandoverRequest;
  readonly ref: string;
  /** When it sends, or null if it never does. */
  sendAt: number | null;
  /** When its sent event becomes visible, relative to the send. */
  readonly eventDelay: number;
  cancelled: boolean;
}

export class ScriptedEmailPort implements SendPort {
  readonly channel = "email";
  readonly calls: { at: number; request: HandoverRequest }[] = [];
  readonly deliveries: { at: number; key: string; subjectId: string; stepId: string; sender: string; ref: string }[] = [];
  readonly works: ScriptedWork[] = [];
  readonly events: { visibleAt: number; event: ProviderEvent }[] = [];
  accountList: AccountStatus[];
  /** What each first call for a key does: its answer, when it sends, and how late its event shows. */
  onCall: (request: HandoverRequest) => { answer: "accepted" | "unknown"; sendAfter: number | null; eventDelay?: number } = () => ({ answer: "accepted", sendAfter: 0 });
  /** Overrides the lookup's truthful answer. */
  lookupOverride: ((work: ScriptedWork | undefined, now: number) => LookupResult | null) | null = null;
  withdrawAnswer: "withdrawn" | "too-late" | "unknown" = "unknown";
  presend: () => Promise<{ kind: "clear" } | { kind: "unavailable" }> = () => Promise.resolve({ kind: "clear" });
  private readonly now: () => number;
  private nextRef = 0;

  constructor(now: () => number, accounts: AccountStatus[]) {
    this.now = now;
    this.accountList = accounts;
  }

  transportFor(step: { readonly threading: "new_subject" | "continue_thread" }): Transport {
    return { retryable: step.threading === "new_subject", notSentIsFinal: false };
  }

  accounts(): Promise<AccountStatus[]> {
    return Promise.resolve(this.accountList);
  }

  presendCheck(request: { sender: string; destination: string; threadRefs: readonly string[] }) {
    // ADR 0002's pre-send check reads only the threads the app recorded for the lead.
    const reply = this.events.find((e) => e.event.kind === "reply" && e.visibleAt <= this.now() && request.threadRefs.includes(e.event.providerRef));
    if (reply && reply.event.kind === "reply") return Promise.resolve({ kind: "reply" as const, providerRef: reply.event.id, at: reply.event.at });
    return this.presend();
  }

  handover(request: HandoverRequest): Promise<CallAnswer> {
    const now = this.now();
    this.calls.push({ at: now, request });
    const existing = this.works.find((w) => w.key === request.idempotencyKey);
    if (existing && request.threading === "new_subject") return Promise.resolve({ kind: "accepted", providerRef: existing.ref });
    const script = this.onCall(request);
    const ref = `msg-${++this.nextRef}`;
    this.works.push({ key: request.idempotencyKey, request, ref, sendAt: script.sendAfter === null ? null : now + script.sendAfter, eventDelay: script.eventDelay ?? 0, cancelled: false });
    this.advance();
    return Promise.resolve(script.answer === "accepted" ? { kind: "accepted", providerRef: ref } : { kind: "unknown" });
  }

  advance(): void {
    const now = this.now();
    for (const w of this.works) {
      if (w.cancelled || w.sendAt === null || w.sendAt > now || this.deliveries.some((d) => d.ref === w.ref)) continue;
      this.deliveries.push({ at: w.sendAt, key: w.key, subjectId: w.request.subjectId, stepId: w.request.stepId, sender: w.request.sender, ref: w.ref });
      this.events.push({ visibleAt: w.sendAt + w.eventDelay, event: { id: `sent-${w.ref}`, kind: "sent", key: w.key, providerRef: w.ref, sentAt: w.sendAt } });
    }
  }

  nextActivityAt(): number | null {
    const now = this.now();
    const times = [...this.works.filter((w) => !w.cancelled && w.sendAt !== null && w.sendAt > now).map((w) => w.sendAt ?? 0), ...this.events.filter((e) => e.visibleAt > now).map((e) => e.visibleAt)];
    return times.length > 0 ? Math.min(...times) : null;
  }

  /** The prospect replies; `onThread` false sends it from their address to the inbox but outside any thread the app knows. */
  reply(destination: string, onThread = true): void {
    const now = this.now();
    const last = this.deliveries.filter((d) => this.works.find((w) => w.ref === d.ref)?.request.destination === destination).at(-1);
    if (!last) throw new Error(`nothing was delivered to ${destination}`);
    const id = `reply-${this.events.length + 1}`;
    this.events.push({ visibleAt: now, event: { id, kind: "reply", providerRef: onThread ? last.ref : `unknown-${id}`, at: now, inbox: last.sender, from: destination } });
  }

  withdraw(attempt: AttemptRef): Promise<"withdrawn" | "too-late" | "unknown"> {
    const w = this.works.find((x) => x.key === attempt.idempotencyKey);
    if (w && this.withdrawAnswer === "withdrawn" && w.sendAt !== null && w.sendAt > this.now()) w.cancelled = true;
    return Promise.resolve(this.withdrawAnswer);
  }

  observe(checkpoint: string | null): Promise<{ events: ProviderEvent[]; checkpoint: string }> {
    const now = this.now();
    const since = checkpoint === null ? -Infinity : Number(checkpoint) - 60 * 60_000;
    return Promise.resolve({ events: this.events.filter((e) => e.visibleAt > since && e.visibleAt <= now).map((e) => e.event), checkpoint: String(now) });
  }

  lookup(attempt: AttemptRef): Promise<LookupResult> {
    const now = this.now();
    const w = this.works.find((x) => x.key === attempt.idempotencyKey);
    const scripted = this.lookupOverride?.(w, now);
    if (scripted) return Promise.resolve(scripted);
    if (!w || w.cancelled || w.sendAt === null) return Promise.resolve({ kind: "not-sent" });
    if (w.sendAt <= now) return Promise.resolve({ kind: "sent", sentAt: w.sendAt, providerRef: w.ref });
    return Promise.resolve({ kind: "queued" });
  }
}
