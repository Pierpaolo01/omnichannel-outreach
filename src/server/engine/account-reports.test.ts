import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { FakeAccount } from "../../../test/support/fake-email-port.ts";
import type { CampaignDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { LeadSearchResult, NeedsAttention } from "../../shared/api.ts";

/**
 * What a port reports about its sender accounts, through the real HTTP app, SQLite store and engine against the fake
 * providers (verifier, 15 November 2026). Capacity 0 is "no room now", on either channel. A value the store cannot
 * hold for one account (a negative or fractional capacity, k of 0, a gap of 0) holds that account as `invalid_report`
 * and never makes the tick throw: every other account keeps sending. Fictitious data.
 */

const MIN = 60_000;
const H = 60 * MIN;
/** Monday 2 November 2026, 09:00 London (GMT). */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const TUESDAY = Date.parse("2026-11-03T00:00:00Z");
const N1 = "+447700900001";
const PAT_MOBILE = "+447700900101";
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));

const inbox = (id: string, fields: Partial<FakeAccount> = {}): FakeAccount => ({ id, capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC", ...fields });
const track = (channel: "email" | "sms", window = ALWAYS): TrackDefinition => ({
  id: "t1",
  channel,
  branch: "main",
  window,
  steps: [{ id: "s1", waitDays: 0, subject: channel === "email" ? "Hello {{first_name|there}}" : "", body: "A note for {{company}}.", threading: "new_subject", removed: false }],
  start: { kind: "entry" },
  removed: false,
});
const rows = {
  businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })],
  people: [person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", dial_phone: PAT_MOBILE, dial_phone_type: "mobile" })],
};

async function launched(h: EngineHarness, definition: CampaignDefinition): Promise<string> {
  await h.tick();
  h.clock = MONDAY_9;
  const { campaign } = await h.createCampaign("Harbour", rows);
  await h.defineSequence(campaign.id, definition);
  const launch = await h.launch(campaign.id);
  if (launch.status !== 200) throw new Error(`launch refused: ${JSON.stringify(launch.body)}`);
  return (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows[0]?.enrollments[0]?.id ?? "";
}

const attention = async (h: EngineHarness) => (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body;

describe("what a port reports about its accounts", () => {
  test.each<[string, Partial<FakeAccount>]>([
    ["a negative capacity", { capacity: -1 }],
    ["a fractional capacity", { capacity: 1.5 }],
    ["a capacity that is not a number", { capacity: Number.NaN }],
    ["an infinite capacity", { capacity: Number.POSITIVE_INFINITY }],
    ["an in-flight bound of 0", { k: 0 }],
    ["a pacing gap of 0", { gapMs: 0 }],
  ])("one inbox reporting %s is held as an invalid report; the tick completes and the other inbox sends", async (_, bad) => {
    const h = new EngineHarness({ start: MONDAY_9 - H, accounts: [inbox("inbox-a", bad), inbox("inbox-b")] });
    const lead = await launched(h, { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a", "inbox-b"], tracks: [track("email")] });
    await h.advanceTo(MONDAY_9 + H);

    expect(h.fake.deliveryLog.map((d) => [d.destination, d.sender])).toEqual([["pat@harbour.example", "inbox-b"]]);
    expect((await h.progress(lead)).tracks[0]?.steps[0]?.result).toBe("sent");
    const read = await attention(h);
    expect(read.sendingInterrupted).toBeNull();
    expect(read.senderProblems.map((p) => [p.accountId, p.problem])).toEqual([["inbox-a", "invalid_report"]]);
  });

  test("an inbox whose report turns invalid is held from then on, and sends again once its report is valid", async () => {
    const a = inbox("inbox-a", { capacity: 50 });
    const h = new EngineHarness({ start: MONDAY_9 - H, accounts: [a] });
    // The window opens at 10:00, so nothing is due at launch.
    await launched(h, { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], tracks: [track("email", ALWAYS.map((w) => ({ ...w, start: 10 })))] });
    a.capacity = -3;
    await h.advanceTo(MONDAY_9 + 2 * H);
    expect(h.fake.deliveryLog).toEqual([]);
    expect((await attention(h)).senderProblems.map((p) => [p.accountId, p.problem])).toEqual([["inbox-a", "invalid_report"]]);
    a.capacity = 50;
    await h.advanceTo(MONDAY_9 + 3 * H);
    expect(h.fake.deliveryLog.map((d) => d.sender)).toEqual(["inbox-a"]);
    expect((await attention(h)).senderProblems).toEqual([]);
  });

  test("an SMS number with capacity 0 has no room today: its text waits for capacity in Needs attention, and goes the next reset day", async () => {
    const number = { id: N1, capacity: 0, gapMs: MIN, k: 2, healthy: true, resetZone: "Europe/London" };
    const h = new EngineHarness({ start: MONDAY_9 - H, accounts: [inbox("inbox-a")], sms: { numbers: [number] } });
    const lead = await launched(h, { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: [N1], tracks: [track("sms")] });
    await h.advanceTo(MONDAY_9 + H);

    expect(h.sms.deliveryLog).toEqual([]);
    const read = await attention(h);
    expect(read.sendingInterrupted).toBeNull();
    expect(read.senderProblems).toEqual([]);
    expect(read.waitingForCapacity.map((w) => [w.enrollmentId, w.channel, w.accountIds, w.resetsAt])).toEqual([[lead, "sms", [N1], new Date(TUESDAY).toISOString()]]);

    number.capacity = 50;
    await h.advanceTo(TUESDAY + H);
    expect(h.sms.deliveryLog.map((d) => [d.destination, d.sender])).toEqual([[PAT_MOBILE, N1]]);
  });
});
