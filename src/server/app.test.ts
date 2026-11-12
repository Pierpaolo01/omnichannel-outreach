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
    expect(res.body.campaigns).toEqual([expect.objectContaining({ id: campaign.id, leadCount: 5 })]);
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

describe("importing the paired scraper export", () => {
  test("reports new, already enrolled, updated and not enrolled leads with reasons", async () => {
    const campaign = await api.createCampaign("Physio clinics, London");
    const record = await api.importRun(campaign.id, "run1");

    expect(record.summary.counts).toEqual({ new: 5, already_enrolled: 0, updated: 0, not_enrolled: 3 });
    expect(record.summary.rows).toEqual({ businesses: 5, people: 6 });
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

    expect(again.summary.counts).toEqual({ new: 1, already_enrolled: 4, updated: 1, not_enrolled: 3 });
    expect(outcomeOf(again, "Ravi Patel")).toMatchObject({ outcome: "new" });
    expect(outcomeOf(again, "Amira Hassan")).toMatchObject({ outcome: "updated" });
    expect(outcomeOf(again, "Tom")).toMatchObject({ outcome: "already_enrolled" });

    const inCampaign = await search(`campaign=${campaign.id}`);
    expect(inCampaign.total).toBe(6);
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

  test("keeps a detail marked bad as bad, and does not count it as an update", async () => {
    const campaign = await api.createCampaign("Physio clinics, London");
    await api.importRun(campaign.id, "run1");
    const mobile = (await personNamed("Amira Hassan")).contactDetails.find((d) => d.phoneKind === "mobile");
    if (!mobile) throw new Error("Amira has no mobile");
    expect(api.store.markContactDetailBad(mobile.id)).toBe(true);

    const again = await api.importRun(campaign.id, "run1");
    expect(outcomeOf(again, "Amira Hassan")).toMatchObject({ outcome: "already_enrolled", channels: { sms: false } });
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

    expect(intoSecond.summary.counts).toEqual({ new: 5, already_enrolled: 0, updated: 0, not_enrolled: 3 });
    const amira = await findRow("Amira Hassan");
    expect(amira.enrollments.map((e) => e.campaign.name)).toEqual(["Physio clinics, London", "Spring follow-up, London"]);
    expect(amira.enrollments.every((e) => e.status === "queued")).toBe(true);
    expect((await search("")).total).toBe(7);
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
      expect.objectContaining({ owner: "company", channel: "phone", phoneKind: "main_line", value: "+442079460202" }),
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
    expect(res.body.contactDetails.map((d) => d.value)).toEqual(["info@riversidesports.example", "+442079460303"]);
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
  });

  test("filters by campaign and outreach status", async () => {
    const other = await api.createCampaign("Spring follow-up, London");
    const res = await api.get<{ campaigns: CampaignListItem[] }>("/api/campaigns");
    const first = res.body.campaigns.find((c) => c.id !== other.id);
    expect((await search(`campaign=${other.id}`)).total).toBe(0);
    expect((await search(`campaign=${first?.id}&status=queued`)).total).toBe(5);
    expect((await search("status=replied")).total).toBe(0);
  });

  test("rejects an unknown outreach status", async () => {
    expect((await api.get<ApiError>("/api/leads?status=sold")).status).toBe(400);
  });

  test("says why someone on record is not in a campaign", async () => {
    expect(await findRow("Sofia Marin")).toMatchObject({ enrollments: [], unenrolledReason: "no_usable_channel" });
    expect(await findRow("Copper Kettle Osteopathy")).toMatchObject({ kind: "company", unenrolledReason: "no_usable_channel" });
  });
});
