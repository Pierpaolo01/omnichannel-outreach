import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, fakeInstagramApp, IG_MONDAY_8, TEST_ACCOUNT, type FakeInstagramApp } from "./fake-instagram.ts";

/**
 * Ticket 25's demonstration (recorded with RECORD_DEMO=1; screenshots with EVIDENCE_DIR) and its states, on the **simulated**
 * Instagram provider with fictitious people, companies and accounts: an Instagram track built on the canvas, a test run to the
 * user's own test account, a launch on the simulated session, the first messages to a person's own account and to a company's,
 * a reply the user marks, and the measures. No Instagram session is connected: the session is labelled "Simulated Instagram
 * (not a session)" wherever it is named.
 */

const H = 3_600_000;

const linger = async (page: Page) => {
  if (process.env["RECORD_DEMO"]) await page.waitForTimeout(2_000);
};

async function at(page: Page, f: FakeInstagramApp, path: string): Promise<void> {
  await page.clock.setFixedTime(f.h.clock);
  await page.goto(f.url + path);
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env["EVIDENCE_DIR"];
  if (!dir) return;
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    // An animation cancelled while waited on rejects its `finished`: settle each, so a cancellation never fails a screenshot.
    await page.evaluate(() => Promise.allSettled(document.getAnimations().map((a) => a.finished)));
    await page.screenshot({ path: `${dir}/instagram-${name}-${theme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: null });
}

test("an Instagram track from the canvas through a test run, a launch, a marked reply and the measures", async ({ page }) => {
  test.setTimeout(180_000);
  const f = await fakeInstagramApp("fresh", "instagram-demonstration");
  const campaign = `/campaigns/${f.campaign}`;

  await test.step("the canvas: an Instagram track, its message request and a follow-up, by role", async () => {
    await at(page, f, campaign);
    await page.getByRole("button", { name: "Instagram track" }).click();
    await expect(page.getByLabel("Message request message")).toBeFocused();
    await page.getByLabel("Message request message").fill("Hi {{first_name|there}}, I help clinics like {{company}} fill evening slots. Could I send a short video?");
    await expect(page.getByText("Text only. To someone who doesn’t follow your session it arrives as a message request.")).toBeVisible();
    await page.getByRole("button", { name: "Add follow-up" }).click();
    await page.getByLabel("Follow-up 1 message").fill("{{first_name|Hi}}, shall I send the video over? A yes is enough.");
    // The track sends only from the sessions the user ticks (ADR 0004 13.5): none is ticked by itself.
    await expect(page.getByText("No session chosen. Choose at least one: launch is blocked until you do.")).toBeVisible();
    await page.getByRole("checkbox", { name: /^Simulated Instagram \(not a session\).*a business account/ }).check();
    await expect(page.getByText(/^Only the sessions you tick start this track’s conversations\./)).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Saved" }).first()).toBeVisible();
    await shot(page, "01-canvas");
    await linger(page);
  });

  await test.step("the test run: the user's own test account; the messages go there with minute waits; the user marks the reply", async () => {
    await page.getByRole("link", { name: "Test run" }).click();
    await page.getByLabel("Your Instagram account, for the messages").fill(TEST_ACCOUNT);
    await page.getByRole("button", { name: "Save contacts" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await page.getByLabel("Copy written for").selectOption({ label: "Pat Oneil" });
    await page.getByRole("button", { name: "Run test" }).click();
    await expect(page.getByRole("button", { name: "Test running" })).toBeVisible();
    await f.h.advanceTo(Date.parse("2026-11-02T09:10:00Z"));
    await at(page, f, `${campaign}/test-run`);
    expect(f.h.instagram.deliveryLog.map((d) => d.destination)).toEqual([TEST_ACCOUNT, TEST_ACCOUNT]);
    await expect(page.getByText(/^Sent /)).toHaveCount(2);
    await shot(page, "02-test-sent");
    await page.getByRole("button", { name: "Mark replied on Instagram" }).click();
    await page.getByRole("group").getByRole("button", { name: "Mark replied" }).click();
    await expect(page.getByText("Stopped by your reply")).toBeVisible();
    await shot(page, "03-test-marked-replied");
    await linger(page);
  });

  await test.step("Before launch and the launch, on the simulated session", async () => {
    await page.getByRole("link", { name: "Launch…" }).click();
    await expect(page.getByText("Ready to launch.")).toBeVisible();
    await expect(page.getByText(/have an Instagram account to message \(1 through their company’s\)/)).toBeVisible();
    await expect(page.getByText("1 lead has no Instagram account to message")).toBeVisible();
    await shot(page, "04-before-launch");
    await page.getByRole("button", { name: "Launch campaign" }).click();
    await expect(page.getByText(/^Launched .*\.$/)).toBeVisible();
    await linger(page);
  });

  await test.step("the first messages: Pat's own account, Nia's company's; Kim skipped, with the cause", async () => {
    await f.h.advanceTo(f.h.clock + 2 * H);
    expect(f.h.instagram.deliveryLog.filter((d) => d.destination !== TEST_ACCOUNT).map((d) => d.destination).sort()).toEqual([ACCOUNTS.pat, ACCOUNTS.quay].sort());
    await at(page, f, `/leads/people/${await f.person("Nia Cole")}`);
    await expect(page.getByText(/^The first message went to their company’s Instagram account from your business session/)).toBeVisible();
    await shot(page, "05-record-company-account");
    await at(page, f, `/leads/people/${await f.person("Kim Hart")}`);
    // Kim ends with no usable channel; Activity gives the skip its recorded cause.
    await expect(page.getByText("Neither they nor their company have an Instagram account in the import.")).toBeVisible();
    await shot(page, "06-record-skipped");
    await linger(page);
  });

  await test.step("Pat answers on Instagram: the user marks the reply, confirmed, and the lead is handed over on Instagram", async () => {
    await at(page, f, `/leads/people/${await f.person("Pat Oneil")}`);
    await expect(page.getByText(/^The first message went to their own Instagram account/)).toBeVisible();
    await page.getByRole("button", { name: "Mark replied on Instagram: Pat Oneil in" }).click();
    await expect(page.getByText(/^Mark them replied on Instagram\?/)).toBeVisible();
    await shot(page, "07-mark-replied-confirmation");
    await page.getByRole("group").getByRole("button", { name: "Mark replied on Instagram" }).click();
    await expect(page.getByText("Marked replied on Instagram. Carry on the conversation on Instagram.")).toBeVisible();
    await expect(page.getByText("You marked them replied on Instagram")).toBeVisible();
    await shot(page, "08-record-replied");
    await linger(page);
  });

  await test.step("the measures: messages sent, the reply marked, test-run facts counted as test; nothing about acceptance", async () => {
    await at(page, f, campaign);
    const row = page.getByRole("region", { name: "Outreach so far" }).locator("dt", { hasText: /^Instagram$/ }).locator("xpath=following-sibling::dd[1]");
    await expect(row).toContainText("4 messages sent (2 from test runs)");
    await expect(row).toContainText("2 marked replied (1 from test runs)");
    await page.getByRole("button", { name: "How these are counted" }).click();
    await expect(page.getByText(/nothing shows whether it was accepted or seen/)).toBeVisible();
    await shot(page, "09-measures");
    await linger(page);
  });
});

test.describe("Instagram's states", () => {
  test("with no session, launch is blocked by name, and nothing offers to connect one", async ({ page }) => {
    const f = await fakeInstagramApp("no-session");
    await at(page, f, `/campaigns/${f.campaign}/before-launch`);
    await expect(page.getByText(/has no connected Instagram session/).first()).toBeVisible();
    await expect(page.getByText(/connect/i).filter({ hasText: /Connect an?|Connect your/ })).toHaveCount(0);
    await shot(page, "10-blocked-no-session");
    await at(page, f, `/campaigns/${f.campaign}`);
    await page.getByRole("button", { name: /^Instagram track:/ }).click();
    await expect(page.getByText("No connected Instagram session.")).toBeVisible();
    // The provider read's own words: here the simulated provider's; the running application's say none is connected.
    await expect(page.getByText("Simulated Instagram (not a session): tests only.")).toBeVisible();
    await shot(page, "11-inspector-no-session");
  });

  test("the sender choice by keyboard: Space ticks a session, the save keeps it across a reload, and unticking the last blocks launch by name", async ({ page }) => {
    const f = await fakeInstagramApp("fresh", "sender-keyboard");
    await at(page, f, `/campaigns/${f.campaign}`);
    await page.getByRole("button", { name: "Instagram track" }).click();
    await page.getByLabel("Message request message").fill("Hello {{first_name|there}}.");
    const session = page.getByRole("checkbox", { name: /^Simulated Instagram \(not a session\)/ });
    // Reached from the field before it by Tab, never only by pointer.
    await session.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(session).toBeFocused();
    await expect(session).not.toBeChecked();
    await page.keyboard.press("Space");
    await expect(session).toBeChecked();
    await expect(page.getByRole("status").filter({ hasText: "Saved" }).first()).toBeVisible();
    // The page opened again from its address: what it shows comes from the saved definition.
    await at(page, f, `/campaigns/${f.campaign}`);
    await page.getByRole("button", { name: /^Instagram track:/ }).click();
    await expect(page.getByRole("checkbox", { name: /^Simulated Instagram \(not a session\)/ })).toBeChecked();
    await page.getByRole("checkbox", { name: /^Simulated Instagram \(not a session\)/ }).focus();
    await page.keyboard.press("Space");
    await expect(page.getByText("No session chosen. Choose at least one: launch is blocked until you do.")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Saved" }).first()).toBeVisible();
    await shot(page, "15-inspector-no-sender-chosen");
    await at(page, f, `/campaigns/${f.campaign}/before-launch`);
    await expect(page.getByText(/has no sender session chosen$/).first()).toBeVisible();
    await shot(page, "16-blocked-no-sender-chosen");
  });

  test("a session with no allowance sends nothing, and Today says why with no time", async ({ page }) => {
    const f = await fakeInstagramApp("no-allowance");
    expect(f.h.instagram.deliveryLog).toEqual([]);
    await at(page, f, "/");
    await expect(page.getByText(/Instagram messages? (that )?can’t go yet/).first()).toBeVisible();
    await shot(page, "12-today-no-allowance");
    await at(page, f, `/leads/people/${await f.person("Pat Oneil")}`);
    await shot(page, "13-record-no-allowance");
  });

  test("a running track's record and the second follow-up's wait", async ({ page }) => {
    const f = await fakeInstagramApp("running");
    await at(page, f, `/leads/people/${await f.person("Pat Oneil")}`);
    await expect(page.getByText(/^The first message went to their own Instagram account/)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Mark replied on Instagram/ })).toBeVisible();
    await shot(page, "14-record-running");
  });
});

test.describe("the sender choice and what has left the app (the council on 5a30b9f, item 5)", () => {
  const SESSION_1 = /^Simulated Instagram \(not a session\) ig-session-1/;
  const SESSION_2 = /^Simulated Instagram \(not a session\) ig-session-2/;

  test("two sessions ticked, one of them unable to send, said beside it", async ({ page }) => {
    const f = await fakeInstagramApp("two-sessions");
    await at(page, f, `/campaigns/${f.campaign}?track=ig`);
    await expect(page.getByRole("checkbox", { name: SESSION_1 })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: SESSION_2 })).toBeChecked();
    await expect(page.getByText("can’t send: the provider reports it unavailable")).toBeVisible();
    await page.getByRole("checkbox", { name: SESSION_2 }).scrollIntoViewIfNeeded();
    await shot(page, "17-sender-choice-two-sessions-one-cannot-send");
  });

  test("a stale tab's save is refused: what it typed is kept, and the saved version is offered", async ({ browser }) => {
    const f = await fakeInstagramApp("two-sessions", "two-sessions-stale");
    const context = await browser.newContext();
    const a = await context.newPage();
    const b = await context.newPage();
    for (const p of [a, b]) await at(p, f, `/campaigns/${f.campaign}?track=ig&step=ig-m1`);
    // Tab B unticks the session that cannot send, and its save lands.
    await b.getByRole("checkbox", { name: SESSION_2 }).uncheck();
    await expect(b.getByRole("status").filter({ hasText: "Saved" }).first()).toBeVisible();
    // Tab A, loaded before it, edits the message: refused, nothing of B's choice is overwritten.
    await a.getByLabel("Message request message").fill("Hi {{first_name|there}}, written in a tab that loaded earlier.");
    await expect(a.getByText("This campaign was changed elsewhere since this page loaded it.")).toBeVisible();
    await expect(a.getByRole("button", { name: "Load the saved version" })).toBeVisible();
    await shot(a, "18-stale-save-refused");
    await context.close();
  });

  test("the inspector at a narrow width", async ({ page }) => {
    const f = await fakeInstagramApp("two-sessions", "two-sessions-narrow");
    await page.setViewportSize({ width: 390, height: 844 });
    await at(page, f, `/campaigns/${f.campaign}?track=ig`);
    await expect(page.getByRole("checkbox", { name: SESSION_1 })).toBeVisible();
    // Nothing runs off the side of the page.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("checkbox", { name: SESSION_1 }).scrollIntoViewIfNeeded();
    await shot(page, "19-inspector-narrow");
  });

  test("a step claimed and not yet handed over: the record says nothing has gone out yet", async ({ page }) => {
    const f = await fakeInstagramApp("claimed");
    expect(f.h.clock).toBe(IG_MONDAY_8 + H + 60_000);
    expect(f.h.instagram.handoverLog).toHaveLength(1);
    const waiting = f.h.instagram.handoverLog[0]!.subjectId === (await f.enrollment("Pat Oneil")) ? "Nia Cole" : "Pat Oneil";
    await at(page, f, `/leads/people/${await f.person(waiting)}`);
    await expect(page.getByText(/^Nothing has gone out yet\./)).toBeVisible();
    await expect(page.getByText(/was handed over/)).toHaveCount(0);
    await shot(page, "20-record-claimed-not-handed-over");
  });
});
