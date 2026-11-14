import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../test/support/engine-harness.ts";
import { business, person } from "../../test/support/export-builder.ts";
import type { BeforeLaunchView } from "../shared/api.ts";
import { projectedSends, projectionStop } from "./before-launch.ts";
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
    expect(projected?.stop).toEqual({ reason: "complete" });
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

describe("no bound yields part of a projection (review bot on 93bcc0c, the horizon)", () => {
  test("an email track with a follow-up 120 days on and an SMS track after it: every bound below the full run gives no figure or the whole of it", { timeout: 300_000 }, async () => {
    const start = Date.parse("2026-11-02T09:00:00Z");
    const h = new EngineHarness({ start, accounts: [{ id: "inbox-a", capacity: 30, gapMs: 60_000, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }], sms: { numbers: [{ id: "+447700900001", capacity: 30, gapMs: null, k: 1, healthy: true, resetZone: "UTC" }] } });
    const { campaign } = await h.createCampaign("Horizon", {
      businesses: [business({ business_id: "b1", business_name: "Clinic One", timezone: "UTC" })],
      people: [person({ person_id: "p1", business_id: "b1", full_name: "Lead One", email: "one@clinic1.example", timezone: "", dial_phone: "+447700900211", dial_phone_type: "mobile" })],
    });
    await h.tick();
    const daily = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 9, end: 17 }));
    await h.defineSequence(campaign.id, {
      timezone: "UTC",
      callSkipLimitDays: 2,
      emailPool: ["inbox-a"],
      smsPool: ["+447700900001"],
      tracks: [
        { id: "e", channel: "email", branch: "main", window: daily, start: { kind: "entry" }, removed: false, steps: [{ id: "e1", waitDays: 0, subject: "Hi", body: "A note.", threading: "new_subject", removed: false }, { id: "e2", waitDays: 120, subject: "", body: "Again.", threading: "continue_thread", removed: false }] },
        { id: "m", channel: "sms", branch: "main", window: daily, start: { kind: "after", trackId: "e", delayDays: 0 }, removed: false, steps: [{ id: "s1", waitDays: 0, subject: "", body: "A text.", threading: "new_subject", removed: false }] },
      ],
    });
    const full = await projectedSends(h.store, campaign.id, h.clock);
    expect(full?.sends.map((x) => x.stepId)).toEqual(["e1", "e2", "s1"]);
    const whole = JSON.stringify(full?.sends);
    for (let bound = 0; bound < (full?.steps ?? 0); bound++) {
      const partial = await projectedSends(h.store, campaign.id, h.clock, { maxSteps: bound });
      if (partial !== null) expect([bound, JSON.stringify(partial.sends)]).toEqual([bound, whole]);
    }
  });
});

/**
 * A projection that stops early says why on itself, set where it stops, and the screen shows no figure
 * unless the run reached its end unbounded (review bot on dc9555b; coordinator's ruling). Fictitious data only.
 */
describe("a projection says why it stopped, and only a whole run shows a figure (review bot on dc9555b)", () => {
  const daily = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 9, end: 17 }));
  const inbox = { id: "inbox-a", capacity: 30, gapMs: 60_000, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" };

  /** One lead, an email now, a follow-up on the estimate's last day (day 120) and another 100 days after it: past the horizon. */
  async function pastTheHorizon() {
    const h = new EngineHarness({ start: Date.parse("2026-11-02T09:00:00Z"), accounts: [inbox] });
    const { campaign } = await h.createCampaign("Past the horizon", {
      businesses: [business({ business_id: "b1", business_name: "Clinic One", timezone: "UTC" })],
      people: [person({ person_id: "p1", business_id: "b1", full_name: "Lead One", email: "one@clinic1.example", timezone: "" })],
    });
    await h.tick();
    await h.defineSequence(campaign.id, {
      timezone: "UTC",
      callSkipLimitDays: 2,
      emailPool: ["inbox-a"],
      tracks: [{ id: "e", channel: "email", branch: "main", window: daily, start: { kind: "entry" }, removed: false, steps: [{ id: "e1", waitDays: 0, subject: "Hi", body: "A note.", threading: "new_subject", removed: false }, { id: "e2", waitDays: 119, subject: "", body: "Again.", threading: "continue_thread", removed: false }, { id: "e3", waitDays: 100, subject: "", body: "Once more.", threading: "continue_thread", removed: false }] }],
    });
    return { h, id: campaign.id };
  }

  /** Three leads with a direct line, a phone track at launch and an email track after it: the assumed user logs calls each evening. */
  async function threeCalls() {
    const h = new EngineHarness({ start: Date.parse("2026-11-02T08:00:00Z"), accounts: [inbox] });
    expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 2, userZone: "Europe/London" })).status).toBe(200);
    const { campaign } = await h.createCampaign("Three calls", {
      businesses: [0, 1, 2].map((i) => business({ business_id: `b${i}`, business_name: `Clinic ${i}`, phone_e164: `+44207941000${i}`, phone_original: "", country: "GB" })),
      people: [0, 1, 2].map((i) => person({ person_id: `p${i}`, business_id: `b${i}`, full_name: `Lead Person${i}`, email: `lead${i}@clinic${i}.example` })),
    });
    await h.tick();
    await h.defineSequence(campaign.id, {
      timezone: "Europe/London",
      callSkipLimitDays: 2,
      emailPool: ["inbox-a"],
      callScript: "Ask who books.",
      tracks: [
        { id: "p1", channel: "call", branch: "main", window: daily, steps: [{ id: "c1", waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false }], start: { kind: "entry" }, removed: false },
        { id: "e1", channel: "email", branch: "main", window: daily, steps: [{ id: "s1", waitDays: 0, subject: "Hi", body: "A note.", threading: "new_subject", removed: false }], start: { kind: "after", trackId: "p1", delayDays: 0 }, removed: false },
      ],
    });
    return { h, id: campaign.id };
  }

  const view = async (h: EngineHarness, id: string) => {
    const res = await h.request<BeforeLaunchView>("GET", `/api/campaigns/${id}/before-launch`);
    expect(res.status).toBe(200);
    return res.body.load;
  };

  test("a run that stops at the horizon says so, and the screen shows no figure", async () => {
    const { h, id } = await pastTheHorizon();
    const stop = await projectionStop(h.store, id, h.clock);
    expect(stop).toMatchObject({ reason: "horizon" });
    const load = await view(h, id);
    expect(load).toMatchObject({ stoppedEarly: "horizon", leadsToStart: null, daysUntilAllStart: null, someNotStartedWithinHorizon: false, accounts: [expect.objectContaining({ busiestDay: 0 })] });
  });

  test("the bound hit at the first instant: stopped by the bound at launch, in the passes, no figure", async () => {
    const { h, id } = await threeCalls();
    expect(await projectionStop(h.store, id, h.clock, { maxSteps: 0 })).toEqual({ reason: "bound", at: h.clock, during: "passes" });
    expect(await projectedSends(h.store, id, h.clock, { maxSteps: 0 })).toBeNull();
  });

  test("the bound hit at the last instant before the horizon: stopped by the bound there, not by the horizon, no figure", async () => {
    const { h, id } = await pastTheHorizon();
    const full = await projectedSends(h.store, id, h.clock);
    expect(full?.stop.reason).toBe("horizon");
    // The last instant the run does any work: the follow-up sent on the estimate's last day, whose
    // next step lies past the horizon (the review bot's case: time would then move past the end).
    expect(full?.sends.map((x) => x.stepId)).toEqual(["e1", "e2"]);
    const last = full?.sends.at(-1)?.at ?? NaN;
    expect(Math.floor((last - h.clock) / 86_400_000) + 1).toBe(120);
    const steps = full?.steps ?? 0;
    expect(await projectionStop(h.store, id, h.clock, { maxSteps: steps - 1 })).toEqual({ reason: "bound", at: last, during: "passes" });
    expect(await projectedSends(h.store, id, h.clock, { maxSteps: steps - 1 })).toBeNull();
  });

  test("the bound hit in the middle of the daily call-logging sweep: stopped by the bound there, no figure; every bound below the full run gives no figure or the whole", { timeout: 120_000 }, async () => {
    const { h, id } = await threeCalls();
    const full = await projectedSends(h.store, id, h.clock);
    expect(full?.stop).toEqual({ reason: "complete" });
    const whole = JSON.stringify([full?.sends, full?.calls]);
    const during = new Set<string>();
    for (let bound = 0; bound < (full?.steps ?? 0); bound++) {
      const stop = await projectionStop(h.store, id, h.clock, { maxSteps: bound });
      const partial = await projectedSends(h.store, id, h.clock, { maxSteps: bound });
      if (stop?.reason === "bound") {
        during.add(stop.during);
        expect([bound, partial]).toEqual([bound, null]);
      } else expect([bound, stop, JSON.stringify([partial?.sends, partial?.calls])]).toEqual([bound, { reason: "complete" }, whole]);
    }
    expect([...during].sort()).toEqual(["call_logging", "passes"]);
  });
});

/**
 * The stop reason is decided in one place, in a fixed order (review bot on 72b7252; coordinator's ruling):
 * finished first, at every instant after its passes; then the bound on work; then the horizon. Each pair
 * that can conflict is tested. Fictitious data only.
 */
describe("the stop reason's order: finished, then the bound, then the horizon (review bot on 72b7252)", () => {
  const H = 3_600_000;
  const DAY = 24 * H;
  const daily = (start: number, end: number) => [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start, end }));

  /** One UTC lead and one inbox; an email at entry and follow-ups after the given waits. */
  async function oneLead(resetZone: string, window: { day: number; start: number; end: number }[], waits: readonly number[], start = Date.parse("2026-11-02T09:00:00Z")) {
    const h = new EngineHarness({ start, accounts: [{ id: "inbox-a", capacity: 30, gapMs: 60_000, k: 1, healthy: true, quotaAvailable: true, resetZone }] });
    const { campaign } = await h.createCampaign("Order", {
      businesses: [business({ business_id: "b1", business_name: "Clinic One", timezone: "UTC" })],
      people: [person({ person_id: "p1", business_id: "b1", full_name: "Lead One", email: "one@clinic1.example", timezone: "" })],
    });
    await h.tick();
    await h.defineSequence(campaign.id, {
      timezone: "UTC",
      callSkipLimitDays: 2,
      emailPool: ["inbox-a"],
      tracks: [{ id: "e", channel: "email", branch: "main", window, start: { kind: "entry" }, removed: false, steps: [0, ...waits].map((waitDays, i) => ({ id: `e${i + 1}`, waitDays, subject: i === 0 ? "Hi" : "", body: "A note.", threading: i === 0 ? ("new_subject" as const) : ("continue_thread" as const), removed: false })) }],
    });
    return { h, id: campaign.id };
  }
  const dayOf = (h: EngineHarness, at: number) => Math.floor((at - Date.parse("2026-11-02T00:00:00Z")) / DAY) + 1 - Math.floor((h.clock - Date.parse("2026-11-02T00:00:00Z")) / DAY);

  test("finished, with a later wake past the horizon (the bot's case: the inbox resets in another zone): complete, and the figures are shown", async () => {
    const { h, id } = await oneLead("Pacific/Honolulu", daily(10, 17), [119]);
    const full = await projectedSends(h.store, id, h.clock);
    expect(full?.sends.map((x) => [x.stepId, dayOf(h, x.at)])).toEqual([["e1", 1], ["e2", 120]]);
    expect(full?.stop).toEqual({ reason: "complete" });
    const res = await h.request<BeforeLaunchView>("GET", `/api/campaigns/${id}/before-launch`);
    expect(res.body.load).toMatchObject({ stoppedEarly: null, leadsToStart: 1, daysUntilAllStart: 1, accounts: [expect.objectContaining({ busiestDay: 1 })] });
  });

  test("finished at the instant the bound is reached: complete, with the whole run's figures", async () => {
    const { h, id } = await oneLead("Pacific/Honolulu", daily(10, 17), [119]);
    const full = await projectedSends(h.store, id, h.clock);
    const bound = (full?.steps ?? 0) - 1;
    const atBound = await projectedSends(h.store, id, h.clock, { maxSteps: bound });
    // The bound was reached (the run took more steps than it), in the instant that finished the lead.
    expect(atBound?.steps).toBeGreaterThan(bound);
    expect(atBound?.stop).toEqual({ reason: "complete" });
    expect(JSON.stringify(atBound?.sends)).toBe(JSON.stringify(full?.sends));
  });

  test("the bound reached exactly at the horizon: stopped by the bound there, not by the horizon, no figure", async () => {
    // Launched at midnight and sending all day, so the follow-up 120 days on (a wait ends at the start of a
    // day) falls due exactly at the horizon's instant; another follows past it.
    const { h, id } = await oneLead("UTC", daily(0, 24), [120, 10], Date.parse("2026-11-02T00:00:00Z"));
    const end = h.clock + 120 * DAY;
    const full = await projectedSends(h.store, id, h.clock);
    expect(full?.sends.map((x) => [x.stepId, x.at === end])).toEqual([["e1", false], ["e2", true]]);
    expect(full?.stop).toEqual({ reason: "horizon", at: end });
    const bound = (full?.steps ?? 0) - 1;
    expect(await projectionStop(h.store, id, h.clock, { maxSteps: bound })).toEqual({ reason: "bound", at: end, during: "passes" });
    expect(await projectedSends(h.store, id, h.clock, { maxSteps: bound })).toBeNull();
  });
});
