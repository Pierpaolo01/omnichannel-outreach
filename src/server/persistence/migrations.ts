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
  {
    version: 5,
    name: "live contact details: the one definition every reader uses",
    // A view has no rowid, so it carries the row's insertion order as row_order.
    sql: `
      CREATE VIEW live_contact_details AS SELECT *, rowid AS row_order FROM contact_details WHERE merged_into IS NULL;
    `,
  },
  {
    version: 6,
    name: "the sequence engine: definitions, lead clocks, track progress, step results, attempts and sender accounts (ADR 0003)",
    // Instants are integer milliseconds. An existing enrollment starts frozen at its enrollment
    // instant, so its lead time is 0 until its campaign launches (ADR 0003 3.2).
    sql: `
      ALTER TABLE campaigns ADD COLUMN launched_at INTEGER;
      ALTER TABLE campaigns ADD COLUMN paused_since INTEGER;
      ALTER TABLE campaigns ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE campaigns ADD COLUMN definition TEXT;
      ALTER TABLE campaigns ADD COLUMN definition_version INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE campaigns ADD COLUMN definition_edited_at TEXT;

      ALTER TABLE enrollments ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE enrollments ADD COLUMN ended TEXT;
      ALTER TABLE enrollments ADD COLUMN ended_at INTEGER;
      ALTER TABLE enrollments ADD COLUMN ended_wall INTEGER;
      ALTER TABLE enrollments ADD COLUMN lead_paused INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE enrollments ADD COLUMN branch TEXT NOT NULL DEFAULT 'main' CHECK (branch IN ('main', 'win_back'));
      ALTER TABLE enrollments ADD COLUMN branch_entered_at INTEGER;
      ALTER TABLE enrollments ADD COLUMN touched INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE enrollments ADD COLUMN no_more_calls INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE enrollments ADD COLUMN frozen_since INTEGER;
      ALTER TABLE enrollments ADD COLUMN frozen_total INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE enrollments ADD COLUMN email_sender TEXT;
      UPDATE enrollments SET
        frozen_since = CAST(ROUND((julianday(enrolled_at) - 2440587.5) * 86400000) AS INTEGER),
        frozen_total = CAST(ROUND((julianday(enrolled_at) - 2440587.5) * 86400000) AS INTEGER);
      CREATE INDEX enrollments_by_campaign_status ON enrollments(campaign_id, status);

      CREATE TABLE freezes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_id TEXT NOT NULL REFERENCES enrollments(id),
        from_wall INTEGER NOT NULL,
        to_wall INTEGER
      );
      CREATE INDEX freezes_by_subject ON freezes(subject_id);
      CREATE UNIQUE INDEX one_open_freeze ON freezes(subject_id) WHERE to_wall IS NULL;
      INSERT INTO freezes (subject_id, from_wall, to_wall) SELECT id, frozen_since, NULL FROM enrollments;

      CREATE TABLE track_progress (
        subject_id TEXT NOT NULL REFERENCES enrollments(id),
        track_id TEXT NOT NULL,
        start_at INTEGER, start_basis_at INTEGER, start_basis_wall INTEGER, start_zone TEXT,
        started_at INTEGER,
        destination_detail_id TEXT REFERENCES contact_details(id),
        next_step_id TEXT, basis_at INTEGER, basis_wall INTEGER, due_at INTEGER, due_wall INTEGER, due_zone TEXT,
        finished_at INTEGER, finished_wall INTEGER, finish_reason TEXT,
        PRIMARY KEY (subject_id, track_id)
      );

      CREATE TABLE step_results (
        subject_id TEXT NOT NULL REFERENCES enrollments(id),
        step_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        result TEXT NOT NULL CHECK (result IN ('sent', 'skipped', 'failed')),
        reason TEXT,
        at INTEGER NOT NULL,
        at_wall INTEGER NOT NULL,
        attempt_id TEXT,
        PRIMARY KEY (subject_id, step_id)
      );

      CREATE TABLE sender_accounts (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
        label TEXT NOT NULL,
        capacity INTEGER NOT NULL CHECK (capacity > 0),
        gap_ms INTEGER NOT NULL CHECK (gap_ms > 0),
        k INTEGER NOT NULL CHECK (k > 0),
        next_slot_at INTEGER NOT NULL DEFAULT 0,
        healthy INTEGER NOT NULL DEFAULT 1,
        wait_until INTEGER,
        wait_reason TEXT,
        backoff_ms INTEGER NOT NULL DEFAULT 0,
        reset_zone TEXT NOT NULL DEFAULT 'UTC'
      );

      CREATE TABLE attempts (
        id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL REFERENCES enrollments(id),
        track_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES sender_accounts(id),
        destination_detail_id TEXT NOT NULL REFERENCES contact_details(id),
        destination TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('claimed', 'handed', 'accepted', 'sent', 'rejected', 'withdrawn')),
        copy TEXT,
        thread_ref TEXT,
        provider_ref TEXT,
        retryable INTEGER NOT NULL,
        not_sent_final INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        calls INTEGER NOT NULL,
        claimed_wall INTEGER NOT NULL,
        handed_at INTEGER, handed_wall INTEGER, last_call_wall INTEGER,
        presend_checked_wall INTEGER, presend_found_reply INTEGER NOT NULL DEFAULT 0,
        lookup_answer TEXT, queued_lookups INTEGER NOT NULL DEFAULT 0, next_lookup_wall INTEGER,
        unresolved_since INTEGER,
        ended_by TEXT,
        withdraw_requested INTEGER NOT NULL DEFAULT 0,
        withdraw_called INTEGER NOT NULL DEFAULT 0,
        awaiting_answer INTEGER NOT NULL DEFAULT 0,
        retry TEXT NOT NULL DEFAULT 'none',
        reject_reason TEXT,
        sent_wall INTEGER,
        sent_day TEXT,
        user_marked_not_sent INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX one_live_attempt_per_step ON attempts(subject_id, step_id) WHERE state IN ('claimed', 'handed', 'accepted');
      CREATE UNIQUE INDEX one_sent_attempt_per_step ON attempts(subject_id, step_id) WHERE state = 'sent';
      CREATE INDEX attempts_by_subject ON attempts(subject_id);
      CREATE INDEX attempts_by_account_state ON attempts(account_id, state);
      CREATE INDEX attempts_by_provider_ref ON attempts(provider_ref);

      -- ADR 0002's ledger, read off the attempts so it cannot drift from them: a live attempt holds
      -- a reservation, a sent one counts on the reset day of its send, and a rejected or withdrawn
      -- one has released its place.
      CREATE VIEW capacity_ledger AS
        SELECT account_id, CASE WHEN state = 'sent' THEN sent_day END AS reset_day, id AS attempt_id,
          CASE WHEN state = 'sent' THEN 'sent' ELSE 'reserved' END AS kind
        FROM attempts WHERE state IN ('claimed', 'handed', 'accepted', 'sent');

      CREATE TABLE replies (
        provider_ref TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL REFERENCES enrollments(id),
        channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
        at_wall INTEGER NOT NULL
      );
      CREATE INDEX replies_by_subject ON replies(subject_id);

      CREATE TABLE provider_anomalies (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id TEXT,
        what TEXT NOT NULL,
        at_wall INTEGER NOT NULL
      );

      CREATE TABLE engine_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
