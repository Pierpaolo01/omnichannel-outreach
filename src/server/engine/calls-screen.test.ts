import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { ActivityView, CallsView, CallTaskView, LeadSearchResult, TodayView } from "../../shared/api.ts";
import { TICK_MS, Worker } from "../worker.ts";

/**
 * What the Today page and the call focus queue read (ticket 14, part b), through the real HTTP app,
 * SQLite store and engine. Additive to part a's read models: why a call left the list, whether the
 * day's call capacity is used, the call's calling hours, and calls in the record's Activity. The
 * user dials on their own phone; nothing here dials. Data is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
/** Monday 2 November 2026, 09:00 London (GMT). */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const WEEKDAYS_9_TO_17 = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));

const email = (id: string, waitDays = 0): StepDefinition => ({ id, waitDays, subject: "Hello {{first_name|there}}", body: `Email ${id} for {{company}}.`, threading: "new_subject", removed: false });
const call = (id: string): StepDefinition => ({ id, waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false });
const track = (id: string, channel: TrackDefinition["channel"], steps: StepDefinition[], window = ALWAYS): TrackDefinition => ({ id, channel, branch: "main", window, steps, start: { kind: "entry" }, removed: false });
const definition = (tracks: TrackDefinition[]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: [], callScript: "Ask who looks after bookings.", tracks });

const PAT = person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", title: "Clinic owner", email: "pat@harbour.example", direct_phone: "+442079460111" });
const NIA = person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", title: "Practice manager", email: "nia@harbour.example", dial_phone: "+447700900102", dial_phone_type: "mobile" });
const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });

async function world(capacity = 20) {
  const h = new EngineHarness({ start: MONDAY_9 - H, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
  await h.tick();
  expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: capacity, userZone: "Europe/London" })).status).toBe(200);
  h.clock = MONDAY_9;
  const { campaign: c } = await h.createCampaign("Calls", { businesses: [HARBOUR], people: [PAT, NIA] });
  await h.defineSequence(c.id, definition([track("e1", "email", [email("s1")]), track("p1", "call", [call("c1")], WEEKDAYS_9_TO_17)]));
  expect((await h.launch(c.id)).status).toBe(200);
  const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
  const lead = (who: string) => rows.find((r) => r.name === who)?.enrollments[0]?.id ?? "";
  const personId = (who: string) => rows.find((r) => r.name === who)?.id ?? "";
  await h.advanceTo(MONDAY_9 + H);
  const calls = async () => (await h.request<CallsView>("GET", "/api/calls")).body;
  const task = async (id: string) => (await h.request<CallTaskView>("GET", `/api/call-tasks/${id}`)).body;
  const taskOf = async (who: string) => (await calls()).readyNow.find((x) => x.person?.name === who)?.taskId ?? "";
  let n = 0;
  const log = (id: string, body: Record<string, unknown>) => h.request<{ error?: { code: string; message: string } }>("POST", `/api/call-tasks/${id}/outcome`, { requestId: `r${++n}`, ...body });
  return { h, c, lead, personId, calls, task, taskOf, log };
}

describe("why a call is off the list, from the server's facts (ADR 0003 4.4.1, offList)", () => {
  test("a listed call has none; once logged, it names the outcome and when; a lead that replied names its status", async () => {
    const { h, task, taskOf, log } = await world();
    const patTask = await taskOf("Pat Oneil");
    expect((await task(patTask)).offList).toBeNull();
    const direct = (await task(patTask)).numbers[0]?.detailId;
    expect((await log(patTask, { outcome: "no_answer", numberId: direct })).status).toBe(200);
    expect((await task(patTask)).offList).toEqual({ reason: "logged", outcome: "no_answer", at: "2026-11-02T10:00:00.000Z", status: "sequence_finished_no_response" });

    // A second tab logs on the same call with its own request id: refused, and the task says why.
    const again = await log(patTask, { outcome: "voicemail", numberId: direct });
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("outcome_refused");

    const niaTask = await taskOf("Nia Cole");
    expect(h.fake.prospectReplies("nia@harbour.example", true, null)).toBe(true);
    await h.advanceTo(MONDAY_9 + 2 * H);
    expect((await task(niaTask)).offList).toMatchObject({ reason: "lead_ended", status: "replied" });
  });

  test("a skip for now leaves the call on the list", async () => {
    const { task, taskOf, log } = await world();
    const patTask = await taskOf("Pat Oneil");
    expect((await log(patTask, { outcome: "skip_for_now" })).status).toBe(200);
    expect((await task(patTask)).offList).toBeNull();
  });
});

describe("the day's call capacity and the call's calling hours, as the screens state them", () => {
  test("the queue and Today say when today's capacity is used, and the factory default", async () => {
    const roomy = await world(5);
    expect(await roomy.calls()).toMatchObject({ dailyCapacity: 5, defaultDailyCapacity: 50, capacityReached: false });
    const full = await world(2);
    expect(await full.calls()).toMatchObject({ dailyCapacity: 2, placedToday: 2, capacityReached: true });
    expect((await full.h.request<TodayView>("GET", "/api/today")).body).toMatchObject({ capacityReached: true });
  });

  test("the call task carries its phone track's calling hours, in the prospect's time", async () => {
    const { task, taskOf } = await world();
    expect((await task(await taskOf("Pat Oneil"))).callingHours).toEqual(WEEKDAYS_9_TO_17);
  });
});

describe("calls in the record's Activity (ticket 14: the person and company-lead timeline)", () => {
  test("each logged call shows with its outcome, the number dialled and its note; a skip for now shows as a skip", async () => {
    const { h, personId, task, taskOf, log } = await world();
    const patTask = await taskOf("Pat Oneil");
    const direct = (await task(patTask)).numbers[0];
    expect((await log(patTask, { outcome: "skip_for_now", note: "In clinic, try after lunch." })).status).toBe(200);
    h.clock += 30 * MIN;
    expect((await log(patTask, { outcome: "wrong_number", numberId: direct?.detailId, note: "Disconnected tone." })).status).toBe(200);
    const activity = (await h.request<ActivityView>("GET", `/api/people/${personId("Pat Oneil")}/activity`)).body.entries;
    const calls = activity.filter((e) => e.kind === "call");
    expect(calls).toEqual([
      { kind: "call", campaign: expect.objectContaining({ name: "Calls" }), at: "2026-11-02T10:30:00.000Z", outcome: "wrong_number", number: { detailId: direct?.detailId, kind: "direct", owner: "person", value: direct?.value }, note: "Disconnected tone." },
      { kind: "call", campaign: expect.objectContaining({ name: "Calls" }), at: "2026-11-02T10:00:00.000Z", outcome: "skip_for_now", number: null, note: "In clinic, try after lunch." },
    ]);
  });
});

describe("when the call list next changes by the clock (ADR 0003 4.4.1, review bot on e6872eb)", () => {
  test("before calling hours, the instant they open; inside them, the instant they close; after them, the user's next day", async () => {
    const h = new EngineHarness({ start: MONDAY_9 - 3 * H, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
    await h.tick();
    await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" });
    h.clock = MONDAY_9 - 2 * H;
    const { campaign: c } = await h.createCampaign("Clock", { businesses: [HARBOUR], people: [PAT] });
    await h.defineSequence(c.id, definition([track("p1", "call", [call("c1")], WEEKDAYS_9_TO_17)]));
    expect((await h.launch(c.id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 - 90 * MIN);
    const views = async () => [(await h.request<CallsView>("GET", "/api/calls")).body, (await h.request<TodayView>("GET", "/api/today")).body] as const;

    for (const v of await views()) expect(v).toMatchObject({ asOf: "2026-11-02T07:30:00.000Z", nextChangeAt: "2026-11-02T09:00:00.000Z" });
    await h.advanceTo(MONDAY_9 + H);
    for (const v of await views()) expect(v).toMatchObject({ asOf: "2026-11-02T10:00:00.000Z", nextChangeAt: "2026-11-02T17:00:00.000Z" });
    await h.advanceTo(MONDAY_9 + 9 * H);
    for (const v of await views()) expect(v).toMatchObject({ nextChangeAt: "2026-11-03T00:00:00.000Z" });
  });

  test("a call that starts after an email track: the engine's next wake, when the email goes", async () => {
    const h = new EngineHarness({ start: MONDAY_9 - 3 * H, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
    await h.tick();
    await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" });
    h.clock = MONDAY_9 - H;
    const { campaign: c } = await h.createCampaign("Call after an email", { businesses: [HARBOUR], people: [PAT] });
    // The call starts when the email track finishes, which the call list alone cannot foresee: the engine's next wake names it.
    await h.defineSequence(c.id, definition([track("e1", "email", [email("s1")], WEEKDAYS_9_TO_17), { ...track("p1", "call", [call("c1")], ALWAYS), start: { kind: "after", trackId: "e1", delayDays: 0 } }]));
    expect((await h.launch(c.id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 - 30 * MIN);
    const view = (await h.request<CallsView>("GET", "/api/calls")).body;
    expect(view.readyNow).toEqual([]);
    expect(view.nextChangeAt).toBe("2026-11-02T09:00:00.000Z");
  });
});

describe("the instant the server advertises is one at which its answer shows the change (review bot on b15a769, item 7)", () => {
  test("a call placed at the user's midnight: a read at the advertised instant, before the worker's tick, waits for that tick and shows it", async () => {
    // The worker as the running app has it: TICK_MS between ticks, on timers this test steps by hand.
    const timers: { at: number; fire: () => void }[] = [];
    const box: { h: EngineHarness | null } = { h: null };
    const worker = new Worker({
      recover: async () => undefined,
      tick: () => (box.h ? box.h.tick() : Promise.resolve()),
      now: () => box.h?.clock ?? 0,
      setTimer: (fire, ms) => {
        const t = { at: (box.h?.clock ?? 0) + ms, fire };
        timers.push(t);
        return () => timers.splice(timers.indexOf(t), 1);
      },
    });
    const h = new EngineHarness({ start: MONDAY_9, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }], worker });
    box.h = h;
    await h.tick();
    await h.request("PUT", "/api/call-settings", { dailyCapacity: 1, userZone: "Europe/London" });
    const { campaign: c } = await h.createCampaign("Midnight", { businesses: [HARBOUR], people: [PAT, NIA] });
    await h.defineSequence(c.id, definition([track("p1", "call", [call("c1")], ALWAYS)]));
    expect((await h.launch(c.id)).status).toBe(200);
    await h.tick();
    // Monday: one call fits the capacity; it is worked. The other waits for Tuesday.
    const monday = (await h.request<CallsView>("GET", "/api/calls")).body;
    expect(monday.readyNow).toHaveLength(1);
    const first = (await h.request<CallTaskView>("GET", `/api/call-tasks/${monday.focusTaskId}`)).body;
    expect((await h.request("POST", `/api/call-tasks/${first.taskId}/outcome`, { requestId: "r1", outcome: "no_answer", numberId: first.numbers[0]?.detailId })).status).toBe(200);

    // 23:59:50 London; the worker's last tick started at 23:59:45, so its next starts at 00:00:00.
    h.clock = Date.parse("2026-11-02T23:59:45Z");
    worker.start();
    await new Promise((r) => setImmediate(r));
    h.clock = Date.parse("2026-11-02T23:59:50Z");
    const before = (await h.request<CallsView>("GET", "/api/calls")).body;
    expect(before).toMatchObject({ readyNow: [], nextChangeAt: "2026-11-03T00:00:00.000Z" });

    // The page reads at the advertised instant; the worker's timer has not fired yet.
    h.clock = Date.parse("2026-11-03T00:00:00Z");
    let answered: CallsView | null = null;
    const read = h.request<CallsView>("GET", `/api/calls?expected=${encodeURIComponent(before.nextChangeAt ?? "")}`).then((x) => (answered = x.body));
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(answered).toBeNull();
    // The worker's tick at 00:00:00 (TICK_MS after the last) places Tuesday's call; then the read answers with it.
    expect(timers[0]?.at).toBe(Date.parse("2026-11-02T23:59:45Z") + TICK_MS);
    timers.shift()?.fire();
    await read;
    expect(answered!.readyNow.map((x) => x.person?.name)).toEqual(["Nia Cole"]);
    worker.stop();
  });

  test("an ordinary read never waits for the worker", async () => {
    const worker = { completedThrough: () => Date.parse("2026-11-02T09:00:00Z"), caughtUpTo: () => new Promise<boolean>(() => undefined), nextTickAt: () => null };
    const h = new EngineHarness({ start: MONDAY_9, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }], worker });
    await h.tick();
    expect((await h.request<CallsView>("GET", "/api/calls")).status).toBe(200);
    expect((await h.request<TodayView>("GET", "/api/today")).status).toBe(200);
  });
});

describe("a read and the worker's placements: a completed-tick marker (ADR 0003 4.4; review bot on 36232cd)", () => {
  /** The midnight world of the test above, with a worker whose tick the test can hold open after it starts. */
  async function heldWorld() {
    const timers: { at: number; fire: () => void }[] = [];
    const box: { h: EngineHarness | null } = { h: null };
    let gate: (() => void) | null = null;
    let holding = false;
    const worker = new Worker({
      recover: async () => undefined,
      tick: async () => {
        // Started, and nothing committed yet: the case both earlier fixes missed.
        if (holding) await new Promise<void>((resolve) => (gate = resolve));
        await box.h?.tick();
      },
      now: () => box.h?.clock ?? 0,
      setTimer: (fire, ms) => {
        const t = { at: (box.h?.clock ?? 0) + ms, fire };
        timers.push(t);
        return () => {
          const i = timers.indexOf(t);
          if (i >= 0) timers.splice(i, 1);
        };
      },
    });
    const h = new EngineHarness({ start: MONDAY_9, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }], worker });
    box.h = h;
    await h.tick();
    await h.request("PUT", "/api/call-settings", { dailyCapacity: 1, userZone: "Europe/London" });
    const { campaign: c } = await h.createCampaign("Held", { businesses: [HARBOUR], people: [PAT, NIA] });
    await h.defineSequence(c.id, definition([track("p1", "call", [call("c1")], ALWAYS)]));
    expect((await h.launch(c.id)).status).toBe(200);
    await h.tick();
    const monday = (await h.request<CallsView>("GET", "/api/calls")).body;
    const first = (await h.request<CallTaskView>("GET", `/api/call-tasks/${monday.focusTaskId}`)).body;
    expect((await h.request("POST", `/api/call-tasks/${first.taskId}/outcome`, { requestId: "r1", outcome: "no_answer", numberId: first.numbers[0]?.detailId })).status).toBe(200);
    // The worker's last finished tick began at 23:59:45; its next is due at 00:00:00.
    h.clock = Date.parse("2026-11-02T23:59:45Z");
    worker.start();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    const fireDue = () => {
      const due = timers.filter((t) => t.at <= h.clock);
      for (const t of due) {
        timers.splice(timers.indexOf(t), 1);
        t.fire();
      }
    };
    const settle = async () => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    };
    return { h, worker, timers, fireDue, settle, hold: () => (holding = true), release: () => gate?.() };
  }

  test("a read at the advertised instant while the tick that will place the call has started and not finished waits for it to finish", async () => {
    const w = await heldWorld();
    w.hold();
    w.h.clock = Date.parse("2026-11-03T00:00:00Z");
    w.fireDue();
    await w.settle();
    // The tick began at 00:00:00 and is held before its placements commit.
    w.h.clock = Date.parse("2026-11-03T00:00:01Z");
    let answered: CallsView | null = null;
    const read = w.h.request<CallsView>("GET", `/api/calls?expected=${encodeURIComponent("2026-11-03T00:00:00.000Z")}`).then((x) => (answered = x.body));
    await w.settle();
    expect(answered).toBeNull();
    w.release();
    await read;
    expect(answered!.readyNow.map((x) => x.person?.name)).toEqual(["Nia Cole"]);
    w.worker.stop();
  });

  test("a tick that never finishes: the read answers within the 30-second bound, with what is stored and the worker's next tick as its next change, never tomorrow", async () => {
    const w = await heldWorld();
    w.hold();
    w.h.clock = Date.parse("2026-11-03T00:00:00Z");
    w.fireDue();
    await w.settle();
    w.h.clock = Date.parse("2026-11-03T00:00:01Z");
    let answered: CallsView | null = null;
    const read = w.h.request<CallsView>("GET", `/api/calls?expected=${encodeURIComponent("2026-11-03T00:00:00.000Z")}`).then((x) => (answered = x.body));
    await w.settle();
    expect(answered).toBeNull();
    w.h.clock = Date.parse("2026-11-03T00:00:31Z");
    w.fireDue();
    await read;
    expect(answered!.readyNow).toEqual([]);
    expect(Date.parse(answered!.nextChangeAt ?? "")).toBeLessThanOrEqual(w.h.clock + TICK_MS);
    // An ordinary read meanwhile never advertises a far-off change while the call is due and unplaced.
    const ordinary = (await w.h.request<TodayView>("GET", "/api/today")).body;
    expect(Date.parse(ordinary.nextChangeAt ?? "")).toBeLessThanOrEqual(w.h.clock + TICK_MS);
    w.worker.stop();
  });
});
