import type { DatabaseSync } from "node:sqlite";
import { OUTREACH_STATUSES } from "../../domain/outreach-status.ts";

/**
 * Versioned schema migrations. Append a new entry for every change; never edit an applied one.
 * Each runs in its own transaction and is recorded in schema_migrations.
 */
interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const statusList = OUTREACH_STATUSES.map((s) => `'${s}'`).join(", ");

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "campaigns, companies, people, contact details, enrollments and imports",
    sql: `
      CREATE TABLE campaigns (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        default_timezone TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE companies (
        id TEXT PRIMARY KEY,
        place_id TEXT UNIQUE,
        name TEXT NOT NULL,
        search_name TEXT NOT NULL,
        category TEXT NOT NULL,
        website TEXT NOT NULL,
        domain TEXT NOT NULL,
        street TEXT NOT NULL,
        neighborhood TEXT NOT NULL,
        city TEXT NOT NULL,
        state_province TEXT NOT NULL,
        postal_code TEXT NOT NULL,
        country TEXT NOT NULL,
        timezone TEXT,
        source_row TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE company_source_ids (
        source_business_id TEXT NOT NULL,
        company_id TEXT NOT NULL REFERENCES companies(id),
        PRIMARY KEY (source_business_id, company_id)
      );

      CREATE TABLE people (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES companies(id),
        full_name TEXT NOT NULL,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        search_name TEXT NOT NULL,
        title TEXT NOT NULL,
        role_tier TEXT NOT NULL,
        timezone TEXT,
        linkedin_url TEXT NOT NULL,
        source_row TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX people_by_company ON people(company_id);

      CREATE TABLE person_source_ids (
        person_id TEXT NOT NULL REFERENCES people(id),
        source_person_id TEXT NOT NULL,
        PRIMARY KEY (person_id, source_person_id)
      );

      CREATE TABLE contact_details (
        id TEXT PRIMARY KEY,
        owner_kind TEXT NOT NULL CHECK (owner_kind IN ('person', 'company')),
        owner_id TEXT NOT NULL,
        channel TEXT NOT NULL CHECK (channel IN ('email', 'phone')),
        phone_kind TEXT CHECK (phone_kind IN ('direct', 'mobile', 'main_line')),
        value TEXT NOT NULL,
        key TEXT NOT NULL,
        search_digits TEXT NOT NULL,
        bad INTEGER NOT NULL DEFAULT 0 CHECK (bad IN (0, 1)),
        added_at TEXT NOT NULL,
        UNIQUE (owner_kind, owner_id, channel, key)
      );
      CREATE INDEX contact_details_by_owner ON contact_details(owner_kind, owner_id);

      CREATE TABLE imports (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id),
        imported_at TEXT NOT NULL,
        people_file_name TEXT,
        businesses_file_name TEXT,
        summary TEXT NOT NULL
      );

      CREATE TABLE enrollments (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id),
        lead_kind TEXT NOT NULL CHECK (lead_kind IN ('person', 'company')),
        person_id TEXT REFERENCES people(id),
        company_id TEXT NOT NULL REFERENCES companies(id),
        status TEXT NOT NULL CHECK (status IN (${statusList})),
        enrolled_at TEXT NOT NULL,
        import_id TEXT REFERENCES imports(id),
        CHECK ((lead_kind = 'person') = (person_id IS NOT NULL))
      );
      CREATE UNIQUE INDEX one_person_lead_per_campaign ON enrollments(campaign_id, person_id) WHERE lead_kind = 'person';
      CREATE UNIQUE INDEX one_company_lead_per_campaign ON enrollments(campaign_id, company_id) WHERE lead_kind = 'company';
    `,
  },
  {
    version: 2,
    name: "provenance: the normalised identity of every row applied to a company or person",
    sql: `
      CREATE TABLE row_identities (
        record_kind TEXT NOT NULL CHECK (record_kind IN ('company', 'person')),
        record_id TEXT NOT NULL,
        identity TEXT NOT NULL,
        PRIMARY KEY (record_kind, record_id, identity)
      );
      CREATE INDEX row_identities_by_identity ON row_identities(record_kind, identity);
    `,
  },
  {
    version: 3,
    name: "a person's copy of an address their company lists as shared is not personal",
    sql: `
      ALTER TABLE contact_details ADD COLUMN listed_shared INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 4,
    name: "a merged contact detail keeps its row and points at the detail it was merged into",
    // SQLite cannot drop a table constraint, so the table is rebuilt: one owner, channel and key
    // is unique among live details only, and an absorbed row keeps the place it was merged from.
    // Rows are copied in rowid order, which the detail lists use to break ties.
    sql: `
      CREATE TABLE contact_details_v4 (
        id TEXT PRIMARY KEY,
        owner_kind TEXT NOT NULL CHECK (owner_kind IN ('person', 'company')),
        owner_id TEXT NOT NULL,
        channel TEXT NOT NULL CHECK (channel IN ('email', 'phone')),
        phone_kind TEXT CHECK (phone_kind IN ('direct', 'mobile', 'main_line')),
        value TEXT NOT NULL,
        key TEXT NOT NULL,
        search_digits TEXT NOT NULL,
        bad INTEGER NOT NULL DEFAULT 0 CHECK (bad IN (0, 1)),
        added_at TEXT NOT NULL,
        listed_shared INTEGER NOT NULL DEFAULT 0,
        merged_into TEXT REFERENCES contact_details_v4(id) CHECK (merged_into IS NULL OR merged_into <> id)
      );
      INSERT INTO contact_details_v4 (id, owner_kind, owner_id, channel, phone_kind, value, key, search_digits, bad, added_at, listed_shared)
        SELECT id, owner_kind, owner_id, channel, phone_kind, value, key, search_digits, bad, added_at, listed_shared
        FROM contact_details ORDER BY rowid;
      DROP TABLE contact_details;
      ALTER TABLE contact_details_v4 RENAME TO contact_details;
      CREATE UNIQUE INDEX one_live_detail_per_owner_channel_key ON contact_details(owner_kind, owner_id, channel, key) WHERE merged_into IS NULL;
      CREATE INDEX contact_details_by_owner ON contact_details(owner_kind, owner_id);
      CREATE INDEX contact_details_by_merged_into ON contact_details(merged_into);
    `,
  },
];

export function migrate(db: DatabaseSync, appliedAt: () => string): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
  const current = typeof row?.["version"] === "number" ? row["version"] : 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        appliedAt(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
