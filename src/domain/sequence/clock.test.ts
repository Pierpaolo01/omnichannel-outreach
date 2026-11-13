import { describe, expect, test } from "vitest";
import {
  isTimeZone,
  leadNow,
  localDayNumber,
  nextWindowOpen,
  prospectZone,
  sendPoint,
  span,
  startOfLocalDay,
  syncClock,
  wallOfLead,
  windowOpen,
  type Freeze,
} from "./clock.ts";

const H = 3_600_000;
const at = (iso: string) => Date.parse(iso);

describe("calendar-day spans in the prospect's zone (ADR 0003 3.3)", () => {
  test("N = 0 is due at once", () => {
    expect(span(at("2026-11-02T15:30:00Z"), 0, "Europe/London")).toBe(0);
  });

  test("a two-day wait is due at the start of the local day two days later", () => {
    // Monday 15:30 in London is due Wednesday 00:00 London.
    const w = at("2026-11-02T15:30:00Z");
    expect(w + span(w, 2, "Europe/London")).toBe(at("2026-11-04T00:00:00Z"));
  });

  test("the local date, not the UTC date, is the basis", () => {
    // 23:30 Monday in New York is 04:30 Tuesday UTC; one day later is Tuesday 00:00 New York.
    const w = at("2026-11-03T04:30:00Z");
    expect(w + span(w, 1, "America/New_York")).toBe(at("2026-11-03T05:00:00Z"));
  });

  test("a wait across the autumn clock change still lands on local midnight", () => {
    // London leaves summer time on Sunday 25 October 2026.
    const w = at("2026-10-24T10:00:00Z"); // Saturday 11:00 BST
    expect(w + span(w, 2, "Europe/London")).toBe(at("2026-10-26T00:00:00Z")); // Monday 00:00 GMT
    const ny = at("2026-10-31T16:00:00Z"); // Saturday 12:00 EDT; New York changes on 1 November
    expect(ny + span(ny, 1, "America/New_York")).toBe(at("2026-11-01T04:00:00Z")); // Sunday 00:00 EDT
    expect(ny + span(ny, 2, "America/New_York")).toBe(at("2026-11-02T05:00:00Z")); // Monday 00:00 EST
  });

  test("a zone whose midnight does not exist starts its day at the first instant that does", () => {
    // Santiago springs forward at 00:00 on Sunday 6 September 2026, so that day starts at 01:00 (-03).
    const start = startOfLocalDay(localDayNumber(at("2026-09-06T12:00:00Z"), "America/Santiago"), "America/Santiago");
    expect(start).toBe(at("2026-09-06T04:00:00Z"));
  });

  test("half-hour zones", () => {
    const w = at("2026-11-02T20:00:00Z"); // Tuesday 01:30 in Kolkata
    expect(w + span(w, 1, "Asia/Kolkata")).toBe(at("2026-11-03T18:30:00Z")); // Wednesday 00:00 IST
  });
});

describe("lead time (ADR 0003 3.2)", () => {
  test("a new subject starts frozen at lead time 0 and runs from its first sync", () => {
    const created = at("2026-11-02T09:00:00Z");
    const clock = { frozenSince: created, frozenTotal: created };
    expect(leadNow(clock, created + 5 * H)).toBe(0);
    const synced = syncClock(clock, [{ fromWall: created, toWall: null }], true, created + 5 * H);
    expect(synced.clock).toEqual({ frozenSince: null, frozenTotal: created + 5 * H });
    expect(synced.freezes).toEqual([{ fromWall: created, toWall: created + 5 * H }]);
    expect(leadNow(synced.clock, created + 7 * H)).toBe(2 * H);
  });

  test("lead time stands still while frozen and a freeze is recorded", () => {
    const clock = { frozenSince: null, frozenTotal: 0 };
    const stopped = syncClock(clock, [], false, 10 * H);
    expect(stopped.clock.frozenSince).toBe(10 * H);
    expect(stopped.freezes).toEqual([{ fromWall: 10 * H, toWall: null }]);
    expect(leadNow(stopped.clock, 30 * H)).toBe(10 * H);
    expect(wallOfLead(stopped.clock, 30 * H)).toBe(10 * H);
  });

  test("syncing a subject already in the right state changes nothing", () => {
    const clock = { frozenSince: null, frozenTotal: 7 };
    expect(syncClock(clock, [], true, 99)).toEqual({ clock, freezes: [] });
  });
});

describe("a provider's send time on the lead's clock (ADR 0003 3.3 trace)", () => {
  // Lead time L at Monday 09:00 UTC; the lead had run since lead time 0 at Monday 09:00 - L.
  const monday9 = at("2026-11-02T09:00:00Z");
  const L = 100 * H;

  test("pause between the handover and the send", () => {
    // Pause Monday 10:00 to Tuesday 10:00; send Tuesday 11:00; observed Thursday 11:00.
    const freezes: Freeze[] = [{ fromWall: monday9 + H, toWall: monday9 + 25 * H }];
    const clock = { frozenSince: null, frozenTotal: monday9 - L + 24 * H };
    const now = at("2026-11-05T11:00:00Z");
    const point = sendPoint(clock, freezes, at("2026-11-03T11:00:00Z"), monday9, now);
    expect(point.at).toBe(L + 2 * H);
    expect(point.atWall).toBe(at("2026-11-03T11:00:00Z"));
    const due = point.at + span(point.atWall, 2, "UTC");
    expect(due).toBe(L + 39 * H);
    // Lead time L + 39 h is Thursday 00:00 on the wall: already due when observed.
    expect(due + clock.frozenTotal).toBe(at("2026-11-05T00:00:00Z"));
  });

  test("the same pause after the send", () => {
    // Send Monday 11:00; pause Monday 12:00 to Tuesday 12:00; observed Thursday 11:00.
    const freezes: Freeze[] = [{ fromWall: monday9 + 3 * H, toWall: monday9 + 27 * H }];
    const clock = { frozenSince: null, frozenTotal: monday9 - L + 24 * H };
    const now = at("2026-11-05T11:00:00Z");
    const point = sendPoint(clock, freezes, at("2026-11-02T11:00:00Z"), monday9, now);
    expect(point.at).toBe(L + 2 * H);
    expect(point.atWall).toBe(at("2026-11-02T11:00:00Z"));
    const due = point.at + span(point.atWall, 2, "UTC");
    expect(due).toBe(L + 39 * H);
    expect(due + clock.frozenTotal).toBe(at("2026-11-05T00:00:00Z"));
  });

  test("a send inside a still-open freeze maps to the freeze's start", () => {
    // The lead ended on a reply at 12:00 (open freeze); the provider had sent at 11:00, observed at 15:00.
    const clock = { frozenSince: monday9 + 3 * H, frozenTotal: monday9 - L };
    const freezes: Freeze[] = [{ fromWall: monday9 + 3 * H, toWall: null }];
    const point = sendPoint(clock, freezes, monday9 + 2 * H, monday9, monday9 + 6 * H);
    expect(point.at).toBe(L + 2 * H);
    expect(point.atWall).toBe(monday9 + 2 * H);
    const inside = sendPoint(clock, freezes, monday9 + 4 * H, monday9, monday9 + 6 * H);
    expect(inside.at).toBe(L + 3 * H);
    expect(inside.atWall).toBe(monday9 + 3 * H);
  });

  test("provider clock skew is clamped to between the handover and now", () => {
    const clock = { frozenSince: null, frozenTotal: 0 };
    expect(sendPoint(clock, [], 50, 100, 200)).toEqual({ at: 100, atWall: 100 });
    expect(sendPoint(clock, [], 900, 100, 200)).toEqual({ at: 200, atWall: 200 });
  });
});

describe("sending windows in the prospect's zone (ADR 0003 3.4)", () => {
  const weekdays9to17 = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));

  test("open and closed", () => {
    expect(windowOpen(weekdays9to17, "Europe/London", at("2026-11-02T09:00:00Z"))).toBe(true);
    expect(windowOpen(weekdays9to17, "Europe/London", at("2026-11-02T17:00:00Z"))).toBe(false);
    expect(windowOpen(weekdays9to17, "America/New_York", at("2026-11-02T09:00:00Z"))).toBe(false);
    expect(windowOpen(weekdays9to17, "Europe/London", at("2026-11-07T10:00:00Z"))).toBe(false); // Saturday
  });

  test("an end before the start runs past midnight", () => {
    const overnight = [{ day: 5, start: 22, end: 2 }]; // Friday 22:00 to Saturday 02:00
    expect(windowOpen(overnight, "UTC", at("2026-11-06T23:00:00Z"))).toBe(true);
    expect(windowOpen(overnight, "UTC", at("2026-11-07T01:59:00Z"))).toBe(true);
    expect(windowOpen(overnight, "UTC", at("2026-11-07T02:00:00Z"))).toBe(false);
    expect(windowOpen(overnight, "UTC", at("2026-11-06T21:59:00Z"))).toBe(false);
  });

  test("a step due outside its window waits for the next window", () => {
    expect(nextWindowOpen(weekdays9to17, "Europe/London", at("2026-11-06T18:00:00Z"))).toBe(at("2026-11-09T09:00:00Z"));
    expect(nextWindowOpen(weekdays9to17, "Europe/London", at("2026-11-04T12:00:00Z"))).toBe(at("2026-11-04T12:00:00Z"));
    expect(nextWindowOpen(weekdays9to17, "Asia/Kolkata", at("2026-11-02T00:00:00Z"))).toBe(at("2026-11-02T03:30:00Z"));
  });
});

describe("the prospect's zone (ADR 0003 3.4)", () => {
  test("person, else company, else the campaign default; an invalid name falls through", () => {
    expect(prospectZone(["Europe/Paris", "Europe/London"], "UTC")).toBe("Europe/Paris");
    expect(prospectZone([null, "Not/AZone", "Europe/London"], "UTC")).toBe("Europe/London");
    expect(prospectZone([null, null], "Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(isTimeZone("Mars/Base")).toBe(false);
  });
});
