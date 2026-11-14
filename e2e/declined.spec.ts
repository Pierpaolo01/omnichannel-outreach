import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ActivityView, CallTaskView, CallsView, PersonRecord, RecordCalls } from "../src/shared/api.ts";
import { focused, freshCalls, logElsewhere } from "./screens.ts";
import type { FakeCallsApp } from "./fake-provider.ts";

/**
 * Not interested on the Calls page (ticket 16, part c), on the app over the fake email provider with a phone track
 * beside an email track and an email after the call, defined over HTTP: the path preselected from the call's read (the
 * phone track's, or, with none set, what the engine does, Q14), a per-lead override, a path the campaign does not offer
 * disabled with its reason, what logging does said from the read before Log and from the server's answer after, and the
 * declined lead on Calls, Today, the record and Activity. Nothing is dialled. All data is fictitious.
 * EVIDENCE_DIR=<dir> also writes each state's screenshot, light and dark, for the pull request.
 */

test.use({ timezoneId: "Europe/London" });

const outcome = (page: Page, name: string) => page.getByRole("group", { name: "Call outcome" }).getByRole("button", { name, exact: true });
const paths = (page: Page) => page.getByRole("group", { name: /What happens next for/ });
const path = (page: Page, name: RegExp) => paths(page).getByRole("radio", { name });
const outcomeStatus = (page: Page) => page.locator("p[role='status']");
const logButton = (page: Page) => page.getByRole("button", { name: "Log and open next call" });
const numberGroup = (page: Page) => page.getByRole("group", { name: "Number you dial" });
const trackLines = (page: Page) => page.getByRole("list", { name: "What logging does to each track" });

/** Screenshots of the page as it is, in both themes (and at 390 px when asked), when EVIDENCE_DIR is set. */
async function shot(page: Page, name: string, options: { narrow?: Locator; fullPage?: boolean } = {}): Promise<void> {
  const dir = process.env["EVIDENCE_DIR"];
  if (!dir) return;
  if (options.narrow) {
    const size = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await options.narrow.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/${name}-390.png` });
    if (size) await page.setViewportSize(size);
  }
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/${name}-${scheme}.png`, fullPage: options.fullPage ?? false });
  }
  await page.emulateMedia({ colorScheme: null });
}

/** When recording the demonstration, holds each step on screen long enough to read. */
const linger = async (page: Page) => {
  if (process.env["RECORD_DEMO"]) await page.waitForTimeout(2_500);
};

/** Presses Tab until `target` has focus; fails after `max` presses. */
async function tabTo(page: Page, target: Locator, max = 40): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

const activity = async (f: FakeCallsApp, who: string) => (await f.harness.request<ActivityView>("GET", `/api/people/${f.person(who)}/activity`)).body.entries;
const record = async (f: FakeCallsApp, who: string) => (await f.harness.request<PersonRecord & RecordCalls>("GET", `/api/people/${f.person(who)}`)).body;
const queueNames = async (f: FakeCallsApp) => {
  const v = (await f.harness.request<CallsView>("GET", "/api/calls")).body;
  return [...v.readyNow, ...v.laterToday].map((x) => x.person?.name ?? x.company.name);
};

test("win back preselected from the phone track, by keyboard alone: the pill, the radios by arrow keys, Log, and focus on the next call's number", async ({ page }) => {
  const f = await freshCalls("win-back", "declined-keyboard");
  await page.clock.setFixedTime(f.harness.clock);
  await page.goto(`${f.url}/calls`);
  await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  // The not-yet sentence of ticket 14b is gone: not interested is a working outcome.
  await expect(page.getByText("arrives with a later release")).toHaveCount(0);
  await tabTo(page, outcome(page, "Not interested"));
  await page.keyboard.press("Enter");
  await expect(outcome(page, "Not interested")).toHaveAttribute("aria-pressed", "true");
  await expect(path(page, /Move to the win-back messages/)).toBeChecked();
  await expect(paths(page)).toHaveAccessibleDescription("Preselected from the phone track’s setting.");
  await expect(page.getByText("Logging this moves them to this campaign’s win-back branch: its tracks replace the main sequence’s remaining ones. No call is made to them again.")).toBeVisible();
  await expect(trackLines(page)).toContainText("Email track 1 is dropped for the win-back branch.");
  await expect(trackLines(page)).toContainText("Win-back email track starts now.");
  await shot(page, "declined-win-back-preselected", { narrow: paths(page) });
  await linger(page);

  // Tab reaches the radio group on its checked radio, after Skip for now; the arrow keys choose another path for Amira only.
  await page.keyboard.press("Tab");
  await expect(outcome(page, "Skip for now")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(path(page, /Move to the win-back messages/)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(path(page, /Keep the email and SMS steps going/)).toBeChecked();
  await expect(path(page, /Keep the email and SMS steps going/)).toBeFocused();
  await expect(paths(page)).toHaveAccessibleDescription("For Amira Hassan only: the phone track is set to “Move to the win-back messages”.");
  await expect(page.getByText("Logging this keeps their remaining tracks in this campaign going. No call is made to them again.")).toBeVisible();
  await shot(page, "declined-overridden-continue");
  await linger(page);
  await page.keyboard.press("ArrowDown");
  await expect(path(page, /Move to the win-back messages/)).toBeChecked();
  await tabTo(page, logButton(page));
  await page.keyboard.press("Enter");

  await expect(outcomeStatus(page)).toHaveText("Amira Hassan: not interested logged. Moved to this campaign’s win-back branch, with no more calls. Now in win-back, in Clinics, London.");
  await expect(page.getByRole("heading", { name: "Amira Hassan" })).toHaveCount(0);
  await expect(numberGroup(page).getByRole("radio", { checked: true })).toBeFocused();
  await shot(page, "declined-win-back-logged");
  await linger(page);
  // Stored as pressed, and the lead is not called again.
  expect((await activity(f, "Amira Hassan")).filter((e) => e.kind === "call")).toEqual([expect.objectContaining({ outcome: "not_interested", declinedPath: "win_back" })]);
  expect(await queueNames(f)).not.toContain("Amira Hassan");
});

test("continue preselected, win back unavailable with its reason; stop chosen for this lead instead", async ({ page }) => {
  const f = await freshCalls("continue", "declined-continue");
  await page.clock.setFixedTime(f.harness.clock);
  await page.goto(`${f.url}/calls`);
  await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  await outcome(page, "Not interested").click();
  await expect(path(page, /Keep the email and SMS steps going/)).toBeChecked();
  await expect(path(page, /Move to the win-back messages \(this campaign has none\)/)).toBeDisabled();
  await expect(page.getByText("Logging this keeps their remaining tracks in this campaign going. No call is made to them again.")).toBeVisible();
  await expect(trackLines(page)).toContainText("Email track 1 carries on.");
  await expect(trackLines(page)).toContainText(/Email track 2 starts after its delay, on Tue 10 Nov\./);
  await shot(page, "declined-continue-preselected", { narrow: paths(page) });
  await path(page, /Stop all outreach in this campaign/).check();
  await expect(page.getByText("Logging this stops their outreach in this campaign only. Their other campaigns and colleagues are not affected. No call is made to them again.")).toBeVisible();
  await expect(trackLines(page)).toContainText("Email track 1 stops.");
  await expect(trackLines(page)).toContainText("Email track 2 will not start.");
  await shot(page, "declined-overridden-stop");
  await page.getByLabel("Notes from this call").fill("Has a booking system they like.");
  await logButton(page).click();
  await expect(outcomeStatus(page)).toHaveText("Amira Hassan: not interested logged. Stopped in this campaign. Now declined on call, in Clinics, London. The note is saved on Amira Hassan.");
  expect((await record(f, "Amira Hassan")).enrollments.map((e) => e.status)).toEqual(["declined_on_call"]);
});

test("a phone track with no path set: stop is preselected as what logging does, said as the read states it (Q14), and win back is unavailable", async ({ page }) => {
  const f = await freshCalls("ready", "declined-unset");
  await page.clock.setFixedTime(f.harness.clock);
  await page.goto(`${f.url}/calls`);
  await outcome(page, "Not interested").click();
  await expect(path(page, /Stop all outreach in this campaign/)).toBeChecked();
  await expect(paths(page)).toHaveAccessibleDescription("No path is set on the phone track for a declined call, so the one logging uses without a choice is preselected.");
  await expect(path(page, /Move to the win-back messages \(this campaign has none\)/)).toBeDisabled();
  await shot(page, "declined-no-path-set");
  // Overridden on a track with no path set: no setting is claimed for the track (review bot on d478d6d).
  await path(page, /Keep the email and SMS steps going/).check();
  await expect(paths(page)).toHaveAccessibleDescription("For Amira Hassan only: no path is set on the phone track, so without a choice logging uses “Stop all outreach in this campaign”.");
  await shot(page, "declined-no-path-set-overridden");
});

test("a path the read no longer offers is refused in place: nothing is sent, the choice stays, and Log waits for another path", async ({ page }) => {
  const f = await freshCalls("continue", "declined-not-offered");
  const t = await focused(f);
  // A draft kept in this tab from when win back was offered (a running edit removed the branch since, ticket 19).
  await page.addInitScript(([id, n]) => window.sessionStorage.setItem(`outreach.calls.draft.${id}`, JSON.stringify({ outcome: "not_interested", numberId: n, note: "", noteScope: "person", redial: false, callbackDay: null, callbackTime: "", callbackAt: null, declinedPath: "win_back", pressId: null })), [t.taskId, t.numberId] as const);
  let posts = 0;
  await page.route("**/api/call-tasks/*/outcome", (route) => {
    posts++;
    return route.continue();
  });
  await page.clock.setFixedTime(f.harness.clock);
  await page.goto(`${f.url}/calls`);
  await expect(path(page, /Move to the win-back messages/)).toBeChecked();
  await expect(page.getByText("This campaign has no win-back branch now, so that path can’t be logged. Choose another.")).toBeVisible();
  await expect(logButton(page)).toBeDisabled();
  await expect(page.getByText("Choose another path.")).toBeVisible();
  await shot(page, "declined-path-not-offered");
  expect(posts).toBe(0);
  // Arrow keys move off it to a path offered; the unavailable path can't be chosen again.
  await path(page, /Move to the win-back messages/).focus();
  await page.keyboard.press("ArrowUp");
  await expect(path(page, /Keep the email and SMS steps going/)).toBeChecked();
  await expect(path(page, /Move to the win-back messages/)).toBeDisabled();
  await expect(logButton(page)).toBeEnabled();
});

test("a not-interested press the server refuses is kept with its path and note until dismissed", async ({ page }) => {
  const f = await freshCalls("win-back", "declined-refused");
  await page.clock.setFixedTime(f.harness.clock);
  await page.goto(`${f.url}/calls`);
  await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  const t = await focused(f);
  await logElsewhere(f, t.taskId, "voicemail", t.numberId);
  await page.getByLabel("Notes from this call").fill("Said no thanks, try again in spring.");
  await outcome(page, "Not interested").click();
  await logButton(page).click();
  const kept = page.getByRole("list", { name: "Outcomes not logged" });
  await expect(kept).toContainText("Not logged: not interested (“Move to the win-back messages”) for Amira Hassan. Amira Hassan’s call was already logged from another window or device: left voicemail at 10:00.");
  await expect(kept).toContainText("Said no thanks, try again in spring.");
  await shot(page, "declined-refused-kept");
});

test("after declines on each path: Calls and Today no longer list the leads, the record says each status and path, and Activity what each decline did to each track", async ({ page }) => {
  const f = await freshCalls("win-back", "declined-everywhere");
  await page.clock.setFixedTime(f.harness.clock);
  await page.goto(`${f.url}/calls`);
  // Amira: win back, as preselected. Tom: continue, overridden. Grace: stop, overridden.
  for (const [who, choice] of [["Amira Hassan", null], ["Tom", /Keep the email and SMS steps going/], ["Grace Okafor", /Stop all outreach in this campaign/]] as const) {
    await expect(page.getByRole("heading", { name: who })).toBeVisible();
    await outcome(page, "Not interested").click();
    if (choice) await path(page, choice).check();
    await logButton(page).click();
    await expect(outcomeStatus(page)).toContainText(`${who}: not interested logged.`);
    await linger(page);
  }
  await expect(page.getByRole("heading", { name: "Riverside Sports Clinic" })).toBeVisible();
  const queue = page.getByRole("region", { name: /Ready now/ });
  for (const who of ["Amira Hassan", "Tom", "Grace Okafor"]) await expect(queue.getByText(who, { exact: true })).toHaveCount(0);
  await shot(page, "declined-calls-after");
  await page.goto(f.url);
  const upNext = page.getByRole("region", { name: "Up next" });
  await expect(upNext.getByRole("listitem")).toHaveCount(1);
  await expect(upNext).not.toContainText("Amira Hassan");
  await shot(page, "declined-today-after");

  await page.goto(`${f.url}/leads/people/${f.person("Amira Hassan")}`);
  const campaigns = page.getByRole("region", { name: "Campaigns" });
  await expect(campaigns).toContainText("In win-back");
  await expect(campaigns).toContainText("Declined on a call on Mon 9 Nov, and moved to this campaign’s win-back branch, which is running. No call is made to them again.");
  const activityRegion = page.getByRole("region", { name: "Activity" });
  await expect(activityRegion.getByRole("listitem").filter({ hasText: "Call: not interested" })).toContainText("Moved to this campaign’s win-back branch, with no more calls. Email track 1 was dropped for the win-back branch. Email track 2 was dropped for the win-back branch. Win-back email track started, and is running.");
  await shot(page, "declined-record-win-back", { fullPage: true });

  await page.goto(`${f.url}/leads/people/${f.person("Tom")}`);
  await expect(campaigns).toContainText("Active");
  await expect(campaigns).toContainText("Declined on a call on Mon 9 Nov. No call is made to them again in this campaign; their other channels continue.");
  await expect(activityRegion.getByRole("listitem").filter({ hasText: "Call: not interested" })).toContainText("No more calls in this campaign; the other channels were kept going. Email track 1 carried on, and is running. Email track 2 starts after its delay, on Tue 10 Nov.");
  await shot(page, "declined-record-continue", { fullPage: true });

  await page.goto(`${f.url}/leads/people/${f.person("Grace Okafor")}`);
  await expect(campaigns).toContainText("Declined on call");
  await expect(campaigns).toContainText("Declined on a call on Mon 9 Nov. Their outreach in this campaign stopped there.");
  await expect(activityRegion.getByRole("listitem").filter({ hasText: "Call: not interested" })).toContainText("Stopped in this campaign. Email track 2 did not start: their outreach in this campaign stopped.");
  await shot(page, "declined-record-stop", { fullPage: true });

  // Leads lists each status in the words of the status vocabulary, and filters by it.
  await page.goto(`${f.url}/leads`);
  await expect(page.getByRole("row").filter({ hasText: "Amira Hassan" })).toContainText("In win-back");
  await expect(page.getByRole("row").filter({ hasText: "Grace Okafor" })).toContainText("Declined on call");
  await page.getByLabel("Status").selectOption({ label: "In win-back" });
  await expect(page.getByRole("row").filter({ hasText: "Amira Hassan" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Grace Okafor" })).toHaveCount(0);
});

test("a reply during win-back is any reply: automation stops, and the record says so from its read", async ({ page }) => {
  const f = await freshCalls("win-back", "declined-reply");
  const t = await focused(f);
  expect((await f.harness.request("POST", `/api/call-tasks/${t.taskId}/outcome`, { requestId: "reply-decline", outcome: "not_interested", numberId: t.numberId })).status).toBe(200);
  await f.harness.advanceTo(f.harness.clock + 10 * 60_000);
  f.harness.fake.prospectReplies("amira@harbourlanephysio.example", true, null);
  await f.harness.advanceTo(f.harness.clock + 10 * 60_000);
  await page.clock.setFixedTime(f.harness.clock);
  await page.goto(`${f.url}/leads/people/${f.person("Amira Hassan")}`);
  const campaigns = page.getByRole("region", { name: "Campaigns" });
  await expect(campaigns).toContainText("Replied, automation stopped");
  await expect(campaigns).toContainText("Declined on a call on Mon 9 Nov, and moved to this campaign’s win-back branch. No call is made to them again.");
  await expect(campaigns).not.toContainText("which is running");
  const activityRegion = page.getByRole("region", { name: "Activity" });
  await expect(activityRegion).toContainText("Replied by email");
  await expect(activityRegion.getByRole("listitem").filter({ hasText: "Call: not interested" })).toContainText("Win-back email track stopped: their outreach in this campaign stopped.");
  await shot(page, "declined-reply-in-win-back", { fullPage: true });
});

test("a decline logged in another window while this page is on the lead's other call: the call says why it left the list", async ({ page }) => {
  // Two phone tracks at entry: the page is on the second's call while the first is declined elsewhere.
  const f = await freshCalls("after-skip", "declined-other-call");
  const view = (await f.harness.request<CallsView>("GET", "/api/calls")).body;
  const amira = [...view.readyNow, ...view.laterToday].filter((x) => x.person?.name === "Amira Hassan");
  expect(amira).toHaveLength(2);
  const [first, second] = amira;
  await page.addInitScript((id) => window.sessionStorage.setItem("outreach.calls.focus", id), second!.taskId);
  await page.clock.setFixedTime(f.harness.clock);
  await page.goto(`${f.url}/calls`);
  await expect(page.getByRole("heading", { name: "Amira Hassan" })).toBeVisible();
  const number = (await f.harness.request<CallTaskView>("GET", `/api/call-tasks/${first!.taskId}`)).body.numbers.find((n) => !n.bad)?.detailId ?? null;
  // Declined there with continue: the second phone track is skipped as declined, and the lead keeps running.
  expect((await f.harness.request("POST", `/api/call-tasks/${first!.taskId}/outcome`, { requestId: "declined-elsewhere-continue", outcome: "not_interested", declinedPath: "continue", numberId: number })).status).toBe(200);
  // The page stays open: coming back to the window reads again (ADR 0003 4.4.1, "Freshness").
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert").filter({ hasText: "Open the next call" })).toContainText("Amira Hassan declined on another call, so no call is made to them again in this campaign and this call left the list.");
  await shot(page, "declined-other-call-off-list");
});

test("the demonstration (ticket 16): all three paths and an override, the main sequence replaced, no further cold call, and a reply stopping the lead in win-back", async ({ page }) => {
  // Recorded, each step lingers long enough to read.
  if (process.env["RECORD_DEMO"]) test.setTimeout(120_000);
  const f = await freshCalls("win-back", "declined-demonstration");
  await page.clock.install({ time: f.harness.clock });
  await page.goto(`${f.url}/calls`);
  // Amira: win back, as the phone track preselects; Tom: continue, overridden for him; Grace: stop, overridden for her.
  for (const [who, choice] of [["Amira Hassan", null], ["Tom", /Keep the email and SMS steps going/], ["Grace Okafor", /Stop all outreach in this campaign/]] as const) {
    await expect(page.getByRole("heading", { name: who })).toBeVisible();
    await outcome(page, "Not interested").click();
    await linger(page);
    if (choice) {
      await path(page, choice).check();
      await linger(page);
    }
    await logButton(page).click();
    await expect(outcomeStatus(page)).toContainText(`${who}: not interested logged.`);
    await linger(page);
  }
  // Amira's main sequence is replaced by the win-back branch.
  await page.goto(`${f.url}/leads/people/${f.person("Amira Hassan")}`);
  await expect(page.getByRole("region", { name: "Activity" })).toContainText("Email track 1 was dropped for the win-back branch.");
  await linger(page);
  // The next morning: none of the three is called again.
  await f.harness.advanceTo(f.harness.clock + 24 * 3_600_000);
  await page.clock.setSystemTime(f.harness.clock);
  await page.goto(`${f.url}/calls`);
  for (const who of ["Amira Hassan", "Tom", "Grace Okafor"]) expect(await queueNames(f)).not.toContain(who);
  await expect(page.getByRole("heading", { name: "Amira Hassan" })).toHaveCount(0);
  await linger(page);
  // Amira replies to a win-back email: the ordinary reply handoff.
  f.harness.fake.prospectReplies("amira@harbourlanephysio.example", true, null);
  await f.harness.advanceTo(f.harness.clock + 10 * 60_000);
  await page.clock.setSystemTime(f.harness.clock);
  await page.goto(`${f.url}/leads/people/${f.person("Amira Hassan")}`);
  await expect(page.getByRole("region", { name: "Campaigns" })).toContainText("Replied, automation stopped");
  await expect(page.getByRole("region", { name: "Activity" })).toContainText("Replied by email");
  await linger(page);
});
