import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { LeadSearchResult, NeedsAttention, TodayView } from "../../shared/api.ts";

/**
 * The dispatch gate per provider, and what the reads say while it holds work (ticket 20a; the council and the verifier
 * on 13dad92): through the real HTTP app, store and engine, against the fake email and SMS providers. Fictitious data.
 */

const MIN = 60_000;
const H = 60 * MIN;
const MONDAY_2350 = Date.parse("2026-11-02T23:50:00Z");
const TUESDAY_0 = Date.parse("2026-11-03T00:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const N1 = "+447700900001";

const email = (id: string, waitDays = 0): StepDefinition => ({ id, waitDays, subject: `Subject ${id}`, body: `Email ${id} for {{company}}.`, threading: "new_subject", removed: false });
const track = (id: string, channel: TrackDefinition["channel"], steps: StepDefinition[]): TrackDefinition => ({ id, channel, branch: "main", window: ALWAYS, steps, start: { kind: "entry" }, removed: false });
const def = (tracks: TrackDefinition[]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: [N1], callScript: "", tracks });
const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });
const PAT = person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", dial_phone: "+447700900101", dial_phone_type: "mobile" });

/** One lead, an email follow-up due at midnight; the worker ticking every 15 seconds itself, as in production. */
async function world(tracks: TrackDefinition[]) {
  const h = new EngineHarness({
    start: MONDAY_2350,
    accounts: [{ id: "inbox-a", capacity: 100, gapMs: MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    sms: { numbers: [{ id: N1, capacity: 100, gapMs: MIN, k: 1, healthy: true, resetZone: "Europe/London" }] },
  });
  h.standsIn = false;
  await h.tick();
  const { campaign } = await h.createCampaign("Clinics", { businesses: [HARBOUR], people: [PAT] });
  await h.defineSequence(campaign.id, def(tracks));
  expect((await h.launch(campaign.id)).status).toBe(200);
  const lead = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows[0]!.enrollments[0]!.id;
  const every15s = async (until: number) => {
    while (h.clock + 15_000 <= until) {
      h.clock += 15_000;
      await h.tick();
    }
  };
  const s2 = () => h.fake.handoverLog.filter((c) => c.stepId === "s2");
  return { h, lead, every15s, s2 };
}

describe("a lead's send waits only on the providers relevant to it (council C)", () => {
  test("an email-only lead is not held by an SMS outage: its midnight follow-up goes on time", async () => {
    const { h, every15s, s2 } = await world([track("e1", "email", [email("s1"), email("s2", 1)])]);
    await every15s(MONDAY_2350 + 2 * MIN);
    h.outageChannels = new Set(["sms"]);
    h.cutProvidersOff(TUESDAY_0 + H);
    await every15s(TUESDAY_0 + 2 * MIN);
    expect(s2().map((c) => c.at)).toEqual([TUESDAY_0]);
  });

  test("a lead with email and SMS waits on both: its email waits for the SMS provider, and Needs attention says why (council B)", async () => {
    const { h, every15s, s2 } = await world([track("e1", "email", [email("s1"), email("s2", 1)]), track("x1", "sms", [{ ...email("t1"), subject: "" }])]);
    await every15s(MONDAY_2350 + 2 * MIN);
    const lastSms = h.clock;
    h.outageChannels = new Set(["sms"]);
    h.cutProvidersOff(TUESDAY_0 + 20 * MIN);
    await every15s(TUESDAY_0 + MIN);
    expect(s2()).toEqual([]);
    const attention = (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body;
    expect(attention.waitingOnProvider).toEqual([{ channel: "sms", since: new Date(lastSms).toISOString(), sends: 1 }]);
    await every15s(TUESDAY_0 + 22 * MIN);
    expect(s2()).toHaveLength(1);
    expect((await h.request<NeedsAttention>("GET", "/api/needs-attention")).body.waitingOnProvider).toEqual([]);
  });
});

describe("a slow tick with no outage invents no interruption (council D)", () => {
  test("eight withdrawals answering in 50 seconds each make a seven-minute tick: no notice", async () => {
    const inboxes = ["inbox-a", "inbox-b", "inbox-c", "inbox-d"];
    const h = new EngineHarness({ start: MONDAY_2350, accounts: inboxes.map((id) => ({ id, capacity: 100, gapMs: 1000, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" })), modes: ["late-send"] });
    h.standsIn = false;
    await h.tick();
    const people = Array.from({ length: 8 }, (_, i) => person({ person_id: `p${i}`, business_id: "b1", full_name: `Lead Number${i}`, email: `lead${i}@harbour.example` }));
    const { campaign } = await h.createCampaign("Clinics", { businesses: [HARBOUR], people });
    await h.defineSequence(campaign.id, { ...def([track("e1", "email", [email("s1"), email("s2", 1)])]), emailPool: inboxes, smsPool: [] });
    expect((await h.launch(campaign.id)).status).toBe(200);
    while (h.fake.handoverLog.length < 8 && h.clock < MONDAY_2350 + 5 * MIN) {
      h.clock += 1000;
      await h.tick();
    }
    expect(h.fake.handoverLog).toHaveLength(8);
    h.slowCalls = { kind: "withdraw", ms: 50_000 };
    const before = h.clock;
    expect((await h.request("POST", `/api/campaigns/${campaign.id}/pause`, { requestId: "slow" })).status).toBe(200);
    expect(h.clock - before).toBeGreaterThan(6 * MIN);
    expect((await h.request<TodayView>("GET", "/api/today")).body.interruption).toBeNull();
  });
});

describe("the cause of a wait comes from evidence (council G)", () => {
  test("no tick for six minutes and no provider failing: the worker is not running", async () => {
    const { h, every15s } = await world([track("e1", "email", [email("s1"), email("s2", 1)])]);
    await every15s(MONDAY_2350 + 2 * MIN);
    h.clock += 6 * MIN;
    expect((await h.request<TodayView>("GET", "/api/today")).body.sendingInterrupted).toMatchObject({ cause: "not_running" });
  });
});

describe("a process that lost its lease sends nothing (council E)", () => {
  test("with the lease not held, the gate dispatches nothing; held again, the follow-up goes", async () => {
    let held = true;
    const h = new EngineHarness({ start: MONDAY_2350, accounts: [{ id: "inbox-a", capacity: 100, gapMs: MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }], engine: { leaseHeld: () => held } });
    await h.tick();
    const { campaign } = await h.createCampaign("Clinics", { businesses: [HARBOUR], people: [PAT] });
    await h.defineSequence(campaign.id, { ...def([track("e1", "email", [email("s1"), email("s2", 1)])]), smsPool: [] });
    expect((await h.launch(campaign.id)).status).toBe(200);
    held = false;
    await h.advanceTo(TUESDAY_0 + H);
    expect(h.fake.handoverLog.filter((c) => c.stepId === "s2")).toEqual([]);
    held = true;
    await h.advanceTo(TUESDAY_0 + 2 * H);
    expect(h.fake.handoverLog.filter((c) => c.stepId === "s2")).toHaveLength(1);
  });
});
