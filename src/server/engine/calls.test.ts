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
  const log = (id: string, body: Record<string, unknown>) => h.request<{ error?: { message: string } }>("POST", `/api/call-tasks/${id}/outcome`, body);
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
    await h.advanceTo(Date.parse("2026-11-05T05:00:00Z"));

    // The parallel email track ran both its steps; the email after the phone track waits for the call.
    expect(emails("pat@harbour.example").map((d) => d.stepId)).toEqual(["s1", "s2"]);
    expect(h.fake.handoverLog.every((x) => x.destination === "pat@harbour.example")).toBe(true);
    const progress = await h.progress(c.lead("Pat Oneil"));
    expect(progress.status).toBe("waiting_on_call");
    expect(progress.tracks.map((t) => [t.trackId, t.finishReason])).toEqual([["e1", "completed"], ["p1", null], ["e2", null]]);
    expect(progress.tracks.find((t) => t.trackId === "e2")?.started).toBe(false);

    // Thursday 05:00 London: outside calling hours, the unworked call waits as later today, rolled over.
    const thursday = await today();
    expect(thursday).toMatchObject({ date: "2026-11-05", readyNow: 0, laterToday: 1 });
    expect(thursday.upNext).toEqual([expect.objectContaining({ bucket: "later_today", reason: "rolled_over", localTime: "05:00", opensAt: "2026-11-05T09:00:00.000Z" })]);
    expect((await calls()).focusTaskId).toBeNull();

    // At 09:00 it is ready now, oldest due first.
    await h.advanceTo(Date.parse("2026-11-05T09:30:00Z"));
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

    const logged = await log(taskId, { outcome: "gatekeeper", numberId: mainLine?.detailId, note: "Receptionist says Pat is in clinic until 3." });
    expect(logged.status).toBe(200);
    const after = await task(taskId);
    expect(after).toMatchObject({ open: false, listed: false, outcomes: [], status: "active" });
    expect(after.touches.at(-1)).toEqual({ kind: "call", at: "2026-11-02T11:00:00.000Z", outcome: "gatekeeper", number: mainLine, note: "Receptionist says Pat is in clinic until 3." });
    expect(after.personNotes.map((n) => n.body)).toEqual(["Receptionist says Pat is in clinic until 3."]);
    expect(after.companyNotes).toEqual([]);
    expect((await calls()).readyNow).toEqual([]);

    const progress = await h.progress(c.lead("Pat Oneil"));
    expect(progress.tracks.find((t) => t.trackId === "p1")).toMatchObject({
      channel: "call",
      finishReason: "completed",
      finishedAt: "2026-11-02T11:00:00.000Z",
      callTask: { taskId, open: false, placedAt: "2026-11-02T09:00:00.000Z", listed: false },
      steps: [{ stepId: "c1", result: "sent", reason: "gatekeeper", calls: [{ outcome: "gatekeeper", at: "2026-11-02T11:00:00.000Z", number: mainLine, note: "Receptionist says Pat is in clinic until 3." }] }],
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
      outcomes: ["no_answer", "voicemail", "gatekeeper", "wrong_number", "interested", "skip_for_now"],
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
    await h.advanceTo(MONDAY_9 + 2 * DAY);
    expect(emails("pat@harbour.example").filter((d) => d.subjectId === spring.lead("Pat Oneil")).map((d) => d.stepId)).toEqual(["s1"]);
    expect(emails("pat@harbour.example").filter((d) => d.subjectId === autumn.lead("Pat Oneil")).map((d) => d.stepId)).toEqual(["s1", "s2"]);
    expect((await h.progress(spring.lead("Nia Cole"))).status).toBe("waiting_on_call");
  });

  test("skip for now moves the task to the end of the queue and is not a call made; outcomes on a task that is not listed are refused", async () => {
    const { h, campaign, calls, task, log } = await world();
    h.clock = MONDAY_9;
    const c = await campaign("Skipping", definition([track("p1", "call", [call("c1")], { kind: "entry" }, WEEKDAYS_9_TO_17)], { emailPool: [] }));
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

    // Not interested, callbacks and redials are not offered by this release.
    expect((await log(firstId, { outcome: "not_interested", numberId: skipped.numbers[0]?.detailId })).status).toBe(400);
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

    // Wednesday: one call is carried over, so one new call fits: the one that waited.
    await h.advanceTo(Date.parse("2026-11-04T09:30:00Z"));
    const wednesday = await calls();
    expect(wednesday).toMatchObject({ placedToday: 1, committed: 1 });
    expect(wednesday.readyNow.map((x) => [x.enrollmentId, x.reason])).toEqual([[ids.find((id) => id !== first.enrollmentId && id !== ids[2]), "rolled_over"], [ids[2], "due"]].sort((a, b) => (a[0]! < b[0]! ? -1 : 1)));
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
    expect((await h.request("POST", `/api/call-tasks/${view.taskId}/outcome`, { outcome: "wrong_number", numberId: view.numbers[0]?.detailId })).status).toBe(200);
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

