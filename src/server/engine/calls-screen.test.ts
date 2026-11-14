import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { ActivityView, CallsView, CallTaskView, LeadSearchResult, TodayView } from "../../shared/api.ts";

/**
 * What the Today page and the call focus queue read (ticket 14, part b), through the real HTTP app,
 * SQLite store and engine. Additive to part a's read models: why a call left the list, whether the
 * day's call capacity is used, the call's calling hours, and calls in the record's Activity. The
 * user dials on their own phone; nothing here dials. Data is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
/** Monday 2 November 2026, 09:00 London (GMT). */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const WEEKDAYS_9_TO_17 = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));

const email = (id: string, waitDays = 0): StepDefinition => ({ id, waitDays, subject: "Hello {{first_name|there}}", body: `Email ${id} for {{company}}.`, threading: "new_subject", removed: false });
const call = (id: string): StepDefinition => ({ id, waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false });
const track = (id: string, channel: TrackDefinition["channel"], steps: StepDefinition[], window = ALWAYS): TrackDefinition => ({ id, channel, branch: "main", window, steps, start: { kind: "entry" }, removed: false });
const definition = (tracks: TrackDefinition[]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: [], callScript: "Ask who looks after bookings.", tracks });

const PAT = person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", title: "Clinic owner", email: "pat@harbour.example", direct_phone: "+442079460111" });
const NIA = person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", title: "Practice manager", email: "nia@harbour.example", dial_phone: "+447700900102", dial_phone_type: "mobile" });
const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });

async function world(capacity = 20) {
  const h = new EngineHarness({ start: MONDAY_9 - H, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
  await h.tick();
  expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: capacity, userZone: "Europe/London" })).status).toBe(200);
  h.clock = MONDAY_9;
  const { campaign: c } = await h.createCampaign("Calls", { businesses: [HARBOUR], people: [PAT, NIA] });
  await h.defineSequence(c.id, definition([track("e1", "email", [email("s1")]), track("p1", "call", [call("c1")], WEEKDAYS_9_TO_17)]));
  expect((await h.launch(c.id)).status).toBe(200);
  const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
  const lead = (who: string) => rows.find((r) => r.name === who)?.enrollments[0]?.id ?? "";
  const personId = (who: string) => rows.find((r) => r.name === who)?.id ?? "";
  await h.advanceTo(MONDAY_9 + H);
  const calls = async () => (await h.request<CallsView>("GET", "/api/calls")).body;
  const task = async (id: string) => (await h.request<CallTaskView>("GET", `/api/call-tasks/${id}`)).body;
  const taskOf = async (who: string) => (await calls()).readyNow.find((x) => x.person?.name === who)?.taskId ?? "";
  let n = 0;
  const log = (id: string, body: Record<string, unknown>) => h.request<{ error?: { code: string; message: string } }>("POST", `/api/call-tasks/${id}/outcome`, { requestId: `r${++n}`, ...body });
  return { h, c, lead, personId, calls, task, taskOf, log };
}

describe("why a call is off the list, from the server's facts (ADR 0003 4.4.1, offList)", () => {
  test("a listed call has none; once logged, it names the outcome and when; a lead that replied names its status", async () => {
    const { h, task, taskOf, log } = await world();
    const patTask = await taskOf("Pat Oneil");
    expect((await task(patTask)).offList).toBeNull();
    const direct = (await task(patTask)).numbers[0]?.detailId;
    expect((await log(patTask, { outcome: "no_answer", numberId: direct })).status).toBe(200);
    expect((await task(patTask)).offList).toEqual({ reason: "logged", outcome: "no_answer", at: "2026-11-02T10:00:00.000Z", status: "sequence_finished_no_response" });

    // A second tab logs on the same call with its own request id: refused, and the task says why.
    const again = await log(patTask, { outcome: "voicemail", numberId: direct });
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("outcome_refused");
    // The refusal carries why the call is off the list, as the server read it then.
    expect((again.body as { offList?: unknown }).offList).toMatchObject({ reason: "logged", outcome: "no_answer" });

    const niaTask = await taskOf("Nia Cole");
    expect(h.fake.prospectReplies("nia@harbour.example", true, null)).toBe(true);
    await h.advanceTo(MONDAY_9 + 2 * H);
    expect((await task(niaTask)).offList).toMatchObject({ reason: "lead_ended", status: "replied" });
  });

  test("a skip for now leaves the call on the list", async () => {
    const { task, taskOf, log } = await world();
    const patTask = await taskOf("Pat Oneil");
    expect((await log(patTask, { outcome: "skip_for_now" })).status).toBe(200);
    expect((await task(patTask)).offList).toBeNull();
  });

  test("the call's read names the request id of every outcome stored on it, a skip for now included, so a page knows its press is logged whoever got the answer (council on b8c65f9)", async () => {
    const { task, taskOf, log } = await world();
    const patTask = await taskOf("Pat Oneil");
    expect((await task(patTask)).storedRequestIds).toEqual([]);
    expect((await log(patTask, { requestId: "skip-1", outcome: "skip_for_now" })).status).toBe(200);
    expect((await task(patTask)).storedRequestIds).toEqual(["skip-1"]);
    const direct = (await task(patTask)).numbers[0]?.detailId;
    expect((await log(patTask, { requestId: "call-2", outcome: "no_answer", numberId: direct })).status).toBe(200);
    // A repeated id stores nothing twice; a refused one is not stored.
    expect((await log(patTask, { requestId: "call-2", outcome: "no_answer", numberId: direct })).status).toBe(200);
    expect((await log(patTask, { requestId: "call-3", outcome: "voicemail", numberId: direct })).status).toBe(409);
    expect((await task(patTask)).storedRequestIds).toEqual(["skip-1", "call-2"]);
  });
});

describe("the day's call capacity and the call's calling hours, as the screens state them", () => {
  test("the queue and Today say when today's capacity is used, and the factory default", async () => {
    const roomy = await world(5);
    expect(await roomy.calls()).toMatchObject({ dailyCapacity: 5, defaultDailyCapacity: 50, capacityReached: false });
    const full = await world(2);
    expect(await full.calls()).toMatchObject({ dailyCapacity: 2, placedToday: 2, capacityReached: true });
    expect((await full.h.request<TodayView>("GET", "/api/today")).body).toMatchObject({ capacityReached: true });
  });

  test("the call task carries its phone track's calling hours, in the prospect's time", async () => {
    const { task, taskOf } = await world();
    expect((await task(await taskOf("Pat Oneil"))).callingHours).toEqual(WEEKDAYS_9_TO_17);
  });

  test("the call task says whether the prospect is inside those hours as of the read, and when they open later today (re-check 7, R10)", async () => {
    const { h, task, taskOf } = await world();
    const pat = await taskOf("Pat Oneil");
    // Monday 10:00 London, hours 09:00 to 17:00: inside.
    expect((await task(pat)).callingHoursNow).toEqual({ open: true, opensLaterToday: null });
    // Monday 17:30: closed, and they do not open again today.
    h.clock = Date.parse("2026-11-02T17:30:00Z");
    expect((await task(pat)).callingHoursNow).toEqual({ open: false, opensLaterToday: null });
    // Tuesday 07:30: closed, opening at 09:00 later today.
    h.clock = Date.parse("2026-11-03T07:30:00Z");
    expect((await task(pat)).callingHoursNow).toEqual({ open: false, opensLaterToday: "2026-11-03T09:00:00.000Z" });
  });
});

describe("calls in the record's Activity (ticket 14: the person and company-lead timeline)", () => {
  test("each logged call shows with its outcome, the number dialled and its note; a skip for now shows as a skip", async () => {
    const { h, personId, task, taskOf, log } = await world();
    const patTask = await taskOf("Pat Oneil");
    const direct = (await task(patTask)).numbers[0];
    expect((await log(patTask, { outcome: "skip_for_now", note: "In clinic, try after lunch." })).status).toBe(200);
    h.clock += 30 * MIN;
    expect((await log(patTask, { outcome: "wrong_number", numberId: direct?.detailId, note: "Disconnected tone." })).status).toBe(200);
    const activity = (await h.request<ActivityView>("GET", `/api/people/${personId("Pat Oneil")}/activity`)).body.entries;
    const calls = activity.filter((e) => e.kind === "call");
    expect(calls).toEqual([
      { kind: "call", channel: "call", track: { label: "Phone track", several: false, branch: "main" }, campaign: expect.objectContaining({ name: "Calls" }), at: "2026-11-02T10:30:00.000Z", outcome: "wrong_number", number: { detailId: direct?.detailId, kind: "direct", owner: "person", value: direct?.value }, note: "Disconnected tone.", redial: false, callbackAt: null, onCallback: null, zone: "Europe/London", redialListedFrom: null, callbackOpen: false, declinedPath: null, afterDecline: [] },
      { kind: "call", channel: "call", track: { label: "Phone track", several: false, branch: "main" }, campaign: expect.objectContaining({ name: "Calls" }), at: "2026-11-02T10:00:00.000Z", outcome: "skip_for_now", number: null, note: "In clinic, try after lunch.", redial: false, callbackAt: null, onCallback: null, zone: "Europe/London", redialListedFrom: null, callbackOpen: false, declinedPath: null, afterDecline: [] },
    ]);
  });
});

describe("a phone track's skip and release in Activity, from its stored finish (merge of ticket 13b's Activity rule)", () => {
  test("a lead with no number skips the phone track, and the email after it says it started because of that", async () => {
    const SAM = person({ person_id: "p3", business_id: "b2", full_name: "Sam Lee", email: "sam@elm.example" });
    const ELM = business({ business_id: "b2", business_name: "Elm Street Clinic" });
    const h = new EngineHarness({ start: MONDAY_9 - H, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
    await h.tick();
    h.clock = MONDAY_9;
    const { campaign: c } = await h.createCampaign("No number", { businesses: [ELM], people: [SAM] });
    await h.defineSequence(c.id, definition([track("p1", "call", [call("c1")], WEEKDAYS_9_TO_17), { ...track("e1", "email", [email("s1")]), start: { kind: "after", trackId: "p1", delayDays: 0 } }]));
    expect((await h.launch(c.id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 2 * H);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
    const entries = (await h.request<ActivityView>("GET", `/api/people/${rows.find((r) => r.name === "Sam Lee")?.id}/activity`)).body.entries;
    expect(entries.map((e) => `${e.kind}|${"channel" in e ? e.channel : ""}|${"track" in e ? e.track.label : ""}`)).toEqual(expect.arrayContaining(["skipped|call|Phone track", "released|email|Email track", "sent|email|Email track"]));
    expect(entries.filter((e) => e.kind === "call")).toEqual([]);
  });
});

describe("a hint of when the call list changes by the clock (ADR 0003 4.4.1, \"Freshness\": the page reads every 20 seconds anyway)", () => {
  test("before calling hours, the instant they open; inside them, the instant they close; after them, the user's next day", async () => {
    const h = new EngineHarness({ start: MONDAY_9 - 3 * H, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
    await h.tick();
    await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" });
    h.clock = MONDAY_9 - 2 * H;
    const { campaign: c } = await h.createCampaign("Clock", { businesses: [HARBOUR], people: [PAT] });
    await h.defineSequence(c.id, definition([track("p1", "call", [call("c1")], WEEKDAYS_9_TO_17)]));
    expect((await h.launch(c.id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 - 90 * MIN);
    const views = async () => [(await h.request<CallsView>("GET", "/api/calls")).body, (await h.request<TodayView>("GET", "/api/today")).body] as const;

    for (const v of await views()) expect(v).toMatchObject({ asOf: "2026-11-02T07:30:00.000Z", nextChangeAt: "2026-11-02T09:00:00.000Z" });
    await h.advanceTo(MONDAY_9 + H);
    for (const v of await views()) expect(v).toMatchObject({ asOf: "2026-11-02T10:00:00.000Z", nextChangeAt: "2026-11-02T17:00:00.000Z" });
    await h.advanceTo(MONDAY_9 + 9 * H);
    for (const v of await views()) expect(v).toMatchObject({ nextChangeAt: "2026-11-03T00:00:00.000Z" });
  });
});
