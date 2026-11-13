import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../test/support/engine-harness.ts";
import { business, person } from "../../test/support/export-builder.ts";
import type { FakeAccount } from "../../test/support/fake-email-port.ts";
import type { CampaignDefinition, StepDefinition } from "../domain/sequence/definition.ts";
import type { WindowRule } from "../domain/sequence/clock.ts";
import type { BeforeLaunchView } from "../shared/api.ts";
import { localDayNumber, resetDayOf } from "../domain/sequence/clock.ts";
import { projectedSends } from "./before-launch.ts";

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

async function compare(c: Case) {
  const h = new EngineHarness({ start: c.start, accounts: c.accounts });
  const businesses = c.zones.map((zone, i) => business({ business_id: `b${i}`, business_name: `Clinic ${i}`, timezone: zone }));
  const people = c.zones.map((_, i) => person({ person_id: `p${i}`, business_id: `b${i}`, full_name: `Lead Person${i}`, email: `lead${i}@clinic${i}.example`, timezone: "" }));
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
  const kept = projected!.sends.filter((s) => s.at < until);
  return { projected: kept, actual, view, daily: { projected: daily(kept), actual: daily(actual) } };
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
    // The first campaign's waiting lead goes first at the end of the wait, so this one goes one
    // gap later: the projection does not model other campaigns' pending work (ADR 0003, 12c).
    expect(projected!.sends[0]!.at).toBeGreaterThanOrEqual(MONDAY_10 + 2 * MIN);
    expect(sentSecond!.at - projected!.sends[0]!.at).toBeLessThanOrEqual(MIN);
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
