import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { CallsView, CampaignDetail, ControlView, EnrollmentRead, LeadSearchResult } from "../../shared/api.ts";

/**
 * Pause, resume, skip, stop and restart (ticket 17a) through the real HTTP app, SQLite store and engine, against
 * the fake email provider: ADR 0003 "Ticket 17a". Nothing is dialled. Data is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
/** Monday 2 November 2026, 09:00 London (GMT). */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const WEEKDAYS_9_TO_17 = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));

const email = (id: string, waitDays = 0): StepDefinition => ({ id, waitDays, subject: `Subject ${id}`, body: `Email ${id} for {{company}}.`, threading: "new_subject", removed: false });
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
/** Three emails, two days then three days apart, a call beside them, and a win-back email. */
const DEFINITION: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["inbox-a"],
  smsPool: [],
  callScript: "Ask who looks after new patient bookings.",
  tracks: [
    track("e1", "email", [email("s1"), email("s2", 2), email("s3", 3)]),
    track("p1", "call", [{ ...email("c1"), subject: "", body: "" }]),
    track("w1", "email", [email("w1s1"), email("w1s2", 2)], { branch: "win_back" }),
  ],
};
const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });
const PAT = person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", direct_phone: "+442079460111" });
const NIA = person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", email: "nia@harbour.example", direct_phone: "+442079460112" });

async function world(def: CampaignDefinition = DEFINITION) {
  const h = new EngineHarness({ start: MONDAY_9, accounts: [{ id: "inbox-a", capacity: 50, gapMs: 10 * MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
  await h.tick();
  expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" })).status).toBe(200);
  const campaign = async (name: string) => {
    const { campaign: c } = await h.createCampaign(name, { businesses: [HARBOUR], people: [PAT, NIA] });
    await h.defineSequence(c.id, def);
    expect((await h.launch(c.id)).status).toBe(200);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
    return { id: c.id, lead: (who: string) => rows.find((r) => r.name === who)?.enrollments.find((e) => e.campaign.id === c.id)?.id ?? "" };
  };
  let n = 0;
  const control = (enrollmentId: string, action: string, requestId = `r-${++n}`) => h.request<{ error?: { message: string }; enrollment?: EnrollmentRead; replayed?: boolean }>("POST", `/api/enrollments/${enrollmentId}/controls`, { requestId, action });
  const campaignControl = (id: string, action: "pause" | "resume", requestId = `r-${++n}`) => h.request<{ error?: { message: string } } & Partial<CampaignDetail>>("POST", `/api/campaigns/${id}/${action}`, { requestId });
  const read = async (id: string) => (await h.request<EnrollmentRead>("GET", `/api/enrollments/${id}`)).body;
  const sent = (enrollmentId: string) => h.fake.deliveryLog.filter((d) => d.subjectId === enrollmentId).map((d) => d.stepId);
  return { h, campaign, control, campaignControl, read, sent };
}
const controlOf = (read: EnrollmentRead, action: string): ControlView => read.controls.find((c) => c.action === action)!;

describe("pausing a campaign", () => {
  test("during a wait: nothing is sent, its calls leave the list, and every wait resumes moved by the time paused", async () => {
    const { h, campaign, campaignControl, read, sent } = await world();
    const c = await campaign("Clinics");
    const pat = c.lead("Pat Oneil");
    await h.advanceTo(MONDAY_9 + H);
    expect(sent(pat)).toEqual(["s1"]);
    const dueBefore = (await read(pat)).tracks.find((t) => t.trackId === "e1")?.nextStep?.dueAt;
    const q0 = (await h.request<CallsView>("GET", "/api/calls")).body;
    expect(q0.readyNow.length, JSON.stringify(q0).slice(0, 800)).toBe(2);

    const paused = await campaignControl(c.id, "pause");
    expect(paused.status).toBe(200);
    expect(paused.body.pause).toEqual({ paused: true, pausedSince: new Date(MONDAY_9 + H).toISOString() });
    // A campaign pause changes no status: the counts are of the statuses the leads keep.
    expect(paused.body.statusCounts, JSON.stringify(paused.body)).toMatchObject({ waiting_on_call: 2 });
    expect((await h.request<CallsView>("GET", "/api/calls")).body.readyNow).toEqual([]);

    // A week paused: nothing is sent, nothing listed.
    await h.advanceTo(MONDAY_9 + H + 7 * DAY);
    expect(sent(pat)).toEqual(["s1"]);
    expect((await h.request<CallsView>("GET", "/api/calls")).body.readyNow).toEqual([]);
    expect((await campaignControl(c.id, "pause")).body.error?.message).toMatch(/already paused/);

    expect((await campaignControl(c.id, "resume")).status).toBe(200);
    const dueAfter = (await read(pat)).tracks.find((t) => t.trackId === "e1")?.nextStep?.dueAt;
    expect(dueBefore).toBe("2026-11-04T00:00:00.000Z");
    expect(dueAfter).toBe("2026-11-11T00:00:00.000Z");
    expect((await h.request<CallsView>("GET", "/api/calls")).body.readyNow.length).toBe(2);
  });

  test("resume spreads what fell due across the pacing gap, without a burst, and another campaign is untouched", async () => {
    const { h, campaign, campaignControl, read } = await world();
    const a = await campaign("Clinics");
    const b = await campaign("Dentists");
    await h.advanceTo(MONDAY_9 + 2 * H);
    expect((await campaignControl(a.id, "pause")).status).toBe(200);
    const otherBefore = await read(b.lead("Pat Oneil"));
    await h.advanceTo(MONDAY_9 + 10 * DAY);
    // The other campaign ran on.
    expect((await read(b.lead("Pat Oneil"))).tracks).not.toEqual(otherBefore.tracks);
    expect((await campaignControl(a.id, "resume")).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 10 * DAY + 6 * H);
    const calls = h.fake.handoverLog.map((x) => x.at).sort((x, y) => x - y);
    for (let i = 1; i < calls.length; i++) expect(calls[i]! - calls[i - 1]!).toBeGreaterThanOrEqual(10 * MIN);
  });
});

describe("one lead's controls", () => {
  test("pause and resume one lead; its colleague runs on", async () => {
    const { h, campaign, control, read, sent } = await world();
    const c = await campaign("Clinics");
    const pat = c.lead("Pat Oneil");
    const nia = c.lead("Nia Cole");
    await h.advanceTo(MONDAY_9 + H);
    const offered = controlOf(await read(pat), "pause");
    expect(offered).toMatchObject({ allowed: true, statusAfter: "paused" });
    expect((await control(pat, "pause")).body.enrollment?.status).toBe("paused");
    expect((await h.request<CallsView>("GET", "/api/calls")).body.readyNow.map((x) => x.enrollmentId)).toEqual([nia]);
    await h.advanceTo(MONDAY_9 + 4 * DAY);
    expect(sent(pat)).toEqual(["s1"]);
    expect(sent(nia)).toEqual(["s1", "s2"]);
    expect(controlOf(await read(pat), "pause")).toEqual({ action: "pause", allowed: false, reason: "They are already paused." });
    const resumed = await control(pat, "resume");
    expect(resumed.body.enrollment?.status).toBe("waiting_on_call");
  });

  test("skip advances exactly one step and never sends it; a repeated request skips once", async () => {
    const { h, campaign, control, read, sent } = await world();
    const c = await campaign("Clinics");
    const pat = c.lead("Pat Oneil");
    await h.advanceTo(MONDAY_9 + H);
    const preview = controlOf(await read(pat), "skip");
    // The current step is the one due first: the call, due at launch, before email 2.
    expect(preview).toMatchObject({ allowed: true, skips: { trackId: "p1", number: 1, of: 1 } });
    expect((await control(pat, "skip", "skip-1")).status).toBe(200);
    const again = await control(pat, "skip", "skip-1");
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    const after = await read(pat);
    expect(after.tracks.find((t) => t.trackId === "p1")?.finishReason).toBe("skipped_by_user");
    expect(after.tracks.find((t) => t.trackId === "e1")?.finishReason).toBeNull();
    // The next skip is email 2, which then never goes; email 3 is due three days after the skip.
    expect((await control(pat, "skip")).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 6 * DAY);
    expect(sent(pat)).toEqual(["s1", "s3"]);
    expect(h.fake.deliveryLog.find((d) => d.subjectId === pat && d.stepId === "s3")?.at).toBe(Date.parse("2026-11-05T00:00:00Z"));
    // Reusing an id for another action is refused.
    expect((await control(pat, "stop", "skip-1")).body.error?.message).toMatch(/already used/);
  });

  test("stop is final until a restart; restart after an auto-reply continues at the next unsent step without sending anything twice", { timeout: 60_000 }, async () => {
    const { h, campaign, control, read, sent } = await world();
    const c = await campaign("Clinics");
    const pat = c.lead("Pat Oneil");
    await h.advanceTo(MONDAY_9 + H);
    expect(h.fake.prospectReplies("pat@harbour.example")).toBe(true);
    await h.advanceTo(MONDAY_9 + 2 * H);
    expect((await read(pat)).status).toBe("replied");
    expect(controlOf(await read(pat), "stop")).toMatchObject({ allowed: false });
    const restart = controlOf(await read(pat), "resume_from_next_step");
    expect(restart).toMatchObject({ allowed: true, statusAfter: "waiting_on_call" });
    expect((await control(pat, "resume_from_next_step")).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 3 * DAY);
    expect(sent(pat)).toEqual(["s1", "s2"]);
    const stopped = await control(pat, "stop");
    expect(stopped.body.enrollment?.status).toBe("stopped_manually");
    // Stopped: email 3, due on the Saturday, never goes, and no call is listed.
    await h.advanceTo(MONDAY_9 + 7 * DAY);
    expect(sent(pat)).toEqual(["s1", "s2"]);
    expect((await h.request<CallsView>("GET", "/api/calls")).body.readyNow.map((x) => x.enrollmentId)).not.toContain(pat);
    // A restart continues with email 3, its wait frozen while stopped: due Saturday 00:00 plus the four days
    // stopped. Nothing is sent twice.
    expect((await control(pat, "resume_from_next_step")).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 9 * DAY);
    expect(sent(pat)).toEqual(["s1", "s2", "s3"]);
    expect(h.fake.deliveryLog.find((d) => d.subjectId === pat && d.stepId === "s3")?.at).toBe(Date.parse("2026-11-11T00:00:00Z"));
  });

  test("a stopped lead moves into win-back, with no call, and the colleague is untouched", async () => {
    const { h, campaign, control, read, sent } = await world();
    const c = await campaign("Clinics");
    const pat = c.lead("Pat Oneil");
    await h.advanceTo(MONDAY_9 + H);
    expect((await control(pat, "stop")).status).toBe(200);
    expect(controlOf(await read(pat), "move_to_win_back")).toMatchObject({ allowed: true, statusAfter: "in_win_back", next: { trackId: "w1", branch: "win_back" } });
    expect((await control(pat, "move_to_win_back")).body.enrollment?.status).toBe("in_win_back");
    await h.advanceTo(MONDAY_9 + 2 * H);
    expect(sent(pat)).toEqual(["s1", "w1s1"]);
    expect((await h.request<CallsView>("GET", "/api/calls")).body.readyNow.map((x) => x.enrollmentId)).toEqual([c.lead("Nia Cole")]);
  });

  test("the same lead enrolled in another campaign runs there, and the first enrollment stays as it was", async () => {
    const { h, campaign, control, read } = await world();
    const a = await campaign("Clinics");
    const pat = a.lead("Pat Oneil");
    await h.advanceTo(MONDAY_9 + H);
    expect((await control(pat, "stop")).status).toBe(200);
    const before = await read(pat);
    const b = await campaign("Dentists");
    await h.advanceTo(MONDAY_9 + 2 * H);
    expect((await read(b.lead("Pat Oneil"))).status).toBe("waiting_on_call");
    const after = await read(pat);
    expect({ ...after, controls: [] }).toEqual({ ...before, controls: [] });
  });

  test("before launch every lead control is refused; an unknown field is a 400", async () => {
    const { h, control } = await world();
    const { campaign: c } = await h.createCampaign("Draft", { businesses: [HARBOUR], people: [PAT] });
    const id = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows[0]!.enrollments[0]!.id;
    for (const action of ["pause", "skip", "stop"]) expect((await control(id, action)).body.error?.message).toMatch(/has not launched/);
    expect((await h.request("POST", `/api/enrollments/${id}/controls`, { requestId: "x", action: "pause", sendNow: true })).status).toBe(400);
    expect((await h.request("POST", `/api/campaigns/${c.id}/pause`, { requestId: "y" })).status).toBe(409);
  });

  test("a control is judged as of its own instant: a call that expired at the rollover before the worker ticked is skipped first, and stays skipped", async () => {
    const { h, campaign, control, read } = await world();
    const c = await campaign("Clinics");
    const pat = c.lead("Pat Oneil");
    await h.advanceTo(MONDAY_9 + H);
    // Due Monday with a two-day limit: unworked, it expires at the rollover into Wednesday.
    const rollover = Date.parse("2026-11-04T00:00:00Z");
    await h.advanceTo(rollover - MIN);
    expect((await read(pat)).tracks.find((t) => t.trackId === "p1")?.finishReason).toBeNull();
    h.clock = rollover + 1_000;
    expect((await control(pat, "pause")).status).toBe(200);
    const after = await read(pat);
    expect(after.tracks.find((t) => t.trackId === "p1")).toMatchObject({ finishReason: "skipped_unworked", finishedAt: new Date(rollover).toISOString() });
    expect(after.status).toBe("paused");
  });

  test("a call of a lead paused at the day's start takes no room that day; resumed later that day, it is listed all the same (P12)", async () => {
    const callOnly: CampaignDefinition = { ...DEFINITION, tracks: [track("p1", "call", [{ ...email("c1"), subject: "", body: "" }])] };
    const { h, campaign, control } = await world(callOnly);
    expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 1, userZone: "Europe/London" })).status).toBe(200);
    const c = await campaign("Clinics");
    const pat = c.lead("Pat Oneil");
    const nia = c.lead("Nia Cole");
    await h.advanceTo(MONDAY_9 + H);
    const listed = async () => (await h.request<CallsView>("GET", "/api/calls")).body.readyNow.map((x) => x.enrollmentId).sort();
    // Capacity 1: one of them is placed on Monday.
    const first = (await listed())[0]!;
    const other = first === pat ? nia : pat;
    expect(await listed()).toEqual([first]);
    expect((await control(first, "pause")).status).toBe(200);
    // Tuesday: the paused lead's carried call is not committed, so the other lead's call is placed.
    await h.advanceTo(MONDAY_9 + DAY + H);
    expect(await listed()).toEqual([other]);
    // Resumed at noon: its call is listed again, rolled over, beside the one placed today.
    expect((await control(first, "resume")).status).toBe(200);
    expect(await listed()).toEqual([pat, nia].sort());
  });

  test("a reply after a stop keeps the stop's held interval: the next day's committed calls stay as they stood at its start (review bot on ca8baee, item 3)", async () => {
    const { h, campaign, control } = await world();
    const c = await campaign("Clinics");
    const pat = c.lead("Pat Oneil");
    await h.advanceTo(MONDAY_9 + H);
    const committed = async () => (await h.store.engine.callDay(h.clock)).committed;
    // Stopped on Monday with its call open (its skip limit is days away): Tuesday's list does not carry it.
    expect((await control(pat, "stop")).status).toBe(200);
    await h.advanceTo(MONDAY_9 + DAY + H);
    expect(await committed()).toBe(1);
    // A reply on Tuesday turns the stop into replied, and a restart follows: Tuesday's count is as it stood at its start.
    expect(h.fake.prospectReplies("pat@harbour.example")).toBe(true);
    await h.tick();
    expect(await committed()).toBe(1);
    expect((await control(pat, "resume_from_next_step")).status).toBe(200);
    expect(await committed()).toBe(1);
    // Wednesday: Pat ran at its start, so its carried call counts; Nia's, unworked since Monday with a two-day limit,
    // was skipped at that rollover. Pat's clock stood still while stopped, so its own limit has not run out.
    await h.advanceTo(MONDAY_9 + 2 * DAY + H);
    expect(await committed()).toBe(1);
    expect((await h.request<EnrollmentRead>("GET", `/api/enrollments/${pat}`)).body.tracks.find((t) => t.trackId === "p1")?.finishReason).toBeNull();
  });

  test("skip waits for the provider's final word: refused while work it was handed may still be sent, in the read and the action (review bot on ca8baee, item 2)", async () => {
    // Every email is accepted and sent 27 minutes later; until 38 minutes a lookup lags and answers "not sent".
    const h = new EngineHarness({ start: MONDAY_9, accounts: [{ id: "inbox-a", capacity: 50, gapMs: 10 * MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }], modes: ["lookup-lags"], random: () => 0.9 });
    h.fake.withdrawAnswers = "unknown-sends";
    await h.tick();
    const emailOnly: CampaignDefinition = { ...DEFINITION, tracks: [DEFINITION.tracks[0]!] };
    const { campaign } = await h.createCampaign("Clinics", { businesses: [HARBOUR], people: [PAT] });
    await h.defineSequence(campaign.id, emailOnly);
    expect((await h.launch(campaign.id)).status).toBe(200);
    const pat = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows[0]!.enrollments[0]!.id;
    await h.advanceTo(MONDAY_9 + MIN);
    // Paused with email 1 at the provider: the withdrawal answers unknown, and the provider keeps it.
    expect((await h.request("POST", `/api/enrollments/${pat}/controls`, { requestId: "p", action: "pause" })).status).toBe(200);
    // At the first lookup the provider still says "not sent", which is not final: the attempt is withdrawn, the work stays uncertain.
    await h.advanceTo(MONDAY_9 + 16 * MIN);
    const st = await h.store.engine.subject(pat, h.clock);
    expect(st?.attempts.find((a) => a.stepId === "s1")).toMatchObject({ state: "withdrawn", endedBy: "lookup_not_sent" });
    expect(st?.work.find((w) => w.stepId === "s1")?.settled).toBeNull();
    const read = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${pat}`)).body;
    expect(controlOf(read, "skip")).toMatchObject({ allowed: false, reason: expect.stringMatching(/may still be sent/) });
    const skip = await h.request<{ error?: { message: string } }>("POST", `/api/enrollments/${pat}/controls`, { requestId: "s", action: "skip" });
    expect(skip.status).toBe(409);
    // The provider sends it: it is recorded once, as sent, and email 2 waits for the resume.
    await h.advanceTo(MONDAY_9 + 2 * H);
    expect(h.fake.deliveryLog.map((d) => d.stepId)).toEqual(["s1"]);
    expect((await h.request<EnrollmentRead>("GET", `/api/enrollments/${pat}`)).body.tracks[0]?.steps[0]?.result).toBe("sent");
    expect(h.fake.handoverLog.filter((c) => c.stepId === "s2")).toEqual([]);
  });

  test("a request id is bound to its first answer, refused or accepted: a refused resume sent again after a pause is refused again and changes nothing (verifier B5)", async () => {
    const { h, campaign, control, campaignControl, read } = await world();
    const c = await campaign("Clinics");
    const pat = c.lead("Pat Oneil");
    await h.advanceTo(MONDAY_9 + H);
    const first = await control(pat, "resume", "retry-refused");
    expect(first.status).toBe(409);
    expect((await control(pat, "pause", "a-pause")).status).toBe(200);
    const again = await control(pat, "resume", "retry-refused");
    expect([again.status, again.body.error?.message]).toEqual([409, first.body.error?.message]);
    expect((await read(pat)).status).toBe("paused");
    // The same for a campaign: a refused resume, then a pause, then the refused id again.
    expect((await campaignControl(c.id, "resume", "c-retry")).status).toBe(409);
    expect((await campaignControl(c.id, "pause", "c-pause")).status).toBe(200);
    expect((await campaignControl(c.id, "resume", "c-retry")).status).toBe(409);
    expect((await h.request<CampaignDetail>("GET", `/api/campaigns/${c.id}`)).body.pause.paused).toBe(true);
  });

  test("a control's answer is its preview: the effect the read showed at that instant, then the read after the worker ran (verifier B4)", async () => {
    const window = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 10, end: 11 }));
    const oneEmail: CampaignDefinition = { ...DEFINITION, tracks: [{ ...DEFINITION.tracks[0]!, window, steps: [email("s1")] }] };
    const { h, campaign, control, read } = await world(oneEmail);
    const c = await campaign("Clinics");
    const pat = c.lead("Pat Oneil");
    await h.advanceTo(MONDAY_9 + 30 * MIN);
    expect((await control(pat, "pause")).status).toBe(200);
    await h.advanceTo(MONDAY_9 + H + MIN);
    const preview = controlOf(await read(pat), "resume");
    const answer = await h.request<{ effect?: ControlView; enrollment?: EnrollmentRead }>("POST", `/api/enrollments/${pat}/controls`, { requestId: "b4", action: "resume" });
    expect(answer.status).toBe(200);
    expect(answer.body.effect).toEqual(preview);
    // The worker then ran: Pat's email is due, but Nia's took the inbox's 10:00 slot, so it waits for 10:10 and goes then.
    expect(answer.body.enrollment?.status).toBe("queued");
    await h.advanceTo(MONDAY_9 + H + 15 * MIN);
    expect((await read(pat)).status).toBe("sequence_finished_no_response");
    // A replay answers with the same effect.
    expect((await h.request<{ effect?: ControlView }>("POST", `/api/enrollments/${pat}/controls`, { requestId: "b4", action: "resume" })).body.effect).toEqual(preview);
  });

  test("the call outcome route binds a refused request id to its refusal too (verifier B5, the same rule)", async () => {
    const { h, campaign } = await world();
    const c = await campaign("Clinics");
    const pat = c.lead("Pat Oneil");
    await h.advanceTo(MONDAY_9 + H);
    const taskId = (await h.request<CallsView>("GET", "/api/calls")).body.readyNow.find((x) => x.enrollmentId === pat)!.taskId;
    const view = (await h.request<{ numbers: { detailId: string; bad: boolean }[] }>("GET", `/api/call-tasks/${taskId}`)).body;
    const numberId = view.numbers.find((n) => !n.bad)?.detailId;
    // Redialed to tomorrow, so an outcome today is refused; the same id sent again tomorrow, when it would be listed, is refused again.
    expect((await h.request("POST", `/api/call-tasks/${taskId}/outcome`, { requestId: "redial", outcome: "no_answer", redial: true, numberId, note: "" })).status).toBe(200);
    const body = { requestId: "o-retry", outcome: "no_answer", numberId, note: "" };
    const first = await h.request<{ error?: { message: string } }>("POST", `/api/call-tasks/${taskId}/outcome`, body);
    expect(first.status).toBe(409);
    await h.advanceTo(MONDAY_9 + DAY + H);
    const again = await h.request<{ error?: { message: string } }>("POST", `/api/call-tasks/${taskId}/outcome`, body);
    expect([again.status, again.body.error?.message]).toEqual([409, first.body.error?.message]);
  });
});

