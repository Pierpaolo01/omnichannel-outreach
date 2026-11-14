import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import { inbox, launched, MONDAY_9 as LIFECYCLE_MONDAY_9, SETTLING } from "../../../test/support/regressions.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { CallsView, CallTaskView, TodayView } from "../../shared/api.ts";
import { leadNow } from "../../domain/sequence/clock.ts";
import { TICK_STEPS, type TickStep } from "./engine.ts";

/**
 * A tick is as of one instant (ADR 0003 4.4; review bot on 12f0303): it reads the clock once, and
 * evaluation, placement and the completed-placement marker are all as of that instant. The table
 * moves the clock across a boundary between every pair of a tick's steps, and checks two things:
 * the tick stores exactly what a tick at its starting instant stores, and a read at the later
 * instant never says the list is current when a tick at that instant would change it.
 * Nothing is sent or dialled to anyone real; data is fictitious.
 */

const SEC = 1_000;
const MIN = 60 * SEC;
const H = 60 * MIN;
const DAY = 24 * H;
/** Monday 2 November 2026, 09:00 London (GMT). */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const WEEKDAYS_9_TO_17 = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
const ACCOUNT = { id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" };

const email = (id: string): StepDefinition => ({ id, waitDays: 0, subject: "Hello {{first_name|there}}", body: `Email ${id} for {{company}}.`, threading: "new_subject", removed: false });
const call = (id: string): StepDefinition => ({ id, waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false });
const track = (id: string, channel: TrackDefinition["channel"], steps: StepDefinition[], window = ALWAYS, start: TrackDefinition["start"] = { kind: "entry" }): TrackDefinition => ({ id, channel, branch: "main", window, steps, start, removed: false });
const definition = (tracks: TrackDefinition[]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: [], callScript: "Ask who looks after bookings.", tracks });

const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });
const PEOPLE = [
  person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", direct_phone: "+442079460111" }),
  person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", email: "nia@harbour.example" }),
  person({ person_id: "p3", business_id: "b1", full_name: "Sam Lee", email: "sam@harbour.example" }),
  person({ person_id: "p4", business_id: "b1", full_name: "Ana Ruiz", email: "ana@harbour.example" }),
];

/** A world brought to the instant `t0` just before the tick under test, and the later instant `t1` the clock jumps to. */
interface World {
  readonly h: EngineHarness;
  readonly t0: number;
  readonly t1: number;
}

async function callWorld(capacity: number, people: typeof PEOPLE, tracks: TrackDefinition[], launchAt: number): Promise<EngineHarness> {
  const h = new EngineHarness({ start: launchAt - H, accounts: [ACCOUNT] });
  await h.tick();
  expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: capacity, userZone: "Europe/London" })).status).toBe(200);
  h.clock = launchAt;
  const { campaign: c } = await h.createCampaign("One instant", { businesses: [HARBOUR], people });
  await h.defineSequence(c.id, definition(tracks));
  expect((await h.launch(c.id)).status).toBe(200);
  return h;
}

/** The wall instant the phone track starts: its start is kept in the lead's running time. */
async function phoneStart(h: EngineHarness): Promise<number> {
  const [id] = await h.store.engine.runningSubjectIds();
  const s = await h.store.engine.subject(id ?? "", h.clock);
  const startAt = s?.tracks.find((p) => p.trackId === "p1")?.startAt ?? null;
  expect(startAt).not.toBeNull();
  return s && startAt !== null ? h.clock + (startAt - leadNow(s.subject.clock, h.clock)) : 0;
}

const SCENARIOS: Record<string, () => Promise<World>> = {
  /** Monday's capacity is used; two due calls wait for Tuesday, which begins between t0 and t1. */
  "the user's midnight": async () => {
    const h = await callWorld(2, PEOPLE, [track("p1", "call", [call("c1")])], MONDAY_9);
    await h.tick();
    for (const item of (await h.request<CallsView>("GET", "/api/calls")).body.readyNow) {
      const t = (await h.request<CallTaskView>("GET", `/api/call-tasks/${item.taskId}`)).body;
      expect((await h.request("POST", `/api/call-tasks/${t.taskId}/outcome`, { requestId: `r-${t.taskId}`, outcome: "no_answer", numberId: t.numbers[0]?.detailId })).status).toBe(200);
    }
    h.clock = Date.parse("2026-11-02T23:59:45Z");
    await h.tick();
    return { h, t0: Date.parse("2026-11-02T23:59:59Z"), t1: Date.parse("2026-11-03T00:00:05Z") };
  },
  /** A phone track starts a day after the email track finishes; its start falls between t0 and t1. */
  "a phone track's start": async () => {
    const h = await callWorld(20, PEOPLE.slice(0, 1), [track("e1", "email", [email("s1")]), track("p1", "call", [call("c1")], ALWAYS, { kind: "after", trackId: "e1", delayDays: 1 })], MONDAY_9);
    await h.advanceTo(MONDAY_9 + H);
    const start = await phoneStart(h);
    h.clock = start - MIN;
    await h.tick();
    return { h, t0: start - SEC, t1: start + 5 * SEC };
  },
  /** The phone track starts at t0, a few seconds before its calling hours close at 17:00; t1 is after they close. */
  "the close of calling hours": async () => {
    const h = await callWorld(20, PEOPLE.slice(0, 1), [track("e1", "email", [email("s1")]), track("p1", "call", [call("c1")], WEEKDAYS_9_TO_17, { kind: "after", trackId: "e1", delayDays: 1 })], MONDAY_9 + 8 * H - 30 * SEC);
    await h.advanceTo(MONDAY_9 + 8 * H);
    const start = await phoneStart(h);
    const close = MONDAY_9 + DAY + 8 * H;
    expect(start).toBeLessThan(close);
    h.clock = start - MIN;
    await h.tick();
    return { h, t0: start, t1: close + 5 * SEC };
  },
  /** An email claim whose pre-send check never answers expires SETTLING after it was claimed, between t0 and t1. */
  "a claim's expiry": async () => {
    const { h, port, start } = await launched([inbox("inbox-a")]);
    port.presend = () => new Promise(() => undefined);
    await start();
    const [attempt] = await h.store.engine.openAttempts();
    expect(attempt?.state).toBe("claimed");
    const expiry = (attempt?.claimedWall ?? LIFECYCLE_MONDAY_9) + SETTLING;
    h.clock = expiry - MIN;
    await h.tick();
    return { h, t0: expiry - SEC, t1: expiry + 5 * SEC };
  },
};

/** What a tick stores, without the identifiers it generates. */
async function stored(h: EngineHarness, at: number): Promise<unknown> {
  const out: unknown[] = [];
  for (const id of await h.store.engine.runningSubjectIds()) {
    const s = await h.store.engine.subject(id, at);
    if (!s) continue;
    out.push({
      tracks: s.tracks.map((p) => ({ track: p.trackId, startedAt: p.startedAt, finishedAt: p.finishedAt, next: p.nextStepId, dueAt: p.dueAt })),
      calls: s.callTasks.map((t) => ({ step: t.stepId, listDay: t.listDay, placedWall: t.placedWall, open: t.open })),
      attempts: s.attempts.map((a) => ({ step: a.stepId, state: a.state, endedBy: a.endedBy })),
    });
  }
  return out;
}

const listed = async (h: EngineHarness) => (await h.request<CallsView>("GET", "/api/calls")).body;
const names = (v: CallsView) => v.readyNow.map((x) => x.person?.name ?? "").sort();

describe("a tick is as of one instant: a clock that jumps between any two of its steps changes nothing it stores (ADR 0003 4.4; review bot on 12f0303)", () => {
  for (const [scenario, build] of Object.entries(SCENARIOS)) {
    const gaps = TICK_STEPS.slice(0, -1);
    for (const gap of gaps) {
      test(`across ${scenario}, the clock jumps after "${gap}"`, async () => {
        const reference = await build();
        reference.h.clock = reference.t0;
        await reference.h.tick();
        const expected = await stored(reference.h, reference.t0);

        const { h, t0, t1 } = await build();
        h.clock = t0;
        let jumped = false;
        h.hooks = {
          ...h.hooks,
          afterStep: (step: TickStep) => {
            if (step !== gap || jumped) return;
            jumped = true;
            h.clock = t1;
          },
        };
        await h.tick();
        expect(jumped).toBe(true);
        h.clock = t1;
        // The tick stored what a tick at its own starting instant stores.
        expect(await stored(h, t0)).toEqual(expected);
        // A read at t1 says the list is current only if a tick at t1 leaves it as it is.
        const view = await listed(h);
        const today = (await h.request<TodayView>("GET", "/api/today")).body;
        expect(today.behind).toBe(view.behind);
        if (!view.behind) {
          await h.tick();
          expect(names(await listed(h))).toEqual(names(view));
        }
      });
    }
  }
});
