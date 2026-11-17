import { expect, test, type Page } from "@playwright/test";
import { fakeLinkedinApp, PROFILES, TEST_PROFILE, type FakeLinkedinApp } from "./fake-linkedin.ts";

/**
 * Ticket 24b's demonstration (recorded with RECORD_DEMO=1; screenshots with EVIDENCE_DIR), on the **simulated** LinkedIn
 * provider with fictitious people and profiles: a LinkedIn track built on the canvas, a test run to the user's own test
 * profile accepted by hand, a launch on the simulated session, an acceptance, a reply the user marks, and the measures.
 * No LinkedIn session is connected: the session is labelled "Simulated LinkedIn (not a session)" wherever it is named.
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;

const linger = async (page: Page) => {
  if (process.env["RECORD_DEMO"]) await page.waitForTimeout(2_000);
};

async function at(page: Page, f: FakeLinkedinApp, path: string): Promise<void> {
  await page.clock.setFixedTime(f.h.clock);
  await page.goto(f.url + path);
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env["EVIDENCE_DIR"];
  if (!dir) return;
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    await page.screenshot({ path: `${dir}/linkedin-${name}-${theme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: null });
}

test("a LinkedIn track from the canvas through a test run, a launch, an acceptance, a marked reply and the measures", async ({ page }) => {
  test.setTimeout(180_000);
  const f = await fakeLinkedinApp("fresh", "linkedin-demonstration");
  const campaign = `/campaigns/${f.campaign}`;

  await test.step("the canvas: a LinkedIn track, its invite with a note and its first message, by role", async () => {
    await at(page, f, campaign);
    await page.getByRole("button", { name: "LinkedIn track" }).click();
    // Focus goes to the invite's note; an empty note is a plain invite and blocks nothing.
    await expect(page.getByLabel("Connection invite note")).toBeFocused();
    await page.getByLabel("Connection invite note").fill("Hi {{first_name|there}}, I work with physio clinics like {{company}}.");
    await expect(page.getByText("The connection invite stays first and can’t be removed while this track has messages.")).toBeVisible();
    await page.getByRole("button", { name: /^First message/ }).click();
    await page.getByLabel("First message message").fill("Thanks for connecting, {{first_name|there}}. Worth a short call about evening bookings?");
    await expect(page.getByLabel("Days to wait for the invite to be accepted")).toHaveValue("14");
    await page.getByLabel("Days to wait for the invite to be accepted").fill("3");
    await expect(page.getByText(/^Simulated LinkedIn \(not a session\)/).first()).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Saved" }).first()).toBeVisible();
    await shot(page, "01-canvas");
    await linger(page);
  });

  await test.step("the test run: the user's own test profile; the invite waits for them to accept it by hand, with the day the wait ends", async () => {
    await page.getByRole("link", { name: "Test run" }).click();
    await page.getByLabel("Your LinkedIn profile, for the invite and messages").fill(TEST_PROFILE);
    await page.getByRole("button", { name: "Save contacts" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await page.getByLabel("Copy written for").selectOption({ label: "Pat Oneil" });
    await page.getByRole("button", { name: "Run test" }).click();
    await expect(page.getByRole("button", { name: "Test running" })).toBeVisible();
    // Monday 09:05: the window has opened and the invite went; the wait is not cut short (Q40).
    await f.h.advanceTo(Date.parse("2026-11-02T09:05:00Z"));
    await at(page, f, `${campaign}/test-run`);
    await expect(page.getByText("Waiting for you to accept the invite on your test profile; the wait ends Thu 5 Nov")).toBeVisible();
    expect(f.h.linkedin.deliveryLog.map((d) => [d.action, d.destination])).toEqual([["invite", TEST_PROFILE]]);
    await shot(page, "02-test-waiting-for-acceptance");
    await linger(page);
    // The user accepts the invite on their own test profile; the first message follows about a minute later.
    expect(f.h.linkedin.acceptNow(TEST_PROFILE)).toBe(true);
    await f.h.advanceTo(f.h.clock + 20 * MIN);
    await at(page, f, `${campaign}/test-run`);
    await expect(page.getByText(/^Sent /)).toHaveCount(2);
    await page.getByRole("button", { name: "Mark replied on LinkedIn" }).click();
    await page.getByRole("group").getByRole("button", { name: "Mark replied" }).click();
    await expect(page.getByText("Stopped by your reply")).toBeVisible();
    await shot(page, "03-test-marked-replied");
    await linger(page);
  });

  await test.step("the launch, on the simulated session", async () => {
    await page.getByRole("link", { name: "Launch…" }).click();
    await expect(page.getByText("Ready to launch.")).toBeVisible();
    await expect(page.getByText("have a LinkedIn profile")).toBeVisible();
    await shot(page, "04-before-launch");
    // Pat will accept three hours after the invite reaches them (the simulated provider's script).
    f.h.linkedin.profiles.set(PROFILES.pat, { acceptAfterMs: 3 * H });
    await page.getByRole("button", { name: "Launch campaign" }).click();
    await expect(page.getByText(/^Launched .*\.$/)).toBeVisible();
    await linger(page);
  });

  await test.step("Pat accepts: the first message goes, and the record says when they accepted", async () => {
    await f.h.advanceTo(f.h.clock + DAY);
    expect(f.h.linkedin.deliveryLog.filter((d) => d.destination === PROFILES.pat).map((d) => d.action)).toEqual(["invite", "message"]);
    await at(page, f, `/leads/people/${await f.person("Pat Oneil")}`);
    await expect(page.getByText(/^They accepted the invite on Mon 2 Nov\.$/)).toBeVisible();
    await expect(page.getByText("First message sent")).toBeVisible();
    await linger(page);
  });

  await test.step("Pat answers on LinkedIn: the user marks the reply, confirmed, and the lead is handed over on LinkedIn", async () => {
    await page.getByRole("button", { name: "Mark replied on LinkedIn: Pat Oneil in" }).click();
    await expect(page.getByText(/^Mark them replied on LinkedIn\?/)).toBeVisible();
    await shot(page, "05-mark-replied-confirmation");
    await page.getByRole("group").getByRole("button", { name: "Mark replied on LinkedIn" }).click();
    await expect(page.getByText("Marked replied on LinkedIn. Carry on the conversation on LinkedIn.")).toBeVisible();
    await expect(page.getByText(/^Marked replied on LinkedIn by you on .*Carry on the conversation on LinkedIn\.$/)).toBeVisible();
    await expect(page.getByText("You marked them replied on LinkedIn")).toBeVisible();
    await shot(page, "06-record-replied");
    await linger(page);
  });

  await test.step("the measures: invites sent and accepted, messages sent, the reply marked, test-run facts counted as test", async () => {
    await at(page, f, campaign);
    const row = page.getByRole("region", { name: "Outreach so far" }).locator("dt", { hasText: /^LinkedIn$/ }).locator("xpath=following-sibling::dd[1]");
    await expect(row).toContainText("(1 from test runs)");
    await expect(row).toContainText("2 accepted (1 from test runs)");
    await expect(row).toContainText("2 marked replied (1 from test runs)");
    await expect(row).toContainText("marked replied");
    await shot(page, "07-measures");
    await linger(page);
  });
});
