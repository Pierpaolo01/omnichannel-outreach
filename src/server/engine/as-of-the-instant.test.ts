import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, csvOf, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { CallTask as SubjectStateTask } from "../../domain/sequence/state.ts";
import type { CallsView, CallTaskView, EnrollmentProgress, LeadSearchResult, NeedsAttention, TodayView } from "../../shared/api.ts";

/**
 * Ticket 15a, council on 228cd3b. Everything the engine decides about a lead is decided as of an
 * instant, whether or not the worker has ticked since what fell due: a user action, every route that
 * changes an input the engine's timing reads (which first applies what fell due under the old inputs),
 * and every read model. The past, once judged, is not reinterpreted by a later input. Fictitious data only.
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
/** Monday 2 November 2026, 09:00 London (GMT). */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const WED_0 = Date.parse("2026-11-04T00:00:00Z");
const WEEKDAYS_9_TO_17 = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
/** Monday 09:00-17:00 and Tuesday 21:00-23:00: in London, Tuesday is a calling day; in New York, Tuesday (London) is not. */
const MON_AND_TUE_EVENING = [
  { day: 1, start: 9, end: 17 },
  { day: 2, start: 21, end: 23 },
];

const call = (id: string): StepDefinition => ({ id, waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false });
const phone = (id: string, window = WEEKDAYS_9_TO_17, start: TrackDefinition["start"] = { kind: "entry" }): TrackDefinition => ({ id, channel: "call", branch: "main", window, steps: [call(`${id}c`)], start, removed: false });
const definition = (tracks: TrackDefinition[], fields: Partial<CampaignDefinition> = {}): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: [], smsPool: [], callScript: "", tracks, ...fields });

const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });
const pat = (timezone = "") => person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", direct_phone: "+442079460111", timezone });
const NIA = person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", dial_phone: "+447700900102", dial_phone_type: "mobile" });

async function world(def: CampaignDefinition, options: { capacity?: number; people?: Record<string, string>[] } = {}) {
  const h = new EngineHarness({ start: MONDAY_9 - H, accounts: [] });
  await h.tick();
  expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: options.capacity ?? 20, userZone: "Europe/London" })).status).toBe(200);
  h.clock = MONDAY_9;
  const people = options.people ?? [pat()];
  const { campaign } = await h.createCampaign("As of the instant", { businesses: [HARBOUR], people });
  await h.defineSequence(campaign.id, def);
  expect((await h.launch(campaign.id)).status).toBe(200);
  const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows;
  const lead = (who: string) => rows.find((r) => r.name === who)?.enrollments[0]?.id ?? "";
  const progress = async (who: string) => (await h.request<EnrollmentProgress>("GET", `/api/enrollments/${lead(who)}`)).body;
  const taskOf = async (who: string, track: string) => (await progress(who)).tracks.find((t) => t.trackId === track)?.callTask?.taskId ?? "";
  let n = 0;
  const log = async (taskId: string, body: Record<string, unknown>) => {
    const view = (await h.request<CallTaskView>("GET", `/api/call-tasks/${taskId}`)).body;
    return h.request<{ error?: { message: string } }>("POST", `/api/call-tasks/${taskId}/outcome`, { requestId: `r${++n}`, numberId: view.numbers.find((x) => !x.bad)?.detailId, ...body });
  };
  return { h, campaign, progress, taskOf, log };
}

/** The worker last ticked at Tuesday 23:59; the clock is now Wednesday 00:00:01. */
async function staleAfterTheRollover(h: EngineHarness) {
  await h.advanceTo(WED_0 - MIN);
  h.clock = WED_0 + 1_000;
}

const callback = { outcome: "callback_requested", callbackAt: "2026-11-05T15:00:00Z" };

describe("a route that changes an input the engine's timing reads first applies what fell due under the old inputs (council on 228cd3b, blocking)", () => {
  const def = () => definition([phone("p1", MON_AND_TUE_EVENING)]);
  const skippedAtTheRollover = async (progress: (who: string) => Promise<EnrollmentProgress>) =>
    expect((await progress("Pat Oneil")).tracks[0]).toMatchObject({ finishReason: "skipped_unworked", finishedAt: "2026-11-04T00:00:00.000Z", callTask: { open: false } });

  test("a re-import that moves the prospect to New York, between the rollover and the worker's tick: the call that expired under London stays expired, and a callback is refused", async () => {
    const { h, campaign, progress, taskOf, log } = await world(def());
    const id = await taskOf("Pat Oneil", "p1");
    await staleAfterTheRollover(h);
    await h.reimport(campaign.id, { businesses: [HARBOUR], people: [pat("America/New_York")] });
    await skippedAtTheRollover(progress);
    expect((await log(id, callback)).status).toBe(409);
  });

  test("a change of the call list's zone to New York, between the rollover and the worker's tick: the expiry under London stands, and a callback is refused", async () => {
    const { h, progress, taskOf, log } = await world(def());
    const id = await taskOf("Pat Oneil", "p1");
    await staleAfterTheRollover(h);
    expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "America/New_York" })).status).toBe(200);
    await skippedAtTheRollover(progress);
    expect((await log(id, callback)).status).toBe(409);
  });

  test("every route that writes is either one that changes a timing input, and catches up first, or one that changes none", async () => {
    // A route that changes what the engine's timing reads: the prospect's zone (imports), the user's day and
    // zone (call settings). Each, called between a rollover and the worker's tick, leaves the call skipped at that rollover.
    const timing: Record<string, (h: EngineHarness, campaignId: string) => Promise<number>> = {
      "POST /api/campaigns": async (h) => (await h.request("POST", "/api/campaigns", { name: "Another", defaultTimezone: "Europe/London", ...csvOf({ businesses: [HARBOUR], people: [pat("America/New_York")] }) })).status,
      "POST /api/campaigns/:id/imports": async (h, campaignId) => (await h.request("POST", `/api/campaigns/${campaignId}/imports`, csvOf({ businesses: [HARBOUR], people: [pat("America/New_York")] }))).status,
      "PUT /api/call-settings": async (h) => (await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "America/New_York" })).status,
    };
    // Every other route that writes, and why it changes no timing input of a running lead.
    const none: Record<string, string> = {
      "POST /api/scraper-files/check": "checks files; writes nothing",
      "PUT /api/campaigns/:id/sequence": "refused once the campaign has launched (ticket 19); before launch no lead of it runs",
      "POST /api/campaigns/:id/launch": "enters and evaluates each lead at its own instant",
      "POST /api/call-tasks/:id/outcome": "judged as of its own instant (asOfAction)",
      "POST /api/enrollments/:id/controls": "judged as of its own instant (asOfAction, ticket 17a); a pause holds the clock, which every stored deadline reads",
      "POST /api/campaigns/:id/pause": "each lead judged as of the pause's instant (asOfAction), then held, in one transaction (ticket 17a)",
      "POST /api/campaigns/:id/resume": "each lead judged as of the resume's instant (asOfAction), then released, in one transaction (ticket 17a)",
    };
    const probe = await world(def());
    const routes = [...new Set(probe.h.app.routes.filter((r) => ["POST", "PUT", "PATCH", "DELETE"].includes(r.method)).map((r) => `${r.method} ${r.path}`))];
    expect(routes.filter((r) => !(r in timing) && !(r in none)), "a route that writes is in neither list: classify it").toEqual([]);
    for (const [route, call] of Object.entries(timing)) {
      const { h, campaign, progress } = await world(def());
      await staleAfterTheRollover(h);
      expect([route, await call(h, campaign.id)]).toEqual([route, route.startsWith("PUT") ? 200 : 201]);
      expect([route, (await progress("Pat Oneil")).tracks[0]?.finishReason]).toEqual([route, "skipped_unworked"]);
    }
  });
});

describe("the read models are as of the instant they are read (council on 228cd3b, item 2)", () => {
  test("between the rollover and the worker's tick, Today, the queue, the task and Needs attention show the expired call as gone", async () => {
    const { h, taskOf } = await world(definition([phone("p1")]));
    const id = await taskOf("Pat Oneil", "p1");
    await staleAfterTheRollover(h);
    expect((await h.request<TodayView>("GET", "/api/today")).body.upNext).toEqual([]);
    const queue = (await h.request<CallsView>("GET", `/api/calls?focus=${id}`)).body;
    expect([queue.readyNow, queue.laterToday, queue.focusTaskId]).toEqual([[], [], null]);
    expect((await h.request<CallTaskView>("GET", `/api/call-tasks/${id}`)).body).toMatchObject({ open: false, listed: false, outcomes: [], task: null });
    expect((await h.request<NeedsAttention>("GET", "/api/needs-attention")).body.overdueCallbacks).toEqual([]);
  });
});

describe("a call counts against the day's capacity only if it can be listed that day (council on 228cd3b, item 3)", () => {
  test("a lead held by a callback on one phone track: its other track's carried call takes no place", async () => {
    const { h, taskOf, log } = await world(definition([phone("a"), phone("b")]), { capacity: 2, people: [pat()] });
    const a = await taskOf("Pat Oneil", "a");
    await h.advanceTo(MONDAY_9 + H);
    // Pat asks to be called back next Monday: both of Pat's calls are carried, but only the callback can be listed (and only on its day).
    expect((await log(a, { outcome: "callback_requested", callbackAt: "2026-11-09T10:00:00Z" })).status).toBe(200);
    await h.advanceTo(MONDAY_9 + DAY + H);
    expect((await h.request<CallsView>("GET", "/api/calls")).body.committed).toBe(0);
  });

  test("a carried callback whose lead has no good number left takes no place (Q13)", async () => {
    // Pat's only number is the company main line; a colleague's wrong-number call marks it bad.
    const patOnTheMainLine = person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil" });
    const { h, taskOf, log } = await world(definition([phone("a")]), { capacity: 2, people: [patOnTheMainLine, NIA] });
    const pats = await taskOf("Pat Oneil", "a");
    const nias = await taskOf("Nia Cole", "a");
    await h.advanceTo(MONDAY_9 + H);
    expect((await log(pats, { outcome: "callback_requested", callbackAt: "2026-11-03T10:00:00Z" })).status).toBe(200);
    const mainLine = (await h.request<CallTaskView>("GET", `/api/call-tasks/${nias}`)).body.numbers.find((x) => x.kind === "main_line")?.detailId;
    expect((await h.request("POST", `/api/call-tasks/${nias}/outcome`, { requestId: "wrong-main", outcome: "wrong_number", numberId: mainLine })).status).toBe(200);
    // Tuesday, the callback's day: it is listed and overdue, but no call can be logged on it, so it takes no place.
    await h.advanceTo(MONDAY_9 + DAY + 2 * H);
    expect((await h.request<CallsView>("GET", "/api/calls")).body).toMatchObject({ committed: 0, readyNow: [expect.objectContaining({ taskId: pats, reason: "overdue" })] });
  });
});

describe("why a call is on the list (council on 228cd3b, item 4)", () => {
  test("a call redialed on Friday is a redial on Monday, its first listed day, not rolled over", async () => {
    // A limit of nine days: the deadline is the start of the second Wednesday, so the call is open all the second Tuesday.
    const { h, taskOf, log } = await world(definition([phone("p1")], { callSkipLimitDays: 9 }));
    const id = await taskOf("Pat Oneil", "p1");
    await h.advanceTo(MONDAY_9 + 4 * DAY + H);
    expect((await log(id, { outcome: "no_answer", redial: true })).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 7 * DAY + H);
    expect((await h.request<TodayView>("GET", "/api/today")).body.upNext).toEqual([expect.objectContaining({ taskId: id, reason: "redial" })]);
    await h.advanceTo(MONDAY_9 + 8 * DAY + H);
    expect((await h.request<TodayView>("GET", "/api/today")).body.upNext).toEqual([expect.objectContaining({ taskId: id, reason: "rolled_over" })]);
  });
});

describe("an edited skip limit re-resolves an open call's deadline, and nothing else moves it (ADR 0003 3.5, 5.2; pull request 47's review)", () => {
  test("the store accepts the re-resolution from the call's own due time with the limit now in force, and refuses any other change", async () => {
    const { h, campaign, taskOf } = await world(definition([phone("p1")]));
    const id = await taskOf("Pat Oneil", "p1");
    // Ticket 19 will publish a running edit; here the stored definition's limit goes from 2 to 4 days directly.
    const db = (h.store.engine as unknown as { db: { prepare(sql: string): { get(...a: unknown[]): Record<string, unknown> | undefined; run(...a: unknown[]): unknown } } }).db;
    const row = db.prepare("SELECT definition FROM campaigns WHERE id = ?").get(campaign.id);
    db.prepare("UPDATE campaigns SET definition = ?, version = version + 1, definition_version = definition_version + 1 WHERE id = ?").run(JSON.stringify({ ...JSON.parse(String(row?.["definition"])), callSkipLimitDays: 4 }), campaign.id);
    const subjectId = (await h.store.engine.callTaskSubject(id)) ?? "";
    const deadlineAfter = (days: number) => Date.parse("2026-11-02T00:00:00Z") + days * DAY - MONDAY_9;
    const reresolved = await h.store.engine.update(subjectId, h.clock, (s) => ({ ...s, callTasks: s.callTasks.map((t) => ({ ...t, skipDeadline: t.dueAt + deadlineAfter(4) })) }));
    expect(reresolved?.callTasks[0]?.skipDeadline).toBe(reresolved!.callTasks[0]!.dueAt + deadlineAfter(4));
    await expect(h.store.engine.update(subjectId, h.clock, (s) => ({ ...s, callTasks: s.callTasks.map((t) => ({ ...t, skipDeadline: t.skipDeadline + DAY })) }))).rejects.toThrow("keeps its skip deadline unless its limit is edited");
  });
});

describe("what the store accepts of a call task is what it stores (review bot on e489037)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  async function onFile() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "call-task-columns-"));
    dirs.push(dir);
    const file = path.join(dir, "app.db");
    const h = new EngineHarness({ start: MONDAY_9, databasePath: file, accounts: [] });
    await h.tick();
    expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" })).status).toBe(200);
    const { campaign } = await h.createCampaign("Columns", { businesses: [HARBOUR], people: [pat()] });
    await h.defineSequence(campaign.id, definition([phone("p1")]));
    expect((await h.launch(campaign.id)).status).toBe(200);
    const taskId = (await h.request<CallsView>("GET", "/api/calls")).body.focusTaskId ?? "";
    const subjectId = (await h.store.engine.callTaskSubject(taskId)) ?? "";
    return { h, file, campaign, subjectId };
  }

  test("a re-resolved skip deadline, written, the store closed and reopened, is the deadline read back", async () => {
    const { h, file, campaign, subjectId } = await onFile();
    const db = (h.store.engine as unknown as { db: { prepare(sql: string): { get(...a: unknown[]): Record<string, unknown> | undefined; run(...a: unknown[]): unknown } } }).db;
    const row = db.prepare("SELECT definition FROM campaigns WHERE id = ?").get(campaign.id);
    db.prepare("UPDATE campaigns SET definition = ?, version = version + 1, definition_version = definition_version + 1 WHERE id = ?").run(JSON.stringify({ ...JSON.parse(String(row?.["definition"])), callSkipLimitDays: 4 }), campaign.id);
    const reresolved = Date.parse("2026-11-06T00:00:00Z") - MONDAY_9;
    await h.store.engine.update(subjectId, h.clock, (s) => ({ ...s, callTasks: s.callTasks.map((t) => ({ ...t, skipDeadline: t.dueAt + reresolved })) }));
    await h.store.close();
    const reopened = new EngineHarness({ start: h.clock, databasePath: file, accounts: [] });
    const task = (await reopened.store.engine.subject(subjectId, reopened.clock))?.callTasks[0];
    expect(task?.skipDeadline).toBe((task?.dueAt ?? 0) + reresolved);
    await reopened.store.close();
  });

  test("a change to a column the store never updates (its due wall time and zone, placement, track or step) is refused, not silently dropped", async () => {
    const { h, subjectId } = await onFile();
    const changes: Record<string, (t: SubjectStateTask) => SubjectStateTask> = {
      dueWall: (t) => ({ ...t, dueWall: t.dueWall + H }),
      dueZone: (t) => ({ ...t, dueZone: "America/New_York" }),
      placedWall: (t) => ({ ...t, placedWall: t.placedWall + H }),
      trackId: (t) => ({ ...t, trackId: "p2" }),
      stepId: (t) => ({ ...t, stepId: "p2c" }),
    };
    for (const [field, change] of Object.entries(changes)) {
      await expect(h.store.engine.update(subjectId, h.clock, (s) => ({ ...s, callTasks: s.callTasks.map(change) })), field).rejects.toThrow("a call task keeps");
    }
    await h.store.close();
  });
});
