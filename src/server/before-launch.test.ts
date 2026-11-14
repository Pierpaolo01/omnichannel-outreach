import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../test/support/engine-harness.ts";
import { business, person } from "../../test/support/export-builder.ts";
import type { FakeAccount } from "../../test/support/fake-email-port.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../domain/sequence/definition.ts";
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

describe("Before launch: copy for one lead across both channels, by track, dated from launch (ticket 13b)", () => {
  const text = (id: string, fields: Partial<StepDefinition> = {}): StepDefinition => step(id, { threading: "new_subject", ...fields });
  const tracks: CampaignDefinition = {
    timezone: "Europe/London",
    callSkipLimitDays: 2,
    emailPool: ["inbox-a"],
    smsPool: [],
    tracks: [
      { id: "t1", channel: "email", branch: "main", window: weekdays, start: { kind: "entry" }, removed: false, steps: [step("s1", { subject: "Hi {{company}}", threading: "new_subject" }), step("s2", { waitDays: 3 })] },
      { id: "t2", channel: "sms", branch: "main", window: weekdays, start: { kind: "after", trackId: "t1", delayDays: 1 }, removed: false, steps: [text("m1", { body: "Hi {{first_name|there}}, a text." }), text("m2", { waitDays: 2 })] },
      { id: "t3", channel: "sms", branch: "main", window: weekdays, start: { kind: "entry" }, removed: false, steps: [text("m3", { body: "Together with the first email." })] },
    ],
  };
  const ANA = person({ person_id: "p4", business_id: "b1", full_name: "Ana Ruiz", title: "Owner", dial_phone: "+447700900244", dial_phone_type: "mobile" });
  const preview = async (name: string) => {
    const { h, id } = await campaign([inbox("inbox-a")], [...PEOPLE, ANA]);
    await h.defineSequence(id, tracks);
    const lead = (await beforeLaunch(h, id)).leads.find((l) => l.name === name)!;
    return (await h.request<CopyPreview>("GET", `/api/campaigns/${id}/preview/${lead.id}`)).body;
  };
  const rows = (p: CopyPreview) => p.steps.map((s) => [s.trackId, s.stepId, s.channel, s.number, s.day, s.skipped]);

  test("every track's messages, in the order they can go: an SMS track after the emails starts the day after they finish", async () => {
    const pat = await preview("Pat Oneil");
    expect(rows(pat)).toEqual([
      ["t1", "s1", "email", 1, 1, false],
      ["t3", "m3", "sms", 1, 1, false],
      ["t1", "s2", "email", 2, 4, false],
      ["t2", "m1", "sms", 1, 5, false],
      ["t2", "m2", "sms", 2, 7, false],
    ]);
    const m1 = pat.steps.find((s) => s.stepId === "m1")!;
    // A text has no subject.
    expect(m1.subject).toEqual([]);
    expect(m1.body.map((x) => x.text).join("")).toBe("Hi Pat, a text.");
  });

  test("a lead with no email skips the email track, so the SMS track after it starts a day after launch, not after the emails", async () => {
    expect(rows(await preview("Ana Ruiz"))).toEqual([
      ["t1", "s1", "email", 1, 1, true],
      ["t1", "s2", "email", 2, 1, true],
      ["t3", "m3", "sms", 1, 1, false],
      ["t2", "m1", "sms", 1, 2, false],
      ["t2", "m2", "sms", 2, 4, false],
    ]);
  });

  test("a company lead is never texted: its SMS tracks are skipped (ADR 0003 Q10)", async () => {
    const northgate = await preview("Northgate Dental");
    expect(northgate.steps.filter((s) => s.channel === "sms").every((s) => s.skipped)).toBe(true);
    expect(northgate.steps.filter((s) => s.channel === "email").every((s) => !s.skipped)).toBe(true);
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
    expect(load).toMatchObject({ leadsToStart: null, accounts: [], daysUntilAllStart: null, withheldBy: { tracks: [{ trackId: "t1", channel: "email", label: "the email track", why: "no_sender" }] } });
  });

  test("first emails fill each inbox's daily capacity, so 25 leads at 10 a day start over three sending days", async () => {
    const { h, id } = await campaign([inbox("inbox-a", { capacity: 10 })], many(25).people, many(25).businesses);
    await h.defineSequence(id, emailTrack([step("s1", { subject: "Hi", threading: "new_subject" })]));
    const { load } = await beforeLaunch(h, id);
    expect(load).toMatchObject({ leadsToStart: 25, daysUntilAllStart: 3, notStartedWithinHorizon: 0 });
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
    // Another campaign has used 8 of today's sends on the same inbox: 7 sent, and one claimed that
    // goes at 14:36 before this campaign's (it is older, PR 41 re-check B10).
    const { campaign: other } = await h.createCampaign("Other", many(8));
    await h.defineSequence(other.id, emailTrack([step("s1", { subject: "Hi", threading: "new_subject" })]));
    h.clock = MONDAY_8 + H;
    await h.launch(other.id);
    await h.advanceTo(MONDAY_8 + 6 * H);
    await h.defineSequence(id, emailTrack([step("s1", { subject: "Hi", threading: "new_subject" })]));
    const { load } = await beforeLaunch(h, id);
    expect(load!.accounts[0]).toMatchObject({ usedToday: 8 });
    // Today: the other campaign's claimed lead, then 2 of 12. Tuesday: 10. All start on day 2.
    expect(load!.daysUntilAllStart).toBe(2);
  });

  describe("with an SMS track, texts are projected with the emails (ticket 13b)", () => {
    const N1 = "+447700900001";
    const text = (id: string): StepDefinition => step(id, { body: "A short text.", threading: "new_subject" });
    const withSms = (start: TrackDefinition["start"], smsPool = [N1]): CampaignDefinition => {
      const email = emailTrack([step("s1", { subject: "Hi", threading: "new_subject" })]);
      return { ...email, smsPool, tracks: [...email.tracks, { id: "t2", channel: "sms", branch: "main", window: weekdays, steps: [text("m1")], start, removed: false }] };
    };
    /** `n` leads, each with an email and a fictitious UK mobile of their own. */
    const withMobiles = (n: number) => ({
      businesses: [HARBOUR],
      people: Array.from({ length: n }, (_, i) =>
        person({ person_id: `q${i}`, business_id: "b1", full_name: `Lead Number${String(i).padStart(3, "0")}`, email: `lead${i}@harbour.example`, dial_phone: `+4477009003${String(i).padStart(2, "0")}`, dial_phone_type: "mobile" }),
      ),
    });
    const smsWorld = async (n: number, smsCapacity = 50) => {
      const h = new EngineHarness({ start: MONDAY_8, accounts: [inbox("inbox-a", { capacity: 10 })], sms: { numbers: [{ id: N1, capacity: smsCapacity, gapMs: null, k: 1, healthy: true, resetZone: "Europe/London" }] } });
      const { campaign: c } = await h.createCampaign("Autumn physio", withMobiles(n));
      await h.tick();
      return { h, id: c.id };
    };

    test("an SMS track that starts with the emails: every lead gets a text on launch day, so all 25 start on day 1, and both senders are listed", async () => {
      const { h, id } = await smsWorld(25);
      await h.defineSequence(id, withSms({ kind: "entry" }));
      const { load } = await beforeLaunch(h, id);
      expect(load).toMatchObject({ leadsToStart: 25, daysUntilAllStart: 1, withheldBy: null, cannotProject: [] });
      expect(load!.accounts).toEqual([expect.objectContaining({ id: "inbox-a", channel: "email", busiestDay: 10 }), expect.objectContaining({ id: N1, channel: "sms", busiestDay: 25, label: "Simulated SMS (not a provider) +44 7700 900001" })]);
    });

    test("an SMS track after the email track starts each lead's texts a day after its emails finish, so texts follow the email days", async () => {
      const { h, id } = await smsWorld(25, 10);
      await h.defineSequence(id, withSms({ kind: "after", trackId: "t1", delayDays: 1 }));
      const { load } = await beforeLaunch(h, id);
      expect(load).toMatchObject({ leadsToStart: 25, daysUntilAllStart: 3 });
      expect(load!.accounts.find((a) => a.id === N1)).toMatchObject({ busiestDay: 10 });
    });

    test("with no SMS number connected nothing is projected, and the SMS track is named", async () => {
      const { h, id } = await smsWorld(5);
      await h.defineSequence(id, withSms({ kind: "entry" }, []));
      const { load } = await beforeLaunch(h, id);
      expect(load).toMatchObject({ leadsToStart: null, daysUntilAllStart: null, withheldBy: { tracks: [{ trackId: "t2", channel: "sms", why: "no_sender" }] } });
    });

    test("a disconnected SMS number has no known end, so nothing is projected and the screen says which", async () => {
      const { h, id } = await smsWorld(5);
      await h.defineSequence(id, withSms({ kind: "entry" }, [N1, "+447700900002"]));
      h.sms.numbers.set("+447700900002", { id: "+447700900002", capacity: 5, gapMs: null, k: 1, healthy: false, resetZone: "Europe/London" });
      await h.tick();
      const { load } = await beforeLaunch(h, id);
      expect(load).toMatchObject({ daysUntilAllStart: null, cannotProject: [{ accountId: "+447700900002", channel: "sms", reason: "cannot_send" }] });
    });
  });

  test("a phone track beside or after the email track: the emails are projected, as the engine sends them with no call logged, and every call goes on the list within the daily call capacity (ticket 13b, merge of 14a; ticket 14c)", async () => {
    const call = (start: TrackDefinition["start"]): TrackDefinition => ({ id: "p1", channel: "call", branch: "main", window: weekdays, steps: [step("c1", { body: "" })], start, removed: false });
    const many = Array.from({ length: 25 }, (_, i) => person({ person_id: `c${i}`, business_id: "b1", full_name: `Caller Number${String(i).padStart(3, "0")}`, email: `caller${i}@harbour.example` }));
    const callOnly = person({ person_id: "c99", business_id: "b1", full_name: "Only Called", direct_phone: "+44 20 7946 0399" });
    const { h, id } = await campaign([inbox("inbox-a", { capacity: 10 })], [...many, callOnly], [HARBOUR]);
    const email = emailTrack([step("s1", { subject: "Hi", threading: "new_subject" }), step("s2", { waitDays: 2 })]);
    // Every lead has a good number: Harbour Lane's main line, and Only Called's own direct line.
    // At launch, all 26 calls go on Monday's list (capacity 50), so every lead has started on day 1.
    await h.defineSequence(id, { ...email, tracks: [...email.tracks, call({ kind: "entry" })] });
    expect((await beforeLaunch(h, id)).load).toMatchObject({ withheldBy: null, leadsToStart: 26, onlyCalled: 1, daysUntilAllStart: 1, calls: { capacity: 50, onListToday: 0, busiestDay: 26 } });
    // After the email track, plus a day: 10 emails a day, so days 1 and 2 take 20 first emails, days 3
    // and 4 go to their follow-ups first (4.3) and the last 5 start on day 5. Only Called has no email,
    // so the email track is skipped for them at launch and their call goes on Tuesday's list. The call
    // changes none of the emails while it is not logged.
    await h.defineSequence(id, { ...email, tracks: [...email.tracks, call({ kind: "after", trackId: "t1", delayDays: 1 })] });
    const after = (await beforeLaunch(h, id)).load;
    expect(after).toMatchObject({ withheldBy: null, leadsToStart: 26, onlyCalled: 1, daysUntilAllStart: 5, accounts: [expect.objectContaining({ busiestDay: 10 })] });
    // A capacity of 3 a day spreads the 26 calls over more days; the emails are unchanged.
    expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 3, userZone: "Europe/London" })).status).toBe(200);
    await h.defineSequence(id, { ...email, tracks: [...email.tracks, call({ kind: "entry" })] });
    const tight = (await beforeLaunch(h, id)).load;
    expect(tight).toMatchObject({ withheldBy: null, leadsToStart: 26, calls: { capacity: 3, onListToday: 0, busiestDay: 3 }, accounts: [expect.objectContaining({ busiestDay: 10 })] });
    // Only Called is reached by no email, so nothing touches them: their call is not among the three
    // placed at launch, and from then on every other lead, touched by its first email, goes first
    // (4.4: the priority classes of 4.3). Their call is the 26th, on the ninth weekday: day 11.
    expect(tight?.daysUntilAllStart).toBe(11);
  });

  test("only a track with no connected sender withholds the figure, and it is named; tracks after a phone track, and a phone track after another, are projected under the stated assumption about calls (review bot on 8edc8dd; ticket 13b; review bot on 5cd8a93)", async () => {
    const N1 = "+447700900001";
    const h = new EngineHarness({ start: MONDAY_8, accounts: [inbox("inbox-a", { capacity: 10 })], sms: { numbers: [{ id: N1, capacity: 50, gapMs: null, k: 1, healthy: true, resetZone: "Europe/London" }] } });
    const { campaign: c } = await h.createCampaign("Autumn physio", { businesses: [HARBOUR], people: PEOPLE });
    await h.tick();
    const base = emailTrack([step("s1", { subject: "Hi", threading: "new_subject" })]);
    const phone: TrackDefinition = { id: "p1", channel: "call", branch: "main", window: weekdays, steps: [step("c1", { body: "" })], start: { kind: "entry" }, removed: false };
    const sms = (start: TrackDefinition["start"]): TrackDefinition => ({ id: "m1", channel: "sms", branch: "main", window: weekdays, steps: [step("x1", { body: "A short text.", threading: "new_subject" })], start, removed: false });
    const secondEmail = (start: TrackDefinition["start"]): TrackDefinition => ({ id: "e2", channel: "email", branch: "main", window: weekdays, steps: [step("s2", { subject: "Hello", threading: "new_subject" })], start, removed: false });
    const load = async (tracks: TrackDefinition[], smsPool = [N1]) => {
      await h.defineSequence(c.id, { ...base, smsPool, tracks: [...base.tracks, ...tracks] });
      return (await beforeLaunch(h, c.id)).load!;
    };
    // Together with or after the email track, an SMS track, a second email track and a phone track are all projected.
    expect(await load([phone, sms({ kind: "entry" }), secondEmail({ kind: "after", trackId: "t1", delayDays: 1 })])).toMatchObject({ withheldBy: null, daysUntilAllStart: expect.any(Number) });
    // A track after the phone track, directly or through another: projected, its call assumed worked
    // on its day with no answer, which finishes the phone track (ticket 14c).
    expect(await load([phone, sms({ kind: "after", trackId: "p1", delayDays: 1 }), secondEmail({ kind: "after", trackId: "m1", delayDays: 0 })])).toMatchObject({ withheldBy: null, daysUntilAllStart: expect.any(Number) });
    // A second phone track after the first: projected the same way.
    const secondCall: TrackDefinition = { ...phone, id: "p2", steps: [step("c2", { body: "" })], start: { kind: "after", trackId: "p1", delayDays: 2 } };
    expect(await load([phone, secondCall])).toMatchObject({ withheldBy: null, daysUntilAllStart: expect.any(Number) });
    // An SMS track with no number: named as such.
    expect((await load([sms({ kind: "entry" })], [])).withheldBy).toEqual({ tracks: [{ trackId: "m1", channel: "sms", label: "the SMS track", why: "no_sender" }] });
  });

  describe("a competing campaign's calls (council on 10121d3, item 1; the test 14a had, restored)", () => {
    const phone = (start: TrackDefinition["start"] = { kind: "entry" }): TrackDefinition => ({ id: "p1", channel: "call", branch: "main", window: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 })), steps: [step("c1", { body: "" })], start, removed: false });
    const afterCall: TrackDefinition = { id: "e2", channel: "email", branch: "main", window: weekdays, steps: [step("s2", { subject: "After the call", threading: "new_subject" })], start: { kind: "after", trackId: "p1", delayDays: 0 }, removed: false };
    const base = emailTrack([step("s1", { subject: "Hi", threading: "new_subject" })]);
    async function competing(tracks: TrackDefinition[]) {
      const h = new EngineHarness({ start: MONDAY_8, accounts: [inbox("inbox-a", { capacity: 10 })] });
      await h.tick();
      expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" })).status).toBe(200);
      const { campaign: other } = await h.createCampaign("Winter physio", { businesses: [HARBOUR], people: PEOPLE });
      await h.defineSequence(other.id, { ...base, tracks: [...base.tracks, ...tracks] });
      expect((await h.launch(other.id)).status).toBe(200);
      const { campaign: c } = await h.createCampaign("Autumn physio", { businesses: [HARBOUR], people: PEOPLE });
      await h.defineSequence(c.id, base);
      return { h, other, c };
    }

    test("an email track after its phone track: projected, its calls assumed worked on their day, and the caveat names that campaign; once its calls are logged, it names none", async () => {
      const { h, other, c } = await competing([phone(), afterCall]);
      expect((await beforeLaunch(h, c.id)).load).toMatchObject({ withheldBy: null, daysUntilAllStart: expect.any(Number), callsNotCounted: [{ id: other.id, name: "Winter physio" }] });
      // The user logs every placed call: no call is left to assume anything about.
      await h.advanceTo(h.clock + H);
      for (const id of await h.store.engine.subjectsOf(other.id)) {
        const s = (await h.store.engine.subject(id, h.clock))!;
        const task = s.callTasks.find((t) => t.open);
        const number = s.lead.phones.find((n) => !n.bad);
        if (!task || !number) continue;
        expect((await h.request("POST", `/api/call-tasks/${task.id}/outcome`, { requestId: `r-${task.id}`, outcome: "no_answer", numberId: number.id, note: "" })).status).toBe(200);
      }
      expect((await beforeLaunch(h, c.id)).load).toMatchObject({ withheldBy: null, daysUntilAllStart: expect.any(Number), callsNotCounted: [] });
    });

    test("a phone track there with nothing after it does not withhold the figure, and the call caveat names that campaign", async () => {
      const { h, other, c } = await competing([phone()]);
      expect((await beforeLaunch(h, c.id)).load).toMatchObject({ withheldBy: null, daysUntilAllStart: expect.any(Number), callsNotCounted: [{ id: other.id, name: "Winter physio" }] });
    });
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
