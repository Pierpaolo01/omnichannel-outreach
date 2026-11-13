import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { business, person } from "../../../test/support/export-builder.ts";
import { Crash, EngineHarness } from "../../../test/support/engine-harness.ts";
import { ScriptedEmailPort } from "../../../test/support/scripted-email-port.ts";
import type { CallAnswer } from "../../domain/sequence/attempt.ts";
import { applyReply } from "../../domain/sequence/progress.ts";
import type { SubjectState } from "../../domain/sequence/state.ts";
import type { CampaignDefinition } from "../../domain/sequence/definition.ts";
import type { EnrollmentView, NeedsAttention } from "../../shared/api.ts";
import { migrate } from "../persistence/migrations.ts";
import {
  acceptedWorkSettles,
  DAY,
  fallbackScopeAndPause,
  H,
  inbox,
  lateAcceptanceSettles,
  launched,
  lookupSentKeepsThread,
  MAX_QUEUED_LOOKUPS,
  MIN,
  MONDAY_9,
  PEOPLE,
  quickWaits,
  reimportBeatsStaleEnding,
  sendSettlesOnOriginalWork,
  SETTLING,
  step,
  twoSteps,
  unresolvedThenNotSent,
} from "../../../test/support/regressions.ts";

/**
 * Regression tests for the attempt lifecycle findings of review round 1 on PR 37, each an exact
 * event order through the real HTTP app, SQLite store and engine, against a scripted provider.
 */

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
    expect((await h.store.engine.work(attempt!.idempotencyKey))?.unresolvedSince).not.toBeNull();
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

describe("ruling 3: the verification's reproduction (B1), through the HTTP interface with the generated test's fake", () => {
  test("one inbox of capacity 1, windows 09-10 and 10-17, a lagging lookup: the provider sends once that day", async () => {
    const h = new EngineHarness({
      start: MONDAY_9 - H,
      accounts: [{ id: "inbox-a", capacity: 1, gapMs: MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
      modes: ["lookup-lags"],
      random: () => 0.95,
      engine: quickWaits,
    });
    const window = (start: number, end: number) => [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start, end }));
    const campaignWith = (start: number, end: number): CampaignDefinition => ({ ...twoSteps(), tracks: [{ ...twoSteps().tracks[0]!, window: window(start, end) }] });
    const a = await h.createCampaign("Campaign A", { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })], people: [PEOPLE[0]!] });
    const b = await h.createCampaign("Campaign B", { businesses: [business({ business_id: "b2", business_name: "Northgate Dental" })], people: [person({ person_id: "p9", business_id: "b2", full_name: "Grace Okafor", email: "grace@northgate.example" })] });
    await h.tick();
    await h.defineSequence(a.campaign.id, campaignWith(9, 10));
    await h.defineSequence(b.campaign.id, campaignWith(10, 17));
    h.clock = Date.parse("2026-11-02T09:59:00Z");
    expect((await h.launch(a.campaign.id)).status).toBe(200);
    expect((await h.launch(b.campaign.id)).status).toBe(200);
    await h.advanceTo(Date.parse("2026-11-02T23:59:00Z"));
    const monday = h.fake.deliveryLog.filter((d) => d.at < Date.parse("2026-11-03T00:00:00Z"));
    expect(monday).toHaveLength(1);
  });
});

describe("ruling 4: a provider send belongs to the provider work that produced it", () => {
  test("a send for a withdrawn attempt's key, arriving while its inheritor is claimed, settles on the original work (review: Opus 4, GPT P1)", () => sendSettlesOnOriginalWork());

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
    expect((await h.store.engine.work(attempt!.idempotencyKey))?.unresolvedSince).not.toBeNull();
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

describe("ruling 5: accepted work settles", () => {
  test("work the provider accepts and holds is looked up until MAX_QUEUED_LOOKUPS queued answers, then unresolved, and cannot be marked not sent while queued", () => acceptedWorkSettles());
});

describe("ruling 6: an unresolved attempt is still settled by a later not-sent", () => {
  test("unknown, then not-sent: the keyed attempt is withdrawn as lookup_not_sent and keeps when it became unresolved (review: Opus 3, GPT P2)", () => unresolvedThenNotSent());
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

describe("ruling 1: an off-thread reply from one person in two campaigns (found by the extended generator, seed 20261117)", () => {
  test("is recorded on every lead the inbox wrote to at that address, and stops each", async () => {
    let clock = MONDAY_9 - H;
    const port = new ScriptedEmailPort(() => clock, [inbox("inbox-a")]);
    const h = new EngineHarness({ start: clock, accounts: [], port, engine: quickWaits });
    Object.defineProperty(h, "clock", { get: () => clock, set: (v: number) => (clock = v) });
    const rows = { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })], people: [PEOPLE[0]!] };
    const a = await h.createCampaign("Campaign A", rows);
    const b = await h.createCampaign("Campaign B", rows);
    await h.tick();
    await h.defineSequence(a.campaign.id, twoSteps());
    await h.defineSequence(b.campaign.id, twoSteps());
    clock = MONDAY_9;
    await h.launch(a.campaign.id);
    await h.launch(b.campaign.id);
    await h.advanceTo(MONDAY_9 + H);
    port.reply("pat@harbour.example", false);
    await h.advanceTo(MONDAY_9 + 3 * DAY);
    for (const id of [...(await h.store.engine.subjectsOf(a.campaign.id)), ...(await h.store.engine.subjectsOf(b.campaign.id))]) {
      expect((await h.progress(id)).status).toBe("replied");
    }
    expect(port.calls.filter((c) => c.request.stepId === "s2")).toEqual([]);
  });
});

describe("review bot findings on 1c2591f", () => {
  test("engine.ts:223: a send settled by lookup before its event, then a reply: correlation survives and the lead stops (two new-subject steps)", async () => {
    const definition: CampaignDefinition = { ...twoSteps(), tracks: [{ ...twoSteps().tracks[0]!, steps: [step("s1", { subject: "Hello", threading: "new_subject" }), step("s2", { subject: "Again", threading: "new_subject", waitDays: 1 })] }] };
    const { h, port, start } = await launched([inbox("inbox-a")], [PEOPLE[0]!], definition);
    // The answer is lost; the sent event is withheld until minute 20; lookup is available at minute 15.
    port.onCall = () => ({ answer: "unknown", sendAfter: 0, eventDelay: 20 * MIN });
    const call = port.handover.bind(port);
    port.handover = async (request) => {
      await call(request);
      return { kind: "unknown" };
    };
    const lead = await start();
    await h.advanceTo(MONDAY_9 + 20 * MIN);
    port.reply("pat@harbour.example");
    await h.advanceTo(MONDAY_9 + 2 * DAY);
    expect((await h.progress(lead("Pat Oneil"))).status).toBe("replied");
    expect(port.calls.filter((c) => c.request.stepId === "s2")).toEqual([]);
    const s1 = (await h.store.engine.subject(lead("Pat Oneil"), h.clock))!.attempts.find((a) => a.stepId === "s1" && a.state === "sent");
    expect((await h.store.engine.work(s1!.idempotencyKey))?.providerRef).toBe("msg-1");
  });

  test("attempt.ts:81: a late acceptance during a pending retry still reaches lookup and settles, freeing the inbox's in-flight place", () => lateAcceptanceSettles());

  test("rules.ts:62: a re-import that gives a phone-only lead an email between evaluation and apply is not overwritten by the stale ending", () => reimportBeatsStaleEnding());
});

describe("a discarded stale evaluation is redone on fresh state (ADR 0003 2.5; found by the extended generator, seed 20261199)", () => {
  test("a lead whose only address is marked bad while it is evaluated ends in the same tick", async () => {
    const h = new EngineHarness({ start: MONDAY_9 - H, accounts: [{ id: "inbox-a", capacity: 30, gapMs: MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }], engine: quickWaits });
    const businesses = [business({ business_id: "b1", business_name: "Harbour Lane Physio" })];
    const { campaign } = await h.createCampaign("Race", { businesses, people: [PEOPLE[0]!] });
    await h.tick();
    await h.defineSequence(campaign.id, twoSteps());
    h.clock = MONDAY_9;
    await h.launch(campaign.id);
    let marked = false;
    h.hooks = {
      beforeApplyEvaluation: async (subjectId) => {
        const s = await h.store.engine.subject(subjectId, h.clock);
        const detail = s?.lead.details.find((d) => d.value === "sam@harbour.example");
        if (marked || !detail) return;
        marked = true;
        await h.store.markContactDetailBad(detail.id);
      },
    };
    h.clock = MONDAY_9 + H;
    await h.reimport(campaign.id, { businesses, people: [PEOPLE[0]!, PEOPLE[1]!] });
    await h.tick();
    expect(marked).toBe(true);
    const rows = (await h.request<{ rows: { name: string; enrollments: EnrollmentView[] }[] }>("GET", "/api/leads")).body.rows;
    expect((await h.progress(rows.find((r) => r.name === "Sam Lee")!.enrollments[0]!.id)).status).toBe("finished_no_usable_channel");
  });
});

// ---------------------------------------------------------------------------------------------
// Review round 2 on PR 37: the coordinator's rulings 1-3 and 5, each reproduced first.

/**
 * A second writer that commits a reply to a lead at every turn of the microtask queue after any
 * store write that leaves an attempt awaiting its call's answer, until the call is made. Returns
 * how many times it found an authorized attempt whose call had not yet been made.
 */
function replyInEveryGap(h: EngineHarness, port: ScriptedEmailPort): { gaps: () => number } {
  const store = h.store.engine;
  let gaps = 0;
  const watching = new Map<string, { subjectId: string; calls: number }>();
  const check = () => {
    for (const [id, w] of watching) {
      if (port.calls.filter((c) => c.request.attemptId === id).length >= w.calls) {
        watching.delete(id);
        continue;
      }
      gaps++;
      // Another tick applies an observed reply here.
      void store.update(w.subjectId, h.clock, (s) => applyReply(s, { channel: "email", atWall: h.clock, providerRef: `gap-reply-${gaps}` }, h.clock));
    }
  };
  const probe = (n: number) =>
    queueMicrotask(() => {
      check();
      if (n > 0) probe(n - 1);
    });
  const watch = (state: SubjectState | null) => {
    for (const a of state?.attempts ?? []) if (a.awaitingAnswer) watching.set(a.id, { subjectId: a.subjectId, calls: a.calls });
    probe(40);
  };
  const update = store.update.bind(store);
  store.update = async (...args) => {
    const result = await update(...args);
    watch(result);
    return result;
  };
  const updateNow = store.updateNow.bind(store);
  store.updateNow = (...args) => {
    const result = updateNow(...args);
    watch(result);
    return result;
  };
  return { gaps: () => gaps };
}

describe("review round 2, ruling 1: from the authorization commit to the port call is synchronous, and ticks run one at a time", () => {
  test.each(["first handover", "retry", "recovery after restart"] as const)("no reply can commit between a send's authorization and its call: %s", async (path) => {
    const { h, port, start } = await launched([inbox("inbox-a")]);
    // The first call's answer is lost and nothing is sent yet, so a same-key retry is authorized and called.
    if (path === "retry") port.onCall = () => ({ answer: "unknown", sendAfter: null });
    if (path === "recovery after restart") {
      // The follow-up's claim is cut short by a crash; the restarted engine hands it over.
      let crashed = false;
      h.hooks = {
        crashPoint: (point) => {
          if (point === "after_claim" && !crashed && h.clock > MONDAY_9 + H) {
            crashed = true;
            throw new Crash(point);
          }
        },
      };
    }
    const probe = replyInEveryGap(h, port);
    await start();
    await h.advanceTo(path === "recovery after restart" ? MONDAY_9 + 2 * DAY : MONDAY_9 + 10 * MIN);
    if (path === "retry") expect(port.calls.length).toBeGreaterThanOrEqual(2);
    if (path === "recovery after restart") {
      expect(h.crashes).toHaveLength(1);
      expect(port.calls.map((c) => c.request.stepId)).toEqual(["s1", "s2"]);
    }
    expect(port.calls.length).toBeGreaterThanOrEqual(1);
    expect(probe.gaps()).toBe(0);
  });

  test("a tick started while another runs waits for it: the timer, launch, recovery, the user's mark and a late answer all queue", async () => {
    const { h, port, start } = await launched([inbox("inbox-a")], PEOPLE);
    let release: (answer: CallAnswer) => void = () => undefined;
    let hanging = false;
    const answer = port.handover.bind(port);
    port.handover = async (request) => {
      const a = await answer(request);
      if (hanging) return a;
      hanging = true;
      return new Promise<CallAnswer>((resolve) => (release = resolve));
    };
    // Port waits that never time out, so the first tick stays inside its call until released.
    (h.engine as unknown as { waitFor: (p: Promise<unknown>) => Promise<unknown> }).waitFor = (p) => p;
    const lead = start();
    const started = () => hanging;
    for (let i = 0; i < 20 && !started(); i++) await new Promise((resolve) => setImmediate(resolve));
    expect(started()).toBe(true);
    const observed = port.observeCalls;
    const order: string[] = [];
    const others = [
      h.engine.tick().then(() => order.push("tick")),
      h.engine.recover().then(() => order.push("recover")),
      h.engine.markAttempt("none", "not_sent").then(() => order.push("mark")),
      h.engine.receiveLateAnswer("none", { kind: "unknown" }).then(() => order.push("late answer")),
    ];
    let waited: string[] = [];
    let observedMeanwhile = -1;
    try {
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
      waited = [...order];
      observedMeanwhile = port.observeCalls;
    } finally {
      release({ kind: "accepted", providerRef: "msg-1" });
    }
    expect(waited).toEqual([]);
    expect(observedMeanwhile).toBe(observed);
    await lead;
    order.push("launch");
    await Promise.all(others);
    expect(order[0]).toBe("launch");
    expect(port.observeCalls).toBeGreaterThan(observed);
  });
});

describe("review round 2, ruling 2: a reservation belongs to provider work and is released once, when the work settles", () => {
  test("attempt.ts:218: capacity 1, the work is unresolved and the user marks it not sent: the held capacity is listed, then freed, and the next lead sends that day", async () => {
    const { h, port, start } = await launched([inbox("inbox-a", { capacity: 1 })], PEOPLE);
    // Pat's first work is accepted and never sent; the lookup cannot say. Later work sends at once.
    port.onCall = () => (port.calls.length === 1 ? { answer: "accepted", sendAfter: null } : { answer: "accepted", sendAfter: 0 });
    port.lookupOverride = (work) => (work === port.works[0] ? { kind: "unknown" } : null);
    const lead = await start();
    await h.advanceTo(MONDAY_9 + 2 * H);
    const before = (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body;
    const pat = (await h.store.engine.subject(lead("Pat Oneil"), h.clock))!.attempts[0]!;
    expect(before.heldCapacity).toEqual([{ accountId: "inbox-a", held: 1, capacity: 1, sentToday: 0, work: [expect.objectContaining({ attemptId: pat.id, enrollmentId: lead("Pat Oneil"), stepId: "s1", destination: "pat@harbour.example", unresolvedSince: expect.any(String) })] }]);
    expect(port.deliveries.map((d) => d.subjectId)).toEqual([]);
    expect(await h.engine.markAttempt(pat.id, "not_sent")).toBe(true);
    await h.advanceTo(MONDAY_9 + 3 * H);
    // The freed daily send goes out that day: Pat's step again, under a new key, first by priority.
    expect(port.deliveries.filter((d) => d.at < MONDAY_9 + 15 * H).map((d) => d.subjectId)).toEqual([lead("Pat Oneil")]);
    expect((await h.request<NeedsAttention>("GET", "/api/needs-attention")).body.heldCapacity).toEqual([]);
  });

  test("the verification's reproduction (B2): uncertain work withdrawn after a re-import keeps its reservation visibly, and the next lead sends once the user resolves it", async () => {
    const { h, port, start, campaign } = await launched([inbox("inbox-a", { capacity: 1 })], PEOPLE);
    port.onCall = (request) => (request.destination === "pat@harbour.example" ? { answer: "accepted", sendAfter: null } : { answer: "accepted", sendAfter: 0 });
    // Lookup: unknown at minute 15, then a not-sent the transport cannot vouch for.
    port.lookupOverride = (work, now) => (work?.request.destination === "pat@harbour.example" ? (now < MONDAY_9 + 20 * MIN ? { kind: "unknown" } : { kind: "not-sent" }) : null);
    port.withdrawAnswer = "unknown";
    const lead = await start();
    await h.advanceTo(MONDAY_9 + 20 * MIN);
    // A re-import removes Pat's address: the lead has no usable channel and its work is withdrawn.
    const businesses = [business({ business_id: "b1", business_name: "Harbour Lane Physio", general_emails: "pat@harbour.example" })];
    await h.reimport(campaign.id, { businesses, people: [{ ...PEOPLE[0]!, email: "" }, PEOPLE[1]!] });
    await h.advanceTo(MONDAY_9 + 2 * DAY);
    expect((await h.progress(lead("Pat Oneil"))).status).toBe("finished_no_usable_channel");
    const pat = (await h.store.engine.subject(lead("Pat Oneil"), h.clock))!.attempts[0]!;
    expect(pat).toMatchObject({ state: "withdrawn", endedBy: "lookup_not_sent" });
    // Unsettled, the work holds its reservation.
    expect((await h.store.engine.work(pat.idempotencyKey))?.settled).toBeNull();
    const listed = (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body.heldCapacity;
    expect(listed).toEqual([{ accountId: "inbox-a", held: 1, capacity: 1, sentToday: 0, work: [expect.objectContaining({ attemptId: pat.id, enrollmentId: lead("Pat Oneil"), stepId: "s1", destination: "pat@harbour.example", unresolvedSince: expect.any(String) })] }]);
    expect(port.deliveries).toEqual([]);
    expect(await h.engine.markAttempt(pat.id, "not_sent")).toBe(true);
    await h.advanceTo(MONDAY_9 + 2 * DAY + H);
    expect(port.deliveries.map((d) => d.subjectId)).toEqual([lead("Sam Lee")]);
  });
});

describe("review round 2, ruling 3: a reply keeps its campaign's scope", () => {
  test("engine.ts:304 and the verification's reproduction (B3): a threaded reply to campaign B's message, before its sent event, stops only B", async () => {
    let clock = MONDAY_9 - H;
    const port = new ScriptedEmailPort(() => clock, [inbox("inbox-a")]);
    const h = new EngineHarness({ start: clock, accounts: [], port, engine: quickWaits });
    Object.defineProperty(h, "clock", { get: () => clock, set: (v: number) => (clock = v) });
    const rows = { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })], people: [PEOPLE[0]!] };
    const definition: CampaignDefinition = { ...twoSteps(), tracks: [{ ...twoSteps().tracks[0]!, steps: [step("s1", { subject: "Hello", threading: "new_subject" }), step("s2", { subject: "Again", threading: "new_subject", waitDays: 1 })] }] };
    const a = await h.createCampaign("Campaign A", rows);
    const b = await h.createCampaign("Campaign B", rows);
    await h.tick();
    await h.defineSequence(a.campaign.id, definition);
    await h.defineSequence(b.campaign.id, definition);
    const leadA = async () => (await h.store.engine.subjectsOf(a.campaign.id))[0]!;
    const leadB = async () => (await h.store.engine.subjectsOf(b.campaign.id))[0]!;
    // B's call (the second) loses its answer, and its sent event shows twenty minutes late.
    port.onCall = () => (port.calls.length === 2 ? { answer: "unknown", sendAfter: 0, eventDelay: 20 * MIN } : { answer: "accepted", sendAfter: 0 });
    const answer = port.handover.bind(port);
    port.handover = async (request) => {
      const result = await answer(request);
      return port.calls.length === 2 ? { kind: "unknown" } : result;
    };
    clock = MONDAY_9;
    await h.launch(a.campaign.id);
    clock = MONDAY_9 + MIN;
    await h.launch(b.campaign.id);
    expect(port.calls.map((c) => c.request.subjectId)).toEqual([await leadA(), await leadB()]);
    // A second later the prospect answers B's message, on its thread.
    clock = MONDAY_9 + MIN + 1000;
    port.reply("pat@harbour.example", true, port.deliveries.find((d) => d.at === MONDAY_9 + MIN)!.ref);
    await h.advanceTo(MONDAY_9 + 3 * DAY);
    expect((await h.progress(await leadB())).status).toBe("replied");
    expect((await h.progress(await leadA())).status).not.toBe("replied");
    const aLead = await leadA();
    expect(port.calls.filter((c) => c.request.subjectId === aLead).map((c) => c.request.stepId)).toEqual(["s1", "s2"]);
  });

  test("a reply on a thread the app never learns falls back after one settling period to work sent at or before it, pausing that inbox's sends to the address meanwhile; refused work and work handed after the reply are not matched", () => fallbackScopeAndPause());
});

describe("review round 2, ruling 5", () => {
  test("lookup confirms a send whose sent event never arrives: the live attempt carries the reference at once, and the continue-thread follow-up is called with it", () => lookupSentKeepsThread());
});

// ---------------------------------------------------------------------------------------------
// Review round 3 on PR 37 (the head 51d9503): the full search, the review bot and the first reviewer.

/** Campaigns A and B write to one person from one inbox; B's call loses its answer and its sent event shows 20 minutes late. */
async function twoCampaignsOneAddress() {
  let clock = MONDAY_9 - H;
  const port = new ScriptedEmailPort(() => clock, [inbox("inbox-a")]);
  const h = new EngineHarness({ start: clock, accounts: [], port, engine: quickWaits });
  Object.defineProperty(h, "clock", { get: () => clock, set: (v: number) => (clock = v) });
  const rows = { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })], people: [PEOPLE[0]!] };
  const definition: CampaignDefinition = { ...twoSteps(), tracks: [{ ...twoSteps().tracks[0]!, steps: [step("s1", { subject: "Hello", threading: "new_subject" }), step("s2", { subject: "Again", threading: "new_subject", waitDays: 1 })] }] };
  const a = await h.createCampaign("Campaign A", rows);
  const b = await h.createCampaign("Campaign B", rows);
  await h.tick();
  await h.defineSequence(a.campaign.id, definition);
  await h.defineSequence(b.campaign.id, definition);
  port.onCall = () => (port.calls.length === 2 ? { answer: "unknown", sendAfter: 0, eventDelay: 20 * MIN } : { answer: "accepted", sendAfter: 0 });
  const answer = port.handover.bind(port);
  port.handover = async (request) => {
    const result = await answer(request);
    return port.calls.length === 2 ? { kind: "unknown" } : result;
  };
  clock = MONDAY_9;
  await h.launch(a.campaign.id);
  clock = MONDAY_9 + MIN;
  await h.launch(b.campaign.id);
  const leadA = (await h.store.engine.subjectsOf(a.campaign.id))[0]!;
  const leadB = (await h.store.engine.subjectsOf(b.campaign.id))[0]!;
  // A second later the prospect answers B's message, on its thread, and the app holds the reply.
  clock = MONDAY_9 + MIN + 1000;
  port.reply("pat@harbour.example", true, port.deliveries.find((d) => d.at === MONDAY_9 + MIN)!.ref);
  await h.tick();
  return { h, port, leadA, leadB, set: (t: number) => (clock = t) };
}

describe("review round 3: a reply's life", () => {
  test.each([
    ["engine.ts:304 after a restart: the application restarts at 09:18, before B's delayed sent event at 09:21", MONDAY_9 + 18 * MIN],
    ["engine.ts:304 after a restart: the application restarts at 09:22, after B's delayed sent event", MONDAY_9 + 22 * MIN],
  ])("%s; only B is stopped", async (_name, restartAt) => {
    const { h, port, leadA, leadB, set } = await twoCampaignsOneAddress();
    expect((await h.store.engine.pendingReplies()).length).toBe(1);
    // The application is not running until the restart.
    set(restartAt);
    port.advance();
    await h.restart();
    await h.advanceTo(MONDAY_9 + 3 * DAY);
    expect((await h.progress(leadB)).status).toBe("replied");
    expect((await h.progress(leadA)).status).not.toBe("replied");
    expect(port.calls.filter((c) => c.request.subjectId === leadA).map((c) => c.request.stepId)).toEqual(["s1", "s2"]);
  });

  test("engine.ts:402: a reply resolved by fallback is never held again when an overlapping observation replays it, so a campaign launched after it is not paused", async () => {
    let clock = MONDAY_9 - H;
    const port = new ScriptedEmailPort(() => clock, [inbox("inbox-a")]);
    const h = new EngineHarness({ start: clock, accounts: [], port, engine: quickWaits });
    Object.defineProperty(h, "clock", { get: () => clock, set: (v: number) => (clock = v) });
    const rows = { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })], people: [PEOPLE[0]!] };
    const first = await h.createCampaign("First", rows);
    const second = await h.createCampaign("Second", rows);
    await h.tick();
    await h.defineSequence(first.campaign.id, twoSteps());
    await h.defineSequence(second.campaign.id, twoSteps());
    clock = MONDAY_9;
    await h.launch(first.campaign.id);
    // At 09:01 a reply arrives on a thread no message of the app's has; the observation window overlaps by an hour.
    clock = MONDAY_9 + MIN;
    port.events.push({ visibleAt: clock, event: { id: "reply-x", kind: "reply", providerRef: "thread-unknown", at: clock, inbox: "inbox-a", from: "pat@harbour.example" } });
    await h.advanceTo(MONDAY_9 + 17 * MIN);
    expect(await h.store.engine.pendingReplies()).toEqual([]);
    await h.launch(second.campaign.id);
    await h.advanceTo(MONDAY_9 + 20 * MIN);
    expect(await h.store.engine.pendingReplies()).toEqual([]);
    const secondLead = (await h.store.engine.subjectsOf(second.campaign.id))[0]!;
    // Matched by fallback, the reply stopped the first lead only; the second, launched after it, sends.
    expect(port.calls.filter((c) => c.request.subjectId === secondLead).map((c) => c.at)).toEqual([MONDAY_9 + 17 * MIN]);
  });

  test("Opus round 3 B1: a reply on work the user marked not sent that the provider sent anyway stops the lead; the replacement is never handed over", async () => {
    const { h, port, start } = await launched([inbox("inbox-a")]);
    // The opener's answer is lost; the provider sends it at 09:18 and its event shows two hours late; lookups cannot say.
    port.onCall = () => ({ answer: "unknown", sendAfter: 18 * MIN, eventDelay: 2 * H });
    const call = port.handover.bind(port);
    port.handover = async (request) => {
      await call(request);
      return { kind: "unknown" };
    };
    port.lookupOverride = () => ({ kind: "unknown" });
    const lead = await start();
    await h.advanceTo(MONDAY_9 + 19 * MIN);
    port.reply("pat@harbour.example");
    await h.tick();
    const opener = (await h.store.engine.subject(lead("Pat Oneil"), h.clock))!.attempts[0]!;
    expect((await h.store.engine.work(opener.idempotencyKey))?.unresolvedSince).not.toBeNull();
    h.clock = MONDAY_9 + 20 * MIN;
    expect(await h.engine.markAttempt(opener.id, "not_sent")).toBe(true);
    await h.advanceTo(MONDAY_9 + 3 * DAY);
    expect((await h.progress(lead("Pat Oneil"))).status).toBe("replied");
    expect(port.calls.filter((c) => c.at > MONDAY_9 + 19 * MIN)).toEqual([]);
  });

  test("Opus round 3 Q5: a reply with no thread from an address a re-import moved away from the person does not stop them", async () => {
    const people = [
      person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example" }),
      person({ person_id: "p2", business_id: "b1", full_name: "Sam Lee", email: "sam@harbour.example" }),
    ];
    const { h, port, start, campaign } = await launched([inbox("inbox-a")], [people[0]!]);
    const lead = await start();
    await h.advanceTo(MONDAY_9 + H);
    // Pat now uses another address; the old one is the practice's general inbox (ADR 0001 ownership).
    await h.reimport(campaign.id, {
      businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", general_emails: "pat@harbour.example" })],
      people: [{ ...people[0]!, email: "pat.oneil@harbour.example" }],
    });
    await h.tick();
    const details = (await h.store.engine.subject(lead("Pat Oneil"), h.clock))!.lead.details;
    expect(details.filter((d) => d.value === "pat@harbour.example").map((d) => d.ownEmail)).not.toContain(true);
    port.events.push({ visibleAt: h.clock, event: { id: "reply-y", kind: "reply", providerRef: null, at: h.clock, inbox: "inbox-a", from: "pat@harbour.example" } });
    await h.tick();
    expect((await h.progress(lead("Pat Oneil"))).status).not.toBe("replied");
    expect((await h.store.engine.anomalies()).map((x) => x.what)).toContain("a reply from an address the app never wrote to from that inbox");
  });
});

describe("review round 3: key inheritance", () => {
  /** Pat's opener is accepted and never sent; the first lookup says not sent, so an inheritor takes its key; later lookups cannot say. */
  async function inheritorUnresolved() {
    const { h, port, start } = await launched([inbox("inbox-a")]);
    port.onCall = () => ({ answer: "accepted", sendAfter: null });
    let lookups = 0;
    port.lookupOverride = () => (++lookups === 1 ? { kind: "not-sent" } : { kind: "unknown" });
    const lead = await start();
    await h.advanceTo(MONDAY_9 + 31 * MIN);
    const attempts = (await h.store.engine.subject(lead("Pat Oneil"), h.clock))!.attempts;
    expect(attempts.map((a) => [a.state, a.endedBy, a.idempotencyKey])).toEqual([["withdrawn", "lookup_not_sent", attempts[0]!.id], ["accepted", null, attempts[0]!.id]]);
    return { h, port, lead, attempts };
  }

  test("progress.ts:304: once a key's work settles (the user's not sent on its inheritor), no later attempt inherits it: the next attempt takes a fresh key and sends", async () => {
    const { h, port, lead, attempts } = await inheritorUnresolved();
    const listed = (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body.heldCapacity;
    expect(listed[0]!.work.map((w) => w.attemptId)).toEqual([attempts[1]!.id]);
    expect(await h.engine.markAttempt(attempts[1]!.id, "not_sent")).toBe(true);
    port.onCall = () => ({ answer: "accepted", sendAfter: 0 });
    await h.advanceTo(MONDAY_9 + 2 * H);
    const after = (await h.store.engine.subject(lead("Pat Oneil"), h.clock))!.attempts;
    expect(after[2]!.idempotencyKey).not.toBe(attempts[0]!.id);
    expect(port.deliveries.map((d) => d.subjectId)).toEqual([lead("Pat Oneil")]);
  });

  test("full search seed 20261198 and GPT round 3 finding 2: the user's not sent on the older attempt settles the work its live inheritor carries; the inheritor ends, the reservation goes, and the step proceeds under new work", async () => {
    const { h, port, lead, attempts } = await inheritorUnresolved();
    expect(await h.engine.markAttempt(attempts[0]!.id, "not_sent")).toBe(true);
    const marked = (await h.store.engine.subject(lead("Pat Oneil"), h.clock))!;
    expect(marked.attempts.map((a) => [a.state, a.endedBy])).toEqual([["withdrawn", "lookup_not_sent"], ["withdrawn", "user"]]);
    expect(marked.work[0]).toMatchObject({ settled: "user_not_sent", nextLookupWall: null });
    // The provider sends the old work after all; the step's new work sends too.
    port.works[0]!.sendAt = h.clock;
    port.onCall = () => ({ answer: "accepted", sendAfter: 0 });
    port.lookupOverride = null;
    await h.advanceTo(MONDAY_9 + 3 * H);
    const after = (await h.store.engine.subject(lead("Pat Oneil"), h.clock))!;
    expect(after.attempts.filter((a) => a.state !== "withdrawn" && a.state !== "sent")).toEqual([]);
    expect(after.attempts.at(-1)!.idempotencyKey).not.toBe(attempts[0]!.id);
    expect(after.results.map((r) => [r.stepId, r.result, r.attemptId])).toEqual([["s1", "sent", after.attempts.at(-1)!.id]]);
  });
});

describe("review round 3: the verification's reproductions on 51d9503", () => {
  test.each(["marked not sent", "refused by the provider"] as const)("B5: with a handed inheritor and the original destination removed by a re-import, the original %s settles the work: capacity is freed and the second lead sends", async (how) => {
    const { h, port, start, campaign } = await launched([inbox("inbox-a", { capacity: 1 })], PEOPLE);
    // Pat's work is accepted and never sent; the first lookup says not sent, so an inheritor carries it on; later lookups cannot say.
    port.onCall = () => ({ answer: "accepted", sendAfter: null });
    let lookups = 0;
    port.lookupOverride = () => (++lookups === 1 ? { kind: "not-sent" } : { kind: "unknown" });
    const lead = await start();
    await h.advanceTo(MONDAY_9 + 20 * MIN);
    const before = (await h.store.engine.subject(lead("Pat Oneil"), h.clock))!;
    expect(before.attempts.map((a) => a.state)).toEqual(["withdrawn", "accepted"]);
    // A re-import moves Pat's address to the practice: the lead has no usable channel.
    await h.reimport(campaign.id, { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", general_emails: "pat@harbour.example" })], people: [{ ...PEOPLE[0]!, email: "" }, PEOPLE[1]!] });
    await h.advanceTo(MONDAY_9 + 40 * MIN);
    const original = before.attempts[0]!;
    port.onCall = () => ({ answer: "accepted", sendAfter: 0 });
    if (how === "marked not sent") expect(await h.engine.markAttempt(original.id, "not_sent")).toBe(true);
    else port.events.push({ visibleAt: h.clock, event: { id: "refused-1", kind: "rejected", key: original.idempotencyKey, providerRef: port.works[0]!.ref, reason: "provider_skipped" } });
    await h.advanceTo(MONDAY_9 + 2 * DAY);
    const work = await h.store.engine.work(original.idempotencyKey);
    expect(work?.settled).toBe(how === "marked not sent" ? "user_not_sent" : "rejected");
    expect((await h.store.engine.accounts(h.clock))[0]!.used).toBeLessThanOrEqual(1);
    expect(port.deliveries.map((d) => d.subjectId)).toContain(lead("Sam Lee"));
    expect((await h.request<NeedsAttention>("GET", "/api/needs-attention")).body.heldCapacity).toEqual([]);
  });

  test("GPT round 3 finding 6: an address re-imported as the practice's general email, the person's own removed, then a reply with no thread from it: the former owner is not marked replied", async () => {
    const { h, port, start, campaign } = await launched([inbox("inbox-a")]);
    const lead = await start();
    await h.advanceTo(MONDAY_9 + H);
    await h.reimport(campaign.id, { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", general_emails: "pat@harbour.example" })], people: [{ ...PEOPLE[0]!, email: "" }] });
    await h.tick();
    const status = (await h.progress(lead("Pat Oneil"))).status;
    port.events.push({ visibleAt: h.clock, event: { id: "reply-z", kind: "reply", providerRef: null, at: h.clock, inbox: "inbox-a", from: "pat@harbour.example" } });
    await h.tick();
    expect((await h.progress(lead("Pat Oneil"))).status).toBe(status);
    expect(status).not.toBe("replied");
  });
});
