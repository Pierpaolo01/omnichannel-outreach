import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { ActivityView, CallsView, CallTaskView, LeadSearchResult, PersonRecord, RecordCalls, TodayView } from "../../shared/api.ts";

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

/** A campaign with an email track, a phone track (weekdays 09:00 to 17:00), and an email after the call. */
async function world(start = MONDAY_9) {
  const h = new EngineHarness({ start: start - H, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
  await h.tick();
  expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" })).status).toBe(200);
  h.clock = start;
  const { campaign: c } = await h.createCampaign("Calls", { businesses: [HARBOUR], people: [PAT, NIA, LOU] });
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
  const activity = async (who: string) => (await h.request<ActivityView>("GET", `/api/people/${personId(who)}/activity`)).body.entries;
  let n = 0;
  const log = (id: string, body: Record<string, unknown>) => h.request<{ error?: { message: string } }>("POST", `/api/call-tasks/${id}/outcome`, { requestId: `r${++n}`, ...body });
  const numberOf = async (id: string, kind: "direct" | "mobile" | "main_line") => (await task(id)).numbers.find((x) => x.kind === kind)?.detailId;
  return { h, c, personId, calls, task, taskOf, record, activity, log, numberOf };
}

describe("when an unworked call is skipped, as the engine's skip limit decides it (ADR 0003 3.5)", () => {
  test("the call names its original due date, the limit, and the day at whose end it is skipped if not worked, with and without a redial", async () => {
    const { task, taskOf } = await world();
    const pat = await task(await taskOf("Pat Oneil"));
    // Due Monday; a limit of two days counts from Monday, so an unworked call is skipped at the end of Tuesday.
    expect(pat.skipLimit).toEqual({ dueDate: "2026-11-02", limitDays: 2, ifUnworked: "2026-11-03" });
    // A redial moves the call to Tuesday and keeps the same deadline.
    expect(pat.redial).toEqual({ listedFor: "2026-11-03", ifUnworked: "2026-11-03" });
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
    expect(view.redial).toEqual({ listedFor: "2026-11-03", ifUnworked: "2026-11-04" });
  });

  test("a call due on a Friday is not skipped over a weekend with no calling hours: the end of Monday", async () => {
    const { task, taskOf } = await world(Date.parse("2026-11-06T09:00:00Z"));
    const pat = await task(await taskOf("Pat Oneil"));
    expect(pat.skipLimit).toEqual({ dueDate: "2026-11-06", limitDays: 2, ifUnworked: "2026-11-09" });
    // Redialed on Friday, it is listed from Saturday (no hours) and still skipped at the end of Monday.
    expect(pat.redial).toEqual({ listedFor: "2026-11-07", ifUnworked: "2026-11-09" });
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
