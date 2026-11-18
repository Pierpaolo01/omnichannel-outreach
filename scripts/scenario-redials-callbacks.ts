/**
 * A scripted run of ticket 15's demonstration (redials, callbacks and unworked calls), through the real
 * HTTP app and an in-memory SQLite store, against the fake email provider, with time advanced by the
 * script. The user dials on their own phone: the application never dials, has no telephony provider,
 * and the script only logs the outcomes a user would log. Fictitious data only.
 *
 *   node --import ./src/server/quiet-sqlite-warning.ts scripts/scenario-redials-callbacks.ts
 *
 * It shows: a redial aging from the call's original due date until the skip limit skips it, which
 * releases the message after the call; the parallel email track sending on its own days throughout;
 * and an overdue callback holding the lead's automated outreach until its outcome is logged.
 */
import type { CampaignDefinition, StepDefinition } from "../src/domain/sequence/definition.ts";
import type { CallTaskView, EnrollmentProgress, LeadSearchResult, NeedsAttention, TodayView } from "../src/shared/api.ts";
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
await h.request("PUT", "/api/call-settings", { dailyCapacity: 5, userZone: "Europe/London" });

const { campaign } = await h.createCampaign("Scenario: redials and callbacks", {
  businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })],
  people: [
    person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", title: "Clinic owner", email: "pat@harbour.example", direct_phone: "+442079460111" }),
    person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", title: "Practice manager", email: "nia@harbour.example", dial_phone: "+447700900102", dial_phone_type: "mobile" }),
  ],
});

const weekdays = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
const always = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const email = (id: string, waitDays: number, body: string): StepDefinition => ({ id, waitDays, subject: waitDays === 0 ? "Hello {{first_name|there}}" : "", body, threading: waitDays === 0 ? "new_subject" : "continue_thread", removed: false });
const definition: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["inbox-a"],
  smsPool: [],
  callScript: "Introduce yourself, ask who looks after new patient bookings, offer a ten-minute demo.",
  tracks: [
    // The parallel email track: e1 at once, e2 a day later, e3 two days after that.
    { id: "intro", channel: "email", branch: "main", window: always, steps: [email("e1", 0, "A note for {{company}}."), email("e2", 1, "Following up, {{first_name|there}}."), email("e3", 2, "One last note.")], start: { kind: "entry" }, removed: false },
    { id: "phone", channel: "call", branch: "main", window: weekdays, steps: [{ id: "c1", waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false }], start: { kind: "entry" }, removed: false },
    // "Following up on my call": only once the phone track has finished.
    { id: "after-call", channel: "email", branch: "main", window: always, steps: [email("f1", 0, "Following up on my call, {{first_name|there}}.")], start: { kind: "after", trackId: "phone", delayDays: 0 }, removed: false },
  ],
};
await h.defineSequence(campaign.id, definition);
log("Sequence: intro emails [e1; e2 1 day later; e3 2 days after e2], every day, together with a phone track [one call], calling hours Mon-Fri 09:00-17:00; after-call email [f1] as soon as the phone track finishes. Skip limit 2 days. User zone Europe/London.");

h.clock = Date.parse("2026-11-02T09:00:00Z");
log(`${at(h.clock)}  launch -> HTTP ${(await h.launch(campaign.id)).status}`);
const leads = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows;
const id = (who: string) => leads.find((r) => r.name === who)?.enrollments[0]?.id ?? "";

const today = async () => {
  const t = (await h.request<TodayView>("GET", "/api/today")).body;
  const item = (x: TodayView["upNext"][number]) => `${x.person?.name ?? x.company.name} ${x.bucket} (${x.reason}${x.callbackAt ? `, asked for ${at(Date.parse(x.callbackAt))}` : ""}; original due ${at(Date.parse(x.dueAt))}${x.skippedTonight ? "; skipped tonight if unworked" : ""})`;
  log(`${at(h.clock)}  Today ${t.date}: ${t.readyNow} ready now, ${t.laterToday} later today, ${t.carriedOver} carried over. Up next: ${t.upNext.map(item).join("; ") || "nothing"}. Overdue callbacks: ${t.overdueCallbacks.map(item).join("; ") || "none"}`);
};
const attention = async () => {
  const n = (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body;
  log(`${at(h.clock)}  Needs attention, overdue callbacks: ${JSON.stringify(n.overdueCallbacks.map((x) => ({ lead: leads.find((r) => r.enrollments[0]?.id === x.enrollmentId)?.name, callbackAt: x.callbackAt, dueAt: x.dueAt })))}`);
};
const status = async (who: string) => {
  const p = (await h.request<EnrollmentProgress>("GET", `/api/enrollments/${id(who)}`)).body;
  const phone = p.tracks.find((t) => t.trackId === "phone");
  log(`${at(h.clock)}  ${who}: ${p.status}; phone track ${phone?.finishReason ?? "open"}${phone?.finishedAt ? ` at ${at(Date.parse(phone.finishedAt))}` : ""}${phone?.callTask ? `; its call ${phone.callTask.open ? "open" : "closed"}, a ${phone.callTask.kind}, listed for ${phone.callTask.listedFor}` : ""}`);
};
const emails = (who: string) => {
  const to = who === "Pat Oneil" ? "pat@harbour.example" : "nia@harbour.example";
  log(`${at(h.clock)}  ${who}'s emails sent: ${h.fake.deliveryLog.filter((d) => d.destination === to).map((d) => `${d.stepId} ${at(d.at)}`).join(", ") || "none"}`);
};
let actions = 0;
const taskOf = async (who: string) => {
  const p = (await h.request<EnrollmentProgress>("GET", `/api/enrollments/${id(who)}`)).body;
  return p.tracks.find((t) => t.trackId === "phone")?.callTask?.taskId ?? "";
};
/** The user logs what happened on the named lead's call, on the first good number. */
const outcome = async (who: string, body: { outcome: string; redial?: boolean; callbackAt?: string; note?: string }) => {
  const taskId = await taskOf(who);
  const view = (await h.request<CallTaskView>("GET", `/api/call-tasks/${taskId}`)).body;
  const number = view.numbers.find((n) => !n.bad);
  const res = await h.request<{ error?: { message: string } }>("POST", `/api/call-tasks/${taskId}/outcome`, { requestId: `scenario-${++actions}`, ...body, numberId: number?.detailId ?? null, note: body.note ?? "" });
  log(`${at(h.clock)}  ${who}: ${body.outcome}${body.redial ? " + redial" : ""}${body.callbackAt ? ` (callback at ${body.callbackAt})` : ""} -> HTTP ${res.status}${res.body.error ? ` (${res.body.error.message})` : ""}`);
};

// Monday.
await today();
await h.advanceTo(Date.parse("2026-11-02T10:00:00Z"));
await outcome("Pat Oneil", { outcome: "no_answer", redial: true, note: "Rang out." });
log("A redial moves the call to tomorrow: an outcome on it today is refused.");
await outcome("Pat Oneil", { outcome: "no_answer" });
log("A redial follows only no answer, voicemail or gatekeeper; a callback is for a time still to come.");
await outcome("Nia Cole", { outcome: "interested", redial: true });
await outcome("Nia Cole", { outcome: "callback_requested", callbackAt: "2026-11-01T15:00:00+00:00" });
await outcome("Nia Cole", { outcome: "callback_requested", callbackAt: "2026-11-03T15:00:00+00:00", note: "Busy now; call back tomorrow afternoon." });
await status("Pat Oneil");
await status("Nia Cole");
await today();

// Tuesday: Pat's redial is on the list with its original due date; Nia's callback is later today.
await h.advanceTo(Date.parse("2026-11-03T09:30:00Z"));
await today();
emails("Pat Oneil");
emails("Nia Cole");

// The user is away until Thursday: Pat's redial is left unworked, Nia's callback is missed.
await h.advanceTo(Date.parse("2026-11-04T00:30:00Z"));
log("Wednesday 00:30: Pat's call was skipped at the end of Tuesday, two days from its original due date (not from the redial); the after-call email went then.");
await status("Pat Oneil");
emails("Pat Oneil");
await h.advanceTo(Date.parse("2026-11-05T22:00:00Z"));
log("Thursday 22:00, outside every calling hour: Nia's callback is overdue and still on the list; her intro e2 (due Tuesday 00:00, 14 hours of her clock after the hold began) has not gone.");
await today();
await attention();
await status("Nia Cole");
emails("Nia Cole");

// Thursday 22:30: the user reaches Nia's voicemail. The hold ends; her clock resumes where it stopped.
await h.advanceTo(Date.parse("2026-11-05T22:30:00Z"));
await outcome("Nia Cole", { outcome: "voicemail", note: "Left a message." });
await status("Nia Cole");
await h.advanceTo(Date.parse("2026-11-07T00:00:00Z"));
log("Saturday: the after-call email went when her call was logged; e2 went 14 hours later, the rest of its wait counted on her running clock.");
emails("Nia Cole");
emails("Pat Oneil");
await h.store.close();
