/**
 * A scripted run of ticket 19's demonstration (editing a running campaign), through the real HTTP app and an in-memory
 * SQLite store, against the fake email provider and, for the push of changed copy, the fake Instantly service shaped
 * from the documented API. No real provider is called. Fictitious data only.
 *
 *   node --import ./src/server/quiet-sqlite-warning.ts scripts/scenario-running-edits.ts
 *
 * Three leads stand before, inside and past the affected step; a step is removed, the copy of the next one changed and
 * a step added; the read says what that does to each before it is applied; a paused campaign takes an edit that its
 * leads follow on resume; an edit the save must refuse changes nothing; and changed email copy reaches the fake
 * Instantly with the next lead handed over, overwriting a direct edit made there.
 */
import type { CampaignDefinition, StepDefinition } from "../src/domain/sequence/definition.ts";
import type { EditImpactView, EnrollmentProgress, LeadSearchResult } from "../src/shared/api.ts";
import { InstantlyClient } from "../src/server/instantly/client.ts";
import { InstantlyEmailPort } from "../src/server/instantly/port.ts";
import { EngineHarness, type Provider } from "../test/support/engine-harness.ts";
import { business, person } from "../test/support/export-builder.ts";
import { FakeInstantly } from "../test/support/fake-instantly.ts";

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const at = (t: number) => new Date(t).toISOString().replace(":00.000Z", "Z");
const log = (line: string) => console.info(line);
const always = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const email = (id: string, waitDays: number, body: string): StepDefinition => ({ id, waitDays, subject: `Evening bookings (${id})`, body, threading: "new_subject", removed: false });
const def = (steps: StepDefinition[], emailPool = ["inbox-a"]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool, smsPool: [], callScript: "", tracks: [{ id: "email", channel: "email", branch: "main", window: always, steps, start: { kind: "entry" }, removed: false }] });
const S1 = email("s1", 0, "Hi {{first_name|there}}, booking at {{company}} stops at 18:00.");
const S2 = email("s2", 2, "A quick follow-up for {{company}}.");
const S3 = email("s3", 3, "Last note on evening booking at {{company}}.");

async function call<T>(h: EngineHarness, method: string, path: string, body?: unknown): Promise<T> {
  const res = await h.request<T>(method, path, body);
  log(`${method} ${path}${body !== undefined && method !== "GET" ? ` ${JSON.stringify(body).slice(0, 160)}${JSON.stringify(body).length > 160 ? "…" : ""}` : ""}\n  -> ${res.status} ${JSON.stringify(res.body).slice(0, 400)}`);
  return res.body;
}

// --- Part 1: leads before, inside and past the affected step. ---
const h = new EngineHarness({ start: Date.parse("2026-11-02T08:00:00Z"), accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
await h.tick();
const { campaign } = await h.createCampaign("Scenario: running edits", {
  businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })],
  people: [
    person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example" }),
    person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", email: "nia@harbour.example" }),
    person({ person_id: "p3", business_id: "b1", full_name: "Omar Reed", email: "omar@harbour.example" }),
  ],
});
await h.defineSequence(campaign.id, def([S1, S2, S3]));
log(`\n## ${at(h.clock)}: launch three emails (s2 two days after s1, s3 three days after s2)`);
await call(h, "POST", `/api/campaigns/${campaign.id}/launch`);
await h.advanceTo(h.clock + H);
// Omar replies at once: he is past everything.
h.fake.prospectReplies("omar@harbour.example");
// Lena is enrolled by a re-import after launch: she gets Email 1 then, so she is before Email 2 when the user edits.
await h.advanceTo(Date.parse("2026-11-03T12:00:00Z"));
await h.reimport(campaign.id, {
  businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })],
  people: [person({ person_id: "p7", business_id: "b1", full_name: "Lena Park", email: "lena@harbour.example" })],
});
await h.advanceTo(Date.parse("2026-11-04T01:00:00Z"));
const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows;
const lead = (name: string) => rows.find((r) => r.name === name)?.enrollments.find((e) => e.campaign.id === campaign.id)?.id ?? "";
const sent = (id: string) => h.fake.deliveryLog.filter((d) => d.subjectId === id).map((d) => `${d.stepId}@${at(d.at)}`);
const NAMES = ["Lena Park", "Pat Oneil", "Nia Cole", "Omar Reed"];
for (const name of NAMES) log(`${name}: sent ${JSON.stringify(sent(lead(name)))}, status ${(await h.progress(lead(name))).status}`);

log(`\n## ${at(h.clock)}: Lena is before Email 2, Pat and Nia are past it and before Email 3, Omar is past everything. The draft changes Email 2's copy, removes Email 3 and adds Email 4`);
const S4 = email("s4", 1, "One more idea for {{company}}: a waiting list for the evening slots.");
const draft = def([S1, { ...S2, body: "A changed follow-up for {{company}}." }, { ...S3, removed: true }, S4]);
await call<EditImpactView>(h, "POST", `/api/campaigns/${campaign.id}/sequence/impact`, { definition: draft });
await call(h, "PUT", `/api/campaigns/${campaign.id}/sequence`, draft);
await h.advanceTo(Date.parse("2026-11-10T00:00:00Z"));
for (const name of NAMES) {
  const p = await h.progress(lead(name));
  log(`${name}: sent ${JSON.stringify(sent(lead(name)))}, status ${p.status}; tracks ${JSON.stringify(p.tracks.map((t) => [t.trackId, t.finishReason]))}`);
}

log(`\n## an edit the save must refuse changes nothing`);
await call(h, "PUT", `/api/campaigns/${campaign.id}/sequence`, def([S1, S2]));
await call(h, "PUT", `/api/campaigns/${campaign.id}/sequence`, def([S1, { ...S2, body: "" }, { ...S3, removed: true }, S4]));

// --- Part 2: a paused campaign. ---
log(`\n## a paused campaign: edited while paused, followed on resume`);
const { campaign: paused } = await h.createCampaign("Scenario: paused edits", { businesses: [business({ business_id: "b2", business_name: "Quay Street Dental", phone_e164: "+442079460201" })], people: [person({ person_id: "p4", business_id: "b2", full_name: "Sam Lee", email: "sam@quay.example" })] });
await h.defineSequence(paused.id, def([S1, S2, S3]));
await call(h, "POST", `/api/campaigns/${paused.id}/launch`);
await h.advanceTo(h.clock + H);
const sam = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${paused.id}`)).body.rows[0]?.enrollments.find((e) => e.campaign.id === paused.id)?.id ?? "";
await call(h, "POST", `/api/campaigns/${paused.id}/pause`, { requestId: "scenario-pause" });
await call(h, "PUT", `/api/campaigns/${paused.id}/sequence`, def([S1, { ...S2, waitDays: 1 }, S3]));
log(`Sam's next step while paused: ${JSON.stringify((await call<EnrollmentProgress>(h, "GET", `/api/enrollments/${sam}`)).tracks[0]?.nextStep)}`);
await h.advanceTo(h.clock + 2 * DAY);
await call(h, "POST", `/api/campaigns/${paused.id}/resume`, { requestId: "scenario-resume" });
log(`Sam's next step after the resume (the one-day wait, moved by the two days paused): ${JSON.stringify((await h.progress(sam)).tracks[0]?.nextStep)}`);
await h.advanceTo(h.clock + 2 * DAY);
log(`Sam: sent ${JSON.stringify(sent(sam))}`);

// --- Part 3: the push to the fake Instantly. ---
log(`\n## changed copy reaches the fake Instantly with the next lead handed over (no real Instantly request)`);
const built: { fake?: FakeInstantly } = {};
const ih = new EngineHarness({
  start: Date.parse("2026-11-16T08:00:00Z"),
  accounts: [],
  port: (store, now) => {
    const fake = new FakeInstantly({ now, accounts: [{ email: "ada@sender.example", status: 1, daily_limit: 30 }] });
    const client = new InstantlyClient({ apiKey: "test-key-not-real", fetch: fake.fetch, writes: true, now, timeoutMs: 10_000 });
    const port = new InstantlyEmailPort({ client, store: store.instantly, now, config: { resetZone: "UTC", pollIntervalMs: 0, freshnessMs: 30 * DAY } });
    built.fake = fake;
    return Object.assign(port, { advance: () => fake.advance(), nextActivityAt: () => fake.nextActivityAt() }) satisfies Provider;
  },
});
const fake = built.fake!;
await ih.tick();
const { campaign: pushed } = await ih.createCampaign("Scenario: Instantly push", { businesses: [business({ business_id: "b3", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })], people: [person({ person_id: "p5", business_id: "b3", full_name: "Pat Oneil", email: "pat@harbour.example" }), person({ person_id: "p6", business_id: "b3", full_name: "Nia Cole", email: "nia@harbour.example" })] });
await ih.tick();
await ih.defineSequence(pushed.id, def([S1, S2], ["ada@sender.example"]));
await ih.tick();
await call(ih, "POST", `/api/campaigns/${pushed.id}/launch`);
const dispatch = fake.campaigns[0]!;
log(`dispatch campaign ${dispatch.name}; template ${JSON.stringify(dispatch.settings.sequences)}`);
fake.editDirectly(dispatch.id, { sequences: [{ steps: [{ type: "email", delay: 0, delay_unit: "minutes", variants: [{ subject: "Edited in Instantly", body: "Edited in Instantly" }] }] }] });
log(`someone edits the template in Instantly: ${JSON.stringify(dispatch.settings.sequences)}`);
await call(ih, "PUT", `/api/campaigns/${pushed.id}/sequence`, def([{ ...S1, body: "A changed note for {{company}}." }, S2], ["ada@sender.example"]));
await ih.advanceTo(ih.clock + 2 * H);
for (const w of fake.writes()) log(`fake Instantly ${w.method} ${w.path} ${JSON.stringify(w.body).slice(0, 220)}`);
for (const d of fake.deliveries()) log(`delivered from ${d.inbox} to ${d.to}: ${JSON.stringify(d.body)}`);
log(`template after the next handover: ${JSON.stringify(dispatch.settings.sequences)}`);
