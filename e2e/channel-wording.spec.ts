import { expect, test, type Locator, type Page } from "@playwright/test";
import { fakeProviderApp } from "./fake-provider.ts";

/**
 * Standing check (ticket 13b, verifier F1): a screen about one channel's track never names the other
 * channel where it means its own. The words come from the track's channel, never from a default. A
 * select's options name other tracks on purpose ("After the email track"), so they are left out; text
 * and accessible names (aria-label) are both read.
 */
async function wordsOf(scope: Locator): Promise<string> {
  return scope.evaluate((root) => {
    const clone = root.cloneNode(true) as HTMLElement;
    for (const el of clone.querySelectorAll("select, option")) el.remove();
    const labels = [...clone.querySelectorAll("[aria-label]")].map((el) => el.getAttribute("aria-label") ?? "");
    return `${clone.textContent} ${labels.join(" ")}`;
  });
}

const EMAIL_WORDS = /\bemails?\b/i;
const SMS_WORDS = /\b(sms|texts?)\b/i;

async function openAll(page: Page) {
  // Every message open, so its fields and fallbacks are read too.
  for (const toggle of await page.locator("button[id^='step-toggle-'][aria-expanded='false']").all()) await toggle.click();
}

test("an SMS track's inspector says text, never email, for its own messages", async ({ page }) => {
  const f = await fakeProviderApp();
  await page.goto(`${f.url}/campaigns/${f.twoChannelsReady}?track=sms&step=m1`);
  await page.getByLabel("Text 1 message").waitFor();
  await openAll(page);
  const words = await wordsOf(page.getByTestId("inspector"));
  expect(words).toContain("Merge fields in this text");
  expect(words.match(EMAIL_WORDS)).toBeNull();
});

test("an email track's inspector says email, never text or SMS, for its own messages", async ({ page }) => {
  const f = await fakeProviderApp();
  await page.goto(`${f.url}/campaigns/${f.twoChannelsReady}?track=email&step=s1`);
  await page.getByLabel("Email 1 subject").waitFor();
  await openAll(page);
  const words = await wordsOf(page.getByTestId("inspector"));
  expect(words).toContain("Merge fields in this email");
  expect(words.match(SMS_WORDS)).toBeNull();
});

test("each message in the copy for a lead names only its own channel", async ({ page }) => {
  const f = await fakeProviderApp();
  await page.goto(`${f.url}/campaigns/${f.twoChannelsReady}/before-launch`);
  for (const lead of ["Nadia Wells", "Ravi Patel", "Hugo Grant"]) {
    await page.getByLabel("Preview as lead").selectOption({ label: lead });
    const cards = page.getByRole("list", { name: "The messages, in the order they can go" }).getByRole("listitem");
    await expect(cards.first()).toBeVisible();
    for (const card of await cards.all()) {
      const words = await wordsOf(card);
      if (/^\s*Text \d/.test(words)) expect(words.match(EMAIL_WORDS), `${lead}: ${words}`).toBeNull();
      else expect(words.replace(/^\s*Email \d+ · Email track \d/, "").match(SMS_WORDS), `${lead}: ${words}`).toBeNull();
    }
  }
});
