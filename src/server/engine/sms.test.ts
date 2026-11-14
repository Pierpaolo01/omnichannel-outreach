import { describe, expect, test } from "vitest";
import { EngineHarness, quickWait } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { FakeNumber } from "../../../test/support/fake-sms-port.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { LeadSearchResult, NeedsAttention, PersonRecord, SequenceView } from "../../shared/api.ts";
import { Engine, TickQueue } from "./engine.ts";
import { DEFAULT_RULES } from "./rules.ts";

/**
 * SMS tracks beside email and the coordination between tracks (ticket 13), through the real HTTP
 * app, SQLite store and engine, against the fake email provider and the fake SMS provider. No SMS
 * provider exists; the fake is a test double, not an integration. Data is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
/** Monday 2 November 2026, 09:00 London (GMT). */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const N1 = "+447700900001";
const N2 = "+447700900002";
const PAT_MOBILE = "+447700900101";
const NIA_MOBILE = "+447700900102";

const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const email = (id: string, waitDays = 0, threading: StepDefinition["threading"] = waitDays === 0 ? "new_subject" : "continue_thread"): StepDefinition => ({
  id,
  waitDays,
  subject: "Hello {{first_name|there}}",
  body: `Email ${id} for {{company}}.`,
  threading,
  removed: false,
});
const text = (id: string, waitDays = 0): StepDefinition => ({ id, waitDays, subject: "", body: `Text ${id}, {{first_name|there}}.`, threading: "new_subject", removed: false });
const track = (id: string, channel: "email" | "sms", steps: StepDefinition[], start: TrackDefinition["start"] = { kind: "entry" }, window = ALWAYS): TrackDefinition => ({
  id,
  channel,
  branch: "main",
  window,
  steps,
  start,
  removed: false,
});
const after = (trackId: string, delayDays: number) => ({ kind: "after" as const, trackId, delayDays });
const definition = (tracks: TrackDefinition[], smsPool = [N1, N2]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool, tracks });

const number = (id: string, fields: Partial<FakeNumber> = {}): FakeNumber => ({ id, capacity: 50, gapMs: MIN, k: 2, healthy: true, resetZone: "Europe/London", ...fields });

const PEOPLE = [
  person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", dial_phone: PAT_MOBILE, dial_phone_type: "mobile" }),
  person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", dial_phone: NIA_MOBILE, dial_phone_type: "mobile" }),
  person({ person_id: "p3", business_id: "b1", full_name: "Sam Lee", email: "sam@harbour.example" }),
];
const BUSINESSES = [
  business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" }),
  // No decision maker is known: a company lead, on its shared inbox and main line.
  business({ business_id: "b2", business_name: "Elm Street Clinic", phone_e164: "+442079460303", general_emails: "hello@elm.example" }),
];

async function world(options: { numbers?: FakeNumber[]; people?: typeof PEOPLE; businesses?: typeof BUSINESSES } = {}) {
  const h = new EngineHarness({
    start: MONDAY_9 - H,
    accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    sms: { numbers: options.numbers ?? [number(N1), number(N2)] },
  });
  await h.tick();
  const campaigns: string[] = [];
  /** Creates a campaign with these tracks and launches it now. */
  const campaign = async (name: string, tracks: TrackDefinition[], smsPool = [N1, N2], rows = { businesses: options.businesses ?? BUSINESSES, people: options.people ?? PEOPLE }) => {
    const { campaign: c } = await h.createCampaign(name, rows);
    campaigns.push(c.id);
    await h.defineSequence(c.id, definition(tracks, smsPool));
    const launched = await h.launch(c.id);
    if (launched.status !== 200) throw new Error(`launch refused: ${JSON.stringify(launched.body)}`);
    const rowsFound = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
    return (name: string) => rowsFound.find((r) => r.name === name)?.enrollments.find((e) => e.campaign.id === c.id)?.id ?? "";
  };
  const texts = (to: string) => h.sms.deliveryLog.filter((d) => d.destination === to);
  const emails = (to: string) => h.fake.deliveryLog.filter((d) => d.destination === to);
  return { h, campaign, texts, emails };
}

describe("tracks together and after (spec: Define coordinated email, SMS and phone sequences)", () => {
  test("email and SMS connected together both start at launch; SMS goes to the decision maker's own mobile", async () => {
    const { h, campaign, texts, emails } = await world();
    h.clock = MONDAY_9;
    const lead = await campaign("Together", [track("t1", "email", [email("s1")]), track("t2", "sms", [text("m1")])]);
    await h.advanceTo(MONDAY_9 + H);
    expect(emails("pat@harbour.example").map((d) => d.stepId)).toEqual(["s1"]);
    expect(texts(PAT_MOBILE)).toEqual([expect.objectContaining({ stepId: "m1", sender: N1, rendered: { subject: "", body: "Text m1, Pat." } })]);
    // Nia has only a mobile: her email track is skipped as missing, her SMS track runs.
    expect(texts(NIA_MOBILE).map((d) => d.stepId)).toEqual(["m1"]);
    const nia = await h.progress(lead("Nia Cole"));
    expect(nia.tracks.map((t) => [t.trackId, t.finishReason])).toEqual([["t1", "skipped_missing_channel"], ["t2", "completed"]]);
    // A company lead has no SMS destination: a main line is not a mobile (ADR 0001).
    const company = await h.progress(lead("Elm Street Clinic"));
    expect(company.tracks.find((t) => t.trackId === "t2")?.finishReason).toBe("skipped_missing_channel");
    expect(company.status).toBe("sequence_finished_no_response");
    const pat = await h.progress(lead("Pat Oneil"));
    expect(pat).toMatchObject({ status: "sequence_finished_no_response", sender: "inbox-a", smsSender: N1 });
  });

  test("a track after another starts its delay, in the prospect's calendar days, once the earlier track has finished all its steps", async () => {
    const { h, campaign, texts, emails } = await world();
    h.clock = MONDAY_9;
    const lead = await campaign("After", [track("t1", "email", [email("s1"), email("s2", 2)]), track("t2", "sms", [text("m1")], after("t1", 1))]);
    await h.advanceTo(MONDAY_9 + 6 * DAY);
    const s2 = emails("pat@harbour.example").find((d) => d.stepId === "s2");
    // s2 is due Wednesday 00:00; the SMS track starts one calendar day after it was sent: Thursday 00:00 London.
    expect(new Date(s2?.at ?? 0).toISOString()).toBe("2026-11-04T00:00:00.000Z");
    expect(texts(PAT_MOBILE).map((d) => new Date(d.at).toISOString())).toEqual(["2026-11-05T00:00:00.000Z"]);
    expect((await h.progress(lead("Pat Oneil"))).status).toBe("sequence_finished_no_response");
  });

  test("a skipped track releases the track after it after its delay, counted from the skip", async () => {
    const { h, campaign, emails } = await world({ people: [PEOPLE[2]!], businesses: [BUSINESSES[0]!] });
    h.clock = MONDAY_9;
    // Sam has no mobile: the SMS track is skipped at launch, and the email track waits two days from then.
    await campaign("Release on skip", [track("t1", "sms", [text("m1")]), track("t2", "email", [email("s1")], after("t1", 2))]);
    await h.advanceTo(MONDAY_9 + 4 * DAY);
    expect(emails("sam@harbour.example").map((d) => new Date(d.at).toISOString())).toEqual(["2026-11-04T00:00:00.000Z"]);
  });

  test("an invalid SMS number is marked bad and its track ends; the track after it is released; a lead with no channel left ends with the reason", async () => {
    const { h, campaign, texts, emails } = await world();
    h.sms.invalid.add(PAT_MOBILE);
    h.sms.invalid.add(NIA_MOBILE);
    h.clock = MONDAY_9;
    const lead = await campaign("Release on failure", [track("t1", "sms", [text("m1"), text("m2", 1)]), track("t2", "email", [email("s1")], after("t1", 1))]);
    await h.advanceTo(MONDAY_9 + 3 * DAY);
    const pat = await h.progress(lead("Pat Oneil"));
    expect(pat.tracks.map((t) => [t.trackId, t.finishReason])).toEqual([["t1", "failed_bad_destination"], ["t2", "completed"]]);
    expect(texts(PAT_MOBILE)).toEqual([]);
    expect(emails("pat@harbour.example").map((d) => new Date(d.at).toISOString())).toEqual(["2026-11-03T00:00:00.000Z"]);
    const record = (await h.request<PersonRecord>("GET", `/api/people/${(await h.request<LeadSearchResult>("GET", "/api/leads?q=Pat")).body.rows[0]?.id}`)).body;
    expect(record.contactDetails.find((d) => d.channel === "phone")).toMatchObject({ bad: true });
    // Nia had only that mobile: no usable channel is left, and the ending says so.
    expect((await h.progress(lead("Nia Cole"))).status).toBe("finished_no_usable_channel");
  });

  test("a number the carrier reports invalid after a text was sent is marked bad and its track ends early", async () => {
    const { h, campaign, texts } = await world();
    h.sms.invalidAfterSend.add(PAT_MOBILE);
    h.clock = MONDAY_9;
    const lead = await campaign("Undeliverable", [track("t1", "sms", [text("m1"), text("m2", 1)]), track("t2", "email", [email("s1")])]);
    await h.advanceTo(MONDAY_9 + 3 * DAY);
    expect(texts(PAT_MOBILE).map((d) => d.stepId)).toEqual(["m1"]);
    const pat = await h.progress(lead("Pat Oneil"));
    expect(pat.tracks.find((t) => t.trackId === "t1")?.finishReason).toBe("failed_bad_destination");
    expect(pat.status).toBe("sequence_finished_no_response");
  });
});

describe("replies stop the lead in its campaign across all its tracks (spec: Define reply handoff)", () => {
  test("an SMS reply, STOP included, stops later email and SMS work; status shows channel and date only; colleagues continue", async () => {
    const { h, campaign, texts, emails } = await world();
    h.clock = MONDAY_9;
    const lead = await campaign("Stop on text", [track("t1", "email", [email("s1"), email("s2", 2)]), track("t2", "sms", [text("m1"), text("m2", 1)])]);
    await h.advanceTo(MONDAY_9 + 3 * H);
    expect(h.sms.prospectTexts(PAT_MOBILE, "STOP")).toBe(true);
    await h.advanceTo(MONDAY_9 + 5 * DAY);
    expect(emails("pat@harbour.example").map((d) => d.stepId)).toEqual(["s1"]);
    expect(texts(PAT_MOBILE).map((d) => d.stepId)).toEqual(["m1"]);
    const pat = await h.progress(lead("Pat Oneil"));
    expect(pat.status).toBe("replied");
    expect(pat.reply).toEqual({ channel: "sms", at: new Date(MONDAY_9 + 3 * H).toISOString() });
    expect(JSON.stringify(pat)).not.toContain("STOP");
    // Nia, a colleague at the same company, keeps receiving her texts.
    expect(texts(NIA_MOBILE).map((d) => d.stepId)).toEqual(["m1", "m2"]);
  });

  test("a second text does not move the reply's date: the status dates the reply that stopped the lead (found by the generated test)", async () => {
    const { h, campaign } = await world();
    h.clock = MONDAY_9;
    const lead = await campaign("Two texts", [track("t1", "sms", [text("m1"), text("m2", 2)])]);
    await h.advanceTo(MONDAY_9 + H);
    h.sms.prospectTexts(PAT_MOBILE, "STOP");
    await h.advanceTo(MONDAY_9 + 2 * H);
    h.sms.prospectTexts(PAT_MOBILE, "Really, stop");
    await h.advanceTo(MONDAY_9 + 3 * H);
    expect((await h.progress(lead("Pat Oneil"))).reply).toEqual({ channel: "sms", at: new Date(MONDAY_9 + H).toISOString() });
  });

  test("replies observed late and out of order never move the stopping reply's channel or date, on either channel, across a restart (verifier B1)", async () => {
    const { h, campaign } = await world({ people: [PEOPLE[0]!], businesses: [BUSINESSES[0]!] });
    h.clock = MONDAY_9;
    const lead = await campaign("Late replies", [track("t1", "email", [email("s1"), email("s2", 3)]), track("t2", "sms", [text("m1"), text("m2", 3)])]);
    await h.advanceTo(MONDAY_9 + 3 * H);
    // Observed at 12:00: a text Pat sent at 10:00. It stops the lead.
    h.clock = MONDAY_9 + 3 * H;
    h.sms.prospectTexts(PAT_MOBILE, "STOP", null, MONDAY_9 + H);
    await h.tick();
    const stopped = { channel: "sms", at: new Date(MONDAY_9 + H).toISOString() };
    expect((await h.progress(lead("Pat Oneil"))).reply).toEqual(stopped);
    // Observed at 13:00: a text sent at 11:00, earlier than when the first was observed.
    h.clock = MONDAY_9 + 4 * H;
    h.sms.prospectTexts(PAT_MOBILE, "Again", null, MONDAY_9 + 2 * H);
    await h.tick();
    expect((await h.progress(lead("Pat Oneil"))).reply).toEqual(stopped);
    // Observed at 14:00: an email reply on its thread, sent at 10:30 by the provider's clock.
    h.clock = MONDAY_9 + 5 * H;
    expect(h.fake.prospectReplies("pat@harbour.example", true, MONDAY_9 + H + 30 * MIN)).toBe(true);
    await h.tick();
    expect((await h.progress(lead("Pat Oneil"))).reply).toEqual(stopped);
    await h.restart();
    await h.advanceTo(MONDAY_9 + 6 * DAY);
    expect((await h.progress(lead("Pat Oneil"))).reply).toEqual(stopped);
  });

  test("the reply observed first stops the lead, even when a reply observed later carries an earlier time on the other channel", async () => {
    const { h, campaign } = await world({ people: [PEOPLE[0]!], businesses: [BUSINESSES[0]!] });
    h.clock = MONDAY_9;
    const lead = await campaign("Email first", [track("t1", "email", [email("s1"), email("s2", 3)]), track("t2", "sms", [text("m1"), text("m2", 3)])]);
    await h.advanceTo(MONDAY_9 + 3 * H);
    h.fake.prospectReplies("pat@harbour.example", true, MONDAY_9 + 2 * H);
    await h.tick();
    h.clock = MONDAY_9 + 4 * H;
    h.sms.prospectTexts(PAT_MOBILE, "STOP", null, MONDAY_9 + H);
    await h.tick();
    expect((await h.progress(lead("Pat Oneil"))).reply).toEqual({ channel: "email", at: new Date(MONDAY_9 + 2 * H).toISOString() });
  });

  test("an email reply stops the lead's SMS track", async () => {
    const { h, campaign, texts } = await world();
    h.clock = MONDAY_9;
    const lead = await campaign("Stop on email", [track("t1", "email", [email("s1")]), track("t2", "sms", [text("m1")], after("t1", 1))]);
    await h.advanceTo(MONDAY_9 + 2 * H);
    expect(h.fake.prospectReplies("pat@harbour.example")).toBe(true);
    await h.advanceTo(MONDAY_9 + 4 * DAY);
    expect(texts(PAT_MOBILE)).toEqual([]);
    expect((await h.progress(lead("Pat Oneil"))).reply?.channel).toBe("email");
  });
});

describe("SMS conversations are campaign-local (ADR 0003 4.5)", () => {
  test("one person in two campaigns on one number: the second campaign uses another number, and a reply stops only the campaign that owns that conversation", async () => {
    const { h, campaign, texts } = await world();
    h.clock = MONDAY_9;
    const a = await campaign("A", [track("t1", "sms", [text("m1"), text("m2", 3)])]);
    await h.advanceTo(MONDAY_9 + H);
    const b = await campaign("B", [track("t1", "sms", [text("m1"), text("m2", 3)])]);
    await h.advanceTo(MONDAY_9 + 2 * H);
    expect(texts(PAT_MOBILE).map((d) => d.sender)).toEqual([N1, N2]);
    // Pat answers campaign B's number.
    h.sms.prospectTexts(PAT_MOBILE, "Who is this?", N2);
    await h.advanceTo(MONDAY_9 + 5 * DAY);
    expect((await h.progress(b("Pat Oneil"))).status).toBe("replied");
    expect((await h.progress(a("Pat Oneil"))).status).toBe("sequence_finished_no_response");
    expect(texts(PAT_MOBILE).map((d) => `${d.sender}/${d.stepId}`)).toEqual([`${N1}/m1`, `${N2}/m1`, `${N1}/m2`]);
  });

  test("with no free number the second campaign's SMS track is held and listed; a late reply on the first conversation reaches the first campaign after it ended", async () => {
    const { h, campaign, texts } = await world();
    h.clock = MONDAY_9;
    const a = await campaign("A", [track("t1", "sms", [text("m1")])], [N1]);
    await h.advanceTo(MONDAY_9 + H);
    expect((await h.progress(a("Pat Oneil"))).status).toBe("sequence_finished_no_response");
    const b = await campaign("B", [track("t1", "sms", [text("m1")])], [N1]);
    await h.advanceTo(MONDAY_9 + 2 * H);
    expect(texts(PAT_MOBILE).map((d) => d.sender)).toEqual([N1]);
    const held = await h.progress(b("Pat Oneil"));
    expect(held.status).toBe("queued");
    expect(held.tracks[0]?.hold).toBe("sms_conversation_taken");
    const attention = (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body;
    expect(attention.heldTracks).toContainEqual({ enrollmentId: b("Pat Oneil"), trackId: "t1", reason: "sms_conversation_taken" });
    h.sms.prospectTexts(PAT_MOBILE, "Late answer");
    await h.advanceTo(MONDAY_9 + 3 * H);
    expect((await h.progress(a("Pat Oneil"))).status).toBe("replied");
    expect((await h.progress(b("Pat Oneil"))).status).toBe("queued");
  });

  test("two campaigns racing for one conversation: only one is ever texted from that number, and the other is held", async () => {
    const { h, texts } = await world({ numbers: [number(N1)] });
    h.clock = MONDAY_9;
    const ids: string[] = [];
    // Both launch while their window is closed; it opens at 10:00 and both claim on the one number.
    const tenToFive = [{ day: 1, start: 10, end: 17 }];
    for (const name of ["A", "B"]) {
      const { campaign: c } = await h.createCampaign(name, { businesses: [BUSINESSES[0]!], people: [PEOPLE[0]!] });
      await h.defineSequence(c.id, definition([track("t1", "sms", [text("m1")], { kind: "entry" }, tenToFive)], [N1]));
      expect((await h.launch(c.id)).status).toBe(200);
      ids.push(c.id);
    }
    // Another worker runs its handovers while this one waits between a claim and its handover.
    let raced = false;
    h.hooks = {
      beforeHandover: async () => {
        if (raced) return;
        raced = true;
        await h.otherWorker();
      },
    };
    await h.advanceTo(MONDAY_9 + 3 * H);
    expect(raced).toBe(true);
    expect(texts(PAT_MOBILE)).toHaveLength(1);
    const holds = [];
    for (const id of ids) {
      const row = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${id}`)).body.rows[0]!;
      holds.push((await h.progress(row.enrollments.find((e) => e.campaign.id === id)!.id)).tracks[0]?.hold ?? null);
    }
    expect(holds.filter((x) => x === "sms_conversation_taken")).toHaveLength(1);
  });
});

describe("a conversation another worker takes while this one evaluates (review bot on 5ca8c5e)", () => {
  test("the evaluation applies with the other campaign's new binding kept, the tick does not fail, and the lead texts from another number", async () => {
    const { h, campaign, texts } = await world({ people: [PEOPLE[0]!], businesses: [BUSINESSES[0]!] });
    h.clock = MONDAY_9;
    // Campaign A: an email, then a text one day after it. Campaign B: a text, whose window opens on Tuesday.
    const a = await campaign("A", [track("t1", "email", [email("s1")]), track("t2", "sms", [text("m1")], after("t1", 1))]);
    const b = await campaign("B", [track("t1", "sms", [text("m1")], { kind: "entry" }, [{ day: 2, start: 0, end: 24 }])]);
    await h.advanceTo(MONDAY_9 + 2 * H);
    // At Tuesday 00:00 A's text track starts. Between that evaluation and its commit, another process,
    // which leaves A alone, claims and hands over B's text: B takes the conversation from N1.
    let other = 0;
    const otherProcess = new Engine({
      store: h.store.engine,
      port: h.provider,
      smsPort: h.sms,
      now: () => h.clock,
      newId: () => `other-${++other}`,
      ticks: new TickQueue(),
      waitFor: quickWait,
      rules: { evaluate: (s, now, options) => (s.subject.id === a("Pat Oneil") ? s : DEFAULT_RULES.evaluate(s, now, options)), readyItems: (s, now) => (s.subject.id === a("Pat Oneil") ? [] : DEFAULT_RULES.readyItems(s, now)) },
    });
    let raced = false;
    h.hooks = {
      beforeApplyEvaluation: async (id) => {
        if (raced || id !== a("Pat Oneil")) return;
        raced = true;
        await otherProcess.tick();
      },
    };
    await h.advanceTo(Date.parse("2026-11-03T06:00:00Z"));
    expect(raced).toBe(true);
    expect(texts(PAT_MOBILE).map((d) => [d.subjectId, d.sender])).toEqual([[b("Pat Oneil"), N1], [a("Pat Oneil"), N2]]);
    const pat = await h.progress(a("Pat Oneil"));
    expect(pat.tracks.find((t) => t.trackId === "t2")).toMatchObject({ started: true, finishReason: "completed" });
    expect((await h.progress(b("Pat Oneil"))).smsSender).toBe(N1);
  });
});

describe("SMS sending: windows, capacity across campaigns and priority (spec: Pace, capacity and timing)", () => {
  test("a text due outside its window waits for the prospect's local window", async () => {
    const { h, campaign, texts } = await world({ people: [person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", timezone: "America/New_York", dial_phone: PAT_MOBILE, dial_phone_type: "mobile" })], businesses: [BUSINESSES[0]!] });
    h.clock = MONDAY_9;
    await campaign("Windows", [track("t1", "sms", [text("m1")], { kind: "entry" }, [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })))]);
    await h.advanceTo(MONDAY_9 + DAY);
    // 09:00 in New York on Monday 2 November is 14:00 UTC.
    expect(texts(PAT_MOBILE).map((d) => new Date(d.at).toISOString())).toEqual(["2026-11-02T14:00:00.000Z"]);
  });

  test("a number's daily capacity holds across campaigns; follow-ups go first, oldest due first; the rest waits for the next day and new leads stay queued", async () => {
    const people = ["Ada", "Ben", "Cat", "Dev"].map((first, i) => person({ person_id: `q${i}`, business_id: "b1", full_name: `${first} Hart`, dial_phone: `+4477009002${i}0`, dial_phone_type: "mobile" }));
    const { h, campaign } = await world({ numbers: [number(N1, { capacity: 2, gapMs: MIN })], people, businesses: [BUSINESSES[0]!] });
    h.clock = MONDAY_9;
    const a = await campaign("A", [track("t1", "sms", [text("m1"), text("m2", 1)])], [N1], { businesses: [BUSINESSES[0]!], people: people.slice(0, 2) });
    // Campaign B launches an hour later, so its first texts fall due after campaign A's.
    await h.advanceTo(MONDAY_9 + H);
    const b = await campaign("B", [track("t1", "sms", [text("m1")])], [N1], { businesses: [BUSINESSES[0]!], people: people.slice(2) });
    await h.advanceTo(MONDAY_9 + 2 * H);
    const day = (t: number) => new Date(t).toISOString().slice(0, 10);
    const perDay = (d: string) => h.sms.deliveryLog.filter((x) => day(x.at) === d);
    expect(perDay("2026-11-02")).toHaveLength(2);
    // Campaign B's leads have had nothing yet: they are queued, waiting for capacity.
    expect((await h.progress(b("Cat Hart"))).status).toBe("queued");
    await h.advanceTo(MONDAY_9 + 4 * DAY);
    // Tuesday: campaign A's follow-ups (touched leads) before campaign B's first texts.
    expect(perDay("2026-11-03").map((x) => x.stepId)).toEqual(["m2", "m2"]);
    expect(perDay("2026-11-04")).toHaveLength(2);
    for (const d of ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"]) expect(perDay(d).length).toBeLessThanOrEqual(2);
    expect((await h.progress(a("Ada Hart"))).status).toBe("sequence_finished_no_response");
    expect((await h.progress(b("Dev Hart"))).status).toBe("sequence_finished_no_response");
  });
});

describe("priority when a lead has items on two channels at once (found by the generated test's priority check)", () => {
  test("a lead's second ready item is still claimed in its priority turn after its first item's claim in the same pass", async () => {
    // One number that holds one text in flight, one inbox that holds two emails in flight. Three
    // leads, each with an email and a text due at launch.
    const people = ["Ada", "Ben", "Cat"].map((first, i) => person({ person_id: `q${i}`, business_id: "b1", full_name: `${first} Hart`, email: `${first.toLowerCase()}@harbour.example`, dial_phone: `+4477009002${i}0`, dial_phone_type: "mobile" }));
    const h = new EngineHarness({
      start: MONDAY_9 - H,
      accounts: [{ id: "inbox-a", capacity: 50, gapMs: 10 * MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
      sms: { numbers: [number(N1, { k: 1, gapMs: 10 * MIN })] },
    });
    await h.tick();
    const { campaign: c } = await h.createCampaign("Two channels", { businesses: [BUSINESSES[0]!], people });
    await h.defineSequence(c.id, definition([track("t1", "sms", [text("m1")]), track("t2", "email", [email("s1")])], [N1]));
    h.clock = MONDAY_9;
    expect((await h.launch(c.id)).status).toBe(200);
    const ids = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows.map((r) => r.enrollments[0]!.id);
    // Priority among equals is by subject id: the two emails in flight belong to the first two.
    const byPriority = [...ids].sort((a, b) => (a < b ? -1 : 1));
    const inFlight = (await h.store.engine.openAttempts()).filter((a) => a.accountId === "inbox-a").map((a) => a.subjectId);
    const called = h.fake.handoverLog.map((x) => x.subjectId);
    expect([...new Set([...called, ...inFlight])].slice(0, 2).sort()).toEqual(byPriority.slice(0, 2));
  });
});

describe("sender checks and Needs attention cover SMS", () => {
  test("a disconnected SMS number is listed in Needs attention, and its leads wait on it without being dropped", async () => {
    const { h, campaign, texts } = await world({ numbers: [number(N1)] });
    h.clock = MONDAY_9;
    const lead = await campaign("Disconnected", [track("t1", "sms", [text("m1"), text("m2", 1)])], [N1]);
    await h.advanceTo(MONDAY_9 + H);
    h.sms.numbers.get(N1)!.healthy = false;
    await h.advanceTo(MONDAY_9 + 2 * DAY);
    expect(texts(PAT_MOBILE).map((d) => d.stepId)).toEqual(["m1"]);
    const attention = (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body;
    expect(attention.senderProblems).toEqual([{ accountId: N1, channel: "sms", label: "Simulated SMS (not a provider) +44 7700 900001", problem: "disconnected" }]);
    // A number the provider stops listing is disconnected too.
    h.sms.numbers.get(N1)!.healthy = true;
    h.sms.numbers.get(N1)!.listed = false;
    await h.advanceTo(MONDAY_9 + 3 * DAY);
    expect((await h.request<NeedsAttention>("GET", "/api/needs-attention")).body.senderProblems).toEqual([{ accountId: N1, channel: "sms", label: "Simulated SMS (not a provider) +44 7700 900001", problem: "not_listed" }]);
    expect(texts(PAT_MOBILE).map((d) => d.stepId)).toEqual(["m1"]);
    h.sms.numbers.get(N1)!.listed = true;
    await h.advanceTo(MONDAY_9 + 4 * DAY);
    expect(texts(PAT_MOBILE).map((d) => d.stepId)).toEqual(["m1", "m2"]);
    expect((await h.progress(lead("Pat Oneil"))).status).toBe("sequence_finished_no_response");
  });

  test("the launch check names no connected sender per channel", async () => {
    const { h } = await world({ numbers: [] });
    const { campaign } = await h.createCampaign("No numbers", { businesses: BUSINESSES, people: PEOPLE });
    const view: SequenceView = await h.defineSequence(campaign.id, definition([track("t1", "email", [email("s1")]), track("t2", "sms", [text("m1")])]));
    expect(view.launch.blockers.map((b) => b.message)).toEqual(["The SMS track has no connected sender number."]);
    expect((await h.launch(campaign.id)).status).toBe(409);
  });
});
