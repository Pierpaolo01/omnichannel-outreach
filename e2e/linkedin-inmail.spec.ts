import { expect, test, type Page } from "@playwright/test";
import { fakeLinkedinApp, LI_MONDAY_8, type FakeLinkedinApp } from "./fake-linkedin.ts";

/**
 * Ticket 27's demonstration (recorded with RECORD_DEMO=1; screenshots with EVIDENCE_DIR), on the **simulated** LinkedIn
 * provider: no LinkedIn session is connected, and the session here only scripts what a Premium session would report of
 * itself (three InMail credits). The InMail fallback from the inspector, through Before launch and the Test run tab, a
 * launch, the wait's end, the InMail, a refused InMail, a follow-up after the InMail, and the measures. Fictitious data only.
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
    // A cancelled animation rejects its `finished` promise: wait for each to settle, either way (council on 8b0c846, item 12).
    await page.evaluate(() => Promise.allSettled(document.getAnimations().map((a) => a.finished)));
    await page.screenshot({ path: `${dir}/inmail-${name}-${theme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: null });
}

test("the InMail fallback in the inspector, Before launch and the Test run tab: switched off and on, its text, and what each says", async ({ page }) => {
  const f = await fakeLinkedinApp("inmail-ready", "inmail-editor");
  await at(page, f, `/campaigns/${f.campaign}?track=li`);
  const fallback = page.getByRole("checkbox", { name: "Send an InMail if they don’t accept in time" });
  await expect(fallback).toBeChecked();
  await expect(page.getByLabel("InMail", { exact: true })).toHaveValue(/we haven’t connected/);
  // The steps keep their names: the InMail is not among them.
  await expect(page.getByRole("button", { name: /^First message/ })).toBeVisible();
  await expect(page.getByText(/^When the wait ends, one InMail goes from the session that sent the invite/)).toBeVisible();
  await expect(page.getByText("Invite, then 2 messages, InMail if not accepted").first()).toBeVisible();
  await fallback.scrollIntoViewIfNeeded();
  await shot(page, "01-inspector-on");

  // An empty InMail blocks launch as empty copy.
  await page.getByLabel("InMail", { exact: true }).fill("");
  await expect(page.getByRole("status").filter({ hasText: "Saved" }).first()).toBeVisible();
  await page.getByRole("link", { name: "Before launch" }).click();
  await expect(page.getByText("The LinkedIn track: InMail has no message")).toBeVisible();
  await expect(page.getByText("Write it, or switch the InMail fallback off.")).toBeVisible();
  await shot(page, "02-before-launch-empty-inmail");

  // Switched off: the InMail and its field go, the wait's line says the invite is withdrawn.
  await at(page, f, `/campaigns/${f.campaign}?track=li`);
  await fallback.uncheck();
  await expect(page.getByLabel("InMail", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Off: when the wait ends, this track ends for them and the app asks LinkedIn to withdraw the invite.")).toBeVisible();
  await expect(page.getByText(/invite is withdrawn/)).toHaveCount(0);
  await expect(page.getByText("Invite, then 2 messages").first()).toBeVisible();
  await fallback.scrollIntoViewIfNeeded();
  await shot(page, "03-inspector-off");

  // On again, with text: Copy for a lead shows the InMail and when it goes.
  await fallback.check();
  await page.getByLabel("InMail", { exact: true }).fill("Hi {{first_name|there}}, a short note about evening bookings at {{company}}.");
  await expect(page.getByRole("status").filter({ hasText: "Saved" }).first()).toBeVisible();
  await page.getByRole("link", { name: "Before launch" }).click();
  await expect(page.getByText(/^Hi \w+, a short note about evening bookings at Harbour Lane Physio\.$/).first()).toBeVisible();
  await expect(page.getByText(/^Sent only if they haven’t accepted when the wait ends/).first()).toBeVisible();
  await shot(page, "04-copy-for-a-lead");

  await page.getByRole("link", { name: "Test run" }).click();
  await expect(page.getByText(/With the InMail fallback on, the test reaches the InMail only if you leave the test invite unaccepted for the whole wait/)).toBeVisible();
  await shot(page, "05-test-run-tab");
});

test("a launched track with the fallback on: the wait, its end, the InMail, a refused InMail, a follow-up after it, and the measures", async ({ page }) => {
  test.setTimeout(180_000);
  const f = await fakeLinkedinApp("inmail", "inmail-running");
  const nia = await f.person("Nia Cole");
  const ola = await f.person("Ola Berg");

  await test.step("Wednesday: Nia waits for acceptance, and the record says what the end of the wait does", async () => {
    await at(page, f, `/leads/people/${nia}`);
    await expect(page.getByText("If they haven’t accepted by the end of the wait, an InMail goes instead, if your session can send one then.")).toBeVisible();
    await shot(page, "06-record-waiting");
    await linger(page);
  });

  await test.step("Friday: the wait ended; Nia's InMail went and the invite stays open; Ola's was refused and her invite is to be withdrawn", async () => {
    await f.h.advanceTo(LI_MONDAY_8 + 4 * DAY + 4 * H);
    await at(page, f, `/leads/people/${nia}`);
    await expect(page.getByText(/^No acceptance was recorded within the track’s wait, so the InMail went instead on Thu 5 Nov, from Simulated LinkedIn \(not a session\) li-session-1\./)).toBeVisible();
    await expect(page.getByText("The connection invite sent from this campaign is still open on LinkedIn.", { exact: false })).toHaveCount(0);
    await shot(page, "07-record-inmail-sent");
    await linger(page);
    await at(page, f, `/leads/people/${ola}`);
    await expect(page.getByText("The InMail fallback didn’t go: LinkedIn refused the InMail for this person. Their profile isn’t marked wrong.")).toBeVisible();
    await shot(page, "08-record-inmail-refused");
    await linger(page);
  });

  await test.step("the next Tuesday: Nia's follow-up went two days after the InMail, at the window's opening; the first message never went", async () => {
    await f.h.advanceTo(LI_MONDAY_8 + 8 * DAY + 4 * H);
    const sent = f.h.linkedin.deliveryLog.filter((d) => d.destination.endsWith("fictional-nia-cole")).map((d) => d.stepId);
    expect(sent).toEqual(["li-invite", "li-inmail", "li-m2"]);
    await at(page, f, `/leads/people/${nia}`);
    await expect(page.getByText(/InMail sent/).first()).toBeVisible();
    await shot(page, "09-record-follow-up");
    await linger(page);
  });

  await test.step("the measures: InMails sent beside invites and messages", async () => {
    await at(page, f, `/campaigns/${f.campaign}`);
    const row = page.getByRole("region", { name: "Outreach so far" }).locator("dt", { hasText: /^LinkedIn$/ }).locator("xpath=following-sibling::dd[1]");
    await expect(row).toContainText(/\d+ InMails? sent/);
    await shot(page, "10-measures");
    await linger(page);
  });
});

test("on a running campaign, switching the fallback on says which leads it may reach, as a condition, and names the step InMail", async ({ page }) => {
  // The council on d6ad9f5, item 5: leads still waiting for acceptance are ones the InMail may reach; never zero, never a promise.
  const f = await fakeLinkedinApp("launched", "inmail-running-edit");
  await at(page, f, `/campaigns/${f.campaign}?track=li`);
  await page.getByRole("checkbox", { name: "Send an InMail if they don’t accept in time" }).check();
  await page.getByLabel("InMail", { exact: true }).fill("Hi {{first_name|there}}, a short note about {{company}}.");
  const panel = page.getByTestId("running-changes");
  await expect(panel.getByText("LinkedIn track · InMail")).toBeVisible();
  await expect(panel.getByText(/^\d+ leads? still waiting for acceptance will get the InMail if the invite is not accepted in time and your session can send one then/)).toBeVisible();
  await expect(panel.getByText(/LinkedIn track · First message/)).toHaveCount(0);
  await shot(page, "11-running-edit-switched-on");
});
