import { describe, expect, test } from "vitest";
import { account, H, MONDAY_9, step, subjectState } from "../../../test/support/sequence-state.ts";
import { claimRefusal, stepWhen } from "./dispatch.ts";
import { readyCalls } from "./calls.ts";
import { localDayNumber } from "./clock.ts";
import { enterMain, evaluate } from "./progress.ts";
import type { WindowRule } from "./clock.ts";
import type { SubjectState } from "./state.ts";

/**
 * When a pending step goes, as the reads say it (ADR 0003 "Reads that say when"): the engine's own instant, from the
 * function the claim's step guard uses, or a reason with no time. Fictitious data.
 */

const MIN = 60_000;
const weekdays = (days: number[], start = 9, end = 17): WindowRule[] => days.map((day) => ({ day, start, end }));

function launchedWith(window: WindowRule[], at: number, fields: Partial<SubjectState> = {}, zone = "Europe/London"): SubjectState {
  const base = subjectState(fields);
  const def = { ...base.campaign.definition, tracks: base.campaign.definition.tracks.map((t) => ({ ...t, window, steps: [step("s1", { threading: "new_subject" }), step("s2", { waitDays: 2 })] })) };
  const s = { ...base, lead: { ...base.lead, zone }, campaign: { ...base.campaign, definition: def, launchedAt: at } };
  return evaluate(enterMain(s, at), at);
}

const item = { subjectId: "lead-1", trackId: "t1", stepId: "s1", touched: false, dueWall: MONDAY_9 };

describe("an email whose wait has ended outside its window (ticket 23, defect 2)", () => {
  // Tuesday to Friday, 09:00 to 17:00 London; launched Monday 2 November at 10:00.
  const s = launchedWith(weekdays([2, 3, 4, 5]), MONDAY_9 + H);
  const TUESDAY_9 = Date.parse("2026-11-03T09:00:00Z");

  test("goes when Tuesday's window opens, and the read says that instant, not the wait's end", () => {
    expect(stepWhen(s, "t1", MONDAY_9 + 2 * H)).toEqual({ kind: "at", at: TUESDAY_9 });
  });

  test("the claim's step guard agrees: refused a minute before that instant, accepted at it", () => {
    expect(claimRefusal(s, item, TUESDAY_9 - MIN)).toBe("the sending window is closed");
    expect(claimRefusal(s, item, TUESDAY_9)).toBeNull();
    expect(stepWhen(s, "t1", TUESDAY_9)).toEqual({ kind: "at", at: TUESDAY_9 });
  });

  test("inside the window a due step is due at the read's own instant, never at a past one", () => {
    expect(stepWhen(s, "t1", TUESDAY_9 + 3 * H)).toEqual({ kind: "at", at: TUESDAY_9 + 3 * H });
  });
});

describe("a reason, and no time, while the engine cannot know when", () => {
  const open = weekdays([0, 1, 2, 3, 4, 5, 6], 0, 24);

  test("a paused campaign, a paused lead, a callback hold and an ended lead", () => {
    const s = launchedWith(open, MONDAY_9);
    expect(stepWhen({ ...s, campaign: { ...s.campaign, pausedSince: MONDAY_9 } }, "t1", MONDAY_9)).toEqual({ kind: "waits", why: "campaign_paused" });
    expect(stepWhen({ ...s, subject: { ...s.subject, leadPaused: true } }, "t1", MONDAY_9)).toEqual({ kind: "waits", why: "lead_paused" });
    expect(stepWhen({ ...s, subject: { ...s.subject, ended: "stopped_manually" } }, "t1", MONDAY_9)).toEqual({ kind: "waits", why: "ended" });
  });

  test("every account the step may use is full for its reset day: no time before the reset, the instant after it", () => {
    const s = launchedWith(open, MONDAY_9);
    const full = { ...s, accounts: { "inbox-a": account("inbox-a", { capacity: 1, used: 1 }), "inbox-b": account("inbox-b", { capacity: 1, used: 1 }) } };
    expect(stepWhen(full, "t1", MONDAY_9)).toEqual({ kind: "waits", why: "sending_capacity" });
    // One account with room: due now.
    const room = { ...full, accounts: { ...full.accounts, "inbox-b": account("inbox-b") } };
    expect(stepWhen(room, "t1", MONDAY_9)).toEqual({ kind: "at", at: MONDAY_9 });
  });

  test("a full account does not hide an instant on a later reset day", () => {
    // Window opens Tuesday only; both inboxes (reset zone UTC) are full on Monday: Tuesday 09:00 is after their reset.
    const s = launchedWith(weekdays([2]), MONDAY_9);
    const full = { ...s, accounts: { "inbox-a": account("inbox-a", { capacity: 1, used: 1 }), "inbox-b": account("inbox-b", { capacity: 1, used: 1 }) } };
    expect(stepWhen(full, "t1", MONDAY_9)).toEqual({ kind: "at", at: Date.parse("2026-11-03T09:00:00Z") });
  });

  test("no account the step may use can send", () => {
    const s = launchedWith(open, MONDAY_9);
    const down = { ...s, accounts: { "inbox-a": account("inbox-a", { healthy: false }), "inbox-b": account("inbox-b", { healthy: false }) } };
    expect(stepWhen(down, "t1", MONDAY_9)).toEqual({ kind: "waits", why: "sender_unavailable" });
  });
});

describe("zones and clock changes", () => {
  test("the window is the prospect's: a lead in New York launched at 10:00 London waits for 09:00 New York", () => {
    // Monday 2 November 10:00 London is 05:00 in New York (EST, UTC-5).
    const s = launchedWith(weekdays([1, 2, 3, 4, 5]), MONDAY_9 + H, {}, "America/New_York");
    expect(stepWhen(s, "t1", MONDAY_9 + H)).toEqual({ kind: "at", at: Date.parse("2026-11-02T14:00:00Z") });
  });

  test("across the spring clock change: a window opening on the day after it is said at the new offset", () => {
    // Saturday 28 March 2026 12:00 London (GMT); the window is Monday only; British Summer Time starts Sunday 29 March.
    const saturday = Date.parse("2026-03-28T12:00:00Z");
    const s = launchedWith(weekdays([1]), saturday);
    expect(stepWhen(s, "t1", saturday)).toEqual({ kind: "at", at: Date.parse("2026-03-30T08:00:00Z") });
  });

  test("a two-day wait ends at the prospect's midnight and goes at the window's opening after it", () => {
    // Sent Monday 09:00; step 2 waits two days: due Wednesday 00:00 London, goes Wednesday 09:00.
    const s = launchedWith(weekdays([1, 2, 3, 4, 5]), MONDAY_9);
    const sent = { ...s, results: [{ stepId: "s1", trackId: "t1", result: "sent" as const, reason: null, at: 0, atWall: MONDAY_9, attemptId: null }] };
    const after = evaluate(sent, MONDAY_9);
    expect(after.tracks[0]?.nextStepId).toBe("s2");
    expect(stepWhen(after, "t1", MONDAY_9 + H)).toEqual({ kind: "at", at: Date.parse("2026-11-04T09:00:00Z") });
  });
});

describe("a call step: when it goes on the user's list", () => {
  const SATURDAY_10 = Date.parse("2026-11-07T10:00:00Z");
  function callLead(at: number, window: WindowRule[], zone: string, userZone = "Europe/London", fields: Partial<SubjectState> = {}): SubjectState {
    const base = subjectState(fields);
    const phone = { id: "phone", channel: "call" as const, branch: "main" as const, window, steps: [step("c1")], start: { kind: "entry" as const }, removed: false };
    const s: SubjectState = {
      ...base,
      lead: { ...base.lead, zone, phones: [{ id: "d-direct", kind: "direct", owner: "person", key: "+442079460120", value: "+44 20 7946 0120", bad: false, order: 2 }] },
      callDay: { ...base.callDay, userZone, day: localDayNumber(at, userZone) },
      campaign: { ...base.campaign, launchedAt: at, definition: { ...base.campaign.definition, tracks: [phone] } },
    };
    return evaluate(enterMain(s, at), at);
  }

  test("a call due on Saturday with weekday hours goes on the list at the start of Monday, the user's day; readyCalls agrees", () => {
    const s = callLead(SATURDAY_10, weekdays([1, 2, 3, 4, 5]), "Europe/London");
    const MONDAY = Date.parse("2026-11-09T00:00:00Z");
    expect(stepWhen(s, "phone", SATURDAY_10)).toEqual({ kind: "at", at: MONDAY });
    expect(readyCalls(s, SATURDAY_10)).toEqual([]);
    const monday = { ...s, callDay: { ...s.callDay, day: localDayNumber(MONDAY, "Europe/London") } };
    expect(stepWhen(monday, "phone", MONDAY)).toEqual({ kind: "at", at: MONDAY });
    expect(readyCalls(monday, MONDAY)).toHaveLength(1);
  });

  test("a prospect whose day differs from the user's: Sydney's Monday hours open during the user's Sunday in London", () => {
    // Sunday 8 November 23:00 London is Monday 10:00 in Sydney (AEDT, UTC+11): the hours open on the user's Sunday.
    const s = callLead(SATURDAY_10, weekdays([1, 2, 3, 4, 5]), "Australia/Sydney");
    expect(stepWhen(s, "phone", SATURDAY_10)).toEqual({ kind: "at", at: Date.parse("2026-11-08T00:00:00Z") });
  });

  test("today's list is full: no time, the call capacity is the reason", () => {
    const s = callLead(MONDAY_9, weekdays([1, 2, 3, 4, 5]), "Europe/London");
    const full = { ...s, callDay: { ...s.callDay, placedToday: 20 } };
    expect(stepWhen(full, "phone", MONDAY_9)).toEqual({ kind: "waits", why: "call_capacity" });
    expect(stepWhen(s, "phone", MONDAY_9)).toEqual({ kind: "at", at: MONDAY_9 });
  });
});
