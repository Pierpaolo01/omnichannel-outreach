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
  const client = new InstantlyClient({ apiKey: "test-key-not-real", fetch: fake.fetch, writes: options.writes ?? true, now, timeoutMs: 10_000 });
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

async function sentOpener() {
  const ctx = await setUp();
  await ctx.port.observe(null);
  const r = request({ idempotencyKey: "key-sent" });
  const answer = await ctx.port.handover(r);
  if (answer.kind !== "accepted") throw new Error("not accepted");
  ctx.advance(2 * MINUTE);
  return { ...ctx, r, ref: answer.providerRef };
}

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
    // Instantly created the lead, but its answer never reached the app.
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

  test("a sent campaign email becomes a sent event for its work, once", async () => {
    const { port, ref } = await sentOpener();
    const first = await port.observe("c0");
    expect(first.events).toEqual([{ id: expect.any(String), kind: "sent", key: "key-sent", providerRef: ref, sentAt: T0 + MINUTE }]);
    // The overlap reads it again; its event id is the same, so the engine applies it once.
    const again = await port.observe(first.checkpoint);
    expect(again.events.filter((e) => e.kind === "sent").map((e) => e.id)).toEqual(first.events.map((e) => e.id));
  });

  test("a reply in the lead's thread names that work; one outside every known thread is held, then reported with no thread; mail from an address the app never wrote to is not reported", async () => {
    const { port, fake, ref, advance } = await sentOpener();
    const c1 = await port.observe("c0");
    fake.reply("Pat Oneil <PAT@harbour.example>");
    advance(MINUTE);
    // A new conversation without the lead's id: nothing proves which work it answers.
    fake.reply("pat@harbour.example", { onThread: false, withLead: false });
    fake.reply("someone@else.example", { inbox: "ada@sender.example" });
    advance(MINUTE);
    const c2 = await port.observe(c1.checkpoint);
    expect(c2.events.filter((e) => e.kind === "reply")).toEqual([{ id: expect.any(String), kind: "reply", providerRef: ref, at: T0 + 2 * MINUTE, inbox: "ada@sender.example", from: "pat@harbour.example" }]);
    // The off-thread reply is held by the adapter, pausing sends to that address from that inbox,
    // and after the settling period it is reported with no thread, for the engine's fallback.
    expect(await port.presendCheck({ sender: "ada@sender.example", destination: "pat@harbour.example", threadRefs: [] })).toEqual({ kind: "unavailable" });
    advance(16 * MINUTE);
    const released = (await port.observe(c2.checkpoint)).events.filter((e) => e.kind === "reply" && e.providerRef !== ref);
    expect(released).toEqual([{ id: expect.any(String), kind: "reply", providerRef: null, at: T0 + 3 * MINUTE, inbox: "ada@sender.example", from: "pat@harbour.example" }]);
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

/**
 * Review bot findings on `7de601e`, two kinds. Signal identity: an event names a piece of work only
 * when the message's own identity (its thread or its lead, with the sender and the inbox) proves it,
 * and the reference is one the engine already holds. Completeness: a poll counts as current only
 * when every read it depends on reached its end, and nothing the adapter reported is forgotten
 * before the engine has stored the checkpoint it came with.
 */
describe("signal identity", () => {
  test("a delivery notice in the lead's thread is not the lead's reply (finding 3)", async () => {
    const { port, fake, advance } = await sentOpener();
    const c1 = await port.observe("c0");
    fake.reply("mailer-daemon@googlemail.example", { inThreadOf: "pat@harbour.example" });
    // The lead's own address, in the lead's thread, but received by another inbox.
    fake.reply("pat@harbour.example", { inbox: "bo@sender.example" });
    advance(MINUTE);
    const c2 = await port.observe(c1.checkpoint);
    advance(16 * MINUTE);
    const later = await port.observe(c2.checkpoint);
    expect([...c2.events, ...later.events].filter((e) => e.kind === "reply")).toEqual([]);
  });

  test("a reply seen before its sent record attaches to its own work, never by a reference the engine cannot hold (finding 2)", async () => {
    const { port, fake, advance } = await setUp();
    await port.observe(null);
    fake.visibleDelayMs = 5 * MINUTE;
    const answer = await port.handover(request({ idempotencyKey: "k-pat" }));
    const ref = answer.kind === "accepted" ? answer.providerRef : "";
    advance(2 * MINUTE);
    const c1 = await port.observe("c0");
    expect(c1.events).toEqual([]);
    // Without the lead's id on the message, only its thread can name the work, and that is not known yet.
    fake.reply("pat@harbour.example", { withLead: false });
    advance(MINUTE);
    const c2 = await port.observe(c1.checkpoint);
    expect(c2.events.filter((e) => e.kind === "reply")).toEqual([]);
    expect(await port.presendCheck({ sender: "ada@sender.example", destination: "pat@harbour.example", threadRefs: [ref] })).toEqual({ kind: "unavailable" });
    expect(await port.presendCheck({ sender: "ada@sender.example", destination: "nia@harbour.example", threadRefs: [] })).toEqual({ kind: "clear" });
    advance(5 * MINUTE);
    const c3 = await port.observe(c2.checkpoint);
    expect(c3.events.map((e) => [e.kind, e.providerRef])).toEqual([
      ["sent", ref],
      ["reply", ref],
    ]);
  });

  test("a reply carrying the lead's id attaches at once, before the sent record is visible (finding 2)", async () => {
    const { port, fake, advance } = await setUp();
    await port.observe(null);
    fake.visibleDelayMs = 5 * MINUTE;
    const answer = await port.handover(request({ idempotencyKey: "k-pat" }));
    advance(2 * MINUTE);
    fake.reply("pat@harbour.example");
    advance(MINUTE);
    const c1 = await port.observe("c0");
    expect(c1.events.filter((e) => e.kind === "reply").map((e) => e.providerRef)).toEqual([answer.kind === "accepted" ? answer.providerRef : ""]);
  });

  test("a message the user sends by hand in the lead's thread is not the opener's send (sibling)", async () => {
    const { port, fake, advance } = await sentOpener();
    const c1 = await port.observe("c0");
    expect(c1.events.filter((e) => e.kind === "sent")).toHaveLength(1);
    const manual = fake.manualSend("pat@harbour.example");
    advance(MINUTE);
    const c2 = await port.observe(c1.checkpoint);
    expect(c2.events.filter((e) => e.id.includes(manual.id))).toEqual([]);
  });
});

describe("completeness", () => {
  test("a status-only batch is reported again until the engine stores the checkpoint it came with (finding 1)", async () => {
    const { port, fake, advance } = await sentOpener();
    const c1 = (await port.observe("c0")).checkpoint;
    fake.setLeadStatus("pat@harbour.example", -2);
    advance(MINUTE);
    const batch = await port.observe(c1);
    expect(batch.events.filter((e) => e.kind === "reply")).toHaveLength(1);
    // The engine crashed before applying it, so its stored checkpoint is still c1.
    advance(MINUTE);
    const replay = await port.observe(c1);
    expect(replay.events.filter((e) => e.kind === "reply")).toHaveLength(1);
    // Applied and stored: not reported again.
    advance(MINUTE);
    const after = await port.observe(replay.checkpoint);
    expect(after.events.filter((e) => e.kind === "reply")).toEqual([]);
  });

  test("lead statuses past the first 2,000 leads are read, and the inbox is not fresh until the whole campaign has been read (finding 4)", async () => {
    const { port, fake, store, advance } = await sentOpener();
    let checkpoint = (await port.observe("c0")).checkpoint;
    const campaign = store.instantly.dispatchCampaigns()[0]!;
    const seeded = fake.seedLeads(campaign.instantlyId ?? "", 2_100);
    const deep = seeded[2_050]!;
    store.instantly.saveDispatched({ workKey: "k-deep", ref: `il:${deep.id}`, leadId: deep.id, dispatchCampaign: campaign.key, instantlyCampaignId: campaign.instantlyId ?? "", inbox: "ada@sender.example", destination: deep.email, addedWall: T0, sentEmailId: "email-seeded", threadId: "thread-seeded", sentWall: T0, leadStatus: 3, verificationStatus: 0 });
    fake.setLeadStatusById(deep.id, -2);
    advance(11 * MINUTE);
    const first = await port.observe(checkpoint);
    checkpoint = first.checkpoint;
    // Twenty pages read, more remain: the inbox's statuses are not known to be current.
    expect(port.status().inboxes.find((i) => i.id === "ada@sender.example")?.reason).toBe("stale");
    const events = [...first.events];
    for (let i = 0; i < 2; i++) {
      advance(MINUTE);
      const next = await port.observe(checkpoint);
      checkpoint = next.checkpoint;
      events.push(...next.events);
    }
    expect(events.filter((e) => e.kind === "reply" && e.providerRef === `il:${deep.id}`)).toHaveLength(1);
    expect(port.status().inboxes.find((i) => i.id === "ada@sender.example")?.reason).toBeNull();
  });

  test("a poll that could not read every new email does not count as fresh, and the next one carries on (sibling)", async () => {
    const { port, fake, advance } = await sentOpener();
    let checkpoint = (await port.observe("c0")).checkpoint;
    for (let i = 0; i < 2_100; i++) fake.reply(`stranger-${String(i)}@else.example`, { inbox: "ada@sender.example" });
    advance(11 * MINUTE);
    checkpoint = (await port.observe(checkpoint)).checkpoint;
    expect(port.status().inboxes.find((i) => i.id === "ada@sender.example")?.reason).toBe("stale");
    advance(MINUTE);
    await port.observe(checkpoint);
    expect(port.status().inboxes.find((i) => i.id === "ada@sender.example")?.reason).toBeNull();
  });

  test("a dispatch campaign found by name past the first page of search results is not created again (sibling)", async () => {
    const { port, fake, store } = await setUp();
    await port.observe(null);
    const name = "oo·camp-1·t1·s1·ada@sender.example";
    for (let i = 0; i < 100; i++) fake.seedCampaign(`${name} (old ${String(i)})`);
    store.instantly.saveDispatchCampaign({ key: "enrollment|camp-1|t1|s1|ada@sender.example", name, instantlyId: null, timestampUpdated: null });
    fake.seedCampaign(name);
    await port.handover(request());
    expect(fake.campaigns.filter((c) => c.name === name)).toHaveLength(1);
  });

  test("the pre-send check reads every page of the lead's mail, so an older reply is not missed (sibling)", async () => {
    const { port, fake, ref, advance } = await sentOpener();
    await port.observe("c0");
    fake.reply("pat@harbour.example");
    advance(MINUTE);
    for (let i = 0; i < 120; i++) fake.manualSend("pat@harbour.example");
    expect((await port.presendCheck({ sender: "ada@sender.example", destination: "pat@harbour.example", threadRefs: [ref] })).kind).toBe("reply");
  });
});
