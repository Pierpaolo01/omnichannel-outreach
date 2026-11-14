import { describe, expect, test } from "vitest";
import { Crash, EngineHarness, TransientError } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { Rules } from "./rules.ts";
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
async function world(capacity = 50, extraRules: Partial<Rules> = {}) {
  failing = false;
  const h = new EngineHarness({
    start: MONDAY_9,
    accounts: [{ id: "inbox-a", capacity, gapMs: 10 * MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    rules: {
      // Every tick judges its dispatch at an instant: failing here fails every tick.
      dispatchInstant: (_started, now) => {
        if (failing) throw new TransientError("a tick");
        return now;
      },
      ...extraRules,
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
  test("an answer held across midnight: the interruption is recorded, with its count, when the tick decides to dispatch, before the overdue follow-ups go (PR 56 review bot)", async () => {
    const { h, campaign, today } = await world();
    await campaign("Clinics");
    // The three first emails went on Monday; their follow-ups fall due at midnight.
    await h.advanceTo(TUESDAY_0 - 10 * MIN);
    const asked = h.clock;
    // At each follow-up's handover, the notice as stored then: it must already count the follow-ups.
    const atHandover: (string | null)[] = [];
    h.hooks = { beforeHandover: async () => void atHandover.push(await h.store.engine.meta("engine_interruption")) };
    h.stopMarkingAlive();
    // The machine sleeps for six hours in the middle of the tick's observation.
    h.heldAnswer = { kind: "observe", ms: 6 * H };
    await h.tick();
    expect(h.heldAnswers).toEqual([{ kind: "observe", askedAt: asked, answeredAt: asked + 6 * H }]);
    const notice = { from: iso(asked), to: iso(asked + 6 * H), rescheduled: 3 };
    expect((await today()).interruption).toEqual(notice);
    expect(atHandover.length).toBeGreaterThan(0);
    for (const stored of atHandover) expect(stored === null ? null : JSON.parse(stored)).toEqual({ from: asked, to: asked + 6 * H, rescheduled: 3 });
    // Under the mutation that decides at the tick's start, the follow-ups go before anything is counted.
    expect(h.fake.handoverLog.filter((c) => c.stepId === "s2").every((c) => c.at >= asked + 6 * H)).toBe(true);
  });

  test("decided at the tick's start instead, the follow-ups go uncounted: the test above bites", async () => {
    const { h, campaign, today } = await world(50, { dispatchInstant: (started) => started });
    await campaign("Clinics");
    await h.advanceTo(TUESDAY_0 - 10 * MIN);
    h.stopMarkingAlive();
    h.heldAnswer = { kind: "observe", ms: 6 * H };
    await h.tick();
    await h.tick();
    expect((await today()).interruption?.rescheduled ?? 0).toBeLessThan(3);
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

describe("the verifier's reproductions on 2f7cd20 (one lead, one inbox: capacity 100, gap one minute, k = 1)", () => {
  async function oneLead() {
    const h = new EngineHarness({ start: MONDAY_9, accounts: [{ id: "inbox-a", capacity: 100, gapMs: MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
    await h.tick();
    const { campaign } = await h.createCampaign("Clinics", { businesses: [HARBOUR], people: [PEOPLE[0]!] });
    await h.defineSequence(campaign.id, DEFINITION);
    expect((await h.launch(campaign.id)).status).toBe(200);
    const today = async () => (await h.request<TodayView>("GET", "/api/today")).body;
    return { h, today };
  }

  test("A: an observation held from Monday 23:50 to Tuesday 05:50 counts the midnight follow-up (N = 1) before it is sent", async () => {
    const { h, today } = await oneLead();
    await h.advanceTo(TUESDAY_0 - 10 * MIN);
    h.stopMarkingAlive();
    h.heldAnswer = { kind: "observe", ms: 6 * H };
    await h.tick();
    await h.tick();
    expect((await today()).interruption).toEqual({ from: iso(TUESDAY_0 - 10 * MIN), to: iso(TUESDAY_0 + 5 * H + 50 * MIN), rescheduled: 1 });
    expect(h.fake.handoverLog.filter((c) => c.stepId === "s2").map((c) => c.at)).toEqual([TUESDAY_0 + 5 * H + 50 * MIN]);
  });

  test("B: a 24-hour gap, then a recovery tick that sleeps six hours: one notice, from the last heartbeat to the end of the sleep", async () => {
    const { h, today } = await oneLead();
    const monday10 = MONDAY_9 + H;
    await h.advanceTo(monday10);
    // Nothing ticks for 24 hours; the recovery tick's first observation is then held another six.
    h.stopMarkingAlive();
    h.clock = monday10 + DAY;
    h.heldAnswer = { kind: "observe", ms: 6 * H };
    await h.tick();
    const notice = { from: iso(monday10), to: iso(monday10 + DAY + 6 * H), rescheduled: 1 };
    expect((await today()).interruption).toEqual(notice);
    await h.tick();
    expect((await today()).interruption).toEqual(notice);
  });
});

describe("a provider answer that arrives after midnight (follow-up 42 item 39; R9)", () => {
  /** s1 handed over at 23:40 on Monday; the provider sends it at 00:10:30 on Tuesday (late-send, half an hour). */
  async function heldAcrossMidnight(rules: Partial<Rules> = {}) {
    const MONDAY_2340 = Date.parse("2026-11-02T23:40:00Z");
    const h = new EngineHarness({ start: MONDAY_2340, accounts: [{ id: "inbox-a", capacity: 50, gapMs: 10 * MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }], modes: ["late-send"], rules });
    await h.tick();
    const { campaign } = await h.createCampaign("Clinics", { businesses: [HARBOUR], people: [PEOPLE[0]!] });
    await h.defineSequence(campaign.id, DEFINITION);
    expect((await h.launch(campaign.id)).status).toBe(200);
    await h.advanceTo(TUESDAY_0 - MIN);
    // Asked at 23:59; the machine sleeps; the answer, holding the 00:10:30 send, arrives at 05:59.
    h.stopMarkingAlive();
    h.heldAnswer = { kind: "observe", ms: 6 * H };
    await h.tick();
    expect(h.heldAnswers).toHaveLength(1);
    await h.advanceTo(TUESDAY_0 + DAY + H);
    return h.fake.handoverLog.filter((c) => c.stepId === "s2").map((c) => c.at);
  }

  test("the send it reports counts from its own time, so a one-day follow-up waits for Wednesday", async () => {
    const s2 = await heldAcrossMidnight();
    expect(s2).toHaveLength(1);
    expect(s2[0]!).toBeGreaterThanOrEqual(TUESDAY_0 + DAY);
  });

  test("applied at the instant the request was made, the follow-up would go on Tuesday: the test above bites", async () => {
    const s2 = await heldAcrossMidnight({ answerInstant: (asked) => asked });
    expect(s2[0]!).toBeLessThan(TUESDAY_0 + DAY);
  });
});

describe("a call whose answer a crash lost (council I: the lost-answer mutation's named example)", () => {
  /** The follow-up handed over and accepted by the provider (which sends it half an hour later); the process crashes before recording the answer. */
  async function crashAfterTheCall(rules: Partial<Rules>) {
    const h = new EngineHarness({ start: MONDAY_9, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }], modes: ["late-send"], rules });
    await h.tick();
    const { campaign } = await h.createCampaign("Clinics", { businesses: [HARBOUR], people: [PEOPLE[0]!] });
    await h.defineSequence(campaign.id, DEFINITION);
    expect((await h.launch(campaign.id)).status).toBe(200);
    let crashed = false;
    h.hooks = {
      crashPoint: (point) => {
        if (point === "after_call" && !crashed) {
          crashed = true;
          throw new Crash(point);
        }
      },
    };
    await h.advanceTo(TUESDAY_0 + 3 * H);
    expect(crashed).toBe(true);
    return h.fake.deliveryLog.filter((d) => d.stepId === "s2");
  }

  test("recovered as the crash row says (unknown: a same-key retry or a lookup), the follow-up is delivered once", async () => {
    expect(await crashAfterTheCall({})).toHaveLength(1);
  });

  test("taken as refused, the step is claimed again with a new key and the follow-up is delivered twice: the mutation is a real double send", async () => {
    expect(await crashAfterTheCall({ lostAnswer: { kind: "rejected", reason: "rate_limited" } })).toHaveLength(2);
  });
});

describe("only sends the interruption delayed are rescheduled (question Q21's interim)", () => {
  test("a full inbox with first emails waiting, then a ten-minute stop: none rescheduled", async () => {
    // Capacity 2 a day: of three first emails on Monday, two go and the third waits for Tuesday whatever happens.
    const { h, campaign, today } = await world(2);
    await campaign("Clinics");
    await h.advanceTo(MONDAY_9 + H);
    expect(h.fake.deliveryLog).toHaveLength(2);
    await h.stopFor(10 * MIN);
    expect((await today()).interruption).toMatchObject({ rescheduled: 0 });
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
    // Every read failed: the last to fail is named, with its channel and part.
    const interrupted = { since: iso(cutAt), cause: "providers_unreachable", lastFailedRead: { channel: "email", part: "observation" } };
    expect((await today()).sendingInterrupted).toMatchObject(interrupted);
    expect((await h.request<CallsView>("GET", "/api/calls")).body.sendingInterrupted).toMatchObject(interrupted);
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
    expect((await today()).sendingInterrupted).toEqual({ since: iso(lastGood), cause: "ticks_failing", lastFailedRead: null });
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
