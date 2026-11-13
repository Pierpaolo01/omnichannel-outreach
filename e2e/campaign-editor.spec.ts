import { readFileSync } from "node:fs";
import { expect, test, type Browser, type Page, type Route } from "@playwright/test";
import type { CampaignDefinition, StepDefinition } from "../src/domain/sequence/definition.ts";
import type { Campaign, EnrollmentView, SequenceView } from "../src/shared/api.ts";
import { COPY, FAKE_INBOX, fakeProviderApp, type FakeProviderApp } from "./fake-provider.ts";
import { serverError } from "./mocks.ts";
import { fixture } from "./support.ts";

/**
 * The campaign editor and the timeline, as the user uses them (ticket 12c). On the running app
 * there is no email provider, so launch is blocked by "no connected sender". Launch, sends,
 * bounces and replies run on the app over the fake provider; none of it is provider proof.
 */
const H = 3_600_000;
const DAY = 24 * H;

async function newCampaign(request: { post: (url: string, options: { data: unknown }) => Promise<{ json: () => Promise<unknown> }> }, name: string): Promise<string> {
  const res = await request.post("/api/campaigns", {
    data: { name, defaultTimezone: "Europe/London", businessesCsv: readFileSync(fixture("businesses-run1.csv"), "utf8"), peopleCsv: readFileSync(fixture("people-run1.csv"), "utf8") },
  });
  return ((await res.json()) as { campaign: Campaign }).campaign.id;
}

async function writeEmailTrack(page: Page) {
  await page.getByRole("button", { name: "Email track" }).click();
  await page.getByLabel("Email 1 subject").fill("Evening bookings at {{company}}");
  await page.getByLabel("Email 1 copy").fill("Hi {{first_name}},\n\nOnline booking at {{company}} stops at 18:00.\n\nAlex");
  // The fallback field under the email rewrites every use of the field.
  await page.getByLabel("Fallback for first name").fill("there");
  await page.getByRole("button", { name: "Add follow-up" }).click();
  await page.getByLabel("Days to wait before Email 2").fill("2");
  await page.getByLabel("Email 2 copy").fill("A quick follow-up, {{first_name|there}}.");
}

test.describe("on the running app, with no email provider connected", () => {
  test("the user writes an email track; it is saved, and launch is blocked only by the missing sender", async ({ page, request }) => {
    const id = await newCampaign(request, "Editor, no sender");
    await page.goto(`/campaigns/${id}`);
    await writeEmailTrack(page);
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    // Continue thread is the follow-up's default; the sending window starts on weekdays, 09:00 to 17:00.
    await expect(page.getByRole("radio", { name: "Continue thread" })).toBeChecked();
    await page.getByRole("button", { name: "Saturday" }).click();
    await page.getByLabel("Sending starts at").selectOption("8");
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

    // The open track and email are in the address, so a reload comes back to them.
    await page.reload();
    await expect(page.getByRole("button", { name: /^Email track: 2 emails over 2 days/ })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Email 1", exact: false }).first().click();
    await expect(page.getByLabel("Email 1 copy")).toHaveValue("Hi {{first_name|there}},\n\nOnline booking at {{company}} stops at 18:00.\n\nAlex");
    await expect(page.getByRole("button", { name: "Saturday" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Sending starts at")).toHaveValue("8");
    await expect(page.getByText("No connected sender inbox.")).toBeVisible();
    // The reason, from GET /api/email-provider: this run has no email provider set up.
    await expect(page.getByText("No email provider is set up on this machine.")).toBeVisible();

    await page.getByRole("link", { name: /Before launch/ }).click();
    await expect(page.getByText("1 thing blocks launch.")).toBeVisible();
    await expect(page.getByText("The email track has no connected sender inbox")).toBeVisible();
    await expect(page.getByRole("button", { name: "Launch campaign" })).toBeDisabled();
    // The copy still renders for a real imported lead.
    await expect(page.getByText("Online booking at Harbour Lane Physio stops at 18:00.")).toBeVisible();
  });

  test("the canvas and inspector work from the keyboard", async ({ page, request }) => {
    const id = await newCampaign(request, "Editor, keyboard");
    await page.goto(`/campaigns/${id}`);
    await page.getByRole("button", { name: "Email track" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Email 1 subject")).toBeVisible();
    await page.getByRole("button", { name: "Close the email track" }).focus();
    await page.keyboard.press("Enter");
    const node = page.getByRole("button", { name: /^Email track: 1 email/ });
    await node.focus();
    await expect(node).toBeFocused();
    await page.keyboard.press("Space");
    await expect(node).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("on the app over the fake email provider", () => {
  let f: FakeProviderApp;
  test.beforeAll(async () => {
    f = await fakeProviderApp();
  });

  test("the preview switches between real leads, and a blocker is fixed where it is named", async ({ page }) => {
    await page.goto(`${f.url}/campaigns/${f.blocked}/before-launch`);
    await expect(page.getByText("Lead 1 of 6")).toBeVisible();
    const first = await page.getByLabel("Preview as lead").inputValue();
    await page.getByRole("button", { name: "Next lead" }).click();
    await expect(page.getByText("Lead 2 of 6")).toBeVisible();
    expect(await page.getByLabel("Preview as lead").inputValue()).not.toBe(first);

    // The blocked campaign is shared by the scans, so the fix is checked without saving it.
    await page.route("**/api/campaigns/*/sequence", (route) => (route.request().method() === "PUT" ? new Promise(() => undefined) : route.continue()));
    await page.getByRole("button", { name: "Add fallback" }).click();
    await expect(page).toHaveURL(/track=email&step=s1/);
    await expect(page.getByText("2 leads don’t have it. Add a fallback or remove the field.")).toBeVisible();
    const held = page.waitForRequest((r) => r.method() === "PUT");
    await page.getByLabel("Fallback for first name").fill("there");
    await expect(page.getByLabel("Email 1 copy")).toHaveValue("Hi {{first_name|there}}, a note for {{company}}.");
    // Held by the route above, so the shared campaign stays blocked when the page closes.
    await held;
  });

  test("demonstration: write, preview and launch an email track; see sends, a bounce, a reply and the end on the timeline", async ({ page }) => {
    test.setTimeout(120_000);
    const demo = await fakeProviderApp("demonstration");
    const h = demo.harness;
    const csv = { businessesCsv: readFileSync(fixture("businesses-run1.csv"), "utf8"), peopleCsv: readFileSync(fixture("people-run1.csv"), "utf8") };
    const { campaign } = (await h.request<{ campaign: Campaign }>("POST", "/api/campaigns", { name: "Sports clinics, Exeter", defaultTimezone: "Europe/London", ...csv })).body;

    await page.goto(`${demo.url}/campaigns`);
    await page.getByRole("link", { name: "Open Sports clinics, Exeter" }).click();
    await writeEmailTrack(page);
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

    await page.getByRole("link", { name: "Launch…" }).click();
    await expect(page.getByText("Ready to launch.")).toBeVisible();
    await page.getByRole("button", { name: "Next lead" }).click();
    await page.getByLabel("Preview as lead").selectOption({ label: "Riverside Sports Clinic (company lead)" });
    await expect(page.getByText("Hi there,").first()).toBeVisible();
    await page.getByRole("button", { name: "Launch campaign" }).click();
    await expect(page.getByText(/^Launched .*\.$/)).toBeVisible();
    await expect(page.getByText("Running").first()).toBeVisible();

    // Monday: the first emails go; one address bounces and one lead replies. Wednesday: follow-ups.
    h.fake.bouncing.add("info@riversidesports.example");
    const start = h.clock;
    await h.advanceTo(start + 6 * H);
    h.fake.prospectReplies("daniel@elmstreetchiro.example");
    await h.advanceTo(start + 4 * DAY);

    const rows = (await h.request<{ rows: { id: string; kind: string; name: string; enrollments: EnrollmentView[] }[] }>("GET", `/api/leads?campaign=${campaign.id}&limit=500`)).body.rows;
    const person = (name: string) => rows.find((r) => r.name === name)?.id ?? "";
    await page.goto(`${demo.url}/leads/people/${person("Amira Hassan")}`);
    await page.getByLabel("Show activity from").selectOption({ label: "Sports clinics, Exeter" });
    await expect(page.getByText("Sequence finished with no response")).toBeVisible();
    await page.getByText("Show message").last().click();
    await expect(page.getByText("Online booking at Harbour Lane Physio stops at 18:00.")).toBeVisible();

    // A company lead's shared inbox bounces: the address is struck through and the track ends.
    await page.goto(`${demo.url}/leads/companies/${person("Riverside Sports Clinic")}`);
    await page.getByLabel("Show activity from").selectOption({ label: "Sports clinics, Exeter" });
    await expect(page.getByText("Email 1 bounced")).toBeVisible();
    await expect(page.getByText("info@riversidesports.example", { exact: true })).toHaveCSS("text-decoration-line", "line-through");

    await page.goto(`${demo.url}/leads/people/${person("Daniel Price")}`);
    await page.getByLabel("Show activity from").selectOption({ label: "Sports clinics, Exeter" });
    await expect(page.getByText("Replied by email")).toBeVisible();
    await expect(page.getByText("Email 2 sent")).toHaveCount(0);

    await page.goto(`${demo.url}/leads/people/${person("Grace Okafor")}`);
    await page.getByLabel("Show activity from").selectOption({ label: "Sports clinics, Exeter" });
    await expect(page.getByText("Email skipped")).toBeVisible();
  });
});

/** Regressions from the review of pull request 41, each on its own fake-provider app and campaign. */
test.describe("review of pull request 41", () => {
  let r: FakeProviderApp;
  let n = 0;
  test.beforeAll(async () => {
    r = await fakeProviderApp("review");
  });
  const campaign = async (definition?: CampaignDefinition) => {
    const csv = { businessesCsv: readFileSync(fixture("businesses-run1.csv"), "utf8"), peopleCsv: readFileSync(fixture("people-run1.csv"), "utf8") };
    const id = (await r.harness.request<{ campaign: Campaign }>("POST", "/api/campaigns", { name: `Review ${++n}`, defaultTimezone: "Europe/London", ...csv })).body.campaign.id;
    if (definition) await r.harness.defineSequence(id, definition);
    return id;
  };
  const stored = async (id: string) => (await r.harness.request<SequenceView>("GET", `/api/campaigns/${id}/sequence`)).body;
  const track = (steps: StepDefinition[]): CampaignDefinition => ({
    timezone: "Europe/London",
    callSkipLimitDays: 2,
    emailPool: [FAKE_INBOX],
    tracks: [{ id: "email", channel: "email", branch: "main", window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })), steps, start: { kind: "entry" }, removed: false }],
  });

  test("a draft the server would refuse is not launched in place of the stored one (useSequence.ts:133)", async ({ page }) => {
    const id = await campaign(track([COPY.first, COPY.second]));
    let launches = 0;
    await page.route("**/api/campaigns/*/launch", (route) => {
      launches++;
      return route.continue();
    });
    await page.goto(`${r.url}/campaigns/${id}?track=email&step=s2`);
    await page.getByLabel("Days to wait before Email 2").fill("");
    await page.getByRole("link", { name: /Before launch/ }).click();
    await expect(page.getByText("Your latest change isn’t saved, so launch waits.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Launch campaign" })).toBeDisabled();
    expect(launches).toBe(0);
    expect((await stored(id)).launchedAt).toBeNull();
  });

  test("a save that failed blocks launch until it succeeds (useSequence.ts:133)", async ({ page }) => {
    const id = await campaign(track([COPY.first, COPY.second]));
    let launches = 0;
    await page.route("**/api/campaigns/*/launch", (route) => {
      launches++;
      return route.continue();
    });
    await page.goto(`${r.url}/campaigns/${id}?track=email&step=s1`);
    await page.route("**/api/campaigns/*/sequence", (route) => (route.request().method() === "PUT" ? serverError(route) : route.continue()));
    await page.getByLabel("Email 1 subject").fill("A subject that never saved");
    await expect(page.getByText("Your last change wasn’t saved.")).toBeVisible();
    await page.getByRole("link", { name: /Before launch/ }).click();
    await expect(page.getByText("Your latest change isn’t saved, so launch waits.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Launch campaign" })).toBeDisabled();
    expect(launches).toBe(0);
    expect((await stored(id)).launchedAt).toBeNull();
  });

  test("a delayed older save never overwrites a newer one, and the status ends on Saved (useSequence.ts:76)", async ({ page }) => {
    const id = await campaign(track([COPY.first, COPY.second]));
    await page.goto(`${r.url}/campaigns/${id}?track=email&step=s1`);
    const held: Route[] = [];
    await page.route("**/api/campaigns/*/sequence", (route) => {
      if (route.request().method() !== "PUT" || held.length > 0) return route.continue();
      held.push(route);
      return undefined;
    });
    await page.getByLabel("Email 1 subject").fill("Older subject");
    await expect.poll(() => held.length).toBe(1);
    await page.getByLabel("Email 1 subject").fill("Newest subject");
    // Give a second save every chance to overtake the first before the first is let through.
    await page.waitForTimeout(1500);
    await held[0]!.continue();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    await expect.poll(async () => (await stored(id)).definition.tracks[0]!.steps[0]!.subject).toBe("Newest subject");
  });

  test("removing Email 1 makes the next email a valid first email, which saves and survives a reload (SequenceTab.tsx:220)", async ({ page }) => {
    const id = await campaign(track([COPY.first, COPY.second]));
    await page.goto(`${r.url}/campaigns/${id}?track=email&step=s1`);
    await page.getByRole("button", { name: "Remove Email 1" }).click();
    await page.getByRole("button", { name: /^Email 1/ }).first().click();
    await page.getByLabel("Email 1 subject").fill("A fresh subject for {{company}}");
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    const saved = (await stored(id)).definition.tracks[0]!.steps;
    expect(saved.map((s) => [s.id, s.waitDays, s.threading, s.subject])).toEqual([["s2", 0, "new_subject", "A fresh subject for {{company}}"]]);
    await page.reload();
    await expect(page.getByLabel("Email 1 copy")).toHaveValue(COPY.second.body);
  });

  test("a running campaign's inspector has no enabled authoring control (PR 41 review: one lock)", async ({ page }) => {
    await page.goto(`${r.url}/campaigns/${r.running}?track=email&step=s1`);
    await expect(page.getByText("This campaign is running.")).toBeVisible();
    expect(await enabledAuthoring(page)).toEqual([]);
  });

  test("a running campaign's emails still open, read-only (SequenceTab.tsx:207)", async ({ page }) => {
    const id = await campaign(track([COPY.first, COPY.second]));
    expect((await r.harness.launch(id)).status).toBe(200);
    await page.goto(`${r.url}/campaigns/${id}?track=email`);
    await page.getByRole("button", { name: /^Email 2/ }).click();
    await expect(page.getByLabel("Email 2 copy")).toHaveValue(COPY.second.body);
    await expect(page.getByLabel("Email 2 copy")).toBeDisabled();
  });

  test("a campaign whose leads have all ended lists them with their outreach status, not \"No leads yet\" (verification F5)", async ({ page }) => {
    const id = await campaign(track([COPY.first]));
    expect((await r.harness.launch(id)).status).toBe(200);
    await r.harness.advanceTo(r.harness.clock + 3 * 24 * 3_600_000);
    await page.goto(`${r.url}/campaigns/${id}/leads`);
    const table = page.getByRole("table");
    await expect(table.getByRole("row")).toHaveCount(7);
    await expect(table.getByText("Sequence finished, no response").first()).toBeVisible();
    await expect(table.getByText("Finished, no usable channel").first()).toBeVisible();
    await expect(page.getByText("No leads yet.")).toHaveCount(0);
  });

  test("variant A's layout: the canvas fills the view and stays there, while the inspector scrolls on its own (verification)", async ({ page }) => {
    const id = await campaign(track([COPY.first, COPY.second, { ...COPY.second, id: "s3" }]));
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.goto(`${r.url}/campaigns/${id}?track=email&step=s1`);
    await expect(page.getByLabel("Email 1 copy")).toBeVisible();
    const canvas = await page.getByTestId("canvas").boundingBox();
    const inspector = await page.getByTestId("inspector").boundingBox();
    expect(canvas!.height).toBeGreaterThanOrEqual(470);
    // Side by side, the same height, and inside the viewport: the page does not scroll.
    expect(Math.abs(inspector!.height - canvas!.height)).toBeLessThan(2);
    expect(inspector!.y + inspector!.height).toBeLessThanOrEqual(900);
    expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(1);
    const body = page.getByTestId("inspector-body");
    expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    // Scrolling the inspector to its sender settings leaves the canvas where it was.
    await page.getByText("Timing and sender").scrollIntoViewIfNeeded();
    expect((await page.getByTestId("canvas").boundingBox())!.y).toBe(canvas!.y);
  });

  test("switching the preview lead shows loading, never the previous lead's copy under the new name (council item 2)", async ({ page }) => {
    const id = await campaign(track([COPY.first, COPY.second]));
    await page.goto(`${r.url}/campaigns/${id}/before-launch`);
    await expect(page.getByText("Hi Amira,").first()).toBeVisible();
    await page.route("**/api/campaigns/*/preview/**", () => new Promise(() => undefined));
    await page.getByRole("button", { name: "Next lead" }).click();
    await expect(page.getByLabel("Loading the copy")).toBeVisible();
    await expect(page.getByText("Hi Amira,")).toHaveCount(0);
  });

  test("a new definition version shows loading for the copy and checks, not the older ones (council item 2)", async ({ page }) => {
    // Stored with an empty pool: opening the campaign saves the connected inboxes, a new version.
    const id = await campaign({ ...track([COPY.first, COPY.second]), emailPool: [] });
    const held: Route[] = [];
    await page.route("**/api/campaigns/*/sequence", (route) => (route.request().method() === "PUT" ? void held.push(route) : route.continue()));
    await page.goto(`${r.url}/campaigns/${id}/before-launch`);
    await expect(page.getByText("Hi Amira,").first()).toBeVisible();
    // The new version's checks and copy never arrive; the older ones must not stand in for them.
    await page.route("**/api/campaigns/*/before-launch?*", () => new Promise(() => undefined));
    await page.route("**/api/campaigns/*/preview/**", () => new Promise(() => undefined));
    await expect.poll(() => held.length).toBe(1);
    await held[0]!.continue();
    await expect(page.getByLabel("Loading the checks before launch")).toBeVisible();
    await expect(page.getByText("Hi Amira,")).toHaveCount(0);
  });

  test("once launched, the inspector shows no lead counts for the fallbacks, which would leave out ended leads (council item 4)", async ({ page }) => {
    const id = await campaign(track([COPY.first]));
    expect((await r.harness.launch(id)).status).toBe(200);
    await r.harness.advanceTo(r.harness.clock + 3 * 24 * 3_600_000);
    await page.goto(`${r.url}/campaigns/${id}?track=email&step=s1`);
    await expect(page.getByLabel("Fallback for first name")).toHaveValue("there");
    await expect(page.getByText("Every lead has it")).toHaveCount(0);
    await expect(page.getByText(/leads? without one/)).toHaveCount(0);
  });

  test("moving to another campaign in the app shows that campaign's sequence, not the last one's (council item 6)", async ({ page }) => {
    const two = await campaign(track([COPY.first, COPY.second]));
    const one = await campaign(track([COPY.first]));
    await page.goto(`${r.url}/campaigns/${two}?track=email&step=s1`);
    await page.getByLabel("Email 1 subject").fill("An edit to the first campaign");
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Email track: 2 emails/ })).toBeVisible();
    // Client-side navigation, as Back and Forward do: the page stays mounted.
    await page.evaluate((path) => {
      history.pushState(null, "", path);
      dispatchEvent(new PopStateEvent("popstate"));
    }, `/campaigns/${one}`);
    await expect(page.getByRole("button", { name: /^Email track: 1 email/ })).toBeVisible();
  });

  test("closing the open email leaves every email collapsed, also after a reload (council item 8)", async ({ page }) => {
    const id = await campaign(track([COPY.first, COPY.second]));
    await page.goto(`${r.url}/campaigns/${id}?track=email`);
    const first = page.getByRole("button", { name: /^Email 1/ });
    await expect(first).toHaveAttribute("aria-expanded", "true");
    await first.click();
    await expect(first).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("button", { name: /^Email 2/ })).toHaveAttribute("aria-expanded", "false");
    await page.reload();
    await expect(page.getByRole("button", { name: /^Email 1/ })).toHaveAttribute("aria-expanded", "false");
  });

  test("leaving the page with a save in flight keeps the newest edit, and the late older save is refused (re-check B6)", async ({ page }) => {
    const id = await campaign(track([COPY.first, COPY.second]));
    await page.goto(`${r.url}/campaigns/${id}?track=email&step=s1`);
    const held: Route[] = [];
    await page.route("**/api/campaigns/*/sequence", (route) => (route.request().method() === "PUT" && held.length === 0 ? void held.push(route) : route.continue()));
    await page.getByLabel("Email 1 subject").fill("Older delayed save");
    await expect.poll(() => held.length).toBe(1);
    const older = held[0]!.request().postData() ?? "";
    await page.getByLabel("Email 1 subject").fill("Newest edit must survive navigation");
    await page.waitForTimeout(900);
    // A full document navigation, then the older request reaches the server late.
    await page.goto(`${r.url}/campaigns`);
    await held[0]!.abort().catch(() => undefined);
    const late = await r.harness.request<{ error: { code: string } }>("PUT", `/api/campaigns/${id}/sequence`, JSON.parse(older));
    expect(late).toMatchObject({ status: 409, body: { error: { code: "superseded" } } });
    await expect.poll(async () => (await stored(id)).definition.tracks[0]!.steps[0]!.subject).toBe("Newest edit must survive navigation");
    await page.goto(`${r.url}/campaigns/${id}?track=email&step=s1`);
    await expect(page.getByLabel("Email 1 subject")).toHaveValue("Newest edit must survive navigation");
  });

  test("an edit still inside its debounce survives a full navigation (re-check B6, opposite case)", async ({ page }) => {
    const id = await campaign(track([COPY.first, COPY.second]));
    await page.goto(`${r.url}/campaigns/${id}?track=email&step=s1`);
    await page.getByLabel("Email 1 subject").fill("Debounce leave is preserved");
    await page.goto(`${r.url}/campaigns`);
    await expect.poll(async () => (await stored(id)).definition.tracks[0]!.steps[0]!.subject).toBe("Debounce leave is preserved");
  });

  test("an in-app navigation behind a held save keeps the newest edit (re-check B6, opposite case)", async ({ page }) => {
    const id = await campaign(track([COPY.first, COPY.second]));
    await page.goto(`${r.url}/campaigns/${id}?track=email&step=s1`);
    const held: Route[] = [];
    await page.route("**/api/campaigns/*/sequence", (route) => (route.request().method() === "PUT" && held.length === 0 ? void held.push(route) : route.continue()));
    await page.getByLabel("Email 1 subject").fill("Older behind the leave");
    await expect.poll(() => held.length).toBe(1);
    await page.getByLabel("Email 1 subject").fill("Latest before SPA leave");
    await page.waitForTimeout(900);
    await page.getByRole("link", { name: "Campaigns", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "Campaigns", level: 1 })).toBeVisible();
    await held[0]!.continue();
    await expect.poll(async () => (await stored(id)).definition.tracks[0]!.steps[0]!.subject).toBe("Latest before SPA leave");
  });

  test("a failed save recovers through Try again, and launch is ready again (re-check B6, opposite case)", async ({ page }) => {
    const id = await campaign(track([COPY.first, COPY.second]));
    await page.goto(`${r.url}/campaigns/${id}?track=email&step=s1`);
    await page.route("**/api/campaigns/*/sequence", (route) => (route.request().method() === "PUT" ? serverError(route) : route.continue()));
    await page.getByLabel("Email 1 subject").fill("Saved on the second try");
    await page.getByRole("link", { name: /Before launch/ }).click();
    await expect(page.getByText("Your latest change isn’t saved, so launch waits.")).toBeVisible();
    await page.unroute("**/api/campaigns/*/sequence");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("button", { name: "Launch campaign" })).toBeEnabled();
    expect((await stored(id)).definition.tracks[0]!.steps[0]!.subject).toBe("Saved on the second try");
  });

  test("a save stored on the server whose answer is lost is resent unchanged and ends Saved, with launch ready (review: retry, B8)", async ({ page }) => {
    const id = await campaign(track([COPY.first, COPY.second]));
    await page.goto(`${r.url}/campaigns/${id}?track=email&step=s1`);
    let lost = false;
    await page.route("**/api/campaigns/*/sequence", async (route) => {
      if (route.request().method() !== "PUT" || lost) return route.continue();
      lost = true;
      await route.fetch(); // the server stores it
      await route.abort(); // and the answer never reaches the page
    });
    await page.getByLabel("Email 1 subject").fill("Stored, answer lost");
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    expect((await stored(id)).definition.tracks[0]!.steps[0]!.subject).toBe("Stored, answer lost");
    await page.getByRole("link", { name: /Before launch/ }).click();
    await expect(page.getByRole("button", { name: "Launch campaign" })).toBeEnabled();
  });

  test("a leave-save whose page the browser keeps, then shows again, reports its answer: the page says Saved (review: saveQueue.ts:76)", async ({ page }) => {
    const id = await campaign(track([COPY.first, COPY.second]));
    await page.goto(`${r.url}/campaigns/${id}?track=email&step=s1`);
    await page.getByLabel("Email 1 subject").fill("Sent as the page was hidden");
    // Inside the debounce: the page is hidden (kept for Back), the leave-save goes, and the page returns.
    await page.evaluate(() => {
      dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    await expect.poll(async () => (await stored(id)).definition.tracks[0]!.steps[0]!.subject).toBe("Sent as the page was hidden");
  });

  test("a stale tab cannot overwrite another tab's saved change: it keeps what was typed and offers the saved version (re-check B7)", async ({ browser }) => {
    const id = await campaign(track([COPY.first, COPY.second]));
    const context = await browser.newContext();
    const a = await context.newPage();
    const b = await context.newPage();
    await a.goto(`${r.url}/campaigns/${id}?track=email&step=s1`);
    await b.goto(`${r.url}/campaigns/${id}?track=email&step=s1`);
    await b.getByLabel("Email 1 subject").fill("Tab B protected subject newer");
    await expect(b.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    // Tab A still shows the old subject and changes only the body.
    await a.getByLabel("Email 1 copy").fill("Tab A later body without changing subject");
    await expect(a.getByText("This campaign was changed elsewhere since this page loaded it.")).toBeVisible();
    await expect(a.getByLabel("Email 1 copy")).toHaveValue("Tab A later body without changing subject");
    expect((await stored(id)).definition.tracks[0]!.steps[0]!.subject).toBe("Tab B protected subject newer");
    await a.getByRole("link", { name: /Before launch/ }).click();
    await expect(a.getByRole("button", { name: "Launch campaign" })).toBeDisabled();
    await a.getByRole("button", { name: "Load the saved version" }).click();
    await a.getByRole("link", { name: "Sequence" }).click();
    await a.getByRole("button", { name: /^Email track: / }).click();
    await expect(a.getByLabel("Email 1 subject")).toHaveValue("Tab B protected subject newer");
    await context.close();
  });

  test("a large valid draft keeps its newest edit when the page is left with a save in flight (re-check B6, large)", async ({ page }) => {
    const long = "y".repeat(12_000);
    const id = await campaign(track([COPY.first, ...[2, 3, 4].map((n) => ({ ...COPY.second, id: `s${n}`, body: long }))]));
    await page.goto(`${r.url}/campaigns/${id}?track=email&step=s1`);
    const held: Route[] = [];
    await page.route("**/api/campaigns/*/sequence", (route) => (route.request().method() === "PUT" && held.length === 0 ? void held.push(route) : route.continue()));
    await page.getByLabel("Email 1 subject").fill("Large older held");
    await expect.poll(() => held.length).toBe(1);
    await page.getByLabel("Email 1 subject").fill("Large newest queued must survive");
    await page.waitForTimeout(900);
    await page.goto(`${r.url}/campaigns`);
    await held[0]!.abort().catch(() => undefined);
    await expect.poll(async () => (await stored(id)).definition.tracks[0]!.steps[0]!.subject).toBe("Large newest queued must survive");
  });

  test("a draft over the size bound is refused in place and never sent (boundary)", async ({ page }) => {
    const id = await campaign(track([COPY.first, COPY.second]));
    await page.goto(`${r.url}/campaigns/${id}?track=email&step=s2`);
    let puts = 0;
    await page.route("**/api/campaigns/*/sequence", (route) => (route.request().method() === "PUT" ? (puts++, route.continue()) : route.continue()));
    for (const n of [2, 3, 4]) {
      if (n > 2) {
        await page.getByRole("button", { name: "Add follow-up" }).click();
      }
      await page.getByLabel(`Email ${n} copy`).fill("z".repeat(19_000));
    }
    await expect(page.getByText(/The sequence is larger than 56 KB/)).toBeVisible();
    await page.waitForTimeout(900);
    const before = puts;
    await page.getByLabel("Email 4 copy").fill("z".repeat(19_500));
    await page.waitForTimeout(900);
    expect(puts).toBe(before);
  });

  test("Launch waits until the checks for the definition on the page have arrived (re-check F7)", async ({ page }) => {
    const id = await campaign(track([COPY.first, COPY.second]));
    await page.route("**/api/campaigns/*/before-launch?*", () => new Promise(() => undefined));
    await page.goto(`${r.url}/campaigns/${id}/before-launch`);
    await expect(page.getByLabel("Loading the checks before launch")).toBeVisible();
    await expect(page.getByRole("button", { name: "Launch campaign" })).toBeDisabled();
  });

  test("a follow-up that continues the thread names the subject of the nearest email that started one (SequenceTab.tsx:274)", async ({ page }) => {
    const id = await campaign(track([COPY.first, { ...COPY.second, threading: "new_subject", subject: "A second idea" }, { ...COPY.second, id: "s3", body: "Last note." }]));
    await page.goto(`${r.url}/campaigns/${id}?track=email&step=s3`);
    await expect(page.getByText("Re: A second idea")).toBeVisible();
  });

  /**
   * The inspector's authoring controls that are enabled: every input, select, textarea and button
   * except the ones that only show or close (the close button, each email's row) and the conflict's
   * way out. While editing is locked this is empty (PR 41 review: TimingAndSender).
   */
  const enabledAuthoring = (page: Page) =>
    page.getByTestId("inspector").evaluate((root) =>
      [...root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>("input, select, textarea, button")]
        .map((el) => ({ el, name: el.getAttribute("aria-label") ?? (el.labels?.[0]?.textContent ?? el.textContent).trim() }))
        .filter(({ el, name }) => !el.matches(":disabled") && !el.matches("[id^='step-toggle-']") && !["Close the email track", "Load the saved version", "Loading…"].includes(name))
        .map(({ name }) => name),
    );

  /** Tab B saves a change; tab A, still on the older revision, edits and is refused. Returns tab A. */
  const conflicted = async (browser: Browser, id: string) => {
    const context = await browser.newContext();
    const a = await context.newPage();
    const b = await context.newPage();
    await a.goto(`${r.url}/campaigns/${id}?track=email&step=s1`);
    await b.goto(`${r.url}/campaigns/${id}?track=email&step=s1`);
    await b.getByLabel("Email 1 subject").fill("Tab B saved subject");
    await expect(b.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    await a.getByLabel("Email 1 copy").fill("Tab A stale body");
    await expect(a.getByRole("button", { name: "Load the saved version" })).toBeVisible();
    return { a, context };
  };

  test("typing again after a conflict keeps the conflict and its way out, here and on Before launch (council item 10, re-check B11)", async ({ browser }) => {
    const id = await campaign(track([COPY.first, COPY.second]));
    const { a, context } = await conflicted(browser, id);
    await a.getByLabel("Email 1 copy").fill("Tab A keeps typing after the conflict");
    // Past the debounce: nothing is sent, and the page still says what happened.
    await a.waitForTimeout(1_500);
    await expect(a.getByRole("button", { name: "Load the saved version" })).toBeVisible();
    await expect(a.getByRole("status").filter({ hasText: "Not saved" })).toBeVisible();
    await expect(a.getByLabel("Email 1 copy")).toHaveValue("Tab A keeps typing after the conflict");
    await a.getByRole("link", { name: /Before launch/ }).click();
    await expect(a.getByRole("button", { name: "Load the saved version" })).toBeVisible();
    await expect(a.getByRole("button", { name: "Launch campaign" })).toBeDisabled();
    expect((await stored(id)).definition.tracks[0]!.steps[0]!.subject).toBe("Tab B saved subject");
    await context.close();
  });

  test("while the saved version loads, the email is locked, so its answer never erases words typed after choosing it (re-check B12)", async ({ browser }) => {
    const id = await campaign(track([COPY.first, COPY.second]));
    const { a, context } = await conflicted(browser, id);
    const held: Route[] = [];
    await a.route("**/api/campaigns/*/sequence", (route) => (route.request().method() === "GET" ? void held.push(route) : route.continue()));
    await a.getByRole("button", { name: "Load the saved version" }).click();
    await expect.poll(() => held.length).toBe(1);
    await expect(a.getByText("Loading the saved version. Editing is paused until it arrives.")).toBeVisible();
    await expect(a.getByLabel("Email 1 copy")).toBeDisabled();
    expect(await enabledAuthoring(a)).toEqual([]);
    await held[0]!.continue();
    await a.unroute("**/api/campaigns/*/sequence");
    await expect(a.getByLabel("Email 1 subject")).toHaveValue("Tab B saved subject");
    // Editing carries on from the loaded version and saves.
    await a.getByLabel("Email 1 copy").fill("Tab A after loading");
    await expect(a.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    expect((await stored(id)).definition.tracks[0]!.steps[0]!.body).toBe("Tab A after loading");
    await context.close();
  });

  test("while a launch is pending, the emails are locked, so its answer never discards copy typed meanwhile (council item 9)", async ({ page }) => {
    const id = await campaign(track([COPY.first, COPY.second]));
    await page.goto(`${r.url}/campaigns/${id}/before-launch`);
    const held: Route[] = [];
    await page.route("**/api/campaigns/*/launch", (route) => void held.push(route));
    await page.getByRole("button", { name: "Launch campaign" }).click();
    await expect.poll(() => held.length).toBe(1);
    await page.getByRole("link", { name: "Sequence" }).click();
    await page.getByRole("button", { name: /^Email track: / }).click();
    await expect(page.getByText("Launching. Editing is paused until the launch answers.")).toBeVisible();
    await expect(page.getByLabel("Email 1 copy")).toBeDisabled();
    // Every authoring control, not only the copy: sending days, hours, time zone, add and remove.
    expect(await enabledAuthoring(page)).toEqual([]);
    await held[0]!.continue();
    await expect(page.getByText("This campaign is running.")).toBeVisible();
    expect((await stored(id)).launchedAt).not.toBeNull();
  });

  test("leaving twice with a draft over 32 KiB keeps one request outliving the page, and the newest is the one stored (council item 11)", async ({ page }) => {
    const long = "y".repeat(12_000);
    const id = await campaign(track([COPY.first, ...[2, 3, 4].map((n) => ({ ...COPY.second, id: `s${n}`, body: long }))]));
    // Counts the page's requests that outlive it (keepalive) while they are open.
    await page.addInitScript(() => {
      const count = { open: 0, most: 0 };
      (window as unknown as { keepalive: typeof count }).keepalive = count;
      const send = window.fetch.bind(window);
      window.fetch = (input, init) => {
        if (!init?.keepalive) return send(input, init);
        count.open++;
        count.most = Math.max(count.most, count.open);
        return send(input, init).finally(() => count.open--);
      };
    });
    await page.goto(`${r.url}/campaigns/${id}?track=email&step=s1`);
    const held: Route[] = [];
    await page.route("**/api/campaigns/*/sequence", (route) => (route.request().method() === "PUT" ? void held.push(route) : route.continue()));
    const leave = () => page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    const keepalive = () => page.evaluate(() => (window as unknown as { keepalive: { open: number; most: number } }).keepalive);
    await page.getByLabel("Email 1 subject").fill("First leave");
    await leave();
    await expect.poll(async () => (await keepalive()).open).toBe(1);
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await page.getByLabel("Email 1 subject").fill("Second leave, the newest");
    await leave();
    const newest = () => held.find((route) => (route.request().postData() ?? "").includes("Second leave, the newest"));
    await expect.poll(() => newest() !== undefined).toBe(true);
    // The first leave-save was cancelled as the second was sent: never two open at once.
    expect(await keepalive()).toEqual({ open: 1, most: 1 });
    await newest()!.continue();
    await expect.poll(async () => (await stored(id)).definition.tracks[0]!.steps[0]!.subject).toBe("Second leave, the newest");
    for (const route of held) if (route !== newest()) await route.abort().catch(() => undefined);
  });

  test("a field written with spaces inside its braces keeps its Add fallback action, which opens the email that uses it (PR 41 review: BeforeLaunchTab.tsx)", async ({ page }) => {
    const id = await campaign(track([{ ...COPY.first, body: "Hi {{ first_name }}, a note for {{company}}." }, COPY.second]));
    await page.goto(`${r.url}/campaigns/${id}/before-launch`);
    await expect(page.getByText("First name has no fallback")).toBeVisible();
    await expect(page.getByText("It is used only in a track this editor can’t open yet.")).toHaveCount(0);
    await page.getByRole("button", { name: "Add fallback" }).click();
    await expect(page).toHaveURL(/step=s1/);
    await expect(page.getByLabel("Fallback for first name")).toBeVisible();
  });

  test("a second email track's blockers (defined through the API) are named as that email track's, never as an SMS track's (PR 41 review: BeforeLaunchTab.tsx)", async ({ page }) => {
    const id = await campaign(track([COPY.first, COPY.second]));
    const email = (await stored(id)).definition;
    const second = { ...email.tracks[0]!, id: "email-2", steps: [{ id: "e2s1", waitDays: 0, subject: "", body: "", threading: "new_subject" as const, removed: false }], start: { kind: "after" as const, trackId: "email", delayDays: 3 } };
    await r.harness.defineSequence(id, { ...email, tracks: [...email.tracks, second] });
    await page.goto(`${r.url}/campaigns/${id}/before-launch`);
    await expect(page.getByText("Email track 2: Email 1 has no subject")).toBeVisible();
    await expect(page.getByText("Email track 2: Email 1 has no copy")).toBeVisible();
    await expect(page.getByText("This editor opens one email track, so Email track 2 can’t be edited here yet.").first()).toBeVisible();
    await expect(page.getByText(/Text \d|SMS/)).toHaveCount(0);
    // Nothing to open for a track this editor can't show.
    await expect(page.getByRole("button", { name: "Write it" })).toHaveCount(0);
  });

  test("a campaign with an SMS track (defined through the API) names the SMS track's blockers as its own, not the email track's (merge of ticket 13a)", async ({ page }) => {
    const id = await campaign(track([COPY.first, COPY.second]));
    const email = (await stored(id)).definition;
    const sms = { id: "sms", channel: "sms" as const, branch: "main" as const, window: email.tracks[0]!.window, steps: [{ id: "m1", waitDays: 0, subject: "", body: "", threading: "new_subject" as const, removed: false }], start: { kind: "after" as const, trackId: "email", delayDays: 1 }, removed: false };
    await r.harness.defineSequence(id, { ...email, tracks: [...email.tracks, sms] });
    await page.goto(`${r.url}/campaigns/${id}/before-launch`);
    await expect(page.getByText("The SMS track has no connected sender number")).toBeVisible();
    await expect(page.getByText("The SMS track: Text 1 has no message")).toBeVisible();
    // The email track has its inbox: nothing is said against it.
    await expect(page.getByText("The email track has no connected sender inbox")).toHaveCount(0);
    await expect(page.getByText("SMS sends are not in this estimate yet: it counts email only.", { exact: false })).toBeVisible();
    await page.getByRole("link", { name: "Sequence" }).click();
    await expect(page.getByRole("button", { name: /^Email track: / })).not.toContainText("to fix");
  });
});
