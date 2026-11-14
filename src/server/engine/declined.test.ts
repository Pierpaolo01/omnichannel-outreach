import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition, DeclinedPath, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { ActivityView, CallsView, CallTaskView, LeadSearchResult, PersonRecord } from "../../shared/api.ts";

/**
 * A declined call (ticket 16, part a): the phone track's declined path (stop, continue on the other channels,
 * or the campaign's win-back branch), preselected from the track and overridable for one lead, through the
 * real HTTP app, SQLite store and engine, against the fake email provider. Nothing is dialled: the user
 * calls on their own phone and logs what happened. Data is fictitious.
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
 * The main sequence: a phone track at entry (p1, the path under test), an email track beside it (two emails two
 * days apart), and an email track and a second phone track a day after the call. The win-back branch, unless
 * left out: an email at once, and a second two days after it.
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
const NIA = person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", title: "Practice manager", email: "nia@harbour.example", direct_phone: "+442079460112" });
const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });

async function world() {
  const h = new EngineHarness({ start: MONDAY_9 - H, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
  await h.tick();
  expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" })).status).toBe(200);
  const campaign = async (name: string, def: CampaignDefinition) => {
    const { campaign: c } = await h.createCampaign(name, { businesses: [HARBOUR], people: [PAT, NIA] });
    await h.defineSequence(c.id, def);
    const launched = await h.launch(c.id);
    if (launched.status !== 200) throw new Error(`launch refused: ${JSON.stringify(launched.body)}`);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
    return { id: c.id, lead: (who: string) => rows.find((r) => r.name === who)?.enrollments.find((e) => e.campaign.id === c.id)?.id ?? "" };
  };
  const queue = async () => (await h.request<CallsView>("GET", "/api/calls")).body;
  const task = async (id: string) => (await h.request<CallTaskView>("GET", `/api/call-tasks/${id}`)).body;
  /** The call task of a lead's phone track, from its progress. */
  const taskOf = async (enrollmentId: string, trackId = "p1") => (await h.progress(enrollmentId)).tracks.find((t) => t.trackId === trackId)?.callTask?.taskId ?? "";
  let requests = 0;
  const log = (id: string, body: Record<string, unknown>) => h.request<{ error?: { message: string } }>("POST", `/api/call-tasks/${id}/outcome`, { requestId: `req-${++requests}`, ...body });
  /** Logs not interested on the lead's first phone track, on its direct line. */
  const decline = async (enrollmentId: string, fields: Record<string, unknown> = {}) => {
    const id = await taskOf(enrollmentId);
    const direct = (await task(id)).numbers.find((n) => n.kind === "direct")?.detailId;
    return log(id, { outcome: "not_interested", numberId: direct, ...fields });
  };
  const sent = (to: string) => h.fake.deliveryLog.filter((d) => d.destination === to).map((d) => d.stepId);
  return { h, campaign, queue, task, taskOf, log, decline, sent };
}

describe("the call task offers not interested with the phone track's declined path preselected (spec: Declined calls and the win-back branch)", () => {
  test("the configured path, and the paths the user may choose for this lead: win back only with a win-back branch", async () => {
    const { h, campaign, task, taskOf } = await world();
    h.clock = MONDAY_9;
    const withBranch = await campaign("With a branch", definition("win_back"));
    const without = await campaign("Without a branch", definition(undefined, false));
    const offered = await task(await taskOf(withBranch.lead("Pat Oneil")));
    expect(offered.outcomes).toContain("not_interested");
    expect(offered).toMatchObject({ declinedPath: "win_back", declinedPaths: ["stop", "continue", "win_back"] });
    // A phone track the canvas has not set a path on stops the lead (question Q14).
    expect(await task(await taskOf(without.lead("Pat Oneil")))).toMatchObject({ declinedPath: "stop", declinedPaths: ["stop", "continue"] });
  });
});

describe("the three paths (spec: Declined calls and the win-back branch; ticket 16)", () => {
  test("win back: the remaining main-sequence work is replaced by the branch's own tracks and copy, no call is made again, and a reply in win-back hands the lead over", async () => {
    const { h, campaign, queue, task, taskOf, decline, sent } = await world();
    h.clock = MONDAY_9;
    const c = await campaign("Spring physio", definition("win_back"));
    const other = await campaign("Autumn physio", definition("stop"));
    const pat = c.lead("Pat Oneil");
    await h.advanceTo(MONDAY_9 + H);
    expect(sent("pat@harbour.example")).toEqual(["e1s1", "e1s1"]);

    const answer = await decline(pat, { note: "Happy with their current supplier." });
    expect(answer.status).toBe(200);
    const progress = await h.progress(pat);
    expect(progress).toMatchObject({ status: "in_win_back", branch: "win_back", winBackEnteredAt: new Date(MONDAY_9 + H).toISOString(), declined: { path: "win_back", trackId: "p1", at: new Date(MONDAY_9 + H).toISOString() } });
    expect(progress.tracks.map((t) => [t.trackId, t.branch, t.finishReason])).toEqual([
      ["p1", "main", "completed"],
      ["e1", "main", "dropped_for_win_back"],
      ["e2", "main", "dropped_for_win_back"],
      ["p2", "main", "dropped_for_win_back"],
      ["w1", "win_back", "completed"],
      ["w2", "win_back", null],
    ]);
    // The call record keeps the path taken.
    expect(progress.tracks[0]?.steps[0]?.calls).toEqual([expect.objectContaining({ outcome: "not_interested", declinedPath: "win_back" })]);
    expect((await task(await taskOf(pat))).touches.at(-1)).toMatchObject({ kind: "call", outcome: "not_interested", declinedPath: "win_back" });

    // Two weeks on: the branch's emails went, the main sequence's never did, and no call was placed again.
    await h.advanceTo(MONDAY_9 + 14 * DAY);
    const spring = h.fake.deliveryLog.filter((d) => d.subjectId === pat).map((d) => d.stepId);
    expect(spring).toEqual(["e1s1", "w1s1", "w2s1"]);
    expect((await h.progress(pat)).tracks.find((t) => t.trackId === "p2")?.callTask).toBeNull();
    expect((await queue()).readyNow.some((x) => x.enrollmentId === pat)).toBe(false);
    expect((await h.progress(pat)).status).toBe("sequence_finished_no_response");

    // Other campaigns and colleagues are untouched: Pat's other enrollment and Nia still wait on their calls.
    expect((await h.progress(other.lead("Pat Oneil"))).status).not.toBe("declined_on_call");
    expect((await h.progress(c.lead("Nia Cole"))).declined).toBeNull();
    expect((await h.progress(c.lead("Nia Cole"))).branch).toBe("main");
  });

  test("a reply during win-back is the ordinary reply handoff: the lead stops in this campaign, and the branch sends nothing more", async () => {
    const { h, campaign, decline } = await world();
    h.clock = MONDAY_9;
    const c = await campaign("Spring physio", definition("win_back"));
    const pat = c.lead("Pat Oneil");
    await h.advanceTo(MONDAY_9 + H);
    expect((await decline(pat)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 2 * H);
    expect(h.fake.prospectReplies("pat@harbour.example")).toBe(true);
    await h.advanceTo(MONDAY_9 + 10 * DAY);
    expect(await h.progress(pat)).toMatchObject({ status: "replied", reply: { channel: "email" }, branch: "win_back" });
    expect(h.fake.deliveryLog.filter((d) => d.subjectId === pat).map((d) => d.stepId)).toEqual(["e1s1", "w1s1"]);
  });

  test("continue: the other channels run on, and no call is made again, the later phone track included", async () => {
    const { h, campaign, decline, sent } = await world();
    h.clock = MONDAY_9;
    const c = await campaign("Spring physio", definition("continue"));
    const pat = c.lead("Pat Oneil");
    await h.advanceTo(MONDAY_9 + H);
    expect((await decline(pat)).status).toBe(200);
    expect(await h.progress(pat)).toMatchObject({ status: "active", branch: "main", declined: { path: "continue" } });
    await h.advanceTo(MONDAY_9 + 14 * DAY);
    const progress = await h.progress(pat);
    expect(progress.tracks.map((t) => [t.trackId, t.finishReason])).toEqual([["p1", "completed"], ["e1", "completed"], ["e2", "completed"], ["p2", "skipped_declined"], ["w1", null], ["w2", null]]);
    expect(progress.tracks.find((t) => t.trackId === "p2")?.callTask).toBeNull();
    expect(progress.status).toBe("sequence_finished_no_response");
    expect(sent("pat@harbour.example").filter((s) => s.startsWith("w"))).toEqual([]);
  });

  test("stop: the lead stops in this campaign only, declined on call", async () => {
    const { h, campaign, decline } = await world();
    h.clock = MONDAY_9;
    const c = await campaign("Spring physio", definition("stop"));
    const pat = c.lead("Pat Oneil");
    await h.advanceTo(MONDAY_9 + H);
    expect((await decline(pat)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 14 * DAY);
    expect(await h.progress(pat)).toMatchObject({ status: "declined_on_call", endedAt: new Date(MONDAY_9 + H).toISOString(), declined: { path: "stop" } });
    expect(h.fake.deliveryLog.filter((d) => d.subjectId === pat).map((d) => d.stepId)).toEqual(["e1s1"]);
    expect((await h.progress(c.lead("Nia Cole"))).status).not.toBe("declined_on_call");
  });

  test("the user overrides the path for this one lead; the next lead gets the track's own", async () => {
    const { h, campaign, decline } = await world();
    h.clock = MONDAY_9;
    const c = await campaign("Spring physio", definition("win_back"));
    await h.advanceTo(MONDAY_9 + H);
    expect((await decline(c.lead("Pat Oneil"), { declinedPath: "continue" })).status).toBe(200);
    expect((await decline(c.lead("Nia Cole"))).status).toBe(200);
    expect(await h.progress(c.lead("Pat Oneil"))).toMatchObject({ status: "active", declined: { path: "continue" } });
    expect(await h.progress(c.lead("Nia Cole"))).toMatchObject({ status: "in_win_back", declined: { path: "win_back" } });
  });

  test("refused plainly, changing nothing: win back with no branch, a declined path with another outcome, and a path this release does not know", async () => {
    const { h, campaign, task, taskOf, decline } = await world();
    h.clock = MONDAY_9;
    const c = await campaign("No branch", definition("stop", false));
    const pat = c.lead("Pat Oneil");
    await h.advanceTo(MONDAY_9 + H);
    const winBack = await decline(pat, { declinedPath: "win_back" });
    expect(winBack.status).toBe(409);
    expect(winBack.body.error?.message).toBe("This campaign has no win-back branch: choose stop or continue.");
    const withAnother = await decline(pat, { outcome: "no_answer", declinedPath: "continue" });
    expect(withAnother.status).toBe(409);
    expect(withAnother.body.error?.message).toBe("A declined path goes with not interested only.");
    expect((await decline(pat, { declinedPath: "later" })).status).toBe(400);
    const after = await task(await taskOf(pat));
    expect(after.open).toBe(true);
    expect(after.touches.filter((t) => t.kind === "call")).toEqual([]);
    expect((await h.progress(pat)).status).toBe("waiting_on_call");
  });
});

describe("Activity says what was declined and which path was taken", () => {
  test("a person's timeline lists the decline with its path and track", async () => {
    const { h, campaign, decline } = await world();
    h.clock = MONDAY_9;
    const c = await campaign("Spring physio", definition("win_back"));
    await h.advanceTo(MONDAY_9 + H);
    expect((await decline(c.lead("Pat Oneil"))).status).toBe(200);
    const pat = (await h.request<LeadSearchResult>("GET", "/api/leads?q=Pat")).body.rows[0]!;
    expect((await h.request<PersonRecord>("GET", `/api/people/${pat.id}`)).body.enrollments[0]?.status).toBe("in_win_back");
    const activity = (await h.request<ActivityView>("GET", `/api/people/${pat.id}/activity`)).body;
    expect(activity.declines).toEqual([{ campaign: { id: c.id, name: "Spring physio" }, at: new Date(MONDAY_9 + H).toISOString(), track: { label: "Phone track 1", several: true }, path: "win_back" }]);
    await h.advanceTo(MONDAY_9 + 2 * H);
    // The branch's emails are named as the branch's tracks.
    expect((await h.request<ActivityView>("GET", `/api/people/${pat.id}/activity`)).body.entries.find((e) => e.kind === "sent" && e.stepNumber === 1 && e.at >= new Date(MONDAY_9 + H).toISOString())).toMatchObject({ track: { label: "Win-back email track 1", several: true } });
  });
});
