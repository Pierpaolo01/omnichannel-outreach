import { expect, test } from "@playwright/test";
import { nav } from "./support.ts";

test("the four areas are reachable from the rail, and Today and Calls say honestly that nothing is due", async ({ page }) => {
  await page.goto("/");
  await expect(nav(page, "Today")).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Nothing to call right now.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Needs attention" })).toBeVisible();

  await nav(page, "Calls").click();
  await expect(page.getByRole("heading", { name: "No calls today" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ready now, 0" })).toBeVisible();

  await nav(page, "Leads").click();
  await expect(page.getByRole("heading", { name: "Leads" })).toBeVisible();
  await nav(page, "Campaigns").click();
  await expect(page.getByRole("heading", { name: "Campaigns", exact: true })).toBeVisible();
});

test("the quick search above each page opens Leads with the query", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Find a lead").fill("Okafor");
  await page.getByLabel("Find a lead").press("Enter");
  await expect(page).toHaveURL(/\/leads\?q=Okafor/);
  await expect(page.getByLabel("Search leads")).toHaveValue("Okafor");
});

test("Leads shows an empty state when nothing has been imported", async ({ page }) => {
  await page.route("**/api/leads?*", (route) => route.fulfill({ json: { rows: [], total: 0, limit: 100 } }));
  await page.goto("/leads");
  await expect(page.getByText("No leads yet.", { exact: false })).toBeVisible();
});

test("Leads says when no one matches a search", async ({ page }) => {
  await page.goto("/leads?q=zzzz-nobody");
  await expect(page.getByText("No one matches “zzzz-nobody”.", { exact: false })).toBeVisible();
});

test("a failed load says so and offers to try again", async ({ page }) => {
  let fail = true;
  await page.route("**/api/leads?*", async (route) => {
    if (fail) await route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong on the server." } } });
    else await route.continue();
  });
  await page.goto("/leads");
  await expect(page.getByRole("alert")).toContainText("Leads didn’t load.");
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("table")).toBeVisible();
});

test("records show a loading state while they load", async ({ page }) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/people/*", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/leads?q=Grace");
  await page.getByRole("link", { name: "Grace Okafor" }).click();
  await expect(page.getByLabel("Loading")).toBeVisible();
  release();
  await expect(page.getByRole("heading", { name: "Grace Okafor", level: 1 })).toBeVisible();
  await expect(page.getByText("Main line", { exact: true })).toBeVisible();
});

test("an unknown record and an unknown page say so", async ({ page }) => {
  await page.goto("/leads/people/nobody");
  await expect(page.getByRole("heading", { name: "No one found" })).toBeVisible();
  await page.goto("/nowhere");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});

test("a campaign can be created without importing, and is listed ready to import", async ({ page }) => {
  await page.goto("/campaigns/new");
  await expect(page.getByRole("button", { name: "Create campaign and import" })).toBeDisabled();
  await expect(page.getByText("Name the campaign first.")).toBeVisible();
  await page.getByLabel("Campaign name").fill("Dental clinics, Bristol");
  await page.getByRole("button", { name: "Create without importing" }).click();
  await expect(page).toHaveURL(/\/campaigns$/);
  await expect(page.getByRole("listitem").filter({ hasText: "Dental clinics, Bristol" })).toContainText("0 leads. Nothing imported yet.");
});

test("files from two different scraper runs are refused before import", async ({ page }) => {
  await page.goto("/campaigns/new");
  await page.getByLabel("Campaign name").fill("Mismatched");
  const unrelated = "business_id,place_id,business_name,category,phone_e164,phone_original,general_emails,website,domain,street,neighborhood,city,state_province,postal_code,country,search_area,search_place,timezone,tz_check,rating,review_count,maps_url,facebook,instagram,linkedin_company,chain_flag,status,people_count,run_ids,first_seen,last_seen,phone_extension\nbz-other-run-0001,PL-other-0001,Other Clinic,Dentist,+442079460999,,,,,,,,,,,,,,,,,,,,,FALSE,no_people,0,run-9,,,\n";
  await page.getByLabel("Businesses file", { exact: true }).setInputFiles({ name: "businesses-other.csv", mimeType: "text/csv", buffer: Buffer.from(unrelated) });
  await page.getByLabel("People file", { exact: true }).setInputFiles(new URL("../test/fixtures/scraper/people-run1.csv", import.meta.url).pathname);
  await expect(page.getByText(/don’t belong together/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create campaign and import" })).toBeDisabled();
});
