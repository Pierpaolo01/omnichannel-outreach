import { business, csvOf, person, type ExportRows } from "./export-builder.ts";
import { testApi, type TestApi } from "./http.ts";
import { parsePhone } from "../../src/domain/phone.ts";
import type { CompanyRecord, ContactDetailView, ImportSummary, LeadSearchResult, PersonRecord, SummaryEntry } from "../../src/shared/api.ts";

type Unmatched = Extract<SummaryEntry, { reason: "ambiguous_match" }>;
const isUnmatched = (e: SummaryEntry): e is Unmatched => e.outcome === "not_enrolled" && e.reason === "ambiguous_match";
const notJoined = (e: SummaryEntry) => e.outcome === "not_enrolled" && e.reason === "company_not_in_export";

/**
 * Generated import sequences through the real HTTP app and SQLite store, for
 * src/server/import-sequences.test.ts. The generator keeps its own record of the logical people
 * and companies behind every row and predicts, from that record alone, which rows are decisive
 * and which are truly ambiguous. The checks compare the CRM against that record, never against
 * names:
 * 1. a decisive row is applied, and enrolled when it has a usable channel; an ambiguity the record
 *    does not predict fails, and so does a predicted ambiguity that lands in a record;
 * 2. a row that changed nothing wrote nothing;
 * 3. every record belongs to exactly one logical person or company, and each logical person or
 *    company to one record; a person's record sits at their company's record;
 * 4. at most one enrollment per logical person, and per logical company lead, per campaign; and a
 *    personal email or mobile is one enrolled lead's per campaign, a shared inbox one company lead's;
 * 5. a contact value has exactly one owner within a company, and personal reach uses only personal
 *    details; a bad mark survives every import;
 * 6. importing the same files again changes nothing;
 * 7. no import returns a server error.
 * The generator only produces input the rule can decide: same-name colleagues first appear
 * together, an ID is never reused by someone whose namesake has carried it onto a record, a twin
 * lists only its own email and numbers, and every company row carries its anchor (a place_id,
 * main line or address) unless the company never has one. docs/adr/0001 lists what it cannot reach.
 */

export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The ways one UK number is written. */
const forms = (digits: string) => [`+44${digits}`, `0${digits.replace(/^(\d{2})(\d{4})/, "$1 $2 ")}`, `0044 ${digits}`, `+44 ${digits}`];

interface LogicalCompany {
  readonly names: readonly string[];
  /** Present on every row of this company. "none": the company never has a place, line or address. */
  readonly anchor: "place" | "line" | "address" | "none";
  readonly line: string | null;
  readonly street: string;
  readonly postal: string;
  readonly inbox: string;
}

export const COMPANIES: readonly LogicalCompany[] = [
  { names: ["Harbour Lane Physio", "HARBOUR-LANE PHYSIO"], anchor: "line", line: "2079460101", street: "1 Harbour Lane", postal: "N1 1AA", inbox: "info@harbour.example" },
  { names: ["Northgate Dental", "Northgate dental"], anchor: "place", line: "2079460202", street: "2 Northgate", postal: "N2 2BB", inbox: "hello@northgate.example" },
  { names: ["Elm Street Chiro"], anchor: "address", line: "2079460303", street: "4 Elm Street", postal: "N4 4DD", inbox: "contact@elm.example" },
  { names: ["City Physio"], anchor: "line", line: "2079460404", street: "1 North Street", postal: "N9 1AA", inbox: "north@cityphysio.example" },
  { names: ["City Physio"], anchor: "address", line: "2079460505", street: "9 South Road", postal: "SE1 9ZZ", inbox: "south@cityphysio.example" },
  { names: ["Unkeyed Clinic"], anchor: "none", line: null, street: "", postal: "", inbox: "office@unkeyed.example" },
];

interface LogicalPerson {
  readonly company: number;
  readonly names: readonly string[];
  readonly title: string;
  readonly emails: readonly string[];
  /** Numbers only this person lists, as national digits. */
  readonly direct: string;
  readonly mobile: string;
  /** Has a colleague of the same name, so lists only their own numbers. */
  readonly twin?: number;
}

export const PEOPLE: readonly LogicalPerson[] = [
  { company: 0, names: ["Pat O'Neil", "Pat ONeil", "Dr Pat O’Neil"], title: "Owner", emails: ["pat@harbour.example", "Pat@Harbour.example", "p.oneil@mail.example"], direct: "2079461001", mobile: "7700900101" },
  { company: 0, names: ["Sam Lee"], title: "Owner", emails: ["sam@harbour.example"], direct: "2079461002", mobile: "7700900102", twin: 2 },
  { company: 0, names: ["Sam Lee"], title: "Practice manager", emails: ["s.lee@harbour.example"], direct: "2079461003", mobile: "7700900103", twin: 1 },
  { company: 1, names: ["Grace Okafor", "Grace OKAFOR"], title: "Principal dentist", emails: ["grace@northgate.example"], direct: "2079461004", mobile: "7700900104" },
  { company: 1, names: ["Ravi Patel"], title: "Practice owner", emails: ["ravi@northgate.example", "info@harbour.example"], direct: "2079461005", mobile: "7700900105" },
  { company: 2, names: ["Daniel Price", "Daniel Price PhD"], title: "Clinic director", emails: ["daniel@elm.example", "contact@elm.example"], direct: "2079461006", mobile: "7700900106" },
  { company: 3, names: ["Nia Cole"], title: "Owner", emails: ["nia@cityphysio.example"], direct: "2079461007", mobile: "7700900107" },
  { company: 4, names: ["Omar Reed"], title: "Clinical lead", emails: ["omar@cityphysio.example"], direct: "2079461008", mobile: "7700900108" },
  { company: 5, names: ["Lena Ward"], title: "Owner", emails: ["lena@unkeyed.example"], direct: "2079461009", mobile: "7700900109" },
];

export interface Generated {
  readonly rows: ExportRows;
  /** The logical company behind each business row, and the logical person behind each People row. */
  readonly companyOfRow: readonly number[];
  readonly personOfRow: readonly number[];
}

export interface History {
  /** Whether the logical person has a record yet. */
  appeared(person: number): boolean;
  /** Whether another logical person or company with this name has carried the ID onto a record. */
  carriedBySameName(kind: "person" | "company", logical: number, id: string): boolean;
}

export function generateRun(rand: () => number, step: number, history: History): Generated {
  const appeared = (p: number) => history.appeared(p);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
  const chance = (p: number) => rand() < p;
  const taken = new Set<string>();
  /**
   * An ID: the entity's own, blank, one used only in this run, or another entity's. Never one a
   * same-name entity has carried onto a record: no rule could tell the two apart.
   */
  const idFor = (kind: "person" | "company", logical: number, own: string, others: readonly string[]): string => {
    const choice = rand();
    const id = choice < 0.6 ? own : choice < 0.75 ? "" : choice < 0.85 ? `${own}-run${step}` : pick(others);
    if (!id) return "";
    const unique = taken.has(id) || history.carriedBySameName(kind, logical, id) ? `${own}-run${step}-${taken.size}` : id;
    taken.add(unique);
    return unique;
  };

  const includedCompanies = COMPANIES.map((_, i) => i).filter(() => chance(0.85));
  const businesses: Record<string, string>[] = [];
  const companyOfRow: number[] = [];
  const businessIdOf = new Map<number, string>();
  const lineListed = new Set<number>();
  for (const i of includedCompanies) {
    const c = COMPANIES[i];
    if (!c) continue;
    const withLine = c.line !== null && (c.anchor === "line" || chance(0.5));
    const line = withLine && c.line ? pick(forms(c.line)) : "";
    if (withLine) lineListed.add(i);
    const e164 = line.startsWith("+") && !line.includes(" ") ? line : "";
    const otherNames = COMPANIES.flatMap((o, j) => (o.names[0] !== c.names[0] ? [`bz-${j}`] : []));
    const businessId = idFor("company", i, `bz-${i}`, otherNames);
    businessIdOf.set(i, businessId);
    // A twin's email never becomes a shared inbox: it is how the twin is told apart.
    const sameCompanyEmails = PEOPLE.filter((p) => p.company === i && p.twin === undefined).flatMap((p) => p.emails);
    const row = business({
      business_id: businessId,
      place_id: c.anchor === "place" || (c.anchor !== "none" && chance(0.5)) ? `PL-${i}` : "",
      business_name: pick(c.names),
      country: e164 ? pick(["GB", "GB", "United Kingdom", ""]) : "GB",
      phone_e164: e164,
      phone_original: line,
      street: c.anchor === "address" || (c.anchor !== "none" && chance(0.5)) ? c.street : "",
      postal_code: c.anchor === "address" || (c.anchor !== "none" && chance(0.5)) ? c.postal : "",
      general_emails: [chance(0.5) ? c.inbox : "", chance(0.1) ? pick(sameCompanyEmails) : ""].filter(Boolean).join(";"),
    });
    // An address is the street with its postal code: keep both or neither, so the anchor holds.
    if (!row["street"] || !row["postal_code"]) Object.assign(row, c.anchor === "address" ? { street: c.street, postal_code: c.postal } : { street: "", postal_code: "" });
    businesses.push(row);
    companyOfRow.push(i);
    if (chance(0.1)) {
      businesses.push(row);
      companyOfRow.push(i);
    }
  }

  const chosen = PEOPLE.map((p, i) => includedCompanies.includes(p.company) && chance(0.75) ? i : -1).filter((i) => i >= 0);
  // Same-name colleagues first appear together, so no rule could mistake one for the other.
  const people = chosen.filter((i) => {
    const twin = PEOPLE[i]?.twin;
    return twin === undefined || appeared(i) || (!appeared(twin) && chosen.includes(twin));
  });
  const rows: Record<string, string>[] = [];
  const personOfRow: number[] = [];
  for (const i of people) {
    const p = PEOPLE[i];
    const c = p ? COMPANIES[p.company] : undefined;
    if (!p || !c) continue;
    const otherNames = PEOPLE.flatMap((o, j) => (o.names[0] !== p.names[0] ? [`pp-${j}`] : []));
    const companyLine = c.line && p.twin === undefined && (lineListed.has(p.company) || chance(0.3)) && chance(0.15) ? pick(forms(c.line)) : "";
    const mobile = chance(0.3);
    const row = person({
      person_id: idFor("person", i, `pp-${i}`, otherNames),
      business_id: businessIdOf.get(p.company) ?? "",
      full_name: pick(p.names),
      title: p.title,
      email: chance(0.6) ? pick(p.emails) : "",
      direct_phone: companyLine || (chance(0.3) ? pick(forms(p.direct)) : ""),
      dial_phone: mobile ? pick(forms(p.mobile)) : "",
      dial_phone_type: mobile ? pick(["mobile", "mobile", "cell", ""]) : "",
    });
    rows.push(row);
    personOfRow.push(i);
    if (chance(0.1)) {
      rows.push(row);
      personOfRow.push(i);
    }
  }
  return { rows: { businesses, people: rows }, companyOfRow, personOfRow };
}

/** One key per value: phones by their E.164 key, emails lower-cased. */
export function valueKey(d: Pick<ContactDetailView, "channel" | "value">): string {
  return d.channel === "phone" ? `phone|${parsePhone(d.value, "GB")?.key ?? d.value}` : `email|${d.value.trim().toLowerCase()}`;
}

interface World {
  readonly companies: readonly CompanyRecord[];
  readonly people: readonly PersonRecord[];
}

async function world(api: TestApi): Promise<World> {
  const rows = (await api.get<LeadSearchResult>("/api/leads?limit=500")).body.rows;
  const companyIds = new Set(rows.map((r) => (r.kind === "company" ? r.id : r.company.id)));
  const people = await Promise.all(rows.filter((r) => r.kind === "person").map(async (r) => (await api.get<PersonRecord>(`/api/people/${r.id}`)).body));
  const companies = await Promise.all([...companyIds].map(async (id) => (await api.get<CompanyRecord>(`/api/companies/${id}`)).body));
  return { companies, people };
}

/**
 * The generator's ledger, kept from its own logical identities: which records each logical person
 * and company has landed in, which IDs each carried there, and the evidence each twin's record
 * holds (the emails, IDs and numbers of its applied rows).
 */
class Ledger implements History {
  readonly recordsOfPerson = new Map<number, Set<string>>();
  readonly recordsOfCompany = new Map<number, Set<string>>();
  readonly evidence = new Map<number, Set<string>>();
  private readonly carriers = new Map<string, Set<number>>();

  record(summary: ImportSummary, run: Generated): void {
    run.personOfRow.forEach((logical, row) => {
      const record = summary.rowRecords.people[row];
      link(this.recordsOfPerson, logical, record);
      const cells = run.rows.people?.[row];
      if (!record || !cells) return;
      this.carry("person", logical, cells["person_id"] ?? "");
      this.evidence.set(logical, new Set([...(this.evidence.get(logical) ?? []), ...evidenceOf(cells)]));
    });
    run.companyOfRow.forEach((logical, row) => {
      const record = summary.rowRecords.businesses[row];
      link(this.recordsOfCompany, logical, record);
      if (record) this.carry("company", logical, run.rows.businesses[row]?.["business_id"] ?? "");
    });
  }

  appeared(person: number): boolean {
    return (this.recordsOfPerson.get(person)?.size ?? 0) > 0;
  }

  carriedBySameName(kind: "person" | "company", logical: number, id: string): boolean {
    const nameOf = (i: number) => (kind === "person" ? PEOPLE[i]?.names[0] : COMPANIES[i]?.names[0]);
    return [...(this.carriers.get(`${kind}|${id}`) ?? [])].some((other) => other !== logical && nameOf(other) === nameOf(logical));
  }

  private carry(kind: "person" | "company", logical: number, id: string): void {
    if (!id) return;
    const key = `${kind}|${id}`;
    this.carriers.set(key, (this.carriers.get(key) ?? new Set()).add(logical));
  }
}

/** A People row's identifying evidence: its ID, email and numbers, as the generator wrote them. */
function evidenceOf(cells: Readonly<Record<string, string>>): string[] {
  const phone = (raw: string) => (raw ? [`phone|${parsePhone(raw, "GB")?.key ?? raw}`] : []);
  return [
    ...(cells["person_id"] ? [`id|${cells["person_id"]}`] : []),
    ...(cells["email"] ? [`email|${cells["email"].trim().toLowerCase()}`] : []),
    ...phone(cells["direct_phone"] ?? ""),
    ...phone(cells["dial_phone"] ?? ""),
  ];
}

function link(map: Map<number, Set<string>>, logical: number, record: string | null | undefined): void {
  if (!record) return;
  map.set(logical, (map.get(logical) ?? new Set()).add(record));
}

/** What the generator's own record says should happen to a row. */
type Expected = "applied" | "ambiguous" | "company_not_in_export";

/**
 * Predicts each People row from the ledger alone, before the import. Company rows always carry an
 * anchor, so they are always applied. A People row whose business row has a blank business_id
 * cannot join. A row of a person without a namesake is decisive. A twin's row is decisive when it
 * carries evidence its twin's record already holds, when the twins have no records yet, or when
 * its namesake's row in the same file is decisive by its own evidence; otherwise it is ambiguous.
 */
function expectations(run: Generated, ledger: Ledger): Expected[] {
  const people = run.rows.people ?? [];
  const ownEvidence = (row: number) => {
    const logical = run.personOfRow[row] ?? -1;
    const cells = people[row];
    return cells !== undefined && evidenceOf(cells).some((e) => ledger.evidence.get(logical)?.has(e));
  };
  return run.personOfRow.map((logical, row) => {
    if (!people[row]?.["business_id"]) return "company_not_in_export";
    const twin = PEOPLE[logical]?.twin;
    if (twin === undefined || !ledger.appeared(logical) || ownEvidence(row)) return "applied";
    const namesakeDecisive = run.personOfRow.some((other, r) => other === twin && ownEvidence(r));
    return namesakeDecisive ? "applied" : "ambiguous";
  });
}

function identityProblems(ledger: Ledger, w: World): string[] {
  const problems: string[] = [];
  const oneToOne = (map: Map<number, Set<string>>, label: (i: number) => string) => {
    const owner = new Map<string, number>();
    for (const [logical, records] of map) {
      if (records.size > 1) problems.push(`${label(logical)} is split over ${records.size} records`);
      for (const record of records) {
        const other = owner.get(record);
        if (other !== undefined && other !== logical) problems.push(`${label(logical)} and ${label(other)} share one record`);
        owner.set(record, logical);
      }
    }
    return owner;
  };
  const personOf = oneToOne(ledger.recordsOfPerson, personLabel);
  const companyOf = oneToOne(ledger.recordsOfCompany, companyLabel);
  // Every record in the CRM belongs to exactly one logical person or company.
  for (const p of w.people) if (!personOf.has(p.id)) problems.push(`person record ${p.id} (${p.name}) belongs to no logical person`);
  for (const c of w.companies) if (!companyOf.has(c.id)) problems.push(`company record ${c.id} (${c.name}) belongs to no logical company`);

  for (const [logical, records] of ledger.recordsOfPerson) {
    const companyRecords = ledger.recordsOfCompany.get(PEOPLE[logical]?.company ?? -1);
    for (const id of records) {
      const record = w.people.find((p) => p.id === id);
      if (!record) problems.push(`${personLabel(logical)}'s record ${id} is gone`);
      else if (companyRecords && companyRecords.size === 1 && !companyRecords.has(record.company.id)) problems.push(`${personLabel(logical)} sits at the wrong company`);
    }
    const campaigns = w.people.filter((p) => records.has(p.id)).flatMap((p) => p.enrollments.map((e) => e.campaign.id));
    if (new Set(campaigns).size !== campaigns.length) problems.push(`${personLabel(logical)} is enrolled twice in one campaign`);
  }
  for (const [logical, records] of ledger.recordsOfCompany) {
    const campaigns = w.companies.filter((c) => records.has(c.id)).flatMap((c) => c.enrollments.map((e) => e.campaign.id));
    if (new Set(campaigns).size !== campaigns.length) problems.push(`${companyLabel(logical)} is a company lead twice in one campaign`);
  }
  return problems;
}

const personLabel = (i: number) => `person ${i} (${PEOPLE[i]?.names[0] ?? "?"})`;
const companyLabel = (i: number) => `company ${i} (${COMPANIES[i]?.names[0] ?? "?"})`;

/** Each row against the prediction: decisive rows applied and enrolled where reachable, ambiguity only where predicted. */
function rowProblems(run: Generated, expected: readonly Expected[], summary: ImportSummary, w: World): string[] {
  const problems: string[] = [];
  const people = run.rows.people ?? [];
  if (summary.rowRecords.people.length !== people.length || summary.rowRecords.businesses.length !== run.rows.businesses.length) {
    problems.push("the row records do not cover every row");
  }
  run.companyOfRow.forEach((logical, row) => {
    if (summary.rowRecords.businesses[row] === null) problems.push(`${companyLabel(logical)}'s decisive row was not applied`);
  });
  const reported = (row: number) => summary.entries.filter(isUnmatched).find((e) => e.file === "people" && e.rowNumbers.includes(row + 2));
  run.personOfRow.forEach((logical, row) => {
    const record = summary.rowRecords.people[row] ?? null;
    const want = expected[row];
    const label = `${personLabel(logical)}'s row ${row + 2}`;
    if (want === "company_not_in_export") {
      if (record !== null || !summary.entries.some((e) => notJoined(e) && e.name === people[row]?.["full_name"])) problems.push(`${label} should not join a company`);
      return;
    }
    if (want === "ambiguous") {
      if (record !== null) problems.push(`${label} should be ambiguous but landed in ${record}`);
      else if (!reported(row)) problems.push(`${label} changed nothing and is not reported`);
      return;
    }
    if (record === null) {
      problems.push(`${label} is decisive but was not applied${reported(row) ? ` (reported as ${reported(row)?.conflict ?? "?"})` : ""}`);
      return;
    }
    const entry = summary.entries.find((e) => e.lead?.kind === "person" && e.lead.personId === record);
    const p = w.people.find((x) => x.id === record);
    if (!entry || !p) {
      problems.push(`${label} has no result`);
      return;
    }
    if (entry.outcome !== "not_enrolled") return;
    if (entry.reason !== "no_usable_channel") {
      problems.push(`${label} is decisive but not enrolled (${entry.reason})`);
      return;
    }
    // Not enrolled for want of a channel: check that against the record itself.
    // Any detail of their own that isn't marked wrong, or the company's main line, would do.
    const usable = p.contactDetails.some((d) => !d.bad && (d.owner === "person" || d.phoneKind === "main_line"));
    if (usable) problems.push(`${label} has a usable channel but was not enrolled`);
  });
  return problems;
}

/** A refused row writes nothing: every new or changed record and enrollment belongs to an applied row of this run. */
function writeProblems(before: World, after: World, summary: ImportSummary): string[] {
  const problems: string[] = [];
  const appliedPeople = new Set(summary.rowRecords.people.filter((r): r is string => r !== null));
  const appliedCompanies = new Set(summary.rowRecords.businesses.filter((r): r is string => r !== null));
  const own = (p: PersonRecord) => JSON.stringify([p.name, p.title, p.contactDetails.filter((d) => d.owner === "person"), p.enrollments]);
  for (const p of after.people) {
    const was = before.people.find((x) => x.id === p.id);
    if (was && own(was) === own(p)) continue;
    // A company row can take a person's detail as its own shared detail.
    if (!appliedPeople.has(p.id) && !appliedCompanies.has(p.company.id)) problems.push(`person record ${p.id} (${p.name}) changed without an applied row`);
  }
  const ownCompany = (c: CompanyRecord) => JSON.stringify([c.name, c.contactDetails, c.enrollments]);
  for (const c of after.companies) {
    const was = before.companies.find((x) => x.id === c.id);
    if (!(was && ownCompany(was) === ownCompany(c)) && !appliedCompanies.has(c.id)) problems.push(`company record ${c.id} (${c.name}) changed without an applied row`);
  }
  return problems;
}

/**
 * The safety net counts what a row lists, not only what is stored: a lead enrolled by this import
 * never listed a personal email or mobile that another lead enrolled in the campaign holds.
 */
function listedProblems(run: Generated, summary: ImportSummary, w: World, campaignId: string): string[] {
  const problems: string[] = [];
  const newlyEnrolled = new Set(summary.entries.flatMap((e) => (e.outcome === "new" && e.lead.kind === "person" ? [e.lead.personId] : [])));
  const held = new Map<string, string>();
  for (const p of w.people) {
    if (!p.enrollments.some((e) => e.campaign.id === campaignId)) continue;
    for (const d of p.contactDetails.filter((x) => x.owner === "person" && (x.channel === "email" || x.phoneKind === "mobile"))) held.set(valueKey(d), p.id);
  }
  (run.rows.people ?? []).forEach((cells, row) => {
    const record = summary.rowRecords.people[row];
    if (!record || !newlyEnrolled.has(record)) return;
    const listed = [
      ...(cells["email"] ? [valueKey({ channel: "email", value: cells["email"] })] : []),
      ...(cells["dial_phone"] && /mobile|cell/i.test(cells["dial_phone_type"] ?? "") ? [valueKey({ channel: "phone", value: cells["dial_phone"] })] : []),
    ];
    for (const key of listed) {
      const holder = held.get(key);
      if (holder && holder !== record) problems.push(`row ${row + 2} was enrolled although ${key} is another enrolled lead's`);
    }
  });
  return problems;
}

/** Bad marks the sequence made, keyed by company, channel and value. */
type BadMarks = Set<string>;

function detailProblems(w: World, summary: ImportSummary, badMarks: BadMarks): string[] {
  const problems: string[] = [];
  const atCompany = (companyId: string) => [
    ...(w.companies.find((c) => c.id === companyId)?.contactDetails ?? []).map((d) => ({ d, owner: `company ${companyId}` })),
    ...w.people.filter((p) => p.company.id === companyId).flatMap((p) => p.contactDetails.filter((d) => d.owner === "person").map((d) => ({ d, owner: `person ${p.id}` }))),
  ];
  for (const company of w.companies) {
    const owners = new Map<string, string>();
    for (const { d, owner } of atCompany(company.id)) {
      const key = valueKey(d);
      const other = owners.get(key);
      if (other && other !== owner) problems.push(`${d.value} at ${company.name} is held by ${other} and ${owner}`);
      owners.set(key, owner);
    }
  }
  // The safety net: within a campaign, a personal email or mobile is one enrolled lead's, and a shared inbox one company lead's.
  const destinations = new Map<string, string>();
  const claim = (campaign: string, destination: string, lead: string) => {
    const key = `${campaign} ${destination}`;
    const other = destinations.get(key);
    if (other && other !== lead) problems.push(`${destination} belongs to two enrolled leads in one campaign`);
    destinations.set(key, lead);
  };
  for (const p of w.people) {
    for (const e of p.enrollments) {
      for (const d of p.contactDetails.filter((x) => x.owner === "person" && (x.channel === "email" || x.phoneKind === "mobile"))) claim(e.campaign.id, valueKey(d), p.id);
    }
  }
  for (const c of w.companies) {
    for (const e of c.enrollments) for (const d of c.contactDetails.filter((x) => x.channel === "email")) claim(e.campaign.id, `inbox ${valueKey(d)}`, c.id);
  }
  for (const entry of summary.entries) {
    if (entry.outcome === "not_enrolled" || entry.lead.kind !== "person") continue;
    const { personId } = entry.lead;
    const own = w.people.find((x) => x.id === personId)?.contactDetails.filter((d) => d.owner === "person" && !d.bad) ?? [];
    if (entry.via.includes("email") && !own.some((d) => d.channel === "email")) problems.push(`${entry.name} has email reach without an email of their own`);
    if (entry.via.includes("mobile") && !own.some((d) => d.phoneKind === "mobile")) problems.push(`${entry.name} has SMS reach without a mobile of their own`);
    if (entry.via.includes("direct") && !own.some((d) => d.phoneKind === "direct")) problems.push(`${entry.name} has direct reach without a number of their own`);
  }
  for (const mark of badMarks) {
    const [companyId = "", ...rest] = mark.split("#");
    const key = rest.join("#");
    const held = atCompany(companyId).filter(({ d }) => valueKey(d) === key);
    if (held.length === 0) problems.push(`bad ${key} disappeared from its company`);
    if (held.some(({ d }) => !d.bad)) problems.push(`bad ${key} lost its mark`);
  }
  return problems;
}

/** One generated sequence; the problems it finds, empty when every check holds. */
export async function runSequence(seed: number): Promise<string[]> {
  const rand = random(seed);
  const api = testApi();
  const campaigns = [(await api.createCampaign("Generated A")).id, (await api.createCampaign("Generated B")).id];
  const ledger = new Ledger();
  const badMarks: BadMarks = new Set();
  const steps = 3 + Math.floor(rand() * 4);
  for (let step = 1; step <= steps; step++) {
    const start = await world(api);
    for (let k = Math.floor(rand() * 3); k > 0; k--) {
      const details = [
        ...start.companies.flatMap((c) => c.contactDetails.map((d) => ({ d, companyId: c.id }))),
        ...start.people.flatMap((p) => p.contactDetails.filter((d) => d.owner === "person").map((d) => ({ d, companyId: p.company.id }))),
      ];
      const chosen = details[Math.floor(rand() * details.length)];
      if (!chosen) break;
      await api.store.markContactDetailBad(chosen.d.id);
      badMarks.add(`${chosen.companyId}#${valueKey(chosen.d)}`);
    }
    const run = generateRun(rand, step, ledger);
    const campaign = rand() < 0.3 ? campaigns[1] : campaigns[0];
    const send = () => api.post<{ import?: { summary: ImportSummary }; error?: unknown }>(`/api/campaigns/${campaign ?? ""}/imports`, csvOf(run.rows));

    // A pair in which no person joins a business is refused whole, as the ticket requires.
    const people = run.rows.people ?? [];
    if (people.length > 0 && people.every((p) => !p["business_id"])) {
      const refused = await send();
      if (refused.status !== 400) return [`step ${step}: a pair with no joining people answered ${refused.status}`];
      continue;
    }
    const importOnce = async (label: string): Promise<{ summary: ImportSummary; after: World } | string[]> => {
      const before = await world(api);
      const expected = expectations(run, ledger);
      const res = await send();
      const summary = res.body.import?.summary;
      if (res.status >= 500) return [`step ${step}, ${label}: the import answered ${res.status}`];
      if (res.status !== 201 || !summary) return [`step ${step}, ${label}: the import answered ${res.status}`];
      ledger.record(summary, run);
      const after = await world(api);
      const found = [
        ...rowProblems(run, expected, summary, after),
        ...writeProblems(before, after, summary),
        ...identityProblems(ledger, after),
        ...detailProblems(after, summary, badMarks),
        ...listedProblems(run, summary, after, campaign ?? ""),
      ];
      return found.length > 0 ? found.map((f) => `step ${step}, ${label}: ${f}`) : { summary, after };
    };

    const first = await importOnce("first import");
    if (Array.isArray(first)) return first;
    const again = await importOnce("same files again");
    if (Array.isArray(again)) return again;
    if (again.summary.counts.new !== 0 || again.summary.counts.updated !== 0) {
      const changed = again.summary.entries.filter((e) => e.outcome === "new" || e.outcome === "updated");
      return [`step ${step}: the same files again gave ${changed.map((e) => `${e.outcome} ${e.name}`).join(", ")}`];
    }
    if (JSON.stringify(again.after) !== JSON.stringify(first.after)) return [`step ${step}: the same files again changed the records`];
  }
  return [];
}
