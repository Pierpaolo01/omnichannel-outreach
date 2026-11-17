import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { UNDO_SINCE_18, UNDO_21 } from "../../../test/support/undo-migrations.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { FakeAccount } from "../../../test/support/fake-email-port.ts";
import type { CampaignDefinition } from "../../domain/sequence/definition.ts";
import type { LeadSearchResult, NeedsAttention, TestRunTab } from "../../shared/api.ts";
import { migrate, MIGRATIONS, type Migration } from "./migrations.ts";
import { openDatabase } from "./sqlite-store.ts";

/**
 * Migration 20: a sender account's capacity may be 0 ("no room on its reset day"). SQLite cannot change a CHECK, so the
 * table is rebuilt while provider work and attempts (a lead's and a test run's) reference it, through the one mechanism
 * every rebuilding migration uses (`rebuildsTables`). Fictitious data only.
 */
const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const TEST_EMAIL = "alex.own@personal-mail.example";
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
  smsPool: [],
  tracks: [{ id: "e1", channel: "email", branch: "main", window: ALWAYS, steps: [email("s1", 0), email("s2", 1)], start: { kind: "entry" }, removed: false }],
};
/**
 * The current build's database taken back to 19, the integration tip (`9fc5c2b`): migration 20's rebuild undone, with
 * the old CHECK and no daily limit. The current code cannot write a database at 19 itself: it writes the daily limit.
 */
const UNDO_20 = `
  PRAGMA foreign_keys = OFF;
  CREATE TABLE sender_accounts_old (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
    label TEXT NOT NULL,
    capacity INTEGER NOT NULL CHECK (capacity > 0),
    gap_ms INTEGER CHECK (gap_ms IS NULL OR gap_ms > 0),
    k INTEGER NOT NULL CHECK (k > 0),
    next_slot_at INTEGER NOT NULL DEFAULT 0,
    healthy INTEGER NOT NULL DEFAULT 1,
    wait_until INTEGER,
    wait_reason TEXT,
    backoff_ms INTEGER NOT NULL DEFAULT 0,
    reset_zone TEXT NOT NULL DEFAULT 'UTC',
    problem TEXT
  );
  INSERT INTO sender_accounts_old SELECT id, channel, label, capacity, gap_ms, k, next_slot_at, healthy, wait_until, wait_reason, backoff_ms, reset_zone, problem FROM sender_accounts;
  DROP TABLE sender_accounts;
  ALTER TABLE sender_accounts_old RENAME TO sender_accounts;
  PRAGMA foreign_keys = ON;
  DELETE FROM schema_migrations WHERE version >= 20;
`;
/**
 * Taken back to 17, the integration tip before ticket 21 (pull request 60): 20 undone, then 19 (data only, safe to run
 * again) and 18 as ticket 21's own test undoes them. The current code cannot write a database at 17: it reads ticket
 * 21's tables.
 */
const UNDO_SINCE_18_WITH_20 = `${UNDO_20} ${UNDO_SINCE_18}`;
const schemaOf = (db: DatabaseSync, name: string) => String(db.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(name)?.["sql"] ?? "");
const names = (db: DatabaseSync, type: string) => db.prepare("SELECT name FROM sqlite_schema WHERE type = ? ORDER BY name").all(type).map((r) => String(r["name"]));
const count = (db: DatabaseSync, table: string) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"] ?? 0);
const rawOf = (h: EngineHarness) => (h.store.engine as unknown as { db: DatabaseSync }).db;

/**
 * A database written by an older build (`migrations`): a lead whose first email went from inbox-a, and, when the build
 * has ticket 21, a test run whose two emails went from it too. Then the current build opens it while other senders have
 * used inbox-a up for the day: the account is stored with no room, the lead's next email waits for capacity, and it goes
 * the next day. Returns what each check needs.
 */
async function upgrade(undo: string, withTestRun: boolean) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "migration-20-"));
  dirs.push(dir);
  const file = path.join(dir, "app.db");
  const inbox: FakeAccount = { id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" };

  const before = new EngineHarness({ start: MONDAY_9, databasePath: file, accounts: [inbox] });
  await before.tick();
  const { campaign } = await before.createCampaign("Before 20", { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })], people: [person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example" })] });
  await before.defineSequence(campaign.id, definition);
  expect((await before.launch(campaign.id)).status).toBe(200);
  await before.advanceTo(MONDAY_9 + H);
  const lead = (await before.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows[0]?.enrollments[0]?.id ?? "";
  if (withTestRun) {
    await before.request("PUT", `/api/campaigns/${campaign.id}/test-contacts`, { email: TEST_EMAIL, mobile: "" });
    const tab = (await before.request<TestRunTab>("GET", `/api/campaigns/${campaign.id}/test-runs`)).body;
    expect((await before.request("POST", `/api/campaigns/${campaign.id}/test-runs`, { requestId: "r1", renderAs: lead, expect: { definitionVersion: tab.definitionVersion } })).status).toBe(200);
    await before.advanceTo(before.clock + H);
    expect(before.fake.deliveryLog.filter((d) => d.destination === TEST_EMAIL).map((d) => d.stepId)).toEqual(["s1", "s2"]);
  }
  expect(before.fake.deliveryLog.filter((d) => d.destination === "pat@harbour.example").map((d) => d.stepId)).toEqual(["s1"]);
  await before.store.close();

  const old = new DatabaseSync(file);
  old.exec(UNDO_21 + undo);
  expect(schemaOf(old, "sender_accounts")).toContain("CHECK (capacity > 0)");
  const kept = {
    accounts: old.prepare("SELECT * FROM sender_accounts").all(),
    work: count(old, "provider_work"),
    attempts: old.prepare("SELECT id, subject_id, account_id FROM attempts ORDER BY id").all(),
    triggers: names(old, "trigger"),
    views: names(old, "view"),
  };
  old.close();

  // Tuesday, after the upgrade: other senders have used inbox-a up for the day.
  const after = new EngineHarness({ start: MONDAY_9 + DAY + 9 * H, databasePath: file, idPrefix: "after", accounts: [inbox] });
  after.fake.usedUpUntil.set("inbox-a", MONDAY_9 + 2 * DAY - 9 * H);
  await after.tick();
  const waiting = (await after.request<NeedsAttention>("GET", "/api/needs-attention")).body.waitingForCapacity;
  expect(waiting.map((w) => [w.enrollmentId, w.stepId, w.accountIds])).toEqual([[lead, "s2", ["inbox-a"]]]);
  const foreignKeysAfter = Number(rawOf(after).prepare("PRAGMA foreign_keys").get()?.["foreign_keys"]);
  await after.store.close();

  const upgraded = new DatabaseSync(file);
  const result = {
    kept,
    foreignKeysAfter,
    versions: upgraded.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => Number(r["version"])),
    accountsSchema: schemaOf(upgraded, "sender_accounts"),
    attemptsSchema: schemaOf(upgraded, "attempts"),
    workSchema: schemaOf(upgraded, "provider_work"),
    violations: upgraded.prepare("PRAGMA foreign_key_check").all(),
    accounts: upgraded.prepare("SELECT * FROM sender_accounts").all(),
    work: count(upgraded, "provider_work"),
    attempts: upgraded.prepare("SELECT id, subject_id, account_id FROM attempts ORDER BY id").all(),
    triggers: names(upgraded, "trigger"),
    views: names(upgraded, "view"),
  };
  upgraded.close();

  // Wednesday the inbox has room again, and the lead's s2 goes.
  const later = new EngineHarness({ start: MONDAY_9 + 2 * DAY + 9 * H, databasePath: file, idPrefix: "later", accounts: [inbox] });
  await later.advanceTo(MONDAY_9 + 2 * DAY + 10 * H);
  expect(later.fake.deliveryLog.filter((d) => d.destination === "pat@harbour.example").map((d) => d.stepId)).toEqual(["s2"]);
  await later.store.close();
  return result;
}

function expectKept(r: Awaited<ReturnType<typeof upgrade>>): void {
  expect(r.versions).toEqual(MIGRATIONS.map((m) => m.version));
  expect(r.accountsSchema).toContain("CHECK (capacity >= 0)");
  // The rebuilt table is still the one provider work and attempts reference, and every reference resolves.
  expect(r.workSchema).toContain("REFERENCES sender_accounts(id)");
  expect(r.attemptsSchema).toContain("REFERENCES sender_accounts(id)");
  expect(r.violations).toEqual([]);
  expect(r.foreignKeysAfter).toBe(1);
  expect(r.work).toBe(r.kept.work);
  expect(r.attempts).toEqual(r.kept.attempts);
  // Every column of the account is kept; the sync after the upgrade set today's room to 0 and stored the daily limit.
  // Migration 26 adds a social session's kind (ticket 25), none for an inbox.
  expect(r.accounts).toEqual(r.kept.accounts.map((a) => ({ ...a, capacity: 0, daily_limit: 50, social_kind: null })));
}

/** The triggers migrations after 20 add, read from their own SQL (23: a fixed channel, the conversations' version). */
const LATER_TRIGGERS = MIGRATIONS.filter((m) => m.version > 20)
  .flatMap((m) => [...m.sql.matchAll(/CREATE TRIGGER ([a-z_]+)/g)].map((x) => x[1]!))
  .filter((name) => !/destination_detail_id|number_detail_id/.test(name))
  .sort();

describe("migration 20 on a database an older build created", () => {
  test("at 19 (the integration tip): the test run's attempts and ticket 21's triggers and view are kept, and inbox-a is stored with no room", async () => {
    const r = await upgrade(UNDO_20, true);
    expect(r.kept.attempts.filter((a) => a["subject_id"] !== r.kept.attempts[0]?.["subject_id"])).not.toEqual([]);
    expect(r.kept.triggers.length).toBeGreaterThan(0);
    expectKept(r);
    // Every trigger kept; migration 23 adds its two (a pair's and an account's channel never change).
    expect(r.triggers.filter((t) => !LATER_TRIGGERS.includes(t))).toEqual(r.kept.triggers);
    expect(r.triggers.filter((t) => LATER_TRIGGERS.includes(t)).sort()).toEqual(LATER_TRIGGERS);
    expect(r.views).toEqual(r.kept.views);
  });

  test("at 17 (the tip before ticket 21): 18, 19 and 20 apply in a row, two of them rebuilding tables", async () => {
    const r = await upgrade(UNDO_SINCE_18_WITH_20, false);
    expect(r.kept.views).not.toContain("engine_subjects");
    expect(r.kept.triggers).toEqual([]);
    expectKept(r);
    expect(r.triggers.length).toBeGreaterThan(0);
  });

  test("a capacity or daily limit below 0 is refused by the store", () => {
    const db = openDatabase(":memory:");
    migrate(db, at);
    const insert = (capacity: number, dailyLimit: number) =>
      db.prepare("INSERT INTO sender_accounts (id, channel, label, capacity, k, daily_limit) VALUES (?, 'email', 'x', ?, 1, ?)").run(`a${capacity}/${dailyLimit}`, capacity, dailyLimit);
    insert(0, 0);
    expect(() => insert(-1, 0)).toThrow("CHECK constraint failed");
    expect(() => insert(0, -1)).toThrow("CHECK constraint failed");
  });
});

describe("a migration that rebuilds a table others reference", () => {
  const parentAndChild: Migration = {
    version: 1,
    name: "parent and child",
    sql: "CREATE TABLE parent (id TEXT PRIMARY KEY); CREATE TABLE child (parent_id TEXT NOT NULL REFERENCES parent(id)); INSERT INTO parent VALUES ('p'); INSERT INTO child VALUES ('p');",
  };
  const rebuild = (version: number, keepRows: boolean): Migration => ({
    version,
    name: "rebuild parent",
    rebuildsTables: true,
    sql: `CREATE TABLE parent_v${version} (id TEXT PRIMARY KEY); ${keepRows ? `INSERT INTO parent_v${version} SELECT id FROM parent;` : ""} DROP TABLE parent; ALTER TABLE parent_v${version} RENAME TO parent;`,
  });
  const foreignKeys = (db: DatabaseSync) => Number(db.prepare("PRAGMA foreign_keys").get()?.["foreign_keys"]);

  test("two in a row run with foreign keys off and leave them on", () => {
    const db = openDatabase(":memory:");
    migrate(db, at, [parentAndChild, rebuild(2, true), rebuild(3, true)]);
    expect(foreignKeys(db)).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => db.prepare("INSERT INTO child VALUES ('missing')").run()).toThrow("FOREIGN KEY constraint failed");
  });

  test("leave foreign keys off on a connection that had them off", () => {
    const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
    migrate(db, at, [parentAndChild, rebuild(2, true)]);
    expect(foreignKeys(db)).toBe(0);
  });

  test("is refused and rolled back when it would leave a reference to a row that no longer exists, and foreign keys stay on", () => {
    const db = openDatabase(":memory:");
    migrate(db, at, [parentAndChild]);
    expect(() => migrate(db, at, [parentAndChild, rebuild(2, false)])).toThrow("foreign key violations");
    expect(db.prepare("SELECT version FROM schema_migrations").all().map((r) => Number(r["version"]))).toEqual([1]);
    expect(db.prepare("SELECT id FROM parent").all().map((r) => r["id"])).toEqual(["p"]);
    expect(foreignKeys(db)).toBe(1);
  });
});
