import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import { UNDO_SINCE_18 } from "../../../test/support/undo-migrations.ts";
import type { CampaignDefinition } from "../../domain/sequence/definition.ts";
import type { LeadSearchResult, TestRunTab } from "../../shared/api.ts";
import { MIGRATIONS } from "./migrations.ts";

/**
 * Migration 18 (ticket 21): test runs, the campaign's test contacts and edit revision, and the three detail references
 * rebuilt without their foreign key, which triggers replace. A database written before it keeps its leads' progress and
 * their sends; afterwards a lead's row still names only a CRM detail, and a test run's only its own test contact.
 * Fictitious data only.
 */
const MIN = 60_000;
const H = 60 * MIN;
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
  tracks: [{ id: "e1", channel: "email", branch: "main", window: ALWAYS, steps: [email("s1", 0), email("s2", 1)], start: { kind: "entry" }, removed: false }],
};
const raw0 = (file: string, sql: string) => new DatabaseSync(file).prepare(sql).all().map((r) => String(r["name"]));
const harness = (databasePath: string, idPrefix = "att") => new EngineHarness({ start: MONDAY_9, databasePath, idPrefix, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });

/** Migration 17 (ticket 18) undone too: a database written before either, which upgrades through 17 and then 18. */
const UNDO_SINCE_17 = `
  ${UNDO_SINCE_18}
  DROP TABLE IF EXISTS bulk_requests;
  DROP INDEX IF EXISTS enrollments_by_person;
  DROP INDEX IF EXISTS enrollments_by_company;
  DELETE FROM schema_migrations WHERE version >= 17;
`;

describe("migration 18 on a database written before it", () => {
  test.each([
    ["at 17 (the integration branch with ticket 18)", UNDO_SINCE_18],
    ["at 16 (before tickets 18 and 21), through 17 then 18", UNDO_SINCE_17],
  ])("from a database %s: a running lead keeps its progress and sends its next step; the triggers refuse what the key refused, and a test runs", async (_, undo) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "migration-18-"));
    dirs.push(dir);
    const file = path.join(dir, "app.db");
    const before = harness(file);
    await before.tick();
    const { campaign } = await before.createCampaign("Before 17", { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })], people: [person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example" })] });
    await before.defineSequence(campaign.id, definition);
    expect((await before.launch(campaign.id)).status).toBe(200);
    await before.advanceTo(MONDAY_9 + H);
    expect(before.fake.deliveryLog.map((d) => d.stepId)).toEqual(["s1"]);
    await before.store.close();

    const db = new DatabaseSync(file);
    db.exec(undo);
    expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.["v"]).toBe(undo === UNDO_SINCE_18 ? 17 : 16);
    db.close();

    const after = harness(file, "after");
    after.clock = MONDAY_9 + 2 * H;
    await after.tick();
    const versions = new DatabaseSync(file).prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => Number(r["version"]));
    expect(versions).toEqual(MIGRATIONS.map((m) => m.version));
    expect(raw0(file, "SELECT name FROM sqlite_master WHERE name IN ('bulk_requests', 'test_runs', 'engine_subjects') ORDER BY name")).toEqual(["bulk_requests", "engine_subjects", "test_runs"]);
    const lead = (await after.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows[0]?.enrollments[0]?.id ?? "";
    expect((await after.progress(lead)).status).toBe("active");

    // The triggers: a lead's attempt naming a detail that does not exist, or a test contact's id, is refused.
    const raw = (after.store.engine as unknown as { db: DatabaseSync }).db;
    const insert = (detail: string) => () =>
      raw.prepare("UPDATE attempts SET destination_detail_id = ? WHERE subject_id = ?").run(detail, lead);
    expect(insert("no-such-detail")).toThrow(/names neither a contact detail of a lead nor a test contact/);
    expect(insert(`test:${lead}:email`)).toThrow(/names neither a contact detail of a lead nor a test contact/);

    // A campaign upgraded with its revision tested by nothing: the warning shows, and a test after the upgrade runs.
    expect((await after.request<TestRunTab>("GET", `/api/campaigns/${campaign.id}/test-runs`)).body.noTestSinceEdit).toBe(true);
    await after.request("PUT", `/api/campaigns/${campaign.id}/test-contacts`, { email: "alex.own@personal-mail.example", mobile: "" });
    const tab = (await after.request<TestRunTab>("GET", `/api/campaigns/${campaign.id}/test-runs`)).body;
    expect((await after.request("POST", `/api/campaigns/${campaign.id}/test-runs`, { requestId: "r1", renderAs: lead, expect: { definitionVersion: tab.definitionVersion } })).status).toBe(200);
    // The reopened harness's fake provider reports the first send through a lookup, a settling period later.
    await after.advanceTo(after.clock + H);
    expect(after.fake.deliveryLog.filter((d) => d.destination === "alex.own@personal-mail.example").map((d) => d.stepId)).toEqual(["s1", "s2"]);
    expect((await after.request<TestRunTab>("GET", `/api/campaigns/${campaign.id}/test-runs`)).body.noTestSinceEdit).toBe(false);
    await after.store.close();
  });
});
