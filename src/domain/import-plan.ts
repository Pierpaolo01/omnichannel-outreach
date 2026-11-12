import { emailKey, nameKey, type Channel, type PhoneKind } from "./contact-details.ts";
import { ENROLLED_BY_IMPORT, type OutreachStatus } from "./outreach-status.ts";
import { companyRegion, displayPhone, parsePhone } from "./phone.ts";
import {
  companyLeadReach,
  companyLeadRoutes,
  decisionMakerReach,
  decisionMakerRoutes,
  hasUsableChannel,
  type ContactRoute,
  type Reach,
} from "./reach.ts";
import type { ScrapedBusiness, ScrapedPerson, ScraperExport } from "./scraper-export.ts";

/**
 * Import planning: given what the CRM already holds and one paired scraper export, decide which
 * companies, people and contact details to add or update, who to enrol in the campaign, and what
 * the import summary reports. Pure: the caller loads the directory, applies the plan and supplies
 * the clock and identifiers.
 *
 * Rules (spec issue #10, "Define CSV enrollment and repeat-contact behavior", and the principal's
 * decisions on #11):
 * - every reachable decision maker is enrolled as their own lead;
 * - a company with no named decision maker, or none who can be reached but a shared inbox, is
 *   enrolled as a company lead;
 * - a decision maker with no usable channel stays on the company record, unenrolled;
 * - a People row joins only to a business in the same export;
 * - re-importing never enrols anyone twice and never touches an existing enrollment;
 * - new contact details are added alongside existing ones; bad marks are never cleared;
 * - only this campaign's enrollments matter: no exclusions from other campaigns.
 * Matching is the factory's choice, recorded in docs/adr/0001.
 */

export type CompanyFields = {
  readonly name: string;
  readonly category: string;
  readonly website: string;
  readonly domain: string;
  readonly street: string;
  readonly neighborhood: string;
  readonly city: string;
  readonly stateProvince: string;
  readonly postalCode: string;
  readonly country: string;
  readonly timezone: string | null;
};

export type PersonFields = {
  readonly fullName: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly title: string;
  readonly roleTier: string;
  readonly timezone: string | null;
  readonly linkedinUrl: string;
};

export interface KnownDetail {
  readonly id: string;
  readonly channel: Channel;
  readonly phoneKind: PhoneKind | null;
  readonly value: string;
  readonly key: string;
  readonly bad: boolean;
}

export interface KnownCompany {
  readonly id: string;
  readonly placeId: string | null;
  readonly sourceBusinessIds: readonly string[];
  readonly fields: CompanyFields;
  readonly details: readonly KnownDetail[];
}

export interface KnownPerson {
  readonly id: string;
  readonly companyId: string;
  readonly sourcePersonIds: readonly string[];
  readonly fields: PersonFields;
  readonly details: readonly KnownDetail[];
}

export type LeadRef =
  | { readonly kind: "person"; readonly personId: string }
  | { readonly kind: "company"; readonly companyId: string };

export interface KnownEnrollment {
  readonly id: string;
  readonly lead: LeadRef;
}

/** Everything the CRM holds that an import can match against, plus this campaign's enrollments. */
export interface Directory {
  readonly companies: readonly KnownCompany[];
  readonly people: readonly KnownPerson[];
  /** Enrollments in the campaign being imported into. Other campaigns never exclude anyone. */
  readonly enrollments: readonly KnownEnrollment[];
}

export function emptyDirectory(): Directory {
  return { companies: [], people: [], enrollments: [] };
}

export type DetailOwner =
  | { readonly kind: "person"; readonly personId: string }
  | { readonly kind: "company"; readonly companyId: string };

export interface NewDetail {
  readonly id: string;
  readonly owner: DetailOwner;
  readonly channel: Channel;
  readonly phoneKind: PhoneKind | null;
  /** As written in the export. */
  readonly value: string;
  /** One key per address or number, however it is written. */
  readonly key: string;
  /** For phones: the digit forms search matches, international and national. */
  readonly searchDigits: string;
  readonly addedAt: string;
}

/**
 * A change to a detail the CRM already holds: a direct number now known to be a mobile, or a
 * person's number that turned out to be the company main line. The id and bad mark are kept.
 */
export interface DetailChange {
  readonly id: string;
  readonly owner: DetailOwner;
  readonly phoneKind: PhoneKind | null;
}

/** A personal copy of a company detail, folded into it. A bad mark on either side survives. */
export interface DetailConsolidation {
  readonly fromId: string;
  readonly intoId: string;
}

export interface CompanyWrite {
  readonly id: string;
  readonly isNew: boolean;
  readonly placeId: string | null;
  readonly newSourceBusinessIds: readonly string[];
  readonly fields: CompanyFields;
  readonly source: Readonly<Record<string, string>>;
}

export interface PersonWrite {
  readonly id: string;
  readonly isNew: boolean;
  readonly companyId: string;
  readonly newSourcePersonIds: readonly string[];
  readonly fields: PersonFields;
  readonly source: Readonly<Record<string, string>>;
}

export interface NewEnrollment {
  readonly id: string;
  readonly lead: LeadRef;
  readonly status: OutreachStatus;
  readonly enrolledAt: string;
}

export type LeadOutcome = "new" | "already_enrolled" | "updated" | "not_enrolled";

export type NotEnrolledReason = "no_usable_channel" | "company_not_in_export";

/** A contact detail as the import summary reports it. Phones are grouped for reading. */
export interface DetailNote {
  readonly channel: Channel;
  readonly phoneKind: PhoneKind | null;
  readonly value: string;
}

export type SummaryEntry =
  | {
      readonly outcome: "new" | "already_enrolled" | "updated";
      readonly lead: LeadRef;
      readonly name: string;
      readonly title: string;
      readonly companyId: string;
      readonly companyName: string;
      /** Decision makers on record at the company after this import. */
      readonly peopleAtCompany: number;
      readonly channels: Reach;
      readonly via: readonly ContactRoute[];
      /** Details this import added to the lead's own record, marked newer. */
      readonly added: readonly DetailNote[];
      /** Numbers on the lead's record that this import showed to be mobiles. */
      readonly becameMobile: readonly DetailNote[];
      /** Details in the export that the CRM already holds marked bad. They stay bad. */
      readonly stillBad: readonly DetailNote[];
    }
  | {
      readonly outcome: "not_enrolled";
      readonly reason: "no_usable_channel";
      readonly lead: LeadRef;
      readonly name: string;
      readonly title: string;
      readonly companyId: string;
      readonly companyName: string;
      readonly peopleAtCompany: number;
    }
  | {
      readonly outcome: "not_enrolled";
      readonly reason: "company_not_in_export";
      readonly lead: null;
      readonly name: string;
      /** The People row's business_id, blank or matching no business in this export. */
      readonly sourceBusinessId: string;
    };

export interface ImportSummary {
  readonly rows: { readonly businesses: number; readonly people: number };
  readonly counts: Readonly<Record<LeadOutcome, number>>;
  readonly entries: readonly SummaryEntry[];
}

export interface ImportPlan {
  readonly companies: readonly CompanyWrite[];
  readonly people: readonly PersonWrite[];
  readonly details: readonly NewDetail[];
  readonly detailChanges: readonly DetailChange[];
  readonly consolidations: readonly DetailConsolidation[];
  readonly enrollments: readonly NewEnrollment[];
  readonly summary: ImportSummary;
}

export function planImport(input: {
  directory: Directory;
  scraped: ScraperExport;
  now: string;
  newId: () => string;
}): ImportPlan {
  const { scraped, now, newId } = input;
  const crm = new WorkingDirectory(input.directory, now, newId);

  // Businesses first: People rows join only to a business in this export.
  const companyForBusinessId = new Map<string, string>();
  const companiesInExport: string[] = [];
  for (const business of scraped.businesses) {
    const companyId = crm.upsertCompany(business);
    if (business.sourceBusinessId) companyForBusinessId.set(business.sourceBusinessId, companyId);
    companiesInExport.push(companyId);
    const owner: DetailOwner = { kind: "company", companyId };
    if (business.mainPhone) {
      const { e164, original } = business.mainPhone;
      const region = crm.regionOf(companyId, e164);
      crm.addPhone(owner, "main_line", e164 || original, parsePhone(e164, region) ?? parsePhone(original, region));
    }
    for (const email of business.generalEmails) crm.addEmail(owner, email);
  }

  const joined: { row: ScrapedPerson; companyId: string }[] = [];
  const unmatched: SummaryEntry[] = [];
  for (const row of scraped.people) {
    const companyId = row.sourceBusinessId ? companyForBusinessId.get(row.sourceBusinessId) : undefined;
    if (companyId) joined.push({ row, companyId });
    else {
      unmatched.push({
        outcome: "not_enrolled",
        reason: "company_not_in_export",
        lead: null,
        name: personDisplayName(fieldsOf(row)),
        sourceBusinessId: row.sourceBusinessId,
      });
    }
  }

  // Rows sharing a scraper business and person ID, or a personal email at one company, are one
  // person. Same-name rows with different identifiers stay separate.
  const groups = groupRows(joined, crm);
  const matches = crm.matchPeople(groups);
  const peopleInExport = groups.map((group, index) => {
    const personId = crm.upsertPerson(group, matches[index] ?? null);
    for (const row of group.rows) addPersonDetails(crm, row, personId, group.companyId);
    return personId;
  });

  const entries: SummaryEntry[] = [];
  const enrollments: NewEnrollment[] = [];

  const decide = (lead: LeadRef, reachable: { reach: Reach; via: ContactRoute[] }, who: { name: string; title: string; companyId: string }): void => {
    const companyName = crm.company(who.companyId).fields.name;
    const base = { lead, ...who, companyName, peopleAtCompany: crm.peopleAt(who.companyId).length };
    const notes = crm.notesFor(lead);
    if (crm.isEnrolled(lead)) {
      const updated = notes.added.length > 0 || notes.becameMobile.length > 0;
      entries.push({ ...base, outcome: updated ? "updated" : "already_enrolled", channels: reachable.reach, via: reachable.via, ...notes });
    } else if (hasUsableChannel(reachable.reach)) {
      enrollments.push({ id: newId(), lead, status: ENROLLED_BY_IMPORT, enrolledAt: now });
      entries.push({ ...base, outcome: "new", channels: reachable.reach, via: reachable.via, ...notes });
    } else {
      entries.push({ ...base, outcome: "not_enrolled", reason: "no_usable_channel" });
    }
  };

  const personReach = (personId: string) => {
    const person = crm.person(personId);
    const company = crm.company(person.companyId);
    return {
      reach: decisionMakerReach(person.details, company.details),
      via: decisionMakerRoutes(person.details, company.details),
    };
  };

  for (const personId of peopleInExport) {
    const person = crm.person(personId);
    decide({ kind: "person", personId }, personReach(personId), {
      name: personDisplayName(person.fields),
      title: person.fields.title,
      companyId: person.companyId,
    });
  }

  // A company is a company lead when it has no named decision maker, or when none of its
  // decision makers can be reached: then its shared inbox is contacted and their names stay on
  // the record for calls (principal's decision, issue #11, 12 November 2026).
  for (const companyId of unique(companiesInExport)) {
    const people = crm.peopleAt(companyId);
    const company = crm.company(companyId);
    const lead: LeadRef = { kind: "company", companyId };
    const reachable = { reach: companyLeadReach(company.details), via: companyLeadRoutes(company.details) };
    if (people.length > 0) {
      const anyoneReachable = people.some((p) => hasUsableChannel(personReach(p.id).reach));
      if (!crm.isEnrolled(lead) && (anyoneReachable || !reachable.reach.email)) continue;
    }
    decide(lead, reachable, { name: company.fields.name, title: "", companyId });
  }

  entries.push(...unmatched);
  return {
    companies: crm.companyWrites(),
    people: crm.personWrites(),
    details: crm.newDetails(),
    detailChanges: crm.detailChanges(),
    consolidations: crm.consolidations(),
    enrollments,
    summary: {
      rows: { businesses: scraped.businesses.length, people: scraped.people.length },
      counts: countOutcomes(entries),
      entries,
    },
  };
}

/** The name shown for a decision maker. A blank last name is kept as provided. */
export function personDisplayName(fields: Pick<PersonFields, "fullName" | "firstName" | "lastName">): string {
  const joined = [fields.firstName, fields.lastName].filter(Boolean).join(" ");
  return fields.fullName || joined || "Unnamed decision maker";
}

/** A detail as reported in the summary: phones grouped for reading. */
export function noteOf(detail: { channel: Channel; phoneKind: PhoneKind | null; key: string; value: string }): DetailNote {
  return {
    channel: detail.channel,
    phoneKind: detail.phoneKind,
    value: detail.channel === "phone" ? displayPhone(detail.key) : detail.value,
  };
}

/**
 * The identifier a row is recognised by next time: its scraper person_id, or for a row without
 * one, a stand-in built from its name, so the same row always finds the same person. Stand-ins
 * never group rows within one export; only real IDs and emails do.
 */
function sourceIdOf(row: ScrapedPerson): string {
  if (row.sourcePersonId) return row.sourcePersonId;
  const name = personNameKey(fieldsOf(row));
  return name ? `~name:${name}` : "";
}

/** People rows of one export that are one person. */
interface RowGroup {
  readonly companyId: string;
  readonly rows: readonly ScrapedPerson[];
}

function groupRows(joined: readonly { row: ScrapedPerson; companyId: string }[], crm: WorkingDirectory): RowGroup[] {
  const parent = joined.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] ?? root;
    parent[i] = root;
    return root;
  };
  const firstWith = new Map<string, number>();
  joined.forEach(({ row, companyId }, i) => {
    const keys: string[] = [];
    if (row.sourceBusinessId && row.sourcePersonId) keys.push(`id|${row.sourceBusinessId}|${row.sourcePersonId}`);
    const email = emailKey(row.email);
    if (email && !crm.companyHolds(companyId, "email", email)) keys.push(`email|${companyId}|${email}`);
    for (const key of keys) {
      const other = firstWith.get(key);
      if (other === undefined) firstWith.set(key, i);
      else parent[find(i)] = find(other);
    }
  });
  const groups = new Map<number, { companyId: string; rows: ScrapedPerson[] }>();
  joined.forEach(({ row, companyId }, i) => {
    const root = find(i);
    const group = groups.get(root) ?? { companyId, rows: [] };
    group.rows.push(row);
    groups.set(root, group);
  });
  return [...groups.values()];
}

function addPersonDetails(crm: WorkingDirectory, row: ScrapedPerson, personId: string, companyId: string): void {
  const owner: DetailOwner = { kind: "person", personId };
  const region = crm.regionOf(companyId, "");

  crm.addEmail(owner, row.email);

  // A mobile first, so a number listed both as direct and as mobile keeps its mobile capability.
  const dialKind: PhoneKind = /mobile|cell/i.test(row.dialPhoneType) ? "mobile" : "direct";
  const phones: [PhoneKind, string][] = [
    [dialKind, row.dialPhone],
    ["direct", row.directPhone],
  ];
  for (const [kind, raw] of phones) crm.addPhone(owner, kind, raw, parsePhone(raw, region));
}

function fieldsOf(row: ScrapedPerson): PersonFields {
  return {
    fullName: row.fullName,
    firstName: row.firstName,
    lastName: row.lastName,
    title: row.title,
    roleTier: row.roleTier,
    timezone: row.timezone,
    linkedinUrl: row.linkedinUrl,
  };
}

function companyFieldsOf(row: ScrapedBusiness): CompanyFields {
  return {
    name: row.name,
    category: row.category,
    website: row.website,
    domain: row.domain,
    street: row.street,
    neighborhood: row.neighborhood,
    city: row.city,
    stateProvince: row.stateProvince,
    postalCode: row.postalCode,
    country: row.country,
    timezone: row.timezone,
  };
}

/** Newer non-empty values replace older ones; an empty cell never erases what is known. */
function mergeFields<T extends Readonly<Record<string, string | null>>>(known: T, incoming: T): T {
  const merged = { ...known };
  // Object.keys loses the key type; both objects share T's keys.
  for (const key of Object.keys(incoming) as (keyof T)[]) {
    const value = incoming[key];
    if (value !== null && value !== "") merged[key] = value;
  }
  return merged;
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function countOutcomes(entries: readonly SummaryEntry[]): Record<LeadOutcome, number> {
  const counts: Record<LeadOutcome, number> = { new: 0, already_enrolled: 0, updated: 0, not_enrolled: 0 };
  for (const entry of entries) counts[entry.outcome] += 1;
  return counts;
}

function personNameKey(fields: Pick<PersonFields, "fullName" | "firstName" | "lastName">): string {
  return nameKey(fields.fullName || [fields.firstName, fields.lastName].filter(Boolean).join(" "));
}

interface MutableDetail {
  id: string;
  channel: Channel;
  phoneKind: PhoneKind | null;
  value: string;
  key: string;
  bad: boolean;
}

interface MutableCompany {
  id: string;
  isNew: boolean;
  placeId: string | null;
  sourceBusinessIds: Set<string>;
  newSourceBusinessIds: Set<string>;
  fields: CompanyFields;
  details: MutableDetail[];
  source: Readonly<Record<string, string>>;
  touched: boolean;
}

interface MutablePerson {
  id: string;
  isNew: boolean;
  companyId: string;
  sourcePersonIds: Set<string>;
  newSourcePersonIds: Set<string>;
  fields: PersonFields;
  details: MutableDetail[];
  source: Readonly<Record<string, string>>;
  touched: boolean;
}

/** A map from a key to every id holding it. A key held by more than one id is ambiguous. */
class Index {
  private readonly map = new Map<string, Set<string>>();

  add(key: string, id: string): void {
    if (!key) return;
    const ids = this.map.get(key) ?? new Set<string>();
    ids.add(id);
    this.map.set(key, ids);
  }

  all(key: string): string[] {
    return [...(this.map.get(key) ?? [])];
  }

  /** The id holding `key`, or undefined when none or several do. */
  only(key: string): string | undefined {
    const ids = this.map.get(key);
    if (ids?.size !== 1) return undefined;
    return [...ids][0];
  }
}

/** The directory as it evolves while one export is applied, with the indexes used for matching. */
class WorkingDirectory {
  private readonly companies = new Map<string, MutableCompany>();
  private readonly people = new Map<string, MutablePerson>();
  private readonly enrolled = new Set<string>();
  private readonly added: NewDetail[] = [];
  private readonly changed = new Map<string, DetailChange>();
  private readonly merged: DetailConsolidation[] = [];
  private readonly keptBad: { owner: DetailOwner; detail: MutableDetail }[] = [];
  private readonly upgraded: { owner: DetailOwner; detail: MutableDetail }[] = [];
  private readonly companyByPlace = new Map<string, string>();
  private readonly companyByBusinessId = new Index();
  private readonly companyByNameAndMainLine = new Index();
  private readonly now: string;
  private readonly newId: () => string;

  constructor(directory: Directory, now: string, newId: () => string) {
    this.now = now;
    this.newId = newId;
    for (const c of directory.companies) {
      this.companies.set(c.id, {
        id: c.id,
        isNew: false,
        placeId: c.placeId,
        sourceBusinessIds: new Set(c.sourceBusinessIds),
        newSourceBusinessIds: new Set(),
        fields: c.fields,
        details: c.details.map((d) => ({ ...d })),
        source: {},
        touched: false,
      });
      this.indexCompany(c.id);
    }
    for (const p of directory.people) {
      this.people.set(p.id, {
        id: p.id,
        isNew: false,
        companyId: p.companyId,
        sourcePersonIds: new Set(p.sourcePersonIds),
        newSourcePersonIds: new Set(),
        fields: p.fields,
        details: p.details.map((d) => ({ ...d })),
        source: {},
        touched: false,
      });
    }
    for (const e of directory.enrollments) this.enrolled.add(leadKey(e.lead));
  }

  company(id: string): MutableCompany {
    const company = this.companies.get(id);
    if (!company) throw new Error(`unknown company ${id}`);
    return company;
  }

  person(id: string): MutablePerson {
    const person = this.people.get(id);
    if (!person) throw new Error(`unknown person ${id}`);
    return person;
  }

  peopleAt(companyId: string): MutablePerson[] {
    return [...this.people.values()].filter((p) => p.companyId === companyId);
  }

  isEnrolled(lead: LeadRef): boolean {
    return this.enrolled.has(leadKey(lead));
  }

  /**
   * Same company when the place_id matches; otherwise the scraper's business_id, or the name with
   * any main line the company holds, when exactly one company fits and neither side carries a
   * different place_id. Scraper IDs are not proven stable across runs, so a conflicting place_id
   * always wins, and an ambiguous key matches nothing.
   */
  upsertCompany(row: ScrapedBusiness): string {
    const compatible = (id: string | undefined): string | undefined => {
      if (!id) return undefined;
      const known = this.company(id);
      return known.placeId && row.placeId && known.placeId !== row.placeId ? undefined : id;
    };
    const region = companyRegion(row.country, [row.mainPhone?.e164 ?? ""]);
    const mainLine = row.mainPhone ? (parsePhone(row.mainPhone.e164, region) ?? parsePhone(row.mainPhone.original, region)) : null;
    // A business_id alone is not enough: the name or a main line must agree too (round 2).
    const corroborated = (id: string | undefined): string | undefined => {
      if (!id) return undefined;
      const known = this.company(id);
      const sameName = nameKey(known.fields.name) !== "" && nameKey(known.fields.name) === nameKey(row.name);
      const sharedLine = mainLine !== null && known.details.some((d) => d.phoneKind === "main_line" && d.key === mainLine.key);
      return sameName || sharedLine ? id : undefined;
    };
    // Of the companies holding this business_id, one the name or a main line corroborates. When
    // several do, prefer one whose name agrees, then the most recently created, so importing the
    // same files again settles on the same company instead of adding another.
    const byBusinessId = (): string | undefined => {
      if (!row.sourceBusinessId) return undefined;
      const fits = this.companyByBusinessId.all(row.sourceBusinessId).filter((id) => corroborated(compatible(id)) !== undefined);
      const named = fits.filter((id) => nameKey(this.company(id).fields.name) === nameKey(row.name));
      return (named.length > 0 ? named : fits).at(-1);
    };
    const existing =
      (row.placeId ? this.companyByPlace.get(row.placeId) : undefined) ??
      byBusinessId() ??
      compatible(mainLine ? this.companyByNameAndMainLine.only(`${nameKey(row.name)}|${mainLine.key}`) : undefined);

    const incoming = companyFieldsOf(row);
    const newIds = row.sourceBusinessId ? [row.sourceBusinessId] : [];
    if (existing) {
      const company = this.company(existing);
      company.fields = mergeFields(company.fields, incoming);
      company.placeId ??= row.placeId;
      company.source = row.source;
      company.touched = true;
      for (const id of newIds) {
        if (!company.sourceBusinessIds.has(id)) {
          company.sourceBusinessIds.add(id);
          company.newSourceBusinessIds.add(id);
        }
      }
      this.indexCompany(existing);
      return existing;
    }

    const id = this.newId();
    this.companies.set(id, {
      id,
      isNew: true,
      placeId: row.placeId,
      sourceBusinessIds: new Set(newIds),
      newSourceBusinessIds: new Set(newIds),
      fields: incoming,
      details: [],
      source: row.source,
      touched: true,
    });
    this.indexCompany(id);
    return id;
  }

  /**
   * Matches each group of People rows to a person already in the CRM, or to nobody. Groups of
   * one export never share a person, and each existing person is claimed at most once.
   * In order, a group matches the one unclaimed person at its company who:
   * 1. has one of the group's own emails;
   * 2. has one of its scraper person_ids and the same name;
   * 3. has the same name, and no email that conflicts with the group's;
   * 4. has the same name, when nobody else at the company and no other group in the export
   *    does; a differing email is then a newly found one (round 2, item 4).
   * A reused person_id under a different name is not a match.
   */
  matchPeople(groups: readonly RowGroup[]): (string | null)[] {
    const result: (string | null)[] = groups.map(() => null);
    const claimed = new Set<string>();
    const candidates = (companyId: string) => this.peopleAt(companyId).filter((p) => !p.isNew && !claimed.has(p.id));
    const emailsOf = (p: MutablePerson) => p.details.filter((d) => d.channel === "email").map((d) => d.key);
    const identity = groups.map((g) => ({
      emails: g.rows.map((r) => emailKey(r.email)).filter((e): e is string => e !== null && !this.companyHolds(g.companyId, "email", e)),
      ids: g.rows.map(sourceIdOf).filter(Boolean),
      names: [...new Set(g.rows.map((r) => personNameKey(fieldsOf(r))).filter(Boolean))],
    }));
    const groupsWithName = (companyId: string, name: string) =>
      groups.filter((g, i) => g.companyId === companyId && identity[i]?.names.includes(name)).length;

    const pass = (fits: (index: number, candidate: MutablePerson) => boolean, several: "none" | "latest" = "none") => {
      groups.forEach((group, index) => {
        if (result[index] !== null) return;
        const found = candidates(group.companyId).filter((c) => fits(index, c));
        const chosen = found.length === 1 || several === "latest" ? found.at(-1) : undefined;
        if (chosen) {
          result[index] = chosen.id;
          claimed.add(chosen.id);
        }
      });
    };
    const id = (index: number) => identity[index] ?? { emails: [], ids: [], names: [] };
    const sameName = (index: number, c: MutablePerson) => id(index).names.includes(personNameKey(c.fields));

    pass((index, c) => id(index).emails.some((e) => emailsOf(c).includes(e)));
    // Several people holding the same ID and name are left from an earlier ambiguous row: take
    // the most recently created, so the same files always settle on the same person.
    pass((index, c) => id(index).ids.some((pid) => c.sourcePersonIds.has(pid)) && sameName(index, c), "latest");
    pass((index, c) => {
      const known = emailsOf(c);
      const mine = id(index).emails;
      const conflicting = mine.length > 0 && known.length > 0 && !mine.some((e) => known.includes(e));
      return sameName(index, c) && !conflicting;
    });
    pass((index, c) => {
      const name = personNameKey(c.fields);
      const group = groups[index];
      return group !== undefined && sameName(index, c) && groupsWithName(group.companyId, name) === 1;
    });
    return result;
  }

  upsertPerson(group: RowGroup, existing: string | null): string {
    const [first, ...rest] = group.rows;
    if (!first) throw new Error("an empty row group");
    const incoming = rest.reduce((fields, row) => mergeFields(fields, fieldsOf(row)), fieldsOf(first));
    const source = group.rows.at(-1)?.source ?? first.source;
    const ids = [...new Set(group.rows.map(sourceIdOf).filter(Boolean))];
    if (existing) {
      const person = this.person(existing);
      person.fields = mergeFields(person.fields, incoming);
      person.source = source;
      person.touched = true;
      for (const pid of ids) {
        if (!person.sourcePersonIds.has(pid)) {
          person.sourcePersonIds.add(pid);
          person.newSourcePersonIds.add(pid);
        }
      }
      return existing;
    }
    const id = this.newId();
    this.people.set(id, {
      id,
      isNew: true,
      companyId: group.companyId,
      sourcePersonIds: new Set(ids),
      newSourcePersonIds: new Set(ids),
      fields: incoming,
      details: [],
      source,
      touched: true,
    });
    return id;
  }

  /** Whether the company itself holds this address or number. */
  companyHolds(companyId: string, channel: Channel, key: string): boolean {
    return this.company(companyId).details.some((d) => d.channel === channel && d.key === key);
  }

  /** The region the company's national numbers are read in. */
  regionOf(companyId: string, incomingMainLine: string): string | null {
    const company = this.company(companyId);
    const lines = company.details.filter((d) => d.phoneKind === "main_line").map((d) => d.key);
    return companyRegion(company.fields.country, [incomingMainLine, ...lines]);
  }

  /**
   * Adds an email unless it is already known at the company. An address the company holds as
   * its shared inbox is never a personal email: listing it as the company's absorbs every
   * personal copy at the company into the one company detail (round 2, item 1).
   */
  addEmail(owner: DetailOwner, raw: string): void {
    const key = emailKey(raw);
    if (!key) return;
    if (owner.kind === "company") {
      const held = this.claimForCompany(owner.companyId, "email", key, null);
      if (held) this.noteKeptBad(owner, held);
      else this.add(owner, "email", null, raw, key, "");
      return;
    }
    const companyId = this.person(owner.personId).companyId;
    if (this.companyHolds(companyId, "email", key) || this.colleagueHolds(owner.personId, "email", key)) return;
    const existing = this.person(owner.personId).details.find((d) => d.channel === "email" && d.key === key);
    if (existing) this.noteKeptBad(owner, existing);
    else this.add(owner, "email", null, raw, key, "");
  }

  /**
   * Adds a phone unless it is already known at the company, in any written form. A number the
   * company holds as its main line is never personal: listing it as the main line absorbs every
   * personal copy at the company into the one company detail, keeping a bad mark. A number a
   * colleague already holds stays theirs. A direct number later shown to be a mobile becomes one.
   */
  addPhone(owner: DetailOwner, kind: PhoneKind, raw: string, phone: ReturnType<typeof parsePhone>): void {
    if (!phone) return;
    if (owner.kind === "company") {
      const held = this.claimForCompany(owner.companyId, "phone", phone.key, "main_line");
      if (held) this.noteKeptBad(owner, held);
      else this.add(owner, "phone", "main_line", raw, phone.key, phone.searchDigits);
      this.indexCompany(owner.companyId);
      return;
    }
    const person = this.person(owner.personId);
    const companyId = person.companyId;
    if (this.companyHolds(companyId, "phone", phone.key)) {
      const mainLine = this.company(companyId).details.find((d) => d.channel === "phone" && d.key === phone.key);
      if (mainLine) this.noteKeptBad({ kind: "company", companyId }, mainLine);
      return;
    }
    if (this.colleagueHolds(owner.personId, "phone", phone.key)) return;
    const existing = person.details.find((d) => d.channel === "phone" && d.key === phone.key);
    if (!existing) {
      this.add(owner, "phone", kind, raw, phone.key, phone.searchDigits);
      return;
    }
    this.noteKeptBad(owner, existing);
    if (kind === "mobile" && existing.phoneKind === "direct") {
      existing.phoneKind = "mobile";
      this.recordChange(existing, owner);
      if (!this.added.some((d) => d.id === existing.id)) this.upgraded.push({ owner, detail: existing });
    }
  }

  private colleagueHolds(personId: string, channel: Channel, key: string): boolean {
    const companyId = this.person(personId).companyId;
    return this.peopleAt(companyId).some((p) => p.id !== personId && p.details.some((d) => d.channel === channel && d.key === key));
  }

  /**
   * Makes the company the one owner of this address or number. The first personal copy moves to
   * the company if it has none; every other copy folds into the company detail.
   */
  private claimForCompany(companyId: string, channel: Channel, key: string, phoneKind: PhoneKind | null): MutableDetail | null {
    const owner: DetailOwner = { kind: "company", companyId };
    const company = this.company(companyId);
    let target = company.details.find((d) => d.channel === channel && d.key === key) ?? null;
    for (const person of this.peopleAt(companyId)) {
      for (const copy of person.details.filter((d) => d.channel === channel && d.key === key)) {
        person.details = person.details.filter((d) => d !== copy);
        if (!target) {
          copy.phoneKind = phoneKind;
          company.details.push(copy);
          this.recordChange(copy, owner);
          target = copy;
          continue;
        }
        target.bad ||= copy.bad;
        const fresh = this.added.findIndex((d) => d.id === copy.id);
        if (fresh >= 0) this.added.splice(fresh, 1);
        else this.merged.push({ fromId: copy.id, intoId: target.id });
        this.changed.delete(copy.id);
      }
    }
    return target;
  }

  /** What this import added to the lead's own record, and which of its details stayed bad. */
  notesFor(lead: LeadRef): { added: DetailNote[]; becameMobile: DetailNote[]; stillBad: DetailNote[] } {
    const owns = (owner: DetailOwner) =>
      lead.kind === "person"
        ? owner.kind === "person" && owner.personId === lead.personId
        : owner.kind === "company" && owner.companyId === lead.companyId;
    const current = (id: string) => [...this.holderOf(lead).details].find((d) => d.id === id);
    return {
      added: this.added.filter((d) => owns(d.owner)).map((d) => noteOf({ ...d, phoneKind: current(d.id)?.phoneKind ?? d.phoneKind })),
      becameMobile: this.upgraded.filter((u) => owns(u.owner)).map((u) => noteOf(u.detail)),
      stillBad: this.keptBad.filter((k) => owns(k.owner)).map((k) => noteOf(k.detail)),
    };
  }

  companyWrites(): CompanyWrite[] {
    return [...this.companies.values()]
      .filter((c) => c.touched)
      .map((c) => ({
        id: c.id,
        isNew: c.isNew,
        placeId: c.placeId,
        newSourceBusinessIds: [...c.newSourceBusinessIds],
        fields: c.fields,
        source: c.source,
      }));
  }

  personWrites(): PersonWrite[] {
    return [...this.people.values()]
      .filter((p) => p.touched)
      .map((p) => ({
        id: p.id,
        isNew: p.isNew,
        companyId: p.companyId,
        newSourcePersonIds: [...p.newSourcePersonIds],
        fields: p.fields,
        source: p.source,
      }));
  }

  /** New details, with any kind change made later in the same import folded in. */
  newDetails(): NewDetail[] {
    return this.added.map((d) => {
      const change = this.changed.get(d.id);
      return change ? { ...d, owner: change.owner, phoneKind: change.phoneKind } : d;
    });
  }

  /** Personal copies folded into a company detail. */
  consolidations(): DetailConsolidation[] {
    return [...this.merged];
  }

  /** Changes to details that existed before this import. */
  detailChanges(): DetailChange[] {
    const fresh = new Set(this.added.map((d) => d.id));
    return [...this.changed.values()].filter((c) => !fresh.has(c.id));
  }

  private holder(owner: DetailOwner): MutableCompany | MutablePerson {
    return owner.kind === "person" ? this.person(owner.personId) : this.company(owner.companyId);
  }

  private holderOf(lead: LeadRef): MutableCompany | MutablePerson {
    return lead.kind === "person" ? this.person(lead.personId) : this.company(lead.companyId);
  }

  private add(owner: DetailOwner, channel: Channel, phoneKind: PhoneKind | null, raw: string, key: string, searchDigits: string): void {
    const detail: NewDetail = {
      id: this.newId(),
      owner,
      channel,
      phoneKind,
      value: raw.trim(),
      key,
      searchDigits,
      addedAt: this.now,
    };
    this.holder(owner).details.push({ id: detail.id, channel, phoneKind, value: detail.value, key, bad: false });
    this.added.push(detail);
  }

  private recordChange(detail: MutableDetail, owner: DetailOwner): void {
    this.changed.set(detail.id, { id: detail.id, owner, phoneKind: detail.phoneKind });
  }

  private noteKeptBad(owner: DetailOwner, detail: MutableDetail): void {
    if (detail.bad && !this.keptBad.some((k) => k.detail.id === detail.id)) this.keptBad.push({ owner, detail });
  }

  private indexCompany(id: string): void {
    const company = this.company(id);
    if (company.placeId) this.companyByPlace.set(company.placeId, id);
    for (const businessId of company.sourceBusinessIds) this.companyByBusinessId.add(businessId, id);
    for (const d of company.details) {
      if (d.phoneKind === "main_line") this.companyByNameAndMainLine.add(`${nameKey(company.fields.name)}|${d.key}`, id);
    }
  }
}

function leadKey(lead: LeadRef): string {
  return lead.kind === "person" ? `person:${lead.personId}` : `company:${lead.companyId}`;
}
