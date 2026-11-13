import { describe, expect, test } from "vitest";
import { attempt, handed, MONDAY_9 } from "../../../test/support/sequence-state.ts";
import { applyAttemptEvent, ENGINE_PARAMS } from "./attempt.ts";

const { SETTLING, MAX_QUEUED_LOOKUPS, MAX_CALLS } = ENGINE_PARAMS;
const now = MONDAY_9 + 5 * 60_000;

describe("the attempt table, row by row (ADR 0003 5.3)", () => {
  test("a claim older than SETTLING is withdrawn; a younger one is not", () => {
    expect(applyAttemptEvent(attempt(), { kind: "claim_expired", now: MONDAY_9 + SETTLING - 1 }).attempt.state).toBe("claimed");
    expect(applyAttemptEvent(attempt(), { kind: "claim_expired", now: MONDAY_9 + SETTLING }).attempt).toMatchObject({ state: "withdrawn", endedBy: "claim_expired" });
  });

  test("failed handover predicates withdraw a claimed attempt; the provider was never called", () => {
    expect(applyAttemptEvent(attempt(), { kind: "guard_failed" }).attempt).toMatchObject({ state: "withdrawn", endedBy: "guard", calls: 0 });
    expect(() => applyAttemptEvent(handed(), { kind: "guard_failed" })).toThrow();
  });

  test("accepted moves handed forward and schedules a lookup one SETTLING after the call; a duplicate is ignored", () => {
    const accepted = applyAttemptEvent(handed(), { kind: "call_answer", answer: { kind: "accepted", providerRef: "p-1" }, now }).attempt;
    expect(accepted).toMatchObject({ state: "accepted", providerRef: "p-1", awaitingAnswer: false, nextLookupWall: MONDAY_9 + SETTLING });
    expect(applyAttemptEvent(accepted, { kind: "call_answer", answer: { kind: "accepted", providerRef: "p-1" }, now }).attempt).toEqual({ ...accepted });
  });

  test("a call answer is impossible on an attempt never handed over", () => {
    expect(() => applyAttemptEvent(attempt(), { kind: "call_answer", answer: { kind: "unknown" }, now })).toThrow();
  });

  test("a final refusal rejects a handed attempt, but a refusal after acceptance is ignored", () => {
    const step = applyAttemptEvent(handed(), { kind: "call_answer", answer: { kind: "rejected", reason: "blocklisted" }, now });
    expect(step.attempt).toMatchObject({ state: "rejected", rejectReason: "blocklisted" });
    expect(step.effects).toEqual([{ kind: "rejected", reason: "blocklisted" }]);
    expect(applyAttemptEvent(handed({ state: "accepted" }), { kind: "call_answer", answer: { kind: "rejected", reason: "blocklisted" }, now }).attempt.state).toBe("accepted");
  });

  test("an unknown answer on a retryable handed attempt asks for the retry authorization", () => {
    expect(applyAttemptEvent(handed(), { kind: "call_answer", answer: { kind: "unknown" }, now }).attempt).toMatchObject({ state: "handed", retry: "wanted" });
  });

  test("a late acceptance while a same-key retry waits clears the retry intent and keeps settlement scheduled (review bot, attempt.ts:81)", () => {
    for (const retry of ["wanted", "wanted_after_not_sent"] as const) {
      const waiting = handed({ retry, awaitingAnswer: false, nextLookupWall: MONDAY_9 + SETTLING });
      const accepted = applyAttemptEvent(waiting, { kind: "call_answer", answer: { kind: "accepted", providerRef: "msg-1" }, now }).attempt;
      expect(accepted).toMatchObject({ state: "accepted", retry: "none", providerRef: "msg-1" });
      expect(accepted.nextLookupWall).not.toBeNull();
    }
  });

  test("an unknown answer on a non-retryable attempt, or with no calls left, settles instead", () => {
    expect(applyAttemptEvent(handed({ retryable: false }), { kind: "call_answer", answer: { kind: "unknown" }, now }).attempt).toMatchObject({ retry: "refused", nextLookupWall: MONDAY_9 + SETTLING });
    expect(applyAttemptEvent(handed({ calls: MAX_CALLS }), { kind: "call_answer", answer: { kind: "unknown" }, now }).attempt.retry).toBe("refused");
  });

  test("an unknown answer on an accepted attempt stays accepted and settles", () => {
    expect(applyAttemptEvent(handed({ state: "accepted" }), { kind: "call_answer", answer: { kind: "unknown" }, now }).attempt).toMatchObject({ state: "accepted", retry: "none" });
  });

  test("a send observed moves handed or accepted to sent, carrying the provider's send time", () => {
    for (const state of ["handed", "accepted"] as const) {
      const step = applyAttemptEvent(handed({ state }), { kind: "sent_observed", providerTime: MONDAY_9 + 1000, providerRef: "p-1" });
      expect(step.attempt.state).toBe("sent");
      expect(step.effects).toEqual([{ kind: "sent", providerTime: MONDAY_9 + 1000 }]);
    }
  });

  test("a send observed after a lookup said not sent is the one terminal state an observation may leave", () => {
    const step = applyAttemptEvent(handed({ state: "withdrawn", endedBy: "lookup_not_sent" }), { kind: "sent_observed", providerTime: now, providerRef: "p" });
    expect(step.attempt.state).toBe("sent");
  });

  test("a send observed on another terminal attempt is a provider anomaly, never a second send of the step", () => {
    // A withdrawn attempt the provider sent anyway still counts against its send day's capacity (ruling 3).
    for (const fields of [{ state: "withdrawn" as const, endedBy: "provider" as const }, { state: "withdrawn" as const, endedBy: "user" as const }]) {
      const step = applyAttemptEvent(handed(fields), { kind: "sent_observed", providerTime: now, providerRef: "p" });
      expect(step.attempt.state).toBe("withdrawn");
      expect(step.effects.map((e) => e.kind)).toEqual(["anomaly", "sent_after_withdrawal"]);
    }
    const refused = applyAttemptEvent(handed({ state: "rejected" }), { kind: "sent_observed", providerTime: now, providerRef: "p" });
    expect(refused.attempt.state).toBe("rejected");
    expect(refused.effects.map((e) => e.kind)).toEqual(["anomaly"]);
    expect(applyAttemptEvent(handed({ state: "sent" }), { kind: "sent_observed", providerTime: now, providerRef: "p" }).effects.map((e) => e.kind)).toEqual(["ignored"]);
  });

  test("quiesce withdraws a claim locally, but only asks the provider to withdraw a handed or accepted attempt", () => {
    expect(applyAttemptEvent(attempt(), { kind: "quiesce" }).attempt).toMatchObject({ state: "withdrawn", endedBy: "quiesce" });
    for (const state of ["handed", "accepted"] as const) {
      const step = applyAttemptEvent(handed({ state }), { kind: "quiesce" });
      expect(step.attempt).toMatchObject({ state, withdrawRequested: true });
      expect(step.effects).toEqual([{ kind: "call_withdraw" }]);
    }
  });

  test("withdraw answers: only a positive signal withdraws; too-late and unknown leave it to settle", () => {
    const requested = handed({ state: "accepted", withdrawRequested: true });
    expect(applyAttemptEvent(requested, { kind: "withdraw_answer", answer: "withdrawn", now }).attempt).toMatchObject({ state: "withdrawn", endedBy: "provider" });
    for (const answer of ["too-late", "unknown"] as const) {
      expect(applyAttemptEvent(requested, { kind: "withdraw_answer", answer, now }).attempt).toMatchObject({ state: "accepted", withdrawCalled: true });
    }
  });

  test("lookup sent moves to sent at the provider's send time", () => {
    const step = applyAttemptEvent(handed({ state: "accepted" }), { kind: "lookup_answer", answer: { kind: "sent", sentAt: MONDAY_9 + 7 }, now });
    expect(step.attempt.state).toBe("sent");
    expect(step.effects).toEqual([{ kind: "sent", providerTime: MONDAY_9 + 7 }]);
  });

  test("queued is looked up again, and only MAX_QUEUED_LOOKUPS consecutive queued answers make it unresolved", () => {
    let a = handed();
    for (let i = 1; i < MAX_QUEUED_LOOKUPS; i++) {
      a = applyAttemptEvent(a, { kind: "lookup_answer", answer: { kind: "queued" }, now: now + i }).attempt;
      expect(a).toMatchObject({ state: "accepted", unresolvedSince: null, queuedLookups: i, nextLookupWall: now + i + SETTLING });
    }
    a = applyAttemptEvent(a, { kind: "lookup_answer", answer: { kind: "queued" }, now: now + 99 }).attempt;
    expect(a.unresolvedSince).toBe(now + 99);
  });

  test("not-sent on a retryable handed attempt tries the retry; refused, it withdraws as lookup_not_sent", () => {
    const wanted = applyAttemptEvent(handed({ awaitingAnswer: false }), { kind: "lookup_answer", answer: { kind: "not-sent" }, now }).attempt;
    expect(wanted.retry).toBe("wanted_after_not_sent");
    expect(applyAttemptEvent(wanted, { kind: "retry_refused", now }).attempt).toMatchObject({ state: "withdrawn", endedBy: "lookup_not_sent" });
    // An accepted attempt cannot be retried (5.6 requires handed), so not-sent withdraws it at once.
    expect(applyAttemptEvent(handed({ state: "accepted" }), { kind: "lookup_answer", answer: { kind: "not-sent" }, now }).attempt).toMatchObject({ state: "withdrawn", endedBy: "lookup_not_sent" });
  });

  test("not-sent on a non-retryable transport withdraws only when the transport's not-sent is final", () => {
    expect(applyAttemptEvent(handed({ retryable: false, notSentIsFinal: true }), { kind: "lookup_answer", answer: { kind: "not-sent" }, now }).attempt).toMatchObject({ state: "withdrawn", endedBy: "provider" });
    expect(applyAttemptEvent(handed({ retryable: false }), { kind: "lookup_answer", answer: { kind: "not-sent" }, now }).attempt).toMatchObject({ state: "handed", unresolvedSince: now });
  });

  test("an unresolved keyed attempt is still settled by a later not-sent, keeping when it became unresolved (ruling 6)", () => {
    const unresolved = handed({ state: "accepted", unresolvedSince: now, lookupAnswer: "unknown", awaitingAnswer: false });
    expect(applyAttemptEvent(unresolved, { kind: "lookup_answer", answer: { kind: "not-sent" }, now: now + SETTLING }).attempt).toMatchObject({
      state: "withdrawn",
      endedBy: "lookup_not_sent",
      unresolvedSince: now,
      holdsReservation: true,
    });
  });

  test("reservations (ruling 3; review round 2, ruling 2): released when the provider never got the work, refused it or said it will not send, or the user settles it; kept while its outcome is uncertain, which is unresolved", () => {
    expect(applyAttemptEvent(attempt(), { kind: "guard_failed" }).attempt.holdsReservation).toBe(false);
    expect(applyAttemptEvent(handed(), { kind: "call_answer", answer: { kind: "rejected", reason: "blocklisted" }, now }).attempt.holdsReservation).toBe(false);
    expect(applyAttemptEvent(handed({ withdrawRequested: true }), { kind: "withdraw_answer", answer: "withdrawn", now }).attempt.holdsReservation).toBe(false);
    const lookupNotSent = applyAttemptEvent(handed({ state: "accepted" }), { kind: "lookup_answer", answer: { kind: "not-sent" }, now }).attempt;
    expect(lookupNotSent).toMatchObject({ state: "withdrawn", endedBy: "lookup_not_sent", holdsReservation: true, nextLookupWall: now + SETTLING, unresolvedSince: now });
    const marked = applyAttemptEvent(handed({ unresolvedSince: now, lookupAnswer: "unknown" }), { kind: "mark_not_sent", now });
    expect(marked.attempt).toMatchObject({ state: "withdrawn", endedBy: "user", holdsReservation: false, nextLookupWall: null });
    expect(marked.effects).toEqual([{ kind: "settled" }]);
    // The user may settle uncertain work too, sent or not sent.
    expect(applyAttemptEvent(lookupNotSent, { kind: "mark_not_sent", now }).attempt).toMatchObject({ endedBy: "user", holdsReservation: false, nextLookupWall: null });
    expect(applyAttemptEvent(lookupNotSent, { kind: "mark_sent", now }).attempt).toMatchObject({ state: "sent", endedBy: "user" });
    // Uncertain work is still looked up; only a later sent, or a not-sent the transport vouches for, settles it.
    expect(applyAttemptEvent(lookupNotSent, { kind: "lookup_answer", answer: { kind: "not-sent" }, now: now + SETTLING }).attempt).toMatchObject({ holdsReservation: true, nextLookupWall: now + 2 * SETTLING });
    expect(applyAttemptEvent({ ...lookupNotSent, notSentIsFinal: true }, { kind: "lookup_answer", answer: { kind: "not-sent" }, now }).attempt.holdsReservation).toBe(false);
    expect(applyAttemptEvent(lookupNotSent, { kind: "lookup_answer", answer: { kind: "sent", sentAt: now, providerRef: "p-1" }, now }).attempt).toMatchObject({ state: "sent", providerRef: "p-1" });
  });

  test("a waiting retry does not hold settlement back: settlement is scheduled with the unknown answer (ruling 5)", () => {
    expect(applyAttemptEvent(handed(), { kind: "call_answer", answer: { kind: "unknown" }, now }).attempt).toMatchObject({ retry: "wanted", nextLookupWall: MONDAY_9 + SETTLING });
  });

  test("unknown makes the attempt unresolved, which is set once and keeps being looked up", () => {
    const a = applyAttemptEvent(handed(), { kind: "lookup_answer", answer: { kind: "unknown" }, now }).attempt;
    expect(a).toMatchObject({ unresolvedSince: now, nextLookupWall: now + SETTLING });
    expect(applyAttemptEvent(a, { kind: "lookup_answer", answer: { kind: "unknown" }, now: now + SETTLING }).attempt.unresolvedSince).toBe(now);
  });

  test("the user marks an unresolved attempt sent or not sent; not sent is refused while the provider reports it queued", () => {
    const unresolved = handed({ state: "accepted", unresolvedSince: now, lookupAnswer: "unknown" });
    expect(applyAttemptEvent(unresolved, { kind: "mark_sent", now }).attempt).toMatchObject({ state: "sent", endedBy: "user" });
    expect(applyAttemptEvent(unresolved, { kind: "mark_not_sent", now }).attempt).toMatchObject({ state: "withdrawn", endedBy: "user", userMarkedNotSent: true });
    expect(applyAttemptEvent({ ...unresolved, lookupAnswer: "queued" }, { kind: "mark_not_sent", now }).attempt.state).toBe("accepted");
    expect(applyAttemptEvent(handed(), { kind: "mark_not_sent", now }).attempt.state).toBe("handed");
  });

  test("a terminal attempt never leaves its state for anything but the one observation", () => {
    for (const state of ["sent", "rejected", "withdrawn"] as const) {
      const a = handed({ state, endedBy: "provider" });
      for (const event of [
        { kind: "quiesce" as const },
        { kind: "call_answer" as const, answer: { kind: "accepted" as const, providerRef: "x" }, now },
        { kind: "lookup_answer" as const, answer: { kind: "not-sent" as const }, now },
        { kind: "withdraw_answer" as const, answer: "withdrawn" as const, now },
        { kind: "mark_not_sent" as const, now },
      ]) {
        expect(applyAttemptEvent(a, event).attempt.state).toBe(state);
      }
    }
  });
});
