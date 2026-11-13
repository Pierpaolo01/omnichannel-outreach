import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { business, person } from "../../../test/support/export-builder.ts";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { ScriptedEmailPort } from "../../../test/support/scripted-email-port.ts";
import { ENGINE_PARAMS } from "../../domain/sequence/attempt.ts";
import type { CampaignDefinition, StepDefinition } from "../../domain/sequence/definition.ts";
import type { EnrollmentView } from "../../shared/api.ts";
import { migrate } from "../persistence/migrations.ts";
import type { AccountStatus } from "./ports.ts";

/**
 * Regression tests for the attempt lifecycle findings of review round 1 on PR 37, each an exact
 * event order through the real HTTP app, SQLite store and engine, against a scripted provider.
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const { SETTLING, MAX_QUEUED_LOOKUPS } = ENGINE_PARAMS;

const inbox = (id: string, fields: Partial<AccountStatus> = {}): AccountStatus => ({
  id,
  channel: "email",
  label: id,
  capacity: 30,
  gapMs: MIN,
  k: 1,
  healthy: true,
  resetZone: "UTC",
  quotaAvailable: true,
  ...fields,
});

const step = (id: string, fields: Partial<StepDefinition> = {}): StepDefinition => ({
  id,
  waitDays: 0,
  subject: "",
  body: "A note for {{company}}.",
  threading: "continue_thread",
  removed: false,
  ...fields,
});

const twoSteps = (pool = ["inbox-a"]): CampaignDefinition => ({
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: pool,
  tracks: [
    {
      id: "t1",
      channel: "email",
      branch: "main",
      window: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 })),
      steps: [step("s1", { subject: "Hello", threading: "new_subject" }), step("s2", { waitDays: 1 })],
      start: { kind: "entry" },
      removed: false,
    },
  ],
});

const PEOPLE = [
  person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example" }),
  person({ person_id: "p2", business_id: "b1", full_name: "Sam Lee", email: "sam@harbour.example" }),
];

/** Immediately-settling port waits: a wait that has not resolved by the next turn counts as timed out. */
const quickWaits = { waitFor: <T,>(promise: Promise<T>, _ms: number, timedOut: T) => Promise.race([promise, new Promise<T>((resolve) => setImmediate(() => resolve(timedOut)))]) };

async function launched(accounts: AccountStatus[], people = [PEOPLE[0]!], definition = twoSteps()) {
  let clock = MONDAY_9 - H;
  const port = new ScriptedEmailPort(() => clock, accounts);
  const h = new EngineHarness({ start: clock, accounts: [], port, engine: quickWaits });
  Object.defineProperty(h, "clock", { get: () => clock, set: (v: number) => (clock = v) });
  const { campaign } = await h.createCampaign("Round one", { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })], people });
  await h.tick();
  await h.defineSequence(campaign.id, definition);
  return { h, port, campaign, start: async () => {
    clock = MONDAY_9;
    const res = await h.launch(campaign.id);
    if (res.status !== 200) throw new Error(JSON.stringify(res.body));
    const rows = (await h.request<{ rows: { name: string; enrollments: EnrollmentView[] }[] }>("GET", "/api/leads")).body.rows;
    return (name: string) => rows.find((r) => r.name === name)?.enrollments[0]?.id ?? "";
  } };
}

describe("ruling 1: threads, replies outside them, and follow-ups with no thread", () => {
  test("a send confirmed by lookup carries its thread, so a reply on it stops the lead (review: Opus 1, GPT P1)", async () => {
    const { h, port, start } = await launched([inbox("inbox-a")]);
    // Every call times out though the provider took the work; its sent event shows two hours late.
    port.onCall = () => ({ answer: "unknown", sendAfter: 0, eventDelay: 2 * H });
    const repeat = port.handover.bind(port);
    port.handover = async (request) => {
      await repeat(request);
      return { kind: "unknown" };
    };
    const lead = await start();
    await h.advanceTo(MONDAY_9 + 3 * H);
    port.reply("pat@harbour.example");
    await h.advanceTo(MONDAY_9 + 3 * DAY);
    expect((await h.progress(lead("Pat Oneil"))).status).toBe("replied");
    expect(port.calls.filter((c) => c.request.stepId === "s2")).toEqual([]);
  });

  test("a reply outside any known thread is reconciled by inbox and the lead's address before any further send", async () => {
    const { h, port, start } = await launched([inbox("inbox-a")]);
    const lead = await start();
    await h.advanceTo(MONDAY_9 + 3 * H);
    port.reply("pat@harbour.example", false);
    await h.advanceTo(MONDAY_9 + 3 * DAY);
    expect((await h.progress(lead("Pat Oneil"))).status).toBe("replied");
    expect(port.calls.filter((c) => c.request.stepId === "s2")).toEqual([]);
  });

  test("a continue-thread step with no thread to continue is held, not sent", async () => {
    const { h, port, start } = await launched([inbox("inbox-a")]);
    // The opener's outcome never becomes known; the user marks it sent, so no thread is recorded.
    port.onCall = () => ({ answer: "unknown", sendAfter: null });
    const call = port.handover.bind(port);
    port.handover = async (request) => {
      await call(request);
      return { kind: "unknown" };
    };
    port.lookupOverride = () => ({ kind: "unknown" });
    const lead = await start();
    await h.advanceTo(MONDAY_9 + 6 * H);
    const [attempt] = await h.store.engine.openAttempts();
    expect(attempt?.unresolvedSince).not.toBeNull();
    expect(await h.engine.markAttempt(attempt!.id, "sent")).toBe(true);
    await h.advanceTo(MONDAY_9 + 3 * DAY);
    expect(port.calls.filter((c) => c.request.stepId === "s2")).toEqual([]);
    expect((await h.progress(lead("Pat Oneil"))).tracks[0]?.hold).toBe("no_thread");
  });
});

describe("ruling 2: nothing asynchronous between a send's authorization and its call", () => {
  test("no store work runs between the authorization commit and the call, and calls keep the pacing gap", async () => {
    const { h, port, start } = await launched([inbox("inbox-a", { gapMs: MIN })], PEOPLE);
    const store = h.store.engine;
    let pending = false;
    let between = 0;
    for (const name of ["subject", "update", "attempt", "openAttempts", "accounts"] as const) {
      const original = (store[name] as (...args: unknown[]) => Promise<unknown>).bind(store);
      (store as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
        if (pending) {
          // A concurrent change and a clock advance land here if anything awaits in this window.
          between++;
          h.clock += MIN;
        }
        const result = await original(...args);
        if (name === "update" && result && (result as { attempts: { awaitingAnswer: boolean }[] }).attempts.some((a) => a.awaitingAnswer)) pending = true;
        return result;
      };
    }
    const handover = port.handover.bind(port);
    port.handover = (request) => {
      pending = false;
      return handover(request);
    };
    await start();
    await h.advanceTo(MONDAY_9 + H);
    expect(between).toBe(0);
    const times = port.calls.map((c) => c.at);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(MIN);
  });
});

describe("ruling 2: a reply and a clock advance between authorization and call", () => {
  test("the authorized call goes out, nothing after it, and the next call keeps the gap from the call's actual start", async () => {
    const { h, port, start } = await launched([inbox("inbox-a", { gapMs: 10 * MIN })], PEOPLE);
    let injected = false;
    h.hooks = {
      afterAuthorization: () => {
        if (injected) return;
        injected = true;
        h.clock += 7 * MIN;
        port.advance();
      },
    };
    const lead = await start();
    await h.advanceTo(MONDAY_9 + H);
    const times = port.calls.map((c) => c.at);
    expect(times[0]).toBe(MONDAY_9 + 7 * MIN);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(10 * MIN);
    // A reply that reaches the provider at that point stops the lead before its next send.
    port.reply("pat@harbour.example");
    await h.advanceTo(MONDAY_9 + 3 * DAY);
    expect((await h.progress(lead("Pat Oneil"))).status).toBe("replied");
    expect(port.calls.filter((c) => c.request.subjectId === lead("Pat Oneil")).map((c) => c.request.stepId)).toEqual(["s1"]);
  });
});

describe("ruling 3: uncertain provider work keeps its capacity reservation", () => {
  test("a not-sent lookup that was wrong cannot let a second lead through on a day with capacity 1 (review: GPT P1)", async () => {
    const { h, port, start } = await launched([inbox("inbox-a", { capacity: 1 })], PEOPLE);
    // Pat's work is taken but sends 30 minutes later; until 40 minutes the lookup lags and says not sent.
    port.onCall = (request) => (request.destination === "pat@harbour.example" ? { answer: "unknown", sendAfter: 30 * MIN } : { answer: "accepted", sendAfter: 0 });
    port.lookupOverride = (work, now) => (work && now < 40 * MIN + MONDAY_9 ? { kind: "not-sent" } : null);
    port.withdrawAnswer = "unknown";
    const lead = await start();
    // Pat's address is marked bad elsewhere: the track fails and the lead quiesces with the work in flight.
    await h.advanceTo(MONDAY_9 + 5 * MIN);
    const pat = await h.store.engine.subject(lead("Pat Oneil"), h.clock);
    await h.store.markContactDetailBad(pat!.tracks[0]!.destinationDetailId!);
    await h.advanceTo(MONDAY_9 + 12 * H);
    const monday = port.deliveries.filter((d) => d.at < MONDAY_9 + 15 * H);
    expect(monday.map((d) => d.subjectId)).toEqual([lead("Pat Oneil")]);
  });
});

describe("ruling 4: a provider send belongs to the provider work that produced it", () => {
  test("a send for a withdrawn attempt's key, arriving while its inheritor is claimed, settles on the original work (review: Opus 4, GPT P1)", async () => {
    const { h, port, start } = await launched([inbox("inbox-a")]);
    port.onCall = () => ({ answer: "unknown", sendAfter: 30 * MIN });
    const answer = port.handover.bind(port);
    port.handover = async (request) => {
      await answer(request);
      return { kind: "unknown" };
    };
    port.lookupOverride = (work, now) => (work && now < MONDAY_9 + 40 * MIN ? { kind: "not-sent" } : null);
    const lead = await start();
    // After the third call is refused a retry, the lookup's not-sent withdraws it; the inheritor cannot get a pre-send check.
    await h.advanceTo(MONDAY_9 + 20 * MIN);
    port.presend = () => Promise.resolve({ kind: "unavailable" });
    await h.advanceTo(MONDAY_9 + 35 * MIN);
    const s = (await h.store.engine.subject(lead("Pat Oneil"), h.clock))!;
    const sent = s.attempts.filter((a) => a.state === "sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.handedWall).toBe(MONDAY_9);
    expect(s.results).toEqual([expect.objectContaining({ stepId: "s1", atWall: MONDAY_9 + 30 * MIN, attemptId: sent[0]!.id })]);
    expect(s.attempts.filter((a) => a.state !== "sent").every((a) => a.state === "withdrawn")).toBe(true);
  });

  test("a send the app learns of only after the inheritor's handover keeps the original send time (review: GPT P1)", async () => {
    const { h, port, start } = await launched([inbox("inbox-a")]);
    // The work sends at 10 minutes; its event shows three hours late; lookups lag for an hour.
    port.onCall = () => ({ answer: "unknown", sendAfter: 10 * MIN, eventDelay: 3 * H });
    const answer = port.handover.bind(port);
    let calls = 0;
    port.handover = async (request) => {
      const a = await answer(request);
      return ++calls <= 3 ? { kind: "unknown" } : a;
    };
    port.lookupOverride = (work, now) => (work && now < MONDAY_9 + H ? { kind: "not-sent" } : null);
    const lead = await start();
    await h.advanceTo(MONDAY_9 + 5 * H);
    const s = (await h.store.engine.subject(lead("Pat Oneil"), h.clock))!;
    expect(s.results).toEqual([expect.objectContaining({ stepId: "s1", atWall: MONDAY_9 + 10 * MIN })]);
    expect(s.attempts.filter((a) => a.state === "sent")).toHaveLength(1);
    expect(port.deliveries).toHaveLength(1);
  });
});

describe("ruling 5: settlement runs on its own clock", () => {
  test("a retry waiting a day for its pacing slot does not keep its attempt from lookup and unresolved (review: GPT P1)", async () => {
    const { h, port, start } = await launched([inbox("inbox-a", { gapMs: DAY })]);
    port.onCall = () => ({ answer: "unknown", sendAfter: null });
    port.lookupOverride = () => ({ kind: "unknown" });
    await start();
    await h.advanceTo(MONDAY_9 + SETTLING * (MAX_QUEUED_LOOKUPS + 1) + H);
    const [attempt] = await h.store.engine.openAttempts();
    expect(attempt?.unresolvedSince).not.toBeNull();
  });

  test("a pre-send check that never answers is bounded, so the claim still expires (review: GPT P1)", async () => {
    const { h, port, start } = await launched([inbox("inbox-a")]);
    port.presend = () => new Promise(() => undefined);
    const ran = Promise.race([
      (async () => {
        await start();
        await h.advanceTo(MONDAY_9 + SETTLING + MIN);
        return "ran";
      })(),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 3000)),
    ]);
    expect(await ran).toBe("ran");
    const all = (await h.store.engine.subject((await h.store.engine.runningSubjectIds())[0]!, h.clock))!.attempts;
    expect(all[0]).toMatchObject({ state: "withdrawn", endedBy: "claim_expired" });
  });

  test("an error while applying a provider answer does not leave the attempt waiting for a restart (review: Opus 9)", async () => {
    const { h, port, start, campaign } = await launched([inbox("inbox-a")]);
    port.onCall = () => ({ answer: "accepted", sendAfter: 0, eventDelay: DAY });
    let thrown = false;
    h.hooks = {
      crashPoint: (point) => {
        if (point === "after_call" && !thrown) {
          thrown = true;
          throw new Error("the database was busy");
        }
      },
    };
    await start().catch(() => undefined);
    // The worker loop logs the error and carries on with the same engine.
    for (let t = MONDAY_9; t < MONDAY_9 + 2 * SETTLING; t += MIN) {
      h.clock = t;
      port.advance();
      await h.engine.tick();
    }
    const s = (await h.store.engine.subject((await h.store.engine.subjectsOf(campaign.id))[0]!, h.clock))!;
    expect(s.attempts[0]).toMatchObject({ state: "sent", awaitingAnswer: false });
  });
});

describe("ruling 6: an unresolved attempt is still settled by a later not-sent", () => {
  test("unknown, then not-sent: the keyed attempt is withdrawn as lookup_not_sent and keeps when it became unresolved (review: Opus 3, GPT P2)", async () => {
    const { h, port, start } = await launched([inbox("inbox-a")]);
    port.onCall = () => ({ answer: "accepted", sendAfter: null });
    let lookups = 0;
    port.lookupOverride = () => (++lookups === 1 ? { kind: "unknown" } : { kind: "not-sent" });
    const lead = await start();
    await h.advanceTo(MONDAY_9 + 2 * SETTLING + MIN);
    const s = (await h.store.engine.subject(lead("Pat Oneil"), h.clock))!;
    expect(s.attempts[0]).toMatchObject({ state: "withdrawn", endedBy: "lookup_not_sent", unresolvedSince: MONDAY_9 + SETTLING });
  });
});

describe("ruling 8: progress tables reference subjects", () => {
  test("every progress table's subject_id references subjects, not enrollments (review: Opus 2)", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db, () => "2026-11-13T00:00:00Z");
    for (const table of ["freezes", "track_progress", "step_results", "attempts", "replies"]) {
      const refs = db.prepare(`PRAGMA foreign_key_list(${table})`).all().filter((r) => r["from"] === "subject_id").map((r) => r["table"]);
      expect([table, refs]).toEqual([table, ["subjects"]]);
    }
    db.close();
  });
});
