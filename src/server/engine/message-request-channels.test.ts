import { describe, expect, test } from "vitest";
import { socialAccountId } from "./ports.ts";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { FakeSocialSession } from "../../../test/support/fake-social-port.ts";
import { businessAccountCell, exampleAccount, personAccountCell } from "../../../test/support/message-request-accounts.ts";
import { MESSAGE_REQUEST_CHANNELS, type MessageRequestChannel } from "../../domain/social-channels.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { ActivityView, BeforeLaunchView, CampaignMeasures, EnrollmentProgress, EnrollmentRead, LeadSearchResult, NeedsAttention, RecordControls, SocialProvidersStatus } from "../../shared/api.ts";
import { noUsableChannelItem } from "../../web/calls/interruption.ts";
import { nextStepSentence, outgoingSoFar } from "../../web/controls/wording.ts";

/**
 * A message-request track (ADR 0004 section 13: Instagram, ticket 25; section 14: Facebook, ticket 26) through the real HTTP
 * app, SQLite store and engine, against the channel's simulated provider beside the fake email provider. Every test runs
 * once per message-request channel; the last group runs both channels in one campaign. No session of either channel is
 * connected: the simulated providers are test doubles, not integrations. Every account here is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
/** Monday 2 November 2026, 09:00 London (GMT). */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const S1 = "session-1";

/**
 * Each channel's words and forms as the user reads them, written here by hand so the sentences below are checked against
 * the wording the principal reviews, not recomputed from the registry the code reads.
 */
const WORDS = {
  instagram: { Name: "Instagram", aName: "an Instagram", AName: "An Instagram", noun: "account", example: "https://www.instagram.com/your.name" },
  facebook: { Name: "Facebook", aName: "a Facebook", AName: "A Facebook", noun: "profile", example: "https://www.facebook.com/your.name" },
} as const satisfies Record<MessageRequestChannel, { Name: string; aName: string; AName: string; noun: string; example: string }>;

const step = (id: string, waitDays: number, body: string): StepDefinition => ({ id, waitDays, subject: "", body, threading: "new_subject", removed: false });
const emailTrack = (id: string, start: TrackDefinition["start"] = { kind: "entry" }): TrackDefinition => ({
  id,
  channel: "email",
  branch: "main",
  window: ALWAYS,
  steps: [{ id: `${id}-1`, waitDays: 0, subject: "Hello {{first_name|there}}", body: "Email for {{company}}.", threading: "new_subject", removed: false }],
  start,
  removed: false,
});
const session = (id: string, fields: Partial<FakeSocialSession> = {}): FakeSocialSession => ({ id, kind: "business", gapMs: MIN, k: 1, healthy: true, resetZone: "Europe/London", ...fields });
const three = () => [step("m1", 0, "Hello {{first_name|there}}, I work with clinics like {{company}}."), step("m2", 2, "Following up."), step("m3", 3, "Last note.")];

describe.each(MESSAGE_REQUEST_CHANNELS.map((channel) => [WORDS[channel].Name, channel] as const))("%s", (_name, channel: MessageRequestChannel) => {
const W = WORDS[channel];
const PAT_OWN = exampleAccount(channel, "pat.oneil");
const HARBOUR = exampleAccount(channel, "harbour.physio");
const NORTHGATE = exampleAccount(channel, "northgate.dental");
const PAT_NEW = exampleAccount(channel, "pat.new");
const own = (value: string) => personAccountCell(channel, value);
const company = (value: string) => businessAccountCell(channel, value);
const mrTrack = (id: string, steps: StepDefinition[], start: TrackDefinition["start"] = { kind: "entry" }): TrackDefinition => ({ id, channel, branch: "main", window: ALWAYS, steps, start, removed: false });
/** The user's chosen senders go on each track of the channel (ADR 0004 13.5). */
const definition = (tracks: TrackDefinition[], pool = [socialAccountId(channel, S1)]): CampaignDefinition => ({
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["inbox-a"],
  smsPool: [],
  tracks: tracks.map((t) => (t.channel === channel ? { ...t, senders: t.senders ?? pool } : t)),
});

const BUSINESSES = [
  business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101", ...company(HARBOUR) }),
  business({ business_id: "b2", business_name: "Northgate Dental", phone_e164: "+442079460202", ...company(`${NORTHGATE}/`) }),
  business({ business_id: "b3", business_name: "Quayside Clinic", phone_e164: "+442079460303", ...company(`https://${channel}.example/quayside`) }),
  business({ business_id: "b4", business_name: "Elm Street Practice", phone_e164: "+442079460404", ...company("") }),
];
const PEOPLE = [
  // Their own account (the people file's optional column, questions Q43 and Q48): preferred to the company's.
  person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", ...own(PAT_OWN) }),
  // No own account: the company's.
  person({ person_id: "p2", business_id: "b2", full_name: "Nia Cole", email: "nia@northgate.example", ...own("") }),
  // The company's cell is not an account, and no own: missing, not an account.
  person({ person_id: "p3", business_id: "b3", full_name: "Sam Lee", email: "sam@quayside.example", ...own("") }),
  // Nothing in either file: missing.
  person({ person_id: "p4", business_id: "b4", full_name: "Kim Hart", email: "kim@elm.example", ...own("") }),
];

async function world(options: { messagesPerDay?: number | null; sessions?: FakeSocialSession[]; people?: typeof PEOPLE; businesses?: typeof BUSINESSES } = {}) {
  const h = new EngineHarness({
    start: MONDAY_9 - H,
    accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    social: { [channel]: { sessions: options.sessions ?? [session(S1)] } },
  });
  await h.tick();
  const perDay = options.messagesPerDay === undefined ? 20 : options.messagesPerDay;
  for (const s of options.sessions ?? [session(S1)]) {
    if (perDay !== null) expect((await h.request("PUT", `/api/sender-accounts/${socialAccountId(channel, s.id)}/allowances`, { invitesPerDay: 0, messagesPerDay: perDay, notesPerMonth: 0 })).status).toBe(200);
  }
  const campaign = async (tracks: TrackDefinition[], name: string = W.Name, pool?: string[]) => {
    const { campaign: c } = await h.createCampaign(name, { businesses: options.businesses ?? BUSINESSES, people: options.people ?? PEOPLE });
    await h.defineSequence(c.id, definition(tracks, pool));
    if (h.clock < MONDAY_9) h.clock = MONDAY_9;
    const launched = await h.launch(c.id);
    if (launched.status !== 200) throw new Error(`launch refused: ${JSON.stringify(launched.body)}`);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
    const lead = (name: string) => rows.find((r) => r.name === name)?.enrollments.find((e) => e.campaign.id === c.id)?.id ?? "";
    return { id: c.id, lead };
  };
  const delivered = (account: string) => h.social(channel).deliveryLog.filter((d) => d.destination === account);
  const progress = (id: string) => h.request<EnrollmentRead>("GET", `/api/enrollments/${id}`).then((r) => r.body);
  return { h, campaign, delivered, progress };
}

describe("the message request and its follow-ups (ADR 0004 13.3, 13.4)", () => {
  test("text only, to the decision maker's own account, else the company's; follow-ups after their waits; nothing promised after", async () => {
    const { h, campaign, delivered, progress } = await world();
    const c = await campaign([mrTrack("ig", three())]);
    await h.advanceTo(MONDAY_9 + H);
    // Pat's own account, never the company's: the decision maker's own when the CSV has one.
    expect(delivered(PAT_OWN).map((d) => [d.stepId, d.rendered.subject, d.rendered.body])).toEqual([["m1", "", "Hello Pat, I work with clinics like Harbour Lane Physio."]]);
    expect(delivered(HARBOUR)).toEqual([]);
    // Nia has none of her own: her company's account, normalised from its trailing slash.
    expect(delivered(NORTHGATE).map((d) => d.stepId)).toEqual(["m1"]);
    // Each message action is a message; the simulated provider was never asked for an invite.
    expect(h.social(channel).handoverLog.every((x) => x.action === "message")).toBe(true);
    // The read says what the engine knows: the first message sent, to whose account, from which session; nothing about acceptance.
    const pat = await progress(c.lead("Pat Oneil"));
    const track = pat.tracks.find((t) => t.trackId === "ig");
    expect(track?.messageRequest).toEqual({ destination: "own", address: PAT_OWN, firstMessage: "sent", sender: { id: socialAccountId(channel, S1), kind: "business" }, skipCause: null });
    expect((await progress(c.lead("Nia Cole"))).tracks.find((t) => t.trackId === "ig")?.messageRequest?.destination).toBe("company");
    // Follow-ups after their waits: two calendar days, then three.
    await h.advanceTo(MONDAY_9 + 6 * DAY);
    expect(delivered(PAT_OWN).map((d) => d.stepId)).toEqual(["m1", "m2", "m3"]);
    const days = delivered(PAT_OWN).map((d) => Math.round((d.at - MONDAY_9) / DAY));
    expect(days).toEqual([0, 2, 5]);
    expect((await progress(c.lead("Pat Oneil"))).status).toBe("sequence_finished_no_response");
  });

  test("with no usable account the track is skipped with its cause recorded, and the lead's other tracks carry on", async () => {
    const { h, campaign, progress } = await world();
    const c = await campaign([mrTrack("ig", three()), emailTrack("em", { kind: "after", trackId: "ig", delayDays: 0 })]);
    await h.advanceTo(MONDAY_9 + H);
    const sam = await progress(c.lead("Sam Lee"));
    const kim = await progress(c.lead("Kim Hart"));
    expect(sam.tracks.find((t) => t.trackId === "ig")).toMatchObject({ finishReason: "skipped_missing_channel", messageRequest: { skipCause: "not_a_member_profile", destination: null } });
    expect(kim.tracks.find((t) => t.trackId === "ig")).toMatchObject({ finishReason: "skipped_missing_channel", messageRequest: { skipCause: "no_profile" } });
    // The email track after it starts at once for them: a skipped track counts as finished.
    expect(h.fake.deliveryLog.filter((d) => d.destination === "sam@quayside.example").map((d) => d.stepId)).toEqual(["em-1"]);
    expect(h.fake.deliveryLog.filter((d) => d.destination === "kim@elm.example").map((d) => d.stepId)).toEqual(["em-1"]);
    // Pat, with an account, still waits for the channel's track to finish before the email.
    expect(h.fake.deliveryLog.filter((d) => d.destination === "pat@harbour.example")).toEqual([]);
  });

  test("a company lead messages the company's own account", async () => {
    const { h, campaign, delivered } = await world({ people: [] });
    await campaign([mrTrack("ig", [step("m1", 0, "Hello {{company}}.")])]);
    await h.advanceTo(MONDAY_9 + H);
    expect(delivered(HARBOUR).map((d) => d.rendered.body)).toEqual(["Hello Harbour Lane Physio."]);
    expect(delivered(NORTHGATE)).toHaveLength(1);
  });
});

describe("refusals and lost answers (ADR 0004 13.3)", () => {
  test("an unreachable account is marked bad and fails the track; a not-allowed one fails it and stays good", async () => {
    const { h, campaign, delivered, progress } = await world();
    h.social(channel).accountsScript.set(PAT_OWN, { unreachable: true });
    h.social(channel).accountsScript.set(NORTHGATE, { notAllowed: true });
    const c = await campaign([mrTrack("ig", three()), emailTrack("em")]);
    await h.advanceTo(MONDAY_9 + H);
    const pat = (await progress(c.lead("Pat Oneil"))).tracks.find((t) => t.trackId === "ig");
    const nia = (await progress(c.lead("Nia Cole"))).tracks.find((t) => t.trackId === "ig");
    expect(pat).toMatchObject({ finishReason: "failed_bad_destination" });
    expect(pat?.steps[0]).toMatchObject({ result: "failed", reason: "account unreachable" });
    expect(nia).toMatchObject({ finishReason: "failed_bad_destination" });
    expect(nia?.steps[0]).toMatchObject({ result: "failed", reason: "not allowed" });
    expect(delivered(PAT_OWN)).toEqual([]);
    // The email track beside it went for both: a failed track of the channel ends neither lead.
    expect(h.fake.deliveryLog.map((d) => d.destination).sort()).toContain("nia@northgate.example");
    // A second campaign: Pat's own account is marked bad, so the company's is Pat's destination now; Northgate's is still good.
    const second = await campaign([mrTrack("ig2", [step("x1", 0, "Hello again.")])], "Second");
    await h.advanceTo(h.clock + H);
    expect(delivered(HARBOUR).map((d) => d.stepId)).toEqual(["x1"]);
    expect((await progress(second.lead("Nia Cole"))).tracks.find((t) => t.trackId === "ig2")?.finishReason).toBe("failed_bad_destination");
  });

  test("a lost answer is found by a lookup and the message is never handed over twice", async () => {
    const { h, campaign, delivered, progress } = await world();
    h.social(channel).accountsScript.set(PAT_OWN, { loseAnswer: 1 });
    const c = await campaign([mrTrack("ig", three())]);
    await h.advanceTo(MONDAY_9 + 3 * H);
    expect(h.social(channel).handoverLog.filter((x) => x.destination === PAT_OWN && x.stepId === "m1")).toHaveLength(1);
    expect(h.social(channel).lookupLog.some((l) => l.answer === "sent")).toBe(true);
    expect((await progress(c.lead("Pat Oneil"))).tracks.find((t) => t.trackId === "ig")?.messageRequest?.firstMessage).toBe("sent");
    await h.advanceTo(MONDAY_9 + 3 * DAY);
    expect(delivered(PAT_OWN).map((d) => d.stepId)).toEqual(["m1", "m2"]);
  });
});

describe("a message handed over whose answer is not known (verifier on f2824d4, item 10)", () => {
  test("delivered, its answer lost and the lookup still unknown: the record never says nothing has gone out", async () => {
    const { h, campaign, delivered } = await world({ people: [PEOPLE[0]!], businesses: [BUSINESSES[0]!] });
    h.social(channel).accountsScript.set(PAT_OWN, { loseAnswer: 1, lookupUnknown: 1_000 });
    const c = await campaign([mrTrack("ig", three())]);
    await h.advanceTo(MONDAY_9 + 2 * H);
    // The simulated session's log shows it delivered; the engine cannot know yet.
    expect(delivered(PAT_OWN).map((d) => d.stepId)).toEqual(["m1"]);
    const person = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows[0]!.id;
    const record = (await h.request<RecordControls>("GET", `/api/people/${person}`)).body;
    const lead = record.leads.find((l) => l.id === c.lead("Pat Oneil"))!;
    expect(outgoingSoFar(lead)).toEqual({ state: "unknown", channel });
    const sentence = nextStepSentence(lead, record.userZone);
    expect(sentence).toMatch(new RegExp(`^${W.AName} message was handed over, and it isn’t known yet whether it went\\.`));
    expect(sentence).not.toContain("Nothing has gone out");
  });
});

describe("allowances, capacity and priority (ADR 0004 13.7)", () => {
  test("an unset allowance sends nothing and reads as no allowance, never a time", async () => {
    const { h, campaign, delivered, progress } = await world({ messagesPerDay: null });
    const c = await campaign([mrTrack("ig", three())]);
    await h.advanceTo(MONDAY_9 + 2 * DAY);
    expect(h.social(channel).deliveryLog).toEqual([]);
    const next = (await progress(c.lead("Pat Oneil"))).tracks.find((t) => t.trackId === "ig")?.nextStep;
    // The engine's `sending_capacity`, read as the user's own setting: no allowance (ticket 24b, item 15; ADR 0004 13.7).
    expect(next?.when).toEqual({ kind: "waits", why: "no_allowance", channel });
    expect(delivered(PAT_OWN)).toEqual([]);
  });

  test("one message a day per session: follow-ups first, then the oldest due, overflow to the next day", async () => {
    const { h, campaign, delivered } = await world({ messagesPerDay: 1 });
    await campaign([mrTrack("ig", [step("m1", 0, "One."), step("m2", 1, "Two.")])]);
    await h.advanceTo(MONDAY_9 + 12 * H);
    // Monday: one message only, Nia's or Pat's first.
    expect(h.social(channel).deliveryLog).toHaveLength(1);
    const first = h.social(channel).deliveryLog[0]!.destination;
    const other = first === PAT_OWN ? NORTHGATE : PAT_OWN;
    // Tuesday: the touched lead's follow-up goes before the other's first message.
    await h.advanceTo(MONDAY_9 + DAY + 12 * H);
    expect(h.social(channel).deliveryLog.map((d) => [d.destination, d.stepId])).toEqual([
      [first, "m1"],
      [first, "m2"],
    ]);
    await h.advanceTo(MONDAY_9 + 3 * DAY + 12 * H);
    expect(delivered(other).map((d) => d.stepId)).toEqual(["m1", "m2"]);
  });
});

describe("ownership of a conversation (ADR 0004 13.6)", () => {
  test("two decision makers of one company share its account: the first owns it, the second is skipped naming the owner", async () => {
    const people = [
      person({ person_id: "p2", business_id: "b2", full_name: "Nia Cole", email: "nia@northgate.example" }),
      person({ person_id: "p5", business_id: "b2", full_name: "Ola Berg", email: "ola@northgate.example" }),
    ];
    const { h, campaign, delivered, progress } = await world({ people });
    const c = await campaign([mrTrack("ig", [step("m1", 0, "Hello.")])]);
    await h.advanceTo(MONDAY_9 + 3 * H);
    expect(delivered(NORTHGATE)).toHaveLength(1);
    const owner = delivered(NORTHGATE)[0]!.subjectId;
    const skippedName = owner === c.lead("Nia Cole") ? "Ola Berg" : "Nia Cole";
    const skipped = (await progress(c.lead(skippedName))).tracks.find((t) => t.trackId === "ig");
    const ownerName = skippedName === "Nia Cole" ? "Ola Berg" : "Nia Cole";
    // A colleague in this same campaign owns it: named as that lead, never as "another campaign" (verifier on f2824d4, item 9).
    expect(skipped).toMatchObject({ finishReason: "skipped_conversation_taken", conversationOwners: [{ name: W.Name, test: false, lead: ownerName }] });
    // Today reads the same owner, and says it in the channel's own words.
    const today = (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body.noUsableChannel.find((x) => x.enrollmentId === c.lead(skippedName));
    expect(today?.channels).toEqual([{ channel, why: "conversation_taken", owners: [{ name: W.Name, test: false, lead: ownerName }] }]);
    expect(noUsableChannelItem(today ? [today] : [], "2026-11-02", "Europe/London")?.body).toContain(`Now their ${W.Name} account is in ${W.aName} conversation (a message request or a follow-up) with ${ownerName}, a lead of this campaign, on every ${W.Name} session this campaign can use.`);
  });

  test("Before launch counts the leads that share a company's account, from the read: five colleagues at one company, two at another, and a person with their own (verifier on f2824d4, item 4)", async () => {
    const colleagues = ["Nia Cole", "Ola Berg", "Uma Reid", "Ivo Marsh", "Eli Grant"].map((n, i) => person({ person_id: `n${i}`, business_id: "b2", full_name: n, email: `n${i}@northgate.example`, ...own("") }));
    const harbour = ["Ana Holt", "Ben Fry"].map((n, i) => person({ person_id: `h${i}`, business_id: "b1", full_name: n, email: `h${i}@harbour.example`, ...own("") }));
    const { h } = await world({ people: [PEOPLE[0]!, ...colleagues, ...harbour] });
    const { campaign: c } = await h.createCampaign("Shared", { businesses: BUSINESSES, people: [PEOPLE[0]!, ...colleagues, ...harbour] });
    await h.defineSequence(c.id, definition([mrTrack("ig", three())]));
    const view = (await h.request<BeforeLaunchView>("GET", `/api/campaigns/${c.id}/before-launch`)).body;
    // Pat goes to their own account; seven go to a company's: five share Northgate's, two Harbour's.
    expect(view.coverage.social[channel]).toEqual({ own: 1, company: 7, shared: { accounts: 2, leads: 7 } });
  });

  test("a second campaign on the same session is skipped for an account the first reached; a person's own account and their company's are two", async () => {
    const { h, campaign, delivered, progress } = await world();
    await campaign([mrTrack("ig", [step("m1", 0, "First.")])], "First");
    await h.advanceTo(MONDAY_9 + H);
    const second = await campaign([mrTrack("ig2", [step("x1", 0, "Second.")])], "Second");
    await h.advanceTo(h.clock + 2 * H);
    // Nia's company account was reached by the first campaign: the second skips her, naming it.
    expect((await progress(second.lead("Nia Cole"))).tracks.find((t) => t.trackId === "ig2")).toMatchObject({ finishReason: "skipped_conversation_taken", conversationOwners: [{ name: "First", test: false, lead: null }] });
    expect(delivered(NORTHGATE).map((d) => d.stepId)).toEqual(["m1"]);
    expect(delivered(PAT_OWN).map((d) => d.stepId)).toEqual(["m1"]);
    // Harbour's own account was never reached (Pat went to their own): another destination, free.
    expect(delivered(HARBOUR)).toEqual([]);
  });

  test("a pair's channel is stored: an SMS conversation and one on this channel never read each other", async () => {
    const { h, campaign } = await world();
    await campaign([mrTrack("ig", [step("m1", 0, "Hello.")])]);
    await h.advanceTo(MONDAY_9 + H);
    const db = (h.store.engine as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    const channels = db.prepare("SELECT DISTINCT channel FROM sms_bindings").all().map((r) => r["channel"]);
    expect(channels).toEqual([channel]);
  });
});

describe("the reply mark (ADR 0004 13.8)", () => {
  test("refused before anything reached them; then it stops only that lead in that campaign, said as marked by the user", async () => {
    const { h, campaign, progress } = await world();
    const c = await campaign([mrTrack("ig", three()), emailTrack("em")]);
    const pat = c.lead("Pat Oneil");
    await h.advanceTo(MONDAY_9 + H);
    // Kim has no account: nothing reached them on the channel, so there is no reply there to mark.
    const kim = await h.request("POST", `/api/enrollments/${c.lead("Kim Hart")}/replies`, { requestId: "r0", channel });
    expect(kim.status).toBe(409);
    expect(JSON.stringify(kim.body)).toContain(`Nothing has been sent to them on ${W.Name} in this campaign`);
    const before = await progress(pat);
    expect(before.replyMarks[channel]).toEqual({ allowed: true, work: { kind: "message", state: "sent" } });
    // A LinkedIn mark is refused: nothing went to them on LinkedIn, and no campaign track is there either.
    expect((await h.request("POST", `/api/enrollments/${pat}/replies`, { requestId: "r1", channel: "linkedin" })).status).toBe(409);
    const marked = await h.request<{ enrollment: EnrollmentProgress }>("POST", `/api/enrollments/${pat}/replies`, { requestId: "r2", channel, expect: { status: before.status } });
    expect(marked.status).toBe(200);
    expect(marked.body.enrollment).toMatchObject({ status: "replied", reply: { channel } });
    await h.advanceTo(MONDAY_9 + 6 * DAY);
    expect(h.social(channel).deliveryLog.filter((d) => d.subjectId === pat).map((d) => d.stepId)).toEqual(["m1"]);
    // Nia carries on.
    expect(h.social(channel).deliveryLog.filter((d) => d.subjectId === c.lead("Nia Cole")).map((d) => d.stepId)).toEqual(["m1", "m2", "m3"]);
    const personId = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows.find((r) => r.name === "Pat Oneil")?.id ?? "";
    const activity = (await h.request<ActivityView>("GET", `/api/people/${personId}/activity`)).body;
    // Activity says the mark from its stored record: a reply on the channel the user marked, never a detected one.
    expect(activity.entries.filter((e) => e.kind === "replied" && e.channel === channel)).toHaveLength(1);
    expect(activity.entries.filter((e) => e.kind === "sent" && e.channel === channel)).toHaveLength(1);
    const m = (await h.request<CampaignMeasures>("GET", `/api/campaigns/${c.id}/measures`)).body;
    expect(m.channels).toContain(channel);
    expect(m.messageRequests[channel]).toMatchObject({ messagesSent: 4, failed: 0, replies: 1 });
  });
});

describe("the running application (ADR 0004 13.1)", () => {
  test("lists no session of the channel, so its track meets launch blocker 3, and presents no connection", async () => {
    const h = new EngineHarness({ start: MONDAY_9, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
    await h.tick();
    const { campaign: c } = await h.createCampaign("No session", { businesses: BUSINESSES, people: PEOPLE });
    await h.defineSequence(c.id, definition([mrTrack("ig", [step("m1", 0, "Hello.")])], []));
    const launched = await h.launch(c.id);
    expect(launched.status).toBe(409);
    expect(JSON.stringify(launched.body)).toContain(`The ${W.Name} track has no connected ${W.Name} session.`);
    const providers = (await h.request<SocialProvidersStatus>("GET", "/api/social-providers")).body;
    expect(providers[channel]).toEqual({ provider: "none", message: `No ${W.Name} session is connected, so ${W.Name} tracks cannot launch.` });
  });
});

describe("test runs to the user's own account (ADR 0004 13.8)", () => {
  const OWN_TEST = exampleAccount(channel, "my.test.account");

  test("an account a person's or company's record holds is refused; the run messages the test account with minute waits, and its mark ends only the run", async () => {
    const { h, campaign } = await world({ messagesPerDay: 20 });
    const c = await campaign([mrTrack("ig", three())]);
    // The boundary: a lead's own account, and a company's, are refused; an address that is not an account is refused.
    expect((await h.request("PUT", `/api/campaigns/${c.id}/test-contacts`, { email: "", mobile: "", [channel]: PAT_OWN })).status).toBe(409);
    expect((await h.request("PUT", `/api/campaigns/${c.id}/test-contacts`, { email: "", mobile: "", [channel]: HARBOUR })).status).toBe(409);
    const bad = await h.request("PUT", `/api/campaigns/${c.id}/test-contacts`, { email: "", mobile: "", [channel]: "@example.my.test.account" });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain(`Give your ${W.Name} ${W.noun}'s address, such as ${W.example}.`);
    const saved = await h.request<{ contacts: { social: Record<MessageRequestChannel, { address: string | null }> }; definitionVersion: number }>("PUT", `/api/campaigns/${c.id}/test-contacts`, { email: "", mobile: "", [channel]: OWN_TEST });
    expect([saved.status, JSON.stringify(saved.body).slice(0, 300)]).toEqual([200, expect.anything()]);
    expect(saved.body.contacts.social[channel].address).toBe(OWN_TEST);
    const run = await h.request<{ run: { id: string } }>("POST", `/api/campaigns/${c.id}/test-runs`, { requestId: "run-1", renderAs: c.lead("Pat Oneil"), expect: { definitionVersion: saved.body.definitionVersion } });
    expect(run.status).toBe(200);
    await h.advanceTo(h.clock + 10 * MIN);
    // Rendered for Pat, sent to the user's own account, each wait a minute.
    const toTest = h.social(channel).deliveryLog.filter((d) => d.destination === OWN_TEST);
    expect(toTest.map((d) => [d.stepId, d.rendered.body])).toEqual([
      ["m1", "Hello Pat, I work with clinics like Harbour Lane Physio."],
      ["m2", "Following up."],
      ["m3", "Last note."],
    ]);
    const runId = run.body.run.id;
    const marked = await h.request<{ run: { running: boolean; ending: string | null } }>("POST", `/api/test-runs/${runId}/replies`, { requestId: "tr-1", channel });
    expect(marked.status).toBe(200);
    expect(marked.body.run).toMatchObject({ running: false, ending: "your_reply" });
    const m = (await h.request<CampaignMeasures>("GET", `/api/campaigns/${c.id}/measures`)).body;
    expect(m.messageRequests[channel].fromTests).toEqual({ messagesSent: 3, failed: 0, replies: 1 });
  });
});

describe("the import (ADR 0004 13.4)", () => {
  test("a person whose only channel is their company's account is enrolled, and a re-import that replaces an account skips the track not finished", async () => {
    const { h, campaign, delivered, progress } = await world({ messagesPerDay: 20 });
    const people = [person({ person_id: "p9", business_id: "b2", full_name: "Lou Park" })];
    const c = await campaign([mrTrack("ig", [step("m1", 0, "One."), step("m2", 3, "Two.")])], `Only ${W.Name}`);
    const { campaign: only } = await h.createCampaign("Company account only", { businesses: BUSINESSES, people });
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${only.id}`)).body.rows;
    // Lou has no email, no mobile, no number of their own: the company's main line and its account on the channel still reach them.
    expect(rows.map((r) => r.name)).toEqual(["Lou Park"]);
    await h.advanceTo(MONDAY_9 + H);
    expect(delivered(PAT_OWN).map((d) => d.stepId)).toEqual(["m1"]);
    // Pat's own cell now names another account: the track started with the old one, which is no longer theirs.
    await h.reimport(c.id, { businesses: BUSINESSES, people: [person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", ...own(PAT_NEW) })] });
    await h.advanceTo(MONDAY_9 + 4 * DAY);
    const track = (await progress(c.lead("Pat Oneil"))).tracks.find((t) => t.trackId === "ig");
    expect(track).toMatchObject({ finishReason: "skipped_missing_channel", messageRequest: { skipCause: "replaced" } });
    expect(delivered(PAT_NEW)).toEqual([]);
  });
});

describe("the senders a track chooses (ADR 0004 13.5; the review of f2824d4, item 2)", () => {
  const S2 = "session-2";
  const id1 = socialAccountId(channel, S1);
  const id2 = socialAccountId(channel, S2);
  const senders = (v: { definition: CampaignDefinition }, track = "ig") => v.definition.tracks.find((t) => t.id === track)?.senders;
  type View = { definition: CampaignDefinition; definitionVersion: number; launch: { blockers: { kind: string; noneChosen?: boolean }[] }; accounts: { id: string; healthy: boolean; socialKind?: string | null }[] };

  test("a chosen pool survives a save, a reload, a second tab saving first, and sessions connecting or disconnecting; a new session is never added by itself", async () => {
    const { h } = await world({ sessions: [session(S1), session(S2, { kind: "personal" })] });
    const { campaign: c } = await h.createCampaign("Chosen senders", { businesses: BUSINESSES, people: PEOPLE });
    const url = `/api/campaigns/${c.id}/sequence`;
    const get = async () => (await h.request<View>("GET", url)).body;
    // Tab A chooses session 2 only on one track and both on another; the save keeps each track's own choice.
    const tracks = [{ ...mrTrack("ig", three()), senders: [id2] }, { ...mrTrack("ig2", [step("n1", 0, "Hello again.")], { kind: "after", trackId: "ig", delayDays: 0 }), senders: [id1, id2] }];
    const saved = await h.request<View>("PUT", url, { ...definition(tracks), save: { session: "A", seq: 1, base: 0 } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect([senders(saved.body), senders(saved.body, "ig2")]).toEqual([[id2], [id1, id2]]);
    // A reload reads the same choice, and the sessions with their kinds.
    const loaded = await get();
    expect([senders(loaded), senders(loaded, "ig2")]).toEqual([[id2], [id1, id2]]);
    expect(loaded.accounts.filter((a) => a.id.startsWith(`${channel}:`)).map((a) => [a.id, a.socialKind])).toEqual([[id1, "business"], [id2, "personal"]]);
    // Tab B, loaded at revision 1, edits a message and saves first: it carries the choice it loaded.
    const fromB = { ...loaded.definition, tracks: loaded.definition.tracks.map((t) => (t.id === "ig" ? { ...t, steps: t.steps.map((s, i) => (i === 0 ? { ...s, body: "Edited in tab B." } : s)) } : t)) };
    expect((await h.request("PUT", url, { ...fromB, save: { session: "B", seq: 1, base: loaded.definitionVersion } })).status).toBe(200);
    // Tab A, still on revision 1, saves an empty choice: refused, so its stale page cannot clear what is stored.
    const stale = await h.request("PUT", url, { ...definition([{ ...tracks[0]!, senders: [] }, tracks[1]!]), save: { session: "A", seq: 2, base: 1 } });
    expect(stale.status).toBe(409);
    expect([senders(await get()), senders(await get(), "ig2")]).toEqual([[id2], [id1, id2]]);
    // A third session connects: it is listed, but no track gains it.
    h.social(channel).sessions.set("session-3", session("session-3"));
    await h.tick();
    const withThird = await get();
    expect(withThird.accounts.some((a) => a.id === socialAccountId(channel, "session-3"))).toBe(true);
    expect([senders(withThird), senders(withThird, "ig2")]).toEqual([[id2], [id1, id2]]);
    // Session 2 disconnects: the choice keeps it, still listed, ticked and said as unable to send, and the track
    // whose only choice it was meets blocker 3 by name; the other track still has session 1.
    h.social(channel).sessions.set(S2, session(S2, { listed: false }));
    await h.tick();
    const without = await get();
    expect([senders(without), senders(without, "ig2")]).toEqual([[id2], [id1, id2]]);
    expect(without.accounts.find((a) => a.id === id2)?.healthy).toBe(false);
    expect(without.launch.blockers.map((b) => [b.kind, b.noneChosen ?? false])).toEqual([["no_sender", false]]);
    // It reconnects: the track can send again, from the session it chose.
    h.social(channel).sessions.set(S2, session(S2, { kind: "personal" }));
    await h.tick();
    expect((await get()).launch.blockers).toEqual([]);
  });

  test("a session removed from a running track's choice keeps sending the leads it already started, as LinkedIn's fixed session does; new leads start from the sessions still chosen", async () => {
    const S2 = "session-2";
    const { h, delivered } = await world({ sessions: [session(S1), session(S2)], messagesPerDay: 1 });
    const { campaign: c } = await h.createCampaign("Fixed", { businesses: BUSINESSES, people: PEOPLE });
    const both = [socialAccountId(channel, S1), socialAccountId(channel, S2)];
    await h.defineSequence(c.id, definition([{ ...mrTrack("ig", three()), senders: both }]));
    h.clock = MONDAY_9;
    expect((await h.launch(c.id)).status).toBe(200);
    // One message a day per session: Pat and Nia start, one from each session.
    await h.advanceTo(MONDAY_9 + H);
    const first = new Map(h.social(channel).handoverLog.map((x) => [x.destination, x.sender]));
    expect(new Set(first.values())).toEqual(new Set([S1, S2]));
    const dropped = first.get(PAT_OWN)!;
    // The user unticks the session that started Pat.
    const stored = (await h.request<{ definition: CampaignDefinition }>("GET", `/api/campaigns/${c.id}/sequence`)).body.definition;
    const kept = both.filter((id) => id !== socialAccountId(channel, dropped));
    expect((await h.request("PUT", `/api/campaigns/${c.id}/sequence`, { ...stored, tracks: stored.tracks.map((t) => (t.id === "ig" ? { ...t, senders: kept } : t)) })).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 3 * DAY);
    // Pat's follow-up still goes from the session of Pat's own conversation: a fixed sender is never reassigned (ADR 0003 1.3).
    expect(h.social(channel).handoverLog.filter((x) => x.destination === PAT_OWN).map((x) => [x.stepId, x.sender])).toEqual([["m1", dropped], ["m2", dropped]]);
    // Nobody starts from the unticked session after the edit.
    const editAt = MONDAY_9 + H;
    const startedLater = h.social(channel).handoverLog.filter((x) => x.at > editAt && x.stepId === "m1");
    expect(startedLater.every((x) => x.sender !== dropped)).toBe(true);
    expect(delivered(PAT_OWN)).toHaveLength(2);
  });

  describe("each track sends from its own choice, fixed at its own first handover, never from another track's (the review bot on 0922582)", () => {
    const S2 = "session-2";
    const id = (s: string) => socialAccountId(channel, s);
    /** Pat alone (their own account), two tracks of the channel with the given choices; B after A or beside it. */
    const twoTracks = async (a: string[], b: string[], bStart: "after" | "beside", perDay: Record<string, number> = {}) => {
      const { h } = await world({ sessions: [session(S1), session(S2)], people: [PEOPLE[0]!], businesses: [BUSINESSES[0]!] });
      for (const [s, n] of Object.entries(perDay)) expect((await h.request("PUT", `/api/sender-accounts/${id(s)}/allowances`, { invitesPerDay: 0, messagesPerDay: n, notesPerMonth: 0 })).status).toBe(200);
      const { campaign: c } = await h.createCampaign("Two tracks", { businesses: [BUSINESSES[0]!], people: [PEOPLE[0]!] });
      const A = { ...mrTrack("a", [step("a1", 0, "From A.")]), senders: a.map(id) };
      const B = { ...mrTrack("b", [step("b1", 0, "From B.")], bStart === "after" ? { kind: "after", trackId: "a", delayDays: 0 } : { kind: "entry" }), senders: b.map(id) };
      await h.defineSequence(c.id, definition([A, B]));
      h.clock = MONDAY_9;
      expect((await h.launch(c.id)).status).toBe(200);
      await h.advanceTo(MONDAY_9 + 2 * DAY);
      const by = (track: string) => h.social(channel).handoverLog.filter((x) => x.trackId === track).map((x) => x.sender);
      return { h, by };
    };

    test("disjoint choices: A from its session, B, after A, from its own; B never from A's", async () => {
      const { by } = await twoTracks([S1], [S2], "after");
      expect([by("a"), by("b")]).toEqual([[S1], [S2]]);
    });

    test("overlapping choices: each from a session it chose; B never from the one only A chose", async () => {
      const { by } = await twoTracks([S1, S2], [S2], "beside");
      expect(by("b")).toEqual([S2]);
      expect([S1, S2]).toContain(by("a")[0]);
    });

    test("the same choice: both from it, one conversation with the account from that session", async () => {
      const { by, h } = await twoTracks([S1], [S1], "beside");
      expect([by("a"), by("b")]).toEqual([[S1], [S1]]);
      const db = (h.store.engine as unknown as { db: import("node:sqlite").DatabaseSync }).db;
      expect(db.prepare("SELECT sender_number, recipient_key FROM sms_bindings WHERE channel = ?").all(channel).map((r) => `${String(r["sender_number"])} ${String(r["recipient_key"])}`)).toEqual([`${id(S1)} ${PAT_OWN}`]);
    });

    test("one track's session has no allowance while the other's has room: neither borrows the other's", async () => {
      const { by, h } = await twoTracks([S1], [S2], "beside", { [S1]: 0 });
      expect([by("a"), by("b")]).toEqual([[], [S2]]);
      // A waits for its own session, said as no allowance, never sent from B's.
      const lead = (await h.request<LeadSearchResult>("GET", "/api/leads")).body.rows[0]!.enrollments[0]!.id;
      const a = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${lead}`)).body.tracks.find((t) => t.trackId === "a");
      expect(a?.nextStep?.when).toMatchObject({ kind: "waits", why: "no_allowance" });
    });
  });

  test("a track with no session chosen is blocker 3, said as no sender chosen, though sessions are connected", async () => {
    const { h } = await world();
    const { campaign: c } = await h.createCampaign("None chosen", { businesses: BUSINESSES, people: PEOPLE });
    const view = await h.defineSequence(c.id, definition([{ ...mrTrack("ig", three()), senders: [] }]));
    expect(view.launch.blockers.map((b) => [b.kind, "noneChosen" in b ? b.noneChosen : undefined, b.message])).toEqual([["no_sender", true, `The ${W.Name} track has no sender session chosen.`]]);
    expect(view.launch.canLaunch).toBe(false);
  });
});
});

describe("Instagram and Facebook in one campaign (ADR 0004 14.6): two tracks of one lead on two channels are two conversations, and nothing is read across channels", () => {
  /** The same session id on both channels: an id the app read without its channel would collide. */
  const SAME = "session-1";
  const IG = (name: string) => exampleAccount("instagram", name);
  const FB = (name: string) => exampleAccount("facebook", name);
  const both = (fb: string, ig: string) => ({ ...personAccountCell("facebook", fb), ...personAccountCell("instagram", ig) });
  const BUSINESSES = [
    business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101", ...businessAccountCell("instagram", IG("harbour.physio")), ...businessAccountCell("facebook", FB("harbour.physio")) }),
    business({ business_id: "b2", business_name: "Northgate Dental", phone_e164: "+442079460202", ...businessAccountCell("instagram", IG("northgate.dental")), ...businessAccountCell("facebook", FB("northgate.dental")) }),
  ];
  const PEOPLE = [
    person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", ...both(FB("pat.oneil"), IG("pat.oneil")) }),
    person({ person_id: "p2", business_id: "b2", full_name: "Nia Cole", email: "nia@northgate.example", ...both("", "") }),
  ];
  /** A track of the channel; its steps' ids carry the track's id, since a campaign's step ids are unique. */
  const trackOn = (channel: MessageRequestChannel, id: string, steps: StepDefinition[]): TrackDefinition => ({ id, channel, branch: "main", window: ALWAYS, steps: steps.map((x) => ({ ...x, id: `${id}-${x.id}` })), start: { kind: "entry" }, removed: false, senders: [socialAccountId(channel, SAME)] });
  const definitionOf = (tracks: TrackDefinition[]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: [], tracks });

  async function world(perDay: { readonly [C in MessageRequestChannel]: number }) {
    const h = new EngineHarness({
      start: MONDAY_9 - H,
      accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
      social: { instagram: { sessions: [session(SAME)] }, facebook: { sessions: [session(SAME, { kind: "personal" })] } },
    });
    await h.tick();
    for (const c of MESSAGE_REQUEST_CHANNELS) expect((await h.request("PUT", `/api/sender-accounts/${socialAccountId(c, SAME)}/allowances`, { invitesPerDay: 0, messagesPerDay: perDay[c], notesPerMonth: 0 })).status).toBe(200);
    const campaign = async (name: string, tracks: TrackDefinition[]) => {
      const { campaign: c } = await h.createCampaign(name, { businesses: BUSINESSES, people: PEOPLE });
      await h.defineSequence(c.id, definitionOf(tracks));
      if (h.clock < MONDAY_9) h.clock = MONDAY_9;
      const launched = await h.launch(c.id);
      if (launched.status !== 200) throw new Error(`launch refused: ${JSON.stringify(launched.body)}`);
      const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
      return { id: c.id, lead: (n: string) => rows.find((r) => r.name === n)?.enrollments.find((e) => e.campaign.id === c.id)?.id ?? "" };
    };
    const progress = async (id: string) => (await h.request<EnrollmentRead>("GET", `/api/enrollments/${id}`)).body;
    return { h, campaign, progress };
  }

  test("each track goes to the lead's own account on its own channel, from that channel's session, as its own stored conversation", async () => {
    const { h, campaign, progress } = await world({ instagram: 20, facebook: 20 });
    const c = await campaign("Both", [trackOn("instagram", "ig", three()), trackOn("facebook", "fb", three()), emailTrack("em")]);
    await h.advanceTo(MONDAY_9 + H);
    expect(h.social("instagram").deliveryLog.map((d) => [d.subjectId, d.trackId, d.destination])).toEqual([
      [c.lead("Pat Oneil"), "ig", IG("pat.oneil")],
      [c.lead("Nia Cole"), "ig", IG("northgate.dental")],
    ]);
    expect(h.social("facebook").deliveryLog.map((d) => [d.subjectId, d.trackId, d.destination])).toEqual([
      [c.lead("Pat Oneil"), "fb", FB("pat.oneil")],
      [c.lead("Nia Cole"), "fb", FB("northgate.dental")],
    ]);
    // Two conversations per lead, each with its channel and that channel's session.
    const db = (h.store.engine as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    const pairs = db.prepare("SELECT channel, sender_number, recipient_key FROM sms_bindings WHERE owner_subject = ? ORDER BY channel").all(c.lead("Pat Oneil"));
    expect(pairs.map((r) => [r["channel"], r["sender_number"], r["recipient_key"]])).toEqual([
      ["facebook", socialAccountId("facebook", SAME), FB("pat.oneil")],
      ["instagram", socialAccountId("instagram", SAME), IG("pat.oneil")],
    ]);
    // Each track's read names its own channel's session and its kind there.
    const pat = await progress(c.lead("Pat Oneil"));
    expect(pat.tracks.find((t) => t.trackId === "ig")?.messageRequest?.sender).toEqual({ id: socialAccountId("instagram", SAME), kind: "business" });
    expect(pat.tracks.find((t) => t.trackId === "fb")?.messageRequest?.sender).toEqual({ id: socialAccountId("facebook", SAME), kind: "personal" });
  });

  test("an account taken on Instagram leaves the lead's Facebook track free, and each channel's allowance is its own", async () => {
    const { h, campaign, progress } = await world({ instagram: 20, facebook: 0 });
    // A first campaign reaches Northgate's Instagram account from the session.
    await campaign("First", [trackOn("instagram", "ig", [step("a1", 0, "First.")])]);
    await h.advanceTo(MONDAY_9 + H);
    expect(h.social("instagram").deliveryLog.filter((d) => d.destination === IG("northgate.dental"))).toHaveLength(1);
    // A second campaign with both channels: Nia's Instagram track is skipped as taken; her Facebook track is not, and waits
    // only on Facebook's own allowance of zero, never on Instagram's room under the same session id.
    const second = await campaign("Second", [trackOn("instagram", "ig2", [step("b1", 0, "Second.")]), trackOn("facebook", "fb2", [step("c1", 0, "Second, on Facebook.")])]);
    await h.advanceTo(h.clock + 2 * H);
    const nia = await progress(second.lead("Nia Cole"));
    expect(nia.tracks.find((t) => t.trackId === "ig2")).toMatchObject({ finishReason: "skipped_conversation_taken", conversationOwners: [{ name: "First", test: false, lead: null }] });
    expect(nia.tracks.find((t) => t.trackId === "fb2")).toMatchObject({ finishReason: null, nextStep: { when: { kind: "waits", why: "no_allowance", channel: "facebook" } } });
    expect(h.social("facebook").deliveryLog).toEqual([]);
    // Room on Facebook: the Facebook track sends to Northgate's Facebook account, a conversation of its own.
    expect((await h.request("PUT", `/api/sender-accounts/${socialAccountId("facebook", SAME)}/allowances`, { invitesPerDay: 0, messagesPerDay: 20, notesPerMonth: 0 })).status).toBe(200);
    await h.advanceTo(h.clock + H);
    expect(h.social("facebook").deliveryLog.filter((d) => d.subjectId === second.lead("Nia Cole")).map((d) => [d.trackId, d.destination])).toEqual([["fb2", FB("northgate.dental")]]);
  });

  test("a reply is marked on the channel that reached them: refused on one nothing reached, accepted on the other, and it stops both tracks of that lead only", async () => {
    const { h, campaign, progress } = await world({ instagram: 0, facebook: 20 });
    const c = await campaign("Both", [trackOn("instagram", "ig", three()), trackOn("facebook", "fb", three())]);
    const pat = c.lead("Pat Oneil");
    await h.advanceTo(MONDAY_9 + H);
    // Facebook reached Pat; Instagram has no allowance, so nothing went there.
    expect(h.social("facebook").deliveryLog.filter((d) => d.subjectId === pat)).toHaveLength(1);
    expect(h.social("instagram").deliveryLog).toEqual([]);
    const before = await progress(pat);
    expect(before.replyMarks).toMatchObject({ instagram: { allowed: false }, facebook: { allowed: true, work: { kind: "message", state: "sent" } } });
    const onInstagram = await h.request("POST", `/api/enrollments/${pat}/replies`, { requestId: "r1", channel: "instagram" });
    expect(onInstagram.status).toBe(409);
    expect(JSON.stringify(onInstagram.body)).toContain("Nothing has been sent to them on Instagram in this campaign");
    const onFacebook = await h.request<{ enrollment: EnrollmentProgress }>("POST", `/api/enrollments/${pat}/replies`, { requestId: "r2", channel: "facebook" });
    expect(onFacebook.status).toBe(200);
    expect(onFacebook.body.enrollment).toMatchObject({ status: "replied", reply: { channel: "facebook" } });
    // Instagram gets room; nothing more goes to Pat on either channel, while Nia carries on on both.
    expect((await h.request("PUT", `/api/sender-accounts/${socialAccountId("instagram", SAME)}/allowances`, { invitesPerDay: 0, messagesPerDay: 20, notesPerMonth: 0 })).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 6 * DAY);
    expect(h.social("instagram").deliveryLog.filter((d) => d.subjectId === pat)).toEqual([]);
    expect(h.social("facebook").deliveryLog.filter((d) => d.subjectId === pat).map((d) => d.stepId)).toEqual(["fb-m1"]);
    expect(h.social("instagram").deliveryLog.filter((d) => d.subjectId === c.lead("Nia Cole")).map((d) => d.stepId)).toEqual(["ig-m1", "ig-m2", "ig-m3"]);
    // The measures count each channel's own messages and marks.
    const m = (await h.request<CampaignMeasures>("GET", `/api/campaigns/${c.id}/measures`)).body;
    expect(m.messageRequests.facebook).toMatchObject({ messagesSent: 4, replies: 1 });
    expect(m.messageRequests.instagram).toMatchObject({ messagesSent: 3, replies: 0 });
  });
});

describe("one Facebook account under several spellings (the review bot and the council on c072ae8 and f3c9014; ADR 0004 14.3)", () => {
  const N = "100012345678901";
  /** Pairs of spellings of one account, each tried in both orders: periods, every number form, and host aliases. */
  const PAIRS: readonly (readonly [string, string])[] = [
    ["https://www.facebook.com/exampleharbourphysio", "https://www.facebook.com/Example.Harbour.Physio/"],
    [`https://www.facebook.com/${N}`, `https://www.facebook.com/profile.php?id=${N}`],
    [`https://www.facebook.com/Example-Clinic-${N}/`, `https://www.facebook.com/${N}`],
    [`https://m.facebook.com/profile.php?id=${N}&sk=about`, `https://mbasic.facebook.com/Example-Clinic-${N}`],
    ["https://fb.com/exampleharbourphysio", "https://en-gb.facebook.com/example.harbour.physio"],
  ];
  const ORDERED = PAIRS.flatMap(([a, b]) => [[a, b], [b, a]] as const);
  const fbTrack: TrackDefinition = { id: "fb", channel: "facebook", branch: "main", window: ALWAYS, steps: [step("fb-m1", 0, "Hello {{company}}.")], start: { kind: "entry" }, removed: false, senders: [socialAccountId("facebook", S1)] };
  const business1 = (cell: string, id = "b1", name = "Harbour Lane Physio") => business({ business_id: id, business_name: name, phone_e164: `+4420794601${id === "b1" ? "01" : "02"}`, ...businessAccountCell("facebook", cell) });

  async function facebookWorld(companyCells: readonly string[]) {
    const h = new EngineHarness({
      start: MONDAY_9 - H,
      accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
      social: { facebook: { sessions: [session(S1)] } },
    });
    await h.tick();
    expect((await h.request("PUT", `/api/sender-accounts/${socialAccountId("facebook", S1)}/allowances`, { invitesPerDay: 0, messagesPerDay: 20, notesPerMonth: 0 })).status).toBe(200);
    const businesses = companyCells.map((cell, i) => business1(cell, `b${i + 1}`, `Fictional Clinic ${i + 1}`));
    const { campaign: c } = await h.createCampaign("Spellings", { businesses, people: [] });
    await h.defineSequence(c.id, { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: [], tracks: [fbTrack] });
    const lead = async () => (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows[0]?.enrollments[0]?.id ?? "";
    const version = async () => (await h.request<{ definitionVersion: number }>("GET", `/api/campaigns/${c.id}/sequence`)).body.definitionVersion;
    /** Starts a test run written for a company lead: the request is well formed, so only the boundary can refuse it. */
    const runTest = async (requestId: string) => h.request("POST", `/api/campaigns/${c.id}/test-runs`, { requestId, renderAs: await lead(), expect: { definitionVersion: await version() } });
    return { h, campaign: c.id, businesses, runTest };
  }

  for (const [imported, given] of ORDERED) {
    test(`a prospect at ${imported} refuses ${given} as a test contact, and no test run reaches it`, async () => {
      const { h, campaign, runTest } = await facebookWorld([imported]);
      const saved = await h.request("PUT", `/api/campaigns/${campaign}/test-contacts`, { email: "", mobile: "", facebook: given });
      expect(saved.status).toBe(409);
      expect((await runTest("run-1")).status).toBe(409);
      await h.advanceTo(h.clock + H);
      expect(h.social("facebook").handoverLog.filter((x) => !x.subjectId.startsWith("id-"))).toEqual([]);
    });

    test(`a test contact saved as ${given} before a prospect at ${imported} is imported is refused when the run starts`, async () => {
      const { h, campaign, businesses, runTest } = await facebookWorld([""]);
      expect((await h.request("PUT", `/api/campaigns/${campaign}/test-contacts`, { email: "", mobile: "", facebook: given })).status).toBe(200);
      await h.reimport(campaign, { businesses: [{ ...businesses[0]!, ...businessAccountCell("facebook", imported) }], people: [] });
      const run = await runTest("run-2");
      expect(run.status).toBe(409);
      expect(JSON.stringify(run.body)).toContain("Facebook");
      await h.advanceTo(h.clock + H);
      expect(h.social("facebook").handoverLog).toEqual([]);
    });
  }

  for (const [a, b] of PAIRS) {
    test(`two leads whose companies give one account as ${a} and ${b}: one session sends it one first message, and the other lead is skipped as taken`, async () => {
      const { h, campaign } = await facebookWorld([a, b]);
      h.clock = MONDAY_9;
      expect((await h.launch(campaign)).status).toBe(200);
      await h.advanceTo(MONDAY_9 + 2 * H);
      const sent = h.social("facebook").deliveryLog;
      expect(sent).toHaveLength(1);
      const leads = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign}`)).body.rows.map((r) => r.enrollments[0]!.id);
      const other = leads.find((id) => id !== sent[0]!.subjectId)!;
      const track = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${other}`)).body.tracks.find((t) => t.trackId === "fb");
      expect(track).toMatchObject({ finishReason: "skipped_conversation_taken" });
    });
  }
});
