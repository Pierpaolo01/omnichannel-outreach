import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import type { EnrollmentRead } from "../../shared/api.ts";
import { migrate, MIGRATIONS } from "./migrations.ts";

/**
 * Migration 24 on a database the integration tip (`9ae8c38`) wrote with its own code (ticket 24b, the re-check of 82cf16d):
 * a LinkedIn track skipped as a missing channel for a company-page address, recorded before skip causes were kept. The
 * tip's rows are `test/fixtures/upgrade/tip-9ae8c38-linkedin-skip.sql`, dumped from that database as statements readable in
 * a diff; its schema is migrations 1 to 23. Opened by this branch, the skip has no recorded cause, and its read says only
 * what is known. Fictitious data only.
 */
const ROWS = readFileSync(path.join(import.meta.dirname, "../../../test/fixtures/upgrade/tip-9ae8c38-linkedin-skip.sql"), "utf8").split("\n").filter((l) => l.trim() !== "");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("migration 24 on the integration tip's own database", () => {
  test("a skip recorded before causes were kept reads as unrecorded, never as a cause guessed from today's import", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "migration-24-"));
    dirs.push(dir);
    const file = path.join(dir, "app.db");
    const tip = new DatabaseSync(file);
    migrate(tip, () => "2026-11-02T09:00:00.000Z", MIGRATIONS.filter((m) => m.version <= 23));
    tip.exec("PRAGMA foreign_keys = OFF");
    for (const row of ROWS) tip.exec(row);
    tip.exec("PRAGMA foreign_keys = ON");
    expect(tip.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    tip.close();

    const h = new EngineHarness({
      start: Date.parse("2026-11-02T10:00:00Z"),
      databasePath: file,
      idPrefix: "after-24",
      accounts: [{ id: "inbox-a", capacity: 50, gapMs: 60_000, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
      linkedin: { sessions: [{ id: "li-session-1", gapMs: 60_000, k: 1, healthy: true, resetZone: "Europe/London" }] },
    });
    const db = (h.store.engine as unknown as { db: DatabaseSync }).db;
    expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: 25 });
    expect(db.prepare("SELECT track_id, finish_reason, skip_cause FROM track_progress WHERE track_id = 'li'").all()).toEqual([{ track_id: "li", finish_reason: "skipped_missing_channel", skip_cause: null }]);
    await h.tick();
    const id = (db.prepare("SELECT id FROM enrollments").get() as { id: string }).id;
    const view = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${id}`)).body.tracks.find((t) => t.trackId === "li")?.linkedin;
    expect(view?.skipCause).toBe("unrecorded");
    // The column takes only the causes the domain records.
    expect(() => db.exec("UPDATE track_progress SET skip_cause = 'guessed' WHERE track_id = 'li'")).toThrow();
  });
});
