import { describe, expect, test } from "vitest";
import { DAY, H, handed, MONDAY_9, step, subjectState, track, tracksDefinition, withAttempts } from "../../../test/support/sequence-state.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "./definition.ts";
import { applyToWork, enterMain, evaluate } from "./progress.ts";
import { alignPending, changesBetween, editImpact, reconcileEdit } from "./reconcile.ts";
import type { SubjectState } from "./state.ts";

/**
 * Editing a running campaign (ADR 0003 "Ticket 19"): `reconcileEdit` brings one lead's stored progress in line with
 * the new definition. Instants are worked by hand from Monday 2 November 2026 09:00 London (GMT, so UTC).
 */

const opts = { resetDay: () => "2026-11-02" };
const steps3 = (): StepDefinition[] => [step("s1", { threading: "new_subject" }), step("s2", { waitDays: 2 }), step("s3", { waitDays: 3 })];
const emailTrack = (s: StepDefinition[] = steps3(), fields: Partial<TrackDefinition> = {}): TrackDefinition => ({ ...track("t1", "email", s), ...fields });

function launchedWith(def: CampaignDefinition, at = MONDAY_9): SubjectState {
  const base = subjectState();
  const s = { ...base, campaign: { ...base.campaign, definition: def, launchedAt: at } };
  return evaluate(enterMain(s, at), at);
}

/** Step `stepId` handed over and sent at `sentWall`, observed then. */
function sent(state: SubjectState, stepId: string, sentWall: number, id = `a-${stepId}`): SubjectState {
  const track = state.tracks.find((t) => t.nextStepId === stepId)!.trackId;
  const withOne = withAttempts(state, [...state.attempts, handed({ id, idempotencyKey: id, stepId, trackId: track, handedWall: sentWall, lastCallWall: sentWall })], state.work);
  return applyToWork(withOne, id, { kind: "sent_observed", providerTime: sentWall, providerRef: `p-${id}` }, sentWall, opts).state;
}

const withDefinition = (state: SubjectState, def: CampaignDefinition): SubjectState => ({ ...state, campaign: { ...state.campaign, definition: def, definitionVersion: state.campaign.definitionVersion + 1 } });
const progress = (s: SubjectState, trackId = "t1") => s.tracks.find((t) => t.trackId === trackId);

/** Reconciles `state` to `next` at `now`, as the save does. */
function edit(state: SubjectState, next: CampaignDefinition, now: number): SubjectState {
  return reconcileEdit(withDefinition(state, next), state.campaign.definition, state.lead.zone, now);
}

describe("a removed step is skipped by leads not yet at it", () => {
  test("the pending step removed: the next live step becomes pending, due from the same basis with its own wait", () => {
    const before = sent(launchedWith(tracksDefinition([emailTrack()])), "s1", MONDAY_9);
    expect(progress(before)).toMatchObject({ nextStepId: "s2", dueWall: Date.parse("2026-11-04T00:00:00Z") });
    const removed = tracksDefinition([emailTrack(steps3().map((s) => (s.id === "s2" ? { ...s, removed: true } : s)))]);
    const after = edit(before, removed, MONDAY_9 + 5 * H);
    // s3 waits 3 days from s1's send (its basis): Thursday 5 November 00:00.
    expect(progress(after)).toMatchObject({ nextStepId: "s3", basisWall: MONDAY_9, dueWall: Date.parse("2026-11-05T00:00:00Z") });
    expect(after.results.map((r) => r.stepId)).toEqual(["s1"]);
  });
});

describe("waits, copy and added steps apply to unsent messages only", () => {
  const afterFirst = () => sent(launchedWith(tracksDefinition([emailTrack()])), "s1", MONDAY_9);
  const withStep = (id: string, change: Partial<StepDefinition>) => tracksDefinition([emailTrack(steps3().map((s) => (s.id === id ? { ...s, ...change } : s)))]);

  test("a changed wait re-resolves the pending step from its basis, not from the edit", () => {
    const after = edit(afterFirst(), withStep("s2", { waitDays: 1 }), MONDAY_9 + 2 * DAY);
    // One day after Monday's send: Tuesday 00:00, already past at the edit, so due at once.
    expect(progress(after)).toMatchObject({ nextStepId: "s2", dueWall: Date.parse("2026-11-03T00:00:00Z"), basisWall: MONDAY_9 });
  });

  test("an edit of a step's copy withdraws a claim on it; one on an unchanged step stays", () => {
    const first = afterFirst();
    const claimed = withAttempts(first, [...first.attempts, { ...handed({ id: "c2", idempotencyKey: "c2", stepId: "s2" }), state: "claimed", calls: 0, handedWall: null, handedAt: null, lastCallWall: null, awaitingAnswer: false, copy: null }], first.work);
    const unchanged = edit(claimed, withStep("s3", { body: "New words." }), MONDAY_9 + 3 * DAY);
    expect(unchanged.attempts.find((a) => a.id === "c2")?.state).toBe("claimed");
    const changed = edit(claimed, withStep("s2", { body: "New words." }), MONDAY_9 + 3 * DAY);
    expect(changed.attempts.find((a) => a.id === "c2")).toMatchObject({ state: "withdrawn" });
    expect(progress(changed)).toMatchObject({ nextStepId: "s2", dueWall: Date.parse("2026-11-04T00:00:00Z") });
  });

  test("a step added between the last sent one and the pending one becomes pending; one added behind the lead is not sent to it (Q22)", () => {
    const twoSent = sent(afterFirst(), "s2", Date.parse("2026-11-04T09:00:00Z"));
    const added = tracksDefinition([emailTrack([step("s0", { threading: "new_subject" }), ...steps3().map((s) => (s.id === "s1" ? { ...s, threading: "continue_thread" as const, waitDays: 1 } : s)), step("s4", { waitDays: 1 })])]);
    const ahead = tracksDefinition([emailTrack([...steps3().slice(0, 2), step("s2b", { waitDays: 1 }), steps3()[2]!])]);
    const behind = edit(twoSent, added, Date.parse("2026-11-04T10:00:00Z"));
    expect(progress(behind)?.nextStepId).toBe("s3");
    const reaches = edit(twoSent, ahead, Date.parse("2026-11-04T10:00:00Z"));
    expect(progress(reaches)).toMatchObject({ nextStepId: "s2b", dueWall: Date.parse("2026-11-05T00:00:00Z") });
  });

  test("removing the last step a lead waits for finishes the track at the edit (Q23)", () => {
    const twoSent = sent(afterFirst(), "s2", Date.parse("2026-11-04T09:00:00Z"));
    const editAt = Date.parse("2026-11-05T12:00:00Z");
    const after = edit(twoSent, withStep("s3", { removed: true }), editAt);
    expect(progress(after)).toMatchObject({ finishReason: "completed", finishedWall: editAt });
  });
});

describe("what is in flight or finished is never touched", () => {
  test("a pending step handed to the provider keeps its place; once it settles not sent, the removed step is passed over", () => {
    const base = sent(launchedWith(tracksDefinition([emailTrack()])), "s1", MONDAY_9);
    const inFlight = withAttempts(base, [...base.attempts, handed({ id: "h2", idempotencyKey: "h2", stepId: "s2", handedWall: MONDAY_9 + 2 * DAY })], base.work);
    const removed = tracksDefinition([emailTrack(steps3().map((s) => (s.id === "s2" ? { ...s, removed: true } : s)))]);
    const after = edit(inFlight, removed, MONDAY_9 + 2 * DAY + H);
    expect(progress(after)?.nextStepId).toBe("s2");
    expect(after.attempts.find((a) => a.id === "h2")?.state).toBe("handed");
    // The provider confirms it withdrew it: the step was never sent, so 5.1's step under the new definition follows.
    // `attend`, run after every change to provider work, aligns the pending step once nothing is in flight.
    const wanted = { ...after, work: after.work.map((w) => (w.key === "h2" ? { ...w, withdrawWanted: true } : w)) };
    const settled = applyToWork(wanted, "h2", { kind: "withdraw_answer", answer: "withdrawn", now: MONDAY_9 + 2 * DAY + 2 * H }, MONDAY_9 + 2 * DAY + 2 * H, opts).state;
    expect(settled.work.find((w) => w.key === "h2")?.settled).toBe("withdrawn");
    expect(progress(settled)).toMatchObject({ nextStepId: "s3", dueWall: Date.parse("2026-11-05T00:00:00Z") });
    expect(alignPending(settled, MONDAY_9 + 3 * DAY)).toEqual(settled);
  });

  test("a finished track is never restarted by an added step", () => {
    const one = tracksDefinition([emailTrack([step("s1", { threading: "new_subject" })])]);
    const done = sent(launchedWith(one), "s1", MONDAY_9);
    expect(progress(done)?.finishReason).toBe("completed");
    const after = edit(done, tracksDefinition([emailTrack([step("s1", { threading: "new_subject" }), step("s2", { waitDays: 1 })])]), MONDAY_9 + H);
    expect(progress(after)).toEqual(progress(done));
  });
});

describe("rearranging tracks applies only to leads that have not started them", () => {
  const sms = (start: TrackDefinition["start"], fields: Partial<TrackDefinition> = {}) => ({ ...track("t2", "sms", [step("m1", { subject: "" })], start), ...fields });

  test("an unstarted track's resolved start is forgotten when it is reconnected, and kept when nothing about it changed", () => {
    const def = tracksDefinition([emailTrack([step("s1", { threading: "new_subject" })]), sms({ kind: "after", trackId: "t1", delayDays: 3 })]);
    const done = sent(launchedWith(def), "s1", MONDAY_9);
    expect(progress(done, "t2")).toMatchObject({ startedAt: null, startBasisWall: MONDAY_9 });
    const kept = edit(done, tracksDefinition([emailTrack([step("s1", { threading: "new_subject", body: "Other words." })]), sms({ kind: "after", trackId: "t1", delayDays: 3 })]), MONDAY_9 + H);
    expect(progress(kept, "t2")).toEqual(progress(done, "t2"));
    const moved = edit(done, tracksDefinition([emailTrack([step("s1", { threading: "new_subject" })]), sms({ kind: "after", trackId: "t1", delayDays: 1 })]), MONDAY_9 + H);
    expect(progress(moved, "t2")).toMatchObject({ startAt: null, startBasisAt: null });
    // The next evaluation resolves it under the new rule: one day after the email track finished.
    const evaluated = evaluate(moved, MONDAY_9 + 2 * H);
    expect(progress(evaluated, "t2")?.startBasisWall).toBe(MONDAY_9);
    const removed = edit(done, tracksDefinition([emailTrack([step("s1", { threading: "new_subject" })]), sms({ kind: "after", trackId: "t1", delayDays: 3 }, { removed: true })]), MONDAY_9 + H);
    expect(progress(evaluate(removed, MONDAY_9 + 5 * DAY), "t2")?.startedAt ?? null).toBeNull();
  });

  test("a held lead is reconciled too: its new deadline moves with its frozen clock", () => {
    const base = sent(launchedWith(tracksDefinition([emailTrack()])), "s1", MONDAY_9);
    const paused = { ...base, campaign: { ...base.campaign, pausedSince: MONDAY_9 + H } };
    const after = edit(paused, tracksDefinition([emailTrack(steps3().map((s) => (s.id === "s2" ? { ...s, waitDays: 5 } : s)))]), MONDAY_9 + 2 * H);
    expect(progress(after)).toMatchObject({ nextStepId: "s2", dueWall: Date.parse("2026-11-07T00:00:00Z") });
  });
});

describe("what an edit does to one lead (the editor's read)", () => {
  const def0 = tracksDefinition([emailTrack()]);
  const afterFirst = () => sent(launchedWith(def0), "s1", MONDAY_9);

  test("each change between two definitions, by identity", () => {
    const next = tracksDefinition([
      emailTrack([step("s1", { threading: "new_subject", body: "Changed." }), { ...step("s2", { waitDays: 2 }), removed: true }, step("s3", { waitDays: 1 }), step("s4", { waitDays: 1 })]),
      track("t2", "sms", [step("m1", { subject: "" })]),
    ]);
    expect(changesBetween(def0, next).map((c) => `${c.kind} ${c.trackId} ${c.stepId ?? ""}`.trim())).toEqual(["step_copy t1 s1", "step_removed t1 s2", "step_wait t1 s3", "step_added t1 s4", "track_added t2"]);
  });

  test("a lead between two steps: the removed pending step is skipped, a changed earlier step leaves it untouched, an added later one reaches it", () => {
    const before = afterFirst();
    const next = tracksDefinition([emailTrack([step("s1", { threading: "new_subject", body: "Changed." }), { ...step("s2", { waitDays: 2 }), removed: true }, step("s3", { waitDays: 3 }), step("s4", { waitDays: 1 })])]);
    const after = edit(before, next, MONDAY_9 + H);
    const impact = editImpact(before, after, changesBetween(def0, next));
    expect(impact).toEqual(["untouched", "skips", "reaches"]);
  });

  test("a lead whose pending step is with the provider holds it in flight; an ended lead is untouched by everything", () => {
    const base = afterFirst();
    const flying = withAttempts(base, [...base.attempts, handed({ id: "h2", idempotencyKey: "h2", stepId: "s2" })], base.work);
    const next = tracksDefinition([emailTrack(steps3().map((s) => (s.id === "s2" ? { ...s, body: "Changed." } : s)))]);
    expect(editImpact(flying, edit(flying, next, MONDAY_9 + H), changesBetween(def0, next))).toEqual(["in_flight"]);
    const ended = { ...base, subject: { ...base.subject, ended: "replied" as const } };
    expect(editImpact(ended, edit(ended, next, MONDAY_9 + H), changesBetween(def0, next))).toEqual(["untouched"]);
  });
});

describe("a change of the campaign's default zone (ADR 0003 \"Ticket 19\", step 3)", () => {
  test("a lead on the default zone has its pending deadline re-resolved in the new zone, from the same basis", () => {
    const before = sent(launchedWith(tracksDefinition([emailTrack()])), "s1", MONDAY_9);
    expect(progress(before)?.dueWall).toBe(Date.parse("2026-11-04T00:00:00Z"));
    const next = { ...tracksDefinition([emailTrack()]), timezone: "America/New_York" };
    const moved = { ...withDefinition(before, next), lead: { ...before.lead, zone: "America/New_York" } };
    const after = reconcileEdit(moved, before.campaign.definition, "Europe/London", MONDAY_9 + H);
    // Two days after Monday 09:00 London (04:00 in New York): Wednesday 00:00 in New York, 05:00 UTC.
    expect(progress(after)).toMatchObject({ nextStepId: "s2", dueZone: "America/New_York", dueWall: Date.parse("2026-11-04T05:00:00Z") });
    // A lead whose zone is its own (it did not move) keeps its deadline.
    expect(progress(reconcileEdit(withDefinition(before, next), before.campaign.definition, "Europe/London", MONDAY_9 + H))).toEqual(progress(before));
  });
});

describe("the pending step is 5.1's whatever wrote it (ADR 0003 \"Ticket 19\", step 4)", () => {
  test("a pending step pointed back at a sent step is brought forward again (retires the control mutation \"a restart rewinds to the track's first step\")", () => {
    const base = sent(launchedWith(tracksDefinition([emailTrack()])), "s1", MONDAY_9);
    const rewound = { ...base, tracks: base.tracks.map((t) => ({ ...t, nextStepId: "s1" })) };
    expect(progress(evaluate(rewound, MONDAY_9 + H))?.nextStepId).toBe("s2");
    expect(progress(alignPending(rewound, MONDAY_9 + H))).toEqual(progress(base));
  });
});
