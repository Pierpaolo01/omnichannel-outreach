/**
 * Nothing changes for email, SMS or calls (ADR 0004 10.5): one scripted campaign of email, SMS and phone tracks with no
 * LinkedIn track, run through the real HTTP app and an in-memory SQLite store against the fake email and SMS providers,
 * with time advanced by the script and call outcomes logged as a user would. It prints the providers' handover and
 * delivery logs and each day's call list, and a SHA-256 digest of all of them. Run it on the integration tip and on the
 * ticket's branch: the digests must be equal. Fictitious data only; nothing leaves the machine.
 *
 *   node --import ./src/server/quiet-sqlite-warning.ts scripts/no-social-digest.ts
 */
import { createHash } from "node:crypto";
import type { CampaignDefinition, StepDefinition } from "../src/domain/sequence/definition.ts";
import type { CallsView, CallTaskView } from "../src/shared/api.ts";
import { EngineHarness } from "../test/support/engine-harness.ts";
import { business, person } from "../test/support/export-builder.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const h = new EngineHarness({
  start: Date.parse("2026-11-02T07:00:00Z"),
  accounts: [{ id: "inbox-a", capacity: 30, gapMs: 2 * MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
  sms: { numbers: [{ id: "+447700900001", capacity: 20, gapMs: 3 * MIN, k: 1, healthy: true, resetZone: "Europe/London" }] },
});
await h.tick();
await h.request("PUT", "/api/call-settings", { dailyCapacity: 2, userZone: "Europe/London" });
const { campaign } = await h.createCampaign("Digest", {
  businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })],
  people: [
    person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", dial_phone: "+447700900101", dial_phone_type: "mobile" }),
    person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", email: "nia@harbour.example", direct_phone: "+442079460111" }),
    person({ person_id: "p3", business_id: "b1", full_name: "Sam Lee", dial_phone: "+447700900103", dial_phone_type: "mobile", timezone: "America/New_York" }),
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
  callScript: "Ask who looks after bookings.",
  tracks: [
    { id: "e", channel: "email", branch: "main", window: weekdays, steps: [email("e1", 0), email("e2", 2)], start: { kind: "entry" }, removed: false },
    { id: "s", channel: "sms", branch: "main", window: weekdays, steps: [text("t1", 0), text("t2", 1)], start: { kind: "after", trackId: "e", delayDays: 1 }, removed: false },
    { id: "c", channel: "call", branch: "main", window: weekdays, steps: [{ id: "c1", waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false }], start: { kind: "entry" }, removed: false },
  ],
};
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
const record = { emailHandovers: strip(h.fake.handoverLog), emailDeliveries: strip(h.fake.deliveryLog), smsHandovers: strip(h.sms.handoverLog), smsDeliveries: strip(h.sms.deliveryLog), callLists: lists, outcomes };
const text_ = JSON.stringify(record);
console.info(`email handovers ${h.fake.handoverLog.length}, deliveries ${h.fake.deliveryLog.length}; SMS handovers ${h.sms.handoverLog.length}, deliveries ${h.sms.deliveryLog.length}; call lists ${lists.length} (one a day), outcomes logged ${outcomes.length}`);
console.info(`digest ${createHash("sha256").update(text_).digest("hex")}`);
