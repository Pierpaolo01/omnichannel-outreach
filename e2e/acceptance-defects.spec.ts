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

/**
 * The defect's own assertion, and only it. By default it asserts the defect as it stands today, so the suite passes and a
 * fix makes this one assertion fail (the fix then swaps it for the spec's). SHOW_DEFECTS=1 asserts what the spec asks
 * instead, which fails while the defect stands. Everything before it is asserted normally, so a broken setup fails either way.
 */
async function defect(spec: () => Promise<void> | void, today: () => Promise<void> | void): Promise<void> {
  await (process.env["SHOW_DEFECTS"] ? spec() : today());
}

test("defect 2 (review item 11): a person's campaign row and the read name when the next email goes, not a past instant outside its sending window", async ({ page }) => {
  w = await acceptanceWorld({ start: MONDAY_10, smsConnected: true });
  const h = w.harness;
  // One email, sent Tuesday to Friday only, launched on a Monday morning.
  const id = await launched(w, def([track("email", "email", [step("s1", { subject: "Spring hours", body: "A note on spring hours." })], days([2, 3, 4, 5]))]));
  await h.advanceTo(MONDAY_10 + H);
  const lead = await w.lead("Pat Oneil", id);
  const read = await w.read(lead);
  await at(page, w, `/leads/people/${await w.record("Pat Oneil")}`);
  const row = page.getByRole("region", { name: "Campaigns" }).getByRole("listitem").first();
  await expect(row).toContainText("Next: email 1 of 1, due");
  const sentence = (await row.textContent()) ?? "";
  // What the engine does with it: nothing on Monday; it goes when Tuesday's window opens.
  await h.advanceTo(Date.parse("2026-11-10T12:00:00Z"));
  expect(h.fake.deliveryLog).toHaveLength(1);
  const sentAt = h.fake.deliveryLog[0]?.at;
  expect(sentAt).toBe(Date.parse("2026-11-10T09:00:00Z"));
  const dueInRead = read.tracks.find((t) => t.channel === "email")?.nextStep?.dueAt;
  await defect(
    () => {
      // The spec: the read and the row, taken on Monday at 11:00, name the instant it goes.
      expect(dueInRead).toBe(new Date(sentAt ?? NaN).toISOString());
      expect(sentence).toContain("due Tue 10 Nov at 09:00");
    },
    () => {
      // Today: both name the wait's end, the launch on Monday at 10:00, already past and outside the window.
      expect(dueInRead).toBe(new Date(MONDAY_10).toISOString());
      expect(sentence).toContain("due Mon 9 Nov at 10:00");
    },
  );
});

test("defect 3: while its campaign is paused, the Calls page does not say a call was logged from another window when it was not", async ({ page }) => {
  w = await acceptanceWorld({ start: MONDAY_10, smsConnected: true });
  const h = w.harness;
  const id = await launched(w, def([track("phone", "call", [step("c1", {})])]));
  await h.advanceTo(MONDAY_10 + 5 * MIN);
  // A callback for 15:30, logged over HTTP as the Calls page would; the user then has it open on the Calls page.
  const item = (await h.request<CallsView>("GET", "/api/calls")).body.readyNow[0];
  const taskId = item?.taskId ?? "";
  const task = (await h.request<CallTaskView>("GET", `/api/call-tasks/${taskId}`)).body;
  expect((await h.request("POST", `/api/call-tasks/${taskId}/outcome`, { requestId: "callback-1", outcome: "callback_requested", callbackAt: "2026-11-09T15:30:00.000Z", numberId: task.numbers[0]?.detailId ?? null, note: "" })).status).toBe(200);
  await h.advanceTo(Date.parse("2026-11-09T15:45:00Z"));
  await at(page, w, "/calls");
  await expect(page.getByRole("heading", { name: "Pat Oneil", exact: true })).toBeVisible();
  // The campaign is paused; the user comes back to the Calls page.
  expect((await h.request("POST", `/api/campaigns/${id}/pause`, { requestId: "pause-1" })).status).toBe(200);
  await at(page, w, "/calls");
  await expect(page.getByRole("complementary", { name: "Call queue" }).getByText("Ready now, 0")).toBeVisible();
  // Nothing can be logged on it while paused: every outcome and Log are disabled, and a post is refused.
  for (const button of await page.getByRole("group", { name: "Call outcome" }).getByRole("button").all()) await expect(button).toBeDisabled();
  await expect(page.getByRole("button", { name: "Log and open next call" })).toBeDisabled();
  expect((await h.request("POST", `/api/call-tasks/${taskId}/outcome`, { requestId: "while-paused", outcome: "no_answer", numberId: task.numbers[0]?.detailId ?? null, note: "" })).status).toBe(409);
  const offList = (await h.request<CallTaskView>("GET", `/api/call-tasks/${taskId}`)).body.offList;
  await defect(
    async () => {
      // The spec: the call is off the list because the campaign is paused, not because an outcome was logged elsewhere.
      expect(offList?.reason).not.toBe("logged");
      await expect(page.getByText(/already logged from another window or device/)).toHaveCount(0);
    },
    async () => {
      // Today: the read gives the reason "logged" (the callback request on the same task), and the page says so.
      expect(offList?.reason).toBe("logged");
      await expect(page.getByText(/already logged from another window or device: callback requested/)).toBeVisible();
    },
  );
});
