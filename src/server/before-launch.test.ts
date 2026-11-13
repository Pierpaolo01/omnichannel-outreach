import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../test/support/engine-harness.ts";
import { business, person } from "../../test/support/export-builder.ts";
import type { FakeAccount } from "../../test/support/fake-email-port.ts";
import type { CampaignDefinition, StepDefinition } from "../domain/sequence/definition.ts";
import type { ApiError, BeforeLaunchView, CampaignDetail, CampaignListItem, CopyPreview } from "../shared/api.ts";

/**
 * The Before launch tab's read models (ticket 12c), through the real HTTP app and store with the
 * engine over a fake email provider. Fictitious data only.
 */
const H = 3_600_000;
const DAY = 24 * H;
/** Monday 2 November 2026, 08:00 in London. */
const MONDAY_8 = Date.parse("2026-11-02T08:00:00Z");

const inbox = (id: string, fields: Partial<FakeAccount> = {}): FakeAccount => ({ id, capacity: 30, gapMs: null, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC", ...fields });

const step = (id: string, fields: Partial<StepDefinition> = {}): StepDefinition => ({ id, waitDays: 0, subject: "", body: "Hello.", threading: "continue_thread", removed: false, ...fields });

const weekdays = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));

const emailTrack = (steps: StepDefinition[], pool = ["inbox-a"]): CampaignDefinition => ({
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: pool,
  tracks: [{ id: "t1", channel: "email", branch: "main", window: weekdays, steps, start: { kind: "entry" }, removed: false }],
});

const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101", phone_original: "020 7946 0101" });
const NORTHGATE = business({ business_id: "b2", business_name: "Northgate Dental", general_emails: "hello@northgate.example" });
const PEOPLE = [
  person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", title: "Clinic director", email: "pat@harbour.example", dial_phone: "+447700900211", dial_phone_type: "mobile" }),
  person({ person_id: "p2", business_id: "b1", full_name: "Sam Lee", title: "Practice manager", direct_phone: "+44 20 7946 0303" }),
];

async function campaign(accounts: FakeAccount[] = [inbox("inbox-a")], people = PEOPLE, businesses = [HARBOUR, NORTHGATE]) {
  const h = new EngineHarness({ start: MONDAY_8, accounts });
  const { campaign } = await h.createCampaign("Autumn physio", { businesses, people });
  // The engine learns the provider's inboxes on its first tick.
  await h.tick();
  return { h, id: campaign.id };
}

const beforeLaunch = async (h: EngineHarness, id: string) => {
  const res = await h.request<BeforeLaunchView>("GET", `/api/campaigns/${id}/before-launch`);
  expect(res.status).toBe(200);
  return res.body;
};

describe("Before launch: the leads, channel coverage and missing merge fields", () => {
  test("lists every lead with the address the email track would use, and counts email, mobile and phone coverage", async () => {
    const { h, id } = await campaign();
    const view = await beforeLaunch(h, id);
    expect(view.leads.map((l) => [l.name, l.kind, l.title, l.company, l.email])).toEqual([
      ["Northgate Dental", "company", "", "Northgate Dental", "hello@northgate.example"],
      ["Pat Oneil", "person", "Clinic director", "Harbour Lane Physio", "pat@harbour.example"],
      ["Sam Lee", "person", "Practice manager", "Harbour Lane Physio", null],
    ]);
    // Pat: email, mobile, phone. Sam: direct line, and the company main line. Northgate: shared inbox only.
    expect(view.coverage).toEqual({ leads: 3, email: 2, mobile: 1, phone: 2 });
  });

  test("counts, for each merge field the copy uses, the leads that lack it and the fallbacks written", async () => {
    const { h, id } = await campaign();
    await h.defineSequence(
      id,
      emailTrack([
        step("s1", { subject: "Evening bookings at {{company}}", body: "Hi {{first_name|there}},", threading: "new_subject" }),
        step("s2", { waitDays: 3, body: "Hi {{first_name}}, a follow-up on {{title|your role}}." }),
      ]),
    );
    const view = await beforeLaunch(h, id);
    // Each lead says which fields the copy uses that it lacks, and which channels it has.
    expect(view.leads.map((l) => [l.name, l.lacks, l.mobile, l.phone])).toEqual([
      ["Northgate Dental", ["first_name", "title"], false, false],
      ["Pat Oneil", [], true, true],
      ["Sam Lee", [], false, true],
    ]);
    expect(view.mergeFields).toEqual([
      { field: "company", leadsMissing: 0, companyLeadsMissing: 0, fallbacks: [], someUseWithoutFallback: true },
      { field: "first_name", leadsMissing: 1, companyLeadsMissing: 1, fallbacks: ["there"], someUseWithoutFallback: true },
      { field: "title", leadsMissing: 1, companyLeadsMissing: 1, fallbacks: ["your role"], someUseWithoutFallback: false },
    ]);
  });

  test("an unknown campaign is a 404", async () => {
    const { h } = await campaign();
    expect((await h.request<ApiError>("GET", "/api/campaigns/nope/before-launch")).status).toBe(404);
    expect((await h.request<ApiError>("GET", "/api/campaigns/nope/preview/nope")).status).toBe(404);
  });
});

describe("Before launch: copy rendered for one lead", () => {
  const steps = [
    step("s1", { subject: "Evening bookings at {{company}}", body: "Hi {{first_name|there}},\nA note for {{company}}.", threading: "new_subject" }),
    step("s2", { waitDays: 3, body: "Following up, {{first_name}}." }),
    step("gone", { waitDays: 1, body: "Removed.", removed: true }),
    step("s3", { waitDays: 4, subject: "One more idea for {{company}}", body: "Last note.", threading: "new_subject" }),
  ];

  test("renders each live step with the lead's values, marks fallbacks, and dates it by its waits", async () => {
    const { h, id } = await campaign();
    await h.defineSequence(id, emailTrack(steps));
    const pat = (await beforeLaunch(h, id)).leads.find((l) => l.name === "Pat Oneil")!;
    const res = await h.request<CopyPreview>("GET", `/api/campaigns/${id}/preview/${pat.id}`);
    expect(res.status).toBe(200);
    expect(res.body.lead.name).toBe("Pat Oneil");
    expect(res.body.steps.map((s) => [s.stepId, s.number, s.day, s.threading, s.missing])).toEqual([
      ["s1", 1, 1, "new_subject", []],
      ["s2", 2, 4, "continue_thread", []],
      ["s3", 3, 8, "new_subject", []],
    ]);
    const [first, second] = res.body.steps;
    expect(first!.subject).toEqual([
      { text: "Evening bookings at ", kind: "literal" },
      { text: "Harbour Lane Physio", kind: "value", field: "company" },
    ]);
    expect(first!.body.map((s) => s.text).join("")).toBe("Hi Pat,\nA note for Harbour Lane Physio.");
    // A continue-thread step shows the subject of the thread it continues.
    expect(second!.subject.map((s) => s.text).join("")).toBe("Re: Evening bookings at Harbour Lane Physio");
  });

  test("for a lead without the field, shows the fallback as one, and names a field with no fallback as missing", async () => {
    const { h, id } = await campaign();
    await h.defineSequence(id, emailTrack(steps));
    const northgate = (await beforeLaunch(h, id)).leads.find((l) => l.kind === "company")!;
    const { body } = await h.request<CopyPreview>("GET", `/api/campaigns/${id}/preview/${northgate.id}`);
    expect(body.steps[0]!.body[1]).toEqual({ text: "there", kind: "fallback", field: "first_name" });
    expect(body.steps[1]!.missing).toEqual(["first_name"]);
    expect(body.steps[1]!.body).toContainEqual({ text: "", kind: "missing", field: "first_name" });
  });

  test("a lead from another campaign is a 404", async () => {
    const { h, id } = await campaign();
    const { campaign: other } = await h.createCampaign("Winter", { businesses: [business({ business_id: "b9", business_name: "Elm Dental", general_emails: "hi@elm.example" })] });
    const elm = (await beforeLaunch(h, other.id)).leads[0]!;
    expect((await h.request<ApiError>("GET", `/api/campaigns/${id}/preview/${elm.id}`)).status).toBe(404);
  });
});

describe("Before launch: projected daily load per sender inbox", () => {
  const many = (n: number) => ({
    businesses: [HARBOUR],
    people: Array.from({ length: n }, (_, i) => person({ person_id: `q${i}`, business_id: "b1", full_name: `Lead Number${String(i).padStart(3, "0")}`, email: `lead${i}@harbour.example` })),
  });

  test("with no connected inbox there is no projection to show", async () => {
    const { h, id } = await campaign([]);
    await h.defineSequence(id, emailTrack([step("s1", { subject: "Hi", threading: "new_subject" })], []));
    const { load } = await beforeLaunch(h, id);
    expect(load).toMatchObject({ leadsWithEmail: 2, accounts: [], daysUntilAllStart: null });
  });

  test("first emails fill each inbox's daily capacity, so 25 leads at 10 a day start over three sending days", async () => {
    const { h, id } = await campaign([inbox("inbox-a", { capacity: 10 })], many(25).people, many(25).businesses);
    await h.defineSequence(id, emailTrack([step("s1", { subject: "Hi", threading: "new_subject" })]));
    const { load } = await beforeLaunch(h, id);
    expect(load).toMatchObject({ leadsWithEmail: 25, daysUntilAllStart: 3, notStartedWithinHorizon: 0 });
    expect(load!.accounts).toEqual([expect.objectContaining({ id: "inbox-a", capacity: 10, usedToday: 0, busiestDay: 10 })]);
  });

  test("follow-ups go first, so when they come due they push new first emails to a later day", async () => {
    // 10 a day; a follow-up the next day. Day 1: 10 first emails. Day 2: 10 follow-ups, nothing new.
    const { h, id } = await campaign([inbox("inbox-a", { capacity: 10 })], many(20).people, many(20).businesses);
    await h.defineSequence(id, emailTrack([step("s1", { subject: "Hi", threading: "new_subject" }), step("s2", { waitDays: 1 })]));
    const { load } = await beforeLaunch(h, id);
    expect(load).toMatchObject({ daysUntilAllStart: 3 });
  });

  test("two inboxes share the leads, and a weekend outside the window does not count as a sending day", async () => {
    // Friday 08:00 in London: Friday is day 1, Saturday and Sunday send nothing, Monday is day 4.
    const friday = MONDAY_8 + 4 * DAY;
    const h = new EngineHarness({ start: friday, accounts: [inbox("inbox-a", { capacity: 5 }), inbox("inbox-b", { capacity: 5 })] });
    const { campaign: c } = await h.createCampaign("Weekend", many(15));
    await h.tick();
    await h.defineSequence(c.id, emailTrack([step("s1", { subject: "Hi", threading: "new_subject" })], ["inbox-a", "inbox-b"]));
    const { load } = await beforeLaunch(h, c.id);
    expect(load!.accounts.map((a) => [a.id, a.busiestDay])).toEqual([
      ["inbox-a", 5],
      ["inbox-b", 5],
    ]);
    expect(load!.daysUntilAllStart).toBe(4);
  });

  test("an inbox's sends already counted today leave less room on launch day", async () => {
    const { h, id } = await campaign([inbox("inbox-a", { capacity: 10 })], many(12).people, many(12).businesses);
    // Another campaign has already sent 8 today from the same inbox.
    const { campaign: other } = await h.createCampaign("Other", many(8));
    await h.defineSequence(other.id, emailTrack([step("s1", { subject: "Hi", threading: "new_subject" })]));
    h.clock = MONDAY_8 + H;
    await h.launch(other.id);
    await h.advanceTo(MONDAY_8 + 6 * H);
    await h.defineSequence(id, emailTrack([step("s1", { subject: "Hi", threading: "new_subject" })]));
    const { load } = await beforeLaunch(h, id);
    expect(load!.accounts[0]).toMatchObject({ usedToday: 8 });
    // Today: 2 of 12. Tuesday: 10. All start on day 2.
    expect(load!.daysUntilAllStart).toBe(2);
  });

  test("once launched, there is no before-launch projection", async () => {
    const { h, id } = await campaign();
    await h.defineSequence(id, emailTrack([step("s1", { subject: "Hi", threading: "new_subject" })]));
    expect((await h.launch(id)).status).toBe(200);
    expect((await beforeLaunch(h, id)).load).toBeNull();
  });
});

describe("the campaign list and page say whether a campaign has launched and what its sequence holds", () => {
  test("not launched with no sequence, then an email track, then launched", async () => {
    const { h, id } = await campaign();
    const row = async () => (await h.request<{ campaigns: CampaignListItem[] }>("GET", "/api/campaigns")).body.campaigns.find((c) => c.id === id)!;
    expect((await row()).sequence).toEqual({ launchedAt: null, tracks: [] });
    await h.defineSequence(id, emailTrack([step("s1", { subject: "Hi", threading: "new_subject" })]));
    expect((await row()).sequence).toEqual({ launchedAt: null, tracks: ["email"] });
    await h.launch(id);
    expect((await row()).sequence.launchedAt).toBe(new Date(MONDAY_8).toISOString());
    const detail = await h.request<CampaignDetail>("GET", `/api/campaigns/${id}`);
    expect(detail.body).toMatchObject({ campaign: { id }, leadCount: 3, sequence: { tracks: ["email"] } });
  });
});
