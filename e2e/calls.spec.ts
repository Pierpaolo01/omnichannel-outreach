import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ActivityView } from "../src/shared/api.ts";
import { fakeCallsApp, type FakeCallsApp } from "./fake-provider.ts";
import { respond, serverError } from "./mocks.ts";
import { focused, freshCalls, logElsewhere, logWithMouse } from "./screens.ts";

/**
 * Today and the call focus queue (ticket 14, part b), on the app over the fake email provider with
 * a campaign whose phone track sits beside its email track, defined over HTTP (the canvas's phone
 * track editor is a later part). Nothing is dialled: the user dials on their own phone, and the app
 * lists calls and records outcomes. All data is fictitious.
 */

// The user and the prospects are in London: times on screen read as the calls' own.
test.use({ timezoneId: "Europe/London" });

const MONDAY_10 = Date.parse("2026-11-09T10:00:00Z");
const DAY = 24 * 3_600_000;

const numberGroup = (page: Page) => page.getByRole("group", { name: "Number you dial" });
const outcome = (page: Page, name: string) => page.getByRole("group", { name: "Call outcome" }).getByRole("button", { name, exact: true });
/** The line that says what happened to the last outcome (the loading skeleton is a status region too). */
const outcomeStatus = (page: Page) => page.locator("p[role='status']");
const logButton = (page: Page) => page.getByRole("button", { name: "Log and open next call" });

/** Presses Tab until `target` has focus, as a keyboard user would; fails if it takes more than `max` presses. */
async function tabTo(page: Page, target: Locator, max = 20): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

async function activity(f: FakeCallsApp, person: string): Promise<ActivityView["entries"]> {
  return (await f.harness.request<ActivityView>("GET", `/api/people/${f.person(person)}/activity`)).body.entries;
}

test("Today opens first with the date, the call counts, Start calling and Up next with each call's local time and reason", async ({ page }) => {
  const f = await fakeCallsApp("ready");
  await page.goto(f.url);
  await expect(page.getByText("4 calls are ready now.")).toBeVisible();
  const upNext = page.getByRole("region", { name: "Up next" });
  await expect(upNext.getByRole("listitem")).toHaveCount(4);
  await expect(upNext.getByRole("listitem").first()).toContainText("Amira Hassan");
  await expect(upNext.getByRole("listitem").first()).toContainText("Due today");
  await expect(upNext.getByRole("listitem").first()).toContainText("10:00");
  await page.getByRole("link", { name: "Start calling" }).click();
  await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Call queue" }).locator("li[aria-current='true']")).toContainText("Amira Hassan");
});

test("before calling hours, the calls wait in later today with the time they open", async ({ page }) => {
  const f = await fakeCallsApp("early");
  await page.goto(f.url);
  await expect(page.getByText("Nothing to call right now. 4 calls open later today.")).toBeVisible();
  await expect(page.getByText(/Later today: Amira Hassan \(their calling hours start at 09:00 your time\)/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Start calling" })).toHaveCount(0);
  await page.goto(`${f.url}/calls`);
  await expect(page.getByRole("heading", { name: "Later today, 4" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Nothing to call right now" })).toBeVisible();
});

test("the whole calling loop by keyboard alone: choose the number dialled, write a note, log, and the next call opens with focus on its number", async ({ page }) => {
  const f = await freshCalls("ready", "keyboard");
  await page.goto(`${f.url}/calls`);
  await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  // Amira's mobile is first; the main line is the company's. She is dialled on the main line.
  await numberGroup(page).getByRole("radio", { checked: true }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(numberGroup(page).getByRole("radio", { checked: true })).toHaveAccessibleName(/7946 0101/);
  await tabTo(page, page.getByLabel("Notes from this call"));
  await page.keyboard.type("Front desk says she is with a patient until 11.");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Space");
  await expect(page.getByRole("checkbox", { name: /company note/ })).toBeChecked();
  await tabTo(page, outcome(page, "Didn’t reach them"));
  await page.keyboard.press("Enter");
  await expect(outcome(page, "Didn’t reach them")).toHaveAttribute("aria-pressed", "true");
  await tabTo(page, logButton(page));
  await page.keyboard.press("Enter");

  await expect(outcomeStatus(page).filter({ hasText: "Amira Hassan: didn’t reach them logged." })).toContainText("The phone track is finished. The note is saved for everyone at Harbour Lane Physio.");
  await expect(page.getByRole("heading", { name: "Tom" })).toBeVisible();
  await expect(numberGroup(page).getByRole("radio", { checked: true })).toBeFocused();
  // The shared company note now shows on the colleague's call.
  await expect(page.getByText("Company note. Front desk says she is with a patient until 11.")).toBeVisible();
  const entries = await activity(f, "Amira Hassan");
  expect(entries.filter((e) => e.kind === "call")).toEqual([expect.objectContaining({ outcome: "gatekeeper", note: "Front desk says she is with a patient until 11.", number: expect.objectContaining({ kind: "main_line" }) })]);
});

test("an answer lost on the way back is sent again with the same request id and logged once", async ({ page }) => {
  const f = await freshCalls("ready", "lost-answer");
  await page.goto(`${f.url}/calls`);
  await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  const ids: string[] = [];
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/call-tasks/*/outcome", async (route) => {
    ids.push((route.request().postDataJSON() as { requestId: string }).requestId);
    if (ids.length > 1) {
      // Resends wait until the page has said the first is not confirmed.
      await released;
      return route.continue();
    }
    // The first reaches the server, and its answer is lost.
    await route.fetch();
    return route.abort("connectionreset");
  });
  await logWithMouse(page, "No answer", "Rang out.");
  await expect(outcomeStatus(page)).toContainText("not confirmed yet");
  await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Logging…" })).toBeVisible();
  release();
  await page.getByRole("button", { name: "Try again now" }).click({ timeout: 1_000 }).catch(() => undefined);
  await expect(outcomeStatus(page)).toContainText("Amira Hassan: no answer logged.");
  expect(new Set(ids).size).toBe(1);
  expect(ids.length).toBeGreaterThanOrEqual(2);
  expect((await activity(f, "Amira Hassan")).filter((e) => e.kind === "call")).toHaveLength(1);
});

test("leaving the page while an outcome is pending loses nothing: the next Calls page sends it again and it is logged once", async ({ page }) => {
  const f = await freshCalls("ready", "reload-pending");
  await page.goto(`${f.url}/calls`);
  await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  await page.route("**/api/call-tasks/*/outcome", (route) => route.abort("internetdisconnected"));
  await logWithMouse(page, "Left voicemail", "Left a short message about evening bookings.");
  await expect(outcomeStatus(page)).toContainText("not confirmed yet");
  await page.unroute("**/api/call-tasks/*/outcome");
  await page.goto(`${f.url}/leads`);
  await page.goto(`${f.url}/calls`);
  // The reopened page sends it again; the tab's draft is still the one that press captured, so its answer shows it logged and the next call opens.
  await expect(outcomeStatus(page)).toContainText("left voicemail logged");
  await expect(page.getByRole("heading", { name: "Tom" })).toBeVisible();
  const calls = (await activity(f, "Amira Hassan")).filter((e) => e.kind === "call");
  expect(calls).toEqual([expect.objectContaining({ outcome: "voicemail", note: "Left a short message about evening bookings." })]);
});

test("a second tab on the same call is told it was logged there, keeps its unsaved note on screen, and moves on only when asked", async ({ page, context }) => {
  const f = await freshCalls("ready", "two-tabs");
  await page.goto(`${f.url}/calls`);
  const other = await context.newPage();
  await other.goto(`${f.url}/calls`);
  await expect(other.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  await other.getByLabel("Notes from this call").fill("Typed in the second tab.");

  await logWithMouse(page, "No answer");
  await expect(page.getByRole("heading", { name: "Tom" })).toBeVisible();
  // The other tab learns it from the outbox change, says so, and keeps the call and the note on screen.
  await expect(other.getByRole("alert")).toContainText("Amira Hassan’s call is already logged: no answer at 10:00.");
  await expect(other.getByRole("alert")).toContainText("Your note wasn’t saved: Typed in the second tab.");
  await expect(other.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  await expect(outcome(other, "Interested")).toBeDisabled();
  await other.getByRole("button", { name: "Open the next call" }).click();
  await expect(other.getByRole("heading", { name: "Tom" })).toBeVisible();
});

test("a call logged from another window is refused here, explained, and the queue moves on truthfully", async ({ page }) => {
  const f = await freshCalls("ready", "other-window");
  await page.goto(`${f.url}/calls`);
  await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  const t = await focused(f);
  await logElsewhere(f, t.taskId, "interested", t.numberId);
  await logWithMouse(page, "Left voicemail", "Typed here.");
  // One path for the refusal: kept with its note, and the call says why it is off the list.
  const notLogged = page.getByRole("list", { name: "Outcomes not logged" });
  await expect(notLogged).toContainText("Not logged: left voicemail for Amira Hassan.");
  await expect(notLogged).toContainText("The note typed with it: Typed here.");
  await expect(notLogged).not.toContainText("saved");
  await expect(page.getByRole("alert").filter({ hasText: "Open the next call" })).toContainText("Amira Hassan’s call is already logged: interested at 10:00.");
  await expect(outcomeStatus(page)).not.toContainText("logged.");
  await page.getByRole("button", { name: "Open the next call" }).click();
  await expect(page.getByRole("heading", { name: "Tom" })).toBeVisible();
  expect((await activity(f, "Amira Hassan")).filter((e) => e.kind === "call")).toEqual([expect.objectContaining({ outcome: "interested", note: "" })]);
});

test("the focus holds while other calls become ready, and moves only on an outcome", async ({ page }) => {
  const f = await freshCalls("early", "focus-holds");
  await f.harness.advanceTo(Date.parse("2026-11-09T09:01:00Z"));
  await page.goto(`${f.url}/calls`);
  await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  await page.getByLabel("Notes from this call").fill("Still typing.");
  await f.harness.advanceTo(Date.parse("2026-11-09T09:40:00Z"));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("heading", { name: "Ready now, 4" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  await expect(page.getByLabel("Notes from this call")).toHaveValue("Still typing.");
});

test("wrong number marks the number dialled; interested stops only this lead with its handoff status", async ({ page }) => {
  const f = await freshCalls("ready", "outcomes");
  await page.goto(`${f.url}/calls`);
  await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  await logWithMouse(page, "Wrong number");
  await expect(outcomeStatus(page)).toContainText("Amira Hassan: wrong number logged. +44 7700 900101 is marked wrong. The phone track is finished.");
  await expect(page.getByRole("heading", { name: "Tom" })).toBeVisible();
  await logWithMouse(page, "Interested", "Wants a walkthrough on Thursday.");
  await expect(outcomeStatus(page)).toContainText("Tom: interested logged. Interested on call, automation stopped in Clinics, London. Nothing else is recorded.");
  await page.goto(`${f.url}/leads/people/${f.person("Tom")}`);
  await expect(page.getByText("Interested on call, automation stopped")).toBeVisible();
  await expect(page.getByText("Call: interested")).toBeVisible();
  await page.goto(`${f.url}/leads/people/${f.person("Amira Hassan")}`);
  await expect(page.getByText("+44 7700 900101").first()).toHaveCSS("text-decoration-line", "line-through");
});

/** When recording the demonstration, holds each step on screen long enough to read. */
const linger = async (page: Page) => {
  if (process.env["RECORD_DEMO"]) await page.waitForTimeout(2_500);
};

/**
 * The ticket's demonstration (recorded with RECORD_DEMO=1): manual dialling and logged outcomes from
 * a campaign, the visible state and timeline changes, and the email track beside the phone track
 * carrying on by itself while the email after the call waits for it.
 */
test("demonstration: work the call list from Today, see each outcome on the record, and the parallel email track carry on", async ({ page }) => {
  const f = await freshCalls("ready", "demonstration");
  await test.step("Today: four calls ready now", async () => {
    // A ticking clock from the app's time, so the screen's dates agree with the calls (and the recording keeps time).
    await page.clock.install({ time: f.harness.clock });
    await page.goto(f.url);
    await expect(page.getByText("4 calls are ready now.")).toBeVisible();
    await page.getByRole("link", { name: "Start calling" }).click();
    await linger(page);
  });
  await test.step("Amira: dialled on her mobile, on your own phone; no answer, with a note", async () => {
    await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
    await expect(page.getByText("the app never places a call")).toBeVisible();
    await logWithMouse(page, "No answer", "Rang eight times, no voicemail.");
    await expect(outcomeStatus(page)).toContainText("Amira Hassan: no answer logged. The phone track is finished.");
    await linger(page);
  });
  await test.step("Tom: interested, so automation stops for him in this campaign only", async () => {
    await expect(page.getByRole("heading", { name: "Tom" })).toBeVisible();
    await logWithMouse(page, "Interested", "Wants a walkthrough on Thursday at 2.");
    await expect(outcomeStatus(page)).toContainText("Interested on call, automation stopped");
    await linger(page);
  });
  await test.step("Grace: skipped for now, so the call stays on today's list", async () => {
    await expect(page.getByRole("heading", { name: "Grace Okafor" })).toBeVisible();
    await logWithMouse(page, "Skip for now");
    await expect(outcomeStatus(page)).toContainText("Grace Okafor skipped for now. The call stays on today’s list.");
    await linger(page);
  });
  await test.step("the email after Amira's call goes once the call is logged; her first email track carried on beside it", async () => {
    await f.harness.advanceTo(MONDAY_10 + 2 * DAY + 3_600_000);
    await page.clock.setSystemTime(f.harness.clock);
    await page.goto(`${f.url}/leads/people/${f.person("Amira Hassan")}`);
    await expect(page.getByText("Call: no answer")).toBeVisible();
    await expect(page.getByText(/Rang eight times, no voicemail\./)).toBeVisible();
    await expect(page.getByText("Email 2 sent")).toBeVisible();
    await expect(page.getByText("Email 1 sent")).toHaveCount(2);
    await linger(page);
  });
  await test.step("Tom's record: interested, the call and its note; nothing more goes to him", async () => {
    await page.goto(`${f.url}/leads/people/${f.person("Tom")}`);
    await expect(page.getByText("Interested on call, automation stopped")).toBeVisible();
    await expect(page.getByText(/Wants a walkthrough on Thursday at 2\./)).toBeVisible();
    await expect(page.getByText("Email 2 sent")).toHaveCount(0);
    await linger(page);
  });
});

test.describe("whatever the server decides by the clock is refreshed when it can change (review bot and verifier on e6872eb)", () => {
  test("Today: another client's outcome shows when the page is shown again; calling hours opening shows at the instant the server named", async ({ page }) => {
    const f = await freshCalls("early", "today-live");
    await page.clock.install({ time: f.harness.clock });
    await page.goto(f.url);
    await expect(page.getByText("Nothing to call right now. 4 calls open later today.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Start calling" })).toHaveCount(0);

    // 09:00 London: the calling hours open. The page refreshes at the server's nextChangeAt, with no navigation.
    await f.harness.advanceTo(Date.parse("2026-11-09T09:00:30Z"));
    await page.clock.runFor(91 * 60_000);
    await expect(page.getByText("4 calls are ready now.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Start calling" })).toBeVisible();

    // Another window works the first call: shown when the page is shown again.
    const t = await focused(f);
    await logElsewhere(f, t.taskId, "no_answer", t.numberId);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.getByText("3 calls are ready now.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Up next" }).getByRole("listitem").first()).not.toContainText("Amira Hassan");
  });

  test("Today: the date turns at the user's midnight, and Needs attention is read again with it", async ({ page }) => {
    const f = await freshCalls("ready", "today-midnight");
    let problem = false;
    await page.route("**/api/needs-attention", async (route) => {
      if (!problem) return route.continue();
      return respond(route, {
        stalledInboxes: [],
        heldTracks: [],
        accountWaits: [],
        senderProblems: [{ accountId: "sms-1", channel: "sms", label: "+44 7700 900999", problem: "disconnected" }],
        heldCapacity: [],
        anomalies: [],
      });
    });
    await page.clock.install({ time: f.harness.clock });
    await page.goto(f.url);
    await expect(page.getByText(/^Monday 9 November, /)).toBeVisible();
    await expect(page.getByText("Nothing needs you.")).toBeVisible();
    problem = true;
    await f.harness.advanceTo(Date.parse("2026-11-10T00:05:00Z"));
    await page.clock.runFor(14 * 3_600_000 + 6 * 60_000);
    await expect(page.getByText(/^Tuesday 10 November, /)).toBeVisible();
    await expect(page.getByText("Your SMS number +44 7700 900999 can’t send")).toBeVisible();
  });

  test("Calls: the queue fills when the calling hours open, at the instant the server named", async ({ page }) => {
    const f = await freshCalls("early", "calls-live");
    await page.clock.install({ time: f.harness.clock });
    await page.goto(`${f.url}/calls`);
    await expect(page.getByRole("heading", { name: "Nothing to call right now" })).toBeVisible();
    await f.harness.advanceTo(Date.parse("2026-11-09T09:00:30Z"));
    await page.clock.runFor(91 * 60_000);
    await expect(page.getByRole("heading", { name: "Ready now, 4" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  });
});

test("the number chosen goes bad on a colleague's call: the choice stays, the page says so, and Log waits for a new choice (review bot on e6872eb)", async ({ page }) => {
  const f = await freshCalls("ready", "number-gone-bad");
  await page.goto(`${f.url}/calls`);
  await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  await numberGroup(page).getByRole("radio", { name: /7946 0101/ }).check();
  await outcome(page, "Wrong number").click();
  await page.getByLabel("Notes from this call").fill("The main line is dead.");
  // Tom's call, at the same company, is logged as a wrong number on the shared main line from another window.
  const tom = (await f.harness.request<{ readyNow: { taskId: string; person: { name: string } | null }[] }>("GET", "/api/calls")).body.readyNow.find((x) => x.person?.name === "Tom");
  const main = (await f.harness.request<{ numbers: { detailId: string; kind: string }[] }>("GET", `/api/call-tasks/${tom?.taskId}`)).body.numbers.find((n) => n.kind === "main_line");
  await logElsewhere(f, tom?.taskId ?? "", "wrong_number", main?.detailId ?? null);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByText("The number you chose, +44 20 7946 0101, is now marked wrong. Choose the number you dial.")).toBeVisible();
  await expect(numberGroup(page).getByRole("radio", { checked: true })).toHaveAccessibleName(/7946 0101/);
  await expect(page.getByLabel("Notes from this call")).toHaveValue("The main line is dead.");
  await expect(logButton(page)).toBeDisabled();
  await numberGroup(page).getByRole("radio", { name: /7700 900101/ }).check();
  await expect(logButton(page)).toBeEnabled();
});

test("an outcome left by a closed tab and refused on recovery is listed with its note until dismissed (verifier on e6872eb)", async ({ page, context }) => {
  const f = await freshCalls("ready", "closed-tab-refused");
  const first = await context.newPage();
  await first.goto(`${f.url}/calls`);
  await expect(first.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  // The request never leaves: the tab closes before the server hears of it.
  await first.route("**/api/call-tasks/*/outcome", (route) => route.abort("internetdisconnected"));
  await logWithMouse(first, "No answer", "Orphan refusal note must remain visible");
  await expect(first.locator("p[role='status']")).toContainText("not confirmed yet");
  await first.close();
  const t = await focused(f);
  await logElsewhere(f, t.taskId, "interested", t.numberId);

  await page.goto(`${f.url}/calls`);
  const notLogged = page.getByRole("list", { name: "Outcomes not logged" });
  await expect(notLogged).toContainText("Not logged: no answer for Amira Hassan. Amira Hassan’s call is already logged: interested at 10:00.");
  await expect(notLogged).toContainText("The note typed with it: Orphan refusal note must remain visible");
  await notLogged.getByRole("button", { name: "Dismiss" }).click();
  await expect(notLogged).toHaveCount(0);
});

test("what the page says was saved, logged or sent comes from the server, with a failed read in between (review bot on 9c3ad27)", async ({ page }) => {
  const f = await freshCalls("ready", "saved-sentences");
  await page.goto(`${f.url}/calls`);
  await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  // The outcome reaches the server; its answer is lost on the way back.
  let lose = true;
  await page.route("**/api/call-tasks/*/outcome", async (route) => {
    if (!lose) return route.continue();
    lose = false;
    await route.fetch();
    return route.abort("connectionreset");
  });
  await logWithMouse(page, "Left voicemail", "Left a message about evening bookings.");
  await expect(outcomeStatus(page)).toContainText("not confirmed yet");
  // The user leaves Calls and comes back; the first read of the call fails.
  await page.goto(`${f.url}/leads`);
  let failOnce = true;
  await page.route("**/api/call-tasks/*", (route) => {
    if (route.request().method() !== "GET" || !failOnce) return route.continue();
    failOnce = false;
    return serverError(route);
  });
  await page.goto(`${f.url}/calls`);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  // The tab's draft is still the one that press captured: the answer to its resend shows it logged, with the note where the server stored it.
  await expect(outcomeStatus(page)).toContainText("left voicemail logged");
  await expect(outcomeStatus(page)).toContainText("The note is saved on Amira Hassan.");
  await expect(page.getByText("wasn’t saved")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Tom" })).toBeVisible();
  // A note logged here is said to be saved where the server's answer stores it.
  await page.getByRole("checkbox", { name: /company note/ }).check();
  await logWithMouse(page, "No answer", "Tom is in on Thursdays.");
  await expect(outcomeStatus(page)).toContainText("The note is saved for everyone at Harbour Lane Physio.");
});

test("a kept refusal says what was not logged, why, and the note typed with it, never whether that note is saved (re-check on 12f0303, R2)", async ({ page }) => {
  const f = await freshCalls("ready", "refused-then-relogged");
  await page.goto(`${f.url}/calls`);
  await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  await numberGroup(page).getByRole("radio", { name: /7946 0101/ }).check();
  // The press reaches the server just after the company main line is marked wrong on Tom's call.
  const tom = (await f.harness.request<{ readyNow: { taskId: string; person: { name: string } | null }[] }>("GET", "/api/calls")).body.readyNow.find((x) => x.person?.name === "Tom");
  const main = (await f.harness.request<{ numbers: { detailId: string; kind: string }[] }>("GET", `/api/call-tasks/${tom?.taskId}`)).body.numbers.find((n) => n.kind === "main_line");
  let first = true;
  await page.route("**/api/call-tasks/*/outcome", async (route) => {
    if (first) {
      first = false;
      await logElsewhere(f, tom?.taskId ?? "", "wrong_number", main?.detailId ?? null);
    }
    return route.continue();
  });
  await logWithMouse(page, "No answer", "Same note, logged again on the mobile.");
  const notLogged = page.getByRole("list", { name: "Outcomes not logged" });
  await expect(notLogged).toContainText("Not logged: no answer for Amira Hassan.");
  // The user picks the good mobile and logs the outcome again with the same note; the server stores it.
  await numberGroup(page).getByRole("radio", { name: /7700 900101/ }).check();
  await logButton(page).click();
  await expect(outcomeStatus(page)).toContainText("The note is saved on Amira Hassan.");
  // The kept refusal is about that refused outcome only: not logged, why, and the note typed with it.
  await expect(notLogged).toContainText("Not logged: no answer for Amira Hassan.");
  await expect(notLogged).toContainText("The note typed with it: Same note, logged again on the mobile.");
  await expect(notLogged).not.toContainText("saved");
  await expect(page.getByText("wasn’t saved")).toHaveCount(0);
});

test("a press this device cannot store sends nothing, says so, and keeps the draft; Log works once storage has room (re-check on 9c3ad27, B3)", async ({ page }) => {
  const f = await freshCalls("ready", "storage-full");
  await page.addInitScript(() => {
    const setItem = Object.getOwnPropertyDescriptor(Storage.prototype, "setItem")?.value as (this: Storage, k: string, v: string) => void;
    Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
      if (this === window.localStorage && (window as Window & { storageFull?: boolean }).storageFull) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      setItem.call(this, k, v);
    };
  });
  await page.goto(`${f.url}/calls`);
  await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/outcome")) posts.push(r.url());
  });
  await page.evaluate(() => ((window as Window & { storageFull?: boolean }).storageFull = true));
  await logWithMouse(page, "Left voicemail", "Left a message about evening bookings.");
  await expect(page.getByRole("alert").filter({ hasText: "couldn’t be queued on this device" })).toBeVisible();
  expect(posts).toEqual([]);
  await expect(page.getByLabel("Notes from this call")).toHaveValue("Left a message about evening bookings.");
  await expect(logButton(page)).toBeEnabled();
  // Leaving and coming back: nothing was queued, so nothing is pending or lost; the draft is still there.
  await page.goto(`${f.url}/leads`);
  await page.goto(`${f.url}/calls`);
  await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  await expect(page.getByLabel("Notes from this call")).toHaveValue("Left a message about evening bookings.");
  await page.evaluate(() => ((window as Window & { storageFull?: boolean }).storageFull = false));
  await outcome(page, "Left voicemail").click();
  await logButton(page).click();
  await expect(outcomeStatus(page)).toContainText("Amira Hassan: left voicemail logged.");
  expect(posts).toHaveLength(1);
});
