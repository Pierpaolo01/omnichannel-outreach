import { describe, expect, test } from "vitest";
import { attempt, DAY, definition, H, handed, MONDAY_9, step, subjectState, withAttempts, work } from "../../../test/support/sequence-state.ts";
import { leadNow } from "./clock.ts";
import { applyControl } from "./controls.ts";
import { afterInterruption, INTERRUPTION_GAP, interruptionOf, rescheduledSteps } from "./interruption.ts";
import { enterMain, evaluate } from "./progress.ts";
import type { SubjectState } from "./state.ts";

/** What an interruption is, and which sends it rescheduled (ADR 0003 "Ticket 20a"). Data is fictitious. */

const MIN = 60_000;
/** Wednesday 4 November 2026, 00:00 London: step s2's due instant after s1 is sent on Monday (a two-day wait). */
const WEDNESDAY_0 = Date.parse("2026-11-04T00:00:00Z");

function launched(now = MONDAY_9): SubjectState {
  // Each step with its own subject, so a follow-up is never held for want of a thread (5.4).
  const base = subjectState({ campaign: { ...subjectState().campaign, definition: definition([step("s1", { threading: "new_subject" }), step("s2", { waitDays: 2, threading: "new_subject" }), step("s3", { waitDays: 3, threading: "new_subject" })]) } });
  return evaluate(enterMain({ ...base, campaign: { ...base.campaign, launchedAt: now } }, now), now);
}
/** s1 sent at `at`; s2 pending, due Wednesday 00:00. */
function sentFirst(s: SubjectState, at: number): SubjectState {
  return evaluate({ ...s, subject: { ...s.subject, touched: true }, results: [{ stepId: "s1", trackId: "t1", result: "sent", reason: null, at: leadNow(s.subject.clock, at), atWall: at, attemptId: null }], tracks: s.tracks.map((t) => ({ ...t, nextStepId: null })) }, at);
}
const ok = (r: ReturnType<typeof applyControl>): SubjectState => {
  if (!r.ok) throw new Error(r.reason);
  return r.state;
};
const ids = (s: SubjectState, from: number, to: number) => rescheduledSteps(s, { from, to }, to).map((x) => x.stepId);

describe("what an interruption is", () => {
  test("a gap of more than five minutes since the last heartbeat, and nothing before the first heartbeat", () => {
    expect(INTERRUPTION_GAP).toBe(5 * MIN);
    expect(interruptionOf(null, MONDAY_9)).toBeNull();
    expect(interruptionOf(MONDAY_9, MONDAY_9 + 5 * MIN)).toBeNull();
    expect(interruptionOf(MONDAY_9, MONDAY_9 + 5 * MIN + 1)).toEqual({ from: MONDAY_9, to: MONDAY_9 + 5 * MIN + 1 });
  });

  test("an interruption changes no lead: it is not a pause", () => {
    const s = sentFirst(launched(), MONDAY_9);
    expect(afterInterruption(s, { from: MONDAY_9 + H, to: MONDAY_9 + 3 * DAY }, MONDAY_9 + 3 * DAY)).toBe(s);
  });
});

describe("the sends an interruption rescheduled", () => {
  const s = sentFirst(launched(), MONDAY_9);

  test("a step that fell due while the application could not send", () => {
    expect(ids(s, WEDNESDAY_0 - H, WEDNESDAY_0 + H)).toEqual(["s2"]);
  });

  test("a step already waiting when the interruption began counts; one due after it ended does not", () => {
    expect(ids(s, WEDNESDAY_0 + 2 * H, WEDNESDAY_0 + 3 * H)).toEqual(["s2"]);
    expect(ids(s, WEDNESDAY_0 - 3 * H, WEDNESDAY_0 - H)).toEqual([]);
    // Due exactly at the end: the application could send it at that instant.
    expect(ids(s, WEDNESDAY_0 - H, WEDNESDAY_0)).toEqual([]);
  });

  test("a lead held for the whole interruption is not counted; one that ran after its step fell due is", () => {
    // Paused Tuesday, before s2 fell due, through the interruption: lead time stood still, s2 never came due.
    const paused = ok(applyControl(s, "pause", MONDAY_9 + DAY));
    expect(ids(paused, WEDNESDAY_0 - H, WEDNESDAY_0 + 2 * DAY)).toEqual([]);
    // Paused at 02:00 Wednesday, inside the interruption: s2 was due and the lead ran from 00:00 to 02:00.
    const later = ok(applyControl(s, "pause", WEDNESDAY_0 + 2 * H));
    expect(ids(later, WEDNESDAY_0 - H, WEDNESDAY_0 + 5 * H)).toEqual(["s2"]);
    // Paused at 00:30, the interruption from 01:00: it never ran with s2 due inside the interruption.
    const before = ok(applyControl(s, "pause", WEDNESDAY_0 + 30 * MIN));
    expect(ids(before, WEDNESDAY_0 + H, WEDNESDAY_0 + 5 * H)).toEqual([]);
  });

  test("a window that stayed closed through the interruption counts nothing; one that opened during it does", () => {
    const nineToFive = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 9, end: 17 }));
    const narrowed: SubjectState = { ...s, campaign: { ...s.campaign, definition: { ...s.campaign.definition, tracks: s.campaign.definition.tracks.map((t) => ({ ...t, window: nineToFive })) } } };
    expect(ids(narrowed, WEDNESDAY_0 - H, WEDNESDAY_0 + 8 * H)).toEqual([]);
    expect(ids(narrowed, WEDNESDAY_0 - H, WEDNESDAY_0 + 9 * H + 1)).toEqual(["s2"]);
  });

  test("a step with work at the provider, an ended lead and a sent step are not counted; an open claim is", () => {
    const due = WEDNESDAY_0 + 2 * H;
    expect(ids(withAttempts(s, [attempt({ stepId: "s2" })]), WEDNESDAY_0 - H, due)).toEqual(["s2"]);
    expect(ids(withAttempts(s, [handed({ stepId: "s2" })]), WEDNESDAY_0 - H, due)).toEqual([]);
    // Work withdrawn on a not-sent the transport cannot vouch for is still uncertain: the provider may hold it.
    const uncertain: SubjectState = { ...withAttempts(s, [handed({ stepId: "s2", state: "withdrawn", endedBy: "lookup_not_sent" })]), work: [work({ stepId: "s2", calls: 1 })] };
    expect(ids(uncertain, WEDNESDAY_0 - H, due)).toEqual([]);
    expect(ids(ok(applyControl(s, "stop", WEDNESDAY_0 + H)), WEDNESDAY_0 - H, due)).toEqual([]);
    expect(ids(launched(), MONDAY_9 + H, MONDAY_9 + 2 * H)).toEqual(["s1"]);
  });
});
