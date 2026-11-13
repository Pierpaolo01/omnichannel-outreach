import { describe, expect, test } from "vitest";
import { FakeInstantly } from "../../../test/support/fake-instantly.ts";
import type { HandoverRequest } from "../engine/ports.ts";
import { openSqliteStore } from "../persistence/sqlite-store.ts";
import type { DispatchCampaignSettings, InstantlyAccount } from "./api.ts";
import { InstantlyClient } from "./client.ts";
import { InstantlyEmailPort, type InstantlyPortConfig } from "./port.ts";

/**
 * The Instantly adapter at the engine's email port (ADR 0003 5.3), against the fake Instantly
 * service. Every shape the fake answers with is the documented one; a pass here shows the adapter
 * follows the documentation, not that Instantly behaves this way (ADR 0002 X1 to X9). Fictitious data.
 */

const MINUTE = 60_000;
const T0 = Date.parse("2026-11-16T10:00:00Z");
const INBOXES: InstantlyAccount[] = [
  { email: "ada@sender.example", status: 1, daily_limit: 30 },
  { email: "bo@sender.example", status: 1, daily_limit: 25 },
  { email: "cy@sender.example", status: 2, daily_limit: 30 },
];

async function setUp(options: { writes?: boolean; accounts?: InstantlyAccount[]; config?: Partial<InstantlyPortConfig> } = {}) {
  let clock = T0;
  const now = () => clock;
  const fake = new FakeInstantly({ now, accounts: options.accounts ?? INBOXES });
  const store = openSqliteStore(":memory:");
  const campaign = { id: "camp-1", name: "Autumn physio", defaultTimezone: "Europe/London", createdAt: new Date(T0).toISOString() };
  await store.createCampaign(campaign);
  const client = new InstantlyClient({ apiKey: "test-key-not-real", fetch: fake.fetch, writes: options.writes ?? true, now, timeoutMs: 50 });
  const port = new InstantlyEmailPort({ client, store: store.instantly, now, config: { resetZone: "UTC", pollIntervalMs: 0, ...options.config }, subjectCampaign: () => Promise.resolve({ kind: "enrollment", campaignId: campaign.id }) });
  return {
    fake,
    port,
    store,
    advance: (ms: number) => {
      clock += ms;
      fake.advance();
    },
  };
}

let n = 0;
const request = (fields: Partial<HandoverRequest> = {}): HandoverRequest => {
  n++;
  return {
    attemptId: `att-${n}`,
    idempotencyKey: `key-${n}`,
    sender: "ada@sender.example",
    destination: "pat@harbour.example",
    rendered: { subject: "Hello Pat", body: "A note for Harbour Lane Physio.\nSecond line & more <b>." },
    threadRef: null,
    threading: "new_subject",
    subjectId: "enr-1",
    trackId: "t1",
    stepId: "s1",
    ...fields,
  };
};

describe("sender inboxes", () => {
  test("are read from Instantly, healthy only while writes are on, the inbox is Active and its poll is fresh", async () => {
    const { port } = await setUp();
    // No poll yet: every inbox is stale, so nothing can be sent before replies are known.
    expect((await port.accounts()).map((a) => [a.id, a.healthy])).toEqual([
      ["ada@sender.example", false],
      ["bo@sender.example", false],
      ["cy@sender.example", false],
    ]);
    await port.observe(null);
    const accounts = await port.accounts();
    expect(accounts.map((a) => ({ id: a.id, healthy: a.healthy, capacity: a.capacity, k: a.k, resetZone: a.resetZone, quota: a.quotaAvailable }))).toEqual([
      { id: "ada@sender.example", healthy: true, capacity: 30, k: 1, resetZone: "UTC", quota: true },
      { id: "bo@sender.example", healthy: true, capacity: 25, k: 1, resetZone: "UTC", quota: true },
      // Paused in Instantly: held, and listed as unhealthy.
      { id: "cy@sender.example", healthy: false, capacity: 30, k: 1, resetZone: "UTC", quota: true },
    ]);
    expect(port.status().inboxes.find((i) => i.id === "cy@sender.example")?.reason).toBe("not_active");
  });

  test("with writes off, every inbox is listed but none can send, and nothing is written", async () => {
    const { port, fake } = await setUp({ writes: false });
    await port.observe(null);
    expect((await port.accounts()).every((a) => !a.healthy)).toBe(true);
    expect(port.status()).toMatchObject({ sending: "off", inboxes: [{ reason: "sending_off" }, { reason: "sending_off" }, { reason: "sending_off" }] });
    await expect(port.handover(request())).rejects.toThrow(/writes are off/);
    expect(fake.writes()).toEqual([]);
  });

  test("an inbox goes stale when its last successful poll is older than the freshness bound", async () => {
    const { port, fake, advance } = await setUp({ config: { freshnessMs: 10 * MINUTE } });
    await port.observe(null);
    expect((await port.accounts())[0]?.healthy).toBe(true);
    fake.failWith = 500;
    advance(11 * MINUTE);
    await expect(port.observe("x")).rejects.toThrow();
    expect((await port.accounts())[0]?.healthy).toBe(false);
    expect(port.status().inboxes[0]?.reason).toBe("stale");
  });

  test("other senders' campaign emails today reduce the capacity the app may use", async () => {
    const { port, fake } = await setUp();
    fake.otherSentToday.set("ada@sender.example", 12);
    await port.observe(null);
    expect((await port.accounts()).find((a) => a.id === "ada@sender.example")?.capacity).toBe(18);
  });
});

describe("openers through dispatch campaigns", () => {
  test("the first opener creates one dispatch campaign with ADR 0002's settings, activates it and adds the lead under the attempt's key", async () => {
    const { port, fake } = await setUp();
    await port.observe(null);
    const answer = await port.handover(request({ idempotencyKey: "key-a" }));
    expect(answer).toEqual({ kind: "accepted", providerRef: expect.stringMatching(/^il:/) });
    const name = "oo·camp-1·t1·s1·ada@sender.example";
    const campaign = fake.campaignNamed(name);
    expect(campaign?.status).toBe(1);
    const expected: DispatchCampaignSettings = {
      name,
      campaign_schedule: { schedules: [{ name: "oo always open", timing: { from: "00:00", to: "23:59" }, days: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true }, timezone: "Africa/Abidjan" }] },
      sequences: [{ steps: [{ type: "email", delay: 0, delay_unit: "minutes", variants: [{ subject: "{{oo_subject}}", body: "{{oo_body}}" }] }] }],
      email_list: ["ada@sender.example"],
      daily_limit: 30,
      daily_max_leads: 30,
      stop_on_reply: true,
      stop_on_auto_reply: true,
      stop_for_company: false,
      insert_unsubscribe_header: true,
      open_tracking: false,
      link_tracking: false,
      prioritize_new_leads: false,
      allow_risky_contacts: false,
      disable_bounce_protect: false,
      match_lead_esp: false,
      provider_routing_rules: [],
      limit_emails_per_company_override: { mode: "disabled" },
    };
    expect(campaign?.settings).toEqual(expected);
    const add = fake.requests.find((r) => r.path === "/api/v2/leads/add");
    expect(add?.body).toEqual({
      campaign_id: campaign?.id,
      idempotency_key: "key-a",
      leads: [{ email: "pat@harbour.example", custom_variables: { oo_subject: "Hello Pat", oo_body: "A note for Harbour Lane Physio.<br/>Second line &amp; more &lt;b&gt;." } }],
    });
    // A second opener on the same track, step and inbox reuses the campaign; another step gets its own.
    await port.handover(request({ destination: "nia@harbour.example" }));
    await port.handover(request({ destination: "sam@harbour.example", stepId: "s9" }));
    expect(fake.campaigns.map((c) => c.name)).toEqual([name, "oo·camp-1·t1·s9·ada@sender.example"]);
    expect(fake.requests.filter((r) => r.method === "POST" && r.path === "/api/v2/campaigns")).toHaveLength(2);
  });

  test("a create whose answer was lost is found again by its deterministic name, not created twice", async () => {
    const { port, fake, store } = await setUp();
    await port.observe(null);
    // The app recorded the intent; Instantly created the campaign; the app never learned its id.
    store.instantly.saveDispatchCampaign({ key: "enrollment|camp-1|t1|s1|ada@sender.example", name: "oo·camp-1·t1·s1·ada@sender.example", instantlyId: null, timestampUpdated: null });
    await fake.fetch("https://api.instantly.ai/api/v2/campaigns", { method: "POST", headers: { authorization: "Bearer test-key-not-real", "user-agent": "t" }, body: JSON.stringify({ name: "oo·camp-1·t1·s1·ada@sender.example", campaign_schedule: { schedules: [] } }) });
    await port.handover(request());
    expect(fake.campaigns).toHaveLength(1);
  });

  test("a direct edit in Instantly is overwritten at the next handover", async () => {
    const { port, fake, advance } = await setUp();
    await port.observe(null);
    await port.handover(request());
    const campaign = fake.campaigns[0]!;
    advance(MINUTE);
    fake.editDirectly(campaign.id, { stop_on_reply: false, email_list: ["bo@sender.example"] });
    await port.handover(request({ destination: "nia@harbour.example" }));
    expect(campaign.settings.stop_on_reply).toBe(true);
    expect(campaign.settings.email_list).toEqual(["ada@sender.example"]);
    const patches = fake.requests.filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(1);
    // Unchanged since the adapter last asserted it: no further patch.
    await port.handover(request({ destination: "sam@harbour.example" }));
    expect(fake.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
  });

  test("a retry after a lost answer reuses the key and the identical lead, and Instantly reports the lead it already created", async () => {
    const { port, fake } = await setUp();
    await port.observe(null);
    fake.loseAddResponses = true;
    const r = request();
    // The engine bounds the call; the adapter's own request timeout ends it here.
    expect(await port.handover(r)).toEqual({ kind: "unknown" });
    fake.loseAddResponses = false;
    const again = await port.handover(r);
    expect(again).toEqual({ kind: "accepted", providerRef: expect.stringMatching(/^il:/) });
    expect(fake.leads).toHaveLength(1);
    const adds = fake.requests.filter((x) => x.path === "/api/v2/leads/add");
    expect(adds[1]?.body).toEqual(adds[0]?.body);
  });

  test("every add result is reconciled: block list, invalid address, duplicate, plan, rate limit, server error", async () => {
    const { port, fake } = await setUp();
    await port.observe(null);
    fake.blocklist.add("blocked@harbour.example");
    expect(await port.handover(request({ destination: "blocked@harbour.example" }))).toEqual({ kind: "rejected", reason: "blocklisted" });
    expect(await port.handover(request({ destination: "not-an-address" }))).toEqual({ kind: "rejected", reason: "invalid_destination" });

    // Already in this dispatch campaign under another key: never assumed sent, never reported as this attempt's lead.
    await port.handover(request({ destination: "pat@harbour.example" }));
    expect(await port.handover(request({ destination: "pat@harbour.example" }))).toEqual({ kind: "unknown" });

    fake.failAddWith = 429;
    expect(await port.handover(request({ destination: "a1@harbour.example" }))).toEqual({ kind: "rejected", reason: "rate_limited" });
    fake.failAddWith = 500;
    expect(await port.handover(request({ destination: "a2@harbour.example" }))).toEqual({ kind: "unknown" });
    fake.failAddWith = 402;
    expect(await port.handover(request({ destination: "a3@harbour.example" }))).toEqual({ kind: "rejected", reason: "payment_required" });
    // A 402 holds every dispatch handover, workspace-wide.
    expect((await port.accounts()).every((a) => !a.quotaAvailable)).toBe(true);
  });

  test("an exhausted lead quota holds every inbox after the lead it created", async () => {
    const { port, fake, advance } = await setUp();
    await port.observe(null);
    fake.remainingInPlan = 1;
    expect((await port.handover(request())).kind).toBe("accepted");
    expect((await port.accounts()).map((a) => a.quotaAvailable)).toEqual([false, false, false]);
    expect(port.status().quota).toBe("exhausted");
    // While held, a handover is refused as Instantly's 402 would be, before any request, so the
    // engine's workspace quota wait starts; after the recheck period one handover probes again.
    const adds = () => fake.requests.filter((r) => r.path === "/api/v2/leads/add").length;
    const before = adds();
    expect(await port.handover(request({ destination: "nia@harbour.example" }))).toEqual({ kind: "rejected", reason: "payment_required" });
    expect(adds()).toBe(before);
    advance(61 * MINUTE);
    await port.observe("c0");
    expect((await port.accounts()).every((a) => a.quotaAvailable)).toBe(true);
    await port.handover(request({ destination: "nia@harbour.example" }));
    expect(adds()).toBe(before + 1);
  });
});

describe("follow-ups", () => {
  test("continue-thread follow-ups have no transport until experiment X2, and nothing is sent for one", async () => {
    const { port, fake } = await setUp();
    expect(port.transportFor({ threading: "continue_thread" })).toEqual({ retryable: false, notSentIsFinal: false, available: false });
    expect(port.transportFor({ threading: "new_subject" })).toEqual({ retryable: true, notSentIsFinal: false, available: true });
    await port.observe(null);
    await expect(port.handover(request({ threading: "continue_thread", threadRef: "il:x" }))).rejects.toThrow(/no follow-up transport/);
    expect(fake.requests.filter((r) => r.method !== "GET")).toEqual([]);
  });
});

describe("observation, lookup, withdrawal and the pre-send check", () => {
  async function sentOpener() {
    const ctx = await setUp();
    await ctx.port.observe(null);
    const r = request({ idempotencyKey: "key-sent" });
    const answer = await ctx.port.handover(r);
    if (answer.kind !== "accepted") throw new Error("not accepted");
    ctx.advance(2 * MINUTE);
    return { ...ctx, r, ref: answer.providerRef };
  }

  test("a sent campaign email becomes a sent event for its work, once", async () => {
    const { port, ref } = await sentOpener();
    const first = await port.observe("c0");
    expect(first.events).toEqual([{ id: expect.any(String), kind: "sent", key: "key-sent", providerRef: ref, sentAt: T0 + MINUTE }]);
    // The overlap reads it again; its event id is the same, so the engine applies it once.
    const again = await port.observe(first.checkpoint);
    expect(again.events.filter((e) => e.kind === "sent").map((e) => e.id)).toEqual(first.events.map((e) => e.id));
  });

  test("a reply in the lead's thread names that work; a reply outside it names no known thread; mail from an address the app never wrote to is not reported", async () => {
    const { port, fake, ref, advance } = await sentOpener();
    const c1 = await port.observe("c0");
    fake.reply("Pat Oneil <PAT@harbour.example>");
    advance(MINUTE);
    fake.reply("pat@harbour.example", { onThread: false });
    fake.reply("someone@else.example", { inbox: "ada@sender.example" });
    advance(MINUTE);
    const replies = (await port.observe(c1.checkpoint)).events.filter((e) => e.kind === "reply");
    expect(replies).toEqual([
      { id: expect.any(String), kind: "reply", providerRef: ref, at: T0 + 2 * MINUTE, inbox: "ada@sender.example", from: "pat@harbour.example" },
      { id: expect.any(String), kind: "reply", providerRef: expect.stringMatching(/^it:/), at: T0 + 3 * MINUTE, inbox: "ada@sender.example", from: "pat@harbour.example" },
    ]);
  });

  test("lead statuses: a bounce fails the work, an unsubscribe stops it like a reply, a skip is explained or held", async () => {
    const { port, fake, advance } = await setUp();
    await port.observe(null);
    fake.bouncing.add("sam@harbour.example");
    fake.skipping.set("risky@harbour.example", -2);
    fake.skipping.set("odd@harbour.example", null);
    fake.skipping.set("invalid@harbour.example", -1);
    const sam = await port.handover(request({ destination: "sam@harbour.example", idempotencyKey: "k-sam" }));
    const pat = await port.handover(request({ destination: "pat@harbour.example", idempotencyKey: "k-pat" }));
    await port.handover(request({ destination: "risky@harbour.example", idempotencyKey: "k-risky" }));
    await port.handover(request({ destination: "odd@harbour.example", idempotencyKey: "k-odd" }));
    await port.handover(request({ destination: "invalid@harbour.example", idempotencyKey: "k-invalid" }));
    advance(2 * MINUTE);
    fake.setLeadStatus("pat@harbour.example", -2);
    const events = (await port.observe("c0")).events;
    const ref = (a: typeof sam) => (a.kind === "accepted" ? a.providerRef : "");
    expect(events.filter((e) => e.kind === "bounced")).toEqual([{ id: expect.any(String), kind: "bounced", key: "k-sam", providerRef: ref(sam), at: T0 + 2 * MINUTE }]);
    expect(events.filter((e) => e.kind === "reply")).toEqual([{ id: expect.any(String), kind: "reply", providerRef: ref(pat), at: T0 + 2 * MINUTE, inbox: "ada@sender.example", from: "pat@harbour.example" }]);
    expect(events.filter((e) => e.kind === "rejected").map((e) => [e.key, e.reason])).toEqual([
      ["k-risky", "provider_skipped"],
      ["k-odd", "provider_skipped"],
      ["k-invalid", "invalid_destination"],
    ]);
  });

  test("lookup answers from Instantly's records: sent with its time, queued while the lead waits, not sent without a record, so a same-key retry can find it", async () => {
    const { port, ref } = await sentOpener();
    expect(await port.lookup({ idempotencyKey: "key-sent", providerRef: ref, sender: "ada@sender.example", destination: "pat@harbour.example" })).toEqual({ kind: "sent", sentAt: T0 + MINUTE, providerRef: ref });
    const waiting = await port.handover(request({ destination: "nia@harbour.example", idempotencyKey: "key-wait" }));
    expect(await port.lookup({ idempotencyKey: "key-wait", providerRef: waiting.kind === "accepted" ? waiting.providerRef : null, sender: "ada@sender.example", destination: "nia@harbour.example" })).toEqual({ kind: "queued" });
    expect(await port.lookup({ idempotencyKey: "key-none", providerRef: null, sender: "ada@sender.example", destination: "x@harbour.example" })).toEqual({ kind: "not-sent" });
  });

  test("withdrawal deletes a lead not yet sent but never claims it worked; a sent one is too late", async () => {
    const { port, fake, ref } = await sentOpener();
    expect(await port.withdraw({ idempotencyKey: "key-sent", providerRef: ref, sender: "ada@sender.example", destination: "pat@harbour.example" })).toBe("too-late");
    const waiting = await port.handover(request({ destination: "nia@harbour.example", idempotencyKey: "key-wait" }));
    const before = fake.leads.filter((l) => !l.deleted).length;
    expect(await port.withdraw({ idempotencyKey: "key-wait", providerRef: waiting.kind === "accepted" ? waiting.providerRef : null, sender: "ada@sender.example", destination: "nia@harbour.example" })).toBe("unknown");
    expect(fake.leads.filter((l) => !l.deleted).length).toBe(before - 1);
  });

  test("the pre-send check finds a reply in a recorded thread, is clear otherwise, and is unavailable when the /emails budget is spent", async () => {
    const { port, fake, ref } = await sentOpener();
    await port.observe("c0");
    expect(await port.presendCheck({ sender: "ada@sender.example", destination: "pat@harbour.example", threadRefs: [ref] })).toEqual({ kind: "clear" });
    const reply = fake.reply("pat@harbour.example");
    expect(await port.presendCheck({ sender: "ada@sender.example", destination: "pat@harbour.example", threadRefs: [ref] })).toEqual({ kind: "reply", providerRef: reply.id, at: T0 + 2 * MINUTE });
    for (let i = 0; i < 25; i++) await port.presendCheck({ sender: "ada@sender.example", destination: "pat@harbour.example", threadRefs: [ref] });
    expect(await port.presendCheck({ sender: "ada@sender.example", destination: "pat@harbour.example", threadRefs: [ref] })).toEqual({ kind: "unavailable" });
  });
});
