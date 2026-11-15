import { describe, expect, test } from "vitest";
import { EngineHarness, type Provider } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import { FakeInstantly } from "../../../test/support/fake-instantly.ts";
import type { CampaignDefinition } from "../../domain/sequence/definition.ts";
import type { EmailProviderStatus, EnrollmentView, NeedsAttention } from "../../shared/api.ts";
import type { InstantlyAccount } from "./api.ts";
import { InstantlyClient } from "./client.ts";
import { InstantlyEmailPort } from "./port.ts";

/**
 * An inbox with no room today (verifier on the integration branch, 15 November 2026): the adapter reports its
 * capacity as 0, and the engine stores that as "no room now" (ADR 0003 4.1 as amended). The engine, the real
 * adapter and the SQLite store, against the in-process fake Instantly service. Fictitious data.
 */

const H = 3_600_000;
const DAY = 24 * H;
/** Monday 16 November 2026, 09:00 London (UTC in November). */
const MONDAY_9 = Date.parse("2026-11-16T09:00:00Z");
const TUESDAY = Date.parse("2026-11-17T00:00:00Z");
const ADA = "ada@sender.example";
const BEA = "bea@sender.example";

const opener = (pool: string): CampaignDefinition => ({
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: [pool],
  tracks: [
    {
      id: "t1",
      channel: "email",
      branch: "main",
      window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })),
      steps: [{ id: "s1", waitDays: 0, subject: "Hello {{first_name|there}}", body: "A note for {{company}}.", threading: "new_subject", removed: false }],
      start: { kind: "entry" },
      removed: false,
    },
  ],
});

function setUp(inboxes: InstantlyAccount[]) {
  const built: { fake?: FakeInstantly } = {};
  const h = new EngineHarness({
    start: MONDAY_9 - H,
    accounts: [],
    port: (store, now) => {
      const fake = new FakeInstantly({ now, accounts: inboxes });
      // Writes on against the fake only: the client is given the fake's fetch.
      const client = new InstantlyClient({ apiKey: "test-key-not-real", fetch: fake.fetch, writes: true, now, timeoutMs: 10_000 });
      const port = new InstantlyEmailPort({ client, store: store.instantly, now, config: { resetZone: "UTC", pollIntervalMs: 0, freshnessMs: 30 * DAY } });
      built.fake = fake;
      return Object.assign(port, { advance: () => fake.advance(), nextActivityAt: () => fake.nextActivityAt() }) satisfies Provider;
    },
  });
  if (!built.fake) throw new Error("the harness did not build the provider");
  return { h, fake: built.fake };
}

/** One campaign per inbox: its people may send only from that inbox. */
async function campaignOn(h: EngineHarness, name: string, pool: string, people: readonly [string, string][]) {
  // Each business has a main line of its own; with a shared one the second import enrolled no one.
  const phone = pool === ADA ? "+442079460101" : "+442079460202";
  const key = name.toLowerCase().replace(/\W+/g, "-");
  const { campaign } = await h.createCampaign(name, {
    businesses: [business({ business_id: `${key}-b`, business_name: `${name} Clinic`, phone_e164: phone })],
    people: people.map(([full_name, email], i) => person({ person_id: `${key}-p${i}`, business_id: `${key}-b`, full_name, email })),
  });
  await h.defineSequence(campaign.id, opener(pool));
  return campaign;
}

async function leadsByName(h: EngineHarness): Promise<Map<string, string>> {
  const rows = (await h.request<{ rows: { name: string; enrollments: EnrollmentView[] }[] }>("GET", "/api/leads")).body.rows;
  return new Map(rows.map((r) => [r.name, r.enrollments[0]?.id ?? ""]));
}

const attention = async (h: EngineHarness) => (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body;
const inboxView = async (h: EngineHarness, id: string) => (await h.request<EmailProviderStatus>("GET", "/api/email-provider")).body.inboxes.find((i) => i.id === id);

describe("an inbox with no room today", () => {
  test("used up outside the app: the tick completes, the inbox's lead waits for capacity in Needs attention, the other inbox sends, and the next reset day the lead's email goes", async () => {
    const { h, fake } = setUp([
      { email: ADA, status: 1, daily_limit: 1 },
      { email: BEA, status: 1, daily_limit: 30 },
    ]);
    // Instantly's analytics report one send from Ada's inbox today that the app did not make.
    fake.otherSentToday.set(ADA, 1);
    const onAda = await campaignOn(h, "Harbour", ADA, [["Pat Oneil", "pat@harbour.example"]]);
    const onBea = await campaignOn(h, "Northgate", BEA, [["Nia Cole", "nia@northgate.example"]]);
    h.clock = MONDAY_9;
    await h.tick();
    expect((await h.launch(onAda.id)).status).toBe(200);
    expect((await h.launch(onBea.id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 2 * H);

    // Every tick completed (a tick that threw would have thrown out of the harness) and sending is not interrupted.
    const read = await attention(h);
    expect(read.sendingInterrupted).toBeNull();
    expect(await inboxView(h, ADA)).toMatchObject({ dailyLimit: 1, capacity: 0, healthy: true, reason: null });
    // Bea's inbox kept working; Ada's sent nothing today.
    expect(fake.deliveries().map((d) => [d.to, d.inbox])).toEqual([["nia@northgate.example", BEA]]);
    const leads = await leadsByName(h);
    expect(read.waitingForCapacity.map((w) => [w.enrollmentId, w.accountIds, w.resetsAt])).toEqual([[leads.get("Pat Oneil"), [ADA], new Date(TUESDAY).toISOString()]]);
    expect(read.senderProblems).toEqual([]);

    // The next reset day the outside sends no longer count, and Pat's email goes from Ada's inbox in its window.
    fake.otherSentToday.clear();
    await h.advanceTo(TUESDAY + 11 * H);
    expect(fake.deliveries().map((d) => [d.to, d.inbox]).sort()).toEqual([
      ["nia@northgate.example", BEA],
      ["pat@harbour.example", ADA],
    ]);
    expect((await h.progress(leads.get("Pat Oneil") ?? "")).tracks[0]?.steps[0]?.result).toBe("sent");
    expect((await attention(h)).waitingForCapacity).toEqual([]);
  });

  test.each([
    ["a daily limit of 0", 0],
    ["no daily limit", null],
  ])("configured with %s: the tick completes, Needs attention names the inbox's problem, and the other inbox sends", async (_, limit) => {
    const { h, fake } = setUp([
      { email: ADA, status: 1, daily_limit: limit },
      { email: BEA, status: 1, daily_limit: 30 },
    ]);
    await campaignOn(h, "Harbour", ADA, [["Pat Oneil", "pat@harbour.example"]]);
    const onBea = await campaignOn(h, "Northgate", BEA, [["Nia Cole", "nia@northgate.example"]]);
    h.clock = MONDAY_9;
    await h.tick();
    expect((await h.launch(onBea.id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 2 * H);

    expect(await inboxView(h, ADA)).toMatchObject({ capacity: 0, healthy: false, reason: "no_daily_limit" });
    const read = await attention(h);
    expect(read.sendingInterrupted).toBeNull();
    expect(read.senderProblems.map((p) => [p.accountId, p.problem])).toEqual([[ADA, "no_daily_limit"]]);
    expect(fake.deliveries().map((d) => [d.to, d.inbox])).toEqual([["nia@northgate.example", BEA]]);
  });

  test("used up by the app's own sends: the second lead waits for capacity until the next reset day", async () => {
    const { h, fake } = setUp([{ email: ADA, status: 1, daily_limit: 1 }]);
    const onAda = await campaignOn(h, "Harbour", ADA, [
      ["Pat Oneil", "pat@harbour.example"],
      ["Sam Lee", "sam@harbour.example"],
    ]);
    h.clock = MONDAY_9;
    await h.tick();
    expect((await h.launch(onAda.id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 2 * H);

    expect(fake.deliveries()).toHaveLength(1);
    // The app's own send is in analytics too, so nothing counts as sent outside the app.
    expect(await inboxView(h, ADA)).toMatchObject({ capacity: 1, healthy: true });
    const read = await attention(h);
    expect(read.sendingInterrupted).toBeNull();
    expect(read.waitingForCapacity.map((w) => [w.accountIds, w.resetsAt])).toEqual([[[ADA], new Date(TUESDAY).toISOString()]]);

    await h.advanceTo(TUESDAY + 11 * H);
    expect(fake.deliveries().map((d) => d.to).sort()).toEqual(["pat@harbour.example", "sam@harbour.example"]);
    expect((await attention(h)).waitingForCapacity).toEqual([]);
  });
});
