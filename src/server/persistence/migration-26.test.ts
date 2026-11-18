import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { addChannel } from "./add-channel.ts";
import { migrate, MIGRATIONS } from "./migrations.ts";

/**
 * Facebook's migration (ticket 26, ADR 0004 section 14) on a database at the migration before it, holding Instagram rows:
 * the rows of `test/fixtures/upgrade/tip-9ae8c38-linkedin-skip.sql` (written at version 24) migrated to that version, then an Instagram session, its pair, a
 * reply marked on Instagram, the stopping reply's channel, a bad mark and a track's Instagram destination. Every row keeps
 * every column; the CHECKs take Facebook beside Instagram; the destination triggers and the bad marks take a Facebook
 * account. Fictitious data only.
 */
/**
 * This migration's number, found by its own entry, and the one before it: renumbered when another branch lands a migration
 * first (delivery workflow, "Migration numbers"), the test follows with no edit.
 */
const THIS = MIGRATIONS.find((m) => m.name.startsWith("Facebook as a message-request channel"))!.version;
const BEFORE = THIS - 1;
/** The version the fixture's rows were written at, by the integration tip of ticket 24b. */
const FIXTURE_VERSION = 24;

const ROWS = readFileSync(path.join(import.meta.dirname, "../../../test/fixtures/upgrade/tip-9ae8c38-linkedin-skip.sql"), "utf8").split("\n").filter((l) => l.trim() !== "");

function tipDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrate(db, () => "2026-11-02T09:00:00.000Z", MIGRATIONS.filter((m) => m.version <= FIXTURE_VERSION));
  db.exec("PRAGMA foreign_keys = OFF");
  for (const row of ROWS) db.exec(row);
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, () => "2026-11-17T09:00:00.000Z", MIGRATIONS.filter((m) => m.version <= BEFORE));
  const e = lead(db);
  db.exec(`
    INSERT INTO sender_accounts (id, channel, label, capacity, k, daily_limit, social_kind) VALUES ('instagram:s-a', 'instagram', 'Simulated session', 0, 1, 0, 'business');
    INSERT INTO sms_bindings (sender_number, recipient_key, owner_subject, created_at, channel) VALUES ('instagram:s-a', 'https://www.instagram.com/example_harbour', '${e.id}', 1793613600000, 'instagram');
    INSERT INTO replies (provider_ref, subject_id, channel, at_wall) VALUES ('instagram:mark:r-1', '${e.id}', 'instagram', 1793613600000);
    UPDATE enrollments SET stop_reply_channel = 'instagram', stop_reply_at = 1793613600000 WHERE id = '${e.id}';
    INSERT INTO social_destination_marks (channel, key, marked_wall) VALUES ('instagram', 'https://www.instagram.com/example_gone', 1793613600000);
    UPDATE track_progress SET destination_detail_id = 'instagram:c:${e.company_id}:https://www.instagram.com/example_harbour' WHERE subject_id = '${e.id}' AND rowid = (SELECT MIN(rowid) FROM track_progress WHERE subject_id = '${e.id}');
  `);
  return db;
}

const lead = (db: DatabaseSync) => db.prepare("SELECT id, person_id, company_id FROM enrollments LIMIT 1").get() as { id: string; person_id: string | null; company_id: string };
const tables = (db: DatabaseSync) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => String(r["name"]));
const columns = (db: DatabaseSync, table: string) => db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((r) => String(r["name"]));
const rowsOf = (db: DatabaseSync, table: string, cols: readonly string[]) => db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM ${table} ORDER BY rowid`).all();
const objects = (db: DatabaseSync, type: string) => db.prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name").all(type).map((r) => String(r["name"]));
const upgrade = (db: DatabaseSync) => migrate(db, () => "2026-11-18T09:00:00.000Z", MIGRATIONS.filter((m) => m.version <= THIS));

describe(`Facebook's migration (${THIS}) on a database at version ${BEFORE} with Instagram rows`, () => {
  test("every row keeps every column it had, foreign keys hold, nothing is lost, and the version is recorded", () => {
    const db = tipDatabase();
    const before = new Map(tables(db).map((t) => [t, { cols: columns(db, t), rows: rowsOf(db, t, columns(db, t)) }]));
    const kept = { triggers: objects(db, "trigger"), views: objects(db, "view"), indexes: objects(db, "index") };
    upgrade(db);
    expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: THIS });
    for (const [table, was] of before) {
      if (table === "schema_migrations" || table === "message_request_channels") continue;
      expect(rowsOf(db, table, was.cols), table).toEqual(was.rows);
    }
    expect(db.prepare("SELECT name FROM message_request_channels ORDER BY name").all().map((r) => r["name"])).toEqual(["facebook", "instagram"]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect({ triggers: objects(db, "trigger"), views: objects(db, "view"), indexes: objects(db, "index") }).toEqual(kept);
  });

  test("every channel list takes Facebook beside Instagram and refuses what it refused", () => {
    const db = tipDatabase();
    upgrade(db);
    const e = lead(db);
    db.prepare("INSERT INTO sender_accounts (id, channel, label, capacity, k, daily_limit, social_kind) VALUES ('facebook:s-a', 'facebook', 'x', 0, 1, 0, 'business')").run();
    db.prepare("INSERT INTO sms_bindings (sender_number, recipient_key, owner_subject, created_at, channel) VALUES ('facebook:s-a', 'https://www.facebook.com/example.harbour', ?, 1, 'facebook')").run(e.id);
    db.prepare("INSERT INTO replies (provider_ref, subject_id, channel, at_wall) VALUES ('facebook:mark:r-2', ?, 'facebook', 2)").run(e.id);
    db.prepare("UPDATE enrollments SET stop_reply_channel = 'facebook' WHERE id = ?").run(e.id);
    db.prepare("INSERT INTO social_destination_marks (channel, key, marked_wall) VALUES ('facebook', 'https://www.facebook.com/example.gone', 1)").run();
    expect(() => db.prepare("INSERT INTO sender_accounts (id, channel, label, capacity, k, daily_limit) VALUES ('tiktok:s1', 'tiktok', 'x', 0, 1, 0)").run()).toThrow();
    expect(() => db.prepare("INSERT INTO sender_accounts (id, channel, label, capacity, k, daily_limit, social_kind) VALUES ('facebook:s2', 'facebook', 'x', 0, 1, 0, 'robot')").run()).toThrow();
    expect(() => db.prepare("UPDATE sender_accounts SET channel = 'instagram' WHERE id = 'facebook:s-a'").run()).toThrow();
    expect(() => db.prepare("INSERT INTO social_destination_marks (channel, key, marked_wall) VALUES ('linkedin', 'https://www.linkedin.com/in/x', 1)").run()).toThrow();
  });

  test("the destination triggers take a Facebook account of the lead's own person or company, and refuse any other", () => {
    const db = tipDatabase();
    upgrade(db);
    const e = lead(db);
    const set = (detail: string) => db.prepare("UPDATE track_progress SET destination_detail_id = ? WHERE subject_id = ?").run(detail, e.id);
    expect(() => set(`facebook:c:${e.company_id}:https://www.facebook.com/example.harbour`)).not.toThrow();
    if (e.person_id !== null) expect(() => set(`facebook:p:${e.person_id}:https://www.facebook.com/profile.php?id=100000000000001`)).not.toThrow();
    expect(() => set("facebook:c:another-company:https://www.facebook.com/example.harbour")).toThrow();
    expect(() => set("facebook:p:another-person:https://www.facebook.com/example.pat")).toThrow();
    expect(() => set(`instagram:c:${e.company_id}:https://www.instagram.com/example_harbour`)).not.toThrow();
  });

  test("a second addChannel of Facebook changes nothing", () => {
    const db = tipDatabase();
    upgrade(db);
    const schema = () => db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
    const once = schema();
    db.exec("PRAGMA foreign_keys = OFF");
    addChannel(db, "facebook");
    db.exec("PRAGMA foreign_keys = ON");
    expect(schema()).toEqual(once);
  });
});
