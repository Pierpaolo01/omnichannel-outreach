/**
 * A scripted end-to-end run of the engine core (ticket 12b) through the real HTTP app and an
 * in-memory SQLite store, against the fake email provider, with time advanced by the script.
 * Fictitious data only; nothing reaches a real provider.
 *
 *   node --import ./src/server/quiet-sqlite-warning.ts scripts/scenario-engine-core.ts
 */
import type { CampaignDefinition } from "../src/domain/sequence/definition.ts";
import type { EnrollmentProgress, LeadSearchResult, PersonRecord } from "../src/shared/api.ts";
import { EngineHarness } from "../test/support/engine-harness.ts";
import { business, person } from "../test/support/export-builder.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const start = Date.parse("2026-11-02T08:00:00Z"); // Monday, London
const at = (t: number) => new Date(t).toISOString().replace(".000Z", "Z");
const log = (line: string) => console.info(line);

const h = new EngineHarness({
  start,
  accounts: [{ id: "inbox-a", capacity: 30, gapMs: 2 * 60_000, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
});
h.fake.bouncing.add("sam@harbour.example");

const { campaign } = await h.createCampaign("Scenario: autumn physio", {
  businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })],
  people: [
    person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example" }),
    person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", email: "nia@harbour.example" }),
    person({ person_id: "p3", business_id: "b1", full_name: "Sam Lee", email: "sam@harbour.example" }),
    person({ person_id: "p4", business_id: "b1", full_name: "Omar Reed", dial_phone: "+447700900104", dial_phone_type: "mobile" }),
  ],
});

const definition: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["inbox-a"],
  tracks: [
    {
      id: "t1",
      channel: "email",
      branch: "main",
      window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })),
      steps: [
        { id: "s1", waitDays: 0, subject: "Hello {{first_name|there}}", body: "A note for {{company}}.", threading: "new_subject", removed: false },
        { id: "s2", waitDays: 2, subject: "", body: "Following up, {{first_name|there}}.", threading: "continue_thread", removed: false },
        { id: "s3", waitDays: 3, subject: "", body: "One last note.", threading: "continue_thread", removed: false },
      ],
      start: { kind: "entry" },
      removed: false,
    },
  ],
};
await h.tick(); // the engine reads the provider's sender accounts
const view = await h.defineSequence(campaign.id, definition);
log(`Sequence saved: one email track, 3 steps (waits 0, 2, 3 days), Mon-Fri 09:00-17:00 prospect time.`);
log(`Launch blockers: ${view.launch.blockers.length === 0 ? "none" : view.launch.blockers.map((b) => b.message).join("; ")}`);

h.clock = Date.parse("2026-11-02T09:00:00Z");
const launched = await h.launch(campaign.id);
log(`${at(h.clock)}  launch -> HTTP ${launched.status}`);

const leads = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows;
const enrollment = (name: string) => leads.find((r) => r.name === name)?.enrollments[0]?.id ?? "";
const names = ["Pat Oneil", "Nia Cole", "Sam Lee", "Omar Reed"];

await h.advanceTo(Date.parse("2026-11-02T13:00:00Z"));
log(`${at(h.clock)}  Nia replies to her first email`);
h.fake.prospectReplies("nia@harbour.example");
await h.advanceTo(start + 14 * DAY);

log("");
log("Provider's delivery log (what the fake actually sent):");
for (const d of h.fake.deliveryLog) {
  const name = names.find((n) => enrollment(n) === d.subjectId) ?? d.subjectId;
  log(`  ${at(d.at)}  ${d.stepId}  ${name.padEnd(10)} from ${d.sender}  "${d.rendered.subject || "(same thread)"}" / "${d.rendered.body}"`);
}

log("");
log("Final state per lead (GET /api/enrollments/:id):");
for (const name of names) {
  const p = (await h.request<EnrollmentProgress>("GET", `/api/enrollments/${enrollment(name)}`)).body;
  const track = p.tracks[0];
  const steps = track ? track.steps.map((s) => `${s.stepId}:${s.result ?? "-"}`).join(" ") : "no track started";
  const reply = p.reply ? ` reply on ${p.reply.channel} at ${at(Date.parse(p.reply.at))}` : "";
  const trackState = !track?.started ? "never started" : (track.finishReason ?? "left unfinished");
  log(`  ${name.padEnd(10)} status=${p.status}${reply}; track ${trackState}; ${steps}`);
}

const sam = leads.find((r) => r.name === "Sam Lee");
const record = (await h.request<PersonRecord>("GET", `/api/people/${sam?.id ?? ""}`)).body;
log("");
log(`Sam Lee's address after the bounce: ${record.contactDetails.filter((d) => d.channel === "email").map((d) => `${d.value} bad=${d.bad}`).join(", ")}`);
log(`Provider calls: ${h.fake.handoverLog.length}, deliveries: ${h.fake.deliveryLog.length}, engine ticks: ${h.ticks}`);
await h.store.close();
