import { describe, expect, test } from "vitest";
import { attempt, calledWork, handed, MONDAY_9, work } from "../../../test/support/sequence-state.ts";
import { applyAttemptEvent, applyLookup, ENGINE_PARAMS } from "./attempt.ts";

const { SETTLING, MAX_QUEUED_LOOKUPS, MAX_CALLS } = ENGINE_PARAMS;
const now = MONDAY_9 + 5 * 60_000;
const retryable = { retryable: true, notSentIsFinal: false };

describe("the attempt table, row by row (ADR 0003 5.3): events about one attempt, with its work", () => {
  test("a claim older than SETTLING is withdrawn, and work never called settles as never called; a younger claim is not", () => {
    expect(applyAttemptEvent(attempt(), work(), { kind: "claim_expired", now: MONDAY_9 + SETTLING - 1 }).attempt.state).toBe("claimed");
    const expired = applyAttemptEvent(attempt(), work(), { kind: "claim_expired", now: MONDAY_9 + SETTLING });
    expect(expired.attempt).toMatchObject({ state: "withdrawn", endedBy: "claim_expired" });
    expect(expired.work.settled).toBe("never_called");
    // An inheritor's claim that expires leaves its uncertain work unsettled.
    expect(applyAttemptEvent(attempt(), calledWork(), { kind: "claim_expired", now: MONDAY_9 + SETTLING }).work.settled).toBeNull();
  });

  test("failed handover predicates withdraw a claimed attempt; the provider was never called", () => {
    const step = applyAttemptEvent(attempt(), work(), { kind: "guard_failed" });
    expect(step.attempt).toMatchObject({ state: "withdrawn", endedBy: "guard", calls: 0 });
    expect(step.work.settled).toBe("never_called");
    expect(() => applyAttemptEvent(handed(), calledWork(), { kind: "guard_failed" })).toThrow();
  });

  test("accepted moves handed forward, records the work's reference and schedules its lookup one SETTLING after the call; a duplicate is ignored", () => {
    const step = applyAttemptEvent(handed(), calledWork(), { kind: "call_answer", answer: { kind: "accepted", providerRef: "p-1" }, now });
    expect(step.attempt).toMatchObject({ state: "accepted", awaitingAnswer: false });
    expect(step.work).toMatchObject({ providerRef: "p-1", nextLookupWall: MONDAY_9 + SETTLING });
    const again = applyAttemptEvent(step.attempt, step.work, { kind: "call_answer", answer: { kind: "accepted", providerRef: "p-1" }, now });
    expect([again.attempt, again.work]).toEqual([step.attempt, step.work]);
  });

  test("a call answer is impossible on an attempt never handed over", () => {
    expect(() => applyAttemptEvent(attempt(), work(), { kind: "call_answer", answer: { kind: "unknown" }, now })).toThrow();
  });

  test("a refusal of the work's only call rejects the attempt and settles the work; after earlier unknown calls the work stays uncertain; a refusal after acceptance is ignored", () => {
    const step = applyAttemptEvent(handed(), calledWork(), { kind: "call_answer", answer: { kind: "rejected", reason: "blocklisted" }, now });
    expect(step.attempt).toMatchObject({ state: "rejected", rejectReason: "blocklisted" });
    expect(step.work).toMatchObject({ settled: "rejected", nextLookupWall: null });
    expect(step.effects).toEqual([{ kind: "rejected", reason: "blocklisted" }]);
    const retried = applyAttemptEvent(handed({ calls: 2 }), calledWork({ calls: 2 }), { kind: "call_answer", answer: { kind: "rejected", reason: "rate_limited" }, now });
    expect(retried.work.settled).toBeNull();
    expect(applyAttemptEvent(handed({ state: "accepted" }), calledWork(), { kind: "call_answer", answer: { kind: "rejected", reason: "blocklisted" }, now }).attempt.state).toBe("accepted");
  });

  test("an unknown answer on a retryable handed attempt asks for the retry authorization, and settlement is scheduled anyway (ruling 5)", () => {
    const step = applyAttemptEvent(handed(), calledWork(), { kind: "call_answer", answer: { kind: "unknown" }, now });
    expect(step.attempt).toMatchObject({ state: "handed", retry: "wanted" });
    expect(step.work.nextLookupWall).toBe(MONDAY_9 + SETTLING);
  });

  test("a late acceptance while a same-key retry waits clears the retry intent and keeps settlement scheduled (review bot, attempt.ts:81)", () => {
    for (const retry of ["wanted", "wanted_after_not_sent"] as const) {
      const step = applyAttemptEvent(handed({ retry, awaitingAnswer: false }), calledWork({ nextLookupWall: MONDAY_9 + SETTLING }), { kind: "call_answer", answer: { kind: "accepted", providerRef: "msg-1" }, now });
      expect(step.attempt).toMatchObject({ state: "accepted", retry: "none" });
      expect(step.work.providerRef).toBe("msg-1");
      expect(step.work.nextLookupWall).not.toBeNull();
    }
  });

  test("an unknown answer on a non-retryable attempt, with no calls left, or on unresolved work, settles instead", () => {
    expect(applyAttemptEvent(handed({ retryable: false }), calledWork(), { kind: "call_answer", answer: { kind: "unknown" }, now }).attempt.retry).toBe("refused");
    expect(applyAttemptEvent(handed({ calls: MAX_CALLS }), calledWork(), { kind: "call_answer", answer: { kind: "unknown" }, now }).attempt.retry).toBe("refused");
    expect(applyAttemptEvent(handed(), calledWork({ unresolvedSince: now }), { kind: "call_answer", answer: { kind: "unknown" }, now }).attempt.retry).toBe("refused");
  });

  test("an unknown answer on an accepted attempt stays accepted and settles", () => {
    expect(applyAttemptEvent(handed({ state: "accepted" }), calledWork(), { kind: "call_answer", answer: { kind: "unknown" }, now }).attempt).toMatchObject({ state: "accepted", retry: "none" });
  });

  test("quiesce withdraws a claim locally, but only asks the provider to withdraw a handed or accepted attempt", () => {
    expect(applyAttemptEvent(attempt(), work(), { kind: "quiesce" }).attempt).toMatchObject({ state: "withdrawn", endedBy: "quiesce" });
    for (const state of ["handed", "accepted"] as const) {
      const step = applyAttemptEvent(handed({ state }), calledWork(), { kind: "quiesce" });
      expect(step.attempt).toMatchObject({ state, withdrawRequested: true });
      expect(step.effects).toEqual([{ kind: "call_withdraw" }]);
    }
  });

  test("withdraw answers: only a positive signal withdraws, and it settles the work; too-late and unknown leave it to settle", () => {
    const requested = handed({ state: "accepted", withdrawRequested: true });
    const withdrawn = applyAttemptEvent(requested, calledWork(), { kind: "withdraw_answer", answer: "withdrawn", now });
    expect(withdrawn.attempt).toMatchObject({ state: "withdrawn", endedBy: "provider" });
    expect(withdrawn.work.settled).toBe("withdrawn");
    for (const answer of ["too-late", "unknown"] as const) {
      const step = applyAttemptEvent(requested, calledWork(), { kind: "withdraw_answer", answer, now });
      expect(step.attempt).toMatchObject({ state: "accepted", withdrawCalled: true });
      expect(step.work.settled).toBeNull();
    }
  });

  test("a refused retry after not-sent withdraws the attempt as lookup_not_sent; its work stays unsettled", () => {
    const step = applyAttemptEvent(handed({ retry: "wanted_after_not_sent", awaitingAnswer: false }), calledWork(), { kind: "retry_refused", now });
    expect(step.attempt).toMatchObject({ state: "withdrawn", endedBy: "lookup_not_sent" });
    expect(step.work).toMatchObject({ settled: null, nextLookupWall: now + SETTLING });
  });

  test("a terminal attempt never leaves its state through an attempt event", () => {
    for (const state of ["sent", "rejected", "withdrawn"] as const) {
      const a = handed({ state, endedBy: "provider" });
      for (const event of [
        { kind: "quiesce" as const },
        { kind: "call_answer" as const, answer: { kind: "accepted" as const, providerRef: "x" }, now },
        { kind: "withdraw_answer" as const, answer: "withdrawn" as const, now },
      ]) {
        expect(applyAttemptEvent(a, calledWork(), event).attempt.state).toBe(state);
      }
    }
  });
});

describe("lookups (ADR 0003 5.3 lookup rows): the work's answer, with its live attempt", () => {
  test("queued is looked up again, and only MAX_QUEUED_LOOKUPS consecutive queued answers make the work unresolved", () => {
    let w = calledWork();
    let a = handed();
    for (let i = 1; i < MAX_QUEUED_LOOKUPS; i++) {
      const out = applyLookup(w, a, retryable, "queued", now + i);
      w = out.work;
      a = out.live!;
      expect(a.state).toBe("accepted");
      expect(w).toMatchObject({ unresolvedSince: null, queuedLookups: i, nextLookupWall: now + i + SETTLING });
    }
    expect(applyLookup(w, a, retryable, "queued", now + 99).work.unresolvedSince).toBe(now + 99);
  });

  test("not-sent on a retryable handed attempt asks for the retry; on an accepted one it withdraws it as lookup_not_sent, the work unsettled", () => {
    expect(applyLookup(calledWork(), handed({ awaitingAnswer: false }), retryable, "not-sent", now).live?.retry).toBe("wanted_after_not_sent");
    const out = applyLookup(calledWork(), handed({ state: "accepted" }), retryable, "not-sent", now);
    expect(out.live).toMatchObject({ state: "withdrawn", endedBy: "lookup_not_sent" });
    expect(out.work.settled).toBeNull();
  });

  test("not-sent settles the work only when the transport vouches for it", () => {
    const final = applyLookup(calledWork(), handed({ retryable: false, notSentIsFinal: true }), { retryable: false, notSentIsFinal: true }, "not-sent", now);
    expect(final.work.settled).toBe("not_sent");
    expect(final.live).toMatchObject({ state: "withdrawn", endedBy: "provider" });
    const unvouched = applyLookup(calledWork(), handed({ retryable: false }), { retryable: false, notSentIsFinal: false }, "not-sent", now);
    expect(unvouched.work).toMatchObject({ settled: null, unresolvedSince: now });
    expect(unvouched.live?.state).toBe("handed");
  });

  test("unresolved work is still settled by a later not-sent, keeping when it became unresolved (ruling 6)", () => {
    const out = applyLookup(calledWork({ unresolvedSince: now, lookupAnswer: "unknown" }), handed({ state: "accepted", awaitingAnswer: false }), retryable, "not-sent", now + SETTLING);
    expect(out.live).toMatchObject({ state: "withdrawn", endedBy: "lookup_not_sent" });
    expect(out.work).toMatchObject({ unresolvedSince: now, settled: null });
  });

  test("unknown makes the work unresolved, set once, and it keeps being looked up; uncertain work with no attempt is looked up the same way", () => {
    const w = applyLookup(calledWork(), handed(), retryable, "unknown", now).work;
    expect(w).toMatchObject({ unresolvedSince: now, nextLookupWall: now + SETTLING });
    expect(applyLookup(w, null, retryable, "unknown", now + SETTLING).work.unresolvedSince).toBe(now);
    expect(applyLookup(calledWork(), null, retryable, "not-sent", now).work).toMatchObject({ unresolvedSince: now, nextLookupWall: now + SETTLING, settled: null });
  });

  test("settled work ignores lookups", () => {
    const settled = calledWork({ settled: "rejected" });
    expect(applyLookup(settled, null, retryable, "unknown", now).work).toEqual(settled);
  });
});
