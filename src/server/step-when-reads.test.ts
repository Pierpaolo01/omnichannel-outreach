import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../test/support/engine-harness.ts";
import { business, person } from "../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../domain/sequence/definition.ts";
import type { ControlView, EnrollmentRead, LeadSearchResult, StepWhenView } from "../shared/api.ts";

/**
 * Reads that say when a step goes (ADR 0003 "Reads that say when", ticket 23's defect 2), through the real HTTP app,
 * SQLite store and engine against the fake email provider. Every name and address is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
/** Monday 9 November 2026, 10:00 London (GMT). */
const MONDAY_10 = Date.parse("2026-11-09T10:00:00Z");
const TUESDAY_9 = Date.parse("2026-11-10T09:00:00Z");
const TUESDAY_TO_FRIDAY = [2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));

const email = (id: string, waitDays = 0): StepDefinition => ({ id, waitDays, subject: `Subject ${id}`, body: `Email ${id} for {{company}}.`, threading: "new_subject", removed: false });
const track = (id: string, steps: StepDefinition[], fields: Partial<TrackDefinition> = {}): TrackDefinition => ({ id, channel: "email", branch: "main", window: TUESDAY_TO_FRIDAY, steps, start: { kind: "entry" }, removed: false, ...fields });
const definition = (tracks: TrackDefinition[]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: [], callScript: "", tracks });
const LARK = business({ business_id: "b1", business_name: "Lark Street Clinic", phone_e164: "+441174960303" });
const PAT = person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@larkstreet.example" });

async function world(def: CampaignDefinition, capacity = 50) {
  const h = new EngineHarness({ start: MONDAY_10, accounts: [{ id: "inbox-a", capacity, gapMs: 10 * MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
  await h.tick();
  expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" })).status).toBe(200);
  const { campaign } = await h.createCampaign("Spring follow-up, Bristol", { businesses: [LARK], people: [PAT] });
  await h.defineSequence(campaign.id, def);
  expect((await h.launch(campaign.id)).status).toBe(200);
  const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows;
  const pat = rows[0]?.enrollments[0]?.id ?? "";
  const read = async () => (await h.request<EnrollmentRead>("GET", `/api/enrollments/${pat}`)).body;
  const when = async (trackId = "email"): Promise<StepWhenView | undefined> => (await read()).tracks.find((t) => t.trackId === trackId)?.nextStep?.when;
  return { h, campaign, pat, read, when };
}
const controlOf = (read: EnrollmentRead, action: string): ControlView => read.controls.find((c) => c.action === action)!;

describe("the enrollment read's next step (person and company records, GET /api/enrollments/:id)", () => {
  test("launched on Monday with a Tuesday-to-Friday window: the read says Tuesday 09:00, the instant the engine sends", async () => {
    const { h, when } = await world(definition([track("email", [email("s1")])]));
    await h.advanceTo(MONDAY_10 + H);
    expect(await when()).toEqual({ kind: "at", at: new Date(TUESDAY_9).toISOString() });
    await h.advanceTo(TUESDAY_9 + 2 * H);
    expect(h.fake.deliveryLog.map((d) => d.at)).toEqual([TUESDAY_9]);
  });

  test("inside the window, with no room on the only inbox today, the read gives the reason and no time", async () => {
    const { h, when } = await world(definition([track("email", [email("s1")], { window: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 })) })]), 0);
    await h.advanceTo(MONDAY_10 + MIN);
    expect(await when()).toEqual({ kind: "waits", why: "sending_capacity" });
  });

  test("while the campaign is paused the read promises no time; after the resume it says Tuesday's opening again", async () => {
    const { h, campaign, when } = await world(definition([track("email", [email("s1")])]));
    expect((await h.request("POST", `/api/campaigns/${campaign.id}/pause`, { requestId: "pause-1" })).status).toBe(200);
    expect(await when()).toEqual({ kind: "waits", why: "campaign_paused" });
    await h.advanceTo(MONDAY_10 + 3 * H);
    expect((await h.request("POST", `/api/campaigns/${campaign.id}/resume`, { requestId: "resume-1" })).status).toBe(200);
    expect(await when()).toEqual({ kind: "at", at: new Date(TUESDAY_9).toISOString() });
  });

  test("the lead's own pause previews its resume at Tuesday's opening, the engine's instant, not the wait's end", async () => {
    const { h, pat, read } = await world(definition([track("email", [email("s1")])]));
    expect((await h.request("POST", `/api/enrollments/${pat}/controls`, { requestId: "p-1", action: "pause" })).status).toBe(200);
    await h.advanceTo(MONDAY_10 + 2 * H);
    const resume = controlOf(await read(), "resume");
    expect(resume.allowed && resume.next?.when).toEqual({ kind: "at", at: new Date(TUESDAY_9).toISOString() });
  });
});
