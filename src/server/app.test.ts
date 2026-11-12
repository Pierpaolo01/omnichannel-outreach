import { beforeEach, describe, expect, test } from "vitest";
import { scraperExport } from "../../test/support/fixtures.ts";
import { testApi, type TestApi } from "../../test/support/http.ts";
import type {
  ApiError,
  CampaignListItem,
  CompanyRecord,
  ImportRecord,
  LeadRow,
  LeadSearchResult,
  PersonRecord,
  SummaryEntry,
} from "../shared/api.ts";

let api: TestApi;
beforeEach(() => {
  api = testApi();
});

async function search(query: string): Promise<LeadSearchResult> {
  const res = await api.get<LeadSearchResult>(`/api/leads?${query}`);
  expect(res.status).toBe(200);
  return res.body;
}

async function findRow(name: string): Promise<LeadRow> {
  const { rows } = await search(`q=${encodeURIComponent(name)}`);
  const row = rows.find((r) => r.name === name);
  if (!row) throw new Error(`no lead row for ${name}`);
  return row;
}

async function personNamed(name: string): Promise<PersonRecord> {
  const row = await findRow(name);
  const res = await api.get<PersonRecord>(`/api/people/${row.id}`);
  expect(res.status).toBe(200);
  return res.body;
}

function outcomeOf(record: ImportRecord, name: string): SummaryEntry | undefined {
  return record.summary.entries.find((e) => e.name === name);
}

describe("campaigns", () => {
  test("a created campaign is listed with its lead count", async () => {
    const campaign = await api.createCampaign("Physio clinics, London", "Europe/London");
    expect(campaign).toMatchObject({ name: "Physio clinics, London", defaultTimezone: "Europe/London" });

    await api.importRun(campaign.id, "run1");
    const res = await api.get<{ campaigns: CampaignListItem[] }>("/api/campaigns");
    expect(res.body.campaigns).toEqual([
      expect.objectContaining({ id: campaign.id, leadCount: 6, lastImport: expect.objectContaining({ counts: expect.objectContaining({ new: 6 }) }) }),
    ]);
  });

  test("a campaign name is at most 100 characters, and the refusal says so", async () => {
    const res = await api.post<ApiError>("/api/campaigns", { name: `L${"x".repeat(100)}` });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("Keep the campaign name to 100 characters or fewer.");
    expect((await api.post<ApiError>("/api/campaigns", { name: "x".repeat(100) })).status).toBe(201);
  });

  test("a campaign needs a name and a recognised time zone", async () => {
    expect((await api.post<ApiError>("/api/campaigns", { name: "  " })).status).toBe(400);
    const badZone = await api.post<ApiError>("/api/campaigns", { name: "Physio", defaultTimezone: "Mars/Olympus" });
    expect(badZone.status).toBe(400);
    expect(badZone.body.error.message).toMatch(/time zone/i);
  });

  test("importing into a campaign that does not exist is a 404", async () => {
    const res = await api.post<ApiError>("/api/campaigns/nope/imports", scraperExport("run1"));
    expect(res.status).toBe(404);
  });
});

describe("creating a campaign from its first scraper files", () => {
  test("creates the campaign and imports both files in one step", async () => {
    const res = await api.post<{ campaign: { id: string; name: string }; import: ImportRecord }>("/api/campaigns", {
      name: "Physio clinics, London",
      ...scraperExport("run1"),
      fileNames: { people: "people-run1.csv", businesses: "businesses-run1.csv" },
    });
    expect(res.status).toBe(201);
    expect(res.body.import).toMatchObject({
      campaignId: res.body.campaign.id,
      fileNames: { people: "people-run1.csv", businesses: "businesses-run1.csv" },
      summary: { counts: { new: 6 } },
    });
    const found = await api.get<{ campaign: { id: string }; import: ImportRecord }>(
      `/api/campaigns/${res.body.campaign.id}/imports/${res.body.import.id}`,
    );
    expect(found.body.import.summary.counts).toEqual(res.body.import.summary.counts);
  });

  test("invalid files import nothing and create no campaign", async () => {
    const { businessesCsv, peopleCsv } = scraperExport("run1");
    const res = await api.post<ApiError>("/api/campaigns", { name: "Physio clinics, London", businessesCsv: peopleCsv, peopleCsv: businessesCsv });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_export");
    expect((await api.get<{ campaigns: CampaignListItem[] }>("/api/campaigns")).body.campaigns).toEqual([]);
    expect((await search("")).total).toBe(0);
  });

  test("needs both files, or neither", async () => {
    const res = await api.post<ApiError>("/api/campaigns", { name: "Physio", peopleCsv: scraperExport("run1").peopleCsv });
    expect(res.status).toBe(400);
    expect((await api.get<{ campaigns: CampaignListItem[] }>("/api/campaigns")).body.campaigns).toEqual([]);
  });
});

describe("checking a chosen file before importing", () => {
  test("counts the rows of a file that matches the scraper export", async () => {
    const res = await api.post<{ businesses: unknown; people: unknown; pair: unknown }>("/api/scraper-files/check", {
      peopleCsv: scraperExport("run1").peopleCsv,
    });
    expect(res.body).toEqual({ businesses: null, people: { ok: true, rows: 7 }, pair: null });
  });

  test("says when a file is in the wrong slot, and when two files are from different runs", async () => {
    const { businessesCsv, peopleCsv } = scraperExport("run1");
    const swapped = await api.post<{ businesses: { ok: boolean; message?: string } }>("/api/scraper-files/check", {
      businessesCsv: peopleCsv,
    });
    expect(swapped.body.businesses).toEqual({ ok: false, message: "This is the People file. Choose the Businesses file here." });

    const header = businessesCsv.split("\n")[0] ?? "";
    const unrelated = await api.post<{ pair: string | null }>("/api/scraper-files/check", { businessesCsv: `${header}\n`, peopleCsv });
    expect(unrelated.body.pair).toMatch(/same scraper run/);
  });
});

describe("importing the paired scraper export", () => {
  test("reports new, already enrolled, updated and not enrolled leads with reasons", async () => {
    const campaign = await api.createCampaign("Physio clinics, London");
    const record = await api.importRun(campaign.id, "run1");

    expect(record.summary.counts).toEqual({ new: 6, already_enrolled: 0, updated: 0, not_enrolled: 4 });
    expect(record.summary.rows).toEqual({ businesses: 6, people: 7 });
    expect(outcomeOf(record, "Sofia Marin")).toMatchObject({ outcome: "not_enrolled", reason: "no_usable_channel" });
    expect(outcomeOf(record, "Jordan Lee")).toMatchObject({ outcome: "not_enrolled", reason: "company_not_in_export" });
  });

  test("rejects an export with missing columns and names the problem", async () => {
    const campaign = await api.createCampaign("Physio clinics, London");
    const { peopleCsv } = scraperExport("run1");
    const res = await api.post<ApiError>(`/api/campaigns/${campaign.id}/imports`, { businessesCsv: peopleCsv, peopleCsv });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_export");
    expect(res.body.error.problems?.[0]).toMatchObject({ file: "businesses" });
  });

  test("keeps the import summaries for the campaign, newest first", async () => {
    const campaign = await api.createCampaign("Physio clinics, London");
    const first = await api.importRun(campaign.id, "run1");
    const second = await api.importRun(campaign.id, "run2");
    const res = await api.get<{ imports: ImportRecord[] }>(`/api/campaigns/${campaign.id}/imports`);
    expect(res.body.imports.map((i) => i.id)).toEqual([second.id, first.id]);
  });
});

describe("re-importing into the same campaign", () => {
  test("merges duplicates without enrolling anyone twice, and enrols new people", async () => {
    const campaign = await api.createCampaign("Physio clinics, London");
    await api.importRun(campaign.id, "run1");
    const again = await api.importRun(campaign.id, "run2");

    expect(again.summary.counts).toEqual({ new: 1, already_enrolled: 4, updated: 2, not_enrolled: 4 });
    expect(outcomeOf(again, "Ravi Patel")).toMatchObject({ outcome: "new" });
    expect(outcomeOf(again, "Amira Hassan")).toMatchObject({
      outcome: "updated",
      added: [{ channel: "email", phoneKind: null, value: "amira.hassan@harbourmail.example" }],
    });
    expect(outcomeOf(again, "Riverside Sports Clinic")).toMatchObject({
      outcome: "updated",
      added: [{ channel: "email", value: "bookings@riversidesports.example" }],
    });
    expect(outcomeOf(again, "Tom")).toMatchObject({ outcome: "already_enrolled" });

    const inCampaign = await search(`campaign=${campaign.id}`);
    expect(inCampaign.total).toBe(7);
    expect(inCampaign.rows.every((r) => r.enrollments.length === 1)).toBe(true);
  });

  test("matches a company whose scraper business_id changed between runs by its place", async () => {
    const campaign = await api.createCampaign("Physio clinics, London");
    await api.importRun(campaign.id, "run1");
    await api.importRun(campaign.id, "run2");
    const { rows } = await search("q=Harbour%20Lane");
    expect(rows.map((r) => r.name).sort()).toEqual(["Amira Hassan", "Tom"]);
  });

  test("never restarts an existing enrollment", async () => {
    const campaign = await api.createCampaign("Physio clinics, London");
    await api.importRun(campaign.id, "run1");
    const before = (await personNamed("Amira Hassan")).enrollments;
    await api.importRun(campaign.id, "run2");
    await api.importRun(campaign.id, "run1");
    expect((await personNamed("Amira Hassan")).enrollments).toEqual(before);
  });

  test("adds a new detail alongside the old one and marks it newer", async () => {
    const campaign = await api.createCampaign("Physio clinics, London");
    await api.importRun(campaign.id, "run1");
    await api.importRun(campaign.id, "run2");

    const emails = (await personNamed("Amira Hassan")).contactDetails.filter((d) => d.owner === "person" && d.channel === "email");
    expect(emails).toEqual([
      expect.objectContaining({ value: "amira@harbourlanephysio.example", newer: false }),
      expect.objectContaining({ value: "amira.hassan@harbourmail.example", newer: true }),
    ]);
  });

  test("counts as updated only a lead whose import brought newer contact details", async () => {
    const campaign = await api.createCampaign("Physio clinics, London");
    await api.importRun(campaign.id, "run1");
    const { businessesCsv, peopleCsv } = scraperExport("run1");
    const retitled = await api.post<{ import: ImportRecord }>(`/api/campaigns/${campaign.id}/imports`, {
      businessesCsv,
      peopleCsv: peopleCsv.replace("Clinic director", "Managing director"),
    });
    expect(outcomeOf(retitled.body.import, "Amira Hassan")).toMatchObject({ outcome: "already_enrolled", added: [] });
    expect((await personNamed("Amira Hassan")).title).toBe("Managing director");
  });

  test("keeps a detail marked bad as bad, and does not count it as an update", async () => {
    const campaign = await api.createCampaign("Physio clinics, London");
    await api.importRun(campaign.id, "run1");
    const mobile = (await personNamed("Amira Hassan")).contactDetails.find((d) => d.phoneKind === "mobile");
    if (!mobile) throw new Error("Amira has no mobile");
    expect(await api.store.markContactDetailBad(mobile.id)).toBe(true);

    const again = await api.importRun(campaign.id, "run1");
    expect(outcomeOf(again, "Amira Hassan")).toMatchObject({
      outcome: "already_enrolled",
      channels: { sms: false },
      stillBad: [{ channel: "phone", phoneKind: "mobile", value: "+44 7700 900101" }],
    });
    const after = (await personNamed("Amira Hassan")).contactDetails.filter((d) => d.phoneKind === "mobile");
    expect(after).toEqual([expect.objectContaining({ id: mobile.id, bad: true })]);
  });
});

describe("several campaigns", () => {
  test("one person can be enrolled in several campaigns, with no exclusions from earlier ones", async () => {
    const first = await api.createCampaign("Physio clinics, London");
    const second = await api.createCampaign("Spring follow-up, London");
    await api.importRun(first.id, "run1");
    const intoSecond = await api.importRun(second.id, "run1");

    expect(intoSecond.summary.counts).toEqual({ new: 6, already_enrolled: 0, updated: 0, not_enrolled: 4 });
    const amira = await findRow("Amira Hassan");
    expect(amira.enrollments.map((e) => e.campaign.name)).toEqual(["Physio clinics, London", "Spring follow-up, London"]);
    expect(amira.enrollments.every((e) => e.status === "queued")).toBe(true);
    expect((await search("")).total).toBe(9);
  });
});

describe("contact details on the record", () => {
  test("a decision maker's own details are kept apart from the company's shared ones", async () => {
    const campaign = await api.createCampaign("Physio clinics, London");
    await api.importRun(campaign.id, "run1");

    const daniel = await personNamed("Daniel Price");
    expect(daniel.contactDetails).toEqual([
      expect.objectContaining({ owner: "person", channel: "email", value: "daniel@elmstreetchiro.example" }),
      expect.objectContaining({ owner: "company", channel: "email", value: "contact@elmstreetchiro.example" }),
    ]);

    const grace = await personNamed("Grace Okafor");
    expect(grace.contactDetails).toEqual([
      expect.objectContaining({ owner: "company", channel: "phone", phoneKind: "main_line", value: "+44 20 7946 0202" }),
    ]);
    expect(grace.enrollments).toHaveLength(1);
  });

  test("an unreachable decision maker stays on the company record, shown beside colleagues", async () => {
    const campaign = await api.createCampaign("Physio clinics, London");
    await api.importRun(campaign.id, "run1");

    const sofia = await personNamed("Sofia Marin");
    expect(sofia).toMatchObject({ enrollments: [], unenrolledReason: "no_usable_channel", company: { name: "Elm Street Chiropractic" } });

    const daniel = await personNamed("Daniel Price");
    expect(daniel.colleagues).toEqual([
      expect.objectContaining({ name: "Sofia Marin", title: "Head chiropractor", enrollments: [], unenrolledReason: "no_usable_channel" }),
    ]);
    const company = await api.get<CompanyRecord>(`/api/companies/${daniel.company.id}`);
    expect(company.body.people.map((p) => p.name)).toEqual(["Daniel Price", "Sofia Marin"]);
  });

  test("a company whose decision makers cannot be reached is a company lead through its shared inbox", async () => {
    const campaign = await api.createCampaign("Physio clinics, London");
    await api.importRun(campaign.id, "run1");

    const row = await findRow("Juniper Pilates Studio");
    expect(row).toMatchObject({ kind: "company", enrollments: [expect.objectContaining({ status: "queued" })] });
    const company = await api.get<CompanyRecord>(`/api/companies/${row.id}`);
    expect(company.body.people).toEqual([
      expect.objectContaining({ name: "Marco Bianchi", enrollments: [], unenrolledReason: "no_usable_channel" }),
    ]);
    expect(await personNamed("Marco Bianchi")).toMatchObject({ enrollments: [], unenrolledReason: "no_usable_channel" });
  });

  test("a company lead's record holds its shared details and its enrollment", async () => {
    const campaign = await api.createCampaign("Physio clinics, London");
    await api.importRun(campaign.id, "run1");

    const row = await findRow("Riverside Sports Clinic");
    expect(row).toMatchObject({ kind: "company" });
    const res = await api.get<CompanyRecord>(`/api/companies/${row.id}`);
    expect(res.body).toMatchObject({
      kind: "company",
      name: "Riverside Sports Clinic",
      timezone: "Europe/London",
      people: [],
      enrollments: [expect.objectContaining({ status: "queued" })],
    });
    expect(res.body.contactDetails.map((d) => d.value)).toEqual(["+44 20 7946 0303", "info@riversidesports.example"]);
  });

  test("an unknown person is a 404", async () => {
    expect((await api.get<ApiError>("/api/people/nobody")).status).toBe(404);
  });
});

describe("lead search", () => {
  beforeEach(async () => {
    const campaign = await api.createCampaign("Physio clinics, London");
    await api.importRun(campaign.id, "run1");
  });

  const names = async (query: string): Promise<string[]> => (await search(query)).rows.map((r) => r.name);

  test("finds people by name, ignoring case", async () => {
    expect(await names("q=amira")).toEqual(["Amira Hassan"]);
  });

  test("finds everyone at a company by its name, and company leads as company rows", async () => {
    expect(await names("q=elm%20street")).toEqual(["Daniel Price", "Sofia Marin"]);
    const { rows } = await search("q=riverside");
    expect(rows).toEqual([expect.objectContaining({ kind: "company", name: "Riverside Sports Clinic" })]);
  });

  test("finds people by email", async () => {
    expect(await names("q=tom%40harbourlane")).toEqual(["Tom"]);
  });

  test("finds by partial phone digits, in international or national form", async () => {
    expect(await names("q=7946%200303")).toEqual(["Riverside Sports Clinic"]);
    expect(await names("q=020%207946%200202")).toEqual(["Grace Okafor"]);
    expect(await names("q=900101")).toEqual(["Amira Hassan"]);
    expect(await names("q=07700%20900101")).toEqual(["Amira Hassan"]);
  });

  test("counts people and companies separately", async () => {
    expect(await search("")).toMatchObject({ total: 9, people: 6, companies: 3 });
  });

  test("filters by campaign and outreach status", async () => {
    const other = await api.createCampaign("Spring follow-up, London");
    const res = await api.get<{ campaigns: CampaignListItem[] }>("/api/campaigns");
    const first = res.body.campaigns.find((c) => c.id !== other.id);
    expect((await search(`campaign=${other.id}`)).total).toBe(0);
    expect((await search(`campaign=${first?.id}&status=queued`)).total).toBe(6);
    expect((await search("status=replied")).total).toBe(0);
  });

  test("filters to one company: its people and its company lead", async () => {
    const daniel = await findRow("Daniel Price");
    if (daniel.kind !== "person") throw new Error("expected a person row");
    expect(await names(`company=${daniel.company.id}`)).toEqual(["Daniel Price", "Sofia Marin"]);
    const juniper = await findRow("Juniper Pilates Studio");
    expect(await names(`company=${juniper.id}`)).toEqual(["Juniper Pilates Studio", "Marco Bianchi"]);
  });

  test("rejects an unknown outreach status", async () => {
    expect((await api.get<ApiError>("/api/leads?status=sold")).status).toBe(400);
  });

  test("says why someone on record is not in a campaign", async () => {
    expect(await findRow("Sofia Marin")).toMatchObject({ enrollments: [], unenrolledReason: "no_usable_channel" });
    expect(await findRow("Copper Kettle Osteopathy")).toMatchObject({ kind: "company", unenrolledReason: "no_usable_channel" });
  });
});

describe("the local server's request guard", () => {
  const post = (headers: Record<string, string>, body = JSON.stringify({ name: "Physio" })) =>
    api.raw("/api/campaigns", { method: "POST", headers, body });

  test("refuses a request for another host, as a DNS-rebinding page would send", async () => {
    const res = await api.raw("/api/leads", { headers: { host: "attacker.example:4310" } });
    expect(res.status).toBe(403);
  });

  test("accepts localhost and 127.0.0.1 on any port", async () => {
    expect((await api.raw("/api/leads", { headers: { host: "127.0.0.1:4310" } })).status).toBe(200);
    expect((await api.raw("/api/leads", { headers: { host: "localhost:5173" } })).status).toBe(200);
  });

  test("refuses a change that isn't JSON, as a cross-site form or no-cors fetch would send", async () => {
    const res = await post({ "content-type": "text/plain" });
    expect(res.status).toBe(415);
    expect((await api.get<{ campaigns: CampaignListItem[] }>("/api/campaigns")).body.campaigns).toEqual([]);
  });

  test("refuses a change from another site", async () => {
    expect((await post({ "content-type": "application/json", origin: "https://attacker.example" })).status).toBe(403);
    expect((await post({ "content-type": "application/json", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await api.get<{ campaigns: CampaignListItem[] }>("/api/campaigns")).body.campaigns).toEqual([]);
  });

  test("accepts a change from the app's own page", async () => {
    const res = await post({ "content-type": "application/json", origin: "http://127.0.0.1:4310", "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(201);
  });
});
