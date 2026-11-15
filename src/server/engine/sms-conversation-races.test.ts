import type { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { EngineHarness, quickWait } from "../../../test/support/engine-harness.ts";
import { business, person, type ExportRows } from "../../../test/support/export-builder.ts";
import type { FakeNumber } from "../../../test/support/fake-sms-port.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { ActivityView, EnrollmentProgress, LeadSearchResult, NeedsAttention, TestRunTab } from "../../shared/api.ts";
import { Engine, TickQueue } from "./engine.ts";
import { DEFAULT_RULES } from "./rules.ts";

/**
 * Question Q7 answered (ADR 0003, 15 November 2026), after the reviews of `bebdc06`: a skip is decided against the SMS
 * conversations as they are in the write that stores it (point 2), it keeps the cause it was decided on (point 3), and a
 * conversation exists only once a text is known to have gone (point 10). Through the real HTTP app, SQLite store and
 * engine, against the fake email provider and the fake SMS provider (a test double, not an integration). Fictitious data.
 */

const MIN = 60_000;
const H = 60 * MIN;
/** Monday 2 November 2026, 08:00 London (GMT). */
const MONDAY_8 = Date.parse("2026-11-02T08:00:00Z");
const N1 = "+447700900001";
const N2 = "+447700900002";
const PAT_MOBILE = "+447700900101";
const OWN_MOBILE = "+447700900456";
const OWN_EMAIL = "alex.own@personal-mail.example";
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
/** Every day from 09:00 to 17:00. */
const FROM_NINE = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 9, end: 17 }));

const text = (id: string, waitDays = 0): StepDefinition => ({ id, waitDays, subject: "", body: `Text ${id}, {{first_name|there}}.`, threading: "new_subject", removed: false });
const email = (id: string): StepDefinition => ({ id, waitDays: 0, subject: "Hello", body: `Email ${id}.`, threading: "new_subject", removed: false });
const callStep = (id: string): StepDefinition => ({ id, waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false });
const track = (id: string, channel: TrackDefinition["channel"], steps: StepDefinition[], window = ALWAYS, start: TrackDefinition["start"] = { kind: "entry" }): TrackDefinition => ({ id, channel, branch: "main", window, steps, start, removed: false });
const definition = (tracks: TrackDefinition[], smsPool: string[]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool, tracks });
const number = (id: string, fields: Partial<FakeNumber> = {}): FakeNumber => ({ id, capacity: 50, gapMs: MIN, k: 2, healthy: true, resetZone: "Europe/London", ...fields });

const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });
const PAT = person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", dial_phone: PAT_MOBILE, dial_phone_type: "mobile" });
const SAM = person({ person_id: "p3", business_id: "b1", full_name: "Sam Lee", email: "sam@harbour.example" });

async function world(numbers: FakeNumber[] = [number(N1), number(N2)]) {
  const h = new EngineHarness({
    start: MONDAY_8,
    accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    sms: { numbers },
  });
  await h.tick();
  expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" })).status).toBe(200);
  const ids: Record<string, string> = {};
  const create = async (name: string, tracks: TrackDefinition[], smsPool: string[], rows: ExportRows = { businesses: [HARBOUR], people: [PAT] }) => {
    const id = (await h.createCampaign(name, rows)).campaign.id;
    ids[name] = id;
    await h.defineSequence(id, definition(tracks, smsPool));
    return id;
  };
  const launch = async (name: string) => {
    const launched = await h.launch(ids[name]!);
    if (launched.status !== 200) throw new Error(`launch refused: ${JSON.stringify(launched.body)}`);
  };
  const lead = async (name: string, who = "Pat Oneil") => (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${ids[name]}`)).body.rows.find((r) => r.name === who)?.enrollments.find((e) => e.campaign.id === ids[name])?.id ?? "";
  let n = 0;
  /** Saves the user's own test contacts on a campaign and runs its test, as its lead `renderAs`. */
  const runTest = async (name: string, renderAs = "Sam Lee") => {
    const id = ids[name]!;
    expect((await h.request("PUT", `/api/campaigns/${id}/test-contacts`, { email: OWN_EMAIL, mobile: OWN_MOBILE })).status).toBe(200);
    const tab = (await h.request<TestRunTab>("GET", `/api/campaigns/${id}/test-runs`)).body;
    const started = await h.request<TestRunTab>("POST", `/api/campaigns/${id}/test-runs`, { requestId: `run-${++n}`, renderAs: await lead(name, renderAs), expect: { definitionVersion: tab.definitionVersion } });
    expect(started.status).toBe(200);
    return started.body.run?.id ?? "";
  };
  const tab = async (name: string) => (await h.request<TestRunTab>("GET", `/api/campaigns/${ids[name]}/test-runs`)).body;
  /** Another process on the same database, with none of this harness's hooks, that leaves `alone` untouched. */
  const otherProcess = (alone: string | null = null) =>
    new Engine({
      store: h.store.engine,
      port: h.provider,
      smsPort: h.sms,
      now: () => h.clock,
      newId: (() => { let i = 0; return () => `other-${++i}`; })(),
      ticks: new TickQueue(),
      waitFor: quickWait,
      rules: { evaluate: (s, now, o) => (s.subject.id === alone ? s : DEFAULT_RULES.evaluate(s, now, o)), readyItems: (s, now) => (s.subject.id === alone ? [] : DEFAULT_RULES.readyItems(s, now)) },
    });
  const db = (h.store.engine as unknown as { db: DatabaseSync }).db;
  return { h, create, launch, lead, runTest, tab, otherProcess, db, ids };
}

const progress = async (h: EngineHarness, id: string) => (await h.request<EnrollmentProgress>("GET", `/api/enrollments/${id}`)).body;

describe("a skip is decided against the conversations as they are in the write that stores it (council on bebdc06, item 2)", () => {
  test("two test runs: the first's conversation is released between the second's evaluation and its write, so no skip is stored and the second texts", async () => {
    const w = await world([number(N1)]);
    // The first campaign's test texts the user's own mobile at once and keeps running on its test call.
    await w.create("Spring clinics", [track("m", "sms", [text("a1")]), track("p", "call", [callStep("c1")], FROM_NINE)], [N1], { businesses: [HARBOUR], people: [SAM] });
    await w.create("Autumn clinics", [track("m", "sms", [text("b1")], FROM_NINE)], [N1], { businesses: [HARBOUR], people: [SAM] });
    const first = await w.runTest("Spring clinics");
    await w.h.advanceTo(MONDAY_8 + 5 * MIN);
    expect(w.h.sms.deliveryLog.map((d) => d.subjectId)).toEqual([first]);
    const second = await w.runTest("Autumn clinics");
    // At 09:00 the second test's text falls due on the one number, whose conversation the first test owns. Between that
    // evaluation and its write, another process stops the first test, which releases the conversation.
    let raced = false;
    w.h.hooks = {
      beforeApplyEvaluation: async (id) => {
        if (raced || id !== second || w.h.clock < Date.parse("2026-11-02T09:00:00Z")) return;
        raced = true;
        const stopped = await w.otherProcess(second).controlLead(first, "stop", "stop-first", null);
        expect(stopped.ok).toBe(true);
      },
    };
    await w.h.advanceTo(Date.parse("2026-11-02T09:30:00Z"));
    expect(raced).toBe(true);
    const row = (await w.tab("Autumn clinics")).run?.steps.find((s) => s.stepId === "b1");
    expect(row?.state).toBe("sent");
    expect(w.h.sms.deliveryLog.map((d) => d.subjectId)).toEqual([first, second]);
  });

  test("a lead and a test run never meet in one conversation: the import that gives a lead the test mobile ends the test and releases its conversation, so the lead texts", async () => {
    const w = await world([number(N1)]);
    // The test texts the user's own mobile first; a later import gives a lead that mobile (question Q29's interim).
    await w.create("Spring clinics", [track("m", "sms", [text("a1")]), track("p", "call", [callStep("c1")], FROM_NINE)], [N1], { businesses: [HARBOUR], people: [SAM] });
    const test_ = await w.runTest("Spring clinics");
    await w.h.advanceTo(MONDAY_8 + 5 * MIN);
    const importedAt = w.h.clock;
    const OWN = person({ person_id: "p9", business_id: "b1", full_name: "Robin Vale", dial_phone: OWN_MOBILE, dial_phone_type: "mobile" });
    await w.create("Autumn clinics", [track("m", "sms", [text("b1")], FROM_NINE)], [N1], { businesses: [HARBOUR], people: [OWN] });
    await w.launch("Autumn clinics");
    const robin = await w.lead("Autumn clinics", "Robin Vale");
    // The test's conversation was released at the import: no skip can ever be decided on it for the lead.
    expect(w.db.prepare("SELECT released_at FROM sms_bindings WHERE owner_subject = ?").all(test_)).toEqual([{ released_at: importedAt }]);
    await w.h.advanceTo(Date.parse("2026-11-02T09:30:00Z"));
    expect((await progress(w.h, robin)).tracks[0]?.finishReason).toBe("completed");
    expect(w.h.sms.deliveryLog.filter((d) => d.subjectId === robin).map((d) => d.sender)).toEqual([N1]);
  });

  test("the opposite race: a conversation taken between a lead's evaluation and its write is not texted twice; the lead is skipped once it is known sent", async () => {
    const w = await world([number(N1)]);
    // Campaign A: an email, then a text one day after it. Campaign B: a text, whose window opens on Tuesday.
    await w.create("A", [track("e", "email", [email("s1")]), track("m", "sms", [text("a1")], ALWAYS, { kind: "after", trackId: "e", delayDays: 1 })], [N1]);
    await w.create("B", [track("m", "sms", [text("b1")], [{ day: 2, start: 0, end: 24 }])], [N1]);
    await w.launch("A");
    await w.launch("B");
    const [a, b] = [await w.lead("A"), await w.lead("B")];
    await w.h.advanceTo(MONDAY_8 + 2 * H);
    // At Tuesday 00:00 A's text track starts and B's window opens. Between A's evaluation and its write, another process
    // (which leaves A alone) hands over B's text: B takes the conversation on the one number.
    const other = new Engine({
      store: w.h.store.engine,
      port: w.h.provider,
      smsPort: w.h.sms,
      now: () => w.h.clock,
      newId: (() => { let i = 0; return () => `other-${++i}`; })(),
      ticks: new TickQueue(),
      waitFor: quickWait,
      rules: { evaluate: (s, now, o) => (s.subject.id === a ? s : DEFAULT_RULES.evaluate(s, now, o)), readyItems: (s, now) => (s.subject.id === a ? [] : DEFAULT_RULES.readyItems(s, now)) },
    });
    let raced = false;
    w.h.hooks = {
      beforeApplyEvaluation: async (id) => {
        if (raced || id !== a || w.h.clock < Date.parse("2026-11-03T00:00:00Z")) return;
        raced = true;
        await other.tick();
      },
    };
    await w.h.advanceTo(Date.parse("2026-11-03T06:00:00Z"));
    expect(raced).toBe(true);
    // One subject per conversation: N1 texted Pat for B only; A's SMS track was skipped once B's text was known sent.
    expect(w.h.sms.deliveryLog.map((d) => [d.subjectId, d.sender])).toEqual([[b, N1]]);
    expect((await progress(w.h, a)).tracks.find((t) => t.trackId === "m")?.finishReason).toBe("skipped_conversation_taken");
  });
});

describe("a skip keeps the cause it was decided on (council on bebdc06, item 3)", () => {
  test("a pool edit after the skip does not change the owner the reason names", async () => {
    const w = await world();
    await w.create("A", [track("m", "sms", [text("a1")])], [N1]);
    await w.create("C", [track("m", "sms", [text("c1")])], [N2]);
    await w.launch("A");
    await w.launch("C");
    await w.h.advanceTo(MONDAY_8 + H);
    await w.create("B", [track("m", "sms", [text("b1")]), track("e", "email", [email("e1")], ALWAYS, { kind: "after", trackId: "m", delayDays: 1 })], [N1]);
    await w.launch("B");
    await w.h.advanceTo(MONDAY_8 + 2 * H);
    const b = await w.lead("B");
    expect((await progress(w.h, b)).tracks[0]?.conversationOwners).toEqual([{ name: "A", test: false }]);
    // B may now use only N2, whose conversation with Pat belongs to C: the recorded skip still names A.
    await w.h.defineSequence(w.ids["B"]!, definition([track("m", "sms", [text("b1")]), track("e", "email", [email("e1")], ALWAYS, { kind: "after", trackId: "m", delayDays: 1 })], [N2]));
    await w.h.advanceTo(MONDAY_8 + 3 * H);
    expect((await progress(w.h, b)).tracks[0]?.conversationOwners).toEqual([{ name: "A", test: false }]);
    const row = (await w.h.request<LeadSearchResult>("GET", "/api/leads?q=Pat%20Oneil")).body.rows.find((r) => r.name === "Pat Oneil")!;
    const entry = (await w.h.request<ActivityView>("GET", `/api/people/${row.id}/activity`)).body.entries.find((e) => e.campaign.name === "B" && e.kind === "skipped");
    expect(entry).toMatchObject({ reason: "sms_conversation_taken", owners: [{ name: "A", test: false }] });
  });

  test("the owner's test run ending after the skip, and the owner campaign renamed, leave the reason as it was", async () => {
    const w = await world([number(N1)]);
    await w.create("Spring clinics", [track("m", "sms", [text("a1")]), track("p", "call", [callStep("c1")], FROM_NINE)], [N1], { businesses: [HARBOUR], people: [SAM] });
    await w.create("Autumn clinics", [track("m", "sms", [text("b1")])], [N1], { businesses: [HARBOUR], people: [SAM] });
    const first = await w.runTest("Spring clinics");
    await w.h.advanceTo(MONDAY_8 + 5 * MIN);
    await w.runTest("Autumn clinics");
    await w.h.advanceTo(MONDAY_8 + 10 * MIN);
    const skipped = () => w.tab("Autumn clinics").then((t) => t.run?.steps.find((s) => s.stepId === "b1"));
    expect(await skipped()).toMatchObject({ state: "skipped", reason: "sms_conversation_taken", owners: [{ name: "Spring clinics", test: true }] });
    // The owner's test ends: its conversation is released. The campaign is then renamed, as another process could.
    expect((await w.otherProcess().controlLead(first, "stop", "stop-first", null)).ok).toBe(true);
    w.db.prepare("UPDATE campaigns SET name = ? WHERE id = ?").run("Spring clinics, renamed", w.ids["Spring clinics"]!);
    await w.h.advanceTo(MONDAY_8 + 20 * MIN);
    expect(await skipped()).toMatchObject({ state: "skipped", reason: "sms_conversation_taken", owners: [{ name: "Spring clinics", test: true }] });
  });
});

describe("a conversation exists once a text is known to have gone (council on bebdc06, item 4; ADR 0003 Q7 point 10)", () => {
  /** Campaign A texts Pat on N1 first; campaign B, launched a minute later, may use only N1, and emails after its text. */
  async function twoCampaigns() {
    const w = await world([number(N1)]);
    await w.create("A", [track("m", "sms", [text("a1")])], [N1]);
    await w.create("B", [track("m", "sms", [text("b1")]), track("e", "email", [email("e1")], ALWAYS, { kind: "after", trackId: "m", delayDays: 0 })], [N1]);
    return w;
  }
  const bindingRows = (w: Awaited<ReturnType<typeof world>>) => w.db.prepare("SELECT owner_subject AS owner, released_at IS NOT NULL AS released, unsent FROM sms_bindings WHERE recipient_key = ? ORDER BY seq").all(PAT_MOBILE);

  test("refused for an account reason: the conversation is released as unsent, and the other campaign is not skipped for it", async () => {
    const w = await twoCampaigns();
    w.h.sms.refuseFrom.set(N1, { calls: 1, reason: "rate_limited", retryAfterMs: 30 * MIN });
    await w.launch("A");
    await w.h.advanceTo(MONDAY_8 + MIN);
    const a = await w.lead("A");
    expect(bindingRows(w)).toEqual([{ owner: a, released: 1, unsent: 1 }]);
    await w.launch("B");
    const b = await w.lead("B");
    await w.h.advanceTo(MONDAY_8 + 10 * MIN);
    // B waits on the number's rate limit, not on a conversation: nothing is skipped and nothing is held for one.
    expect((await progress(w.h, b)).tracks[0]).toMatchObject({ finishReason: null, hold: null });
    // A's retry takes the number again by the ordinary rule; once its text is known sent, B is skipped then.
    await w.h.advanceTo(MONDAY_8 + 2 * H);
    expect(w.h.sms.deliveryLog.map((d) => d.subjectId)).toEqual([a]);
    expect((await progress(w.h, b)).tracks[0]?.finishReason).toBe("skipped_conversation_taken");
  });

  test("failed after the provider accepted it: the conversation is released as unsent, and the other campaign texts on it", async () => {
    const w = await twoCampaigns();
    w.h.sms.failAfterAccept.add(PAT_MOBILE);
    await w.launch("A");
    await w.h.advanceTo(MONDAY_8 + 5 * MIN);
    const a = await w.lead("A");
    expect(bindingRows(w)).toEqual([{ owner: a, released: 1, unsent: 1 }]);
    w.h.sms.failAfterAccept.delete(PAT_MOBILE);
    await w.launch("B");
    const b = await w.lead("B");
    await w.h.advanceTo(MONDAY_8 + H);
    expect(w.h.sms.deliveryLog.map((d) => [d.subjectId, d.sender])).toEqual([[b, N1]]);
    // A reply on that conversation goes to B, whose text was sent, never to A, whose was not.
    w.h.sms.prospectTexts(PAT_MOBILE, "Who is this?", N1);
    await w.h.advanceTo(MONDAY_8 + 2 * H);
    expect((await progress(w.h, b)).status).toBe("replied");
    expect((await progress(w.h, a)).status).not.toBe("replied");
  });

  test("an answer lost, then found not sent: the other campaign waits with a reason while it is unknown, and the conversation is released as unsent", async () => {
    const w = await twoCampaigns();
    w.h.sms.dropUnanswered.set(PAT_MOBILE, 1);
    await w.launch("A");
    await w.h.advanceTo(MONDAY_8 + MIN);
    await w.launch("B");
    const [a, b] = [await w.lead("A"), await w.lead("B")];
    await w.h.advanceTo(MONDAY_8 + 2 * MIN);
    // Unknown: no final decision. B waits, listed with its reason.
    expect((await progress(w.h, b)).tracks[0]).toMatchObject({ finishReason: null, hold: "sms_conversation_unsettled" });
    expect((await w.h.request<NeedsAttention>("GET", "/api/needs-attention")).body.heldTracks).toContainEqual(expect.objectContaining({ enrollmentId: b, trackId: "m", reason: "sms_conversation_unsettled", owners: [{ name: "A", test: false }], campaign: expect.objectContaining({ name: "B" }) }));
    // The lookups find nothing, but an SMS "not sent" is not final (ADR 0002 P3): the work is unresolved and B still waits.
    await w.h.advanceTo(MONDAY_8 + 3 * H);
    expect(bindingRows(w)).toEqual([{ owner: a, released: 0, unsent: 0 }]);
    expect((await progress(w.h, b)).tracks[0]).toMatchObject({ finishReason: null, hold: "sms_conversation_unsettled" });
    // The user marks it not sent: the work settles not sent, and its binding is released as unsent in the same write.
    const attempt = (await w.h.store.engine.subject(a, w.h.clock))!.attempts[0]!;
    expect(await w.h.engine.markAttempt(attempt.id, "not_sent")).toBe(true);
    expect(bindingRows(w)[0]).toEqual({ owner: a, released: 1, unsent: 1 });
    expect((await progress(w.h, b)).tracks[0]?.hold).toBeNull();
  });

  test("a lead held on an unsettled conversation texts once the binding is released as unsent, on the same engine, and its waiting email starts (council on faac357, item 1)", async () => {
    const w = await twoCampaigns();
    w.h.sms.dropUnanswered.set(PAT_MOBILE, 1);
    await w.launch("A");
    await w.h.advanceTo(MONDAY_8 + MIN);
    await w.launch("B");
    const [a, b] = [await w.lead("A"), await w.lead("B")];
    await w.h.advanceTo(MONDAY_8 + 2 * MIN);
    expect((await progress(w.h, b)).tracks[0]?.hold).toBe("sms_conversation_unsettled");
    // An hour on, the lookups have found nothing, which for SMS is not final: A's text is unresolved, and B still waits.
    await w.h.advanceTo(MONDAY_8 + H);
    expect((await progress(w.h, b)).tracks[0]?.hold).toBe("sms_conversation_unsettled");
    // A's campaign is paused, so its own retry cannot take the number back; the user marks A's text not sent.
    // (Pausing asks the provider to withdraw A's text, which it never had: settled withdrawn, so the mark finds it settled.)
    expect((await w.h.request("POST", `/api/campaigns/${w.ids["A"]}/pause`, { requestId: "pause-a" })).status).toBe(200);
    const attempt = (await w.h.store.engine.subject(a, w.h.clock))!.attempts[0]!;
    await w.h.engine.markAttempt(attempt.id, "not_sent");
    expect(bindingRows(w)[0]).toEqual({ owner: a, released: 1, unsent: 1 });
    await w.h.advanceTo(w.h.clock + 3 * H);
    // The same long-running engine: B texts on the number, and the email waiting on its SMS track goes after it.
    expect(w.h.sms.deliveryLog.filter((d) => d.subjectId === b).map((d) => [d.stepId, d.sender])).toEqual([["b1", N1]]);
    expect((await progress(w.h, b)).tracks.map((t) => [t.trackId, t.finishReason])).toEqual([["m", "completed"], ["e", "completed"]]);
    expect(w.h.fake.deliveryLog.filter((d) => d.subjectId === b).map((d) => d.stepId)).toEqual(["e1"]);
  });

  test("the release reaches a waiting lead by settlement too: A's text accepted then refused finally, B held meanwhile, then B texts and its email starts (verifier on faac357)", async () => {
    const w = await twoCampaigns();
    w.h.sms.failAfterAccept.add(PAT_MOBILE);
    await w.launch("A");
    w.h.clock = MONDAY_8 + 15_000;
    await w.launch("B");
    const b = await w.lead("B");
    await w.h.advanceTo(MONDAY_8 + 30_000);
    expect((await progress(w.h, b)).tracks[0]?.hold).toBe("sms_conversation_unsettled");
    w.h.sms.failAfterAccept.delete(PAT_MOBILE);
    // At 09:01 the provider refuses A's text: its binding is released as unsent; the same engine then serves B.
    await w.h.advanceTo(MONDAY_8 + 2 * H);
    expect(w.h.sms.deliveryLog.map((d) => [d.subjectId, d.sender])).toContainEqual([b, N1]);
    expect((await progress(w.h, b)).tracks.map((t) => [t.trackId, t.finishReason])).toEqual([["m", "completed"], ["e", "completed"]]);
  });

  test("a first text that never settles: the waiting lead is listed with its reason, and each of the user's controls releases it (council on faac357, item 1)", async () => {
    for (const control of ["skip", "stop", "mark the owner's text not sent"] as const) {
      const w = await twoCampaigns();
      w.h.sms.dropUnanswered.set(PAT_MOBILE, 1);
      // The provider never answers a lookup for A's text: its work stays unresolved.
      w.h.sms.silentSends = true;
      await w.launch("A");
      await w.h.advanceTo(MONDAY_8 + MIN);
      await w.launch("B");
      const [a, b] = [await w.lead("A"), await w.lead("B")];
      await w.h.advanceTo(MONDAY_8 + 6 * H);
      expect((await progress(w.h, b)).tracks[0]).toMatchObject({ finishReason: null, hold: "sms_conversation_unsettled" });
      const attention = (await w.h.request<NeedsAttention>("GET", "/api/needs-attention")).body;
      expect(attention.heldTracks).toContainEqual(expect.objectContaining({ enrollmentId: b, trackId: "m", reason: "sms_conversation_unsettled", owners: [{ name: "A", test: false }], campaign: expect.objectContaining({ name: "B" }) }));
      if (control === "skip") {
        expect((await w.h.request("POST", `/api/enrollments/${b}/controls`, { requestId: "skip-b", action: "skip" })).status).toBe(200);
        await w.h.advanceTo(w.h.clock + H);
        expect((await progress(w.h, b)).tracks.map((t) => [t.trackId, t.finishReason])).toEqual([["m", "skipped"], ["e", "completed"]]);
      } else if (control === "stop") {
        expect((await w.h.request("POST", `/api/enrollments/${b}/controls`, { requestId: "stop-b", action: "stop" })).status).toBe(200);
        expect((await progress(w.h, b)).status).toBe("stopped_manually");
      } else {
        expect((await w.h.request("POST", `/api/campaigns/${w.ids["A"]}/pause`, { requestId: "pause-a" })).status).toBe(200);
        const attempt = (await w.h.store.engine.subject(a, w.h.clock))!.attempts[0]!;
        expect(await w.h.engine.markAttempt(attempt.id, "not_sent")).toBe(true);
        // From here the provider reports texts again, so B's own text is not left unresolved.
        w.h.sms.silentSends = false;
        await w.h.advanceTo(w.h.clock + H);
        expect(w.h.sms.deliveryLog.filter((d) => d.subjectId === b).map((d) => d.stepId)).toEqual(["b1"]);
      }
      expect((await w.h.request<NeedsAttention>("GET", "/api/needs-attention")).body.heldTracks.filter((x) => x.enrollmentId === b), control).toEqual([]);
    }
  });

  test("an answer lost, then found sent: the other campaign waits while it is unknown, then is skipped", async () => {
    const w = await twoCampaigns();
    w.h.sms.loseAnswer.add(PAT_MOBILE);
    await w.launch("A");
    await w.h.advanceTo(MONDAY_8 + MIN);
    await w.launch("B");
    const b = await w.lead("B");
    await w.h.advanceTo(MONDAY_8 + 2 * MIN);
    expect((await progress(w.h, b)).tracks[0]).toMatchObject({ finishReason: null, hold: "sms_conversation_unsettled" });
    await w.h.advanceTo(MONDAY_8 + 3 * H);
    const skipped = (await progress(w.h, b)).tracks[0];
    expect(skipped).toMatchObject({ finishReason: "skipped_conversation_taken", hold: null, conversationOwners: [{ name: "A", test: false }] });
    expect(Date.parse(skipped?.finishedAt ?? "")).toBeGreaterThan(MONDAY_8 + 2 * MIN);
    expect(w.h.sms.deliveryLog.map((d) => d.destination)).toEqual([PAT_MOBILE]);
  });
});


describe("a reply while the conversation's ownership is unsettled (the coordinator's ruling on faac357; ADR 0003 Q7 point 10)", () => {
  async function waiting() {
    const w = await world([number(N1)]);
    await w.create("A", [track("m", "sms", [text("a1")]), track("e", "email", [email("ea")], ALWAYS, { kind: "after", trackId: "m", delayDays: 2 })], [N1]);
    await w.create("B", [track("m", "sms", [text("b1")]), track("e", "email", [email("e1")], ALWAYS, { kind: "after", trackId: "m", delayDays: 0 })], [N1]);
    return w;
  }
  const workOf = async (w: Awaited<ReturnType<typeof world>>, id: string) => (await w.h.store.engine.subject(id, w.h.clock))!.work.map((x) => ({ settled: x.settled, sentWall: x.sentWall }));
  const activityKinds = async (w: Awaited<ReturnType<typeof world>>, campaign: string) => {
    const row = (await w.h.request<LeadSearchResult>("GET", "/api/leads?q=Pat%20Oneil")).body.rows.find((r) => r.name === "Pat Oneil")!;
    return (await w.h.request<ActivityView>("GET", `/api/people/${row.id}/activity`)).body.entries.filter((e) => e.campaign.name === campaign).map((e) => `${e.kind}${"channel" in e ? `|${e.channel}` : ""}`);
  };

  test("the reply stops the holder at once and settles nothing; the waiting lead is then skipped, the owner named; a later not-sent leaves the holder replied and the conversation its own", async () => {
    const w = await waiting();
    w.h.sms.dropUnanswered.set(PAT_MOBILE, 1);
    await w.launch("A");
    await w.h.advanceTo(MONDAY_8 + MIN);
    await w.launch("B");
    const [a, b] = [await w.lead("A"), await w.lead("B")];
    await w.h.advanceTo(MONDAY_8 + 2 * MIN);
    expect((await progress(w.h, b)).tracks[0]?.hold).toBe("sms_conversation_unsettled");
    // Pat answers the number, although no text from it is known to have gone.
    w.h.sms.prospectTexts(PAT_MOBILE, "Who is this?", N1);
    await w.h.advanceTo(MONDAY_8 + 3 * MIN);
    expect((await progress(w.h, a)).status).toBe("replied");
    // The reply settles nothing by itself: A's text is still neither sent nor not sent.
    expect(await workOf(w, a)).toEqual([{ settled: null, sentWall: null }]);
    // The answered conversation is A's for good: B is skipped, A named; B's email goes.
    const skipped = (await progress(w.h, b)).tracks[0];
    expect(skipped).toMatchObject({ finishReason: "skipped_conversation_taken", hold: null, conversationOwners: [{ name: "A", test: false }] });
    expect((await progress(w.h, b)).status).not.toBe("replied");
    await w.h.advanceTo(MONDAY_8 + H);
    expect(w.h.fake.deliveryLog.filter((d) => d.subjectId === b).map((d) => d.stepId)).toEqual(["e1"]);
    // A's text is found not sent (the user's mark, after the lookups). A stays replied, its conversation is kept (it was
    // answered), Activity says a reply came and claims no text was sent, and the restart is offered.
    const attempt = (await w.h.store.engine.subject(a, w.h.clock))!.attempts[0]!;
    expect(await w.h.engine.markAttempt(attempt.id, "not_sent")).toBe(true);
    expect((await progress(w.h, a)).status).toBe("replied");
    expect(w.db.prepare("SELECT owner_subject AS owner, released_at, unsent FROM sms_bindings").all()).toEqual([{ owner: a, released_at: null, unsent: 0 }]);
    expect(await activityKinds(w, "A")).toEqual(["replied|sms"]);
    const controls = (await w.h.request<{ controls: { action: string; allowed: boolean }[] }>("GET", `/api/enrollments/${a}`)).body.controls;
    expect(controls.find((c) => c.action === "resume_from_next_step")?.allowed).toBe(true);
    // A later text on that conversation still reaches A.
    w.h.sms.prospectTexts(PAT_MOBILE, "Hello again", N1);
    await w.h.advanceTo(w.h.clock + MIN);
    expect((await w.h.request<NeedsAttention>("GET", "/api/needs-attention")).body.anomalies).toEqual([]);
  });

  test("the reply while unknown, then the text found sent: the holder stays replied, the waiting lead skipped", async () => {
    const w = await waiting();
    w.h.sms.loseAnswer.add(PAT_MOBILE);
    await w.launch("A");
    await w.h.advanceTo(MONDAY_8 + MIN);
    await w.launch("B");
    const [a, b] = [await w.lead("A"), await w.lead("B")];
    await w.h.advanceTo(MONDAY_8 + 2 * MIN);
    expect((await progress(w.h, b)).tracks[0]?.hold).toBe("sms_conversation_unsettled");
    w.h.sms.prospectTexts(PAT_MOBILE, "STOP", N1);
    await w.h.advanceTo(MONDAY_8 + 3 * MIN);
    expect((await progress(w.h, a)).status).toBe("replied");
    expect((await progress(w.h, b)).tracks[0]?.finishReason).toBe("skipped_conversation_taken");
    // The lookups then find A's text sent: nothing about either lead changes.
    await w.h.advanceTo(MONDAY_8 + 3 * H);
    expect((await workOf(w, a))[0]?.settled).toBe("sent");
    expect((await progress(w.h, a)).status).toBe("replied");
    expect(await activityKinds(w, "A")).toEqual(["replied|sms", "sent|sms"]);
  });

  test("a reply on a conversation released as unsent, with no binding left, is a text from a mobile no number has a conversation with: nobody is stopped", async () => {
    const w = await waiting();
    w.h.sms.failAfterAccept.add(PAT_MOBILE);
    await w.launch("A");
    await w.h.advanceTo(MONDAY_8 + 5 * MIN);
    const a = await w.lead("A");
    expect(w.db.prepare("SELECT released_at IS NOT NULL AS released, unsent FROM sms_bindings").all()).toEqual([{ released: 1, unsent: 1 }]);
    w.h.sms.prospectTexts(PAT_MOBILE, "Hello?", N1);
    await w.h.advanceTo(MONDAY_8 + 10 * MIN);
    expect((await progress(w.h, a)).status).not.toBe("replied");
    expect((await w.h.request<NeedsAttention>("GET", "/api/needs-attention")).body.anomalies.map((x) => x.what)).toContain("a text from a mobile no number of the app's has a conversation with");
  });
});
