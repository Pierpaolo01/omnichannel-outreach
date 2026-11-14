import { expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition } from "../../domain/sequence/definition.ts";
import type { CallsView, EnrollmentRead, LeadSearchResult, NeedsAttention, TodayView } from "../../shared/api.ts";

/**
 * Ticket 20's demonstration, on the fake providers (no real provider is reached): an interruption with due email and
 * SMS, a paused enrollment and pending call tasks, across two campaigns sharing one inbox of capacity 4 a day. It checks
 * the timing, the statuses, that nothing is delivered twice and the inbox's capacity, and with DEMO_TRANSCRIPT=1 prints
 * the HTTP exchanges as the pull request's evidence. Every name, address and number is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
/** Monday 2 November 2026, 09:00 London (GMT). */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const WEEKDAYS_9_TO_17 = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
const N1 = "+447700900001";
const N2 = "+447700900002";

const email = (id: string, waitDays = 0): StepDefinition => ({ id, waitDays, subject: `Subject ${id}`, body: `Email ${id} for {{company}}.`, threading: "new_subject", removed: false });
const text = (id: string, waitDays = 0): StepDefinition => ({ ...email(id, waitDays), subject: "" });
const definition = (sms: string): CampaignDefinition => ({
  timezone: "Europe/London",
  callSkipLimitDays: 3,
  emailPool: ["inbox-a"],
  smsPool: [sms],
  callScript: "Ask who looks after new patient bookings.",
  tracks: [
    { id: "e1", channel: "email", branch: "main", window: ALWAYS, steps: [email("s1"), email("s2", 1)], start: { kind: "entry" }, removed: false },
    { id: "x1", channel: "sms", branch: "main", window: ALWAYS, steps: [text("t1"), text("t2", 1)], start: { kind: "entry" }, removed: false },
    { id: "p1", channel: "call", branch: "main", window: WEEKDAYS_9_TO_17, steps: [{ ...email("c1"), subject: "", body: "" }], start: { kind: "entry" }, removed: false },
  ],
});
const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });
const PEOPLE = [
  person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", dial_phone: "+447700900101", dial_phone_type: "mobile" }),
  person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", email: "nia@harbour.example", dial_phone: "+447700900102", dial_phone_type: "mobile" }),
  person({ person_id: "p3", business_id: "b1", full_name: "Sam Reed", email: "sam@harbour.example" }),
];

const lines: string[] = [];
const say = (line: string) => lines.push(line);

test("ticket 20's demonstration: an interruption with due email and SMS, a paused enrollment and pending calls, across two campaigns", async () => {
  const number = (id: string) => ({ id, capacity: 50, gapMs: 5 * MIN, k: 2, healthy: true, resetZone: "Europe/London" });
  const h = new EngineHarness({ start: MONDAY_9, accounts: [{ id: "inbox-a", capacity: 4, gapMs: 5 * MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }], sms: { numbers: [number(N1), number(N2)] } });
  const get = async <T,>(path: string) => {
    const res = await h.request<T>("GET", path);
    return res.body;
  };
  await h.tick();
  expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 10, userZone: "Europe/London" })).status).toBe(200);
  const campaigns: { id: string; name: string; lead: (who: string) => string }[] = [];
  for (const [name, sms] of [["Clinics", N1], ["Physios", N2]] as const) {
    const { campaign } = await h.createCampaign(name, { businesses: [HARBOUR], people: PEOPLE });
    await h.defineSequence(campaign.id, definition(sms));
    expect((await h.launch(campaign.id)).status).toBe(200);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows;
    campaigns.push({ id: campaign.id, name, lead: (who) => rows.find((r) => r.name === who)?.enrollments.find((e) => e.campaign.id === campaign.id)?.id ?? "" });
  }
  say(`Monday 09:00 London: two campaigns launched (email s1 then s2 a day later; a text t1 then t2 a day later; a call), three leads each, one inbox of capacity 4 a day shared by both.`);
  await h.advanceTo(MONDAY_9 + 3 * H);
  const pausedLead = campaigns[0]!.lead("Nia Cole");
  const pause = await h.request("POST", `/api/enrollments/${pausedLead}/controls`, { requestId: "demo-pause", action: "pause" });
  say(`POST /api/enrollments/<Nia in Clinics>/controls {"action":"pause"} → ${pause.status}`);
  const before = await get<CallsView>("/api/calls");
  say(`GET /api/calls at Monday 12:00 → ${before.readyNow.length} ready now`);
  say(`Delivered before the stop: ${h.fake.deliveryLog.length} emails, ${h.sms.deliveryLog.length} texts.`);

  const stoppedAt = h.clock;
  say(`The application stops at Monday 12:00 and is started again on Wednesday at 12:00 (two days).`);
  await h.stopFor(2 * DAY);
  const today = await get<TodayView>("/api/today");
  say(`GET /api/today → interruption ${JSON.stringify(today.interruption)}; sendingInterrupted ${JSON.stringify(today.sendingInterrupted)}; carriedOver ${today.carriedOver}; readyNow ${today.readyNow}`);
  expect(today.interruption?.from).toBe(new Date(stoppedAt).toISOString());
  expect(today.interruption?.to).toBe(new Date(stoppedAt + 2 * DAY).toISOString());
  const wednesday = await get<CallsView>("/api/calls");
  say(`GET /api/calls (Wednesday 12:00) → ${wednesday.readyNow.length} ready now, reasons ${JSON.stringify(wednesday.readyNow.map((x) => x.reason))}: the calls waited for the user and are on the list, carried over.`);

  await h.advanceTo(h.clock + 3 * DAY);
  const attention = await get<NeedsAttention>("/api/needs-attention");
  say(`GET /api/needs-attention (Saturday) → waitingForCapacity ${attention.waitingForCapacity.length}, noUsableChannel ${attention.noUsableChannel.length}, overdueCallbacks ${attention.overdueCallbacks.length}`);

  // Nothing twice.
  const deliveredKeys = [...h.fake.deliveryLog, ...h.sms.deliveryLog].map((d) => `${d.subjectId}/${d.stepId}`);
  expect(new Set(deliveredKeys).size).toBe(deliveredKeys.length);
  // The inbox's capacity, across both campaigns, per UTC day.
  const perDay = new Map<string, number>();
  for (const d of h.fake.deliveryLog) perDay.set(new Date(d.at).toISOString().slice(0, 10), (perDay.get(new Date(d.at).toISOString().slice(0, 10)) ?? 0) + 1);
  say(`Emails delivered per day on inbox-a (capacity 4): ${JSON.stringify(Object.fromEntries(perDay))}`);
  expect(Math.max(...perDay.values())).toBeLessThanOrEqual(4);
  // Pacing: no two sends from one sender closer than its gap.
  for (const log of [h.fake.handoverLog, h.sms.handoverLog]) {
    const bySender = new Map<string, number[]>();
    for (const c of log) bySender.set(c.sender, [...(bySender.get(c.sender) ?? []), c.at]);
    for (const ats of bySender.values()) for (let i = 1; i < ats.length; i++) expect(ats[i]! - ats[i - 1]!).toBeGreaterThanOrEqual(5 * MIN);
  }
  // The paused lead sent nothing after its pause, and is still paused.
  expect([...h.fake.handoverLog, ...h.sms.handoverLog].filter((c) => c.subjectId === pausedLead && c.at > stoppedAt)).toEqual([]);
  for (const c of campaigns) {
    for (const who of ["Pat Oneil", "Nia Cole", "Sam Reed"]) {
      const read = await get<EnrollmentRead>(`/api/enrollments/${c.lead(who)}`);
      const sent = [...h.fake.deliveryLog, ...h.sms.deliveryLog].filter((d) => d.subjectId === c.lead(who)).map((d) => `${d.stepId}@${new Date(d.at).toISOString().slice(5, 16)}`);
      say(`${c.name} / ${who}: status ${read.status}; delivered ${sent.join(", ") || "nothing"}`);
    }
  }
  expect((await get<EnrollmentRead>(`/api/enrollments/${pausedLead}`)).status).toBe("paused");
  if (process.env["DEMO_TRANSCRIPT"]) console.info(lines.join("\n"));
});
