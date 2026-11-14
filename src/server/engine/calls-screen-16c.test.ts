import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { FakeMode } from "../../../test/support/fake-email-port.ts";
import type { CampaignDefinition, DeclinedPath, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import { dependentStateOf } from "./track-states.ts";
import type { ActivityEntry, ActivityView, CallTaskView, LeadSearchResult, PersonRecord, RecordCalls } from "../../shared/api.ts";

/**
 * What the not-interested screens read (ticket 16, part c; ADR 0003 "Changes from ticket 16c"), through the real
 * HTTP app, SQLite store and engine. Each addition is read-only and decided by the engine's own functions: what a
 * decline on each path offered would do, as the engine's own outcome applied to a copy of the lead (`declines`);
 * whether the phone track sets a path (Q14); what a logged decline did to each remaining track, in its state at the
 * read (Activity); and each enrollment's decline on the record. Nothing is dialled; data is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
/** Monday 2 November 2026, 09:00 London (GMT). */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const WEEKDAYS_9_TO_17 = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));

const email = (id: string, waitDays = 0): StepDefinition => ({ id, waitDays, subject: `Subject ${id}`, body: `Email ${id} for {{company}}.`, threading: "new_subject", removed: false });
const call = (id: string): StepDefinition => ({ id, waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false });
const track = (id: string, channel: TrackDefinition["channel"], steps: StepDefinition[], fields: Partial<TrackDefinition> = {}): TrackDefinition => ({
  id,
  channel,
  branch: "main",
  window: channel === "call" ? WEEKDAYS_9_TO_17 : ALWAYS,
  steps,
  start: { kind: "entry" },
  removed: false,
  ...fields,
});
const after = (trackId: string, delayDays: number) => ({ kind: "after" as const, trackId, delayDays });

/**
 * The main sequence: the phone track under test at entry (p1), an email track beside it (two emails two days apart),
 * and an email track and a second phone track a day after the call. The win-back branch, unless left out: an email at
 * once, and a second two days after it.
 */
function definition(path: DeclinedPath | undefined, branch = true): CampaignDefinition {
  return {
    timezone: "Europe/London",
    callSkipLimitDays: 2,
    emailPool: ["inbox-a"],
    smsPool: [],
    callScript: "Ask who looks after new patient bookings.",
    tracks: [
      track("p1", "call", [call("c1")], path ? { declinedPath: path } : {}),
      track("e1", "email", [email("e1s1"), email("e1s2", 2)]),
      track("e2", "email", [email("e2s1")], { start: after("p1", 1) }),
      track("p2", "call", [call("c2")], { start: after("p1", 1) }),
      ...(branch ? [track("w1", "email", [email("w1s1")], { branch: "win_back" }), track("w2", "email", [email("w2s1")], { branch: "win_back", start: after("w1", 2) })] : []),
    ],
  };
}

const PAT = person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", title: "Clinic owner", email: "pat@harbour.example", direct_phone: "+442079460111" });
const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });

async function world(modes: readonly FakeMode[] = ["honest"]) {
  const h = new EngineHarness({ start: MONDAY_9 - H, modes: [...modes], accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
  await h.tick();
  expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" })).status).toBe(200);
  h.clock = MONDAY_9;
  let personId = "";
  const campaign = async (name: string, def: CampaignDefinition) => {
    const { campaign: c } = await h.createCampaign(name, { businesses: [HARBOUR], people: [PAT] });
    await h.defineSequence(c.id, def);
    const launched = await h.launch(c.id);
    if (launched.status !== 200) throw new Error(`launch refused: ${JSON.stringify(launched.body)}`);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
    personId = rows[0]?.id ?? "";
    return { id: c.id, lead: rows[0]?.enrollments.find((e) => e.campaign.id === c.id)?.id ?? "" };
  };
  const task = async (id: string) => (await h.request<CallTaskView>("GET", `/api/call-tasks/${id}`)).body;
  const taskOf = async (enrollmentId: string, trackId = "p1") => (await h.progress(enrollmentId)).tracks.find((t) => t.trackId === trackId)?.callTask?.taskId ?? "";
  let requests = 0;
  const log = (id: string, body: Record<string, unknown>) => h.request<{ error?: { message: string } }>("POST", `/api/call-tasks/${id}/outcome`, { requestId: `req-${++requests}`, ...body });
  const decline = async (enrollmentId: string, path?: DeclinedPath) => {
    const id = await taskOf(enrollmentId);
    const direct = (await task(id)).numbers.find((n) => n.kind === "direct")?.detailId;
    return log(id, { outcome: "not_interested", numberId: direct, ...(path ? { declinedPath: path } : {}) });
  };
  const activity = async (campaignId: string) => (await h.request<ActivityView>("GET", `/api/people/${personId}/activity`)).body.entries.filter((e) => e.campaign.id === campaignId);
  const declineEntry = async (campaignId: string) => (await activity(campaignId)).find((e): e is Extract<ActivityEntry, { kind: "call"; channel: "call" }> => e.kind === "call" && e.outcome === "not_interested");
  const record = async () => (await h.request<PersonRecord & RecordCalls>("GET", `/api/people/${personId}`)).body;
  return { h, campaign, task, taskOf, decline, activity, declineEntry, record };
}

const label = (name: string) => ({ label: name, several: true, branch: name.startsWith("Win-back") ? "win_back" : "main" });
const at = (state: string, startsAt: string | null = null) => ({ state, startsAt });

describe("before Log: what a decline on each path offered would do, from the engine's own outcome on a copy (ADR 0003 4.4.1)", () => {
  test("stop ends the lead in this campaign; continue keeps the email tracks, and no call is made again; win back drops the main tracks and starts the branch", async () => {
    const { h, campaign, task, taskOf } = await world();
    const c = await campaign("Win back configured", definition("win_back"));
    await h.advanceTo(MONDAY_9 + H);
    const view = await task(await taskOf(c.lead));
    expect(view).toMatchObject({ declinedPath: "win_back", declinedPathSet: true, declinedPaths: ["stop", "continue", "win_back"] });
    expect(view.declines).toEqual([
      {
        path: "stop",
        status: "declined_on_call",
        tracks: [
          { track: label("Email track 1"), ...at("stopped_after_start") },
          { track: label("Email track 2"), ...at("stopped") },
          { track: label("Phone track 2"), ...at("stopped") },
        ],
        noMoreCalls: true,
        withProvider: 0,
      },
      {
        path: "continue",
        status: "active",
        tracks: [
          { track: label("Email track 1"), ...at("started") },
          // A day after the call, logged now on Monday: a delay counts calendar days, so it starts at the beginning of Tuesday.
          { track: label("Email track 2"), ...at("waiting", "2026-11-03T00:00:00.000Z") },
          { track: label("Phone track 2"), ...at("no_more_calls") },
        ],
        noMoreCalls: true,
        withProvider: 0,
      },
      {
        path: "win_back",
        status: "in_win_back",
        tracks: [
          { track: label("Email track 1"), ...at("dropped_for_win_back") },
          { track: label("Email track 2"), ...at("dropped_for_win_back") },
          { track: label("Phone track 2"), ...at("dropped_for_win_back") },
          { track: label("Win-back email track 1"), ...at("started") },
          { track: label("Win-back email track 2"), ...at("not_started") },
        ],
        noMoreCalls: true,
        withProvider: 0,
      },
    ]);
  });

  test("a phone track with no path set: the read says so, preselects what the engine does (stop, Q14), and offers no win back without a branch", async () => {
    const { h, campaign, task, taskOf } = await world();
    const c = await campaign("No path, no branch", definition(undefined, false));
    await h.advanceTo(MONDAY_9 + H);
    const view = await task(await taskOf(c.lead));
    expect(view).toMatchObject({ declinedPath: "stop", declinedPathSet: false, declinedPaths: ["stop", "continue"] });
    expect(view.declines?.map((d) => d.path)).toEqual(["stop", "continue"]);
  });

  test("work already with the provider is counted: it is asked to withdraw, and may still go", async () => {
    // The provider sends each email a while after the handover: the first email is with it, accepted and not yet sent.
    const { h, campaign, task, taskOf } = await world(["late-send"]);
    const c = await campaign("With the provider", definition("win_back"));
    await h.advanceTo(MONDAY_9 + 2 * MIN);
    expect((await h.progress(c.lead)).tracks.find((t) => t.trackId === "e1")?.steps[0]?.sends.map((x) => x.state)).toEqual(["accepted"]);
    const view = await task(await taskOf(c.lead));
    expect(view.declines?.map((d) => [d.path, d.withProvider])).toEqual([
      ["stop", 1],
      ["continue", 0],
      ["win_back", 1],
    ]);
  });

  test("off the list, there is nothing to preview", async () => {
    const { h, campaign, task, taskOf, decline } = await world();
    const c = await campaign("Logged", definition("stop"));
    await h.advanceTo(MONDAY_9 + H);
    const id = await taskOf(c.lead);
    expect((await decline(c.lead)).status).toBe(200);
    expect((await task(id)).declines).toBeNull();
  });
});

describe("after Log: the read agrees with the preview, and Activity says what the decline did to each track, as each stands at the read", () => {
  for (const path of ["stop", "continue", "win_back"] as const) {
    test(`${path}: the stored path, the status and every track's state are what the preview said`, async () => {
      // The provider holds each email a while after the handover, so the outcome route's own tick, which hands the
      // win-back branch's first email over at once, leaves its track started, as the preview of that instant said.
      const { h, campaign, task, taskOf, decline, declineEntry, record } = await world(["late-send"]);
      // Configured stop, so continue and win back are the user's override for this lead.
      const c = await campaign(`Declined, ${path}`, definition("stop"));
      await h.advanceTo(MONDAY_9 + H);
      const id = await taskOf(c.lead);
      const preview = (await task(id)).declines?.find((d) => d.path === path);
      expect((await decline(c.lead, path)).status).toBe(200);
      const read = await task(id);
      expect(read.status).toBe(preview?.status);
      expect(read.storedCalls.at(-1)?.declinedPath).toBe(path);
      const entry = await declineEntry(c.id);
      expect(entry?.declinedPath).toBe(path);
      expect(entry?.afterDecline).toEqual(preview?.tracks);
      expect((await record()).declines).toEqual([{ enrollmentId: c.lead, date: "2026-11-02", path }]);
    });
  }

  test("continue, a day later: the email after the call has started and finished, and the later phone track never calls", async () => {
    const { h, campaign, decline, declineEntry } = await world();
    const c = await campaign("Continue", definition("continue"));
    await h.advanceTo(MONDAY_9 + H);
    expect((await decline(c.lead)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + DAY + 2 * H);
    expect((await declineEntry(c.id))?.afterDecline).toEqual([
      { track: label("Email track 1"), ...at("started") },
      { track: label("Email track 2"), ...at("finished") },
      { track: label("Phone track 2"), ...at("skipped_declined") },
    ]);
  });

  test("a reply during win-back is any reply: the lead is handed over, and the branch's track that had not started never will", async () => {
    const { h, campaign, decline, declineEntry, activity, record } = await world();
    const c = await campaign("Win back, then a reply", definition("win_back"));
    await h.advanceTo(MONDAY_9 + H);
    expect((await decline(c.lead)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + H + 10 * MIN);
    h.fake.prospectReplies("pat@harbour.example", true, null);
    await h.advanceTo(MONDAY_9 + 2 * H);
    expect((await record()).enrollments.find((e) => e.id === c.lead)?.status).toBe("replied");
    expect((await activity(c.id)).some((e) => e.kind === "replied")).toBe(true);
    expect((await declineEntry(c.id))?.afterDecline).toEqual([
      { track: label("Email track 1"), ...at("dropped_for_win_back") },
      { track: label("Email track 2"), ...at("dropped_for_win_back") },
      { track: label("Phone track 2"), ...at("dropped_for_win_back") },
      { track: label("Win-back email track 1"), ...at("finished") },
      { track: label("Win-back email track 2"), ...at("stopped") },
    ]);
  });
});

describe("council on 4fd9ca4", () => {
  test("item 1: a later phone track with no progress yet never calls a lead who declined, in the preview and after Log", async () => {
    const { h, campaign, task, taskOf, decline, declineEntry } = await world();
    // The second phone track starts after a two-email track, which is still running when the first call is declined.
    const def = definition(undefined, false);
    const c = await campaign("Phone after email", { ...def, tracks: def.tracks.map((t) => (t.id === "p2" ? { ...t, start: after("e1", 0) } : t)) });
    await h.advanceTo(MONDAY_9 + H);
    const view = await task(await taskOf(c.lead));
    const cont = view.declines?.find((d) => d.path === "continue");
    expect(cont?.tracks.find((t) => t.track.label === "Phone track 2")).toEqual({ track: label("Phone track 2"), ...at("no_more_calls") });
    expect((await decline(c.lead, "continue")).status).toBe(200);
    expect((await declineEntry(c.id))?.afterDecline.find((t) => t.track.label === "Phone track 2")).toEqual({ track: label("Phone track 2"), ...at("no_more_calls") });
  });

  test("item 2: a track that has started is said as held, not running, while a hold stops the lead", async () => {
    const { h, campaign, task, taskOf } = await world();
    const c = await campaign("Held", definition(undefined, false));
    await h.advanceTo(MONDAY_9 + H);
    const id = await taskOf(c.lead);
    const direct = (await task(id)).numbers.find((n) => n.kind === "direct")?.detailId;
    // A callback holds the lead's outreach; its first email track had started.
    expect((await h.request("POST", `/api/call-tasks/${id}/outcome`, { requestId: "cb", outcome: "callback_requested", callbackAt: new Date(MONDAY_9 + DAY).toISOString(), numberId: direct })).status).toBe(200);
    const live = (await h.store.engine.subject(c.lead, h.clock))!;
    const e1 = live.campaign.definition.tracks.find((t) => t.id === "e1")!;
    expect(dependentStateOf(live, e1, h.clock)).toEqual({ state: "started_held", startsAt: null });
  });

  test("item 6: the record reads each enrollment's state once", async () => {
    const { h, campaign, decline, record } = await world();
    const c = await campaign("Loads", definition("stop"));
    await campaign("Loads, again", definition("continue"));
    await h.advanceTo(MONDAY_9 + H);
    expect((await decline(c.lead)).status).toBe(200);
    const subject = h.store.engine.subject.bind(h.store.engine);
    const loads: string[] = [];
    h.store.engine.subject = (id: string, now: number) => {
      loads.push(id);
      return subject(id, now);
    };
    const rec = await record();
    expect(rec.enrollments).toHaveLength(2);
    expect(rec.declines).toHaveLength(1);
    expect(loads.filter((id) => rec.enrollments.some((e) => e.id === id)).length).toBe(2);
  });
});
