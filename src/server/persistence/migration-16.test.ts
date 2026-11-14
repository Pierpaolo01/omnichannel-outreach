import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition } from "../../domain/sequence/definition.ts";
import type { CampaignDetail, EnrollmentRead, LeadSearchResult } from "../../shared/api.ts";

/**
 * Migration 16 (ticket 17a): the hold history and the controls' request ids. A database written before it
 * holds no pause (nothing set one): after the upgrade its running leads keep running, and a pause, a resume and
 * a stop recorded afterwards work. Fictitious data only.
 */
const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
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
  tracks: [{ id: "e1", channel: "email", branch: "main", window: ALWAYS, steps: [email("s1", 0), email("s2", 2)], start: { kind: "entry" }, removed: false }],
};
const harness = (databasePath: string) => new EngineHarness({ start: MONDAY_9, databasePath, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });

describe("migration 16 on a database written before it", () => {
  test("running leads keep running after the upgrade, and the controls work", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "migration-16-"));
    dirs.push(dir);
    const file = path.join(dir, "app.db");
    const before = harness(file);
    await before.tick();
    const { campaign } = await before.createCampaign("Before 16", { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })], people: [person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example" })] });
    await before.defineSequence(campaign.id, definition);
    expect((await before.launch(campaign.id)).status).toBe(200);
    await before.advanceTo(MONDAY_9 + H);
    expect(before.fake.deliveryLog.map((d) => d.stepId)).toEqual(["s1"]);
    await before.store.close();

    const db = new DatabaseSync(file);
    db.exec(`
      DROP TABLE hold_intervals;
      DROP TABLE control_requests;
      DELETE FROM schema_migrations WHERE version >= 16;
    `);
    db.close();

    const after = harness(file);
    after.clock = MONDAY_9 + 2 * H;
    await after.tick();
    const id = (await after.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows[0]?.enrollments[0]?.id ?? "";
    const read = (await after.request<EnrollmentRead>("GET", `/api/enrollments/${id}`)).body;
    expect(read.status).toBe("active");
    expect(read.controls.find((c) => c.action === "pause")).toMatchObject({ allowed: true });
    expect((await after.request<CampaignDetail>("GET", `/api/campaigns/${campaign.id}`)).body.pause).toEqual({ paused: false, pausedSince: null });
    expect((await after.request("POST", `/api/campaigns/${campaign.id}/pause`, { requestId: "p" })).status).toBe(200);
    await after.advanceTo(MONDAY_9 + 2 * H + 3 * DAY);
    expect((await after.request("POST", `/api/campaigns/${campaign.id}/resume`, { requestId: "r" })).status).toBe(200);
    expect((await after.request("POST", `/api/enrollments/${id}/controls`, { requestId: "s", action: "stop" })).status).toBe(200);
    const versions = new DatabaseSync(file).prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => Number(r["version"]));
    expect(versions.at(-1)).toBe(16);
    await after.store.close();
  });
});
