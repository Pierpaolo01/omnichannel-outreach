import { describe, expect, test } from "vitest";
import { Crash, EngineHarness, TransientError } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import { interruptionOf } from "../../domain/sequence/interruption.ts";
import type { CampaignDefinition, StepDefinition } from "../../domain/sequence/definition.ts";
import type { CallsView, EnrollmentRead, LeadSearchResult, TodayView } from "../../shared/api.ts";

/**
 * Recovery after a sending interruption (ticket 20a; ADR 0003 "Ticket 20a") through the real HTTP app, SQLite store
 * and engine, against the fake email provider: the application stopped, the providers unreachable, ticks failing,
 * and a crash during recovery. Nothing is sent for real. Data is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
/** Monday 2 November 2026, 09:00 London (GMT). */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const TUESDAY_0 = Date.parse("2026-11-03T00:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const iso = (t: number) => new Date(t).toISOString();

const email = (id: string, waitDays = 0): StepDefinition => ({ id, waitDays, subject: `Subject ${id}`, body: `Email ${id} for {{company}}.`, threading: "new_subject", removed: false });
/** Two emails a day apart. */
const DEFINITION: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["inbox-a"],
  smsPool: [],
  callScript: "",
  tracks: [{ id: "e1", channel: "email", branch: "main", window: ALWAYS, steps: [email("s1"), email("s2", 1)], start: { kind: "entry" }, removed: false }],
};
const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });
const PEOPLE = ["Pat Oneil", "Nia Cole", "Sam Reed"].map((name, i) => person({ person_id: `p${i + 1}`, business_id: "b1", full_name: name, email: `${name.split(" ")[0]!.toLowerCase()}@harbour.example` }));

let failing = false;
async function world(capacity = 50) {
  failing = false;
  const h = new EngineHarness({
    start: MONDAY_9,
    accounts: [{ id: "inbox-a", capacity, gapMs: 10 * MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    rules: {
      // Every tick in which the providers answer asks whether an interruption ended: failing here fails every tick.
      interruptionOf: (last, now) => {
        if (failing) throw new TransientError("a tick");
        return interruptionOf(last, now);
      },
    },
  });
  await h.tick();
  const campaign = async (name: string) => {
    const { campaign: c } = await h.createCampaign(name, { businesses: [HARBOUR], people: PEOPLE });
    await h.defineSequence(c.id, DEFINITION);
    expect((await h.launch(c.id)).status).toBe(200);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
    return { id: c.id, lead: (who: string) => rows.find((r) => r.name === who)?.enrollments.find((e) => e.campaign.id === c.id)?.id ?? "" };
  };
  const today = async () => (await h.request<TodayView>("GET", "/api/today")).body;
  const handovers = (stepId: string) => h.fake.handoverLog.filter((c) => c.stepId === stepId).map((c) => c.at);
  const deliveredOnce = () => {
    const keys = h.fake.deliveryLog.map((d) => `${d.subjectId}/${d.stepId}`);
    return new Set(keys).size === keys.length;
  };
  return { h, campaign, today, handovers, deliveredOnce };
}

describe("the application stopped", () => {
  test("for two days: the notice runs from the last heartbeat to the restart, counts the follow-ups that fell due, and they go once, paced", async () => {
    const { h, campaign, today, handovers, deliveredOnce } = await world();
    await campaign("Clinics");
    await h.advanceTo(MONDAY_9 + 3 * H);
    expect(handovers("s1")).toHaveLength(3);
    expect((await today()).interruption).toBeNull();
    const stoppedAt = h.clock;
    await h.stopFor(2 * DAY);
    // The three follow-ups fell due on Tuesday at 00:00 while nothing ran.
    expect((await today()).interruption).toEqual({ from: iso(stoppedAt), to: iso(stoppedAt + 2 * DAY), rescheduled: 3 });
    await h.advanceTo(h.clock + H);
    const s2 = handovers("s2");
    expect(s2).toHaveLength(3);
    // Spread one pacing gap apart from the restart, never a burst, and nothing sent twice.
    expect(s2.every((t) => t >= stoppedAt + 2 * DAY)).toBe(true);
    expect(s2[1]! - s2[0]!).toBeGreaterThanOrEqual(10 * MIN);
    expect(s2[2]! - s2[1]!).toBeGreaterThanOrEqual(10 * MIN);
    expect(deliveredOnce()).toBe(true);
  });

  test("for two minutes: not an interruption, and the notice stays as it was", async () => {
    const { h, campaign, today } = await world();
    await campaign("Clinics");
    await h.advanceTo(MONDAY_9 + H);
    await h.stopFor(2 * MIN);
    expect((await today()).interruption).toBeNull();
    await h.stopFor(DAY);
    const notice = (await today()).interruption;
    expect(notice).not.toBeNull();
    await h.stopFor(4 * MIN);
    expect((await today()).interruption).toEqual(notice);
  });

  test("over the night the follow-ups were not due: none rescheduled, and the line still says when", async () => {
    const { h, campaign, today } = await world();
    await campaign("Clinics");
    await h.advanceTo(MONDAY_9 + 3 * H);
    await h.stopFor(8 * H);
    expect((await today()).interruption).toEqual({ from: iso(MONDAY_9 + 3 * H), to: iso(MONDAY_9 + 11 * H), rescheduled: 0 });
  });

  test("a paused lead stays paused and is not counted; the others' follow-ups are", async () => {
    const { h, campaign, today, handovers } = await world();
    const c = await campaign("Clinics");
    await h.advanceTo(MONDAY_9 + 3 * H);
    expect((await h.request("POST", `/api/enrollments/${c.lead("Pat Oneil")}/controls`, { requestId: "p", action: "pause" })).status).toBe(200);
    await h.stopFor(2 * DAY);
    expect((await today()).interruption?.rescheduled).toBe(2);
    await h.advanceTo(h.clock + DAY);
    expect(h.fake.handoverLog.filter((x) => x.subjectId === c.lead("Pat Oneil") && x.stepId === "s2")).toEqual([]);
    expect((await h.request<EnrollmentRead>("GET", `/api/enrollments/${c.lead("Pat Oneil")}`)).body.status).toBe("paused");
    expect(handovers("s2")).toHaveLength(2);
  });

  test("a crash during recovery: the second recovery sends nothing more and gives the same notice", async () => {
    const { h, campaign, today, handovers, deliveredOnce } = await world();
    await campaign("Clinics");
    await h.advanceTo(MONDAY_9 + 3 * H);
    const stoppedAt = h.clock;
    let crashes = 0;
    h.hooks = {
      crashPoint: (point) => {
        if ((point === "after_handover_commit" || point === "after_call" || point === "after_claim") && crashes < 3) {
          crashes++;
          throw new Crash(point);
        }
      },
    };
    await h.stopFor(2 * DAY);
    expect(crashes).toBeGreaterThan(0);
    h.hooks = {};
    expect((await today()).interruption).toEqual({ from: iso(stoppedAt), to: iso(stoppedAt + 2 * DAY), rescheduled: 3 });
    await h.advanceTo(h.clock + 2 * H);
    expect(new Set(h.fake.deliveryLog.filter((d) => d.stepId === "s2").map((d) => d.subjectId)).size).toBe(3);
    expect(handovers("s2").length).toBeGreaterThanOrEqual(3);
    expect(deliveredOnce()).toBe(true);
  });
});

describe("the machine slept in the middle of a tick", () => {
  test("an answer held across midnight: the tick that took it records no heartbeat, and the next reports the interruption from before it", async () => {
    const { h, campaign, today } = await world();
    await campaign("Clinics");
    await h.advanceTo(TUESDAY_0 - 10 * MIN);
    const asked = h.clock;
    h.stopMarkingAlive();
    h.heldAnswer = { kind: "observe", ms: 6 * H };
    await h.tick();
    expect(h.heldAnswers).toEqual([{ kind: "observe", askedAt: asked, answeredAt: asked + 6 * H }]);
    await h.tick();
    expect((await today()).interruption).toMatchObject({ from: iso(asked), to: iso(asked + 6 * H) });
  });

  test("an answer held for a minute is not an interruption", async () => {
    const { h, campaign, today } = await world();
    await campaign("Clinics");
    await h.advanceTo(TUESDAY_0 - 30_000);
    h.stopMarkingAlive();
    h.heldAnswer = { kind: "observe", ms: MIN };
    await h.tick();
    await h.tick();
    expect((await today()).interruption).toBeNull();
  });
});

describe("capacity across two campaigns after an interruption", () => {
  test("missed work waits for the next reset day instead of bursting past the inbox's capacity", async () => {
    // Capacity 4 a day, shared: six first emails on Monday would need two days.
    const { h, campaign, deliveredOnce } = await world(4);
    await campaign("Clinics");
    await campaign("Physios");
    await h.advanceTo(MONDAY_9 + 2 * MIN);
    await h.stopFor(3 * DAY);
    await h.advanceTo(h.clock + 4 * DAY);
    const perDay = new Map<string, number>();
    for (const d of h.fake.deliveryLog) perDay.set(iso(d.at).slice(0, 10), (perDay.get(iso(d.at).slice(0, 10)) ?? 0) + 1);
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(4);
    expect(h.fake.deliveryLog).toHaveLength(12);
    expect(deliveredOnce()).toBe(true);
  });
});

describe("while sending is interrupted, the reads say so", () => {
  test("the providers unreachable: since when, and why; then the notice", async () => {
    const { h, campaign, today } = await world();
    await campaign("Clinics");
    await h.advanceTo(MONDAY_9 + H);
    const cutAt = h.clock;
    h.cutProvidersOff(TUESDAY_0 + 2 * H);
    await h.advanceTo(cutAt + 10 * MIN);
    expect((await today()).sendingInterrupted).toEqual({ since: iso(cutAt), cause: "providers_unreachable" });
    expect((await h.request<CallsView>("GET", "/api/calls")).body.sendingInterrupted).toEqual({ since: iso(cutAt), cause: "providers_unreachable" });
    await h.advanceTo(TUESDAY_0 + 3 * H);
    expect((await today()).sendingInterrupted).toBeNull();
    expect((await today()).interruption).toEqual({ from: iso(cutAt), to: iso(TUESDAY_0 + 2 * H), rescheduled: 3 });
  });

  test("ticks failing: the read says due work may be waiting because ticks fail", async () => {
    const { h, campaign, today } = await world();
    await campaign("Clinics");
    await h.advanceTo(MONDAY_9 + H);
    const lastGood = h.clock;
    failing = true;
    // From here only the engine's own ticks could write a heartbeat, and they fail.
    h.stopMarkingAlive();
    await h.advanceTo(lastGood + 20 * MIN);
    expect((await today()).sendingInterrupted).toEqual({ since: iso(lastGood), cause: "ticks_failing" });
    failing = false;
    await h.advanceTo(h.clock + MIN);
    expect((await today()).sendingInterrupted).toBeNull();
    expect((await today()).interruption?.from).toBe(iso(lastGood));
  });

  test("a database no worker has run on yet is not interrupted", async () => {
    const h = new EngineHarness({ start: MONDAY_9, accounts: [] });
    expect((await h.request<TodayView>("GET", "/api/today")).body).toMatchObject({ interruption: null, sendingInterrupted: null });
  });
});
