import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { OUTREACH_STATUSES } from "../../domain/outreach-status.ts";
import { addChannel } from "./add-channel.ts";

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
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  /** What SQL alone cannot compute, run after `sql` in the same transaction. */
  readonly data?: (db: DatabaseSync) => void;
  /**
   * Rebuilds tables other tables reference (SQLite's documented twelve-step procedure): foreign keys are off for this
   * migration only, and `foreign_key_check` must find nothing before it commits.
   */
  readonly rebuildsTables?: boolean;
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
    version: 13,
    name: "each editing session's newest accepted save of a campaign's definition (ADR 0003 1.1.1, the generated save test's seeds 7369 and 7729)",
    // The campaign row names only the session that wrote last, so once another page saved, a late or
    // retried save of a page that had saved before was refused as a conflict, and that page said its
    // change was not saved. Each session's newest accepted number, and a hash of what it stored, are
    // kept here. The writer at the time of this migration is known from the campaign row.
    sql: `
      CREATE TABLE definition_saves (
        campaign_id TEXT NOT NULL REFERENCES campaigns(id),
        session TEXT NOT NULL,
        seq INTEGER NOT NULL,
        content_sha256 TEXT,
        PRIMARY KEY (campaign_id, session)
      );
      INSERT INTO definition_saves (campaign_id, session, seq, content_sha256)
        SELECT id, definition_session, definition_seq, NULL FROM campaigns WHERE definition_session IS NOT NULL AND definition_seq IS NOT NULL;
    `,
    // The hash of what the writer stored, as `saveDefinition` hashes a save, so a retry of its save
    // after another page replaced it is `replaced` on an upgraded database too (council on aebeb80, item 1).
    data: (db) => {
      const update = db.prepare("UPDATE definition_saves SET content_sha256 = ? WHERE campaign_id = ?");
      for (const row of db.prepare("SELECT s.campaign_id, c.definition FROM definition_saves s JOIN campaigns c ON c.id = s.campaign_id WHERE c.definition IS NOT NULL").all()) {
        update.run(createHash("sha256").update(String(row["definition"])).digest("hex"), String(row["campaign_id"]));
      }
    },
  },
  {
    // Ticket 15a, numbered after pull request 49's 13.
    version: 14,
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
  {
    // Ticket 16a.
    version: 15,
    name: "the declined path on the call records (ADR 0003 1.3, 2.4; ticket 16)",
    // A not interested call keeps the declined path it applied, the phone track's or the user's override for
    // that lead. Earlier records are of other outcomes (ticket 15 refused not interested): none.
    sql: `
      ALTER TABLE call_attempts ADD COLUMN declined_path TEXT CHECK (declined_path IN ('stop', 'continue', 'win_back'));
    `,
  },
  {
    // Ticket 17a.
    version: 16,
    name: "the hold history and the controls' request ids (ADR 0003, ticket 17a)",
    // Each campaign pause, lead pause and ending (from the lead's first ending to its restart), as an interval: the committed-call
    // count reads whether a lead was held at a day's start (P12). And each accepted control by its request id,
    // so a retry is answered with the first answer and applies nothing twice (P7). Nothing set a pause before
    // this migration; a database that holds one anyway gets an open interval from now.
    sql: `
      CREATE TABLE hold_intervals (
        id INTEGER PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('campaign', 'lead', 'ended')),
        owner_id TEXT NOT NULL,
        from_wall INTEGER NOT NULL,
        to_wall INTEGER
      );
      CREATE INDEX hold_intervals_owner ON hold_intervals(owner_id, scope);
      CREATE UNIQUE INDEX hold_intervals_one_open ON hold_intervals(owner_id, scope) WHERE to_wall IS NULL;
      INSERT INTO hold_intervals (scope, owner_id, from_wall, to_wall) SELECT 'campaign', id, paused_since, NULL FROM campaigns WHERE paused_since IS NOT NULL;
      INSERT INTO hold_intervals (scope, owner_id, from_wall, to_wall)
        SELECT 'lead', id, COALESCE(frozen_since, 0), NULL FROM enrollments WHERE lead_paused = 1;
      -- Every lead that has ended holds an open ended interval from its ending (a restart closes it).
      INSERT INTO hold_intervals (scope, owner_id, from_wall, to_wall)
        SELECT 'ended', id, COALESCE(ended_wall, 0), NULL FROM enrollments WHERE ended IS NOT NULL;
      -- Every answered request by its id, accepted or refused, with the refusal's reason or the accepted control's
      -- effect: a request id is bound to its first answer (verifier B5 on ca8baee).
      CREATE TABLE control_requests (
        request_id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        action TEXT NOT NULL,
        answer TEXT NOT NULL CHECK (answer IN ('accepted', 'refused')),
        -- The request's body as JSON: an id is bound to it too, and the same id with another body is refused.
        body TEXT NOT NULL DEFAULT '',
        reason TEXT,
        effect TEXT,
        at_wall INTEGER NOT NULL
      );
      -- A withdrawal wanted of provider work, kept on the work so it outlives an attempt a non-final "not sent" retires,
      -- and when the provider last answered it "unknown": asked again each settling period until the work's answer is
      -- final (council A on 56d599c). Work whose live attempt was already asked to withdraw keeps that intent.
      ALTER TABLE provider_work ADD COLUMN withdraw_wanted INTEGER NOT NULL DEFAULT 0 CHECK (withdraw_wanted IN (0, 1));
      ALTER TABLE provider_work ADD COLUMN withdraw_last_wall INTEGER;
      -- When the provider said it was too late to withdraw it: it went, and its send time follows (council J).
      ALTER TABLE provider_work ADD COLUMN went_wall INTEGER;
      UPDATE provider_work SET withdraw_wanted = 1 WHERE settled IS NULL AND calls > 0
        AND EXISTS (SELECT 1 FROM attempts a WHERE a.idempotency_key = provider_work.key AND a.withdraw_requested = 1);
    `,
  },
  {
    // Ticket 18.
    version: 17,
    name: "bulk actions' request ids, and enrollments by person and by company for lead search (ADR 0003, ticket 18)",
    // A bulk id is bound to its action and body (a hash of it): the same id with another body is refused whole. Each
    // per-lead control of a bulk keeps its own id (bulkId/enrollmentId) in control_requests. An add to campaign keeps its
    // whole answer here, written in the transaction that enrolls, so a retry replays it and never enrolls twice.
    // IF NOT EXISTS: the older migrations' tests rewind a database to before their version and migrate it again.
    sql: `
      CREATE TABLE IF NOT EXISTS bulk_requests (
        bulk_id TEXT PRIMARY KEY,
        action TEXT NOT NULL CHECK (action IN ('add', 'pause', 'resume', 'stop')),
        body_sha256 TEXT NOT NULL,
        answer TEXT,
        at_wall INTEGER NOT NULL
      );
      -- Lead search reads each row's enrollments, and filters by campaign and status per person or company: without
      -- these it scanned every enrollment for every row (measured at 2,000 leads; ADR 0003 "Ticket 18").
      CREATE INDEX IF NOT EXISTS enrollments_by_person ON enrollments(person_id) WHERE lead_kind = 'person';
      CREATE INDEX IF NOT EXISTS enrollments_by_company ON enrollments(company_id, lead_kind);
    `,
  },
  {
    // Ticket 21.
    version: 18,
    name: "test runs: a subject of their own, the campaign's test contacts, and detail references a test contact can satisfy (ADR 0003, ticket 21)",
    rebuildsTables: true,
    // A test run is a subject with the fields of an enrollment and no person or company. Its contacts' detail ids
    // (`test:<run>:email`, `test:<run>:mobile`) name no CRM record, so the three columns that referenced
    // contact_details are rebuilt without that key, which triggers replace: a lead's row may name only a CRM detail,
    // and a test run's only its own test contact.
    sql: `
      ALTER TABLE campaigns ADD COLUMN test_email TEXT;
      ALTER TABLE campaigns ADD COLUMN test_mobile TEXT;
      -- The revision of the definition's last edit: a launch moves definition_version on without an edit (ticket 19).
      ALTER TABLE campaigns ADD COLUMN edit_version INTEGER NOT NULL DEFAULT 0;
      UPDATE campaigns SET edit_version = definition_version;
      CREATE TABLE test_runs (
        id TEXT PRIMARY KEY REFERENCES subjects(id),
        campaign_id TEXT NOT NULL REFERENCES campaigns(id),
        render_as TEXT NOT NULL REFERENCES enrollments(id),
        email_value TEXT, email_key TEXT, mobile_value TEXT, mobile_key TEXT,
        email_bad INTEGER NOT NULL DEFAULT 0 CHECK (email_bad IN (0, 1)),
        mobile_bad INTEGER NOT NULL DEFAULT 0 CHECK (mobile_bad IN (0, 1)),
        definition_version INTEGER NOT NULL,
        definition_edited_at TEXT,
        started_wall INTEGER NOT NULL,
        stopped_by TEXT CHECK (stopped_by IN ('user', 'edit')),
        request_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN (${statusList})),
        version INTEGER NOT NULL DEFAULT 0,
        ended TEXT, ended_at INTEGER, ended_wall INTEGER,
        lead_paused INTEGER NOT NULL DEFAULT 0,
        branch TEXT NOT NULL DEFAULT 'main' CHECK (branch IN ('main', 'win_back')),
        branch_entered_at INTEGER,
        touched INTEGER NOT NULL DEFAULT 0,
        no_more_calls INTEGER NOT NULL DEFAULT 0,
        frozen_since INTEGER, frozen_total INTEGER NOT NULL DEFAULT 0,
        email_sender TEXT, sms_sender TEXT,
        stop_reply_channel TEXT CHECK (stop_reply_channel IN ('email', 'sms')),
        stop_reply_at INTEGER,
        CHECK (email_key IS NOT NULL OR mobile_key IS NOT NULL)
      );
      CREATE UNIQUE INDEX one_running_test_per_campaign ON test_runs(campaign_id) WHERE ended IS NULL;
      CREATE INDEX test_runs_by_campaign ON test_runs(campaign_id, started_wall);
      -- Every subject the engine runs, with what the call list and the worker read of it: a test run has no person or company.
      CREATE VIEW engine_subjects AS
        SELECT id, 'enrollment' AS kind, campaign_id, person_id, company_id, ended, ended_wall FROM enrollments
        UNION ALL
        SELECT id, 'test_run' AS kind, campaign_id, NULL, NULL, ended, ended_wall FROM test_runs;

      CREATE TABLE track_progress_v17 (
        subject_id TEXT NOT NULL REFERENCES subjects(id),
        track_id TEXT NOT NULL,
        start_at INTEGER, start_basis_at INTEGER, start_basis_wall INTEGER, start_zone TEXT,
        started_at INTEGER,
        destination_detail_id TEXT,
        next_step_id TEXT, basis_at INTEGER, basis_wall INTEGER, due_at INTEGER, due_wall INTEGER, due_zone TEXT,
        finished_at INTEGER, finished_wall INTEGER, finish_reason TEXT,
        PRIMARY KEY (subject_id, track_id)
      );
      INSERT INTO track_progress_v17 SELECT subject_id, track_id, start_at, start_basis_at, start_basis_wall, start_zone, started_at, destination_detail_id,
        next_step_id, basis_at, basis_wall, due_at, due_wall, due_zone, finished_at, finished_wall, finish_reason FROM track_progress ORDER BY rowid;
      DROP TABLE track_progress;
      ALTER TABLE track_progress_v17 RENAME TO track_progress;

      CREATE TABLE attempts_v17 (
        id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL REFERENCES subjects(id),
        track_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES sender_accounts(id),
        destination_detail_id TEXT NOT NULL,
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
      INSERT INTO attempts_v17 SELECT id, subject_id, track_id, step_id, account_id, destination_detail_id, destination, state, copy, threading, thread_ref,
        retryable, not_sent_final, idempotency_key, calls, claimed_wall, handed_at, handed_wall, last_call_wall, presend_checked_wall, presend_found_reply,
        ended_by, withdraw_requested, withdraw_called, awaiting_answer, retry, reject_reason FROM attempts ORDER BY rowid;
      DROP TABLE attempts;
      ALTER TABLE attempts_v17 RENAME TO attempts;
      CREATE UNIQUE INDEX one_live_attempt_per_step ON attempts(subject_id, step_id) WHERE state IN ('claimed', 'handed', 'accepted');
      CREATE UNIQUE INDEX one_sent_attempt_per_step ON attempts(subject_id, step_id) WHERE state = 'sent';
      CREATE INDEX attempts_by_subject ON attempts(subject_id);
      CREATE INDEX attempts_by_account_state ON attempts(account_id, state);
      CREATE INDEX attempts_by_key ON attempts(idempotency_key);

      CREATE TABLE call_attempts_v17 (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES call_tasks(id),
        subject_id TEXT NOT NULL REFERENCES subjects(id),
        -- The client's key for the action that logged it: one action is logged once, whatever retries it.
        request_id TEXT NOT NULL UNIQUE,
        outcome TEXT NOT NULL,
        number_detail_id TEXT,
        note TEXT NOT NULL,
        at INTEGER NOT NULL,
        at_wall INTEGER NOT NULL,
        redial INTEGER NOT NULL DEFAULT 0 CHECK (redial IN (0, 1)),
        callback_at INTEGER,
        declined_path TEXT CHECK (declined_path IN ('stop', 'continue', 'win_back'))
      );
      INSERT INTO call_attempts_v17 SELECT id, task_id, subject_id, request_id, outcome, number_detail_id, note, at, at_wall, redial, callback_at, declined_path
        FROM call_attempts ORDER BY rowid;
      DROP TABLE call_attempts;
      ALTER TABLE call_attempts_v17 RENAME TO call_attempts;
      CREATE INDEX call_attempts_by_subject ON call_attempts(subject_id, at_wall);

      -- A lead's row names only a live or merged CRM detail; a test run's names only its own email or mobile, which it has
      -- (verifier F2 on 55d6ac6: another run's id, an invented kind or a contact the run lacks is refused).
      CREATE TRIGGER track_progress_destination_detail_id_known_insert BEFORE INSERT ON track_progress
      WHEN NOT (NEW.destination_detail_id IS NULL OR (CASE WHEN (SELECT kind FROM subjects WHERE id = NEW.subject_id) = 'test_run'
          THEN (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':email' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND email_key IS NOT NULL))
            OR (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':mobile' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND mobile_key IS NOT NULL))
          ELSE NEW.destination_detail_id NOT LIKE 'test:%' AND EXISTS (SELECT 1 FROM contact_details WHERE id = NEW.destination_detail_id) END))
      BEGIN SELECT RAISE(ABORT, 'track_progress.destination_detail_id names neither a contact detail of a lead nor a test contact of this test run'); END;
      CREATE TRIGGER track_progress_destination_detail_id_known_update BEFORE UPDATE OF destination_detail_id, subject_id ON track_progress
      WHEN NOT (NEW.destination_detail_id IS NULL OR (CASE WHEN (SELECT kind FROM subjects WHERE id = NEW.subject_id) = 'test_run'
          THEN (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':email' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND email_key IS NOT NULL))
            OR (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':mobile' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND mobile_key IS NOT NULL))
          ELSE NEW.destination_detail_id NOT LIKE 'test:%' AND EXISTS (SELECT 1 FROM contact_details WHERE id = NEW.destination_detail_id) END))
      BEGIN SELECT RAISE(ABORT, 'track_progress.destination_detail_id names neither a contact detail of a lead nor a test contact of this test run'); END;
      CREATE TRIGGER attempts_destination_detail_id_known_insert BEFORE INSERT ON attempts
      WHEN NOT (CASE WHEN (SELECT kind FROM subjects WHERE id = NEW.subject_id) = 'test_run'
          THEN (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':email' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND email_key IS NOT NULL))
            OR (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':mobile' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND mobile_key IS NOT NULL))
          ELSE NEW.destination_detail_id NOT LIKE 'test:%' AND EXISTS (SELECT 1 FROM contact_details WHERE id = NEW.destination_detail_id) END)
      BEGIN SELECT RAISE(ABORT, 'attempts.destination_detail_id names neither a contact detail of a lead nor a test contact of this test run'); END;
      CREATE TRIGGER attempts_destination_detail_id_known_update BEFORE UPDATE OF destination_detail_id, subject_id ON attempts
      WHEN NOT (CASE WHEN (SELECT kind FROM subjects WHERE id = NEW.subject_id) = 'test_run'
          THEN (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':email' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND email_key IS NOT NULL))
            OR (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':mobile' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND mobile_key IS NOT NULL))
          ELSE NEW.destination_detail_id NOT LIKE 'test:%' AND EXISTS (SELECT 1 FROM contact_details WHERE id = NEW.destination_detail_id) END)
      BEGIN SELECT RAISE(ABORT, 'attempts.destination_detail_id names neither a contact detail of a lead nor a test contact of this test run'); END;
      CREATE TRIGGER call_attempts_number_detail_id_known_insert BEFORE INSERT ON call_attempts
      WHEN NOT (NEW.number_detail_id IS NULL OR (CASE WHEN (SELECT kind FROM subjects WHERE id = NEW.subject_id) = 'test_run'
          THEN (NEW.number_detail_id = 'test:' || NEW.subject_id || ':email' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND email_key IS NOT NULL))
            OR (NEW.number_detail_id = 'test:' || NEW.subject_id || ':mobile' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND mobile_key IS NOT NULL))
          ELSE NEW.number_detail_id NOT LIKE 'test:%' AND EXISTS (SELECT 1 FROM contact_details WHERE id = NEW.number_detail_id) END))
      BEGIN SELECT RAISE(ABORT, 'call_attempts.number_detail_id names neither a contact detail of a lead nor a test contact of this test run'); END;
      CREATE TRIGGER call_attempts_number_detail_id_known_update BEFORE UPDATE OF number_detail_id, subject_id ON call_attempts
      WHEN NOT (NEW.number_detail_id IS NULL OR (CASE WHEN (SELECT kind FROM subjects WHERE id = NEW.subject_id) = 'test_run'
          THEN (NEW.number_detail_id = 'test:' || NEW.subject_id || ':email' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND email_key IS NOT NULL))
            OR (NEW.number_detail_id = 'test:' || NEW.subject_id || ':mobile' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND mobile_key IS NOT NULL))
          ELSE NEW.number_detail_id NOT LIKE 'test:%' AND EXISTS (SELECT 1 FROM contact_details WHERE id = NEW.number_detail_id) END))
      BEGIN SELECT RAISE(ABORT, 'call_attempts.number_detail_id names neither a contact detail of a lead nor a test contact of this test run'); END;
    `,
  },
  {
    // PR 62, the reply identity rule (ADR 0003 "Ticket 17a").
    version: 19,
    name: "one stored form for a reply's id: sms:<id> for a text, reply:<email id> for an email (ADR 0003, the reply identity rule)",
    // A pre-send answer was stored under the provider's bare id while the observation stores the event's id: a text's
    // bare id (until PR 62) beside sms:<id>, and an email's bare id (the Instantly adapter until ticket 17a, from
    // cb31184) beside reply:<email id>. A late observation of the same reply was then a second reply that ended a resumed
    // lead again (verifier B1 and the council on PR 62). Every bare id becomes the observed form; a lead holding both
    // keeps one row, at the earlier instant. An email id with a colon is an event's id already (reply:, unsubscribed:)
    // and is kept exactly. Reply events hold only observed ids. Bare is: a text without the sms: prefix, an email
    // without any colon.
    sql: `
      CREATE TEMP TABLE reply_forms AS
        SELECT rowid AS id, subject_id, provider_ref AS bare,
          CASE channel WHEN 'sms' THEN 'sms:' || provider_ref ELSE 'reply:' || provider_ref END AS canonical, at_wall
        FROM replies
        WHERE (channel = 'sms' AND substr(provider_ref, 1, 4) <> 'sms:') OR (channel = 'email' AND instr(provider_ref, ':') = 0);
      UPDATE replies SET at_wall = (SELECT MIN(f.at_wall) FROM reply_forms f WHERE f.subject_id = replies.subject_id AND f.canonical = replies.provider_ref)
      WHERE EXISTS (SELECT 1 FROM reply_forms f WHERE f.subject_id = replies.subject_id AND f.canonical = replies.provider_ref AND f.at_wall < replies.at_wall);
      DELETE FROM replies
      WHERE rowid IN (SELECT f.id FROM reply_forms f WHERE EXISTS (SELECT 1 FROM replies c WHERE c.subject_id = f.subject_id AND c.provider_ref = f.canonical));
      UPDATE replies SET provider_ref = (SELECT f.canonical FROM reply_forms f WHERE f.id = replies.rowid)
      WHERE rowid IN (SELECT id FROM reply_forms);
      DROP TABLE reply_forms;
    `,
  },
  {
    // Fix: an inbox used up outside the app no longer stops the engine's tick (verifier, 15 November 2026).
    version: 20,
    name: "a sender account's capacity may be 0 (no room on its reset day), and its daily limit is stored apart (ADR 0003 4.1 as amended)",
    // An Instantly inbox whose daily limit other senders used up today, or that has no daily limit, reports capacity 0;
    // `capacity > 0` refused it and the tick threw. 0 now means "no room now": the claim's capacity rule refuses it, and
    // its due work waits for capacity in Needs attention. SQLite cannot change a CHECK, so the table is rebuilt; provider
    // work and attempts reference it, hence `rebuildsTables`. Every stored row already satisfies the new CHECK.
    rebuildsTables: true,
    sql: `
      CREATE TABLE sender_accounts_v20 (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
        label TEXT NOT NULL,
        capacity INTEGER NOT NULL CHECK (capacity >= 0),
        gap_ms INTEGER CHECK (gap_ms IS NULL OR gap_ms > 0),
        k INTEGER NOT NULL CHECK (k > 0),
        next_slot_at INTEGER NOT NULL DEFAULT 0,
        healthy INTEGER NOT NULL DEFAULT 1,
        wait_until INTEGER,
        wait_reason TEXT,
        backoff_ms INTEGER NOT NULL DEFAULT 0,
        reset_zone TEXT NOT NULL DEFAULT 'UTC',
        problem TEXT,
        -- The room on any other reset day; today's is capacity (council on PR 63). Until the next sync, the capacity.
        daily_limit INTEGER NOT NULL CHECK (daily_limit >= 0)
      );
      INSERT INTO sender_accounts_v20 (id, channel, label, capacity, gap_ms, k, next_slot_at, healthy, wait_until, wait_reason, backoff_ms, reset_zone, problem, daily_limit)
        SELECT id, channel, label, capacity, gap_ms, k, next_slot_at, healthy, wait_until, wait_reason, backoff_ms, reset_zone, problem, capacity
        FROM sender_accounts ORDER BY rowid;
      DROP TABLE sender_accounts;
      ALTER TABLE sender_accounts_v20 RENAME TO sender_accounts;
    `,
  },
  {
    version: 21,
    name: "a skip for a taken SMS conversation records its cause; a binding whose texts all ended not sent is released as unsent (ADR 0003, question Q7 answered)",
    // The skip's cause (the number, the mobile and the owner then) is stored with the track, so a later pool edit, a
    // release or a rename never changes the reason a read gives. A conversation exists once a text is known sent: a
    // binding none of whose owner's texts on the pair went is released, marked unsent, so it neither blocks another
    // campaign nor takes a reply.
    // It releases no binding itself. Which bindings own no conversation is the engine's rule (`bindingUnsent`), applied
    // by the store to every standing binding as it opens, before anything reads one (`openStoreOn`), so the upgrade and the
    // running engine decide it by one statement of the rule, never by two (review bot on 50788ac: an SQL restatement here
    // missed that an answered binding stays its owner's).
    sql: `
      ALTER TABLE track_progress ADD COLUMN conversation_owners TEXT;
      ALTER TABLE sms_bindings ADD COLUMN unsent INTEGER NOT NULL DEFAULT 0 CHECK (unsent IN (0, 1));
    `,
  },
  {
    version: 22,
    name: "LinkedIn tracks (ticket 24, ADR 0004): the channel, a track's connection and acceptance deadline, allowances, profiles and test profiles",
    // SQLite cannot change a CHECK, so the four tables whose CHECK names the channels are rebuilt with 'linkedin' added:
    // sender accounts, replies (a LinkedIn reply is the user's mark), and the stopping reply's channel on enrollments and
    // test runs. The detail triggers of migration 18 are replaced, so a lead's row may also name its person's LinkedIn
    // profile (`linkedin:<person id>:<key>`, ADR 0004 section 5) and a test run's its own test profile; the view that reads
    // both subject tables is dropped and made again around the rebuild. Every stored row satisfies the new CHECKs.
    rebuildsTables: true,
    sql: `
      DROP TRIGGER track_progress_destination_detail_id_known_insert;
      DROP TRIGGER track_progress_destination_detail_id_known_update;
      DROP TRIGGER attempts_destination_detail_id_known_insert;
      DROP TRIGGER attempts_destination_detail_id_known_update;
      DROP TRIGGER call_attempts_number_detail_id_known_insert;
      DROP TRIGGER call_attempts_number_detail_id_known_update;
      DROP VIEW engine_subjects;

      CREATE TABLE sender_accounts_v22 (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'linkedin')),
        label TEXT NOT NULL,
        capacity INTEGER NOT NULL CHECK (capacity >= 0),
        gap_ms INTEGER CHECK (gap_ms IS NULL OR gap_ms > 0),
        k INTEGER NOT NULL CHECK (k > 0),
        next_slot_at INTEGER NOT NULL DEFAULT 0,
        healthy INTEGER NOT NULL DEFAULT 1,
        wait_until INTEGER,
        wait_reason TEXT,
        backoff_ms INTEGER NOT NULL DEFAULT 0,
        reset_zone TEXT NOT NULL DEFAULT 'UTC',
        problem TEXT,
        daily_limit INTEGER NOT NULL CHECK (daily_limit >= 0)
      );
      INSERT INTO sender_accounts_v22 (id, channel, label, capacity, gap_ms, k, next_slot_at, healthy, wait_until, wait_reason, backoff_ms, reset_zone, problem, daily_limit)
        SELECT id, channel, label, capacity, gap_ms, k, next_slot_at, healthy, wait_until, wait_reason, backoff_ms, reset_zone, problem, daily_limit FROM sender_accounts ORDER BY rowid;
      DROP TABLE sender_accounts;
      ALTER TABLE sender_accounts_v22 RENAME TO sender_accounts;

      CREATE TABLE replies_v22 (
        provider_ref TEXT NOT NULL,
        subject_id TEXT NOT NULL REFERENCES subjects(id),
        channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'linkedin')),
        at_wall INTEGER NOT NULL,
        PRIMARY KEY (subject_id, provider_ref)
      );
      INSERT INTO replies_v22 (provider_ref, subject_id, channel, at_wall) SELECT provider_ref, subject_id, channel, at_wall FROM replies ORDER BY rowid;
      DROP TABLE replies;
      ALTER TABLE replies_v22 RENAME TO replies;
      CREATE INDEX replies_by_subject ON replies(subject_id);

      CREATE TABLE enrollments_v22 (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id),
        lead_kind TEXT NOT NULL CHECK (lead_kind IN ('person', 'company')),
        person_id TEXT REFERENCES people(id),
        company_id TEXT NOT NULL REFERENCES companies(id),
        status TEXT NOT NULL CHECK (status IN ('queued', 'active', 'in_win_back', 'waiting_on_call', 'callback_scheduled', 'replied', 'interested_on_call', 'paused', 'declined_on_call', 'stopped_manually', 'sequence_finished_no_response', 'finished_no_usable_channel')),
        enrolled_at TEXT NOT NULL,
        import_id TEXT REFERENCES imports(id),
        version INTEGER NOT NULL DEFAULT 0,
        ended TEXT, ended_at INTEGER, ended_wall INTEGER,
        lead_paused INTEGER NOT NULL DEFAULT 0,
        branch TEXT NOT NULL DEFAULT 'main' CHECK (branch IN ('main', 'win_back')),
        branch_entered_at INTEGER,
        touched INTEGER NOT NULL DEFAULT 0,
        no_more_calls INTEGER NOT NULL DEFAULT 0,
        frozen_since INTEGER, frozen_total INTEGER NOT NULL DEFAULT 0,
        email_sender TEXT, sms_sender TEXT,
        stop_reply_channel TEXT CHECK (stop_reply_channel IN ('email', 'sms', 'linkedin')),
        stop_reply_at INTEGER,
        linkedin_sender TEXT,
        CHECK ((lead_kind = 'person') = (person_id IS NOT NULL))
      );
      INSERT INTO enrollments_v22 (id, campaign_id, lead_kind, person_id, company_id, status, enrolled_at, import_id, version, ended, ended_at, ended_wall, lead_paused, branch,
          branch_entered_at, touched, no_more_calls, frozen_since, frozen_total, email_sender, sms_sender, stop_reply_channel, stop_reply_at)
        SELECT id, campaign_id, lead_kind, person_id, company_id, status, enrolled_at, import_id, version, ended, ended_at, ended_wall, lead_paused, branch,
          branch_entered_at, touched, no_more_calls, frozen_since, frozen_total, email_sender, sms_sender, stop_reply_channel, stop_reply_at FROM enrollments ORDER BY rowid;
      DROP TABLE enrollments;
      ALTER TABLE enrollments_v22 RENAME TO enrollments;
      CREATE UNIQUE INDEX one_person_lead_per_campaign ON enrollments(campaign_id, person_id) WHERE lead_kind = 'person';
      CREATE UNIQUE INDEX one_company_lead_per_campaign ON enrollments(campaign_id, company_id) WHERE lead_kind = 'company';
      CREATE INDEX enrollments_by_campaign_status ON enrollments(campaign_id, status);
      CREATE INDEX enrollments_by_person ON enrollments(person_id) WHERE lead_kind = 'person';
      CREATE INDEX enrollments_by_company ON enrollments(company_id, lead_kind);

      CREATE TABLE test_runs_v22 (
        id TEXT PRIMARY KEY REFERENCES subjects(id),
        campaign_id TEXT NOT NULL REFERENCES campaigns(id),
        render_as TEXT NOT NULL REFERENCES enrollments(id),
        email_value TEXT, email_key TEXT, mobile_value TEXT, mobile_key TEXT,
        email_bad INTEGER NOT NULL DEFAULT 0 CHECK (email_bad IN (0, 1)),
        mobile_bad INTEGER NOT NULL DEFAULT 0 CHECK (mobile_bad IN (0, 1)),
        definition_version INTEGER NOT NULL,
        definition_edited_at TEXT,
        started_wall INTEGER NOT NULL,
        stopped_by TEXT CHECK (stopped_by IN ('user', 'edit')),
        request_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('queued', 'active', 'in_win_back', 'waiting_on_call', 'callback_scheduled', 'replied', 'interested_on_call', 'paused', 'declined_on_call', 'stopped_manually', 'sequence_finished_no_response', 'finished_no_usable_channel')),
        version INTEGER NOT NULL DEFAULT 0,
        ended TEXT, ended_at INTEGER, ended_wall INTEGER,
        lead_paused INTEGER NOT NULL DEFAULT 0,
        branch TEXT NOT NULL DEFAULT 'main' CHECK (branch IN ('main', 'win_back')),
        branch_entered_at INTEGER,
        touched INTEGER NOT NULL DEFAULT 0,
        no_more_calls INTEGER NOT NULL DEFAULT 0,
        frozen_since INTEGER, frozen_total INTEGER NOT NULL DEFAULT 0,
        email_sender TEXT, sms_sender TEXT,
        stop_reply_channel TEXT CHECK (stop_reply_channel IN ('email', 'sms', 'linkedin')),
        stop_reply_at INTEGER,
        linkedin_sender TEXT,
        linkedin_value TEXT, linkedin_key TEXT,
        linkedin_bad INTEGER NOT NULL DEFAULT 0 CHECK (linkedin_bad IN (0, 1)),
        CHECK (email_key IS NOT NULL OR mobile_key IS NOT NULL OR linkedin_key IS NOT NULL)
      );
      INSERT INTO test_runs_v22 (id, campaign_id, render_as, email_value, email_key, mobile_value, mobile_key, email_bad, mobile_bad, definition_version, definition_edited_at,
          started_wall, stopped_by, request_id, status, version, ended, ended_at, ended_wall, lead_paused, branch, branch_entered_at, touched, no_more_calls, frozen_since,
          frozen_total, email_sender, sms_sender, stop_reply_channel, stop_reply_at)
        SELECT id, campaign_id, render_as, email_value, email_key, mobile_value, mobile_key, email_bad, mobile_bad, definition_version, definition_edited_at,
          started_wall, stopped_by, request_id, status, version, ended, ended_at, ended_wall, lead_paused, branch, branch_entered_at, touched, no_more_calls, frozen_since,
          frozen_total, email_sender, sms_sender, stop_reply_channel, stop_reply_at FROM test_runs ORDER BY rowid;
      DROP TABLE test_runs;
      ALTER TABLE test_runs_v22 RENAME TO test_runs;
      CREATE UNIQUE INDEX one_running_test_per_campaign ON test_runs(campaign_id) WHERE ended IS NULL;
      CREATE INDEX test_runs_by_campaign ON test_runs(campaign_id, started_wall);

      CREATE VIEW engine_subjects AS
        SELECT id, 'enrollment' AS kind, campaign_id, person_id, company_id, ended, ended_wall FROM enrollments
        UNION ALL
        SELECT id, 'test_run' AS kind, campaign_id, NULL, NULL, ended, ended_wall FROM test_runs;

      -- A LinkedIn track's connection, acceptance deadline and invite withdrawal (ADR 0004 3.2).
      ALTER TABLE track_progress ADD COLUMN connection TEXT CHECK (connection IN ('accepted', 'already_connected'));
      ALTER TABLE track_progress ADD COLUMN connected_at INTEGER;
      ALTER TABLE track_progress ADD COLUMN connected_wall INTEGER;
      ALTER TABLE track_progress ADD COLUMN accepted_wall INTEGER;
      ALTER TABLE track_progress ADD COLUMN accept_by INTEGER;
      ALTER TABLE track_progress ADD COLUMN accept_by_wall INTEGER;
      ALTER TABLE track_progress ADD COLUMN accept_by_zone TEXT;
      ALTER TABLE track_progress ADD COLUMN accept_by_days INTEGER;
      ALTER TABLE track_progress ADD COLUMN invite_withdrawal TEXT CHECK (invite_withdrawal IN ('wanted', 'withdrawn', 'accepted_first', 'kept_by_user'));
      ALTER TABLE track_progress ADD COLUMN invite_withdrawal_unknowns INTEGER NOT NULL DEFAULT 0;
      -- The connection checks before the invite, one answer per session (ADR 0004 6; question Q42; review bot on e261ffa):
      -- a JSON object of session id to {answer: 'clear' | 'pending', checkedWall, pendingSince}.
      ALTER TABLE track_progress ADD COLUMN connection_checks TEXT CHECK (connection_checks IS NULL OR json_valid(connection_checks));
      ALTER TABLE track_progress ADD COLUMN invite_withdrawal_last_wall INTEGER;
      -- A social step's action and an invite's note, fixed at the claim and at the handover (ADR 0004 4, 6).
      ALTER TABLE provider_work ADD COLUMN kind TEXT CHECK (kind IN ('invite', 'message'));
      ALTER TABLE provider_work ADD COLUMN note TEXT CHECK (note IN ('with', 'withheld', 'none'));
      ALTER TABLE attempts ADD COLUMN action TEXT CHECK (action IN ('invite', 'message'));
      -- The user's test LinkedIn profile (ADR 0004 section 8).
      ALTER TABLE campaigns ADD COLUMN test_linkedin TEXT;

      -- The user's allowances for each social sender account (ADR 0004 1.2): no default; kept across the port's syncs.
      CREATE TABLE social_allowances (
        account_id TEXT PRIMARY KEY,
        invites_per_day INTEGER NOT NULL CHECK (invites_per_day >= 0),
        messages_per_day INTEGER NOT NULL CHECK (messages_per_day >= 0),
        notes_per_month INTEGER NOT NULL CHECK (notes_per_month >= 0),
        updated_wall INTEGER NOT NULL
      );
      -- A LinkedIn profile the session found unreachable, by its key (ADR 0004 section 5; ADR 0001: never cleared).
      CREATE TABLE linkedin_profile_marks (
        key TEXT PRIMARY KEY,
        marked_wall INTEGER NOT NULL
      );

      CREATE TRIGGER track_progress_destination_detail_id_known_insert BEFORE INSERT ON track_progress
      WHEN NOT (NEW.destination_detail_id IS NULL OR (CASE WHEN (SELECT kind FROM subjects WHERE id = NEW.subject_id) = 'test_run'
          THEN (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':email' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND email_key IS NOT NULL))
            OR (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':mobile' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND mobile_key IS NOT NULL))
            OR (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':linkedin' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND linkedin_key IS NOT NULL))
          WHEN NEW.destination_detail_id LIKE 'linkedin:%' THEN EXISTS (SELECT 1 FROM enrollments e WHERE e.id = NEW.subject_id AND e.person_id IS NOT NULL AND substr(NEW.destination_detail_id, 1, length(e.person_id) + 10) = 'linkedin:' || e.person_id || ':')
          ELSE NEW.destination_detail_id NOT LIKE 'test:%' AND EXISTS (SELECT 1 FROM contact_details WHERE id = NEW.destination_detail_id) END))
      BEGIN SELECT RAISE(ABORT, 'track_progress.destination_detail_id names neither a contact detail of a lead nor a test contact of this test run'); END;
      CREATE TRIGGER track_progress_destination_detail_id_known_update BEFORE UPDATE OF destination_detail_id, subject_id ON track_progress
      WHEN NOT (NEW.destination_detail_id IS NULL OR (CASE WHEN (SELECT kind FROM subjects WHERE id = NEW.subject_id) = 'test_run'
          THEN (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':email' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND email_key IS NOT NULL))
            OR (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':mobile' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND mobile_key IS NOT NULL))
            OR (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':linkedin' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND linkedin_key IS NOT NULL))
          WHEN NEW.destination_detail_id LIKE 'linkedin:%' THEN EXISTS (SELECT 1 FROM enrollments e WHERE e.id = NEW.subject_id AND e.person_id IS NOT NULL AND substr(NEW.destination_detail_id, 1, length(e.person_id) + 10) = 'linkedin:' || e.person_id || ':')
          ELSE NEW.destination_detail_id NOT LIKE 'test:%' AND EXISTS (SELECT 1 FROM contact_details WHERE id = NEW.destination_detail_id) END))
      BEGIN SELECT RAISE(ABORT, 'track_progress.destination_detail_id names neither a contact detail of a lead nor a test contact of this test run'); END;
      CREATE TRIGGER attempts_destination_detail_id_known_insert BEFORE INSERT ON attempts
      WHEN NOT ((CASE WHEN (SELECT kind FROM subjects WHERE id = NEW.subject_id) = 'test_run'
          THEN (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':email' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND email_key IS NOT NULL))
            OR (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':mobile' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND mobile_key IS NOT NULL))
            OR (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':linkedin' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND linkedin_key IS NOT NULL))
          WHEN NEW.destination_detail_id LIKE 'linkedin:%' THEN EXISTS (SELECT 1 FROM enrollments e WHERE e.id = NEW.subject_id AND e.person_id IS NOT NULL AND substr(NEW.destination_detail_id, 1, length(e.person_id) + 10) = 'linkedin:' || e.person_id || ':')
          ELSE NEW.destination_detail_id NOT LIKE 'test:%' AND EXISTS (SELECT 1 FROM contact_details WHERE id = NEW.destination_detail_id) END))
      BEGIN SELECT RAISE(ABORT, 'attempts.destination_detail_id names neither a contact detail of a lead nor a test contact of this test run'); END;
      CREATE TRIGGER attempts_destination_detail_id_known_update BEFORE UPDATE OF destination_detail_id, subject_id ON attempts
      WHEN NOT ((CASE WHEN (SELECT kind FROM subjects WHERE id = NEW.subject_id) = 'test_run'
          THEN (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':email' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND email_key IS NOT NULL))
            OR (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':mobile' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND mobile_key IS NOT NULL))
            OR (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':linkedin' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND linkedin_key IS NOT NULL))
          WHEN NEW.destination_detail_id LIKE 'linkedin:%' THEN EXISTS (SELECT 1 FROM enrollments e WHERE e.id = NEW.subject_id AND e.person_id IS NOT NULL AND substr(NEW.destination_detail_id, 1, length(e.person_id) + 10) = 'linkedin:' || e.person_id || ':')
          ELSE NEW.destination_detail_id NOT LIKE 'test:%' AND EXISTS (SELECT 1 FROM contact_details WHERE id = NEW.destination_detail_id) END))
      BEGIN SELECT RAISE(ABORT, 'attempts.destination_detail_id names neither a contact detail of a lead nor a test contact of this test run'); END;
      CREATE TRIGGER call_attempts_number_detail_id_known_insert BEFORE INSERT ON call_attempts
      WHEN NOT (NEW.number_detail_id IS NULL OR (CASE WHEN (SELECT kind FROM subjects WHERE id = NEW.subject_id) = 'test_run'
          THEN (NEW.number_detail_id = 'test:' || NEW.subject_id || ':email' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND email_key IS NOT NULL))
            OR (NEW.number_detail_id = 'test:' || NEW.subject_id || ':mobile' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND mobile_key IS NOT NULL))
          ELSE NEW.number_detail_id NOT LIKE 'test:%' AND EXISTS (SELECT 1 FROM contact_details WHERE id = NEW.number_detail_id) END))
      BEGIN SELECT RAISE(ABORT, 'call_attempts.number_detail_id names neither a contact detail of a lead nor a test contact of this test run'); END;
      CREATE TRIGGER call_attempts_number_detail_id_known_update BEFORE UPDATE OF number_detail_id, subject_id ON call_attempts
      WHEN NOT (NEW.number_detail_id IS NULL OR (CASE WHEN (SELECT kind FROM subjects WHERE id = NEW.subject_id) = 'test_run'
          THEN (NEW.number_detail_id = 'test:' || NEW.subject_id || ':email' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND email_key IS NOT NULL))
            OR (NEW.number_detail_id = 'test:' || NEW.subject_id || ':mobile' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND mobile_key IS NOT NULL))
          ELSE NEW.number_detail_id NOT LIKE 'test:%' AND EXISTS (SELECT 1 FROM contact_details WHERE id = NEW.number_detail_id) END))
      BEGIN SELECT RAISE(ABORT, 'call_attempts.number_detail_id names neither a contact detail of a lead nor a test contact of this test run'); END;
    `,
  },
  {
    version: 23,
    name: "a pair records its channel when it is taken and never changes it (the re-check of e261ffa, item 3)",
    sql: `
      -- Every pair before this is an SMS conversation, but for LinkedIn pairs a database of this branch already holds.
      ALTER TABLE sms_bindings ADD COLUMN channel TEXT NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms', 'linkedin'));
      UPDATE sms_bindings SET channel = 'linkedin' WHERE sender_number IN (SELECT id FROM sender_accounts WHERE channel = 'linkedin');
      CREATE TRIGGER sms_bindings_channel_fixed BEFORE UPDATE OF channel ON sms_bindings WHEN NEW.channel IS NOT OLD.channel
      BEGIN SELECT RAISE(ABORT, 'a pair''s channel never changes'); END;
      -- An account's channel never changes either: the same id on another channel is another account (ADR 0004 1.1).
      CREATE TRIGGER sender_accounts_channel_fixed BEFORE UPDATE OF channel ON sender_accounts WHEN NEW.channel IS NOT OLD.channel
      BEGIN SELECT RAISE(ABORT, 'an account''s channel never changes'); END;
      -- An INSERT OR REPLACE is a change too, refused before the old row is removed (the re-checks of dd3969c, item 3, and of
      -- 8c85b2f, item 2): on the pair's own key, and on the active sender and recipient it would replace.
      CREATE TRIGGER sms_bindings_channel_fixed_on_replace BEFORE INSERT ON sms_bindings
      WHEN EXISTS (SELECT 1 FROM sms_bindings WHERE seq = NEW.seq AND channel IS NOT NEW.channel)
        OR EXISTS (SELECT 1 FROM sms_bindings WHERE sender_number = NEW.sender_number AND recipient_key = NEW.recipient_key AND released_at IS NULL AND channel IS NOT NEW.channel)
      BEGIN SELECT RAISE(ABORT, 'a pair''s channel never changes'); END;
      CREATE TRIGGER sender_accounts_channel_fixed_on_replace BEFORE INSERT ON sender_accounts
      WHEN EXISTS (SELECT 1 FROM sender_accounts WHERE id = NEW.id AND channel IS NOT NEW.channel)
      BEGIN SELECT RAISE(ABORT, 'an account''s channel never changes'); END;
      CREATE INDEX sms_bindings_by_owner ON sms_bindings(owner_subject);

      -- The conversations' versions, per destination (ADR 0004, "The conversations' version"; the re-checks of dd3969c, item 1,
      -- and of 8c85b2f, item 1): a counter per mobile or profile that the database moves itself, in the same write, on every
      -- write to a fact a pair's ownership or knownness is read from, whatever wrote it. The inputs are the same list the
      -- ownership query reads (CONVERSATION_PAIRS_QUERY in sqlite-engine-store.ts): the pair rows; the owner's provider work;
      -- the owner's track progress (a connection, an acceptance, a withdrawal); the owner's ending; and replies. Each write
      -- moves only the destinations it belongs to: a pair row its recipient; an owner's work, progress or ending the recipients
      -- of the pairs that subject owns; a reply its address. An update moves them only when it changes a column the query
      -- reads (CONVERSATION_INPUTS). A cache remembers only its own destinations' versions.
      CREATE TABLE conversation_versions (recipient_key TEXT PRIMARY KEY, seq INTEGER NOT NULL);
      CREATE TRIGGER conversations_pair_insert AFTER INSERT ON sms_bindings BEGIN INSERT INTO conversation_versions (recipient_key, seq) VALUES (NEW.recipient_key, 1) ON CONFLICT(recipient_key) DO UPDATE SET seq = seq + 1; END;
      CREATE TRIGGER conversations_pair_update AFTER UPDATE ON sms_bindings BEGIN INSERT INTO conversation_versions (recipient_key, seq) VALUES (OLD.recipient_key, 1) ON CONFLICT(recipient_key) DO UPDATE SET seq = seq + 1; INSERT INTO conversation_versions (recipient_key, seq) VALUES (NEW.recipient_key, 1) ON CONFLICT(recipient_key) DO UPDATE SET seq = seq + 1; END;
      CREATE TRIGGER conversations_pair_delete AFTER DELETE ON sms_bindings BEGIN INSERT INTO conversation_versions (recipient_key, seq) VALUES (OLD.recipient_key, 1) ON CONFLICT(recipient_key) DO UPDATE SET seq = seq + 1; END;
      CREATE TRIGGER conversations_work_insert AFTER INSERT ON provider_work BEGIN INSERT INTO conversation_versions (recipient_key, seq) SELECT DISTINCT recipient_key, 1 FROM sms_bindings WHERE owner_subject = NEW.subject_id ON CONFLICT(recipient_key) DO UPDATE SET seq = seq + 1; END;
      CREATE TRIGGER conversations_work_update AFTER UPDATE OF subject_id, account_id, destination, settled, sent_wall ON provider_work WHEN NEW.subject_id IS NOT OLD.subject_id OR NEW.account_id IS NOT OLD.account_id OR NEW.destination IS NOT OLD.destination OR NEW.settled IS NOT OLD.settled OR NEW.sent_wall IS NOT OLD.sent_wall
      BEGIN INSERT INTO conversation_versions (recipient_key, seq) SELECT DISTINCT recipient_key, 1 FROM sms_bindings WHERE owner_subject = OLD.subject_id ON CONFLICT(recipient_key) DO UPDATE SET seq = seq + 1; INSERT INTO conversation_versions (recipient_key, seq) SELECT DISTINCT recipient_key, 1 FROM sms_bindings WHERE owner_subject = NEW.subject_id ON CONFLICT(recipient_key) DO UPDATE SET seq = seq + 1; END;
      CREATE TRIGGER conversations_work_delete AFTER DELETE ON provider_work BEGIN INSERT INTO conversation_versions (recipient_key, seq) SELECT DISTINCT recipient_key, 1 FROM sms_bindings WHERE owner_subject = OLD.subject_id ON CONFLICT(recipient_key) DO UPDATE SET seq = seq + 1; END;
      CREATE TRIGGER conversations_progress_insert AFTER INSERT ON track_progress BEGIN INSERT INTO conversation_versions (recipient_key, seq) SELECT DISTINCT recipient_key, 1 FROM sms_bindings WHERE owner_subject = NEW.subject_id ON CONFLICT(recipient_key) DO UPDATE SET seq = seq + 1; END;
      CREATE TRIGGER conversations_progress_update AFTER UPDATE OF subject_id, connection, destination_detail_id, invite_withdrawal, accepted_wall ON track_progress WHEN NEW.subject_id IS NOT OLD.subject_id OR NEW.connection IS NOT OLD.connection OR NEW.destination_detail_id IS NOT OLD.destination_detail_id OR NEW.invite_withdrawal IS NOT OLD.invite_withdrawal OR NEW.accepted_wall IS NOT OLD.accepted_wall
      BEGIN INSERT INTO conversation_versions (recipient_key, seq) SELECT DISTINCT recipient_key, 1 FROM sms_bindings WHERE owner_subject = OLD.subject_id ON CONFLICT(recipient_key) DO UPDATE SET seq = seq + 1; INSERT INTO conversation_versions (recipient_key, seq) SELECT DISTINCT recipient_key, 1 FROM sms_bindings WHERE owner_subject = NEW.subject_id ON CONFLICT(recipient_key) DO UPDATE SET seq = seq + 1; END;
      CREATE TRIGGER conversations_progress_delete AFTER DELETE ON track_progress BEGIN INSERT INTO conversation_versions (recipient_key, seq) SELECT DISTINCT recipient_key, 1 FROM sms_bindings WHERE owner_subject = OLD.subject_id ON CONFLICT(recipient_key) DO UPDATE SET seq = seq + 1; END;
      CREATE TRIGGER conversations_enrollment_update AFTER UPDATE OF id, campaign_id, person_id, ended ON enrollments WHEN NEW.id IS NOT OLD.id OR NEW.campaign_id IS NOT OLD.campaign_id OR NEW.person_id IS NOT OLD.person_id OR NEW.ended IS NOT OLD.ended BEGIN INSERT INTO conversation_versions (recipient_key, seq) SELECT DISTINCT recipient_key, 1 FROM sms_bindings WHERE owner_subject = NEW.id ON CONFLICT(recipient_key) DO UPDATE SET seq = seq + 1; END;
      CREATE TRIGGER conversations_test_run_update AFTER UPDATE OF id, campaign_id, linkedin_key, ended ON test_runs WHEN NEW.id IS NOT OLD.id OR NEW.campaign_id IS NOT OLD.campaign_id OR NEW.linkedin_key IS NOT OLD.linkedin_key OR NEW.ended IS NOT OLD.ended BEGIN INSERT INTO conversation_versions (recipient_key, seq) SELECT DISTINCT recipient_key, 1 FROM sms_bindings WHERE owner_subject = NEW.id ON CONFLICT(recipient_key) DO UPDATE SET seq = seq + 1; END;
      -- A reply belongs to the pair of the number it reached and the mobile it came from: its address is the destination.
      -- Every write to one moves it (the re-check of 8c85b2f, item 3): an insert, a change of a column the rule reads (its
      -- state, number, mobile or time), and a delete.
      CREATE TRIGGER conversations_reply_insert AFTER INSERT ON reply_events BEGIN INSERT INTO conversation_versions (recipient_key, seq) VALUES (NEW.address, 1) ON CONFLICT(recipient_key) DO UPDATE SET seq = seq + 1; END;
      CREATE TRIGGER conversations_reply_update AFTER UPDATE OF event_id, state, inbox, address, received_wall ON reply_events WHEN NEW.event_id IS NOT OLD.event_id OR NEW.state IS NOT OLD.state OR NEW.inbox IS NOT OLD.inbox OR NEW.address IS NOT OLD.address OR NEW.received_wall IS NOT OLD.received_wall BEGIN INSERT INTO conversation_versions (recipient_key, seq) VALUES (OLD.address, 1) ON CONFLICT(recipient_key) DO UPDATE SET seq = seq + 1; INSERT INTO conversation_versions (recipient_key, seq) VALUES (NEW.address, 1) ON CONFLICT(recipient_key) DO UPDATE SET seq = seq + 1; END;
      CREATE TRIGGER conversations_reply_delete AFTER DELETE ON reply_events BEGIN INSERT INTO conversation_versions (recipient_key, seq) VALUES (OLD.address, 1) ON CONFLICT(recipient_key) DO UPDATE SET seq = seq + 1; END;
    `,
  },
  {
    version: 24,
    name: "a LinkedIn track skipped as a missing channel records why when it finishes (ticket 24b, the re-check of 82cf16d)",
    sql: `
      -- Recorded once, at the skip; a skip stored before this has none, and its read says only what is known.
      ALTER TABLE track_progress ADD COLUMN skip_cause TEXT CHECK (skip_cause IS NULL OR skip_cause IN ('no_profile', 'not_a_member_profile', 'company_lead', 'replaced', 'removed_by_import', 'marked_bad'));
    `,
  },
  {
    version: 25,
    name: "message-request channels (ticket 25, ADR 0004 section 13): Instagram, its accounts, test accounts, sessions' kinds and fixed senders",
    // The CHECKs that list the social channels gain 'instagram' through `addChannel`, the one rebuild Facebook's migration
    // repeats; test_runs' contact CHECK gains its social contacts in the same rebuild. A message-request channel is a row of
    // `message_request_channels`, which the destination triggers read, so a later channel adds a row, not a trigger.
    rebuildsTables: true,
    sql: `
      CREATE TABLE message_request_channels (name TEXT PRIMARY KEY);
      INSERT INTO message_request_channels (name) VALUES ('instagram');
      -- A message-request account the session found unreachable, by channel and key (ADR 0004 13.4; ADR 0001: never cleared).
      CREATE TABLE social_destination_marks (
        channel TEXT NOT NULL REFERENCES message_request_channels(name),
        key TEXT NOT NULL,
        marked_wall INTEGER NOT NULL,
        PRIMARY KEY (channel, key)
      );
      -- The user's own test accounts on the message-request channels, by channel: {"instagram": {"value", "key"}} (ADR 0004 13.8).
      ALTER TABLE campaigns ADD COLUMN test_social TEXT CHECK (test_social IS NULL OR json_valid(test_social));
      -- What a session reports of itself (ADR 0004 13.5).
      ALTER TABLE sender_accounts ADD COLUMN social_kind TEXT CHECK (social_kind IS NULL OR social_kind IN ('personal', 'business'));
      -- A subject's fixed sender on each message-request channel (ADR 0004 13.5): {"instagram": "<account id>"}.
      ALTER TABLE enrollments ADD COLUMN social_senders TEXT CHECK (social_senders IS NULL OR json_valid(social_senders));
      ALTER TABLE test_runs ADD COLUMN social_senders TEXT CHECK (social_senders IS NULL OR json_valid(social_senders));
      -- A test run's own test accounts, by channel: {"instagram": {"value", "key", "bad"}}.
      ALTER TABLE test_runs ADD COLUMN social_contacts TEXT CHECK (social_contacts IS NULL OR json_valid(social_contacts));

      DROP TRIGGER track_progress_destination_detail_id_known_insert;
      DROP TRIGGER track_progress_destination_detail_id_known_update;
      DROP TRIGGER attempts_destination_detail_id_known_insert;
      DROP TRIGGER attempts_destination_detail_id_known_update;
      CREATE TRIGGER track_progress_destination_detail_id_known_insert BEFORE INSERT ON track_progress
      WHEN NOT (NEW.destination_detail_id IS NULL OR (CASE WHEN (SELECT kind FROM subjects WHERE id = NEW.subject_id) = 'test_run'
          THEN (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':email' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND email_key IS NOT NULL))
            OR (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':mobile' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND mobile_key IS NOT NULL))
            OR (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':linkedin' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND linkedin_key IS NOT NULL))
            OR EXISTS (SELECT 1 FROM message_request_channels m, test_runs r WHERE r.id = NEW.subject_id AND NEW.destination_detail_id = 'test:' || NEW.subject_id || ':' || m.name
              AND json_extract(r.social_contacts, '$.' || m.name || '.key') IS NOT NULL)
          WHEN NEW.destination_detail_id LIKE 'linkedin:%' THEN EXISTS (SELECT 1 FROM enrollments e WHERE e.id = NEW.subject_id AND e.person_id IS NOT NULL AND substr(NEW.destination_detail_id, 1, length(e.person_id) + 10) = 'linkedin:' || e.person_id || ':')
          WHEN EXISTS (SELECT 1 FROM message_request_channels m WHERE substr(NEW.destination_detail_id, 1, length(m.name) + 1) = m.name || ':')
            THEN EXISTS (SELECT 1 FROM enrollments e, message_request_channels m WHERE e.id = NEW.subject_id
              AND ((e.person_id IS NOT NULL AND substr(NEW.destination_detail_id, 1, length(m.name) + length(e.person_id) + 4) = m.name || ':p:' || e.person_id || ':')
                OR substr(NEW.destination_detail_id, 1, length(m.name) + length(e.company_id) + 4) = m.name || ':c:' || e.company_id || ':'))
          ELSE NEW.destination_detail_id NOT LIKE 'test:%' AND EXISTS (SELECT 1 FROM contact_details WHERE id = NEW.destination_detail_id) END))
      BEGIN SELECT RAISE(ABORT, 'track_progress.destination_detail_id names neither a contact detail of a lead nor a test contact of this test run'); END;
      CREATE TRIGGER track_progress_destination_detail_id_known_update BEFORE UPDATE OF destination_detail_id, subject_id ON track_progress
      WHEN NOT (NEW.destination_detail_id IS NULL OR (CASE WHEN (SELECT kind FROM subjects WHERE id = NEW.subject_id) = 'test_run'
          THEN (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':email' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND email_key IS NOT NULL))
            OR (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':mobile' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND mobile_key IS NOT NULL))
            OR (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':linkedin' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND linkedin_key IS NOT NULL))
            OR EXISTS (SELECT 1 FROM message_request_channels m, test_runs r WHERE r.id = NEW.subject_id AND NEW.destination_detail_id = 'test:' || NEW.subject_id || ':' || m.name
              AND json_extract(r.social_contacts, '$.' || m.name || '.key') IS NOT NULL)
          WHEN NEW.destination_detail_id LIKE 'linkedin:%' THEN EXISTS (SELECT 1 FROM enrollments e WHERE e.id = NEW.subject_id AND e.person_id IS NOT NULL AND substr(NEW.destination_detail_id, 1, length(e.person_id) + 10) = 'linkedin:' || e.person_id || ':')
          WHEN EXISTS (SELECT 1 FROM message_request_channels m WHERE substr(NEW.destination_detail_id, 1, length(m.name) + 1) = m.name || ':')
            THEN EXISTS (SELECT 1 FROM enrollments e, message_request_channels m WHERE e.id = NEW.subject_id
              AND ((e.person_id IS NOT NULL AND substr(NEW.destination_detail_id, 1, length(m.name) + length(e.person_id) + 4) = m.name || ':p:' || e.person_id || ':')
                OR substr(NEW.destination_detail_id, 1, length(m.name) + length(e.company_id) + 4) = m.name || ':c:' || e.company_id || ':'))
          ELSE NEW.destination_detail_id NOT LIKE 'test:%' AND EXISTS (SELECT 1 FROM contact_details WHERE id = NEW.destination_detail_id) END))
      BEGIN SELECT RAISE(ABORT, 'track_progress.destination_detail_id names neither a contact detail of a lead nor a test contact of this test run'); END;
      CREATE TRIGGER attempts_destination_detail_id_known_insert BEFORE INSERT ON attempts
      WHEN NOT ((CASE WHEN (SELECT kind FROM subjects WHERE id = NEW.subject_id) = 'test_run'
          THEN (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':email' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND email_key IS NOT NULL))
            OR (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':mobile' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND mobile_key IS NOT NULL))
            OR (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':linkedin' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND linkedin_key IS NOT NULL))
            OR EXISTS (SELECT 1 FROM message_request_channels m, test_runs r WHERE r.id = NEW.subject_id AND NEW.destination_detail_id = 'test:' || NEW.subject_id || ':' || m.name
              AND json_extract(r.social_contacts, '$.' || m.name || '.key') IS NOT NULL)
          WHEN NEW.destination_detail_id LIKE 'linkedin:%' THEN EXISTS (SELECT 1 FROM enrollments e WHERE e.id = NEW.subject_id AND e.person_id IS NOT NULL AND substr(NEW.destination_detail_id, 1, length(e.person_id) + 10) = 'linkedin:' || e.person_id || ':')
          WHEN EXISTS (SELECT 1 FROM message_request_channels m WHERE substr(NEW.destination_detail_id, 1, length(m.name) + 1) = m.name || ':')
            THEN EXISTS (SELECT 1 FROM enrollments e, message_request_channels m WHERE e.id = NEW.subject_id
              AND ((e.person_id IS NOT NULL AND substr(NEW.destination_detail_id, 1, length(m.name) + length(e.person_id) + 4) = m.name || ':p:' || e.person_id || ':')
                OR substr(NEW.destination_detail_id, 1, length(m.name) + length(e.company_id) + 4) = m.name || ':c:' || e.company_id || ':'))
          ELSE NEW.destination_detail_id NOT LIKE 'test:%' AND EXISTS (SELECT 1 FROM contact_details WHERE id = NEW.destination_detail_id) END))
      BEGIN SELECT RAISE(ABORT, 'attempts.destination_detail_id names neither a contact detail of a lead nor a test contact of this test run'); END;
      CREATE TRIGGER attempts_destination_detail_id_known_update BEFORE UPDATE OF destination_detail_id, subject_id ON attempts
      WHEN NOT ((CASE WHEN (SELECT kind FROM subjects WHERE id = NEW.subject_id) = 'test_run'
          THEN (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':email' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND email_key IS NOT NULL))
            OR (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':mobile' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND mobile_key IS NOT NULL))
            OR (NEW.destination_detail_id = 'test:' || NEW.subject_id || ':linkedin' AND EXISTS (SELECT 1 FROM test_runs WHERE id = NEW.subject_id AND linkedin_key IS NOT NULL))
            OR EXISTS (SELECT 1 FROM message_request_channels m, test_runs r WHERE r.id = NEW.subject_id AND NEW.destination_detail_id = 'test:' || NEW.subject_id || ':' || m.name
              AND json_extract(r.social_contacts, '$.' || m.name || '.key') IS NOT NULL)
          WHEN NEW.destination_detail_id LIKE 'linkedin:%' THEN EXISTS (SELECT 1 FROM enrollments e WHERE e.id = NEW.subject_id AND e.person_id IS NOT NULL AND substr(NEW.destination_detail_id, 1, length(e.person_id) + 10) = 'linkedin:' || e.person_id || ':')
          WHEN EXISTS (SELECT 1 FROM message_request_channels m WHERE substr(NEW.destination_detail_id, 1, length(m.name) + 1) = m.name || ':')
            THEN EXISTS (SELECT 1 FROM enrollments e, message_request_channels m WHERE e.id = NEW.subject_id
              AND ((e.person_id IS NOT NULL AND substr(NEW.destination_detail_id, 1, length(m.name) + length(e.person_id) + 4) = m.name || ':p:' || e.person_id || ':')
                OR substr(NEW.destination_detail_id, 1, length(m.name) + length(e.company_id) + 4) = m.name || ':c:' || e.company_id || ':'))
          ELSE NEW.destination_detail_id NOT LIKE 'test:%' AND EXISTS (SELECT 1 FROM contact_details WHERE id = NEW.destination_detail_id) END))
      BEGIN SELECT RAISE(ABORT, 'attempts.destination_detail_id names neither a contact detail of a lead nor a test contact of this test run'); END;
    `,
    data: (db) =>
      addChannel(db, "instagram", [{ from: "OR linkedin_key IS NOT NULL)", to: "OR linkedin_key IS NOT NULL OR social_contacts IS NOT NULL)" }]),
  },
  {
    version: 26,
    name: "Facebook as a message-request channel (ticket 26, ADR 0004 section 14): its row, and the social channel lists",
    // The second message-request channel: a row the destination triggers and the bad marks read, and the one `addChannel`
    // rebuild of every CHECK that lists the social channels. Nothing else in the schema names a message-request channel.
    rebuildsTables: true,
    sql: `
      INSERT INTO message_request_channels (name) VALUES ('facebook');
    `,
    data: (db) => addChannel(db, "facebook"),
  },
];

export function migrate(db: DatabaseSync, appliedAt: () => string, migrations: readonly Migration[] = MIGRATIONS): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => Number(r["version"]));
  const known = new Set(migrations.map((m) => m.version));
  const unknown = versions.filter((v) => !known.has(v));
  if (unknown.length > 0 || versions.some((v, i) => v !== i + 1)) {
    throw new Error(
      `This database's schema versions are ${versions.join(", ")}, which is not a prefix of this code's migrations (1 to ${migrations.length})` +
        (unknown.length > 0 ? `: it records a version this code does not know (${unknown.join(", ")})` : ": a version is missing") +
        ". It was written by other code; it is not migrated.",
    );
  }
  const current = versions.length;

  for (const migration of migrations) {
    if (migration.version <= current) continue;
    // A rebuild of tables other tables reference runs with foreign keys off (they cannot change inside a transaction).
    const keysWereOn = migration.rebuildsTables === true && Number(db.prepare("PRAGMA foreign_keys").get()?.["foreign_keys"]) === 1;
    if (keysWereOn) db.exec("PRAGMA foreign_keys = OFF");
    try {
      applyOne(db, migration, appliedAt);
    } finally {
      if (keysWereOn) db.exec("PRAGMA foreign_keys = ON");
    }
  }
}

function applyOne(db: DatabaseSync, migration: Migration, appliedAt: () => string): void {
  db.exec("BEGIN IMMEDIATE");
  // Another process starting on the same new database may have applied it while this one waited for the lock (ticket 20a).
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(migration.version) !== undefined) {
    db.exec("COMMIT");
    return;
  }
  try {
    db.exec(migration.sql);
    migration.data?.(db);
    if (migration.rebuildsTables === true) {
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length > 0) throw new Error(`migration ${migration.version} left ${broken.length} foreign key violations`);
    }
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(migration.version, migration.name, appliedAt());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
