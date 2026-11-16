import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { FakeSession } from "../../../test/support/fake-linkedin-port.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { CampaignMeasures, EnrollmentProgress, LeadSearchResult, NeedsAttention, TestRunTab } from "../../shared/api.ts";

/**
 * The review of 194fc44 (ticket 24a), each finding reproduced through the real HTTP app, store and engine against the
 * simulated LinkedIn provider. Every profile is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const PAT = "https://www.linkedin.com/in/fictional-pat-oneil";
const TEST = "https://www.linkedin.com/in/fictional-user-test-profile";

const step = (id: string, waitDays: number, body: string): StepDefinition => ({ id, waitDays, subject: "", body, threading: "new_subject", removed: false });
const li = (id: string, prefix: string, messages = 2, acceptWaitDays = 3): TrackDefinition => ({
  id,
  channel: "linkedin",
  branch: "main",
  window: ALWAYS,
  steps: [step(`${prefix}-inv`, 0, "Hello {{first_name|there}}."), ...Array.from({ length: messages }, (_, i) => step(`${prefix}-m${i + 1}`, i === 0 ? 0 : 1, `Message ${i + 1}.`))],
  start: { kind: "entry" },
  removed: false,
  acceptWaitDays,
});
const def = (tracks: TrackDefinition[], pool: readonly string[]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: [], linkedinPool: [...pool], tracks });
const session = (id: string): FakeSession => ({ id, gapMs: MIN, k: 1, healthy: true, resetZone: "Europe/London" });
const PEOPLE = [person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", linkedin_url: PAT })];
const BUSINESSES = [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })];

async function world(sessions = ["s1"], allowances: Record<string, { invitesPerDay: number; messagesPerDay: number; notesPerMonth: number }> = {}) {
  const h = new EngineHarness({ start: MONDAY_9 - H, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }], linkedin: { sessions: sessions.map(session) } });
  await h.tick();
  for (const s of sessions) await h.request("PUT", `/api/sender-accounts/${s}/allowances`, allowances[s] ?? { invitesPerDay: 20, messagesPerDay: 20, notesPerMonth: 20 });
  h.clock = Math.max(h.clock, MONDAY_9);
  let n = 0;
  const campaign = async (name: string, tracks: TrackDefinition[], pool: readonly string[] = sessions, people = PEOPLE) => {
    const { campaign: c } = await h.createCampaign(name, { businesses: BUSINESSES, people });
    await h.defineSequence(c.id, def(tracks, pool));
    const launched = await h.launch(c.id);
    if (launched.status !== 200) throw new Error(`launch refused: ${JSON.stringify(launched.body)}`);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
    return { id: c.id, lead: rows[0]?.enrollments.find((e) => e.campaign.id === c.id)?.id ?? "" };
  };
  const st = (id: string) => h.store.engine.subject(id, h.clock);
  const track = async (id: string, trackId: string) => (await st(id))?.tracks.find((t) => t.trackId === trackId);
  const read = (id: string) => h.request<EnrollmentProgress>("GET", `/api/enrollments/${id}`).then((r) => r.body);
  const control = (id: string, action: string) => h.request<{ error?: { message: string } }>("POST", `/api/enrollments/${id}/controls`, { requestId: `c-${++n}`, action });
  const mark = (id: string, expect?: { status: string }) => h.request<{ error?: { message: string } }>("POST", `/api/enrollments/${id}/replies`, { requestId: `m-${++n}`, channel: "linkedin", ...(expect ? { expect } : {}) });
  return { h, campaign, st, track, read, control, mark };
}

describe("item 1: two campaigns, one profile, one session: the pair belongs to the first that reached it (question Q41)", () => {
  test("B launched while A's invite is pending: no second invite; B's track is skipped naming A; after acceptance B sends nothing; a reply marked on A stops A, and B's mark is refused", async () => {
    const w = await world();
    w.h.linkedin.profiles.set(PAT, { acceptAfterMs: 5 * H });
    const a = await w.campaign("Spring", [li("a", "a")]);
    await w.h.advanceTo(MONDAY_9 + 10 * MIN);
    const b = await w.campaign("Autumn", [li("b", "b")]);
    await w.h.advanceTo(MONDAY_9 + 2 * DAY);
    expect(w.h.linkedin.handoverLog.filter((x) => x.action === "invite").map((x) => x.subjectId)).toEqual([a.lead]);
    expect((await w.track(b.lead, "b"))?.finishReason).toBe("skipped_conversation_taken");
    expect(JSON.stringify((await w.read(b.lead)).tracks)).toContain("Spring");
    expect(w.h.linkedin.handoverLog.some((x) => x.subjectId === b.lead)).toBe(false);
    expect((await w.mark(b.lead)).status).toBe(409);
    expect((await w.mark(a.lead)).status).toBe(200);
    const before = w.h.linkedin.handoverLog.length;
    await w.h.advanceTo(MONDAY_9 + 6 * DAY);
    expect(w.h.linkedin.handoverLog.length).toBe(before);
  });

  test("B launched after A's invite was accepted: B is skipped, never 'already connected', and sends no first message into A's thread", async () => {
    const w = await world();
    w.h.linkedin.profiles.set(PAT, { acceptAfterMs: H });
    const a = await w.campaign("Spring", [li("a", "a")]);
    await w.h.advanceTo(MONDAY_9 + 3 * H);
    const b = await w.campaign("Autumn", [li("b", "b")]);
    await w.h.advanceTo(MONDAY_9 + 3 * DAY);
    expect((await w.track(b.lead, "b"))?.finishReason).toBe("skipped_conversation_taken");
    expect((await w.track(b.lead, "b"))?.connection ?? null).toBeNull();
    expect(w.h.linkedin.deliveryLog.filter((x) => x.action === "message").map((x) => x.subjectId).every((s) => s === a.lead)).toBe(true);
  });

  test("A's invite withdrawn unaccepted leaves no conversation: the pair is released, and B, launched after, may invite", async () => {
    const w = await world();
    const a = await w.campaign("Spring", [li("a", "a", 1, 1)]);
    await w.h.advanceTo(MONDAY_9 + 2 * DAY);
    expect((await w.track(a.lead, "a"))?.finishReason).toBe("invite_not_accepted");
    expect(w.h.linkedin.withdrawalLog.map((x) => x.answer)).toContain("withdrawn");
    const b = await w.campaign("Autumn", [li("b", "b")]);
    await w.h.advanceTo(MONDAY_9 + 2 * DAY + H);
    expect(w.h.linkedin.deliveryLog.filter((x) => x.action === "invite").map((x) => x.subjectId)).toEqual([a.lead, b.lead]);
  });

  test("while A's invite is unknown (a lost answer), B waits under a hold naming A; once it is known sent, B is skipped", async () => {
    const w = await world();
    w.h.linkedin.profiles.set(PAT, { loseAnswer: 1 });
    await w.campaign("Spring", [li("a", "a")]);
    await w.h.advanceTo(MONDAY_9 + MIN);
    const b = await w.campaign("Autumn", [li("b", "b")]);
    await w.h.advanceTo(MONDAY_9 + 5 * MIN);
    expect((await w.read(b.lead)).tracks[0]?.hold).toBe("sms_conversation_unsettled");
    await w.h.advanceTo(MONDAY_9 + H);
    expect((await w.track(b.lead, "b"))?.finishReason).toBe("skipped_conversation_taken");
  });

  test("an invite pending on LinkedIn that this application did not send is never sent again: the invite is held, and once the person accepts it the track goes on as already connected", async () => {
    const w = await world();
    w.h.linkedin.profiles.set(PAT, { pendingElsewhere: true });
    const a = await w.campaign("Spring", [li("a", "a")]);
    await w.h.advanceTo(MONDAY_9 + H);
    expect(w.h.linkedin.handoverLog).toHaveLength(0);
    expect((await w.read(a.lead)).tracks[0]?.hold).toBe("invite_pending_elsewhere");
    expect((await w.read(a.lead)).tracks[0]?.linkedin?.pendingElsewhereSince).not.toBeNull();
    w.h.linkedin.acceptElsewhere(PAT);
    await w.h.advanceTo(MONDAY_9 + 2 * H);
    expect(w.h.linkedin.deliveryLog.map((x) => x.action)).toEqual(["message"]);
    expect((await w.track(a.lead, "a"))?.connection).toBe("already_connected");
  });

  test("a test run owns its pair: a second campaign's test run on the same test profile and session is skipped", async () => {
    const w = await world();
    const runIn = async (name: string, prefix: string) => {
      const { campaign: c } = await w.h.createCampaign(name, { businesses: BUSINESSES, people: PEOPLE });
      await w.h.defineSequence(c.id, def([li(prefix, prefix)], ["s1"]));
      await w.h.request("PUT", `/api/campaigns/${c.id}/test-contacts`, { email: "", mobile: "", linkedin: TEST });
      const tab = (await w.h.request<TestRunTab>("GET", `/api/campaigns/${c.id}/test-runs`)).body;
      const lead = (await w.h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows[0]?.enrollments.find((e) => e.campaign.id === c.id)?.id ?? "";
      expect((await w.h.request("POST", `/api/campaigns/${c.id}/test-runs`, { requestId: `run-${prefix}`, renderAs: lead, expect: { definitionVersion: tab.definitionVersion } })).status).toBe(200);
      return c.id;
    };
    await runIn("Spring", "a");
    await w.h.advanceTo(MONDAY_9 + 10 * MIN);
    const second = await runIn("Autumn", "b");
    await w.h.advanceTo(MONDAY_9 + 30 * MIN);
    expect(w.h.linkedin.handoverLog.filter((x) => x.action === "invite")).toHaveLength(1);
    expect(JSON.stringify((await w.h.request<TestRunTab>("GET", `/api/campaigns/${second}/test-runs`)).body)).toContain("sms_conversation_taken");
  });
});

describe("item 9: the connection gate, and skipping", () => {
  test("skipping the first message while waiting skips it, and the next message still waits for acceptance; it goes once accepted", async () => {
    const w = await world();
    w.h.linkedin.profiles.set(PAT, { acceptAfterMs: DAY });
    const a = await w.campaign("Spring", [li("a", "a", 2)]);
    await w.h.advanceTo(MONDAY_9 + H);
    expect((await w.control(a.lead, "skip")).status).toBe(200);
    await w.h.advanceTo(MONDAY_9 + 2 * H);
    expect(w.h.linkedin.handoverLog.filter((x) => x.action === "message")).toHaveLength(0);
    expect((await w.read(a.lead)).tracks[0]?.nextStep).toMatchObject({ when: { kind: "waits", why: "awaiting_acceptance" } });
    await w.h.advanceTo(MONDAY_9 + 3 * DAY);
    expect(w.h.linkedin.deliveryLog.filter((x) => x.action === "message").map((x) => x.stepId)).toEqual(["a-m2"]);
  });

  test("skipping an invite not yet sent leaves no connection: the track finishes skipped by the user and releases what waits on it", async () => {
    const w = await world(["s1"], { s1: { invitesPerDay: 0, messagesPerDay: 5, notesPerMonth: 5 } });
    const a = await w.campaign("Spring", [li("a", "a")]);
    await w.h.advanceTo(MONDAY_9 + H);
    expect((await w.control(a.lead, "skip")).status).toBe(200);
    expect((await w.track(a.lead, "a"))?.finishReason).toBe("skipped_by_user");
  });
});

describe("item 10: the connection's session is the track's sender", () => {
  test("already connected on a session with no message room: the first message waits for that session, never another", async () => {
    const w = await world(["s1", "s2", "s3"], { s1: { invitesPerDay: 5, messagesPerDay: 0, notesPerMonth: 5 }, s2: { invitesPerDay: 0, messagesPerDay: 5, notesPerMonth: 5 }, s3: { invitesPerDay: 0, messagesPerDay: 5, notesPerMonth: 5 } });
    w.h.linkedin.profiles.set(PAT, { connected: true });
    const a = await w.campaign("Spring", [li("a", "a")]);
    await w.h.advanceTo(MONDAY_9 + 2 * H);
    expect(w.h.linkedin.handoverLog).toHaveLength(0);
    expect((await w.st(a.lead))?.smsBindings.find((b) => b.owner === a.lead)?.sender).toBe("s1");
    // Signed out, then removed from the pool by an edit: a fixed sender is kept (ADR 0003 5.2), so it waits for s1.
    w.h.linkedin.sessions.get("s1")!.healthy = false;
    await w.h.advanceTo(MONDAY_9 + 4 * H);
    expect(w.h.linkedin.handoverLog).toHaveLength(0);
    w.h.linkedin.sessions.get("s1")!.healthy = true;
    await w.h.request("PUT", "/api/sender-accounts/s1/allowances", { invitesPerDay: 5, messagesPerDay: 5, notesPerMonth: 5 });
    await w.h.advanceTo(MONDAY_9 + 6 * H);
    expect(w.h.linkedin.deliveryLog.map((x) => x.sender)).toEqual(["s1"]);
  });
});

describe("items 3 and 11: the deadline on the lead's own clock, and edits of the wait", () => {
  test("paused: the read gives the pause as the reason with no date; resumed after a day, the wait ends a day later", async () => {
    const w = await world();
    const a = await w.campaign("Spring", [li("a", "a", 1, 3)]);
    await w.h.advanceTo(MONDAY_9 + H);
    const until = () => w.read(a.lead).then((r) => r.tracks[0]?.nextStep?.when);
    expect(await until()).toMatchObject({ kind: "waits", why: "awaiting_acceptance", until: "2026-11-05T00:00:00.000Z" });
    await w.control(a.lead, "pause");
    expect(await until()).toEqual({ kind: "waits", why: "lead_paused" });
    await w.h.advanceTo(MONDAY_9 + 25 * H);
    await w.control(a.lead, "resume");
    expect(await until()).toMatchObject({ until: "2026-11-06T00:00:00.000Z" });
  });

  test("shortening the wait re-resolves the deadline of a lead already waiting; one whose new deadline has passed expires once, at the edit", async () => {
    const w = await world();
    const a = await w.campaign("Spring", [li("a", "a", 1, 3)]);
    await w.h.advanceTo(MONDAY_9 + 2 * DAY);
    const stored = (await w.h.request<{ definition: CampaignDefinition }>("GET", `/api/campaigns/${a.id}/sequence`)).body.definition;
    const edited = { ...stored, tracks: stored.tracks.map((t) => ({ ...t, acceptWaitDays: 1 })) };
    const impact = await w.h.request<{ changes: { kind: string }[] }>("POST", `/api/campaigns/${a.id}/sequence/impact`, { definition: edited });
    expect(JSON.stringify(impact.body)).toContain("accept_wait");
    expect((await w.h.request("PUT", `/api/campaigns/${a.id}/sequence`, edited)).status).toBe(200);
    await w.h.advanceTo(w.h.clock + MIN);
    const t = await w.track(a.lead, "a");
    expect(t?.finishReason).toBe("invite_not_accepted");
    expect(t?.finishedWall).toBeGreaterThanOrEqual(MONDAY_9 + 2 * DAY);
  });
});

describe("items 4 to 7, 12 to 14: reads, withdrawals, marks, profile-only leads", () => {
  test("reads: the note, the withdrawal, an acceptance after the track finished, and an invite still open on an ended lead", async () => {
    const w = await world();
    w.h.linkedin.profiles.set(PAT, { acceptAfterMs: 3 * DAY, withdrawUnknown: 5 });
    const a = await w.campaign("Spring", [li("a", "a", 1, 1)]);
    await w.h.advanceTo(MONDAY_9 + H);
    expect((await w.read(a.lead)).tracks[0]?.linkedin).toMatchObject({ note: "with", inviteOpen: true, withdrawal: null });
    await w.h.advanceTo(MONDAY_9 + 2 * DAY);
    const r = (await w.read(a.lead)).tracks[0]?.linkedin;
    expect(r).toMatchObject({ withdrawal: "wanted", inviteOpen: true });
    // Item 5: three unknown answers list it in Needs attention; the user marks it still there.
    await w.h.advanceTo(MONDAY_9 + 2 * DAY + 2 * H);
    const attention = (await w.h.request<NeedsAttention>("GET", "/api/needs-attention")).body;
    expect(attention.inviteWithdrawalsUnknown?.map((x) => x.enrollmentId)).toEqual([a.lead]);
    expect((await w.h.request("POST", `/api/enrollments/${a.lead}/invite-withdrawal`, { requestId: "iw-1", trackId: "a", answer: "kept" })).status).toBe(200);
    await w.h.advanceTo(MONDAY_9 + 4 * DAY);
    expect((await w.read(a.lead)).tracks[0]?.linkedin).toMatchObject({ withdrawal: "kept_by_user", acceptedAfterFinish: true });
  });

  test("the mark: refused after an invite refused as an unreachable profile; refused when the read it was confirmed on changed; a test run's mark ends only the test, counted as test", async () => {
    const w = await world();
    w.h.linkedin.profiles.set(PAT, { unreachable: true });
    const a = await w.campaign("Spring", [li("a", "a")]);
    await w.h.advanceTo(MONDAY_9 + H);
    expect((await w.mark(a.lead)).status).toBe(409);
    w.h.linkedin.profiles.set(PAT, {});
    const { campaign: c } = await w.h.createCampaign("Test me", { businesses: BUSINESSES, people: PEOPLE });
    await w.h.defineSequence(c.id, def([li("t", "t")], ["s1"]));
    await w.h.request("PUT", `/api/campaigns/${c.id}/test-contacts`, { email: "", mobile: "", linkedin: TEST });
    const tab = (await w.h.request<TestRunTab>("GET", `/api/campaigns/${c.id}/test-runs`)).body;
    const lead = (await w.h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows[0]?.enrollments.find((e) => e.campaign.id === c.id)?.id ?? "";
    const run = await w.h.request<TestRunTab>("POST", `/api/campaigns/${c.id}/test-runs`, { requestId: "run-1", renderAs: lead, expect: { definitionVersion: tab.definitionVersion } });
    expect(run.status).toBe(200);
    await w.h.advanceTo(w.h.clock + 10 * MIN);
    const runId = run.body.run?.id ?? "";
    expect((await w.h.request("POST", `/api/test-runs/${runId}/replies`, { requestId: "tr-1", channel: "linkedin", expect: { status: "active" } })).status).toBe(200);
    const m = (await w.h.request<CampaignMeasures>("GET", `/api/campaigns/${c.id}/measures`)).body;
    expect(m.linkedin.replies).toBe(1);
    expect(m.linkedin.fromTests.replies).toBe(1);
    // The confirmation: a mark sent with a status the lead no longer has is refused, as the other controls are.
    w.h.linkedin.profiles.set(PAT, { acceptAfterMs: H });
    const b = await w.campaign("Autumn", [li("b", "b")], ["s1"], [person({ person_id: "p9", business_id: "b1", full_name: "Kit Rowe", linkedin_url: "https://www.linkedin.com/in/fictional-kit-rowe" })]);
    await w.h.advanceTo(w.h.clock + 10 * MIN);
    expect((await w.mark(b.lead, { status: "queued" })).status).toBe(409);
  });

  test("item 12: a person whose only channel is a member profile is enrolled; a company page alone is not", async () => {
    const w = await world();
    const { campaign: c, import: imp } = await w.h.createCampaign("Only LinkedIn", {
      // No main line: nothing but the profile can reach them.
      businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })],
      people: [
        person({ person_id: "q1", business_id: "b1", full_name: "Ana Lund", linkedin_url: "https://www.linkedin.com/in/fictional-ana-lund" }),
        person({ person_id: "q2", business_id: "b1", full_name: "Bo Diaz", linkedin_url: "https://www.linkedin.com/company/fictional-clinic" }),
      ],
    });
    const summary = JSON.stringify(imp.summary);
    expect(summary).toContain("Ana Lund");
    const enrolled = (await w.h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows.filter((r) => r.enrollments.some((e) => e.campaign.id === c.id)).map((r) => r.name);
    expect(enrolled).toContain("Ana Lund");
    expect(enrolled).not.toContain("Bo Diaz");
  });

  test("item 14: after an edit removes the pending first message, the read numbers the next one from 1 over the steps there are now", async () => {
    const w = await world();
    const a = await w.campaign("Spring", [li("a", "a", 2)]);
    await w.h.advanceTo(MONDAY_9 + H);
    const stored = (await w.h.request<{ definition: CampaignDefinition }>("GET", `/api/campaigns/${a.id}/sequence`)).body.definition;
    const edited = { ...stored, tracks: stored.tracks.map((t) => ({ ...t, steps: t.steps.map((s) => (s.id === "a-m1" ? { ...s, removed: true } : s.id === "a-m2" ? { ...s, waitDays: 0 } : s)) })) };
    expect((await w.h.request("PUT", `/api/campaigns/${a.id}/sequence`, edited)).status).toBe(200);
    const next = (await w.read(a.lead)).tracks[0]?.nextStep;
    expect(next).toMatchObject({ stepId: "a-m2", number: 2 });
  });
});

describe("the second pass on b21af02", () => {
  const SMS = "+447700900001";
  const MOBILE = "+447700900101";
  const smsTrack = (id: string): TrackDefinition => ({ id, channel: "sms", branch: "main", window: ALWAYS, steps: [step(`${id}-t1`, 0, "A text.")], start: { kind: "entry" }, removed: false });
  async function both(order: "sms_first" | "linkedin_first") {
    const h = new EngineHarness({ start: MONDAY_9 - H, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }], sms: { numbers: [{ id: SMS, capacity: 50, gapMs: MIN, k: 2, healthy: true, resetZone: "Europe/London" }] }, linkedin: { sessions: [session("s1")] } });
    await h.tick();
    await h.request("PUT", "/api/sender-accounts/s1/allowances", { invitesPerDay: 5, messagesPerDay: 5, notesPerMonth: 5 });
    h.clock = MONDAY_9;
    const people = [person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", dial_phone: MOBILE, dial_phone_type: "mobile", linkedin_url: PAT })];
    const { campaign: c } = await h.createCampaign("Both", { businesses: BUSINESSES, people });
    const tracks = order === "sms_first" ? [smsTrack("t"), { ...li("l", "l"), start: { kind: "after" as const, trackId: "t", delayDays: 0 } }] : [li("l", "l", 1, 1), { ...smsTrack("t"), start: { kind: "after" as const, trackId: "l", delayDays: 0 } }];
    await h.defineSequence(c.id, { ...def(tracks, ["s1"]), smsPool: [SMS] });
    expect((await h.launch(c.id)).status).toBe(200);
    return h;
  }

  test("item 3: an SMS pair is never the LinkedIn sender: SMS first, then LinkedIn, the invite goes from the session", async () => {
    const h = await both("sms_first");
    await h.advanceTo(MONDAY_9 + 2 * DAY);
    expect(h.sms.deliveryLog).toHaveLength(1);
    expect(h.linkedin.deliveryLog.map((d) => [d.action, d.sender])).toEqual([["invite", "s1"]]);
  });

  test("item 3, the reverse: LinkedIn first, then SMS: the text goes from the number", async () => {
    const h = await both("linkedin_first");
    await h.advanceTo(MONDAY_9 + 3 * DAY);
    expect(h.sms.deliveryLog.map((d) => d.sender)).toEqual([SMS]);
  });

  test("item 4: an existing connection needs no invite allowance: with none left, the first message goes on the message allowance", async () => {
    for (const invites of [0, 1]) {
      const w = await world(["s1"], { s1: { invitesPerDay: invites, messagesPerDay: 10, notesPerMonth: 0 } });
      w.h.linkedin.profiles.set(PAT, { connected: true });
      // With one invite a day, another lead's invite spends it first.
      const other = person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", linkedin_url: "https://www.linkedin.com/in/fictional-nia-cole" });
      await w.campaign("Spring", [li("a", "a")], ["s1"], [other, ...PEOPLE]);
      await w.h.advanceTo(MONDAY_9 + 2 * H);
      expect(w.h.linkedin.deliveryLog.filter((d) => d.destination === PAT).map((d) => d.action), `invites ${invites}`).toEqual(["message"]);
    }
  });

  test("item 4: no message allowance: the invite still goes, and the messages wait", async () => {
    const w = await world(["s1"], { s1: { invitesPerDay: 5, messagesPerDay: 0, notesPerMonth: 5 } });
    w.h.linkedin.profiles.set(PAT, { acceptAfterMs: H });
    await w.campaign("Spring", [li("a", "a")]);
    await w.h.advanceTo(MONDAY_9 + DAY);
    expect(w.h.linkedin.deliveryLog.map((d) => d.action)).toEqual(["invite"]);
  });

  test("item 5: an existing connection is not outreach: with nothing handed over, the mark is refused", async () => {
    const w = await world(["s1"], { s1: { invitesPerDay: 5, messagesPerDay: 0, notesPerMonth: 5 } });
    w.h.linkedin.profiles.set(PAT, { connected: true });
    const a = await w.campaign("Spring", [li("a", "a")]);
    await w.h.advanceTo(MONDAY_9 + 2 * H);
    expect((await w.track(a.lead, "a"))?.connection).toBe("already_connected");
    expect((await w.mark(a.lead)).status).toBe(409);
  });

  test("item 7: the user's 'withdrawn' mark on an ended lead releases the pair at once: another campaign then invites", async () => {
    const w = await world();
    w.h.linkedin.profiles.set(PAT, { withdrawUnknown: 50 });
    const a = await w.campaign("Spring", [li("a", "a", 1, 1)]);
    await w.h.advanceTo(MONDAY_9 + 2 * DAY + 2 * H);
    expect((await w.read(a.lead)).status).toBe("sequence_finished_no_response");
    expect((await w.h.request("POST", `/api/enrollments/${a.lead}/invite-withdrawal`, { requestId: "iw-1", trackId: "a", answer: "withdrawn" })).status).toBe(200);
    const b = await w.campaign("Autumn", [li("b", "b")]);
    await w.h.advanceTo(w.h.clock + H);
    expect(w.h.linkedin.deliveryLog.filter((d) => d.action === "invite").map((d) => d.subjectId)).toEqual([a.lead, b.lead]);
  });
});
