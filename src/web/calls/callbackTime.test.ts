import { describe, expect, test } from "vitest";
import { callbackAdvice, callbackChoice, callbackDays, isoWithOffset, zonedInstants } from "./callbackTime.ts";

const iso = (ts: readonly number[]) => ts.map((t) => new Date(t).toISOString());

const WEEKDAYS_9_TO_17 = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));

describe("the prospect's requested time, entered in their zone, as an instant (ticket 15b)", () => {
  test("a wall time in the prospect's zone is that zone's instant, in winter and in summer", () => {
    expect(iso(zonedInstants("2026-11-05", "14:30", "Europe/London"))).toEqual(["2026-11-05T14:30:00.000Z"]);
    expect(iso(zonedInstants("2026-07-01", "14:30", "Europe/London"))).toEqual(["2026-07-01T13:30:00.000Z"]);
    expect(iso(zonedInstants("2026-11-05", "09:00", "America/New_York"))).toEqual(["2026-11-05T14:00:00.000Z"]);
  });

  test("a time the clocks skip does not exist; a time they repeat has both of its occurrences, earliest first", () => {
    expect(zonedInstants("2027-03-28", "01:30", "Europe/London")).toEqual([]);
    expect(iso(zonedInstants("2026-10-25", "01:30", "Europe/London"))).toEqual(["2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"]);
    expect(iso(zonedInstants("2027-10-31", "01:30", "Europe/London"))).toEqual(["2027-10-31T00:30:00.000Z", "2027-10-31T01:30:00.000Z"]);
  });

  test("the instant goes to the server in ISO 8601 with the prospect's offset", () => {
    expect(isoWithOffset(Date.parse("2026-11-05T14:30:00Z"), "Europe/London")).toBe("2026-11-05T14:30:00+00:00");
    expect(isoWithOffset(Date.parse("2026-07-01T13:30:00Z"), "Europe/London")).toBe("2026-07-01T14:30:00+01:00");
    expect(isoWithOffset(Date.parse("2026-11-05T14:00:00Z"), "America/New_York")).toBe("2026-11-05T09:00:00-05:00");
  });

  test("malformed input is no time at all", () => {
    expect(zonedInstants("2026-11-05", "", "Europe/London")).toEqual([]);
    expect(zonedInstants("not a day", "10:00", "Europe/London")).toEqual([]);
  });

  test("the days offered are the prospect's, from their today as of the server's read", () => {
    // 23:30 on Monday in London is already Tuesday in Berlin.
    const days = callbackDays("2026-11-02T23:30:00.000Z", "Europe/Berlin");
    expect(days[0]).toEqual({ value: "2026-11-03", label: "Today, Tue 3 Nov" });
    expect(days[1]).toEqual({ value: "2026-11-04", label: "Tomorrow, Wed 4 Nov" });
    expect(days[2]).toEqual({ value: "2026-11-05", label: "Thu 5 Nov" });
    expect(days).toHaveLength(28);
  });
});

describe("what the page can say before Log, as the engine judges it (ADR 0003 7.1.1, 2.3)", () => {
  const view = { zone: "Europe/London", asOf: "2026-11-02T10:00:00.000Z", callingHours: WEEKDAYS_9_TO_17 };
  test("nothing entered yet, a time that does not exist, a time already passed: Log sends nothing", () => {
    const none = { callbackAt: null };
    expect(callbackChoice({ ...none, callbackDay: "2026-11-02", callbackTime: "" }, view)).toEqual({ at: null, problem: "missing", occurrence: null });
    expect(callbackChoice({ ...none, callbackDay: null, callbackTime: "10:00" }, view)).toEqual({ at: null, problem: "missing", occurrence: null });
    expect(callbackChoice({ ...none, callbackDay: "2027-03-28", callbackTime: "01:30" }, view)).toEqual({ at: null, problem: "no_such_time", occurrence: null });
    // The engine refuses a time not after its own instant: the read's instant is the page's best knowledge of it.
    expect(callbackChoice({ ...none, callbackDay: "2026-11-02", callbackTime: "10:00" }, view)).toEqual({ at: null, problem: "past", occurrence: null });
    expect(callbackChoice({ ...none, callbackDay: "2026-11-02", callbackTime: "10:01" }, view)).toEqual({ at: Date.parse("2026-11-02T10:01:00Z"), problem: null, occurrence: "only" });
  });

  test("outside the calling hours, or on a day they never open, a callback is still accepted, and the page says so", () => {
    expect(callbackAdvice(Date.parse("2026-11-02T15:00:00Z"), view)).toBe("inside");
    expect(callbackAdvice(Date.parse("2026-11-02T18:00:00Z"), view)).toBe("outside");
    // Saturday 7 November: the hours never open.
    expect(callbackAdvice(Date.parse("2026-11-07T11:00:00Z"), view)).toBe("closed_day");
  });
});

describe("a time the clocks repeat: its earliest occurrence after the call's read, and the draft keeps it (council on 32454ea, B)", () => {
  const at = (asOf: string) => ({ zone: "Europe/London", asOf });
  const chosen = { callbackDay: "2027-10-31", callbackTime: "01:30", callbackAt: null };

  test("both occurrences still to come: the first, said as before the clocks go back", () => {
    expect(callbackChoice(chosen, at("2027-10-30T12:00:00.000Z"))).toEqual({ at: Date.parse("2027-10-31T00:30:00Z"), problem: null, occurrence: "first" });
  });

  test("inside the repeated hour, the first already passed: the second, still to come, and Log is not refused", () => {
    expect(callbackChoice(chosen, at("2027-10-31T01:05:00.000Z"))).toEqual({ at: Date.parse("2027-10-31T01:30:00Z"), problem: null, occurrence: "second" });
  });

  test("refused only when both occurrences are past", () => {
    expect(callbackChoice(chosen, at("2027-10-31T01:31:00.000Z"))).toEqual({ at: null, problem: "past", occurrence: null });
  });

  test("the draft keeps the instant chosen: after a reload, or a retry, the same occurrence is sent while it is still to come", () => {
    // Chosen while both were to come: the first. A later read inside the repeated hour, before the first: still the first.
    const kept = { ...chosen, callbackAt: Date.parse("2027-10-31T00:30:00Z") };
    expect(callbackChoice(kept, at("2027-10-31T00:10:00.000Z"))).toEqual({ at: Date.parse("2027-10-31T00:30:00Z"), problem: null, occurrence: "first" });
    // The second chosen (the first had passed) stays the second, whatever read comes next.
    const second = { ...chosen, callbackAt: Date.parse("2027-10-31T01:30:00Z") };
    expect(callbackChoice(second, at("2027-10-31T01:10:00.000Z"))).toEqual({ at: Date.parse("2027-10-31T01:30:00Z"), problem: null, occurrence: "second" });
    // A kept instant that is not an occurrence of the day and time entered (the entry changed) is not used.
    expect(callbackChoice({ ...chosen, callbackTime: "01:45", callbackAt: Date.parse("2027-10-31T00:30:00Z") }, at("2027-10-30T12:00:00.000Z"))).toEqual({ at: Date.parse("2027-10-31T00:45:00Z"), problem: null, occurrence: "first" });
  });
});
