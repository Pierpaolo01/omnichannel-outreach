import type { APIRequestContext, Page } from "@playwright/test";
import { fixture } from "./support.ts";

/**
 * Every route and state the app can show, for the standing accessibility and layout checks.
 * Add new screens here: e2e/accessibility.spec.ts and e2e/layout.spec.ts then cover them in
 * both themes and at every width. Runs after the demonstration project, so its data exists.
 */
export interface Screen {
  readonly name: string;
  readonly open: (page: Page, data: SeedData) => Promise<void>;
}

export interface SeedData {
  readonly campaignId: string;
  readonly firstImportId: string;
  readonly reimportId: string;
  readonly person: (name: string) => string;
  readonly company: (name: string) => string;
  readonly companyOf: (personName: string) => string;
}

interface Row {
  kind: "person" | "company";
  id: string;
  name: string;
  company?: { id: string };
}

export async function seedData(request: APIRequestContext): Promise<SeedData> {
  const campaigns = (await (await request.get("/api/campaigns")).json()) as { campaigns: { id: string; name: string }[] };
  const physio = campaigns.campaigns.find((c) => c.name === "Physio clinics, London");
  if (!physio) throw new Error("the demonstration project has not created its campaigns");
  const detail = (await (await request.get(`/api/campaigns/${physio.id}`)).json()) as { imports: { id: string }[] };
  const [reimport, first] = detail.imports;
  if (!reimport || !first) throw new Error("expected two imports into Physio clinics, London");
  const leads = (await (await request.get("/api/leads?limit=500")).json()) as { rows: Row[] };
  const row = (name: string) => {
    const found = leads.rows.find((r) => r.name === name);
    if (!found) throw new Error(`no lead row named ${name}`);
    return found;
  };
  return {
    campaignId: physio.id,
    firstImportId: first.id,
    reimportId: reimport.id,
    person: (name) => row(name).id,
    company: (name) => row(name).id,
    companyOf: (name) => row(name).company?.id ?? "",
  };
}

/** Holds matching requests open for the rest of the test, to show a loading state. */
async function hold(page: Page, pattern: string, method?: string): Promise<void> {
  await page.route(pattern, async (route) => {
    if (method && route.request().method() !== method) return route.continue();
    await new Promise(() => undefined);
  });
}

async function fail(page: Page, pattern: string): Promise<void> {
  await page.route(pattern, (route) =>
    route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong on the server." } } }),
  );
}

async function settle(page: Page, text: string | RegExp): Promise<void> {
  await page.getByText(text).first().waitFor();
}

async function readyForm(page: Page): Promise<void> {
  await page.goto("/campaigns/new");
  await page.getByLabel("Campaign name").fill("Physio clinics, North London");
  await page.getByLabel("People file", { exact: true }).setInputFiles(fixture("people-run1.csv"));
  await page.getByLabel("Businesses file", { exact: true }).setInputFiles(fixture("businesses-run1.csv"));
  await settle(page, /6 businesses, matches/);
}

export const SCREENS: readonly Screen[] = [
  { name: "today", open: async (page) => { await page.goto("/"); await settle(page, "Nothing to call right now."); } },
  { name: "calls", open: async (page) => { await page.goto("/calls"); await settle(page, "No calls today"); } },
  { name: "campaigns list", open: async (page) => { await page.goto("/campaigns"); await settle(page, "See result"); } },
  {
    name: "campaigns empty",
    open: async (page) => {
      await page.route("**/api/campaigns", (route) => route.fulfill({ json: { campaigns: [] } }));
      await page.goto("/campaigns");
      await settle(page, "Start a campaign from a scraper run");
    },
  },
  {
    name: "campaigns loading",
    open: async (page) => { await hold(page, "**/api/campaigns"); await page.goto("/campaigns"); await page.getByLabel("Loading campaigns").waitFor(); },
  },
  {
    name: "campaigns error",
    open: async (page) => { await fail(page, "**/api/campaigns"); await page.goto("/campaigns"); await settle(page, "Campaigns didn’t load."); },
  },
  { name: "new campaign", open: async (page) => { await page.goto("/campaigns/new"); await settle(page, "Name the campaign first."); } },
  {
    name: "new campaign with a file in the wrong slot",
    open: async (page) => {
      await page.goto("/campaigns/new");
      await page.getByLabel("Businesses file", { exact: true }).setInputFiles(fixture("people-run1.csv"));
      await settle(page, "This is the People file.");
    },
  },
  { name: "new campaign ready", open: readyForm },
  {
    name: "new campaign refused",
    open: async (page) => {
      await page.route("**/api/campaigns", (route) =>
        route.request().method() === "POST"
          ? route.fulfill({
              status: 400,
              json: { error: { code: "invalid_export", message: "Nothing was imported.", problems: [{ file: "pair", message: "These two files don’t belong together." }] } },
            })
          : route.continue(),
      );
      await readyForm(page);
      await page.getByRole("button", { name: "Create campaign and import" }).click();
      await page.getByRole("alert").waitFor();
    },
  },
  {
    name: "importing",
    open: async (page) => {
      await hold(page, "**/api/campaigns", "POST");
      await readyForm(page);
      await page.getByRole("button", { name: "Create campaign and import" }).click();
      await settle(page, "Importing into");
    },
  },
  {
    name: "import again",
    open: async (page, data) => { await page.goto(`/campaigns/${data.campaignId}/import`); await settle(page, "Import again into"); },
  },
  {
    name: "import result",
    open: async (page, data) => { await page.goto(`/campaigns/${data.campaignId}/imports/${data.firstImportId}`); await settle(page, "What happened"); },
  },
  {
    name: "import result, re-import",
    open: async (page, data) => { await page.goto(`/campaigns/${data.campaignId}/imports/${data.reimportId}`); await settle(page, "No sequence was restarted."); },
  },
  {
    name: "import result, not enrolled tab",
    open: async (page, data) => {
      await page.goto(`/campaigns/${data.campaignId}/imports/${data.firstImportId}`);
      await page.getByRole("tab", { name: /Not enrolled/ }).click();
      await settle(page, "Their company isn’t in the Businesses file.");
    },
  },
  {
    name: "import result loading",
    open: async (page, data) => {
      await hold(page, `**/api/campaigns/${data.campaignId}`);
      await page.goto(`/campaigns/${data.campaignId}/imports/${data.firstImportId}`);
      await page.getByLabel("Loading the import result").waitFor();
    },
  },
  { name: "leads", open: async (page) => { await page.goto("/leads"); await settle(page, "Amira Hassan"); } },
  { name: "leads search with no match", open: async (page) => { await page.goto("/leads?q=zzzz"); await settle(page, "No one matches"); } },
  {
    name: "leads empty",
    open: async (page) => {
      await page.route("**/api/leads?*", (route) => route.fulfill({ json: { rows: [], total: 0, limit: 100 } }));
      await page.goto("/leads");
      await settle(page, "No leads yet.");
    },
  },
  { name: "leads loading", open: async (page) => { await hold(page, "**/api/leads?*"); await page.goto("/leads"); await page.getByLabel("Loading leads").waitFor(); } },
  { name: "leads error", open: async (page) => { await fail(page, "**/api/leads?*"); await page.goto("/leads"); await settle(page, "Leads didn’t load."); } },
  {
    name: "leads with campaign options failing",
    open: async (page) => { await fail(page, "**/api/campaigns"); await page.goto("/leads"); await settle(page, "Amira Hassan"); },
  },
  {
    name: "company record",
    open: async (page, data) => { await page.goto(`/leads?company=${data.companyOf("Daniel Price")}`); await settle(page, "of whom 1 is enrolled"); },
  },
  {
    name: "person",
    open: async (page, data) => { await page.goto(`/leads/people/${data.person("Amira Hassan")}`); await page.getByRole("heading", { level: 1 }).waitFor(); },
  },
  {
    name: "person not enrolled",
    open: async (page, data) => { await page.goto(`/leads/people/${data.person("Sofia Marin")}`); await settle(page, "Not in any campaign."); },
  },
  {
    name: "person loading",
    open: async (page, data) => { await hold(page, "**/api/people/*"); await page.goto(`/leads/people/${data.person("Amira Hassan")}`); await page.getByLabel("Loading").waitFor(); },
  },
  {
    name: "person error",
    open: async (page, data) => { await fail(page, "**/api/people/*"); await page.goto(`/leads/people/${data.person("Amira Hassan")}`); await settle(page, "This record didn’t load."); },
  },
  {
    name: "company lead",
    open: async (page, data) => { await page.goto(`/leads/companies/${data.company("Riverside Sports Clinic")}`); await settle(page, "Company lead"); },
  },
  {
    name: "company lead through its shared inbox",
    open: async (page, data) => { await page.goto(`/leads/companies/${data.company("Juniper Pilates Studio")}`); await settle(page, "People on record"); },
  },
  { name: "record not found", open: async (page) => { await page.goto("/leads/people/nobody"); await settle(page, "No one found"); } },
  { name: "page not found", open: async (page) => { await page.goto("/nowhere"); await settle(page, "Page not found"); } },
];
