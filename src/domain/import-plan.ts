import { emailKey, foldText, phoneKey, type Channel, type PhoneKind } from "./contact-details.ts";
import { ENROLLED_BY_IMPORT, type OutreachStatus } from "./outreach-status.ts";
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
 * Rules (spec issue #10, "Define CSV enrollment and repeat-contact behavior"):
 * - every reachable decision maker is enrolled as their own lead;
 * - a company with no named decision maker is enrolled as a company lead;
 * - a decision maker with no usable channel stays on the company record, unenrolled;
 * - re-importing never enrols anyone twice and never touches an existing enrollment;
 * - new contact details are added alongside existing ones; bad marks are never cleared;
 * - only this campaign's enrollments matter: no exclusions from other campaigns.
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
}

export type PersonFields = {
  readonly fullName: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly title: string;
  readonly roleTier: string;
  readonly timezone: string | null;
  readonly linkedinUrl: string;
}

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
  /** As written in the export; for a main line, the E.164 form when the export has one. */
  readonly value: string;
  /** Another written form of the same number, such as the export's national phone_original. */
  readonly original: string | null;
  readonly key: string;
  readonly addedAt: string;
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

/** A contact detail as the import summary reports it. */
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
      readonly channels: Reach;
      readonly via: readonly ContactRoute[];
      /** Details this import added to the lead's own record, marked newer. */
      readonly added: readonly DetailNote[];
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
    }
  | {
      readonly outcome: "not_enrolled";
      readonly reason: "company_not_in_export";
      readonly lead: null;
      readonly name: string;
      /** The people row's business_id, which matched no business in this export or the CRM. */
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
  const crm = new WorkingDirectory(input.directory);

  const companyForBusinessId = new Map<string, string>();
  const companiesInExport: string[] = [];
  const peopleInExport: string[] = [];
  const unmatched: SummaryEntry[] = [];

  for (const business of scraped.businesses) {
    const companyId = crm.upsertCompany(business, newId);
    companyForBusinessId.set(business.sourceBusinessId, companyId);
    companiesInExport.push(companyId);
    if (business.mainPhone) {
      const { e164, original } = business.mainPhone;
      const raw = e164 || original;
      crm.addDetail({ kind: "company", companyId }, "phone", "main_line", raw, phoneKey(raw), now, newId, e164 ? original : "");
    }
    for (const email of business.generalEmails) {
      crm.addDetail({ kind: "company", companyId }, "email", null, email, emailKey(email), now, newId);
    }
  }

  for (const row of scraped.people) {
    const companyId = companyForBusinessId.get(row.sourceBusinessId) ?? crm.companyBySourceBusinessId(row.sourceBusinessId);
    if (!companyId) {
      unmatched.push({
        outcome: "not_enrolled",
        reason: "company_not_in_export",
        lead: null,
        name: personDisplayName(fieldsOf(row)),
        sourceBusinessId: row.sourceBusinessId,
      });
      continue;
    }
    const personId = crm.upsertPerson(row, companyId, newId);
    peopleInExport.push(personId);
    addPersonDetails(crm, row, personId, companyId, now, newId);
  }

  const entries: SummaryEntry[] = [];
  const enrollments: NewEnrollment[] = [];

  const decide = (lead: LeadRef, reachable: { reach: Reach; via: ContactRoute[] }, who: { name: string; title: string; companyId: string }): void => {
    const companyName = crm.company(who.companyId).fields.name;
    const base = { lead, ...who, companyName };
    const notes = crm.notesFor(lead);
    if (crm.isEnrolled(lead)) {
      entries.push({ ...base, outcome: notes.added.length > 0 ? "updated" : "already_enrolled", channels: reachable.reach, via: reachable.via, ...notes });
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

  for (const personId of unique(peopleInExport)) {
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

function addPersonDetails(
  crm: WorkingDirectory,
  row: ScrapedPerson,
  personId: string,
  companyId: string,
  now: string,
  newId: () => string,
): void {
  const owner: DetailOwner = { kind: "person", personId };
  const company = crm.company(companyId);
  const companyKeys = new Set(company.details.map((d) => d.key));

  // A company's shared inbox or main line listed against a person is not their own detail.
  const email = emailKey(row.email);
  if (email && !companyKeys.has(email)) crm.addDetail(owner, "email", null, row.email, email, now, newId);

  const direct = phoneKey(row.directPhone);
  if (direct && !companyKeys.has(direct)) crm.addDetail(owner, "phone", "direct", row.directPhone, direct, now, newId);

  const dial = phoneKey(row.dialPhone);
  if (dial && !companyKeys.has(dial)) {
    const kind: PhoneKind = /mobile|cell/i.test(row.dialPhoneType) ? "mobile" : "direct";
    crm.addDetail(owner, "phone", kind, row.dialPhone, dial, now, newId);
  }
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

interface MutableCompany {
  id: string;
  isNew: boolean;
  placeId: string | null;
  sourceBusinessIds: Set<string>;
  newSourceBusinessIds: Set<string>;
  fields: CompanyFields;
  details: KnownDetail[];
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
  details: KnownDetail[];
  source: Readonly<Record<string, string>>;
  touched: boolean;
}

/** The directory as it evolves while one export is applied, with the indexes used for matching. */
class WorkingDirectory {
  private readonly companies = new Map<string, MutableCompany>();
  private readonly people = new Map<string, MutablePerson>();
  private readonly enrolled = new Set<string>();
  private readonly added: NewDetail[] = [];
  private readonly keptBad: { owner: DetailOwner; detail: KnownDetail }[] = [];
  private readonly companyByPlace = new Map<string, string>();
  private readonly companyByBusinessId = new Map<string, string>();
  private readonly companyByNameAndPhone = new Map<string, string>();
  private readonly personByIdentity = new Map<string, string>();

  constructor(directory: Directory) {
    for (const c of directory.companies) {
      this.companies.set(c.id, {
        id: c.id,
        isNew: false,
        placeId: c.placeId,
        sourceBusinessIds: new Set(c.sourceBusinessIds),
        newSourceBusinessIds: new Set(),
        fields: c.fields,
        details: [...c.details],
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
        details: [...p.details],
        source: {},
        touched: false,
      });
      this.indexPerson(p.id);
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

  companyBySourceBusinessId(sourceBusinessId: string): string | undefined {
    return this.companyByBusinessId.get(sourceBusinessId);
  }

  peopleAt(companyId: string): MutablePerson[] {
    return [...this.people.values()].filter((p) => p.companyId === companyId);
  }

  /** What this import added to the lead's own record, and which of its details stayed bad. */
  notesFor(lead: LeadRef): { added: DetailNote[]; stillBad: DetailNote[] } {
    const owns = (owner: DetailOwner) =>
      lead.kind === "person"
        ? owner.kind === "person" && owner.personId === lead.personId
        : owner.kind === "company" && owner.companyId === lead.companyId;
    const note = (d: DetailNote): DetailNote => ({ channel: d.channel, phoneKind: d.phoneKind, value: d.value });
    return {
      added: this.added.filter((d) => owns(d.owner)).map(note),
      stillBad: this.keptBad.filter((d) => owns(d.owner)).map(({ detail }) => note(detail)),
    };
  }

  isEnrolled(lead: LeadRef): boolean {
    return this.enrolled.has(leadKey(lead));
  }

  /**
   * Same company when the place_id matches; otherwise the scraper's business_id, or name and main
   * line together, provided neither side carries a different place_id. Scraper IDs are not proven
   * stable across runs, so a conflicting place_id always wins.
   */
  upsertCompany(row: ScrapedBusiness, newId: () => string): string {
    const compatible = (id: string | undefined): string | undefined => {
      if (!id) return undefined;
      const known = this.company(id);
      return known.placeId && row.placeId && known.placeId !== row.placeId ? undefined : id;
    };
    const existing =
      (row.placeId ? this.companyByPlace.get(row.placeId) : undefined) ??
      compatible(this.companyByBusinessId.get(row.sourceBusinessId)) ??
      compatible(this.companyByNameAndPhone.get(nameAndPhoneKey(row)));

    const incoming = companyFieldsOf(row);
    if (existing) {
      const company = this.company(existing);
      const merged = mergeFields(company.fields, incoming);
      company.fields = merged;
      company.placeId ??= row.placeId;
      company.source = row.source;
      company.touched = true;
      if (!company.sourceBusinessIds.has(row.sourceBusinessId)) {
        company.sourceBusinessIds.add(row.sourceBusinessId);
        company.newSourceBusinessIds.add(row.sourceBusinessId);
      }
      this.indexCompany(existing);
      return existing;
    }

    const id = newId();
    this.companies.set(id, {
      id,
      isNew: true,
      placeId: row.placeId,
      sourceBusinessIds: new Set([row.sourceBusinessId]),
      newSourceBusinessIds: new Set([row.sourceBusinessId]),
      fields: incoming,
      details: [],
      source: row.source,
      touched: true,
    });
    this.indexCompany(id);
    return id;
  }

  /** People match only within their company: by own email, scraper person_id, or name. */
  upsertPerson(row: ScrapedPerson, companyId: string, newId: () => string): string {
    const incoming = fieldsOf(row);
    const existing = identitiesOf(companyId, row.sourcePersonId, row.email, incoming)
      .map((identity) => this.personByIdentity.get(identity))
      .find((id) => id !== undefined);

    if (existing) {
      const person = this.person(existing);
      const merged = mergeFields(person.fields, incoming);
      person.fields = merged;
      person.source = row.source;
      person.touched = true;
      if (row.sourcePersonId && !person.sourcePersonIds.has(row.sourcePersonId)) {
        person.sourcePersonIds.add(row.sourcePersonId);
        person.newSourcePersonIds.add(row.sourcePersonId);
      }
      this.indexPerson(existing);
      return existing;
    }

    const id = newId();
    const ids = row.sourcePersonId ? [row.sourcePersonId] : [];
    this.people.set(id, {
      id,
      isNew: true,
      companyId,
      sourcePersonIds: new Set(ids),
      newSourcePersonIds: new Set(ids),
      fields: incoming,
      details: [],
      source: row.source,
      touched: true,
    });
    this.indexPerson(id);
    return id;
  }

  /** Adds a detail unless its owner already has it. An existing detail keeps its bad mark. */
  addDetail(
    owner: DetailOwner,
    channel: Channel,
    phoneKind: PhoneKind | null,
    value: string,
    key: string | null,
    now: string,
    newId: () => string,
    original = "",
  ): void {
    if (!key) return;
    const holder = owner.kind === "person" ? this.person(owner.personId) : this.company(owner.companyId);
    const existing = holder.details.find((d) => d.channel === channel && d.key === key);
    if (existing) {
      if (existing.bad && !this.keptBad.some((k) => k.detail.id === existing.id)) this.keptBad.push({ owner, detail: existing });
      return;
    }
    const detail: NewDetail = { id: newId(), owner, channel, phoneKind, value: value.trim(), original: original.trim() || null, key, addedAt: now };
    holder.details.push({ id: detail.id, channel, phoneKind, value: detail.value, key, bad: false });
    this.added.push(detail);
    if (owner.kind === "person" && channel === "email") this.indexPerson(owner.personId);
    if (owner.kind === "company" && phoneKind === "main_line") this.indexCompany(owner.companyId);
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

  newDetails(): NewDetail[] {
    return [...this.added];
  }

  private indexCompany(id: string): void {
    const company = this.company(id);
    if (company.placeId) this.companyByPlace.set(company.placeId, id);
    for (const businessId of company.sourceBusinessIds) this.companyByBusinessId.set(businessId, id);
    const mainLine = company.details.find((d) => d.phoneKind === "main_line");
    if (mainLine) this.companyByNameAndPhone.set(`${foldText(company.fields.name)}|${mainLine.key}`, id);
  }

  private indexPerson(id: string): void {
    const person = this.person(id);
    const emails = person.details.filter((d) => d.channel === "email").map((d) => d.key);
    const identities = [
      ...[...person.sourcePersonIds].map((sourceId) => `${person.companyId}|id|${sourceId}`),
      ...emails.map((email) => `${person.companyId}|email|${email}`),
      ...nameIdentity(person.companyId, person.fields),
    ];
    for (const identity of identities) this.personByIdentity.set(identity, id);
  }
}

function identitiesOf(companyId: string, sourcePersonId: string, email: string, fields: PersonFields): string[] {
  const key = emailKey(email);
  return [
    ...(key ? [`${companyId}|email|${key}`] : []),
    ...(sourcePersonId ? [`${companyId}|id|${sourcePersonId}`] : []),
    ...nameIdentity(companyId, fields),
  ];
}

function nameIdentity(companyId: string, fields: PersonFields): string[] {
  const joined = [fields.firstName, fields.lastName].filter(Boolean).join(" ");
  const name = foldText(fields.fullName || joined);
  return name ? [`${companyId}|name|${name}`] : [];
}

function nameAndPhoneKey(row: ScrapedBusiness): string {
  const phone = row.mainPhone ? phoneKey(row.mainPhone.e164 || row.mainPhone.original) : null;
  return phone ? `${foldText(row.name)}|${phone}` : "";
}

function leadKey(lead: LeadRef): string {
  return lead.kind === "person" ? `person:${lead.personId}` : `company:${lead.companyId}`;
}
