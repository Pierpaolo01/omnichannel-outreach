import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { migrate, MIGRATIONS } from "./migrations.ts";

/**
 * Migration 25 (ticket 27, ADR 0004 13.10) on a database at 24, the integration tip's schema, holding the rows the tip's own
 * code wrote (`test/fixtures/upgrade/tip-9ae8c38-linkedin-skip.sql`, a LinkedIn track and its session). After it, nothing
 * reads differently: no track has an InMail state, no work is an InMail, no session has a report. Fictitious data only.
 */
/** This migration's number: the InMail fallback's, wherever the sequence put it at merge time. */
const INMAIL = MIGRATIONS.find((m) => m.name.startsWith("the LinkedIn InMail fallback"))!.version;
const ROWS = readFileSync(path.join(import.meta.dirname, "../../../test/fixtures/upgrade/tip-9ae8c38-linkedin-skip.sql"), "utf8").split("\n").filter((l) => l.trim() !== "");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the InMail fallback's migration on a database just before it", () => {
  test("existing rows read as before: no InMail state, no InMail work, no InMail report; the first sync stores a session's report", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "migration-25-"));
    dirs.push(dir);
    const file = path.join(dir, "app.db");
    const tip = new DatabaseSync(file);
    migrate(tip, () => "2026-11-02T09:00:00.000Z", MIGRATIONS.filter((m) => m.version < INMAIL));
    tip.exec("PRAGMA foreign_keys = OFF");
    for (const row of ROWS) tip.exec(row);
    tip.exec("PRAGMA foreign_keys = ON");
    tip.close();
    const h = new EngineHarness({
      start: Date.parse("2026-11-02T10:00:00Z"),
      databasePath: file,
      idPrefix: "after-25",
      accounts: [{ id: "inbox-a", capacity: 50, gapMs: 60_000, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
      linkedin: { sessions: [{ id: "li-session-1", gapMs: 60_000, k: 1, healthy: true, resetZone: "Europe/London", inmail: { plan: "sales_navigator", credits: 3 } }] },
    });
    const db = (h.store.engine as unknown as { db: DatabaseSync }).db;
    expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: MIGRATIONS.at(-1)?.version });
    expect(db.prepare("SELECT COUNT(*) AS n FROM track_progress WHERE inmail IS NOT NULL OR inmail_session IS NOT NULL").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM provider_work WHERE inmail <> 0").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE inmail <> 0").get()).toEqual({ n: 0 });
    await h.tick();
    expect(db.prepare("SELECT inmail_plan, inmail_credits FROM sender_accounts WHERE id = 'linkedin:li-session-1'").get()).toEqual({ inmail_plan: "sales_navigator", inmail_credits: 3 });
    await h.store.close();
  });

  test("a track's InMail state only moves forward, by an update or by the store's replace; InMail work is message work", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, () => "2026-11-02T09:00:00.000Z");
    db.exec("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = OFF;");
    db.exec("DROP TRIGGER IF EXISTS track_progress_destination_detail_id_known_insert");
    db.exec("INSERT INTO track_progress (subject_id, track_id, inmail) VALUES ('s', 't', 'chosen')");
    db.exec("UPDATE track_progress SET inmail = 'sent'");
    expect(() => db.exec("UPDATE track_progress SET inmail = 'chosen'")).toThrow(/only moves forward/);
    expect(() => db.exec("INSERT OR REPLACE INTO track_progress (subject_id, track_id, inmail) VALUES ('s', 't', NULL)")).toThrow(/only moves forward/);
    expect(() => db.exec("INSERT INTO provider_work (key, subject_id, track_id, step_id, account_id, destination, kind, inmail) VALUES ('k', 's', 't', 'x', 'a', 'd', 'invite', 1)")).toThrow(/CHECK/);
    db.close();
  });
});
