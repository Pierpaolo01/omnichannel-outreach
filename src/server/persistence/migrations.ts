import type { DatabaseSync } from "node:sqlite";
import { OUTREACH_STATUSES } from "../../domain/outreach-status.ts";

/**
 * Versioned schema migrations. Append a new entry for every change; never edit an applied one.
 * Each runs in its own transaction and is recorded in schema_migrations.
 *
 * Versions are exactly 1 to N, in order, with no gap (`migrations.test.ts` checks it). `migrate`
 * applies what is above a database's highest recorded version, so a gap would never be filled on a
 * database that moved past it; it therefore refuses a database whose recorded versions are not a
 * prefix of this list. A branch takes the next number at merge time: if another branch merged a
 * migration first, renumber yours when merging the integration branch tip (see
 * docs/agents/delivery-workflow.md, "Standing checks").
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

      -- Every subject the engine runs: an enrollment, or (ticket 21) a test run. Progress tables
      -- reference this, not enrollments (ADR 0003 1.2).
      CREATE TABLE subjects (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('enrollment', 'test_run'))
      );
      INSERT INTO subjects (id, kind) SELECT id, 'enrollment' FROM enrollments;

      CREATE TABLE freezes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_id TEXT NOT NULL REFERENCES subjects(id),
        from_wall INTEGER NOT NULL,
        to_wall INTEGER
      );
      CREATE INDEX freezes_by_subject ON freezes(subject_id);
      CREATE UNIQUE INDEX one_open_freeze ON freezes(subject_id) WHERE to_wall IS NULL;
      INSERT INTO freezes (subject_id, from_wall, to_wall) SELECT id, frozen_since, NULL FROM enrollments;

      CREATE TABLE track_progress (
        subject_id TEXT NOT NULL REFERENCES subjects(id),
        track_id TEXT NOT NULL,
        start_at INTEGER, start_basis_at INTEGER, start_basis_wall INTEGER, start_zone TEXT,
        started_at INTEGER,
        destination_detail_id TEXT REFERENCES contact_details(id),
        next_step_id TEXT, basis_at INTEGER, basis_wall INTEGER, due_at INTEGER, due_wall INTEGER, due_zone TEXT,
        finished_at INTEGER, finished_wall INTEGER, finish_reason TEXT,
        PRIMARY KEY (subject_id, track_id)
      );

      CREATE TABLE step_results (
        subject_id TEXT NOT NULL REFERENCES subjects(id),
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
        -- Null: the default gap of ADR 0003 4.1, from the windows the account serves.
        gap_ms INTEGER CHECK (gap_ms IS NULL OR gap_ms > 0),
        k INTEGER NOT NULL CHECK (k > 0),
        next_slot_at INTEGER NOT NULL DEFAULT 0,
        healthy INTEGER NOT NULL DEFAULT 1,
        wait_until INTEGER,
        wait_reason TEXT,
        backoff_ms INTEGER NOT NULL DEFAULT 0,
        reset_zone TEXT NOT NULL DEFAULT 'UTC'
      );

      -- One row per piece of provider work, by idempotency key (ADR 0003 1.3, PR 37 review
      -- round 3): everything true of the work rather than of one attempt. Attempts point at it.
      CREATE TABLE provider_work (
        key TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL REFERENCES subjects(id),
        track_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES sender_accounts(id),
        destination TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0,
        first_handed_wall INTEGER,
        provider_ref TEXT,
        settled TEXT CHECK (settled IN ('sent', 'not_sent', 'withdrawn', 'rejected', 'never_called', 'user_sent', 'user_not_sent')),
        sent_wall INTEGER,
        sent_day TEXT,
        next_lookup_wall INTEGER,
        lookup_answer TEXT,
        queued_lookups INTEGER NOT NULL DEFAULT 0,
        unresolved_since INTEGER
      );
      CREATE INDEX provider_work_by_subject ON provider_work(subject_id);
      CREATE INDEX provider_work_by_ref ON provider_work(provider_ref);
      CREATE INDEX provider_work_by_account ON provider_work(account_id, settled);

      CREATE TABLE attempts (
        id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL REFERENCES subjects(id),
        track_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES sender_accounts(id),
        destination_detail_id TEXT NOT NULL REFERENCES contact_details(id),
        destination TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('claimed', 'handed', 'accepted', 'sent', 'rejected', 'withdrawn')),
        copy TEXT,
        threading TEXT NOT NULL CHECK (threading IN ('new_subject', 'continue_thread')),
        thread_ref TEXT,
        retryable INTEGER NOT NULL,
        not_sent_final INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL REFERENCES provider_work(key),
        calls INTEGER NOT NULL,
        claimed_wall INTEGER NOT NULL,
        handed_at INTEGER, handed_wall INTEGER, last_call_wall INTEGER,
        presend_checked_wall INTEGER, presend_found_reply INTEGER NOT NULL DEFAULT 0,
        ended_by TEXT,
        withdraw_requested INTEGER NOT NULL DEFAULT 0,
        withdraw_called INTEGER NOT NULL DEFAULT 0,
        awaiting_answer INTEGER NOT NULL DEFAULT 0,
        retry TEXT NOT NULL DEFAULT 'none',
        reject_reason TEXT
      );
      CREATE UNIQUE INDEX one_live_attempt_per_step ON attempts(subject_id, step_id) WHERE state IN ('claimed', 'handed', 'accepted');
      CREATE UNIQUE INDEX one_sent_attempt_per_step ON attempts(subject_id, step_id) WHERE state = 'sent';
      CREATE INDEX attempts_by_subject ON attempts(subject_id);
      CREATE INDEX attempts_by_account_state ON attempts(account_id, state);
      CREATE INDEX attempts_by_key ON attempts(idempotency_key);

      -- ADR 0002's ledger, read off the provider work so it cannot drift from it: a send counts on
      -- the reset day of its send; unsettled work not yet sent counts as reserved (ADR 0003 4.2).
      CREATE VIEW capacity_ledger AS
        SELECT account_id, sent_day AS reset_day, key AS work, 'sent' AS kind FROM provider_work WHERE sent_wall IS NOT NULL
        UNION ALL
        SELECT account_id, NULL, key, 'reserved' FROM provider_work WHERE settled IS NULL AND sent_wall IS NULL;

      -- One reply may belong to several subjects: one outside every thread is reconciled to every
      -- lead the inbox wrote to at that address (ADR 0003 2.4 as amended).
      CREATE TABLE replies (
        provider_ref TEXT NOT NULL,
        subject_id TEXT NOT NULL REFERENCES subjects(id),
        channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
        at_wall INTEGER NOT NULL,
        PRIMARY KEY (subject_id, provider_ref)
      );
      CREATE INDEX replies_by_subject ON replies(subject_id);

      -- Every reply event the provider reported, by its event id, for good (ADR 0003 2.4, PR 37
      -- review round 3): an observation replay is a no-op. A reply on a thread the app does not
      -- know yet is pending: sends from the inbox to the address pause until its reference attaches
      -- to work, or until it has waited one settling period of running time, then it falls back to
      -- inbox and address. One that matches nothing stays unmatched by its reference, without
      -- pausing, and resolves if that reference later attaches.
      CREATE TABLE reply_events (
        event_id TEXT PRIMARY KEY,
        provider_ref TEXT,
        inbox TEXT NOT NULL,
        address TEXT NOT NULL,
        at_wall INTEGER NOT NULL,
        received_wall INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'resolved', 'unmatched')),
        waited_ms INTEGER NOT NULL DEFAULT 0,
        last_counted_wall INTEGER NOT NULL
      );
      CREATE INDEX reply_events_open ON reply_events(state) WHERE state <> 'resolved';

      CREATE TABLE provider_anomalies (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id TEXT,
        what TEXT NOT NULL,
        at_wall INTEGER NOT NULL
      );

      CREATE TABLE engine_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `,
  },
  {
    version: 7,
    name: "the Instantly adapter: dispatch campaigns, dispatched leads and their threads (ADR 0002)",
    // The adapter's own records, so a restart keeps every mapping between the engine's provider
    // work and Instantly's campaigns, leads, emails and threads. No message body is stored.
    sql: `
      CREATE TABLE instantly_dispatch_campaigns (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        instantly_id TEXT,
        timestamp_updated TEXT
      );
      CREATE TABLE instantly_dispatched (
        work_key TEXT PRIMARY KEY,
        ref TEXT NOT NULL UNIQUE,
        lead_id TEXT NOT NULL,
        dispatch_campaign TEXT NOT NULL REFERENCES instantly_dispatch_campaigns(key),
        instantly_campaign_id TEXT NOT NULL,
        inbox TEXT NOT NULL,
        destination TEXT NOT NULL,
        added_wall INTEGER NOT NULL,
        sent_email_id TEXT,
        thread_id TEXT,
        sent_wall INTEGER,
        lead_status INTEGER,
        verification_status INTEGER
      );
      CREATE INDEX instantly_dispatched_by_lead ON instantly_dispatched(lead_id);
      CREATE INDEX instantly_dispatched_by_thread ON instantly_dispatched(thread_id);
      CREATE INDEX instantly_dispatched_by_address ON instantly_dispatched(inbox, destination);
      CREATE TABLE instantly_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `,
  },
  {
    version: 8,
    name: "the Instantly adapter: in-doubt adds, recorded before the request (ADR 0002)",
    // A lead add whose answer may be lost still means the app may have written to that address
    // from that inbox, so a reply from it is held, not dropped.
    sql: `
      CREATE TABLE instantly_intents (
        work_key TEXT PRIMARY KEY,
        inbox TEXT NOT NULL,
        destination TEXT NOT NULL,
        intended_wall INTEGER NOT NULL
      );
      CREATE INDEX instantly_intents_by_address ON instantly_intents(inbox, destination);
    `,
  },
  {
    // Ticket 13a. It merges before pull request 41 (ticket 12c), which then takes the next numbers.
    version: 9,
    name: "SMS tracks: the fixed SMS sender, SMS conversation bindings, the stopping reply and sender account problems (ADR 0003 1.3, 4.5; ticket 13)",
    // A binding names the subject that owns the conversation between a sender number and a mobile
    // (E.164). One unreleased binding per pair; an enrollment's is never released or transferred,
    // and rows are never deleted, so the table is its own history.
    sql: `
      ALTER TABLE enrollments ADD COLUMN sms_sender TEXT;
      -- The reply that stopped the lead, stored when it stopped and never recomputed (verifier B1).
      ALTER TABLE enrollments ADD COLUMN stop_reply_channel TEXT CHECK (stop_reply_channel IN ('email', 'sms'));
      ALTER TABLE enrollments ADD COLUMN stop_reply_at INTEGER;
      -- A lead that replied before this migration: its stopping reply is the one the engine recorded
      -- first, since replies are inserted as they are observed and any reply ends the lead (the same
      -- reply the engine now stores for a new stop). Leads that did not reply keep none.
      UPDATE enrollments SET
        stop_reply_channel = (SELECT r.channel FROM replies r WHERE r.subject_id = enrollments.id ORDER BY r.rowid LIMIT 1),
        stop_reply_at = (SELECT r.at_wall FROM replies r WHERE r.subject_id = enrollments.id ORDER BY r.rowid LIMIT 1)
      WHERE ended = 'replied';
      -- Why a sender account cannot send, as its provider or the engine reported it; null while it can,
      -- and for an account stored before this migration until the next account sync rewrites it.
      ALTER TABLE sender_accounts ADD COLUMN problem TEXT;
      CREATE TABLE sms_bindings (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_number TEXT NOT NULL,
        recipient_key TEXT NOT NULL,
        owner_subject TEXT NOT NULL REFERENCES subjects(id),
        created_at INTEGER NOT NULL,
        released_at INTEGER
      );
      CREATE UNIQUE INDEX one_unreleased_sms_binding ON sms_bindings(sender_number, recipient_key) WHERE released_at IS NULL;
      CREATE INDEX sms_bindings_by_recipient ON sms_bindings(recipient_key);
    `,
  },
  {
    // Numbered after the Instantly adapter's 7 and 8 and ticket 13a's 9.
    version: 10,
    name: "bounce events: each hard bounce the provider reported, kept by its event id for the timeline (ticket 12c)",
    sql: `
      CREATE TABLE bounce_events (
        event_id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        work_key TEXT NOT NULL,
        track_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        destination TEXT NOT NULL,
        at_wall INTEGER NOT NULL,
        received_wall INTEGER NOT NULL
      );
      CREATE INDEX bounce_events_by_subject ON bounce_events (subject_id, at_wall);
    `,
  },
  {
    version: 11,
    name: "the editing session and number that wrote the definition (ticket 12c, ADR 0003 1.1.1)",
    sql: `
      ALTER TABLE campaigns ADD COLUMN definition_session TEXT;
      ALTER TABLE campaigns ADD COLUMN definition_seq INTEGER;
    `,
  },
  {
    // Ticket 14a, numbered after pull request 41's 10 and 11.
    version: 12,
    name: "call tasks, the outcomes logged on them, and person and company notes (ADR 0003 1.3; ticket 14)",
    // One task per call step, never a second; it closes once, when its track finishes. Outcomes
    // are kept for good. A note belongs to a person, or to a company and shows for everyone there.
    sql: `
      CREATE TABLE call_tasks (
        id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL REFERENCES subjects(id),
        track_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        due_at INTEGER NOT NULL, due_wall INTEGER NOT NULL, due_zone TEXT NOT NULL,
        skip_deadline INTEGER NOT NULL,
        list_day INTEGER NOT NULL,
        placed_wall INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('call', 'callback')),
        callback_at INTEGER,
        open INTEGER NOT NULL CHECK (open IN (0, 1)),
        closed_wall INTEGER,
        skipped_wall INTEGER,
        CHECK ((open = 1) = (closed_wall IS NULL))
      );
      CREATE UNIQUE INDEX one_task_per_call_step ON call_tasks(subject_id, step_id);
      CREATE INDEX call_tasks_open ON call_tasks(open, placed_wall);
      CREATE TABLE call_attempts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES call_tasks(id),
        subject_id TEXT NOT NULL REFERENCES subjects(id),
        -- The client's key for the action that logged it: one action is logged once, whatever retries it.
        request_id TEXT NOT NULL UNIQUE,
        -- Which outcomes a release accepts is the domain's and the HTTP interface's to say, not the schema's,
        -- so tickets 15 and 16 add callbacks and declines without rebuilding this table (council on 7902093).
        outcome TEXT NOT NULL,
        number_detail_id TEXT REFERENCES contact_details(id),
        note TEXT NOT NULL,
        at INTEGER NOT NULL,
        at_wall INTEGER NOT NULL
      );
      CREATE INDEX call_attempts_by_subject ON call_attempts(subject_id, at_wall);
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        owner_kind TEXT NOT NULL CHECK (owner_kind IN ('person', 'company')),
        owner_id TEXT NOT NULL,
        body TEXT NOT NULL,
        at_wall INTEGER NOT NULL,
        subject_id TEXT REFERENCES subjects(id),
        call_attempt_id TEXT REFERENCES call_attempts(id)
      );
      CREATE INDEX notes_by_owner ON notes(owner_kind, owner_id, at_wall);
    `,
  },
  {
    // Ticket 15a, numbered after 14a's 12.
    version: 13,
    name: "redials and callbacks on the call records (ADR 0003 1.3, 2.4; ticket 15)",
    // A call record keeps whether the user asked for a redial, and the time a prospect asked to be
    // called back. Earlier records had neither: no redial, no callback time.
    sql: `
      ALTER TABLE call_attempts ADD COLUMN redial INTEGER NOT NULL DEFAULT 0 CHECK (redial IN (0, 1));
      ALTER TABLE call_attempts ADD COLUMN callback_at INTEGER;
      CREATE INDEX call_tasks_open_callbacks ON call_tasks(open, kind, subject_id);
      -- The instant through which the skip limit has been judged; a task placed before it starts at its placement.
      ALTER TABLE call_tasks ADD COLUMN reckoned_through INTEGER;
      UPDATE call_tasks SET reckoned_through = placed_wall;
    `,
  },
];

export function migrate(db: DatabaseSync, appliedAt: () => string): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => Number(r["version"]));
  const known = new Set(MIGRATIONS.map((m) => m.version));
  const unknown = versions.filter((v) => !known.has(v));
  if (unknown.length > 0 || versions.some((v, i) => v !== i + 1)) {
    throw new Error(
      `This database's schema versions are ${versions.join(", ")}, which is not a prefix of this code's migrations (1 to ${MIGRATIONS.length})` +
        (unknown.length > 0 ? `: it records a version this code does not know (${unknown.join(", ")})` : ": a version is missing") +
        ". It was written by other code; it is not migrated.",
    );
  }
  const current = versions.length;

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
