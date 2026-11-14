import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../test/support/engine-harness.ts";
import { business, person } from "../../test/support/export-builder.ts";
import type { FakeAccount } from "../../test/support/fake-email-port.ts";
import type { CampaignDefinition, StepDefinition } from "../domain/sequence/definition.ts";
import type { WindowRule } from "../domain/sequence/clock.ts";
import type { BeforeLaunchView } from "../shared/api.ts";
import { localDayNumber, resetDayOf, startOfLocalDay } from "../domain/sequence/clock.ts";
import { skippedTonight } from "../domain/sequence/calls.ts";
import { callbackHold } from "../domain/sequence/progress.ts";
import { inbox as scriptedInbox, quickWaits } from "../../test/support/regressions.ts";
import { ScriptedEmailPort } from "../../test/support/scripted-email-port.ts";
import { projectedSends, type ProjectionMutation } from "./before-launch.ts";
import { DEFAULT_RULES } from "./engine/rules.ts";
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
    expect(view.load).toMatchObject({ daysUntilAllStart: 1, someNotStartedWithinHorizon: false, cannotProject: [] });
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
      const definition: CampaignDefinition = { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: subset(inboxes).map((x) => x.id), smsPool: subset(numbers).map((x) => x.id), tracks };
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
  /**
   * Ticket 15's stored facts at the projection's instant, in the earlier campaigns, counted over the worlds:
   * a lead held by a callback, a call redialed to the user's next day, a phone track skipped at the skip limit,
   * and a call that the skip limit skips at the end of today unless it is worked.
   */
  const ticket15 = { held: 0, redialed: 0, skipped: 0, expiresTonight: 0 };
  async function logCalls(h: EngineHarness, campaignId: string, r: () => number, after = false) {
    let logged = 0;
    for (const id of await h.store.engine.subjectsOf(campaignId)) {
      const s = (await h.store.engine.subject(id, h.clock))!;
      const task = s.callTasks.find((t) => t.open);
      const number = s.lead.phones.find((n) => !n.bad);
      if (!task || !number || r() < 0.3) continue;
      const outcome = pick(r, ["no_answer", "gatekeeper", "interested", "no_answer", "gatekeeper", "interested", "redial", "callback_requested"] as const);
      const body =
        outcome === "redial" ? { outcome: "no_answer", redial: true }
        : outcome === "callback_requested" ? { outcome, callbackAt: new Date(h.clock + pick(r, [1, 2, 4]) * DAY).toISOString() }
        : { outcome };
      const res = await h.request("POST", `/api/call-tasks/${task.id}/outcome`, { requestId: `r-${task.id}`, ...body, numberId: number.id, note: "" });
      if (res.status !== 200) continue;
      logged++;
      if (!after && outcome !== "redial" && outcome !== "callback_requested") startedFrom.add(outcome === "interested" ? "an interested call ended a lead" : "a logged call touched a lead and finished its phone track");
    }
    return logged;
  }

  async function compareWorld(w: World, seed: number) {
    const h = new EngineHarness({ start: w.start, accounts: w.inboxes, sms: { numbers: w.numbers } });
    expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 50, userZone: "Europe/London" })).status).toBe(200);
    const r = rng(seed + 77);
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
        if ((await logCalls(h, ids[i]!, r)) > 0) await h.advanceTo(h.clock + pick(r, [MIN, 2 * H, DAY]));
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
    // Sometimes days pass with calls left unworked before the projection, so the skip limit has skipped some
    // and some are skipped tonight unless worked (ticket 15). Its own stream, so the worlds above are unchanged.
    const r15 = rng(seed + 1515);
    if (r15() < 0.4) await h.advanceTo(h.clock + pick(r15, [DAY, 2 * DAY, 3 * DAY]));
    for (const id of ids.slice(0, -1)) {
      for (const sid of await h.store.engine.subjectsOf(id)) {
        const st = (await h.store.engine.subject(sid, h.clock))!;
        if (callbackHold(st)) ticket15.held++;
        if (st.callTasks.some((t) => t.open && t.kind === "call" && t.listDay > st.callDay.day)) ticket15.redialed++;
        if (st.tracks.some((p) => p.finishReason === "skipped_unworked")) ticket15.skipped++;
        if (st.callTasks.some((t) => skippedTonight(st, t, h.clock))) ticket15.expiresTonight++;
      }
    }
    const target = ids.at(-1)!;
    const projected = await projectedSends(h.store, target, h.clock);
    const view = (await h.request<BeforeLaunchView>("GET", `/api/campaigns/${target}/before-launch`)).body;
    const already = { email: h.fake.deliveryLog.length, sms: h.sms.deliveryLog.length };
    expect((await h.launch(target)).status).toBe(200);
    const until = w.start + 12 * DAY;
    // The user works every campaign's calls on their day, as the projection assumes (ticket 14c).
    await advanceWorking(h, ids, "Europe/London", until);
    const mine = new Set(await h.store.engine.subjectsOf(target));
    const pickFields = (x: { leadId: string; accountId: string; stepId: string; at: number }) => `${x.at} ${x.accountId} ${x.leadId} ${x.stepId}`;
    const actual = [...h.fake.deliveryLog.slice(already.email), ...h.sms.deliveryLog.slice(already.sms)]
      .filter((d) => mine.has(d.subjectId) && d.at < until)
      .map((d) => pickFields({ leadId: d.subjectId, accountId: d.sender, stepId: d.stepId, at: d.at }))
      .sort();
    const predicted = (projected?.sends ?? []).filter((s) => s.at < until).map(pickFields).sort();
    // Leads whose phone tracks all were skipped for want of a number: nothing of theirs waits on a call.
    const noCall = new Set<string>();
    for (const id of mine) {
      const st = (await h.store.engine.subject(id, h.clock))!;
      const calls = st.campaign.definition.tracks.filter((t) => t.channel === "call" && !t.removed);
      if (calls.every((t) => st.tracks.find((p) => p.trackId === t.id)?.finishReason === "skipped_missing_channel")) noCall.add(id);
    }
    // The calls the engine placed on the user's list for this campaign, by lead, phone track and user
    // day (ticket 14c): nothing is logged after the projection, and the capacity of 50 is never reached.
    const callsActual: string[] = [];
    for (const id of mine) {
      for (const task of (await h.store.engine.subject(id, h.clock))!.callTasks) if (task.placedWall < until) callsActual.push(`${task.listDay} ${id} ${task.trackId}`);
    }
    const callsPredicted = (projected?.calls ?? []).filter((c) => c.at < until).map((c) => `${c.day} ${c.leadId} ${c.trackId}`);
    return { actual, predicted, callsActual: callsActual.sort(), callsPredicted: callsPredicted.sort(), view, projected, noCall, channels: new Set([...h.sms.deliveryLog.slice(already.sms)].filter((d) => mine.has(d.subjectId)).length > 0 ? ["sms"] : []) };
  }

  const SEEDS = Number(process.env["PROJECTION_SEEDS"] ?? 40);
  const texted: boolean[] = [];
  // Found by a 200-world run: a subject changed by evaluation lost its wake at the next track
  // start, so a delayed track started late. They failed before the fix and always run.
  const REGRESSIONS = [13_056, 13_106];
  for (const seed of [...REGRESSIONS, ...Array.from({ length: SEEDS }, (_, i) => 13_000 + i).filter((x) => !REGRESSIONS.includes(x))]) {
    test(`generated multi-track world ${seed}`, async () => {
      const w = world(seed);
      const { actual, predicted, callsActual, callsPredicted, view, projected, noCall, channels } = await compareWorld(w, seed);
      texted.push(channels.has("sms"));
      // Every track has a sender in these worlds, so nothing is withheld: a track after a phone track is
      // projected too, its call worked on its day with no answer, as the engine's user works it (ticket 14c).
      expect(view.load?.withheldBy ?? null).toBeNull();
      expect(predicted).toEqual(actual);
      // The calls too: placed by the engine's own rules, on the same user day.
      expect(callsPredicted).toEqual(callsActual);
      if (callsActual.length > 0) calledWorlds.push(seed);
      const def = w.campaigns.at(-1)!.definition;
      const afterCall = new Set(def.tracks.filter((t) => t.start.kind === "after" && def.tracks.find((x) => x.id === (t.start as { trackId: string }).trackId)?.channel === "call").map((t) => t.id));
      if ((projected?.sends ?? []).some((x) => afterCall.has(x.trackId) && !noCall.has(x.leadId))) afterCallWorlds.push(seed);
    });
  }
  const afterCallWorlds: number[] = [];
  const calledWorlds: number[] = [];
  test("the projected worlds place calls (ticket 14c)", () => {
    expect(calledWorlds.length).toBeGreaterThan(SEEDS / 8);
  });
  test("the worlds start from logged calls, interested calls and a paused competing campaign", () => {
    expect([...startedFrom].sort()).toEqual(
      ["a logged call touched a lead and finished its phone track", "a paused competing campaign", "a track after a phone track started when its call was logged", "an interested call ended a lead"].filter((x) => SEEDS >= 40 || startedFrom.has(x)),
    );
  });
  test("the worlds start from ticket 15's stored facts: a lead held by a callback, a call redialed to the next day, a call skipped at its skip limit, and a call that is skipped tonight unless worked", () => {
    if (SEEDS < 40) return;
    expect(ticket15).toMatchObject({ held: expect.any(Number), redialed: expect.any(Number), skipped: expect.any(Number), expiresTonight: expect.any(Number) });
    expect(Math.min(ticket15.held, ticket15.redialed, ticket15.skipped, ticket15.expiresTonight)).toBeGreaterThan(0);
  });
  test("the worlds include tracks after a phone track that send once its call is worked (ticket 14c)", () => {
    expect(afterCallWorlds.length).toBeGreaterThan(0);
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

describe("generated: a competing campaign whose email track waits on its calls, the user working each day's list (council on 10121d3, item 1; ticket 14c)", () => {
  const SEEDS = Number(process.env["PROJECTION_SEEDS"] ?? 8);
  for (const seed of Array.from({ length: SEEDS }, (_, i) => 31_000 + i)) {
    test(`case ${seed}`, { timeout: 120_000 }, async () => {
      const r = rng(seed);
      const start = Date.parse("2026-11-02T09:00:00Z");
      const h = new EngineHarness({ start, accounts: [{ id: "inbox-a", capacity: 1 + Math.floor(r() * 3), gapMs: pick(r, [MIN, 7 * MIN]), k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
      expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 1 + Math.floor(r() * 3), userZone: "Europe/London" })).status).toBe(200);
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
      // The newer campaign has no call of its own, but shares the inbox with one whose email track waits
      // on calls: those calls are placed and worked in the simulation, and the figure is shown, naming
      // the campaign whose calls it assumes worked.
      const view = (await h.request<BeforeLaunchView>("GET", `/api/campaigns/${newer.id}/before-launch`)).body;
      expect(view.load?.withheldBy).toBeNull();
      expect(view.load?.callsNotCounted).toEqual([{ id: older.id, name: "Winter physio" }]);
      const projected = await projectedSends(h.store, newer.id, h.clock);
      expect((await h.launch(newer.id)).status).toBe(200);
      const until = start + 6 * DAY;
      await advanceWorking(h, [older.id, newer.id], "Europe/London", until);
      const mine = new Set(await h.store.engine.subjectsOf(newer.id));
      const line = (x: { leadId: string; accountId: string; stepId: string; at: number }) => `${x.at} ${x.accountId} ${x.leadId} ${x.stepId}`;
      const actual = h.fake.deliveryLog.filter((d) => mine.has(d.subjectId) && d.at < until).map((d) => line({ leadId: d.subjectId, accountId: d.sender, stepId: d.stepId, at: d.at }));
      expect((projected?.sends ?? []).filter((x) => x.at < until).map(line).sort()).toEqual(actual.sort());
      // The older campaign's emails really waited on its calls and competed for the inbox.
      const released = new Set(await h.store.engine.subjectsOf(older.id));
      expect(h.fake.deliveryLog.filter((d) => released.has(d.subjectId)).length).toBe(n);
    });
  }
});

/**
 * The user the projection assumes (ADR 0003, ticket 14c): every call on the list is worked by the end
 * of its user day, in the day's last second, and logged as no answer on a good number of the lead's.
 * A logged call can release another phone track at once, whose call the engine then places: the user
 * works that one too, so the sweep repeats, with a tick between, until no call on the list is left
 * that an outcome is accepted on (council on 2cf1d90, item 1).
 */
async function workTheList(h: EngineHarness, campaignIds: readonly string[]) {
  for (let sweep = 0; sweep < 50; sweep++) {
    let logged = 0;
    for (const cid of campaignIds) {
      for (const id of await h.store.engine.subjectsOf(cid)) {
        const s = (await h.store.engine.subject(id, h.clock))!;
        const number = s.lead.phones.find((n) => !n.bad);
        for (const task of s.callTasks.filter((t) => t.open)) {
          if (!number) continue;
          const res = await h.request("POST", `/api/call-tasks/${task.id}/outcome`, { requestId: `w-${task.id}`, outcome: "no_answer", numberId: number.id, note: "" });
          if (res.status === 200) logged++;
        }
      }
    }
    if (logged === 0) return;
    await h.tick();
  }
}
/** The last second of the user day `t` falls in. */
const lastSecondOf = (t: number, zone: string) => startOfLocalDay(localDayNumber(t, zone) + 1, zone) - 1000;
/** Runs the engine to `until`, the user working the list in the last second of every user day. */
async function advanceWorking(h: EngineHarness, campaignIds: readonly string[], zone: string, until: number) {
  while (h.clock < until) {
    const end = lastSecondOf(h.clock, zone);
    if (end > h.clock) {
      await h.advanceTo(Math.min(end, until));
      if (h.clock < end) break;
      await workTheList(h, campaignIds);
    }
    await h.advanceTo(Math.min(end + 2000, until));
  }
}

describe("the time of day a call is logged is part of the stated assumption (re-check on 2cf1d90, B2)", () => {
  /** Two leads with an email; only Caller One has a phone number. A phone track at launch, an email track right after it. */
  async function twoLeads() {
    const start = Date.parse("2026-11-09T08:00:00Z");
    const h = new EngineHarness({ start, accounts: [{ id: "inbox-0", capacity: 30, gapMs: MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
    expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 1, userZone: "Europe/London" })).status).toBe(200);
    const { campaign } = await h.createCampaign("Two leads", {
      businesses: [business({ business_id: "b1", business_name: "Clinic One", timezone: "Europe/London" }), business({ business_id: "b2", business_name: "Clinic Two", timezone: "Europe/London" })],
      people: [
        person({ person_id: "p1", business_id: "b1", full_name: "Caller One", email: "one@clinic1.example", timezone: "", direct_phone: "+442079462301" }),
        person({ person_id: "p2", business_id: "b2", full_name: "Email Two", email: "two@clinic2.example", timezone: "" }),
      ],
    });
    await h.tick();
    const nineToFive = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 9, end: 17 }));
    await h.defineSequence(campaign.id, {
      timezone: "Europe/London",
      callSkipLimitDays: 2,
      emailPool: ["inbox-0"],
      smsPool: [],
      callScript: "Ask who books.",
      tracks: [
        { id: "p", channel: "call", branch: "main", window: nineToFive, steps: [{ id: "c", waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false }], start: { kind: "entry" }, removed: false, callSkipLimitDays: 2 },
        { id: "e", channel: "email", branch: "main", window: nineToFive, steps: [{ id: "s", waitDays: 0, subject: "Hi", body: "A note.", threading: "new_subject", removed: false }], start: { kind: "after", trackId: "p", delayDays: 0 }, removed: false },
      ],
    });
    const projected = await projectedSends(h.store, campaign.id, h.clock);
    expect((await h.launch(campaign.id)).status).toBe(200);
    const busiest = () => Math.max(...[...h.fake.deliveryLog.reduce((m, d) => m.set(localDayNumber(d.at, "Europe/London"), (m.get(localDayNumber(d.at, "Europe/London")) ?? 0) + 1), new Map<number, number>()).values()]);
    return { h, id: campaign.id, start, projected, busiest };
  }

  test("logged at the end of the day, as the screen now states, the engine sends one email a day, the projected busiest day", async () => {
    const { h, id, start, projected, busiest } = await twoLeads();
    expect(projected?.busiestDay.get("inbox-0")).toBe(1);
    await advanceWorking(h, [id], "Europe/London", start + 3 * DAY);
    expect(h.fake.deliveryLog).toHaveLength(2);
    expect(busiest()).toBe(1);
  });

  test("logged at 10:00 instead, the email after the call goes that day too: two in one day, which is why the screen names the time", async () => {
    const { h, id, start, busiest } = await twoLeads();
    await h.advanceTo(start + 2 * 60 * MIN);
    for (const sid of await h.store.engine.subjectsOf(id)) {
      const s = (await h.store.engine.subject(sid, h.clock))!;
      const task = s.callTasks.find((t) => t.open);
      if (task) expect((await h.request("POST", `/api/call-tasks/${task.id}/outcome`, { requestId: `ten-${task.id}`, outcome: "no_answer", numberId: s.lead.phones[0]!.id, note: "" })).status).toBe(200);
    }
    await h.advanceTo(start + 3 * DAY);
    expect(busiest()).toBe(2);
  });
});

describe("a call released by a worked call is worked the same day (council on 2cf1d90, item 1)", () => {
  test("an older campaign's call B right after call A: both its calls and the target's two calls take Tuesday's room of 2, as the engine places them", async () => {
    const start = Date.parse("2026-11-02T09:00:00Z");
    const h = new EngineHarness({ start, accounts: [{ id: "inbox-0", capacity: 50, gapMs: MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
    expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 2, userZone: "Europe/London" })).status).toBe(200);
    const allDay = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
    const call = (id: string, start: CampaignDefinition["tracks"][number]["start"]) => ({ id, channel: "call" as const, branch: "main" as const, window: allDay, steps: [{ id: `${id}1`, waitDays: 0, subject: "", body: "", threading: "new_subject" as const, removed: false }], start, removed: false, callSkipLimitDays: 2 });
    const rows = (prefix: string, n: number) => ({
      businesses: Array.from({ length: n }, (_, i) => business({ business_id: `${prefix}b${i}`, business_name: `${prefix} Clinic ${i}`, timezone: "Europe/London", phone_e164: `+4420794622${prefix === "o" ? 1 : 2}${i}`, phone_original: "", country: "GB" })),
      people: Array.from({ length: n }, (_, i) => person({ person_id: `${prefix}p${i}`, business_id: `${prefix}b${i}`, full_name: `${prefix} Person${i}`, email: "", timezone: "" })),
    });
    const { campaign: older } = await h.createCampaign("Older", rows("o", 1));
    const { campaign: target } = await h.createCampaign("Target", rows("t", 2));
    await h.tick();
    await h.defineSequence(older.id, { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: [], smsPool: [], callScript: "", tracks: [call("a", { kind: "entry" }), call("b", { kind: "after", trackId: "a", delayDays: 0 })] });
    expect((await h.launch(older.id)).status).toBe(200);
    const email = { id: "e", channel: "email" as const, branch: "main" as const, window: allDay, steps: [{ id: "e1", waitDays: 0, subject: "Hello", body: "A note.", threading: "new_subject" as const, removed: false }], start: { kind: "entry" as const }, removed: false };
    await h.defineSequence(target.id, { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-0"], smsPool: [], callScript: "", tracks: [email, call("c", { kind: "after", trackId: "e", delayDays: 1 })] });
    const projected = await projectedSends(h.store, target.id, h.clock);
    expect((await h.launch(target.id)).status).toBe(200);
    await advanceWorking(h, [older.id, target.id], "Europe/London", start + 6 * DAY);
    const days: number[] = [];
    for (const id of await h.store.engine.subjectsOf(target.id)) for (const task of (await h.store.engine.subject(id, h.clock))!.callTasks) days.push(task.listDay - localDayNumber(start, "Europe/London") + 1);
    // The engine: Monday A and B (B released by A's outcome, worked the same day); Tuesday both target calls.
    expect(days.sort()).toEqual([2, 2]);
    expect(projected?.calls.map((c) => c.day - localDayNumber(start, "Europe/London") + 1).sort()).toEqual([2, 2]);
    expect(projected?.busiestCallDay).toBe(2);
    expect(projected?.daysUntilAllStart).toBe(2);
  });
});

describe("a worked call touches its lead, whose next call then goes first: the start horizon is the engine's (review bot on 5cd8a93)", () => {
  test("three leads reached only by phone, capacity 1, call A at launch and call B a day after a skipped email track: the last lead starts on day 5, as the engine starts it", async () => {
    const start = Date.parse("2026-11-02T09:00:00Z");
    const h = new EngineHarness({ start, accounts: [{ id: "inbox-0", capacity: 50, gapMs: MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
    expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 1, userZone: "Europe/London" })).status).toBe(200);
    const leads = [1, 2, 3];
    const { campaign } = await h.createCampaign("Calls only", {
      businesses: leads.map((i) => business({ business_id: `b${i}`, business_name: `Clinic ${i}`, timezone: "Europe/London", phone_e164: `+44207946210${i}`, phone_original: "", country: "GB" })),
      people: leads.map((i) => person({ person_id: `p${i}`, business_id: `b${i}`, full_name: `Lead Person${i}`, email: "", timezone: "" })),
    });
    await h.tick();
    const daily = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 9, end: 17 }));
    const call = (id: string, start: CampaignDefinition["tracks"][number]["start"]) => ({ id, channel: "call" as const, branch: "main" as const, window: daily, steps: [{ id: `${id}1`, waitDays: 0, subject: "", body: "", threading: "new_subject" as const, removed: false }], start, removed: false, callSkipLimitDays: 2 });
    const email = { id: "e", channel: "email" as const, branch: "main" as const, window: daily, steps: [{ id: "e1", waitDays: 0, subject: "Hello", body: "A note.", threading: "new_subject" as const, removed: false }], start: { kind: "entry" as const }, removed: false };
    await h.defineSequence(campaign.id, { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-0"], smsPool: [], callScript: "Ask who books.", tracks: [email, call("a", { kind: "entry" }), call("b", { kind: "after", trackId: "e", delayDays: 1 })] });
    const projected = await projectedSends(h.store, campaign.id, h.clock);
    expect((await h.launch(campaign.id)).status).toBe(200);
    await advanceWorking(h, [campaign.id], "Europe/London", start + 10 * DAY);
    const firstDay = new Map<string, number>();
    const placed: string[] = [];
    for (const id of await h.store.engine.subjectsOf(campaign.id)) {
      for (const task of (await h.store.engine.subject(id, h.clock))!.callTasks) {
        placed.push(`${task.listDay} ${id} ${task.trackId}`);
        firstDay.set(id, Math.min(firstDay.get(id) ?? Infinity, task.listDay));
      }
    }
    // The engine: A1 Monday, B1 Tuesday (touched lead 1 first), A2 Wednesday, B2 Thursday, A3 Friday.
    const engineDays = localDayNumber(Math.max(...[...firstDay.values()].map((d) => startOfLocalDay(d, "Europe/London"))), "Europe/London") - localDayNumber(start, "Europe/London") + 1;
    expect(engineDays).toBe(5);
    expect(projected?.daysUntilAllStart).toBe(engineDays);
    expect((projected?.calls ?? []).filter((c) => c.at < start + 10 * DAY).map((c) => `${c.day} ${c.leadId} ${c.trackId}`).sort()).toEqual(placed.sort());
  });
});

describe("generated: calls placed within a tight daily call capacity, the user working each day's list (ADR 0003, ticket 14c)", () => {
  /**
   * Worlds whose calls do not fit one day: a daily call capacity of 1 to 3, one or two campaigns
   * sharing the user's list, each with an email track at launch and one to three phone tracks with
   * different due dates (at launch, after the email track plus one or two days, after another phone
   * track), and sometimes an email track after a call. Its inbox never runs short. People with and
   * without an email, a direct line or a mobile, at companies with and without a main line, in
   * several zones. The test user works every call on the list in the last second of each user day,
   * logging no answer: the projection's stated assumption, which it applies with the engine's own
   * `logCallOutcome` at the same instant. So a worked call touches its lead, whose later calls and
   * messages go first, and finishes its phone track, releasing the tracks after it (review bot on
   * 5cd8a93). The projection taken just before the last campaign launches must place exactly the
   * engine's calls (lead, phone track, user day), make exactly its sends, start every lead on the
   * engine's day, and give the engine's horizon.
   */
  const CALLING: readonly (readonly WindowRule[])[] = [
    [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })),
    [1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 10, end: 19 })),
    [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 8, end: 20 })),
    [2, 4].map((day) => ({ day, start: 14, end: 18 })),
  ];
  const DAILY = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 8, end: 18 }));
  function world(seed: number) {
    const r = rng(seed);
    const userZone = pick(r, ["Europe/London", "America/New_York"] as const);
    const capacity = 1 + Math.floor(r() * 3);
    const people = Array.from({ length: 3 + Math.floor(r() * 6) }, () => ({ zone: pick(r, ZONES), email: r() < 0.7, direct: r() < 0.5, mobile: r() < 0.3, mainLine: r() < 0.5 }));
    const campaigns = Array.from({ length: 1 + Math.floor(r() * 2) }, (_, c) => {
      const tracks: CampaignDefinition["tracks"][number][] = [{ id: `c${c}e`, channel: "email", branch: "main", window: DAILY, steps: [{ id: `c${c}e1`, waitDays: 0, subject: "Hello", body: "A note.", threading: "new_subject", removed: false }], start: { kind: "entry" }, removed: false }];
      for (let k = 0; k < 1 + Math.floor(r() * 3); k++) {
        const earlierCalls = tracks.filter((t) => t.channel === "call");
        const roll = r();
        const start: CampaignDefinition["tracks"][number]["start"] =
          roll < 0.35 ? { kind: "entry" } : roll < 0.7 || earlierCalls.length === 0 ? { kind: "after", trackId: `c${c}e`, delayDays: 1 + Math.floor(r() * 2) } : { kind: "after", trackId: pick(r, earlierCalls).id, delayDays: Math.floor(r() * 3) };
        tracks.push({ id: `c${c}p${k}`, channel: "call", branch: "main", window: pick(r, CALLING), steps: [{ id: `c${c}p${k}s`, waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false }], start, removed: false, callSkipLimitDays: 2 });
      }
      if (r() < 0.4) tracks.push({ id: `c${c}f`, channel: "email", branch: "main", window: DAILY, steps: [{ id: `c${c}f1`, waitDays: 0, subject: "After the call", body: "A note.", threading: "new_subject", removed: false }], start: { kind: "after", trackId: pick(r, tracks.filter((t) => t.channel === "call")).id, delayDays: Math.floor(r() * 2) }, removed: false });
      const definition: CampaignDefinition = { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-0"], smsPool: [], callScript: "Ask who handles bookings.", tracks };
      const leads = people.map((_, i) => i).filter(() => r() < 0.75);
      return { definition, leads: leads.length > 0 ? leads : [0], launchAfterMs: Math.floor(r() * 4) * 3 * H };
    });
    // Sometimes the user leaves the earlier campaigns' calls unworked before the last launch, so the
    // projection starts from calls carried on the list (the store's committed count); the last
    // campaign's first phone track then calls at launch, at any hour, so those carried calls take its
    // first day's room.
    const idleBefore = campaigns.length > 1 && r() < 0.5;
    const last = campaigns.at(-1)!;
    if (idleBefore) last.definition = { ...last.definition, tracks: last.definition.tracks.map((t, i) => (i === 1 ? { ...t, start: { kind: "entry" as const }, window: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 })) } : t)) };
    return { start: pick(r, ANCHORS) + Math.floor(r() * 5) * MIN, userZone, capacity, people, campaigns, idleBefore };
  }

  async function compareCalls(seed: number, broken: ProjectionMutation = {}) {
    const w = world(seed);
    const h = new EngineHarness({ start: w.start, accounts: [{ id: "inbox-0", capacity: 500, gapMs: MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
    expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: w.capacity, userZone: w.userZone })).status).toBe(200);
    const rows = (leads: readonly number[]) => ({
      businesses: leads.map((i) => business({ business_id: `b${i}`, business_name: `Clinic ${i}`, timezone: w.people[i]!.zone, ...(w.people[i]!.mainLine ? { phone_e164: `+4420794620${String(i).padStart(2, "0")}`, phone_original: "", country: "GB" } : {}) })),
      people: leads.map((i) =>
        person({
          person_id: `p${i}`,
          business_id: `b${i}`,
          full_name: `Lead Person${i}`,
          email: w.people[i]!.email ? `lead${i}@clinic${i}.example` : "",
          timezone: "",
          ...(w.people[i]!.direct ? { direct_phone: `+4420794630${String(i).padStart(2, "0")}` } : {}),
          ...(w.people[i]!.mobile ? { dial_phone: mobileOf(i), dial_phone_type: "mobile" } : {}),
        }),
      ),
    });
    const ids: string[] = [];
    for (const [i, c] of w.campaigns.entries()) ids.push((await h.createCampaign(`Campaign ${i}`, rows(c.leads))).campaign.id);
    await h.tick();
    h.maxWrites = 20_000;
    for (const [i, c] of w.campaigns.entries()) {
      await h.defineSequence(ids[i]!, c.definition);
      if (i === w.campaigns.length - 1) break;
      expect((await h.launch(ids[i]!)).status).toBe(200);
      if (w.idleBefore) await h.advanceTo(h.clock + c.launchAfterMs + 2 * DAY);
      else await advanceWorking(h, ids, w.userZone, h.clock + c.launchAfterMs + 2 * H);
    }
    // The projection also starts from calls the user has already logged today on the earlier campaigns
    // (council on 2cf1d90, item 6), on a stream of its own so the worlds stay as generated: a call
    // skipped for now (still on today's list, at its end), a voicemail (finished, the lead touched),
    // and a wrong number (marked bad: the assumed user then logs on the lead's next good number, and a
    // lead whose only number it was is skipped). People are shared, so the marks reach the last campaign.
    const r3 = rng(seed + 991);
    const startedFrom = new Set<string>();
    for (const cid of ids.slice(0, -1)) {
      for (const sid of await h.store.engine.subjectsOf(cid)) {
        const st = (await h.store.engine.subject(sid, h.clock))!;
        const task = st.callTasks.find((t) => t.open);
        const number = st.lead.phones.find((n) => !n.bad);
        if (!task || !number || r3() < 0.25) continue;
        const outcome = pick(r3, ["skip_for_now", "voicemail", "wrong_number"] as const);
        const res = await h.request("POST", `/api/call-tasks/${task.id}/outcome`, { requestId: `s-${task.id}`, outcome, numberId: outcome === "skip_for_now" ? null : number.id, note: "" });
        if (res.status === 200) startedFrom.add(outcome);
      }
    }
    await h.tick();
    const carried = (await h.store.engine.callDay(h.clock)).committed > 0;
    const target = ids.at(-1)!;
    const launchedAt = h.clock;
    const projected = await projectedSends(h.store, target, h.clock, broken);
    const until = h.clock + 12 * DAY;
    const already = h.fake.deliveryLog.length;
    expect((await h.launch(target)).status).toBe(200);
    await advanceWorking(h, ids, w.userZone, until);
    const mine = await h.store.engine.subjectsOf(target);
    const calls: string[] = [];
    const firstAt = new Map<string, number>();
    const first = (id: string, at: number) => firstAt.set(id, Math.min(firstAt.get(id) ?? Infinity, at));
    for (const id of mine) {
      for (const task of (await h.store.engine.subject(id, h.clock))!.callTasks) {
        if (task.placedWall >= until) continue;
        calls.push(`${task.listDay} ${id} ${task.trackId}`);
        first(id, task.placedWall);
      }
    }
    const sent = h.fake.deliveryLog.slice(already).filter((d) => mine.includes(d.subjectId) && d.at < until);
    for (const d of sent) first(d.subjectId, d.at);
    const predictedFirst = new Map<string, number>();
    const pfirst = (id: string, at: number) => at < until && predictedFirst.set(id, Math.min(predictedFirst.get(id) ?? Infinity, at));
    for (const c of projected?.calls ?? []) pfirst(c.leadId, c.at);
    for (const x of projected?.sends ?? []) pfirst(x.leadId, x.at);
    const dayOf = (at: number) => localDayNumber(at, "Europe/London") - localDayNumber(launchedAt, "Europe/London") + 1;
    const starts = (m: Map<string, number>) => [...m].map(([id, at]) => `${id} day ${dayOf(at)}`).sort();
    // The horizon: the day the last lead some track can reach starts, when every one did before `until`.
    const horizon = firstAt.size === projected?.leadsToStart ? Math.max(...[...firstAt.values()].map(dayOf)) : null;
    return {
      calls: calls.sort(),
      predictedCalls: (projected?.calls ?? []).filter((c) => c.at < until).map((c) => `${c.day} ${c.leadId} ${c.trackId}`).sort(),
      sends: sent.map((d) => `${d.at} ${d.subjectId} ${d.stepId}`).sort(),
      predictedSends: (projected?.sends ?? []).filter((x) => x.at < until).map((x) => `${x.at} ${x.leadId} ${x.stepId}`).sort(),
      starts: starts(firstAt),
      predictedStarts: starts(predictedFirst),
      horizon,
      projected,
      spread: new Set(calls.map((a) => a.split(" ")[0])).size > 1,
      carried,
      twoCalls: w.campaigns.some((c) => c.definition.tracks.filter((t) => t.channel === "call").length > 1),
      startedFrom,
    };
  }

  const SEEDS = Number(process.env["PROJECTION_SEEDS"] ?? 30);
  const coverage = { spread: 0, carried: 0, twoCalls: 0, horizons: 0, startedFrom: new Set<string>() };
  for (const seed of Array.from({ length: SEEDS }, (_, i) => 14_300 + i)) {
    test(`generated calling world ${seed}`, async () => {
      const out = await compareCalls(seed);
      expect(out.projected).not.toBeNull();
      expect(out.predictedCalls).toEqual(out.calls);
      expect(out.predictedSends).toEqual(out.sends);
      // Every lead starts on the engine's day, and the horizon is the engine's.
      expect(out.predictedStarts).toEqual(out.starts);
      if (out.horizon !== null) {
        expect(out.projected?.daysUntilAllStart).toBe(out.horizon);
        coverage.horizons++;
      }
      coverage.spread += out.spread ? 1 : 0;
      coverage.carried += out.carried ? 1 : 0;
      coverage.twoCalls += out.twoCalls ? 1 : 0;
      for (const x of out.startedFrom) coverage.startedFrom.add(x);
    });
  }
  test("the worlds' calls take more than one day's room, some start from calls carried on the list, many have several phone tracks, and the horizon is compared", () => {
    expect(coverage.spread).toBeGreaterThan(SEEDS / 3);
    expect(coverage.carried).toBeGreaterThan(0);
    expect(coverage.twoCalls).toBeGreaterThan(SEEDS / 3);
    expect(coverage.horizons).toBeGreaterThan(SEEDS / 3);
    // The worlds start from a call skipped for now today, a voicemail and a wrong number.
    expect([...coverage.startedFrom].sort()).toEqual(["skip_for_now", "voicemail", "wrong_number"]);
  });

  // Each mutation of the projection alone must make a world disagree with the engine (ADR 0003, ticket 14c),
  // checked on its recorded killing seed (the first from 14,300 that kills it, found by a sweep on the merge
  // of ticket 15a), so no test searches against the clock.
  const MUTATIONS: Record<string, { broken: ProjectionMutation; seed: number }> = {
    "ready calls placed in reversed priority": { seed: 14_300, broken: { rules: { ...DEFAULT_RULES, callOrder: (a, b) => DEFAULT_RULES.callOrder(b, a) } } },
    "the calls carried on today's list left out": { seed: 14_326, broken: { callDay: (d) => ({ ...d, committed: 0 }) } },
    // The bot's finding on 5cd8a93: the call is worked, but the lead is not touched by it.
    "a worked call that does not touch its lead": { seed: 14_302, broken: { rules: { ...DEFAULT_RULES, logCallOutcome: (s, ...rest) => { const out = DEFAULT_RULES.logCallOutcome(s, ...rest); return out.ok ? { ...out, state: { ...out.state, subject: { ...out.state.subject, touched: s.subject.touched } } } : out; } } } },
  };
  for (const [name, { broken, seed }] of Object.entries(MUTATIONS)) {
    test(`the mutation "${name}" makes world ${seed} disagree, and the world agrees without it`, { timeout: 120_000 }, async () => {
      const out = await compareCalls(seed, broken);
      expect(JSON.stringify([out.predictedCalls, out.predictedSends, out.predictedStarts])).not.toBe(JSON.stringify([out.calls, out.sends, out.starts]));
      const sound = await compareCalls(seed);
      expect(JSON.stringify([sound.predictedCalls, sound.predictedSends, sound.predictedStarts])).toBe(JSON.stringify([sound.calls, sound.sends, sound.starts]));
    });
  }
});
