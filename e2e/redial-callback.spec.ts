import { expect, test, type Locator, type Page } from "@playwright/test";
import type { CallQueueItem, CallTaskView } from "../src/shared/api.ts";
import { respond } from "./mocks.ts";
import { SCREENS, callbackWithNoGoodNumber, callOf, carriedAndOverdue, carriedOnly, freshCalls, galleryRecord, openCalls, seedData } from "./screens.ts";

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
async function shot(page: Page, name: string, narrow = false): Promise<void> {
  const dir = process.env["EVIDENCE_DIR"];
  if (!dir) return;
  if (narrow) {
    const size = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel("Day", { exact: true }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/${name}-390.png` });
    if (size) await page.setViewportSize(size);
  }
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
  await expect(page.getByText(/Redial asked for: listed again from Tue 10 Nov/)).toBeVisible();

  // Wednesday: not worked on Tuesday, so it was skipped at midnight, and the email after the call started.
  await at(page, f, "2026-11-11T11:00:00Z");
  await page.reload();
  await expect(page.getByText("Phone track skipped, not called")).toBeVisible();
  await expect(page.getByText("Not called within 2 days of its due date, Mon 9 Nov, so the call was skipped. Email track 2 has finished.")).toBeVisible();
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
  await expect(page.getByText("Logging this holds Amira Hassan’s automated outreach in Clinics, London until you log how the callback went. The call then stays open: it is never skipped, and nothing resumes by itself.")).toBeVisible();
  await page.getByLabel("Notes from this call").fill("Asked for a call after clinic.");
  await shot(page, "calls-callback-entered", true);
  await logButton(page).click();
  await expect(outcomeStatus(page)).toHaveText(
    "Amira Hassan: callback requested for Mon 9 Nov at 15:30 their time, the same as yours. Their automated outreach in Clinics, London is held until you log how the callback went. The note is saved on Amira Hassan.",
  );
  const queue = page.getByRole("complementary", { name: "Call queue" });
  await expect(queue.getByRole("listitem").filter({ hasText: "Amira Hassan" })).toContainText("Callback they asked for at 15:30 their time");
  await page.goto(`${f.url}/leads/people/${f.person("Amira Hassan")}`);
  await expect(page.getByText("Callback scheduled")).toBeVisible();
  await expect(page.getByText("Callback Mon 9 Nov at 15:30 their time. Their automated outreach in this campaign is held until you log how it went.")).toBeVisible();
  await expect(page.getByText(/Callback asked for, Mon 9 Nov at 15:30 their time; their automated outreach in this campaign is held until you log how it went/)).toBeVisible();

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

test("a callback whose lead has no good number left is said the same way on the sheet, the queue, Today and the record, read at one instant: only skip for now can be logged, and it keeps the callback (Q13; verifier on eac9f6c, F4)", async ({ page }) => {
  const f = await callbackWithNoGoodNumber("q13");
  const full = "Every number for Tom is marked wrong, so only skip for now can be logged on this callback, and it keeps the callback open. It stays on the call list, flagged overdue once its time has passed, and their other outreach in this campaign stays held until a new number arrives by import or they reply. Pausing them or skipping the step arrives with a later release.";
  const short = "no good number left, only skip for now can be logged";
  // One instant for all four reads: the app's clock does not move during this test.
  await openCalls(page, f);
  await expect(page.getByRole("heading", { name: "Tom" })).toBeVisible();
  await expect(page.getByText(full)).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Call queue" }).getByRole("listitem").first()).toContainText(short);
  // Every outcome but skip for now is disabled, described by the Q13 sentence (council on 32454ea, F).
  for (const name of ["No answer", "Left voicemail", "Didn’t reach them", "Wrong number", "Callback requested", "Interested"]) {
    await expect(outcome(page, name)).toBeDisabled();
    await expect(outcome(page, name)).toHaveAccessibleDescription(full);
  }
  await outcome(page, "Skip for now").click();
  await expect(page.getByText("The callback goes to the end of today’s list and stays open; their outreach stays held.")).toBeVisible();
  await expect(logButton(page)).toBeEnabled();
  await shot(page, "calls-callback-no-good-number");
  await openCalls(page, f, "/");
  await expect(page.getByRole("region", { name: "Needs attention" })).toContainText(full);
  await expect(page.getByRole("region", { name: "Up next" }).getByRole("listitem").first()).toContainText(short);
  await page.goto(`${f.url}/leads/people/${f.person("Tom")}`);
  // The record says each fact once: the overdue sentence (critical), then only what Q13 adds.
  await expect(page.getByText("Every number is marked wrong, so only skip for now can be logged on this callback, and it keeps the callback open. That lasts until a new number arrives by import or they reply. Pausing them or skipping the step arrives with a later release.", { exact: false })).toBeVisible();
  await expect(page.getByText("flagged overdue once its time has passed", { exact: false })).toHaveCount(0);
  await expect(page.getByText("nothing can be logged", { exact: false })).toHaveCount(0);
  // Skip for now is accepted and keeps the callback open and held.
  await openCalls(page, f);
  await outcome(page, "Skip for now").click();
  await logButton(page).click();
  await expect(outcomeStatus(page)).toContainText("Tom skipped for now. The callback stays on today’s list, and their outreach stays held.");
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
    await expect(page.getByRole("listitem").filter({ hasText: /^Email track 2 started/ })).toBeVisible();
    await expect(page.getByText("Email 2 sent")).toBeVisible();
    await linger(page);
    await page.getByText("Phone track skipped, not called").scrollIntoViewIfNeeded();
    await linger(page);
  });
  await test.step("Wednesday: Tom's callback is still overdue, and nothing more went to him while it holds his outreach", async () => {
    await page.goto(`${f.url}/leads/people/${f.person("Tom")}`);
    await expect(page.getByText(/Callback Tue 10 Nov at 11:00 their time, now overdue/)).toBeVisible();
    await expect(page.getByText("Email 1 sent")).toBeVisible();
    await expect(page.getByText("Email 2 sent")).toHaveCount(0);
    await linger(page);
    await page.getByRole("listitem").filter({ hasText: /^Callback overdue/ }).scrollIntoViewIfNeeded();
    await linger(page);
  });
});

test("the record says each open call's state in its campaign row: rolled over, a callback, overdue with no good number, a redial for another day, and a call waiting on a callback", async ({ page }) => {
  const f = await freshCalls("ready", "record-gallery");
  const id = f.person("Amira Hassan");
  // The gallery fixture: a fictitious record with every call state on it.
  await page.route(`**/api/people/${id}`, (route) => respond(route, galleryRecord(id)));
  await page.goto(`${f.url}/leads/people/${id}`);
  await expect(page.getByText("Their call rolled over to today’s list. It was due Mon 9 Nov; if it isn’t worked, it is skipped at the end of Tue 10 Nov.")).toBeVisible();
  await expect(page.getByText("Callback Tue 10 Nov at 15:00 their time. Their automated outreach in this campaign is held until you log how it went.")).toBeVisible();
  await expect(page.getByText(/Callback Mon 9 Nov at 11:30 their time, now overdue\..*Every number is marked wrong/)).toBeVisible();
  await expect(page.getByText("Their call is on the list for Wed 11 Nov. It was due Mon 9 Nov; if it isn’t worked, it is skipped at the end of Wed 11 Nov.")).toBeVisible();
  await expect(page.getByText("Their call on the phone track 2 waits while their callback is open: only the callback is on the list.")).toBeVisible();
  await expect(page.getByText("Callback Thu 12 Nov at 10:00 their time. Their automated outreach in this campaign is held until you log how it went.")).toBeVisible();
  await page.getByRole("heading", { name: "Campaigns" }).scrollIntoViewIfNeeded();
  await page.getByText("Callbacks, overdue").scrollIntoViewIfNeeded();
  await shot(page, "record-call-states");
});

test.describe("a user in another zone than the prospect (review bot on eac9f6c, item 1)", () => {
  test.use({ timezoneId: "America/New_York" });

  test("the callback is said in their time and the user's, the same on the preview, the logged line, the queue, Today and the record", async ({ page }) => {
    const f = await freshCalls("ready", "callback-new-york");
    // The user works from New York; Amira is in London.
    expect((await f.harness.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "America/New_York" })).status).toBe(200);
    await page.clock.install({ time: f.harness.clock });
    await page.goto(`${f.url}/calls`);
    await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
    await outcome(page, "Callback requested").click();
    await timeField(page).fill("15:30");
    await expect(page.getByText("Callback on Mon 9 Nov at 15:30 their time, 10:30 your time. Inside their calling hours.")).toBeVisible();
    await logButton(page).click();
    await expect(outcomeStatus(page)).toHaveText("Amira Hassan: callback requested for Mon 9 Nov at 15:30 their time, 10:30 your time. Their automated outreach in Clinics, London is held until you log how the callback went.");
    await expect(page.getByText("the same as yours")).toHaveCount(0);
    const queue = page.getByRole("complementary", { name: "Call queue" });
    await expect(queue.getByRole("listitem").filter({ hasText: "Amira Hassan" })).toContainText("Callback they asked for at 15:30 their time, 10:30 your time");
    await page.goto(f.url);
    await expect(page.getByText(/Amira Hassan \(callback they asked for at 15:30 their time, 10:30 your time\)/)).toBeVisible();
    await shot(page, "today-new-york-later-today");

    await at(page, f, "2026-11-09T15:45:00Z");
    await page.reload();
    await expect(page.getByRole("region", { name: "Needs attention" })).toContainText("Amira Hassan asked for Mon 9 Nov at 15:30 their time, 10:30 your time.");
    await expect(page.getByRole("region", { name: "Up next" }).getByRole("listitem").first()).toContainText("Callback overdue since today at 15:30 their time, 10:30 your time");
    await expect(page.getByText("the same as yours")).toHaveCount(0);
    await shot(page, "today-new-york-overdue");
    await page.goto(`${f.url}/leads/people/${f.person("Amira Hassan")}`);
    // The record says the time asked for in their time, which is true whatever the user's zone.
    await expect(page.getByText("Callback Mon 9 Nov at 15:30 their time, now overdue.", { exact: false })).toBeVisible();
    await expect(page.getByText("the same as yours")).toHaveCount(0);
  });
});

test("only calls carried over: Needs attention says how many and how many are on their last day, the same count as the Calls list, and Open Calls is reached by keyboard (review bot on eac9f6c, item 4)", async ({ page }) => {
  const f = await carriedOnly("carried-only");
  const list = (await f.harness.request<{ readyNow: { reason: string }[]; laterToday: { reason: string }[] }>("GET", "/api/calls")).body;
  const carried = [...list.readyNow, ...list.laterToday].filter((x) => x.reason === "rolled_over" || x.reason === "redial").length;
  expect(carried).toBe(4);
  await openCalls(page, f, "/");
  const attention = page.getByRole("region", { name: "Needs attention" });
  await expect(attention.getByText(`${carried} calls carried over from earlier days`)).toBeVisible();
  await expect(attention).toContainText("All 4 are on their last day before they are skipped.");
  await expect(attention.getByText("Nothing needs you.")).toHaveCount(0);
  await shot(page, "today-carried-only");
  const link = attention.getByRole("link", { name: "Open Calls" });
  await tabTo(page, link);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/calls$/);
  await expect(page.getByRole("complementary", { name: "Call queue" }).getByRole("listitem").first()).toContainText("Rolled over, due Mon 9 Nov, last day before it’s skipped");
});

test("an unworked skip says what the track after it has done: waiting out its delay with the day it starts, then started, on a person's and a company lead's record (verifier on eac9f6c, F2)", async ({ page }) => {
  const f = await freshCalls("delayed", "skip-delayed");
  await page.clock.install({ time: f.harness.clock });
  const records = [`/leads/people/${f.person("Amira Hassan")}`, `/leads/companies/${f.company("Riverside Sports Clinic")}`];
  // Monday's calls are left unworked: skipped at the end of Tuesday, and the email after the call waits two days from then, to Friday.
  await at(page, f, "2026-11-11T10:00:00Z");
  for (const path of records) {
    await page.goto(f.url + path);
    const skip = page.getByRole("listitem").filter({ hasText: /^Phone track skipped, not called/ });
    await expect(skip).toContainText("Not called within 2 days of its due date, Mon 9 Nov, so the call was skipped. Email track 2 starts after its delay, on Fri 13 Nov.");
    await expect(skip).not.toContainText("started");
    await expect(page.getByRole("listitem").filter({ hasText: /^Email track 2 started/ })).toHaveCount(0);
  }
  await shot(page, "record-skip-delay-waiting");
  await at(page, f, "2026-11-13T10:00:00Z");
  for (const path of records) {
    await page.goto(f.url + path);
    // Its one email has gone: the track has finished, as the engine stores it; the release says it started because of the skip.
    await expect(page.getByRole("listitem").filter({ hasText: /^Phone track skipped, not called/ })).toContainText("Email track 2 has finished.");
    await expect(page.getByRole("listitem").filter({ hasText: /^Email track 2 started/ })).toContainText("It starts after the phone track, which was skipped: its call wasn’t made within its skip limit.");
  }
});

test("after a reply, the record shows no call and no hold for the tasks kept for a restart: a callback, an ordinary call, and a company lead's call (review bot and verifier on eac9f6c)", async ({ page }) => {
  const f = await freshCalls("ready", "replied-records");
  const amira = await callOf(f, "Amira Hassan");
  expect((await f.harness.request("POST", `/api/call-tasks/${amira.taskId}/outcome`, { requestId: "cb-before-reply", outcome: "callback_requested", callbackAt: "2026-11-09T15:00:00+00:00", numberId: amira.number("mobile") })).status).toBe(200);
  const amiraRecord = `/leads/people/${f.person("Amira Hassan")}`;
  const tomRecord = `/leads/people/${f.person("Tom")}`;
  const records = [amiraRecord, tomRecord, `/leads/companies/${f.company("Riverside Sports Clinic")}`];
  await page.clock.install({ time: f.harness.clock });
  // Before the replies each record says its call.
  await page.goto(f.url + amiraRecord);
  await expect(page.getByText("Callback Mon 9 Nov at 15:00 their time. Their automated outreach in this campaign is held until you log how it went.")).toBeVisible();
  await page.goto(f.url + tomRecord);
  await expect(page.getByText("Their call is on today’s list.")).toBeVisible();
  for (const address of ["amira@harbourlanephysio.example", "tom@harbourlanephysio.example", "info@riversidesports.example"]) expect(f.harness.fake.prospectReplies(address, true, null)).toBe(true);
  await at(page, f, "2026-11-09T10:01:00Z");
  for (const path of records) {
    await page.goto(f.url + path);
    await expect(page.getByText("Replied, automation stopped").first()).toBeVisible();
    for (const said of ["held until you log", "Their call", "waits for a day", "Callback Mon"]) await expect(page.getByText(said, { exact: false })).toHaveCount(0);
  }
  await shot(page, "record-company-replied");
});

test("a time inside the hour the clocks repeat: the earliest occurrence after the call's read, said as such, and refused only when both are past (council on 32454ea, B)", async ({ page }) => {
  const f = await freshCalls("ready", "repeated-hour");
  const amira = await callOf(f, "Amira Hassan");
  // The call's read, as of 01:05 GMT on Sunday 31 October 2027, inside the hour London's clocks repeat (01:00 to 02:00).
  await page.route(`**/api/call-tasks/${amira.taskId}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const view = (await (await route.fetch()).json()) as CallTaskView;
    await respond(route, { ...view, asOf: "2027-10-31T01:05:00.000Z" });
  });
  await openCalls(page, f);
  await outcome(page, "Callback requested").click();
  await expect(dayField(page)).toHaveValue("2027-10-31");
  // 01:30 came once at 00:30 GMT, already past; it comes again at 01:30 GMT, still to come.
  await timeField(page).fill("01:30");
  await expect(page.getByText(/^Callback on Sun 31 Oct at 01:30 their time, after the clocks go back, the same as yours\./)).toBeVisible();
  await expect(logButton(page)).toBeEnabled();
  await shot(page, "calls-callback-repeated-hour");
  // 00:50 comes once, before the read: past.
  await timeField(page).fill("00:50");
  await expect(page.getByText("That time has passed. Choose a time still to come; a callback in the past isn’t accepted.")).toBeVisible();
  await expect(logButton(page)).toBeDisabled();
});

test("a callback day restored from an earlier session is said as a date, not as its raw value (council on 32454ea, G)", async ({ page }) => {
  const f = await freshCalls("ready", "restored-day");
  const amira = await callOf(f, "Amira Hassan");
  await page.addInitScript(([taskId, numberId]) => {
    window.sessionStorage.setItem("outreach.calls.focus", taskId);
    window.sessionStorage.setItem(`outreach.calls.draft.${taskId}`, JSON.stringify({ outcome: "callback_requested", numberId, note: "", noteScope: "person", redial: false, callbackDay: "2026-11-08", callbackTime: "10:00", callbackAt: null, pressId: null }));
  }, [amira.taskId, amira.number("mobile")] as const);
  await openCalls(page, f);
  await expect(dayField(page).locator("option:checked")).toHaveText("Sun 8 Nov");
  await expect(page.getByText("2026-11-08")).toHaveCount(0);
  await expect(page.getByText("That time has passed.", { exact: false })).toBeVisible();
});

test("after a reply, a callback's Activity entry is history: what was asked for and when, with no hold and no overdue flag, before and after its time, on a person's and a company lead's record (verifier re-check, H)", async ({ page }) => {
  for (const late of [false, true]) {
    const f = await freshCalls("ready", `reply-history-${String(late)}`);
    const amira = await callOf(f, "Amira Hassan");
    const riverside = await callOf(f, "Riverside Sports Clinic");
    for (const [taskId, numberId] of [[amira.taskId, amira.number("mobile")], [riverside.taskId, riverside.number("main_line")]] as const) {
      expect((await f.harness.request("POST", `/api/call-tasks/${taskId}/outcome`, { requestId: `cb-${taskId}`, outcome: "callback_requested", callbackAt: "2026-11-09T15:00:00+00:00", numberId })).status).toBe(200);
    }
    if (late) await f.harness.advanceTo(Date.parse("2026-11-09T15:30:00Z"));
    for (const address of ["amira@harbourlanephysio.example", "info@riversidesports.example"]) expect(f.harness.fake.prospectReplies(address, true, null)).toBe(true);
    await f.harness.advanceTo(f.harness.clock + 60_000);
    await page.clock.setFixedTime(f.harness.clock);
    for (const path of [`/leads/people/${f.person("Amira Hassan")}`, `/leads/companies/${f.company("Riverside Sports Clinic")}`]) {
      await page.goto(f.url + path);
      await expect(page.getByText("Replied, automation stopped").first()).toBeVisible();
      const entry = page.getByRole("listitem").filter({ hasText: /^Call: callback requested/ });
      await expect(entry).toContainText("Callback asked for, Mon 9 Nov at 15:00 their time");
      await expect(entry).not.toContainText("held");
      await expect(page.getByRole("listitem").filter({ hasText: /^Callback overdue/ })).toHaveCount(0);
      await expect(page.getByText("held until", { exact: false })).toHaveCount(0);
    }
    if (late) await shot(page, "record-company-replied-after-callback-time");
  }
});

test("after an unworked skip, Activity says the email track after it as the engine stores it: dropped for win-back, not started because outreach stopped, or waiting to a stated day; on a person's and a company lead's record (verifier on 2027f24)", async ({ page }) => {
  const SAID = {
    win_back: "Email track 2 will not start: they moved to this campaign’s win-back branch.",
    stop: "Email track 2 did not start: their outreach in this campaign stopped.",
    continue: "Email track 2 starts after its delay, on Sat 14 Nov.",
  } as const;
  for (const path of ["win_back", "stop", "continue"] as const) {
    const f = await freshCalls("after-skip", `after-skip-${path}`);
    const leads = ["Amira Hassan", "Riverside Sports Clinic"];
    const post = async (taskId: string, body: Record<string, unknown>) => {
      const numbers = (await f.harness.request<CallTaskView>("GET", `/api/call-tasks/${taskId}`)).body.numbers;
      const out = await f.harness.request("POST", `/api/call-tasks/${taskId}/outcome`, { requestId: `${path}-${taskId}-${String(body["outcome"])}`, numberId: numbers.find((n) => !n.bad)?.detailId, ...body });
      expect(out.status, JSON.stringify(out.body)).toBe(200);
    };
    const tasksOn = async (trackId: string) => {
      const q = (await f.harness.request<{ readyNow: CallQueueItem[]; laterToday: CallQueueItem[] }>("GET", "/api/calls")).body;
      return [...q.readyNow, ...q.laterToday].filter((x) => x.track.id === trackId && leads.includes(x.person?.name ?? x.company.name));
    };
    // Monday: the first call redialed. Wednesday 10:00: skipped unworked at midnight; a callback for 11:00 on the second
    // phone track's call; at 11:05 they decline it, with the path.
    for (const x of await tasksOn("phone")) await post(x.taskId, { outcome: "no_answer", redial: true });
    await f.harness.advanceTo(Date.parse("2026-11-11T10:00:00Z"));
    for (const x of await tasksOn("phone2")) await post(x.taskId, { outcome: "callback_requested", callbackAt: "2026-11-11T11:00:00+00:00" });
    await f.harness.advanceTo(Date.parse("2026-11-11T11:05:00Z"));
    for (const x of await tasksOn("phone2")) await post(x.taskId, { outcome: "not_interested", declinedPath: path });
    await page.clock.setFixedTime(f.harness.clock);
    for (const path_ of [`/leads/people/${f.person("Amira Hassan")}`, `/leads/companies/${f.company("Riverside Sports Clinic")}`]) {
      await page.goto(f.url + path_);
      const skip = page.getByRole("listitem").filter({ hasText: /skipped, not called/ });
      await expect(skip).toContainText(SAID[path]);
      for (const [other, said] of Object.entries(SAID)) if (other !== path) await expect(skip).not.toContainText(said);
    }
    if (path === "win_back") await shot(page, "record-skip-then-win-back");
  }
});

/** EVIDENCE_DIR only: the changed pages' states from the standing screen list (each loading, empty, error and success state), light and dark. */
const EVIDENCE_SCREENS = [
  "today loading",
  "today error",
  "today with calls ready",
  "calls loading",
  "calls error",
  "calls, the call didn't load",
  "calls, before calling hours",
  "calls, the list done",
  "calls, a callback on a day their calling hours never open",
  "calls, a callback logged and held",
  "today with only calls carried over from earlier days",
  "calls, a callback time entered",
  "every outreach status, a bad number and a newer email",
];
test.describe("evidence (EVIDENCE_DIR only)", () => {
  test.skip(!process.env["EVIDENCE_DIR"], "evidence captures only");
  for (const name of EVIDENCE_SCREENS) {
    const screen = SCREENS.find((x) => x.name === name);
    if (!screen) continue;
    test(`capture: ${name}`, async ({ page, request }) => {
      await screen.open(page, await seedData(request));
      await shot(page, `screen-${name.replace(/[^a-z0-9]+/gi, "-")}`);
    });
  }
});
