import { emailKey, foldText, nameKey, type Channel, type PhoneKind } from "./contact-details.ts";
import { resolveMatches, type Conflict, type Evidence, type EvidenceKind, type Resolution } from "./matching.ts";
import { ENROLLED_BY_IMPORT, type OutreachStatus } from "./outreach-status.ts";
import { companyRegion, displayPhone, parsePhone, type PhoneNumber } from "./phone.ts";
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
 * Matching is the factory's choice, recorded in docs/adr/0001: a row matches only on evidence
 * that singles out one record, and a row that cannot be matched safely changes nothing.
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

/** Everything the CRM holds that an import can match against, plus the enrollments. */
export interface Directory {
  readonly companies: readonly KnownCompany[];
  readonly people: readonly KnownPerson[];
  /** Enrollments in the campaign being imported into. Other campaigns never exclude anyone. */
  readonly enrollments: readonly KnownEnrollment[];
  /**
   * Enrollments in every other campaign. They exclude nobody; they only stop a lead gaining a
   * personal email, mobile or shared inbox that another lead in the same campaign already has.
   */
  readonly otherEnrollments: readonly { readonly lead: LeadRef; readonly campaignId: string }[];
}

export function emptyDirectory(): Directory {
  return { companies: [], people: [], enrollments: [], otherEnrollments: [] };
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
 * A change to a detail the CRM already holds: a direct number now known to be a mobile, a
 * person's number that turned out to be the company main line, or a number first stored without
 * a known country, now read in the company's. The id and bad mark are kept.
 */
export interface DetailChange {
  readonly id: string;
  readonly owner: DetailOwner;
  readonly phoneKind: PhoneKind | null;
  /** The number's new key, when it can now be read in the company's country. */
  readonly rekeyed: { readonly key: string; readonly searchDigits: string } | null;
}

/**
 * A personal copy of a company detail, folded into it. A bad mark on either side survives. The
 * store deletes the copy's row (docs/adr/0001 records what that means for later tickets).
 */
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

export type NotEnrolledReason = "no_usable_channel" | "company_not_in_export" | "ambiguous_match" | "shares_contact";

export type { Conflict, EvidenceKind } from "./matching.ts";

/** A contact detail as the import summary reports it. Phones are grouped for reading. */
export interface DetailNote {
  readonly channel: Channel;
  readonly phoneKind: PhoneKind | null;
  readonly value: string;
}

/**
 * A detail the row listed that was not stored for this lead: a colleague holds it, or another
 * lead in one of the same campaigns does.
 */
export interface HeldElsewhere {
  readonly detail: DetailNote;
  readonly holder: string;
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
      readonly heldElsewhere: readonly HeldElsewhere[];
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
      readonly heldElsewhere: readonly HeldElsewhere[];
    }
  | {
      readonly outcome: "not_enrolled";
      /** Its personal email or mobile, or its shared inbox, is already another enrolled lead's in this campaign. */
      readonly reason: "shares_contact";
      readonly lead: LeadRef;
      readonly name: string;
      readonly title: string;
      readonly companyId: string;
      readonly companyName: string;
      readonly peopleAtCompany: number;
      readonly shared: { readonly detail: DetailNote; readonly lead: string; readonly companyName: string };
      readonly heldElsewhere: readonly HeldElsewhere[];
    }
  | {
      readonly outcome: "not_enrolled";
      readonly reason: "company_not_in_export";
      readonly lead: null;
      readonly name: string;
      /** The People row's business_id, blank or matching no business in this export. */
      readonly sourceBusinessId: string;
    }
  | {
      readonly outcome: "not_enrolled";
      /** The row could not be matched safely, so it changed nothing. */
      readonly reason: "ambiguous_match";
      readonly lead: null;
      readonly name: string;
      /** A person row's title; a company row's city. */
      readonly title: string;
      /** The file the row is in, and its row numbers there as a spreadsheet shows them (the header is row 1). */
      readonly file: "businesses" | "people";
      readonly rowNumbers: readonly number[];
      /** A person row that fits no single person, or a row whose company fits no single company. */
      readonly record: "person" | "company";
      /** Several records fit and nothing tells them apart; another row fits the same record; or the row's details point to different records. */
      readonly conflict: Conflict;
      /** For a contradiction, the details that disagree. */
      readonly disagreeing: readonly EvidenceKind[];
      /** The company's name: on record for a person row, as in the file for a company row. */
      readonly companyName: string;
    };

export interface ImportSummary {
  readonly rows: { readonly businesses: number; readonly people: number };
  readonly counts: Readonly<Record<LeadOutcome, number>>;
  readonly entries: readonly SummaryEntry[];
  /** The company or person record each row of the two files landed in, in file order; null when the row changed nothing. */
  readonly rowRecords: { readonly businesses: readonly (string | null)[]; readonly people: readonly (string | null)[] };
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
  const businessRecords: (string | null)[] = scraped.businesses.map(() => null);
  const personRecords: (string | null)[] = scraped.people.map(() => null);
  const unapplied: SummaryEntry[] = [];

  // Businesses first: People rows join only to a business in this export. Rows that are one
  // company are collapsed, then each is matched against the companies already on record.
  const settledCompanies = crm.matchCompanies(groupBusinesses(scraped.businesses));
  const businessGroups = settledCompanies.groups;
  const companyMatches = settledCompanies.matches;
  const groupsOfBusinessId = new Map<string, Set<number>>();
  const companyOfGroup: ({ companyId: string } | { conflict: Conflict; disagreeing: readonly EvidenceKind[] })[] = businessGroups.map((group, g) => {
    for (const { row } of group.rows) {
      if (row.sourceBusinessId) groupsOfBusinessId.set(row.sourceBusinessId, (groupsOfBusinessId.get(row.sourceBusinessId) ?? new Set()).add(g));
    }
    const match = companyMatches[g];
    if (match?.kind === "ambiguous") {
      const city = group.rows.find((r) => r.row.city)?.row.city ?? "";
      unapplied.push({
        ...unmatched(group.name, city, "businesses", group.rows, "company", match),
        companyName: group.name,
      });
      return { conflict: match.conflict, disagreeing: match.disagreeing };
    }
    const companyId = crm.upsertCompany(group, match?.kind === "match" ? match.id : null);
    const owner: DetailOwner = { kind: "company", companyId };
    for (const { row, index } of group.rows) {
      businessRecords[index] = companyId;
      if (row.mainPhone) {
        const { e164, original } = row.mainPhone;
        const region = crm.regionOf(companyId, e164);
        crm.addPhone(owner, "main_line", e164 || original, parsePhone(e164, region) ?? parsePhone(original, region));
      }
      for (const email of row.generalEmails) crm.addEmail(owner, email);
    }
    return { companyId };
  });

  const joined: JoinedRow[] = [];
  scraped.people.forEach((row, index) => {
    const name = personDisplayName(fieldsOf(row));
    const candidates = [...(groupsOfBusinessId.get(row.sourceBusinessId) ?? [])];
    const [g] = candidates;
    const company = g === undefined || !row.sourceBusinessId ? undefined : companyOfGroup[g];
    const indexed = [{ row, index }];
    const companyName = businessGroups[g ?? 0]?.name ?? "";
    if (!company) {
      unapplied.push({ outcome: "not_enrolled", reason: "company_not_in_export", lead: null, name, sourceBusinessId: row.sourceBusinessId });
    } else if (candidates.length > 1) {
      // Business rows sharing this business_id are two companies (different place_ids, or a row
      // that settled apart from its group): the person could belong to either.
      const places = new Set(candidates.flatMap((c) => businessGroups[c]?.rows.flatMap((r) => (r.row.placeId ? [r.row.placeId] : [])) ?? []));
      const disagreeing: EvidenceKind[] = places.size > 1 ? ["business_id", "place_id"] : ["business_id"];
      const conflict = { conflict: "contradiction", disagreeing } as const;
      unapplied.push({ ...unmatched(name, row.title, "people", indexed, "company", conflict), companyName });
    } else if ("conflict" in company) {
      unapplied.push({ ...unmatched(name, row.title, "people", indexed, "company", company), companyName });
    } else {
      joined.push({ row, index, companyId: company.companyId });
    }
  });

  // Rows that are one person are collapsed, then each is matched against the people already on
  // record at its company. Same-name rows that differ stay separate people.
  const settledPeople = crm.matchPeople(groupPeople(joined, crm));
  const groups = settledPeople.groups;
  const personMatches = settledPeople.matches;
  const peopleInExport: string[] = [];
  groups.forEach((group, g) => {
    const match = personMatches[g];
    if (match?.kind === "ambiguous") {
      for (const r of group.rows) {
        unapplied.push({
          ...unmatched(personDisplayName(fieldsOf(r.row)), r.row.title, "people", [r], "person", match),
          companyName: crm.company(group.companyId).fields.name,
        });
      }
      return;
    }
    const personId = crm.upsertPerson(group, match?.kind === "match" ? match.id : null);
    for (const { row, index } of group.rows) {
      personRecords[index] = personId;
      addPersonDetails(crm, row, personId, group.companyId);
    }
    peopleInExport.push(personId);
  });

  const entries: SummaryEntry[] = [];
  const enrollments: NewEnrollment[] = [];

  const decide = (lead: LeadRef, reachable: { reach: Reach; via: ContactRoute[] }, who: { name: string; title: string; companyId: string }): void => {
    const companyName = crm.company(who.companyId).fields.name;
    const base = { lead, ...who, companyName, peopleAtCompany: crm.peopleAt(who.companyId).length };
    const { heldElsewhere, ...notes } = crm.notesFor(lead);
    if (crm.isEnrolled(lead)) {
      const updated = notes.added.length > 0 || notes.becameMobile.length > 0;
      entries.push({ ...base, outcome: updated ? "updated" : "already_enrolled", channels: reachable.reach, via: reachable.via, ...notes, heldElsewhere });
      return;
    }
    if (!hasUsableChannel(reachable.reach)) {
      entries.push({ ...base, outcome: "not_enrolled", reason: "no_usable_channel", heldElsewhere });
      return;
    }
    // Enrolled once every lead is decided, so the safety net below does not depend on row order.
    candidates.push({ at: entries.length, lead, entry: { ...base, outcome: "new", channels: reachable.reach, via: reachable.via, ...notes, heldElsewhere } });
    entries.push({ ...base, outcome: "new", channels: reachable.reach, via: reachable.via, ...notes, heldElsewhere });
  };
  const candidates: { at: number; lead: LeadRef; entry: Extract<SummaryEntry, { channels: unknown }> }[] = [];

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
  const companiesInExport = unique(companyOfGroup.flatMap((c) => ("companyId" in c ? [c.companyId] : [])));
  for (const companyId of companiesInExport) {
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

  // Safety net: whatever matching decided, one personal email, mobile or shared inbox is never two
  // enrolled leads' in one campaign. Evidence decides who keeps it, never row order.
  const refused = crm.reserveDestinations(candidates.map((c) => c.lead));
  for (const { at, lead, entry } of candidates) {
    const shared = refused.get(leadKey(lead));
    if (shared) {
      const { name, title, companyId, companyName, peopleAtCompany, heldElsewhere } = entry;
      entries[at] = { outcome: "not_enrolled", reason: "shares_contact", lead, name, title, companyId, companyName, peopleAtCompany, shared, heldElsewhere };
    } else {
      enrollments.push({ id: newId(), lead, status: ENROLLED_BY_IMPORT, enrolledAt: now });
    }
  }

  entries.push(...unapplied);
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
      rowRecords: { businesses: businessRecords, people: personRecords },
    },
  };
}

/** The name shown for a decision maker. A blank last name is kept as provided. */
export function personDisplayName(fields: Pick<PersonFields, "fullName" | "firstName" | "lastName">): string {
  const joined = [fields.firstName, fields.lastName].filter(Boolean).join(" ");
  return fields.fullName || joined || "Unnamed decision maker";
}

/**
 * Matches groups of rows, then decides each row of a collapsed group on its own evidence, name
 * agreement included, beside the file's other groups. A row that does not itself point to its
 * group's match leaves the group and is settled exactly as if it were imported alone; the rest are
 * matched again without it (review rounds 5 and 6).
 */
function settleGroups<R, G extends { readonly rows: readonly R[] }>(
  initial: readonly G[],
  evidenceOf: (group: G) => Evidence,
  withRows: (group: G, rows: readonly R[]) => G,
): { groups: G[]; matches: Resolution[] } {
  let groups = [...initial];
  for (;;) {
    const evidence = groups.map(evidenceOf);
    const matches = resolveMatches(evidence);
    const leaving = new Set<R>();
    groups.forEach((group, g) => {
      const match = matches[g];
      if (group.rows.length < 2 || match?.kind !== "match") return;
      // The row on its own, beside the file's other groups but without its own group's other rows.
      const others = evidence.filter((_, o) => o !== g);
      for (const row of group.rows) {
        const alone = resolveMatches([...others, evidenceOf(withRows(group, [row]))]).at(-1);
        if (alone?.kind !== "match" || alone.id !== match.id) leaving.add(row);
      }
    });
    if (leaving.size === 0) return { groups, matches };
    groups = groups.flatMap((group) => {
      const staying = group.rows.filter((r) => !leaving.has(r));
      const left = group.rows.filter((r) => leaving.has(r)).map((r) => withRows(group, [r]));
      return [...(staying.length > 0 ? [withRows(group, staying)] : []), ...left];
    });
  }
}

/** The summary entry of a row that could not be matched safely, without its company name. */
function unmatched(
  name: string,
  title: string,
  file: "businesses" | "people",
  rows: readonly Indexed<unknown>[],
  record: "person" | "company",
  why: { conflict: Conflict; disagreeing: readonly EvidenceKind[] },
) {
  return {
    outcome: "not_enrolled",
    reason: "ambiguous_match",
    lead: null,
    name,
    title,
    file,
    // A spreadsheet numbers the header row 1, so the first data row is row 2.
    rowNumbers: rows.map((r) => r.index + 2),
    record,
    conflict: why.conflict,
    disagreeing: why.disagreeing,
  } as const;
}

/** A detail as reported in the summary: phones grouped for reading. */
export function noteOf(detail: { channel: Channel; phoneKind: PhoneKind | null; key: string; value: string }): DetailNote {
  return {
    channel: detail.channel,
    phoneKind: detail.phoneKind,
    value: detail.channel === "phone" ? displayPhone(detail.key) : detail.value,
  };
}

interface Indexed<T> {
  readonly row: T;
  /** The row's position in its file. */
  readonly index: number;
}

/** Business rows of one export that are one company. */
interface BusinessGroup {
  readonly rows: readonly Indexed<ScrapedBusiness>[];
  readonly name: string;
}

interface JoinedRow extends Indexed<ScrapedPerson> {
  readonly companyId: string;
}

/** People rows of one export that are one person. */
interface PersonGroup {
  readonly companyId: string;
  readonly rows: readonly JoinedRow[];
}

/**
 * Collapses the rows that share any key into one group, keeping the first row's position.
 * `keysOf` gives each row's keys; an empty key never joins anything.
 */
function collapse<T>(items: readonly T[], keysOf: (item: T) => readonly string[]): T[][] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] ?? root;
    parent[i] = root;
    return root;
  };
  const firstWith = new Map<string, number>();
  items.forEach((item, i) => {
    for (const key of keysOf(item)) {
      if (!key) continue;
      const other = firstWith.get(key);
      if (other === undefined) firstWith.set(key, i);
      else parent[find(i)] = find(other);
    }
  });
  const groups = new Map<number, T[]>();
  items.forEach((item, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), item]);
  });
  return [...groups.values()];
}

/**
 * Groups rows of one export that are one person or company.
 * - Rows sharing a strong key are one, unless they carry different decisive identities (two
 *   place_ids; two personal emails already on record for different people). Then the rows of
 *   each identity are one, and rows with none are grouped among themselves.
 * - Groups sharing a weak key (an agreeing name with a number or main line) are one, when every
 *   group sharing that key fits together.
 */
function groupRows<T>(
  items: readonly T[],
  spec: {
    strong: (item: T) => readonly string[];
    weak: (item: T) => readonly string[];
    identity: (item: T) => string;
    fit: (rows: readonly T[]) => boolean;
  },
): T[][] {
  const identities = (rows: readonly T[]) => new Set(rows.map(spec.identity).filter(Boolean));
  const split = collapse(items, spec.strong).flatMap((rows) => {
    const ids = [...identities(rows)];
    if (ids.length <= 1) return [rows];
    return [...ids.map((id) => rows.filter((r) => spec.identity(r) === id)), ...collapse(rows.filter((r) => !spec.identity(r)), spec.strong)];
  });
  const byWeakKey = new Map<string, Set<number>>();
  split.forEach((rows, g) => {
    for (const key of rows.flatMap(spec.weak)) if (key) byWeakKey.set(key, (byWeakKey.get(key) ?? new Set()).add(g));
  });
  const parent = split.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : find(parent[i] ?? i));
  const members = (root: number) => split.flatMap((rows, g) => (find(g) === root ? rows : []));
  for (const key of [...byWeakKey.keys()].sort()) {
    const roots = [...new Set([...(byWeakKey.get(key) ?? [])].map(find))];
    if (roots.length < 2) continue;
    const together = roots.flatMap(members);
    if (identities(together).size > 1 || !spec.fit(together)) continue;
    for (const root of roots.slice(1)) parent[root] = roots[0] ?? root;
  }
  const merged = new Map<number, T[]>();
  split.forEach((rows, g) => merged.set(find(g), [...(merged.get(find(g)) ?? []), ...rows]));
  return [...merged.values()].map((rows) => [...rows].sort((a, b) => indexOf(a) - indexOf(b)));
}

function indexOf(item: unknown): number {
  return typeof item === "object" && item !== null && "index" in item && typeof item.index === "number" ? item.index : 0;
}

/**
 * Rows with the same non-blank business_id or place_id, identical after normalising, or with an
 * agreeing name and main line, are one company: never across two place_ids, and the name-and-line
 * link never across two addresses.
 */
function groupBusinesses(rows: readonly ScrapedBusiness[]): BusinessGroup[] {
  const indexed = rows.map((row, index) => ({ row, index }));
  return groupRows(indexed, {
    strong: ({ row }) => [
      row.sourceBusinessId ? `id|${row.sourceBusinessId}` : "",
      row.placeId ? `place|${row.placeId}` : "",
      `row|${JSON.stringify([
        row.sourceBusinessId,
        row.placeId ?? "",
        nameKey(row.name),
        mainLineOf(row)?.key ?? "",
        row.generalEmails.map((e) => emailKey(e) ?? "").sort(),
        ...[row.category, row.website, row.domain, row.street, row.neighborhood, row.city, row.stateProvince, row.postalCode, row.country, row.timezone ?? ""].map(foldText),
      ])}`,
    ],
    weak: ({ row }) => {
      const line = mainLineOf(row)?.key;
      return line && nameKey(row.name) ? [`${nameKey(row.name)}|${line}`] : [];
    },
    identity: ({ row }) => row.placeId ?? "",
    fit: (group) => new Set(group.map(({ row }) => addressKey(row)).filter(Boolean)).size <= 1,
  }).map((group) => ({ rows: group, name: group.find((r) => r.row.name)?.row.name ?? "" }));
}

/**
 * At one company, rows with the same non-blank person_id or personal email, identical after
 * normalising, or with an agreeing name and the same personal number, are one person: never
 * across two personal emails already on record for different people. Rows that differ in
 * anything else, same-name colleagues included, stay separate people.
 */
function groupPeople(joined: readonly JoinedRow[], crm: WorkingDirectory): PersonGroup[] {
  const personal = ({ row, companyId }: JoinedRow) => {
    const email = emailKey(row.email);
    return email && !crm.companyHolds(companyId, "email", email) ? email : "";
  };
  const phones = ({ row, companyId }: JoinedRow) => {
    const region = crm.regionOf(companyId, "");
    return [row.directPhone, row.dialPhone].flatMap((raw) => parsePhone(raw, region)?.key ?? []).filter((key) => !crm.companyHolds(companyId, "phone", key));
  };
  return groupRows(joined, {
    strong: (r) => {
      const { row, companyId } = r;
      const region = crm.regionOf(companyId, "");
      const phone = (raw: string) => parsePhone(raw, region)?.key ?? "";
      return [
        row.sourcePersonId ? `id|${companyId}|${row.sourcePersonId}` : "",
        personal(r) ? `email|${companyId}|${personal(r)}` : "",
        `row|${companyId}|${JSON.stringify([
          row.sourcePersonId,
          personNameKey(fieldsOf(row)),
          emailKey(row.email) ?? "",
          phone(row.directPhone),
          phone(row.dialPhone),
          dialKindOf(row),
          ...[row.title, row.roleTier, row.linkedinUrl, row.timezone ?? ""].map(foldText),
        ])}`,
      ];
    },
    weak: (r) => {
      const name = personNameKey(fieldsOf(r.row));
      return name ? phones(r).map((key) => `${r.companyId}|${name}|${key}`) : [];
    },
    identity: (r) => (personal(r) ? (crm.personHolding(r.companyId, personal(r)) ?? "") : ""),
    fit: () => true,
  }).map((rows) => ({ companyId: rows[0]?.companyId ?? "", rows }));
}

function addPersonDetails(crm: WorkingDirectory, row: ScrapedPerson, personId: string, companyId: string): void {
  const owner: DetailOwner = { kind: "person", personId };
  const region = crm.regionOf(companyId, "");

  crm.addEmail(owner, row.email);

  // A mobile first, so a number listed both as direct and as mobile keeps its mobile capability.
  const phones: [PhoneKind, string][] = [
    [dialKindOf(row), row.dialPhone],
    ["direct", row.directPhone],
  ];
  for (const [kind, raw] of phones) crm.addPhone(owner, kind, raw, parsePhone(raw, region));
}

/** dial_phone is a mobile only when dial_phone_type says mobile or cell. */
function dialKindOf(row: ScrapedPerson): PhoneKind {
  return /mobile|cell/i.test(row.dialPhoneType) ? "mobile" : "direct";
}

function mainLineOf(row: ScrapedBusiness): PhoneNumber | null {
  if (!row.mainPhone) return null;
  const region = companyRegion(row.country, [row.mainPhone.e164]);
  return parsePhone(row.mainPhone.e164, region) ?? parsePhone(row.mainPhone.original, region);
}

/** A street address for matching: the street with its postal code, or empty when either is missing. */
function addressKey(fields: Pick<CompanyFields, "street" | "postalCode">): string {
  const fold = (text: string) => foldText(text).replace(/[^\p{L}\p{N}]/gu, "");
  const street = fold(fields.street);
  const postal = fold(fields.postalCode);
  return street && postal ? `${street}|${postal}` : "";
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

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
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

/** The directory as it evolves while one export is applied. */
class WorkingDirectory {
  private readonly companies = new Map<string, MutableCompany>();
  private readonly people = new Map<string, MutablePerson>();
  private readonly enrolled = new Set<string>();
  /** The other campaigns each lead is enrolled in. */
  private readonly campaignsElsewhere = new Map<string, Set<string>>();
  private readonly added: NewDetail[] = [];
  private readonly changed = new Map<string, DetailChange>();
  private readonly merged: DetailConsolidation[] = [];
  private readonly keptBad: { owner: DetailOwner; detail: MutableDetail }[] = [];
  private readonly upgraded: { owner: DetailOwner; detail: MutableDetail }[] = [];
  private readonly heldElsewhere: { owner: DetailOwner; held: HeldElsewhere; holder: LeadRef; key: string }[] = [];
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
    for (const e of directory.otherEnrollments) {
      const key = leadKey(e.lead);
      this.campaignsElsewhere.set(key, (this.campaignsElsewhere.get(key) ?? new Set()).add(e.campaignId));
    }
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

  /** The campaigns a lead is enrolled in; this import's campaign is "". */
  private campaignsOf(lead: LeadRef): Set<string> {
    return new Set([...(this.isEnrolled(lead) ? [""] : []), ...(this.campaignsElsewhere.get(leadKey(lead)) ?? [])]);
  }

  /**
   * The outreach destinations only one enrolled lead per campaign may have: a person's own
   * emails and mobiles, a company lead's shared inboxes.
   */
  private destinations(lead: LeadRef): { kind: string; detail: MutableDetail }[] {
    if (lead.kind === "company") return this.company(lead.companyId).details.filter((d) => d.channel === "email").map((detail) => ({ kind: "inbox", detail }));
    return this.person(lead.personId)
      .details.filter((d) => d.channel === "email" || d.phoneKind === "mobile")
      .map((detail) => ({ kind: detail.channel === "email" ? "email" : "mobile", detail }));
  }

  /** Another lead holding this destination who shares a campaign with `lead`, enrolled or about to be. */
  private destinationHolder(lead: LeadRef, kind: string, key: string, campaigns: ReadonlySet<string>): LeadRef | undefined {
    const others: LeadRef[] =
      lead.kind === "company"
        ? [...this.companies.keys()].filter((id) => id !== lead.companyId).map((companyId) => ({ kind: "company", companyId }))
        : [...this.people.keys()].filter((id) => id !== lead.personId).map((personId) => ({ kind: "person", personId }));
    return others.find(
      (other) => this.destinations(other).some((d) => d.kind === kind && d.detail.key === key) && [...this.campaignsOf(other)].some((c) => campaigns.has(c)),
    );
  }

  /**
   * Reserves each outreach destination in this campaign for one lead, and returns the candidates
   * that may not be enrolled, with whose destination stopped them. A lead's claim on a destination
   * is ranked by evidence: already enrolled here and holding it; holding it from before this
   * import; holding it from this import; only listing it in its row (the detail stayed with
   * whoever already had it). The strongest claim keeps the destination; every weaker or equal
   * claim of another candidate loses, so two candidates with equal claims are both stopped.
   */
  reserveDestinations(candidates: readonly LeadRef[]): Map<string, { detail: DetailNote; lead: string; companyName: string }> {
    const claims: { lead: LeadRef; key: string; rank: number; detail: DetailNote }[] = [];
    const fresh = new Set(this.added.map((d) => d.id));
    const enrolledHere = [...this.enrolled].map((key): LeadRef => {
      const [kind, id = ""] = key.split(":");
      return kind === "company" ? { kind: "company", companyId: id } : { kind: "person", personId: id };
    });
    for (const lead of [...enrolledHere, ...candidates]) {
      const enrolled = this.isEnrolled(lead);
      for (const { kind, detail } of this.destinations(lead)) {
        claims.push({ lead, key: `${kind}|${detail.key}`, rank: enrolled ? 0 : fresh.has(detail.id) ? 2 : 1, detail: noteOf(detail) });
      }
      if (enrolled) continue;
      for (const h of this.heldElsewhere) {
        if (leadKey(h.owner) !== leadKey(lead)) continue;
        const kind = h.held.detail.channel === "email" ? (lead.kind === "company" ? "inbox" : "email") : h.held.detail.phoneKind === "mobile" ? "mobile" : null;
        if (kind) claims.push({ lead, key: `${kind}|${h.key}`, rank: 3, detail: h.held.detail });
      }
    }
    const refused = new Map<string, { detail: DetailNote; lead: string; companyName: string }>();
    for (const lead of candidates) {
      for (const claim of claims.filter((c) => leadKey(c.lead) === leadKey(lead))) {
        const rivals = claims.filter((c) => c.key === claim.key && leadKey(c.lead) !== leadKey(lead) && c.rank <= claim.rank).sort((a, b) => a.rank - b.rank);
        const [strongest] = rivals;
        if (!strongest || refused.has(leadKey(lead))) continue;
        const holder = strongest.lead;
        refused.set(leadKey(lead), {
          detail: claim.detail,
          lead: this.nameOf(holder),
          companyName: this.company(holder.kind === "company" ? holder.companyId : this.person(holder.personId).companyId).fields.name,
        });
      }
    }
    return refused;
  }

  private nameOf(lead: LeadRef): string {
    return lead.kind === "company" ? this.company(lead.companyId).fields.name : personDisplayName(this.person(lead.personId).fields);
  }

  /**
   * Matches each group of business rows to a company already on record, on evidence that
   * singles one out, strongest first:
   * 1. the same place_id;
   * 2. one of its business_ids, with an agreeing name and, where both sides have them, an
   *    agreeing main line or address;
   * 3. an agreeing name and a main line the row carries;
   * 4. an agreeing name and address;
   * 5. an agreeing name alone, when the row has no place_id, main line or address.
   * A company with a different place_id never matches. Called before any company is written.
   */
  matchCompanies(groups: readonly BusinessGroup[]) {
    return settleGroups<Indexed<ScrapedBusiness>, BusinessGroup>(groups, (group) => this.companyEvidence(group), (group, rows) => ({ rows, name: group.name }));
  }

  private companyEvidence(group: BusinessGroup): Evidence {
    const known = [...this.companies.values()];
    return ((): Evidence => {
        const rows = group.rows.map((r) => r.row);
        const places = unique(rows.flatMap((r) => (r.placeId ? [r.placeId] : [])));
        const businessIds = unique(rows.flatMap((r) => (r.sourceBusinessId ? [r.sourceBusinessId] : [])));
        const names = unique(rows.map((r) => nameKey(r.name)).filter(Boolean));
        const lines = unique(rows.flatMap((r) => mainLineOf(r)?.key ?? []));
        const addresses = unique(rows.map(addressKey).filter(Boolean));
        const region = rows.map((r) => companyRegion(r.country, [r.mainPhone?.e164 ?? ""])).find(Boolean) ?? null;
        const compatible = known.filter((c) => !c.placeId || places.length === 0 || places.includes(c.placeId));
        const named = compatible.filter((c) => names.includes(nameKey(c.fields.name)));
        // A main line stored before its company's country was known is compared by its key now.
        const linesOf = (c: MutableCompany) =>
          c.details
            .filter((d) => d.phoneKind === "main_line")
            .map((d) => (d.key.startsWith("+") ? d.key : (parsePhone(d.value, region ?? companyRegion(c.fields.country, []))?.key ?? d.key)));
        const sharesLine = (c: MutableCompany) => linesOf(c).some((key) => lines.includes(key));
        const sharesAddress = (c: MutableCompany) => addresses.includes(addressKey(c.fields));
        const corroborated = (c: MutableCompany) => {
          const comparable = (lines.length > 0 && linesOf(c).length > 0) || (addresses.length > 0 && addressKey(c.fields) !== "");
          return !comparable || sharesLine(c) || sharesAddress(c);
        };
        const ids = (list: readonly MutableCompany[]) => list.map((c) => c.id);
        const bare = places.length === 0 && lines.length === 0 && addresses.length === 0;
        return {
          tiers: [
            { kind: "place_id", decisive: true, ids: ids(known.filter((c) => c.placeId !== null && places.includes(c.placeId))) },
            { kind: "business_id", ids: ids(named.filter((c) => businessIds.some((id) => c.sourceBusinessIds.has(id)) && corroborated(c))) },
            { kind: "main_line", ids: ids(named.filter(sharesLine)) },
            { kind: "address", ids: ids(named.filter(sharesAddress)) },
          ],
          // A main line on record identifies its company whatever the row's name says.
          holders: { kind: "main_line", ids: ids(compatible.filter(sharesLine)) },
          byName: bare ? ids(named) : [],
        };
    })();
  }

  upsertCompany(group: BusinessGroup, existing: string | null): string {
    const rows = group.rows.map((r) => r.row);
    const [first, ...rest] = rows;
    if (!first) throw new Error("an empty business group");
    const incoming = rest.reduce((fields, row) => mergeFields(fields, companyFieldsOf(row)), companyFieldsOf(first));
    const placeId = rows.find((r) => r.placeId)?.placeId ?? null;
    const source = rows.at(-1)?.source ?? first.source;
    const newIds = unique(rows.flatMap((r) => (r.sourceBusinessId ? [r.sourceBusinessId] : [])));
    if (existing) {
      const company = this.company(existing);
      company.fields = mergeFields(company.fields, incoming);
      company.placeId ??= placeId;
      company.source = source;
      company.touched = true;
      for (const id of newIds) {
        if (!company.sourceBusinessIds.has(id)) {
          company.sourceBusinessIds.add(id);
          company.newSourceBusinessIds.add(id);
        }
      }
      return existing;
    }

    const id = this.newId();
    this.companies.set(id, {
      id,
      isNew: true,
      placeId,
      sourceBusinessIds: new Set(newIds),
      newSourceBusinessIds: new Set(newIds),
      fields: incoming,
      details: [],
      source,
      touched: true,
    });
    return id;
  }

  /**
   * Matches each group of People rows to a person who was on record at its company before this
   * import, on evidence that singles one out, strongest first:
   * 1. one of the row's personal emails;
   * 2. one of its scraper person_ids, with an agreeing name;
   * 3. an agreeing name and a personal number the row carries;
   * 4. an agreeing name, when nobody else at the company has it.
   */
  matchPeople(groups: readonly PersonGroup[]) {
    return settleGroups<JoinedRow, PersonGroup>(groups, (group) => this.personEvidence(group), (group, rows) => ({ companyId: group.companyId, rows }));
  }

  private personEvidence(group: PersonGroup): Evidence {
    return ((): Evidence => {
        const rows = group.rows.map((r) => r.row);
        const region = this.regionOf(group.companyId, "");
        const emails = unique(rows.flatMap((r) => emailKey(r.email) ?? [])).filter((e) => !this.companyHolds(group.companyId, "email", e));
        const ids = unique(rows.flatMap((r) => (r.sourcePersonId ? [r.sourcePersonId] : [])));
        const names = unique(rows.map((r) => personNameKey(fieldsOf(r))).filter(Boolean));
        const phones = unique(rows.flatMap((r) => [r.directPhone, r.dialPhone].flatMap((raw) => parsePhone(raw, region)?.key ?? [])));
        const candidates = this.peopleAt(group.companyId).filter((p) => !p.isNew);
        const named = candidates.filter((p) => names.includes(personNameKey(p.fields)));
        const idsOf = (list: readonly MutablePerson[]) => list.map((p) => p.id);
        return {
          tiers: [
            { kind: "email", decisive: true, ids: idsOf(candidates.filter((p) => p.details.some((d) => d.channel === "email" && emails.includes(d.key)))) },
            { kind: "person_id", ids: idsOf(named.filter((p) => ids.some((id) => p.sourcePersonIds.has(id)))) },
            { kind: "phone", ids: idsOf(named.filter((p) => phones.some((key) => this.findNumber(p.details, key, region) !== undefined))) },
          ],
          byName: idsOf(named),
        };
    })();
  }

  /** The person on record before this import at the company who holds this personal email. */
  personHolding(companyId: string, email: string): string | undefined {
    return this.peopleAt(companyId).find((p) => !p.isNew && p.details.some((d) => d.channel === "email" && d.key === email))?.id;
  }

  upsertPerson(group: PersonGroup, existing: string | null): string {
    const [first, ...rest] = group.rows.map((r) => r.row);
    if (!first) throw new Error("an empty row group");
    const incoming = rest.reduce((fields, row) => mergeFields(fields, fieldsOf(row)), fieldsOf(first));
    const source = group.rows.at(-1)?.row.source ?? first.source;
    const ids = unique(group.rows.flatMap((r) => (r.row.sourcePersonId ? [r.row.sourcePersonId] : [])));
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
    const holder = this.destinationHolder(owner, owner.kind === "company" ? "inbox" : "email", key, this.campaignsOf(owner));
    if (holder) {
      this.noteHeldElsewhere(owner, { channel: "email", phoneKind: null, key, value: raw.trim() }, holder);
      return;
    }
    if (owner.kind === "company") {
      const held = this.claimForCompany(owner.companyId, "email", key, null);
      if (held) this.noteKeptBad(owner, held);
      else this.add(owner, "email", null, raw, key, "");
      return;
    }
    const companyId = this.person(owner.personId).companyId;
    if (this.companyHolds(companyId, "email", key)) return;
    const colleague = this.colleagueHolding(owner.personId, (details) => details.find((d) => d.channel === "email" && d.key === key));
    if (colleague) {
      this.noteHeldElsewhere(owner, { channel: "email", phoneKind: null, key, value: raw.trim() }, { kind: "person", personId: colleague.id });
      return;
    }
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
  addPhone(owner: DetailOwner, kind: PhoneKind, raw: string, phone: PhoneNumber | null): void {
    if (!phone) return;
    if (owner.kind === "company") {
      const held = this.claimForCompany(owner.companyId, "phone", phone.key, "main_line");
      if (held) this.noteKeptBad(owner, held);
      else this.add(owner, "phone", "main_line", raw, phone.key, phone.searchDigits);
      return;
    }
    const person = this.person(owner.personId);
    const companyId = person.companyId;
    const region = this.regionOf(companyId, "");
    const mainLine = this.findNumber(this.company(companyId).details, phone.key, region);
    if (mainLine) {
      this.rekey(mainLine, { kind: "company", companyId }, phone);
      this.noteKeptBad({ kind: "company", companyId }, mainLine);
      return;
    }
    const colleague = this.colleagueHolding(owner.personId, (details) => this.findNumber(details, phone.key, region));
    if (colleague) {
      this.noteHeldElsewhere(owner, { channel: "phone", phoneKind: kind, key: phone.key, value: raw.trim() }, { kind: "person", personId: colleague.id });
      return;
    }
    const existing = this.findNumber(person.details, phone.key, region);
    const mobileHolder = kind === "mobile" && existing?.phoneKind !== "mobile" ? this.destinationHolder(owner, "mobile", phone.key, this.campaignsOf(owner)) : undefined;
    if (mobileHolder) {
      this.noteHeldElsewhere(owner, { channel: "phone", phoneKind: kind, key: phone.key, value: raw.trim() }, mobileHolder);
      if (existing) this.noteKeptBad(owner, existing);
      return;
    }
    if (!existing) {
      this.add(owner, "phone", kind, raw, phone.key, phone.searchDigits);
      return;
    }
    this.rekey(existing, owner, phone);
    this.noteKeptBad(owner, existing);
    if (kind === "mobile" && existing.phoneKind === "direct") {
      existing.phoneKind = "mobile";
      this.recordChange(existing, owner);
      if (!this.added.some((d) => d.id === existing.id)) this.upgraded.push({ owner, detail: existing });
    }
  }

  /**
   * The detail holding this number: by its key, or, for a number first stored without a known
   * country (keyed by its digits), by reading what was written in the company's country now.
   */
  private findNumber(details: readonly MutableDetail[], key: string, region: string | null): MutableDetail | undefined {
    return details.find(
      (d) => d.channel === "phone" && (d.key === key || (region !== null && !d.key.startsWith("+") && parsePhone(d.value, region)?.key === key)),
    );
  }

  /** Gives a number first stored without a known country its proper key. */
  private rekey(detail: MutableDetail, owner: DetailOwner, phone: PhoneNumber): void {
    if (detail.key === phone.key) return;
    detail.key = phone.key;
    this.recordChange(detail, owner, { key: phone.key, searchDigits: phone.searchDigits });
  }

  private colleagueHolding(personId: string, holds: (details: readonly MutableDetail[]) => MutableDetail | undefined): MutablePerson | undefined {
    const companyId = this.person(personId).companyId;
    return this.peopleAt(companyId).find((p) => p.id !== personId && holds(p.details) !== undefined);
  }

  /**
   * Makes the company the one owner of this address or number. The first personal copy moves to
   * the company if it has none; every other copy folds into the company detail.
   */
  private claimForCompany(companyId: string, channel: Channel, key: string, phoneKind: PhoneKind | null): MutableDetail | null {
    const owner: DetailOwner = { kind: "company", companyId };
    const company = this.company(companyId);
    const region = this.regionOf(companyId, channel === "phone" ? key : "");
    const holding = (d: MutableDetail) =>
      d.channel === channel && (d.key === key || (channel === "phone" && region !== null && !d.key.startsWith("+") && parsePhone(d.value, region)?.key === key));
    const searchDigits = channel === "phone" ? (parsePhone(key, region)?.searchDigits ?? "") : "";
    let target = company.details.find(holding) ?? null;
    if (target && target.key !== key) {
      target.key = key;
      this.recordChange(target, owner, { key, searchDigits });
    }
    for (const person of this.peopleAt(companyId)) {
      for (const copy of person.details.filter(holding)) {
        person.details = person.details.filter((d) => d !== copy);
        if (!target) {
          copy.phoneKind = phoneKind;
          const rekeyed = copy.key === key ? null : { key, searchDigits };
          copy.key = key;
          company.details.push(copy);
          this.recordChange(copy, owner, rekeyed);
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

  /** What this import added to the lead's own record, which of its details stayed bad, and what a colleague kept. */
  notesFor(lead: LeadRef): { added: DetailNote[]; becameMobile: DetailNote[]; stillBad: DetailNote[]; heldElsewhere: HeldElsewhere[] } {
    const owns = (owner: DetailOwner) =>
      lead.kind === "person"
        ? owner.kind === "person" && owner.personId === lead.personId
        : owner.kind === "company" && owner.companyId === lead.companyId;
    const current = (id: string) => [...this.holderOf(lead).details].find((d) => d.id === id);
    return {
      added: this.added.filter((d) => owns(d.owner)).map((d) => noteOf({ ...d, phoneKind: current(d.id)?.phoneKind ?? d.phoneKind })),
      becameMobile: this.upgraded.filter((u) => owns(u.owner)).map((u) => noteOf(u.detail)),
      stillBad: this.keptBad.filter((k) => owns(k.owner)).map((k) => noteOf(k.detail)),
      heldElsewhere: this.heldElsewhere.filter((h) => owns(h.owner)).map((h) => h.held),
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

  /** New details, with any change made later in the same import folded in. */
  newDetails(): NewDetail[] {
    return this.added.map((d) => {
      const change = this.changed.get(d.id);
      return change ? { ...d, owner: change.owner, phoneKind: change.phoneKind, ...(change.rekeyed ?? {}) } : d;
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

  private recordChange(detail: MutableDetail, owner: DetailOwner, rekeyed: DetailChange["rekeyed"] = null): void {
    const earlier = this.changed.get(detail.id)?.rekeyed ?? null;
    this.changed.set(detail.id, { id: detail.id, owner, phoneKind: detail.phoneKind, rekeyed: rekeyed ?? earlier });
  }

  private noteKeptBad(owner: DetailOwner, detail: MutableDetail): void {
    if (detail.bad && !this.keptBad.some((k) => k.detail.id === detail.id)) this.keptBad.push({ owner, detail });
  }

  private noteHeldElsewhere(owner: DetailOwner, detail: { channel: Channel; phoneKind: PhoneKind | null; key: string; value: string }, holder: LeadRef): void {
    const note = noteOf(detail);
    const same = (h: { owner: DetailOwner; held: HeldElsewhere }) =>
      leadKey(h.owner) === leadKey(owner) && h.held.detail.channel === note.channel && h.held.detail.value === note.value;
    if (!this.heldElsewhere.some(same)) this.heldElsewhere.push({ owner, held: { detail: note, holder: this.nameOf(holder) }, holder, key: detail.key });
  }
}

function leadKey(lead: LeadRef | DetailOwner): string {
  return lead.kind === "person" ? `person:${lead.personId}` : `company:${lead.companyId}`;
}
