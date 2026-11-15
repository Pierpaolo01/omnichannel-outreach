import { expect, test, type Locator, type Page } from "@playwright/test";
import { fakeTakenConversationApp } from "./fake-provider.ts";

/**
 * Question Q7 answered (ADR 0003, 15 November 2026): a lead's SMS track skipped because their mobile is already in
 * another campaign's text conversation on the one number both campaigns use. On the app over the fake providers, with
 * fictitious data: the person record's campaign row and Activity name the campaign that keeps the conversation, the
 * track after it says it started after a skip, a lead with nothing else left ends with no usable channel, and Today's
 * Needs attention says why. EVIDENCE_DIR=<dir> also writes each screenshot, light and dark, for the pull request.
 */

test.use({ timezoneId: "Europe/London" });

const TAKEN = "Their mobile was already in a text conversation with campaign Spring clinics on every number this campaign can use, so a reply couldn’t show which campaign it answers.";

async function shot(page: Page, name: string, target: Locator): Promise<void> {
  const dir = process.env["EVIDENCE_DIR"];
  if (!dir) return;
  await target.scrollIntoViewIfNeeded();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: null });
}

test("a lead whose SMS track was skipped for another campaign's conversation: the record says why and names the campaign, and the email after it went", async ({ page }) => {
  const f = await fakeTakenConversationApp();
  await page.clock.setFixedTime(f.harness.clock);
  await page.goto(`${f.url}/leads/people/${f.person("Pat Oneil")}`);
  await expect(page.getByRole("heading", { name: "Pat Oneil" })).toBeVisible();
  const skipped = page.getByText(TAKEN);
  await expect(skipped).toBeVisible();
  await expect(page.getByText("It starts after the SMS track, which was skipped for this lead.")).toBeVisible();
  // Nothing about it waits on the user: it is never said to be on hold.
  await expect(page.getByText(/on hold/i)).toHaveCount(0);
  await shot(page, "01-record-activity-skipped", skipped);
});

test("a lead whose only channel was that SMS track ends with no usable channel; the record and Today say why", async ({ page }) => {
  const f = await fakeTakenConversationApp();
  await page.clock.setFixedTime(f.harness.clock);
  await page.goto(`${f.url}/leads/people/${f.person("Nia Cole")}`);
  await expect(page.getByRole("heading", { name: "Nia Cole" })).toBeVisible();
  await expect(page.getByText("Nothing is left to reach them on in this campaign.").first()).toBeVisible();
  const skipped = page.getByText(TAKEN);
  await expect(skipped).toBeVisible();
  await shot(page, "02-record-no-usable-channel", page.getByText("Nothing is left to reach them on in this campaign.").first());
  await page.goto(`${f.url}/`);
  const attention = page.getByText("Now their mobile is in a text conversation with campaign Spring clinics on every number this campaign can use and they have no email address.");
  await expect(attention).toBeVisible();
  await shot(page, "03-today-needs-attention", attention);
});
