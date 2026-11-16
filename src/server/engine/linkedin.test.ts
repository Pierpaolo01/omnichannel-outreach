import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { FakeSession } from "../../../test/support/fake-linkedin-port.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { CampaignMeasures, EnrollmentProgress, LeadSearchResult } from "../../shared/api.ts";

/**
 * The LinkedIn track (ticket 24, ADR 0004) through the real HTTP app, SQLite store and engine, against the simulated
 * LinkedIn provider beside the fake email provider. No LinkedIn session is connected: the simulated provider is a test
 * double, not an integration. Every profile URL here is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
/** Monday 2 November 2026, 09:00 London (GMT). */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const S1 = "li-session-1";

const PAT = "https://www.linkedin.com/in/fictional-pat-oneil";
const NIA = "https://www.linkedin.com/in/fictional-nia-cole";
const SAM = "https://www.linkedin.com/in/fictional-sam-lee";

const step = (id: string, waitDays: number, body: string): StepDefinition => ({ id, waitDays, subject: "", body, threading: "new_subject", removed: false });
const invite = (id = "inv", note = "Hello {{first_name|there}}, I work with clinics like {{company}}.") => step(id, 0, note);
const linkedin = (id: string, steps: StepDefinition[], acceptWaitDays = 3, start: TrackDefinition["start"] = { kind: "entry" }): TrackDefinition => ({
  id,
  channel: "linkedin",
  branch: "main",
  window: ALWAYS,
  steps,
  start,
  removed: false,
  acceptWaitDays,
});
const emailTrack = (id: string, start: TrackDefinition["start"] = { kind: "entry" }): TrackDefinition => ({
  id,
  channel: "email",
  branch: "main",
  window: ALWAYS,
  steps: [{ id: `${id}-1`, waitDays: 0, subject: "Hello {{first_name|there}}", body: "Email for {{company}}.", threading: "new_subject", removed: false }],
  start,
  removed: false,
});
const definition = (tracks: TrackDefinition[]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: [], linkedinPool: [S1], tracks });
const session = (id: string, fields: Partial<FakeSession> = {}): FakeSession => ({ id, gapMs: MIN, k: 1, healthy: true, resetZone: "Europe/London", ...fields });

const PEOPLE = [
  person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", linkedin_url: PAT }),
  person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", linkedin_url: `${NIA}/` }),
  person({ person_id: "p3", business_id: "b1", full_name: "Sam Lee", email: "sam@harbour.example", linkedin_url: SAM }),
  // A company page and a malformed cell are not member profiles: missing.
  person({ person_id: "p4", business_id: "b1", full_name: "Kim Hart", email: "kim@harbour.example", linkedin_url: "https://www.linkedin.com/company/fictional-harbour" }),
  person({ person_id: "p5", business_id: "b1", full_name: "Ola Berg", email: "ola@harbour.example", linkedin_url: "" }),
];
const BUSINESSES = [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })];

async function world(options: { allowances?: { invitesPerDay: number; messagesPerDay: number; notesPerMonth: number } | null; people?: typeof PEOPLE } = {}) {
  const h = new EngineHarness({
    start: MONDAY_9 - H,
    accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    linkedin: { sessions: [session(S1)] },
  });
  await h.tick();
  const allowances = options.allowances === undefined ? { invitesPerDay: 20, messagesPerDay: 20, notesPerMonth: 20 } : options.allowances;
  if (allowances) expect((await h.request("PUT", `/api/sender-accounts/${S1}/allowances`, allowances)).status).toBe(200);
  const campaign = async (tracks: TrackDefinition[]) => {
    const { campaign: c } = await h.createCampaign("LinkedIn", { businesses: BUSINESSES, people: options.people ?? PEOPLE });
    await h.defineSequence(c.id, definition(tracks));
    h.clock = MONDAY_9;
    const launched = await h.launch(c.id);
    if (launched.status !== 200) throw new Error(`launch refused: ${JSON.stringify(launched.body)}`);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
    const lead = (name: string) => rows.find((r) => r.name === name)?.enrollments.find((e) => e.campaign.id === c.id)?.id ?? "";
    return { id: c.id, lead };
  };
  const delivered = (profile: string) => h.linkedin.deliveryLog.filter((d) => d.destination === profile);
  const progress = (id: string) => h.request<EnrollmentProgress>("GET", `/api/enrollments/${id}`).then((r) => r.body);
  return { h, campaign, delivered, progress };
}

describe("the invite, the acceptance and the messages (ADR 0004 3.3)", () => {
  test("the invite goes with its note; the first message waits for acceptance and goes at it; a follow-up after its wait", async () => {
    const { h, campaign, delivered } = await world();
    for (const profile of [PAT, NIA, SAM]) h.linkedin.profiles.set(profile, { acceptAfterMs: 26 * H });
    const c = await campaign([linkedin("li", [invite(), step("m1", 0, "Thanks for connecting, {{first_name|there}}."), step("m2", 2, "Following up.")])]);
    await h.advanceTo(MONDAY_9 + H);
    expect(delivered(PAT).map((d) => [d.action, d.rendered.body])).toEqual([["invite", "Hello Pat, I work with clinics like Harbour Lane Physio."]]);
    // Waiting for acceptance: no message goes, and the read says why, with the day the wait ends as a fact.
    await h.advanceTo(MONDAY_9 + 20 * H);
    expect(delivered(PAT)).toHaveLength(1);
    const read = (await h.request<EnrollmentProgress>("GET", `/api/enrollments/${c.lead("Pat Oneil")}`)).body;
    expect(JSON.stringify(read)).toContain("awaiting_acceptance");
    // Accepted 26 hours after the invite: the first message goes then, and the follow-up two calendar days later.
    await h.advanceTo(MONDAY_9 + 28 * H);
    const pat = delivered(PAT);
    expect(pat.map((d) => d.action)).toEqual(["invite", "message"]);
    expect(pat[1]!.at).toBeGreaterThanOrEqual(h.linkedin.acceptanceLog.find((a) => a.profile === PAT)!.at);
    await h.advanceTo(MONDAY_9 + 5 * DAY);
    expect(delivered(PAT).map((d) => d.stepId)).toEqual(["inv", "m1", "m2"]);
    // An acceptance is not a reply: the lead is active, and finishes with no response after its last message.
    const status = (await h.request<EnrollmentProgress>("GET", `/api/enrollments/${c.lead("Pat Oneil")}`)).body.status;
    expect(status).toBe("sequence_finished_no_response");
    const m = (await h.request<CampaignMeasures>("GET", `/api/campaigns/${c.id}/measures`)).body;
    expect(m.channels).toContain("linkedin");
    expect(m.linkedin).toMatchObject({ invitesSent: 3, invitesAccepted: 3, messagesSent: 6, failed: 0, replies: 0 });
    expect(m.groups.handed_to_you).toBe(0);
  });

  test("already connected: no invite is sent; the invite is skipped and the first message goes at once", async () => {
    const { h, campaign, delivered } = await world();
    h.linkedin.profiles.set(PAT, { connected: true });
    const c = await campaign([linkedin("li", [invite(), step("m1", 0, "Hello again, {{first_name|there}}.")])]);
    await h.advanceTo(MONDAY_9 + H);
    expect(delivered(PAT).map((d) => d.action)).toEqual(["message"]);
    const st = await h.store.engine.subject(c.lead("Pat Oneil"), h.clock);
    expect(st?.results.find((r) => r.stepId === "inv")).toMatchObject({ result: "skipped", reason: "already_connected" });
    expect(st?.tracks.find((t) => t.trackId === "li")?.connection).toBe("already_connected");
    const m = (await h.request<CampaignMeasures>("GET", `/api/campaigns/${c.id}/measures`)).body;
    expect(m.linkedin.invitesSent).toBe(2);
    expect(m.linkedin.messagesSent).toBe(1);
  });

  test("not accepted within the wait: the invite is withdrawn, the track finishes, and the track after it starts; nothing more on LinkedIn", async () => {
    const { h, campaign, delivered } = await world();
    const c = await campaign([linkedin("li", [invite(), step("m1", 0, "Thanks.")], 2), emailTrack("after", { kind: "after", trackId: "li", delayDays: 0 })]);
    await h.advanceTo(MONDAY_9 + H);
    expect(delivered(PAT).map((d) => d.action)).toEqual(["invite"]);
    expect(h.fake.deliveryLog.filter((d) => d.destination === "pat@harbour.example")).toHaveLength(0);
    // Two calendar days after the send: Wednesday 00:00 London.
    await h.advanceTo(Date.parse("2026-11-04T01:00:00Z"));
    const st = await h.store.engine.subject(c.lead("Pat Oneil"), h.clock);
    const li = st?.tracks.find((t) => t.trackId === "li");
    expect(li?.finishReason).toBe("invite_not_accepted");
    expect(li?.finishedWall).toBe(Date.parse("2026-11-04T00:00:00Z"));
    expect(h.linkedin.withdrawalLog.map((w) => w.answer)).toContain("withdrawn");
    expect(h.fake.deliveryLog.filter((d) => d.destination === "pat@harbour.example").map((d) => d.at)).toEqual([Date.parse("2026-11-04T00:00:00Z")]);
    // The prospect accepts later: recorded, and still no message (a withdrawn invite is never followed by one).
    await h.advanceTo(Date.parse("2026-11-09T09:00:00Z"));
    expect(delivered(PAT).map((d) => d.action)).toEqual(["invite"]);
  });

  test("an acceptance the platform reports after the deadline, of an acceptance after it, connects nothing", async () => {
    const { h, campaign, delivered } = await world();
    h.linkedin.profiles.set(PAT, { acceptAfterMs: 3 * DAY });
    await campaign([linkedin("li", [invite(), step("m1", 0, "Thanks.")], 1)]);
    await h.advanceTo(MONDAY_9 + 5 * DAY);
    expect(delivered(PAT).map((d) => d.action)).toEqual(["invite"]);
  });
});

describe("the profile URL (ADR 0004 section 5)", () => {
  test("only a member profile from the CSV: a company page or an empty cell skips the track as missing, and the other tracks carry on", async () => {
    const { h, campaign, progress } = await world();
    const c = await campaign([linkedin("li", [invite(), step("m1", 0, "Thanks.")]), emailTrack("e")]);
    await h.advanceTo(MONDAY_9 + H);
    for (const name of ["Kim Hart", "Ola Berg"]) {
      const st = await h.store.engine.subject(c.lead(name), h.clock);
      expect(st?.tracks.find((t) => t.trackId === "li")?.finishReason, name).toBe("skipped_missing_channel");
      expect((await progress(c.lead(name))).status, name).not.toBe("finished_no_usable_channel");
    }
    expect(h.linkedin.handoverLog.map((d) => d.destination).sort()).toEqual([NIA, PAT, SAM].sort());
    // The trailing slash is normalised away: Nia's invite goes to her profile's key.
    expect(h.fake.deliveryLog.map((d) => d.destination).sort()).toEqual(["kim@harbour.example", "ola@harbour.example", "pat@harbour.example", "sam@harbour.example"]);
  });

  test("a profile the session cannot reach fails the track and is marked bad; the lead's email track goes on", async () => {
    const { h, campaign } = await world();
    h.linkedin.profiles.set(PAT, { unreachable: true });
    const c = await campaign([linkedin("li", [invite(), step("m1", 0, "Thanks.")]), emailTrack("e")]);
    await h.advanceTo(MONDAY_9 + H);
    const st = await h.store.engine.subject(c.lead("Pat Oneil"), h.clock);
    expect(st?.tracks.find((t) => t.trackId === "li")?.finishReason).toBe("failed_bad_destination");
    expect(st?.lead.details.find((d) => d.channel === "linkedin")?.bad).toBe(true);
    expect(h.fake.deliveryLog.some((d) => d.destination === "pat@harbour.example")).toBe(true);
  });
});

describe("allowances and the note (ADR 0004 sections 4 and 6)", () => {
  test("no allowance set: nothing goes on LinkedIn; set by the user, the invites go", async () => {
    const { h, campaign, delivered } = await world({ allowances: null });
    await campaign([linkedin("li", [invite(), step("m1", 0, "Thanks.")])]);
    await h.advanceTo(MONDAY_9 + 2 * H);
    expect(h.linkedin.handoverLog).toHaveLength(0);
    expect((await h.request("PUT", `/api/sender-accounts/${S1}/allowances`, { invitesPerDay: 2, messagesPerDay: 5, notesPerMonth: 5 })).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 4 * H);
    // Two invites a day: the third waits for the next day, never dropped.
    expect([PAT, NIA, SAM].map((p) => delivered(p).length).reduce((a, b) => a + b)).toBe(2);
    await h.advanceTo(MONDAY_9 + DAY + 2 * H);
    expect([PAT, NIA, SAM].map((p) => delivered(p).length).reduce((a, b) => a + b)).toBe(3);
  });

  test("the note goes while the note allowance lasts, then the invites go plain", async () => {
    const { h, campaign } = await world({ allowances: { invitesPerDay: 10, messagesPerDay: 10, notesPerMonth: 1 } });
    const c = await campaign([linkedin("li", [invite(), step("m1", 0, "Thanks.")])]);
    await h.advanceTo(MONDAY_9 + 2 * H);
    const invites = h.linkedin.deliveryLog.filter((d) => d.action === "invite");
    expect(invites).toHaveLength(3);
    expect(invites.filter((d) => d.rendered.body !== "")).toHaveLength(1);
    const notes = await Promise.all(["Pat Oneil", "Nia Cole", "Sam Lee"].map(async (n) => (await h.store.engine.subject(c.lead(n), h.clock))?.work.find((w) => w.kind === "invite")?.note));
    expect(notes.sort()).toEqual(["with", "withheld", "withheld"]);
  });

  test("an allowance is not for email or SMS accounts", async () => {
    const { h } = await world();
    expect((await h.request("PUT", "/api/sender-accounts/inbox-a/allowances", { invitesPerDay: 1, messagesPerDay: 1, notesPerMonth: 1 })).status).toBe(404);
    expect((await h.request("PUT", `/api/sender-accounts/${S1}/allowances`, { invitesPerDay: -1, messagesPerDay: 1, notesPerMonth: 1 })).status).toBe(400);
  });
});

describe("the reply mark (ADR 0004 section 7)", () => {
  test("refused before anything went on LinkedIn; accepted after, it stops that lead in that campaign only, and nothing more is handed over", async () => {
    const { h, campaign, delivered } = await world();
    h.linkedin.profiles.set(PAT, { acceptAfterMs: 2 * H });
    const c = await campaign([linkedin("li", [invite(), step("m1", 0, "Thanks."), step("m2", 1, "Following up.")]), emailTrack("e", { kind: "after", trackId: "li", delayDays: 5 })]);
    const early = await h.request<{ error: { message: string } }>("POST", `/api/enrollments/${c.lead("Kim Hart")}/replies`, { requestId: "r-kim", channel: "linkedin" });
    expect(early.status).toBe(409);
    expect(early.body.error.message).toContain("Nothing has been sent to them on LinkedIn");
    await h.advanceTo(MONDAY_9 + 3 * H);
    expect(delivered(PAT).map((d) => d.action)).toEqual(["invite", "message"]);
    const marked = await h.request<{ enrollment: EnrollmentProgress }>("POST", `/api/enrollments/${c.lead("Pat Oneil")}/replies`, { requestId: "r-pat", channel: "linkedin" });
    expect(marked.status).toBe(200);
    expect(marked.body.enrollment.status).toBe("replied");
    expect(JSON.stringify(marked.body.enrollment)).toContain("linkedin");
    // The same request id again is the same answer and changes nothing; a second mark is refused.
    expect((await h.request("POST", `/api/enrollments/${c.lead("Pat Oneil")}/replies`, { requestId: "r-pat", channel: "linkedin" })).status).toBe(200);
    expect((await h.request("POST", `/api/enrollments/${c.lead("Pat Oneil")}/replies`, { requestId: "r-pat-2", channel: "linkedin" })).status).toBe(409);
    await h.advanceTo(MONDAY_9 + 10 * DAY);
    expect(delivered(PAT).map((d) => d.stepId)).toEqual(["inv", "m1"]);
    expect(h.fake.deliveryLog.some((d) => d.destination === "pat@harbour.example")).toBe(false);
    // Nia, in the same campaign, carried on.
    expect(h.fake.deliveryLog.some((d) => d.destination === "sam@harbour.example")).toBe(true);
    const m = (await h.request<CampaignMeasures>("GET", `/api/campaigns/${c.id}/measures`)).body;
    expect(m.linkedin.replies).toBe(1);
    expect(m.replyRate.numerator).toBe(0);
    // Email and SMS replies are detected: the route marks LinkedIn only.
    expect((await h.request("POST", `/api/enrollments/${c.lead("Sam Lee")}/replies`, { requestId: "r-sam", channel: "email" })).status).toBe(400);
  });
});

describe("the running app presents no LinkedIn integration (ADR 0004 1.1)", () => {
  test("with no session connected, the provider read says none and a LinkedIn track cannot launch (blocker 3)", async () => {
    const h = new EngineHarness({ start: MONDAY_9, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
    await h.tick();
    expect((await h.request<{ provider: string }>("GET", "/api/linkedin-provider")).body.provider).toBe("none");
    const { campaign: c } = await h.createCampaign("No session", { businesses: BUSINESSES, people: PEOPLE });
    await h.defineSequence(c.id, definition([linkedin("li", [invite(), step("m1", 0, "Thanks.")])]));
    const launched = await h.launch(c.id);
    expect(launched.status).toBe(409);
    expect(JSON.stringify(launched.body)).toContain("no connected LinkedIn session");
  });
});
