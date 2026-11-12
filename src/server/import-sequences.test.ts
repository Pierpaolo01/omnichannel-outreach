import { expect, test } from "vitest";
import { business, csvOf, person, type ExportRows } from "../../test/support/export-builder.ts";
import { testApi, type TestApi } from "../../test/support/http.ts";
import { parsePhone } from "../domain/phone.ts";
import type { CompanyRecord, ContactDetailView, ImportSummary, LeadSearchResult, PersonRecord } from "../shared/api.ts";

/**
 * Generated import sequences through the real HTTP app and SQLite store, with a fixed seed, so a
 * failure reproduces exactly. The generator keeps its own record of the logical people and
 * companies behind every row, and the checks compare the CRM against that record, not against
 * names:
 * 1. one record per logical person or company, and one logical person or company per record,
 *    apart from rows the import reports as matching ambiguously;
 * 2. a person's record sits at their logical company's record;
 * 3. at most one enrollment per logical person, and per logical company lead, per campaign;
 * 4. a contact value has exactly one owner within a company, so a main line or shared inbox is
 *    never also a personal detail, and personal reach uses only personal details;
 * 5. a bad mark survives every import;
 * 6. importing the same files again changes nothing, and every row lands where it did before;
 * 7. no import returns a server error.
 * The generator only produces input the matching rule can decide: same-name colleagues first
 * appear together, an ID is never reused by someone whose namesake has carried it onto a record,
 * and every company row carries its anchor (a place_id, main line or address) unless the company
 * never has one.
 */

const SEQUENCES = 120;
const SEED = 20261113;

function random(seed: number): () => number {
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

const COMPANIES: readonly LogicalCompany[] = [
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

const PEOPLE: readonly LogicalPerson[] = [
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

interface Generated {
  readonly rows: ExportRows;
  /** The logical company behind each business row, and the logical person behind each People row. */
  readonly companyOfRow: readonly number[];
  readonly personOfRow: readonly number[];
}

interface History {
  /** Whether the logical person has a record yet. */
  appeared(person: number): boolean;
  /** Whether another logical person or company with this name has carried the ID onto a record. */
  carriedBySameName(kind: "person" | "company", logical: number, id: string): boolean;
}

function generateRun(rand: () => number, step: number, history: History): Generated {
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
    const sameCompanyEmails = PEOPLE.filter((p) => p.company === i).flatMap((p) => p.emails);
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
function valueKey(d: Pick<ContactDetailView, "channel" | "value">): string {
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

/** The generator's ledger: which records each logical person and company has landed in, and which IDs each carried there. */
class Ledger implements History {
  readonly recordsOfPerson = new Map<number, Set<string>>();
  readonly recordsOfCompany = new Map<number, Set<string>>();
  private readonly carriers = new Map<string, Set<number>>();

  record(summary: ImportSummary, run: Generated): void {
    run.personOfRow.forEach((logical, row) => {
      const record = summary.rowRecords.people[row];
      link(this.recordsOfPerson, logical, record);
      if (record) this.carry("person", logical, run.rows.people?.[row]?.["person_id"] ?? "");
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

function link(map: Map<number, Set<string>>, logical: number, record: string | null | undefined): void {
  if (!record) return;
  map.set(logical, (map.get(logical) ?? new Set()).add(record));
}

function identityProblems(ledger: Ledger, w: World, summary: ImportSummary, run: Generated): string[] {
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
  };
  const personLabel = (i: number) => `person ${i} (${PEOPLE[i]?.names[0] ?? "?"})`;
  const companyLabel = (i: number) => `company ${i} (${COMPANIES[i]?.names[0] ?? "?"})`;
  oneToOne(ledger.recordsOfPerson, personLabel);
  oneToOne(ledger.recordsOfCompany, companyLabel);

  // A row that was not applied is reported.
  const unapplied = summary.entries.filter((e) => e.lead === null).map((e) => e.name);
  run.companyOfRow.forEach((logical, row) => {
    const name = run.rows.businesses[row]?.["business_name"] ?? "";
    if (summary.rowRecords.businesses[row] === null && !unapplied.includes(name)) problems.push(`${companyLabel(logical)}'s row changed nothing and is not reported`);
  });
  run.personOfRow.forEach((logical, row) => {
    const name = run.rows.people?.[row]?.["full_name"] ?? "";
    if (summary.rowRecords.people[row] === null && !unapplied.includes(name)) problems.push(`${personLabel(logical)}'s row changed nothing and is not reported`);
  });

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

async function runSequence(seed: number): Promise<string[]> {
  const rand = random(seed);
  const api = testApi();
  const campaigns = [(await api.createCampaign("Generated A")).id, (await api.createCampaign("Generated B")).id];
  const ledger = new Ledger();
  const badMarks: BadMarks = new Set();
  const steps = 3 + Math.floor(rand() * 4);
  for (let step = 1; step <= steps; step++) {
    const before = await world(api);
    for (let k = Math.floor(rand() * 3); k > 0; k--) {
      const details = [
        ...before.companies.flatMap((c) => c.contactDetails.map((d) => ({ d, companyId: c.id }))),
        ...before.people.flatMap((p) => p.contactDetails.filter((d) => d.owner === "person").map((d) => ({ d, companyId: p.company.id }))),
      ];
      const chosen = details[Math.floor(rand() * details.length)];
      if (!chosen) break;
      await api.store.markContactDetailBad(chosen.d.id);
      badMarks.add(`${chosen.companyId}#${valueKey(chosen.d)}`);
    }
    const run = generateRun(rand, step, ledger);
    const campaign = rand() < 0.3 ? campaigns[1] : campaigns[0];
    const send = () => api.post<{ import?: { summary: ImportSummary }; error?: unknown }>(`/api/campaigns/${campaign ?? ""}/imports`, csvOf(run.rows));
    const first = await send();
    if (first.status >= 500) return [`step ${step}: the import answered ${first.status}`];
    const summary = first.body.import?.summary;
    if (first.status !== 201 || !summary) continue;
    ledger.record(summary, run);
    const after = await world(api);
    const found = [...identityProblems(ledger, after, summary, run), ...detailProblems(after, summary, badMarks)];
    if (found.length > 0) return found.map((f) => `step ${step}: ${f}`);

    const again = await send();
    const repeat = again.body.import?.summary;
    if (again.status !== 201 || !repeat) return [`step ${step}: the same files answered ${again.status} the second time`];
    if (repeat.counts.new !== 0 || repeat.counts.updated !== 0) {
      const changed = repeat.entries.filter((e) => e.outcome === "new" || e.outcome === "updated");
      return [`step ${step}: the same files again gave ${changed.map((e) => `${e.outcome} ${e.name}`).join(", ")}`];
    }
    // A row may be reported as ambiguous the second time (its first import created the record it
    // now cannot tell apart from a colleague's), but never lands in a different record.
    const moved = (first: readonly (string | null)[], second: readonly (string | null)[]) => first.some((id, row) => id !== null && second[row] !== null && second[row] !== id);
    if (moved(summary.rowRecords.people, repeat.rowRecords.people) || moved(summary.rowRecords.businesses, repeat.rowRecords.businesses)) {
      return [`step ${step}: the same rows landed in different records the second time`];
    }
    if (JSON.stringify(await world(api)) !== JSON.stringify(after)) return [`step ${step}: the same files again changed the records`];
  }
  return [];
}

test(`${SEQUENCES} generated import sequences keep every identity and ownership invariant (seed ${SEED})`, async () => {
  const failures: string[] = [];
  for (let i = 0; i < SEQUENCES; i++) {
    const problems = await runSequence(SEED + i);
    if (problems.length > 0) failures.push(`seed ${SEED + i}: ${problems.join("; ")}`);
  }
  expect(failures).toEqual([]);
}, 1_200_000);
