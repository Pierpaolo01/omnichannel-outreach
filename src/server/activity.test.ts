import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../test/support/engine-harness.ts";
import { business, person } from "../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition } from "../domain/sequence/definition.ts";
import type { ActivityView, ApiError, EnrollmentView } from "../shared/api.ts";

/**
 * The person timeline's activity (ticket 12c): what the provider reported for each email, the
 * skips, bounces, replies and endings, through the real HTTP app and engine over a fake provider.
 */
const H = 3_600_000;
const DAY = 24 * H;
const MONDAY_8 = Date.parse("2026-11-02T08:00:00Z");

const step = (id: string, fields: Partial<StepDefinition> = {}): StepDefinition => ({ id, waitDays: 0, subject: "", body: "Hello.", threading: "continue_thread", removed: false, ...fields });
const definition: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["inbox-a"],
  tracks: [
    {
      id: "t1",
      channel: "email",
      branch: "main",
      window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })),
      steps: [step("s1", { subject: "Evening bookings at {{company}}", body: "Hi {{first_name|there}}.", threading: "new_subject" }), step("s2", { waitDays: 2, body: "Following up, {{first_name|there}}." })],
      start: { kind: "entry" },
      removed: false,
    },
  ],
};

const PEOPLE = [
  person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example" }),
  person({ person_id: "p2", business_id: "b1", full_name: "Sam Lee", email: "sam@harbour.example" }),
  person({ person_id: "p3", business_id: "b1", full_name: "Ada Quinn", email: "ada@harbour.example" }),
  person({ person_id: "p4", business_id: "b1", full_name: "Lee Mott", direct_phone: "+44 20 7946 0303" }),
];

async function ran() {
  const h = new EngineHarness({ start: MONDAY_8, accounts: [{ id: "inbox-a", capacity: 30, gapMs: 60_000, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
  const { campaign } = await h.createCampaign("Autumn physio", { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101", phone_original: "020 7946 0101" })], people: PEOPLE });
  await h.tick();
  await h.defineSequence(campaign.id, definition);
  h.fake.bouncing.add("sam@harbour.example");
  expect((await h.launch(campaign.id)).status).toBe(200);
  await h.advanceTo(MONDAY_8 + 4 * H);
  h.fake.prospectReplies("ada@harbour.example");
  await h.advanceTo(MONDAY_8 + 5 * DAY);
  const rows = (await h.request<{ rows: { id: string; name: string; enrollments: EnrollmentView[] }[] }>("GET", "/api/leads")).body.rows;
  const id = (name: string) => rows.find((r) => r.name === name)!.id;
  const activity = async (name: string) => {
    const res = await h.request<ActivityView>("GET", `/api/people/${id(name)}/activity`);
    expect(res.status).toBe(200);
    return res.body.entries;
  };
  return { h, campaign, activity };
}

describe("the person timeline: email activity as the provider reported it", () => {
  test("each sent email with its sent copy, newest first, then the ending with no response", async () => {
    const { activity, campaign } = await ran();
    const entries = await activity("Pat Oneil");
    expect(entries.map((e) => [e.kind, "stepNumber" in e ? e.stepNumber : null])).toEqual([
      ["ended", null],
      ["sent", 2],
      ["sent", 1],
    ]);
    const [ended, second, first] = entries;
    expect(ended).toMatchObject({ kind: "ended", status: "sequence_finished_no_response", campaign: { id: campaign.id, name: "Autumn physio" } });
    expect(first).toMatchObject({ kind: "sent", from: "Fake inbox inbox-a", to: "pat@harbour.example", copy: { subject: "Evening bookings at Harbour Lane Physio", body: "Hi Pat." } });
    expect(first!.at).toBe("2026-11-02T09:00:00.000Z");
    // Email 2 waits two days after Email 1, so it goes on Wednesday.
    expect(second!.at.slice(0, 10)).toBe("2026-11-04");
  });

  test("a hard bounce shows after the email it answered, and the lead has no usable channel left", async () => {
    const { activity } = await ran();
    expect((await activity("Sam Lee")).map((e) => e.kind)).toEqual(["ended", "bounced", "sent"]);
    expect((await activity("Sam Lee"))[1]).toMatchObject({ kind: "bounced", to: "sam@harbour.example" });
    expect((await activity("Sam Lee"))[0]).toMatchObject({ kind: "ended", status: "finished_no_usable_channel" });
  });

  test("a reply shows its channel and date only, and nothing is sent after it", async () => {
    const { activity } = await ran();
    const entries = await activity("Ada Quinn");
    expect(entries.map((e) => e.kind)).toEqual(["replied", "sent"]);
    expect(entries[0]).toEqual({ kind: "replied", channel: "email", at: "2026-11-02T12:00:00.000Z", campaign: expect.any(Object) as unknown });
  });

  test("a lead without an email skips the email track, said once", async () => {
    const { activity } = await ran();
    const entries = await activity("Lee Mott");
    expect(entries).toEqual([
      expect.objectContaining({ kind: "ended", status: "finished_no_usable_channel" }),
      expect.objectContaining({ kind: "skipped", stepNumber: null, reason: "no_email" }),
    ]);
  });

  test("before launch there is no activity, and an unknown person is a 404", async () => {
    const h = new EngineHarness({ start: MONDAY_8, accounts: [] });
    await h.createCampaign("Quiet", { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })], people: PEOPLE.slice(0, 1) });
    const rows = (await h.request<{ rows: { id: string }[] }>("GET", "/api/leads")).body.rows;
    expect((await h.request<ActivityView>("GET", `/api/people/${rows[0]!.id}/activity`)).body).toEqual({ entries: [] });
    expect((await h.request<ApiError>("GET", "/api/people/nope/activity")).status).toBe(404);
    expect((await h.request<ApiError>("GET", "/api/companies/nope/activity")).status).toBe(404);
  });
});

describe("a bounce is kept as a fact, whatever state the track was in (review: activity.ts:50)", () => {
  const oneEmail: CampaignDefinition = { ...definition, tracks: [{ ...definition.tracks[0]!, steps: [definition.tracks[0]!.steps[0]!] }] };
  const inbox = { id: "inbox-a", capacity: 30, gapMs: 60_000, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" };
  const harbour = business({ business_id: "b1", business_name: "Harbour Lane Physio" });

  async function launchedFor(def: CampaignDefinition, name = "Autumn physio", h = new EngineHarness({ start: MONDAY_8, accounts: [inbox] })) {
    const { campaign } = await h.createCampaign(name, { businesses: [harbour], people: PEOPLE.slice(0, 1) });
    await h.tick();
    await h.defineSequence(campaign.id, def);
    expect((await h.launch(campaign.id)).status).toBe(200);
    const pat = async () => (await h.request<{ rows: { id: string; name: string }[] }>("GET", "/api/leads")).body.rows.find((r) => r.name === "Pat Oneil")!.id;
    const activity = async (campaignId = campaign.id) =>
      (await h.request<ActivityView>("GET", `/api/people/${await pat()}/activity`)).body.entries.filter((e) => e.campaign.id === campaignId);
    return { h, campaign, activity };
  }

  test("a bounce on the only email, after the track completed, still shows", async () => {
    const { h, activity } = await launchedFor(oneEmail);
    h.fake.bouncing.add("pat@harbour.example");
    await h.advanceTo(MONDAY_8 + 4 * H);
    const entries = await activity();
    expect(entries.map((e) => e.kind)).toEqual(["bounced", "ended", "sent"]);
    expect(entries[0]).toMatchObject({ kind: "bounced", to: "pat@harbour.example", stepNumber: 1, at: "2026-11-02T09:05:00.000Z" });
  });

  test("a bounce on the final follow-up, after its sent event, still shows", async () => {
    const { h, activity } = await launchedFor(definition);
    await h.advanceTo(MONDAY_8 + 4 * H);
    h.fake.bouncing.add("pat@harbour.example");
    await h.advanceTo(MONDAY_8 + 5 * DAY);
    const entries = await activity();
    expect(entries.map((e) => [e.kind, "stepNumber" in e ? e.stepNumber : null])).toEqual([
      ["bounced", 2],
      ["ended", null],
      ["sent", 2],
      ["sent", 1],
    ]);
  });

  test("an address another campaign's bounce marked wrong ends this lead here, and is not called a bounce here", async () => {
    const h = new EngineHarness({ start: MONDAY_8, accounts: [inbox] });
    const first = await launchedFor(definition, "Autumn physio", h);
    await h.advanceTo(MONDAY_8 + 4 * H);
    h.fake.bouncing.add("pat@harbour.example");
    const { campaign: other } = await h.createCampaign("Winter physio", { businesses: [harbour], people: PEOPLE.slice(0, 1) });
    await h.defineSequence(other.id, oneEmail);
    expect((await h.launch(other.id)).status).toBe(200);
    await h.advanceTo(MONDAY_8 + 5 * DAY);
    expect((await first.activity(other.id)).map((e) => e.kind)).toEqual(["bounced", "ended", "sent"]);
    // This campaign ends for want of a usable address; no bounce is claimed for it.
    const entries = await first.activity();
    expect(entries.map((e) => e.kind)).toEqual(["ended", "sent"]);
    expect(entries[0]).toMatchObject({ kind: "ended", status: "finished_no_usable_channel" });
  });
});

describe("a bounce the engine does not apply is not recorded (PR 41 council, item 5)", () => {
  test("a bounce for provider work that was never handed over leaves no bounce on the timeline", async () => {
    // A two-hour gap: Pat goes at 09:00; Sam's claim waits for the slot and expires after SETTLING, never handed over.
    const h = new EngineHarness({ start: MONDAY_8, accounts: [{ id: "inbox-a", capacity: 30, gapMs: 2 * H, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
    const { campaign } = await h.createCampaign("Autumn physio", { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })], people: PEOPLE.slice(0, 2) });
    await h.tick();
    await h.defineSequence(campaign.id, definition);
    expect((await h.launch(campaign.id)).status).toBe(200);
    await h.advanceTo(MONDAY_8 + H + 20 * 60_000);
    const rows = (await h.request<{ rows: { id: string; name: string; enrollments: EnrollmentView[] }[] }>("GET", "/api/leads")).body.rows;
    const sam = rows.find((r) => r.name === "Sam Lee")!;
    const state = (await h.store.engine.subject(sam.enrollments[0]!.id, h.clock))!;
    expect(state.attempts.every((a) => a.handedWall === null)).toBe(true);
    const key = state.work[0]!.key;
    (h.fake as unknown as { emit(at: number, e: unknown): void }).emit(h.clock, { id: "bounce-unapplied", kind: "bounced", key, providerRef: "ref-none", at: h.clock });
    await h.advanceTo(h.clock + 60_000);
    const entries = (await h.request<ActivityView>("GET", `/api/people/${sam.id}/activity`)).body.entries;
    expect(entries.filter((e) => e.kind === "bounced")).toEqual([]);
    expect(await h.store.engine.bouncesOf(sam.enrollments[0]!.id)).toEqual([]);
  });
});

describe("SMS on the timeline (ticket 13b): texts sent, bad numbers, skipped and released tracks, a text reply", () => {
  const N1 = "+447700900001";
  const weekdays = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
  const twoChannels: CampaignDefinition = {
    timezone: "Europe/London",
    callSkipLimitDays: 2,
    emailPool: ["inbox-a"],
    smsPool: [N1],
    tracks: [
      { id: "t1", channel: "email", branch: "main", window: weekdays, start: { kind: "entry" }, removed: false, steps: [step("s1", { subject: "Hi {{company}}", threading: "new_subject" })] },
      { id: "t2", channel: "sms", branch: "main", window: weekdays, start: { kind: "after", trackId: "t1", delayDays: 1 }, removed: false, steps: [step("m1", { body: "Hi {{first_name|there}}, a text.", threading: "new_subject" }), step("m2", { waitDays: 1, body: "One more.", threading: "new_subject" })] },
    ],
  };
  const people = [
    person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", dial_phone: "+447700900211", dial_phone_type: "mobile" }),
    person({ person_id: "p2", business_id: "b1", full_name: "Ana Ruiz", dial_phone: "+447700900222", dial_phone_type: "mobile" }),
    person({ person_id: "p3", business_id: "b1", full_name: "Lee Mott", direct_phone: "+44 20 7946 0303" }),
    person({ person_id: "p4", business_id: "b1", full_name: "Kim Park", dial_phone: "+447700900244", dial_phone_type: "mobile" }),
  ];

  async function texted() {
    const h = new EngineHarness({
      start: MONDAY_8,
      accounts: [{ id: "inbox-a", capacity: 30, gapMs: 60_000, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
      sms: { numbers: [{ id: N1, capacity: 30, gapMs: 60_000, k: 1, healthy: true, resetZone: "Europe/London" }] },
    });
    const { campaign } = await h.createCampaign("Autumn physio", { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })], people });
    await h.tick();
    await h.defineSequence(campaign.id, twoChannels);
    // Ana's number is reported invalid after her first text; Kim's is refused at the call.
    h.sms.invalidAfterSend.add("+447700900222");
    h.sms.invalid.add("+447700900244");
    expect((await h.launch(campaign.id)).status).toBe(200);
    await h.advanceTo(MONDAY_8 + DAY + 4 * H);
    expect(h.sms.prospectTexts("+447700900211", "STOP")).toBe(true);
    await h.advanceTo(MONDAY_8 + 5 * DAY);
    const rows = (await h.request<{ rows: { id: string; name: string }[] }>("GET", "/api/leads")).body.rows;
    const activity = async (name: string) => (await h.request<ActivityView>("GET", `/api/people/${rows.find((r) => r.name === name)!.id}/activity`)).body.entries;
    return { activity };
  }
  const brief = (entries: ActivityView["entries"]) => entries.map((e) => [e.kind, "channel" in e ? e.channel : null, "stepNumber" in e ? e.stepNumber : null]);

  test("an SMS reply stops the lead: the text and the email show, the reply has channel and date only, and no second text goes", async () => {
    const { activity } = await texted();
    const pat = await activity("Pat Oneil");
    expect(brief(pat)).toEqual([
      ["replied", "sms", null],
      ["sent", "sms", 1],
      ["sent", "email", 1],
    ]);
    expect(pat[1]).toMatchObject({ kind: "sent", channel: "sms", track: { label: "SMS track", several: false }, to: "+44 7700 900211", copy: { subject: "", body: "Hi Pat, a text." } });
    // A sender number reads grouped, as every number does (council on 10121d3, item 5).
    expect(pat[1]).toMatchObject({ from: "Simulated SMS (not a provider) +44 7700 900001" });
    // The SMS track starts a day after the email track finished.
    expect(pat[1]!.at.slice(0, 10)).toBe("2026-11-03");
    expect(pat[0]).toEqual({ kind: "replied", channel: "sms", at: expect.any(String) as unknown, campaign: expect.any(Object) as unknown });
  });

  test("a number reported invalid after a text is marked bad and ends the track; a skipped email track releases the SMS track after it, said plainly", async () => {
    const { activity } = await texted();
    const ana = await activity("Ana Ruiz");
    expect(brief(ana)).toEqual([
      ["ended", null, null],
      ["bounced", "sms", 1],
      ["sent", "sms", 1],
      ["released", "sms", null],
      ["skipped", "email", null],
    ]);
    expect(ana[1]).toMatchObject({ to: "+44 7700 900222" });
    expect(ana[3]).toMatchObject({ kind: "released", track: { label: "SMS track" }, after: { label: "Email track" }, because: "skipped", at: "2026-11-03T00:00:00.000Z" });
    expect(ana[4]).toMatchObject({ reason: "no_email" });
  });

  test("a number refused at the send fails its text and ends the track", async () => {
    const { activity } = await texted();
    expect(brief(await activity("Kim Park"))).toEqual([
      ["ended", null, null],
      ["failed", "sms", 1],
      ["released", "sms", null],
      ["skipped", "email", null],
    ]);
  });

  test("a lead with neither channel skips both tracks, each said once", async () => {
    const { activity } = await texted();
    const lee = await activity("Lee Mott");
    expect(brief(lee)).toEqual([
      ["ended", null, null],
      ["skipped", "sms", null],
      ["skipped", "email", null],
    ]);
    expect(lee[1]).toMatchObject({ reason: "no_mobile" });
  });
});

describe("Activity states only what is stored (council on 10121d3, item 8)", () => {
  const N1 = "+447700900001";
  const always = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
  const twoThenAfter = (first: "email" | "sms", second: "email" | "sms"): CampaignDefinition => ({
    timezone: "Europe/London",
    callSkipLimitDays: 2,
    emailPool: ["inbox-a"],
    smsPool: [N1],
    tracks: [
      { id: "t1", channel: first, branch: "main", window: always, start: { kind: "entry" }, removed: false, steps: [step("a1", { subject: first === "email" ? "Hi" : "", body: "One.", threading: "new_subject" }), step("a2", { waitDays: 3, body: "Two.", threading: first === "email" ? "continue_thread" : "new_subject" })] },
      { id: "t2", channel: second, branch: "main", window: always, start: { kind: "after", trackId: "t1", delayDays: 1 }, removed: false, steps: [step("b1", { subject: second === "email" ? "Hi" : "", body: "Later.", threading: "new_subject" })] },
    ],
  });
  async function stoppedBeforeTheSecondTrack(first: "email" | "sms", lead: Record<string, string>) {
    const h = new EngineHarness({
      start: MONDAY_8,
      accounts: [{ id: "inbox-a", capacity: 30, gapMs: 60_000, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
      sms: { numbers: [{ id: N1, capacity: 30, gapMs: 60_000, k: 1, healthy: true, resetZone: "Europe/London" }] },
    });
    const { campaign } = await h.createCampaign("Autumn physio", { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })], people: [lead] });
    await h.tick();
    await h.defineSequence(campaign.id, twoThenAfter(first, first === "email" ? "sms" : "email"));
    expect((await h.launch(campaign.id)).status).toBe(200);
    await h.advanceTo(MONDAY_8 + 2 * H);
    // The lead replies on the first track's channel, before the second track would start.
    if (first === "email") h.fake.prospectReplies(lead["email"]!);
    else expect(h.sms.prospectTexts(lead["dial_phone"]!, "Thanks")).toBe(true);
    await h.advanceTo(MONDAY_8 + 8 * DAY);
    const rows = (await h.request<{ rows: { id: string; name: string }[] }>("GET", "/api/leads")).body.rows;
    return (await h.request<ActivityView>("GET", `/api/people/${rows[0]!.id}/activity`)).body.entries;
  }

  test("an email reply before the SMS track starts: no SMS entry is invented for a lead with no mobile", async () => {
    const entries = await stoppedBeforeTheSecondTrack("email", person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example" }));
    expect(entries.map((e) => [e.kind, "channel" in e ? e.channel : null])).toEqual([
      ["replied", "email"],
      ["sent", "email"],
    ]);
  });

  test("a text reply before the email track starts: no email entry is invented for a lead with no email", async () => {
    const entries = await stoppedBeforeTheSecondTrack("sms", person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", dial_phone: "+447700900211", dial_phone_type: "mobile" }));
    expect(entries.map((e) => [e.kind, "channel" in e ? e.channel : null])).toEqual([
      ["replied", "sms"],
      ["sent", "sms"],
    ]);
  });
});
