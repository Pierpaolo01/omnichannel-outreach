import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import type { ApiError } from "../../shared/api.ts";

/**
 * Migration 13 (each editing session's newest accepted save; ADR 0003 1.1.1) on a database written
 * before it (council on aebeb80, item 1): the session that wrote last is known from the campaign row,
 * and so is what it stored. The backfill keeps the hash of that stored definition, so a retry of the
 * writer's save after another page replaced it is still answered `replaced`, never a conflict, on an
 * upgraded database. Fictitious data only.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const body = (subject: string, save: { session: string; seq: number; base: number }) => ({
  timezone: "Europe/London",
  emailPool: [],
  tracks: [
    {
      id: "t1",
      channel: "email",
      branch: "main",
      window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })),
      steps: [{ id: "s1", waitDays: 0, subject, body: "A note.", threading: "new_subject" }],
    },
  ],
  save,
});

/** Takes a database back to just before migration 13: no sessions' saves, and none of migration 14's call fields (ticket 15a). */
function beforeMigration13(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`
    DROP TABLE definition_saves;
    DROP INDEX call_tasks_open_callbacks;
    ALTER TABLE call_attempts DROP COLUMN declined_path;
    ALTER TABLE call_attempts DROP COLUMN redial;
    ALTER TABLE call_attempts DROP COLUMN callback_at;
    ALTER TABLE call_tasks DROP COLUMN reckoned_through;
    DELETE FROM schema_migrations WHERE version > 12;
  `);
  db.close();
}

describe("migration 13 on a database written before it (council on aebeb80, item 1)", () => {
  test("A's save accepted, the application upgrades, B saves over it, A retries its save: replaced, not a conflict", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "outreach-migration-"));
    dirs.push(dir);
    const file = path.join(dir, "outreach.sqlite");
    const harness = () => new EngineHarness({ start: Date.parse("2026-11-02T09:00:00Z"), databasePath: file, accounts: [] });

    const before = harness();
    const { campaign } = await before.createCampaign("Before 13", { businesses: [], people: [] });
    expect((await before.request("PUT", `/api/campaigns/${campaign.id}/sequence`, body("A one", { session: "A", seq: 1, base: 0 }))).status).toBe(200);
    await before.store.close();
    beforeMigration13(file);

    const after = harness();
    expect((await after.request("PUT", `/api/campaigns/${campaign.id}/sequence`, body("B on top", { session: "B", seq: 1, base: 1 }))).status).toBe(200);
    const retry = await after.request<ApiError>("PUT", `/api/campaigns/${campaign.id}/sequence`, body("A one", { session: "A", seq: 1, base: 0 }));
    expect([retry.status, retry.body.error.code]).toEqual([409, "replaced"]);
    await after.store.close();
  });
});

describe("the sessions' saves are kept only while the campaign can be edited (council on aebeb80, item 7)", () => {
  test("launch deletes the campaign's rows in its own transaction; another campaign's stay", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "outreach-migration-"));
    dirs.push(dir);
    const file = path.join(dir, "outreach.sqlite");
    const h = new EngineHarness({ start: Date.parse("2026-11-02T09:00:00Z"), databasePath: file, accounts: [] });
    const { campaign: one } = await h.createCampaign("One", { businesses: [], people: [] });
    const { campaign: two } = await h.createCampaign("Two", { businesses: [], people: [] });
    const call = { id: "p1", channel: "call", branch: "main", window: [{ day: 1, start: 9, end: 17 }], steps: [{ id: "c1", waitDays: 0, subject: "", body: "", threading: "new_subject" }] };
    for (const [id, session] of [[one.id, "A"], [two.id, "B"]] as const) {
      expect((await h.request("PUT", `/api/campaigns/${id}/sequence`, { timezone: "Europe/London", emailPool: [], tracks: [call], save: { session, seq: 1, base: 0 } })).status).toBe(200);
    }
    const rows = () => new DatabaseSync(file).prepare("SELECT campaign_id FROM definition_saves ORDER BY campaign_id").all().map((r) => String(r["campaign_id"]));
    expect(rows()).toEqual([one.id, two.id].sort());
    expect((await h.launch(one.id)).status).toBe(200);
    expect(rows()).toEqual([two.id]);
    await h.store.close();
  });
});
