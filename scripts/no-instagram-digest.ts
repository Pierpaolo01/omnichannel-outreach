/**
 * Nothing changes for email, SMS, calls or LinkedIn (ADR 0004 13.10, ticket 25): one scripted campaign of email, SMS, phone and
 * LinkedIn tracks with no Instagram track, run through the real HTTP app and an in-memory SQLite store against the fake email
 * and SMS providers and the simulated LinkedIn provider. It uses only what the integration tip before ticket 25 already has,
 * so it runs unchanged on both. It prints the providers' handover and delivery logs (LinkedIn's acceptances and withdrawals
 * too) and each day's call list, and a SHA-256 digest of all of them. Run it on the integration tip and on the ticket's
 * branch: the digests must be equal. The earlier `no-social-digest.ts` (no LinkedIn track) is kept as it was.
 * with time advanced by the script and call outcomes logged as a user would. It prints the providers' handover and
 * delivery logs and each day's call list, and a SHA-256 digest of all of them. Run it on the integration tip and on the
 * ticket's branch: the digests must be equal. Fictitious data only; nothing leaves the machine.
 *
 *   node --import ./src/server/quiet-sqlite-warning.ts scripts/no-instagram-digest.ts
 *
 * With `DIGEST_WITH_INSTAGRAM=1` (ticket 26, ADR 0004 14.8) the same campaign also has an Instagram track on a simulated
 * session, and the digest adds its handovers and deliveries: nothing changes for Instagram either when Facebook is added.
 * That form runs on the integration tip of ticket 25 and on later branches alike: it gives the harness its simulated
 * Instagram provider by both the option the tip reads (`instagram`) and the one later code reads (`social`), and reads the
 * provider back by whichever the harness has. Without the variable the script is what it was.
 */
import { createHash } from "node:crypto";
import type { FakeSocialPort } from "../test/support/fake-social-port.ts";
import type { CampaignDefinition, StepDefinition } from "../src/domain/sequence/definition.ts";
import type { CallsView, CallTaskView } from "../src/shared/api.ts";
import { EngineHarness } from "../test/support/engine-harness.ts";
import { business, person } from "../test/support/export-builder.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const withInstagram = process.env["DIGEST_WITH_INSTAGRAM"] === "1";
const igSessions = [{ id: "ig-digest", kind: "business" as const, gapMs: 4 * MIN, k: 1, healthy: true, resetZone: "Europe/London" }];
/** The simulated Instagram provider, by the option either harness reads: an object the harness's type does not list. */
const igOption: object = withInstagram ? { instagram: { sessions: igSessions }, social: { instagram: { sessions: igSessions } } } : {};
const h = new EngineHarness({
  ...igOption,
  start: Date.parse("2026-11-02T07:00:00Z"),
  accounts: [{ id: "inbox-a", capacity: 30, gapMs: 2 * MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
  sms: { numbers: [{ id: "+447700900001", capacity: 20, gapMs: 3 * MIN, k: 1, healthy: true, resetZone: "Europe/London" }] },
  linkedin: { sessions: [{ id: "li-digest", gapMs: 4 * MIN, k: 1, healthy: true, resetZone: "Europe/London" }] },
});
await h.tick();
await h.request("PUT", "/api/sender-accounts/linkedin:li-digest/allowances", { invitesPerDay: 2, messagesPerDay: 3, notesPerMonth: 2 });
await h.request("PUT", "/api/call-settings", { dailyCapacity: 2, userZone: "Europe/London" });
const loose = h as unknown as { social?: (channel: string) => FakeSocialPort; instagram?: FakeSocialPort };
const ig: FakeSocialPort | null = !withInstagram ? null : typeof loose.social === "function" ? loose.social("instagram") : (loose.instagram ?? null);
if (withInstagram) await h.request("PUT", "/api/sender-accounts/instagram:ig-digest/allowances", { invitesPerDay: 0, messagesPerDay: 3, notesPerMonth: 0 });
/** An Instagram cell, only in the Instagram form: without it every row is what it was. */
const igCell = (name: string): Record<string, string> => (withInstagram ? { instagram: `https://www.instagram.com/example_digest_${name}` } : {});
const { campaign } = await h.createCampaign("Digest", {
  businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101", ...igCell("harbour") })],
  people: [
    person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", dial_phone: "+447700900101", dial_phone_type: "mobile", linkedin_url: "https://www.linkedin.com/in/fictional-digest-pat", ...igCell("pat") }),
    person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", email: "nia@harbour.example", direct_phone: "+442079460111", linkedin_url: "https://www.linkedin.com/in/fictional-digest-nia" }),
    person({ person_id: "p3", business_id: "b1", full_name: "Sam Lee", dial_phone: "+447700900103", dial_phone_type: "mobile", timezone: "America/New_York", linkedin_url: "https://www.linkedin.com/in/fictional-digest-sam" }),
    person({ person_id: "p4", business_id: "b1", full_name: "Omar Reed", email: "omar@harbour.example" }),
  ],
});
const weekdays = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
const email = (id: string, waitDays: number): StepDefinition => ({ id, waitDays, subject: waitDays === 0 ? "Hello {{first_name|there}}" : "", body: `Email ${id} for {{company}}.`, threading: waitDays === 0 ? "new_subject" : "continue_thread", removed: false });
const text = (id: string, waitDays: number): StepDefinition => ({ id, waitDays, subject: "", body: `Text ${id}, {{first_name|there}}.`, threading: "new_subject", removed: false });
const definition: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["inbox-a"],
  smsPool: ["+447700900001"],
  linkedinPool: ["linkedin:li-digest"],
  callScript: "Ask who looks after bookings.",
  tracks: [
    { id: "e", channel: "email", branch: "main", window: weekdays, steps: [email("e1", 0), email("e2", 2)], start: { kind: "entry" }, removed: false },
    { id: "s", channel: "sms", branch: "main", window: weekdays, steps: [text("t1", 0), text("t2", 1)], start: { kind: "after", trackId: "e", delayDays: 1 }, removed: false },
    { id: "c", channel: "call", branch: "main", window: weekdays, steps: [{ id: "c1", waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false }], start: { kind: "entry" }, removed: false },
    { id: "l", channel: "linkedin", branch: "main", window: weekdays, steps: [text("i1", 0), text("l1", 0), text("l2", 2)], start: { kind: "entry" }, removed: false, acceptWaitDays: 3 },
    ...(withInstagram ? [{ id: "ig", channel: "instagram" as const, branch: "main" as const, window: weekdays, steps: [text("m1", 0), text("m2", 2)], start: { kind: "after" as const, trackId: "e", delayDays: 0 }, removed: false, senders: ["instagram:ig-digest"] }] : []),
  ],
};
// Pat accepts a day later, Nia never (the invite is withdrawn after three days), Sam was already connected.
h.linkedin.profiles.set("https://www.linkedin.com/in/fictional-digest-pat", { acceptAfterMs: DAY });
h.linkedin.profiles.set("https://www.linkedin.com/in/fictional-digest-sam", { connected: true });
await h.defineSequence(campaign.id, definition);
h.clock = Date.parse("2026-11-02T08:00:00Z");
await h.launch(campaign.id);

const lists: unknown[] = [];
const outcomes: unknown[] = [];
let requestNo = 0;
for (let day = 0; day < 10; day++) {
  await h.advanceTo(Date.parse("2026-11-02T10:00:00Z") + day * DAY);
  const calls = (await h.request<CallsView>("GET", "/api/calls")).body;
  lists.push({ day, ready: calls.readyNow.map((c) => c.taskId), placedToday: calls.placedToday, committed: calls.committed });
  // The user works the first call each day: no answer, then a redial on odd days.
  const first = calls.readyNow[0];
  if (first) {
    const task = (await h.request<CallTaskView>("GET", `/api/call-tasks/${first.taskId}`)).body;
    const logged = await h.request("POST", `/api/call-tasks/${first.taskId}/outcome`, { requestId: `digest-${++requestNo}`, outcome: "no_answer", ...(day % 2 === 1 ? { redial: true } : {}), numberId: task.numbers[0]?.detailId });
    outcomes.push({ day, logged: logged.status });
  }
}
await h.advanceTo(Date.parse("2026-11-20T10:00:00Z"));

const strip = <T extends object>(entries: readonly T[]) => entries.map((e) => JSON.parse(JSON.stringify(e)) as unknown);
const record = {
  emailHandovers: strip(h.fake.handoverLog),
  emailDeliveries: strip(h.fake.deliveryLog),
  smsHandovers: strip(h.sms.handoverLog),
  smsDeliveries: strip(h.sms.deliveryLog),
  linkedinHandovers: strip(h.linkedin.handoverLog),
  linkedinDeliveries: strip(h.linkedin.deliveryLog),
  linkedinAcceptances: strip(h.linkedin.acceptanceLog),
  linkedinWithdrawals: strip(h.linkedin.withdrawalLog),
  callLists: lists,
  outcomes,
  ...(ig ? { instagramHandovers: strip(ig.handoverLog), instagramDeliveries: strip(ig.deliveryLog) } : {}),
};
const text_ = JSON.stringify(record);
console.info(
  `email handovers ${h.fake.handoverLog.length}, deliveries ${h.fake.deliveryLog.length}; SMS handovers ${h.sms.handoverLog.length}, deliveries ${h.sms.deliveryLog.length}; ` +
    `LinkedIn handovers ${h.linkedin.handoverLog.length}, deliveries ${h.linkedin.deliveryLog.length}, acceptances ${h.linkedin.acceptanceLog.length}, withdrawals ${h.linkedin.withdrawalLog.length}; call lists ${lists.length} (one a day), outcomes logged ${outcomes.length}` +
    (ig ? `; Instagram handovers ${ig.handoverLog.length}, deliveries ${ig.deliveryLog.length}` : ""),
);
console.info(`digest ${createHash("sha256").update(text_).digest("hex")}`);
