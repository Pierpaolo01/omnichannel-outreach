import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition } from "../../domain/sequence/definition.ts";
import type { CallsView, CallTaskView, EnrollmentProgress, LeadSearchResult } from "../../shared/api.ts";

/**
 * Migration 14 (ticket 15a, numbered after pull request 49's 13): call records gain whether the user asked for a redial and the time a
 * prospect asked to be called back, and call tasks how far their skip limit has been judged. A database written before it holds calls logged by ticket 14,
 * which had neither: after the upgrade they read as no redial and no callback time, and the lead's
 * open call carries on under the new rules. Fictitious data only.
 */
const H = 3_600_000;
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const call = (id: string) => ({ id: `p${id}`, channel: "call" as const, branch: "main" as const, window: ALWAYS, steps: [{ id: `c${id}`, waitDays: 0, subject: "", body: "", threading: "new_subject" as const, removed: false }], start: { kind: "entry" as const }, removed: false });
const definition: CampaignDefinition = { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: [], smsPool: [], callScript: "", tracks: [call("1"), call("2")] };

const harness = (databasePath: string) => new EngineHarness({ start: MONDAY_9, databasePath, accounts: [] });

describe("migration 14 on a database with calls logged before it", () => {
  test("earlier calls read as no redial and no callback time, and a callback can be logged after the upgrade", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "migration-14-"));
    dirs.push(dir);
    const file = path.join(dir, "app.db");
    const before = harness(file);
    expect((await before.request("PUT", "/api/call-settings", { dailyCapacity: 10, userZone: "Europe/London" })).status).toBe(200);
    const { campaign } = await before.createCampaign("Before 14", { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })], people: [person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", direct_phone: "+442079460111" })] });
    await before.defineSequence(campaign.id, definition);
    expect((await before.launch(campaign.id)).status).toBe(200);
    const [first, second] = (await before.request<CallsView>("GET", "/api/calls")).body.readyNow;
    const number = (await before.request<CallTaskView>("GET", `/api/call-tasks/${first?.taskId}`)).body.numbers[0]?.detailId;
    expect((await before.request("POST", `/api/call-tasks/${first?.taskId}/outcome`, { requestId: "r1", outcome: "no_answer", numberId: number, note: "Rang out." })).status).toBe(200);
    await before.store.close();

    // Back to just before migration 14.
    const db = new DatabaseSync(file);
    db.exec(`
      DROP INDEX call_tasks_open_callbacks;
      ALTER TABLE call_attempts DROP COLUMN declined_path;
      ALTER TABLE call_attempts DROP COLUMN redial;
      ALTER TABLE call_attempts DROP COLUMN callback_at;
      ALTER TABLE call_tasks DROP COLUMN reckoned_through;
      DROP TABLE IF EXISTS hold_intervals;
      DROP TABLE IF EXISTS control_requests;
      ALTER TABLE provider_work DROP COLUMN withdraw_wanted;
      ALTER TABLE provider_work DROP COLUMN withdraw_last_wall;
      ALTER TABLE provider_work DROP COLUMN went_wall;
      DELETE FROM schema_migrations WHERE version >= 14;
    `);
    db.close();

    const after = harness(file);
    after.clock = MONDAY_9 + H;
    await after.tick();
    const enrollment = (await after.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows[0]?.enrollments[0]?.id ?? "";
    const progress = (await after.request<EnrollmentProgress>("GET", `/api/enrollments/${enrollment}`)).body;
    expect(progress.tracks.find((t) => t.trackId === "p1")?.steps[0]?.calls).toEqual([expect.objectContaining({ outcome: "no_answer", note: "Rang out.", redial: false, callbackAt: null })]);
    // An open task is judged from its placement: no day of it had been judged before the skip limit existed.
    const open = (await after.store.engine.subject(enrollment, after.clock))?.callTasks.find((t) => t.open);
    expect(open?.reckonedThrough).toBe(open?.placedWall);
    expect((await after.request("POST", `/api/call-tasks/${second?.taskId}/outcome`, { requestId: "r2", outcome: "callback_requested", callbackAt: "2026-11-03T10:00:00Z", numberId: number })).status).toBe(200);
    expect((await after.request<EnrollmentProgress>("GET", `/api/enrollments/${enrollment}`)).body.status).toBe("callback_scheduled");
    await after.store.close();
  });
});
