/**
 * The attempt contract (ADR 0003 5.3, ruling 1): one forward-only state chain per provider
 * attempt, applied event by event, beside the provider work the attempt carries (PR 37 review
 * round 3). Results may arrive late, twice or out of order; a repeated or backward event is
 * ignored. Once the provider may have been called, the attempt is never withdrawn or repeated
 * without a provider signal or the user's decision.
 *
 * Events about one attempt (its claim, its calls, its withdrawal) are applied here with its work.
 * Events about the work itself (a send, a lookup, a provider refusal, the user's mark) are applied
 * to the work and every attempt carrying it at once, in `progress.ts` `applyToWork`.
 */
import type { Attempt, LookupAnswer, ProviderWork, RejectReason } from "./state.ts";

/** The engine's parameters (ADR 0003 5.6), one value each. */
export const ENGINE_PARAMS = {
  MAX_CALLS: 3,
  SETTLING: 15 * 60_000,
  MAX_QUEUED_LOOKUPS: 12,
  PRESEND_MAX_AGE: 60_000,
  CALL_TIMEOUT: 30_000,
  /** The most running time one observation may credit to a wait (`runningCredit`): four of the worker's 15-second ticks. */
  MAX_RUNNING_CREDIT: 60_000,
} as const;

export const TERMINAL = new Set(["sent", "rejected", "withdrawn"]);
export const isTerminal = (a: Pick<Attempt, "state">): boolean => TERMINAL.has(a.state);
export const isLive = (a: Pick<Attempt, "state">): boolean => !isTerminal(a);

export type CallAnswer =
  | { readonly kind: "accepted"; readonly providerRef: string }
  | { readonly kind: "rejected"; readonly reason: RejectReason; readonly retryAfterMs?: number }
  | { readonly kind: "unknown" };

/** Events about one attempt. */
export type AttemptEvent =
  | { readonly kind: "claim_expired"; readonly now: number }
  | { readonly kind: "guard_failed" }
  | { readonly kind: "call_answer"; readonly answer: CallAnswer; readonly now: number }
  | { readonly kind: "quiesce" }
  | { readonly kind: "withdraw_answer"; readonly answer: "withdrawn" | "too-late" | "unknown"; readonly now: number }
  | { readonly kind: "retry_refused"; readonly now: number };

/** Events about provider work, whichever attempt carries it. */
export type WorkEvent =
  | { readonly kind: "sent_observed"; readonly providerTime: number; readonly providerRef: string | null }
  | { readonly kind: "lookup_answer"; readonly answer: { readonly kind: LookupAnswer; readonly sentAt?: number; readonly providerRef?: string | null }; readonly now: number }
  | { readonly kind: "provider_rejected"; readonly reason: RejectReason }
  | { readonly kind: "mark_sent"; readonly now: number }
  | { readonly kind: "mark_not_sent"; readonly now: number }
  /** The provider's answer to a withdrawal of the work (ticket 17a; council A): asked of the work, whatever its attempts. */
  | { readonly kind: "withdraw_answer"; readonly answer: "withdrawn" | "too-late" | "unknown"; readonly now: number };

/** What a change means for the step, the account or the worker. */
export type AttemptEffect =
  | { readonly kind: "sent"; readonly providerTime: number }
  | { readonly kind: "rejected"; readonly reason: RejectReason; readonly retryAfterMs?: number }
  | { readonly kind: "call_withdraw" }
  | { readonly kind: "anomaly"; readonly what: string }
  | { readonly kind: "ignored"; readonly what: string };

export interface AttemptStep {
  readonly attempt: Attempt;
  readonly work: ProviderWork;
  readonly effects: readonly AttemptEffect[];
}

/** Unsettled work the provider may hold: called at least once. It keeps its reservation. */
/**
 * Unsettled provider work (ticket 17a; council on 56d599c): called, with no final answer yet, whether or not an attempt
 * still carries it. The one definition the in-flight bound, `mayStillSend`, skip's refusal and the campaign read use.
 */
export const isUncertain = (w: Pick<ProviderWork, "settled" | "calls">): boolean => w.settled === null && w.calls > 0;

/**
 * Unsettled work the provider may still send (council on 56d599c, items B and J): unsettled (`isUncertain`), and not work
 * the provider said went ("too late", whose send time is still to be observed). The in-flight bound, `mayStillSend` (the
 * enrollment and campaign reads) and withdrawals use it; skip refuses any unsettled work of its step.
 */
export const maySend = (w: Pick<ProviderWork, "settled" | "calls" | "wentWall">): boolean => isUncertain(w) && w.wentWall === null;

/**
 * The provider work holding an account's in-flight places (4.2's `k`; council B on 56d599c, and the review bot on
 * 612aa05): work the provider may still send (`maySend`), and claims not yet called, counted once per key. Nothing else:
 * a live attempt whose work has any final answer (withdrawn, too late, sent, not sent, bounced) holds no place, so a
 * too-late answer frees its place while the send time is still being reconciled; an inheritor of uncertain work does
 * not count twice; and work a non-final "not sent" left without an attempt still holds its place. `work` must hold the
 * work of every live attempt given, settled or not.
 */
export function occupyingKeys(liveAttemptKeys: Iterable<string>, work: Iterable<Pick<ProviderWork, "key" | "settled" | "calls" | "wentWall">>): Set<string> {
  const byKey = new Map([...work].map((w) => [w.key, w]));
  const keys = new Set<string>();
  for (const key of liveAttemptKeys) {
    const w = byKey.get(key);
    if (!w || w.calls === 0) keys.add(key);
  }
  for (const w of byKey.values()) if (maySend(w)) keys.add(w.key);
  return keys;
}

/** Unresolved work the user may mark sent or not sent. */
export const markable = (w: ProviderWork): boolean => isUncertain(w) && w.unresolvedSince !== null;

/** Whether a same-key retry may still be attempted at all (the attempt's own conditions in 5.6, its work unsettled and not unresolved). */
export function retryPossible(a: Attempt, w: ProviderWork): boolean {
  return a.state === "handed" && a.retryable && a.calls < ENGINE_PARAMS.MAX_CALLS && !a.withdrawRequested && w.unresolvedSince === null && w.settled === null;
}

/** Schedules the work's next lookup one SETTLING after the attempt's last call, while the work is unsettled. */
const settleAfter = (a: Attempt, w: ProviderWork): ProviderWork =>
  w.settled === null ? { ...w, nextLookupWall: (a.lastCallWall ?? a.claimedWall) + ENGINE_PARAMS.SETTLING } : w;

/** Work whose attempt ended before any call: the provider never got it, and the reservation goes. */
const neverCalled = (w: ProviderWork): ProviderWork => (w.settled === null && w.calls === 0 ? { ...w, settled: "never_called", nextLookupWall: null } : w);

/** A missing provider reference is attached from any later fact for the same work (ruling 1). */
export const withRef = (w: ProviderWork, ref: string | null | undefined): ProviderWork => (w.providerRef === null && ref ? { ...w, providerRef: ref } : w);

const ignored = (attempt: Attempt, work: ProviderWork, what: string): AttemptStep => ({ attempt, work, effects: [{ kind: "ignored", what }] });

export function applyAttemptEvent(a: Attempt, w: ProviderWork, event: AttemptEvent): AttemptStep {
  switch (event.kind) {
    case "claim_expired":
      if (a.state !== "claimed") return ignored(a, w, "claim age limit on an attempt past claimed");
      if (event.now - a.claimedWall < ENGINE_PARAMS.SETTLING) return ignored(a, w, "claim not yet expired");
      return { attempt: { ...a, state: "withdrawn", endedBy: "claim_expired" }, work: neverCalled(w), effects: [] };

    case "guard_failed":
      if (a.state !== "claimed") throw new Error(`the handover guard runs only on a claimed attempt, not ${a.state}`);
      return { attempt: { ...a, state: "withdrawn", endedBy: "guard" }, work: neverCalled(w), effects: [] };

    case "call_answer": {
      if (a.state === "claimed") throw new Error("a call answer for an attempt that was never handed over");
      const answered = { ...a, awaitingAnswer: false };
      const answer = event.answer;
      if (isTerminal(a)) return ignored(answered, answer.kind === "accepted" ? withRef(w, answer.providerRef) : w, `call answer on a ${a.state} attempt`);
      if (answer.kind === "accepted") {
        if (a.state === "accepted") return ignored(answered, withRef(w, answer.providerRef), "duplicate accepted");
        // An acceptance ends any retry intent: the provider holds the work, and settlement goes on.
        return { attempt: { ...answered, state: "accepted", retry: "none" }, work: settleAfter(a, withRef(w, answer.providerRef)), effects: [] };
      }
      if (answer.kind === "rejected") {
        if (a.state === "accepted") return ignored(answered, w, "a refusal after the provider accepted the work");
        // A refusal of the work's only call settles it: the provider never took it. After earlier
        // calls whose outcome is unknown the work stays uncertain, for the provider may hold it.
        const work: ProviderWork = w.settled === null && w.calls <= 1 ? { ...w, settled: "rejected", nextLookupWall: null } : settleAfter(a, w);
        return {
          attempt: { ...answered, state: "rejected", endedBy: "call", rejectReason: answer.reason },
          work,
          effects: [{ kind: "rejected", reason: answer.reason, ...(answer.retryAfterMs === undefined ? {} : { retryAfterMs: answer.retryAfterMs }) }],
        };
      }
      // unknown, a timeout, or a crash before the answer was recorded. Settlement is scheduled
      // whether or not a retry is wanted, so a retry waiting for its slot never delays it (ruling 5).
      if (a.state === "accepted") return { attempt: answered, work: settleAfter(a, w), effects: [] };
      return { attempt: { ...answered, retry: retryPossible(answered, w) ? "wanted" : "refused" }, work: settleAfter(a, w), effects: [] };
    }

    case "quiesce":
      if (a.state === "claimed") return { attempt: { ...a, state: "withdrawn", endedBy: "quiesce" }, work: neverCalled(w), effects: [] };
      if (a.state === "handed" || a.state === "accepted") {
        if (a.withdrawRequested) return ignored(a, w, "already asked to withdraw");
        // The provider said not sent and the retry it wanted is now refused (5.3 not-sent row): the work stays uncertain.
        if (a.retry === "wanted_after_not_sent") return { attempt: { ...a, withdrawRequested: true, retry: "refused", state: "withdrawn", endedBy: "lookup_not_sent" }, work: w, effects: [] };
        const requested = { ...a, withdrawRequested: true };
        return { attempt: a.retry === "wanted" ? { ...requested, retry: "refused" } : requested, work: w, effects: [{ kind: "call_withdraw" }] };
      }
      return ignored(a, w, "quiesce on a terminal attempt");

    case "withdraw_answer":
      if (a.state !== "handed" && a.state !== "accepted") return ignored({ ...a, withdrawCalled: true }, w, `withdraw answer on a ${a.state} attempt`);
      if (event.answer === "withdrawn") {
        // A confirmed withdrawal settles the work (4.2).
        const work: ProviderWork = w.settled === null ? { ...w, settled: "withdrawn", nextLookupWall: null } : w;
        return { attempt: { ...a, withdrawCalled: true, state: "withdrawn", endedBy: "provider", awaitingAnswer: false }, work, effects: [] };
      }
      return { attempt: { ...a, withdrawCalled: true }, work: w.settled === null ? { ...w, nextLookupWall: w.nextLookupWall ?? event.now + ENGINE_PARAMS.SETTLING } : w, effects: [] };

    case "retry_refused":
      if (a.retry === "wanted_after_not_sent") {
        return { attempt: { ...a, retry: "refused", state: "withdrawn", endedBy: "lookup_not_sent" }, work: w.settled === null ? { ...w, nextLookupWall: event.now + ENGINE_PARAMS.SETTLING } : w, effects: [] };
      }
      if (a.retry === "wanted") return { attempt: { ...a, retry: "refused" }, work: w.settled === null ? { ...w, nextLookupWall: w.nextLookupWall ?? event.now } : w, effects: [] };
      return ignored(a, w, "no retry was wanted");
  }
}

/**
 * A lookup's answer other than `sent`, for the work and the live attempt carrying it, if any
 * (5.3 lookup rows). `sent` is a send, applied with the step in `progress.ts`.
 */
export function applyLookup(
  w: ProviderWork,
  live: Attempt | null,
  transport: { readonly retryable: boolean; readonly notSentIsFinal: boolean },
  answer: Exclude<LookupAnswer, "sent">,
  now: number,
): { work: ProviderWork; live: Attempt | null } {
  if (w.settled !== null) return { work: w, live };
  const looked: ProviderWork = { ...w, lookupAnswer: answer, nextLookupWall: now + ENGINE_PARAMS.SETTLING };
  if (answer === "queued") {
    const queuedLookups = w.queuedLookups + 1;
    const work = { ...looked, queuedLookups, unresolvedSince: w.unresolvedSince ?? (queuedLookups >= ENGINE_PARAMS.MAX_QUEUED_LOOKUPS ? now : null) };
    return { work, live: live?.state === "handed" ? { ...live, state: "accepted" } : live };
  }
  const counted = { ...looked, queuedLookups: 0 };
  if (answer === "not-sent" && transport.notSentIsFinal) {
    // A not-sent the transport vouches for settles the work.
    return { work: { ...counted, settled: "not_sent", nextLookupWall: null }, live: live && live.state !== "claimed" ? { ...live, state: "withdrawn", endedBy: "provider", awaitingAnswer: false, retry: "refused" } : live };
  }
  if (answer === "not-sent" && transport.retryable && live && live.state !== "claimed") {
    // Also when already unresolved: a later not-sent still settles the attempt, keeping when the work became unresolved (ruling 6).
    if (retryPossible(live, counted)) return { work: counted, live: { ...live, retry: "wanted_after_not_sent" } };
    return { work: counted, live: { ...live, state: "withdrawn", endedBy: "lookup_not_sent", retry: "refused" } };
  }
  // unknown, or a not-sent the transport cannot vouch for: unresolved, and keep looking.
  return { work: { ...counted, unresolvedSince: w.unresolvedSince ?? now }, live };
}
