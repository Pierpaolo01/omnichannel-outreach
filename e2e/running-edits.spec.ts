import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { CampaignDefinition, StepDefinition } from "../src/domain/sequence/definition.ts";
import type { Campaign, SequenceView } from "../src/shared/api.ts";
import { COPY, FAKE_INBOX, fakeProviderApp, type FakeProviderApp } from "./fake-provider.ts";
import { fixture } from "./support.ts";

/**
 * Editing a running campaign (ticket 19) on the app over the fake email provider: changes stay on the page, the page
 * says what each would do to the leads already running (the server's read), and Apply sends them. Fictitious data.
 */

const DAY = 24 * 3_600_000;

/**
 * EVIDENCE_DIR only: the running-edit panel as it is, light and dark, at 1360 px and at 390 px (the panel scrolled into
 * view, then the inspector's message), for the pull request.
 */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env["EVIDENCE_DIR"];
  if (!dir) return;
  const size = page.viewportSize();
  for (const width of [1360, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.getByTestId("running-changes").scrollIntoViewIfNeeded();
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${dir}/${name}-${scheme}-${width}.png` });
    }
  }
  await page.emulateMedia({ colorScheme: null });
  if (size) await page.setViewportSize(size);
}

/** When recording the demonstration, holds each step on screen long enough to read. */
const linger = async (page: Page) => {
  if (process.env["RECORD_DEMO"]) await page.waitForTimeout(2_500);
};
const third: StepDefinition = { ...COPY.second, id: "s3", waitDays: 3, body: "Hi {{first_name|there}},\n\nLast note from me on evening booking at {{company}}.\n\nAlex" };
const definition = (): CampaignDefinition => ({
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: [FAKE_INBOX],
  tracks: [{ id: "email", channel: "email", branch: "main", window: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 })), steps: [COPY.first, COPY.second, third], start: { kind: "entry" }, removed: false }],
});

test.describe("editing a running campaign", () => {
  let f: FakeProviderApp;
  let n = 0;
  test.beforeAll(async () => {
    f = await fakeProviderApp("running-edits");
  });
  /** A launched campaign whose leads have all had Email 1. */
  const running = async () => {
    const csv = { businessesCsv: readFileSync(fixture("businesses-run1.csv"), "utf8"), peopleCsv: readFileSync(fixture("people-run1.csv"), "utf8") };
    const id = (await f.harness.request<{ campaign: Campaign }>("POST", "/api/campaigns", { name: `Running edits ${++n}`, defaultTimezone: "Europe/London", ...csv })).body.campaign.id;
    await f.harness.defineSequence(id, definition());
    expect((await f.harness.launch(id)).status).toBe(200);
    await f.harness.advanceTo(f.harness.clock + 0.5 * DAY);
    return id;
  };
  const stored = async (id: string) => (await f.harness.request<SequenceView>("GET", `/api/campaigns/${id}/sequence`)).body.definition;

  test("a changed email and a removed one say what they do to running leads, and reach them only on Apply", async ({ page }) => {
    const id = await running();
    await page.goto(`${f.url}/campaigns/${id}?track=email`);
    await expect(page.getByRole("heading", { name: "This campaign is running" })).toBeVisible();
    await shot(page, "running-campaign-no-changes");
    await linger(page);
    await page.getByRole("button", { name: /^Email 2/ }).click();
    await page.getByLabel("Email 2 copy").fill("Hi {{first_name|there}},\n\nOne more idea for {{company}}: a waiting list for the evening slots.\n\nAlex");
    const panel = page.getByTestId("running-changes");
    await expect(panel.getByRole("heading", { name: "Changes not applied yet" })).toBeVisible();
    await expect(panel.getByText("Email track · Email 2")).toBeVisible();
    await expect(panel.getByText(/leads? will get the new copy/)).toBeVisible();
    expect((await stored(id)).tracks[0]!.steps[1]!.body).toBe(COPY.second.body);
    await shot(page, "running-campaign-copy-changed-not-applied");
    await linger(page);

    await page.getByRole("button", { name: /^Email 3/ }).click();
    await page.getByRole("button", { name: "Remove Email 3" }).click();
    await expect(panel.getByText(/not there yet will skip it/)).toBeVisible();
    await shot(page, "running-campaign-copy-changed-and-email-3-removed");
    await linger(page);
    await panel.getByRole("button", { name: "Apply to running leads" }).click();
    await expect(panel.getByRole("heading", { name: "This campaign is running" })).toBeVisible();
    await linger(page);
    await shot(page, "running-campaign-applied");
    // The updated copy and fallbacks for a real lead, after Apply.
    if (process.env["EVIDENCE_DIR"] || process.env["RECORD_DEMO"]) {
      await page.goto(`${f.url}/campaigns/${id}/before-launch`);
      await expect(page.getByText("a waiting list for the evening slots").first()).toBeVisible();
      await linger(page);
      const dir = process.env["EVIDENCE_DIR"];
      if (dir) {
        for (const width of [1360, 390]) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
          await page.getByText("a waiting list for the evening slots").first().scrollIntoViewIfNeeded();
          for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(400);
            await page.screenshot({ path: `${dir}/running-campaign-preview-after-apply-${scheme}-${width}.png` });
          }
        }
        await page.emulateMedia({ colorScheme: null });
        await page.setViewportSize({ width: 1360, height: 900 });
      }
    }
    const after = (await stored(id)).tracks[0]!.steps;
    expect(after.map((s) => [s.id, s.removed])).toEqual([["s1", false], ["s2", false], ["s3", true]]);
    expect(after[1]!.body).toContain("a waiting list for the evening slots");
  });

  test("an edit the save would refuse is said before Apply, and Discard puts the running copy back", async ({ page }) => {
    const id = await running();
    await page.goto(`${f.url}/campaigns/${id}?track=email`);
    await page.getByRole("button", { name: /^Email 2/ }).click();
    await page.getByLabel("Email 2 copy").fill("");
    const panel = page.getByTestId("running-changes");
    await expect(panel.getByText(/can’t be applied yet/)).toBeVisible();
    await expect(panel.getByRole("button", { name: "Apply to running leads" })).toBeDisabled();
    await shot(page, "running-campaign-refused-edit");
    await linger(page);
    await panel.getByRole("button", { name: "Discard changes" }).click();
    await expect(page.getByLabel("Email 2 copy")).toHaveValue(COPY.second.body);
  });

  test("a paused campaign is edited the same way; its leads take the change when it resumes", async ({ page }) => {
    const id = await running();
    expect((await f.harness.request("POST", `/api/campaigns/${id}/pause`, { requestId: `pause-${id}` })).status).toBe(200);
    await page.goto(`${f.url}/campaigns/${id}?track=email`);
    await page.getByRole("button", { name: /^Email 2/ }).click();
    await page.getByLabel("Days to wait before Email 2").fill("1");
    const panel = page.getByTestId("running-changes");
    await expect(panel.getByText("wait changed to 1 day")).toBeVisible();
    await shot(page, "paused-campaign-wait-changed-not-applied");
    await linger(page);
    await expect(panel.getByText(/will wait the new time/)).toBeVisible();
    await panel.getByRole("button", { name: "Apply to the paused campaign" }).click();
    await expect(panel.getByRole("heading", { name: "This campaign is paused" })).toBeVisible();
    expect((await stored(id)).tracks[0]!.steps[1]!.waitDays).toBe(1);
  });

  test("removing the only track keeps Apply and Discard in reach; keyboard Discard puts focus on the canvas (review bot and verifier on 7afa03d)", async ({ page }) => {
    const id = await running();
    await page.goto(`${f.url}/campaigns/${id}?track=email`);
    await page.getByRole("button", { name: "Remove this email track" }).click();
    const panel = page.getByTestId("running-changes");
    await expect(panel.getByRole("heading", { name: "Changes not applied yet" })).toBeVisible();
    await expect(panel.getByText("Email track · removed")).toBeVisible();
    await panel.getByRole("button", { name: "Discard changes" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: /^Email track/ })).toBeVisible();
    await expect(page.locator("#add-track")).toBeFocused();
  });

  test("a newer edit's read is waited for: Apply never goes on the read of an earlier draft (review bot on 7afa03d)", async ({ page }) => {
    const id = await running();
    await page.goto(`${f.url}/campaigns/${id}?track=email&step=s2`);
    await page.getByLabel("Email 2 copy").fill("A first change for {{company}}.");
    const panel = page.getByTestId("running-changes");
    await expect(panel.getByText(/leads? will get the new copy/)).toBeVisible();
    // The read for the next change is held: the earlier read must not stand in for it.
    const held: (() => Promise<void>)[] = [];
    await page.route("**/api/campaigns/*/sequence/impact", (route) => void held.push(() => route.continue()));
    await page.getByLabel("Days to wait before Email 2").fill("0");
    await expect(panel.getByText("Checking what this does to the leads…")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Apply to running leads" })).toBeDisabled();
    await expect.poll(() => held.length).toBeGreaterThan(0);
    for (const go of held.splice(0)) await go();
    await page.unroute("**/api/campaigns/*/sequence/impact");
    await expect(panel.getByText("wait changed to 0 days")).toBeVisible();
    await panel.getByRole("button", { name: "Apply to running leads" }).click();
    await expect(panel.getByRole("heading", { name: "This campaign is running" })).toBeVisible();
    expect((await stored(id)).tracks[0]!.steps[1]!.waitDays).toBe(0);
  });

  test("an email track added to a running phone-only campaign uses the connected inbox, as Apply sends it (verifier F4 on 7afa03d)", async ({ page }) => {
    const csv = { businessesCsv: readFileSync(fixture("businesses-run1.csv"), "utf8"), peopleCsv: readFileSync(fixture("people-run1.csv"), "utf8") };
    const id = (await f.harness.request<{ campaign: Campaign }>("POST", "/api/campaigns", { name: `Phone only ${++n}`, defaultTimezone: "Europe/London", ...csv })).body.campaign.id;
    await f.harness.defineSequence(id, {
      timezone: "Europe/London",
      callSkipLimitDays: 2,
      emailPool: [],
      smsPool: [],
      callScript: "Ask who books.",
      tracks: [{ id: "call", channel: "call", branch: "main", window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })), steps: [{ id: "c1", waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false }], start: { kind: "entry" }, removed: false }],
    });
    expect((await f.harness.launch(id)).status).toBe(200);
    await page.goto(`${f.url}/campaigns/${id}`);
    await page.getByRole("button", { name: "Add track" }).click();
    await page.getByRole("menuitem", { name: "Email track" }).click();
    await page.getByLabel("Email 1 subject").fill("Evening bookings at {{company}}");
    await page.getByLabel("Email 1 copy").fill("Hi {{first_name|there}}, a note about evening booking.");
    const panel = page.getByTestId("running-changes");
    await expect(panel.getByText("Email track · added")).toBeVisible();
    await expect(panel.getByText(/can’t be applied yet/)).toHaveCount(0);
    await panel.getByRole("button", { name: "Apply to running leads" }).click();
    await expect(panel.getByRole("heading", { name: "This campaign is running" })).toBeVisible();
    expect((await stored(id)).emailPool).toEqual([FAKE_INBOX]);
  });

  test("leaving inside the app asks first while changes are not applied: links and Back, with history and focus kept (review bot on 7afa03d and 93bed86)", async ({ page }) => {
    const id = await running();
    // One document from here on: the campaigns list, then the campaign by its link.
    await page.goto(`${f.url}/campaigns`);
    await page.getByRole("link", { name: `Running edits ${n}`, exact: true }).click();
    await page.getByRole("button", { name: /^Email track/ }).click();
    await page.getByRole("button", { name: /^Email 2/ }).click();
    await page.getByLabel("Email 2 copy").fill("Kept while I decide.");
    // Another tab of the same campaign keeps the editor: no question.
    await page.getByRole("link", { name: /^Before launch/ }).click();
    await page.getByRole("link", { name: "Sequence" }).click();
    const campaigns = page.getByRole("navigation", { name: "Areas" }).getByRole("link", { name: "Campaigns" });
    await campaigns.click();
    const question = page.getByRole("group").filter({ hasText: "Leave without applying your changes?" });
    await expect(question).toBeVisible();
    await question.getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(new RegExp(`/campaigns/${id}$`));
    // Focus goes back to the link the navigation started from (council on 93bed86, item 17).
    await expect(campaigns).toBeFocused();
    await expect(page.getByTestId("running-changes").getByRole("heading", { name: "Changes not applied yet" })).toBeVisible();
    // Back to the Before launch tab: the same campaign, no question. Then Back past the campaign: asked; Escape stays.
    await page.evaluate(() => history.back());
    await expect(page).toHaveURL(new RegExp(`/campaigns/${id}/before-launch$`));
    await page.evaluate(() => history.go(-2));
    await expect(question).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/campaigns/${id}/before-launch$`));
    await page.keyboard.press("Escape");
    await expect(question).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
    // The history was kept as it was: Forward still goes to the Sequence tab (review bot on 93bed86).
    await page.evaluate(() => history.forward());
    await expect(page).toHaveURL(new RegExp(`/campaigns/${id}$`));
    await expect(page.getByTestId("running-changes").getByRole("heading", { name: "Changes not applied yet" })).toBeVisible();
    // Back past the campaign again, and leave: it lands where Back was going, and nothing was applied.
    await page.evaluate(() => history.go(-3));
    await expect(question).toBeVisible();
    await question.getByRole("button", { name: "Leave and discard changes" }).click();
    await expect(page).toHaveURL(new RegExp(`/campaigns$`));
    expect((await stored(id)).tracks[0]!.steps[1]!.body).toBe(COPY.second.body);
  });

  test("a refused Apply is said in the panel, pointing at Apply; no Try again that would send nothing (council on 93bed86, item 10)", async ({ page }) => {
    const id = await running();
    await page.goto(`${f.url}/campaigns/${id}?track=email&step=s2`);
    await page.getByLabel("Email 2 copy").fill("A refused change for {{company}}.");
    const panel = page.getByTestId("running-changes");
    await expect(panel.getByText(/will get the new copy/)).toBeVisible();
    await page.route("**/api/campaigns/*/sequence", (route) =>
      route.request().method() === "PUT" ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "impact_changed", message: "What this change does changed since it was shown, so nothing was applied. Check what it does now, then apply again.", elsewhere: false } }) }) : route.continue(),
    );
    await panel.getByRole("button", { name: "Apply to running leads" }).click();
    await expect(panel.getByText(/^Not applied\. What this change does changed/)).toBeVisible();
    await expect(page.getByText("Your last change wasn’t saved.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await page.unroute("**/api/campaigns/*/sequence");
  });

  test("with every track removed, the canvas says what is true and offers Add (council on 93bed86, item 15)", async ({ page }) => {
    const id = await running();
    await page.goto(`${f.url}/campaigns/${id}?track=email`);
    await page.getByRole("button", { name: "Remove this email track" }).click();
    await expect(page.getByText("No tracks. Add one, or Discard to keep the running track.")).toBeVisible();
    await expect(page.getByText("This campaign launched with no track.")).toHaveCount(0);
    await expect(page.locator("#add-track")).toBeEnabled();
  });
});
