import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../test/support/engine-harness.ts";
import { business, person } from "../../test/support/export-builder.ts";
import type { CampaignDefinition } from "../domain/sequence/definition.ts";
import type { BeforeLaunchView, TodayView } from "../shared/api.ts";

/**
 * "No room today" is not "no room ever" (council on PR 63): an account reports its daily limit apart from today's room.
 * The engine uses today's room for today and the daily limit for every other day, in the Before launch projection and in
 * the interruption notice's count alike. Fake providers, fictitious data.
 */
const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
/** Monday 2 November 2026, 09:00 London (GMT). */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const TUESDAY = Date.parse("2026-11-03T00:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));

const definition = (window = ALWAYS): CampaignDefinition => ({
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["inbox-a"],
  smsPool: [],
  tracks: [{ id: "e1", channel: "email", branch: "main", window, steps: [{ id: "s1", waitDays: 0, subject: "Hello", body: "A note for {{company}}.", threading: "new_subject", removed: false }], start: { kind: "entry" }, removed: false }],
});
const rows = (n: number) => ({
  businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })],
  people: Array.from({ length: n }, (_, i) => person({ person_id: `p${i}`, business_id: "b1", full_name: `Lead ${String.fromCharCode(65 + i)} Oneil`, email: `lead${i}@harbour.example` })),
});
const harness = () => new EngineHarness({ start: MONDAY_9, accounts: [{ id: "inbox-a", capacity: 5, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });

describe("an inbox with no room today has its daily limit on other days", () => {
  test.each([
    ["with room today", false, 2],
    ["used up outside the app today", true, 3],
  ])("Before launch, 10 leads on an inbox of daily limit 5 %s: the estimate counts its daily limit from tomorrow", async (_, usedUp, days) => {
    const h = harness();
    if (usedUp) h.fake.usedUpUntil.set("inbox-a", TUESDAY);
    await h.tick();
    const { campaign } = await h.createCampaign("Harbour", rows(10));
    await h.defineSequence(campaign.id, definition());
    const load = (await h.request<BeforeLaunchView>("GET", `/api/campaigns/${campaign.id}/before-launch`)).body.load;
    expect(load).toMatchObject({ leadsToStart: 10, daysUntilAllStart: days, stoppedEarly: null });
    expect(load?.accounts).toEqual([expect.objectContaining({ id: "inbox-a", capacity: usedUp ? 0 : 5 })]);
  });

  test("the interruption notice counts a send the inbox had room for on an earlier day of the gap, though it has no room on the day the app restarts", async () => {
    const h = harness();
    await h.tick();
    const { campaign } = await h.createCampaign("Harbour", rows(1));
    // The window opens at 12:00, so the email falls due during the interruption.
    await h.defineSequence(campaign.id, definition(ALWAYS.map((w) => ({ ...w, start: 12 }))));
    expect((await h.launch(campaign.id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + 30 * MIN);
    // Stopped Monday 09:30 until Wednesday 09:30; on Wednesday other senders have used the inbox up.
    h.fake.usedUpUntil.set("inbox-a", TUESDAY + DAY + DAY);
    await h.stopFor(2 * DAY);
    const today = (await h.request<TodayView>("GET", "/api/today")).body;
    expect(today.interruption).toMatchObject({ rescheduled: 1 });
    expect(h.fake.deliveryLog).toEqual([]);
  });
});
