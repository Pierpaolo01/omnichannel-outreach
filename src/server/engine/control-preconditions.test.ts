import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EngineHarness, quickWait } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition } from "../../domain/sequence/definition.ts";
import type { CampaignDetail, ControlView, EnrollmentRead, LeadSearchResult } from "../../shared/api.ts";
import { openSqliteStore } from "../persistence/sqlite-store.ts";
import { Engine, InboxLocks, TickQueue } from "./engine.ts";

/**
 * A control applies only on what it was confirmed on (coordinator's ruling on the verifier's B1 at 8a1732a; ADR 0003
 * "Ticket 17a", "Preconditions"). Each request carries `expect`, the state of the read its confirmation showed: the lead's
 * status and the step the preview named (the step a skip skips, the step a restart resumes at), or the campaign's pause.
 * The engine checks it in the transaction that checks the request id, and refuses with a plain reason when it no longer
 * holds. Through the real HTTP app and SQLite store, and two engines on two connections to one file. Fictitious data.
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
    { id: "w1", channel: "email", branch: "win_back", window: ALWAYS, steps: [email("w1s1")], start: { kind: "entry" }, removed: false },
  ],
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function world(file?: string) {
  const h = new EngineHarness({ start: MONDAY_9, ...(file ? { databasePath: file } : {}), accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
  await h.tick();
  expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" })).status).toBe(200);
  const { campaign } = await h.createCampaign("Clinics", { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })], people: [person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example" })] });
  await h.defineSequence(campaign.id, DEFINITION);
  expect((await h.launch(campaign.id)).status).toBe(200);
  await h.advanceTo(MONDAY_9 + H);
  const pat = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows[0]!.enrollments[0]!.id;
  let n = 0;
  const read = async () => (await h.request<EnrollmentRead>("GET", `/api/enrollments/${pat}`)).body;
  const preview = (r: EnrollmentRead, action: string) => r.controls.find((c): c is Extract<ControlView, { allowed: true }> => c.action === action && c.allowed);
  /** What a confirmation shown on `r` sends as its precondition. */
  const expectOf = (r: EnrollmentRead, action: string) => {
    const p = preview(r, action);
    return { status: r.status, step: action === "skip" ? (p?.skips?.stepId ?? null) : action === "resume_from_next_step" || action === "move_to_win_back" ? (p?.next?.stepId ?? null) : null };
  };
  const control = (action: string, expectation: unknown, requestId = `r-${++n}`) => h.request<{ error?: { code: string; message: string }; effect?: ControlView }>("POST", `/api/enrollments/${pat}/controls`, { requestId, action, expect: expectation });
  return { h, campaign, pat, read, preview, expectOf, control };
}

const skippedSteps = (r: EnrollmentRead) => r.tracks.flatMap((t) => t.steps.filter((s) => s.result === "skipped").map((s) => s.stepId)).sort();

describe("a control applies only on what it was confirmed on", () => {
  test("a Skip confirmed on the call, sent after another tab skipped the call, is refused and skips nothing more (verifier B1 on 8a1732a)", async () => {
    const { read, expectOf, control } = await world();
    const seen = await read();
    expect(seen.controls.find((c) => c.action === "skip")).toMatchObject({ allowed: true, skips: { stepId: "c1" } });
    // Tab B skips the call on a fresh read.
    expect((await control("skip", expectOf(seen, "skip"))).status).toBe(200);
    // Tab A confirms the Skip it was shown, naming the call.
    const stale = await control("skip", expectOf(seen, "skip"));
    expect(stale.status).toBe(409);
    expect(stale.body.error).toEqual({ code: "control_refused", message: "This lead changed since you confirmed this, so nothing was changed. Look at the row again and confirm what it shows now." });
    expect(skippedSteps(await read())).toEqual(["c1"]);
  });

  test("the step is checked even when the status is the same: a Skip named for email 2 is refused once email 2 is not the step waiting", async () => {
    const { h, read, expectOf, control } = await world();
    expect((await control("skip", expectOf(await read(), "skip"))).status).toBe(200);
    const seen = await read();
    expect(seen.controls.find((c) => c.action === "skip")).toMatchObject({ allowed: true, skips: { stepId: "s2" } });
    expect((await control("skip", expectOf(seen, "skip"))).status).toBe(200);
    // The same status (active) but email 3 is now the step waiting.
    expect((await read()).status).toBe(seen.status);
    const stale = await control("skip", expectOf(seen, "skip"));
    expect(stale.status).toBe(409);
    expect(stale.body.error?.message).toBe("The step you confirmed skipping is no longer the step waiting, so nothing was skipped. Look at the row again and confirm the step it names now.");
    expect(skippedSteps(await read())).toEqual(["c1", "s2"]);
    await h.advanceTo(MONDAY_9 + 5 * 24 * H);
    expect(h.fake.deliveryLog.map((d) => d.stepId)).toContain("s3");
  });

  test("pause, resume and stop are confirmed on the status read; a restart on the step it resumes at", async () => {
    const { read, expectOf, control } = await world();
    const running = await read();
    expect((await control("stop", expectOf(running, "stop"))).status).toBe(200);
    // A Pause confirmed while they were running, sent after the stop.
    const pause = await control("pause", expectOf(running, "pause"));
    expect(pause.status).toBe(409);
    expect(pause.body.error?.message).toBe("This lead changed since you confirmed this, so nothing was changed. Look at the row again and confirm what it shows now.");
    const stopped = await read();
    expect(stopped.status).toBe("stopped_manually");
    // A restart naming a step other than the one it would resume at is refused; naming the right one, accepted.
    const wrong = await control("move_to_win_back", { status: "stopped_manually", step: "s3" });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error?.message).toBe("The step they would resume at changed since you confirmed this, so nothing was changed. Look at the row again and confirm the step it names now.");
    const right = await control("move_to_win_back", expectOf(stopped, "move_to_win_back"));
    expect(right.status).toBe(200);
    expect(right.body.effect).toMatchObject({ next: { stepId: "w1s1" } });
  });

  test("a request id is bound to its precondition too: the same id with another precondition is refused", async () => {
    const { read, expectOf, control } = await world();
    const seen = await read();
    expect((await control("pause", expectOf(seen, "pause"), "same-id")).status).toBe(200);
    expect((await control("pause", expectOf(seen, "pause"), "same-id")).status).toBe(200);
    const other = await control("pause", { status: "paused", step: null }, "same-id");
    expect(other.status).toBe(409);
    expect(other.body.error?.message).toBe("This request id was already used for another action: send a new one.");
  });

  test("a malformed precondition is a 400; a request with none is judged as before", async () => {
    const { h, pat, read, control } = await world();
    expect((await control("pause", { status: "nonsense", step: null })).status).toBe(400);
    expect((await control("pause", { status: "active" })).status).toBe(400);
    expect((await h.request("POST", `/api/enrollments/${pat}/controls`, { requestId: "no-expect", action: "pause" })).status).toBe(200);
    expect((await read()).status).toBe("paused");
  });

  test("a campaign's pause and resume are confirmed on the pause read: one confirmed while running, sent after a pause and resume elsewhere, applies; one confirmed while paused since another instant is refused", async () => {
    const { h, campaign } = await world();
    const detail = async () => (await h.request<CampaignDetail>("GET", `/api/campaigns/${campaign.id}`)).body;
    const send = (action: "pause" | "resume", pausedSince: string | null, requestId: string) => h.request<{ error?: { message: string } }>("POST", `/api/campaigns/${campaign.id}/${action}`, { requestId, expect: { pausedSince } });
    expect((await send("pause", null, "p1")).status).toBe(200);
    const first = (await detail()).pause.pausedSince;
    await h.advanceTo(MONDAY_9 + 2 * H);
    expect((await send("resume", first, "r1")).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 3 * H);
    expect((await send("pause", null, "p2")).status).toBe(200);
    // A Resume confirmed on the first pause, sent during the second.
    const stale = await send("resume", first, "r2");
    expect(stale.status).toBe(409);
    expect(stale.body.error?.message).toBe("This campaign was paused or resumed since you confirmed this, so nothing was changed. Look at it again and confirm what it shows now.");
    expect((await detail()).pause.paused).toBe(true);
    expect((await send("pause", "nonsense", "p3")).status).toBe(400);
  });
});

describe("two tabs, two processes, two request ids confirmed on one read", () => {
  test("both Skips sent at once: one applies, the other is refused, and one step is skipped", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "control-preconditions-"));
    dirs.push(dir);
    const file = path.join(dir, "app.db");
    const { h, pat, read, expectOf } = await world(file);
    const engines = [h.store.engine, openSqliteStore(file).engine].map(
      (store) => new Engine({ store, port: h.fake, now: () => h.clock, newId: (() => { let n = 0; const tag = Math.random().toString(36).slice(2, 6); return () => `${tag}-${++n}`; })(), waitFor: quickWait, ticks: new TickQueue(), locks: new InboxLocks() }),
    );
    const seen = await read();
    const expectation = expectOf(seen, "skip");
    const answers = await Promise.all(engines.map((e, i) => e.controlLead(pat, "skip", `tab-${i}`, expectation)));
    expect(answers.filter((a) => a.ok)).toHaveLength(1);
    expect(answers.flatMap((a) => (a.ok ? [] : [a.reason]))).toEqual(["This lead changed since you confirmed this, so nothing was changed. Look at the row again and confirm what it shows now."]);
    expect(skippedSteps(await read())).toEqual(["c1"]);
  });
});
