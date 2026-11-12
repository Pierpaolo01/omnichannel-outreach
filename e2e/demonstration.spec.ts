import { expect, test } from "@playwright/test";
import { chooseFiles, fixture, nav } from "./support.ts";

/**
 * The ticket's demonstration (issue #11): import twice, import into a second campaign, find a
 * person and a company lead, and view a decision maker who was not enrolled. One serial story
 * on one database.
 */
test.describe.configure({ mode: "serial" });

test("import twice, into a second campaign, then find people, company leads and unenrolled decision makers", async ({ page }) => {
  await test.step("start from an empty Campaigns page", async () => {
    await page.goto("/campaigns");
    await expect(page.getByRole("heading", { name: "Start a campaign from a scraper run" })).toBeVisible();
    await page.getByRole("link", { name: "New campaign" }).click();
    await expect(page.getByRole("heading", { name: "New campaign" })).toBeVisible();
  });

  await test.step("a file in the wrong slot is caught before anything is imported", async () => {
    await page.getByLabel("Campaign name").fill("Physio clinics, London");
    await page.getByLabel("Businesses file", { exact: true }).setInputFiles(fixture("people-run1.csv"));
    await expect(page.getByText("This is the People file. Choose the Businesses file here.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create campaign and import" })).toBeDisabled();
  });

  await test.step("the first import enrols decision makers and company leads", async () => {
    await chooseFiles(page, "run1");
    await expect(page.getByText("people-run1.csv. 7 people, matches the scraper’s People export.")).toBeVisible();
    await expect(page.getByText("businesses-run1.csv. 6 businesses, matches the scraper’s Businesses export.")).toBeVisible();
    await page.getByRole("button", { name: "Create campaign and import" }).click();

    await expect(page.getByRole("heading", { name: "Imported into Physio clinics, London" })).toBeVisible();
    await expect(page.getByText("6 new leads: 4 decision makers and 2 company leads.")).toBeVisible();
    await expect(page.getByRole("tab", { name: "New 6" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Not enrolled 4" })).toBeVisible();

    await page.getByRole("tab", { name: "Not enrolled 4" }).click();
    const rows = page.getByRole("tabpanel");
    await expect(rows.getByRole("row", { name: /Sofia Marin/ })).toContainText(
      "No personal email or mobile, and Elm Street Chiropractic has no usable main line.",
    );
    await expect(rows.getByRole("row", { name: /Jordan Lee/ })).toContainText("Their company isn’t in the Businesses file.");
    await page.getByRole("tab", { name: "New 6" }).click();
    await expect(rows.getByRole("row", { name: /Grace Okafor/ })).toContainText("Main line only, so phone steps only.");
    await expect(rows.getByRole("row", { name: /Juniper Pilates Studio/ })).toContainText("Shared inbox only.");
  });

  await test.step("importing again merges without enrolling anyone twice", async () => {
    await nav(page, "Campaigns").click();
    await expect(page.getByText(/6 leads\. Last import today at \d\d:\d\d: 6 new, 4 not enrolled\./)).toBeVisible();
    await page.getByRole("link", { name: "Import again into Physio clinics, London" }).click();
    await expect(page.getByRole("heading", { name: "Import again into Physio clinics, London" })).toBeVisible();
    await chooseFiles(page, "run2");
    await expect(page.getByText(/people-run2\.csv\. 8 people/)).toBeVisible();
    await expect(page.getByText(/businesses-run2\.csv\. 6 businesses/)).toBeVisible();
    await page.getByRole("button", { name: "Import", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Imported again into Physio clinics, London" })).toBeVisible();
    await expect(page.getByText("No sequence was restarted.", { exact: false })).toBeVisible();
    await expect(page.getByRole("tab", { name: "New 1" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Already enrolled 4" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Updated 2" })).toBeVisible();
    await page.getByRole("tab", { name: "Updated 2" }).click();
    await expect(page.getByRole("tabpanel").getByRole("row", { name: /Amira Hassan/ })).toContainText(
      "Added email amira.hassan@harbourmail.example, marked newer.",
    );
    await page.getByRole("tab", { name: "New 1" }).click();
    await expect(page.getByRole("tabpanel").getByRole("row", { name: /Ravi Patel/ })).toBeVisible();
  });

  await test.step("the same people go into a second campaign, with no exclusions", async () => {
    await page.goto("/campaigns");
    await page.getByRole("link", { name: "New campaign" }).click();
    await page.getByLabel("Campaign name").fill("Spring follow-up, London");
    await chooseFiles(page, "run1");
    await expect(page.getByText(/businesses-run1\.csv\. 6 businesses/)).toBeVisible();
    await page.getByRole("button", { name: "Create campaign and import" }).click();
    await expect(page.getByRole("heading", { name: "Imported into Spring follow-up, London" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "New 6" })).toBeVisible();
  });

  await test.step("find a person in Leads and open their record", async () => {
    await nav(page, "Leads").click();
    await page.getByLabel("Search leads").fill("amira");
    const row = page.getByRole("row", { name: /Amira Hassan/ });
    await expect(row).toContainText("Physio clinics, London");
    await expect(row).toContainText("Spring follow-up, London");
    await expect(page.getByRole("row")).toHaveCount(2);
    await row.getByRole("link", { name: "Amira Hassan" }).click();

    await expect(page.getByRole("heading", { name: "Amira Hassan", level: 1 })).toBeVisible();
    await expect(page.getByText("Email, newer")).toBeVisible();
    await expect(page.getByText("amira.hassan@harbourmail.example")).toBeVisible();
    const campaigns = page.getByRole("region", { name: "Campaigns" });
    await expect(campaigns.getByText("Physio clinics, London")).toBeVisible();
    await expect(campaigns.getByText("Spring follow-up, London")).toBeVisible();
    await expect(campaigns.getByText("Queued")).toHaveCount(2);
  });

  await test.step("find a company lead by partial phone digits", async () => {
    await nav(page, "Leads").click();
    await page.getByLabel("Search leads").fill("7946 0303");
    const row = page.getByRole("row", { name: /Riverside Sports Clinic/ });
    await expect(row).toContainText("No named decision maker");
    await row.getByRole("link", { name: "Riverside Sports Clinic" }).click();
    await expect(page.getByText("Company lead", { exact: true })).toBeVisible();
    await expect(page.getByText("bookings@riversidesports.example")).toBeVisible();
  });

  await test.step("view a decision maker who was not enrolled, on the company record", async () => {
    await nav(page, "Leads").click();
    await page.getByLabel("Search leads").fill("Daniel");
    await page.getByRole("row", { name: /Daniel Price/ }).getByRole("link", { name: "Daniel Price" }).click();
    await page.getByRole("link", { name: "Elm Street Chiropractic" }).click();

    const record = page.getByRole("region", { name: "Company record: Elm Street Chiropractic" });
    await expect(record).toContainText("None in the scraper file");
    await expect(record).toContainText("2, of whom 1 is enrolled");
    const sofia = page.getByRole("row", { name: /Sofia Marin/ });
    await expect(sofia).toContainText("Not in a campaign: no personal email or mobile, and no usable company main line.");
    await sofia.getByRole("link", { name: "Sofia Marin" }).click();

    await expect(page.getByRole("heading", { name: "Sofia Marin", level: 1 })).toBeVisible();
    await expect(page.getByText(/Not in any campaign\. There’s no personal email or mobile/)).toBeVisible();
    await expect(page.getByRole("region", { name: "Others at Elm Street Chiropractic" })).toContainText("Daniel Price");
  });

  await test.step("a company whose decision makers can't be reached is contacted through its shared inbox", async () => {
    await nav(page, "Leads").click();
    await page.getByLabel("Search leads").fill("Juniper");
    const company = page.getByRole("row", { name: /^Juniper Pilates Studio/ });
    await expect(company).toContainText("Its decision makers can’t be reached directly");
    await expect(company).toContainText("Queued");
    await page.getByRole("row", { name: /Marco Bianchi/ }).getByRole("link", { name: "Marco Bianchi" }).click();
    await expect(page.getByText("The company is contacted through its shared inbox instead.", { exact: false })).toBeVisible();
  });
});
