import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { digitsOf, foldText, isNewerDetail, type Channel, type PhoneKind } from "../../domain/contact-details.ts";
import {
  personDisplayName,
  type Directory,
  type ImportPlan,
  type ImportSummary,
  type KnownDetail,
  type LeadRef,
} from "../../domain/import-plan.ts";
import { isOutreachStatus } from "../../domain/outreach-status.ts";
import { companyLeadReach, decisionMakerReach, hasUsableChannel } from "../../domain/reach.ts";
import type {
  Campaign,
  CampaignListItem,
  ColleagueView,
  CompanyRecord,
  CompanyRef,
  ContactDetailView,
  EnrollmentView,
  ImportRecord,
  LeadRow,
  LeadSearchResult,
  PersonRecord,
  UnenrolledReason,
} from "../../shared/api.ts";
import { migrate } from "./migrations.ts";
import type { LeadQuery, OutreachStore } from "./store.ts";

type Row = Record<string, SQLOutputValue>;

/** Opens (creating if needed) the SQLite database at `path` and applies pending migrations. */
export function openSqliteStore(path: string): OutreachStore {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db, () => new Date().toISOString());
  return new SqliteStore(db);
}

class SqliteStore implements OutreachStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  createCampaign(campaign: Campaign): void {
    this.run("INSERT INTO campaigns (id, name, default_timezone, created_at) VALUES (?, ?, ?, ?)", [
      campaign.id,
      campaign.name,
      campaign.defaultTimezone,
      campaign.createdAt,
    ]);
  }

  campaign(id: string): Campaign | null {
    const row = this.db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id);
    return row ? toCampaign(row) : null;
  }

  listCampaigns(): CampaignListItem[] {
    return this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM enrollments e WHERE e.campaign_id = c.id) AS lead_count
         FROM campaigns c ORDER BY c.created_at DESC, c.name`,
      )
      .all()
      .map((row) => ({ ...toCampaign(row), leadCount: num(row, "lead_count") }));
  }

  importIntoCampaign(input: {
    campaignId: string;
    importId: string;
    importedAt: string;
    plan: (directory: Directory) => ImportPlan;
  }): ImportRecord {
    return this.transaction(() => {
      const plan = input.plan(this.directory(input.campaignId));
      this.apply(plan, input);
      return {
        id: input.importId,
        campaignId: input.campaignId,
        importedAt: input.importedAt,
        summary: plan.summary,
      };
    });
  }

  listImports(campaignId: string): ImportRecord[] {
    return this.db
      .prepare("SELECT * FROM imports WHERE campaign_id = ? ORDER BY imported_at DESC, rowid DESC")
      .all(campaignId)
      .map((row) => ({
        id: str(row, "id"),
        campaignId: str(row, "campaign_id"),
        importedAt: str(row, "imported_at"),
        // Written by this module from a typed ImportSummary.
        summary: JSON.parse(str(row, "summary")) as ImportSummary,
      }));
  }

  searchLeads(query: LeadQuery): LeadSearchResult {
    const text = foldText(query.text);
    const like = `%${escapeLike(text)}%`;
    const digits = /^[\d\s+().\-/]+$/.test(query.text.trim()) ? digitsOf(query.text) : "";
    const digitsLike = digits.length >= 3 ? `%${digits}%` : "";
    const params = {
      text,
      like,
      digitsLike,
      campaign: query.campaignId ?? "",
      status: query.status ?? "",
    };

    const detailMatch = (ownerFilter: string): string => `EXISTS (
      SELECT 1 FROM contact_details d WHERE ${ownerFilter}
      AND ((d.channel = 'email' AND d.key LIKE :like ESCAPE '\\')
        OR (:digitsLike <> '' AND d.search_digits LIKE :digitsLike)))`;
    const enrollmentFilter = (leadFilter: string): string => `
      (:campaign = '' OR EXISTS (SELECT 1 FROM enrollments e WHERE ${leadFilter} AND e.campaign_id = :campaign))
      AND (:status = '' OR EXISTS (SELECT 1 FROM enrollments e WHERE ${leadFilter} AND e.status = :status
        AND (:campaign = '' OR e.campaign_id = :campaign)))`;

    const sql = `
      SELECT 'person' AS kind, p.id AS id, p.display_name AS sort_name FROM people p
      JOIN companies c ON c.id = p.company_id
      WHERE (:text = '' OR p.search_name LIKE :like ESCAPE '\\' OR c.search_name LIKE :like ESCAPE '\\'
        OR ${detailMatch(
          "((d.owner_kind = 'person' AND d.owner_id = p.id) OR (d.owner_kind = 'company' AND d.owner_id = c.id))",
        )})
      AND ${enrollmentFilter("e.lead_kind = 'person' AND e.person_id = p.id")}
      UNION ALL
      SELECT 'company' AS kind, c.id AS id, c.name AS sort_name FROM companies c
      WHERE NOT EXISTS (SELECT 1 FROM people p WHERE p.company_id = c.id)
      AND (:text = '' OR c.search_name LIKE :like ESCAPE '\\'
        OR ${detailMatch("d.owner_kind = 'company' AND d.owner_id = c.id")})
      AND ${enrollmentFilter("e.lead_kind = 'company' AND e.company_id = c.id")}
    `;
    const total = num(this.db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get(params) ?? {}, "n");
    const ids = this.db
      .prepare(`${sql} ORDER BY sort_name COLLATE NOCASE, id LIMIT :limit`)
      .all({ ...params, limit: query.limit });

    const rows = ids.map((row): LeadRow => {
      const id = str(row, "id");
      if (str(row, "kind") === "person") {
        const person = this.personRow(id);
        if (!person) throw new Error(`person ${id} vanished during search`);
        return {
          kind: "person",
          id,
          name: str(person, "display_name"),
          title: str(person, "title"),
          company: this.companyRef(str(person, "company_id")),
          enrollments: this.enrollments({ kind: "person", personId: id }),
          unenrolledReason: this.personUnenrolledReason(id, str(person, "company_id")),
        };
      }
      const company = this.companyRef(id);
      return {
        kind: "company",
        id,
        name: company.name,
        city: company.city,
        enrollments: this.enrollments({ kind: "company", companyId: id }),
        unenrolledReason: this.companyUnenrolledReason(id),
      };
    });
    return { rows, total, limit: query.limit };
  }

  person(id: string): PersonRecord | null {
    const row = this.personRow(id);
    if (!row) return null;
    const companyId = str(row, "company_id");
    const company = this.companyRow(companyId);
    const enrollments = this.enrollments({ kind: "person", personId: id });
    const own = this.details("person", id);
    const shared = this.details("company", companyId);
    const fallbackZone = enrollments.map((e) => this.campaign(e.campaign.id)?.defaultTimezone).find(Boolean) ?? null;
    return {
      kind: "person",
      id,
      name: str(row, "display_name"),
      title: str(row, "title"),
      timezone: strOrNull(row, "timezone") ?? (company ? strOrNull(company, "timezone") : null) ?? fallbackZone,
      company: this.companyRef(companyId),
      contactDetails: [...own, ...shared],
      enrollments,
      unenrolledReason: this.personUnenrolledReason(id, companyId),
      colleagues: this.peopleAt(companyId).filter((c) => c.id !== id),
    };
  }

  company(id: string): CompanyRecord | null {
    const row = this.companyRow(id);
    if (!row) return null;
    const enrollments = this.enrollments({ kind: "company", companyId: id });
    const people = this.peopleAt(id);
    const fallbackZone = enrollments.map((e) => this.campaign(e.campaign.id)?.defaultTimezone).find(Boolean) ?? null;
    return {
      kind: "company",
      id,
      name: str(row, "name"),
      city: str(row, "city"),
      timezone: strOrNull(row, "timezone") ?? fallbackZone,
      contactDetails: this.details("company", id),
      enrollments,
      unenrolledReason: people.length > 0 ? null : this.companyUnenrolledReason(id),
      people,
    };
  }

  markContactDetailBad(detailId: string): boolean {
    return Number(this.db.prepare("UPDATE contact_details SET bad = 1 WHERE id = ?").run(detailId).changes) > 0;
  }

  close(): void {
    this.db.close();
  }

  private directory(campaignId: string): Directory {
    const detailsByOwner = new Map<string, KnownDetail[]>();
    for (const row of this.db.prepare("SELECT * FROM contact_details").all()) {
      const key = `${str(row, "owner_kind")}:${str(row, "owner_id")}`;
      const list = detailsByOwner.get(key) ?? [];
      list.push({
        id: str(row, "id"),
        channel: channelOf(row),
        phoneKind: phoneKindOf(row),
        key: str(row, "key"),
        bad: num(row, "bad") === 1,
      });
      detailsByOwner.set(key, list);
    }
    const sourceBusinessIds = groupBy(
      this.db.prepare("SELECT company_id, source_business_id FROM company_source_ids").all(),
      "company_id",
      "source_business_id",
    );
    const sourcePersonIds = groupBy(
      this.db.prepare("SELECT person_id, source_person_id FROM person_source_ids").all(),
      "person_id",
      "source_person_id",
    );

    return {
      companies: this.db
        .prepare("SELECT * FROM companies")
        .all()
        .map((row) => ({
          id: str(row, "id"),
          placeId: strOrNull(row, "place_id"),
          sourceBusinessIds: sourceBusinessIds.get(str(row, "id")) ?? [],
          fields: {
            name: str(row, "name"),
            category: str(row, "category"),
            website: str(row, "website"),
            domain: str(row, "domain"),
            street: str(row, "street"),
            neighborhood: str(row, "neighborhood"),
            city: str(row, "city"),
            stateProvince: str(row, "state_province"),
            postalCode: str(row, "postal_code"),
            country: str(row, "country"),
            timezone: strOrNull(row, "timezone"),
          },
          details: detailsByOwner.get(`company:${str(row, "id")}`) ?? [],
        })),
      people: this.db
        .prepare("SELECT * FROM people")
        .all()
        .map((row) => ({
          id: str(row, "id"),
          companyId: str(row, "company_id"),
          sourcePersonIds: sourcePersonIds.get(str(row, "id")) ?? [],
          fields: {
            fullName: str(row, "full_name"),
            firstName: str(row, "first_name"),
            lastName: str(row, "last_name"),
            title: str(row, "title"),
            roleTier: str(row, "role_tier"),
            timezone: strOrNull(row, "timezone"),
            linkedinUrl: str(row, "linkedin_url"),
          },
          details: detailsByOwner.get(`person:${str(row, "id")}`) ?? [],
        })),
      enrollments: this.db
        .prepare("SELECT id, lead_kind, person_id, company_id FROM enrollments WHERE campaign_id = ?")
        .all(campaignId)
        .map((row) => ({
          id: str(row, "id"),
          lead:
            str(row, "lead_kind") === "person"
              ? { kind: "person", personId: str(row, "person_id") }
              : { kind: "company", companyId: str(row, "company_id") },
        })),
    };
  }

  private apply(plan: ImportPlan, meta: { campaignId: string; importId: string; importedAt: string }): void {
    const at = meta.importedAt;
    for (const c of plan.companies) {
      const f = c.fields;
      const values = [
        c.placeId,
        f.name,
        foldText(f.name),
        f.category,
        f.website,
        f.domain,
        f.street,
        f.neighborhood,
        f.city,
        f.stateProvince,
        f.postalCode,
        f.country,
        f.timezone,
        JSON.stringify(c.source),
      ];
      if (c.isNew) {
        this.run(
          `INSERT INTO companies (place_id, name, search_name, category, website, domain, street, neighborhood, city,
            state_province, postal_code, country, timezone, source_row, id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [...values, c.id, at, at],
        );
      } else {
        this.run(
          `UPDATE companies SET place_id = ?, name = ?, search_name = ?, category = ?, website = ?, domain = ?, street = ?,
            neighborhood = ?, city = ?, state_province = ?, postal_code = ?, country = ?, timezone = ?, source_row = ?,
            updated_at = ? WHERE id = ?`,
          [...values, at, c.id],
        );
      }
      for (const sourceId of c.newSourceBusinessIds) {
        this.run("INSERT OR IGNORE INTO company_source_ids (source_business_id, company_id) VALUES (?, ?)", [
          sourceId,
          c.id,
        ]);
      }
    }

    for (const p of plan.people) {
      const f = p.fields;
      const name = personDisplayName(f);
      const values = [
        p.companyId,
        f.fullName,
        f.firstName,
        f.lastName,
        name,
        foldText(name),
        f.title,
        f.roleTier,
        f.timezone,
        f.linkedinUrl,
        JSON.stringify(p.source),
      ];
      if (p.isNew) {
        this.run(
          `INSERT INTO people (company_id, full_name, first_name, last_name, display_name, search_name, title, role_tier,
            timezone, linkedin_url, source_row, id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [...values, p.id, at, at],
        );
      } else {
        this.run(
          `UPDATE people SET company_id = ?, full_name = ?, first_name = ?, last_name = ?, display_name = ?, search_name = ?,
            title = ?, role_tier = ?, timezone = ?, linkedin_url = ?, source_row = ?, updated_at = ? WHERE id = ?`,
          [...values, at, p.id],
        );
      }
      for (const sourceId of p.newSourcePersonIds) {
        this.run("INSERT OR IGNORE INTO person_source_ids (person_id, source_person_id) VALUES (?, ?)", [p.id, sourceId]);
      }
    }

    for (const d of plan.details) {
      const ownerId = d.owner.kind === "person" ? d.owner.personId : d.owner.companyId;
      const searchDigits = [digitsOf(d.value), d.original ? digitsOf(d.original) : ""].filter(Boolean).join(" ");
      this.run(
        `INSERT INTO contact_details (id, owner_kind, owner_id, channel, phone_kind, value, original, key, search_digits, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.id, d.owner.kind, ownerId, d.channel, d.phoneKind, d.value, d.original, d.key, d.channel === "phone" ? searchDigits : "", d.addedAt],
      );
    }

    this.run("INSERT INTO imports (id, campaign_id, imported_at, summary) VALUES (?, ?, ?, ?)", [
      meta.importId,
      meta.campaignId,
      meta.importedAt,
      JSON.stringify(plan.summary),
    ]);

    for (const e of plan.enrollments) {
      const companyId = e.lead.kind === "company" ? e.lead.companyId : this.companyIdOfPerson(e.lead.personId);
      this.run(
        `INSERT INTO enrollments (id, campaign_id, lead_kind, person_id, company_id, status, enrolled_at, import_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          e.id,
          meta.campaignId,
          e.lead.kind,
          e.lead.kind === "person" ? e.lead.personId : null,
          companyId,
          e.status,
          e.enrolledAt,
          meta.importId,
        ],
      );
    }
  }

  private companyIdOfPerson(personId: string): string {
    const row = this.personRow(personId);
    if (!row) throw new Error(`person ${personId} is not stored`);
    return str(row, "company_id");
  }

  private personRow(id: string): Row | undefined {
    return this.db.prepare("SELECT * FROM people WHERE id = ?").get(id);
  }

  private companyRow(id: string): Row | undefined {
    return this.db.prepare("SELECT * FROM companies WHERE id = ?").get(id);
  }

  private companyRef(id: string): CompanyRef {
    const row = this.companyRow(id);
    if (!row) throw new Error(`company ${id} is not stored`);
    return { id, name: str(row, "name"), city: str(row, "city") };
  }

  private enrollments(lead: LeadRef): EnrollmentView[] {
    const filter =
      lead.kind === "person"
        ? { sql: "e.lead_kind = 'person' AND e.person_id = ?", value: lead.personId }
        : { sql: "e.lead_kind = 'company' AND e.company_id = ?", value: lead.companyId };
    return this.db
      .prepare(
        `SELECT e.id, e.status, e.enrolled_at, c.id AS campaign_id, c.name AS campaign_name
         FROM enrollments e JOIN campaigns c ON c.id = e.campaign_id
         WHERE ${filter.sql} ORDER BY e.enrolled_at, c.name`,
      )
      .all(filter.value)
      .map((row) => {
        const status = row["status"];
        if (!isOutreachStatus(status)) throw new Error(`enrollment ${str(row, "id")} has unknown status`);
        return {
          id: str(row, "id"),
          campaign: { id: str(row, "campaign_id"), name: str(row, "campaign_name") },
          status,
          enrolledAt: str(row, "enrolled_at"),
        };
      });
  }

  private details(ownerKind: "person" | "company", ownerId: string): ContactDetailView[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM contact_details WHERE owner_kind = ? AND owner_id = ?
         ORDER BY channel = 'phone', CASE phone_kind WHEN 'direct' THEN 0 WHEN 'mobile' THEN 1 ELSE 2 END, added_at, rowid`,
      )
      .all(ownerKind, ownerId)
      .map((row) => ({
        id: str(row, "id"),
        channel: channelOf(row),
        phoneKind: phoneKindOf(row),
        value: str(row, "value"),
        bad: num(row, "bad") === 1,
        addedAt: str(row, "added_at"),
      }));
    return rows.map(({ addedAt, ...detail }) => ({
      ...detail,
      owner: ownerKind,
      newer: isNewerDetail({ channel: detail.channel, addedAt }, rows),
    }));
  }

  private peopleAt(companyId: string): ColleagueView[] {
    return this.db
      .prepare("SELECT id, display_name, title FROM people WHERE company_id = ? ORDER BY display_name COLLATE NOCASE")
      .all(companyId)
      .map((row) => ({
        id: str(row, "id"),
        name: str(row, "display_name"),
        title: str(row, "title"),
        enrollments: this.enrollments({ kind: "person", personId: str(row, "id") }),
        unenrolledReason: this.personUnenrolledReason(str(row, "id"), companyId),
      }));
  }

  private personUnenrolledReason(personId: string, companyId: string): UnenrolledReason {
    if (this.enrollments({ kind: "person", personId }).length > 0) return null;
    const reach = decisionMakerReach(this.details("person", personId), this.details("company", companyId));
    return hasUsableChannel(reach) ? null : "no_usable_channel";
  }

  private companyUnenrolledReason(companyId: string): UnenrolledReason {
    if (this.enrollments({ kind: "company", companyId }).length > 0) return null;
    return hasUsableChannel(companyLeadReach(this.details("company", companyId))) ? null : "no_usable_channel";
  }

  private run(sql: string, values: readonly SQLInputValue[]): void {
    this.db.prepare(sql).run(...values);
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function toCampaign(row: Row): Campaign {
  return {
    id: str(row, "id"),
    name: str(row, "name"),
    defaultTimezone: strOrNull(row, "default_timezone"),
    createdAt: str(row, "created_at"),
  };
}

function str(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new Error(`column ${column} is not text`);
  return value;
}

function strOrNull(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`column ${column} is not text`);
  return value;
}

function num(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`column ${column} is not a number`);
}

function channelOf(row: Row): Channel {
  const value = str(row, "channel");
  if (value === "email" || value === "phone") return value;
  throw new Error(`unknown channel ${value}`);
}

function phoneKindOf(row: Row): PhoneKind | null {
  const value = strOrNull(row, "phone_kind");
  if (value === null || value === "direct" || value === "mobile" || value === "main_line") return value;
  throw new Error(`unknown phone kind ${value}`);
}

function groupBy(rows: readonly Row[], keyColumn: string, valueColumn: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const key = str(row, keyColumn);
    groups.set(key, [...(groups.get(key) ?? []), str(row, valueColumn)]);
  }
  return groups;
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}
