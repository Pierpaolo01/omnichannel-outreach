import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { BeforeLaunchView, Campaign, CallsView, CampaignDefinition, SequenceView } from "../src/shared/api.ts";
import { TWO_CHANNELS, fakeProviderApp } from "./fake-provider.ts";
import { WITH_A_CALL, phoneTrack } from "./screens.ts";
import { respond } from "./mocks.ts";
import { fixture } from "./support.ts";

/**
 * Ticket 14c, as the user uses it: the phone track on the canvas, its inspector, and calls in
 * Before launch. Nothing is dialled: a call is a task on the user's list. Launching and the call
 * task run on the app over the fake providers. All data is fictitious.
 */
async function newCampaign(page: Page, name: string): Promise<string> {
  const created = await page.request.post("/api/campaigns", { data: { name, businessesCsv: readFileSync(fixture("businesses-run1.csv"), "utf8"), peopleCsv: readFileSync(fixture("people-run1.csv"), "utf8") } });
  return ((await created.json()) as { campaign: Campaign }).campaign.id;
}
const saved = (page: Page) => expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
const stored = async (page: Page, id: string) => ((await (await page.request.get(`/api/campaigns/${id}/sequence`)).json()) as SequenceView).definition;

test.describe("the phone track on the canvas and in its inspector", () => {
  test("a phone track is added from the menu, beside the email track and after it, with its script, hours and skip limit saved", async ({ page }) => {
    const id = await newCampaign(page, "Calls beside email");
    await page.goto(`/campaigns/${id}`);
    await page.getByRole("button", { name: "Email track" }).click();
    await page.getByLabel("Email 1 subject").fill("Evening booking at {{company}}");
    await page.getByLabel("Email 1 copy").fill("Hi {{first_name|there}}, a note about evening booking.");
    await page.getByRole("button", { name: "Add track" }).click();
    await page.getByRole("menuitem", { name: "Phone track" }).click();

    // One call, starting at launch, with the defaults said.
    const inspector = page.getByTestId("inspector");
    await expect(inspector.getByRole("heading", { name: "Phone track" })).toBeVisible();
    await expect(inspector.getByText("One call", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Call script")).toBeFocused();
    await expect(page.getByLabel("Days before an unworked call is skipped")).toHaveValue("2");
    await expect(page.getByLabel("How this track starts")).toHaveValue("entry");
    await expect(inspector.getByRole("button", { name: "Monday", pressed: true })).toBeVisible();
    await expect(inspector.getByRole("button", { name: "Saturday", pressed: false })).toBeVisible();
    await expect(page.getByLabel("Calling starts at")).toHaveValue("9");
    await expect(inspector.getByText("Logging them on the Calls page arrives with the next release.", { exact: false })).toBeVisible();
    // The callback hold lasts until its outcome is logged, not until the time asked for (review bot on 72b7252; ADR 0003 2.3).
    await expect(inspector.getByText("pauses this lead’s other outreach in the campaign until you log the callback’s outcome; a missed callback stays on your list, overdue, until you do.", { exact: false })).toBeVisible();
    await expect(inspector.getByText("until the time the prospect asked for", { exact: false })).toHaveCount(0);
    // No declined path is chosen on a new phone track: none is checked, and what a declined call does meanwhile is
    // said as the engine reads it (question Q14). Win back waits for a win-back track, in the definition's words.
    const paths = inspector.getByRole("radiogroup", { name: "If they decline on the call" });
    await expect(paths.getByRole("radio", { checked: true })).toHaveCount(0);
    await expect(inspector.getByText("No path is chosen yet, so a declined call stops the lead in this campaign.")).toBeVisible();
    await expect(paths.getByRole("radio", { name: /^Win back/ })).toBeDisabled();
    await expect(inspector.getByText("The campaign has no win-back branch: add a track to the win-back branch, or choose stop or continue.")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Phone track: .*If declined: stop, not chosen yet\./ })).toBeVisible();
    // Together with the email track: both hang from Launch.
    await expect(page.getByRole("list", { name: "Tracks that start at launch" }).getByRole("button")).toHaveCount(2);

    await page.getByLabel("Call script").fill("Ask who books the evening appointments.");
    await page.getByLabel("Days before an unworked call is skipped").fill("3");
    await inspector.getByRole("button", { name: "Saturday" }).click();
    await page.getByLabel("Calling starts at").selectOption("10");
    await page.getByLabel("How this track starts").selectOption({ label: "After the email track" });
    await page.getByLabel("Days after that track finishes").fill("1");
    await saved(page);

    const def = await stored(page, id);
    const call = def.tracks.find((t) => t.channel === "call");
    expect(def.callScript).toBe("Ask who books the evening appointments.");
    expect(call).toMatchObject({ callSkipLimitDays: 3, start: { kind: "after", delayDays: 1 }, steps: [{ subject: "", body: "", waitDays: 0 }] });
    expect(call?.window).toEqual([1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 10, end: 17 })));

    // After the email track on the canvas, and still so after a reload.
    await page.reload();
    await expect(page.getByRole("list", { name: "Tracks after the email track" }).getByRole("button", { name: /^Phone track: / })).toBeVisible();
    await expect(page.getByLabel("Call script")).toHaveValue("Ask who books the evening appointments.");
  });

  test("a declined path and a win-back branch set over HTTP are drawn and kept when an edit is saved here (ticket 16a, drawn since 16b)", async ({ page }) => {
    const id = await newCampaign(page, "A branch set over HTTP");
    const branch = { id: "wb-1", channel: "email" as const, branch: "win_back" as const, window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })), steps: [{ id: "wb-1-s1", waitDays: 0, subject: "No pressure", body: "Understood, {{first_name|there}}.", threading: "new_subject" as const, removed: false }], start: { kind: "entry" as const }, removed: false };
    const def = { ...WITH_A_CALL, tracks: [...WITH_A_CALL.tracks.map((t) => (t.id === "call" ? { ...t, declinedPath: "win_back" as const } : t)), branch] };
    expect((await page.request.put(`/api/campaigns/${id}/sequence`, { data: def })).status()).toBe(200);
    await page.goto(`/campaigns/${id}?track=call`);
    const inspector = page.getByTestId("inspector");
    await expect(inspector.getByRole("radio", { name: /^Win back/ })).toBeChecked();
    await expect(inspector.getByRole("list", { name: "The win-back branch’s tracks" })).toContainText("Win-back email track · 1");
    // The branch is drawn in its own box, not as part of the main sequence, and nothing says it is not shown.
    const box = page.getByTestId("win-back-branch");
    await expect(box.getByRole("button", { name: /^Win-back email track: / })).toBeVisible();
    await expect(page.getByRole("list", { name: "Tracks that start at launch" }).getByRole("button", { name: /^Win-back/ })).toHaveCount(0);
    await expect(page.getByText("arrives with a later release", { exact: false }).filter({ hasText: "win-back" })).toHaveCount(0);
    await page.getByLabel("Call script").fill("Ask who looks after new patient bookings.");
    await saved(page);
    const after = await stored(page, id);
    expect(after.callScript).toBe("Ask who looks after new patient bookings.");
    expect(after.tracks.find((t) => t.id === "call")?.declinedPath).toBe("win_back");
    expect(after.tracks.find((t) => t.id === "wb-1")).toEqual(branch);
  });

  test("a track after the phone track says it waits for the call's outcome, and the phone track cannot be removed until it starts elsewhere", async ({ page }) => {
    const id = await newCampaign(page, "A track after a call");
    await page.request.put(`/api/campaigns/${id}/sequence`, { data: WITH_A_CALL });
    await page.goto(`/campaigns/${id}?track=email-2&step=none`);
    await expect(page.getByText("It waits for the call’s outcome", { exact: false })).toBeVisible();
    await page.goto(`/campaigns/${id}?track=call`);
    await page.getByRole("button", { name: "Remove this phone track" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Email track 2 starts after this one. Change how it starts first." })).toBeVisible();
    expect((await stored(page, id)).tracks.some((t) => t.id === "call" && !t.removed)).toBe(true);
  });

  test("the skip limit's hint is worded from the value shown: a phone track saved without its own limit shows the campaign's (council on 2cf1d90, item 4)", async ({ page }) => {
    const id = await newCampaign(page, "A call saved before 14c");
    // A phone track as saved before ticket 14c: no skip limit of its own.
    const older = { ...phoneTrack("call", { kind: "entry" }), callSkipLimitDays: undefined };
    await page.request.put(`/api/campaigns/${id}/sequence`, { data: { ...TWO_CHANNELS, emailPool: [], smsPool: [], callSkipLimitDays: 3, tracks: [...TWO_CHANNELS.tracks, older] } });
    await page.goto(`/campaigns/${id}?track=call`);
    await expect(page.getByLabel("Days before an unworked call is skipped")).toHaveValue("3");
    await expect(page.getByText("This phone track uses the campaign’s limit, 3 days, until you change it here.", { exact: false })).toBeVisible();
    await expect(page.getByText("2 days is the default", { exact: false })).toHaveCount(0);
  });

  test("a skip limit below 1 is said in place, once, as Not saved with its reason and no Try again, and nothing is saved until it is fixed (with the save rule of pull request 49)", async ({ page }) => {
    const id = await newCampaign(page, "Skip limit refused");
    await page.request.put(`/api/campaigns/${id}/sequence`, { data: WITH_A_CALL });
    await page.goto(`/campaigns/${id}?track=call`);
    let puts = 0;
    await page.route("**/api/campaigns/*/sequence", (route) => {
      if (route.request().method() === "PUT") puts++;
      return route.continue();
    });
    await page.getByLabel("Days before an unworked call is skipped").fill("0");
    const inspector = page.getByTestId("inspector");
    await expect(inspector.getByRole("status").filter({ hasText: "Not saved" })).toBeVisible();
    // One message: the reason, in place; no generic failure and nothing to try again.
    await expect(inspector.getByRole("alert")).toHaveCount(1);
    await expect(inspector.getByRole("alert")).toHaveText("Phone track: The call skip limit is a whole number of days, at least 1. Nothing is saved until this is fixed.");
    await expect(page.getByText("Your last change wasn’t saved.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await expect(page.getByText("Saving…")).toHaveCount(0);
    expect(puts).toBe(0);
    await page.getByLabel("Days before an unworked call is skipped").fill("4");
    await saved(page);
    expect((await stored(page, id)).tracks.find((t) => t.id === "call")?.callSkipLimitDays).toBe(4);
  });

  test("a second phone track is a second call the user places after the first, and Before launch withholds no figure because of it", async ({ page }) => {
    const id = await newCampaign(page, "Two calls");
    await page.request.put(`/api/campaigns/${id}/sequence`, { data: { ...TWO_CHANNELS, emailPool: [], smsPool: [], tracks: [...TWO_CHANNELS.tracks, phoneTrack("call", { kind: "entry" })] } });
    await page.goto(`/campaigns/${id}`);
    await page.getByRole("button", { name: "Add track" }).click();
    await page.getByRole("menuitem", { name: "Phone track" }).click();
    await expect(page.getByRole("heading", { name: "Phone track 2" })).toBeVisible();
    await page.getByLabel("How this track starts").selectOption({ label: "After phone track 1" });
    await page.getByLabel("Days after that track finishes").fill("2");
    await saved(page);
    await page.getByRole("link", { name: /Before launch/ }).click();
    // The running app has no email or SMS provider, so only those tracks hold the figure back; a phone
    // track after a phone track is projected under the stated assumption (ticket 14c).
    const reason = page.getByText("Can’t project the load until", { exact: false });
    await expect(reason).toBeVisible();
    await expect(reason).not.toContainText("phone");
  });
});

test.describe("calls in Before launch", () => {
  test("coverage, the empty-script warning and the calls row on the running app, where no email or SMS provider exists", async ({ page }) => {
    const id = await newCampaign(page, "Calls before launch");
    await page.request.put(`/api/campaigns/${id}/sequence`, { data: { ...WITH_A_CALL, callScript: "" } });
    await page.goto(`/campaigns/${id}/before-launch`);
    await expect(page.getByText("have a phone number")).toBeVisible();
    await expect(page.getByText("The call script is empty")).toBeVisible();
    // A phone track needs no sender, so it is named by no blocker.
    await expect(page.getByRole("region", { name: "Blocks launch" }).getByText(/phone track/i)).toHaveCount(0);
    const calls = page.getByRole("row", { name: /Your calls/ });
    await expect(calls).toContainText("At most 50 new calls a day");
    // No estimate here (no email or SMS provider), so Copy for a lead shows no day for any message,
    // and says why, rather than a day worked out another way (review bot on 93bcc0c).
    await expect(page.getByText("No day: no estimate").first()).toBeVisible();
    await expect(page.getByText(/^Day \d/)).toHaveCount(0);
  });

  test("over the fake providers: calls per day against the capacity and how long until every lead has started, then launch puts the calls on the list", async ({ page }) => {
    const f = await fakeProviderApp("phone-editor");
    expect((await f.harness.request("PUT", "/api/call-settings", { dailyCapacity: 2, userZone: "Europe/London" })).status).toBe(200);
    const id = await f.freshTwoChannelCampaign("Calls projected");
    await page.request.put(`${f.url}/api/campaigns/${id}/sequence`, { data: { ...TWO_CHANNELS, callScript: "Ask who books the evening appointments.", tracks: [...TWO_CHANNELS.tracks, phoneTrack("call", { kind: "entry" })] } });
    await page.goto(`${f.url}/campaigns/${id}/before-launch`);
    const calls = page.getByRole("row", { name: /Your calls/ });
    await expect(calls).toContainText("2 a day");
    await expect(calls).toContainText("of 2");
    await expect(page.getByText("A lead starts with its first email or text, or when its first call goes on your list.", { exact: false })).toBeVisible();
    await expect(page.getByText("For calls in this campaign, it assumes you log every call on your list at the end of the day it is there, after its calling hours, and that each one gets no answer", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Launch campaign" }).click();
    await expect(page.getByText(/^Launched .*\.$/)).toBeVisible();
    await f.harness.tick();
    const list = (await f.harness.request<CallsView>("GET", "/api/calls")).body;
    const mine = [...list.readyNow, ...list.laterToday].filter((c) => c.campaign.id === id);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((c) => c.track.label === "Phone track")).toBe(true);
  });

  test("with nothing blocking launch, the line says every email and SMS track has a sender: a phone track needs none (council on 2cf1d90, item 5)", async ({ page }) => {
    const f = await fakeProviderApp("phone-editor");
    const id = await f.freshTwoChannelCampaign("Nothing blocks");
    await page.request.put(`${f.url}/api/campaigns/${id}/sequence`, { data: { ...TWO_CHANNELS, callScript: "Ask who books.", tracks: [...TWO_CHANNELS.tracks, phoneTrack("call", { kind: "entry" })] } });
    await page.goto(`${f.url}/campaigns/${id}/before-launch`);
    await expect(page.getByText("every email and SMS track has a sender.", { exact: false })).toBeVisible();
  });

  test("with a win-back branch, a finished estimate says the branch's emails and texts are not counted; never without a live branch, nor with no figure (ticket 16a)", async ({ page }) => {
    // An app of its own: another test's running campaign on a shared app can hold work that withholds the figure.
    const f = await fakeProviderApp("win-back-before-launch");
    const branchTrack = { ...TWO_CHANNELS.tracks[0]!, id: "wb-1", branch: "win_back" as const, steps: TWO_CHANNELS.tracks[0]!.steps.slice(0, 1).map((st) => ({ ...st, id: "wb-1-s1" })) };
    const withBranch = (removed: boolean): CampaignDefinition => ({ ...TWO_CHANNELS, callScript: "Ask who books.", tracks: [...TWO_CHANNELS.tracks, phoneTrack("call", { kind: "entry" }, { declinedPath: removed ? "stop" : "win_back" }), { ...branchTrack, removed }] });
    const notCounted = "This campaign’s win-back emails and texts are not counted: the figures assume every call gets no answer, so nobody enters win-back.";
    const everyCounts = "Every email and text counts: tracks that start together and tracks that wait for another.";

    const branch = await f.freshTwoChannelCampaign("A win-back branch");
    expect((await page.request.put(`${f.url}/api/campaigns/${branch}/sequence`, { data: withBranch(false) })).status()).toBe(200);
    await page.goto(`${f.url}/campaigns/${branch}/before-launch`);
    await expect(page.getByText(notCounted, { exact: false })).toBeVisible();
    await expect(page.getByText("Every email and text of the main sequence counts", { exact: false })).toBeVisible();
    await expect(page.getByText(everyCounts, { exact: false })).toHaveCount(0);

    // A removed branch is no branch: every email and text counts, and nothing is said of win-back.
    const none = await f.freshTwoChannelCampaign("No live branch");
    expect((await page.request.put(`${f.url}/api/campaigns/${none}/sequence`, { data: withBranch(true) })).status()).toBe(200);
    await page.goto(`${f.url}/campaigns/${none}/before-launch`);
    await expect(page.getByText(everyCounts, { exact: false })).toBeVisible();
    await expect(page.getByText(notCounted, { exact: false })).toHaveCount(0);

    // A run that stopped early, or a withheld figure, shows no figure and says nothing of the branch (marked so in transit, with the flag left set).
    for (const change of [{ stoppedEarly: "horizon" as const, leadsToStart: null, daysUntilAllStart: null }, { withheldBy: { campaign: null, tracks: [{ trackId: "sms", channel: "sms" as const, label: "the SMS track", why: "no_sender" as const }] } }]) {
      await page.unrouteAll();
      await page.route("**/api/campaigns/*/before-launch?v=*", async (route) => {
        const body = (await (await route.fetch()).json()) as BeforeLaunchView;
        await respond(route, { ...body, load: body.load && { ...body.load, ...change, winBackNotCounted: true } });
      });
      await page.goto(`${f.url}/campaigns/${branch}/before-launch`);
      await expect(page.getByText("stoppedEarly" in change ? "runs past the estimate" : "the SMS track", { exact: false }).first()).toBeVisible();
      await expect(page.getByText(notCounted, { exact: false })).toHaveCount(0);
    }
  });

  test("a running campaign's phone track is read-only, and says why", async ({ page }) => {
    const f = await fakeProviderApp("phone-editor");
    const id = await f.freshTwoChannelCampaign("Running with a call");
    await f.harness.defineSequence(id, { ...TWO_CHANNELS, callScript: "Ask who books.", tracks: [...TWO_CHANNELS.tracks, phoneTrack("call", { kind: "entry" })] });
    expect((await f.harness.launch(id)).status).toBe(200);
    await page.goto(`${f.url}/campaigns/${id}?track=call`);
    await expect(page.getByText("This campaign is running. Editing a running campaign arrives with a later release.")).toBeVisible();
    // Read-only, not disabled: it can still be reached by keyboard, scrolled and copied.
    await expect(page.getByLabel("Call script")).not.toBeEditable();
    await expect(page.getByLabel("Call script")).toHaveValue("Ask who books.");
    await expect(page.getByLabel("Days before an unworked call is skipped")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Monday" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Remove this phone track" })).toHaveCount(0);
  });
});
