import { describe, expect, test } from "vitest";
import { callbackAdvice, callbackChoice, callbackDays, isoWithOffset, zonedInstant } from "./callbackTime.ts";

const WEEKDAYS_9_TO_17 = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));

describe("the prospect's requested time, entered in their zone, as an instant (ticket 15b)", () => {
  test("a wall time in the prospect's zone is that zone's instant, in winter and in summer", () => {
    expect(new Date(zonedInstant("2026-11-05", "14:30", "Europe/London") ?? 0).toISOString()).toBe("2026-11-05T14:30:00.000Z");
    expect(new Date(zonedInstant("2026-07-01", "14:30", "Europe/London") ?? 0).toISOString()).toBe("2026-07-01T13:30:00.000Z");
    expect(new Date(zonedInstant("2026-11-05", "09:00", "America/New_York") ?? 0).toISOString()).toBe("2026-11-05T14:00:00.000Z");
  });

  test("a time the clocks skip does not exist; a time they repeat is the first of the two", () => {
    expect(zonedInstant("2027-03-28", "01:30", "Europe/London")).toBeNull();
    expect(new Date(zonedInstant("2026-10-25", "01:30", "Europe/London") ?? 0).toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });

  test("the instant goes to the server in ISO 8601 with the prospect's offset", () => {
    expect(isoWithOffset(Date.parse("2026-11-05T14:30:00Z"), "Europe/London")).toBe("2026-11-05T14:30:00+00:00");
    expect(isoWithOffset(Date.parse("2026-07-01T13:30:00Z"), "Europe/London")).toBe("2026-07-01T14:30:00+01:00");
    expect(isoWithOffset(Date.parse("2026-11-05T14:00:00Z"), "America/New_York")).toBe("2026-11-05T09:00:00-05:00");
  });

  test("malformed input is no time at all", () => {
    expect(zonedInstant("2026-11-05", "", "Europe/London")).toBeNull();
    expect(zonedInstant("not a day", "10:00", "Europe/London")).toBeNull();
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
    expect(callbackChoice({ callbackDay: "2026-11-02", callbackTime: "" }, view)).toEqual({ at: null, problem: "missing" });
    expect(callbackChoice({ callbackDay: null, callbackTime: "10:00" }, view)).toEqual({ at: null, problem: "missing" });
    expect(callbackChoice({ callbackDay: "2027-03-28", callbackTime: "01:30" }, view)).toEqual({ at: null, problem: "no_such_time" });
    // The engine refuses a time not after its own instant: the read's instant is the page's best knowledge of it.
    expect(callbackChoice({ callbackDay: "2026-11-02", callbackTime: "10:00" }, view)).toEqual({ at: null, problem: "past" });
    expect(callbackChoice({ callbackDay: "2026-11-02", callbackTime: "10:01" }, view)).toEqual({ at: Date.parse("2026-11-02T10:01:00Z"), problem: null });
  });

  test("outside the calling hours, or on a day they never open, a callback is still accepted, and the page says so", () => {
    expect(callbackAdvice(Date.parse("2026-11-02T15:00:00Z"), view)).toBe("inside");
    expect(callbackAdvice(Date.parse("2026-11-02T18:00:00Z"), view)).toBe("outside");
    // Saturday 7 November: the hours never open.
    expect(callbackAdvice(Date.parse("2026-11-07T11:00:00Z"), view)).toBe("closed_day");
  });
});
