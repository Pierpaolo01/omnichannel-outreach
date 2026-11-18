import { expect, test, type Page, type Request } from "@playwright/test";
import type { ActivityView, CampaignDetail, EnrollmentRead, LeadSearchResult } from "../src/shared/api.ts";
import { fakeCallsApp, type FakeCallsApp } from "./fake-provider.ts";
import { respond } from "./mocks.ts";
import { skipElsewhere } from "./screens.ts";

/**
 * Ticket 17b: pause, resume, skip, stop and restart on the person page, the campaign page and the campaigns list, on the
 * app over the fake providers (a campaign with an email track, a phone track, an email after the call and a win-back
 * branch; Monday 10:00 London). Nothing is dialled or sent to anyone; all data is fictitious.
 */

let fresh = 0;
const app = (name: string) => fakeCallsApp("win-back", `controls-${name}-${++fresh}`);

async function open(page: Page, f: FakeCallsApp, path: string): Promise<void> {
  await page.clock.setFixedTime(f.harness.clock);
  await page.goto(f.url + path);
}

/** Amira Hassan's campaign row on her record. */
const row = (page: Page) => page.getByRole("region", { name: "Campaigns" }).getByRole("listitem").filter({ hasText: "Clinics, London" }).first();
const press = (page: Page, control: string) => page.getByRole("button", { name: `${control}: Amira Hassan in Clinics, London` });
const confirmStrip = (page: Page) => page.getByRole("group").filter({ has: page.getByRole("button", { name: "Cancel" }) });

/** The controls the server recorded for a person, from its Activity read. */
async function controlsRecorded(f: FakeCallsApp, who: string): Promise<string[]> {
  const activity = (await f.harness.request<ActivityView>("GET", `/api/people/${f.person(who)}/activity`)).body;
  return activity.entries.flatMap((e) => (e.kind === "control" ? [e.action] : [])).reverse();
}

test("the person page: each control is offered as the read allows, confirmed with its preview, and said after from its answer", async ({ page }) => {
  const f = await app("person");
  await open(page, f, `/leads/people/${f.person("Amira Hassan")}`);
  await expect(row(page).getByText("Waiting on call")).toBeVisible();
  // One sentence: the call line says where they stand (council on 57d874f, item 4b).
  await expect(row(page).getByText("Their call is on today’s list.", { exact: false })).toBeVisible();
  await expect(row(page).getByText("Next: the call.")).toHaveCount(0);
  // Running: Pause, Skip this step and Stop; never a restart.
  await expect(row(page).getByRole("button")).toHaveText(["Pause", "Skip this step", "Stop"]);

  await test.step("pause, from the read's preview", async () => {
    await press(page, "Pause").click();
    await expect(confirmStrip(page)).toContainText("Nothing more goes out to them in this campaign and every wait freezes until you resume them. The call waits.");
    await expect(confirmStrip(page).getByRole("button", { name: "Pause" })).toBeFocused();
    await confirmStrip(page).getByRole("button", { name: "Pause" }).click();
    // What it did, only what changed; the row's sentence says the rest (item 4a).
    await expect(row(page).getByRole("status").filter({ hasText: /^Paused\.$/ })).toBeVisible();
    await expect(row(page).getByText("Paused", { exact: true })).toBeVisible();
    await expect(row(page).getByText("Paused before the call. Waiting times are frozen.")).toBeVisible();
    await expect(row(page).getByRole("button")).toHaveText(["Resume", "Skip this step", "Stop"]);
  });

  await test.step("resume", async () => {
    await press(page, "Resume").click();
    await confirmStrip(page).getByRole("button", { name: "Resume" }).click();
    await expect(row(page).getByRole("status").filter({ hasText: /^Resumed[.,]/ })).toBeVisible();
    await expect(row(page).getByText("Waiting on call")).toBeVisible();
  });

  await test.step("skip the call: never made, and the email after it is named", async () => {
    await press(page, "Skip this step").click();
    await expect(confirmStrip(page)).toContainText("The call is skipped and never made.");
    await confirmStrip(page).getByRole("button", { name: "Skip this step" }).click();
    await expect(row(page).getByRole("status").filter({ hasText: /^Call skipped\./ })).toBeVisible();
  });

  await test.step("stop, then resume from the next step", async () => {
    await press(page, "Stop").click();
    await expect(confirmStrip(page)).toContainText("Their outreach in this campaign stops: nothing more goes out and no call is listed.");
    await confirmStrip(page).getByRole("button", { name: "Stop" }).click();
    await expect(row(page).getByText("Stopped manually")).toBeVisible();
    await expect(row(page).getByRole("button")).toHaveText(["Resume from the next step", "Move to win-back"]);
    await press(page, "Resume from the next step").click();
    await expect(confirmStrip(page)).toContainText(/They resume at the next unsent step: .+\. Nothing already sent goes again\./);
    await confirmStrip(page).getByRole("button", { name: "Resume from the next step" }).click();
    await expect(row(page).getByRole("status").filter({ hasText: /^Resumed from the next step/ })).toBeVisible();
  });

  await test.step("stop again, then move to win-back: the preview names the branch's first step", async () => {
    await press(page, "Stop").click();
    await confirmStrip(page).getByRole("button", { name: "Stop" }).click();
    await expect(row(page).getByText("Stopped manually")).toBeVisible();
    await press(page, "Move to win-back").click();
    await expect(confirmStrip(page)).toContainText(/They move to this campaign’s win-back branch, starting with win-back email 1 of \d/);
    await confirmStrip(page).getByRole("button", { name: "Move to win-back" }).click();
    await expect(row(page).getByText("In win-back")).toBeVisible();
    await expect(row(page).getByRole("button", { name: /Move to win-back/ })).toHaveCount(0);
  });

  await test.step("Activity says each control once, in the past tense", async () => {
    const activity = page.getByRole("region", { name: "Activity" });
    for (const title of ["Paused by you", "Resumed by you", "Call skipped by you", "Resumed from the next step by you", "Moved to win-back by you"]) await expect(activity.getByText(title).first()).toBeVisible();
    expect(await controlsRecorded(f, "Amira Hassan")).toEqual(["pause", "resume", "skip", "stop", "resume_from_next_step", "stop", "move_to_win_back"]);
  });

  await test.step("Tom, her colleague, is unchanged", async () => {
    const tom = (await f.harness.request<LeadSearchResult>("GET", `/api/leads?q=Tom`)).body.rows.find((r) => r.name.startsWith("Tom"));
    expect(tom?.enrollments.map((e) => e.status)).toEqual(["waiting_on_call"]);
  });
});

test("by keyboard: Cancel and Escape return focus to the control; a confirmed control moves focus to what it did", async ({ page }) => {
  const f = await app("keyboard");
  await open(page, f, `/leads/people/${f.person("Amira Hassan")}`);
  await press(page, "Pause").focus();
  await page.keyboard.press("Enter");
  await expect(confirmStrip(page).getByRole("button", { name: "Pause" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(press(page, "Pause")).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(confirmStrip(page).getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(press(page, "Pause")).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(row(page).getByRole("status").filter({ hasText: /^Paused\.$/ })).toBeFocused();
});

test("a refusal is shown in place with the server's reason, and Dismiss returns focus to the row", async ({ page }) => {
  const f = await app("refused");
  await page.route("**/api/enrollments/*/controls", (route) => respond(route, { error: { code: "control_refused", message: "They are already paused." } }, 409));
  await open(page, f, `/leads/people/${f.person("Amira Hassan")}`);
  await press(page, "Pause").click();
  await confirmStrip(page).getByRole("button", { name: "Pause" }).click();
  const alert = row(page).getByRole("alert");
  await expect(alert).toContainText("Pause was not applied. They are already paused.");
  await expect(alert.getByRole("button", { name: "Dismiss" })).toBeFocused();
  await alert.getByRole("button", { name: "Dismiss" }).click();
  await expect(alert).toHaveCount(0);
  await expect(press(page, "Pause")).toBeFocused();
});

test("a reload mid-request sends the same request id again, and the control applies once", async ({ page }) => {
  const f = await app("reload");
  const bodies: string[] = [];
  page.on("request", (r: Request) => {
    if (r.method() === "POST" && r.url().includes("/controls")) bodies.push(r.postData() ?? "");
  });
  // The first send reaches the server, which applies it; its answer is lost on the way back.
  let first = true;
  await page.route("**/api/enrollments/*/controls", async (route) => {
    if (!first) return route.continue();
    first = false;
    await route.fetch();
    return route.abort("connectionreset");
  });
  await open(page, f, `/leads/people/${f.person("Amira Hassan")}`);
  await press(page, "Skip this step").click();
  await confirmStrip(page).getByRole("button", { name: "Skip this step" }).click();
  await expect(row(page).getByRole("status").filter({ hasText: "Not confirmed yet. It is being sent again, and it is applied only once." })).toBeVisible();
  await page.reload();
  await expect(row(page).getByRole("status").filter({ hasText: /^Call skipped\./ })).toBeVisible();
  const ids = bodies.map((b) => (JSON.parse(b) as { requestId: string }).requestId);
  expect(new Set(ids).size).toBe(1);
  expect(ids.length).toBeGreaterThanOrEqual(2);
  expect(await controlsRecorded(f, "Amira Hassan")).toEqual(["skip"]);
});

test("two tabs: a press that never answers in one tab is sent by the other with its original id, and applies once (verifier B2 on 8a1732a)", async ({ context }) => {
  const f = await app("tabs");
  const a = await context.newPage();
  const b = await context.newPage();
  const ids: string[] = [];
  for (const p of [a, b]) p.on("request", (r) => r.method() === "POST" && r.url().includes("/controls") && ids.push((JSON.parse(r.postData() ?? "{}") as { requestId: string }).requestId));
  // Tab A stays open; its own send never answers.
  await a.route("**/api/enrollments/*/controls", () => new Promise(() => undefined));
  await open(a, f, `/leads/people/${f.person("Amira Hassan")}`);
  await open(b, f, `/leads/people/${f.person("Amira Hassan")}`);
  await press(a, "Stop").click();
  await confirmStrip(a).getByRole("button", { name: "Stop" }).click();
  // Tab B sees the stored press and sends it with A's id: the lead is stopped once, while A's request still hangs.
  await expect(row(b).getByText("Stopped manually")).toBeVisible();
  await a.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(row(a).getByText("Stopped manually")).toBeVisible();
  expect(new Set(ids).size).toBe(1);
  expect(await controlsRecorded(f, "Amira Hassan")).toEqual(["stop"]);
});

test("a Skip confirmation left open on the call, confirmed after another tab skipped the call, is refused in place and skips nothing more (verifier B1 on 8a1732a)", async ({ page }) => {
  const f = await app("stale-skip");
  await open(page, f, `/leads/people/${f.person("Amira Hassan")}`);
  await press(page, "Skip this step").click();
  await expect(confirmStrip(page)).toContainText("The call is skipped and never made.");
  // This tab's reads are slow from now on: the confirmation stays as it was shown.
  await page.route("**/api/people/*", async (route) => {
    await new Promise((r) => setTimeout(r, 1_500));
    await route.continue();
  });
  // Another tab skips the call, on its own fresh read.
  const lead = (await f.harness.request<LeadSearchResult>("GET", `/api/leads?campaign=${f.campaign}`)).body.rows.find((r) => r.name === "Amira Hassan")?.enrollments[0]?.id ?? "";
  const fresh = (await f.harness.request<EnrollmentRead>("GET", `/api/enrollments/${lead}`)).body;
  const skipPreview = fresh.controls.find((c) => c.action === "skip");
  expect((await f.harness.request("POST", `/api/enrollments/${lead}/controls`, { requestId: "other-tab-skip", action: "skip", expect: { status: fresh.status, preview: skipPreview?.allowed ? skipPreview.digest : "" } })).status).toBe(200);
  await confirmStrip(page).getByRole("button", { name: "Skip this step" }).click();
  const alert = row(page).getByRole("alert");
  await expect(alert).toContainText("Skip this step was not applied. This lead changed since you confirmed this, so nothing was changed.");
  await expect(alert.getByRole("button", { name: "Dismiss" })).toBeFocused();
  const after = (await f.harness.request<EnrollmentRead>("GET", `/api/enrollments/${lead}`)).body;
  expect(after.tracks.flatMap((t) => t.steps.filter((s) => s.result === "skipped").map((s) => s.stepId))).toEqual(["c1"]);
});

for (const how of ["focus", "storage"] as const) {
  test(`a confirmation is a snapshot: Skip opened on the call, the call skipped elsewhere, the page reads again on ${how}; it still shows the call, says the row changed, and confirming is refused in place (council on 57d874f, item 1)`, async ({ page }) => {
    const f = await app(`snapshot-${how}`);
    await open(page, f, `/leads/people/${f.person("Amira Hassan")}`);
    await press(page, "Skip this step").click();
    await expect(confirmStrip(page)).toContainText("The call is skipped and never made.");
    await skipElsewhere(f, "Amira Hassan");
    if (how === "focus") await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    else await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "outreach.controls.elsewhere" })));
    await expect(confirmStrip(page)).toContainText("This row changed since you opened this.");
    await expect(confirmStrip(page)).toContainText("The call is skipped and never made.");
    await confirmStrip(page).getByRole("button", { name: "Skip this step" }).click();
    await expect(row(page).getByRole("alert")).toContainText(/Skip this step was not applied\. .+ since you confirmed .+, so nothing was changed\./);
    const lead = (await f.harness.request<LeadSearchResult>("GET", `/api/leads?campaign=${f.campaign}`)).body.rows.find((r) => r.name === "Amira Hassan")?.enrollments[0]?.id ?? "";
    const after = (await f.harness.request<EnrollmentRead>("GET", `/api/enrollments/${lead}`)).body;
    expect(after.tracks.flatMap((t) => t.steps.filter((x) => x.result === "skipped").map((x) => x.stepId))).toEqual(["c1"]);
  });
}

test("a confirmation waits, and says why, while another tab's press on the lead is on its way; the press is never dropped (council on 57d874f, item 2)", async ({ context }) => {
  const f = await app("busy");
  const a = await context.newPage();
  const b = await context.newPage();
  await b.route("**/api/enrollments/*/controls", () => new Promise(() => undefined));
  await a.route("**/api/enrollments/*/controls", () => new Promise(() => undefined));
  await open(a, f, `/leads/people/${f.person("Amira Hassan")}`);
  await open(b, f, `/leads/people/${f.person("Amira Hassan")}`);
  await press(a, "Pause").click();
  await press(b, "Stop").click();
  await confirmStrip(b).getByRole("button", { name: "Stop" }).click();
  await expect(confirmStrip(a)).toContainText("Another change to this lead is on its way.");
  await expect(confirmStrip(a).getByRole("button", { name: "Pause" })).toBeDisabled();
});

test("a confirmation the read no longer allows closes, and the control the read allows now is offered (review bot on 07fab27, P2)", async ({ page }) => {
  const f = await app("stale-confirmation");
  await open(page, f, `/campaigns/${f.campaign}`);
  await page.getByRole("button", { name: "Pause campaign: Clinics, London" }).click();
  await expect(page.getByRole("group")).toContainText("every waiting time freezes");
  // Another client pauses the campaign; the page reads again on focus.
  expect((await f.harness.request("POST", `/api/campaigns/${f.campaign}/pause`, { requestId: "elsewhere-pause" })).status).toBe(200);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("heading", { name: /^Paused since/ })).toBeVisible();
  await expect(page.getByRole("group")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Resume campaign: Clinics, London" })).toBeEnabled();
  // Focus goes to why it closed, never the page body (verifier F2 on 8a1732a; ticket 24b, re-check of a6c1700, item 11).
  await expect(page.getByText("Pause campaign was closed: the campaign was paused elsewhere since you opened it, so nothing was sent.")).toBeFocused();
  // The reverse: Resume's confirmation open while another client resumes it.
  await page.getByRole("button", { name: "Resume campaign: Clinics, London" }).click();
  await expect(page.getByRole("group")).toContainText("Each lead continues where it was");
  expect((await f.harness.request("POST", `/api/campaigns/${f.campaign}/resume`, { requestId: "elsewhere-resume" })).status).toBe(200);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("heading", { name: /^Paused since/ })).toHaveCount(0);
  await expect(page.getByRole("group")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pause campaign: Clinics, London" })).toBeEnabled();
  await expect(page.getByText("Resume campaign was closed: the campaign was resumed elsewhere since you opened it, so nothing was sent.")).toBeFocused();

  await page.goto(`${f.url}/leads/people/${f.person("Amira Hassan")}`);
  await press(page, "Pause").click();
  await expect(confirmStrip(page)).toBeVisible();
  const lead = (await f.harness.request<LeadSearchResult>("GET", `/api/leads?campaign=${f.campaign}`)).body.rows.find((r) => r.name === "Amira Hassan")?.enrollments[0]?.id ?? "";
  expect((await f.harness.request("POST", `/api/enrollments/${lead}/controls`, { requestId: "elsewhere-lead-pause", action: "pause" })).status).toBe(200);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(confirmStrip(page)).toHaveCount(0);
  await expect(press(page, "Resume")).toBeEnabled();
  await expect(page.getByText("Pause was closed: this row changed since you opened it, so nothing was sent. What it shows now is above.")).toBeFocused();
});

test("a campaign paused from the list and resumed from its page: the Paused banner's counts are its leads', its calls leave Today and Calls, and its leads say so", async ({ page }) => {
  const f = await app("campaign");
  await open(page, f, "/campaigns");
  const listRow = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Clinics, London", exact: true }) });
  await expect(listRow.getByText("Running", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pause campaign: Clinics, London" }).click();
  await expect(listRow.getByRole("group")).toContainText("Pause Clinics, London? Messages stop, its calls leave your list, and every waiting time freezes.");
  await listRow.getByRole("button", { name: "Pause campaign", exact: true }).click();
  await expect(listRow.getByText("Paused", { exact: true }).first()).toBeVisible();
  await expect(listRow.getByRole("heading", { name: "Paused since Mon 9 Nov at 10:00" })).toBeVisible();

  const detail = (await f.harness.request<CampaignDetail>("GET", `/api/campaigns/${f.campaign}`)).body;
  const leads = (await f.harness.request<LeadSearchResult>("GET", `/api/leads?campaign=${f.campaign}&limit=500`)).body.rows;
  // The banner's five groups, in the strip's rendering ("3waiting on you"; ticket 22's `GroupCounts`).
  const counts = (await listRow.getByRole("list", { name: "Leads in each status group" }).getByRole("listitem").allTextContents()).map((t) => parseInt(t, 10));
  expect(counts).toHaveLength(5);
  expect(counts.reduce((a, b) => a + b, 0)).toBe(leads.length);
  expect(counts.reduce((a, b) => a + b, 0)).toBe(detail.leadCount);

  await test.step("Today and Calls say why its calls are not on the list", async () => {
    await page.goto(`${f.url}/`);
    await expect(page.getByText(/calls in Clinics, London are off your list while the campaign is paused \(since Mon 9 Nov at 10:00\)\./)).toBeVisible();
    await page.goto(`${f.url}/calls`);
    await expect(page.getByText(/calls in Clinics, London are off your list while the campaign is paused/).first()).toBeVisible();
  });

  await test.step("its leads say the campaign is paused", async () => {
    await page.goto(`${f.url}/leads/people/${f.person("Amira Hassan")}`);
    await expect(row(page).getByText("(campaign paused)")).toBeVisible();
    await expect(row(page).getByText("The call is on hold while this campaign is paused.")).toBeVisible();
  });

  await test.step("resumed from the campaign's page", async () => {
    await page.goto(`${f.url}/campaigns/${f.campaign}`);
    await expect(page.getByRole("heading", { name: "Paused since Mon 9 Nov at 10:00" })).toBeVisible();
    await page.getByRole("button", { name: "Resume campaign: Clinics, London" }).click();
    await expect(page.getByRole("group")).toContainText("Resume Clinics, London? Each lead continues where it was, spread across the sending window.");
    await page.getByRole("group").getByRole("button", { name: "Resume campaign" }).click();
    await expect(page.getByText("Resumed. Each lead continued where it was.")).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Paused since/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Pause campaign: Clinics, London" })).toBeVisible();
  });
});

test("every lead confirmation another client closes says why and holds focus, in both themes (ticket 24b, re-check of a6c1700, item 11)", async ({ page }) => {
  for (const theme of ["light", "dark"] as const) {
    const f = await app(`closed-${theme}`);
    await page.emulateMedia({ colorScheme: theme });
    const lead = (await f.harness.request<LeadSearchResult>("GET", `/api/leads?campaign=${f.campaign}`)).body.rows.find((r) => r.name === "Amira Hassan")?.enrollments[0]?.id ?? "";
    let n = 0;
    const elsewhere = async (action: string) => expect((await f.harness.request("POST", `/api/enrollments/${lead}/controls`, { requestId: `elsewhere-${theme}-${++n}`, action })).status).toBe(200);
    // Open a control's confirmation by keyboard, let another client act, and read again: the reason line holds focus.
    const closedBy = async (control: string, other: string) => {
      await open(page, f, `/leads/people/${f.person("Amira Hassan")}`);
      await press(page, control).focus();
      await page.keyboard.press("Enter");
      await expect(confirmStrip(page)).toBeVisible();
      await elsewhere(other);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(confirmStrip(page)).toHaveCount(0);
      await expect(page.getByText(`${control} was closed: this row changed since you opened it, so nothing was sent. What it shows now is above.`)).toBeFocused();
    };
    await closedBy("Pause", "pause");
    await closedBy("Resume", "resume");
    await closedBy("Stop", "stop");
    await closedBy("Move to win-back", "resume_from_next_step");
    await elsewhere("stop");
    await closedBy("Resume from the next step", "move_to_win_back");
  }
});
