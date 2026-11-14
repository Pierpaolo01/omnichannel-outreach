import { describe, expect, test } from "vitest";
import { DAY, H, MONDAY_9, subjectState, tracksDefinition } from "../../../test/support/sequence-state.ts";
import { bucketOf, callNumbers, compareReadyNow, isListed, logCallOutcome, placeCall, readyCalls, reasonOf } from "./calls.ts";
import { localDayNumber } from "./clock.ts";
import type { TrackDefinition } from "./definition.ts";
import { deriveStatus, enterMain, evaluate, runs } from "./progress.ts";
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
function launched(now: number, fields: { capacity?: number; committed?: number; placedToday?: number; phones?: CallNumber[] } = {}): SubjectState {
  const base = subjectState();
  const s: SubjectState = {
    ...base,
    campaign: { ...base.campaign, launchedAt: now, definition: tracksDefinition([callTrack()]) },
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

describe("redial (ticket 15; ADR 0003 2.4 \"Calls\")", () => {
  const out = (r: ReturnType<typeof logCallOutcome>) => {
    if (!r.ok) throw new Error(r.reason);
    return r.state;
  };
  test("a redial after no answer keeps the task open for the user's next day, its track open, and its original due time and skip deadline", () => {
    const s = placed(MONDAY_9);
    const before = s.callTasks[0]!;
    const after = out(logCallOutcome(s, "task-1", { requestId: "r1", outcome: "no_answer", redial: true, numberId: "d-direct", note: "", noteScope: "person" }, MONDAY_9 + H, { attempt: "a", note: "n" }));
    expect(after.callTasks[0]).toMatchObject({ open: true, kind: "call", listDay: before.listDay + 1, dueAt: before.dueAt, skipDeadline: before.skipDeadline });
    expect(after.tracks[0]?.finishedAt).toBeNull();
    expect(after.results).toEqual([]);
    expect(after.subject.touched).toBe(true);
    expect(after.callAttempts.at(-1)).toMatchObject({ outcome: "no_answer", redial: true });
    expect(deriveStatus(after)).toBe("waiting_on_call");
    // Not on the list again today: no outcome is accepted on it until tomorrow.
    expect(isListed(after, after.callTasks[0]!)).toBe(false);
    const tuesday = MONDAY_9 + DAY;
    expect(isListed(atDay(after, tuesday), after.callTasks[0]!)).toBe(true);
  });

  test("a redial is offered only after no answer, voicemail or gatekeeper", () => {
    const s = placed(MONDAY_9);
    for (const outcome of ["wrong_number", "interested", "skip_for_now"] as const) {
      expect(logCallOutcome(s, "task-1", { requestId: `r-${outcome}`, outcome, redial: true, numberId: "d-direct", note: "", noteScope: "person" }, MONDAY_9, { attempt: "a", note: "n" })).toEqual({ ok: false, reason: "A redial follows no answer, voicemail left, or gatekeeper or not reached." });
    }
  });
});

describe("callbacks (ticket 15; ADR 0003 2.2, 2.3, 2.4 \"Calls\", 3.2)", () => {
  const ok = (r: ReturnType<typeof logCallOutcome>) => {
    if (!r.ok) throw new Error(r.reason);
    return r.state;
  };
  const input = (requestId: string, fields: Partial<Parameters<typeof logCallOutcome>[2]> = {}) => ({ requestId, outcome: "no_answer" as const, numberId: "d-direct", note: "", noteScope: "person" as const, ...fields });
  /** Monday 10:00: the prospect asks to be called back on Wednesday at 15:00. */
  const WEDNESDAY_15 = MONDAY_9 + 2 * DAY + 6 * H;
  const requested = () => ok(logCallOutcome(placed(MONDAY_9), "task-1", input("r1", { outcome: "callback_requested", callbackAt: WEDNESDAY_15 }), MONDAY_9 + H, { attempt: "a1", note: "n1" }));

  test("a callback holds the lead: it no longer runs, its clock freezes, and its status is callback scheduled", () => {
    const s = requested();
    expect(s.callTasks[0]).toMatchObject({ open: true, kind: "callback", callbackAt: WEDNESDAY_15 });
    expect(runs(s)).toBe(false);
    expect(s.subject.clock.frozenSince).toBe(MONDAY_9 + H);
    expect(s.freezes.at(-1)).toEqual({ fromWall: MONDAY_9 + H, toWall: null });
    expect(deriveStatus(s)).toBe("callback_scheduled");
    expect(s.subject.touched).toBe(true);
    expect(s.results).toEqual([]);
    expect(s.callAttempts.at(-1)).toMatchObject({ outcome: "callback_requested", callbackAt: WEDNESDAY_15, redial: false });
  });

  test("a callback is listed from its own day, at any hour, and stays listed every day after until its outcome", () => {
    const s = requested();
    const task = s.callTasks[0]!;
    expect(isListed(s, task)).toBe(false);
    const wednesday1 = MONDAY_9 + 2 * DAY - 8 * H;
    expect(isListed(atDay(s, wednesday1), task)).toBe(true);
    expect(bucketOf(atDay(s, wednesday1), task, wednesday1)).toEqual({ bucket: "later_today", opensAt: WEDNESDAY_15 });
    expect(bucketOf(atDay(s, WEDNESDAY_15), task, WEDNESDAY_15)).toEqual({ bucket: "ready_now", opensAt: null });
    // Saturday at 22:00, outside every calling hour: the overdue callback is still ready now.
    const saturday22 = MONDAY_9 + 5 * DAY + 13 * H;
    expect(isListed(atDay(s, saturday22), task)).toBe(true);
    expect(bucketOf(atDay(s, saturday22), task, saturday22)).toEqual({ bucket: "ready_now", opensAt: null });
  });

  test("a callback must be for a time still to come, and only with a callback requested", () => {
    const s = placed(MONDAY_9);
    expect(logCallOutcome(s, "task-1", input("r1", { outcome: "callback_requested", callbackAt: MONDAY_9 }), MONDAY_9 + H, { attempt: "a", note: "n" })).toEqual({ ok: false, reason: "A callback is for a date and time still to come." });
    expect(logCallOutcome(s, "task-1", input("r1", { outcome: "callback_requested" }), MONDAY_9 + H, { attempt: "a", note: "n" })).toEqual({ ok: false, reason: "Give the date and time the prospect asked to be called back." });
    expect(logCallOutcome(s, "task-1", input("r1", { callbackAt: WEDNESDAY_15 }), MONDAY_9 + H, { attempt: "a", note: "n" })).toEqual({ ok: false, reason: "A date and time goes with a callback requested only." });
  });

  test("an outcome on the callback releases the hold first, so the call is logged at that instant on a running clock", () => {
    const s = requested();
    const thursday = WEDNESDAY_15 + DAY;
    const done = ok(logCallOutcome(atDay(s, thursday), "task-1", input("r2"), thursday, { attempt: "a2", note: "n2" }));
    // The hold's freeze closes at the outcome; the call is the lead's last step, so the sequence then finishes.
    expect(done.freezes).toEqual([...s.freezes.slice(0, -1), { fromWall: MONDAY_9 + H, toWall: thursday }, { fromWall: thursday, toWall: null }]);
    expect(done.callTasks[0]).toMatchObject({ open: false, closedWall: thursday });
    expect(done.tracks[0]).toMatchObject({ finishReason: "completed", finishedWall: thursday });
    expect(done.results.at(-1)).toMatchObject({ at: s.callTasks[0]!.dueAt + H, atWall: thursday });
    expect(deriveStatus(done)).toBe("sequence_finished_no_response");
  });

  test("a redial on the callback turns it back into a call for the next day with its original deadline; a new callback time keeps the hold", () => {
    const s = requested();
    const original = s.callTasks[0]!;
    const redialed = ok(logCallOutcome(atDay(s, WEDNESDAY_15), "task-1", input("r2", { outcome: "voicemail", redial: true }), WEDNESDAY_15, { attempt: "a2", note: "n2" }));
    expect(redialed.callTasks[0]).toMatchObject({ open: true, kind: "call", callbackAt: null, listDay: localDayNumber(WEDNESDAY_15, "Europe/London") + 1, dueAt: original.dueAt, skipDeadline: original.skipDeadline });
    expect(runs(redialed)).toBe(true);
    const later = WEDNESDAY_15 + 2 * DAY;
    const moved = ok(logCallOutcome(atDay(s, WEDNESDAY_15), "task-1", input("r3", { outcome: "callback_requested", callbackAt: later }), WEDNESDAY_15, { attempt: "a3", note: "n3" }));
    expect(moved.callTasks[0]).toMatchObject({ open: true, kind: "callback", callbackAt: later });
    expect(runs(moved)).toBe(false);
    expect(moved.freezes).toEqual(s.freezes);
  });

  test("skip for now on a callback keeps the hold", () => {
    const s = requested();
    const skipped = ok(logCallOutcome(atDay(s, WEDNESDAY_15), "task-1", input("r2", { outcome: "skip_for_now", numberId: null }), WEDNESDAY_15, { attempt: "a2", note: "n2" }));
    expect(skipped.callTasks[0]).toMatchObject({ open: true, kind: "callback" });
    expect(runs(skipped)).toBe(false);
  });
});

describe("the call skip limit (ticket 15; ADR 0003 3.5)", () => {
  const ok = (r: ReturnType<typeof logCallOutcome>) => {
    if (!r.ok) throw new Error(r.reason);
    return r.state;
  };
  const at = (s: SubjectState, t: number) => evaluate(atDay(s, t), t);
  const WED_0 = Date.parse("2026-11-04T00:00:00Z");

  test("an unworked call due Monday is listed Monday and Tuesday and skipped at the end of Tuesday; the track finishes then and releases what comes after", () => {
    const s = placed(MONDAY_9);
    expect(at(s, WED_0 - 1).callTasks[0]?.open).toBe(true);
    // Read late (the app was off until Thursday): the expiry is still the one at the end of Tuesday.
    for (const t of [WED_0, WED_0 + DAY + 10 * H]) {
      const out = at(s, t);
      expect(out.callTasks[0]).toMatchObject({ open: false, closedWall: WED_0 });
      expect(out.tracks[0]).toMatchObject({ finishReason: "skipped_unworked", finishedWall: WED_0, finishedAt: s.callTasks[0]!.dueAt + (WED_0 - MONDAY_9) });
      expect(out.results).toEqual([expect.objectContaining({ stepId: "c1", result: "skipped", reason: "unworked", atWall: WED_0 })]);
    }
  });

  test("days on which the calling hours never open are not listed days: a call due Friday is skipped at the end of Monday", () => {
    const friday9 = MONDAY_9 + 4 * DAY;
    const s = placed(friday9);
    const tuesday0 = MONDAY_9 + 7 * DAY + 15 * H;
    expect(at(s, tuesday0 - 1).callTasks[0]?.open).toBe(true);
    expect(at(s, tuesday0).tracks[0]).toMatchObject({ finishReason: "skipped_unworked", finishedWall: tuesday0 });
  });

  test("a redial does not reset the clock: redialed on Monday, it is skipped at the end of Tuesday; redialed on Tuesday, it gets Wednesday, its next listed day", () => {
    const s = placed(MONDAY_9);
    const redial = (base: SubjectState, t: number) => ok(logCallOutcome(atDay(base, t), "task-1", { requestId: `r${t}`, outcome: "no_answer", redial: true, numberId: "d-direct", note: "", noteScope: "person" }, t, { attempt: `a${t}`, note: `n${t}` }));
    expect(at(redial(s, MONDAY_9 + H), WED_0).tracks[0]?.finishReason).toBe("skipped_unworked");
    const tuesday = redial(s, MONDAY_9 + DAY + H);
    expect(at(tuesday, WED_0).callTasks[0]?.open).toBe(true);
    expect(at(tuesday, WED_0 + DAY).tracks[0]).toMatchObject({ finishReason: "skipped_unworked", finishedWall: WED_0 + DAY });
  });

  test("a callback never expires, and its days do not count: the lead's clock is frozen while it is held", () => {
    const s = placed(MONDAY_9);
    const held = ok(logCallOutcome(s, "task-1", { requestId: "r1", outcome: "callback_requested", callbackAt: MONDAY_9 + 4 * DAY, numberId: "d-direct", note: "", noteScope: "person" }, MONDAY_9 + H, { attempt: "a1", note: "n1" }));
    expect(at(held, MONDAY_9 + 9 * DAY).callTasks[0]).toMatchObject({ open: true, kind: "callback" });
    // Redialed off the callback on Friday, for Saturday: the lead ran one hour before the hold, so its deadline
    // (Wednesday 00:00 in lead time) falls on Saturday evening; Saturday and Sunday are not listed days, so it is skipped at the end of Monday.
    const friday = MONDAY_9 + 4 * DAY;
    const redialed = ok(logCallOutcome(atDay(held, friday), "task-1", { requestId: "r2", outcome: "no_answer", redial: true, numberId: "d-direct", note: "", noteScope: "person" }, friday, { attempt: "a2", note: "n2" }));
    const tuesday0 = MONDAY_9 + 7 * DAY + 15 * H;
    expect(at(redialed, tuesday0 - 1).callTasks[0]?.open).toBe(true);
    expect(at(redialed, tuesday0).tracks[0]).toMatchObject({ finishReason: "skipped_unworked", finishedWall: tuesday0 });
  });
});

describe("why a call is on the list, and its place in ready now (ticket 15; ADR 0003 4.4)", () => {
  const ok = (r: ReturnType<typeof logCallOutcome>) => {
    if (!r.ok) throw new Error(r.reason);
    return r.state;
  };
  test("due today; rolled over from an earlier day; a redial on the day it was moved to; a callback before its time, overdue after", () => {
    const s = placed(MONDAY_9);
    const task = () => s.callTasks[0]!;
    expect(reasonOf(s, task(), MONDAY_9)).toBe("due");
    expect(reasonOf(atDay(s, MONDAY_9 + DAY), task(), MONDAY_9 + DAY)).toBe("rolled_over");
    const redialed = ok(logCallOutcome(s, "task-1", { requestId: "r1", outcome: "voicemail", redial: true, numberId: "d-direct", note: "", noteScope: "person" }, MONDAY_9 + H, { attempt: "a", note: "n" }));
    expect(reasonOf(atDay(redialed, MONDAY_9 + DAY), redialed.callTasks[0]!, MONDAY_9 + DAY)).toBe("redial");
    expect(reasonOf(atDay(redialed, MONDAY_9 + 2 * DAY), redialed.callTasks[0]!, MONDAY_9 + 2 * DAY)).toBe("rolled_over");
    const callback = ok(logCallOutcome(s, "task-1", { requestId: "r2", outcome: "callback_requested", callbackAt: MONDAY_9 + 5 * H, numberId: "d-direct", note: "", noteScope: "person" }, MONDAY_9 + H, { attempt: "b", note: "m" }));
    expect(reasonOf(callback, callback.callTasks[0]!, MONDAY_9 + 2 * H)).toBe("callback");
    expect(reasonOf(callback, callback.callTasks[0]!, MONDAY_9 + 5 * H)).toBe("overdue");
  });

  test("ready now: callbacks first by the time asked for, then calls carried from earlier days, then today's, each oldest due first; calls skipped for now today last", () => {
    const entry = (taskId: string, rank: 0 | 1 | 2, dueWall: number, skippedWall: number | null = null) => ({ taskId, subjectId: taskId, stepId: "c1", rank, dueWall, skippedWall });
    const entries = [entry("today-old", 2, MONDAY_9 - 5 * DAY), entry("carried", 1, MONDAY_9 - DAY), entry("callback-late", 0, MONDAY_9 + H), entry("callback", 0, MONDAY_9), entry("skipped-carried", 1, MONDAY_9 - 3 * DAY, MONDAY_9)];
    expect([...entries].sort(compareReadyNow).map((e) => e.taskId)).toEqual(["callback", "callback-late", "carried", "today-old", "skipped-carried"]);
  });
});
