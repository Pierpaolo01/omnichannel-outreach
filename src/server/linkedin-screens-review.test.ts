import { describe, expect, test } from "vitest";
import { linkedinAccountId } from "./engine/ports.ts";
import { EngineHarness } from "../../test/support/engine-harness.ts";
import { business, person } from "../../test/support/export-builder.ts";
import { PREVIEW_CHANGED } from "../domain/sequence/controls.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../domain/sequence/definition.ts";
import type { BeforeLaunchView, EnrollmentRead, LeadSearchResult, NeedsAttention, SequenceView, TestRunTab } from "../shared/api.ts";

/**
 * The council's first review of ticket 24b's `dee365d`: each read that let a screen say something untrue, through HTTP on
 * the simulated LinkedIn provider. Every profile is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const S1 = "li-session-1";
const SESSION = linkedinAccountId(S1);
const PAT = "https://www.linkedin.com/in/fictional-pat-oneil";
const TEST = "https://www.linkedin.com/in/fictional-user-test-profile";

const step = (id: string, waitDays: number, body: string): StepDefinition => ({ id, waitDays, subject: "", body, threading: "new_subject", removed: false });
const linkedin = (acceptWaitDays = 3): TrackDefinition => ({ id: "li", channel: "linkedin", branch: "main", window: ALWAYS, steps: [step("inv", 0, "Hello."), step("m1", 0, "Thanks.")], start: { kind: "entry" }, removed: false, acceptWaitDays });
const email = (start: TrackDefinition["start"] = { kind: "entry" }): TrackDefinition => ({
  id: "em",
  channel: "email",
  branch: "main",
  window: ALWAYS,
  steps: [{ id: "em-1", waitDays: 0, subject: "Hello", body: "Email.", threading: "new_subject", removed: false }],
  start,
  removed: false,
});
const definition = (tracks: TrackDefinition[], linkedinPool: string[] = [SESSION]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: [], linkedinPool, tracks });
const PEOPLE = [person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", linkedin_url: PAT })];
const BUSINESSES = [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })];

async function world(options: { session?: boolean; allowances?: { invitesPerDay: number; messagesPerDay: number; notesPerMonth: number } } = {}) {
  const h = new EngineHarness({
    start: MONDAY_9 - H,
    accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    ...(options.session === false ? {} : { linkedin: { sessions: [{ id: S1, gapMs: MIN, k: 1, healthy: true, resetZone: "Europe/London" }] } }),
  });
  await h.tick();
  if (options.session !== false) expect((await h.request("PUT", `/api/sender-accounts/${SESSION}/allowances`, options.allowances ?? { invitesPerDay: 20, messagesPerDay: 10, notesPerMonth: 20 })).status).toBe(200);
  const campaign = async (name: string) => (await h.createCampaign(name, { businesses: BUSINESSES, people: PEOPLE })).campaign.id;
  const lead = async (id: string) => (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${id}`)).body.rows[0]?.enrollments.find((e) => e.campaign.id === id)?.id ?? "";
  return { h, campaign, lead };
}

describe("item 1: a LinkedIn track's load figure is withheld as not modelled, session or none", () => {
  test("with no session connected, the reason is never that a session would bring a figure", async () => {
    const { h, campaign } = await world({ session: false });
    const id = await campaign("No session");
    await h.defineSequence(id, definition([linkedin(), email()], []));
    const load = (await h.request<BeforeLaunchView>("GET", `/api/campaigns/${id}/before-launch`)).body.load;
    expect(load?.withheldBy?.tracks).toEqual([{ trackId: "li", channel: "linkedin", label: "the LinkedIn track", why: "not_modelled" }]);
  });
});

describe("item 4: a LinkedIn session's room is read per kind, never summed", () => {
  test("Before launch and the sequence read give invites and messages apart", async () => {
    const { h, campaign } = await world();
    const running = await campaign("Running");
    await h.defineSequence(running, definition([linkedin()]));
    h.clock = MONDAY_9;
    expect((await h.launch(running)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 10 * MIN);
    const draft = await campaign("Draft");
    await h.defineSequence(draft, definition([linkedin()]));
    const row = (await h.request<BeforeLaunchView>("GET", `/api/campaigns/${draft}/before-launch`)).body.load?.accounts.find((a) => a.id === SESSION);
    expect(row?.kinds).toEqual({ invite: { capacity: 20, usedToday: 1 }, message: { capacity: 10, usedToday: 0 } });
    const account = (await h.request<SequenceView>("GET", `/api/campaigns/${draft}/sequence`)).body.accounts.find((a) => a.id === SESSION);
    expect(account?.kinds).toEqual({ invite: { capacity: 20, usedToday: 1 }, message: { capacity: 10, usedToday: 0 } });
  });

  test("an invite whose kind has no room today is listed as waiting for capacity, on LinkedIn", async () => {
    const { h, campaign } = await world({ allowances: { invitesPerDay: 0, messagesPerDay: 10, notesPerMonth: 0 } });
    const id = await campaign("No invite room");
    await h.defineSequence(id, definition([linkedin()]));
    h.clock = MONDAY_9;
    expect((await h.launch(id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 30 * MIN);
    const waiting = (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body.waitingForCapacity;
    expect(waiting.map((w) => [w.channel, w.stepId, w.accountIds])).toEqual([["linkedin", "inv", [SESSION]]]);
  });
});

describe("item 7: a stop confirmed while an invite was open is refused once it was accepted", () => {
  test("the stop's preview digest changes with the open invite, so the server refuses the stale confirmation", async () => {
    const { h, campaign, lead } = await world();
    h.linkedin.profiles.set(PAT, { acceptAfterMs: 2 * H });
    const id = await campaign("Stop");
    // The first message waits three days after the acceptance, so the acceptance changes nothing but the open invite.
    const slow = { ...linkedin(), steps: [step("inv", 0, "Hello."), step("m1", 3, "Thanks.")] };
    await h.defineSequence(id, definition([slow, email({ kind: "after", trackId: "li", delayDays: 5 })]));
    h.clock = MONDAY_9;
    expect((await h.launch(id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 10 * MIN);
    const pat = await lead(id);
    const read = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${pat}`)).body;
    const stop = read.controls.find((c) => c.action === "stop");
    if (!stop?.allowed) throw new Error("stop not offered");
    // Pat accepts two hours after the invite (the provider's script): the invite is no longer open.
    await h.advanceTo(MONDAY_9 + 3 * H);
    const now = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${pat}`)).body;
    expect(now.status).toBe(read.status);
    expect(now.tracks.find((t) => t.trackId === "li")?.nextStep?.stepId).toBe(read.tracks.find((t) => t.trackId === "li")?.nextStep?.stepId);
    const refused = await h.request<{ error: { message: string } }>("POST", `/api/enrollments/${pat}/controls`, { requestId: "stop-1", action: "stop", expect: { status: read.status, preview: stop.digest } });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe(PREVIEW_CHANGED);
  });
});

describe("item 8: another campaign on the same senders with a LinkedIn track withholds this campaign's figure", () => {
  test("an email-only campaign sharing an inbox with a running LinkedIn campaign gets no figure, naming that campaign", async () => {
    const { h, campaign } = await world();
    const other = await campaign("LinkedIn first, then email");
    await h.defineSequence(other, definition([linkedin(), email({ kind: "after", trackId: "li", delayDays: 0 })]));
    h.clock = MONDAY_9;
    expect((await h.launch(other)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 10 * MIN);
    const mine = await campaign("Email only");
    await h.defineSequence(mine, definition([email()], []));
    const load = (await h.request<BeforeLaunchView>("GET", `/api/campaigns/${mine}/before-launch`)).body.load;
    expect(load?.withheldBy?.tracks).toEqual([{ trackId: "li", channel: "linkedin", label: "the LinkedIn track", why: "not_modelled", campaign: "LinkedIn first, then email" }]);
    expect(load?.leadsToStart).toBeNull();
  });
});

describe("item 3: a test run's stuck withdrawal is read on its tab and settled there", () => {
  test("the run's read carries its LinkedIn track's facts; the user's answer settles the withdrawal through the same transition", async () => {
    const { h, campaign, lead } = await world();
    h.linkedin.profiles.set(TEST, { withdrawUnknown: 50 });
    const id = await campaign("Test");
    await h.defineSequence(id, definition([linkedin(1)]));
    expect((await h.request("PUT", `/api/campaigns/${id}/test-contacts`, { email: "", mobile: "", linkedin: TEST })).status).toBe(200);
    const tab = (await h.request<TestRunTab>("GET", `/api/campaigns/${id}/test-runs`)).body;
    h.clock = MONDAY_9;
    expect((await h.request("POST", `/api/campaigns/${id}/test-runs`, { requestId: "run-1", renderAs: await lead(id), expect: { definitionVersion: tab.definitionVersion } })).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 2 * DAY);
    const run = (await h.request<TestRunTab>("GET", `/api/campaigns/${id}/test-runs`)).body.run;
    expect(run?.linkedinTracks).toEqual([{ trackId: "li", view: expect.objectContaining({ withdrawal: "wanted", withdrawalStuck: true }) }]);
    const answered = await h.request<TestRunTab>("POST", `/api/test-runs/${run?.id ?? ""}/invite-withdrawal`, { requestId: "w-1", trackId: "li", answer: "withdrawn" });
    expect(answered.status).toBe(200);
    expect(answered.body.run?.linkedinTracks[0]?.view).toMatchObject({ withdrawal: "withdrawn", withdrawalStuck: false });
  });
});

describe("item 11: the read says an invite went only once the engine records it sent", () => {
  test("with the handover's answer lost and the lookup not yet answered, the invite is handed over, not sent, and nothing is open", async () => {
    const { h, campaign, lead } = await world();
    h.linkedin.profiles.set(PAT, { loseAnswer: 5 });
    const id = await campaign("Unknown");
    await h.defineSequence(id, definition([linkedin()]));
    h.clock = MONDAY_9;
    expect((await h.launch(id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 2 * MIN);
    const view = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${await lead(id)}`)).body.tracks.find((t) => t.trackId === "li")?.linkedin;
    expect(view).toMatchObject({ invite: "handed", note: "with", inviteOpen: false });
  });
});

describe("item 15: a LinkedIn step with no allowance, or none left today, on the record and in Needs attention", () => {
  const launch = async (allowances: { invitesPerDay: number; messagesPerDay: number; notesPerMonth: number } | null, people = PEOPLE) => {
    const h = new EngineHarness({
      start: MONDAY_9 - H,
      accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
      linkedin: { sessions: [{ id: S1, gapMs: MIN, k: 1, healthy: true, resetZone: "Europe/London" }] },
    });
    await h.tick();
    if (allowances) expect((await h.request("PUT", `/api/sender-accounts/${SESSION}/allowances`, allowances)).status).toBe(200);
    const { campaign } = await h.createCampaign("LinkedIn only", { businesses: BUSINESSES, people });
    await h.defineSequence(campaign.id, definition([linkedin()]));
    h.clock = MONDAY_9;
    expect((await h.launch(campaign.id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 30 * MIN);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows;
    return { h, enrollments: rows.map((r) => r.enrollments[0]?.id ?? "") };
  };
  for (const [name, allowances] of [["set to zero", { invitesPerDay: 0, messagesPerDay: 0, notesPerMonth: 0 }], ["never set", null]] as const) {
    test(`an allowance ${name}: the read says no allowance, never full today, and Needs attention lists it with no reset`, async () => {
      const { h, enrollments } = await launch(allowances);
      const read = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${enrollments[0] ?? ""}`)).body;
      expect(read.tracks.find((t) => t.trackId === "li")?.nextStep?.when).toMatchObject({ kind: "waits", why: "no_allowance", channel: "linkedin" });
      const waiting = (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body.waitingForCapacity;
      expect(waiting.map((w) => [w.channel, w.stepId, w.noAllowance, w.action])).toEqual([["linkedin", "inv", true, "invite"]]);
    });
  }
  test("an allowance used up today: the read says sending capacity, and Needs attention lists it with its reset", async () => {
    const two = [...PEOPLE, person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", email: "nia@harbour.example", linkedin_url: "https://www.linkedin.com/in/fictional-nia-cole" })];
    const { h } = await launch({ invitesPerDay: 1, messagesPerDay: 5, notesPerMonth: 0 }, two);
    const waiting = (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body.waitingForCapacity;
    expect(waiting.map((w) => [w.channel, w.noAllowance, w.action])).toEqual([["linkedin", false, "invite"]]);
  });
});

describe("item 11, continued: a step handed over and not yet reported promises no send", () => {
  test("the read's wait is with the provider while the answer is unknown; the wording says it isn't known whether it went", async () => {
    const { h, campaign, lead } = await world();
    h.linkedin.profiles.set(PAT, { loseAnswer: 5 });
    const id = await campaign("Unknown");
    await h.defineSequence(id, definition([linkedin()]));
    h.clock = MONDAY_9;
    expect((await h.launch(id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 2 * MIN);
    const read = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${await lead(id)}`)).body;
    expect(read.status).toBe("queued");
    expect(read.tracks.find((t) => t.trackId === "li")?.linkedin?.invite).toBe("handed");
  });
});
