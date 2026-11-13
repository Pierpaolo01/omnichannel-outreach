/**
 * The attempt contract (ADR 0003 5.3, ruling 1): one forward-only state chain per provider
 * attempt, applied event by event. Results may arrive late, twice or out of order; a repeated or
 * backward event is ignored. Once the provider may have been called, the attempt is never
 * withdrawn or repeated without a provider signal or the user's decision.
 */
import type { Attempt, LookupAnswer, RejectReason } from "./state.ts";

/** The engine's parameters (ADR 0003 5.6), one value each. */
export const ENGINE_PARAMS = {
  MAX_CALLS: 3,
  SETTLING: 15 * 60_000,
  MAX_QUEUED_LOOKUPS: 12,
  PRESEND_MAX_AGE: 60_000,
  CALL_TIMEOUT: 30_000,
} as const;

export const TERMINAL = new Set(["sent", "rejected", "withdrawn"]);
export const isTerminal = (a: Pick<Attempt, "state">): boolean => TERMINAL.has(a.state);
export const isLive = (a: Pick<Attempt, "state">): boolean => !isTerminal(a);

export type CallAnswer =
  | { readonly kind: "accepted"; readonly providerRef: string }
  | { readonly kind: "rejected"; readonly reason: RejectReason; readonly retryAfterMs?: number }
  | { readonly kind: "unknown" };

export type AttemptEvent =
  | { readonly kind: "claim_expired"; readonly now: number }
  | { readonly kind: "guard_failed" }
  | { readonly kind: "call_answer"; readonly answer: CallAnswer; readonly now: number }
  | { readonly kind: "sent_observed"; readonly providerTime: number; readonly providerRef: string | null }
  | { readonly kind: "provider_rejected"; readonly reason: RejectReason }
  | { readonly kind: "quiesce" }
  | { readonly kind: "withdraw_answer"; readonly answer: "withdrawn" | "too-late" | "unknown"; readonly now: number }
  | { readonly kind: "lookup_answer"; readonly answer: { readonly kind: LookupAnswer; readonly sentAt?: number }; readonly now: number }
  | { readonly kind: "retry_refused"; readonly now: number }
  | { readonly kind: "mark_sent"; readonly now: number }
  | { readonly kind: "mark_not_sent"; readonly now: number };

/** What the attempt's change means for its step, its account or the worker. */
export type AttemptEffect =
  | { readonly kind: "sent"; readonly providerTime: number }
  | { readonly kind: "rejected"; readonly reason: RejectReason; readonly retryAfterMs?: number }
  | { readonly kind: "call_withdraw" }
  | { readonly kind: "anomaly"; readonly what: string }
  | { readonly kind: "ignored"; readonly what: string };

export interface AttemptStep {
  readonly attempt: Attempt;
  readonly effects: readonly AttemptEffect[];
}

const same = (attempt: Attempt, what: string): AttemptStep => ({ attempt, effects: [{ kind: "ignored", what }] });

/** Schedules a `lookup` one SETTLING after the last call. */
const settle = (a: Attempt): Attempt => ({ ...a, nextLookupWall: (a.lastCallWall ?? a.claimedWall) + ENGINE_PARAMS.SETTLING });

/** Whether a same-key retry may still be attempted at all (the attempt's own conditions in 5.6). */
export function retryPossible(a: Attempt): boolean {
  return a.state === "handed" && a.retryable && a.calls < ENGINE_PARAMS.MAX_CALLS && !a.withdrawRequested && a.unresolvedSince === null;
}

export function applyAttemptEvent(a: Attempt, event: AttemptEvent): AttemptStep {
  switch (event.kind) {
    case "claim_expired":
      if (a.state !== "claimed") return same(a, "claim age limit on an attempt past claimed");
      if (event.now - a.claimedWall < ENGINE_PARAMS.SETTLING) return same(a, "claim not yet expired");
      return { attempt: { ...a, state: "withdrawn", endedBy: "claim_expired" }, effects: [] };

    case "guard_failed":
      if (a.state !== "claimed") throw new Error(`the handover guard runs only on a claimed attempt, not ${a.state}`);
      return { attempt: { ...a, state: "withdrawn", endedBy: "guard" }, effects: [] };

    case "call_answer": {
      if (a.state === "claimed") throw new Error("a call answer for an attempt that was never handed over");
      if (isTerminal(a)) return same({ ...a, awaitingAnswer: false }, `call answer on a ${a.state} attempt`);
      const answered = { ...a, awaitingAnswer: false };
      const answer = event.answer;
      if (answer.kind === "accepted") {
        if (a.state === "accepted") return same(answered, "duplicate accepted");
        return { attempt: settle({ ...answered, state: "accepted", providerRef: answer.providerRef }), effects: [] };
      }
      if (answer.kind === "rejected") {
        if (a.state === "accepted") return same(answered, "a refusal after the provider accepted the work");
        return {
          attempt: { ...answered, state: "rejected", endedBy: "call", rejectReason: answer.reason },
          effects: [{ kind: "rejected", reason: answer.reason, ...(answer.retryAfterMs === undefined ? {} : { retryAfterMs: answer.retryAfterMs }) }],
        };
      }
      // unknown, a timeout, or a crash before the answer was recorded.
      if (a.state === "accepted") return { attempt: settle(answered), effects: [] };
      if (retryPossible(answered)) return { attempt: { ...answered, retry: "wanted" }, effects: [] };
      return { attempt: settle({ ...answered, retry: "refused" }), effects: [] };
    }

    case "sent_observed": {
      if (a.state === "claimed") return { attempt: a, effects: [{ kind: "anomaly", what: "a send observed for an attempt never handed over" }] };
      if (a.state === "sent") return same(a, "duplicate send");
      if (a.state === "withdrawn" && a.endedBy !== "lookup_not_sent") {
        return { attempt: a, effects: [{ kind: "anomaly", what: `the provider sent an attempt that was ${a.endedBy === "user" ? "marked not sent" : "withdrawn"}` }] };
      }
      if (a.state === "rejected") return { attempt: a, effects: [{ kind: "anomaly", what: "the provider sent an attempt it had refused" }] };
      return {
        attempt: { ...a, state: "sent", endedBy: "observed", providerRef: a.providerRef ?? event.providerRef, awaitingAnswer: false },
        effects: [{ kind: "sent", providerTime: event.providerTime }],
      };
    }

    case "provider_rejected":
      // Only a provider signal that it will not send moves an accepted attempt (Instantly's skip, P4).
      if (a.state !== "handed" && a.state !== "accepted") return same(a, `a refusal on a ${a.state} attempt`);
      return { attempt: { ...a, state: "rejected", endedBy: "provider", rejectReason: event.reason, awaitingAnswer: false }, effects: [{ kind: "rejected", reason: event.reason }] };

    case "quiesce":
      if (a.state === "claimed") return { attempt: { ...a, state: "withdrawn", endedBy: "quiesce" }, effects: [] };
      if (a.state === "handed" || a.state === "accepted") {
        if (a.withdrawRequested) return same(a, "already asked to withdraw");
        if (a.retry === "wanted_after_not_sent") {
          // The provider said not sent and the retry it wanted is now refused (5.3 not-sent row).
          return { attempt: { ...a, withdrawRequested: true, retry: "refused", state: "withdrawn", endedBy: "lookup_not_sent", nextLookupWall: null }, effects: [] };
        }
        const requested = { ...a, withdrawRequested: true };
        return {
          attempt: a.retry === "wanted" ? settle({ ...requested, retry: "refused" }) : requested,
          effects: [{ kind: "call_withdraw" }],
        };
      }
      return same(a, "quiesce on a terminal attempt");

    case "withdraw_answer":
      if (a.state !== "handed" && a.state !== "accepted") return same({ ...a, withdrawCalled: true }, `withdraw answer on a ${a.state} attempt`);
      if (event.answer === "withdrawn") return { attempt: { ...a, withdrawCalled: true, state: "withdrawn", endedBy: "provider" }, effects: [] };
      return { attempt: { ...a, withdrawCalled: true, nextLookupWall: a.nextLookupWall ?? event.now + ENGINE_PARAMS.SETTLING }, effects: [] };

    case "lookup_answer": {
      if (a.state !== "handed" && a.state !== "accepted") {
        if (a.state === "withdrawn" && a.endedBy === "lookup_not_sent" && event.answer.kind === "sent") {
          return applyAttemptEvent(a, { kind: "sent_observed", providerTime: event.answer.sentAt ?? event.now, providerRef: null });
        }
        return same(a, `lookup on a ${a.state} attempt`);
      }
      const answer = event.answer;
      const looked = { ...a, lookupAnswer: answer.kind, nextLookupWall: event.now + ENGINE_PARAMS.SETTLING };
      if (answer.kind === "sent") {
        return {
          attempt: { ...looked, queuedLookups: 0, state: "sent", endedBy: "lookup", nextLookupWall: null, awaitingAnswer: false },
          effects: [{ kind: "sent", providerTime: answer.sentAt ?? event.now }],
        };
      }
      if (answer.kind === "queued") {
        const queuedLookups = a.queuedLookups + 1;
        return {
          attempt: {
            ...looked,
            state: "accepted",
            queuedLookups,
            unresolvedSince: a.unresolvedSince ?? (queuedLookups >= ENGINE_PARAMS.MAX_QUEUED_LOOKUPS ? event.now : null),
          },
          effects: [],
        };
      }
      const counted = { ...looked, queuedLookups: 0 };
      if (answer.kind === "not-sent" && a.retryable && a.unresolvedSince === null) {
        if (retryPossible(counted)) return { attempt: { ...counted, retry: "wanted_after_not_sent" }, effects: [] };
        return { attempt: { ...counted, state: "withdrawn", endedBy: "lookup_not_sent", nextLookupWall: null }, effects: [] };
      }
      if (answer.kind === "not-sent" && !a.retryable && a.notSentIsFinal) {
        return { attempt: { ...counted, state: "withdrawn", endedBy: "provider", nextLookupWall: null }, effects: [] };
      }
      // unknown, or a not-sent the transport cannot vouch for: unresolved, and keep looking.
      return { attempt: { ...counted, unresolvedSince: a.unresolvedSince ?? event.now }, effects: [] };
    }

    case "retry_refused":
      if (a.retry === "wanted_after_not_sent") return { attempt: { ...a, retry: "refused", state: "withdrawn", endedBy: "lookup_not_sent", nextLookupWall: null }, effects: [] };
      if (a.retry === "wanted") return { attempt: settle({ ...a, retry: "refused" }), effects: [] };
      return same(a, "no retry was wanted");

    case "mark_sent":
      if (isTerminal(a) || a.unresolvedSince === null) return same(a, "mark sent is only for an unresolved attempt");
      return { attempt: { ...a, state: "sent", endedBy: "user", nextLookupWall: null }, effects: [{ kind: "sent", providerTime: event.now }] };

    case "mark_not_sent":
      if (isTerminal(a) || a.unresolvedSince === null) return same(a, "mark not sent is only for an unresolved attempt");
      if (a.lookupAnswer === "queued") return same(a, "the provider reports the work queued");
      return { attempt: { ...a, state: "withdrawn", endedBy: "user", userMarkedNotSent: true, nextLookupWall: null }, effects: [] };
  }
}
