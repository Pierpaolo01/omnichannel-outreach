import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../test/support/engine-harness.ts";
import { business, person } from "../../test/support/export-builder.ts";
import type { FakeAccount } from "../../test/support/fake-email-port.ts";
import type { CampaignDefinition, StepDefinition } from "../domain/sequence/definition.ts";
import type { WindowRule } from "../domain/sequence/clock.ts";
import type { BeforeLaunchView } from "../shared/api.ts";
import { localDayNumber, resetDayOf } from "../domain/sequence/clock.ts";
import { projectedSends } from "./before-launch.ts";
import type { ProjectedSend } from "./load-projection.ts";

/** The fields the email-only comparisons check. */
const core = ({ leadId, accountId, step, at }: ProjectedSend) => ({ leadId, accountId, step, at });

/**
 * The Before launch projection against the engine's actual sends (PR 41 verification, B5). Each
 * generated case is a small campaign launched near a window's end, a capacity reset or a zone
 * boundary. The projection taken just before launch must list exactly the sends the engine then
 * makes over the fake provider: the same lead, step, inbox and instant. The day-level comparison
 * (each lead's step on its local day, the count per inbox per reset day) is what the screen shows,
 * and is asserted first so a failure says which figure would be wrong. The fixed set runs 40 seeds;
 * PROJECTION_SEEDS raises it.
 */
const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const pick = <T,>(r: () => number, items: readonly T[]): T => items[Math.floor(r() * items.length)]!;

const ZONES = ["Europe/London", "America/New_York", "Asia/Tokyo", "Australia/Sydney", "Asia/Kolkata"] as const;
const WINDOWS: readonly (readonly WindowRule[])[] = [
  [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })),
  // Past midnight, every day.
  [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 22, end: 2 })),
  [1, 3, 5].map((day) => ({ day, start: 0, end: 24 })),
  [2, 4].map((day) => ({ day, start: 16, end: 18 })),
];
/** Instants near a window's end in London, UTC and Los Angeles midnights, and a Friday evening. */
const ANCHORS = [
  Date.parse("2026-11-09T16:55:00Z"),
  Date.parse("2026-11-10T23:58:00Z"),
  Date.parse("2026-11-11T07:58:00Z"),
  Date.parse("2026-11-13T16:57:00Z"),
  Date.parse("2026-11-12T01:56:00Z"),
  Date.parse("2026-11-09T23:59:00Z"),
];

interface Case {
  readonly start: number;
  readonly accounts: FakeAccount[];
  readonly zones: string[];
  readonly definition: CampaignDefinition;
  /** The leads have mobiles and the harness an SMS number, for a campaign with an SMS track. */
  readonly sms?: boolean;
}

function generate(seed: number): Case {
  const r = rng(seed);
  const accounts = Array.from({ length: 1 + Math.floor(r() * 2) }, (_, i): FakeAccount => ({
    id: `inbox-${i}`,
    capacity: 1 + Math.floor(r() * 4),
    gapMs: pick(r, [MIN, 7 * MIN, 50 * MIN]),
    k: 1,
    healthy: true,
    quotaAvailable: true,
    resetZone: pick(r, ["UTC", "America/Los_Angeles"]),
  }));
  const zones = Array.from({ length: 1 + Math.floor(r() * 6) }, () => pick(r, ZONES));
  const steps: StepDefinition[] = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => ({
    id: `s${i + 1}`,
    waitDays: i === 0 ? 0 : Math.floor(r() * 3),
    subject: i === 0 ? "Hello {{company}}" : "",
    body: "A note.",
    threading: i === 0 ? "new_subject" : "continue_thread",
    removed: false,
  }));
  return {
    start: pick(r, ANCHORS) + Math.floor(r() * 5) * MIN,
    accounts,
    zones,
    definition: {
      timezone: "Europe/London",
      callSkipLimitDays: 2,
      emailPool: accounts.map((a) => a.id),
      tracks: [{ id: "t1", channel: "email", branch: "main", window: pick(r, WINDOWS), steps, start: { kind: "entry" }, removed: false }],
    },
  };
}

const SMS_NUMBER = "+447700900001";
const smsNumbers = { numbers: [{ id: SMS_NUMBER, capacity: 500, gapMs: null, k: 1, healthy: true, resetZone: "Europe/London" }] };
/** A fictitious UK mobile for lead `i`. */
const mobileOf = (i: number) => `+4477009002${String(i).padStart(2, "0")}`;

/** The case with an SMS track that starts after its email track, `delayDays` after it finishes. */
const withSmsAfter = (c: Case, delayDays: number): Case => ({
  ...c,
  sms: true,
  definition: {
    ...c.definition,
    smsPool: [SMS_NUMBER],
    tracks: [...c.definition.tracks, { id: "t2", channel: "sms", branch: "main", window: c.definition.tracks[0]!.window, steps: [{ id: "m1", waitDays: 0, subject: "", body: "A short text.", threading: "new_subject", removed: false }], start: { kind: "after", trackId: "t1", delayDays }, removed: false }],
  },
});

async function compare(c: Case) {
  const h = new EngineHarness({ start: c.start, accounts: c.accounts, ...(c.sms ? { sms: smsNumbers } : {}) });
  const businesses = c.zones.map((zone, i) => business({ business_id: `b${i}`, business_name: `Clinic ${i}`, timezone: zone }));
  const people = c.zones.map((_, i) => person({ person_id: `p${i}`, business_id: `b${i}`, full_name: `Lead Person${i}`, email: `lead${i}@clinic${i}.example`, timezone: "", ...(c.sms ? { dial_phone: mobileOf(i), dial_phone_type: "mobile" } : {}) }));
  const { campaign } = await h.createCampaign("Projection check", { businesses, people });
  await h.tick();
  await h.defineSequence(campaign.id, c.definition);
  const projected = await projectedSends(h.store, campaign.id, h.clock);
  const view = (await h.request<BeforeLaunchView>("GET", `/api/campaigns/${campaign.id}/before-launch`)).body;
  expect((await h.launch(campaign.id)).status).toBe(200);
  const until = c.start + 12 * DAY;
  h.maxWrites = 5_000;
  await h.advanceTo(until);
  const steps = c.definition.tracks[0]!.steps.map((s) => s.id);
  const actual = h.fake.deliveryLog.map((d) => ({ leadId: d.subjectId, accountId: d.sender, step: steps.indexOf(d.stepId), at: d.at }));
  const zoneOf = new Map(h.fake.deliveryLog.map((d) => [d.subjectId, c.zones[Number(d.destination.match(/lead(\d+)@/)?.[1] ?? 0)] ?? "UTC"]));
  const resetOf = new Map(c.accounts.map((a) => [a.id, a.resetZone]));
  const daily = (sends: readonly { leadId: string; accountId: string; step: number; at: number }[]) => ({
    steps: sends.map((s) => `${s.leadId}/${s.step}/${localDayNumber(s.at, zoneOf.get(s.leadId) ?? "UTC")}`).sort(),
    perInboxDay: sends.map((s) => `${s.accountId}/${resetDayOf(s.at, resetOf.get(s.accountId) ?? "UTC")}`).sort(),
  });
  const kept = projected!.sends.filter((s) => s.at < until && s.channel === "email").map(core);
  return { projected: kept, actual, view, daily: { projected: daily(kept), actual: daily(actual) }, texts: c.sms ? h.sms.deliveryLog.length : 0 };
}

describe("the Before launch projection makes exactly the engine's sends (PR 41 verification, B5)", () => {
  test("the verifier's case: launch at 16:59 with five leads; one goes Monday, four on Tuesday from 09:00", async () => {
    const start = Date.parse("2026-11-09T16:59:00Z");
    const c: Case = {
      start,
      accounts: [{ id: "inbox-a", capacity: 30, gapMs: MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
      zones: Array.from({ length: 5 }, () => "Europe/London"),
      definition: generate(1).definition,
    };
    const definition: CampaignDefinition = {
      ...c.definition,
      emailPool: ["inbox-a"],
      tracks: [{ ...c.definition.tracks[0]!, window: WINDOWS[0]!, steps: [{ id: "s1", waitDays: 0, subject: "Hi", body: "Hi.", threading: "new_subject", removed: false }] }],
    };
    const { projected, actual, view } = await compare({ ...c, definition });
    expect(projected).toEqual(actual);
    expect(view.load).toMatchObject({ daysUntilAllStart: 2, accounts: [expect.objectContaining({ busiestDay: 4 })] });
  });

  const SEEDS = Number(process.env["PROJECTION_SEEDS"] ?? 40);
  for (const seed of Array.from({ length: SEEDS }, (_, i) => 1000 + i)) {
    test(`generated case ${seed}`, async () => {
      const c = generate(seed);
      const { projected, actual, daily } = await compare(c);
      expect(daily.projected).toEqual(daily.actual);
      const exact = (xs: typeof actual) => [...xs].sort((a, b) => a.at - b.at || (a.accountId < b.accountId ? -1 : 1));
      expect(exact(projected)).toEqual(exact(actual));
    });
  }
});

describe("with an SMS track after the email track, the email sends are exactly the engine's (merge of ticket 13a; texts are compared below)", () => {
  const SEEDS = Number(process.env["PROJECTION_SEEDS"] ?? 20);
  const texted: number[] = [];
  for (const seed of Array.from({ length: SEEDS }, (_, i) => 3000 + i)) {
    test(`generated case ${seed}`, async () => {
      const c = withSmsAfter(generate(seed), seed % 3);
      const { projected, actual, daily, view, texts } = await compare(c);
      texted.push(texts);
      expect(daily.projected).toEqual(daily.actual);
      const exact = (xs: typeof actual) => [...xs].sort((a, b) => a.at - b.at || (a.accountId < b.accountId ? -1 : 1));
      expect(exact(projected)).toEqual(exact(actual));
    });
  }
  test("the runs send texts alongside the emails, so the SMS track really runs", () => {
    expect(texted.filter((n) => n > 0).length).toBeGreaterThan(SEEDS / 2);
  });
});

describe("an inbox that cannot send now (PR 41 council, item 1)", () => {
  const inbox = (fields: Partial<FakeAccount> = {}): FakeAccount => ({ id: "inbox-a", capacity: 30, gapMs: MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC", ...fields });
  const oneEmail: CampaignDefinition = {
    timezone: "Europe/London",
    callSkipLimitDays: 2,
    emailPool: ["inbox-a"],
    tracks: [{ id: "t1", channel: "email", branch: "main", window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })), steps: [{ id: "s1", waitDays: 0, subject: "Hi", body: "Hi.", threading: "new_subject", removed: false }], start: { kind: "entry" }, removed: false }],
  };
  const MONDAY_10 = Date.parse("2026-11-09T10:00:00Z");
  const lead = (i: number) => ({ business: business({ business_id: `b${i}`, business_name: `Clinic ${i}` }), person: person({ person_id: `p${i}`, business_id: `b${i}`, full_name: `Lead Person${i}`, email: `lead${i}@clinic${i}.example` }) });

  async function twoCampaigns(account: FakeAccount, before: (h: EngineHarness) => void, launchFirst = true) {
    const h = new EngineHarness({ start: MONDAY_10, accounts: [account] });
    const a = lead(1);
    const { campaign: first } = await h.createCampaign("First", { businesses: [a.business], people: [a.person] });
    await h.tick();
    await h.defineSequence(first.id, oneEmail);
    before(h);
    if (launchFirst) expect((await h.launch(first.id)).status).toBe(200);
    await h.advanceTo(MONDAY_10 + 30_000);
    const b = lead(2);
    const { campaign: second } = await h.createCampaign("Second", { businesses: [b.business], people: [b.person] });
    await h.defineSequence(second.id, oneEmail);
    const view = (await h.request<BeforeLaunchView>("GET", `/api/campaigns/${second.id}/before-launch`)).body;
    const projected = await projectedSends(h.store, second.id, h.clock);
    return { h, second, view, projected };
  }

  test("a rate limit with an end resumes at that instant, as the engine does, instead of looking like an outage", async () => {
    const { h, second, view, projected } = await twoCampaigns(inbox(), (x) => x.fake.rateLimitedUntil.set("inbox-a", MONDAY_10 + 2 * MIN));
    expect(view.load).toMatchObject({ daysUntilAllStart: 1, notStartedWithinHorizon: 0, cannotProject: [] });
    expect((await h.launch(second.id)).status).toBe(200);
    await h.advanceTo(MONDAY_10 + DAY);
    const sentSecond = h.fake.deliveryLog.find((d) => d.destination === "lead2@clinic2.example");
    // The first campaign's waiting lead goes first at the end of the wait, and this one a gap
    // later: the projection simulates the other campaign's waiting work, so the instant is exact.
    const mine = projected!.sends.find((x) => x.leadId === second.id || x.leadId === sentSecond?.subjectId);
    expect(mine).toMatchObject({ at: sentSecond!.at, accountId: sentSecond!.sender, step: 0 });
  });

  test("an inbox the provider reports cannot send has no known end: the screen says it cannot project, never a number", async () => {
    // An inbox that cannot send also blocks launch (blocker 3), so only the projection is checked.
    const { view } = await twoCampaigns(inbox(), (x) => (x.fake.accountsById.get("inbox-a")!.healthy = false), false);
    expect(view.load).toMatchObject({ daysUntilAllStart: null, cannotProject: [{ accountId: "inbox-a", reason: "cannot_send" }] });
  });

  test("a lead quota held at the provider has no known end either", async () => {
    const { view } = await twoCampaigns(inbox(), (x) => (x.fake.accountsById.get("inbox-a")!.quotaAvailable = false));
    expect(view.load).toMatchObject({ daysUntilAllStart: null, cannotProject: [{ accountId: "inbox-a", reason: "quota" }] });
  });
});

describe("another running campaign's waiting work on the same inboxes (PR 41 re-check, B10)", () => {
  const allDay: CampaignDefinition = {
    timezone: "Europe/London",
    callSkipLimitDays: 2,
    emailPool: ["inbox-a"],
    tracks: [{ id: "t1", channel: "email", branch: "main", window: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 })), steps: [{ id: "s1", waitDays: 0, subject: "Hi", body: "Hi.", threading: "new_subject", removed: false }], start: { kind: "entry" }, removed: false }],
  };
  const leadsOf = (prefix: string, zones: readonly string[]) => ({
    businesses: zones.map((zone, i) => business({ business_id: `${prefix}b${i}`, business_name: `${prefix} Clinic ${i}`, timezone: zone })),
    people: zones.map((_, i) => person({ person_id: `${prefix}p${i}`, business_id: `${prefix}b${i}`, full_name: `${prefix} Person${i}`, email: `${prefix}${i}@clinic.example`, timezone: "" })),
  });

  /**
   * Launches `first`, lets `gapMs` pass, then projects `second`, launches it and compares its sends
   * with the engine's: the other campaign's waiting work competes for the inboxes in both.
   */
  async function both(accounts: FakeAccount[], start: number, first: CampaignDefinition, second: CampaignDefinition, zones: { a: readonly string[]; b: readonly string[] }, before?: (h: EngineHarness) => void, gapMs = 0) {
    const h = new EngineHarness({ start, accounts });
    const { campaign: a } = await h.createCampaign("Running", leadsOf("a", zones.a));
    const { campaign: b } = await h.createCampaign("Projected", leadsOf("b", zones.b));
    await h.tick();
    await h.defineSequence(a.id, first);
    before?.(h);
    expect((await h.launch(a.id)).status).toBe(200);
    if (gapMs > 0) await h.advanceTo(start + gapMs);
    await h.defineSequence(b.id, second);
    const projected = await projectedSends(h.store, b.id, h.clock);
    const view = (await h.request<BeforeLaunchView>("GET", `/api/campaigns/${b.id}/before-launch`)).body;
    const already = h.fake.deliveryLog.length;
    expect((await h.launch(b.id)).status).toBe(200);
    h.maxWrites = 5_000;
    const until = start + 10 * DAY;
    await h.advanceTo(until);
    const stepIndex = (stepId: string) => Number(stepId.slice(1)) - 1;
    const exact = (xs: { leadId: string; accountId: string; step: number; at: number }[]) => [...xs].sort((x, y) => x.at - y.at || (x.accountId < y.accountId ? -1 : 1));
    const mine = new Set(await h.store.engine.subjectsOf(b.id));
    const actual = h.fake.deliveryLog.slice(already).filter((d) => mine.has(d.subjectId) && d.at < until).map((d) => ({ leadId: d.subjectId, accountId: d.sender, step: stepIndex(d.stepId), at: d.at }));
    return { projected: exact(projected!.sends.filter((s) => s.at < until && mine.has(s.leadId)).map(core)), actual: exact(actual), view };
  }

  test("the verifier's case: capacity 2, an older waiting lead of another campaign takes today's slot, so this campaign starts over two days", async () => {
    const start = Date.parse("2026-11-09T10:00:00Z");
    const inbox: FakeAccount = { id: "inbox-a", capacity: 2, gapMs: MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" };
    // The other campaign's lead is older: its campaign launched two minutes before this one is projected.
    const { projected, actual, view } = await both([inbox], start, allDay, allDay, { a: ["UTC"], b: ["UTC", "UTC"] }, (h) => h.fake.rateLimitedUntil.set("inbox-a", start + 5 * MIN), 2 * MIN);
    expect(projected).toEqual(actual);
    expect(view.load).toMatchObject({ daysUntilAllStart: 2, accounts: [expect.objectContaining({ busiestDay: 1 })] });
  });

  const SEEDS = Number(process.env["PROJECTION_SEEDS"] ?? 40);
  for (const seed of Array.from({ length: SEEDS }, (_, i) => 5000 + i)) {
    test(`generated two-campaign case ${seed}`, async () => {
      const first = generate(seed);
      const second = generate(seed + 10_000);
      // Both campaigns draw on the first case's inboxes, so they compete for them.
      const pool = first.accounts.map((x) => x.id);
      const shared = (d: CampaignDefinition): CampaignDefinition => ({ ...d, emailPool: pool });
      const { projected, actual } = await both(first.accounts, first.start, shared(first.definition), shared(second.definition), { a: first.zones, b: second.zones }, undefined, (seed % 3) * 7 * MIN);
      expect(projected).toEqual(actual);
    });
  }
});

describe("every inbox of every simulated campaign as the engine sees it (PR 41 council, item 1)", () => {
  const track = (pool: string[], window: readonly WindowRule[], waits: number[]): CampaignDefinition => ({
    timezone: "Europe/London",
    callSkipLimitDays: 2,
    emailPool: pool,
    tracks: [{ id: "t1", channel: "email", branch: "main", window, steps: waits.map((w, i) => ({ id: `s${i + 1}`, waitDays: w, subject: i === 0 ? "Hi" : "", body: "Hi.", threading: i === 0 ? "new_subject" : "continue_thread", removed: false })), start: { kind: "entry" }, removed: false }],
  });
  const leadsOf = (prefix: string, zones: readonly string[]) => ({
    businesses: zones.map((zone, i) => business({ business_id: `${prefix}b${i}`, business_name: `${prefix} Clinic ${i}`, timezone: zone })),
    people: zones.map((_, i) => person({ person_id: `${prefix}p${i}`, business_id: `${prefix}b${i}`, full_name: `${prefix} Person${i}`, email: `${prefix}${i}@clinic.example`, timezone: "" })),
  });
  type Unavailable = { readonly id: string; readonly reason: "unhealthy" | "quota" | "rate_limited" };

  /** Campaign A runs; some inboxes become unavailable; B is projected, launched, and its sends compared. */
  async function compareWith(o: { accounts: FakeAccount[]; start: number; a: CampaignDefinition; b: CampaignDefinition; zones: { a: readonly string[]; b: readonly string[] }; unavailable: readonly Unavailable[]; gapMs: number }) {
    const h = new EngineHarness({ start: o.start, accounts: o.accounts });
    const { campaign: a } = await h.createCampaign("Running", leadsOf("a", o.zones.a));
    const { campaign: b } = await h.createCampaign("Projected", leadsOf("b", o.zones.b));
    await h.tick();
    await h.defineSequence(a.id, o.a);
    for (const u of o.unavailable) {
      const acc = h.fake.accountsById.get(u.id)!;
      if (u.reason === "quota") acc.quotaAvailable = false;
      if (u.reason === "rate_limited") h.fake.rateLimitedUntil.set(u.id, o.start + 40 * MIN);
    }
    const launchedA = await h.launch(a.id);
    await h.advanceTo(o.start + o.gapMs);
    for (const u of o.unavailable) if (u.reason === "unhealthy") h.fake.accountsById.get(u.id)!.healthy = false;
    await h.tick();
    // The projection knows what the engine knows. A quota or rate limit the engine has not met yet
    // (no send was tried on that inbox) is a provider state nobody has observed: it is lifted, so
    // the engine and the projection start from the same facts. Every state the engine learned stays.
    const known = new Map((await h.store.engine.accounts(h.clock)).map((acc) => [acc.id, acc]));
    for (const u of o.unavailable) {
      if (u.reason === "quota" && known.get(u.id)?.waitReason !== "quota") h.fake.accountsById.get(u.id)!.quotaAvailable = true;
      if (u.reason === "rate_limited" && known.get(u.id)?.waitReason !== "rate_limited") h.fake.rateLimitedUntil.delete(u.id);
    }
    await h.defineSequence(b.id, o.b);
    const view = (await h.request<BeforeLaunchView>("GET", `/api/campaigns/${b.id}/before-launch`)).body;
    const projected = await projectedSends(h.store, b.id, h.clock);
    const already = h.fake.deliveryLog.length;
    const launchedB = await h.launch(b.id);
    h.maxWrites = 5_000;
    const until = o.start + 10 * DAY;
    await h.advanceTo(until);
    const mine = new Set(await h.store.engine.subjectsOf(b.id));
    const exact = (xs: { leadId: string; accountId: string; step: number; at: number }[]) => [...xs].sort((x, y) => x.at - y.at || (x.accountId < y.accountId ? -1 : 1));
    const actual = exact(h.fake.deliveryLog.slice(already).filter((d) => mine.has(d.subjectId) && d.at < until).map((d) => ({ leadId: d.subjectId, accountId: d.sender, step: Number(d.stepId.slice(1)) - 1, at: d.at })));
    return { view, projected: projected ? exact(projected.sends.filter((s) => s.at < until && mine.has(s.leadId)).map(core)) : null, actual, launched: launchedA.status === 200 && launchedB.status === 200 };
  }

  test("the reviewer's case: an inbox only the other campaign uses is unhealthy, so its waiting work comes onto the shared inbox", async () => {
    const start = Date.parse("2026-11-09T07:00:00Z");
    const inbox = (id: string): FakeAccount => ({ id, capacity: 2, gapMs: MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" });
    const nine = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
    const out = await compareWith({ accounts: [inbox("a"), inbox("x")], start, a: track(["a", "x"], nine, [0]), b: track(["a"], nine, [0]), zones: { a: ["UTC", "UTC"], b: ["UTC", "UTC"] }, unavailable: [{ id: "x", reason: "unhealthy" }], gapMs: MIN });
    expect(out.projected).toEqual(out.actual);
    expect(out.view.load).toMatchObject({ daysUntilAllStart: 2, accounts: [expect.objectContaining({ id: "a", busiestDay: 2 })] });
  });

  test("the reviewer's second case: the older lead's other inbox has room but is unhealthy, so it takes the shared inbox and the second new lead goes the next day", async () => {
    // Inbox a sends 2 a day; b sends 30 but cannot send. The older campaign may use either, this one only a.
    const start = Date.parse("2026-11-09T07:00:00Z");
    const nine = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
    const inbox = (id: string, capacity: number): FakeAccount => ({ id, capacity, gapMs: MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" });
    const out = await compareWith({ accounts: [inbox("a", 2), inbox("b", 30)], start, a: track(["a", "b"], nine, [0]), b: track(["a"], nine, [0]), zones: { a: ["UTC"], b: ["UTC", "UTC"] }, unavailable: [{ id: "b", reason: "unhealthy" }], gapMs: MIN });
    expect(out.launched).toBe(true);
    expect(out.projected).toEqual(out.actual);
    expect(out.actual.map((x) => new Date(x.at).toISOString().slice(0, 10))).toEqual(["2026-11-09", "2026-11-10"]);
    expect(out.view.load).toMatchObject({ daysUntilAllStart: 2, accounts: [expect.objectContaining({ id: "a", busiestDay: 1 })] });
  });

  const SEEDS = Number(process.env["PROJECTION_SEEDS"] ?? 40);
  for (const seed of Array.from({ length: SEEDS }, (_, i) => 9000 + i)) {
    test(`generated: each campaign its own inboxes, some unavailable, case ${seed}`, async () => {
      const r = rng(seed);
      const ids = ["i0", "i1", "i2"];
      const accounts = ids.map((id): FakeAccount => ({ id, capacity: 1 + Math.floor(r() * 3), gapMs: pick(r, [MIN, 7 * MIN, 50 * MIN]), k: 1, healthy: true, quotaAvailable: true, resetZone: pick(r, ["UTC", "America/Los_Angeles"]) }));
      const subset = () => {
        const s = ids.filter(() => r() < 0.6);
        return s.length > 0 ? s : [pick(r, ids)];
      };
      const reasons = ["unhealthy", "quota", "rate_limited"] as const;
      const unavailable = ids.filter(() => r() < 0.35).map((id): Unavailable => ({ id, reason: pick(r, reasons) }));
      const first = generate(seed);
      const second = generate(seed + 20_000);
      const out = await compareWith({
        accounts,
        start: first.start,
        a: { ...first.definition, emailPool: subset() },
        b: { ...second.definition, emailPool: subset() },
        zones: { a: first.zones, b: second.zones },
        unavailable,
        gapMs: Math.floor(r() * 3) * 7 * MIN,
      });
      // An inbox of this campaign that cannot send with no known end: no projection, and the screen says so.
      if (out.projected === null) {
        expect(out.view.load === null || out.view.load.cannotProject.length > 0 || out.view.load.accounts.length === 0).toBe(true);
        return;
      }
      if (!out.launched) return;
      expect(out.projected).toEqual(out.actual);
    });
  }
});

describe("every track on both channels, across campaigns (ticket 13b): the projection makes exactly the engine's sends", () => {
  interface World {
    readonly start: number;
    readonly inboxes: FakeAccount[];
    readonly numbers: { id: string; capacity: number; gapMs: number | null; k: number; healthy: boolean; resetZone: string }[];
    /** One per campaign; the last is projected, the others launched before it. */
    readonly campaigns: { definition: CampaignDefinition; leads: number[]; launchAfterMs: number }[];
    /** Each lead: its zone, and whether it has an email and a mobile of its own. */
    readonly people: { zone: string; email: boolean; mobile: boolean }[];
  }

  function world(seed: number): World {
    const r = rng(seed);
    const inboxes = Array.from({ length: 1 + Math.floor(r() * 2) }, (_, i): FakeAccount => ({ id: `inbox-${i}`, capacity: 1 + Math.floor(r() * 4), gapMs: pick(r, [MIN, 7 * MIN, 50 * MIN]), k: 1, healthy: true, quotaAvailable: true, resetZone: pick(r, ["UTC", "America/Los_Angeles"]) }));
    const numbers = Array.from({ length: 1 + Math.floor(r() * 2) }, (_, i) => ({ id: `+4477009001${i}0`, capacity: 1 + Math.floor(r() * 4), gapMs: pick(r, [MIN, 7 * MIN, 50 * MIN, null]), k: 1, healthy: true, resetZone: pick(r, ["Europe/London", "UTC"]) }));
    const people = Array.from({ length: 2 + Math.floor(r() * 5) }, () => ({ zone: pick(r, ZONES), email: r() < 0.75, mobile: r() < 0.75 }));
    const subset = <T,>(xs: readonly T[]) => {
      const s = xs.filter(() => r() < 0.6);
      return s.length > 0 ? s : [pick(r, xs)];
    };
    const n = 1 + Math.floor(r() * 3);
    const campaigns = Array.from({ length: n }, (_, c) => {
      const tracks: CampaignDefinition["tracks"][number][] = [];
      for (let i = 0; i < 1 + Math.floor(r() * 4); i++) {
        const channel = pick(r, ["email", "sms"] as const);
        const start = tracks.length > 0 && r() < 0.55 ? { kind: "after" as const, trackId: pick(r, tracks).id, delayDays: Math.floor(r() * 4) } : { kind: "entry" as const };
        const id = `c${c}t${i}`;
        tracks.push({
          id,
          channel,
          branch: "main",
          window: pick(r, WINDOWS),
          steps: Array.from({ length: 1 + Math.floor(r() * 3) }, (_, k) => ({ id: `${id}s${k}`, waitDays: k === 0 ? 0 : Math.floor(r() * 3), subject: k === 0 && channel === "email" ? "Hello" : "", body: "A note.", threading: k === 0 || channel === "sms" ? ("new_subject" as const) : ("continue_thread" as const), removed: false })),
          start,
          removed: false,
        });
      }
      const definition: CampaignDefinition = { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: subset(inboxes).map((x) => x.id), smsPool: subset(numbers).map((x) => x.id), tracks };
      // People are shared between campaigns, so one mobile can be in two campaigns' conversations.
      return { definition, leads: subset(people.map((_, i) => i)), launchAfterMs: Math.floor(r() * 3) * 9 * MIN };
    });
    return { start: pick(r, ANCHORS) + Math.floor(r() * 5) * MIN, inboxes, numbers, campaigns, people };
  }

  async function compareWorld(w: World) {
    const h = new EngineHarness({ start: w.start, accounts: w.inboxes, sms: { numbers: w.numbers } });
    const rows = (leads: readonly number[]) => ({
      businesses: leads.map((i) => business({ business_id: `b${i}`, business_name: `Clinic ${i}`, timezone: w.people[i]!.zone })),
      people: leads.map((i) => person({ person_id: `p${i}`, business_id: `b${i}`, full_name: `Lead Person${i}`, email: w.people[i]!.email ? `lead${i}@clinic${i}.example` : "", timezone: "", ...(w.people[i]!.mobile ? { dial_phone: mobileOf(i), dial_phone_type: "mobile" } : {}) })),
    });
    const ids: string[] = [];
    for (const [i, c] of w.campaigns.entries()) ids.push((await h.createCampaign(`Campaign ${i}`, rows(c.leads))).campaign.id);
    await h.tick();
    h.maxWrites = 20_000;
    for (const [i, c] of w.campaigns.entries()) {
      await h.defineSequence(ids[i]!, c.definition);
      if (i === w.campaigns.length - 1) break;
      expect((await h.launch(ids[i]!)).status).toBe(200);
      if (c.launchAfterMs > 0) await h.advanceTo(h.clock + c.launchAfterMs);
    }
    const target = ids.at(-1)!;
    const projected = await projectedSends(h.store, target, h.clock);
    const view = (await h.request<BeforeLaunchView>("GET", `/api/campaigns/${target}/before-launch`)).body;
    const already = { email: h.fake.deliveryLog.length, sms: h.sms.deliveryLog.length };
    expect((await h.launch(target)).status).toBe(200);
    const until = w.start + 12 * DAY;
    await h.advanceTo(until);
    const mine = new Set(await h.store.engine.subjectsOf(target));
    const pickFields = (x: { leadId: string; accountId: string; stepId: string; at: number }) => `${x.at} ${x.accountId} ${x.leadId} ${x.stepId}`;
    const actual = [...h.fake.deliveryLog.slice(already.email), ...h.sms.deliveryLog.slice(already.sms)]
      .filter((d) => mine.has(d.subjectId) && d.at < until)
      .map((d) => pickFields({ leadId: d.subjectId, accountId: d.sender, stepId: d.stepId, at: d.at }))
      .sort();
    const predicted = (projected?.sends ?? []).filter((s) => s.at < until).map(pickFields).sort();
    return { actual, predicted, view, channels: new Set([...h.sms.deliveryLog.slice(already.sms)].filter((d) => mine.has(d.subjectId)).length > 0 ? ["sms"] : []) };
  }

  const SEEDS = Number(process.env["PROJECTION_SEEDS"] ?? 40);
  const texted: boolean[] = [];
  // Found by a 200-world run: a subject changed by evaluation lost its wake at the next track
  // start, so a delayed track started late. They failed before the fix and always run.
  const REGRESSIONS = [13_056, 13_106];
  for (const seed of [...REGRESSIONS, ...Array.from({ length: SEEDS }, (_, i) => 13_000 + i).filter((x) => !REGRESSIONS.includes(x))]) {
    test(`generated multi-track world ${seed}`, async () => {
      const { actual, predicted, view, channels } = await compareWorld(world(seed));
      texted.push(channels.has("sms"));
      expect(view.load?.noSender).toEqual([]);
      expect(predicted).toEqual(actual);
    });
  }
  test("the worlds really text: most projected campaigns send SMS", () => {
    expect(texted.filter(Boolean).length).toBeGreaterThan(SEEDS / 3);
  });
});
