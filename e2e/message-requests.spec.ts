import { expect, test, type Page } from "@playwright/test";
import { MESSAGE_REQUEST_CHANNELS, type MessageRequestChannel } from "../src/domain/social-channels.ts";
import { accountsOf, fakeMessageRequestApp, MR_MONDAY_8, testAccountOf, trackIdOf, type FakeMessageRequestApp } from "./fake-message-requests.ts";

/**
 * The message-request channels' demonstration (recorded with RECORD_DEMO=1; screenshots with EVIDENCE_DIR) and states, once
 * per channel (Instagram, ticket 25; Facebook, ticket 26), on the **simulated** provider with fictitious people, companies
 * and accounts: a track built on the canvas, a test run to the user's own test account, a launch on the simulated session,
 * the first messages to a person's own account and to a company's, a reply the user marks, and the measures. Then both
 * channels in one campaign. No session of either channel is connected: a session is labelled "Simulated <channel> (not a
 * session)" wherever it is named.
 */

/**
 * Each channel's words on screen, written here by hand so the screens are checked against the wording the principal reviews,
 * not recomputed from the registry the screens read.
 */
const WORDS = {
  instagram: { Name: "Instagram", aName: "an Instagram", business: "a business account", yourBusiness: "your business session", noun: "account", testContactLimit: null },
  facebook: {
    Name: "Facebook",
    aName: "a Facebook",
    business: "a Page",
    yourBusiness: "your Page",
    noun: "profile",
    testContactLimit: "The app compares Facebook addresses as they are written: it can’t tell that a username and a number (profile.php?id=…) are the same account. Give your own account, never a lead’s.",
  },
} as const satisfies Record<MessageRequestChannel, { Name: string; aName: string; business: string; yourBusiness: string; noun: string; testContactLimit: string | null }>;

const H = 3_600_000;

const linger = async (page: Page) => {
  if (process.env["RECORD_DEMO"]) await page.waitForTimeout(2_000);
};

async function at(page: Page, f: FakeMessageRequestApp, path: string): Promise<void> {
  await page.clock.setFixedTime(f.h.clock);
  await page.goto(f.url + path);
}

async function shot(page: Page, channel: MessageRequestChannel | "together", name: string): Promise<void> {
  const dir = process.env["EVIDENCE_DIR"];
  if (!dir) return;
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    // An animation cancelled while waited on rejects its `finished`: settle each, so a cancellation never fails a screenshot.
    await page.evaluate(() => Promise.allSettled(document.getAnimations().map((a) => a.finished)));
    await page.screenshot({ path: `${dir}/${channel}-${name}-${theme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: null });
}

for (const channel of MESSAGE_REQUEST_CHANNELS) {
  const W = WORDS[channel];

  test(`${W.aName} track from the canvas through a test run, a launch, a marked reply and the measures`, async ({ page }) => {
    test.setTimeout(180_000);
    const f = await fakeMessageRequestApp(channel, "fresh", "demonstration");
    const campaign = `/campaigns/${f.campaign}`;

    await test.step("the canvas: a track, its message request and a follow-up, by role", async () => {
      await at(page, f, campaign);
      await page.getByRole("button", { name: `${W.Name} track` }).click();
      await expect(page.getByLabel("Message request message")).toBeFocused();
      await page.getByLabel("Message request message").fill("Hi {{first_name|there}}, I help clinics like {{company}} fill evening slots. Could I send a short video?");
      await expect(page.getByText("Text only. To someone who doesn’t follow your session it arrives as a message request.")).toBeVisible();
      await page.getByRole("button", { name: "Add follow-up" }).click();
      await page.getByLabel("Follow-up 1 message").fill("{{first_name|Hi}}, shall I send the video over? A yes is enough.");
      // The track sends only from the sessions the user ticks (ADR 0004 13.5): none is ticked by itself.
      await expect(page.getByText("No session chosen. Choose at least one: launch is blocked until you do.")).toBeVisible();
      await page.getByRole("checkbox", { name: new RegExp(`^Simulated ${W.Name} \\(not a session\\).*${W.business}`) }).check();
      await expect(page.getByText(/^Only the sessions you tick start this track’s conversations\./)).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "Saved" }).first()).toBeVisible();
      await shot(page, channel, "01-canvas");
      await linger(page);
    });

    await test.step("the test run: the user's own test account; the messages go there with minute waits; the user marks the reply", async () => {
      await page.getByRole("link", { name: "Test run" }).click();
      await page.getByLabel(`Your ${W.Name} ${W.noun}, for the messages`).fill(testAccountOf(channel));
      // What the app cannot tell about the test contact (ADR 0004 14.3; the council on f3c9014, item 1a): under the field
      // where it is given, and beside Run test, where a run with the channel's steps starts. Instagram has no such sentence.
      if (W.testContactLimit === null) await expect(page.getByText("compares", { exact: false })).toHaveCount(0);
      else {
        const said = page.getByText(W.testContactLimit, { exact: true });
        await expect(said).toHaveCount(2);
        await expect(said.last()).toBeVisible();
      }
      await page.getByRole("button", { name: "Save contacts" }).click();
      await expect(page.getByText("Saved.")).toBeVisible();
      await page.getByLabel("Copy written for").selectOption({ label: "Pat Oneil" });
      await page.getByRole("button", { name: "Run test" }).click();
      await expect(page.getByRole("button", { name: "Test running" })).toBeVisible();
      await f.h.advanceTo(Date.parse("2026-11-02T09:10:00Z"));
      await at(page, f, `${campaign}/test-run`);
      expect(f.h.social(channel).deliveryLog.map((d) => d.destination)).toEqual([testAccountOf(channel), testAccountOf(channel)]);
      await expect(page.getByText(/^Sent /)).toHaveCount(2);
      await shot(page, channel, "02-test-sent");
      await page.getByRole("button", { name: `Mark replied on ${W.Name}` }).click();
      await page.getByRole("group").getByRole("button", { name: "Mark replied" }).click();
      await expect(page.getByText("Stopped by your reply")).toBeVisible();
      await shot(page, channel, "03-test-marked-replied");
      await linger(page);
    });

    await test.step("Before launch and the launch, on the simulated session", async () => {
      await page.getByRole("link", { name: "Launch…" }).click();
      await expect(page.getByText("Ready to launch.")).toBeVisible();
      await expect(page.getByText(`have ${W.aName} account to message (1 through their company’s)`, { exact: false })).toBeVisible();
      await expect(page.getByText(`1 lead has no ${W.Name} account to message`)).toBeVisible();
      await shot(page, channel, "04-before-launch");
      await page.getByRole("button", { name: "Launch campaign" }).click();
      await expect(page.getByText(/^Launched .*\.$/)).toBeVisible();
      await linger(page);
    });

    await test.step("the first messages: Pat's own account, Nia's company's; Kim skipped, with the cause", async () => {
      await f.h.advanceTo(f.h.clock + 2 * H);
      expect(f.h.social(channel).deliveryLog.filter((d) => d.destination !== testAccountOf(channel)).map((d) => d.destination).sort()).toEqual([accountsOf(channel).pat, accountsOf(channel).quay].sort());
      await at(page, f, `/leads/people/${await f.person("Nia Cole")}`);
      await expect(page.getByText(`The first message went to their company’s ${W.Name} account from ${W.yourBusiness}`, { exact: false })).toBeVisible();
      await shot(page, channel, "05-record-company-account");
      await at(page, f, `/leads/people/${await f.person("Kim Hart")}`);
      // Kim ends with no usable channel; Activity gives the skip its recorded cause.
      await expect(page.getByText(`Neither they nor their company have ${W.aName} account in the import.`)).toBeVisible();
      await shot(page, channel, "06-record-skipped");
      await linger(page);
    });

    await test.step("Pat answers on the channel: the user marks the reply, confirmed, and the lead is handed over there", async () => {
      await at(page, f, `/leads/people/${await f.person("Pat Oneil")}`);
      await expect(page.getByText(`The first message went to their own ${W.Name} account`, { exact: false })).toBeVisible();
      await page.getByRole("button", { name: `Mark replied on ${W.Name}: Pat Oneil in` }).click();
      await expect(page.getByText(`Mark them replied on ${W.Name}?`, { exact: false })).toBeVisible();
      await shot(page, channel, "07-mark-replied-confirmation");
      await page.getByRole("group").getByRole("button", { name: `Mark replied on ${W.Name}` }).click();
      await expect(page.getByText(`Marked replied on ${W.Name}. Carry on the conversation on ${W.Name}.`)).toBeVisible();
      await expect(page.getByText(`You marked them replied on ${W.Name}`)).toBeVisible();
      await shot(page, channel, "08-record-replied");
      await linger(page);
    });

    await test.step("the measures: messages sent, the reply marked, test-run facts counted as test; nothing about acceptance", async () => {
      await at(page, f, campaign);
      const row = page.getByRole("region", { name: "Outreach so far" }).locator("dt", { hasText: new RegExp(`^${W.Name}$`) }).locator("xpath=following-sibling::dd[1]");
      await expect(row).toContainText("4 messages sent (2 from test runs)");
      await expect(row).toContainText("2 marked replied (1 from test runs)");
      await page.getByRole("button", { name: "How these are counted" }).click();
      await expect(page.getByText(/nothing shows whether it was accepted or seen/)).toBeVisible();
      await shot(page, channel, "09-measures");
      await linger(page);
    });
  });

  test.describe(`${W.Name}'s states`, () => {
    test("with no session, launch is blocked by name, and nothing offers to connect one", async ({ page }) => {
      const f = await fakeMessageRequestApp(channel, "no-session");
      await at(page, f, `/campaigns/${f.campaign}/before-launch`);
      await expect(page.getByText(`has no connected ${W.Name} session`, { exact: false }).first()).toBeVisible();
      await expect(page.getByText(/connect/i).filter({ hasText: /Connect an?|Connect your/ })).toHaveCount(0);
      await shot(page, channel, "10-blocked-no-session");
      await at(page, f, `/campaigns/${f.campaign}`);
      await page.getByRole("button", { name: new RegExp(`^${W.Name} track:`) }).click();
      await expect(page.getByText(`No connected ${W.Name} session.`)).toBeVisible();
      // The provider read's own words: here the simulated provider's; the running application's say none is connected.
      await expect(page.getByText(`Simulated ${W.Name} (not a session): tests only.`)).toBeVisible();
      await shot(page, channel, "11-inspector-no-session");
    });

    test("the sender choice by keyboard: Space ticks a session, the save keeps it across a reload, and unticking the last blocks launch by name", async ({ page }) => {
      const f = await fakeMessageRequestApp(channel, "fresh", "sender-keyboard");
      await at(page, f, `/campaigns/${f.campaign}`);
      await page.getByRole("button", { name: `${W.Name} track` }).click();
      await page.getByLabel("Message request message").fill("Hello {{first_name|there}}.");
      const session = page.getByRole("checkbox", { name: new RegExp(`^Simulated ${W.Name} \\(not a session\\)`) });
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
      await page.getByRole("button", { name: new RegExp(`^${W.Name} track:`) }).click();
      await expect(page.getByRole("checkbox", { name: new RegExp(`^Simulated ${W.Name} \\(not a session\\)`) })).toBeChecked();
      await page.getByRole("checkbox", { name: new RegExp(`^Simulated ${W.Name} \\(not a session\\)`) }).focus();
      await page.keyboard.press("Space");
      await expect(page.getByText("No session chosen. Choose at least one: launch is blocked until you do.")).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "Saved" }).first()).toBeVisible();
      await shot(page, channel, "15-inspector-no-sender-chosen");
      await at(page, f, `/campaigns/${f.campaign}/before-launch`);
      await expect(page.getByText(/has no sender session chosen$/).first()).toBeVisible();
      await shot(page, channel, "16-blocked-no-sender-chosen");
    });

    test("a session with no allowance sends nothing, and Today says why with no time", async ({ page }) => {
      const f = await fakeMessageRequestApp(channel, "no-allowance");
      expect(f.h.social(channel).deliveryLog).toEqual([]);
      await at(page, f, "/");
      await expect(page.getByText(new RegExp(`${W.Name} messages? (that )?can’t go yet`)).first()).toBeVisible();
      await shot(page, channel, "12-today-no-allowance");
      await at(page, f, `/leads/people/${await f.person("Pat Oneil")}`);
      await shot(page, channel, "13-record-no-allowance");
    });

    test("a running track's record and the second follow-up's wait", async ({ page }) => {
      const f = await fakeMessageRequestApp(channel, "running");
      await at(page, f, `/leads/people/${await f.person("Pat Oneil")}`);
      await expect(page.getByText(`The first message went to their own ${W.Name} account`, { exact: false })).toBeVisible();
      await expect(page.getByRole("button", { name: new RegExp(`^Mark replied on ${W.Name}`) })).toBeVisible();
      await shot(page, channel, "14-record-running");
    });
  });

  test.describe(`${W.Name}: the sender choice and what has left the app (the council on 5a30b9f, item 5)`, () => {
    const SESSION_1 = new RegExp(`^Simulated ${W.Name} \\(not a session\\) session-1`);
    const SESSION_2 = new RegExp(`^Simulated ${W.Name} \\(not a session\\) session-2`);
    const track = trackIdOf(channel);

    test("two sessions ticked, one of them unable to send, said beside it", async ({ page }) => {
      const f = await fakeMessageRequestApp(channel, "two-sessions");
      await at(page, f, `/campaigns/${f.campaign}?track=${track}`);
      await expect(page.getByRole("checkbox", { name: SESSION_1 })).toBeChecked();
      await expect(page.getByRole("checkbox", { name: SESSION_2 })).toBeChecked();
      await expect(page.getByText("can’t send: the provider reports it unavailable")).toBeVisible();
      await page.getByRole("checkbox", { name: SESSION_2 }).scrollIntoViewIfNeeded();
      await shot(page, channel, "17-sender-choice-two-sessions-one-cannot-send");
    });

    test("a stale tab's save is refused: what it typed is kept, and the saved version is offered", async ({ browser }) => {
      const f = await fakeMessageRequestApp(channel, "two-sessions", "two-sessions-stale");
      const context = await browser.newContext();
      const a = await context.newPage();
      const b = await context.newPage();
      for (const p of [a, b]) await at(p, f, `/campaigns/${f.campaign}?track=${track}&step=${track}-m1`);
      // Tab B unticks the session that cannot send, and its save lands.
      await b.getByRole("checkbox", { name: SESSION_2 }).uncheck();
      await expect(b.getByRole("status").filter({ hasText: "Saved" }).first()).toBeVisible();
      // Tab A, loaded before it, edits the message: refused, nothing of B's choice is overwritten.
      await a.getByLabel("Message request message").fill("Hi {{first_name|there}}, written in a tab that loaded earlier.");
      await expect(a.getByText("This campaign was changed elsewhere since this page loaded it.")).toBeVisible();
      await expect(a.getByRole("button", { name: "Load the saved version" })).toBeVisible();
      await shot(a, channel, "18-stale-save-refused");
      await context.close();
    });

    test("the inspector at a narrow width", async ({ page }) => {
      const f = await fakeMessageRequestApp(channel, "two-sessions", "two-sessions-narrow");
      await page.setViewportSize({ width: 390, height: 844 });
      await at(page, f, `/campaigns/${f.campaign}?track=${track}`);
      await expect(page.getByRole("checkbox", { name: SESSION_1 })).toBeVisible();
      // Nothing runs off the side of the page.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.getByRole("checkbox", { name: SESSION_1 }).scrollIntoViewIfNeeded();
      await shot(page, channel, "19-inspector-narrow");
    });

    test("a step claimed and not yet handed over: the record says nothing has gone out yet", async ({ page }) => {
      const f = await fakeMessageRequestApp(channel, "claimed");
      expect(f.h.clock).toBe(MR_MONDAY_8 + H + 60_000);
      expect(f.h.social(channel).handoverLog).toHaveLength(1);
      const waiting = f.h.social(channel).handoverLog[0]!.subjectId === (await f.enrollment("Pat Oneil")) ? "Nia Cole" : "Pat Oneil";
      await at(page, f, `/leads/people/${await f.person(waiting)}`);
      await expect(page.getByText(/^Nothing has gone out yet\./)).toBeVisible();
      await expect(page.getByText(/was handed over/)).toHaveCount(0);
      await shot(page, channel, "20-record-claimed-not-handed-over");
    });
  });
}

test.describe("Instagram and Facebook in one campaign (ADR 0004 14.6)", () => {
  test("each channel's track is its own conversation on the record, the canvas and the measures; a reply marked on one channel is said on that channel", async ({ page }) => {
    const f = await fakeMessageRequestApp("together", "running");
    // Pat's own account on each channel, from each channel's own session.
    for (const c of MESSAGE_REQUEST_CHANNELS) expect(f.h.social(c).deliveryLog.filter((d) => d.destination === accountsOf(c).pat)).toHaveLength(1);
    await at(page, f, `/campaigns/${f.campaign}`);
    await expect(page.getByRole("button", { name: /^Instagram track:/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Facebook track:/ })).toBeVisible();
    await shot(page, "together", "01-canvas-both-tracks");
    await at(page, f, `/leads/people/${await f.person("Pat Oneil")}`);
    await expect(page.getByText("The first message went to their own Instagram account from your business session", { exact: false })).toBeVisible();
    await expect(page.getByText("The first message went to their own Facebook account from your Page", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark replied on Instagram: Pat Oneil in" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark replied on Facebook: Pat Oneil in" })).toBeVisible();
    await shot(page, "together", "02-record-both-channels");
    await page.getByRole("button", { name: "Mark replied on Facebook: Pat Oneil in" }).click();
    await page.getByRole("group").getByRole("button", { name: "Mark replied on Facebook" }).click();
    await expect(page.getByText("Marked replied on Facebook. Carry on the conversation on Facebook.")).toBeVisible();
    await expect(page.getByText("You marked them replied on Facebook")).toBeVisible();
    await expect(page.getByText("You marked them replied on Instagram")).toHaveCount(0);
    await shot(page, "together", "03-record-replied-on-facebook");
    await at(page, f, `/campaigns/${f.campaign}`);
    const region = page.getByRole("region", { name: "Outreach so far" });
    const row = (name: string) => region.locator("dt", { hasText: new RegExp(`^${name}$`) }).locator("xpath=following-sibling::dd[1]");
    await expect(row("Instagram")).toContainText("2 messages sent");
    await expect(row("Facebook")).toContainText("2 messages sent");
    await expect(row("Facebook")).toContainText("1 lead marked replied");
    await expect(row("Instagram")).toContainText("0 leads marked replied");
    await shot(page, "together", "04-measures-both-channels");
  });
});
