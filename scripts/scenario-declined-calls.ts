/**
 * A scripted run of ticket 16's demonstration (declined calls: stop, continue on the other channels, or the
 * campaign's win-back branch), through the real HTTP app and an in-memory SQLite store, against the fake email
 * provider, with time advanced by the script. The user dials on their own phone: the application never dials,
 * has no telephony provider, and the script only logs the outcomes a user would log. Fictitious data only.
 *
 *   node --import ./src/server/quiet-sqlite-warning.ts scripts/scenario-declined-calls.ts
 *
 * It shows all three paths and an override for one lead; win back replacing the lead's remaining main-sequence
 * work with the branch's own emails; no call made again, the later phone track included; and a reply during
 * win-back stopping the lead in this campaign while a colleague runs on.
 */
import type { CampaignDefinition, StepDefinition } from "../src/domain/sequence/definition.ts";
import type { ActivityView, CallTaskView, EnrollmentProgress, LeadSearchResult } from "../src/shared/api.ts";
import { EngineHarness } from "../test/support/engine-harness.ts";
import { business, person } from "../test/support/export-builder.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const at = (t: number) => new Date(t).toISOString().replace(":00.000Z", "Z");
const log = (line: string) => console.info(line);

const h = new EngineHarness({
  start: Date.parse("2026-11-02T07:00:00Z"), // Monday, London
  accounts: [{ id: "inbox-a", capacity: 30, gapMs: 2 * MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
});
await h.tick();
await h.request("PUT", "/api/call-settings", { dailyCapacity: 10, userZone: "Europe/London" });

const people = [
  ["p1", "Pat Oneil", "Clinic owner", "pat@harbour.example", "+442079460111"],
  ["p2", "Nia Cole", "Practice manager", "nia@harbour.example", "+442079460112"],
  ["p3", "Omar Reed", "Director", "omar@harbour.example", "+442079460113"],
  ["p4", "Sam Lee", "Physiotherapist", "sam@harbour.example", "+442079460114"],
] as const;
const { campaign } = await h.createCampaign("Scenario: declined calls", {
  businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })],
  people: people.map(([person_id, full_name, title, email, direct_phone]) => person({ person_id, business_id: "b1", full_name, title, email, direct_phone })),
});

const weekdays = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
const always = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const email = (id: string, waitDays: number, subject: string, body: string): StepDefinition => ({ id, waitDays, subject, body, threading: "new_subject", removed: false });
const call = (id: string): StepDefinition => ({ id, waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false });
const definition: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["inbox-a"],
  smsPool: [],
  callScript: "Introduce yourself, ask who looks after new patient bookings, offer a ten-minute demo.",
  tracks: [
    { id: "phone", channel: "call", branch: "main", window: weekdays, steps: [call("c1")], start: { kind: "entry" }, removed: false, declinedPath: "win_back" },
    { id: "intro", channel: "email", branch: "main", window: always, steps: [email("e1", 0, "Hello {{first_name|there}}", "A note for {{company}}."), email("e2", 3, "Checking in", "Following up, {{first_name|there}}.")], start: { kind: "entry" }, removed: false },
    { id: "after-call", channel: "email", branch: "main", window: always, steps: [email("f1", 0, "After our call", "Following up on my call, {{first_name|there}}.")], start: { kind: "after", trackId: "phone", delayDays: 1 }, removed: false },
    { id: "second-call", channel: "call", branch: "main", window: weekdays, steps: [call("c2")], start: { kind: "after", trackId: "phone", delayDays: 2 }, removed: false, declinedPath: "stop" },
    // The win-back branch: its own copy, no call.
    { id: "wb-1", channel: "email", branch: "win_back", window: always, steps: [email("w1", 0, "No pressure", "Understood, {{first_name|there}}. One resource you may find useful.")], start: { kind: "entry" }, removed: false },
    { id: "wb-2", channel: "email", branch: "win_back", window: always, steps: [email("w2", 0, "A last note", "If anything changes at {{company}}, I'm here.")], start: { kind: "after", trackId: "wb-1", delayDays: 5 }, removed: false },
  ],
};
log("Main sequence: a phone track [one call, Mon-Fri 09:00-17:00, declined path: win back]; intro emails [e1; e2 3 days later] beside it; an after-call email [f1] 1 day after the phone track; a second phone track 2 days after it [declined path: stop].");
log("Win-back branch: wb-1 [w1 at once], then wb-2 [w2] 5 days after wb-1. No call in it.");
const saved = await h.request("PUT", `/api/campaigns/${campaign.id}/sequence`, definition);
log(`PUT /sequence -> HTTP ${saved.status}`);
const refused = await h.request<{ error: { message: string } }>("PUT", `/api/campaigns/${campaign.id}/sequence`, { ...definition, tracks: [...definition.tracks, { ...definition.tracks[0], id: "wb-call", branch: "win_back", steps: [call("c9")] }] });
log(`A phone track in the win-back branch -> HTTP ${refused.status}: ${refused.body.error.message}`);

h.clock = Date.parse("2026-11-02T09:00:00Z");
log(`${at(h.clock)}  launch -> HTTP ${(await h.launch(campaign.id)).status}`);
const leads = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows;
const id = (who: string) => leads.find((r) => r.name === who)?.enrollments[0]?.id ?? "";
const progress = async (who: string) => (await h.request<EnrollmentProgress>("GET", `/api/enrollments/${id(who)}`)).body;
const show = async (who: string) => {
  const p = await progress(who);
  const tracks = p.tracks.map((t) => `${t.trackId}${t.branch === "win_back" ? " (win-back)" : ""} ${t.finishReason ?? (t.started ? "running" : "not started")}`).join(", ");
  log(`${at(h.clock)}  ${who}: ${p.status}; branch ${p.branch}${p.declined ? `; declined on ${p.declined.trackId}, path ${p.declined.path}` : ""}. Tracks: ${tracks}`);
};
const sent = (who: string) => {
  const to = people.find((p) => p[1] === who)?.[3];
  log(`${at(h.clock)}  ${who}'s emails sent: ${h.fake.deliveryLog.filter((d) => d.destination === to).map((d) => `${d.stepId} ${at(d.at)}`).join(", ") || "none"}`);
};
let actions = 0;
const decline = async (who: string, override: "stop" | "continue" | "win_back" | null) => {
  const taskId = (await progress(who)).tracks.find((t) => t.trackId === "phone")?.callTask?.taskId ?? "";
  const view = (await h.request<CallTaskView>("GET", `/api/call-tasks/${taskId}`)).body;
  const number = view.numbers.find((n) => n.kind === "direct");
  log(`${at(h.clock)}  ${who}'s call offers ${view.outcomes.join(", ")}; preselected declined path ${view.declinedPath} of ${view.declinedPaths.join(", ")}`);
  const res = await h.request<{ error?: { message: string } }>("POST", `/api/call-tasks/${taskId}/outcome`, { requestId: `scenario-${++actions}`, outcome: "not_interested", numberId: number?.detailId, note: "Not interested this year.", ...(override ? { declinedPath: override } : {}) });
  log(`${at(h.clock)}  ${who}: not interested${override ? `, overridden to ${override}` : ", path as preselected"} -> HTTP ${res.status}${res.body.error ? ` ${res.body.error.message}` : ""}`);
};

await h.advanceTo(Date.parse("2026-11-02T10:00:00Z"));
await decline("Pat Oneil", null);
await decline("Nia Cole", "continue");
await decline("Omar Reed", "stop");
for (const who of ["Pat Oneil", "Nia Cole", "Omar Reed", "Sam Lee"]) await show(who);

await h.advanceTo(Date.parse("2026-11-02T11:00:00Z"));
log("Pat replies to the win-back email:");
log(`${at(h.clock)}  reply from pat@harbour.example -> ${h.fake.prospectReplies("pat@harbour.example") ? "received" : "no thread"}`);

await h.advanceTo(Date.parse("2026-11-02T09:00:00Z") + 10 * DAY);
log("Ten days on:");
for (const who of ["Pat Oneil", "Nia Cole", "Omar Reed", "Sam Lee"]) {
  await show(who);
  sent(who);
}
const calls = (who: string) => p(who).then((x) => x.tracks.filter((t) => t.callTask !== null).map((t) => t.trackId).join(", ") || "none");
const p = progress;
for (const who of ["Pat Oneil", "Nia Cole", "Omar Reed", "Sam Lee"]) log(`${at(h.clock)}  ${who}'s phone tracks with a call placed: ${await calls(who)}`);
const pat = (await h.request<LeadSearchResult>("GET", "/api/leads?q=Pat")).body.rows[0];
const activity = (await h.request<ActivityView>("GET", `/api/people/${pat?.id ?? ""}/activity`)).body;
log(`${at(h.clock)}  Pat's Activity declines: ${JSON.stringify(activity.declines)}`);
await h.store.close();
