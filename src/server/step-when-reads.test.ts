import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../test/support/engine-harness.ts";
import { business, person } from "../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../domain/sequence/definition.ts";
import type { ControlView, EnrollmentRead, LeadSearchResult, StepWhenView } from "../shared/api.ts";

/**
 * Reads that say when a step goes (ADR 0003 "Reads that say when", ticket 23's defect 2), through the real HTTP app,
 * SQLite store and engine against the fake email provider. Every name and address is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
/** Monday 9 November 2026, 10:00 London (GMT). */
const MONDAY_10 = Date.parse("2026-11-09T10:00:00Z");
const TUESDAY_9 = Date.parse("2026-11-10T09:00:00Z");
const TUESDAY_TO_FRIDAY = [2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));

const email = (id: string, waitDays = 0): StepDefinition => ({ id, waitDays, subject: `Subject ${id}`, body: `Email ${id} for {{company}}.`, threading: "new_subject", removed: false });
const track = (id: string, steps: StepDefinition[], fields: Partial<TrackDefinition> = {}): TrackDefinition => ({ id, channel: "email", branch: "main", window: TUESDAY_TO_FRIDAY, steps, start: { kind: "entry" }, removed: false, ...fields });
const definition = (tracks: TrackDefinition[]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: [], callScript: "", tracks });
const LARK = business({ business_id: "b1", business_name: "Lark Street Clinic", phone_e164: "+441174960303" });
const PAT = person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@larkstreet.example" });

async function world(def: CampaignDefinition, capacity = 50) {
  const h = new EngineHarness({ start: MONDAY_10, accounts: [{ id: "inbox-a", capacity, gapMs: 10 * MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
  await h.tick();
  expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" })).status).toBe(200);
  const { campaign } = await h.createCampaign("Spring follow-up, Bristol", { businesses: [LARK], people: [PAT] });
  await h.defineSequence(campaign.id, def);
  expect((await h.launch(campaign.id)).status).toBe(200);
  const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows;
  const pat = rows[0]?.enrollments[0]?.id ?? "";
  const read = async () => (await h.request<EnrollmentRead>("GET", `/api/enrollments/${pat}`)).body;
  const when = async (trackId = "email"): Promise<StepWhenView | undefined> => (await read()).tracks.find((t) => t.trackId === trackId)?.nextStep?.when;
  return { h, campaign, pat, read, when };
}
const controlOf = (read: EnrollmentRead, action: string): ControlView => read.controls.find((c) => c.action === action)!;

describe("the enrollment read's next step (person and company records, GET /api/enrollments/:id)", () => {
  test("launched on Monday with a Tuesday-to-Friday window: the read says Tuesday 09:00, the instant the engine sends", async () => {
    const { h, when } = await world(definition([track("email", [email("s1")])]));
    await h.advanceTo(MONDAY_10 + H);
    expect(await when()).toEqual({ kind: "at", at: new Date(TUESDAY_9).toISOString() });
    await h.advanceTo(TUESDAY_9 + 2 * H);
    expect(h.fake.deliveryLog.map((d) => d.at)).toEqual([TUESDAY_9]);
  });

  test("inside the window, with no room on the only inbox today, the read gives the reason and no time", async () => {
    const { h, when } = await world(definition([track("email", [email("s1")], { window: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 })) })]), 0);
    await h.advanceTo(MONDAY_10 + MIN);
    expect(await when()).toEqual({ kind: "waits", why: "sending_capacity" });
  });

  test("while the campaign is paused the read promises no time; after the resume it says Tuesday's opening again", async () => {
    const { h, campaign, when } = await world(definition([track("email", [email("s1")])]));
    expect((await h.request("POST", `/api/campaigns/${campaign.id}/pause`, { requestId: "pause-1" })).status).toBe(200);
    expect(await when()).toEqual({ kind: "waits", why: "campaign_paused" });
    await h.advanceTo(MONDAY_10 + 3 * H);
    expect((await h.request("POST", `/api/campaigns/${campaign.id}/resume`, { requestId: "resume-1" })).status).toBe(200);
    expect(await when()).toEqual({ kind: "at", at: new Date(TUESDAY_9).toISOString() });
  });

  test("the lead's own pause previews its resume at Tuesday's opening, the engine's instant, not the wait's end", async () => {
    const { h, pat, read } = await world(definition([track("email", [email("s1")])]));
    expect((await h.request("POST", `/api/enrollments/${pat}/controls`, { requestId: "p-1", action: "pause" })).status).toBe(200);
    await h.advanceTo(MONDAY_10 + 2 * H);
    const resume = controlOf(await read(), "resume");
    expect(resume.allowed && resume.next?.when).toEqual({ kind: "at", at: new Date(TUESDAY_9).toISOString() });
  });
});

describe("the read reaches dispatch's answer for the port's transport (council on 178de98, item 2)", () => {
  test("a continue-thread email the provider cannot send yet reads 'no transport', and nothing is sent, however long", async () => {
    const always = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
    const { h, when } = await world(definition([track("email", [email("s1"), { ...email("s2", 1), threading: "continue_thread" }], { window: always })]));
    h.fake.continueThreadUnavailable = true;
    await h.advanceTo(MONDAY_10 + H);
    expect(h.fake.deliveryLog.map((d) => d.stepId)).toEqual(["s1"]);
    await h.advanceTo(MONDAY_10 + 3 * 24 * H);
    expect(await when()).toEqual({ kind: "waits", why: "no_transport", channel: "email" });
    expect(h.fake.deliveryLog.map((d) => d.stepId)).toEqual(["s1"]);
  });
});

describe("the earliest instant, from everything the engine knows at the read (the verifier on 178de98, items 9 to 11)", () => {
  const always = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));

  test("item 9, email: a Tuesday-only window and a sender whose daily limit is zero read as no room, never a Tuesday time", async () => {
    const { h, when } = await world(definition([track("email", [email("s1")])]), 0);
    await h.advanceTo(MONDAY_10 + H);
    expect(await when()).toEqual({ kind: "waits", why: "sending_capacity" });
    await h.advanceTo(TUESDAY_9 + 3 * H);
    expect(h.fake.deliveryLog).toEqual([]);
    expect(await when()).toEqual({ kind: "waits", why: "sending_capacity" });
  });

  test("item 9, calls: Friday, two call-only leads, weekday hours, capacity 1, the first left unworked: on Saturday the second reads no room, and is placed on Tuesday", async () => {
    const FRIDAY_10 = Date.parse("2026-11-13T10:00:00Z");
    const weekdays = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
    const h = new EngineHarness({ start: FRIDAY_10, accounts: [{ id: "inbox-a", capacity: 50, gapMs: 10 * MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
    await h.tick();
    expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 1, userZone: "Europe/London" })).status).toBe(200);
    const people = [PAT, person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", direct_phone: "+441174960311" })].map((p, i) => ({ ...p, direct_phone: `+44117496031${i}` }));
    const { campaign } = await h.createCampaign("Spring calls, Bristol", { businesses: [LARK], people });
    await h.defineSequence(campaign.id, definition([{ id: "phone", channel: "call", branch: "main", window: weekdays, start: { kind: "entry" }, removed: false, steps: [{ ...email("c1"), subject: "", body: "" }] }]));
    expect((await h.launch(campaign.id)).status).toBe(200);
    await h.advanceTo(FRIDAY_10 + MIN);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows;
    const reads = await Promise.all(rows.map(async (r) => (await h.request<EnrollmentRead>("GET", `/api/enrollments/${r.enrollments[0]?.id ?? ""}`)).body));
    const placed = reads.filter((r) => r.tracks[0]?.callTask !== null);
    expect(placed).toHaveLength(1);
    const waiting = rows.find((r) => r.enrollments[0]?.id !== placed[0]?.id)?.enrollments[0]?.id ?? "";
    const whenOf = async () => (await h.request<EnrollmentRead>("GET", `/api/enrollments/${waiting}`)).body.tracks[0]?.nextStep?.when;
    // Saturday: Monday's room is taken by Friday's unworked call, which no day before Monday can list.
    await h.advanceTo(Date.parse("2026-11-14T12:00:00Z"));
    expect(await whenOf()).toEqual({ kind: "waits", why: "call_capacity" });
    // What the engine does: Monday's carried call takes the room; the second is placed on Tuesday.
    await h.advanceTo(Date.parse("2026-11-17T12:00:00Z"));
    const task = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${waiting}`)).body.tracks[0]?.callTask;
    expect(task?.placedAt.slice(0, 10)).toBe("2026-11-17");
  });

  test("item 10: the sender's pacing gap holds the second lead's email: it reads the slot's instant, and goes then", async () => {
    const h = new EngineHarness({ start: MONDAY_10, accounts: [{ id: "inbox-a", capacity: 50, gapMs: H, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
    await h.tick();
    expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" })).status).toBe(200);
    const NIA = person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", email: "nia@larkstreet.example" });
    const { campaign } = await h.createCampaign("Spring follow-up, Bristol", { businesses: [LARK], people: [PAT, NIA] });
    await h.defineSequence(campaign.id, definition([track("email", [email("s1")], { window: always })]));
    expect((await h.launch(campaign.id)).status).toBe(200);
    await h.advanceTo(MONDAY_10 + 5 * MIN);
    expect(h.fake.deliveryLog).toHaveLength(1);
    const first = h.fake.deliveryLog[0]!;
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows;
    const second = rows.flatMap((r) => r.enrollments).find((e) => e.id !== first.subjectId)?.id ?? "";
    const read = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${second}`)).body;
    expect(read.tracks[0]?.nextStep?.when).toEqual({ kind: "at", at: new Date(first.at + H).toISOString() });
    await h.advanceTo(MONDAY_10 + 2 * H);
    expect(h.fake.deliveryLog.find((d) => d.subjectId === second)?.at).toBe(first.at + H);
  });

  test("item 11: with provider access cut, the read gives the interruption, no time, and nothing goes until access returns", async () => {
    const { h, when } = await world(definition([track("email", [email("s1"), email("s2", 1)], { window: always })]));
    await h.advanceTo(MONDAY_10 + MIN);
    expect(h.fake.deliveryLog).toHaveLength(1);
    h.cutProvidersOff(MONDAY_10 + 3 * 24 * H);
    await h.advanceTo(MONDAY_10 + 2 * 24 * H);
    expect(await when()).toEqual({ kind: "waits", why: "waiting_on_provider" });
    expect(h.fake.deliveryLog).toHaveLength(1);
  });
});

describe("the order when a window opens (ADR 0003 4.3, rule 1.3; the coordinator on seed 17031)", () => {
  test("a touched lead's follow-up goes first at 20:00, then two first messages due since 08:40, one per 30-minute gap", async () => {
    // Thursday 12 November 2026, 20:00 London (GMT): one inbox, one in-flight place, a 30-minute gap; windows 20:00 to midnight.
    const THURSDAY_20 = Date.parse("2026-11-12T20:00:00Z");
    const FRIDAY = Date.parse("2026-11-13T00:00:00Z");
    const evenings = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 20, end: 24 }));
    const h = new EngineHarness({ start: THURSDAY_20, accounts: [{ id: "inbox-a", capacity: 50, gapMs: 30 * MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
    await h.tick();
    expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" })).status).toBe(200);
    const ADA = person({ person_id: "p-ada", business_id: "b1", full_name: "Ada Brook", email: "ada@larkstreet.example" });
    const BEN = person({ person_id: "p-ben", business_id: "b1", full_name: "Ben Hale", email: "ben@larkstreet.example" });
    const CAL = person({ person_id: "p-cal", business_id: "b1", full_name: "Cal Reed", email: "cal@larkstreet.example" });
    // Campaign 1: Ada's first email Thursday 20:00; her second a day later, due Friday 00:00, while the window is closed.
    const one = (await h.createCampaign("Evening notes, Bristol", { businesses: [LARK], people: [ADA] })).campaign;
    await h.defineSequence(one.id, definition([track("email", [email("a1"), email("a2", 1)], { window: evenings })]));
    expect((await h.launch(one.id)).status).toBe(200);
    await h.advanceTo(FRIDAY + MIN);
    expect(h.fake.deliveryLog.map((d) => [d.stepId, d.at])).toEqual([["a1", THURSDAY_20]]);
    // Campaign 2, launched Friday 08:40: Ben's and Cal's first messages due at once, the window closed until 20:00.
    await h.advanceTo(FRIDAY + 8 * H + 40 * MIN);
    const two = (await h.createCampaign("Evening openers, Bristol", { businesses: [LARK], people: [BEN, CAL] })).campaign;
    await h.defineSequence(two.id, definition([track("email", [email("b1")], { window: evenings })]));
    expect((await h.launch(two.id)).status).toBe(200);
    await h.advanceTo(FRIDAY + 23 * H);
    // Follow-ups before first messages (4.3): Ada's, touched by her sent first email, at the opening; then the two first
    // messages, oldest due first and then by lead, one per gap.
    const sent = h.fake.deliveryLog.filter((d) => d.at > FRIDAY).map((d) => [d.stepId, new Date(d.at).toISOString()]);
    expect(sent).toEqual([
      ["a2", "2026-11-13T20:00:00.000Z"],
      ["b1", "2026-11-13T20:30:00.000Z"],
      ["b1", "2026-11-13T21:00:00.000Z"],
    ]);
  });
});

describe("a reason promises nothing (council on cc9bf55, item 9)", () => {
  test("Tuesday-to-Friday hours, provider access cut Monday 11:00 and back at noon: the step still waits for Tuesday 09:00, and the read says so", async () => {
    const { h, when } = await world(definition([track("email", [email("s1")])]));
    h.cutProvidersOff(MONDAY_10 + 2 * H);
    await h.advanceTo(MONDAY_10 + H + 30 * MIN);
    expect(await when()).toEqual({ kind: "waits", why: "waiting_on_provider" });
    await h.advanceTo(MONDAY_10 + 3 * H);
    expect(await when()).toEqual({ kind: "at", at: new Date(TUESDAY_9).toISOString() });
    expect(h.fake.deliveryLog).toEqual([]);
    await h.advanceTo(TUESDAY_9 + H);
    expect(h.fake.deliveryLog.map((d) => d.at)).toEqual([TUESDAY_9]);
  });
});

describe("a claimed step's pacing slot after the window closes (review bot on cc9bf55, item 1)", () => {
  test("two leads launched Monday 16:58, weekday 09:00 to 17:00, a three-minute gap: at 16:59 the second reads Tuesday 09:00 and goes then", async () => {
    const MONDAY_1658 = Date.parse("2026-11-02T16:58:00Z");
    const h = new EngineHarness({ start: MONDAY_1658, accounts: [{ id: "inbox-a", capacity: 50, gapMs: 3 * MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
    await h.tick();
    expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" })).status).toBe(200);
    const NIA = person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", email: "nia@larkstreet.example" });
    const { campaign } = await h.createCampaign("Spring follow-up, Bristol", { businesses: [LARK], people: [PAT, NIA] });
    const weekdays = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
    await h.defineSequence(campaign.id, definition([track("email", [email("s1")], { window: weekdays })]));
    expect((await h.launch(campaign.id)).status).toBe(200);
    await h.advanceTo(MONDAY_1658 + MIN);
    expect(h.fake.deliveryLog).toHaveLength(1);
    const first = h.fake.deliveryLog[0]!;
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows;
    const second = rows.flatMap((r) => r.enrollments).find((e) => e.id !== first.subjectId)?.id ?? "";
    // The path the review bot and the council read on: the claim open at the read, its slot (17:01) beyond the close. On
    // cc9bf55 this read gave 17:01.
    expect((await h.store.engine.subject(second, h.clock))?.attempts.some((a) => a.state === "claimed")).toBe(true);
    const read = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${second}`)).body;
    expect(read.tracks[0]?.nextStep?.when).toEqual({ kind: "at", at: "2026-11-03T09:00:00.000Z" });
    await h.advanceTo(Date.parse("2026-11-03T10:00:00Z"));
    expect(h.fake.deliveryLog.find((d) => d.subjectId === second)?.at).toBe(Date.parse("2026-11-03T09:00:00Z"));
  });
});

describe("a control's preview reads the state the control would produce (council on cc9bf55, item 8)", () => {
  test("capacity 1, two consecutive phone tracks, Friday's call unworked: on Saturday Skip's preview names Monday, as the read after it does, and the call is placed Monday", async () => {
    const FRIDAY_10 = Date.parse("2026-11-13T10:00:00Z");
    const weekdays = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
    const h = new EngineHarness({ start: FRIDAY_10, accounts: [{ id: "inbox-a", capacity: 50, gapMs: 10 * MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
    await h.tick();
    expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 1, userZone: "Europe/London" })).status).toBe(200);
    const caller = { ...PAT, direct_phone: "+441174960310" };
    const { campaign } = await h.createCampaign("Spring calls, Bristol", { businesses: [LARK], people: [caller] });
    const call = (id: string) => ({ ...email(id), subject: "", body: "" });
    await h.defineSequence(campaign.id, definition([
      { id: "phone1", channel: "call", branch: "main", window: weekdays, start: { kind: "entry" }, removed: false, steps: [call("c1")] },
      { id: "phone2", channel: "call", branch: "main", window: weekdays, start: { kind: "after", trackId: "phone1", delayDays: 0 }, removed: false, steps: [call("c2")] },
    ]));
    expect((await h.launch(campaign.id)).status).toBe(200);
    await h.advanceTo(FRIDAY_10 + MIN);
    const id = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows[0]?.enrollments[0]?.id ?? "";
    const read = async () => (await h.request<EnrollmentRead>("GET", `/api/enrollments/${id}`)).body;
    expect((await read()).tracks.find((t) => t.trackId === "phone1")?.callTask?.open).toBe(true);
    // Saturday: Friday's call is carried into Monday and takes its one place; skipping it frees that place.
    await h.advanceTo(Date.parse("2026-11-14T12:00:00Z"));
    const skip = controlOf(await read(), "skip");
    expect(skip.allowed && skip.next?.trackId).toBe("phone2");
    const previewed = skip.allowed ? skip.next?.when : undefined;
    expect(previewed).toEqual({ kind: "call_day", day: "2026-11-16", today: false, now: false });
    expect((await h.request("POST", `/api/enrollments/${id}/controls`, { requestId: "skip-1", action: "skip" })).status).toBe(200);
    expect((await read()).tracks.find((t) => t.trackId === "phone2")?.nextStep?.when).toEqual(previewed);
    await h.advanceTo(Date.parse("2026-11-16T12:00:00Z"));
    expect((await read()).tracks.find((t) => t.trackId === "phone2")?.callTask?.placedAt.slice(0, 10)).toBe("2026-11-16");
  });
});
