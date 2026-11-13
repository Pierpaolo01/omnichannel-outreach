import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { Campaign, EnrollmentView } from "../src/shared/api.ts";
import { fakeProviderApp, type FakeProviderApp } from "./fake-provider.ts";
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
    const h = f.harness;
    const csv = { businessesCsv: readFileSync(fixture("businesses-run1.csv"), "utf8"), peopleCsv: readFileSync(fixture("people-run1.csv"), "utf8") };
    const { campaign } = (await h.request<{ campaign: Campaign }>("POST", "/api/campaigns", { name: "Sports clinics, Exeter", defaultTimezone: "Europe/London", ...csv })).body;

    await page.goto(`${f.url}/campaigns`);
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
    await page.goto(`${f.url}/leads/people/${person("Amira Hassan")}`);
    await page.getByLabel("Show activity from").selectOption({ label: "Sports clinics, Exeter" });
    await expect(page.getByText("Sequence finished with no response")).toBeVisible();
    await page.getByText("Show message").last().click();
    await expect(page.getByText("Online booking at Harbour Lane Physio stops at 18:00.")).toBeVisible();

    // A company lead's shared inbox bounces: the address is struck through and the track ends.
    await page.goto(`${f.url}/leads/companies/${person("Riverside Sports Clinic")}`);
    await page.getByLabel("Show activity from").selectOption({ label: "Sports clinics, Exeter" });
    await expect(page.getByText("Email bounced")).toBeVisible();
    await expect(page.getByText("info@riversidesports.example", { exact: true })).toHaveCSS("text-decoration-line", "line-through");

    await page.goto(`${f.url}/leads/people/${person("Daniel Price")}`);
    await page.getByLabel("Show activity from").selectOption({ label: "Sports clinics, Exeter" });
    await expect(page.getByText("Replied by email")).toBeVisible();
    await expect(page.getByText("Email 2 sent")).toHaveCount(0);

    await page.goto(`${f.url}/leads/people/${person("Grace Okafor")}`);
    await page.getByLabel("Show activity from").selectOption({ label: "Sports clinics, Exeter" });
    await expect(page.getByText("Email skipped")).toBeVisible();
  });
});
