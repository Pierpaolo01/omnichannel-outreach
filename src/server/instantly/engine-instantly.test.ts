import { describe, expect, test } from "vitest";
import { Crash, EngineHarness, type Provider } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import { FakeInstantly } from "../../../test/support/fake-instantly.ts";
import type { CampaignDefinition } from "../../domain/sequence/definition.ts";
import type { EmailProviderStatus, EnrollmentView, NeedsAttention } from "../../shared/api.ts";
import type { InstantlyAccount } from "./api.ts";
import { InstantlyClient } from "./client.ts";
import { InstantlyEmailPort } from "./port.ts";

/**
 * The sequence engine driving the Instantly adapter against the fake Instantly service, through the
 * real HTTP app and SQLite store. The fake's shapes are the documented ones; this shows the adapter
 * and the engine agree, not that Instantly behaves this way (ADR 0002 X1 to X9). Fictitious data.
 */

const H = 3_600_000;
const DAY = 24 * H;
/** Monday 16 November 2026, 09:00 London. */
const MONDAY_9 = Date.parse("2026-11-16T09:00:00Z");
const INBOXES: InstantlyAccount[] = [{ email: "ada@sender.example", status: 1, daily_limit: 30 }];

const rows = {
  businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })],
  people: [
    person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example" }),
    person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", email: "nia@harbour.example" }),
  ],
};

const twoEmails = (): CampaignDefinition => ({
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["ada@sender.example"],
  tracks: [
    {
      id: "t1",
      channel: "email",
      branch: "main",
      window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })),
      steps: [
        { id: "s1", waitDays: 0, subject: "Hello {{first_name|there}}", body: "A note for {{company}}.", threading: "new_subject", removed: false },
        { id: "s2", waitDays: 2, subject: "", body: "Following up, {{first_name|there}}.", threading: "continue_thread", removed: false },
      ],
      start: { kind: "entry" },
      removed: false,
    },
  ],
});

/**
 * The harness jumps the clock between the instants something happens, with no poll in between, so
 * the freshness bound is set long here; the stale-inbox test sets the real ten minutes.
 */
function setUp(writes: boolean, freshnessMs = 30 * DAY) {
  const built: { fake?: FakeInstantly; port?: InstantlyEmailPort } = {};
  const h = new EngineHarness({
    start: MONDAY_9 - H,
    accounts: [],
    port: (store, now) => {
      const fake = new FakeInstantly({ now, accounts: INBOXES });
      const client = new InstantlyClient({ apiKey: "test-key-not-real", fetch: fake.fetch, writes, now, timeoutMs: 10_000 });
      const port = new InstantlyEmailPort({ client, store: store.instantly, now, config: { resetZone: "UTC", pollIntervalMs: 0, freshnessMs } });
      Object.assign(built, { fake, port });
      return Object.assign(port, { advance: () => fake.advance(), nextActivityAt: () => fake.nextActivityAt() }) satisfies Provider;
    },
  });
  const { fake, port } = built;
  if (!fake || !port) throw new Error("the harness did not build the provider");
  return { h, fake, port };
}

async function enrolled(h: EngineHarness) {
  const { campaign } = await h.createCampaign("Autumn physio", rows);
  const people = (await h.request<{ rows: { id: string; name: string; enrollments: EnrollmentView[] }[] }>("GET", "/api/leads")).body.rows;
  const lead = (name: string) => people.find((p) => p.name === name)?.enrollments[0]?.id ?? "";
  return { campaign, lead };
}

describe("the engine through the Instantly adapter", () => {
  test("with no provider configured, the status endpoint says so", async () => {
    const h = new EngineHarness({ start: MONDAY_9, accounts: [] });
    expect((await h.request<EmailProviderStatus>("GET", "/api/email-provider")).body).toEqual({ provider: "none", sending: "off", followUps: "unavailable", quota: "available", lastPolledAt: null, inboxes: [], waitingFollowUps: [] });
  });

  test("with writes on: the inbox is read from Instantly, launch is allowed, the opener goes out once, a reply stops the lead, and the continue-thread follow-up waits unsent", async () => {
    const { h, fake } = setUp(true);
    const { campaign, lead } = await enrolled(h);
    await h.tick();
    await h.tick();
    const view = await h.defineSequence(campaign.id, twoEmails());
    expect(view.launch).toEqual({ blockers: [], nothingToLaunch: false, canLaunch: true });
    expect(view.accounts.map((a) => [a.id, a.healthy, a.capacity])).toEqual([["ada@sender.example", true, 30]]);

    h.clock = MONDAY_9;
    // The inboxes are fresh only after a poll at this instant.
    await h.tick();
    expect((await h.launch(campaign.id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 2 * H);
    // One dispatch campaign, two leads, two sends: the openers.
    expect(fake.campaigns.map((c) => c.name)).toEqual(["oo·" + campaign.id + "·t1·s1·ada@sender.example"]);
    expect(fake.deliveries().map((d) => [d.to, d.inbox, d.subject, d.body]).sort()).toEqual([
      ["nia@harbour.example", "ada@sender.example", "Hello Nia", "A note for Harbour Lane Physio."],
      ["pat@harbour.example", "ada@sender.example", "Hello Pat", "A note for Harbour Lane Physio."],
    ]);
    expect((await h.progress(lead("Pat Oneil"))).tracks[0]?.steps[0]?.result).toBe("sent");

    fake.reply("nia@harbour.example");
    await h.advanceTo(MONDAY_9 + 7 * DAY);
    expect((await h.progress(lead("Nia Cole"))).status).toBe("replied");
    const pat = await h.progress(lead("Pat Oneil"));
    // The follow-up is due, but there is no transport until X2: it is not claimed and nothing is sent.
    expect(pat.status).toBe("active");
    expect(pat.tracks[0]?.nextStep?.stepId).toBe("s2");
    expect(pat.tracks[0]?.steps[1]?.sends).toEqual([]);
    expect(fake.deliveries()).toHaveLength(2);
    expect(fake.writes().filter((w) => w.path === "/api/v2/leads/add")).toHaveLength(2);

    // The wait is not silent: the provider status names the lead and the step it waits on.
    const status = (await h.request<EmailProviderStatus>("GET", "/api/email-provider")).body;
    expect(status).toEqual({
      provider: "instantly",
      sending: "on",
      followUps: "unavailable",
      quota: "available",
      // The start of the last mail scan that read to the end.
      lastPolledAt: expect.any(String),
      inboxes: [{ id: "ada@sender.example", status: 1, dailyLimit: 30, capacity: 30, healthy: true, reason: null }],
      waitingFollowUps: [{ enrollmentId: lead("Pat Oneil"), trackId: "t1", stepId: "s2" }],
    });
  });

  test("with writes off: the inbox is listed but cannot send, launch stays blocked, and nothing is written to Instantly", async () => {
    const { h, fake, port } = setUp(false);
    const { campaign } = await enrolled(h);
    await h.tick();
    await h.tick();
    const view = await h.defineSequence(campaign.id, twoEmails());
    expect(view.accounts.map((a) => [a.id, a.healthy])).toEqual([["ada@sender.example", false]]);
    expect(view.launch.blockers.map((b) => b.kind)).toEqual(["no_sender"]);
    expect(port.status().inboxes.map((i) => i.reason)).toEqual(["sending_off"]);
    const attention = (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body;
    expect(attention.unhealthyInboxes).toEqual([{ accountId: "ada@sender.example" }]);
    h.clock = MONDAY_9;
    expect((await h.launch(campaign.id)).status).toBe(409);
    await h.advanceTo(MONDAY_9 + 3 * DAY);
    expect(fake.writes()).toEqual([]);
    expect((await h.request<EmailProviderStatus>("GET", "/api/email-provider")).body).toMatchObject({ provider: "instantly", sending: "off", inboxes: [{ id: "ada@sender.example", healthy: false, reason: "sending_off" }] });
  });

  test("a stale inbox holds sends until a poll succeeds again", async () => {
    const { h, fake } = setUp(true, 10 * 60_000);
    const { campaign, lead } = await enrolled(h);
    await h.tick();
    await h.tick();
    await h.defineSequence(campaign.id, twoEmails());
    fake.failWith = 500;
    h.clock = MONDAY_9 + 20 * 60_000;
    await h.tick();
    expect((await h.request<NeedsAttention>("GET", "/api/needs-attention")).body.unhealthyInboxes).toEqual([{ accountId: "ada@sender.example" }]);
    // Launch is refused while no inbox can send.
    expect((await h.launch(campaign.id)).status).toBe(409);
    fake.failWith = null;
    await h.tick();
    await h.tick();
    expect((await h.launch(campaign.id)).status).toBe(200);
    // The first opener goes out a minute after its handover; the next waits for the pacing gap.
    await h.advanceTo(h.clock + 5 * 60_000);
    expect(fake.deliveries()).toHaveLength(1);
    const results = [(await h.progress(lead("Pat Oneil"))).tracks[0]?.steps[0]?.result, (await h.progress(lead("Nia Cole"))).tracks[0]?.steps[0]?.result];
    expect(results.filter((r) => r === "sent")).toHaveLength(1);
  });

  test("review bot finding 1: a crash partway through a status-only batch loses none of it; both unsubscribes stop their leads after the restart", async () => {
    const { h, fake } = setUp(true);
    const { campaign, lead } = await enrolled(h);
    await h.tick();
    await h.tick();
    await h.defineSequence(campaign.id, twoEmails());
    h.clock = MONDAY_9;
    await h.tick();
    await h.launch(campaign.id);
    await h.advanceTo(MONDAY_9 + 2 * H);
    expect(fake.deliveries()).toHaveLength(2);
    fake.setLeadStatus("pat@harbour.example", -2);
    fake.setLeadStatus("nia@harbour.example", -2);
    let crashed = false;
    h.hooks = {
      crashPoint: (point) => {
        if (point === "after_observe_event" && !crashed) {
          crashed = true;
          throw new Crash(point);
        }
      },
    };
    h.clock += 60_000;
    await h.tick();
    expect(h.crashes).toHaveLength(1);
    h.hooks = {};
    await h.advanceTo(h.clock + H);
    expect((await h.progress(lead("Pat Oneil"))).status).toBe("replied");
    expect((await h.progress(lead("Nia Cole"))).status).toBe("replied");
  });

  test("review bot finding 2: the same person in two campaigns replies to campaign B before B's sent record is visible; only B stops", async () => {
    const { h, fake } = setUp(true);
    const onlyPat = { businesses: rows.businesses, people: rows.people.filter((p) => p.person_id === "p1") };
    const a = (await h.createCampaign("Campaign A", onlyPat)).campaign;
    const b = (await h.createCampaign("Campaign B", onlyPat)).campaign;
    const people = (await h.request<{ rows: { id: string; name: string; enrollments: EnrollmentView[] }[] }>("GET", "/api/leads")).body.rows;
    const enrollmentIn = (campaignId: string) => people[0]?.enrollments.find((e) => e.campaign.id === campaignId)?.id ?? "";
    await h.tick();
    await h.tick();
    await h.defineSequence(a.id, twoEmails());
    await h.defineSequence(b.id, twoEmails());
    fake.visibleDelayMs = 5 * 60_000;
    h.clock = MONDAY_9;
    await h.tick();
    expect((await h.launch(a.id)).status).toBe(200);
    expect((await h.launch(b.id)).status).toBe(200);
    let replied = false;
    await h.advanceTo(MONDAY_9 + 2 * DAY, async () => {
      if (replied || fake.deliveries().length < 2) return;
      replied = true;
      // Pat answers the latest email, B's, without the lead's id on the message: only the thread names it.
      const latest = fake.deliveries().at(-1);
      h.clock += 60_000;
      fake.reply("pat@harbour.example", { withLead: false });
      expect(latest?.to).toBe("pat@harbour.example");
      // Polled while B's sent record is still invisible.
      h.clock += 60_000;
      await h.tick();
    });
    expect(replied).toBe(true);
    const latestCampaign = fake.campaigns.find((c) => c.id === fake.emails.filter((e) => e.ue_type === 1).at(-1)?.campaign_id)?.name ?? "";
    const [repliedCampaign, otherCampaign] = latestCampaign.includes(b.id) ? [b.id, a.id] : [a.id, b.id];
    expect((await h.progress(enrollmentIn(repliedCampaign))).status).toBe("replied");
    expect((await h.progress(enrollmentIn(otherCampaign))).status).toBe("active");
  });
});
