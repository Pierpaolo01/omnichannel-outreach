import { expect, test, type Page } from "@playwright/test";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../src/domain/sequence/definition.ts";
import type { Campaign, CallsView, CallTaskView } from "../src/shared/api.ts";
import { acceptanceWorld, H, INBOX, MIN, NUMBERS, type AcceptanceWorld } from "./acceptance-world.ts";
import { business, csvOf, person } from "../test/support/export-builder.ts";

/**
 * Ticket 23: product defects the acceptance run found and reported to the coordinator, not fixed here. Each test states
 * the behaviour the spec asks for and is marked `test.fail()`: it fails today, and the suite stays green while it does.
 * When the defect is fixed the test passes, Playwright reports the unexpected pass, and the mark comes off.
 * Every name, address and number is fictitious.
 */

test.use({ timezoneId: "Europe/London", actionTimeout: 15_000 });

const step = (id: string, fields: Partial<StepDefinition>): StepDefinition => ({ id, waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false, ...fields });
const days = (list: number[]) => list.map((day) => ({ day, start: 9, end: 17 }));
const track = (id: string, channel: TrackDefinition["channel"], steps: StepDefinition[], window = days([1, 2, 3, 4, 5])): TrackDefinition => ({ id, channel, branch: "main", window, start: { kind: "entry" }, removed: false, steps });
const def = (tracks: TrackDefinition[]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: [INBOX], smsPool: [...NUMBERS], callScript: "", tracks });
const rows = csvOf({
  businesses: [business({ business_id: "bz-lark", business_name: "Lark Street Clinic", city: "Bristol", phone_e164: "+441174960303" })],
  people: [person({ person_id: "pp-pat", business_id: "bz-lark", full_name: "Pat Oneil", email: "pat@larkstreet.example", dial_phone: "+447700900501", dial_phone_type: "mobile" })],
});
const MONDAY_10 = Date.parse("2026-11-09T10:00:00Z");

let w: AcceptanceWorld | null = null;
test.afterEach(async () => {
  await w?.close();
  w = null;
});

async function launched(world: AcceptanceWorld, definition: CampaignDefinition): Promise<string> {
  const id = (await world.harness.request<{ campaign: Campaign }>("POST", "/api/campaigns", { name: "Spring follow-up, Bristol", defaultTimezone: "Europe/London", ...rows })).body.campaign.id;
  await world.harness.defineSequence(id, definition);
  expect((await world.harness.launch(id)).status).toBe(200);
  return id;
}
async function at(page: Page, world: AcceptanceWorld, route: string): Promise<void> {
  await page.clock.setFixedTime(world.harness.clock);
  await page.goto(world.url + route);
}

test("defect 2 (review item 11): a person's campaign row says when the next email goes, not a past instant outside its sending window", async ({ page }) => {
  test.fail(!process.env["SHOW_DEFECTS"], "Reported to the coordinator on 15 November 2026: the row says the wait's end (launch, Monday 10:00), not the next sendable instant (Tuesday 09:00).");
  w = await acceptanceWorld({ start: MONDAY_10, smsConnected: true });
  const h = w.harness;
  // One email, sent Tuesday to Friday only, launched on a Monday morning.
  await launched(w, def([track("email", "email", [step("s1", { subject: "Spring hours", body: "A note on spring hours." })], days([2, 3, 4, 5]))]));
  await h.advanceTo(MONDAY_10 + H);
  await at(page, w, `/leads/people/${await w.record("Pat Oneil")}`);
  const row = page.getByRole("region", { name: "Campaigns" }).getByRole("listitem").first();
  const sentence = (await row.textContent()) ?? "";
  // What the engine does with it: nothing on Monday; it goes when Tuesday's window opens.
  await h.advanceTo(Date.parse("2026-11-10T12:00:00Z"));
  expect(h.fake.deliveryLog).toHaveLength(1);
  expect(h.fake.deliveryLog[0]?.at).toBe(Date.parse("2026-11-10T09:00:00Z"));
  // The row read on Monday at 11:00 should have named that instant, never one already past on a day the window excludes.
  expect(sentence).toContain("due Tue 10 Nov at 09:00");
  expect(sentence).not.toContain("Mon 9 Nov at 10:00");
});

test("defect 3: while its campaign is paused, the Calls page does not reopen a call it had open, nor say it was logged from another window", async ({ page }) => {
  test.fail(!process.env["SHOW_DEFECTS"], "Reported to the coordinator on 15 November 2026: the call-task read gives the reason 'logged' for a callback that a campaign pause took off the list.");
  w = await acceptanceWorld({ start: MONDAY_10, smsConnected: true });
  const h = w.harness;
  const id = await launched(w, def([track("phone", "call", [step("c1", {})])]));
  await h.advanceTo(MONDAY_10 + 5 * MIN);
  // A callback for 15:30, logged over HTTP as the Calls page would; the user then has it open on the Calls page.
  const item = (await h.request<CallsView>("GET", "/api/calls")).body.readyNow[0];
  const task = (await h.request<CallTaskView>("GET", `/api/call-tasks/${item?.taskId ?? ""}`)).body;
  expect((await h.request("POST", `/api/call-tasks/${item?.taskId ?? ""}/outcome`, { requestId: "callback-1", outcome: "callback_requested", callbackAt: "2026-11-09T15:30:00.000Z", numberId: task.numbers[0]?.detailId ?? null, note: "" })).status).toBe(200);
  await h.advanceTo(Date.parse("2026-11-09T15:45:00Z"));
  await at(page, w, "/calls");
  await expect(page.getByRole("heading", { name: "Pat Oneil", exact: true })).toBeVisible();
  // The campaign is paused; the user comes back to the Calls page.
  expect((await h.request("POST", `/api/campaigns/${id}/pause`, { requestId: "pause-1" })).status).toBe(200);
  await at(page, w, "/calls");
  await expect(page.getByRole("complementary", { name: "Call queue" }).getByText("Ready now, 0")).toBeVisible();
  // What the spec asks: the paused campaign's call is off the list, and nothing says it was logged elsewhere.
  await expect(page.getByText(/already logged from another window or device/)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Pat Oneil", exact: true })).toHaveCount(0);
});
