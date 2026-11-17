import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, migrate } from "../../src/server/persistence/migrations.ts";

/**
 * What later migrations added, undone, for a test that takes a database back to before an earlier migration and lets
 * the application upgrade it again (migration-N.test.ts). Its tables rebuilt by 18 keep their shape when 18 runs again.
 * Migration 17 (ticket 18) is written to run again as it is (IF NOT EXISTS), so it needs no undoing.
 */
export const UNDO_SINCE_18 = `
  DROP VIEW IF EXISTS engine_subjects;
  DROP TRIGGER IF EXISTS track_progress_destination_detail_id_known_insert;
  DROP TRIGGER IF EXISTS track_progress_destination_detail_id_known_update;
  DROP TRIGGER IF EXISTS attempts_destination_detail_id_known_insert;
  DROP TRIGGER IF EXISTS attempts_destination_detail_id_known_update;
  DROP TRIGGER IF EXISTS call_attempts_number_detail_id_known_insert;
  DROP TRIGGER IF EXISTS call_attempts_number_detail_id_known_update;
  DROP TABLE IF EXISTS test_runs;
  ALTER TABLE campaigns DROP COLUMN test_email;
  ALTER TABLE campaigns DROP COLUMN test_mobile;
  ALTER TABLE campaigns DROP COLUMN edit_version;
  DELETE FROM schema_migrations WHERE version >= 18;
`;

/**
 * Migration 22 undone (ticket 24, ADR 0004): the columns and tables it added, dropped. The four tables it rebuilt need no
 * undoing: a later run of 22 rebuilds them from the columns it names. Run first by every undo that goes back past 22.
 */
/**
 * Migration 25 undone (ticket 25): the schema taken back to what migrations 1 to 24 make, computed from them, never
 * written by hand. Every table whose text 26 changed is rebuilt from its text before 26 with the columns it had then; the
 * tables 26 added are dropped; every view and trigger is made again as it was. Run first by every undo that goes back past 26.
 */
export const UNDO_25 = undoTo(24);

/** Migration 24 undone (ticket 24b): a LinkedIn skip's recorded cause, dropped. Run first by every undo that goes back past 24. */
export const UNDO_24 = `${UNDO_25}
  ALTER TABLE track_progress DROP COLUMN skip_cause;
  DELETE FROM schema_migrations WHERE version >= 24;
`;
export const UNDO_23 = `${UNDO_24}
  DROP TRIGGER sms_bindings_channel_fixed;
  DROP TRIGGER sender_accounts_channel_fixed;
  DROP TRIGGER sms_bindings_channel_fixed_on_replace;
  DROP TRIGGER sender_accounts_channel_fixed_on_replace;
  DROP TRIGGER conversations_pair_insert;
  DROP TRIGGER conversations_pair_update;
  DROP TRIGGER conversations_pair_delete;
  DROP TRIGGER conversations_work_insert;
  DROP TRIGGER conversations_work_update;
  DROP TRIGGER conversations_work_delete;
  DROP TRIGGER conversations_progress_insert;
  DROP TRIGGER conversations_progress_update;
  DROP TRIGGER conversations_progress_delete;
  DROP TRIGGER conversations_enrollment_update;
  DROP TRIGGER conversations_test_run_update;
  DROP TRIGGER conversations_reply_insert;
  DROP TRIGGER conversations_reply_update;
  DROP TRIGGER conversations_reply_delete;
  DROP INDEX sms_bindings_by_owner;
  DROP TABLE conversation_versions;
  ALTER TABLE sms_bindings DROP COLUMN channel;
  DELETE FROM schema_migrations WHERE version >= 23;
`;
export const UNDO_22 = `${UNDO_23}
  ALTER TABLE track_progress DROP COLUMN connection;
  ALTER TABLE track_progress DROP COLUMN connected_at;
  ALTER TABLE track_progress DROP COLUMN connected_wall;
  ALTER TABLE track_progress DROP COLUMN accepted_wall;
  ALTER TABLE track_progress DROP COLUMN accept_by;
  ALTER TABLE track_progress DROP COLUMN accept_by_wall;
  ALTER TABLE track_progress DROP COLUMN accept_by_zone;
  ALTER TABLE track_progress DROP COLUMN accept_by_days;
  ALTER TABLE track_progress DROP COLUMN invite_withdrawal;
  ALTER TABLE track_progress DROP COLUMN invite_withdrawal_last_wall;
  ALTER TABLE track_progress DROP COLUMN invite_withdrawal_unknowns;
  ALTER TABLE track_progress DROP COLUMN connection_checks;
  ALTER TABLE provider_work DROP COLUMN kind;
  ALTER TABLE provider_work DROP COLUMN note;
  ALTER TABLE attempts DROP COLUMN action;
  ALTER TABLE campaigns DROP COLUMN test_linkedin;
  DROP TABLE social_allowances;
  DROP TABLE linkedin_profile_marks;
  DELETE FROM schema_migrations WHERE version >= 22;
`;

/**
 * Migration 21 undone (question Q7 answered): a skip's cause and the unsent mark, dropped. Run first by a test that takes
 * a database back to before an earlier migration, so that migration and every one after it, 21 included, apply again.
 */
export const UNDO_21 = `${UNDO_22}
  ALTER TABLE track_progress DROP COLUMN conversation_owners;
  ALTER TABLE sms_bindings DROP COLUMN unsent;
  DELETE FROM schema_migrations WHERE version >= 21;
`;

/** The schema objects a list of migrations makes, by name. */
function schemaAfter(count: number): Map<string, { readonly type: string; readonly table: string; readonly sql: string }> {
  const db = new DatabaseSync(":memory:");
  migrate(db, () => "undo", MIGRATIONS.slice(0, count));
  const objects = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name <> 'schema_migrations' ORDER BY rowid").all();
  db.close();
  return new Map(objects.map((o) => [String(o["name"]), { type: String(o["type"]), table: String(o["tbl_name"]), sql: String(o["sql"]) }]));
}

/** SQL that takes a database of the full schema back to what the first `count` migrations make (tables, views, triggers). */
function undoTo(count: number): string {
  const before = schemaAfter(count);
  const now = schemaAfter(MIGRATIONS.length);
  const columns = (sql: string) => {
    const db = new DatabaseSync(":memory:");
    db.exec(sql);
    const name = /^CREATE TABLE "?(\w+)"?/.exec(sql)?.[1] ?? "";
    const names = db.prepare(`SELECT name FROM pragma_table_info('${name}')`).all().map((r) => String(r["name"]));
    db.close();
    return names;
  };
  const statements: string[] = ["PRAGMA foreign_keys = OFF;"];
  for (const [name, o] of now) if (o.type === "trigger") statements.push(`DROP TRIGGER ${name};`);
  for (const [name, o] of now) if (o.type === "view") statements.push(`DROP VIEW ${name};`);
  for (const [name, o] of now) {
    if (o.type !== "table") continue;
    const was = before.get(name);
    if (!was) statements.push(`DROP TABLE ${name};`);
    else if (was.sql !== o.sql) {
      const kept = columns(was.sql).join(", ");
      statements.push(
        `${was.sql.replace(/^CREATE TABLE "?\w+"?/, `CREATE TABLE ${name}__undo`)};`,
        `INSERT INTO ${name}__undo (${kept}) SELECT ${kept} FROM ${name} ORDER BY rowid;`,
        `DROP TABLE ${name};`,
        `ALTER TABLE ${name}__undo RENAME TO ${name};`,
        ...[...before.values()].filter((i) => i.type === "index" && i.table === name).map((i) => `${i.sql};`),
      );
    }
  }
  for (const o of before.values()) if (o.type === "view") statements.push(`${o.sql};`);
  for (const o of before.values()) if (o.type === "trigger") statements.push(`${o.sql};`);
  statements.push("PRAGMA foreign_keys = ON;", `DELETE FROM schema_migrations WHERE version > ${count};`);
  return statements.join("\n");
}
