import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { addChannel } from "./add-channel.ts";
import { migrate, MIGRATIONS } from "./migrations.ts";

/**
 * Migration 25 (ticket 25, ADR 0004 section 13) on a database the integration tip wrote with its own code: the rows of
 * `test/fixtures/upgrade/tip-9ae8c38-linkedin-skip.sql` (a campaign, a lead, a LinkedIn track, provider work and a pair) on
 * migrations 1 to 24, the integration tip's schema. Every row of every table survives the rebuilds with every column it had;
 * the CHECKs take Instagram; the destination triggers take a message-request account's id for its own lead and refuse any
 * other. Fictitious data only.
 */
const ROWS = readFileSync(path.join(import.meta.dirname, "../../../test/fixtures/upgrade/tip-9ae8c38-linkedin-skip.sql"), "utf8").split("\n").filter((l) => l.trim() !== "");

function tipDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrate(db, () => "2026-11-02T09:00:00.000Z", MIGRATIONS.filter((m) => m.version <= 24));
  db.exec("PRAGMA foreign_keys = OFF");
  for (const row of ROWS) db.exec(row);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

const tables = (db: DatabaseSync) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => String(r["name"]));
const columns = (db: DatabaseSync, table: string) => db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((r) => String(r["name"]));
const rowsOf = (db: DatabaseSync, table: string, cols: readonly string[]) => db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM ${table} ORDER BY rowid`).all();

describe("migration 25 on the integration tip's own database", () => {
  test("every row keeps every column it had, foreign keys hold, and the version is recorded", () => {
    const db = tipDatabase();
    const before = new Map(tables(db).map((t) => [t, { cols: columns(db, t), rows: rowsOf(db, t, columns(db, t)) }]));
    const triggersBefore = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all().map((r) => String(r["name"]));
    migrate(db, () => "2026-11-17T09:00:00.000Z");
    expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: 25 });
    for (const [table, was] of before) {
      if (table === "schema_migrations") continue;
      expect(rowsOf(db, table, was.cols), table).toEqual(was.rows);
    }
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    // No trigger is lost by the rebuilds: each is made again from its stored text.
    const triggersAfter = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all().map((r) => String(r["name"]));
    expect(triggersAfter).toEqual(triggersBefore);
    // The view both subject tables feed is back too.
    expect(db.prepare("SELECT COUNT(*) AS n FROM engine_subjects").get()).toEqual({ n: before.get("enrollments")!.rows.length + before.get("test_runs")!.rows.length });
  });

  test("the channel lists take Instagram, and nothing else changes in what they refuse", () => {
    const db = tipDatabase();
    migrate(db, () => "2026-11-17T09:00:00.000Z");
    db.prepare("INSERT INTO sender_accounts (id, channel, label, capacity, k, daily_limit, social_kind) VALUES ('instagram:s1', 'instagram', 'x', 0, 1, 0, 'business')").run();
    expect(() => db.prepare("INSERT INTO sender_accounts (id, channel, label, capacity, k, daily_limit) VALUES ('tiktok:s1', 'tiktok', 'x', 0, 1, 0)").run()).toThrow();
    expect(() => db.prepare("INSERT INTO sender_accounts (id, channel, label, capacity, k, daily_limit, social_kind) VALUES ('instagram:s2', 'instagram', 'x', 0, 1, 0, 'robot')").run()).toThrow();
    // An account's channel still never changes (migration 23's trigger, made again after the rebuild).
    expect(() => db.prepare("UPDATE sender_accounts SET channel = 'linkedin' WHERE id = 'instagram:s1'").run()).toThrow();
    // A bad mark names a message-request channel only.
    db.prepare("INSERT INTO social_destination_marks (channel, key, marked_wall) VALUES ('instagram', 'https://www.instagram.com/example_x', 1)").run();
    expect(() => db.prepare("INSERT INTO social_destination_marks (channel, key, marked_wall) VALUES ('linkedin', 'https://www.linkedin.com/in/x', 1)").run()).toThrow();
  });

  test("the destination triggers take an account of the lead's own person or company on a message-request channel, and refuse any other", () => {
    const db = tipDatabase();
    migrate(db, () => "2026-11-17T09:00:00.000Z");
    const e = db.prepare("SELECT id, person_id, company_id FROM enrollments LIMIT 1").get() as { id: string; person_id: string | null; company_id: string };
    const insert = (detail: string) => db.prepare("UPDATE track_progress SET destination_detail_id = ? WHERE subject_id = ?").run(detail, e.id);
    expect(() => insert(`instagram:c:${e.company_id}:https://www.instagram.com/example_harbour`)).not.toThrow();
    if (e.person_id !== null) expect(() => insert(`instagram:p:${e.person_id}:https://www.instagram.com/example_pat`)).not.toThrow();
    expect(() => insert("instagram:c:another-company:https://www.instagram.com/example_harbour")).toThrow();
    expect(() => insert("instagram:p:another-person:https://www.instagram.com/example_pat")).toThrow();
    expect(() => insert("tiktok:c:x:y")).toThrow();
  });

  test("addChannel adds a channel once: a second call changes nothing", () => {
    const db = tipDatabase();
    migrate(db, () => "2026-11-17T09:00:00.000Z");
    const schema = () => db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
    const once = schema();
    db.exec("PRAGMA foreign_keys = OFF");
    addChannel(db, "instagram");
    db.exec("PRAGMA foreign_keys = ON");
    expect(schema()).toEqual(once);
  });
});

describe("migration numbers across builds (the review of f2824d4, item 1)", () => {
  test("a database at the tip's version, migrated by this branch and then by a later build with one more migration, runs every migration once and in order", () => {
    const db = tipDatabase();
    const applied: number[] = [];
    const counting = MIGRATIONS.map((m) => ({ ...m, data: (d: DatabaseSync) => (applied.push(m.version), m.data?.(d)) }));
    migrate(db, () => "2026-11-17T09:00:00.000Z", counting);
    const later = { version: MIGRATIONS.length + 1, name: "a later build's migration", sql: "CREATE TABLE later_build_marker (id INTEGER PRIMARY KEY);", data: () => void applied.push(MIGRATIONS.length + 1) };
    migrate(db, () => "2026-11-18T09:00:00.000Z", [...counting, later]);
    // This branch's migrations once each, then the later build's, and the later one's change is in the schema.
    expect(applied).toEqual([...MIGRATIONS.filter((m) => m.version > 24).map((m) => m.version), MIGRATIONS.length + 1]);
    expect(db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => Number(r["version"]))).toEqual(Array.from({ length: MIGRATIONS.length + 1 }, (_, i) => i + 1));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'later_build_marker'").get()).toEqual({ name: "later_build_marker" });
  });

  test("no migration is empty: a number is never reserved by one that changes nothing (delivery workflow, \"Standing checks\")", () => {
    expect(MIGRATIONS.filter((m) => m.sql.trim() === "" && m.data === undefined).map((m) => m.version)).toEqual([]);
  });
});
