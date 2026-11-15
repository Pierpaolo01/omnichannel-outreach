import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { LeadSearchResult, NeedsAttention } from "../../shared/api.ts";

/**
 * Needs attention's ticket 20 lists (ADR 0003 "Ticket 20a", Reads) through the real HTTP app, store and engine against
 * the fake email provider: leads waiting for sending capacity, leads left with no usable channel, and steps waiting
 * for a transport the provider cannot use yet. Data is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));

const email = (id: string, waitDays = 0, threading: StepDefinition["threading"] = "new_subject"): StepDefinition => ({ id, waitDays, subject: `Subject ${id}`, body: `Email ${id} for {{company}}.`, threading, removed: false });
const track = (id: string, channel: TrackDefinition["channel"], steps: StepDefinition[]): TrackDefinition => ({ id, channel, branch: "main", window: ALWAYS, steps, start: { kind: "entry" }, removed: false });
const definition = (tracks: TrackDefinition[]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: [], callScript: "", tracks });
const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });
const PAT = person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example" });
const NIA = person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", email: "nia@harbour.example" });
const SAM = person({ person_id: "p3", business_id: "b1", full_name: "Sam Reed", email: "sam@harbour.example" });
/** No email and no mobile: only the company's main line. */
const ROB = person({ person_id: "p4", business_id: "b1", full_name: "Rob Lane" });

async function world(capacity: number, def: CampaignDefinition, people = [PAT, NIA, SAM], bouncing: readonly string[] = []) {
  const h = new EngineHarness({ start: MONDAY_9, accounts: [{ id: "inbox-a", capacity, gapMs: 5 * MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
  for (const address of bouncing) h.fake.bouncing.add(address);
  await h.tick();
  const { campaign } = await h.createCampaign("Clinics", { businesses: [HARBOUR], people });
  await h.defineSequence(campaign.id, def);
  expect((await h.launch(campaign.id)).status).toBe(200);
  const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows;
  const lead = (who: string) => rows.find((r) => r.name === who)?.enrollments[0]?.id ?? "";
  const personId = (who: string) => rows.find((r) => r.name === who)?.id ?? "";
  const attention = async () => (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body;
  return { h, campaignId: campaign.id, lead, personId, attention };
}

describe("leads waiting for sending capacity", () => {
  test("a lead whose step is due and claimable but whose inbox is full for the day, until the inbox resets", async () => {
    const { h, campaignId, lead, personId, attention } = await world(2, definition([track("e1", "email", [email("s1")])]));
    await h.advanceTo(MONDAY_9 + H);
    expect(h.fake.handoverLog).toHaveLength(2);
    expect((await attention()).waitingForCapacity).toEqual([
      {
        enrollmentId: lead("Sam Reed"),
        campaignId,
        // Ticket 20b: whose lead it is and in which campaign, so Today names them and links to the record.
        person: { id: personId("Sam Reed"), name: "Sam Reed" },
        company: { id: expect.any(String), name: "Harbour Lane Physio" },
        campaign: { id: campaignId, name: "Clinics" },
        trackId: "e1",
        stepId: "s1",
        channel: "email",
        dueAt: new Date(MONDAY_9).toISOString(),
        accountIds: ["inbox-a"],
        resetsAt: "2026-11-03T00:00:00.000Z",
      },
    ]);
    await h.advanceTo(Date.parse("2026-11-03T01:00:00Z"));
    expect((await attention()).waitingForCapacity).toEqual([]);
    expect(h.fake.handoverLog).toHaveLength(3);
  });

  test("a lead waiting only for a pacing slot or an in-flight place is not waiting for capacity", async () => {
    const { h, attention } = await world(50, definition([track("e1", "email", [email("s1")])]));
    // At launch two of three are claimed (k = 2); the third waits for a place, with capacity to spare.
    expect(h.fake.handoverLog.length).toBeLessThan(3);
    expect((await attention()).waitingForCapacity).toEqual([]);
  });
});

describe("leads left with no usable channel", () => {
  test("from any cause, with why each channel of the branch cannot reach them", async () => {
    const def = definition([track("e1", "email", [email("s1"), email("s2", 1)])]);
    // Rob has no email: he ends at launch. Pat's only email bounces.
    const { h, campaignId, lead, personId, attention } = await world(50, def, [PAT, ROB], ["pat@harbour.example"]);
    await h.advanceTo(MONDAY_9 + 2 * H);
    const listed = (await attention()).noUsableChannel;
    expect(listed.map((x) => x.enrollmentId).sort()).toEqual([lead("Pat Oneil"), lead("Rob Lane")].sort());
    expect(listed.find((x) => x.enrollmentId === lead("Rob Lane"))).toMatchObject({
      campaignId,
      person: { id: personId("Rob Lane"), name: "Rob Lane" },
      company: { name: "Harbour Lane Physio" },
      campaign: { id: campaignId, name: "Clinics" },
      channels: [{ channel: "email", why: "missing" }],
    });
    expect(listed.find((x) => x.enrollmentId === lead("Pat Oneil"))).toMatchObject({ campaignId, channels: [{ channel: "email", why: "bad" }] });
  });
});

describe("a lead whose details a later import restores (review bot on 487de7c)", () => {
  test("the ending stays listed, final, with no channel left that cannot reach them now", async () => {
    const def = definition([track("e1", "email", [email("s1")])]);
    const { h, campaignId, lead, attention } = await world(50, def, [PAT, ROB]);
    await h.advanceTo(MONDAY_9 + H);
    expect((await attention()).noUsableChannel.find((x) => x.enrollmentId === lead("Rob Lane"))?.channels).toEqual([{ channel: "email", why: "missing" }]);
    await h.reimport(campaignId, { businesses: [HARBOUR], people: [PAT, { ...ROB, email: "rob@harbour.example" }] });
    await h.advanceTo(MONDAY_9 + 2 * H);
    expect((await attention()).noUsableChannel.find((x) => x.enrollmentId === lead("Rob Lane"))).toMatchObject({ person: { name: "Rob Lane" }, channels: [] });
  });
});

describe("steps waiting for a transport the provider cannot use yet (follow-up 42 item 12)", () => {
  test("a continue-thread follow-up, due, while that transport is unavailable", async () => {
    const def = definition([track("e1", "email", [email("s1"), email("s2", 1, "continue_thread")])]);
    const { h, lead, attention } = await world(50, def, [PAT]);
    h.fake.continueThreadUnavailable = true;
    await h.advanceTo(MONDAY_9 + 2 * DAY);
    expect((await attention()).waitingOnTransport).toEqual([{ enrollmentId: lead("Pat Oneil"), trackId: "e1", stepId: "s2", channel: "email", dueAt: "2026-11-03T00:00:00.000Z" }]);
    expect((await attention()).waitingForCapacity).toEqual([]);
  });
});
