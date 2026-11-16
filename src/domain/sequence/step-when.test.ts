import { describe, expect, test } from "vitest";
import { account, calledWork, H, handed, MOBILE, MONDAY_9, multiTrackState, step, subjectState, track, withAttempts } from "../../../test/support/sequence-state.ts";
import { chooseAccount, claim, claimRefusal, heldReason, holdWait, stepWhen } from "./dispatch.ts";
import { logCallOutcome, placeCall, readyCalls } from "./calls.ts";
import { localDayNumber } from "./clock.ts";
import { applyToAttempt, enterMain, evaluate } from "./progress.ts";
import type { WindowRule } from "./clock.ts";
import type { AccountState, SubjectState } from "./state.ts";

/**
 * When a pending step goes, as the reads say it (ADR 0003 "Reads that say when"): the engine's own instant, from the
 * function the claim's step guard uses, or a reason with no time. Fictitious data.
 */

const MIN = 60_000;
const weekdays = (days: number[], start = 9, end = 17): WindowRule[] => days.map((day) => ({ day, start, end }));

function launchedWith(window: WindowRule[], at: number, fields: Partial<SubjectState> = {}, zone = "Europe/London"): SubjectState {
  const base = subjectState(fields);
  const def = { ...base.campaign.definition, tracks: base.campaign.definition.tracks.map((t) => ({ ...t, window, steps: [step("s1", { threading: "new_subject" }), step("s2", { waitDays: 2, threading: "new_subject" })] })) };
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
    expect(stepWhen(s, "phone", SATURDAY_10)).toEqual({ kind: "call_day", at: MONDAY, day: localDayNumber(MONDAY, "Europe/London") });
    expect(readyCalls(s, SATURDAY_10)).toEqual([]);
    const monday = { ...s, callDay: { ...s.callDay, day: localDayNumber(MONDAY, "Europe/London") } };
    expect(stepWhen(monday, "phone", MONDAY)).toMatchObject({ kind: "call_day", at: MONDAY });
    expect(readyCalls(monday, MONDAY)).toHaveLength(1);
  });

  test("a prospect whose day differs from the user's: Sydney's Monday hours open during the user's Sunday in London", () => {
    // Sunday 8 November 23:00 London is Monday 10:00 in Sydney (AEDT, UTC+11): the hours open on the user's Sunday.
    const s = callLead(SATURDAY_10, weekdays([1, 2, 3, 4, 5]), "Australia/Sydney");
    expect(stepWhen(s, "phone", SATURDAY_10)).toMatchObject({ kind: "call_day", at: Date.parse("2026-11-08T00:00:00Z") });
  });

  test("today's list is full: no time, the call capacity is the reason", () => {
    const s = callLead(MONDAY_9, weekdays([1, 2, 3, 4, 5]), "Europe/London");
    const full = { ...s, callDay: { ...s.callDay, placedToday: 20 } };
    expect(stepWhen(full, "phone", MONDAY_9)).toEqual({ kind: "waits", why: "call_capacity" });
    expect(stepWhen(s, "phone", MONDAY_9)).toMatchObject({ kind: "call_day", at: MONDAY_9 });
  });
});

describe("the window's opening around a clock change: the read's instant is the first instant dispatch's own check accepts", () => {
  /** Steps the claim's step guard forward minute by minute from `from`: the first instant it accepts. */
  function firstAccepted(s: SubjectState, from: number): number {
    for (let t = from; t < from + 10 * 24 * H; t += MIN) if (claimRefusal(s, item, t) === null) return t;
    throw new Error("never accepted");
  }
  const cases: { name: string; zone: string; window: WindowRule[]; at: string }[] = [
    // London, spring: 01:00 local does not exist on 29 March 2026 (00:59 GMT is followed by 02:00 BST).
    { name: "London, a window from 01:00, which does not exist that night", zone: "Europe/London", window: [{ day: 0, start: 1, end: 3 }], at: "2026-03-28T12:00:00Z" },
    // London, spring: a window that ends inside the missing hour.
    { name: "London, a window ending at 02:00, inside the missing hour", zone: "Europe/London", window: [{ day: 0, start: 0, end: 2 }], at: "2026-03-28T12:00:00Z" },
    // Berlin, autumn: 02:00 local occurs twice on 25 October 2026 (00:00Z in CEST, 01:00Z in CET).
    { name: "Berlin, a window from 02:00, which occurs twice", zone: "Europe/Berlin", window: [{ day: 0, start: 2, end: 3 }], at: "2026-10-24T12:00:00Z" },
    // Berlin, autumn: a window that ends inside the repeated hour, and reopens when the clock goes back.
    { name: "Berlin, a window ending at 02:00, inside the repeated hour", zone: "Europe/Berlin", window: [{ day: 0, start: 1, end: 2 }], at: "2026-10-25T00:30:00Z" },
    // Sydney, spring (southern): 02:00 local does not exist on 4 October 2026.
    { name: "Sydney, a window from 02:00, which does not exist that night", zone: "Australia/Sydney", window: [{ day: 0, start: 2, end: 4 }], at: "2026-10-03T02:00:00Z" },
    // Sydney, autumn (southern): 02:00 local occurs twice on 5 April 2026.
    { name: "Sydney, a window from 02:00, which occurs twice", zone: "Australia/Sydney", window: [{ day: 0, start: 2, end: 3 }], at: "2026-04-04T02:00:00Z" },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const at = Date.parse(c.at);
      const s = launchedWith(c.window, at, {}, c.zone);
      const accepted = firstAccepted(s, at);
      expect(stepWhen(s, "t1", at)).toEqual({ kind: "at", at: accepted });
    });
  }

  test("the reported cases exactly: London opens 29 March 01:00Z, Berlin at the first 02:00 (00:00Z)", () => {
    const london = launchedWith([{ day: 0, start: 1, end: 3 }], Date.parse("2026-03-28T12:00:00Z"));
    expect(stepWhen(london, "t1", Date.parse("2026-03-28T12:00:00Z"))).toEqual({ kind: "at", at: Date.parse("2026-03-29T01:00:00Z") });
    const berlin = launchedWith([{ day: 0, start: 2, end: 3 }], Date.parse("2026-10-24T12:00:00Z"), {}, "Europe/Berlin");
    expect(stepWhen(berlin, "t1", Date.parse("2026-10-24T12:00:00Z"))).toEqual({ kind: "at", at: Date.parse("2026-10-25T00:00:00Z") });
  });
});

describe("a reservation waives capacity and the in-flight bound only: the read reaches the dispatcher's own choice (review bot and council on 178de98)", () => {
  const open = weekdays([0, 1, 2, 3, 4, 5, 6], 0, 24);
  /** Step 1's work at the provider, called and withdrawn on a non-final not-sent: still uncertain, so a new claim inherits it on inbox-a. */
  function inherited(fields: Partial<SubjectState> = {}, accountA: Partial<AccountState> = {}): SubjectState {
    const s = launchedWith(open, MONDAY_9, fields);
    const old = handed({ id: "a-0", idempotencyKey: "a-0", state: "withdrawn", endedBy: "lookup_not_sent" });
    const w = withAttempts({ ...s, subject: { ...s.subject, emailSender: "inbox-a" } }, [old], [calledWork({ key: "a-0", unresolvedSince: MONDAY_9 })]);
    return { ...w, accounts: { "inbox-a": account("inbox-a", { used: 1, ...accountA }), "inbox-b": account("inbox-b") } };
  }

  test("inherited work whose fixed sender is disconnected: a reason, never a time, and the dispatcher chooses no account", () => {
    const s = inherited({}, { healthy: false, problem: "disconnected" });
    expect(chooseAccount(s, MONDAY_9, "s1")).toBeNull();
    expect(stepWhen(s, "t1", MONDAY_9)).toEqual({ kind: "waits", why: "sender_unavailable" });
  });

  test("inherited work whose healthy sender is held until a known instant: that instant", () => {
    const s = inherited({}, { waitUntil: MONDAY_9 + 2 * H, waitReason: "rate_limited" });
    expect(stepWhen(s, "t1", MONDAY_9)).toEqual({ kind: "at", at: MONDAY_9 + 2 * H });
    expect(chooseAccount(s, MONDAY_9 + 2 * H, "s1")?.id).toBe("inbox-a");
  });

  test("inherited work on a full inbox still goes: its reservation is carried (the existing behaviour)", () => {
    const s = inherited({}, { capacity: 1, used: 1 });
    expect(chooseAccount(s, MONDAY_9, "s1")?.id).toBe("inbox-a");
    expect(stepWhen(s, "t1", MONDAY_9)).toEqual({ kind: "at", at: MONDAY_9 });
  });

  test("a claimed step whose window closes before its handover goes at the next opening, not 'now' (council item 7)", () => {
    // Weekdays 09:00 to 17:00; claimed at Monday 16:59 with the pacing slot at 17:01.
    const s = launchedWith(weekdays([1, 2, 3, 4, 5]), MONDAY_9);
    const at1659 = MONDAY_9 + 8 * H - MIN;
    const c = claim(s, item, account("inbox-a"), { attemptId: "a-1", retryable: true, notSentIsFinal: false, now: at1659 });
    const slotted = { ...c, accounts: { ...c.accounts, "inbox-a": { ...c.accounts["inbox-a"]!, nextSlotAt: at1659 + 2 * MIN } } };
    expect(stepWhen(slotted, "t1", MONDAY_9 + 8 * H)).toEqual({ kind: "at", at: Date.parse("2026-11-03T09:00:00Z") });
  });

  test("a claimed step whose sender has become unavailable: a reason", () => {
    const s = launchedWith(open, MONDAY_9, { accounts: { "inbox-a": account("inbox-a") } });
    const c = claim(s, item, account("inbox-a"), { attemptId: "a-1", retryable: true, notSentIsFinal: false, now: MONDAY_9 });
    const down = { ...c, accounts: { "inbox-a": { ...c.accounts["inbox-a"]!, healthy: false } } };
    expect(stepWhen(down, "t1", MONDAY_9 + MIN)).toEqual({ kind: "waits", why: "sender_unavailable" });
  });

  test("inherited work with the window closed: the next opening", () => {
    const s = inherited();
    const narrowed = { ...s, campaign: { ...s.campaign, definition: { ...s.campaign.definition, tracks: s.campaign.definition.tracks.map((t) => ({ ...t, window: weekdays([2]) })) } } };
    expect(stepWhen(narrowed, "t1", MONDAY_9)).toEqual({ kind: "at", at: Date.parse("2026-11-03T09:00:00Z") });
  });
});

describe("every other condition dispatch checks (council on 178de98, item 2)", () => {
  const open = weekdays([0, 1, 2, 3, 4, 5, 6], 0, 24);
  test("no transport for the step (a continue-thread email Instantly cannot send): a reason", () => {
    const s = launchedWith(open, MONDAY_9);
    expect(stepWhen(s, "t1", MONDAY_9, { transportAvailable: () => false })).toEqual({ kind: "waits", why: "no_transport", channel: "email" });
  });
  test("sending interrupted, waiting on its provider: a reason", () => {
    const s = launchedWith(open, MONDAY_9);
    expect(stepWhen(s, "t1", MONDAY_9, { waitingOnProvider: () => true })).toEqual({ kind: "waits", why: "waiting_on_provider" });
  });
  test("a reply from the destination waiting for its thread pauses the sender's sends to it (predicate 18): a reason", () => {
    const s = launchedWith(open, MONDAY_9, { accounts: { "inbox-a": account("inbox-a") } });
    const waiting = { ...s, pendingReplies: [{ inbox: "inbox-a", address: "pat@harbour.example" }] } as SubjectState;
    expect(stepWhen(waiting, "t1", MONDAY_9)).toEqual({ kind: "waits", why: "reply_pending" });
  });
  test("every sender at its in-flight bound: a reason; its pacing slot later: that instant", () => {
    const s = launchedWith(open, MONDAY_9, { accounts: { "inbox-a": account("inbox-a", { inFlight: 1, k: 1 }) } });
    expect(stepWhen(s, "t1", MONDAY_9)).toEqual({ kind: "waits", why: "sender_busy" });
    const paced = launchedWith(open, MONDAY_9, { accounts: { "inbox-a": account("inbox-a", { nextSlotAt: MONDAY_9 + 3 * MIN }) } });
    expect(stepWhen(paced, "t1", MONDAY_9)).toEqual({ kind: "at", at: MONDAY_9 + 3 * MIN });
  });
});

describe("a placed call: said on the list only when it is on today's list (council on 178de98, item 4)", () => {
  function placed(window: WindowRule[] = weekdays([1, 2, 3, 4, 5])): SubjectState {
    const base = subjectState();
    const phone = { id: "phone", channel: "call" as const, branch: "main" as const, window, steps: [step("c1")], start: { kind: "entry" as const }, removed: false };
    let s: SubjectState = {
      ...base,
      lead: { ...base.lead, phones: [{ id: "d-direct", kind: "direct", owner: "person", key: "+442079460120", value: "+44 20 7946 0120", bad: false, order: 2 }] },
      callDay: { ...base.callDay, day: localDayNumber(MONDAY_9, "Europe/London") },
      campaign: { ...base.campaign, launchedAt: MONDAY_9, definition: { ...base.campaign.definition, tracks: [phone] } },
    };
    s = evaluate(enterMain(s, MONDAY_9), MONDAY_9);
    return placeCall(s, readyCalls(s, MONDAY_9)[0]!, MONDAY_9, "task-1")!;
  }
  test("listed today: on your call list", () => {
    expect(stepWhen(placed(), "phone", MONDAY_9)).toEqual({ kind: "waits", why: "on_call_list" });
  });
  test("redialed to tomorrow: listed for Tuesday, never 'on your call list'", () => {
    const s = placed();
    const out = logCallOutcome(s, "task-1", { requestId: "r-1", outcome: "no_answer", redial: true, numberId: "d-direct", note: "", noteScope: "person" }, MONDAY_9 + H, { attempt: "a-1", note: "n-1" });
    if (!out.ok) throw new Error(out.reason);
    expect(stepWhen(out.state, "phone", MONDAY_9 + H)).toEqual({ kind: "listed_for", day: localDayNumber(Date.parse("2026-11-03T12:00:00Z"), "Europe/London") });
  });
  test("a user day the prospect's hours do not open: waits for a day they open", () => {
    const s = placed();
    const saturday = { ...s, callDay: { ...s.callDay, day: localDayNumber(Date.parse("2026-11-07T12:00:00Z"), "Europe/London") } };
    expect(stepWhen(saturday, "phone", Date.parse("2026-11-07T12:00:00Z"))).toEqual({ kind: "waits", why: "call_hours_closed" });
  });
});

describe("every hold on an email track reads as its reason, with no time (the verifier's note on 178de98)", () => {
  const open = weekdays([0, 1, 2, 3, 4, 5, 6], 0, 24);
  test("a copy that cannot render for this lead: render_failed", () => {
    const base = subjectState();
    const def = { ...base.campaign.definition, tracks: base.campaign.definition.tracks.map((t) => ({ ...t, window: open, steps: [step("s1", { threading: "new_subject", body: "Hi {{title}}" })] })) };
    const s = evaluate(enterMain({ ...base, campaign: { ...base.campaign, definition: def, launchedAt: MONDAY_9 } }, MONDAY_9), MONDAY_9);
    expect(stepWhen(s, "t1", MONDAY_9)).toEqual({ kind: "waits", why: "render_failed" });
  });
  test("a continue-thread email with no thread to continue: no_thread", () => {
    const base = subjectState();
    const def = { ...base.campaign.definition, tracks: base.campaign.definition.tracks.map((t) => ({ ...t, window: open, steps: [step("s1", { threading: "continue_thread" })] })) };
    const s = evaluate(enterMain({ ...base, campaign: { ...base.campaign, definition: def, launchedAt: MONDAY_9 } }, MONDAY_9), MONDAY_9);
    expect(stepWhen(s, "t1", MONDAY_9)).toEqual({ kind: "waits", why: "no_thread" });
  });
  test("work the provider has not confirmed: unresolved, ahead of 'with the provider'", () => {
    const s = launchedWith(open, MONDAY_9);
    const w = withAttempts(s, [handed({ id: "a-0", idempotencyKey: "a-0" })], [calledWork({ key: "a-0", unresolvedSince: MONDAY_9 })]);
    expect(stepWhen(w, "t1", MONDAY_9 + H)).toEqual({ kind: "waits", why: "unresolved" });
  });
  test("handed over and not yet answered: with the provider", () => {
    const s = launchedWith(open, MONDAY_9);
    expect(stepWhen(withAttempts(s, [handed({ id: "a-0", idempotencyKey: "a-0" })]), "t1", MONDAY_9 + MIN)).toEqual({ kind: "waits", why: "with_provider" });
  });
  test("the provider skipped the lead: provider_skipped", () => {
    const s = launchedWith(open, MONDAY_9);
    const skipped = withAttempts(s, [handed({ id: "a-0", idempotencyKey: "a-0", state: "rejected", rejectReason: "provider_skipped" })], [calledWork({ key: "a-0", settled: "rejected" })]);
    expect(stepWhen(skipped, "t1", MONDAY_9 + MIN)).toEqual({ kind: "waits", why: "provider_skipped" });
  });
});

describe("a sender waiting with no known end (a quota): a reason, never a time", () => {
  test("every sender the step may use is out of quota", () => {
    const open = weekdays([0, 1, 2, 3, 4, 5, 6], 0, 24);
    const s = launchedWith(open, MONDAY_9, { accounts: { "inbox-a": account("inbox-a", { waitUntil: Number.MAX_SAFE_INTEGER, waitReason: "quota" }), "inbox-b": account("inbox-b", { waitUntil: Number.MAX_SAFE_INTEGER, waitReason: "quota" }) } });
    expect(stepWhen(s, "t1", MONDAY_9)).toEqual({ kind: "waits", why: "sender_unavailable" });
  });
});

describe("every instant the read gives passes dispatch's checks at it (review bot and council on cc9bf55)", () => {
  const open = weekdays([0, 1, 2, 3, 4, 5, 6], 0, 24);
  const TWO_H = 2 * H;
  test("a mixed pool: one inbox full today, the other with room but held for two hours: that instant, not 'full'", () => {
    const s = launchedWith(open, MONDAY_9, { accounts: { "inbox-a": account("inbox-a", { capacity: 1, used: 1 }), "inbox-b": account("inbox-b", { waitUntil: MONDAY_9 + TWO_H, waitReason: "rate_limited" }) } });
    expect(stepWhen(s, "t1", MONDAY_9)).toEqual({ kind: "at", at: MONDAY_9 + TWO_H });
    expect(chooseAccount(s, MONDAY_9 + TWO_H, "s1")?.id).toBe("inbox-b");
    expect(claimRefusal(s, item, MONDAY_9 + TWO_H)).toBeNull();
  });
  test("a mixed pool: one inbox at its in-flight bound, the other held for two hours: that instant, not 'busy'", () => {
    const s = launchedWith(open, MONDAY_9, { accounts: { "inbox-a": account("inbox-a", { inFlight: 1, k: 1 }), "inbox-b": account("inbox-b", { waitUntil: MONDAY_9 + TWO_H, waitReason: "rate_limited" }) } });
    expect(stepWhen(s, "t1", MONDAY_9)).toEqual({ kind: "at", at: MONDAY_9 + TWO_H });
  });
  test("a held sender with no room even when its wait ends: the reason, no time", () => {
    const s = launchedWith(open, MONDAY_9, { accounts: { "inbox-a": account("inbox-a", { capacity: 1, used: 1, waitUntil: MONDAY_9 + TWO_H, waitReason: "rate_limited" }), "inbox-b": account("inbox-b", { capacity: 1, used: 1 }) } });
    expect(stepWhen(s, "t1", MONDAY_9)).toEqual({ kind: "waits", why: "sending_capacity" });
  });
  test("a claimed step whose slot falls after the window's close: the next opening, as the engine withdraws and claims again", () => {
    // Weekdays 09:00 to 17:00; claimed at Monday 16:59, its slot at 17:01, after the close.
    const s = launchedWith(weekdays([1, 2, 3, 4, 5]), MONDAY_9, { accounts: { "inbox-a": account("inbox-a") } });
    const at1659 = MONDAY_9 + 8 * H - MIN;
    const c = claim(s, item, account("inbox-a"), { attemptId: "a-1", retryable: true, notSentIsFinal: false, now: at1659 });
    const slotted = { ...c, accounts: { "inbox-a": { ...c.accounts["inbox-a"]!, nextSlotAt: at1659 + 2 * MIN } } };
    expect(stepWhen(slotted, "t1", at1659)).toEqual({ kind: "at", at: Date.parse("2026-11-03T09:00:00Z") });
  });
  test("a claim failing a reply awaiting its thread together with another predicate is withdrawn, and the step goes from another inbox", () => {
    const s = launchedWith(open, MONDAY_9);
    const c = claim(s, item, account("inbox-a"), { attemptId: "a-1", retryable: true, notSentIsFinal: false, now: MONDAY_9 });
    const down = { ...c, accounts: { ...c.accounts, "inbox-a": { ...c.accounts["inbox-a"]!, healthy: false } }, pendingReplies: [{ inbox: "inbox-a", address: "pat@harbour.example" }] } as SubjectState;
    expect(stepWhen(down, "t1", MONDAY_9 + MIN)).toEqual({ kind: "at", at: MONDAY_9 + MIN });
    expect(chooseAccount(applyToAttempt(down, "a-1", { kind: "guard_failed" }, MONDAY_9 + MIN).state, MONDAY_9 + MIN, "s1")?.id).toBe("inbox-b");
  });
  test("a claim failing only on a reply awaiting its thread waits, as the engine keeps it", () => {
    const s = launchedWith(open, MONDAY_9);
    const c = claim(s, item, account("inbox-a"), { attemptId: "a-1", retryable: true, notSentIsFinal: false, now: MONDAY_9 });
    const waiting = { ...c, pendingReplies: [{ inbox: "inbox-a", address: "pat@harbour.example" }] } as SubjectState;
    expect(stepWhen(waiting, "t1", MONDAY_9 + MIN)).toEqual({ kind: "waits", why: "reply_pending" });
  });
});

describe("every hold heldReason can give is the read's reason, never a generic one (review bot on cc9bf55)", () => {
  test("a mobile in another campaign's conversation on every number: sms_conversation_taken, not 'no sender'", () => {
    const N1 = "+447700900001";
    const N2 = "+447700900002";
    const base = multiTrackState([track("t2", "sms", [step("m1", { subject: "", body: "Hi {{first_name|there}}." })])]);
    const s = evaluate(enterMain({ ...base, campaign: { ...base.campaign, launchedAt: MONDAY_9 } }, MONDAY_9), MONDAY_9);
    const other = (sender: string) => ({ sender, recipient: MOBILE.key, owner: "lead-in-another-campaign", ownerCampaignId: "camp-2", ownerEnded: false });
    const taken = { ...s, smsBindings: [other(N1), other(N2)] };
    expect(heldReason(taken, "t2", MONDAY_9)).toBe("sms_conversation_taken");
    expect(stepWhen(taken, "t2", MONDAY_9)).toEqual({ kind: "waits", why: "sms_conversation_taken" });
  });
  test("holdWait is the identity on every hold (an unknown hold fails typecheck in its switch)", () => {
    for (const h of ["unresolved", "render_failed", "provider_skipped", "no_thread", "sms_conversation_taken"] as const) expect(holdWait(h)).toBe(h);
  });
});

describe("a pool whose chosen inbox's slot is later than another inbox's held instant (sweep of the windows family, offsets 10 and 44)", () => {
  test("inbox-a's slot two hours away, inbox-b rate-limited for fifteen minutes with room: the fifteen minutes", () => {
    const open = weekdays([0, 1, 2, 3, 4, 5, 6], 0, 24);
    const s = launchedWith(open, MONDAY_9, { accounts: { "inbox-a": account("inbox-a", { nextSlotAt: MONDAY_9 + 2 * H }), "inbox-b": account("inbox-b", { waitUntil: MONDAY_9 + 15 * MIN, waitReason: "rate_limited" }) } });
    expect(stepWhen(s, "t1", MONDAY_9)).toEqual({ kind: "at", at: MONDAY_9 + 15 * MIN });
    expect(chooseAccount(s, MONDAY_9 + 15 * MIN, "s1")?.id).toBe("inbox-b");
  });
});

describe("a claim waiting longer than a settling period for its slot expires, and the step is claimed again (windows family, offsets 10 and 44)", () => {
  test("claimed on inbox-a whose slot is two hours away, inbox-b free: the claim's expiry, fifteen minutes after it, not the slot", () => {
    const open = weekdays([0, 1, 2, 3, 4, 5, 6], 0, 24);
    const s = launchedWith(open, MONDAY_9);
    const c = claim(s, item, account("inbox-a"), { attemptId: "a-1", retryable: true, notSentIsFinal: false, now: MONDAY_9 });
    const slotted = { ...c, accounts: { ...c.accounts, "inbox-a": { ...c.accounts["inbox-a"]!, nextSlotAt: MONDAY_9 + 2 * H } } };
    expect(stepWhen(slotted, "t1", MONDAY_9 + MIN)).toEqual({ kind: "at", at: MONDAY_9 + 15 * MIN });
  });
});
