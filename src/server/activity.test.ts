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
