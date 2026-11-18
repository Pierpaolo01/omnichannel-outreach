import { expect, test, type Page } from "@playwright/test";
import { fakeLinkedinApp, type FakeLinkedinApp } from "./fake-linkedin.ts";

/**
 * The council's reviews of `dee365d` (ticket 24b), items 10 and 12: every confirmation this ticket added is a snapshot of
 * the read and the subject it was opened on, closes with its reason when what it is about is replaced or settled under it
 * (another client), and never leaves keyboard focus on the page body. Keyboard only, on the simulated LinkedIn provider.
 */

async function at(page: Page, f: FakeLinkedinApp, path: string): Promise<void> {
  await page.clock.setFixedTime(f.h.clock);
  await page.goto(f.url + path);
}
const onBody = (page: Page) => page.evaluate(() => document.activeElement === document.body);

test("the record's LinkedIn confirmations: cancel returns focus to the control that opened each, and one closed by another client says why and keeps focus", async ({ page, context }) => {
  const f = await fakeLinkedinApp("later", "linkedin-confirmations-record");
  const nia = `/leads/people/${await f.person("Nia Cole")}`;
  await at(page, f, nia);
  for (const name of [/^It’s withdrawn: the LinkedIn invite to Nia Cole/, /^It’s still there: the LinkedIn invite to Nia Cole/, /^Mark replied on LinkedIn: Nia Cole in/]) {
    await page.getByRole("button", { name }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("group").getByRole("button", { name: "Cancel" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name })).toBeFocused();
  }
  // Another client answers the withdrawal while this one's confirmation is open: it closes, says why, and holds focus.
  await page.getByRole("button", { name: /^It’s withdrawn: the LinkedIn invite to Nia Cole/ }).focus();
  await page.keyboard.press("Enter");
  const other = await context.newPage();
  await at(other, f, nia);
  await other.getByRole("button", { name: /^It’s still there: the LinkedIn invite to Nia Cole/ }).click();
  await other.getByRole("group").getByRole("button", { name: "It’s still there" }).click();
  await expect(other.getByText("Marked still there.", { exact: false })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("The withdrawal was settled since you opened this, so it was closed. Nothing was marked.")).toBeFocused();
  expect(await onBody(page)).toBe(false);
});

test("a test run's confirmations: a reply mark opened on a finished run closes when another client starts a new run, and nothing is marked", async ({ page, context }) => {
  const f = await fakeLinkedinApp("test-stuck", "linkedin-confirmations-test");
  const tab = `/campaigns/${f.campaign}/test-run`;
  await at(page, f, tab);
  // Cancel returns focus to each control that opened a confirmation (item 12).
  for (const name of ["It’s withdrawn", "It’s still there", /^Mark replied on LinkedIn$/]) {
    await page.getByRole("button", { name }).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name })).toBeFocused();
  }
  const before = (await f.h.request<{ run: { id: string } }>("GET", `/api/campaigns/${f.campaign}/test-runs`)).body.run.id;
  await page.getByRole("button", { name: /^Mark replied on LinkedIn$/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/^Mark this test replied on LinkedIn\?/)).toBeVisible();
  // Another client starts a new run; this tab hears of it and its confirmation, opened on the old run, closes (item 10).
  const other = await context.newPage();
  await at(other, f, tab);
  await other.getByRole("button", { name: "Run test again" }).click();
  await expect(other.getByRole("button", { name: "Test running" })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("The test shown here changed since you opened this, so it was closed. Nothing was marked.")).toBeFocused();
  expect(await onBody(page)).toBe(false);
  const runs = (await f.h.request<{ run: { id: string; ending: string | null } }>("GET", `/api/campaigns/${f.campaign}/test-runs`)).body.run;
  expect(runs.id).not.toBe(before);
  expect(runs.ending).toBeNull();
});
