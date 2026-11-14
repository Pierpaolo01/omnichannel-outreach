import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../test/support/engine-harness.ts";
import { business, person } from "../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../domain/sequence/definition.ts";
import type { ActivityView, CallsView, CampaignDetail, CampaignListItem, CompanyRecord, EnrollmentRead, LeadSearchResult, PersonRecord, RecordControls, TodayView } from "../shared/api.ts";

/**
 * The reads ticket 17b's screens show (ADR 0003 "Ticket 17a", "Reads"), each a read-only addition built by the engine's
 * own functions: the campaign list's pause and counts, each record's enrollment reads, the paused campaigns whose calls
 * left Today and Calls, and Activity's entries for the controls, from the engine's record of accepted requests.
 * Through the real HTTP app, SQLite store and engine, against the fake email provider. Data is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
/** Monday 2 November 2026, 09:00 London (GMT). */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const WEEKDAYS_9_TO_17 = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));

const email = (id: string, waitDays = 0): StepDefinition => ({ id, waitDays, subject: `Subject ${id}`, body: `Email ${id} for {{company}}.`, threading: "new_subject", removed: false });
const track = (id: string, channel: TrackDefinition["channel"], steps: StepDefinition[], fields: Partial<TrackDefinition> = {}): TrackDefinition => ({
  id,
  channel,
  branch: "main",
  window: channel === "call" ? WEEKDAYS_9_TO_17 : ALWAYS,
  steps,
  start: { kind: "entry" },
  removed: false,
  ...fields,
});
const DEFINITION: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["inbox-a"],
  smsPool: [],
  callScript: "Ask who looks after new patient bookings.",
  tracks: [
    track("e1", "email", [email("s1"), email("s2", 2), email("s3", 3)]),
    track("p1", "call", [{ ...email("c1"), subject: "", body: "" }]),
    track("w1", "email", [email("w1s1"), email("w1s2", 2)], { branch: "win_back" }),
  ],
};
const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });
const PAT = person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", direct_phone: "+442079460111" });
const NIA = person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", email: "nia@harbour.example", direct_phone: "+442079460112" });
const QUAY = business({ business_id: "b2", business_name: "Quayside Clinic", phone_e164: "+442079460201", email: "hello@quayside.example" });

async function world() {
  const h = new EngineHarness({ start: MONDAY_9, accounts: [{ id: "inbox-a", capacity: 50, gapMs: 10 * MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
  await h.tick();
  expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" })).status).toBe(200);
  const campaign = async (name: string, launch = true) => {
    const { campaign: c } = await h.createCampaign(name, { businesses: [HARBOUR, QUAY], people: [PAT, NIA] });
    await h.defineSequence(c.id, DEFINITION);
    if (launch) expect((await h.launch(c.id)).status).toBe(200);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
    return {
      id: c.id,
      lead: (who: string) => rows.find((r) => r.name === who)?.enrollments.find((e) => e.campaign.id === c.id)?.id ?? "",
      record: (who: string) => rows.find((r) => r.name === who)?.id ?? "",
    };
  };
  let n = 0;
  const control = (enrollmentId: string, action: string) => h.request<{ error?: { message: string }; enrollment?: EnrollmentRead }>("POST", `/api/enrollments/${enrollmentId}/controls`, { requestId: `r-${++n}`, action });
  const campaignControl = (id: string, action: "pause" | "resume") => h.request<CampaignDetail>("POST", `/api/campaigns/${id}/${action}`, { requestId: `r-${++n}` });
  const get = async <T>(path: string) => {
    const res = await h.request<T>("GET", path);
    expect(res.status, path).toBe(200);
    return res.body;
  };
  return { h, campaign, control, campaignControl, get };
}

describe("the campaign list says each campaign's pause as its own page does", () => {
  test("paused and running: the pause, its date, the count of leads in each status, the controls and mayStillSend equal the campaign's read", async () => {
    const { h, campaign, campaignControl, get } = await world();
    const clinics = await campaign("Clinics");
    const draft = await campaign("Draft", false);
    await h.advanceTo(MONDAY_9 + H);
    expect((await campaignControl(clinics.id, "pause")).status).toBe(200);

    const list = (await get<{ campaigns: CampaignListItem[] }>("/api/campaigns")).campaigns;
    for (const id of [clinics.id, draft.id]) {
      const detail = await get<CampaignDetail>(`/api/campaigns/${id}`);
      const item = list.find((c) => c.id === id);
      expect(item?.pause).toEqual(detail.pause);
      expect(item?.statusCounts).toEqual(detail.statusCounts);
      expect(item?.controls).toEqual(detail.controls);
      expect(item?.mayStillSend).toBe(detail.mayStillSend);
    }
    const paused = list.find((c) => c.id === clinics.id);
    expect(paused?.pause).toEqual({ paused: true, pausedSince: new Date(MONDAY_9 + H).toISOString() });
    // A campaign pause changes no status: Pat, Nia and the company lead still wait on their calls.
    expect(paused?.statusCounts).toMatchObject({ waiting_on_call: 3, paused: 0 });
    expect(list.find((c) => c.id === draft.id)?.controls).toEqual([
      { action: "pause", allowed: false, reason: "This campaign has not launched." },
      { action: "resume", allowed: false, reason: "This campaign is not paused." },
    ]);
  });
});

describe("a record carries each enrollment's read, with its campaign's launch and pause", () => {
  test("a person in two campaigns, one paused: each lead is the enrollment's own read, and the user's zone comes with them", async () => {
    const { h, campaign, campaignControl, get } = await world();
    const clinics = await campaign("Clinics");
    const second = await campaign("Second");
    await h.advanceTo(MONDAY_9 + H);
    expect((await campaignControl(clinics.id, "pause")).status).toBe(200);

    const record = await get<PersonRecord & RecordControls>(`/api/people/${clinics.record("Pat Oneil")}`);
    expect(record.userZone).toBe("Europe/London");
    expect(record.leads.map((l) => l.id).sort()).toEqual(record.enrollments.map((e) => e.id).sort());
    for (const lead of record.leads) {
      const { campaignState, ...read } = lead;
      expect(read).toEqual(await get<EnrollmentRead>(`/api/enrollments/${lead.id}`));
      const paused = lead.campaignId === clinics.id;
      expect(campaignState).toEqual({ launched: true, paused, pausedSince: paused ? new Date(MONDAY_9 + H).toISOString() : null });
    }
    expect(record.leads.find((l) => l.campaignId === second.id)?.controls.find((c) => c.action === "pause")).toMatchObject({ allowed: true });
  });

  test("a company lead's record, before launch: its lead says the campaign has not launched", async () => {
    const { campaign, get } = await world();
    const draft = await campaign("Draft", false);
    const company = await get<CompanyRecord & RecordControls>(`/api/companies/${draft.record("Quayside Clinic")}`);
    expect(company.leads).toHaveLength(1);
    expect(company.leads[0]?.campaignState).toEqual({ launched: false, paused: false, pausedSince: null });
    expect(company.leads[0]?.controls.find((c) => c.action === "stop")).toMatchObject({ allowed: false });
  });
});

describe("Today and Calls name the paused campaigns whose calls left the list", () => {
  test("paused: the campaign, its date and how many of its leads wait on a call; resumed: none", async () => {
    const { h, campaign, campaignControl, get } = await world();
    const clinics = await campaign("Clinics");
    await h.advanceTo(MONDAY_9 + H);
    expect((await get<CallsView>("/api/calls")).pausedCampaigns).toEqual([]);
    expect((await campaignControl(clinics.id, "pause")).status).toBe(200);
    const expected = [{ id: clinics.id, name: "Clinics", pausedSince: new Date(MONDAY_9 + H).toISOString(), calls: 3 }];
    const calls = await get<CallsView>("/api/calls");
    expect(calls.readyNow).toEqual([]);
    expect(calls.pausedCampaigns).toEqual(expected);
    expect((await get<TodayView>("/api/today")).pausedCampaigns).toEqual(expected);
    expect((await campaignControl(clinics.id, "resume")).status).toBe(200);
    expect((await get<TodayView>("/api/today")).pausedCampaigns).toEqual([]);
  });

  test("a paused campaign with no lead waiting on a call is not named", async () => {
    const { h, campaign, campaignControl, control, get } = await world();
    const clinics = await campaign("Clinics");
    await h.advanceTo(MONDAY_9 + H);
    expect((await control(clinics.lead("Pat Oneil"), "stop")).status).toBe(200);
    expect((await control(clinics.lead("Nia Cole"), "skip")).status).toBe(200);
    expect((await control(clinics.lead("Quayside Clinic"), "stop")).status).toBe(200);
    expect((await campaignControl(clinics.id, "pause")).status).toBe(200);
    expect((await get<CallsView>("/api/calls")).pausedCampaigns).toEqual([]);
  });
});

describe("Activity says each control, from the engine's record of accepted requests", () => {
  test("pause, resume, skip, stop, restart and the campaign's pause, each once, newest first; a refused control says nothing", async () => {
    const { h, campaign, control, campaignControl, get } = await world();
    const clinics = await campaign("Clinics");
    const pat = clinics.lead("Pat Oneil");
    const at = (ms: number) => new Date(ms).toISOString();
    await h.advanceTo(MONDAY_9 + H);
    expect((await control(pat, "pause")).status).toBe(200);
    expect((await control(pat, "pause")).status).toBe(409);
    await h.advanceTo(MONDAY_9 + 2 * H);
    expect((await control(pat, "resume")).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 3 * H);
    // The call is the current step; skipping it names the phone track.
    expect((await control(pat, "skip")).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 4 * H);
    expect((await control(pat, "skip")).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 5 * H);
    expect((await campaignControl(clinics.id, "pause")).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 6 * H);
    expect((await campaignControl(clinics.id, "resume")).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 7 * H);
    expect((await control(pat, "stop")).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 8 * H);
    expect((await control(pat, "resume_from_next_step")).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 9 * H);
    expect((await control(pat, "stop")).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 10 * H);
    expect((await control(pat, "move_to_win_back")).status).toBe(200);

    const activity = await get<ActivityView>(`/api/people/${clinics.record("Pat Oneil")}/activity`);
    const controls = activity.entries.filter((e) => e.kind === "control" || e.kind === "campaign_paused" || e.kind === "campaign_resumed");
    const campaignRef = { id: clinics.id, name: "Clinics" };
    const EMAIL = { label: "Email track", several: false, branch: "main" };
    expect(controls).toEqual([
      { campaign: campaignRef, at: at(MONDAY_9 + 10 * H), kind: "control", action: "move_to_win_back", step: { channel: "email", track: { label: "Win-back email track", several: false, branch: "win_back" }, number: 1 } },
      { campaign: campaignRef, at: at(MONDAY_9 + 9 * H), kind: "control", action: "stop", step: null },
      { campaign: campaignRef, at: at(MONDAY_9 + 8 * H), kind: "control", action: "resume_from_next_step", step: { channel: "email", track: EMAIL, number: 3 } },
      { campaign: campaignRef, at: at(MONDAY_9 + 7 * H), kind: "control", action: "stop", step: null },
      { campaign: campaignRef, at: at(MONDAY_9 + 6 * H), kind: "campaign_resumed" },
      { campaign: campaignRef, at: at(MONDAY_9 + 5 * H), kind: "campaign_paused" },
      { campaign: campaignRef, at: at(MONDAY_9 + 4 * H), kind: "control", action: "skip", step: { channel: "email", track: EMAIL, number: 2 } },
      { campaign: campaignRef, at: at(MONDAY_9 + 3 * H), kind: "control", action: "skip", step: { channel: "call", track: { label: "Phone track", several: false, branch: "main" }, number: 1 } },
      { campaign: campaignRef, at: at(MONDAY_9 + 2 * H), kind: "control", action: "resume", step: null },
      { campaign: campaignRef, at: at(MONDAY_9 + H), kind: "control", action: "pause", step: null },
    ]);
    // A step the user skipped is said once, by the control's entry, not again as a skipped step.
    expect(activity.entries.filter((e) => e.kind === "skipped")).toEqual([]);
    // Nia's timeline has the campaign's pause and none of Pat's controls.
    const nia = await get<ActivityView>(`/api/people/${clinics.record("Nia Cole")}/activity`);
    expect(nia.entries.filter((e) => e.kind === "control")).toEqual([]);
    expect(nia.entries.filter((e) => e.kind === "campaign_paused").map((e) => e.at)).toEqual([at(MONDAY_9 + 5 * H)]);
  });

  test("a campaign paused before a lead was enrolled is not on that lead's timeline", async () => {
    const { h, campaign, campaignControl, get } = await world();
    const clinics = await campaign("Clinics");
    await h.advanceTo(MONDAY_9 + H);
    expect((await campaignControl(clinics.id, "pause")).status).toBe(200);
    expect((await campaignControl(clinics.id, "resume")).status).toBe(200);
    await h.advanceTo(MONDAY_9 + DAY);
    const later = person({ person_id: "p3", business_id: "b1", full_name: "Ola Brook", email: "ola@harbour.example", direct_phone: "+442079460113" });
    await h.reimport(clinics.id, { businesses: [HARBOUR, QUAY], people: [PAT, NIA, later] });
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${clinics.id}`)).body.rows;
    const ola = rows.find((r) => r.name === "Ola Brook")?.id ?? "";
    const activity = await get<ActivityView>(`/api/people/${ola}/activity`);
    expect(activity.entries.filter((e) => e.kind === "campaign_paused" || e.kind === "campaign_resumed")).toEqual([]);
  });
});
