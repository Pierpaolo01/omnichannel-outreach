import { describe, expect, test } from "vitest";
import { linkedinAccountId } from "./engine/ports.ts";
import { EngineHarness } from "../../test/support/engine-harness.ts";
import { business, person } from "../../test/support/export-builder.ts";
import { NOTHING_SENT_ON_LINKEDIN } from "../domain/sequence/controls.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../domain/sequence/definition.ts";
import type { ActivityView, BeforeLaunchView, EnrollmentRead, LeadSearchResult, TestRunTab } from "../shared/api.ts";

/**
 * The reads ticket 24's screens need that part a did not serve (ticket 24, part b): LinkedIn coverage on Before launch, whether
 * the user may mark a LinkedIn reply on a lead or a test run (and the refusal's own reason), the test profile on the Test run
 * tab, and the day an acceptance wait ends on a test run's step. Each is the engine's own function read through HTTP, on the
 * simulated LinkedIn provider. Every profile is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const S1 = "li-session-1";
const PAT = "https://www.linkedin.com/in/fictional-pat-oneil";
const TEST = "https://www.linkedin.com/in/fictional-user-test-profile";

const step = (id: string, waitDays: number, body: string): StepDefinition => ({ id, waitDays, subject: "", body, threading: "new_subject", removed: false });
const linkedin = (steps: StepDefinition[], acceptWaitDays = 3): TrackDefinition => ({ id: "li", channel: "linkedin", branch: "main", window: ALWAYS, steps, start: { kind: "entry" }, removed: false, acceptWaitDays });
const emailTrack: TrackDefinition = {
  id: "em",
  channel: "email",
  branch: "main",
  window: ALWAYS,
  steps: [{ id: "em-1", waitDays: 0, subject: "Hello", body: "Email for {{company}}.", threading: "new_subject", removed: false }],
  start: { kind: "entry" },
  removed: false,
};
const definition = (tracks: TrackDefinition[]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: [], linkedinPool: [linkedinAccountId(S1)], tracks });
const LI = linkedin([step("inv", 0, "Hello {{first_name|there}}."), step("m1", 0, "Thanks for connecting.")]);

const PEOPLE = [
  person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", linkedin_url: PAT }),
  person({ person_id: "p2", business_id: "b1", full_name: "Kim Hart", email: "kim@harbour.example", linkedin_url: "https://www.linkedin.com/company/fictional-harbour" }),
  person({ person_id: "p3", business_id: "b1", full_name: "Ola Berg", email: "ola@harbour.example" }),
];
const BUSINESSES = [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })];

async function world() {
  const h = new EngineHarness({
    start: MONDAY_9 - H,
    accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    linkedin: { sessions: [{ id: S1, gapMs: MIN, k: 1, healthy: true, resetZone: "Europe/London" }] },
  });
  await h.tick();
  expect((await h.request("PUT", `/api/sender-accounts/${linkedinAccountId(S1)}/allowances`, { invitesPerDay: 20, messagesPerDay: 20, notesPerMonth: 20 })).status).toBe(200);
  const { campaign } = await h.createCampaign("LinkedIn", { businesses: BUSINESSES, people: PEOPLE });
  const lead = async (name: string) => (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows.find((r) => r.name === name)?.enrollments[0]?.id ?? "";
  return { h, id: campaign.id, lead };
}

describe("Before launch's LinkedIn coverage (ticket 24b)", () => {
  test("counts the leads with a usable member profile, by the import's one rule; a company page or none is not one", async () => {
    const { h, id } = await world();
    await h.defineSequence(id, definition([LI]));
    const view = (await h.request<BeforeLaunchView>("GET", `/api/campaigns/${id}/before-launch?load=0`)).body;
    expect(view.coverage.linkedin).toBe(1);
    expect(view.leads.find((l) => l.name === "Pat Oneil")?.linkedin).toBe(true);
    expect(view.leads.find((l) => l.name === "Kim Hart")?.linkedin).toBe(false);
  });
});

describe("marking a LinkedIn reply, as the read allows it (ADR 0004 section 7)", () => {
  test("a lead's read says the mark is refused, with the engine's own reason, until something reached them; allowed after the invite went", async () => {
    const { h, id, lead } = await world();
    // The LinkedIn track starts a day after the email: until then nothing has reached Pat on LinkedIn.
    await h.defineSequence(id, definition([{ ...LI, start: { kind: "after", trackId: "em", delayDays: 1 } }, emailTrack]));
    h.clock = MONDAY_9;
    expect((await h.launch(id)).status).toBe(200);
    const pat = await lead("Pat Oneil");
    await h.advanceTo(MONDAY_9 + H);
    const before = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${pat}`)).body;
    expect(before.linkedinReply).toEqual({ allowed: false, reason: NOTHING_SENT_ON_LINKEDIN });
    await h.advanceTo(MONDAY_9 + 2 * 24 * H);
    const after = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${pat}`)).body;
    expect(after.linkedinReply).toEqual({ allowed: true });
    // Marked: the read refuses a second mark with the engine's reason.
    expect((await h.request("POST", `/api/enrollments/${pat}/replies`, { requestId: "r-1", channel: "linkedin", expect: { status: after.status } })).status).toBe(200);
    const marked = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${pat}`)).body;
    expect(marked.status).toBe("replied");
    expect(marked.linkedinReply).toEqual({ allowed: false, reason: "They are already marked replied in this campaign." });
  });

  test("a campaign with no LinkedIn track offers no mark at all", async () => {
    const { h, id, lead } = await world();
    await h.defineSequence(id, definition([emailTrack]));
    h.clock = MONDAY_9;
    expect((await h.launch(id)).status).toBe(200);
    expect((await h.request<EnrollmentRead>("GET", `/api/enrollments/${await lead("Pat Oneil")}`)).body.linkedinReply).toBeNull();
  });
});

describe("the Test run tab's LinkedIn read (ADR 0004 section 8)", () => {
  test("the test profile is read back; the first message waits for acceptance with the day the wait ends; the run's reply mark follows the rule", async () => {
    const { h, id, lead } = await world();
    await h.defineSequence(id, definition([LI]));
    expect((await h.request("PUT", `/api/campaigns/${id}/test-contacts`, { email: "", mobile: "", linkedin: TEST })).status).toBe(200);
    const tab = (await h.request<TestRunTab>("GET", `/api/campaigns/${id}/test-runs`)).body;
    expect(tab.contacts.linkedin).toBe(TEST);
    expect(tab.contacts.linkedinIsALead).toBe(false);
    h.clock = MONDAY_9;
    const started = await h.request<TestRunTab>("POST", `/api/campaigns/${id}/test-runs`, { requestId: "run-1", renderAs: await lead("Pat Oneil"), expect: { definitionVersion: tab.definitionVersion } });
    expect(started.status).toBe(200);
    expect(started.body.run?.linkedin).toBe(TEST);
    await h.advanceTo(MONDAY_9 + 10 * MIN);
    const run = (await h.request<TestRunTab>("GET", `/api/campaigns/${id}/test-runs`)).body.run;
    const m1 = run?.steps.find((s) => s.stepId === "m1");
    expect(m1).toMatchObject({ state: "due", waits: "awaiting_acceptance" });
    // Q40: the wait is not cut short; it ends three calendar days after the invite went, in the campaign's zone.
    expect(m1?.until).toBe("2026-11-05T00:00:00.000Z");
    expect(run?.linkedinReply).toEqual({ allowed: true });
    // The mark, confirmed on the status the read showed, ends only the test (council on 194fc44, item 13).
    const marked = await h.request<TestRunTab>("POST", `/api/test-runs/${run?.id ?? ""}/replies`, { requestId: "mark-1", channel: "linkedin", expect: { status: run?.status } });
    expect(marked.status).toBe(200);
    expect(marked.body.run).toMatchObject({ running: false, ending: "your_reply", linkedinReply: { allowed: false } });
  });
});

describe("Activity's LinkedIn entries (ticket 24b; part a left LinkedIn tracks out of Activity)", () => {
  test("the invite and the first message as sent, on LinkedIn; a person with no profile skips the track as no profile, never as no mobile", async () => {
    const { h, id } = await world();
    h.linkedin.profiles.set(PAT, { acceptAfterMs: 2 * H });
    await h.defineSequence(id, definition([LI]));
    h.clock = MONDAY_9;
    expect((await h.launch(id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 5 * H);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${id}`)).body.rows;
    const activity = async (name: string) => (await h.request<ActivityView>("GET", `/api/people/${rows.find((r) => r.name === name)?.id ?? ""}/activity`)).body.entries;
    const pat = await activity("Pat Oneil");
    expect(pat.filter((e) => e.kind === "sent").map((e) => [e.kind, "channel" in e ? e.channel : null, "stepNumber" in e ? e.stepNumber : null])).toEqual([
      ["sent", "linkedin", 2],
      ["sent", "linkedin", 1],
    ]);
    const ola = await activity("Ola Berg");
    expect(ola.find((e) => e.kind === "skipped")).toMatchObject({ channel: "linkedin", reason: "no_profile" });
  });
});
