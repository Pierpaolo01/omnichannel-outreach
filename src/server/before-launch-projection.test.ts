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
      if (process.env["DBG"]) console.log("CASE", JSON.stringify({ start: new Date(c.start).toISOString(), accounts: c.accounts, zones: c.zones, window: c.definition.tracks[0]!.window, waits: c.definition.tracks[0]!.steps.map((s) => s.waitDays) }), "\nP", JSON.stringify(projected.map((x) => [x.leadId, x.step, x.accountId, new Date(x.at).toISOString()])), "\nA", JSON.stringify(actual.map((x) => [x.leadId, x.step, x.accountId, new Date(x.at).toISOString()])));
      expect(daily.projected).toEqual(daily.actual);
      const exact = (xs: typeof actual) => [...xs].sort((a, b) => a.at - b.at || (a.accountId < b.accountId ? -1 : 1));
      expect(exact(projected)).toEqual(exact(actual));
    });
  }
});
