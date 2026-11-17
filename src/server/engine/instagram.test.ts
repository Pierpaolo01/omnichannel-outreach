import { describe, expect, test } from "vitest";
import { socialAccountId } from "./ports.ts";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { FakeSocialSession } from "../../../test/support/fake-social-port.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { ActivityView, CampaignMeasures, EnrollmentProgress, EnrollmentRead, LeadSearchResult, SocialProvidersStatus } from "../../shared/api.ts";

/**
 * The Instagram track (ticket 25, ADR 0004 section 13) through the real HTTP app, SQLite store and engine, against the
 * simulated Instagram provider beside the fake email provider. No Instagram session is connected: the simulated provider is
 * a test double, not an integration. Every account here is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
/** Monday 2 November 2026, 09:00 London (GMT). */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const S1 = "ig-session-1";

const PAT_OWN = "https://www.instagram.com/example_pat.oneil";
const HARBOUR = "https://www.instagram.com/example_harbour_physio";
const NORTHGATE = "https://www.instagram.com/example_northgate_dental";

const step = (id: string, waitDays: number, body: string): StepDefinition => ({ id, waitDays, subject: "", body, threading: "new_subject", removed: false });
const instagram = (id: string, steps: StepDefinition[], start: TrackDefinition["start"] = { kind: "entry" }): TrackDefinition => ({ id, channel: "instagram", branch: "main", window: ALWAYS, steps, start, removed: false });
const emailTrack = (id: string, start: TrackDefinition["start"] = { kind: "entry" }): TrackDefinition => ({
  id,
  channel: "email",
  branch: "main",
  window: ALWAYS,
  steps: [{ id: `${id}-1`, waitDays: 0, subject: "Hello {{first_name|there}}", body: "Email for {{company}}.", threading: "new_subject", removed: false }],
  start,
  removed: false,
});
const definition = (tracks: TrackDefinition[], pool = [socialAccountId("instagram", S1)]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: [], instagramPool: pool, tracks });
const session = (id: string, fields: Partial<FakeSocialSession> = {}): FakeSocialSession => ({ id, kind: "business", gapMs: MIN, k: 1, healthy: true, resetZone: "Europe/London", ...fields });
const three = () => [step("m1", 0, "Hello {{first_name|there}}, I work with clinics like {{company}}."), step("m2", 2, "Following up."), step("m3", 3, "Last note.")];

const BUSINESSES = [
  business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101", instagram: HARBOUR }),
  business({ business_id: "b2", business_name: "Northgate Dental", phone_e164: "+442079460202", instagram: `${NORTHGATE}/` }),
  business({ business_id: "b3", business_name: "Quayside Clinic", phone_e164: "+442079460303", instagram: "https://instagram.example/quayside" }),
  business({ business_id: "b4", business_name: "Elm Street Practice", phone_e164: "+442079460404", instagram: "" }),
];
const PEOPLE = [
  // Their own account (the people file's optional column, question Q43): preferred to the company's.
  person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", instagram: PAT_OWN }),
  // No own account: the company's.
  person({ person_id: "p2", business_id: "b2", full_name: "Nia Cole", email: "nia@northgate.example", instagram: "" }),
  // The company's cell is not an account, and no own: missing, not an account.
  person({ person_id: "p3", business_id: "b3", full_name: "Sam Lee", email: "sam@quayside.example", instagram: "" }),
  // Nothing in either file: missing.
  person({ person_id: "p4", business_id: "b4", full_name: "Kim Hart", email: "kim@elm.example", instagram: "" }),
];

async function world(options: { messagesPerDay?: number | null; sessions?: FakeSocialSession[]; people?: typeof PEOPLE; businesses?: typeof BUSINESSES } = {}) {
  const h = new EngineHarness({
    start: MONDAY_9 - H,
    accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    instagram: { sessions: options.sessions ?? [session(S1)] },
  });
  await h.tick();
  const perDay = options.messagesPerDay === undefined ? 20 : options.messagesPerDay;
  for (const s of options.sessions ?? [session(S1)]) {
    if (perDay !== null) expect((await h.request("PUT", `/api/sender-accounts/${socialAccountId("instagram", s.id)}/allowances`, { invitesPerDay: 0, messagesPerDay: perDay, notesPerMonth: 0 })).status).toBe(200);
  }
  const campaign = async (tracks: TrackDefinition[], name = "Instagram", pool?: string[]) => {
    const { campaign: c } = await h.createCampaign(name, { businesses: options.businesses ?? BUSINESSES, people: options.people ?? PEOPLE });
    await h.defineSequence(c.id, definition(tracks, pool));
    if (h.clock < MONDAY_9) h.clock = MONDAY_9;
    const launched = await h.launch(c.id);
    if (launched.status !== 200) throw new Error(`launch refused: ${JSON.stringify(launched.body)}`);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
    const lead = (name: string) => rows.find((r) => r.name === name)?.enrollments.find((e) => e.campaign.id === c.id)?.id ?? "";
    return { id: c.id, lead };
  };
  const delivered = (account: string) => h.instagram.deliveryLog.filter((d) => d.destination === account);
  const progress = (id: string) => h.request<EnrollmentRead>("GET", `/api/enrollments/${id}`).then((r) => r.body);
  return { h, campaign, delivered, progress };
}

describe("the message request and its follow-ups (ADR 0004 13.3, 13.4)", () => {
  test("text only, to the decision maker's own account, else the company's; follow-ups after their waits; nothing promised after", async () => {
    const { h, campaign, delivered, progress } = await world();
    const c = await campaign([instagram("ig", three())]);
    await h.advanceTo(MONDAY_9 + H);
    // Pat's own account, never the company's: the decision maker's own when the CSV has one.
    expect(delivered(PAT_OWN).map((d) => [d.stepId, d.rendered.subject, d.rendered.body])).toEqual([["m1", "", "Hello Pat, I work with clinics like Harbour Lane Physio."]]);
    expect(delivered(HARBOUR)).toEqual([]);
    // Nia has none of her own: her company's account, normalised from its trailing slash.
    expect(delivered(NORTHGATE).map((d) => d.stepId)).toEqual(["m1"]);
    // Each message action is a message; the simulated provider was never asked for an invite.
    expect(h.instagram.handoverLog.every((x) => x.action === "message")).toBe(true);
    // The read says what the engine knows: the first message sent, to whose account, from which session; nothing about acceptance.
    const pat = await progress(c.lead("Pat Oneil"));
    const track = pat.tracks.find((t) => t.trackId === "ig");
    expect(track?.messageRequest).toEqual({ destination: "own", address: PAT_OWN, firstMessage: "sent", sender: { id: socialAccountId("instagram", S1), kind: "business" }, skipCause: null });
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
    const c = await campaign([instagram("ig", three()), emailTrack("em", { kind: "after", trackId: "ig", delayDays: 0 })]);
    await h.advanceTo(MONDAY_9 + H);
    const sam = await progress(c.lead("Sam Lee"));
    const kim = await progress(c.lead("Kim Hart"));
    expect(sam.tracks.find((t) => t.trackId === "ig")).toMatchObject({ finishReason: "skipped_missing_channel", messageRequest: { skipCause: "not_a_member_profile", destination: null } });
    expect(kim.tracks.find((t) => t.trackId === "ig")).toMatchObject({ finishReason: "skipped_missing_channel", messageRequest: { skipCause: "no_profile" } });
    // The email track after it starts at once for them: a skipped track counts as finished.
    expect(h.fake.deliveryLog.filter((d) => d.destination === "sam@quayside.example").map((d) => d.stepId)).toEqual(["em-1"]);
    expect(h.fake.deliveryLog.filter((d) => d.destination === "kim@elm.example").map((d) => d.stepId)).toEqual(["em-1"]);
    // Pat, with an account, still waits for the Instagram track to finish before the email.
    expect(h.fake.deliveryLog.filter((d) => d.destination === "pat@harbour.example")).toEqual([]);
  });

  test("a company lead messages the company's own account", async () => {
    const { h, campaign, delivered } = await world({ people: [] });
    await campaign([instagram("ig", [step("m1", 0, "Hello {{company}}.")])]);
    await h.advanceTo(MONDAY_9 + H);
    expect(delivered(HARBOUR).map((d) => d.rendered.body)).toEqual(["Hello Harbour Lane Physio."]);
    expect(delivered(NORTHGATE)).toHaveLength(1);
  });
});

describe("refusals and lost answers (ADR 0004 13.3)", () => {
  test("an unreachable account is marked bad and fails the track; a not-allowed one fails it and stays good", async () => {
    const { h, campaign, delivered, progress } = await world();
    h.instagram.accountsScript.set(PAT_OWN, { unreachable: true });
    h.instagram.accountsScript.set(NORTHGATE, { notAllowed: true });
    const c = await campaign([instagram("ig", three()), emailTrack("em")]);
    await h.advanceTo(MONDAY_9 + H);
    const pat = (await progress(c.lead("Pat Oneil"))).tracks.find((t) => t.trackId === "ig");
    const nia = (await progress(c.lead("Nia Cole"))).tracks.find((t) => t.trackId === "ig");
    expect(pat).toMatchObject({ finishReason: "failed_bad_destination" });
    expect(pat?.steps[0]).toMatchObject({ result: "failed", reason: "account unreachable" });
    expect(nia).toMatchObject({ finishReason: "failed_bad_destination" });
    expect(nia?.steps[0]).toMatchObject({ result: "failed", reason: "not allowed" });
    expect(delivered(PAT_OWN)).toEqual([]);
    // The email track beside it went for both: a failed Instagram track ends neither lead.
    expect(h.fake.deliveryLog.map((d) => d.destination).sort()).toContain("nia@northgate.example");
    // A second campaign: Pat's own account is marked bad, so the company's is Pat's destination now; Northgate's is still good.
    const second = await campaign([instagram("ig2", [step("x1", 0, "Hello again.")])], "Second");
    await h.advanceTo(h.clock + H);
    expect(delivered(HARBOUR).map((d) => d.stepId)).toEqual(["x1"]);
    expect((await progress(second.lead("Nia Cole"))).tracks.find((t) => t.trackId === "ig2")?.finishReason).toBe("failed_bad_destination");
  });

  test("a lost answer is found by a lookup and the message is never handed over twice", async () => {
    const { h, campaign, delivered, progress } = await world();
    h.instagram.accountsScript.set(PAT_OWN, { loseAnswer: 1 });
    const c = await campaign([instagram("ig", three())]);
    await h.advanceTo(MONDAY_9 + 3 * H);
    expect(h.instagram.handoverLog.filter((x) => x.destination === PAT_OWN && x.stepId === "m1")).toHaveLength(1);
    expect(h.instagram.lookupLog.some((l) => l.answer === "sent")).toBe(true);
    expect((await progress(c.lead("Pat Oneil"))).tracks.find((t) => t.trackId === "ig")?.messageRequest?.firstMessage).toBe("sent");
    await h.advanceTo(MONDAY_9 + 3 * DAY);
    expect(delivered(PAT_OWN).map((d) => d.stepId)).toEqual(["m1", "m2"]);
  });
});

describe("allowances, capacity and priority (ADR 0004 13.7)", () => {
  test("an unset allowance sends nothing and reads as no allowance, never a time", async () => {
    const { h, campaign, delivered, progress } = await world({ messagesPerDay: null });
    const c = await campaign([instagram("ig", three())]);
    await h.advanceTo(MONDAY_9 + 2 * DAY);
    expect(h.instagram.deliveryLog).toEqual([]);
    const next = (await progress(c.lead("Pat Oneil"))).tracks.find((t) => t.trackId === "ig")?.nextStep;
    // The engine's `sending_capacity`, read as the user's own setting: no allowance (ticket 24b, item 15; ADR 0004 13.7).
    expect(next?.when).toEqual({ kind: "waits", why: "no_allowance", channel: "instagram" });
    expect(delivered(PAT_OWN)).toEqual([]);
  });

  test("one message a day per session: follow-ups first, then the oldest due, overflow to the next day", async () => {
    const { h, campaign, delivered } = await world({ messagesPerDay: 1 });
    await campaign([instagram("ig", [step("m1", 0, "One."), step("m2", 1, "Two.")])]);
    await h.advanceTo(MONDAY_9 + 12 * H);
    // Monday: one message only, Nia's or Pat's first.
    expect(h.instagram.deliveryLog).toHaveLength(1);
    const first = h.instagram.deliveryLog[0]!.destination;
    const other = first === PAT_OWN ? NORTHGATE : PAT_OWN;
    // Tuesday: the touched lead's follow-up goes before the other's first message.
    await h.advanceTo(MONDAY_9 + DAY + 12 * H);
    expect(h.instagram.deliveryLog.map((d) => [d.destination, d.stepId])).toEqual([
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
    const c = await campaign([instagram("ig", [step("m1", 0, "Hello.")])]);
    await h.advanceTo(MONDAY_9 + 3 * H);
    expect(delivered(NORTHGATE)).toHaveLength(1);
    const owner = delivered(NORTHGATE)[0]!.subjectId;
    const skippedName = owner === c.lead("Nia Cole") ? "Ola Berg" : "Nia Cole";
    const skipped = (await progress(c.lead(skippedName))).tracks.find((t) => t.trackId === "ig");
    expect(skipped).toMatchObject({ finishReason: "skipped_conversation_taken", conversationOwners: [{ name: "Instagram", test: false }] });
  });

  test("a second campaign on the same session is skipped for an account the first reached; a person's own account and their company's are two", async () => {
    const { h, campaign, delivered, progress } = await world();
    await campaign([instagram("ig", [step("m1", 0, "First.")])], "First");
    await h.advanceTo(MONDAY_9 + H);
    const second = await campaign([instagram("ig2", [step("x1", 0, "Second.")])], "Second");
    await h.advanceTo(h.clock + 2 * H);
    // Nia's company account was reached by the first campaign: the second skips her, naming it.
    expect((await progress(second.lead("Nia Cole"))).tracks.find((t) => t.trackId === "ig2")).toMatchObject({ finishReason: "skipped_conversation_taken", conversationOwners: [{ name: "First", test: false }] });
    expect(delivered(NORTHGATE).map((d) => d.stepId)).toEqual(["m1"]);
    expect(delivered(PAT_OWN).map((d) => d.stepId)).toEqual(["m1"]);
    // Harbour's own account was never reached (Pat went to their own): another destination, free.
    expect(delivered(HARBOUR)).toEqual([]);
  });

  test("a pair's channel is stored: an SMS conversation and an Instagram one never read each other", async () => {
    const { h, campaign } = await world();
    await campaign([instagram("ig", [step("m1", 0, "Hello.")])]);
    await h.advanceTo(MONDAY_9 + H);
    const db = (h.store.engine as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    const channels = db.prepare("SELECT DISTINCT channel FROM sms_bindings").all().map((r) => r["channel"]);
    expect(channels).toEqual(["instagram"]);
  });
});

describe("the reply mark (ADR 0004 13.8)", () => {
  test("refused before anything reached them; then it stops only that lead in that campaign, said as marked by the user", async () => {
    const { h, campaign, progress } = await world();
    const c = await campaign([instagram("ig", three()), emailTrack("em")]);
    const pat = c.lead("Pat Oneil");
    await h.advanceTo(MONDAY_9 + H);
    // Kim has no account: nothing reached them on Instagram, so there is no Instagram reply to mark.
    const kim = await h.request("POST", `/api/enrollments/${c.lead("Kim Hart")}/replies`, { requestId: "r0", channel: "instagram" });
    expect(kim.status).toBe(409);
    expect(JSON.stringify(kim.body)).toContain("Nothing has been sent to them on Instagram in this campaign");
    const before = await progress(pat);
    expect(before.replyMarks.instagram).toEqual({ allowed: true, work: { kind: "message", state: "sent" } });
    // A LinkedIn mark is refused: nothing went to them on LinkedIn, and no campaign track is there either.
    expect((await h.request("POST", `/api/enrollments/${pat}/replies`, { requestId: "r1", channel: "linkedin" })).status).toBe(409);
    const marked = await h.request<{ enrollment: EnrollmentProgress }>("POST", `/api/enrollments/${pat}/replies`, { requestId: "r2", channel: "instagram", expect: { status: before.status } });
    expect(marked.status).toBe(200);
    expect(marked.body.enrollment).toMatchObject({ status: "replied", reply: { channel: "instagram" } });
    await h.advanceTo(MONDAY_9 + 6 * DAY);
    expect(h.instagram.deliveryLog.filter((d) => d.subjectId === pat).map((d) => d.stepId)).toEqual(["m1"]);
    // Nia carries on.
    expect(h.instagram.deliveryLog.filter((d) => d.subjectId === c.lead("Nia Cole")).map((d) => d.stepId)).toEqual(["m1", "m2", "m3"]);
    const personId = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows.find((r) => r.name === "Pat Oneil")?.id ?? "";
    const activity = (await h.request<ActivityView>("GET", `/api/people/${personId}/activity`)).body;
    // Activity says the mark from its stored record: a reply on Instagram the user marked, never a detected one.
    expect(activity.entries.filter((e) => e.kind === "replied" && e.channel === "instagram")).toHaveLength(1);
    expect(activity.entries.filter((e) => e.kind === "sent" && e.channel === "instagram")).toHaveLength(1);
    const m = (await h.request<CampaignMeasures>("GET", `/api/campaigns/${c.id}/measures`)).body;
    expect(m.channels).toContain("instagram");
    expect(m.messageRequests.instagram).toMatchObject({ messagesSent: 4, failed: 0, replies: 1 });
  });
});

describe("the running application (ADR 0004 13.1)", () => {
  test("lists no Instagram session, so an Instagram track meets launch blocker 3, and presents no connection", async () => {
    const h = new EngineHarness({ start: MONDAY_9, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
    await h.tick();
    const { campaign: c } = await h.createCampaign("No session", { businesses: BUSINESSES, people: PEOPLE });
    await h.defineSequence(c.id, definition([instagram("ig", [step("m1", 0, "Hello.")])], []));
    const launched = await h.launch(c.id);
    expect(launched.status).toBe(409);
    expect(JSON.stringify(launched.body)).toContain("The Instagram track has no connected Instagram session.");
    const providers = (await h.request<SocialProvidersStatus>("GET", "/api/social-providers")).body;
    expect(providers.instagram).toEqual({ provider: "none", message: "No Instagram session is connected, so Instagram tracks cannot launch." });
  });
});

describe("test runs to the user's own account (ADR 0004 13.8)", () => {
  const OWN_TEST = "https://www.instagram.com/example_my_test_account";

  test("an account a person's or company's record holds is refused; the run messages the test account with minute waits, and its mark ends only the run", async () => {
    const { h, campaign } = await world({ messagesPerDay: 20 });
    const c = await campaign([instagram("ig", three())]);
    // The boundary: a lead's own account, and a company's, are refused; an address that is not an account is refused.
    expect((await h.request("PUT", `/api/campaigns/${c.id}/test-contacts`, { email: "", mobile: "", instagram: PAT_OWN })).status).toBe(409);
    expect((await h.request("PUT", `/api/campaigns/${c.id}/test-contacts`, { email: "", mobile: "", instagram: HARBOUR })).status).toBe(409);
    const bad = await h.request("PUT", `/api/campaigns/${c.id}/test-contacts`, { email: "", mobile: "", instagram: "@example_my_test_account" });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("Give your Instagram account's address, such as https://www.instagram.com/your.name.");
    const saved = await h.request<{ contacts: { social: { instagram: { address: string | null } } }; definitionVersion: number }>("PUT", `/api/campaigns/${c.id}/test-contacts`, { email: "", mobile: "", instagram: OWN_TEST });
    expect(saved.status).toBe(200);
    expect(saved.body.contacts.social.instagram.address).toBe(OWN_TEST);
    const run = await h.request<{ run: { id: string } }>("POST", `/api/campaigns/${c.id}/test-runs`, { requestId: "run-1", renderAs: c.lead("Pat Oneil"), expect: { definitionVersion: saved.body.definitionVersion } });
    expect(run.status).toBe(200);
    await h.advanceTo(h.clock + 10 * MIN);
    // Rendered for Pat, sent to the user's own account, each wait a minute.
    const toTest = h.instagram.deliveryLog.filter((d) => d.destination === OWN_TEST);
    expect(toTest.map((d) => [d.stepId, d.rendered.body])).toEqual([
      ["m1", "Hello Pat, I work with clinics like Harbour Lane Physio."],
      ["m2", "Following up."],
      ["m3", "Last note."],
    ]);
    const runId = run.body.run.id;
    const marked = await h.request<{ run: { running: boolean; ending: string | null } }>("POST", `/api/test-runs/${runId}/replies`, { requestId: "tr-1", channel: "instagram" });
    expect(marked.status).toBe(200);
    expect(marked.body.run).toMatchObject({ running: false, ending: "your_reply" });
    const m = (await h.request<CampaignMeasures>("GET", `/api/campaigns/${c.id}/measures`)).body;
    expect(m.messageRequests.instagram.fromTests).toEqual({ messagesSent: 3, failed: 0, replies: 1 });
  });
});

describe("the import (ADR 0004 13.4)", () => {
  test("a person whose only channel is their company's account is enrolled, and a re-import that replaces an account skips the track not finished", async () => {
    const { h, campaign, delivered, progress } = await world({ messagesPerDay: 20 });
    const people = [person({ person_id: "p9", business_id: "b2", full_name: "Lou Park" })];
    const c = await campaign([instagram("ig", [step("m1", 0, "One."), step("m2", 3, "Two.")])], "Only Instagram");
    const { campaign: only } = await h.createCampaign("Company account only", { businesses: BUSINESSES, people });
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${only.id}`)).body.rows;
    // Lou has no email, no mobile, no number of their own: the company's main line and its Instagram account still reach them.
    expect(rows.map((r) => r.name)).toEqual(["Lou Park"]);
    await h.advanceTo(MONDAY_9 + H);
    expect(delivered(PAT_OWN).map((d) => d.stepId)).toEqual(["m1"]);
    // Pat's own cell now names another account: the track started with the old one, which is no longer theirs.
    await h.reimport(c.id, { businesses: BUSINESSES, people: [person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", instagram: "https://www.instagram.com/example_pat.new" })] });
    await h.advanceTo(MONDAY_9 + 4 * DAY);
    const track = (await progress(c.lead("Pat Oneil"))).tracks.find((t) => t.trackId === "ig");
    expect(track).toMatchObject({ finishReason: "skipped_missing_channel", messageRequest: { skipCause: "replaced" } });
    expect(delivered("https://www.instagram.com/example_pat.new")).toEqual([]);
  });
});
