import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { FakeAccount } from "../../../test/support/fake-email-port.ts";
import type { CampaignDefinition } from "../../domain/sequence/definition.ts";
import type { LeadSearchResult, NeedsAttention } from "../../shared/api.ts";
import { migrate, MIGRATIONS, type Migration } from "./migrations.ts";
import { openDatabase } from "./sqlite-store.ts";

/**
 * Migration 18: a sender account's capacity may be 0 ("no room on its reset day"). SQLite cannot change a CHECK, so the
 * table is rebuilt while provider work and attempts reference it. Fictitious data only.
 */
const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const at = () => "2026-11-15T00:00:00.000Z";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const email = (id: string, waitDays: number) => ({ id, waitDays, subject: `Subject ${id}`, body: "A note for {{company}}.", threading: "new_subject" as const, removed: false });
const definition: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["inbox-a"],
  tracks: [{ id: "e1", channel: "email", branch: "main", window: ALWAYS, steps: [email("s1", 0), email("s2", 1)], start: { kind: "entry" }, removed: false }],
};
const TIP = MIGRATIONS.filter((m) => m.version < 18);
const schemaOf = (db: DatabaseSync, table: string) => String(db.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(table)?.["sql"] ?? "");
const count = (db: DatabaseSync, table: string) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"] ?? 0);

describe("migration 18 on a database the integration branch's tip creates", () => {
  test("its accounts, provider work and attempts are kept, an account with no room is stored, and its lead's next email waits for capacity", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "migration-18-"));
    dirs.push(dir);
    const file = path.join(dir, "app.db");
    const inbox: FakeAccount = { id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" };

    const before = new EngineHarness({ start: MONDAY_9, databasePath: file, migrations: TIP, accounts: [inbox] });
    await before.tick();
    const { campaign } = await before.createCampaign("Before 18", { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })], people: [person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example" })] });
    await before.defineSequence(campaign.id, definition);
    expect((await before.launch(campaign.id)).status).toBe(200);
    await before.advanceTo(MONDAY_9 + H);
    expect(before.fake.deliveryLog.map((d) => d.stepId)).toEqual(["s1"]);
    await before.store.close();

    const old = new DatabaseSync(file);
    expect(schemaOf(old, "sender_accounts")).toContain("CHECK (capacity > 0)");
    const kept = { accounts: old.prepare("SELECT * FROM sender_accounts").all(), work: count(old, "provider_work"), attempts: count(old, "attempts") };
    expect(kept.work).toBeGreaterThan(0);
    old.close();

    // After the upgrade, outside sends use the inbox up for Tuesday: it reports no room.
    inbox.capacity = 0;
    const after = new EngineHarness({ start: MONDAY_9 + DAY + 9 * H, databasePath: file, idPrefix: "after", accounts: [inbox] });
    await after.tick();
    const lead = (await after.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows[0]?.enrollments[0]?.id ?? "";
    const waiting = (await after.request<NeedsAttention>("GET", "/api/needs-attention")).body.waitingForCapacity;
    expect(waiting.map((w) => [w.enrollmentId, w.stepId, w.accountIds])).toEqual([[lead, "s2", ["inbox-a"]]]);
    await after.store.close();

    const upgraded = new DatabaseSync(file);
    expect(upgraded.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => Number(r["version"])).at(-1)).toBe(18);
    expect(schemaOf(upgraded, "sender_accounts")).toContain("CHECK (capacity >= 0)");
    // The rebuilt table is still the one provider work and attempts reference, and every reference resolves.
    expect(schemaOf(upgraded, "provider_work")).toContain("REFERENCES sender_accounts(id)");
    expect(upgraded.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(count(upgraded, "provider_work")).toBe(kept.work);
    expect(count(upgraded, "attempts")).toBe(kept.attempts);
    // Every column of the account is kept; the sync after the upgrade changed only its capacity.
    expect(upgraded.prepare("SELECT * FROM sender_accounts").all()).toEqual(kept.accounts.map((a) => ({ ...a, capacity: 0 })));
    upgraded.close();

    // Wednesday the inbox has room again, and s2 goes.
    inbox.capacity = 50;
    const later = new EngineHarness({ start: MONDAY_9 + 2 * DAY + 9 * H, databasePath: file, idPrefix: "later", accounts: [inbox] });
    await later.advanceTo(MONDAY_9 + 2 * DAY + 10 * H);
    expect(later.fake.deliveryLog.map((d) => d.stepId)).toEqual(["s2"]);
    await later.store.close();
  });

  test("a capacity below 0 is still refused by the store", () => {
    const db = openDatabase(":memory:");
    migrate(db, at);
    const insert = (capacity: number) => db.prepare("INSERT INTO sender_accounts (id, channel, label, capacity, k) VALUES (?, 'email', 'x', ?, 1)").run(`a${capacity}`, capacity);
    insert(0);
    expect(() => insert(-1)).toThrow("CHECK constraint failed");
  });
});

describe("a migration that rebuilds a table others reference", () => {
  const parentAndChild: Migration = {
    version: 1,
    name: "parent and child",
    sql: "CREATE TABLE parent (id TEXT PRIMARY KEY); CREATE TABLE child (parent_id TEXT NOT NULL REFERENCES parent(id)); INSERT INTO parent VALUES ('p'); INSERT INTO child VALUES ('p');",
  };
  const rebuild = (keepRows: boolean): Migration => ({
    version: 2,
    name: "rebuild parent",
    rebuildsReferencedTable: true,
    sql: `CREATE TABLE parent_v2 (id TEXT PRIMARY KEY); ${keepRows ? "INSERT INTO parent_v2 SELECT id FROM parent;" : ""} DROP TABLE parent; ALTER TABLE parent_v2 RENAME TO parent;`,
  });
  const foreignKeys = (db: DatabaseSync) => Number(db.prepare("PRAGMA foreign_keys").get()?.["foreign_keys"]);

  test("runs with foreign keys off and leaves them on", () => {
    const db = openDatabase(":memory:");
    migrate(db, at, [parentAndChild, rebuild(true)]);
    expect(foreignKeys(db)).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => db.prepare("INSERT INTO child VALUES ('missing')").run()).toThrow("FOREIGN KEY constraint failed");
  });

  test("is refused and rolled back when it would leave a reference to a row that no longer exists", () => {
    const db = openDatabase(":memory:");
    migrate(db, at, [parentAndChild]);
    expect(() => migrate(db, at, [parentAndChild, rebuild(false)])).toThrow("Migration 2 would leave a reference");
    expect(db.prepare("SELECT version FROM schema_migrations").all().map((r) => Number(r["version"]))).toEqual([1]);
    expect(db.prepare("SELECT id FROM parent").all().map((r) => r["id"])).toEqual(["p"]);
    expect(foreignKeys(db)).toBe(1);
  });
});
