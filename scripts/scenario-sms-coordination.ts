/**
 * A scripted run of SMS tracks beside email and the coordination between tracks (ticket 13a),
 * through the real HTTP app and an in-memory SQLite store, against the fake email provider and the
 * fake SMS provider, with time advanced by the script. No SMS provider exists: the fake SMS
 * provider is a test double ("Simulated SMS (not a provider)"), not an integration, and nothing
 * reaches anyone. Fictitious data only.
 *
 *   node --import ./src/server/quiet-sqlite-warning.ts scripts/scenario-sms-coordination.ts
 */
import type { CampaignDefinition, StepDefinition } from "../src/domain/sequence/definition.ts";
import type { EnrollmentProgress, LeadSearchResult, NeedsAttention, SmsProviderStatus } from "../src/shared/api.ts";
import { EngineHarness } from "../test/support/engine-harness.ts";
import { business, person } from "../test/support/export-builder.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const start = Date.parse("2026-11-02T08:00:00Z"); // Monday, London
const at = (t: number) => new Date(t).toISOString().replace(":00.000Z", "Z");
const log = (line: string) => console.info(line);
const N1 = "+447700900001";
const N2 = "+447700900002";

const h = new EngineHarness({
  start,
  accounts: [{ id: "inbox-a", capacity: 30, gapMs: 2 * MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
  sms: { numbers: [N1, N2].map((id) => ({ id, capacity: 30, gapMs: 2 * MIN, k: 1, healthy: true, resetZone: "Europe/London" })) },
});
// Omar's mobile is refused as invalid by the SMS provider.
h.sms.invalid.add("+447700900104");

const { campaign } = await h.createCampaign("Scenario: physio, email and texts", {
  businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })],
  people: [
    person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", dial_phone: "+447700900101", dial_phone_type: "mobile" }),
    person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", email: "nia@harbour.example", dial_phone: "+447700900102", dial_phone_type: "mobile" }),
    person({ person_id: "p3", business_id: "b1", full_name: "Sam Lee", email: "sam@harbour.example" }),
    person({ person_id: "p4", business_id: "b1", full_name: "Omar Reed", email: "omar@harbour.example", dial_phone: "+447700900104", dial_phone_type: "mobile" }),
  ],
});

const weekdays = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
const email = (id: string, waitDays: number, body: string): StepDefinition => ({ id, waitDays, subject: waitDays === 0 ? "Hello {{first_name|there}}" : "", body, threading: waitDays === 0 ? "new_subject" : "continue_thread", removed: false });
const text = (id: string, waitDays: number, body: string): StepDefinition => ({ id, waitDays, subject: "", body, threading: "new_subject", removed: false });
const definition: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["inbox-a"],
  smsPool: [N1, N2],
  tracks: [
    // Email and the first SMS track start together; the follow-up SMS track starts two days after the email track has finished.
    { id: "email", channel: "email", branch: "main", window: weekdays, steps: [email("e1", 0, "A note for {{company}}."), email("e2", 2, "Following up, {{first_name|there}}.")], start: { kind: "entry" }, removed: false },
    { id: "sms", channel: "sms", branch: "main", window: weekdays, steps: [text("t1", 0, "Hi {{first_name|there}}, a quick text from {{company}}.")], start: { kind: "entry" }, removed: false },
    { id: "sms-after", channel: "sms", branch: "main", window: weekdays, steps: [text("t2", 0, "Last text from us, {{first_name|there}}.")], start: { kind: "after", trackId: "email", delayDays: 2 }, removed: false },
    // An email one day after the first SMS track, whether it completed, was skipped (no mobile) or failed (invalid number).
    { id: "nudge", channel: "email", branch: "main", window: weekdays, steps: [email("e3", 0, "Did my text reach you, {{first_name|there}}?")], start: { kind: "after", trackId: "sms", delayDays: 1 }, removed: false },
  ],
};
await h.tick(); // the engine reads both providers' sender accounts
const sms = (await h.request<SmsProviderStatus>("GET", "/api/sms-provider")).body;
log(`SMS provider: ${sms.provider} (${sms.message}) numbers: ${sms.numbers.map((n) => n.label).join(", ")}`);
const view = await h.defineSequence(campaign.id, definition);
log("Sequence: email [e1; e2 after 2 days] together with sms [t1]; sms-after [t2] 2 days after email finishes; nudge [e3] 1 day after sms finishes. Mon-Fri 09:00-17:00 prospect time.");
log(`Launch blockers: ${view.launch.blockers.length === 0 ? "none" : view.launch.blockers.map((b) => b.message).join("; ")}`);

h.clock = Date.parse("2026-11-02T09:00:00Z");
log(`${at(h.clock)}  launch -> HTTP ${(await h.launch(campaign.id)).status}`);
const leads = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows;
const enrollment = (name: string) => leads.find((r) => r.name === name)?.enrollments[0]?.id ?? "";
const names = ["Pat Oneil", "Nia Cole", "Sam Lee", "Omar Reed"];

await h.advanceTo(Date.parse("2026-11-02T13:00:00Z"));
log(`${at(h.clock)}  Nia texts back "STOP" to the number that texted her`);
h.sms.prospectTexts("+447700900102", "STOP");
await h.advanceTo(start + 14 * DAY);

const nameOf = (id: string) => names.find((n) => enrollment(n) === id) ?? id;
log("");
log("Fake email provider's delivery log:");
for (const d of h.fake.deliveryLog) log(`  ${at(d.at)}  ${d.stepId}  ${nameOf(d.subjectId).padEnd(10)} from ${d.sender}  "${d.rendered.body}"`);
log("Fake SMS provider's delivery log:");
for (const d of h.sms.deliveryLog) log(`  ${at(d.at)}  ${d.stepId}  ${nameOf(d.subjectId).padEnd(10)} from ${d.sender} to ${d.destination}  "${d.rendered.body}"`);
log(`Fake SMS provider's refusals: ${h.sms.refusals.map((r) => `${r.destination} (${r.reason})`).join(", ") || "none"}`);

log("");
log("Final state per lead (GET /api/enrollments/:id):");
for (const name of names) {
  const p = (await h.request<EnrollmentProgress>("GET", `/api/enrollments/${enrollment(name)}`)).body;
  const reply = p.reply ? ` reply on ${p.reply.channel} at ${at(Date.parse(p.reply.at))}` : "";
  const tracks = p.tracks.map((t) => `${t.trackId}:${t.started ? (t.finishReason ?? "running") : "not started"}`).join(" ");
  log(`  ${name.padEnd(10)} status=${p.status}${reply}; sms sender ${p.smsSender ?? "none"}; ${tracks}`);
}
const attention = (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body;
log("");
log(`Needs attention: sender problems ${attention.senderProblems.length}, held tracks ${attention.heldTracks.length}`);
log(`Provider calls: email ${h.fake.handoverLog.length}, SMS ${h.sms.handoverLog.length}; engine ticks: ${h.ticks}`);
await h.store.close();
