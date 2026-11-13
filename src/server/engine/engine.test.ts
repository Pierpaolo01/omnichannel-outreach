import { describe, expect, test } from "vitest";
import { business, person } from "../../../test/support/export-builder.ts";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import type { FakeAccount } from "../../../test/support/fake-email-port.ts";
import type { CampaignDefinition } from "../../domain/sequence/definition.ts";
import type { EnrollmentView } from "../../shared/api.ts";

const H = 3_600_000;
const DAY = 24 * H;
/** Monday 2 November 2026, 09:00 London. */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");

const inbox = (id: string, fields: Partial<FakeAccount> = {}): FakeAccount => ({ id, capacity: 30, gapMs: 120_000, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC", ...fields });

const rows = {
  businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })],
  people: [
    person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example" }),
    person({ person_id: "p2", business_id: "b1", full_name: "Sam Lee", email: "sam@harbour.example" }),
    person({ person_id: "p3", business_id: "b1", full_name: "Nia Cole", email: "nia@harbour.example" }),
    person({ person_id: "p4", business_id: "b1", full_name: "Omar Reed", dial_phone: "+447700900104", dial_phone_type: "mobile" }),
  ],
};

const threeEmails = (pool: string[] = ["inbox-a"]): CampaignDefinition => ({
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: pool,
  tracks: [
    {
      id: "t1",
      channel: "email",
      branch: "main",
      window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })),
      steps: [
        { id: "s1", waitDays: 0, subject: "Hello {{first_name|there}}", body: "A note for {{company}}.", threading: "new_subject", removed: false },
        { id: "s2", waitDays: 2, subject: "", body: "Following up, {{first_name|there}}.", threading: "continue_thread", removed: false },
        { id: "s3", waitDays: 3, subject: "", body: "One last note.", threading: "continue_thread", removed: false },
      ],
      start: { kind: "entry" },
      removed: false,
    },
  ],
});

async function setUp(accounts = [inbox("inbox-a")]) {
  const h = new EngineHarness({ start: MONDAY_9 - H, accounts });
  const { campaign } = await h.createCampaign("Autumn physio", rows);
  const people = (await h.request<{ rows: { id: string; name: string; enrollments: EnrollmentView[] }[] }>("GET", "/api/leads")).body.rows;
  const lead = (name: string) => {
    const row = people.find((p) => p.name === name);
    const id = row?.enrollments[0]?.id;
    if (!id) throw new Error(`${name} is not enrolled`);
    return id;
  };
  return { h, campaign, lead };
}

describe("one email track through the engine and a fake provider", () => {
  test("before launch: the three blockers, then launch", async () => {
    const { h, campaign } = await setUp();
    const empty = await h.request<{ launch: { nothingToLaunch: boolean } }>("GET", `/api/campaigns/${campaign.id}/sequence`);
    expect(empty.body.launch.nothingToLaunch).toBe(true);
    expect((await h.launch(campaign.id)).status).toBe(409);

    const noSender = await h.defineSequence(campaign.id, threeEmails(["inbox-z"]));
    expect(noSender.launch.blockers.map((b) => b.kind)).toEqual(["no_sender"]);
    expect((await h.launch(campaign.id)).body).toEqual({ error: { code: "launch_blocked", message: "Launch is blocked: The email track has no connected sender inbox." } });

    const ready = await h.defineSequence(campaign.id, threeEmails());
    expect(ready.launch).toEqual({ blockers: [], nothingToLaunch: false, canLaunch: true });
    h.clock = MONDAY_9;
    expect((await h.launch(campaign.id)).status).toBe(200);
    expect((await h.request("PUT", `/api/campaigns/${campaign.id}/sequence`, threeEmails())).status).toBe(409);
    expect((await h.launch(campaign.id)).status).toBe(409);
  });

  test("every step goes out in order, inside the window, then the lead finishes with no response", async () => {
    const { h, campaign, lead } = await setUp();
    await h.defineSequence(campaign.id, threeEmails());
    h.clock = MONDAY_9;
    await h.launch(campaign.id);
    await h.advanceTo(MONDAY_9 + 10 * DAY);

    const pat = await h.progress(lead("Pat Oneil"));
    expect(pat.status).toBe("sequence_finished_no_response");
    const sends = h.fake.deliveryLog.filter((d) => d.subjectId === pat.id);
    expect(sends.map((d) => d.stepId)).toEqual(["s1", "s2", "s3"]);
    expect(sends[0]?.rendered).toEqual({ subject: "Hello Pat", body: "A note for Harbour Lane Physio." });
    // Step 2 waits two calendar days, to Wednesday 00:00, then the window opens at 09:00.
    expect(new Date(sends[1]!.at).toISOString().slice(0, 13)).toBe("2026-11-04T09");
    // Step 3 waits three days from Wednesday, to Saturday 00:00; the window next opens Monday 09:00.
    expect(new Date(sends[2]!.at).toISOString().slice(0, 13)).toBe("2026-11-09T09");
    expect(pat.tracks[0]?.steps.map((s) => s.result)).toEqual(["sent", "sent", "sent"]);
    expect(pat.tracks[0]?.steps[0]?.sends[0]).toMatchObject({ state: "sent", sender: "inbox-a", copy: { subject: "Hello Pat" } });
  });

  test("a lead with no email finishes with no usable channel at launch", async () => {
    const { h, campaign, lead } = await setUp();
    await h.defineSequence(campaign.id, threeEmails());
    h.clock = MONDAY_9;
    await h.launch(campaign.id);
    expect((await h.progress(lead("Omar Reed"))).status).toBe("finished_no_usable_channel");
  });

  test("a reply stops that lead only, shown as replied with channel and date", async () => {
    const { h, campaign, lead } = await setUp();
    await h.defineSequence(campaign.id, threeEmails());
    h.clock = MONDAY_9;
    await h.launch(campaign.id);
    await h.advanceTo(MONDAY_9 + 3 * H);
    h.fake.prospectReplies("sam@harbour.example");
    await h.advanceTo(MONDAY_9 + 10 * DAY);
    const sam = await h.progress(lead("Sam Lee"));
    expect(sam.status).toBe("replied");
    expect(sam.reply).toEqual({ channel: "email", at: new Date(MONDAY_9 + 3 * H).toISOString() });
    expect(h.fake.deliveryLog.filter((d) => d.subjectId === sam.id).map((d) => d.stepId)).toEqual(["s1"]);
    expect((await h.progress(lead("Pat Oneil"))).status).toBe("sequence_finished_no_response");
    // The status is visible in search.
    const search = await h.request<{ rows: { name: string; enrollments: EnrollmentView[] }[] }>("GET", "/api/leads?status=replied");
    expect(search.body.rows.map((r) => r.name)).toEqual(["Sam Lee"]);
  });

  test("a hard bounce marks the address bad and finishes the track; with no other address the lead has no usable channel", async () => {
    const { h, campaign, lead } = await setUp();
    h.fake.bouncing.add("nia@harbour.example");
    await h.defineSequence(campaign.id, threeEmails());
    h.clock = MONDAY_9;
    await h.launch(campaign.id);
    await h.advanceTo(MONDAY_9 + 10 * DAY);
    const nia = await h.progress(lead("Nia Cole"));
    expect(nia.status).toBe("finished_no_usable_channel");
    expect(nia.tracks[0]?.finishReason).toBe("failed_bad_destination");
    expect(h.fake.deliveryLog.filter((d) => d.subjectId === nia.id).map((d) => d.stepId)).toEqual(["s1"]);
    const people = (await h.request<{ rows: { id: string; name: string }[] }>("GET", "/api/leads?q=nia")).body.rows;
    const record = await h.person(people[0]!.id);
    expect(record.contactDetails.find((d) => d.value === "nia@harbour.example")?.bad).toBe(true);
  });

  test("capacity is shared, follow-ups go first, and overflow waits for the next day while new leads stay queued", async () => {
    const { h, campaign, lead } = await setUp([inbox("inbox-a", { capacity: 2 })]);
    await h.defineSequence(campaign.id, threeEmails());
    h.clock = MONDAY_9;
    await h.launch(campaign.id);
    await h.advanceTo(MONDAY_9 + 7 * H);
    // Two sends on Monday; the third new lead waits for Tuesday.
    const monday = h.fake.deliveryLog.filter((d) => d.at < MONDAY_9 + 15 * H);
    expect(monday).toHaveLength(2);
    const waiting = ["Pat Oneil", "Sam Lee", "Nia Cole"].map(lead).filter((id) => !monday.some((d) => d.subjectId === id));
    expect((await h.progress(waiting[0]!)).status).toBe("queued");
    await h.advanceTo(MONDAY_9 + 3 * DAY);
    // Tuesday's capacity takes the waiting opener; on Wednesday the two follow-ups go out.
    const tuesday = h.fake.deliveryLog.filter((d) => d.at >= MONDAY_9 + 15 * H && d.at < MONDAY_9 + DAY + 15 * H);
    expect(tuesday.map((d) => d.stepId)).toEqual(["s1"]);
    const wednesday = h.fake.deliveryLog.filter((d) => d.at >= MONDAY_9 + 2 * DAY - 9 * H && d.at < MONDAY_9 + 2 * DAY + 15 * H);
    expect(wednesday.map((d) => d.stepId)).toEqual(["s2", "s2"]);
  });

  test("one sender inbox for a lead throughout its campaign", async () => {
    const { h, campaign, lead } = await setUp([inbox("inbox-a"), inbox("inbox-b")]);
    await h.defineSequence(campaign.id, threeEmails(["inbox-a", "inbox-b"]));
    h.clock = MONDAY_9;
    await h.launch(campaign.id);
    await h.advanceTo(MONDAY_9 + 10 * DAY);
    for (const name of ["Pat Oneil", "Sam Lee", "Nia Cole"]) {
      const id = lead(name);
      const senders = new Set(h.fake.deliveryLog.filter((d) => d.subjectId === id).map((d) => d.sender));
      expect(senders.size).toBe(1);
      expect((await h.progress(id)).sender).toBe([...senders][0]);
    }
  });
});

describe("settling against the fake's modes", () => {
  test("a send the provider holds past SETTLING is looked up until MAX_QUEUED_LOOKUPS queued answers, then unresolved, and cannot be marked not sent while queued", async () => {
    const h = new EngineHarness({ start: MONDAY_9 - H, accounts: [inbox("inbox-a")], modes: ["late-send-beyond-settling"], random: () => 0.99 });
    const { campaign } = await h.createCampaign("Held", { businesses: rows.businesses, people: [rows.people[0]!] });
    await h.defineSequence(campaign.id, threeEmails());
    h.clock = MONDAY_9;
    await h.launch(campaign.id);
    await h.advanceTo(MONDAY_9 + 3 * H + 30 * 60_000);
    const [attempt] = await h.store.engine.openAttempts();
    // Twelve queued answers make it unresolved at 3 h; it keeps being looked up every SETTLING after.
    expect(attempt).toMatchObject({ state: "accepted", lookupAnswer: "queued", queuedLookups: 14, unresolvedSince: MONDAY_9 + 3 * H });
    expect(await h.engine.markAttempt(attempt!.id, "not_sent")).toBe(false);
    expect((await h.request<{ heldTracks: unknown[] }>("GET", "/api/needs-attention")).body.heldTracks).toHaveLength(1);
    // The provider sends at last; the observation settles it and the track moves on.
    await h.advanceTo(MONDAY_9 + 6 * H);
    expect((await h.store.engine.attempt(attempt!.id))?.state).toBe("sent");
    expect(h.fake.deliveryLog).toHaveLength(1);
  });
});
