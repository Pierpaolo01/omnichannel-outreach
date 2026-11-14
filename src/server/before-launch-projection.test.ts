import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../test/support/engine-harness.ts";
import { business, person } from "../../test/support/export-builder.ts";
import type { FakeAccount } from "../../test/support/fake-email-port.ts";
import type { CampaignDefinition, DeclinedPath, StepDefinition } from "../domain/sequence/definition.ts";
import type { WindowRule } from "../domain/sequence/clock.ts";
import type { BeforeLaunchView } from "../shared/api.ts";
import { localDayNumber, resetDayOf } from "../domain/sequence/clock.ts";
import { inbox as scriptedInbox, quickWaits } from "../../test/support/regressions.ts";
import { ScriptedEmailPort } from "../../test/support/scripted-email-port.ts";
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
      const { projected, actual, daily, texts } = await compare(c);
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
        // Phone tracks too (merge of 14a): together with or after the others, and others after them.
        const channel = pick(r, ["email", "sms", "email", "sms", "call"] as const);
        const start = tracks.length > 0 && r() < 0.55 ? { kind: "after" as const, trackId: pick(r, tracks).id, delayDays: Math.floor(r() * 4) } : { kind: "entry" as const };
        const id = `c${c}t${i}`;
        tracks.push({
          id,
          channel,
          branch: "main",
          window: pick(r, WINDOWS),
          steps:
            channel === "call"
              ? [{ id: `${id}s0`, waitDays: 0, subject: "", body: "", threading: "new_subject" as const, removed: false }]
              : Array.from({ length: 1 + Math.floor(r() * 3) }, (_, k) => ({ id: `${id}s${k}`, waitDays: k === 0 ? 0 : Math.floor(r() * 3), subject: k === 0 && channel === "email" ? "Hello" : "", body: "A note.", threading: k === 0 || channel === "sms" ? ("new_subject" as const) : ("continue_thread" as const), removed: false })),
          start,
          removed: false,
        });
      }
      // Ticket 16, from its own stream so the worlds above keep their shape: a win-back branch of one or two
      // email and SMS tracks in half the campaigns, and each phone track's declined path.
      const wb = rng(seed * 31 + c + 1616);
      const branch: CampaignDefinition["tracks"][number][] = [];
      if (wb() < 0.5) {
        for (let i = 0; i < 1 + Math.floor(wb() * 2); i++) {
          const channel = pick(wb, ["email", "sms"] as const);
          const id = `c${c}w${i}`;
          branch.push({
            id,
            channel,
            branch: "win_back",
            window: pick(wb, WINDOWS),
            steps: Array.from({ length: 1 + Math.floor(wb() * 2) }, (_, k) => ({ id: `${id}s${k}`, waitDays: k === 0 ? 0 : 1 + Math.floor(wb() * 2), subject: channel === "email" ? "Still here" : "", body: "One more note.", threading: "new_subject" as const, removed: false })),
            start: branch.length > 0 && wb() < 0.5 ? { kind: "after" as const, trackId: pick(wb, branch).id, delayDays: Math.floor(wb() * 3) } : { kind: "entry" as const },
            removed: false,
          });
        }
      }
      const paths: DeclinedPath[] = ["stop", "continue", ...(branch.length > 0 ? (["win_back", "win_back"] as const) : [])];
      const withPaths = tracks.map((t) => (t.channel === "call" ? { ...t, declinedPath: pick(wb, paths) } : t));
      const definition: CampaignDefinition = { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: subset(inboxes).map((x) => x.id), smsPool: subset(numbers).map((x) => x.id), tracks: [...withPaths, ...branch] };
      // People are shared between campaigns, so one mobile can be in two campaigns' conversations.
      return { definition, leads: subset(people.map((_, i) => i)), launchAfterMs: Math.floor(r() * 3) * 9 * MIN };
    });
    return { start: pick(r, ANCHORS) + Math.floor(r() * 5) * MIN, inboxes, numbers, campaigns, people };
  }

  /**
   * What happened in the earlier campaigns before the projection (council on 10121d3, item 1): calls
   * the user logged (no answer or gatekeeper, which complete the phone track and start what follows;
   * interested, which ends the lead), and a campaign paused. Every logged call touches its lead. Ticket
   * 15 adds a redial (the call moves to the next day; its track stays open) and a callback a day or more
   * ahead (the lead's automated outreach pauses: its claims are withdrawn and nothing of it is sent until
   * the outcome, which no estimate can know), and calls left unworked until the skip limit skips them.
   */
  const startedFrom = new Set<string>();
  /** Ticket 15's stored facts, by world: a lead held by a callback, a call redialed, a call skipped at the skip limit. */
  const ticket15 = { held: 0, redialed: 0, skipped: 0, releasedBySkip: 0 };
  /** Ticket 16's stored facts: leads declined on each path before the projection, and the sends of competing leads in win-back after it. */
  const ticket16 = { stop: 0, continue: 0, win_back: 0, winBackSends: 0, projectedWithABranch: 0 };
  async function logCalls(h: EngineHarness, campaignId: string, r: () => number, after = false, d: () => number = () => 1) {
    let logged = 0;
    for (const id of await h.store.engine.subjectsOf(campaignId)) {
      const s = (await h.store.engine.subject(id, h.clock))!;
      const task = s.callTasks.find((t) => t.open);
      const number = s.lead.phones.find((n) => !n.bad);
      if (!task || !number || r() < 0.3) continue;
      const drawn = pick(r, ["no_answer", "gatekeeper", "interested", "no_answer", "gatekeeper", "interested", "redial", "callback_requested"] as const);
      // Ticket 16: a quarter of the calls are declined, on the track's path or the user's override for the lead.
      const outcome = d() < 0.25 ? "not_interested" : drawn;
      const winBack = s.campaign.definition.tracks.some((t) => t.branch === "win_back");
      const override = outcome === "not_interested" && d() < 0.3 ? pick(d, winBack ? (["stop", "continue", "win_back"] as const) : (["stop", "continue"] as const)) : null;
      const body =
        outcome === "not_interested" ? { outcome, ...(override ? { declinedPath: override } : {}) }
        : outcome === "redial" ? { outcome: "no_answer", redial: true }
        : outcome === "callback_requested" ? { outcome, callbackAt: new Date(h.clock + pick(r, [1, 2, 4]) * DAY).toISOString() }
        : { outcome };
      const res = await h.request("POST", `/api/call-tasks/${task.id}/outcome`, { requestId: `r-${task.id}`, ...body, numberId: number.id, note: "" });
      if (res.status !== 200) continue;
      logged++;
      if (outcome === "redial") ticket15.redialed++;
      if (outcome === "not_interested") ticket16[override ?? s.campaign.definition.tracks.find((t) => t.id === task.trackId)?.declinedPath ?? "stop"]++;
      if (outcome === "callback_requested") ticket15.held++;
      if (!after && outcome !== "redial" && outcome !== "callback_requested") startedFrom.add(outcome === "interested" ? "an interested call ended a lead" : "a logged call touched a lead and finished its phone track");
    }
    return logged;
  }
  /** Ticket 16: the user declines open calls of an earlier campaign, each on its track's path or an override for the lead. */
  async function declineCalls(h: EngineHarness, campaignId: string, d: () => number) {
    for (const id of await h.store.engine.subjectsOf(campaignId)) {
      const s = (await h.store.engine.subject(id, h.clock))!;
      const task = s.callTasks.find((t) => t.open);
      const number = s.lead.phones.find((n) => !n.bad);
      if (!task || !number || d() < 0.3) continue;
      const winBack = s.campaign.definition.tracks.some((t) => t.branch === "win_back");
      const override = winBack && d() < 0.5 ? "win_back" : d() < 0.3 ? pick(d, ["stop", "continue"] as const) : null;
      const res = await h.request("POST", `/api/call-tasks/${task.id}/outcome`, { requestId: `d-${task.id}`, outcome: "not_interested", ...(override ? { declinedPath: override } : {}), numberId: number.id, note: "" });
      if (res.status === 200) ticket16[override ?? s.campaign.definition.tracks.find((t) => t.id === task.trackId)?.declinedPath ?? "stop"]++;
    }
  }

  async function compareWorld(w: World, seed: number) {
    const h = new EngineHarness({ start: w.start, accounts: w.inboxes, sms: { numbers: w.numbers } });
    expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 50, userZone: "Europe/London" })).status).toBe(200);
    const r = rng(seed + 77);
    const d = rng(seed + 1616);
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
      if (r() < 0.7) {
        await h.advanceTo(h.clock + pick(r, [H, 3 * H, DAY]));
        if ((await logCalls(h, ids[i]!, r, false, d)) > 0) await h.advanceTo(h.clock + pick(r, [MIN, 2 * H, DAY]));
      }
      if (d() < 0.6) {
        await h.advanceTo(h.clock + pick(d, [H, 5 * H]));
        await declineCalls(h, ids[i]!, d);
      }
      if (r() < 0.2) {
        const db = (h.store.engine as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;
        db.prepare("UPDATE campaigns SET paused_since = ?, version = version + 1 WHERE id = ?").run(h.clock, ids[i]!);
        startedFrom.add("a paused competing campaign");
      }
    }
    for (const id of ids.slice(0, -1)) {
      for (const sid of await h.store.engine.subjectsOf(id)) {
        const st = (await h.store.engine.subject(sid, h.clock))!;
        const def = st.campaign.definition;
        const afterCall = def.tracks.filter((t) => t.start.kind === "after" && def.tracks.find((x) => x.id === (t.start as { trackId: string }).trackId)?.channel === "call");
        if (afterCall.some((t) => st.tracks.find((p) => p.trackId === t.id)?.startedAt != null && st.tracks.find((p) => p.trackId === (t.start as { trackId: string }).trackId)?.finishReason === "completed")) startedFrom.add("a track after a phone track started when its call was logged");
      }
    }
    const target = ids.at(-1)!;
    const projected = await projectedSends(h.store, target, h.clock);
    const view = (await h.request<BeforeLaunchView>("GET", `/api/campaigns/${target}/before-launch`)).body;
    // The branch's sends are not counted, and the screen says so whenever the campaign has one (ticket 16).
    const hasBranch = w.campaigns.at(-1)!.definition.tracks.some((t) => t.branch === "win_back");
    if (view.load) expect(view.load.winBackNotCounted).toBe(hasBranch);
    if (hasBranch && view.load?.withheldBy === null) ticket16.projectedWithABranch++;
    const inWinBack = new Set<string>();
    for (const id of ids.slice(0, -1)) for (const sid of await h.store.engine.subjectsOf(id)) if ((await h.store.engine.subject(sid, h.clock))?.subject.branch === "win_back") inWinBack.add(sid);
    const competingBefore = { email: h.fake.deliveryLog.length, sms: h.sms.deliveryLog.length };
    const already = { email: h.fake.deliveryLog.length, sms: h.sms.deliveryLog.length };
    expect((await h.launch(target)).status).toBe(200);
    const until = w.start + 12 * DAY;
    await h.advanceTo(until);
    const mine = new Set(await h.store.engine.subjectsOf(target));
    ticket16.winBackSends += [...h.fake.deliveryLog.slice(competingBefore.email), ...h.sms.deliveryLog.slice(competingBefore.sms)].filter((x) => inWinBack.has(x.subjectId) && x.stepId.includes("w")).length;
    const pickFields = (x: { leadId: string; accountId: string; stepId: string; at: number }) => `${x.at} ${x.accountId} ${x.leadId} ${x.stepId}`;
    const actual = [...h.fake.deliveryLog.slice(already.email), ...h.sms.deliveryLog.slice(already.sms)]
      .filter((d) => mine.has(d.subjectId) && d.at < until)
      .map((d) => pickFields({ leadId: d.subjectId, accountId: d.sender, stepId: d.stepId, at: d.at }))
      .sort();
    const predicted = (projected?.sends ?? []).filter((s) => s.at < until).map(pickFields).sort();
    // When each lead's phone tracks were skipped with no call logged: for want of a number, or at the skip limit
    // (ticket 15). No call is logged after the projection, so a track waiting on a call starts only then.
    const skippedAt = new Map<string, Map<string, number>>();
    for (const id of mine) {
      const st = (await h.store.engine.subject(id, h.clock))!;
      const byTrack = new Map<string, number>();
      for (const p of st.tracks) {
        if (p.finishReason !== "skipped_missing_channel" && p.finishReason !== "skipped_unworked") continue;
        if (st.campaign.definition.tracks.find((t) => t.id === p.trackId)?.channel !== "call") continue;
        byTrack.set(p.trackId, p.finishedWall ?? 0);
        if (p.finishReason === "skipped_unworked") ticket15.skipped++;
      }
      skippedAt.set(id, byTrack);
    }
    return { actual, predicted, view, projected, skippedAt, channels: new Set([...h.sms.deliveryLog.slice(already.sms)].filter((d) => mine.has(d.subjectId)).length > 0 ? ["sms"] : []) };
  }

  const SEEDS = Number(process.env["PROJECTION_SEEDS"] ?? 40);
  const texted: boolean[] = [];
  // Found by a 200-world run: a subject changed by evaluation lost its wake at the next track
  // start, so a delayed track started late. They failed before the fix and always run.
  const REGRESSIONS = [13_056, 13_106];
  for (const seed of [...REGRESSIONS, ...Array.from({ length: SEEDS }, (_, i) => 13_000 + i).filter((x) => !REGRESSIONS.includes(x))]) {
    test(`generated multi-track world ${seed}`, async () => {
      await verify(world(seed), seed);
    });
  }
  /** The projection lists exactly the engine's sends, or withholds the figure for a track waiting on a call, which the engine then sends on only after that call was skipped. */
  async function verify(w: World, seed: number) {
    {
      const { actual, predicted, view, projected, skippedAt, channels } = await compareWorld(w, seed);
      texted.push(channels.has("sms"));
      const withheld = view.load?.withheldBy ?? null;
      if (withheld === null) {
        expect(predicted).toEqual(actual);
        return;
      }
      // A track that waits on a call is named, nothing is projected, and with no call logged the engine
      // sends on it only once the call it waits on was skipped: for want of a number, or unworked at the
      // skip limit (ticket 15), and never before that instant.
      withheldWorlds.push(seed);
      expect(withheld.tracks.every((t) => t.why === "after_a_phone_track")).toBe(true);
      expect(projected).toBeNull();
      // A competing campaign's tracks: named with that campaign; its own sends are not this test's to check.
      if (withheld.campaign !== null) return;
      const early: string[] = [];
      for (const line of actual) {
        const [at, , lead, step] = line.split(" ");
        const waits = withheld.tracks.find((t) => step?.startsWith(`${t.trackId}s`));
        if (!waits) continue;
        // The phone track it waits on, through its chain: any skipped phone track of the lead before the send releases nothing earlier than its skip.
        const skips = [...(skippedAt.get(lead ?? "")?.values() ?? [])];
        if (skips.length === 0 || Number(at) < Math.min(...skips)) early.push(line);
        else ticket15.releasedBySkip++;
      }
      expect(early).toEqual([]);
    }
  }
  const withheldWorlds: number[] = [];
  /**
   * Ticket 16's stored facts, made certain (the worlds above reach them only now and then): each earlier campaign
   * opens with a phone track and has a win-back branch, so the user's declines leave leads stopped, continuing
   * on the other channels with no call again, and in win-back when the projection is taken.
   */
  const DECLINE_SEEDS = Number(process.env["PROJECTION_SEEDS"] ?? 40) / 2;
  for (const seed of Array.from({ length: DECLINE_SEEDS }, (_, i) => 14_000 + i)) {
    test(`generated world with declined leads ${seed}`, async () => {
      const w = world(seed);
      const last = w.campaigns.length - 1;
      const campaigns = w.campaigns.map((c, i) => {
        if (i === last) return c;
        const tracks = c.definition.tracks;
        const call = { id: `c${i}call`, channel: "call" as const, branch: "main" as const, window: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 })), steps: [{ id: `c${i}calls0`, waitDays: 0, subject: "", body: "", threading: "new_subject" as const, removed: false }], start: { kind: "entry" as const }, removed: false, declinedPath: pick(rng(seed + i), ["stop", "continue", "win_back"] as const) };
        const branch = tracks.some((t) => t.branch === "win_back")
          ? []
          : [{ id: `c${i}w9`, channel: "email" as const, branch: "win_back" as const, window: WINDOWS[0]!, steps: [0, 1, 2].map((k) => ({ id: `c${i}w9s${k}`, waitDays: k === 0 ? 0 : 1, subject: "Still here", body: "One more note.", threading: "new_subject" as const, removed: false })), start: { kind: "entry" as const }, removed: false }];
        return { ...c, definition: { ...c.definition, tracks: [call, ...tracks, ...branch] } };
      });
      await verify({ ...w, campaigns, people: w.people.map((p) => ({ ...p, email: true })) }, seed);
    });
  }
  test("the worlds start from logged calls, interested calls and a paused competing campaign", () => {
    expect([...startedFrom].sort()).toEqual(
      ["a logged call touched a lead and finished its phone track", "a paused competing campaign", "a track after a phone track started when its call was logged", "an interested call ended a lead"].filter((x) => SEEDS >= 40 || startedFrom.has(x)),
    );
  });
  test("the worlds include ticket 15's stored facts: leads held by a callback, redialed calls, and calls skipped at the skip limit releasing the tracks after them", () => {
    if (SEEDS < 40) return;
    expect(ticket15.held).toBeGreaterThan(0);
    expect(ticket15.redialed).toBeGreaterThan(0);
    expect(ticket15.skipped).toBeGreaterThan(0);
    expect(ticket15.releasedBySkip).toBeGreaterThan(0);
  });
  test("the worlds include ticket 16's stored facts: leads declined on each path, competing leads sending in win-back, and a projected campaign with a win-back branch", () => {
    if (SEEDS < 40) return;
    expect(Object.entries(ticket16).filter(([, n]) => n === 0).map(([what]) => what), JSON.stringify(ticket16)).toEqual([]);
  });
  test("the worlds include phone tracks that hold the tracks after them, and worlds with phone tracks still projected", () => {
    expect(withheldWorlds.length).toBeGreaterThan(0);
    expect(withheldWorlds.length).toBeLessThan(SEEDS);
  });
  test("the worlds really text: most projected campaigns send SMS", () => {
    expect(texted.filter(Boolean).length).toBeGreaterThan(SEEDS / 3);
  });
});

describe("work an older campaign already holds when the projection is taken (review bot on c1e215e)", () => {
  const allHours = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 9, end: 10 }));
  const oneEmail = (pool: string[]): CampaignDefinition => ({
    timezone: "Europe/London",
    callSkipLimitDays: 2,
    emailPool: pool,
    tracks: [{ id: "t1", channel: "email", branch: "main", window: allHours, steps: [{ id: "s1", waitDays: 0, subject: "Hi", body: "Hi.", threading: "new_subject", removed: false }], start: { kind: "entry" }, removed: false }],
  });
  const rowsOf = (prefix: string, n: number) => ({
    businesses: Array.from({ length: n }, (_, i) => business({ business_id: `${prefix}b${i}`, business_name: `${prefix} Clinic ${i}`, timezone: "UTC" })),
    people: Array.from({ length: n }, (_, i) => person({ person_id: `${prefix}p${i}`, business_id: `${prefix}b${i}`, full_name: `${prefix} Person${i}`, email: `${prefix}${i}@clinic.example`, timezone: "" })),
  });

  test("a full inbox whose only reservation is uncertain work a ready step can carry on: the projection claims it as the engine does, and both campaigns send", async () => {
    let clock = Date.parse("2026-11-02T09:50:00Z");
    const port = new ScriptedEmailPort(() => clock, [scriptedInbox("inbox-a", { capacity: 1, gapMs: MIN, resetZone: "UTC" })]);
    const h = new EngineHarness({ start: clock, accounts: [], port, engine: quickWaits });
    Object.defineProperty(h, "clock", { get: () => clock, set: (v: number) => (clock = v) });
    const { campaign: older } = await h.createCampaign("Older", rowsOf("a", 1));
    const { campaign: newer } = await h.createCampaign("Newer", rowsOf("b", 1));
    await h.tick();
    // The older campaign's call gets no answer and is never sent; its lookups say not sent, not finally.
    port.onCall = () => ({ answer: "unknown", sendAfter: null });
    port.lookupOverride = (work) => (work && work.sendAt === null ? { kind: "not-sent" } : null);
    await h.defineSequence(older.id, oneEmail(["inbox-a"]));
    expect((await h.launch(older.id)).status).toBe(200);
    // Its lookups say not sent until the attempt is withdrawn; the work stays uncertain and reserved.
    await h.advanceTo(Date.parse("2026-11-02T16:00:00Z"));
    const [account] = await h.store.engine.accounts(h.clock);
    expect(account).toMatchObject({ used: 1, inFlight: 0 });

    await h.defineSequence(newer.id, oneEmail(["inbox-a"]));
    const projected = await projectedSends(h.store, newer.id, h.clock);
    // From now on the provider takes every call, and the carried-on work sends when it is called again.
    port.onCall = () => ({ answer: "accepted", sendAfter: 0 });
    port.resendDropped = true;
    expect((await h.launch(newer.id)).status).toBe(200);
    await h.advanceTo(Date.parse("2026-11-06T00:00:00Z"));
    const mine = new Set(await h.store.engine.subjectsOf(newer.id));
    const actual = port.deliveries.filter((d) => mine.has(d.subjectId)).map((d) => ({ leadId: d.subjectId, accountId: d.sender, at: d.at }));
    // The older lead carries its work on Tuesday at 09:00; this campaign's lead goes on Wednesday.
    expect(actual.map((d) => new Date(d.at).toISOString())).toEqual(["2026-11-04T09:00:00.000Z"]);
    expect(projected!.sends.map(({ leadId, accountId, at }) => ({ leadId, accountId, at }))).toEqual(actual);
    expect(projected).toMatchObject({ notStarted: 0, daysUntilAllStart: 3 });
  });
});

describe("generated: an older campaign's work in every provider state when the projection is taken (ticket 13b, review bot on c1e215e)", () => {
  /**
   * The older campaign's first calls end in one of four states: sent; dropped with an unknown answer
   * and a same-key retry to come (retryable), or with none (not retryable), its lookups saying not
   * sent, not finally, so the work stays uncertain and reserved, carried by an attempt or by none;
   * or accepted and sending exactly at the projection's instant. Claims may be waiting for a slot.
   * From the projection on, the provider takes every call, and dropped work sends when it is called
   * again: the projection's stated provider. The projected campaign's sends must be the engine's.
   */
  type Outcome = "sent" | "dropped" | "in_flight";
  const SEEDS = Number(process.env["PROJECTION_SEEDS"] ?? 40);
  for (const seed of Array.from({ length: SEEDS }, (_, i) => 21_000 + i)) {
    test(`case ${seed}`, { timeout: 120_000 }, async () => {
      const r = rng(seed);
      // Every fourth seed is free; the others pin the state they are for: a same-key retry waiting
      // for a 50-minute slot; uncertain work no attempt carries (a dropped call whose lookups said not
      // sent, hours later); accepted work the provider sends at the projection's instant.
      // Owner statuses too (review bot and council on 10121d3): a lead that replied while its follow-up
      // was accepted; a paused campaign holding accepted work; a reply still being matched to its lead.
      const scenario = (["free", "retry_waiting", "uncertain", "in_flight", "replied_holding", "paused", "pending_reply", "claim_waiting"] as const)[seed % 8]!;
      const start =
        scenario === "free" ? pick(r, [Date.parse("2026-11-02T08:50:00Z"), Date.parse("2026-11-02T09:30:00Z"), Date.parse("2026-11-02T16:40:00Z")])
        : scenario === "uncertain" ? Date.parse("2026-11-02T09:50:00Z")
        : scenario === "replied_holding" ? Date.parse("2026-11-02T09:00:00Z")
        : Date.parse("2026-11-02T09:30:00Z");
      let clock = start;
      const ids = Array.from({ length: 1 + Math.floor(r() * 2) }, (_, i) => `inbox-${i}`);
      const port = new ScriptedEmailPort(
        () => clock,
        ids.map((id) => scriptedInbox(id, { capacity: 1 + Math.floor(r() * 3), gapMs: scenario === "retry_waiting" || scenario === "claim_waiting" ? 50 * MIN : pick(r, [MIN, 7 * MIN, 50 * MIN]), resetZone: pick(r, ["UTC", "America/Los_Angeles"]) })),
      );
      const h = new EngineHarness({ start, accounts: [], port, engine: quickWaits });
      Object.defineProperty(h, "clock", { get: () => clock, set: (v: number) => (clock = v) });
      const rows = (prefix: string, n: number) => ({
        businesses: Array.from({ length: n }, (_, i) => business({ business_id: `${prefix}b${i}`, business_name: `${prefix} Clinic ${i}`, timezone: pick(r, ZONES) })),
        people: Array.from({ length: n }, (_, i) => person({ person_id: `${prefix}p${i}`, business_id: `${prefix}b${i}`, full_name: `${prefix} Person${i}`, email: `${prefix}${i}@clinic.example`, timezone: "" })),
      });
      const subset = () => {
        const s = ids.filter(() => r() < 0.7);
        return s.length > 0 ? s : [pick(r, ids)];
      };
      const always = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
      const track = (pool: string[], stepCount = 1 + Math.floor(r() * 2)): CampaignDefinition => {
        const steps: StepDefinition[] = Array.from({ length: stepCount }, (_, i) => ({ id: `s${i + 1}`, waitDays: i === 0 ? 0 : scenario === "replied_holding" ? 1 : 1 + Math.floor(r() * 2), subject: i === 0 ? "Hi" : "", body: "A note.", threading: i === 0 ? "new_subject" : "continue_thread", removed: false }));
        // Half the time open all day, so the older campaign's work is with the provider at the projection.
        // The uncertain case's window closes ten minutes after launch, so no retry follows the lookups.
        const window = scenario === "uncertain" ? [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 9, end: 10 })) : scenario !== "free" || r() < 0.5 ? always : pick(r, WINDOWS);
        return { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: pool, tracks: [{ id: "t1", channel: "email", branch: "main", window, steps, start: { kind: "entry" }, removed: false }] };
      };
      const { campaign: older } = await h.createCampaign("Older", rows("a", scenario === "claim_waiting" ? 3 : 1 + Math.floor(r() * 4)));
      const { campaign: newer } = await h.createCampaign("Newer", rows("b", 1 + Math.floor(r() * 3)));
      await h.tick();

      const projectAt =
        start +
        (scenario === "retry_waiting" || scenario === "claim_waiting" ? 10 * MIN
        : scenario === "uncertain" ? 6 * H
        : scenario === "replied_holding" ? DAY + 10 * MIN
        : scenario === "paused" ? 20 * MIN
        // Before the engine's first lookup (the settling time after the call) learns the thread.
        : scenario === "pending_reply" ? 12 * MIN
        : pick(r, [10 * MIN, 20 * MIN, 50 * MIN, 3 * H, 7 * H]));
      // A reply being matched needs a thread the app does not know yet: no retry tells it first.
      const retryable = scenario === "retry_waiting" || scenario === "uncertain" ? true : scenario === "pending_reply" ? false : r() < 0.5;
      port.transportFor = () => ({ retryable, notSentIsFinal: false });
      const outcomes = new Map<string, Outcome>();
      port.onCall = (request) => {
        // A lead's follow-up is accepted and sends at the projection's instant; a reply has come first.
        if (scenario === "replied_holding") return request.stepId === "s1" ? { answer: "accepted", sendAfter: 0 } : { answer: "accepted", sendAfter: Math.max(0, projectAt - clock) };
        // The answer is lost and the sent event late, so a reply's thread is not yet known.
        if (scenario === "pending_reply") return { answer: "unknown", sendAfter: 0, eventDelay: 3 * H };
        const outcome =
          outcomes.get(request.destination) ??
          (scenario === "retry_waiting" || scenario === "uncertain" ? "dropped" : scenario === "in_flight" || scenario === "paused" ? "in_flight" : scenario === "claim_waiting" ? "sent" : pick(r, ["sent", "dropped", "in_flight"] as const));
        outcomes.set(request.destination, outcome);
        if (outcome === "dropped") return { answer: "unknown", sendAfter: null };
        if (outcome === "in_flight") return { answer: "accepted", sendAfter: Math.max(0, projectAt - clock) };
        return { answer: "accepted", sendAfter: 0 };
      };
      port.lookupOverride = (work) => (work && work.sendAt === null ? { kind: "not-sent" } : null);
      port.withdrawAnswer = "unknown";
      await h.defineSequence(older.id, track(subset(), scenario === "replied_holding" ? 2 : undefined));
      expect((await h.launch(older.id)).status).toBe(200);
      // The owner's status changes shortly before the projection.
      const before5 = projectAt - (scenario === "pending_reply" ? MIN : 9 * MIN);
      if (scenario === "replied_holding" || scenario === "paused" || scenario === "pending_reply") {
        await h.advanceTo(before5);
        if (scenario === "paused") {
          const db = (h.store.engine as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;
          db.prepare("UPDATE campaigns SET paused_since = ?, version = version + 1 WHERE id = ?").run(clock, older.id);
        } else {
          const delivered = port.deliveries[0];
          const destination = delivered ? port.works.find((w) => w.ref === delivered.ref)?.request.destination : port.works[0]?.request.destination;
          if (destination) port.reply(destination);
        }
      }
      // Up to the projection's instant, without the tick there: work sending then is accepted and not
      // yet reported, as the projection finds it; the provider reports it just before the launch.
      await h.advanceTo(projectAt - 1);
      clock = projectAt;

      await h.defineSequence(newer.id, track(subset()));
      const projected = await projectedSends(h.store, newer.id, h.clock);
      for (const id of await h.store.engine.subjectsOf(older.id)) {
        const s = (await h.store.engine.subject(id, h.clock))!;
        const owner = s.subject.ended ?? (s.campaign.pausedSince !== null ? "paused" : "running");
        for (const w of s.work) if (w.settled === null && w.sentWall === null && !s.attempts.some((a) => a.idempotencyKey === w.key && ["claimed", "handed", "accepted"].includes(a.state))) seen.add(`${owner}: uncertain work no attempt carries`);
        for (const a of s.attempts) {
          if (a.state === "claimed") seen.add(`${owner}: a claim waiting for its slot`);
          if (a.state === "accepted") seen.add(`${owner}: accepted work not yet sent`);
          if (a.state === "handed" && (a.retry === "wanted" || a.retry === "wanted_after_not_sent")) seen.add(`${owner}: a same-key retry waiting`);
          if (a.state === "handed" && a.retry === "refused") seen.add(`${owner}: unresolved work an attempt still carries`);
        }
      }
      if ((await h.store.engine.pendingReplies()).length > 0) seen.add("a reply being matched to its lead");
      if (projected === null) {
        // What the engine cannot settle without the provider or the user withholds the figure, said with the account.
        const view = (await h.request<BeforeLaunchView>("GET", `/api/campaigns/${newer.id}/before-launch`)).body;
        const reasons = (view.load?.cannotProject ?? []).map((c) => c.reason).filter((x) => x === "unsettled_work" || x === "reply_being_matched");
        expect(reasons.length).toBeGreaterThan(0);
        for (const x of reasons) seen.add(`withheld: ${x}`);
        return;
      }
      const before = port.deliveries.length;
      port.onCall = () => ({ answer: "accepted", sendAfter: 0 });
      port.resendDropped = true;
      // Work the provider has accepted sends now, as the projection assumes: the scripted port answers
      // a same-key call for dropped work "accepted" without sending it, which no provider should do.
      const accepted = new Set<string>();
      for (const id of await h.store.engine.subjectsOf(older.id)) for (const a of (await h.store.engine.subject(id, h.clock))!.attempts) if (a.state === "accepted") accepted.add(a.idempotencyKey);
      for (const w of port.works) if (w.sendAt === null && accepted.has(w.key)) w.sendAt = projectAt;
      port.advance();
      expect((await h.launch(newer.id)).status).toBe(200);
      h.maxWrites = 20_000;
      const until = projectAt + 10 * DAY;
      await h.advanceTo(until);
      const mine = new Set(await h.store.engine.subjectsOf(newer.id));
      const fields = (x: { leadId: string; accountId: string; stepId: string; at: number }) => `${x.at} ${x.accountId} ${x.leadId} ${x.stepId}`;
      const actual = port.deliveries.slice(before).filter((d) => mine.has(d.subjectId) && d.at < until).map((d) => fields({ leadId: d.subjectId, accountId: d.sender, stepId: d.stepId, at: d.at })).sort();
      expect(projected.sends.filter((s) => s.at < until).map(fields).sort()).toEqual(actual);
      for (const id of await h.store.engine.subjectsOf(older.id)) {
        const s = (await h.store.engine.subject(id, h.clock))!;
        if (s.attempts.some((a) => a.idempotencyKey !== a.id)) seen.add("a claim that carried uncertain work on");
      }
    });
  }

  const seen = new Set<string>();
  test("the cases reach every state they are for", () => {
    const required = [
      "a claim that carried uncertain work on",
      "a reply being matched to its lead",
      "paused: accepted work not yet sent",
      "replied: accepted work not yet sent",
      "running: a claim waiting for its slot",
      "running: a same-key retry waiting",
      "running: accepted work not yet sent",
      "running: uncertain work no attempt carries",
      "running: unresolved work an attempt still carries",
      "withheld: reply_being_matched",
      "withheld: unsettled_work",
    ];
    expect(required.filter((x) => !seen.has(x) && SEEDS >= 40)).toEqual([]);
  });
});

describe("stored state the engine will go on to change, whoever owns it (review bot on 10121d3; council on 10121d3, item 9)", () => {
  const always = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
  const emails = (pool: string[], waits: number[]): CampaignDefinition => ({
    timezone: "Europe/London",
    callSkipLimitDays: 2,
    emailPool: pool,
    tracks: [{ id: "t1", channel: "email", branch: "main", window: always, start: { kind: "entry" }, removed: false, steps: waits.map((w, i) => ({ id: `s${i + 1}`, waitDays: w, subject: i === 0 ? "Hi" : "", body: "A note.", threading: i === 0 ? "new_subject" : "continue_thread", removed: false })) }],
  });
  const rowsOf = (prefix: string) => ({
    businesses: [business({ business_id: `${prefix}b0`, business_name: `${prefix} Clinic`, timezone: "UTC" })],
    people: [person({ person_id: `${prefix}p0`, business_id: `${prefix}b0`, full_name: `${prefix} Person`, email: `${prefix}0@clinic.example`, timezone: "" })],
  });

  test("a replied lead's accepted follow-up is sent as the projection assumes, so its in-flight place frees and the new campaign sends at once", async () => {
    let clock = Date.parse("2026-11-02T09:00:00Z");
    const port = new ScriptedEmailPort(() => clock, [scriptedInbox("inbox-a", { capacity: 2, gapMs: MIN, resetZone: "UTC" })]);
    const h = new EngineHarness({ start: clock, accounts: [], port, engine: quickWaits });
    Object.defineProperty(h, "clock", { get: () => clock, set: (v: number) => (clock = v) });
    const { campaign: older } = await h.createCampaign("Older", rowsOf("a"));
    const { campaign: newer } = await h.createCampaign("Newer", rowsOf("b"));
    await h.tick();
    const tuesday910 = Date.parse("2026-11-03T09:10:00Z");
    // The opener sends at once; the follow-up is accepted and sends on Tuesday at 09:10.
    port.onCall = (request) => (request.stepId === "s1" ? { answer: "accepted", sendAfter: 0 } : { answer: "accepted", sendAfter: tuesday910 - clock });
    port.withdrawAnswer = "unknown";
    await h.defineSequence(older.id, emails(["inbox-a"], [0, 1]));
    expect((await h.launch(older.id)).status).toBe(200);
    await h.advanceTo(Date.parse("2026-11-03T09:01:00Z"));
    port.reply("a0@clinic.example");
    await h.advanceTo(tuesday910 - 1);
    clock = tuesday910;
    const [replied] = await h.store.engine.subjectsOf(older.id);
    const state = (await h.store.engine.subject(replied!, clock))!;
    expect(state.subject.ended).toBe("replied");
    expect(state.attempts.some((a) => a.state === "accepted")).toBe(true);

    await h.defineSequence(newer.id, emails(["inbox-a"], [0]));
    const projected = await projectedSends(h.store, newer.id, clock);
    port.onCall = () => ({ answer: "accepted", sendAfter: 0 });
    port.advance();
    expect((await h.launch(newer.id)).status).toBe(200);
    await h.advanceTo(tuesday910 + DAY);
    const mine = new Set(await h.store.engine.subjectsOf(newer.id));
    const actual = port.deliveries.filter((d) => mine.has(d.subjectId)).map((d) => d.at);
    expect(actual).toEqual([tuesday910]);
    expect(projected?.sends.map((x) => x.at)).toEqual(actual);
  });

  test("a reply still being matched to its lead may stop that lead: the figure is withheld and the screen says why", async () => {
    let clock = Date.parse("2026-11-02T09:00:00Z");
    const port = new ScriptedEmailPort(() => clock, [scriptedInbox("inbox-a", { capacity: 2, gapMs: H, resetZone: "UTC" })]);
    const h = new EngineHarness({ start: clock, accounts: [], port, engine: quickWaits });
    Object.defineProperty(h, "clock", { get: () => clock, set: (v: number) => (clock = v) });
    const { campaign: older } = await h.createCampaign("Older", { businesses: [business({ business_id: "ab0", business_name: "A Clinic", timezone: "UTC" }), business({ business_id: "ab1", business_name: "A2 Clinic", timezone: "UTC" })], people: [person({ person_id: "ap0", business_id: "ab0", full_name: "A Person", email: "a0@clinic.example", timezone: "" }), person({ person_id: "ap1", business_id: "ab1", full_name: "A Other", email: "a1@clinic.example", timezone: "" })] });
    const { campaign: newer } = await h.createCampaign("Newer", rowsOf("b"));
    await h.tick();
    // The 09:00 email goes, but its answer is lost and its sent event shows only two hours later, so
    // the app does not yet know the thread a reply arrives on.
    port.onCall = () => ({ answer: "unknown", sendAfter: 0, eventDelay: 2 * H });
    await h.defineSequence(older.id, emails(["inbox-a"], [0]));
    expect((await h.launch(older.id)).status).toBe(200);
    await h.advanceTo(Date.parse("2026-11-02T09:10:00Z"));
    port.reply(port.works[0]!.request.destination);
    await h.tick();
    expect((await h.store.engine.pendingReplies()).length).toBe(1);
    await h.defineSequence(newer.id, emails(["inbox-a"], [0]));
    expect(await projectedSends(h.store, newer.id, h.clock)).toBeNull();
    const view = (await h.request<BeforeLaunchView>("GET", `/api/campaigns/${newer.id}/before-launch`)).body;
    expect(view.load?.cannotProject).toEqual([expect.objectContaining({ accountId: "inbox-a", reason: "reply_being_matched" })]);
  });
});

describe("generated: a competing campaign whose email track waits on its calls, which are logged after the projection (council on 10121d3, item 1)", () => {
  const SEEDS = Number(process.env["PROJECTION_SEEDS"] ?? 8);
  for (const seed of Array.from({ length: SEEDS }, (_, i) => 31_000 + i)) {
    test(`case ${seed}`, { timeout: 120_000 }, async () => {
      const r = rng(seed);
      const start = Date.parse("2026-11-02T09:00:00Z");
      const h = new EngineHarness({ start, accounts: [{ id: "inbox-a", capacity: 1 + Math.floor(r() * 3), gapMs: pick(r, [MIN, 7 * MIN]), k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
      expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 50, userZone: "Europe/London" })).status).toBe(200);
      const all = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
      const n = 1 + Math.floor(r() * 3);
      const rows = (prefix: string) => ({
        businesses: Array.from({ length: n }, (_, i) => business({ business_id: `${prefix}b${i}`, business_name: `${prefix} Clinic ${i}`, timezone: "UTC" })),
        people: Array.from({ length: n }, (_, i) => person({ person_id: `${prefix}p${i}`, business_id: `${prefix}b${i}`, full_name: `${prefix} Person${i}`, email: `${prefix}${i}@clinic.example`, timezone: "", direct_phone: `+4420794602${prefix === "a" ? 1 : 2}${i}` })),
      });
      const step = (id: string, body = "A note.", subject = "Hi"): StepDefinition => ({ id, waitDays: 0, subject, body, threading: "new_subject", removed: false });
      const { campaign: older } = await h.createCampaign("Winter physio", rows("a"));
      const { campaign: newer } = await h.createCampaign("Spring physio", rows("b"));
      await h.tick();
      await h.defineSequence(older.id, {
        timezone: "Europe/London",
        callSkipLimitDays: 2,
        emailPool: ["inbox-a"],
        tracks: [
          { id: "p1", channel: "call", branch: "main", window: all, start: { kind: "entry" }, removed: false, steps: [step("c1", "", "")] },
          { id: "e2", channel: "email", branch: "main", window: all, start: { kind: "after", trackId: "p1", delayDays: Math.floor(r() * 2) }, removed: false, steps: [step("s1")] },
        ],
      });
      expect((await h.launch(older.id)).status).toBe(200);
      await h.advanceTo(h.clock + 30 * MIN);
      await h.defineSequence(newer.id, { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], tracks: [{ id: "t1", channel: "email", branch: "main", window: all, start: { kind: "entry" }, removed: false, steps: [step("s1")] }] });
      const view = (await h.request<BeforeLaunchView>("GET", `/api/campaigns/${newer.id}/before-launch`)).body;
      expect(view.load?.withheldBy).toEqual({ campaign: { id: older.id, name: "Winter physio" }, tracks: [{ trackId: "e2", channel: "email", label: "the email track", why: "after_a_phone_track", phoneTrack: "the phone track" }] });
      expect(await projectedSends(h.store, newer.id, h.clock)).toBeNull();
      // The user logs the older campaign's calls after the projection: each releases its email, which
      // then competes for the inbox, so no figure taken before could have been right.
      expect((await h.launch(newer.id)).status).toBe(200);
      await h.advanceTo(h.clock + pick(r, [MIN, 20 * MIN]));
      for (const id of await h.store.engine.subjectsOf(older.id)) {
        const s = (await h.store.engine.subject(id, h.clock))!;
        const task = s.callTasks.find((t) => t.open);
        const number = s.lead.phones.find((x) => !x.bad);
        if (task && number) expect((await h.request("POST", `/api/call-tasks/${task.id}/outcome`, { requestId: `r-${task.id}`, outcome: "no_answer", numberId: number.id, note: "" })).status).toBe(200);
      }
      await h.advanceTo(h.clock + 4 * DAY);
      const released = new Set(await h.store.engine.subjectsOf(older.id));
      expect(h.fake.deliveryLog.filter((d) => released.has(d.subjectId)).length).toBe(n);
    });
  }
});
