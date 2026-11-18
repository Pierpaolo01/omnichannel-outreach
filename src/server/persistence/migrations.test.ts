import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { migrate, MIGRATIONS } from "./migrations.ts";

/**
 * Standing checks on the migration list (added after ticket 13a, whose migration had first been
 * numbered past a gap): `migrate` applies every migration above the highest recorded version, so a
 * gap would never be filled on a database that had moved past it.
 */

const at = () => "2026-11-13T00:00:00.000Z";
const recorded = (db: DatabaseSync) => db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r["version"]);

describe("the migration list", () => {
  test("its versions are exactly 1 to N, in order, with no gap or repeat", () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });

  test("a new database receives every migration, and migrating again changes nothing", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, at);
    migrate(db, at);
    expect(recorded(db)).toEqual(MIGRATIONS.map((m) => m.version));
  });

  test("a database whose recorded versions are a prefix of the list receives the rest", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const m of MIGRATIONS.slice(0, 3)) {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, at());
    }
    migrate(db, at);
    expect(recorded(db)).toEqual(MIGRATIONS.map((m) => m.version));
  });

  test("a database with a gap in its recorded versions, or a version this code does not know, is refused", () => {
    const withVersions = (versions: number[]) => {
      const db = new DatabaseSync(":memory:");
      db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
      for (const v of versions) db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(v, `m${v}`, at());
      return db;
    };
    const n = MIGRATIONS.length;
    expect(() => migrate(withVersions([1, 2, 4]), at)).toThrow("This database's schema versions are 1, 2, 4");
    expect(() => migrate(withVersions([...MIGRATIONS.map((m) => m.version), n + 2]), at)).toThrow(`a version this code does not know (${n + 2})`);
  });
});
