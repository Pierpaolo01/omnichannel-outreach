import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import { applyReply } from "../../domain/sequence/progress.ts";
import type { CampaignDefinition } from "../../domain/sequence/definition.ts";
import type { LeadSearchResult } from "../../shared/api.ts";

/**
 * Migration 9 (ticket 13a) on a database the merged integration branch wrote before it. The
 * database is produced by the real app, then taken back to the state before migration 9: its
 * columns and table removed and its row in schema_migrations deleted. Reopening applies it again.
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

/** Takes a database back to just before migration 9, undoing every later migration first (10 and 11, ticket 12c; 12, ticket 14a). */
function beforeMigration9(file: string): void {
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
    ALTER TABLE enrollments DROP COLUMN stop_reply_channel;
    ALTER TABLE enrollments DROP COLUMN stop_reply_at;
    ALTER TABLE enrollments DROP COLUMN sms_sender;
    DROP TABLE sms_bindings;
    DELETE FROM schema_migrations WHERE version = 9;
  `);
  if (db.prepare("SELECT name FROM pragma_table_info('sender_accounts')").all().some((r) => r["name"] === "problem")) db.exec("ALTER TABLE sender_accounts DROP COLUMN problem");
  const columns = db.prepare("SELECT name FROM pragma_table_info('enrollments')").all().map((r) => r["name"]);
  expect(columns).not.toContain("stop_reply_at");
  db.close();
}

describe("migration 9 on a database written before it", () => {
  test("a lead that replied keeps the channel and date of the reply that stopped it, and a later out-of-order reply leaves them unchanged", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "outreach-migration-"));
    dirs.push(dir);
    const file = path.join(dir, "outreach.sqlite");

    // The integration branch's app: Pat replies twice by email; the second reply, observed later,
    // carries an earlier provider time than the moment the first was observed.
    const before = harness(file);
    await before.tick();
    const { campaign } = await before.createCampaign("Before 9", {
      businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })],
      people: [
        person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example" }),
        person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", email: "nia@harbour.example" }),
      ],
    });
    await before.defineSequence(campaign.id, definition);
    before.clock = MONDAY_9;
    await before.launch(campaign.id);
    const rows = (await before.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows;
    const pat = rows.find((r) => r.name === "Pat Oneil")!.enrollments[0]!.id;
    const nia = rows.find((r) => r.name === "Nia Cole")!.enrollments[0]!.id;
    await before.advanceTo(MONDAY_9 + 3 * H);
    before.fake.prospectReplies("pat@harbour.example", true, MONDAY_9 + H);
    await before.tick();
    before.clock = MONDAY_9 + 4 * H;
    before.fake.prospectReplies("pat@harbour.example", true, MONDAY_9 + 2 * H);
    await before.tick();
    const stopped = { channel: "email", at: new Date(MONDAY_9 + H).toISOString() };
    expect((await before.progress(pat)).reply).toEqual(stopped);
    await before.store.close();
    beforeMigration9(file);

    const after = harness(file);
    after.clock = MONDAY_9 + 5 * H;
    expect((await after.progress(pat))).toMatchObject({ status: "replied", reply: stopped, smsSender: null });
    // A lead that did not reply reads as before: no stopping reply, no SMS sender.
    expect((await after.progress(nia))).toMatchObject({ reply: null, smsSender: null });
    // A reply observed after the upgrade, with an earlier time than either, moves nothing.
    await after.store.engine.update(pat, after.clock, (s) => applyReply(s, { channel: "email", atWall: MONDAY_9 + H / 2, providerRef: "late-after-upgrade" }, after.clock));
    expect((await after.progress(pat)).reply).toEqual(stopped);
    await after.store.close();
  });
});
