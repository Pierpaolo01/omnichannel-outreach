import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { CallsView, CallTaskView, LeadSearchResult, TodayView } from "../../shared/api.ts";

/**
 * Phone tracks and call tasks (ticket 14, part a), through the real HTTP app, SQLite store and
 * engine. The user dials on their own phone: there is no telephony provider, and nothing here
 * dials anyone. Data is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
/** Monday 2 November 2026, 09:00 London (GMT). */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const WEEKDAYS_9_TO_17 = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));

const email = (id: string, waitDays = 0): StepDefinition => ({ id, waitDays, subject: "Hello {{first_name|there}}", body: `Email ${id} for {{company}}.`, threading: "new_subject", removed: false });
const call = (id: string): StepDefinition => ({ id, waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false });
const track = (id: string, channel: TrackDefinition["channel"], steps: StepDefinition[], start: TrackDefinition["start"] = { kind: "entry" }, window = ALWAYS): TrackDefinition => ({
  id,
  channel,
  branch: "main",
  window,
  steps,
  start,
  removed: false,
});
const after = (trackId: string, delayDays: number) => ({ kind: "after" as const, trackId, delayDays });
const definition = (tracks: TrackDefinition[], fields: Partial<CampaignDefinition> = {}): CampaignDefinition => ({
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["inbox-a"],
  smsPool: [],
  callScript: "Ask who looks after new patient bookings.",
  tracks,
  ...fields,
});

const PAT = person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", title: "Clinic owner", email: "pat@harbour.example", direct_phone: "+442079460111" });
const NIA = person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", title: "Practice manager", email: "nia@harbour.example", dial_phone: "+447700900102", dial_phone_type: "mobile" });
const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });

async function world(options: { capacity?: number; people?: Record<string, string>[] } = {}) {
  const h = new EngineHarness({ start: MONDAY_9 - H, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
  await h.tick();
  const settings = await h.request("PUT", "/api/call-settings", { dailyCapacity: options.capacity ?? 20, userZone: "Europe/London" });
  expect(settings.status).toBe(200);
  /** Creates a campaign with these tracks and launches it now; returns a lookup of enrollment ids by name. */
  const campaign = async (name: string, def: CampaignDefinition, people = options.people ?? [PAT, NIA]) => {
    const { campaign: c } = await h.createCampaign(name, { businesses: [HARBOUR], people });
    await h.defineSequence(c.id, def);
    const launched = await h.launch(c.id);
    if (launched.status !== 200) throw new Error(`launch refused: ${JSON.stringify(launched.body)}`);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
    return { id: c.id, lead: (who: string) => rows.find((r) => r.name === who)?.enrollments.find((e) => e.campaign.id === c.id)?.id ?? "" };
  };
  const calls = async () => (await h.request<CallsView>("GET", "/api/calls")).body;
  const today = async () => (await h.request<TodayView>("GET", "/api/today")).body;
  const task = async (id: string) => (await h.request<CallTaskView>("GET", `/api/call-tasks/${id}`)).body;
  let requests = 0;
  /** Logs an outcome as the client would, with a fresh request id unless the test gives one. */
  const log = (id: string, body: Record<string, unknown>) => h.request<{ error?: { message: string } }>("POST", `/api/call-tasks/${id}/outcome`, { requestId: `req-${++requests}`, ...body });
  const emails = (to: string) => h.fake.deliveryLog.filter((d) => d.destination === to);
  return { h, campaign, calls, today, task, log, emails };
}

describe("a phone track's call becomes a task on the user's list (spec: Phone tracks; Working through today's list)", () => {
  test("a due call is placed on today's list and dials nothing; the email track beside it keeps running; the track after it waits", async () => {
    const { h, campaign, calls, today, emails } = await world({ people: [PAT] });
    h.clock = MONDAY_9;
    const c = await campaign("Calls and email", definition([track("e1", "email", [email("s1"), email("s2", 1)]), track("p1", "call", [call("c1")], { kind: "entry" }, WEEKDAYS_9_TO_17), track("e2", "email", [email("s3")], after("p1", 1))]));
    // Monday 09:00: the call is due and its calling hours are open, so it is ready now.
    const monday = await today();
    expect(monday).toMatchObject({ date: "2026-11-02", userZone: "Europe/London", readyNow: 1, laterToday: 0 });
    expect(monday.upNext).toEqual([expect.objectContaining({ bucket: "ready_now", reason: "due", localTime: "09:00", opensAt: null })]);
    await h.advanceTo(Date.parse("2026-11-03T05:00:00Z"));

    // The parallel email track ran both its steps; the email after the phone track waits for the call.
    expect(emails("pat@harbour.example").map((d) => d.stepId)).toEqual(["s1", "s2"]);
    expect(h.fake.handoverLog.every((x) => x.destination === "pat@harbour.example")).toBe(true);
    const progress = await h.progress(c.lead("Pat Oneil"));
    expect(progress.status).toBe("waiting_on_call");
    expect(progress.tracks.map((t) => [t.trackId, t.finishReason])).toEqual([["e1", "completed"], ["p1", null], ["e2", null]]);
    expect(progress.tracks.find((t) => t.trackId === "e2")?.started).toBe(false);

    // Tuesday 05:00 London: outside calling hours, the unworked call waits as later today, rolled over.
    const tuesday = await today();
    expect(tuesday).toMatchObject({ date: "2026-11-03", readyNow: 0, laterToday: 1 });
    expect(tuesday.upNext).toEqual([expect.objectContaining({ bucket: "later_today", reason: "rolled_over", localTime: "05:00", opensAt: "2026-11-03T09:00:00.000Z" })]);
    expect((await calls()).focusTaskId).toBeNull();

    // At 09:00 it is ready now, carried over from Monday, with its original due time.
    await h.advanceTo(Date.parse("2026-11-03T09:30:00Z"));
    const ready = await calls();
    expect(ready.readyNow).toEqual([
      expect.objectContaining({ person: { id: expect.any(String), name: "Pat Oneil", title: "Clinic owner" }, company: expect.objectContaining({ name: "Harbour Lane Physio" }), campaign: { id: c.id, name: "Calls and email" }, track: { id: "p1", label: "Phone track" }, localTime: "09:30", dueAt: "2026-11-02T09:00:00.000Z" }),
    ]);
    expect(ready.focusTaskId).toBe(ready.readyNow[0]?.taskId);
  });
});

describe("outcomes the user logs (spec: Call outcomes and their effect on the lead)", () => {
  const def = () => definition([track("e1", "email", [email("s1")]), track("p1", "call", [call("c1")], { kind: "entry" }, WEEKDAYS_9_TO_17), track("e2", "email", [email("s3")], after("p1", 1))]);

  test("no answer on the company main line is the intended lead's call: the task closes, the track completes and the email after it goes a day later", async () => {
    const { h, campaign, calls, task, log, emails } = await world({ people: [PAT] });
    h.clock = MONDAY_9;
    const c = await campaign("No answer", def());
    await h.advanceTo(MONDAY_9 + 2 * H);
    const taskId = (await calls()).focusTaskId ?? "";
    const before = await task(taskId);
    const mainLine = before.numbers.find((n) => n.kind === "main_line");
    expect(mainLine).toMatchObject({ owner: "company", value: expect.stringContaining("7946 0101") });

    // A past call shows the number dialled, with no claim about dialling it now.
    const dialled = { detailId: mainLine?.detailId, kind: "main_line", owner: "company", value: mainLine?.value };
    const logged = await log(taskId, { outcome: "gatekeeper", numberId: mainLine?.detailId, note: "Receptionist says Pat is in clinic until 3." });
    expect(logged.status).toBe(200);
    const after = await task(taskId);
    expect(after).toMatchObject({ open: false, listed: false, outcomes: [], status: "active" });
    expect(after.touches.at(-1)).toEqual({ kind: "call", at: "2026-11-02T11:00:00.000Z", outcome: "gatekeeper", number: dialled, note: "Receptionist says Pat is in clinic until 3.", redial: false, callbackAt: null, declinedPath: null });
    expect(after.personNotes.map((n) => n.body)).toEqual(["Receptionist says Pat is in clinic until 3."]);
    expect(after.companyNotes).toEqual([]);
    expect((await calls()).readyNow).toEqual([]);

    const progress = await h.progress(c.lead("Pat Oneil"));
    expect(progress.tracks.find((t) => t.trackId === "p1")).toMatchObject({
      channel: "call",
      finishReason: "completed",
      finishedAt: "2026-11-02T11:00:00.000Z",
      callTask: { taskId, open: false, placedAt: "2026-11-02T09:00:00.000Z", listed: false },
      steps: [{ stepId: "c1", result: "sent", reason: "gatekeeper", calls: [{ outcome: "gatekeeper", at: "2026-11-02T11:00:00.000Z", number: dialled, note: "Receptionist says Pat is in clinic until 3." }] }],
    });
    // The track after the phone track starts one calendar day after the call: Tuesday 00:00 London.
    await h.advanceTo(MONDAY_9 + 2 * DAY);
    expect(emails("pat@harbour.example").map((d) => [d.stepId, new Date(d.at).toISOString()])).toEqual([["s1", "2026-11-02T09:00:00.000Z"], ["s3", "2026-11-03T00:00:00.000Z"]]);
    expect((await h.progress(c.lead("Pat Oneil"))).status).toBe("sequence_finished_no_response");
    // Nothing was dialled: the application has no telephony provider, and no provider received a call.
    expect(h.fake.handoverLog.map((x) => x.stepId)).toEqual(["s1", "s3"]);
  });

  test("a call note saved as a company note shows for everyone at the company", async () => {
    const { h, campaign, calls, task, log } = await world();
    h.clock = MONDAY_9;
    await campaign("Company notes", definition([track("p1", "call", [call("c1")], { kind: "entry" }, WEEKDAYS_9_TO_17)], { emailPool: [] }));
    await h.advanceTo(MONDAY_9 + H);
    const [first, second] = (await calls()).readyNow;
    const firstView = await task(first?.taskId ?? "");
    expect((await log(first?.taskId ?? "", { outcome: "voicemail", numberId: firstView.numbers[0]?.detailId, note: "The practice closes on Fridays.", noteScope: "company" })).status).toBe(200);
    const other = await task(second?.taskId ?? "");
    expect(other.companyNotes.map((n) => n.body)).toEqual(["The practice closes on Fridays."]);
    expect(other.personNotes).toEqual([]);
    // The colleague just called shows their status and last call note.
    expect(other.colleagues.find((x) => x.name === firstView.person?.name)).toMatchObject({ lastCallNote: { note: "The practice closes on Fridays.", outcome: "voicemail" } });
  });
});

describe("the call task shows what the user needs to make the call (spec: Call task view)", () => {
  test("person, role, company, campaign and step, local time, labelled numbers direct first, script, earlier touches and calls, and everyone at the company", async () => {
    const OMAR = person({ person_id: "p4", business_id: "b2", full_name: "Omar Reed", title: "Director", email: "omar@northgate.example", direct_phone: "+442079460444", dial_phone: "+447700900104", dial_phone_type: "mobile" });
    // Grace has no usable channel, so she is on record but never enrolled.
    const GRACE = person({ person_id: "p5", business_id: "b2", full_name: "Grace Okafor", title: "Practice manager" });
    const NORTHGATE = business({ business_id: "b2", business_name: "Northgate Dental" });
    const { h, task, log, calls } = await world();
    const { campaign: c } = await h.createCampaign("Northgate calls", { businesses: [NORTHGATE], people: [OMAR, GRACE] });
    await h.defineSequence(c.id, definition([track("e1", "email", [email("s1")]), track("p1", "call", [call("c1")], { kind: "entry" }, WEEKDAYS_9_TO_17), track("p2", "call", [call("c2")], after("p1", 0), WEEKDAYS_9_TO_17)]));
    h.clock = MONDAY_9;
    expect((await h.launch(c.id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 30 * MIN);

    const first = await task((await calls()).focusTaskId ?? "");
    expect(first).toMatchObject({
      person: { name: "Omar Reed", title: "Director" },
      company: { name: "Northgate Dental" },
      campaign: { name: "Northgate calls" },
      track: { id: "p1", label: "Phone track 1" },
      zone: "Europe/London",
      localTime: "09:30",
      script: "Ask who looks after new patient bookings.",
      status: "waiting_on_call",
      listed: true,
      outcomes: ["no_answer", "voicemail", "gatekeeper", "wrong_number", "interested", "not_interested", "callback_requested", "skip_for_now"], redialOutcomes: ["no_answer", "voicemail", "gatekeeper"],
    });
    expect(first.numbers.map((n) => [n.kind, n.owner, n.bad])).toEqual([["direct", "person", false], ["mobile", "person", false]]);
    expect(first.touches).toEqual([{ kind: "email", at: "2026-11-02T09:00:00.000Z", stepId: "s1", copy: { subject: "Hello Omar", body: "Email s1 for Northgate Dental." } }]);
    expect(first.colleagues).toEqual([{ id: expect.any(String), name: "Grace Okafor", title: "Practice manager", statuses: [], lastCallNote: null }]);

    expect((await log(first.taskId, { outcome: "no_answer", numberId: first.numbers[1]?.detailId, note: "Rang out." })).status).toBe(200);
    // The second phone track starts at once after the first: its task shows the earlier call and its note.
    await h.advanceTo(MONDAY_9 + H);
    const second = await task((await calls()).focusTaskId ?? "");
    expect(second.track).toEqual({ id: "p2", label: "Phone track 2" });
    expect(second.touches.map((t) => t.kind)).toEqual(["email", "call"]);
    expect(second.touches[1]).toMatchObject({ outcome: "no_answer", note: "Rang out.", number: { kind: "mobile" } });
    expect(second.personNotes.map((n) => n.body)).toEqual(["Rang out."]);
  });
});

describe("wrong numbers, interest and skipping (spec: Call outcomes and their effect on the lead)", () => {
  test("a wrong number is marked bad and other channels keep running; a later phone track with no good number left is skipped", async () => {
    const { h, campaign, calls, task, log, emails } = await world({ people: [PAT] });
    h.clock = MONDAY_9;
    // Pat's direct line and the company main line: two phone tracks one after the other, and an email track beside them.
    const c = await campaign("Wrong numbers", definition([track("e1", "email", [email("s1"), email("s2", 2)]), track("p1", "call", [call("c1")], { kind: "entry" }, WEEKDAYS_9_TO_17), track("p2", "call", [call("c2")], after("p1", 1), WEEKDAYS_9_TO_17), track("p3", "call", [call("c3")], after("p2", 1), WEEKDAYS_9_TO_17)]));
    await h.advanceTo(MONDAY_9 + H);
    const first = await task((await calls()).focusTaskId ?? "");
    const direct = first.numbers.find((n) => n.kind === "direct");
    // Until question Q4 is answered, a wrong number finishes the phone track, even with another good number left.
    expect((await log(first.taskId, { outcome: "wrong_number", numberId: direct?.detailId })).status).toBe(200);
    expect((await h.progress(c.lead("Pat Oneil"))).tracks.find((t) => t.trackId === "p1")?.finishReason).toBe("completed");
    const pat = (await h.request<LeadSearchResult>("GET", "/api/leads?q=Pat")).body.rows[0];
    const record = await h.person(pat?.id ?? "");
    expect(record.contactDetails.find((d) => d.phoneKind === "direct")?.bad).toBe(true);

    // Tuesday: the second phone track offers only the main line, struck numbers shown as bad.
    await h.advanceTo(Date.parse("2026-11-03T10:00:00Z"));
    const second = await task((await calls()).focusTaskId ?? "");
    expect(second.numbers.map((n) => [n.kind, n.bad])).toEqual([["direct", true], ["main_line", false]]);
    expect((await log(second.taskId, { outcome: "wrong_number", numberId: direct?.detailId })).body.error?.message).toBe("That number is marked bad: choose another of the lead's numbers.");
    expect((await log(second.taskId, { outcome: "wrong_number", numberId: second.numbers[1]?.detailId })).status).toBe(200);

    // No good number remains: the third phone track is skipped as a missing channel; email continues.
    await h.advanceTo(Date.parse("2026-11-06T10:00:00Z"));
    const progress = await h.progress(c.lead("Pat Oneil"));
    expect(progress.tracks.map((t) => [t.trackId, t.finishReason])).toEqual([["e1", "completed"], ["p1", "completed"], ["p2", "completed"], ["p3", "skipped_missing_channel"]]);
    expect(emails("pat@harbour.example").map((d) => d.stepId)).toEqual(["s1", "s2"]);
    expect(progress.status).toBe("sequence_finished_no_response");
  });

  test("interested stops only this lead in this campaign and records nothing more; its other phone track's open task closes", async () => {
    const { h, campaign, calls, task, log, emails } = await world();
    h.clock = MONDAY_9;
    const def = definition([track("e1", "email", [email("s1"), email("s2", 1)]), track("p1", "call", [call("c1")], { kind: "entry" }, WEEKDAYS_9_TO_17), track("p2", "call", [call("c2")], { kind: "entry" }, WEEKDAYS_9_TO_17)]);
    const spring = await campaign("Spring", def);
    const autumn = await campaign("Autumn", def);
    await h.advanceTo(MONDAY_9 + H);
    const queue = await calls();
    const patSpring = queue.readyNow.filter((x) => x.person?.name === "Pat Oneil" && x.campaign.name === "Spring");
    expect(patSpring.map((x) => x.track.id)).toEqual(["p1", "p2"]);
    const view = await task(patSpring[0]?.taskId ?? "");
    expect((await log(view.taskId, { outcome: "interested", numberId: view.numbers[0]?.detailId, note: "Wants a demo next week." })).status).toBe(200);

    const pat = await h.progress(spring.lead("Pat Oneil"));
    expect(pat.status).toBe("interested_on_call");
    expect(pat.tracks.map((t) => [t.trackId, t.finishReason])).toEqual([["e1", null], ["p1", "completed"], ["p2", "closed_on_interest"]]);
    expect((await task(patSpring[1]?.taskId ?? "")).open).toBe(false);
    // Only this lead in this campaign: Pat in Autumn and Nia in Spring keep their calls and emails.
    const after = await calls();
    expect(after.readyNow.filter((x) => x.person?.name === "Pat Oneil").map((x) => x.campaign.name)).toEqual(["Autumn", "Autumn"]);
    expect(after.readyNow.filter((x) => x.person?.name === "Nia Cole").length).toBe(4);
    await h.advanceTo(MONDAY_9 + DAY);
    expect(emails("pat@harbour.example").filter((d) => d.subjectId === spring.lead("Pat Oneil")).map((d) => d.stepId)).toEqual(["s1"]);
    expect(emails("pat@harbour.example").filter((d) => d.subjectId === autumn.lead("Pat Oneil")).map((d) => d.stepId)).toEqual(["s1", "s2"]);
    expect((await h.progress(spring.lead("Nia Cole"))).status).toBe("waiting_on_call");
  });

  test("skip for now moves the task to the end of the queue and is not a call made; outcomes on a task that is not listed are refused", async () => {
    const { h, campaign, calls, task, log } = await world();
    h.clock = MONDAY_9;
    // A skip limit past Saturday: the call is still open then, so Saturday tests a day its calling hours never open.
    const c = await campaign("Skipping", definition([track("p1", "call", [call("c1")], { kind: "entry" }, WEEKDAYS_9_TO_17)], { emailPool: [], callSkipLimitDays: 7 }));
    await h.advanceTo(MONDAY_9 + H);
    const before = await calls();
    expect(before.readyNow.map((x) => x.person?.name)).toEqual(["Pat Oneil", "Nia Cole"].sort((a, b) => (c.lead(a) < c.lead(b) ? -1 : 1)));
    const firstId = before.focusTaskId ?? "";
    expect((await log(firstId, { outcome: "skip_for_now" })).status).toBe(200);
    const after = await calls();
    expect(after.readyNow.map((x) => x.taskId)).toEqual([before.readyNow[1]?.taskId, firstId]);
    expect(after.focusTaskId).toBe(before.readyNow[1]?.taskId);
    const skipped = await task(firstId);
    expect(skipped).toMatchObject({ open: true, listed: true, status: "waiting_on_call", touches: [] });
    expect((await h.progress(skipped.enrollmentId)).status).toBe("waiting_on_call");

    // A closed task, an unknown task, and a call outside the prospect's calling day are refused.
    expect((await log(firstId, { outcome: "no_answer", numberId: skipped.numbers[0]?.detailId })).status).toBe(200);
    expect((await log(firstId, { outcome: "no_answer", numberId: skipped.numbers[0]?.detailId })).body.error?.message).toContain("no longer on the list");
    expect((await log("no-such-task", { outcome: "no_answer" })).status).toBe(404);
    const other = before.readyNow[1]?.taskId ?? "";
    h.clock = Date.parse("2026-11-07T12:00:00Z"); // Saturday: Mon-Fri calling hours never open today
    const refused = await log(other, { outcome: "no_answer", numberId: (await task(other)).numbers[0]?.detailId });
    expect(refused).toMatchObject({ status: 409, body: { error: { message: "This call is not on today's list." } } });
    expect((await task(other)).outcomes).toEqual([]);
  });
});

describe("the user's daily call capacity (spec: Pace, capacity and timing; ADR 0003 4.4)", () => {
  test("new calls are placed while today's list has room; carried calls count first and are never dropped; the rest wait for the next day", async () => {
    const SAM = person({ person_id: "p3", business_id: "b1", full_name: "Sam Lee", email: "sam@harbour.example" });
    const { h, campaign, calls, task, log } = await world({ capacity: 2, people: [PAT, NIA, SAM] });
    h.clock = MONDAY_9;
    const c = await campaign("Capacity", definition([track("e1", "email", [email("s1", 0)], after("p1", 0)), track("p1", "call", [call("c1")], { kind: "entry" }, WEEKDAYS_9_TO_17)]));
    await h.advanceTo(MONDAY_9 + H);
    const monday = await calls();
    expect(monday).toMatchObject({ date: "2026-11-02", dailyCapacity: 2, placedToday: 2, committed: 0 });
    // Placed in priority order: oldest due first, then by enrollment.
    const ids = ["Pat Oneil", "Nia Cole", "Sam Lee"].map((n) => c.lead(n)).sort();
    expect(monday.readyNow.map((x) => x.enrollmentId)).toEqual(ids.slice(0, 2));
    const waiting = await h.progress(ids[2] ?? "");
    expect(waiting.status).toBe("queued");

    // Tuesday: Monday's two calls are carried over, unworked, and fill the day; working one frees nothing today.
    await h.advanceTo(Date.parse("2026-11-03T09:30:00Z"));
    const tuesday = await calls();
    expect(tuesday).toMatchObject({ placedToday: 0, committed: 2 });
    expect(tuesday.readyNow.map((x) => x.reason)).toEqual(["rolled_over", "rolled_over"]);
    const first = await task(tuesday.focusTaskId ?? "");
    expect((await log(first.taskId, { outcome: "no_answer", numberId: first.numbers[0]?.detailId })).status).toBe(200);
    await h.advanceTo(Date.parse("2026-11-03T16:00:00Z"));
    expect(await calls()).toMatchObject({ placedToday: 0, committed: 2 });
    expect((await h.progress(ids[2] ?? "")).status).toBe("queued");

    // Wednesday: Monday's other call, unworked on Monday and Tuesday, was skipped at the end of Tuesday (the
    // skip limit, ticket 15), and the email after it went then. Nothing is carried, so the call that waited fits.
    await h.advanceTo(Date.parse("2026-11-04T09:30:00Z"));
    const unworked = ids.find((id) => id !== first.enrollmentId && id !== ids[2]) ?? "";
    expect((await h.progress(unworked)).tracks.map((t) => [t.trackId, t.finishReason, t.finishedAt])).toEqual([["e1", "completed", "2026-11-04T00:00:00.000Z"], ["p1", "skipped_unworked", "2026-11-04T00:00:00.000Z"]]);
    const wednesday = await calls();
    expect(wednesday).toMatchObject({ placedToday: 1, committed: 0 });
    expect(wednesday.readyNow.map((x) => [x.enrollmentId, x.reason])).toEqual([[ids[2], "due"]]);
    expect((await h.progress(ids[2] ?? "")).status).toBe("waiting_on_call");
  });

  test("a lead that replies leaves the list, and its unworked call does not take tomorrow's capacity", async () => {
    const { h, campaign, calls } = await world({ capacity: 1 });
    h.clock = MONDAY_9;
    const c = await campaign("Reply", definition([track("e1", "email", [email("s1")]), track("p1", "call", [call("c1")], { kind: "entry" }, WEEKDAYS_9_TO_17)]));
    await h.advanceTo(MONDAY_9 + H);
    const placed = (await calls()).readyNow;
    expect(placed.length).toBe(1);
    const who = placed[0]?.person?.name === "Pat Oneil" ? "pat@harbour.example" : "nia@harbour.example";
    expect(h.fake.prospectReplies(who, true, null)).toBe(true);
    await h.advanceTo(MONDAY_9 + 2 * H);
    expect((await calls()).readyNow).toEqual([]);
    expect((await h.progress(placed[0]?.enrollmentId ?? "")).status).toBe("replied");
    await h.advanceTo(Date.parse("2026-11-03T09:30:00Z"));
    const tuesday = await calls();
    expect(tuesday).toMatchObject({ committed: 0, placedToday: 1 });
    expect(tuesday.readyNow.map((x) => x.enrollmentId)).toEqual([["Pat Oneil", "Nia Cole"].map((n) => c.lead(n)).find((id) => id !== placed[0]?.enrollmentId)]);
  });
});

describe("numbers shared across leads and channels", () => {
  test("a colleague's wrong number on the shared main line skips another lead's open call; placing a call never counts as reaching the lead", async () => {
    // Grace has no number of her own: only the company main line.
    const GRACE = person({ person_id: "p5", business_id: "b1", full_name: "Grace Okafor", email: "grace@harbour.example" });
    const { h, campaign, calls, task, log, emails } = await world({ people: [PAT, GRACE] });
    h.clock = MONDAY_9;
    const c = await campaign("Shared line", definition([track("p1", "call", [call("c1")], { kind: "entry" }, WEEKDAYS_9_TO_17), track("e1", "email", [email("s1")], after("p1", 1))]));
    await h.advanceTo(MONDAY_9 + H);
    const queue = await calls();
    const pat = await task(queue.readyNow.find((x) => x.person?.name === "Pat Oneil")?.taskId ?? "");
    const grace = queue.readyNow.find((x) => x.person?.name === "Grace Okafor");
    expect((await h.progress(c.lead("Grace Okafor"))).status).toBe("waiting_on_call");
    const mainLine = pat.numbers.find((n) => n.kind === "main_line");
    expect((await log(pat.taskId, { outcome: "wrong_number", numberId: mainLine?.detailId, note: "Number disconnected." })).status).toBe(200);

    // Grace's call has no good number left: her phone track is skipped and her task leaves the list.
    await h.advanceTo(MONDAY_9 + 2 * H);
    expect((await calls()).readyNow).toEqual([]);
    expect(await task(grace?.taskId ?? "")).toMatchObject({ open: false, listed: false });
    const progress = await h.progress(c.lead("Grace Okafor"));
    expect(progress.tracks.find((t) => t.trackId === "p1")).toMatchObject({ finishReason: "skipped_missing_channel", finishedAt: "2026-11-02T10:00:00.000Z" });
    // No call was made to her and nothing was sent: she is still queued, not active.
    expect(progress.status).toBe("queued");
    await h.advanceTo(MONDAY_9 + 2 * DAY);
    expect(emails("grace@harbour.example").map((d) => d.stepId)).toEqual(["s1"]);
    // Her email track starts a calendar day after the skip, Tuesday 00:00 London, and goes in the inbox's next slot after Pat's.
    expect((await h.progress(c.lead("Grace Okafor"))).tracks.find((t) => t.trackId === "e1")?.steps[0]?.sends[0]?.handedAt).toBe("2026-11-03T00:01:00.000Z");
    expect((await h.progress(c.lead("Pat Oneil"))).tracks.find((t) => t.trackId === "e1")?.steps[0]?.sends[0]?.handedAt).toBe("2026-11-03T00:00:00.000Z");
    expect((await h.progress(c.lead("Grace Okafor"))).status).toBe("sequence_finished_no_response");
  });

  test("a wrong number on a mobile marks it bad for texts too: the SMS track to it fails, and email continues", async () => {
    const h = new EngineHarness({
      start: MONDAY_9 - H,
      accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
      sms: { numbers: [{ id: "+447700900001", capacity: 50, gapMs: MIN, k: 2, healthy: true, resetZone: "Europe/London" }] },
    });
    await h.tick();
    await h.request("PUT", "/api/call-settings", { dailyCapacity: 10, userZone: "Europe/London" });
    const { campaign: c } = await h.createCampaign("Mobile", { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })], people: [NIA] });
    const text = (id: string, waitDays: number): StepDefinition => ({ id, waitDays, subject: "", body: "A quick text, {{first_name|there}}.", threading: "new_subject", removed: false });
    await h.defineSequence(c.id, definition([track("p1", "call", [call("c1")], { kind: "entry" }, WEEKDAYS_9_TO_17), track("m1", "sms", [text("t1", 0), text("t2", 2)]), track("e1", "email", [email("s1"), email("s2", 3)])], { smsPool: ["+447700900001"] }));
    h.clock = MONDAY_9;
    expect((await h.launch(c.id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + H);
    const view = (await h.request<CallTaskView>("GET", `/api/call-tasks/${(await h.request<CallsView>("GET", "/api/calls")).body.focusTaskId ?? ""}`)).body;
    expect(view.numbers.map((n) => n.kind)).toEqual(["mobile"]);
    expect((await h.request("POST", `/api/call-tasks/${view.taskId}/outcome`, { requestId: "req-1", outcome: "wrong_number", numberId: view.numbers[0]?.detailId })).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 5 * DAY);
    const progress = await h.progress(view.enrollmentId);
    expect(progress.tracks.map((t) => [t.trackId, t.finishReason])).toEqual([["p1", "completed"], ["m1", "failed_bad_destination"], ["e1", "completed"]]);
    expect(h.sms.deliveryLog.map((d) => d.stepId)).toEqual(["t1"]);
    expect(h.fake.deliveryLog.map((d) => d.stepId)).toEqual(["s1", "s2"]);
  });
});

describe("who a call record belongs to (review bot on a1399ce)", () => {
  test("a note is the person's or the company's as the user chose, whatever numbers the person has; only a company lead's notes are its company's", async () => {
    // Sam has no number of his own: his calls go to the company main line.
    const SAM = person({ person_id: "p3", business_id: "b1", full_name: "Sam Lee", email: "sam@harbour.example" });
    const ELM = business({ business_id: "b2", business_name: "Elm Street Clinic", phone_e164: "+442079460303", general_emails: "hello@elm.example" });
    const { h, calls, task, log } = await world();
    const { campaign: c } = await h.createCampaign("Notes", { businesses: [HARBOUR, ELM], people: [SAM] });
    await h.defineSequence(c.id, definition([track("p1", "call", [call("c1")], { kind: "entry" }, WEEKDAYS_9_TO_17)], { emailPool: [] }));
    h.clock = MONDAY_9;
    expect((await h.launch(c.id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + H);
    const queue = (await calls()).readyNow;
    const sam = await task(queue.find((x) => x.person?.name === "Sam Lee")?.taskId ?? "");
    expect(sam.numbers.map((n) => n.kind)).toEqual(["main_line"]);
    expect((await log(sam.taskId, { outcome: "gatekeeper", numberId: sam.numbers[0]?.detailId, note: "Sam prefers mornings.", noteScope: "person" })).status).toBe(200);
    const after = await task(sam.taskId);
    expect(after.personNotes.map((n) => n.body)).toEqual(["Sam prefers mornings."]);
    expect(after.companyNotes).toEqual([]);

    // A company lead has no person: its notes are its company's, the stated default for it.
    const elm = await task(queue.find((x) => x.person === null)?.taskId ?? "");
    expect((await log(elm.taskId, { outcome: "voicemail", numberId: elm.numbers[0]?.detailId, note: "Reception closes at 4.", noteScope: "person" })).status).toBe(200);
    expect((await task(elm.taskId)).companyNotes.map((n) => n.body)).toEqual(["Reception closes at 4."]);
  });

  test("a re-import that merges a dialled number keeps it on the call's history, and a number id from before the merge still logs an outcome", async () => {
    // No country and no main line at first: Zara's national number is kept as its digits.
    const noCountry = business({ business_id: "b1", business_name: "Harbour Lane Physio", country: "" });
    const YARA = person({ person_id: "p6", business_id: "b1", full_name: "Yara Haddad", direct_phone: "+442079460155" });
    const ZARA = person({ person_id: "p7", business_id: "b1", full_name: "Zara Malik", direct_phone: "020 7946 0155" });
    const { h, calls, task, log } = await world();
    const { campaign: c } = await h.createCampaign("Merges", { businesses: [noCountry], people: [YARA, ZARA] });
    await h.defineSequence(c.id, definition([track("p1", "call", [call("c1")], { kind: "entry" }, WEEKDAYS_9_TO_17), track("p2", "call", [call("c2")], after("p1", 0), WEEKDAYS_9_TO_17)], { emailPool: [] }));
    h.clock = MONDAY_9;
    expect((await h.launch(c.id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + H);
    const zara = await task((await calls()).readyNow.find((x) => x.person?.name === "Zara Malik")?.taskId ?? "");
    const dialled = zara.numbers[0];
    expect(dialled).toMatchObject({ kind: "direct" });
    expect((await log(zara.taskId, { outcome: "no_answer", numberId: dialled?.detailId, note: "Rang out." })).status).toBe(200);

    // The company's country and main line arrive: Zara's copy folds into the company's main line.
    await h.reimport(c.id, { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460155" })], people: [YARA, ZARA] });
    await h.advanceTo(MONDAY_9 + 2 * H);
    const history = await task(zara.taskId);
    expect(history.touches).toEqual([expect.objectContaining({ kind: "call", outcome: "no_answer", number: expect.objectContaining({ kind: "main_line", value: "+44 20 7946 0155" }) })]);
    const progress = await h.progress(zara.enrollmentId);
    expect(progress.tracks.find((t) => t.trackId === "p1")?.steps[0]?.calls[0]?.number).toMatchObject({ kind: "main_line" });

    // Her second call, logged from a screen read before the merge, names the old id: it is the same number.
    const second = (await calls()).readyNow.find((x) => x.enrollmentId === zara.enrollmentId && x.track.id === "p2");
    expect((await log(second?.taskId ?? "", { outcome: "voicemail", numberId: dialled?.detailId })).status).toBe(200);
    expect((await task(second?.taskId ?? "")).touches.at(-1)).toMatchObject({ kind: "call", outcome: "voicemail", number: expect.objectContaining({ kind: "main_line" }) });
  });
});

describe("a user action posted twice is logged once (verifier B3 on a1399ce)", () => {
  test("the same skip with a note, posted again and posted twice at once, is one skip and one note; a later skip with a new id is a new one", async () => {
    const { h, campaign, calls, task, log } = await world({ people: [PAT] });
    h.clock = MONDAY_9;
    await campaign("Replays", definition([track("p1", "call", [call("c1")], { kind: "entry" }, WEEKDAYS_9_TO_17)], { emailPool: [] }));
    await h.advanceTo(MONDAY_9 + H);
    const taskId = (await calls()).focusTaskId ?? "";
    const skip = { requestId: "skip-1", outcome: "skip_for_now", note: "Single skip note" };
    expect((await log(taskId, skip)).status).toBe(200);
    expect((await log(taskId, skip)).status).toBe(200);
    const twice = await Promise.all([log(taskId, { ...skip, requestId: "skip-2" }), log(taskId, { ...skip, requestId: "skip-2" })]);
    expect(twice.map((r) => r.status)).toEqual([200, 200]);
    const view = await task(taskId);
    expect(view.personNotes.map((n) => n.body)).toEqual(["Single skip note", "Single skip note"]);
    const progress = await h.progress(view.enrollmentId);
    expect(progress.tracks[0]?.steps[0]?.calls.map((c) => c.outcome)).toEqual(["skip_for_now", "skip_for_now"]);
  });

  test("an outcome replayed after its response was lost, across a restart, answers with the first result and stores nothing again", async () => {
    const { h, campaign, calls, task, log } = await world({ people: [PAT] });
    h.clock = MONDAY_9;
    await campaign("Lost response", definition([track("p1", "call", [call("c1")], { kind: "entry" }, WEEKDAYS_9_TO_17)], { emailPool: [] }));
    await h.advanceTo(MONDAY_9 + H);
    const taskId = (await calls()).focusTaskId ?? "";
    const numberId = (await task(taskId)).numbers[0]?.detailId;
    const body = { requestId: "vm-1", outcome: "voicemail", numberId, note: "Left a message." };
    const first = await log(taskId, body);
    expect(first.status).toBe(200);
    await h.restart();
    const replay = await log(taskId, body);
    expect(replay).toEqual(first);
    const view = await task(taskId);
    expect(view.touches.filter((t) => t.kind === "call")).toHaveLength(1);
    expect(view.personNotes.map((n) => n.body)).toEqual(["Left a message."]);
  });

  test("a request id already used for another call is refused, and nothing is stored", async () => {
    const { h, campaign, calls, task, log } = await world();
    h.clock = MONDAY_9;
    await campaign("Reused id", definition([track("p1", "call", [call("c1")], { kind: "entry" }, WEEKDAYS_9_TO_17)], { emailPool: [] }));
    await h.advanceTo(MONDAY_9 + H);
    const [a, b] = (await calls()).readyNow;
    expect((await log(a?.taskId ?? "", { requestId: "same", outcome: "skip_for_now" })).status).toBe(200);
    const reused = await log(b?.taskId ?? "", { requestId: "same", outcome: "no_answer", numberId: (await task(b?.taskId ?? "")).numbers[0]?.detailId });
    expect(reused).toMatchObject({ status: 409, body: { error: { message: "This request id was already used for another call: send a new one." } } });
    expect((await task(b?.taskId ?? "")).open).toBe(true);
  });
});

describe("council on 7902093", () => {
  test("the call the user is on keeps the focus while it is listed: a later-today call opening with an older due time does not take it; the outcome's answer names the next focus", async () => {
    const { h, campaign, task, log } = await world();
    h.clock = Date.parse("2026-11-02T08:00:00Z");
    // Nia's calling hours open at 13:00; her call is due at 08:00, so it is the oldest due.
    await campaign("Afternoons", definition([track("p1", "call", [call("c1")], { kind: "entry" }, [1, 2, 3, 4, 5].map((day) => ({ day, start: 13, end: 17 })))], { emailPool: [] }), [NIA]);
    h.clock = MONDAY_9;
    await campaign("Mornings", definition([track("p1", "call", [call("c1")], { kind: "entry" }, WEEKDAYS_9_TO_17)], { emailPool: [] }), [PAT]);
    await h.advanceTo(MONDAY_9 + 30 * MIN);
    const calls = async (focus: string | null) => (await h.request<CallsView>("GET", `/api/calls${focus ? `?focus=${focus}` : ""}`)).body;
    const morning = await calls(null);
    const pat = morning.focusTaskId ?? "";
    expect(morning.readyNow.map((x) => x.person?.name)).toEqual(["Pat Oneil"]);
    expect(morning.laterToday.map((x) => x.person?.name)).toEqual(["Nia Cole"]);

    await h.advanceTo(Date.parse("2026-11-02T13:05:00Z"));
    const afternoon = await calls(pat);
    expect(afternoon.readyNow.map((x) => x.person?.name)).toEqual(["Nia Cole", "Pat Oneil"]);
    expect(afternoon.focusTaskId).toBe(pat);
    // A screen that names no call starts at the first one ready.
    expect((await calls(null)).focusTaskId).toBe(afternoon.readyNow[0]?.taskId);

    const answer = await log(pat, { outcome: "no_answer", numberId: (await task(pat)).numbers[0]?.detailId });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ task: { taskId: pat, open: false }, nextFocusTaskId: afternoon.readyNow[0]?.taskId });
  });

  test("a carried call counts against capacity only on a day it can be listed: a weekday call left on Friday leaves the weekend's room free", async () => {
    const SAM = person({ person_id: "p3", business_id: "b1", full_name: "Sam Lee", email: "sam@harbour.example" });
    const { h, campaign, calls } = await world({ capacity: 1, people: [PAT] });
    const friday = Date.parse("2026-11-06T09:00:00Z");
    h.clock = friday;
    await campaign("Weekdays", definition([track("p1", "call", [call("c1")], { kind: "entry" }, WEEKDAYS_9_TO_17)], { emailPool: [] }));
    await h.advanceTo(friday + H);
    expect(await calls()).toMatchObject({ placedToday: 1, committed: 0 });
    // Saturday: Pat's call cannot be listed, so it takes none of the day's room; Sam's every-day call is placed.
    h.clock = Date.parse("2026-11-07T09:00:00Z");
    await campaign("Every day", definition([track("p1", "call", [call("c1")], { kind: "entry" }, ALWAYS)], { emailPool: [] }), [SAM]);
    await h.advanceTo(h.clock + H);
    const saturday = await calls();
    expect(saturday).toMatchObject({ placedToday: 1, committed: 0 });
    expect(saturday.readyNow.map((x) => x.person?.name)).toEqual(["Sam Lee"]);
    // Monday: Pat's call is listed again and counts first.
    await h.advanceTo(Date.parse("2026-11-09T09:30:00Z"));
    expect((await calls()).committed).toBeGreaterThanOrEqual(1);
    expect((await calls()).readyNow.map((x) => x.person?.name)).toContain("Pat Oneil");
  });

  test("an outcome is accepted after the prospect's calling hours closed earlier that day, and refused on a day they never open", async () => {
    const { h, campaign, calls, task, log } = await world({ people: [PAT] });
    h.clock = MONDAY_9;
    await campaign("Hours", definition([track("p1", "call", [call("c1")], { kind: "entry" }, WEEKDAYS_9_TO_17)], { emailPool: [] }));
    await h.advanceTo(MONDAY_9 + H);
    const id = (await calls()).focusTaskId ?? "";
    const numberId = (await task(id)).numbers[0]?.detailId;
    // Monday 17:30: the hours have closed for the day. The call is in neither part of the queue, but it is on today's list.
    await h.advanceTo(Date.parse("2026-11-02T17:30:00Z"));
    expect(await calls()).toMatchObject({ readyNow: [], laterToday: [] });
    expect((await task(id)).listed).toBe(true);
    expect((await log(id, { outcome: "skip_for_now" })).status).toBe(200);
    // Saturday: the hours never open, so the call is not listed and its outcome is refused.
    await h.advanceTo(Date.parse("2026-11-07T12:00:00Z"));
    expect((await log(id, { outcome: "no_answer", numberId })).status).toBe(409);
  });

  test("a skip for now is not a call: its note is never a colleague's last call note", async () => {
    const { h, campaign, calls, task, log } = await world();
    h.clock = MONDAY_9;
    await campaign("Last notes", definition([track("p1", "call", [call("c1")], { kind: "entry" }, WEEKDAYS_9_TO_17)], { emailPool: [] }));
    await h.advanceTo(MONDAY_9 + H);
    const [first, second] = (await calls()).readyNow;
    const firstView = await task(first?.taskId ?? "");
    expect((await log(first?.taskId ?? "", { outcome: "voicemail", numberId: firstView.numbers[0]?.detailId, note: "Left a message." })).status).toBe(200);
    expect((await log(second?.taskId ?? "", { outcome: "skip_for_now", note: "Skipping: in a meeting." })).status).toBe(200);
    const fromSecond = (await task(second?.taskId ?? "")).colleagues.find((c) => c.name === firstView.person?.name);
    expect(fromSecond?.lastCallNote).toMatchObject({ note: "Left a message.", outcome: "voicemail" });
    const fromFirst = (await task(first?.taskId ?? "")).colleagues.find((c) => c.name !== firstView.person?.name);
    expect(fromFirst?.lastCallNote).toBeNull();
  });
});

describe("a call's history is what was dialled, not what may be dialled now (verifier re-check on 7902093)", () => {
  test("a dialled number merged into a colleague's detail, then into the company main line, stays on both histories after each import", async () => {
    const YARA = person({ person_id: "p6", business_id: "b1", full_name: "Yara Haddad", direct_phone: "+442079460155" });
    const ZARA = person({ person_id: "p7", business_id: "b1", full_name: "Zara Malik", direct_phone: "020 7946 0155" });
    // No country at first: Zara's national number is kept as its digits, and the company's line is not read.
    const harbour = (country: string) => business({ business_id: "b1", business_name: "Harbour Lane Physio", country, phone_original: "011442079460155" });
    const { h, calls, task, log } = await world();
    const { campaign: c } = await h.createCampaign("History", { businesses: [harbour("")], people: [YARA, ZARA] });
    await h.defineSequence(c.id, definition([track("p1", "call", [call("c1")], { kind: "entry" }, WEEKDAYS_9_TO_17)], { emailPool: [] }));
    h.clock = MONDAY_9;
    expect((await h.launch(c.id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + H);
    const zara = await task((await calls()).readyNow.find((x) => x.person?.name === "Zara Malik")?.taskId ?? "");
    const dialled = zara.numbers.find((n) => n.value.replace(/\D/g, "").endsWith("79460155"));
    expect(dialled).toBeDefined();
    expect((await log(zara.taskId, { outcome: "no_answer", numberId: dialled?.detailId, note: "Rang out." })).status).toBe(200);
    const histories = async () => {
      const view = await task(zara.taskId);
      const progress = await h.progress(zara.enrollmentId);
      return [view.touches.find((t) => t.kind === "call"), progress.tracks[0]?.steps[0]?.calls[0]] as const;
    };
    const [before] = await histories();
    expect(before).toMatchObject({ number: { value: "02079460155" } });

    // Import 1: the company's country arrives; Zara's copy folds into Yara's direct line, a colleague's number.
    await h.reimport(c.id, { businesses: [harbour("GB")], people: [YARA, ZARA] });
    await h.advanceTo(MONDAY_9 + 2 * H);
    for (const recorded of await histories()) expect(recorded).toMatchObject({ number: { value: "+44 20 7946 0155", kind: "direct", owner: "person" } });
    // The colleague's line is history only: Zara cannot log a new call on it.
    expect((await task(zara.taskId)).numbers.map((n) => n.value)).not.toContain("+44 20 7946 0155");

    // Import 2: the country is corrected to US, the line is read as international and becomes the company main line.
    await h.reimport(c.id, { businesses: [harbour("US")], people: [YARA, ZARA] });
    await h.advanceTo(MONDAY_9 + 3 * H);
    for (const recorded of await histories()) expect(recorded).toMatchObject({ number: { value: "+44 20 7946 0155" }, note: "Rang out." });
  });
});


describe("redials, callbacks and unworked calls (ticket 15)", () => {
  const WED_0 = Date.parse("2026-11-04T00:00:00Z");
  const def = () =>
    definition([
      // The parallel email track: two emails a day apart, and a third two days later.
      track("e1", "email", [email("s1"), email("s2", 1), email("s3", 2)]),
      track("p1", "call", [call("c1")], { kind: "entry" }, WEEKDAYS_9_TO_17),
      // "Following up on my call": only after the phone track has finished.
      track("e2", "email", [email("f1")], after("p1", 0)),
    ]);

  test("a redial ages from the call's original due date; the unworked call is skipped at the skip limit, the message after it goes then, and the parallel emails never wait", async () => {
    const { h, campaign, calls, today, task, log, emails } = await world({ people: [PAT] });
    h.clock = MONDAY_9;
    const c = await campaign("Redial", def());
    const id = (await calls()).focusTaskId ?? "";
    const direct = (await task(id)).numbers.find((n) => n.kind === "direct")?.detailId;

    // Monday 10:00: no answer, and the user asks for a redial. The call leaves today's list for tomorrow's.
    await h.advanceTo(MONDAY_9 + H);
    expect((await log(id, { outcome: "no_answer", redial: true, numberId: direct, note: "Rang out." })).status).toBe(200);
    expect(await task(id)).toMatchObject({ open: true, listed: false, outcomes: [], kind: "call", listedFor: "2026-11-03", dueAt: "2026-11-02T09:00:00.000Z" });
    expect((await today()).upNext).toEqual([]);
    expect((await log(id, { outcome: "no_answer", numberId: direct })).status).toBe(409);
    expect((await h.progress(c.lead("Pat Oneil"))).status).toBe("waiting_on_call");

    // Tuesday: on the list as a redial, at the top, with its original due date; skipped tonight if left unworked.
    await h.advanceTo(MONDAY_9 + DAY + H);
    const tuesday = await today();
    expect(tuesday.upNext).toEqual([expect.objectContaining({ taskId: id, reason: "redial", dueAt: "2026-11-02T09:00:00.000Z", bucket: "ready_now", skippedTonight: true })]);
    expect(tuesday.carriedOver).toBe(1);

    // Left unworked: at the end of Tuesday (two days from its original due date, not from the redial) it is skipped.
    await h.advanceTo(WED_0 + 2 * H);
    const progress = await h.progress(c.lead("Pat Oneil"));
    expect(progress.tracks.find((t) => t.trackId === "p1")).toMatchObject({ finishReason: "skipped_unworked", finishedAt: "2026-11-04T00:00:00.000Z", callTask: { open: false } });
    expect(progress.status).toBe("active");
    expect((await today()).upNext).toEqual([]);
    // The message after the call went when the call was skipped; the parallel track sent on its own days throughout.
    expect(emails("pat@harbour.example").map((d) => [d.stepId, new Date(d.at).toISOString()])).toEqual([
      ["s1", "2026-11-02T09:00:00.000Z"],
      ["s2", "2026-11-03T00:00:00.000Z"],
      ["f1", "2026-11-04T00:00:00.000Z"],
    ]);
    await h.advanceTo(WED_0 + DAY + H);
    expect(emails("pat@harbour.example").map((d) => d.stepId)).toEqual(["s1", "s2", "f1", "s3"]);
  });

  test("a callback holds the lead's automated outreach until its outcome: later today before its time, overdue after, never expired or resumed silently", async () => {
    const { h, campaign, calls, today, task, log, emails } = await world({ people: [PAT] });
    h.clock = MONDAY_9;
    const c = await campaign("Callback", def());
    const id = (await calls()).focusTaskId ?? "";
    const direct = (await task(id)).numbers.find((n) => n.kind === "direct")?.detailId;

    // Monday 10:00: Pat asks to be called back on Tuesday at 15:00.
    await h.advanceTo(MONDAY_9 + H);
    expect((await log(id, { outcome: "callback_requested", callbackAt: "2026-11-03T15:00:00.000Z", numberId: direct, note: "Call back tomorrow afternoon." })).status).toBe(200);
    expect((await h.progress(c.lead("Pat Oneil"))).status).toBe("callback_scheduled");
    expect(await task(id)).toMatchObject({ kind: "callback", callbackAt: "2026-11-03T15:00:00.000Z", listedFor: "2026-11-03", listed: false });

    // Tuesday morning: later today, at the time Pat asked for. The email due at Tuesday 00:00 waits.
    await h.advanceTo(MONDAY_9 + DAY);
    expect((await today()).upNext).toEqual([expect.objectContaining({ taskId: id, kind: "callback", reason: "callback", bucket: "later_today", opensAt: "2026-11-03T15:00:00.000Z" })]);
    expect(emails("pat@harbour.example").map((d) => d.stepId)).toEqual(["s1"]);

    // Missed. Thursday, at 22:00, outside every calling hour: still on the list, overdue, at the top; nothing sent; never skipped.
    await h.advanceTo(MONDAY_9 + 3 * DAY + 13 * H);
    const thursday = await today();
    expect(thursday.overdueCallbacks).toEqual([expect.objectContaining({ taskId: id, reason: "overdue", bucket: "ready_now", callbackAt: "2026-11-03T15:00:00.000Z", dueAt: "2026-11-02T09:00:00.000Z" })]);
    expect((await h.request<{ overdueCallbacks: unknown[] }>("GET", "/api/needs-attention")).body.overdueCallbacks).toEqual([{ taskId: id, enrollmentId: c.lead("Pat Oneil"), campaignId: c.id, callbackAt: "2026-11-03T15:00:00.000Z", dueAt: "2026-11-02T09:00:00.000Z" }]);
    expect(emails("pat@harbour.example").map((d) => d.stepId)).toEqual(["s1"]);
    expect((await h.progress(c.lead("Pat Oneil"))).status).toBe("callback_scheduled");

    // Thursday 22:30: the user reaches Pat's voicemail. The hold ends; the clock resumes where it stopped (Monday 10:00),
    // so the email that was due 14 hours later goes 14 hours from now, and the message after the call goes now.
    const thursday2230 = MONDAY_9 + 3 * DAY + 13 * H + 30 * 60_000;
    await h.advanceTo(thursday2230);
    expect((await log(id, { outcome: "voicemail", numberId: direct })).status).toBe(200);
    expect((await h.progress(c.lead("Pat Oneil"))).status).toBe("active");
    await h.advanceTo(thursday2230 + 15 * H);
    expect(emails("pat@harbour.example").map((d) => [d.stepId, new Date(d.at).toISOString()])).toEqual([
      ["s1", "2026-11-02T09:00:00.000Z"],
      ["f1", "2026-11-05T22:30:00.000Z"],
      ["s2", "2026-11-06T12:30:00.000Z"],
    ]);
  });

  test("redial and callback are refused plainly where they do not apply, and every action is safe to repeat", async () => {
    const { h, campaign, calls, task } = await world({ people: [PAT] });
    h.clock = MONDAY_9;
    const c = await campaign("Refusals", def());
    const id = (await calls()).focusTaskId ?? "";
    const direct = (await task(id)).numbers.find((n) => n.kind === "direct")?.detailId;
    const post = (body: Record<string, unknown>) => h.request<{ error?: { code: string; message: string } }>("POST", `/api/call-tasks/${id}/outcome`, { numberId: direct, note: "", ...body });

    expect(await post({ requestId: "r1", outcome: "interested", redial: true })).toMatchObject({ status: 409, body: { error: { code: "outcome_refused", message: "A redial follows no answer, voicemail left, or gatekeeper or not reached." } } });
    expect(await post({ requestId: "r2", outcome: "callback_requested" })).toMatchObject({ status: 409, body: { error: { message: "Give the date and time the prospect asked to be called back." } } });
    expect(await post({ requestId: "r3", outcome: "no_answer", callbackAt: "2026-11-03T15:00:00.000Z" })).toMatchObject({ status: 409, body: { error: { message: "A date and time goes with a callback requested only." } } });
    expect(await post({ requestId: "r4", outcome: "callback_requested", callbackAt: "2026-11-01T15:00:00.000Z" })).toMatchObject({ status: 409, body: { error: { message: "A callback is for a date and time still to come." } } });
    expect((await post({ requestId: "r5", outcome: "callback_requested", callbackAt: "tomorrow at three" })).status).toBe(400);
    expect((await post({ requestId: "r6", outcome: "callback_requested", callbackAt: "2026-11-03T15:00:00.000Z", reschedule: "auto" })).status).toBe(400);
    // Nothing above was logged.
    expect((await h.progress(c.lead("Pat Oneil"))).tracks.find((t) => t.trackId === "p1")?.steps[0]?.calls).toEqual([]);

    // The same callback posted twice, once more after a restart: logged once, and the hold is the one asked for.
    const body = { requestId: "r7", outcome: "callback_requested", callbackAt: "2026-11-03T15:00:00+01:00" };
    const twice = await Promise.all([post(body), post(body)]);
    expect(twice.map((r) => r.status)).toEqual([200, 200]);
    await h.restart();
    expect((await post(body)).status).toBe(200);
    const progress = await h.progress(c.lead("Pat Oneil"));
    expect(progress.status).toBe("callback_scheduled");
    expect(progress.tracks.find((t) => t.trackId === "p1")?.steps[0]?.calls).toEqual([expect.objectContaining({ outcome: "callback_requested", callbackAt: "2026-11-03T14:00:00.000Z", redial: false })]);

    // A redial posted twice moves the call once.
    await h.advanceTo(Date.parse("2026-11-03T14:30:00Z"));
    const redial = { requestId: "r8", outcome: "gatekeeper", redial: true };
    expect((await post(redial)).status).toBe(200);
    expect((await post(redial)).status).toBe(200);
    expect(await task(id)).toMatchObject({ kind: "call", listedFor: "2026-11-04" });
    expect((await h.progress(c.lead("Pat Oneil"))).tracks.find((t) => t.trackId === "p1")?.steps[0]?.calls.map((x) => [x.outcome, x.redial])).toEqual([["callback_requested", false], ["gatekeeper", true]]);
  });
});

describe("a user action is judged as of its own instant, whether or not the worker has ticked since (review bot on eda5fa0)", () => {
  const WED_0 = Date.parse("2026-11-04T00:00:00Z");
  const def = () => definition([track("p1", "call", [call("c1")], { kind: "entry" }, WEEKDAYS_9_TO_17), track("e2", "email", [email("f1")], after("p1", 0))]);

  for (const [name, body] of [
    ["a callback", { outcome: "callback_requested", callbackAt: "2026-11-05T15:00:00Z" }],
    ["a redial", { outcome: "no_answer", redial: true }],
    ["an outcome", { outcome: "voicemail" }],
  ] as const) {
    test(`${name} one second after the skip limit expired the call, before any tick, is refused, and the expiry and what it releases stand as at that rollover`, async () => {
      const { h, campaign, calls, task, log, emails } = await world({ people: [PAT] });
      h.clock = MONDAY_9;
      const c = await campaign("As of the instant", def());
      const id = (await calls()).focusTaskId ?? "";
      const direct = (await task(id)).numbers.find((n) => n.kind === "direct")?.detailId;
      await h.advanceTo(WED_0 - 60_000);
      // The worker has not ticked since Tuesday 23:59; the user acts at Wednesday 00:00:01.
      h.clock = WED_0 + 1_000;
      const res = await log(id, { ...body, numberId: direct });
      // Refused, and it says why: the call was skipped at that rollover, before this action arrived.
      expect(res).toMatchObject({ status: 409, body: { error: { message: "This call was skipped at 2026-11-04T00:00:00.000Z: it was not worked within its skip limit, so it is no longer on the list." } } });
      const progress = await h.progress(c.lead("Pat Oneil"));
      // Never reached: the call was skipped unworked, and the email after it has only just started.
      expect(progress.status).toBe("queued");
      expect(progress.tracks.find((t) => t.trackId === "p1")).toMatchObject({ finishReason: "skipped_unworked", finishedAt: "2026-11-04T00:00:00.000Z", callTask: { open: false } });
      expect(progress.tracks.find((t) => t.trackId === "p1")?.steps[0]?.calls).toEqual([]);
      // The track after the call starts from the rollover, not from when the worker caught up.
      await h.advanceTo(WED_0 + H);
      expect(emails("pat@harbour.example").map((d) => [d.stepId, new Date(d.at).toISOString()])).toEqual([["f1", "2026-11-04T00:00:01.000Z"]]);
      expect(progress.tracks.find((t) => t.trackId === "e2")?.started).toBe(true);
    });
  }

  test("one second before the rollover, the same action is accepted", async () => {
    const { h, campaign, calls, task, log } = await world({ people: [PAT] });
    h.clock = MONDAY_9;
    const c = await campaign("Just in time", def());
    const id = (await calls()).focusTaskId ?? "";
    const direct = (await task(id)).numbers.find((n) => n.kind === "direct")?.detailId;
    await h.advanceTo(WED_0 - 60_000);
    h.clock = WED_0 - 1_000;
    expect((await log(id, { outcome: "callback_requested", callbackAt: "2026-11-05T15:00:00Z", numberId: direct })).status).toBe(200);
    expect((await h.progress(c.lead("Pat Oneil"))).status).toBe("callback_scheduled");
  });
});

describe("a call carried into a day counts against it as it stood at the day's start (ticket 15a, found by the generated runs)", () => {
  test("working a carried callback on a day its calling hours never open frees no room that day", async () => {
    const { h, campaign, calls, task, log } = await world({ capacity: 1 });
    h.clock = MONDAY_9;
    const a = await campaign("Weekday calls", definition([track("p1", "call", [call("c1")], { kind: "entry" }, WEEKDAYS_9_TO_17)], { emailPool: [] }), [PAT]);
    const id = (await calls()).focusTaskId ?? "";
    const direct = (await task(id)).numbers.find((n) => n.kind === "direct")?.detailId;
    // Monday: Pat asks to be called back on Saturday at 10:00.
    await h.advanceTo(MONDAY_9 + H);
    expect((await log(id, { outcome: "callback_requested", callbackAt: "2026-11-07T10:00:00Z", numberId: direct })).status).toBe(200);
    // Saturday 08:00: another campaign's call falls due; the carried callback takes the day's one place.
    await h.advanceTo(Date.parse("2026-11-07T08:00:00Z"));
    const b = await campaign("Every day", definition([track("p2", "call", [call("c2")], { kind: "entry" }, ALWAYS)], { emailPool: [] }), [NIA]);
    expect(await calls()).toMatchObject({ committed: 1, placedToday: 0 });
    // Saturday 10:30: the user works the callback. That frees no room today: Nia's call waits for Sunday.
    await h.advanceTo(Date.parse("2026-11-07T10:30:00Z"));
    expect((await log(id, { outcome: "no_answer", numberId: direct })).status).toBe(200);
    expect((await h.progress(a.lead("Pat Oneil"))).tracks[0]?.finishReason).toBe("completed");
    await h.advanceTo(Date.parse("2026-11-07T23:00:00Z"));
    expect(await calls()).toMatchObject({ committed: 1, placedToday: 0 });
    expect((await h.progress(b.lead("Nia Cole"))).status).toBe("queued");
    await h.advanceTo(Date.parse("2026-11-08T08:00:00Z"));
    expect((await h.progress(b.lead("Nia Cole"))).status).toBe("waiting_on_call");
  });
});
