import { describe, expect, test } from "vitest";
import { attempt, DAY, definition, H, handed, MONDAY_9, step, subjectState } from "../../../test/support/sequence-state.ts";
import { leadNow } from "./clock.ts";
import { applyBadDestination, applyReply, applyToAttempt, deriveStatus, enterMain, evaluate, runs } from "./progress.ts";
import type { SubjectState } from "./state.ts";

/** Launched at Monday 09:00 and evaluated then. */
function launched(state: SubjectState = subjectState(), at = MONDAY_9): SubjectState {
  return evaluate(enterMain({ ...state, campaign: { ...state.campaign, launchedAt: at } }, at), at);
}

const opts = { resetDay: () => "2026-11-02" };

describe("status is a total function of the stored state (ADR 0003 2.1)", () => {
  test("a lead not yet touched is queued; once sent to, active", () => {
    const s = launched();
    expect(deriveStatus(s)).toBe("queued");
    expect(deriveStatus({ ...s, subject: { ...s.subject, touched: true } })).toBe("active");
  });

  test("an ending wins over everything, and a lead pause over the branch", () => {
    const s = launched();
    expect(deriveStatus({ ...s, subject: { ...s.subject, ended: "replied", leadPaused: true, touched: true } })).toBe("replied");
    expect(deriveStatus({ ...s, subject: { ...s.subject, leadPaused: true, branch: "win_back" } })).toBe("paused");
  });
});

describe("launch and the first step (ADR 0003 2.4, 2.6)", () => {
  test("before launch the lead does not run and its lead time stays 0", () => {
    const s = evaluate(subjectState(), MONDAY_9);
    expect(runs(s)).toBe(false);
    expect(s.tracks).toEqual([]);
    expect(leadNow(s.subject.clock, MONDAY_9 + 5 * H)).toBe(0);
  });

  test("launch enters main at lead time 0, starts the email track and makes its first step due at once", () => {
    const s = launched();
    expect(s.subject).toMatchObject({ branch: "main", branchEnteredAt: 0, clock: { frozenSince: null } });
    expect(s.freezes).toEqual([{ fromWall: MONDAY_9 - H, toWall: MONDAY_9 }]);
    expect(s.tracks).toEqual([
      expect.objectContaining({ trackId: "t1", startedAt: 0, destinationDetailId: "d-email", nextStepId: "s1", basisAt: 0, basisWall: MONDAY_9, dueAt: 0, dueWall: MONDAY_9 }),
    ]);
  });

  test("a lead with no email ends with no usable channel at launch, before its track is started", () => {
    const s = launched(subjectState({ lead: { ...subjectState().lead, details: [{ id: "d-phone", channel: "phone", ownEmail: false, value: "+447700900101", bad: false, order: 1 }], resolved: {} } }));
    expect(s.subject.ended).toBe("finished_no_usable_channel");
    expect(s.tracks).toEqual([]);
    expect(s.subject.clock.frozenSince).toBe(MONDAY_9);
  });

  test("the newest good email is the track's destination", () => {
    const base = subjectState();
    const details = [...base.lead.details, { id: "d-new", channel: "email" as const, ownEmail: true, value: "p.oneil@mail.example", bad: false, order: 2 }];
    const s = launched({ ...base, lead: { ...base.lead, details, resolved: { ...base.lead.resolved, "d-new": { liveId: "d-new", bad: false, owned: true } } } });
    expect(s.tracks[0]?.destinationDetailId).toBe("d-new");
  });
});

describe("sending (ADR 0003 2.4)", () => {
  function sentFirst(providerTime = MONDAY_9 + 10 * 60_000, now = MONDAY_9 + 20 * 60_000): SubjectState {
    const s = launched();
    const withAttempt = { ...s, attempts: [handed({ state: "accepted", providerRef: "p-1" })] };
    return applyToAttempt(withAttempt, "a-1", { kind: "sent_observed", providerTime, providerRef: "p-1" }, now, opts).state;
  }

  test("a send records the step, touches the lead and resolves the next step from the provider's send time", () => {
    const s = sentFirst();
    expect(s.results).toEqual([expect.objectContaining({ stepId: "s1", result: "sent", at: 10 * 60_000, atWall: MONDAY_9 + 10 * 60_000 })]);
    expect(s.subject.touched).toBe(true);
    expect(deriveStatus(s)).toBe("active");
    // Two calendar days after Monday in London: Wednesday 00:00.
    expect(s.tracks[0]).toMatchObject({ nextStepId: "s2", basisAt: 10 * 60_000, dueWall: Date.parse("2026-11-04T00:00:00Z"), dueAt: Date.parse("2026-11-04T00:00:00Z") - MONDAY_9 });
  });

  test("the next step is resolved from the send time, not from when the app observed it", () => {
    const late = sentFirst(MONDAY_9 + 10 * 60_000, MONDAY_9 + 2 * DAY);
    expect(late.tracks[0]?.dueWall).toBe(Date.parse("2026-11-04T00:00:00Z"));
  });

  test("the last step sent completes the track and the lead finishes with no response", () => {
    const one = launched(subjectState({ campaign: { ...subjectState().campaign, definition: definition([step("s1", { threading: "new_subject" })]) } }));
    const s = applyToAttempt({ ...one, attempts: [handed({ state: "accepted" })] }, "a-1", { kind: "sent_observed", providerTime: MONDAY_9 + 1000, providerRef: "p" }, MONDAY_9 + 2000, opts).state;
    expect(s.tracks[0]).toMatchObject({ finishReason: "completed" });
    expect(s.subject.ended).toBe("sequence_finished_no_response");
  });

  test("a reply ends the lead as replied and quiesces its live attempts", () => {
    const s = launched();
    const live = { ...s, attempts: [handed({ state: "accepted" })] };
    const replied = applyReply(live, { channel: "email", atWall: MONDAY_9 + H, providerRef: "r-1" }, MONDAY_9 + H);
    expect(replied.subject.ended).toBe("replied");
    expect(replied.attempts[0]).toMatchObject({ state: "accepted", withdrawRequested: true });
    expect(replied.subject.clock.frozenSince).toBe(MONDAY_9 + H);
    expect(deriveStatus(replied)).toBe("replied");
  });

  test("a reply after another ending makes the lead replied; a second reply only records it", () => {
    const finished = { ...launched(), subject: { ...launched().subject, ended: "sequence_finished_no_response" as const } };
    const replied = applyReply(finished, { channel: "email", atWall: MONDAY_9 + H, providerRef: "r-1" }, MONDAY_9 + H);
    expect(replied.subject.ended).toBe("replied");
    const again = applyReply(replied, { channel: "email", atWall: MONDAY_9 + 2 * H, providerRef: "r-2" }, MONDAY_9 + 2 * H);
    expect(again.subject).toEqual(replied.subject);
    expect(again.replies).toHaveLength(2);
  });

  test("a bounce while the next step is handed marks the address bad, fails the track, quiesces the next attempt and ends the lead", () => {
    const sent = sentFirst();
    const withNext = { ...sent, attempts: [...sent.attempts, handed({ id: "a-2", stepId: "s2", state: "accepted" })] };
    const bounced = applyBadDestination(withNext, withNext.attempts[0]!, MONDAY_9 + 3 * DAY);
    expect(bounced.markBad).toEqual(["d-email"]);
    expect(bounced.tracks[0]?.finishReason).toBe("failed_bad_destination");
    expect(bounced.attempts[1]).toMatchObject({ state: "accepted", withdrawRequested: true });
    expect(bounced.subject.ended).toBe("finished_no_usable_channel");
  });

  test("a bounce with another good email left finishes the lead with no response", () => {
    const base = subjectState();
    const two = {
      ...base,
      lead: {
        ...base.lead,
        details: [...base.lead.details, { id: "d-old", channel: "email" as const, ownEmail: true, value: "old@harbour.example", bad: false, order: 0 }],
        resolved: { ...base.lead.resolved, "d-old": { liveId: "d-old", bad: false, owned: true } },
      },
    };
    const s = launched(two);
    const bounced = applyBadDestination({ ...s, attempts: [handed({ state: "sent" })] }, handed(), MONDAY_9 + H);
    expect(bounced.tracks[0]?.finishReason).toBe("failed_bad_destination");
    expect(bounced.subject.ended).toBe("sequence_finished_no_response");
  });

  test("a late send on a track that already finished is recorded, but changes neither its finish nor its successor", () => {
    const s = launched();
    const finished = {
      ...s,
      tracks: s.tracks.map((t) => ({ ...t, finishedAt: 0, finishedWall: MONDAY_9, finishReason: "failed_bad_destination" as const })),
      attempts: [handed({ state: "accepted", withdrawRequested: true })],
    };
    const after = applyToAttempt(finished, "a-1", { kind: "sent_observed", providerTime: MONDAY_9 + 1000, providerRef: "p" }, MONDAY_9 + 2000, opts).state;
    expect(after.results.map((r) => r.stepId)).toEqual(["s1"]);
    expect(after.tracks[0]).toMatchObject({ finishReason: "failed_bad_destination", nextStepId: "s1", dueAt: 0 });
  });

  test("an invalid address refused at the handover marks it bad and fails the track", () => {
    const s = launched();
    const live = { ...s, attempts: [handed()] };
    const after = applyToAttempt(live, "a-1", { kind: "call_answer", answer: { kind: "rejected", reason: "invalid_destination" }, now: MONDAY_9 + 1000 }, MONDAY_9 + 1000, opts).state;
    expect(after.markBad).toEqual(["d-email"]);
    expect(after.tracks[0]?.finishReason).toBe("failed_bad_destination");
    expect(after.subject.ended).toBe("finished_no_usable_channel");
  });

  test("a block-listed address skips the track without marking it bad", () => {
    const s = launched();
    const after = applyToAttempt({ ...s, attempts: [handed()] }, "a-1", { kind: "call_answer", answer: { kind: "rejected", reason: "blocklisted" }, now: MONDAY_9 + 1000 }, MONDAY_9 + 1000, opts).state;
    expect(after.markBad).toEqual([]);
    expect(after.tracks[0]?.finishReason).toBe("skipped_missing_channel");
    expect(after.subject.ended).toBe("sequence_finished_no_response");
  });

  test("a rate limit leaves the step pending with its deadline unchanged", () => {
    const s = launched();
    const after = applyToAttempt({ ...s, attempts: [handed()] }, "a-1", { kind: "call_answer", answer: { kind: "rejected", reason: "rate_limited" }, now: MONDAY_9 + 1000 }, MONDAY_9 + 1000, opts).state;
    expect(after.tracks).toEqual(s.tracks);
    expect(after.subject.ended).toBeNull();
  });

  test("an address marked bad elsewhere ends a lead with no other address at the next evaluation, withdrawing its claim", () => {
    const s = launched();
    const marked = { ...s, lead: { ...s.lead, details: s.lead.details.map((d) => ({ ...d, bad: true })), resolved: { "d-email": { liveId: "d-email", bad: true, owned: true } } } };
    const after = evaluate({ ...marked, attempts: [attempt()] }, MONDAY_9 + H);
    expect(after.attempts[0]?.state).toBe("withdrawn");
    expect(after.subject.ended).toBe("finished_no_usable_channel");
  });
});

describe("a provider send belongs to the provider work that produced it (ruling 4; found by generated seed 20261117)", () => {
  const opts2 = { resetDay: () => "2026-11-02" };
  function inherited(inheritor: "accepted" | "claimed" = "accepted"): SubjectState {
    const s = launched();
    return {
      ...s,
      attempts: [
        handed({ id: "a-1", idempotencyKey: "a-1", state: "withdrawn", endedBy: "lookup_not_sent", providerRef: "p-1", handedWall: MONDAY_9 }),
        inheritor === "claimed"
          ? attempt({ id: "a-2", idempotencyKey: "a-1", claimedWall: MONDAY_9 + H })
          : handed({ id: "a-2", idempotencyKey: "a-1", state: "accepted", providerRef: "p-1", handedWall: MONDAY_9 + 2 * H }),
      ],
    };
  }

  test("a send reported against the inheritor settles on the original work, with its own handover time, and quiesces the inheritor", () => {
    const after = applyToAttempt(inherited(), "a-2", { kind: "sent_observed", providerTime: MONDAY_9 + 1000, providerRef: "p-1" }, MONDAY_9 + 3 * H, opts2).state;
    expect(after.attempts.map((a) => [a.id, a.state, a.withdrawRequested])).toEqual([["a-1", "sent", false], ["a-2", "accepted", true]]);
    // The original's handover (09:00) bounds the send time, not the inheritor's (11:00).
    expect(after.results).toEqual([expect.objectContaining({ stepId: "s1", attemptId: "a-1", atWall: MONDAY_9 + 1000 })]);
  });

  test("a claimed inheritor is withdrawn when the original work's send arrives", () => {
    const after = applyToAttempt(inherited("claimed"), "a-1", { kind: "sent_observed", providerTime: MONDAY_9 + 1000, providerRef: "p-1" }, MONDAY_9 + 2 * H, opts2).state;
    expect(after.attempts.map((a) => [a.id, a.state, a.endedBy])).toEqual([["a-1", "sent", "observed"], ["a-2", "withdrawn", "quiesce"]]);
  });

  test("a step never gets a second sent attempt: a later sent fact for the same work settles the live inheritor by the provider's statement", () => {
    const once = applyToAttempt(inherited(), "a-1", { kind: "sent_observed", providerTime: MONDAY_9 + 1000, providerRef: "p-1" }, MONDAY_9 + 3 * H, opts2).state;
    const again = applyToAttempt(once, "a-2", { kind: "lookup_answer", answer: { kind: "sent", sentAt: MONDAY_9 + 1000, providerRef: "p-1" }, now: MONDAY_9 + 4 * H }, MONDAY_9 + 4 * H, opts2).state;
    expect(again.attempts.map((a) => [a.id, a.state, a.endedBy])).toEqual([["a-1", "sent", "observed"], ["a-2", "withdrawn", "provider"]]);
  });

  test("the user's \"mark sent\" on a live inheritor whose work is already sent settles it, never a second sent attempt (found by the extended generator, seed 20261124)", () => {
    const once = applyToAttempt(inherited(), "a-1", { kind: "sent_observed", providerTime: MONDAY_9 + 1000, providerRef: "p-1" }, MONDAY_9 + 3 * H, opts2).state;
    const unresolved = { ...once, attempts: once.attempts.map((a) => (a.id === "a-2" ? { ...a, unresolvedSince: MONDAY_9 + 3 * H } : a)) };
    const marked = applyToAttempt(unresolved, "a-2", { kind: "mark_sent", now: MONDAY_9 + 4 * H }, MONDAY_9 + 4 * H, opts2).state;
    expect(marked.attempts.filter((a) => a.state === "sent").map((a) => a.id)).toEqual(["a-1"]);
    expect(marked.attempts.find((a) => a.id === "a-2")).toMatchObject({ state: "withdrawn", holdsReservation: false });
  });

  test("a sent fact attaches a missing provider reference to work already settled as sent (ruling 1)", () => {
    const s = launched();
    const state = { ...s, attempts: [handed({ id: "a-1", state: "sent", endedBy: "lookup", providerRef: null })] };
    const after = applyToAttempt(state, "a-1", { kind: "sent_observed", providerTime: MONDAY_9, providerRef: "p-9" }, MONDAY_9 + H, opts2).state;
    expect(after.attempts[0]?.providerRef).toBe("p-9");
  });
});
