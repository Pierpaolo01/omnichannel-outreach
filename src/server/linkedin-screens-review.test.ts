import { describe, expect, test } from "vitest";
import { linkedinAccountId } from "./engine/ports.ts";
import { EngineHarness } from "../../test/support/engine-harness.ts";
import { business, csvOf, person } from "../../test/support/export-builder.ts";
import { inviteOpenOn, invitingWork } from "../domain/sequence/progress.ts";
import type { SubjectState } from "../domain/sequence/state.ts";
import { linkedinTrackView } from "./engine/views.ts";
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
    expect(load?.withheldBy?.tracks).toEqual([{ trackId: "li", channel: "linkedin", label: "the LinkedIn track", why: "not_modelled", competing: { name: "LinkedIn first, then email", test: false, own: false, why: "inbox" } }]);
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

describe("item 2 of the review of a6c1700: no allowance is judged on the sessions the engine uses for the lead", () => {
  test("a lead keeping session A (invites, no messages) beside B (messages, no invites): no allowance on the record and on Today alike", async () => {
    const S2 = "li-session-2";
    const h = new EngineHarness({
      start: MONDAY_9 - H,
      accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
      linkedin: { sessions: [{ id: S1, gapMs: MIN, k: 1, healthy: true, resetZone: "Europe/London" }, { id: S2, gapMs: MIN, k: 1, healthy: true, resetZone: "Europe/London" }] },
    });
    await h.tick();
    expect((await h.request("PUT", `/api/sender-accounts/${SESSION}/allowances`, { invitesPerDay: 20, messagesPerDay: 0, notesPerMonth: 0 })).status).toBe(200);
    expect((await h.request("PUT", `/api/sender-accounts/${linkedinAccountId(S2)}/allowances`, { invitesPerDay: 0, messagesPerDay: 10, notesPerMonth: 0 })).status).toBe(200);
    h.linkedin.profiles.set(PAT, { acceptAfterMs: H });
    const { campaign } = await h.createCampaign("Two sessions", { businesses: BUSINESSES, people: PEOPLE });
    await h.defineSequence(campaign.id, definition([linkedin()], [SESSION, linkedinAccountId(S2)]));
    h.clock = MONDAY_9;
    expect((await h.launch(campaign.id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 3 * H);
    expect(h.linkedin.deliveryLog.filter((d) => d.destination === PAT).map((d) => [d.action, d.sender])).toEqual([["invite", S1]]);
    const pat = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows[0]?.enrollments[0]?.id ?? "";
    const when = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${pat}`)).body.tracks.find((t) => t.trackId === "li")?.nextStep?.when;
    expect(when).toMatchObject({ kind: "waits", why: "no_allowance" });
    const waiting = (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body.waitingForCapacity;
    expect(waiting.map((w) => [w.stepId, w.action, w.noAllowance])).toEqual([["m1", "message", true]]);
  });
});

describe("item 5 of the review of a6c1700: a competing campaign withholds the figure only while its LinkedIn track is still to finish", () => {
  test("once every lead of the other campaign has finished its LinkedIn track, this campaign's figure is shown", async () => {
    const { h, campaign } = await world();
    h.linkedin.profiles.set(PAT, { acceptAfterMs: H });
    const other = await campaign("LinkedIn, done");
    // Its email waits five days after the LinkedIn track, so its lead is still running with that track finished.
    await h.defineSequence(other, definition([linkedin(), email({ kind: "after", trackId: "li", delayDays: 5 })]));
    h.clock = MONDAY_9;
    expect((await h.launch(other)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + DAY);
    const running = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${other}`)).body.rows[0]?.enrollments[0];
    expect(running?.status).toBe("active");
    const mine = await campaign("Email only");
    await h.defineSequence(mine, definition([email()], []));
    const load = (await h.request<BeforeLaunchView>("GET", `/api/campaigns/${mine}/before-launch`)).body.load;
    expect(load?.withheldBy).toBeNull();
  });
});

describe("the review bot on a6c1700: every sender-side explanation comes from dispatch's own eligible sessions", () => {
  const S2 = "li-session-2";
  const twoSessions = async (s1: { invitesPerDay: number; messagesPerDay: number }, s2: { invitesPerDay: number; messagesPerDay: number }) => {
    const h = new EngineHarness({
      start: MONDAY_9 - H,
      accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
      linkedin: { sessions: [{ id: S1, gapMs: MIN, k: 1, healthy: true, resetZone: "Europe/London" }, { id: S2, gapMs: MIN, k: 1, healthy: true, resetZone: "Europe/London" }] },
    });
    await h.tick();
    expect((await h.request("PUT", `/api/sender-accounts/${SESSION}/allowances`, { ...s1, notesPerMonth: 0 })).status).toBe(200);
    expect((await h.request("PUT", `/api/sender-accounts/${linkedinAccountId(S2)}/allowances`, { ...s2, notesPerMonth: 0 })).status).toBe(200);
    const { campaign } = await h.createCampaign("Two sessions", { businesses: BUSINESSES, people: PEOPLE });
    await h.defineSequence(campaign.id, definition([linkedin()], [SESSION, linkedinAccountId(S2)]));
    const read = async () => {
      const pat = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows[0]?.enrollments[0]?.id ?? "";
      return {
        when: (await h.request<EnrollmentRead>("GET", `/api/enrollments/${pat}`)).body.tracks.find((t) => t.trackId === "li")?.nextStep?.when,
        waiting: (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body.waitingForCapacity.map((w) => [w.stepId, w.accountIds, w.noAllowance]),
      };
    };
    return { h, id: campaign.id, read };
  };

  test("(a) already connected on s1, which allows no messages, s2 allowing ten: both reads say no allowance on s1 alone", async () => {
    const { h, id, read } = await twoSessions({ invitesPerDay: 10, messagesPerDay: 0 }, { invitesPerDay: 10, messagesPerDay: 10 });
    h.linkedin.profiles.set(PAT, { sessions: { [S1]: { connected: true } } });
    h.clock = MONDAY_9;
    expect((await h.launch(id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + H);
    const { when, waiting } = await read();
    expect(when).toMatchObject({ kind: "waits", why: "no_allowance" });
    expect(waiting).toEqual([["m1", [SESSION], true]]);
  });

  test("(b) s1 clear with no invite allowance, s2 allowing ten but with an invite pending from elsewhere: both reads say no allowance, and the lead is listed", async () => {
    const { h, id, read } = await twoSessions({ invitesPerDay: 0, messagesPerDay: 10 }, { invitesPerDay: 10, messagesPerDay: 10 });
    h.linkedin.profiles.set(PAT, { sessions: { [S2]: { pendingElsewhere: true } } });
    h.clock = MONDAY_9;
    expect((await h.launch(id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + H);
    expect(h.linkedin.deliveryLog.filter((d) => d.destination === PAT)).toEqual([]);
    const { when, waiting } = await read();
    expect(when).toMatchObject({ kind: "waits", why: "no_allowance" });
    expect(waiting).toEqual([["inv", [SESSION], true]]);
  });
});

describe("item 8 of a6c1700's council: the invite work that counts, whatever the order of attempts", () => {
  const work = (fields: Record<string, unknown>) => ({ trackId: "li", kind: "invite", firstHandedWall: 1, settled: null, sentWall: null, note: "with", ...fields });
  const state = (w: Record<string, unknown>[], track: Record<string, unknown> = {}) => ({ work: w, tracks: [{ trackId: "li", acceptedWall: null, connection: null, inviteWithdrawal: null, ...track }] }) as unknown as SubjectState;
  test("an earlier attempt settled not sent never hides a later one that was sent, in either order", () => {
    const failed = work({ firstHandedWall: 1, settled: "not_sent" });
    const sent = work({ firstHandedWall: 2, settled: "sent", sentWall: 3 });
    for (const order of [[failed, sent], [sent, failed]]) {
      expect(invitingWork(state(order), "li")).toMatchObject({ sent: true, work: { firstHandedWall: 2 } });
      expect(inviteOpenOn(state(order), "li")).toBe(true);
    }
  });
  test("with none sent, the latest still unsettled counts as handed; settled not sent alone counts as nothing", () => {
    const failed = work({ firstHandedWall: 1, settled: "user_not_sent" });
    const pending = work({ firstHandedWall: 2 });
    expect(invitingWork(state([failed, pending]), "li")).toMatchObject({ sent: false, work: { firstHandedWall: 2 } });
    expect(invitingWork(state([failed]), "li")).toBeNull();
    expect(inviteOpenOn(state([failed, pending]), "li")).toBe(false);
  });
});

describe("item 9 of a6c1700's council: a withdrawal is said as asked only once the session was asked", () => {
  test("wanted with no answer yet reads not asked; after an unknown answer, asked", async () => {
    const { h, campaign, lead } = await world();
    h.linkedin.profiles.set(PAT, { withdrawUnknown: 50 });
    const id = await campaign("Expiry");
    await h.defineSequence(id, definition([linkedin(1)]));
    h.clock = MONDAY_9;
    expect((await h.launch(id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 2 * DAY);
    const stored = await h.store.engine.subject(await lead(id), h.clock);
    if (!stored) throw new Error("no subject");
    const asked = linkedinTrackView(stored, "li");
    expect(asked).toMatchObject({ withdrawal: "wanted", withdrawalAsked: true });
    // The same track before the worker's first ask: the stored answers removed.
    const before = { ...stored, tracks: stored.tracks.map((t) => (t.trackId === "li" ? { ...t, inviteWithdrawalUnknowns: 0, inviteWithdrawalLastWall: null } : t)) };
    expect(linkedinTrackView(before, "li")).toMatchObject({ withdrawal: "wanted", withdrawalAsked: false });
  });
});

describe("item 10 of a6c1700's council: a skip as a missing channel says its stored cause", () => {
  test("a profile replaced by a re-import, a company page, and no address each read their own cause", async () => {
    const { h } = await world();
    h.linkedin.profiles.set(PAT, { acceptAfterMs: null });
    const people = [
      ...PEOPLE,
      person({ person_id: "p2", business_id: "b1", full_name: "Kim Hart", email: "kim@harbour.example", linkedin_url: "https://www.linkedin.com/company/fictional-harbour" }),
      person({ person_id: "p3", business_id: "b1", full_name: "Ola Berg", email: "ola@harbour.example" }),
    ];
    const { campaign: c } = await h.createCampaign("Causes", { businesses: BUSINESSES, people });
    const slow = { ...linkedin(), steps: [step("inv", 0, "Hello."), step("m1", 3, "Thanks.")] };
    await h.defineSequence(c.id, definition([slow, email({ kind: "after", trackId: "li", delayDays: 9 })]));
    h.clock = MONDAY_9;
    expect((await h.launch(c.id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + H);
    // Pat's invite went; a re-import gives Pat a different member profile, retiring the one the track started with.
    const again = await h.request("POST", `/api/campaigns/${c.id}/imports`, csvOf({ businesses: BUSINESSES, people: [person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", linkedin_url: "https://www.linkedin.com/in/fictional-pat-oneil-2" })] }));
    expect(again.status).toBeLessThan(300);
    await h.advanceTo(MONDAY_9 + 2 * H);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
    const cause = async (name: string) => {
      const id = rows.find((r) => r.name === name)?.enrollments.find((e) => e.campaign.id === c.id)?.id ?? "";
      return (await h.request<EnrollmentRead>("GET", `/api/enrollments/${id}`)).body.tracks.find((t) => t.trackId === "li")?.linkedin?.skipCause;
    };
    expect(await cause("Pat Oneil")).toBe("replaced");
    expect(await cause("Kim Hart")).toBe("not_a_member_profile");
    expect(await cause("Ola Berg")).toBe("no_profile");
  });

  test("a re-import that removes the profile the track started with reads as removed, never as a different profile", async () => {
    const { h } = await world();
    h.linkedin.profiles.set(PAT, { acceptAfterMs: null });
    const { campaign: c } = await h.createCampaign("Removed", { businesses: BUSINESSES, people: PEOPLE });
    const slow = { ...linkedin(), steps: [step("inv", 0, "Hello."), step("m1", 3, "Thanks.")] };
    await h.defineSequence(c.id, definition([slow, email({ kind: "after", trackId: "li", delayDays: 9 })]));
    h.clock = MONDAY_9;
    expect((await h.launch(c.id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + H);
    const again = await h.request("POST", `/api/campaigns/${c.id}/imports`, csvOf({ businesses: BUSINESSES, people: [person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", linkedin_url: "https://www.linkedin.com/company/fictional-harbour" })] }));
    expect(again.status).toBeLessThan(300);
    await h.advanceTo(MONDAY_9 + 2 * H);
    const id = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows[0]?.enrollments[0]?.id ?? "";
    const view = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${id}`)).body.tracks.find((t) => t.trackId === "li")?.linkedin;
    expect(view?.skipCause).toBe("removed_by_import");
  });
});

describe("the review bot on 82cf16d: a test run's invitation handed over and not known to have gone", () => {
  test("the run's read carries it as handed, and the mark is allowed by the rule for work handed over and unsettled", async () => {
    const { h, campaign, lead } = await world();
    h.linkedin.profiles.set(TEST, { loseAnswer: 50 });
    const id = await campaign("Unknown test");
    await h.defineSequence(id, definition([linkedin()]));
    expect((await h.request("PUT", `/api/campaigns/${id}/test-contacts`, { email: "", mobile: "", linkedin: TEST })).status).toBe(200);
    const tab = (await h.request<TestRunTab>("GET", `/api/campaigns/${id}/test-runs`)).body;
    h.clock = MONDAY_9;
    expect((await h.request("POST", `/api/campaigns/${id}/test-runs`, { requestId: "run-u", renderAs: await lead(id), expect: { definitionVersion: tab.definitionVersion } })).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 2 * MIN);
    const run = (await h.request<TestRunTab>("GET", `/api/campaigns/${id}/test-runs`)).body.run;
    expect(run?.linkedinTracks[0]?.view.invite).toBe("handed");
    expect(run?.linkedinReply).toEqual({ allowed: true });
  });
});
