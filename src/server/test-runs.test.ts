import type { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../test/support/engine-harness.ts";
import { business, person } from "../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../domain/sequence/definition.ts";
import type { BeforeLaunchView, CallsView, LeadSearchResult, TestRunTab } from "../shared/api.ts";

/**
 * Test runs (ticket 21; ADR 0003 "Ticket 21") through the real HTTP app, SQLite store and engine, on the fake email
 * and SMS providers. The test contacts are fictitious and the user's own; nothing reaches a real destination.
 */

const MIN = 60_000;
/** Monday 2 November 2026, 09:00 London (GMT). */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const WEEKDAYS = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
const OWN_EMAIL = "alex.own@personal-mail.example";
const OWN_MOBILE = "+447700900456";
const NUMBER = "+447700900900";

const step = (id: string, waitDays = 0, body = `Message ${id} for {{company}}, {{first_name|there}}.`): StepDefinition => ({ id, waitDays, subject: `Subject ${id}`, body, threading: "new_subject", removed: false });
const track = (id: string, channel: TrackDefinition["channel"], steps: StepDefinition[], fields: Partial<TrackDefinition> = {}): TrackDefinition => ({
  id,
  channel,
  branch: "main",
  window: channel === "call" ? WEEKDAYS : ALWAYS,
  steps,
  start: { kind: "entry" },
  removed: false,
  ...fields,
});

/** Two emails three days apart and two texts two days apart, together; a call a day after the emails; a win-back email. */
const DEFINITION: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["inbox-a"],
  smsPool: [NUMBER],
  callScript: "Ask who looks after bookings.",
  tracks: [
    track("e", "email", [step("e1"), step("e2", 3)]),
    track("m", "sms", [step("m1"), step("m2", 2)]),
    track("p", "call", [{ id: "c1", waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false }], { start: { kind: "after", trackId: "e", delayDays: 1 }, declinedPath: "win_back" }),
    track("w", "email", [step("w1")], { branch: "win_back" }),
  ],
};

const PAT = person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", title: "Clinic owner", email: "pat@harbour.example", dial_phone: "+447700900111", dial_phone_type: "mobile" });
const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });

async function world(definition: CampaignDefinition = DEFINITION) {
  const h = new EngineHarness({
    start: MONDAY_9,
    accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    sms: { numbers: [{ id: NUMBER, capacity: 50, gapMs: MIN, k: 2, healthy: true, resetZone: "Europe/London" }] },
  });
  await h.tick();
  expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" })).status).toBe(200);
  const { campaign } = await h.createCampaign("Clinics, London", { businesses: [HARBOUR], people: [PAT] });
  await h.defineSequence(campaign.id, definition);
  const lead = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows[0]?.enrollments[0]?.id ?? "";
  const tab = async () => (await h.request<TestRunTab>("GET", `/api/campaigns/${campaign.id}/test-runs`)).body;
  let n = 0;
  const run = async () => h.request<TestRunTab & { error?: { message: string } }>("POST", `/api/campaigns/${campaign.id}/test-runs`, { requestId: `run-${++n}`, renderAs: lead, expect: { definitionVersion: (await tab()).definitionVersion } });
  const sent = () => [...h.fake.deliveryLog, ...h.sms.deliveryLog];
  return { h, campaign: campaign.id, lead, tab, run, sent };
}

describe("test contacts (ADR 0003 'Ticket 21', the boundary)", () => {
  test("a lead's email or mobile is refused as a test contact, and nothing is stored", async () => {
    const w = await world();
    const refused = await w.h.request<{ error: { code: string; field: string } }>("PUT", `/api/campaigns/${w.campaign}/test-contacts`, { email: "PAT@harbour.example", mobile: "" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: "test_contact_is_a_lead", field: "email" });
    const mobile = await w.h.request<{ error: { field: string } }>("PUT", `/api/campaigns/${w.campaign}/test-contacts`, { email: "", mobile: "+44 7700 900111" });
    expect(mobile.status).toBe(409);
    expect((await w.tab()).contacts).toMatchObject({ email: null, mobile: null });
    const ok = await w.h.request<TestRunTab>("PUT", `/api/campaigns/${w.campaign}/test-contacts`, { email: OWN_EMAIL, mobile: "+44 7700 900456" });
    expect(ok.status).toBe(200);
    expect(ok.body.contacts).toEqual({ email: OWN_EMAIL, mobile: "+44 7700 900456", emailIsALead: false, mobileIsALead: false });
  });

  test("a lead's routes do not know a test run: its read, its controls and a bulk stop answer as for no lead (merge of ticket 18)", async () => {
    const w = await world();
    await w.h.request("PUT", `/api/campaigns/${w.campaign}/test-contacts`, { email: OWN_EMAIL, mobile: "" });
    const runId = (await w.run()).body.run?.id ?? "";
    expect((await w.h.request("GET", `/api/enrollments/${runId}`)).status).toBe(404);
    expect((await w.h.request("POST", `/api/enrollments/${runId}/controls`, { requestId: "c-1", action: "stop" })).status).toBe(404);
    const bulk = await w.h.request<{ results: { outcome: string; reason: string | null }[] }>("POST", "/api/bulk", {
      bulkId: "bulk-1",
      action: "stop",
      campaignId: null,
      items: [{ enrollmentId: runId, expect: { status: "active", preview: "" } }],
    });
    expect(bulk.body.results).toMatchObject([{ outcome: "refused", reason: "There is no such lead." }]);
    expect((await w.tab()).run).toMatchObject({ id: runId, running: true });
  });

  test("Run test is refused with no contact, and a lead's controls do not reach a test run", async () => {
    const w = await world();
    const refused = await w.run();
    expect(refused.status).toBe(409);
    expect(refused.body.error?.message).toBe("Add your own email or mobile first.");
  });
});

describe("a test run before launch (ADR 0003 'Ticket 21')", () => {
  test("every step goes to the test contacts only, a minute apart, and a reply from the test email stops it; the lead is untouched", async () => {
    const w = await world();
    await w.h.request("PUT", `/api/campaigns/${w.campaign}/test-contacts`, { email: OWN_EMAIL, mobile: OWN_MOBILE });
    expect((await w.tab()).noTestSinceEdit).toBe(true);
    const started = await w.run();
    expect(started.status).toBe(200);
    expect(started.body.run?.running).toBe(true);
    expect(started.body.noTestSinceEdit).toBe(false);
    // A second run while one runs is refused (T8).
    expect((await w.run()).body.error?.message).toBe("A test is already running. Stop it to run another.");

    await w.h.advanceTo(MONDAY_9 + 3 * MIN);
    const sent = w.sent();
    expect(sent.map((d) => d.stepId).sort()).toEqual(["e1", "e2", "m1", "m2"]);
    expect(new Set(sent.map((d) => d.destination))).toEqual(new Set([OWN_EMAIL, OWN_MOBILE]));
    // Rendered for the lead it renders as, sent to the user's own contacts.
    expect(sent.find((d) => d.stepId === "e1")?.rendered.body).toBe("Message e1 for Harbour Lane Physio, Pat.");
    const at = (id: string) => sent.find((d) => d.stepId === id)?.at ?? 0;
    expect(at("e2") - at("e1")).toBeGreaterThanOrEqual(MIN);
    expect(at("e2") - at("e1")).toBeLessThan(3 * MIN);

    // The call goes on the list a minute after the email track finishes.
    await w.h.advanceTo(MONDAY_9 + 5 * MIN);
    const calls = (await w.h.request<CallsView>("GET", "/api/calls")).body;
    const testCall = calls.readyNow.find((c) => c.test);
    expect(testCall?.campaign.name).toBe("Clinics, London");

    // A reply from the test email ends the test.
    expect(w.h.fake.prospectReplies(OWN_EMAIL)).toBe(true);
    await w.h.advanceTo(MONDAY_9 + 7 * MIN);
    const tab = await w.tab();
    expect(tab.run).toMatchObject({ running: false, ending: "your_reply" });
    // The lead was never sent anything and is not launched.
    const progress = await w.h.progress(w.lead);
    expect(progress.status).toBe("queued");
    expect(w.sent().every((d) => d.subjectId !== w.lead)).toBe(true);
  });

  test("a test call's outcome follows the canvas: not interested enters the win-back branch, whose email goes to the test email", async () => {
    const w = await world();
    await w.h.request("PUT", `/api/campaigns/${w.campaign}/test-contacts`, { email: OWN_EMAIL, mobile: OWN_MOBILE });
    await w.run();
    await w.h.advanceTo(MONDAY_9 + 5 * MIN);
    const call = (await w.h.request<CallsView>("GET", "/api/calls")).body.readyNow.find((c) => c.test);
    expect(call).toBeDefined();
    const noted = await w.h.request("POST", `/api/call-tasks/${call?.taskId}/outcome`, { requestId: "o-0", outcome: "not_interested", declinedPath: "win_back", numberId: `test:${(await w.tab()).run?.id}:mobile`, note: "a note" });
    expect(noted.status).toBe(400);
    const logged = await w.h.request("POST", `/api/call-tasks/${call?.taskId}/outcome`, { requestId: "o-1", outcome: "not_interested", declinedPath: "win_back", numberId: `test:${(await w.tab()).run?.id}:mobile`, note: "" });
    expect(logged.status).toBe(200);
    await w.h.advanceTo(MONDAY_9 + 8 * MIN);
    expect(w.sent().filter((d) => d.stepId === "w1").map((d) => d.destination)).toEqual([OWN_EMAIL]);
    const rows = (await w.tab()).run?.steps ?? [];
    expect(rows.find((r) => r.stepId === "c1")).toMatchObject({ state: "logged", outcome: "not_interested" });
    expect(rows.find((r) => r.stepId === "w1")?.state).toBe("sent");
  });

  test("a stopped test's call is not reported on the list, as the Calls list does not list it (review bot on 55d6ac6)", async () => {
    const w = await world();
    await w.h.request("PUT", `/api/campaigns/${w.campaign}/test-contacts`, { email: OWN_EMAIL, mobile: OWN_MOBILE });
    const runId = (await w.run()).body.run?.id ?? "";
    await w.h.advanceTo(MONDAY_9 + 5 * MIN);
    expect((await w.tab()).run?.steps.find((r) => r.stepId === "c1")?.state).toBe("on_your_list");
    expect((await w.h.request("POST", `/api/test-runs/${runId}/stop`, { requestId: "stop-1" })).status).toBe(200);
    expect((await w.h.request<CallsView>("GET", "/api/calls")).body.readyNow.filter((c) => c.test)).toEqual([]);
    expect((await w.tab()).run?.steps.find((r) => r.stepId === "c1")?.state).toBe("not_reached");
  });

  test("a test call carried into the next day while its campaign is paused takes that day's capacity, as it is listed (review bot on 55d6ac6)", async () => {
    const w = await world();
    expect((await w.h.request("PUT", "/api/call-settings", { dailyCapacity: 1, userZone: "Europe/London" })).status).toBe(200);
    await w.h.request("PUT", `/api/campaigns/${w.campaign}/test-contacts`, { email: OWN_EMAIL, mobile: OWN_MOBILE });
    expect((await w.h.launch(w.campaign)).status).toBe(200);
    await w.run();
    await w.h.advanceTo(MONDAY_9 + 5 * MIN);
    expect((await w.h.request<CallsView>("GET", "/api/calls")).body.readyNow.filter((c) => c.test)).toHaveLength(1);
    expect((await w.h.request("POST", `/api/campaigns/${w.campaign}/pause`, { requestId: "p-1" })).status).toBe(200);
    await w.h.advanceTo(Date.parse("2026-11-03T09:30:00Z"));
    const tuesday = (await w.h.request<CallsView>("GET", "/api/calls")).body;
    expect(tuesday.readyNow.filter((c) => c.test)).toHaveLength(1);
    expect([tuesday.committed, tuesday.capacityReached]).toEqual([1, true]);
  });

  test("a test run's rows may name only its own test contacts: another run's, an invented one or one it lacks is refused on all three tables (verifier F2 on 55d6ac6)", async () => {
    const w = await world();
    await w.h.request("PUT", `/api/campaigns/${w.campaign}/test-contacts`, { email: OWN_EMAIL, mobile: OWN_MOBILE });
    const runId = (await w.run()).body.run?.id ?? "";
    await w.h.advanceTo(MONDAY_9 + 5 * MIN);
    const call = (await w.h.request<CallsView>("GET", "/api/calls")).body.readyNow.find((c) => c.test);
    expect((await w.h.request("POST", `/api/call-tasks/${call?.taskId}/outcome`, { requestId: "o-1", outcome: "no_answer", numberId: `test:${runId}:mobile`, note: "" })).status).toBe(200);
    const db = (w.h.store.engine as unknown as { db: DatabaseSync }).db;
    const set = (table: string, column: string, value: string) => () => db.prepare(`UPDATE ${table} SET ${column} = ? WHERE subject_id = ?`).run(value, runId);
    for (const [table, column] of [["track_progress", "destination_detail_id"], ["attempts", "destination_detail_id"], ["call_attempts", "number_detail_id"]] as const) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE subject_id = ? AND ${column} IS NOT NULL`).get(runId)?.["n"], table).not.toBe(0);
      for (const bad of ["test:test-other:email", `test:${runId}:invented`, `test:${runId}:fax`]) expect(set(table, column, bad), `${table} ${bad}`).toThrow(/names neither/);
      expect(set(table, column, `test:${runId}:email`), table).not.toThrow();
    }
    // A run without a mobile: its own mobile id is refused, since it has no such contact.
    db.exec(`UPDATE test_runs SET mobile_key = NULL, mobile_value = NULL WHERE id = '${runId}'`);
    expect(set("attempts", "destination_detail_id", `test:${runId}:mobile`)).toThrow(/names neither/);
  });

  test("an edit stops the running test, and the warning holds until a test runs on the new version; launch is never blocked by it", async () => {
    const w = await world();
    await w.h.request("PUT", `/api/campaigns/${w.campaign}/test-contacts`, { email: OWN_EMAIL, mobile: "" });
    await w.run();
    await w.h.defineSequence(w.campaign, { ...DEFINITION, tracks: DEFINITION.tracks.map((t) => (t.id === "e" ? { ...t, steps: [step("e1", 0, "Changed copy for {{company}}."), step("e2", 3)] } : t)) });
    const tab = await w.tab();
    expect(tab.run).toMatchObject({ running: false, ending: "edited" });
    expect(tab.noTestSinceEdit).toBe(true);
    const before = (await w.h.request<BeforeLaunchView>("GET", `/api/campaigns/${w.campaign}/before-launch`)).body;
    expect(before.noTestSinceEdit).toBe(true);
    expect((await w.h.launch(w.campaign)).status).toBe(200);
  });

  test("a stopped test frees its SMS conversation, so the next test texts from the same number", async () => {
    const w = await world({ ...DEFINITION, tracks: [track("m", "sms", [step("m1")])] });
    await w.h.request("PUT", `/api/campaigns/${w.campaign}/test-contacts`, { email: "", mobile: OWN_MOBILE });
    await w.run();
    await w.h.advanceTo(MONDAY_9 + 2 * MIN);
    expect((await w.tab()).run?.ending).toBe("finished");
    await w.run();
    await w.h.advanceTo(MONDAY_9 + 4 * MIN);
    expect(w.h.sms.deliveryLog.map((d) => [d.destination, d.sender])).toEqual([
      [OWN_MOBILE, NUMBER],
      [OWN_MOBILE, NUMBER],
    ]);
  });
});
