import { expect, test, type Page } from "@playwright/test";
import type { NeedsAttention, TodayView } from "../src/shared/api.ts";
import { fakeCallsApp, fakeInterruptionApp, type FakeInterruptionApp } from "./fake-provider.ts";
import { respond } from "./mocks.ts";

/**
 * Ticket 20b: the interruption line and the new Needs attention entries on Today. The demonstration (recorded with
 * RECORD_DEMO=1) runs ticket 20's story on the fake providers: an interruption with due email and SMS, a paused
 * enrollment and pending calls, then Today. Every name, address and number is fictitious.
 */

const linger = async (page: Page) => {
  if (process.env["RECORD_DEMO"]) await page.waitForTimeout(2_500);
};

async function at(page: Page, f: FakeInterruptionApp, path: string): Promise<void> {
  await page.clock.setFixedTime(f.harness.clock);
  await page.goto(f.url + path);
}

const attention = (page: Page) => page.getByRole("region", { name: "Needs attention" });
const entry = (page: Page, title: string | RegExp) => attention(page).getByRole("listitem").filter({ hasText: title });

test("ticket 20's demonstration: after two days stopped, Today says when sending was interrupted and what needs the user", async ({ page }) => {
  test.setTimeout(120_000);
  const f = await fakeInterruptionApp("across-days");
  const today = (await f.harness.request<TodayView>("GET", "/api/today")).body;
  const needs = (await f.harness.request<NeedsAttention>("GET", "/api/needs-attention")).body;
  const n = today.interruption?.rescheduled ?? -1;
  expect(n).toBeGreaterThan(1);

  await test.step("Wednesday 12:00 London: the one line, with the stop's date, since it began on Monday", async () => {
    await at(page, f, "/");
    await expect(page.getByTestId("interruption-line")).toHaveText(`Sending was interrupted from Mon 9 Nov at 12:00 to 12:00; ${n} sends rescheduled.`);
    await expect(page.getByText(/sending was interrupted/i)).toHaveCount(1);
    await linger(page);
  });

  await test.step("Needs attention: the calls that waited for the user, and leads waiting for the shared inbox's capacity", async () => {
    await expect(entry(page, /calls carried over from earlier days/)).toBeVisible();
    expect(needs.waitingForCapacity.length).toBeGreaterThan(0);
    const campaigns = [...new Set(needs.waitingForCapacity.map((w) => w.campaign.name))];
    for (const name of campaigns) await expect(entry(page, new RegExp(`(in ${name} are|is) waiting for sending capacity`)).first()).toBeVisible();
    await expect(attention(page).getByText(/full for the day/).first()).toBeVisible();
    // No replies count or list (spec).
    await expect(attention(page).getByText(/repl/i)).toHaveCount(0);
    await linger(page);
  });

  await test.step("an entry leads where to act, by keyboard", async () => {
    const link = attention(page).getByRole("link", { name: /^Open (campaign|.*’s record)$|Open Clinics|Open Physios/ }).first();
    await link.focus();
    await expect(link).toBeFocused();
    const href = await link.getAttribute("href");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`${href?.replace(/[?]/g, "\\?") ?? ""}$`));
    await linger(page);
  });
});

test("an interruption within today says its times only, and the line stays while the read carries it", async ({ page }) => {
  test.setTimeout(120_000);
  const f = await fakeInterruptionApp("same-day");
  const today = (await f.harness.request<TodayView>("GET", "/api/today")).body;
  const n = today.interruption?.rescheduled ?? -1;
  await at(page, f, "/");
  await expect(page.getByTestId("interruption-line")).toHaveText(`Sending was interrupted from 12:00 to 15:00; ${n === 1 ? "1 send" : n === 0 ? "no sends" : `${n} sends`} rescheduled.`);
  // Question Q18's interim: it stays until a newer interruption replaces it; a later read still carries it.
  await f.harness.advanceTo(f.harness.clock + 2 * 3_600_000);
  await at(page, f, "/");
  await expect(page.getByTestId("interruption-line")).toContainText("from 12:00 to 15:00");
});

test("no interruption: no line", async ({ page }) => {
  const f = await fakeCallsApp("ready");
  await page.clock.setFixedTime(f.harness.clock);
  await page.goto(f.url + "/");
  await expect(page.getByRole("heading", { name: "Needs attention" })).toBeVisible();
  await expect(page.getByTestId("interruption-line")).toHaveCount(0);
});

test("sending not running, a provider not answering and leads with no way left: what each is and where to act", async ({ page }) => {
  const f = await fakeCallsApp("ready");
  await page.route("**/api/today", async (route) => {
    const body = (await (await route.fetch()).json()) as TodayView;
    await respond(route, { ...body, sendingInterrupted: { since: body.asOf, cause: "not_running", lastFailedRead: null } });
  });
  await page.route("**/api/needs-attention", async (route) => {
    const body = (await (await route.fetch()).json()) as NeedsAttention;
    const campaign = { id: f.campaign, name: "Clinics, London" };
    const company = { id: "co-1", name: "Harbour Lane Physio" };
    await respond(route, {
      ...body,
      waitingOnProvider: [{ channel: "sms", since: null, sends: 2 }],
      noUsableChannel: [{ enrollmentId: "e-1", campaignId: f.campaign, person: { id: "person-1", name: "Rob Lane" }, company, campaign, endedAt: body.overdueCallbacks[0]?.dueAt ?? "2026-11-09T09:00:00.000Z", channels: [{ channel: "email", why: "missing" }] }],
    });
  });
  await page.clock.setFixedTime(f.harness.clock);
  await page.goto(f.url + "/");
  const stopped = entry(page, "Sending is not running");
  await expect(stopped).toContainText("No sending round has run since 10:00.");
  // No page restarts sending: the entry has no link.
  await expect(stopped.getByRole("link")).toHaveCount(0);
  await expect(entry(page, "The SMS provider isn’t answering")).toContainText("It hasn’t answered yet. 2 texts wait on it");
  const ended = entry(page, "No way was left to reach Rob Lane");
  await expect(ended).toContainText("they have no email address");
  await expect(ended.getByRole("link", { name: "Open Rob Lane’s record" })).toHaveAttribute("href", "/leads/people/person-1");
  // The order: sending first among these, the lead with no way left last.
  const titles = await attention(page).getByRole("listitem").locator("b").allTextContents();
  expect(titles.indexOf("Sending is not running")).toBeLessThan(titles.indexOf("The SMS provider isn’t answering"));
  expect(titles.at(-1)).toBe("No way was left to reach Rob Lane");
});
