import { expect, test } from "@playwright/test";
import type { LeadSearchResult } from "../src/shared/api.ts";
import { refusedPair, respond, serverError } from "./mocks.ts";
import { JUNIPER_LATER, JUNIPER_LATER_ROW } from "./screens.ts";
import { fixture, nav } from "./support.ts";

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

test("the quick search above the Campaigns list opens Leads with the query", async ({ page }) => {
  await page.goto("/campaigns");
  await page.getByLabel("Find a lead").fill("Okafor");
  await page.getByLabel("Find a lead").press("Enter");
  await expect(page).toHaveURL(/\/leads\?q=Okafor/);
  await expect(page.getByLabel("Search leads")).toHaveValue("Okafor");
});

test("Leads shows an empty state when nothing has been imported", async ({ page }) => {
  const empty = { rows: [], total: 0, people: 0, companies: 0, limit: 100 } satisfies LeadSearchResult;
  await page.route("**/api/leads?*", (route) => respond(route, empty));
  await page.goto("/leads");
  await expect(page.getByText("No leads yet.", { exact: false })).toBeVisible();
  await expect(page.getByText("undefined")).toHaveCount(0);
});

test("Leads says when no one matches a search", async ({ page }) => {
  await page.goto("/leads?q=zzzz-nobody");
  await expect(page.getByText("No one matches “zzzz-nobody”.", { exact: false })).toBeVisible();
});

test("a failed load says so and offers to try again", async ({ page }) => {
  let fail = true;
  await page.route("**/api/leads?*", async (route) => {
    if (fail) await serverError(route);
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

test("the campaign filter says when its campaigns didn't load, and recovers on retry", async ({ page }) => {
  let fail = true;
  await page.route("**/api/campaigns", async (route) => {
    if (fail) await serverError(route);
    else await route.continue();
  });
  await page.goto("/leads");
  await expect(page.getByRole("alert")).toContainText("Campaigns for the filter didn’t load.");
  await expect(page.getByLabel("Campaign", { exact: true })).toBeDisabled();
  await expect(page.getByRole("link", { name: "Amira Hassan" })).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("Campaign", { exact: true }).locator("option", { hasText: "Physio clinics, London" })).toHaveCount(1);
});

test("a late failure from an obsolete file check does not replace newer selections", async ({ page }) => {
  let release: () => void = () => undefined;
  const oldCheckHeld = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/scraper-files/check", async (route) => {
    const body = route.request().postDataJSON() as { businessesCsv?: string };
    if (body.businessesCsv === undefined) {
      await oldCheckHeld;
      await serverError(route);
    } else await route.continue();
  });
  await page.goto("/campaigns/new");
  await page.getByLabel("People file", { exact: true }).setInputFiles(fixture("people-run1.csv"));
  await page.getByLabel("Businesses file", { exact: true }).setInputFiles(fixture("businesses-run1.csv"));
  await expect(page.getByText(/businesses-run1\.csv\. 6 businesses, matches/)).toBeVisible();
  release();
  await page.waitForTimeout(300);
  await expect(page.getByText(/businesses-run1\.csv\. 6 businesses, matches/)).toBeVisible();
  await expect(page.getByText(/people-run1\.csv\. 7 people, matches/)).toBeVisible();
});

test("a pair the server refuses marks the Businesses slot and blocks Import until a file is replaced", async ({ page }) => {
  let refuse = true;
  await page.route("**/api/campaigns", async (route) => {
    if (route.request().method() === "POST" && refuse) {
      await refusedPair(route);
    } else await route.continue();
  });
  await page.goto("/campaigns/new");
  await page.getByLabel("Campaign name").fill("Refused pair");
  await page.getByLabel("People file", { exact: true }).setInputFiles(fixture("people-run1.csv"));
  await page.getByLabel("Businesses file", { exact: true }).setInputFiles(fixture("businesses-run1.csv"));
  await expect(page.getByText(/6 businesses, matches/)).toBeVisible();
  await page.getByRole("button", { name: "Create campaign and import" }).click();

  await expect(page.getByRole("alert")).toContainText("Nothing was imported, and the campaign wasn’t created.");
  await expect(page.getByRole("alert")).toContainText("These two files don’t belong together.");
  // The slot says what is wrong with the file; it does not repeat the banner.
  await expect(page.getByText("businesses-run1.csv is from a different scraper run.")).toBeVisible();
  await expect(page.getByText("These two files don’t belong together.")).toHaveCount(1);
  await expect(page.getByText(/6 businesses, matches/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create campaign and import" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Choose another businesses file" })).toBeVisible();

  refuse = false;
  await page.getByLabel("Businesses file", { exact: true }).setInputFiles(fixture("businesses-run1.csv"));
  await expect(page.getByRole("button", { name: "Create campaign and import" })).toBeEnabled();
});

test("a long campaign name is limited, says so, and wraps", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/campaigns/new");
  await page.getByLabel("Campaign name").fill(`Long${"x".repeat(200)}`);
  await expect(page.getByLabel("Campaign name")).toHaveValue(`Long${"x".repeat(96)}`);
  await expect(page.getByText("100 of 100 characters.", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("a company lead's explanation stays true once a later import makes a decision maker reachable", async ({ page }) => {
  await page.route("**/api/companies/co-juniper", (route) => respond(route, JUNIPER_LATER));
  await page.goto("/leads/companies/co-juniper");
  await expect(page.getByRole("heading", { name: "Juniper Pilates Studio", level: 1 })).toBeVisible();
  await expect(page.getByText("None of its decision makers can be reached", { exact: false })).toHaveCount(0);
  await expect(page.getByText("1 of its 2 decision makers can now be reached too", { exact: false })).toBeVisible();

  await page.route("**/api/leads?*", (route) => respond(route, JUNIPER_LATER_ROW));
  await page.goto("/leads?q=Juniper");
  const row = page.getByRole("row", { name: /^Juniper Pilates Studio/ });
  await expect(row).toContainText("1 of its 2 decision makers can now be reached");
  await expect(row).not.toContainText("can’t be reached");
});

test("a company that is not a lead shows no bare label in the Company column", async ({ page }) => {
  const leads = {
    rows: [{ kind: "company", id: "co-copper", name: "Copper Kettle Osteopathy", city: "London", peopleOnRecord: 0, peopleReachable: 0, enrollments: [], unenrolledReason: "no_usable_channel" }],
    total: 1,
    people: 0,
    companies: 1,
    limit: 100,
  } satisfies LeadSearchResult;
  await page.route("**/api/leads?*", (route) => respond(route, leads));
  await page.goto("/leads?q=Copper");
  const cells = page.getByRole("row", { name: /^Copper Kettle Osteopathy/ }).getByRole("cell");
  await expect(cells.nth(1)).not.toHaveText("Company");
  await expect(cells.nth(1)).toContainText("Not a company lead");
});
