import { expect, test, type Locator, type Page } from "@playwright/test";
import { callbackWithNoGoodNumber, callOf, carriedAndOverdue, freshCalls, openCalls } from "./screens.ts";

/**
 * Redials, callbacks, rolled-over and overdue calls (ticket 15, part b), on the app over the fake email
 * provider with a phone track beside an email track and an email after the call, defined over HTTP.
 * The page says what the engine does from the server's reads and answers; nothing is dialled. All data
 * is fictitious. EVIDENCE_DIR=<dir> also writes each state's screenshot, light and dark, for the pull request.
 */

test.use({ timezoneId: "Europe/London" });

const outcome = (page: Page, name: string) => page.getByRole("group", { name: "Call outcome" }).getByRole("button", { name, exact: true });
const outcomeStatus = (page: Page) => page.locator("p[role='status']");
const logButton = (page: Page) => page.getByRole("button", { name: "Log and open next call" });
const dayField = (page: Page) => page.getByLabel("Day", { exact: true });
const timeField = (page: Page) => page.getByLabel("Their time", { exact: true });

/** Screenshots of the page as it is, in both themes, when EVIDENCE_DIR is set. */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env["EVIDENCE_DIR"];
  if (!dir) return;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // The theme's colour transitions settle before the capture; the viewport is what the user sees (the log bar is sticky).
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: null });
}

/** When recording the demonstration, holds each step on screen long enough to read. */
const linger = async (page: Page) => {
  if (process.env["RECORD_DEMO"]) await page.waitForTimeout(2_500);
};

/** Moves the app's clock and the browser's together. */
async function at(page: Page, f: Awaited<ReturnType<typeof freshCalls>>, iso: string): Promise<void> {
  await f.harness.advanceTo(Date.parse(iso));
  await page.clock.setSystemTime(f.harness.clock);
}

/** Presses Tab until `target` has focus; fails after `max` presses. */
async function tabTo(page: Page, target: Locator, max = 30): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

test("a redial: the page says where the call goes and when its skip limit still ends it; the next day it is a redial on its last day; then it is skipped and the email after it starts", async ({ page }) => {
  const f = await freshCalls("ready", "redial");
  await page.clock.install({ time: f.harness.clock });
  await page.goto(`${f.url}/calls`);
  await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  await outcome(page, "No answer").click();
  await expect(page.getByText("Without a redial, this call is done: the phone track finishes, and nothing calls them again unless you ask.")).toBeVisible();
  await page.getByRole("checkbox", { name: /Call again tomorrow/ }).check();
  await expect(page.getByText("The call moves to the list for Tue 10 Nov, and the phone track stays open, so the tracks after it keep waiting. The skip limit still counts from Mon 9 Nov, its original due date: if it isn’t worked, it is skipped at the end of Tue 10 Nov.")).toBeVisible();
  await shot(page, "calls-redial-chosen");
  await logButton(page).click();
  await expect(outcomeStatus(page)).toHaveText("Amira Hassan: no answer logged, with a redial. The call is on the list for Tue 10 Nov, and the phone track stays open. If it isn’t worked, it is skipped at the end of Tue 10 Nov.");
  await shot(page, "calls-redial-logged");

  await at(page, f, "2026-11-10T10:00:00Z");
  await page.goto(f.url);
  const upNext = page.getByRole("region", { name: "Up next" });
  await expect(upNext.getByRole("listitem").filter({ hasText: "Amira Hassan" })).toContainText("Redial, due Mon 9 Nov, last day before it’s skipped");
  await expect(upNext.getByRole("listitem").filter({ hasText: "Grace Okafor" })).toContainText("Rolled over, due Mon 9 Nov, last day before it’s skipped");
  await page.goto(`${f.url}/leads/people/${f.person("Amira Hassan")}`);
  await expect(page.getByText("Their call is back on today’s list: you asked for a redial. It was due Mon 9 Nov; if it isn’t worked, it is skipped at the end of Tue 10 Nov.")).toBeVisible();
  await expect(page.getByText(/Redial asked for: back on the next day’s list/)).toBeVisible();

  // Wednesday: not worked on Tuesday, so it was skipped at midnight, and the email after the call started.
  await at(page, f, "2026-11-11T11:00:00Z");
  await page.reload();
  await expect(page.getByText("Phone track skipped, not called")).toBeVisible();
  await expect(page.getByText("Not called within 2 days of its due date, Mon 9 Nov, so the call was skipped. The tracks after it started.")).toBeVisible();
  await expect(page.getByText("It starts after the phone track, which was skipped: its call wasn’t made within its skip limit.")).toBeVisible();
  await expect(page.getByText(/Their call/)).toHaveCount(0);
  await shot(page, "record-skipped-unworked");
});

test("a callback: entered in their time, said back in both, judged before Log as the engine judges it, then held, later today, overdue, and released by its outcome", async ({ page }) => {
  const f = await freshCalls("ready", "callback");
  await page.clock.install({ time: f.harness.clock });
  await page.goto(`${f.url}/calls`);
  await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  await outcome(page, "Callback requested").click();
  await expect(dayField(page)).toHaveValue("2026-11-09");
  await expect(page.getByText("In London time (Europe/London)")).toBeVisible();
  await expect(page.getByText("Enter the day and time they asked for, in their time.")).toBeVisible();
  await expect(logButton(page)).toBeDisabled();
  // A time already passed: refused in place, as the engine refuses it.
  await timeField(page).fill("09:30");
  await expect(page.getByText("That time has passed. Choose a time still to come; a callback in the past isn’t accepted.")).toBeVisible();
  await expect(logButton(page)).toBeDisabled();
  await shot(page, "calls-callback-past");
  // Outside the calling hours, and on a day they never open: accepted, and the page says so.
  await timeField(page).fill("18:30");
  await expect(page.getByText("Callback on Mon 9 Nov at 18:30 their time, the same as yours. Outside their calling hours (Mon–Fri, 09:00–17:00), and still accepted: a callback is listed at the time they asked for.")).toBeVisible();
  await dayField(page).selectOption("2026-11-14");
  await expect(page.getByText(/Their calling hours never open on that day \(Mon–Fri, 09:00–17:00\), and it is still accepted/)).toBeVisible();
  await expect(logButton(page)).toBeEnabled();
  await dayField(page).selectOption("2026-11-09");
  await timeField(page).fill("15:30");
  await expect(page.getByText("Callback on Mon 9 Nov at 15:30 their time, the same as yours. Inside their calling hours.")).toBeVisible();
  await expect(page.getByText("Amira Hassan’s automated outreach in Clinics, London is held from now until you log how the callback went. The call stays open: it is never skipped, and nothing resumes by itself.")).toBeVisible();
  await page.getByLabel("Notes from this call").fill("Asked for a call after clinic.");
  await shot(page, "calls-callback-entered");
  await logButton(page).click();
  await expect(outcomeStatus(page)).toHaveText(
    "Amira Hassan: callback requested for Mon 9 Nov at 15:30 their time, the same as yours. Their automated outreach in Clinics, London is held until you log how the callback went. The note is saved on Amira Hassan.",
  );
  const queue = page.getByRole("complementary", { name: "Call queue" });
  await expect(queue.getByRole("listitem").filter({ hasText: "Amira Hassan" })).toContainText("Callback they asked for at 15:30 their time");
  await page.goto(`${f.url}/leads/people/${f.person("Amira Hassan")}`);
  await expect(page.getByText("Callback scheduled")).toBeVisible();
  await expect(page.getByText("Callback Mon 9 Nov at 15:30 their time. Their automated outreach in this campaign is held until you log how it went.")).toBeVisible();
  await expect(page.getByText(/Call back Mon 9 Nov at 15:30 their time; automated outreach in this campaign is held until its outcome is logged/)).toBeVisible();

  // Missed: overdue from the time asked for, on Today's Needs attention and first on the list, until an outcome.
  await at(page, f, "2026-11-09T15:45:00Z");
  await page.goto(f.url);
  const attention = page.getByRole("region", { name: "Needs attention" });
  await expect(attention.getByText("Amira Hassan’s callback is overdue")).toBeVisible();
  await expect(attention).toContainText("It stays on your call list, flagged overdue, and automated outreach to them stays held until you log what happened.");
  await expect(page.getByRole("region", { name: "Up next" }).getByRole("listitem").first()).toContainText("Callback overdue since today at 15:30 their time");
  await shot(page, "today-overdue-callback");
  await attention.getByRole("link", { name: "Open Calls" }).click();
  // The page is still on Tom's call (the focus holds while it is listed); once it is worked, the overdue callback is first.
  await expect(page.getByRole("heading", { name: "Tom" })).toBeVisible();
  await outcome(page, "Skip for now").click();
  await logButton(page).click();
  await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  await outcome(page, "Left voicemail").click();
  await expect(page.getByText("Logging this ends the callback’s hold on their automated outreach in this campaign.")).toBeVisible();
  await logButton(page).click();
  await expect(outcomeStatus(page)).toContainText("Amira Hassan: left voicemail logged. The phone track is finished.");
  await page.goto(`${f.url}/leads/people/${f.person("Amira Hassan")}`);
  await expect(page.getByText(/The callback they asked for, Mon 9 Nov at 15:30 their time; its hold on automated outreach ended/)).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: /^Callback overdue/ })).toHaveCount(0);
});

test("the callback loop by keyboard alone: choose the outcome, the day and their time, log, and focus lands on the next call's number", async ({ page }) => {
  const f = await freshCalls("ready", "callback-keyboard");
  await page.clock.install({ time: f.harness.clock });
  await page.goto(`${f.url}/calls`);
  await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  await tabTo(page, outcome(page, "Callback requested"));
  await page.keyboard.press("Enter");
  await expect(outcome(page, "Callback requested")).toHaveAttribute("aria-pressed", "true");
  await tabTo(page, dayField(page));
  // Typeahead on the closed select picks the day by its label.
  await page.keyboard.type("Tom");
  await expect(dayField(page)).toHaveValue("2026-11-10");
  await page.keyboard.press("Tab");
  await expect(timeField(page)).toBeFocused();
  await page.keyboard.type("1430");
  await expect(timeField(page)).toHaveValue("14:30");
  await expect(page.getByText("Callback on Tue 10 Nov at 14:30 their time, the same as yours. Inside their calling hours.")).toBeVisible();
  await tabTo(page, logButton(page));
  await page.keyboard.press("Enter");
  await expect(outcomeStatus(page)).toContainText("Amira Hassan: callback requested for Tue 10 Nov at 14:30 their time");
  await expect(page.getByRole("heading", { name: "Tom" })).toBeVisible();
  await expect(page.getByRole("radio", { checked: true })).toBeFocused();
});

test("a redial by keyboard: the check is a real control, and Space sets it", async ({ page }) => {
  const f = await freshCalls("ready", "redial-keyboard");
  await page.clock.install({ time: f.harness.clock });
  await page.goto(`${f.url}/calls`);
  await tabTo(page, outcome(page, "Left voicemail"));
  await page.keyboard.press("Space");
  const check = page.getByRole("checkbox", { name: /Call again tomorrow/ });
  await tabTo(page, check);
  await page.keyboard.press("Space");
  await expect(check).toBeChecked();
  await tabTo(page, logButton(page));
  await page.keyboard.press("Enter");
  await expect(outcomeStatus(page)).toContainText("Amira Hassan: left voicemail logged, with a redial.");
});

test("Today and Calls show an overdue callback first, then calls carried from the day before with their original due date", async ({ page }) => {
  const f = await carriedAndOverdue("carried");
  await openCalls(page, f, "/");
  const rows = page.getByRole("region", { name: "Up next" }).getByRole("listitem");
  await expect(rows.nth(0)).toContainText("Tom");
  await expect(rows.nth(0)).toContainText("Callback overdue since today at 11:00 their time");
  await expect(rows.nth(1)).toContainText("Amira Hassan");
  await expect(rows.nth(1)).toContainText("Redial, due Mon 9 Nov, last day before it’s skipped");
  await expect(rows.nth(2)).toContainText("Rolled over, due Mon 9 Nov, last day before it’s skipped");
  await expect(page.getByRole("region", { name: "Needs attention" })).toContainText("Tom asked for Tue 10 Nov at 11:00 their time, the same as yours.");
  await shot(page, "today-carried-and-overdue");
  await openCalls(page, f);
  const queue = page.getByRole("complementary", { name: "Call queue" });
  await expect(queue.getByRole("listitem").nth(0)).toContainText("Callback overdue since today at 11:00 their time");
  await expect(page.getByRole("heading", { name: "Tom" })).toBeVisible();
  await shot(page, "calls-overdue-callback");
  await page.goto(`${f.url}/leads/people/${f.person("Tom")}`);
  await expect(page.getByText("Callback Tue 10 Nov at 11:00 their time, now overdue. It stays on your call list until you log what happened, and their automated outreach in this campaign stays held until then.")).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: /^Callback overdue/ })).toContainText("They asked for Tue 10 Nov at 11:00 their time.");
  await shot(page, "record-overdue-callback");
});

test("a callback whose lead has no good number left is shown for what it is: held, listed, overdue, and what the user can do today (Q13)", async ({ page }) => {
  const f = await callbackWithNoGoodNumber("q13");
  await openCalls(page, f);
  await expect(page.getByRole("heading", { name: "Tom" })).toBeVisible();
  await expect(page.getByText(/Every number for Tom is marked wrong, so nothing but skip for now can be logged on this callback\./)).toBeVisible();
  await expect(page.getByText(/until a new number arrives by import or they reply\. Pausing them or skipping the step arrives with a later release\./)).toBeVisible();
  await outcome(page, "No answer").click();
  await expect(logButton(page)).toBeDisabled();
  await outcome(page, "Skip for now").click();
  await expect(page.getByText("The callback goes to the end of today’s list and stays open; their outreach stays held.")).toBeVisible();
  await expect(logButton(page)).toBeEnabled();
  await shot(page, "calls-callback-no-good-number");
  await openCalls(page, f, "/");
  await expect(page.getByRole("region", { name: "Needs attention" })).toContainText("Every number for Tom is marked wrong, so nothing can be logged on that callback until a new number arrives by import or they reply.");
  await page.goto(`${f.url}/leads/people/${f.person("Tom")}`);
  await expect(page.getByText(/Every number is marked wrong, so nothing can be logged on it until a new number arrives by import or they reply\./)).toBeVisible();
});

test("a callback refused because its call expired meanwhile is kept with its time and note until dismissed", async ({ page }) => {
  const f = await freshCalls("ready", "callback-expired");
  const amira = await callOf(f, "Amira Hassan");
  // What a closed tab left on Monday: a callback press for Amira that never reached the server.
  await page.addInitScript(([taskId, numberId]) => {
    const body = { requestId: "callback-left-on-monday", outcome: "callback_requested", numberId, note: "Call Thursday after 11.", noteScope: "person", callbackAt: "2026-11-12T11:00:00+00:00" };
    window.localStorage.setItem("outreach.calls.outbox.callback-left-on-monday", JSON.stringify({ v: 2, taskId, who: "Amira Hassan", body, pressedAt: 1 }));
  }, [amira.taskId, amira.number("mobile")] as const);
  // Wednesday: Amira's call was skipped unworked at the end of Tuesday.
  await f.harness.advanceTo(Date.parse("2026-11-11T10:00:00Z"));
  await page.clock.setFixedTime(f.harness.clock);
  await page.goto(`${f.url}/calls`);
  await expect(page.getByText(/^Not logged: callback requested for Thu 12 Nov at 11:00 your time for Amira Hassan\. This call was skipped at /)).toBeVisible();
  await expect(page.getByText("The note typed with it:")).toBeVisible();
  await shot(page, "calls-callback-refused");
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByText(/^Not logged:/)).toHaveCount(0);
});

/**
 * The ticket's demonstration (recorded with RECORD_DEMO=1): a redial aging from its original due date, an
 * unworked call expiring and releasing the email after it, the parallel email track carrying on, and an
 * overdue callback holding a lead's automated outreach.
 */
test("demonstration: a redial ages from its original due date, an unworked call expires and releases the email after it, parallel sends continue, and an overdue callback holds outreach", async ({ page }) => {
  const f = await freshCalls("ready", "demonstration-15b");
  await page.clock.install({ time: f.harness.clock });
  await test.step("Monday: Amira, no answer, call again tomorrow", async () => {
    await page.goto(`${f.url}/calls`);
    await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
    await outcome(page, "No answer").click();
    await page.getByRole("checkbox", { name: /Call again tomorrow/ }).check();
    await linger(page);
    await logButton(page).click();
    await expect(outcomeStatus(page)).toContainText("with a redial");
    await linger(page);
  });
  await test.step("Monday: Tom asks to be called back on Tuesday at 11:00 his time", async () => {
    await expect(page.getByRole("heading", { name: "Tom" })).toBeVisible();
    await outcome(page, "Callback requested").click();
    await dayField(page).selectOption("2026-11-10");
    await timeField(page).fill("11:00");
    await linger(page);
    await logButton(page).click();
    await expect(outcomeStatus(page)).toContainText("is held until you log how the callback went");
    await linger(page);
  });
  await test.step("Tuesday 11:30: Tom's callback is overdue; Amira's redial and Grace's unworked call are on their last day", async () => {
    await at(page, f, "2026-11-10T11:30:00Z");
    await page.goto(f.url);
    await expect(page.getByText("Tom’s callback is overdue")).toBeVisible();
    await expect(page.getByText("Redial, due Mon 9 Nov, last day before it’s skipped")).toBeVisible();
    await linger(page);
  });
  await test.step("Wednesday: Amira's call was skipped unworked at midnight and the email after it went; her first email track carried on", async () => {
    await at(page, f, "2026-11-11T11:00:00Z");
    await page.goto(`${f.url}/leads/people/${f.person("Amira Hassan")}`);
    await expect(page.getByText("Phone track skipped, not called")).toBeVisible();
    await expect(page.getByText("Email track 2 started")).toBeVisible();
    await expect(page.getByText("Email 2 sent")).toBeVisible();
    await linger(page);
  });
  await test.step("Wednesday: Tom's callback is still overdue, and nothing more went to him while it holds his outreach", async () => {
    await page.goto(`${f.url}/leads/people/${f.person("Tom")}`);
    await expect(page.getByText(/Callback Tue 10 Nov at 11:00 their time, now overdue/)).toBeVisible();
    await expect(page.getByText("Email 1 sent")).toBeVisible();
    await expect(page.getByText("Email 2 sent")).toHaveCount(0);
    await linger(page);
  });
});
