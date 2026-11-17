/**
 * Nothing changes for a LinkedIn track with the InMail fallback off (ticket 27, ADR 0004 14): one scripted campaign of a
 * LinkedIn track (no InMail step) and an email track after it, through the real HTTP app and an in-memory SQLite store
 * against the simulated LinkedIn provider and the fake email provider. Its people accept, never accept, accept late, are
 * already connected, or cannot be reached; a withdrawal answers unknown once; one removes the connection while an invitation
 * to them is pending, so the session answers "pending" at their follow-up's check. It prints the providers' logs and their
 * SHA-256 digest. Run it on the integration tip and on the ticket's branch: the digests must be equal. Its sessions report
 * nothing about InMail (the tip's simulated provider has no such report). Fictitious data only; nothing leaves the machine.
 *
 *   node --import ./src/server/quiet-sqlite-warning.ts scripts/no-inmail-digest.ts
 */
import { createHash } from "node:crypto";
import type { CampaignDefinition, StepDefinition } from "../src/domain/sequence/definition.ts";
import { linkedinAccountId } from "../src/server/engine/ports.ts";
import { EngineHarness } from "../test/support/engine-harness.ts";
import { business, person } from "../test/support/export-builder.ts";

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const profile = (slug: string) => `https://www.linkedin.com/in/fictional-${slug}`;
const h = new EngineHarness({
  start: Date.parse("2026-11-02T07:00:00Z"),
  accounts: [{ id: "inbox-a", capacity: 30, gapMs: 2 * MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
  linkedin: { sessions: [{ id: "li-a", gapMs: 5 * MIN, k: 1, healthy: true, resetZone: "Europe/London" }, { id: "li-b", gapMs: 5 * MIN, k: 1, healthy: true, resetZone: "Europe/London" }] },
});
await h.tick();
for (const s of ["li-a", "li-b"]) await h.request("PUT", `/api/sender-accounts/${linkedinAccountId(s)}/allowances`, { invitesPerDay: 3, messagesPerDay: 4, notesPerMonth: 2 });
h.linkedin.profiles.set(profile("pat"), { acceptAfterMs: 20 * H });
h.linkedin.profiles.set(profile("nia"), {});
h.linkedin.profiles.set(profile("sam"), { acceptAfterMs: 5 * DAY, acceptReportDelayMs: 2 * H });
h.linkedin.profiles.set(profile("omar"), { connected: true });
h.linkedin.profiles.set(profile("kim"), { unreachable: true });
h.linkedin.profiles.set(profile("ola"), { withdrawUnknown: 1 });
h.linkedin.profiles.set(profile("ray"), { acceptAfterMs: 2 * DAY + 3 * H });
const names = ["pat", "nia", "sam", "omar", "kim", "ola", "ray"];
const { campaign } = await h.createCampaign("Digest", {
  businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })],
  people: names.map((n, i) => person({ person_id: `p${i + 1}`, business_id: "b1", full_name: `${n[0]!.toUpperCase()}${n.slice(1)} Test`, email: `${n}@harbour.example`, linkedin_url: profile(n), ...(i % 3 === 2 ? { timezone: "America/New_York" } : {}) })),
});
const weekdays = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
const step = (id: string, waitDays: number, body: string): StepDefinition => ({ id, waitDays, subject: "", body, threading: "new_subject", removed: false });
const definition: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["inbox-a"],
  smsPool: [],
  linkedinPool: [linkedinAccountId("li-a"), linkedinAccountId("li-b")],
  tracks: [
    { id: "li", channel: "linkedin", branch: "main", window: weekdays, steps: [step("inv", 0, "Hello {{first_name|there}}."), step("m1", 0, "Thanks for connecting."), step("m2", 2, "Following up.")], start: { kind: "entry" }, removed: false, acceptWaitDays: 3 },
    { id: "e", channel: "email", branch: "main", window: weekdays, steps: [{ id: "e1", waitDays: 0, subject: "Hello {{first_name|there}}", body: "Email for {{company}}.", threading: "new_subject", removed: false }], start: { kind: "after", trackId: "li", delayDays: 1 }, removed: false },
  ],
};
await h.defineSequence(campaign.id, definition);
h.clock = Date.parse("2026-11-02T08:00:00Z");
await h.launch(campaign.id);
// Wednesday noon: Pat, connected since Tuesday, removes the connection while an invitation to them is pending from elsewhere,
// so the session answers "pending" at their follow-up's check (council on 8b0c846, item 3): the follow-up is not handed over.
await h.advanceTo(Date.parse("2026-11-04T12:00:00Z"));
h.linkedin.profiles.set(profile("pat"), { connectionRemoved: true, pendingElsewhere: true });
await h.advanceTo(Date.parse("2026-11-20T10:00:00Z"));

// The simulated provider's own ordering field (`seq`, which ticket 27 added to its logs) is the test double's, not anything a
// provider was asked or did, so it is left out: the tip's simulated provider has none.
const strip = <T extends object>(entries: readonly T[]) => entries.map((e) => JSON.parse(JSON.stringify(e, (k, v: unknown) => (k === "seq" ? undefined : v))) as unknown);
const li = h.linkedin;
const record = {
  linkedinHandovers: strip(li.handoverLog),
  linkedinDeliveries: strip(li.deliveryLog),
  acceptances: strip(li.acceptanceLog),
  withdrawals: strip(li.withdrawalLog),
  checks: strip(li.presendLog),
  refusals: strip(li.refusals),
  emailHandovers: strip(h.fake.handoverLog),
  emailDeliveries: strip(h.fake.deliveryLog),
};
console.info(`LinkedIn handovers ${li.handoverLog.length}, deliveries ${li.deliveryLog.length}, acceptances ${li.acceptanceLog.length}, withdrawals ${li.withdrawalLog.length}, checks ${li.presendLog.length}, refusals ${li.refusals.length}; email handovers ${h.fake.handoverLog.length}, deliveries ${h.fake.deliveryLog.length}`);
console.info(`digest ${createHash("sha256").update(JSON.stringify(record)).digest("hex")}`);
