import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../test/support/engine-harness.ts";
import { business, person } from "../../test/support/export-builder.ts";
import { projectedSends } from "./before-launch.ts";
import { PROJECTION_MAX_STEPS } from "./load-projection.ts";

/**
 * The Before launch projection's work, counted in calls into the engine's rules, never in time
 * (ADR 0003, ticket 14c; the re-check on 2cf1d90 measured a read of 51.76 seconds at 500 leads with a
 * phone track). A fixed campaign of 500 leads, each with a direct line through its company's main line
 * and an email, a phone track at launch and an email track a day after it, a daily call capacity of
 * 25: the count must stay within a stated number, and past the bound the projection stops and shows
 * no figure. Fictitious data only.
 */
async function fixed500() {
  const h = new EngineHarness({ start: Date.parse("2026-11-02T08:00:00Z"), accounts: [{ id: "inbox-a", capacity: 30, gapMs: 60_000, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
  expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 25, userZone: "Europe/London" })).status).toBe(200);
  const n = 500;
  const { campaign } = await h.createCampaign("Five hundred", {
    businesses: Array.from({ length: n }, (_, i) => business({ business_id: `b${i}`, business_name: `Clinic ${i}`, phone_e164: `+4420794${String(10000 + i).padStart(5, "0")}`, phone_original: "", country: "GB" })),
    people: Array.from({ length: n }, (_, i) => person({ person_id: `p${i}`, business_id: `b${i}`, full_name: `Lead Person${i}`, email: `lead${i}@clinic${i}.example` })),
  });
  await h.tick();
  const weekdays = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
  await h.defineSequence(campaign.id, {
    timezone: "Europe/London",
    callSkipLimitDays: 2,
    emailPool: ["inbox-a"],
    smsPool: [],
    callScript: "Ask who books.",
    tracks: [
      { id: "p1", channel: "call", branch: "main", window: weekdays, steps: [{ id: "c1", waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false }], start: { kind: "entry" }, removed: false },
      { id: "e1", channel: "email", branch: "main", window: weekdays, steps: [{ id: "s1", waitDays: 0, subject: "Hi", body: "A note.", threading: "new_subject", removed: false }], start: { kind: "after", trackId: "p1", delayDays: 1 }, removed: false },
    ],
  });
  return { h, id: campaign.id };
}

describe("the projection's work is bounded by a count of engine steps (re-check on 2cf1d90)", () => {
  test("the fixed 500-lead campaign with a phone track takes at most 70,000 steps (57,725 on 14 November 2026)", { timeout: 120_000 }, async () => {
    const { h, id } = await fixed500();
    const projected = await projectedSends(h.store, id, h.clock);
    expect(projected?.tooLarge).toBe(false);
    expect(projected?.steps).toBeLessThanOrEqual(70_000);
    // The figures the screen shows: 25 calls a day, so the last of 500 leads starts on day 26.
    expect([projected?.busiestCallDay, projected?.daysUntilAllStart]).toEqual([25, 26]);
    // The bound is well above it, so a campaign of this size is always estimated.
    expect(PROJECTION_MAX_STEPS).toBeGreaterThan(20 * 70_000);
  });

  test("past its bound the projection stops and shows no figure: the campaign is too large to estimate", { timeout: 120_000 }, async () => {
    const { h, id } = await fixed500();
    expect(await projectedSends(h.store, id, h.clock, { maxSteps: 10_000 })).toBeNull();
  });
});
