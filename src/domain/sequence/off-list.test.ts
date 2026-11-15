import { describe, expect, test } from "vitest";
import { H, MONDAY_9, step, subjectState } from "../../../test/support/sequence-state.ts";
import { isListed, logCallOutcome, offListReason, placeCall, readyCalls } from "./calls.ts";
import { localDayNumber, type WindowRule } from "./clock.ts";
import { enterMain, evaluate } from "./progress.ts";
import type { SubjectState } from "./state.ts";

/**
 * Why a call left the list (ADR 0003 "Reads that say when, and why a call left the list", ticket 23's defect 3): the
 * engine's own reason, an exhaustive set, and an outcome posted for a call off the list is refused with it. Fictitious.
 */

const WEEKDAYS: WindowRule[] = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
const ZONE = "Europe/London";

/** A lead with one phone track and its call placed on Monday's list. */
function onTheList(window: WindowRule[] = WEEKDAYS, at = MONDAY_9): SubjectState {
  const base = subjectState();
  const phone = { id: "phone", channel: "call" as const, branch: "main" as const, window, steps: [step("c1")], start: { kind: "entry" as const }, removed: false };
  const tracks = [phone, { ...base.campaign.definition.tracks[0]!, id: "email", start: { kind: "after" as const, trackId: "phone", delayDays: 0 } }];
  let s: SubjectState = {
    ...base,
    lead: { ...base.lead, phones: [{ id: "d-direct", kind: "direct", owner: "person", key: "+442079460120", value: "+44 20 7946 0120", bad: false, order: 2 }] },
    callDay: { ...base.callDay, userZone: ZONE, day: localDayNumber(at, ZONE) },
    campaign: { ...base.campaign, launchedAt: at, definition: { ...base.campaign.definition, tracks } },
  };
  s = evaluate(enterMain(s, at), at);
  const item = readyCalls(s, at)[0];
  if (!item) throw new Error("no call ready");
  return placeCall(s, item, at, "task-1")!;
}
const task = (s: SubjectState) => s.callTasks.find((t) => t.id === "task-1")!;
let n = 0;
const log = (s: SubjectState, outcome: Parameters<typeof logCallOutcome>[2]["outcome"], now: number, more: Partial<Parameters<typeof logCallOutcome>[2]> = {}) => {
  const out = logCallOutcome(s, "task-1", { requestId: `r-${++n}`, outcome, numberId: outcome === "skip_for_now" ? null : "d-direct", note: "", noteScope: "person", ...more }, now, { attempt: `a-${n}`, note: `n-${n}` });
  if (!out.ok) throw new Error(out.reason);
  return out.state;
};
const nextDay = (s: SubjectState, at: number) => ({ ...s, callDay: { ...s.callDay, day: localDayNumber(at, ZONE) } });

describe("a call on the list has no reason to be off it", () => {
  test("listed: null", () => {
    const s = onTheList();
    expect(isListed(s, task(s))).toBe(true);
    expect(offListReason(s, task(s))).toBeNull();
  });
});

describe("why a call left the list: the engine's reason, never an earlier outcome that left it listed", () => {
  test("a callback for later today, then the campaign paused: paused, not logged (defect 3)", () => {
    const s = log(onTheList(), "callback_requested", MONDAY_9 + H, { callbackAt: MONDAY_9 + 6 * H });
    expect(isListed(s, task(s))).toBe(true);
    const paused = { ...s, campaign: { ...s.campaign, pausedSince: MONDAY_9 + 7 * H } };
    expect(offListReason(paused, task(paused))).toEqual({ kind: "campaign_paused" });
  });

  test("an outcome that closed the call: logged, with that outcome", () => {
    const s = log(onTheList(), "no_answer", MONDAY_9 + H);
    expect(offListReason(s, task(s))).toMatchObject({ kind: "logged", attempt: { outcome: "no_answer" } });
  });

  test("a redial moved it to tomorrow: logged; once tomorrow is past the day it was moved to, the redial is no longer why", () => {
    const s = log(onTheList(), "no_answer", MONDAY_9 + H, { redial: true });
    expect(offListReason(s, task(s))).toMatchObject({ kind: "logged", attempt: { outcome: "no_answer", redial: true } });
    const tuesday = nextDay(s, MONDAY_9 + 24 * H);
    expect(offListReason(tuesday, task(tuesday))).toBeNull();
  });

  test("a callback for a later day: logged", () => {
    const s = log(onTheList(), "callback_requested", MONDAY_9 + H, { callbackAt: MONDAY_9 + 25 * H });
    expect(offListReason(s, task(s))).toMatchObject({ kind: "logged", attempt: { outcome: "callback_requested" } });
  });

  test("the lead paused", () => {
    const s = onTheList();
    const paused = { ...s, subject: { ...s.subject, leadPaused: true } };
    expect(offListReason(paused, task(paused))).toEqual({ kind: "lead_paused" });
  });

  test("the lead's outreach ended (a reply, a stop)", () => {
    const s = onTheList();
    const replied = { ...s, subject: { ...s.subject, ended: "replied" as const } };
    expect(offListReason(replied, task(replied))).toEqual({ kind: "lead_ended" });
  });

  test("its track finished otherwise: skipped by the user", () => {
    const s = onTheList();
    const closed = { ...s, callTasks: s.callTasks.map((t) => ({ ...t, open: false, closedWall: MONDAY_9 + H })), tracks: s.tracks.map((p) => (p.trackId === "phone" ? { ...p, finishReason: "skipped_by_user" as const, finishedAt: 0, finishedWall: MONDAY_9 + H } : p)) };
    expect(offListReason(closed, task(closed))).toEqual({ kind: "track_finished", finish: "skipped_by_user" });
  });

  test("a redial, then the skip limit closed it: the track's finish, not the redial", () => {
    const s = log(onTheList(), "no_answer", MONDAY_9 + H, { redial: true });
    const expired = { ...s, callTasks: s.callTasks.map((t) => ({ ...t, open: false, closedWall: MONDAY_9 + 72 * H })), tracks: s.tracks.map((p) => (p.trackId === "phone" ? { ...p, finishReason: "skipped_unworked" as const, finishedAt: 0, finishedWall: MONDAY_9 + 72 * H } : p)) };
    expect(offListReason(expired, task(expired))).toEqual({ kind: "track_finished", finish: "skipped_unworked" });
  });

  test("the prospect's calling hours do not open on the user's day", () => {
    const s = onTheList();
    const saturday = nextDay(s, Date.parse("2026-11-07T10:00:00Z"));
    expect(offListReason(saturday, task(saturday))).toEqual({ kind: "no_hours_today" });
  });
});

describe("an outcome posted for a call off the list is refused with the reason, and nothing is stored", () => {
  test("campaign paused, lead paused", () => {
    const s = log(onTheList(), "callback_requested", MONDAY_9 + H, { callbackAt: MONDAY_9 + 2 * H });
    const paused = { ...s, campaign: { ...s.campaign, pausedSince: MONDAY_9 + 3 * H } };
    const out = logCallOutcome(paused, "task-1", { requestId: "late", outcome: "no_answer", numberId: "d-direct", note: "", noteScope: "person" }, MONDAY_9 + 4 * H, { attempt: "a-late", note: "n-late" });
    expect(out).toEqual({ ok: false, reason: "This call is off the list while its campaign is paused." });
    const leadPaused = { ...s, subject: { ...s.subject, leadPaused: true } };
    const out2 = logCallOutcome(leadPaused, "task-1", { requestId: "late-2", outcome: "no_answer", numberId: "d-direct", note: "", noteScope: "person" }, MONDAY_9 + 4 * H, { attempt: "a-late2", note: "n-late2" });
    expect(out2).toEqual({ ok: false, reason: "This call is off the list while the lead is paused." });
  });
});
