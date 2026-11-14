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
    await expect(panel.getByText(/leads? will get it/)).toBeVisible();
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
    await panel.getByRole("button", { name: "Apply to running leads" }).click();
    await expect(panel.getByRole("heading", { name: "This campaign is running" })).toBeVisible();
    expect((await stored(id)).tracks[0]!.steps[1]!.waitDays).toBe(1);
  });
});
