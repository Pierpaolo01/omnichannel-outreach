import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { EngineHarness, quickWait } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition } from "../../domain/sequence/definition.ts";
import type { CallsView, CallTaskView, LeadSearchResult } from "../../shared/api.ts";
import { openSqliteStore } from "../persistence/sqlite-store.ts";
import { Engine, InboxLocks, TickQueue } from "./engine.ts";
import type { EngineStore } from "./engine-store.ts";

/**
 * A request id is bound to one execution and one answer across processes (council and review bot on 56d599c, item E):
 * the id is read, the action judged and applied, and the answer recorded in one write transaction in the store, for every
 * route that takes a request id. Two engines on two connections to one database each get the same id at once. A mutation
 * that reads the id outside the transaction, as the outcome route did, is caught. Fictitious data.
 */

const MIN = 60_000;
const H = 60 * MIN;
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const email = (id: string, waitDays = 0) => ({ id, waitDays, subject: `Subject ${id}`, body: "A note for {{company}}.", threading: "new_subject" as const, removed: false });
const DEFINITION: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 30,
  emailPool: ["inbox-a"],
  smsPool: [],
  callScript: "",
  tracks: [
    { id: "e1", channel: "email", branch: "main", window: ALWAYS, steps: [email("s1"), email("s2", 2), email("s3", 2)], start: { kind: "entry" }, removed: false },
    { id: "p1", channel: "call", branch: "main", window: ALWAYS, steps: [{ ...email("c1"), subject: "", body: "" }], start: { kind: "entry" }, removed: false },
  ],
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The store as the outcome route used it before item E: the id's answer read before the transaction, then trusted inside it. */
function checkOutside(store: EngineStore, file: string): EngineStore {
  const reader = new DatabaseSync(file);
  const stale = (id: string) => reader.prepare("SELECT target, action, answer, reason, effect FROM control_requests WHERE request_id = ?").get(id);
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop !== "controlSubject") return Reflect.get(target, prop, receiver) as unknown;
      return async (...args: Parameters<EngineStore["controlSubject"]>) => {
        const [subjectId, now, request, , decide] = args;
        const before = stale(request.id);
        // Another request runs between the check and the transaction.
        await new Promise((resolve) => setImmediate(resolve));
        return target.controlSubject(subjectId, now, request, () => (before ? "replay" : "new"), decide);
      };
    },
  });
}

async function world(mutate = false) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "request-ids-"));
  dirs.push(dir);
  const file = path.join(dir, "app.db");
  const h = new EngineHarness({ start: MONDAY_9, databasePath: file, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
  await h.tick();
  expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" })).status).toBe(200);
  const { campaign } = await h.createCampaign("Clinics", { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })], people: [person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example" })] });
  await h.defineSequence(campaign.id, DEFINITION);
  expect((await h.launch(campaign.id)).status).toBe(200);
  await h.advanceTo(MONDAY_9 + H);
  const pat = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows[0]!.enrollments[0]!.id;
  /** Two processes: two connections to the file, two engines, each with its own tick queue. */
  const engines = [h.store.engine, openSqliteStore(file).engine].map((store) => new Engine({ store: mutate ? checkOutside(store, file) : store, port: h.fake, now: () => h.clock, newId: (() => { let n = 0; const tag = Math.random().toString(36).slice(2, 6); return () => `${tag}-${++n}`; })(), waitFor: quickWait, ticks: new TickQueue(), locks: new InboxLocks() }));
  return { h, campaign, pat, engines };
}

describe("one request id, two processes at once: one execution, one answer", () => {
  test("an enrollment control, accepted: one skip, the same answer twice", async () => {
    const { h, pat, engines } = await world();
    const answers = await Promise.all(engines.map((e) => e.controlLead(pat, "skip", "same-skip")));
    expect(answers.map((a) => a.ok)).toEqual([true, true]);
    expect(answers.filter((a) => a.ok && a.replayed)).toHaveLength(1);
    const skipped = (await h.store.engine.subject(pat, h.clock))?.results.filter((r) => r.reason === "by_user") ?? [];
    expect(skipped).toHaveLength(1);
  });

  test("an enrollment control, refused: both refused alike, and the id stays refused after the state changes", async () => {
    const { h, pat, engines } = await world();
    const answers = await Promise.all(engines.map((e) => e.controlLead(pat, "resume", "same-resume")));
    expect(answers).toEqual([{ ok: false, reason: "They are not paused." }, { ok: false, reason: "They are not paused." }]);
    expect((await engines[0]!.controlLead(pat, "pause", "a-pause")).ok).toBe(true);
    expect(await engines[1]!.controlLead(pat, "resume", "same-resume")).toEqual({ ok: false, reason: "They are not paused." });
    expect((await h.store.engine.subject(pat, h.clock))?.subject.leadPaused).toBe(true);
  });

  test("a campaign pause and resume: one pause, one hold interval, the same answer; a refused resume stays refused", async () => {
    const { h, campaign, engines } = await world();
    const answers = await Promise.all(engines.map((e) => e.setCampaignPause(campaign.id, true, "same-pause")));
    expect(answers.map((a) => a.ok)).toEqual([true, true]);
    const db = new DatabaseSync(path.join(dirs.at(-1)!, "app.db"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM hold_intervals WHERE scope = 'campaign'").get()?.["n"]).toBe(1);
    const resumes = await Promise.all(engines.map((e) => e.setCampaignPause(campaign.id, false, "same-resume")));
    expect(resumes.map((a) => a.ok)).toEqual([true, true]);
    const refused = await Promise.all(engines.map((e) => e.setCampaignPause(campaign.id, false, "late-resume")));
    expect(refused).toEqual([{ ok: false, reason: "This campaign is not paused." }, { ok: false, reason: "This campaign is not paused." }]);
    expect((await engines[0]!.setCampaignPause(campaign.id, true, "pause-2")).ok).toBe(true);
    expect(await engines[1]!.setCampaignPause(campaign.id, false, "late-resume")).toEqual({ ok: false, reason: "This campaign is not paused." });
    db.close();
    void h;
  });

  test("a call outcome, accepted: one call record; refused: refused alike, and still refused once the call could take it", async () => {
    const { h, engines } = await world();
    const taskId = (await h.request<CallsView>("GET", "/api/calls")).body.readyNow[0]!.taskId;
    const numberId = (await h.request<CallTaskView>("GET", `/api/call-tasks/${taskId}`)).body.numbers.find((n) => !n.bad)!.detailId;
    const redial = { requestId: "same-redial", outcome: "no_answer" as const, redial: true, callbackAt: null, declinedPath: null, numberId, note: "Rang out.", noteScope: "person" as const };
    const answers = await Promise.all(engines.map((e) => e.logCallOutcome(taskId, redial)));
    expect(answers).toEqual([{ ok: true }, { ok: true }]);
    const db = new DatabaseSync(path.join(dirs.at(-1)!, "app.db"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM call_attempts WHERE request_id = 'same-redial'").get()?.["n"]).toBe(1);
    // Redialed to tomorrow: an outcome today is refused, by both, and still refused tomorrow under the same id.
    const today = { ...redial, requestId: "same-today", redial: false };
    const refused = await Promise.all(engines.map((e) => e.logCallOutcome(taskId, today)));
    expect(refused.map((a) => a.ok)).toEqual([false, false]);
    await h.advanceTo(MONDAY_9 + 24 * H);
    expect((await engines[1]!.logCallOutcome(taskId, today)).ok).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM call_attempts WHERE request_id = 'same-today'").get()?.["n"]).toBe(0);
    db.close();
  });

  test("the mutation that reads the id outside the transaction executes one request twice", async () => {
    const { h, pat, engines } = await world(true);
    await Promise.all(engines.map((e) => e.controlLead(pat, "skip", "same-skip")));
    const skipped = (await h.store.engine.subject(pat, h.clock))?.results.filter((r) => r.reason === "by_user") ?? [];
    expect(skipped.length).toBeGreaterThan(1);
  });
});
