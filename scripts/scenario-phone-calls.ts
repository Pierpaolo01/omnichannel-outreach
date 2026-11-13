/**
 * A scripted run of a phone track worked from the call list (ticket 14a), through the real HTTP app
 * and an in-memory SQLite store, against the fake email provider, with time advanced by the script.
 * The user dials on their own phone: the application never dials, has no telephony provider, and
 * the script only logs the outcomes a user would log. Fictitious data only.
 *
 *   node --import ./src/server/quiet-sqlite-warning.ts scripts/scenario-phone-calls.ts
 */
import type { CampaignDefinition, StepDefinition } from "../src/domain/sequence/definition.ts";
import type { CallsView, CallTaskView, EnrollmentProgress, LeadSearchResult, TodayView } from "../src/shared/api.ts";
import { EngineHarness } from "../test/support/engine-harness.ts";
import { business, person } from "../test/support/export-builder.ts";

const MIN = 60_000;
const at = (t: number) => new Date(t).toISOString().replace(":00.000Z", "Z");
const log = (line: string) => console.info(line);

const h = new EngineHarness({
  start: Date.parse("2026-11-02T07:00:00Z"), // Monday, London
  accounts: [{ id: "inbox-a", capacity: 30, gapMs: 2 * MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
});
await h.tick();
await h.request("PUT", "/api/call-settings", { dailyCapacity: 3, userZone: "Europe/London" });
log(`Call settings: ${JSON.stringify((await h.request("GET", "/api/call-settings")).body)}`);

const { campaign } = await h.createCampaign("Scenario: physio calls", {
  businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })],
  people: [
    person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", title: "Clinic owner", email: "pat@harbour.example", direct_phone: "+442079460111" }),
    person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", title: "Practice manager", email: "nia@harbour.example", dial_phone: "+447700900102", dial_phone_type: "mobile" }),
    person({ person_id: "p3", business_id: "b1", full_name: "Sam Lee", title: "Lead physio", email: "sam@harbour.example" }),
    person({ person_id: "p4", business_id: "b1", full_name: "Omar Reed", title: "Physio", email: "omar@harbour.example", direct_phone: "+442079460144" }),
  ],
});

const weekdays = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
const email = (id: string, waitDays: number, body: string): StepDefinition => ({ id, waitDays, subject: waitDays === 0 ? "Hello {{first_name|there}}" : "", body, threading: waitDays === 0 ? "new_subject" : "continue_thread", removed: false });
const call = (id: string): StepDefinition => ({ id, waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false });
const definition: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["inbox-a"],
  smsPool: [],
  callScript: "Introduce yourself, ask who looks after new patient bookings, offer a ten-minute demo.",
  tracks: [
    // An email track and a phone track start together; a follow-up email goes one day after the call.
    { id: "intro", channel: "email", branch: "main", window: weekdays, steps: [email("e1", 0, "A note for {{company}}."), email("e2", 2, "Following up, {{first_name|there}}.")], start: { kind: "entry" }, removed: false },
    { id: "phone", channel: "call", branch: "main", window: weekdays, steps: [call("c1")], start: { kind: "entry" }, removed: false },
    { id: "after-call", channel: "email", branch: "main", window: weekdays, steps: [email("e3", 0, "Thanks for your time on the phone, {{first_name|there}}.")], start: { kind: "after", trackId: "phone", delayDays: 1 }, removed: false },
  ],
};
await h.defineSequence(campaign.id, definition);
log("Sequence: intro email [e1; e2 after 2 days] together with a phone track [one call]; after-call email [e3] 1 day after the call. Calling hours and sending window Mon-Fri 09:00-17:00 prospect time. Daily call capacity 3.");

h.clock = Date.parse("2026-11-02T08:00:00Z");
log(`${at(h.clock)}  launch -> HTTP ${(await h.launch(campaign.id)).status}`);
const leads = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows;
const names = new Map(leads.map((r) => [r.enrollments[0]?.id ?? "", r.name]));
const name = (id: string) => names.get(id) ?? id;

const today = async () => {
  const t = (await h.request<TodayView>("GET", "/api/today")).body;
  log(`${at(h.clock)}  Today ${t.date} (${t.userZone}): ${t.readyNow} ready now, ${t.laterToday} later today. Up next: ${t.upNext.map((x) => `${x.person?.name ?? x.company.name} ${x.localTime} ${x.bucket} (${x.reason})`).join("; ") || "nothing"}`);
};
const queue = async () => {
  const q = (await h.request<CallsView>("GET", "/api/calls")).body;
  log(`${at(h.clock)}  Calls: placed today ${q.placedToday}, committed ${q.committed} of ${q.dailyCapacity}; ready now [${q.readyNow.map((x) => x.person?.name).join(", ")}], later today [${q.laterToday.map((x) => x.person?.name).join(", ")}]; focus ${q.focusTaskId ? (q.readyNow[0]?.person?.name ?? "") : "none"}`);
  return q;
};
/** The user logs what happened on the named lead's call, on the number of that kind they dialled. */
const outcome = async (who: string, body: { outcome: string; kind?: string; note?: string; noteScope?: string }) => {
  const q = (await h.request<CallsView>("GET", "/api/calls")).body;
  const item = q.readyNow.find((x) => x.person?.name === who);
  const view = (await h.request<CallTaskView>("GET", `/api/call-tasks/${item?.taskId ?? ""}`)).body;
  const number = body.kind ? view.numbers.find((n) => n.kind === body.kind) : undefined;
  const res = await h.request<{ error?: { message: string } }>("POST", `/api/call-tasks/${view.taskId}/outcome`, { outcome: body.outcome, numberId: number?.detailId ?? null, note: body.note ?? "", noteScope: body.noteScope ?? "person" });
  log(`${at(h.clock)}  ${who}: ${body.outcome}${number ? ` on the ${number.kind.replace("_", " ")} ${number.value}` : ""}${body.note ? ` with a ${body.noteScope ?? "person"} note "${body.note}"` : ""} -> HTTP ${res.status}${res.body.error ? ` (${res.body.error.message})` : ""}`);
};

await today();
h.clock = Date.parse("2026-11-02T09:05:00Z");
await h.tick();
await today();
await queue();

const focus = (await h.request<CallsView>("GET", "/api/calls")).body.focusTaskId ?? "";
const view = (await h.request<CallTaskView>("GET", `/api/call-tasks/${focus}`)).body;
log("");
log(`Call screen for ${view.person?.name} (${view.person?.title}, ${view.company.name}), ${view.campaign.name}, ${view.track.label}, local time ${view.localTime}:`);
log(`  numbers: ${view.numbers.map((n) => `${n.kind.replace("_", " ")} ${n.value}${n.bad ? " (bad)" : ""}`).join(", ")}`);
log(`  script: ${view.script}`);
log(`  earlier touches: ${view.touches.map((t) => (t.kind === "call" ? `call ${t.outcome}` : t.kind === "reply" ? `reply (${t.channel})` : `${t.kind} ${t.stepId} "${t.copy?.body ?? ""}"`)).join("; ") || "none"}`);
log(`  others at the company: ${view.colleagues.map((c) => `${c.name} (${c.title}) ${c.statuses.map((s) => s.status).join("/") || "not enrolled"}`).join("; ")}`);
log(`  outcomes offered: ${view.outcomes.join(", ")}`);
log("");

await outcome("Pat Oneil", { outcome: "skip_for_now" });
await queue();
h.clock += 10 * MIN;
await outcome("Nia Cole", { outcome: "interested", kind: "mobile", note: "Wants a demo next week." });
h.clock += 10 * MIN;
await outcome("Sam Lee", { outcome: "gatekeeper", kind: "main_line", note: "Receptionist: Sam is back from clinic at 3pm.", noteScope: "company" });
h.clock += 10 * MIN;
await outcome("Pat Oneil", { outcome: "wrong_number", kind: "direct", note: "Direct line is a fax." });
log(`${at(h.clock)}  (until question Q4 is answered, a wrong number finishes the phone track even though Pat's main line is still good)`);
await queue();
log(`${at(h.clock)}  Omar's call waits: today's list already holds its capacity of 3`);

const progress = async () => {
  for (const [id, who] of names) {
    const p = (await h.request<EnrollmentProgress>("GET", `/api/enrollments/${id}`)).body;
    log(`  ${who.padEnd(10)} status=${p.status}; ${p.tracks.map((t) => `${t.trackId}:${t.started ? (t.finishReason ?? "running") : "not started"}`).join(" ")}`);
  }
};
log("");
log(`${at(h.clock)}  state per lead (GET /api/enrollments/:id):`);
await progress();

await h.advanceTo(Date.parse("2026-11-03T09:30:00Z"));
log("");
await today();
await queue();
await outcome("Omar Reed", { outcome: "voicemail", kind: "direct", note: "Left a message about the demo." });
await h.advanceTo(Date.parse("2026-11-06T17:00:00Z"));

log("");
log("Fake email provider's delivery log (nothing else received anything; no call was dialled by the app):");
for (const d of h.fake.deliveryLog) log(`  ${at(d.at)}  ${d.stepId}  ${name(d.subjectId).padEnd(10)} "${d.rendered.body}"`);
log("");
log(`${at(h.clock)}  final state per lead:`);
await progress();
const last = (await h.request<CallTaskView>("GET", `/api/call-tasks/${focus}`)).body;
log(`Company notes, shown on every call at ${last.company.name}: ${last.companyNotes.map((n) => `"${n.body}"`).join(", ")}`);
await h.store.close();
