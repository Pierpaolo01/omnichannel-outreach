import { describe, expect, test } from "vitest";
import { DAY, H, MONDAY_9, subjectState, tracksDefinition } from "../../../test/support/sequence-state.ts";
import { bucketOf, callNumbers, isListed, logCallOutcome, placeCall, readyCalls } from "./calls.ts";
import { localDayNumber } from "./clock.ts";
import type { TrackDefinition } from "./definition.ts";
import { deriveStatus, enterMain, evaluate } from "./progress.ts";
import type { CallNumber, SubjectState } from "./state.ts";

/** Call tasks as pure rules (ADR 0003 2.3, 2.4 "Calls", 4.4; ticket 14). Data is fictitious. */

const MIN = 60_000;
const WEEKDAYS_9_TO_17 = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
const phone = (id: string, kind: CallNumber["kind"], order: number, bad = false): CallNumber => ({ id, kind, owner: kind === "main_line" ? "company" : "person", key: `+4420794601${order}0`, value: `+44 20 7946 01${order}0`, bad, order });
const callTrack = (fields: Partial<TrackDefinition> = {}): TrackDefinition => ({
  id: "p1",
  channel: "call",
  branch: "main",
  window: WEEKDAYS_9_TO_17,
  steps: [{ id: "c1", waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false }],
  start: { kind: "entry" },
  removed: false,
  ...fields,
});

/** A lead in a launched call-only campaign at `now`, with the user's list on that day. */
function launched(now: number, fields: { capacity?: number; committed?: number; placedToday?: number; phones?: CallNumber[]; track?: Partial<TrackDefinition> } = {}): SubjectState {
  const base = subjectState();
  const s: SubjectState = {
    ...base,
    campaign: { ...base.campaign, launchedAt: now, definition: tracksDefinition([callTrack(fields.track)]) },
    lead: { ...base.lead, phones: fields.phones ?? [phone("d-main", "main_line", 1), phone("d-mobile", "mobile", 3), phone("d-direct", "direct", 2)] },
    callDay: { userZone: "Europe/London", day: localDayNumber(now, "Europe/London"), capacity: fields.capacity ?? 5, placedToday: fields.placedToday ?? 0, committed: fields.committed ?? 0 },
  };
  return evaluate(enterMain(s, now), now);
}
const atDay = (s: SubjectState, now: number): SubjectState => ({ ...s, callDay: { ...s.callDay, day: localDayNumber(now, "Europe/London") } });
const placed = (now: number, fields: Parameters<typeof launched>[1] = {}) => {
  const s = launched(now, fields);
  const item = readyCalls(s, now)[0];
  if (!item) throw new Error("no ready call");
  const out = placeCall(s, item, now, "task-1");
  if (!out) throw new Error("not placed");
  return out;
};

describe("placing a due call on the user's list (4.4)", () => {
  test("a due call is ready only while its calling hours are open now or later on the user's day", () => {
    expect(readyCalls(launched(MONDAY_9 - 2 * H), MONDAY_9 - 2 * H).map((r) => r.stepId)).toEqual(["c1"]);
    // Friday 18:00: the hours have closed and do not open again until Monday, so nothing is placed today.
    const friday = MONDAY_9 + 4 * DAY + 9 * H;
    expect(readyCalls(launched(friday), friday)).toEqual([]);
  });

  test("new calls are placed while new placed today stay below capacity minus committed; nothing else changes the lead", () => {
    expect(placeCall(launched(MONDAY_9, { capacity: 3, committed: 2, placedToday: 1 }), readyCalls(launched(MONDAY_9), MONDAY_9)[0]!, MONDAY_9, "t")).toBeNull();
    const s = placed(MONDAY_9, { capacity: 3, committed: 1, placedToday: 1 });
    expect(s.callTasks).toEqual([expect.objectContaining({ id: "task-1", trackId: "p1", stepId: "c1", dueWall: MONDAY_9, placedWall: MONDAY_9, listDay: localDayNumber(MONDAY_9, "Europe/London"), open: true, kind: "call" })]);
    expect(deriveStatus(s)).toBe("waiting_on_call");
    expect(s.subject.touched).toBe(false);
    // The skip limit (ticket 15) is resolved once, from the original due time: the start of the user's day two days later.
    expect(s.callTasks[0]?.skipDeadline).toBe(s.callTasks[0]!.dueAt + (Date.parse("2026-11-04T00:00:00Z") - MONDAY_9));
    expect(readyCalls(s, MONDAY_9)).toEqual([]);
  });

  test("the skip deadline is resolved from the phone track's own skip limit, else the campaign's (ticket 14c)", () => {
    // The campaign's limit is 2 days; this phone track's is 3: the start of the user's day three days after the due date.
    const own = placed(MONDAY_9, { track: { callSkipLimitDays: 3 } });
    expect(own.campaign.definition.callSkipLimitDays).toBe(2);
    expect(own.callTasks[0]?.skipDeadline).toBe(own.callTasks[0]!.dueAt + (Date.parse("2026-11-05T00:00:00Z") - MONDAY_9));
    const one = placed(MONDAY_9, { track: { callSkipLimitDays: 1 } });
    expect(one.callTasks[0]?.skipDeadline).toBe(one.callTasks[0]!.dueAt + (Date.parse("2026-11-03T00:00:00Z") - MONDAY_9));
  });

  test("the numbers are labelled, direct first, then mobile, then the main line", () => {
    expect(callNumbers(launched(MONDAY_9)).map((n) => n.kind)).toEqual(["direct", "mobile", "main_line"]);
  });
});

describe("the listing rule and the queue (2.3, 4.4)", () => {
  test("ready now inside calling hours; later today when they open later on the user's day; neither once they have closed for the day, though an outcome is still accepted", () => {
    const s = placed(MONDAY_9);
    const task = s.callTasks[0]!;
    expect(bucketOf(s, task, MONDAY_9)).toEqual({ bucket: "ready_now", opensAt: null });
    const tuesday6 = MONDAY_9 + DAY - 3 * H;
    expect(bucketOf(atDay(s, tuesday6), task, tuesday6)).toEqual({ bucket: "later_today", opensAt: MONDAY_9 + DAY });
    const monday18 = MONDAY_9 + 9 * H;
    expect(bucketOf(s, task, monday18)).toBeNull();
    expect(isListed(s, task)).toBe(true);
    const logged = logCallOutcome(s, task.id, { requestId: "r1", outcome: "no_answer", numberId: "d-direct", note: "", noteScope: "person" }, monday18, { attempt: "a", note: "n" });
    expect(logged.ok).toBe(true);
    // Saturday: Mon-Fri hours never open, so the call is not on the list and its outcome is refused.
    const saturday = MONDAY_9 + 5 * DAY;
    expect(isListed(atDay(s, saturday), task)).toBe(false);
    expect(logCallOutcome(atDay(s, saturday), task.id, { requestId: "r1", outcome: "no_answer", numberId: "d-direct", note: "", noteScope: "person" }, saturday, { attempt: "a", note: "n" })).toEqual({ ok: false, reason: "This call is not on today's list." });
  });

  test("skip for now keeps the task and the hold on the track, and is not a call made", () => {
    const s = placed(MONDAY_9);
    const out = logCallOutcome(s, "task-1", { requestId: "r1", outcome: "skip_for_now", numberId: null, note: "", noteScope: "person" }, MONDAY_9 + 5 * MIN, { attempt: "a", note: "n" });
    if (!out.ok) throw new Error(out.reason);
    expect(out.state.callTasks[0]).toMatchObject({ open: true, skippedWall: MONDAY_9 + 5 * MIN });
    expect(out.state.subject.touched).toBe(false);
    expect(out.state.results).toEqual([]);
    expect(out.state.tracks[0]?.finishedAt).toBeNull();
  });
});
