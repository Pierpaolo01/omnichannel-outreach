import { describe, expect, test } from "vitest";
import { DAY, H, MONDAY_9, step, subjectState, definition } from "../../../test/support/sequence-state.ts";
import { TEST_WAIT_MS, waitSpan } from "./clock.ts";
import { enterMain, evaluate, runs } from "./progress.ts";
import type { SubjectState } from "./state.ts";

/** A test run (ADR 0003 "Ticket 21"): the same subject, of kind test_run. */
const testRun = (fields: Partial<SubjectState> = {}): SubjectState => {
  const s = subjectState(fields);
  return { ...s, subject: { ...s.subject, id: "test-1", kind: "test_run" } };
};

describe("a test run's waits are about a minute, by the one wait rule (ADR 0003 'Ticket 21')", () => {
  test("a wait of days is 60 seconds for a test run and calendar days for a lead; no wait is no wait", () => {
    expect(waitSpan("test_run", MONDAY_9, 3, "Europe/London")).toBe(TEST_WAIT_MS);
    expect(TEST_WAIT_MS).toBe(60_000);
    expect(waitSpan("test_run", MONDAY_9, 0, "Europe/London")).toBe(0);
    // Monday 09:00 London plus 2 calendar days: Wednesday 00:00.
    expect(waitSpan("enrollment", MONDAY_9, 2, "Europe/London")).toBe(2 * DAY - 9 * H);
  });

  test("a test run entered at once has its first step due at once", () => {
    const def = definition([step("s1", { threading: "new_subject" }), step("s2", { waitDays: 3 })]);
    const s = evaluate(enterMain(testRun({ campaign: { ...subjectState().campaign, definition: def } }), MONDAY_9), MONDAY_9);
    // The first step is due at once.
    expect(s.tracks[0]?.dueWall).toBe(MONDAY_9);
  });
});

describe("whether a test run runs (ADR 0003 'Ticket 21', 3.6)", () => {
  test("it runs before launch and while the campaign is paused, where a lead does not", () => {
    const lead = subjectState();
    expect(runs(lead)).toBe(false);
    expect(runs(testRun())).toBe(true);
    const paused = { ...lead.campaign, launchedAt: MONDAY_9, pausedSince: MONDAY_9 + H };
    expect(runs({ ...lead, campaign: paused })).toBe(false);
    expect(runs(testRun({ campaign: paused }))).toBe(true);
  });

  test("an ended test run does not run", () => {
    const s = testRun();
    expect(runs({ ...s, subject: { ...s.subject, ended: "replied", endedAt: 0, endedWall: MONDAY_9 } })).toBe(false);
  });
});
