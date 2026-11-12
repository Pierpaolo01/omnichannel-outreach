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
  readonly unimportedCampaignId: string;
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
  let unimported = campaigns.campaigns.find((c) => c.name === "Dental clinics, Leeds");
  if (!unimported) {
    const created = await request.post("/api/campaigns", { data: { name: "Dental clinics, Leeds" } });
    unimported = ((await created.json()) as { campaign: { id: string; name: string } }).campaign;
  }
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
    unimportedCampaignId: unimported.id,
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

async function fail(page: Page, pattern: string, method?: string): Promise<void> {
  await page.route(pattern, (route) =>
    method && route.request().method() !== method
      ? route.continue()
      : route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong on the server." } } }),
  );
}

async function refuse(page: Page, pattern: string): Promise<void> {
  await page.route(pattern, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 400,
          json: { error: { code: "invalid_export", message: "Nothing was imported.", problems: [{ file: "pair", message: "These two files don’t belong together." }] } },
        })
      : route.continue(),
  );
}

async function readyImportAgain(page: Page, data: SeedData): Promise<void> {
  await page.goto(`/campaigns/${data.campaignId}/import`);
  await page.getByLabel("People file", { exact: true }).setInputFiles(fixture("people-run2.csv"));
  await page.getByLabel("Businesses file", { exact: true }).setInputFiles(fixture("businesses-run2.csv"));
  await settle(page, /6 businesses, matches/);
}

const BUSINESS_HEADER_ONLY_MISSING_PLACE =
  "business_id,business_name,phone_e164\nbz-1,Some Clinic,+442079460999\n";

/** A person record showing every outreach status, a bad number and a newer email. */
function galleryRecord(id: string) {
  const statuses = [
    "queued", "active", "in_win_back", "waiting_on_call", "callback_scheduled", "replied",
    "interested_on_call", "paused", "declined_on_call", "stopped_manually", "sequence_finished_no_response", "finished_no_usable_channel",
  ];
  return {
    kind: "person",
    id,
    name: "Status Gallery",
    title: "Fixture for every status",
    timezone: "Europe/London",
    company: { id: "co-gallery", name: "Gallery Clinic", city: "London" },
    companyIsLead: false,
    contactDetails: [
      { id: "d1", owner: "person", channel: "email", phoneKind: null, value: "old@gallery.example", bad: false, newer: false },
      { id: "d2", owner: "person", channel: "email", phoneKind: null, value: "new@gallery.example", bad: false, newer: true },
      { id: "d3", owner: "person", channel: "phone", phoneKind: "direct", value: "+44 20 7946 0999", bad: true, newer: false },
      { id: "d4", owner: "company", channel: "phone", phoneKind: "main_line", value: "+44 20 7946 0998", bad: false, newer: false },
    ],
    enrollments: statuses.map((status, i) => ({ id: `e${i}`, campaign: { id: `c${i}`, name: `Campaign ${i + 1}` }, status, enrolledAt: "2026-11-12T09:00:00.000Z" })),
    unenrolledReason: null,
    colleagues: [
      { id: "p2", name: "Colleague Two", title: "Manager", enrollments: statuses.slice(5, 8).map((status, i) => ({ id: `ce${i}`, campaign: { id: `c${i}`, name: `Campaign ${i + 1}` }, status, enrolledAt: "2026-11-12T09:00:00.000Z" })), unenrolledReason: null },
    ],
  };
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
  // States added after the second verification (recheck R3).
  {
    name: "leads refreshing with previous results",
    open: async (page) => {
      await page.goto("/leads");
      await settle(page, "Amira Hassan");
      await hold(page, "**/api/leads?q=*");
      await page.getByLabel("Search leads").fill("Amira");
      await settle(page, "Updating results.");
    },
  },
  {
    name: "leads with campaign options loading",
    open: async (page) => { await hold(page, "**/api/campaigns"); await page.goto("/leads"); await settle(page, "Amira Hassan"); },
  },
  {
    name: "leads filtered by campaign",
    open: async (page, data) => { await page.goto(`/leads?campaign=${data.campaignId}`); await settle(page, "Clear search and filters"); await settle(page, "Ravi Patel"); },
  },
  { name: "leads with a status filter that matches nobody", open: async (page) => { await page.goto("/leads?status=replied"); await settle(page, "No one matches these filters."); } },
  {
    name: "company record loading",
    open: async (page, data) => { await hold(page, "**/api/companies/*"); await page.goto(`/leads?company=${data.companyOf("Daniel Price")}`); await page.getByLabel("Loading the company").waitFor(); },
  },
  {
    name: "company record error",
    open: async (page, data) => { await fail(page, "**/api/companies/*"); await page.goto(`/leads?company=${data.companyOf("Daniel Price")}`); await settle(page, "This company didn’t load."); },
  },
  {
    name: "company lead loading",
    open: async (page, data) => { await hold(page, "**/api/companies/*"); await page.goto(`/leads/companies/${data.company("Riverside Sports Clinic")}`); await page.getByLabel("Loading").waitFor(); },
  },
  {
    name: "company lead error",
    open: async (page, data) => { await fail(page, "**/api/companies/*"); await page.goto(`/leads/companies/${data.company("Riverside Sports Clinic")}`); await settle(page, "This record didn’t load."); },
  },
  { name: "company not found", open: async (page) => { await page.goto("/leads/companies/nobody"); await settle(page, "No one found"); } },
  {
    name: "company with no usable channel",
    open: async (page, data) => { await page.goto(`/leads/companies/${data.company("Copper Kettle Osteopathy")}`); await settle(page, "Not in any campaign."); },
  },
  {
    name: "import again loading",
    open: async (page, data) => { await hold(page, "**/api/campaigns"); await page.goto(`/campaigns/${data.campaignId}/import`); await page.getByLabel("Loading").waitFor(); },
  },
  {
    name: "import again error",
    open: async (page, data) => { await fail(page, "**/api/campaigns"); await page.goto(`/campaigns/${data.campaignId}/import`); await settle(page, "This campaign didn’t load."); },
  },
  { name: "import again into a missing campaign", open: async (page) => { await page.goto("/campaigns/nope/import"); await settle(page, "No such campaign"); } },
  { name: "import again ready", open: readyImportAgain },
  {
    name: "import again refused",
    open: async (page, data) => {
      await refuse(page, "**/api/campaigns/*/imports");
      await readyImportAgain(page, data);
      await page.getByRole("button", { name: "Import", exact: true }).click();
      await page.getByRole("alert").waitFor();
    },
  },
  {
    name: "import again importing",
    open: async (page, data) => {
      await hold(page, "**/api/campaigns/*/imports", "POST");
      await readyImportAgain(page, data);
      await page.getByRole("button", { name: "Import", exact: true }).click();
      await settle(page, "Importing into");
    },
  },
  {
    name: "import result error",
    open: async (page, data) => { await fail(page, `**/api/campaigns/${data.campaignId}`); await page.goto(`/campaigns/${data.campaignId}/imports/${data.firstImportId}`); await settle(page, "This import result didn’t load."); },
  },
  {
    name: "import result for a missing import",
    open: async (page, data) => { await page.goto(`/campaigns/${data.campaignId}/imports/nope`); await settle(page, "No such import"); },
  },
  {
    name: "import result for a missing campaign",
    open: async (page) => { await page.goto("/campaigns/nope/imports/nope"); await settle(page, "This import result didn’t load."); },
  },
  ...(["New", "Already enrolled", "Updated"] as const).map(
    (tab): Screen => ({
      name: `import result, re-import, ${tab} tab`,
      open: async (page, data) => {
        await page.goto(`/campaigns/${data.campaignId}/imports/${data.reimportId}`);
        await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
        await page.getByRole("tab", { name: new RegExp(`^${tab}`), selected: true }).waitFor();
      },
    }),
  ),
  {
    name: "import result, unchanged group expanded",
    open: async (page, data) => {
      await page.goto(`/campaigns/${data.campaignId}/imports/${data.reimportId}`);
      await page.getByRole("button", { name: "Show them" }).click();
      await page.getByRole("tab", { name: /^Already enrolled/, selected: true }).waitFor();
    },
  },
  {
    name: "import result, empty outcome tab",
    open: async (page, data) => {
      await page.goto(`/campaigns/${data.campaignId}/imports/${data.firstImportId}`);
      await page.getByRole("tab", { name: /^Updated/ }).click();
      await settle(page, "None in this import.");
    },
  },
  {
    name: "new campaign checking a file",
    open: async (page) => {
      await hold(page, "**/api/scraper-files/check");
      await page.goto("/campaigns/new");
      await page.getByLabel("People file", { exact: true }).setInputFiles(fixture("people-run1.csv"));
      await settle(page, "Checking people-run1.csv");
    },
  },
  {
    name: "new campaign with a failed file check",
    open: async (page) => {
      await fail(page, "**/api/scraper-files/check");
      await page.goto("/campaigns/new");
      await page.getByLabel("People file", { exact: true }).setInputFiles(fixture("people-run1.csv"));
      await settle(page, "Something went wrong on the server.");
    },
  },
  {
    name: "new campaign with a file missing columns",
    open: async (page) => {
      await page.goto("/campaigns/new");
      await page.getByLabel("Businesses file", { exact: true }).setInputFiles({ name: "businesses-broken.csv", mimeType: "text/csv", buffer: Buffer.from(BUSINESS_HEADER_ONLY_MISSING_PLACE) });
      await settle(page, "missing these columns");
    },
  },
  {
    name: "new campaign with files from different runs",
    open: async (page) => {
      await page.goto("/campaigns/new");
      await page.getByLabel("People file", { exact: true }).setInputFiles(fixture("people-run1.csv"));
      await page.getByLabel("Businesses file", { exact: true }).setInputFiles({
        name: "businesses-other-run.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          "business_id,place_id,business_name,category,phone_e164,phone_original,general_emails,website,domain,street,neighborhood,city,state_province,postal_code,country,timezone\nbz-other,PL-other,Other Clinic,Dentist,+442079460999,,,,,,,London,,,GB,Europe/London\n",
        ),
      });
      await settle(page, "don’t belong together");
    },
  },
  {
    name: "new campaign named, one file chosen",
    open: async (page) => {
      await page.goto("/campaigns/new");
      await page.getByLabel("Campaign name").fill("Physio clinics, South London");
      await page.getByLabel("People file", { exact: true }).setInputFiles(fixture("people-run1.csv"));
      await settle(page, "Add both files.");
    },
  },
  {
    name: "creating a campaign without importing",
    open: async (page) => {
      await hold(page, "**/api/campaigns", "POST");
      await page.goto("/campaigns/new");
      await page.getByLabel("Campaign name").fill("Physio clinics, South London");
      await page.getByRole("button", { name: "Create without importing" }).click();
      await page.getByRole("button", { name: "Create without importing" }).and(page.locator("[disabled]")).waitFor();
    },
  },
  {
    name: "creating a campaign without importing fails",
    open: async (page) => {
      await fail(page, "**/api/campaigns", "POST");
      await page.goto("/campaigns/new");
      await page.getByLabel("Campaign name").fill("Physio clinics, South London");
      await page.getByRole("button", { name: "Create without importing" }).click();
      await page.getByRole("alert").waitFor();
    },
  },
  {
    name: "campaigns list with a campaign not imported yet",
    open: async (page) => { await page.goto("/campaigns"); await settle(page, "Nothing imported yet."); },
  },
  {
    name: "keyboard focus on the primary action",
    open: async (page) => {
      await readyForm(page);
      await page.getByRole("button", { name: "Create campaign and import" }).focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
    },
  },
  {
    name: "hovering a lead row",
    open: async (page) => { await page.goto("/leads"); await settle(page, "Amira Hassan"); await page.getByRole("row", { name: /Amira Hassan/ }).hover(); },
  },
  {
    name: "every outreach status, a bad number and a newer email",
    open: async (page, data) => {
      const id = data.person("Amira Hassan");
      await page.route(`**/api/people/${id}`, (route) => route.fulfill({ json: galleryRecord(id) }));
      await page.goto(`/leads/people/${id}`);
      await settle(page, "Finished, no usable channel");
    },
  },
  { name: "record not found", open: async (page) => { await page.goto("/leads/people/nobody"); await settle(page, "No one found"); } },
  { name: "page not found", open: async (page) => { await page.goto("/nowhere"); await settle(page, "Page not found"); } },
];
