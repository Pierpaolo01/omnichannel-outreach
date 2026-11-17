import { describe, expect, test } from "vitest";
import { linkedinAccountId } from "./ports.ts";
import { DEFAULT_RULES } from "./rules.ts";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { FakeSession } from "../../../test/support/fake-linkedin-port.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { CampaignMeasures, LeadSearchResult } from "../../shared/api.ts";

/**
 * The InMail fallback (ticket 27, ADR 0004 section 13) through the real HTTP app, SQLite store and engine, against the
 * simulated LinkedIn provider. No LinkedIn session is connected: the simulated sessions script their own InMail standing
 * (plan and credits) as a session would report it. Every profile URL here is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
/** Monday 2 November 2026, 09:00 London (GMT). */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
/** Two calendar days after an invite sent on Monday morning: Wednesday 00:00 London. */
const WEDNESDAY_0 = Date.parse("2026-11-04T00:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const OFFICE = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 9, end: 17 }));
const S1 = "li-session-1";

const PAT = "https://www.linkedin.com/in/fictional-pat-oneil";
const NIA = "https://www.linkedin.com/in/fictional-nia-cole";

const step = (id: string, waitDays: number, body: string): StepDefinition => ({ id, waitDays, subject: "", body, threading: "new_subject", removed: false });
const inmail = (id = "im", body = "Hello {{first_name|there}}, a short note about {{company}}."): StepDefinition => ({ ...step(id, 0, body), role: "inmail" });
const linkedin = (steps: StepDefinition[], window = ALWAYS): TrackDefinition => ({ id: "li", channel: "linkedin", branch: "main", window, steps, start: { kind: "entry" }, removed: false, acceptWaitDays: 2 });
const definition = (tracks: TrackDefinition[]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: [], linkedinPool: [linkedinAccountId(S1)], tracks });
const FALLBACK = [step("inv", 0, "Hello {{first_name|there}}."), inmail(), step("m1", 0, "Thanks for connecting."), step("m2", 3, "Following up."), step("m3", 2, "One last note.")];

const PEOPLE = [
  person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", linkedin_url: PAT }),
  person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", linkedin_url: NIA }),
];
const BUSINESSES = [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })];

async function world(inmailStanding: FakeSession["inmail"] | null = { plan: "premium", credits: 5 }, options: { readonly invitesPerDay?: number; readonly people?: typeof PEOPLE } = {}) {
  const session: FakeSession = { id: S1, gapMs: MIN, k: 1, healthy: true, resetZone: "Europe/London", ...(inmailStanding ? { inmail: inmailStanding } : {}) };
  const h = new EngineHarness({ start: MONDAY_9 - H, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }], linkedin: { sessions: [session] } });
  await h.tick();
  expect((await h.request("PUT", `/api/sender-accounts/${linkedinAccountId(S1)}/allowances`, { invitesPerDay: options.invitesPerDay ?? 20, messagesPerDay: 20, notesPerMonth: 20 })).status).toBe(200);
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
  const track = async (lead: string) => (await h.store.engine.subject(lead, h.clock))?.tracks.find((t) => t.trackId === "li");
  const results = async (lead: string) => (await h.store.engine.subject(lead, h.clock))?.results.filter((r) => r.trackId === "li") ?? [];
  return { h, campaign, delivered, track, results };
}

describe("the fallback on, a session that reports Premium with credits (ADR 0004 13.3)", () => {
  test("at the expiry one InMail goes, the invite stays open, the first message is not sent, and the follow-ups follow the InMail", async () => {
    const { h, campaign, delivered, track, results } = await world();
    const c = await campaign([linkedin(FALLBACK)]);
    await h.advanceTo(MONDAY_9 + H);
    expect(delivered(PAT).map((d) => d.action)).toEqual(["invite"]);
    // Nothing before the deadline: no InMail while the invite may still be accepted.
    await h.advanceTo(WEDNESDAY_0 - MIN);
    expect(delivered(PAT).map((d) => d.action)).toEqual(["invite"]);
    await h.advanceTo(WEDNESDAY_0 + H);
    const pat = delivered(PAT);
    expect(pat.map((d) => d.action)).toEqual(["invite", "inmail"]);
    expect(pat[1]!.at).toBe(WEDNESDAY_0);
    expect(pat[1]!.rendered.body).toBe("Hello Pat, a short note about Harbour Lane Physio.");
    const t = await track(c.lead("Pat Oneil"));
    expect(t?.finishedAt).toBeNull();
    expect(t?.inmail).toBe("sent");
    // The invite is left open: no withdrawal is asked (question Q50).
    expect(t?.inviteWithdrawal ?? null).toBeNull();
    expect(h.linkedin.withdrawalLog).toHaveLength(0);
    expect((await results(c.lead("Pat Oneil"))).find((r) => r.stepId === "m1")).toMatchObject({ result: "skipped", reason: "inmail_instead" });
    // The follow-ups after their waits, counted from the InMail: three days, then two more.
    await h.advanceTo(WEDNESDAY_0 + 6 * DAY);
    const after = delivered(PAT);
    expect(after.map((d) => [d.action, d.stepId])).toEqual([["invite", "inv"], ["inmail", "im"], ["message", "m2"], ["message", "m3"]]);
    expect(after[2]!.at).toBe(WEDNESDAY_0 + 3 * DAY);
    expect(after[3]!.at).toBe(WEDNESDAY_0 + 5 * DAY);
    expect((await track(c.lead("Pat Oneil")))?.finishReason).toBe("completed");
    const m = (await h.request<CampaignMeasures>("GET", `/api/campaigns/${c.id}/measures`)).body;
    expect(m.linkedin).toMatchObject({ invitesSent: 2, inmailsSent: 2, messagesSent: 4, failed: 0 });
  });

  test("accepted within the wait: no InMail; the first message follows the connection", async () => {
    const { h, campaign, delivered, results } = await world();
    h.linkedin.profiles.set(PAT, { acceptAfterMs: 20 * H });
    const c = await campaign([linkedin(FALLBACK)]);
    await h.advanceTo(WEDNESDAY_0 + 2 * DAY);
    expect(delivered(PAT).map((d) => d.stepId).slice(0, 2)).toEqual(["inv", "m1"]);
    expect(delivered(PAT).some((d) => d.action === "inmail")).toBe(false);
    expect((await results(c.lead("Pat Oneil"))).some((r) => r.stepId === "im")).toBe(false);
  });

  test("accepted after the wait ended but before the InMail went: no InMail, and the first message follows the connection (question Q56)", async () => {
    const { h, campaign, delivered, track, results } = await world();
    // Office hours: the InMail is due at midnight and would go at 09:00; the acceptance comes at 03:00.
    h.linkedin.profiles.set(PAT, { acceptAfterMs: WEDNESDAY_0 + 3 * H - MONDAY_9 });
    const c = await campaign([linkedin(FALLBACK, OFFICE)]);
    await h.advanceTo(WEDNESDAY_0 + 10 * H);
    expect(delivered(PAT).map((d) => d.stepId)).toEqual(["inv", "m1"]);
    expect((await results(c.lead("Pat Oneil"))).find((r) => r.stepId === "im")).toMatchObject({ result: "skipped", reason: "accepted" });
    expect((await track(c.lead("Pat Oneil")))?.connection).toBe("accepted");
  });
});

describe("a session that cannot send an InMail at the expiry (ADR 0004 13.3, 13.5; question Q51)", () => {
  test("a session that reports no Premium or Sales Navigator: the invite is withdrawn and the track ends, with why", async () => {
    const { h, campaign, delivered, track } = await world({ plan: "none", credits: 0 });
    const c = await campaign([linkedin(FALLBACK)]);
    await h.advanceTo(WEDNESDAY_0 + H);
    expect(delivered(PAT).map((d) => d.action)).toEqual(["invite"]);
    const t = await track(c.lead("Pat Oneil"));
    expect(t).toMatchObject({ finishReason: "invite_not_accepted", inmail: "no_plan", finishedWall: WEDNESDAY_0 });
    expect(h.linkedin.withdrawalLog.map((w) => w.answer)).toContain("withdrawn");
  });

  test("a session that reports nothing about InMail is not eligible", async () => {
    const { h, campaign, track } = await world(null);
    const c = await campaign([linkedin(FALLBACK)]);
    await h.advanceTo(WEDNESDAY_0 + H);
    expect((await track(c.lead("Pat Oneil")))?.inmail).toBe("no_plan");
    expect(h.linkedin.handoverLog.some((x) => x.action === "inmail")).toBe(false);
  });

  test("one credit, two leads expiring together: one InMail, and the other's invite is withdrawn for want of a credit", async () => {
    const { h, campaign, delivered, track } = await world({ plan: "sales_navigator", credits: 1 });
    const c = await campaign([linkedin(FALLBACK)]);
    await h.advanceTo(WEDNESDAY_0 + H);
    const inmails = [...delivered(PAT), ...delivered(NIA)].filter((d) => d.action === "inmail");
    expect(inmails).toHaveLength(1);
    const states = [await track(c.lead("Pat Oneil")), await track(c.lead("Nia Cole"))].map((t) => t?.inmail).sort();
    expect(states).toEqual(["no_credit", "sent"]);
  });
});

describe("the recipient refuses the InMail (ADR 0004 13.3; question Q55)", () => {
  test("a failure with its own cause; the profile stays good; the track takes the withdrawal path", async () => {
    const { h, campaign, track, results } = await world();
    h.linkedin.profiles.set(PAT, { refusesInmail: true });
    const c = await campaign([linkedin(FALLBACK)]);
    await h.advanceTo(WEDNESDAY_0 + H);
    expect((await results(c.lead("Pat Oneil"))).find((r) => r.stepId === "im")).toMatchObject({ result: "failed", reason: "inmail refused" });
    const t = await track(c.lead("Pat Oneil"));
    expect(t).toMatchObject({ inmail: "refused", finishReason: "invite_not_accepted" });
    const st = await h.store.engine.subject(c.lead("Pat Oneil"), h.clock);
    expect(st?.lead.details.find((d) => d.channel === "linkedin")?.bad).toBe(false);
    await h.advanceTo(WEDNESDAY_0 + 2 * H);
    expect(h.linkedin.withdrawalLog.map((w) => w.answer)).toContain("withdrawn");
    // A refused InMail spends no credit.
    expect(h.linkedin.sessions.get(S1)?.inmail?.credits).toBe(4);
  });
});

describe("a running edit of the switch (ADR 0004 13.8)", () => {
  test("switched off while the InMail is chosen and not yet handed over: it is not sent, and the track takes the withdrawal path", async () => {
    const { h, campaign, delivered, track } = await world();
    const c = await campaign([linkedin(FALLBACK, OFFICE)]);
    await h.advanceTo(WEDNESDAY_0 + 2 * H);
    expect((await track(c.lead("Pat Oneil")))?.inmail).toBe("chosen");
    const off = definition([linkedin(FALLBACK.map((s) => (s.id === "im" ? { ...s, removed: true } : s)), OFFICE)]);
    expect((await h.request("PUT", `/api/campaigns/${c.id}/sequence`, off)).status).toBe(200);
    await h.advanceTo(WEDNESDAY_0 + 12 * H);
    expect(delivered(PAT).map((d) => d.action)).toEqual(["invite"]);
    expect(await track(c.lead("Pat Oneil"))).toMatchObject({ inmail: "switched_off", finishReason: "invite_not_accepted" });
  });
});

describe("a first message skipped while waiting for acceptance (the generated runs, seed 24018)", () => {
  test("the InMail chosen at the expiry stays the pending step, goes, and the follow-ups follow it", async () => {
    const { h, campaign, delivered, track } = await world();
    const c = await campaign([linkedin(FALLBACK)]);
    await h.advanceTo(MONDAY_9 + H);
    // The user skips the step waiting for acceptance: the first message.
    expect((await h.request("POST", `/api/enrollments/${c.lead("Pat Oneil")}/controls`, { requestId: "skip-1", action: "skip" })).status).toBe(200);
    await h.advanceTo(WEDNESDAY_0 + H);
    expect((await track(c.lead("Pat Oneil")))?.inmail).toBe("sent");
    expect(delivered(PAT).map((d) => d.stepId)).toEqual(["inv", "im"]);
    await h.advanceTo(WEDNESDAY_0 + 6 * DAY);
    expect(delivered(PAT).map((d) => d.stepId)).toEqual(["inv", "im", "m2", "m3"]);
  });
});

describe("a chosen InMail that cannot go yet, and one the user skips (ADR 0004 13.3)", () => {
  test("its session's credits spent by hand after the expiry chose it: it waits, said with its reason and no time", async () => {
    const { h, campaign, delivered, track } = await world({ plan: "premium", credits: 1 });
    const c = await campaign([linkedin(FALLBACK, OFFICE)]);
    await h.advanceTo(WEDNESDAY_0 + 2 * H);
    // Nia's track took the one credit at the expiry; Pat's found none.
    const chosen = (await track(c.lead("Pat Oneil")))?.inmail === "chosen" ? "Pat Oneil" : "Nia Cole";
    expect((await track(c.lead(chosen)))?.inmail).toBe("chosen");
    h.linkedin.sessions.get(S1)!.inmail!.credits = 0;
    await h.advanceTo(WEDNESDAY_0 + 12 * H);
    expect(h.linkedin.handoverLog.some((x) => x.action === "inmail")).toBe(false);
    const read = (await h.request<{ tracks: { trackId: string; nextStep: { when: { kind: string; why?: string; inmail?: string } } | null }[] }>("GET", `/api/enrollments/${c.lead(chosen)}`)).body;
    expect(read.tracks.find((t) => t.trackId === "li")?.nextStep?.when).toMatchObject({ kind: "waits", why: "inmail_unavailable", inmail: "unbacked" });
    expect(delivered(PAT).filter((d) => d.action === "inmail")).toHaveLength(0);
  });

  test("skipped by the user: not sent, and the track takes the withdrawal path at the skip", async () => {
    const { h, campaign, delivered, track } = await world();
    const c = await campaign([linkedin(FALLBACK, OFFICE)]);
    await h.advanceTo(WEDNESDAY_0 + 2 * H);
    expect((await h.request("POST", `/api/enrollments/${c.lead("Pat Oneil")}/controls`, { requestId: "skip-im", action: "skip" })).status).toBe(200);
    await h.advanceTo(WEDNESDAY_0 + 12 * H);
    expect(delivered(PAT).map((d) => d.action)).toEqual(["invite"]);
    expect(await track(c.lead("Pat Oneil"))).toMatchObject({ inmail: "skipped_by_user", finishReason: "invite_not_accepted", finishedWall: WEDNESDAY_0 + 2 * H });
  });
});

describe("the review bot on b49a71b", () => {
  test("the replaced first message removed by a running edit after the InMail: the follow-ups still go", async () => {
    const { h, campaign, delivered } = await world();
    const c = await campaign([linkedin(FALLBACK)]);
    await h.advanceTo(WEDNESDAY_0 + H);
    expect(delivered(PAT).map((d) => d.stepId)).toEqual(["inv", "im"]);
    const edited = definition([linkedin(FALLBACK.map((s) => (s.id === "m1" ? { ...s, removed: true } : s)))]);
    expect((await h.request("PUT", `/api/campaigns/${c.id}/sequence`, edited)).status).toBe(200);
    await h.advanceTo(WEDNESDAY_0 + 7 * DAY);
    expect(delivered(PAT).map((d) => d.stepId)).toEqual(["inv", "im", "m2", "m3"]);
  });

  test("an InMail refused for a limit, then the invite accepted before its retry: the track connects and the first message goes", { timeout: 60_000 }, async () => {
    const { h, campaign, delivered, track, results } = await world();
    const c = await campaign([linkedin(FALLBACK)]);
    await h.advanceTo(WEDNESDAY_0 - H);
    // The InMail's first handover is refused for a limit; they accept 30 seconds later, before the retry.
    h.linkedin.profiles.set(PAT, { rateLimited: 1 });
    await h.advanceTo(WEDNESDAY_0 + MIN / 2);
    expect(h.linkedin.refusals.some((r) => r.destination === PAT && r.reason === "rate_limited")).toBe(true);
    h.linkedin.acceptNow(PAT);
    await h.advanceTo(WEDNESDAY_0 + 2 * DAY);
    expect((await track(c.lead("Pat Oneil")))?.connection).toBe("accepted");
    expect((await results(c.lead("Pat Oneil"))).find((r) => r.stepId === "im")).toMatchObject({ result: "skipped", reason: "accepted" });
    expect(delivered(PAT).map((d) => d.stepId)).toEqual(["inv", "m1"]);
  });

  test("two expiries evaluated concurrently with one credit: one commits it, the other finds none free, and the one InMail goes", async () => {
    const { h, campaign, track } = await world({ plan: "premium", credits: 1 });
    const c = await campaign([linkedin(FALLBACK, OFFICE)]);
    await h.advanceTo(WEDNESDAY_0 - H);
    const [pat, nia] = [c.lead("Pat Oneil"), c.lead("Nia Cole")];
    let raced = false;
    h.hooks = {
      beforeApplyEvaluation: async (id) => {
        if (raced || (id !== pat && id !== nia)) return;
        raced = true;
        // The other lead's own expiry is evaluated and committed in between (another process's pass).
        const other = id === pat ? nia : pat;
        await h.store.engine.update(other, h.clock, (s) => DEFAULT_RULES.evaluate(s, h.clock));
      },
    };
    await h.advanceTo(WEDNESDAY_0 + 12 * H);
    expect(raced).toBe(true);
    const states = [(await track(pat))?.inmail, (await track(nia))?.inmail].sort();
    expect(states).toEqual(["no_credit", "sent"]);
    expect(h.linkedin.deliveryLog.filter((d) => d.action === "inmail")).toHaveLength(1);
  });
});

describe("credits held by named work (council on 8b0c846, items 2, 7 and 8; ADR 0004 13.5)", () => {
  const SAM = "https://www.linkedin.com/in/fictional-sam-lee";
  const THREE = [...PEOPLE, person({ person_id: "p3", business_id: "b1", full_name: "Sam Lee", linkedin_url: SAM })];
  type Read = { tracks: { trackId: string; nextStep: { when: { kind: string; why?: string; inmail?: string } } | null }[] };
  const waitOf = async (h: EngineHarness, lead: string) => (await h.request<Read>("GET", `/api/enrollments/${lead}`)).body.tracks.find((t) => t.trackId === "li")?.nextStep?.when;
  const inmailsTo = (h: EngineHarness) => h.linkedin.deliveryLog.filter((d) => d.action === "inmail").map((d) => d.destination);
  /** A report the session gives now, stored as an account sync would store it. */
  const report = async (h: EngineHarness, standing: { plan: "premium" | "sales_navigator" | "none"; credits: number }) => {
    h.linkedin.sessions.get(S1)!.inmail = { ...standing };
    const listed = (await h.linkedin.accounts()).map((a) => ({ ...a, id: linkedinAccountId(a.id) }));
    await h.store.engine.upsertAccounts(listed, h.clock);
  };

  test("two chosen, the report falls to one credit: the earlier acquired goes, the other waits unbacked; a credit returning lets it go", async () => {
    const { h, campaign } = await world({ plan: "premium", credits: 2 });
    const c = await campaign([linkedin(FALLBACK, OFFICE)]);
    await h.advanceTo(WEDNESDAY_0 + 2 * H);
    await report(h, { plan: "premium", credits: 1 });
    await h.advanceTo(WEDNESDAY_0 + 12 * H);
    expect(inmailsTo(h)).toHaveLength(1);
    const waiting = inmailsTo(h)[0] === PAT ? c.lead("Nia Cole") : c.lead("Pat Oneil");
    expect(await waitOf(h, waiting)).toMatchObject({ why: "inmail_unavailable", inmail: "unbacked" });
    await report(h, { plan: "premium", credits: 1 });
    await h.advanceTo(WEDNESDAY_0 + DAY + 12 * H);
    expect(inmailsTo(h)).toHaveLength(2);
  });

  test("three chosen and one credit: exactly one goes", async () => {
    const { h, campaign } = await world({ plan: "premium", credits: 3 }, { people: THREE });
    await campaign([linkedin(FALLBACK, OFFICE)]);
    await h.advanceTo(WEDNESDAY_0 + 2 * H);
    await report(h, { plan: "premium", credits: 1 });
    await h.advanceTo(WEDNESDAY_0 + 2 * DAY);
    expect(inmailsTo(h)).toHaveLength(1);
  });

  test("the backed lead stopped before its InMail goes: the next one moves up and goes", async () => {
    const { h, campaign } = await world({ plan: "premium", credits: 2 });
    const c = await campaign([linkedin(FALLBACK, OFFICE)]);
    await h.advanceTo(WEDNESDAY_0 + 2 * H);
    await report(h, { plan: "premium", credits: 1 });
    // Both acquired at the same instant: ranked by subject and track, so one of them is backed. Stop that one.
    const backed = [];
    for (const name of ["Pat Oneil", "Nia Cole"]) if ((await waitOf(h, c.lead(name)))?.why !== "inmail_unavailable") backed.push(name);
    expect(backed).toHaveLength(1);
    expect((await h.request("POST", `/api/enrollments/${c.lead(backed[0]!)}/controls`, { requestId: "stop-backed", action: "stop" })).status).toBe(200);
    await h.advanceTo(WEDNESDAY_0 + 12 * H);
    expect(inmailsTo(h)).toEqual([backed[0] === "Pat Oneil" ? NIA : PAT]);
  });

  test("a stopped lead restarted after another took the last credit waits for one; it never takes it back (item 7)", async () => {
    // One invite a day: Pat's wait ends Wednesday, Nia's Thursday.
    const { h, campaign } = await world({ plan: "premium", credits: 1 }, { invitesPerDay: 1 });
    const c = await campaign([linkedin(FALLBACK, OFFICE)]);
    await h.advanceTo(WEDNESDAY_0 + 2 * H);
    const first = h.linkedin.deliveryLog.find((d) => d.action === "invite")!.destination === PAT ? "Pat Oneil" : "Nia Cole";
    const second = first === "Pat Oneil" ? "Nia Cole" : "Pat Oneil";
    expect((await h.request("POST", `/api/enrollments/${c.lead(first)}/controls`, { requestId: "stop-a", action: "stop" })).status).toBe(200);
    await h.advanceTo(WEDNESDAY_0 + DAY + 2 * H);
    expect((await h.request("POST", `/api/enrollments/${c.lead(first)}/controls`, { requestId: "restart-a", action: "resume_from_next_step" })).status).toBe(200);
    await h.advanceTo(WEDNESDAY_0 + 3 * DAY);
    expect(inmailsTo(h)).toEqual([second === "Pat Oneil" ? PAT : NIA]);
    expect(await waitOf(h, c.lead(first))).toMatchObject({ why: "inmail_unavailable" });
  });

  for (const [what, standing] of [["a report of zero credits", { plan: "premium", credits: 0 }], ["a plan lost", { plan: "none", credits: 0 }]] as const) {
    test(`${what} stored after the InMail's claim and before its handover: it is not handed over (item 8)`, async () => {
      const { h, campaign } = await world({ plan: "premium", credits: 1 });
      await campaign([linkedin([FALLBACK[0]!, FALLBACK[1]!, FALLBACK[2]!], OFFICE)]);
      await h.advanceTo(WEDNESDAY_0 + 2 * H);
      let reported = false;
      h.hooks = {
        afterClaim: async (attemptId) => {
          const a = await h.store.engine.attempt(attemptId);
          if (reported || a?.action !== "inmail") return;
          reported = true;
          await report(h, standing);
        },
      };
      await h.advanceTo(WEDNESDAY_0 + 12 * H);
      expect(reported).toBe(true);
      expect(h.linkedin.handoverLog.filter((x) => x.action === "inmail")).toHaveLength(0);
      expect(h.linkedin.refusals.filter((r) => r.reason === "payment_required")).toHaveLength(0);
    });
  }

  test("a session not read for over a day at the expiry: not judged on its old report; the withdrawal path, said as of that report (item 5)", async () => {
    const { h, campaign, track } = await world();
    const c = await campaign([linkedin(FALLBACK)]);
    await h.advanceTo(MONDAY_9 + H);
    h.linkedin.sessions.get(S1)!.healthy = false;
    await h.advanceTo(WEDNESDAY_0 + H);
    expect(await track(c.lead("Pat Oneil"))).toMatchObject({ inmail: "stale_report", finishReason: "invite_not_accepted" });
    expect((await track(c.lead("Pat Oneil")))?.inmailReportedWall).toBeLessThan(MONDAY_9 + 2 * H);
  });
});

describe("the step the InMail replaces is named when it is chosen (council on 8b0c846, item 1)", () => {
  test("the first message removed after the choice and before the InMail goes: the follow-up the user kept still goes", async () => {
    const { h, campaign, delivered, results } = await world();
    const c = await campaign([linkedin(FALLBACK, OFFICE)]);
    await h.advanceTo(WEDNESDAY_0 + 2 * H);
    const edited = definition([linkedin(FALLBACK.map((s) => (s.id === "m1" ? { ...s, removed: true } : s)), OFFICE)]);
    expect((await h.request("PUT", `/api/campaigns/${c.id}/sequence`, edited)).status).toBe(200);
    await h.advanceTo(WEDNESDAY_0 + 8 * DAY);
    expect(delivered(PAT).map((d) => d.stepId)).toEqual(["inv", "im", "m2", "m3"]);
    expect((await results(c.lead("Pat Oneil"))).some((r) => r.reason === "inmail_instead")).toBe(false);
  });
});
