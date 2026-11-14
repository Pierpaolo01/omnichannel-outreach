import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import { end } from "../../domain/sequence/progress.ts";
import type { ActivityView, CallsView, CallTaskView, CompanyRecord, LeadSearchResult, PersonRecord, RecordCalls, TodayView } from "../../shared/api.ts";

/**
 * What the redial, callback, rolled-over and overdue screens read (ticket 15, part b), through the real
 * HTTP app, SQLite store and engine. Each addition is read-only and computed by the engine's own rules as
 * of the instant read: when an unworked call would be skipped (with and without a redial), the outcomes
 * stored on a call with their redial and callback time, whether a lead has a good number left, each
 * enrollment's open call on the person and company-lead record, and redials, callbacks and unworked skips
 * in Activity. Nothing is dialled; data is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
/** Monday 2 November 2026, 09:00 London (GMT). */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const DAY = 24 * H;
const WEEKDAYS_9_TO_17 = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));

const email = (id: string): StepDefinition => ({ id, waitDays: 0, subject: "Hello", body: `Email ${id} for {{company}}.`, threading: "new_subject", removed: false });
const call = (id: string): StepDefinition => ({ id, waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false });
const track = (id: string, channel: TrackDefinition["channel"], steps: StepDefinition[], window = ALWAYS, start: TrackDefinition["start"] = { kind: "entry" }): TrackDefinition => ({ id, channel, branch: "main", window, steps, start, removed: false });
const definition = (tracks: TrackDefinition[]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: [], callScript: "", tracks });

const PAT = person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", title: "Clinic owner", email: "pat@harbour.example", direct_phone: "+442079460111" });
const NIA = person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", title: "Practice manager", email: "nia@harbour.example", dial_phone: "+447700900102", dial_phone_type: "mobile" });
/** Lou has no number of their own: only the company's main line. */
const LOU = person({ person_id: "p3", business_id: "b1", full_name: "Lou Park", title: "Receptionist", email: "lou@harbour.example" });
const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });
/** A company lead: no decision maker named, called on its main line, emailed at its shared inbox. */
const ELM = business({ business_id: "b2", business_name: "Elm Street Clinic", phone_e164: "+442079460202", general_emails: "front@elmstreet.example" });

/** A campaign with an email track, a phone track (weekdays 09:00 to 17:00), and an email after the call. */
async function world(start = MONDAY_9) {
  const h = new EngineHarness({ start: start - H, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
  await h.tick();
  expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" })).status).toBe(200);
  h.clock = start;
  const { campaign: c } = await h.createCampaign("Calls", { businesses: [HARBOUR, ELM], people: [PAT, NIA, LOU] });
  await h.defineSequence(
    c.id,
    definition([track("e1", "email", [email("s1")]), track("p1", "call", [call("c1")], WEEKDAYS_9_TO_17), track("e2", "email", [email("a1")], ALWAYS, { kind: "after", trackId: "p1", delayDays: 0 })]),
  );
  expect((await h.launch(c.id)).status).toBe(200);
  const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
  const personId = (who: string) => rows.find((r) => r.name === who)?.id ?? "";
  await h.advanceTo(start + H);
  const calls = async () => (await h.request<CallsView>("GET", "/api/calls")).body;
  const task = async (id: string) => (await h.request<CallTaskView>("GET", `/api/call-tasks/${id}`)).body;
  const taskOf = async (who: string) => {
    const v = await calls();
    return [...v.readyNow, ...v.laterToday].find((x) => x.person?.name === who)?.taskId ?? "";
  };
  const record = async (who: string) => (await h.request<PersonRecord & RecordCalls>("GET", `/api/people/${personId(who)}`)).body;
  const companyRecord = async () => (await h.request<CompanyRecord & RecordCalls>("GET", `/api/companies/${rows.find((r) => r.kind === "company")?.id ?? ""}`)).body;
  const enrollmentOf = (who: string) => rows.find((r) => r.name === who)?.enrollments[0]?.id ?? "";
  const activity = async (who: string) => (await h.request<ActivityView>("GET", `/api/people/${personId(who)}/activity`)).body.entries;
  let n = 0;
  const log = (id: string, body: Record<string, unknown>) => h.request<{ error?: { message: string } }>("POST", `/api/call-tasks/${id}/outcome`, { requestId: `r${++n}`, ...body });
  const numberOf = async (id: string, kind: "direct" | "mobile" | "main_line") => (await task(id)).numbers.find((x) => x.kind === kind)?.detailId;
  const taskOfCompany = async () => {
    const v = await calls();
    return [...v.readyNow, ...v.laterToday].find((x) => x.person === null)?.taskId ?? "";
  };
  return { h, c, personId, calls, task, taskOf, taskOfCompany, record, companyRecord, enrollmentOf, activity, log, numberOf };
}

describe("when an unworked call is skipped, as the engine's skip limit decides it (ADR 0003 3.5)", () => {
  test("the call names its original due date, the limit, and the day at whose end it is skipped if not worked, with and without a redial", async () => {
    const { task, taskOf } = await world();
    const pat = await task(await taskOf("Pat Oneil"));
    // Due Monday; a limit of two days counts from Monday, so an unworked call is skipped at the end of Tuesday.
    expect(pat.skipLimit).toEqual({ dueDate: "2026-11-02", limitDays: 2, ifUnworked: "2026-11-03" });
    // A redial moves the call to Tuesday and keeps the same deadline.
    expect(pat.redial).toEqual({ listedFor: "2026-11-03", skipLimit: { dueDate: "2026-11-02", limitDays: 2, ifUnworked: "2026-11-03" } });
    expect(pat.asOf).toBe("2026-11-02T10:00:00.000Z");
  });

  test("a phone track's own skip limit (pull request 47) is the one the read counts by", async () => {
    const h = new EngineHarness({ start: MONDAY_9 - H, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
    await h.tick();
    await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" });
    h.clock = MONDAY_9;
    const { campaign: c } = await h.createCampaign("Own limit", { businesses: [HARBOUR], people: [PAT] });
    await h.defineSequence(c.id, definition([{ ...track("p1", "call", [call("c1")], WEEKDAYS_9_TO_17), callSkipLimitDays: 3 }]));
    expect((await h.launch(c.id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + H);
    const id = (await h.request<CallsView>("GET", "/api/calls")).body.readyNow[0]?.taskId ?? "";
    const view = (await h.request<CallTaskView>("GET", `/api/call-tasks/${id}`)).body;
    // Three days from Monday: skipped at the end of Wednesday, with a redial too.
    expect(view.skipLimit).toEqual({ dueDate: "2026-11-02", limitDays: 3, ifUnworked: "2026-11-04" });
    expect(view.redial).toEqual({ listedFor: "2026-11-03", skipLimit: { dueDate: "2026-11-02", limitDays: 3, ifUnworked: "2026-11-04" } });
  });

  test("a call due on a Friday is not skipped over a weekend with no calling hours: the end of Monday", async () => {
    const { task, taskOf } = await world(Date.parse("2026-11-06T09:00:00Z"));
    const pat = await task(await taskOf("Pat Oneil"));
    expect(pat.skipLimit).toEqual({ dueDate: "2026-11-06", limitDays: 2, ifUnworked: "2026-11-09" });
    // Redialed on Friday, it is next listed on Monday (no hours at the weekend) and still skipped at the end of Monday.
    expect(pat.redial).toEqual({ listedFor: "2026-11-09", skipLimit: { dueDate: "2026-11-06", limitDays: 2, ifUnworked: "2026-11-09" } });
  });

  test("after a redial the call is off today's list, then listed tomorrow as a redial skipped tonight, then skipped and the email after it starts", async () => {
    const { h, task, taskOf, log, numberOf, activity } = await world();
    const id = await taskOf("Pat Oneil");
    expect((await log(id, { requestId: "redial-1", outcome: "no_answer", redial: true, numberId: await numberOf(id, "direct") })).status).toBe(200);
    const after = await task(id);
    expect(after).toMatchObject({ open: true, listed: false, listedFor: "2026-11-03", skipLimit: { dueDate: "2026-11-02", ifUnworked: "2026-11-03" } });
    expect(after.storedCalls).toEqual([{ requestId: "redial-1", outcome: "no_answer", redial: true, callbackAt: null, at: "2026-11-02T10:00:00.000Z", number: expect.objectContaining({ kind: "direct" }), note: "" }]);
    await h.advanceTo(MONDAY_9 + DAY + H);
    const item = (await h.request<CallsView>("GET", "/api/calls")).body.readyNow.find((x) => x.taskId === id);
    expect(item).toMatchObject({ reason: "redial", skippedTonight: true, dueAt: "2026-11-02T09:00:00.000Z", noGoodNumber: false });
    await h.advanceTo(MONDAY_9 + 2 * DAY + H);
    expect((await task(id)).open).toBe(false);
    const entries = await activity("Pat Oneil");
    // The redial in Activity, then the skip at the end of Tuesday with its original due date, then the release.
    expect(entries.find((e) => e.kind === "call")).toMatchObject({ outcome: "no_answer", redial: true, callbackAt: null, onCallback: null });
    expect(entries.find((e) => e.kind === "skipped" && e.channel === "call")).toEqual(expect.objectContaining({ kind: "skipped", channel: "call", reason: "unworked", at: "2026-11-04T00:00:00.000Z", dueAt: "2026-11-02T09:00:00.000Z", limitDays: 2 }));
    expect(entries.find((e) => e.kind === "released")).toMatchObject({ channel: "email", track: { label: "Email track 2" }, after: { label: "Phone track" }, because: "unworked" });
  });
});

describe("callbacks on the screens (ADR 0003 2.3, Q12, Q13)", () => {
  test("a callback is later today until its time, then overdue; the record and Activity say so, then say it was worked", async () => {
    const { h, task, taskOf, log, numberOf, record, activity } = await world();
    const id = await taskOf("Pat Oneil");
    expect((await log(id, { requestId: "cb-1", outcome: "callback_requested", callbackAt: "2026-11-02T15:00:00+00:00", numberId: await numberOf(id, "direct"), note: "After clinic." })).status).toBe(200);
    const held = await task(id);
    expect(held).toMatchObject({ kind: "callback", callbackAt: "2026-11-02T15:00:00.000Z", status: "callback_scheduled", skipLimit: null });
    expect(held.storedCalls.at(-1)).toMatchObject({ requestId: "cb-1", outcome: "callback_requested", callbackAt: "2026-11-02T15:00:00.000Z", redial: false });
    expect((await record("Pat Oneil")).calls).toEqual([
      expect.objectContaining({ taskId: id, kind: "callback", listed: true, reason: "callback", callbackAt: "2026-11-02T15:00:00.000Z", zone: "Europe/London", noGoodNumber: false, skipLimit: null, heldByCallback: false }),
    ]);
    await h.advanceTo(Date.parse("2026-11-02T15:05:00Z"));
    expect((await record("Pat Oneil")).calls[0]).toMatchObject({ reason: "overdue" });
    expect((await activity("Pat Oneil"))[0]).toMatchObject({ kind: "callback_overdue", channel: "call", at: "2026-11-02T15:00:00.000Z", callbackAt: "2026-11-02T15:00:00.000Z" });
    expect((await h.request<TodayView>("GET", "/api/today")).body.overdueCallbacks.map((x) => x.taskId)).toEqual([id]);
    expect((await log(id, { outcome: "voicemail", numberId: await numberOf(id, "direct") })).status).toBe(200);
    const entries = await activity("Pat Oneil");
    expect(entries.some((e) => e.kind === "callback_overdue")).toBe(false);
    expect(entries.flatMap((e) => (e.kind === "call" ? [[e.outcome, e.callbackAt, e.onCallback]] : []))).toEqual([
      ["voicemail", null, "2026-11-02T15:00:00.000Z"],
      ["callback_requested", "2026-11-02T15:00:00.000Z", null],
    ]);
    expect((await record("Pat Oneil")).calls).toEqual([]);
    expect((await record("Pat Oneil")).today).toBe("2026-11-02");
  });

  test("a callback whose lead has no good number left says so on the queue and the record (Q13)", async () => {
    const { h, taskOf, log, numberOf, record, calls } = await world();
    const lou = await taskOf("Lou Park");
    const main = await numberOf(lou, "main_line");
    expect((await log(lou, { outcome: "callback_requested", callbackAt: "2026-11-02T11:00:00+00:00", numberId: main })).status).toBe(200);
    // Nia's call on the shared main line: wrong. Lou has no number left.
    const nia = await taskOf("Nia Cole");
    expect((await log(nia, { outcome: "wrong_number", numberId: main })).status).toBe(200);
    await h.advanceTo(Date.parse("2026-11-02T11:30:00Z"));
    expect((await calls()).readyNow.find((x) => x.taskId === lou)).toMatchObject({ reason: "overdue", noGoodNumber: true });
    expect((await record("Lou Park")).calls[0]).toMatchObject({ kind: "callback", reason: "overdue", noGoodNumber: true });
  });

  test("a call of a lead held by its own callback on another phone track waits, and says why on the record", async () => {
    const h = new EngineHarness({ start: MONDAY_9 - H, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
    await h.tick();
    await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" });
    h.clock = MONDAY_9;
    const { campaign: c } = await h.createCampaign("Two calls", { businesses: [HARBOUR], people: [PAT] });
    await h.defineSequence(c.id, definition([track("p1", "call", [call("c1")], WEEKDAYS_9_TO_17), track("p2", "call", [call("c2")], WEEKDAYS_9_TO_17)]));
    expect((await h.launch(c.id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + H);
    const list = (await h.request<CallsView>("GET", "/api/calls")).body.readyNow;
    expect(list).toHaveLength(2);
    const [first, second] = list;
    const number = (await h.request<CallTaskView>("GET", `/api/call-tasks/${first?.taskId}`)).body.numbers[0]?.detailId;
    expect((await h.request("POST", `/api/call-tasks/${first?.taskId}/outcome`, { requestId: "cb", outcome: "callback_requested", callbackAt: "2026-11-03T10:00:00+00:00", numberId: number })).status).toBe(200);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
    const rec = (await h.request<PersonRecord & RecordCalls>("GET", `/api/people/${rows[0]?.id}`)).body;
    expect(rec.calls.find((x) => x.taskId === second?.taskId)).toMatchObject({ kind: "call", listed: false, reason: null, heldByCallback: true });
    // A callback for tomorrow is not on today's list.
    expect(rec.calls.find((x) => x.taskId === first?.taskId)).toMatchObject({ kind: "callback", listed: false, reason: null, listedFor: "2026-11-03" });
  });
});

describe("the record shows only calls the user can act on, or that hold outreach, by the engine's listing rule (review bot on eac9f6c, item 2)", () => {
  type World = Awaited<ReturnType<typeof world>>;
  /** Every row the record shows agrees with what the call's read and the outcome route answer now. */
  async function agrees(w: World, rec: RecordCalls): Promise<void> {
    for (const row of rec.calls) {
      const read = await w.task(row.taskId);
      expect(read.listed, `${row.taskId} listed`).toBe(row.listed);
      if (!row.listed) expect((await w.log(row.taskId, { outcome: "skip_for_now" })).status, `${row.taskId} refused`).toBe(409);
    }
  }
  /** After the lead stopped (a reply or a manual stop), its retained tasks are neither shown nor accepted. */
  async function gone(w: World, rec: RecordCalls, taskId: string): Promise<void> {
    expect(rec.calls).toEqual([]);
    expect((await w.task(taskId)).listed).toBe(false);
    expect((await w.log(taskId, { outcome: "skip_for_now" })).status).toBe(409);
  }

  test("a person: a reply during a callback shows no call and no hold", async () => {
    const w = await world();
    const id = await w.taskOf("Pat Oneil");
    expect((await w.log(id, { outcome: "callback_requested", callbackAt: "2026-11-03T11:00:00+00:00", numberId: await w.numberOf(id, "direct") })).status).toBe(200);
    const before = await w.record("Pat Oneil");
    expect(before.calls.map((x) => x.kind)).toEqual(["callback"]);
    await agrees(w, before);
    expect(w.h.fake.prospectReplies("pat@harbour.example", true, null)).toBe(true);
    await w.h.advanceTo(MONDAY_9 + H + MIN);
    await gone(w, await w.record("Pat Oneil"), id);
  });

  test("a person: a reply with an ordinary open call shows no call", async () => {
    const w = await world();
    const id = await w.taskOf("Nia Cole");
    await agrees(w, await w.record("Nia Cole"));
    expect(w.h.fake.prospectReplies("nia@harbour.example", true, null)).toBe(true);
    await w.h.advanceTo(MONDAY_9 + H + MIN);
    await gone(w, await w.record("Nia Cole"), id);
  });

  test("a person: a manual stop (ticket 17's control, set here through the engine's own ending) shows no call", async () => {
    const w = await world();
    const id = await w.taskOf("Pat Oneil");
    expect((await w.log(id, { outcome: "no_answer", redial: true, numberId: await w.numberOf(id, "direct") })).status).toBe(200);
    const redialed = await w.record("Pat Oneil");
    expect(redialed.calls).toEqual([expect.objectContaining({ taskId: id, listed: false, listedFor: "2026-11-03" })]);
    await agrees(w, redialed);
    await w.h.store.engine.update(w.enrollmentOf("Pat Oneil"), w.h.clock, (s) => end(s, "stopped_manually", w.h.clock));
    await gone(w, await w.record("Pat Oneil"), id);
  });

  test("a company lead: a callback, then a reply to its shared inbox, shows no call and no hold", async () => {
    const w = await world();
    const id = await w.taskOfCompany();
    expect((await w.log(id, { outcome: "callback_requested", callbackAt: "2026-11-02T15:00:00+00:00", numberId: await w.numberOf(id, "main_line") })).status).toBe(200);
    const before = await w.companyRecord();
    expect(before.calls).toEqual([expect.objectContaining({ taskId: id, kind: "callback", listed: true })]);
    await agrees(w, before);
    expect(w.h.fake.prospectReplies("front@elmstreet.example", true, null)).toBe(true);
    await w.h.advanceTo(MONDAY_9 + H + MIN);
    await gone(w, await w.companyRecord(), id);
  });

  test("a company lead: an ordinary open call, then a manual stop, shows no call", async () => {
    const w = await world();
    const id = await w.taskOfCompany();
    const before = await w.companyRecord();
    expect(before.calls).toEqual([expect.objectContaining({ taskId: id, kind: "call", listed: true })]);
    await agrees(w, before);
    const enrollment = (await w.companyRecord()).enrollments[0]?.id ?? "";
    await w.h.store.engine.update(enrollment, w.h.clock, (s) => end(s, "stopped_manually", w.h.clock));
    await gone(w, await w.companyRecord(), id);
  });

  test("a call left for a day without calling hours is shown from the first day it is listed", async () => {
    const w = await world(Date.parse("2026-11-06T09:00:00Z"));
    const id = await w.taskOf("Pat Oneil");
    expect((await w.log(id, { outcome: "no_answer", redial: true, numberId: await w.numberOf(id, "direct") })).status).toBe(200);
    // A Friday redial is for Saturday; the hours open on Monday.
    expect((await w.record("Pat Oneil")).calls).toEqual([expect.objectContaining({ taskId: id, listed: false, listedFor: "2026-11-09" })]);
  });
});

describe("a redial's preview is the engine's own outcome applied to a copy of the call, storing nothing (review bot on eac9f6c, item 3)", () => {
  type World = Awaited<ReturnType<typeof world>>;
  /** What the read previews before Log equals what the next read reports after logging no answer with a redial. */
  async function parity(w: World, id: string): Promise<void> {
    const before = await w.task(id);
    expect(before.redial).not.toBeNull();
    const again = await w.task(id);
    expect(again.storedRequestIds).toEqual(before.storedRequestIds);
    const number = before.numbers.find((n) => !n.bad)?.detailId;
    expect((await w.log(id, { outcome: "no_answer", redial: true, numberId: number })).status).toBe(200);
    const after = await w.task(id);
    expect(before.redial).toEqual({ listedFor: after.listedFrom, skipLimit: after.skipLimit });
  }

  test("an ordinary call", async () => {
    const w = await world();
    await parity(w, await w.taskOf("Pat Oneil"));
  });

  test("a rolled-over call, on its last day", async () => {
    const w = await world();
    const id = await w.taskOf("Pat Oneil");
    await w.h.advanceTo(MONDAY_9 + DAY + H);
    expect((await w.calls()).readyNow.find((x) => x.taskId === id)).toMatchObject({ reason: "rolled_over", skippedTonight: true });
    await parity(w, id);
  });

  test("a callback before its time, and an overdue callback: the hold released, the skip limit counted from the original due date", async () => {
    const w = await world();
    const pat = await w.taskOf("Pat Oneil");
    expect((await w.log(pat, { outcome: "callback_requested", callbackAt: "2026-11-02T15:00:00+00:00", numberId: await w.numberOf(pat, "direct") })).status).toBe(200);
    const preview = (await w.task(pat)).redial;
    expect(preview?.skipLimit).toMatchObject({ dueDate: "2026-11-02", limitDays: 2 });
    expect(preview?.skipLimit?.ifUnworked).not.toBeNull();
    await parity(w, pat);

    const nia = await w.taskOf("Nia Cole");
    expect((await w.log(nia, { outcome: "callback_requested", callbackAt: "2026-11-02T11:00:00+00:00", numberId: await w.numberOf(nia, "mobile") })).status).toBe(200);
    await w.h.advanceTo(Date.parse("2026-11-04T10:00:00Z"));
    expect((await w.calls()).readyNow.find((x) => x.taskId === nia)).toMatchObject({ reason: "overdue" });
    await parity(w, nia);
  });

  test("a track with its own skip limit", async () => {
    const h = new EngineHarness({ start: MONDAY_9 - H, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
    await h.tick();
    await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" });
    h.clock = MONDAY_9;
    const { campaign: c } = await h.createCampaign("Own limit", { businesses: [HARBOUR], people: [PAT] });
    await h.defineSequence(c.id, definition([{ ...track("p1", "call", [call("c1")], WEEKDAYS_9_TO_17), callSkipLimitDays: 3 }]));
    expect((await h.launch(c.id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + H);
    const id = (await h.request<CallsView>("GET", "/api/calls")).body.readyNow[0]?.taskId ?? "";
    const before = (await h.request<CallTaskView>("GET", `/api/call-tasks/${id}`)).body;
    expect(before.redial?.skipLimit).toEqual({ dueDate: "2026-11-02", limitDays: 3, ifUnworked: "2026-11-04" });
    expect((await h.request("POST", `/api/call-tasks/${id}/outcome`, { requestId: "own", outcome: "no_answer", redial: true, numberId: before.numbers[0]?.detailId })).status).toBe(200);
    const after = (await h.request<CallTaskView>("GET", `/api/call-tasks/${id}`)).body;
    expect(before.redial).toEqual({ listedFor: after.listedFrom, skipLimit: after.skipLimit });
  });

  test("a callback whose lead has no good number left offers no redial preview: no outcome but skip for now can be logged", async () => {
    const w = await world();
    const lou = await w.taskOf("Lou Park");
    const main = await w.numberOf(lou, "main_line");
    expect((await w.log(lou, { outcome: "callback_requested", callbackAt: "2026-11-02T11:00:00+00:00", numberId: main })).status).toBe(200);
    expect((await w.log(await w.taskOf("Nia Cole"), { outcome: "wrong_number", numberId: main })).status).toBe(200);
    await w.h.advanceTo(Date.parse("2026-11-02T11:30:00Z"));
    expect((await w.task(lou)).redial).toBeNull();
  });
});

describe("Today counts the calls carried over from earlier days, and those on their last day (review bot on eac9f6c, item 4)", () => {
  test("the count equals the Calls list's rolled-over and redialed calls at the same read", async () => {
    const w = await world();
    const pat = await w.taskOf("Pat Oneil");
    expect((await w.log(pat, { outcome: "voicemail", redial: true, numberId: await w.numberOf(pat, "direct") })).status).toBe(200);
    await w.h.advanceTo(MONDAY_9 + DAY + H);
    const today = (await w.h.request<TodayView>("GET", "/api/today")).body;
    const list = await w.calls();
    const carried = [...list.readyNow, ...list.laterToday].filter((x) => x.reason === "rolled_over" || x.reason === "redial");
    expect(carried.length).toBeGreaterThan(1);
    expect(today.carriedOver).toBe(carried.length);
    expect(today.carriedOverLastDay).toBe(carried.filter((x) => x.skippedTonight).length);
    // Monday's calls, unworked or redialed, are on their last day on Tuesday.
    expect(today.carriedOverLastDay).toBe(today.carriedOver);
  });
});

describe("an unworked skip says what each track after it has done at the read: started, or waiting out its delay until a stated day (verifier on eac9f6c, F2)", () => {
  /** A person and a company lead; the email after the call waits two days after the phone track ends. */
  async function delayed() {
    const h = new EngineHarness({ start: MONDAY_9 - H, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
    await h.tick();
    await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" });
    h.clock = MONDAY_9;
    const { campaign: c } = await h.createCampaign("Delayed", { businesses: [HARBOUR, ELM], people: [PAT] });
    await h.defineSequence(c.id, definition([track("e1", "email", [email("s1")]), track("p1", "call", [call("c1")], WEEKDAYS_9_TO_17), track("e2", "email", [email("a1")], ALWAYS, { kind: "after", trackId: "p1", delayDays: 2 })]));
    expect((await h.launch(c.id)).status).toBe(200);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
    const paths = [`/api/people/${rows.find((r) => r.kind === "person")?.id ?? ""}/activity`, `/api/companies/${rows.find((r) => r.kind === "company")?.id ?? ""}/activity`];
    const skips = async () => {
      const out = [];
      for (const path of paths) out.push((await h.request<ActivityView>("GET", path)).body.entries.find((e) => e.kind === "skipped" && e.channel === "call"));
      return out;
    };
    return { h, skips };
  }

  test("before the delay ends the track after it is waiting, with the day it starts; after, it has started", async () => {
    const { h, skips } = await delayed();
    // Skipped at the end of Tuesday; the email after it waits two days, to Friday.
    await h.advanceTo(Date.parse("2026-11-04T10:00:00Z"));
    for (const skip of await skips()) {
      expect(skip).toMatchObject({ reason: "unworked", after: [{ track: { label: "Email track 2" }, state: "waiting", startsAt: "2026-11-06T00:00:00.000Z" }] });
    }
    await h.advanceTo(Date.parse("2026-11-06T10:00:00Z"));
    for (const skip of await skips()) expect(skip).toMatchObject({ reason: "unworked", after: [{ track: { label: "Email track 2" }, state: "started", startsAt: null }] });
  });
});
