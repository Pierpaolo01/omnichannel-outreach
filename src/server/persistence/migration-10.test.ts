import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition } from "../../domain/sequence/definition.ts";
import type { ActivityView, LeadSearchResult } from "../../shared/api.ts";

/**
 * Migration 10 (ticket 12c's bounce events) on a database with a bounce observed before it: the
 * known limit the coordinator accepted (re-check B14, ADR 0003 "Bounce events"). The old store kept
 * no bounce event, and a bounce cannot be rebuilt honestly from a bad address or a failed track,
 * because another campaign can mark an address bad. So after the upgrade Activity invents no bounce:
 * it shows the send, the track's ending on a bad address, and the lead's ending, as stored.
 * Fictitious data only.
 */
const H = 3_600_000;
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const definition: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["inbox-a"],
  tracks: [
    {
      id: "t1",
      channel: "email",
      branch: "main",
      window: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 })),
      steps: [
        { id: "s1", waitDays: 0, subject: "Hello", body: "A note.", threading: "new_subject", removed: false },
        { id: "s2", waitDays: 3, subject: "", body: "Following up.", threading: "continue_thread", removed: false },
      ],
      start: { kind: "entry" },
      removed: false,
    },
  ],
};

const harness = (databasePath: string) =>
  new EngineHarness({ start: MONDAY_9 - H, databasePath, accounts: [{ id: "inbox-a", capacity: 50, gapMs: 60_000, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });

/** Takes a database back to just before migration 10: no bounce events table, no save-rule columns (11), no call tables (12, ticket 14a), no sessions' saves (13). */
function beforeMigration10(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`
    DROP TABLE definition_saves;
    DROP TABLE notes;
    DROP TABLE call_attempts;
    DROP TABLE call_tasks;
    DROP TABLE bounce_events;
    ALTER TABLE campaigns DROP COLUMN definition_session;
    ALTER TABLE campaigns DROP COLUMN definition_seq;
    DROP TABLE IF EXISTS hold_intervals;
    DROP TABLE IF EXISTS control_requests;
    DELETE FROM schema_migrations WHERE version > 9;
  `);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'bounce_events'").all()).toEqual([]);
  db.close();
}

describe("migration 10 on a database with a bounce observed before it (re-check B14)", () => {
  test("Activity invents no bounce: it shows the send, the ending on a bad address and the lead's ending", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "outreach-migration-"));
    dirs.push(dir);
    const file = path.join(dir, "outreach.sqlite");

    const before = harness(file);
    await before.tick();
    const { campaign } = await before.createCampaign("Before 10", {
      businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })],
      people: [person({ person_id: "p1", business_id: "b1", full_name: "Sam Lee", email: "sam@harbour.example" })],
    });
    await before.defineSequence(campaign.id, definition);
    before.fake.bouncing.add("sam@harbour.example");
    before.clock = MONDAY_9;
    expect((await before.launch(campaign.id)).status).toBe(200);
    await before.advanceTo(MONDAY_9 + 3 * H);
    const sam = (await before.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows[0]!.id;
    const kinds = async (h: EngineHarness) => (await h.request<ActivityView>("GET", `/api/people/${sam}/activity`)).body.entries.map((e) => e.kind);
    // With the event stored, the bounce shows.
    expect(await kinds(before)).toEqual(["ended", "bounced", "sent"]);
    await before.store.close();
    beforeMigration10(file);

    const after = harness(file);
    after.clock = MONDAY_9 + 4 * H;
    const entries = (await after.request<ActivityView>("GET", `/api/people/${sam}/activity`)).body.entries;
    expect(entries.map((e) => e.kind)).toEqual(["ended", "address_bad", "sent"]);
    expect(entries.filter((e) => e.kind === "bounced")).toEqual([]);
    expect(entries[0]).toMatchObject({ kind: "ended", status: "finished_no_usable_channel" });
    expect(entries[1]).toMatchObject({ kind: "address_bad", to: "sam@harbour.example" });
    // The upgrade itself ran 10 and 11 (and 12, ticket 14a's call tables, 13, pull request 49's sessions' saves, and 14, ticket 15a's redial, callback and skip-limit fields, 15 and 16), and later bounces are recorded again.
    const versions = new DatabaseSync(file).prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => Number(r["version"]));
    expect(versions.filter((v) => v >= 9)).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
    await after.store.close();
  });
});
