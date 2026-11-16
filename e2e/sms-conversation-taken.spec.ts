import { expect, test, type Locator, type Page } from "@playwright/test";
import { fakeTakenConversationApp, fakeUnsettledConversationApp } from "./fake-provider.ts";

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

// Point 10 (the reviews of faac357, item 5): while Spring clinics' first text to Pat isn't known to have gone or not,
// Autumn clinics' text to Pat is on hold, and every read says so with one wording, naming the campaign; Skip is offered.
const UNSETTLED = "the first text from campaign Spring clinics to the same mobile, on every number this campaign can use, isn’t known to have gone or not yet";

test("a lead held while another campaign's first text to the same mobile is unknown: Today names the lead and the campaign and opens the record", async ({ page }) => {
  const f = await fakeUnsettledConversationApp();
  await page.clock.setFixedTime(f.harness.clock);
  await page.goto(`${f.url}/`);
  const title = page.getByText("Pat Oneil is on hold in Autumn clinics");
  await expect(title).toBeVisible();
  await expect(page.getByText(`On hold because ${UNSETTLED}. Nothing is dropped.`)).toBeVisible();
  await shot(page, "04-today-on-hold-unsettled", title);
  await page.getByRole("link", { name: /Open .*Pat Oneil|Open record/ }).first().click();
  await expect(page.getByRole("heading", { name: "Pat Oneil" })).toBeVisible();
});

test("the person record says the Autumn clinics text is on hold because of Spring clinics' unknown first text, and offers Skip", async ({ page }) => {
  const f = await fakeUnsettledConversationApp();
  await page.clock.setFixedTime(f.harness.clock);
  await page.goto(`${f.url}/leads/people/${f.person("Pat Oneil")}`);
  await expect(page.getByRole("heading", { name: "Pat Oneil" })).toBeVisible();
  const sentence = page.getByText(`Nothing has gone out yet. Next: text 1 of 2, on hold because ${UNSETTLED}.`, { exact: true });
  await expect(sentence).toBeVisible();
  await expect(page.getByRole("button", { name: /Skip/ }).first()).toBeVisible();
  await shot(page, "05-record-on-hold-unsettled", sentence);
});
