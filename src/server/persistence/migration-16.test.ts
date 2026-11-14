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
      ALTER TABLE provider_work DROP COLUMN withdraw_wanted;
      ALTER TABLE provider_work DROP COLUMN withdraw_last_wall;
      ALTER TABLE provider_work DROP COLUMN went_wall;
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

  /**
   * Council F on 56d599c: before migration 16 a reply to a lead that had ended overwrote its ended_wall, so the backfilled
   * interval starts at the reply, not at the first ending. Every way a lead ended before this ticket closes its call tasks
   * (a decline, interested, a finished sequence) or leaves none that counts (no good number), except a reply, whose later
   * replies change nothing; so no day from the upgrade on can count a task the truth would not. Shown here: a lead declined
   * on Monday, replying on Tuesday, beside a second campaign's calls under a tight capacity, upgraded on Wednesday; each
   * day's committed calls equal those of the same history on a database that had migration 16 throughout.
   */
  test("a lead declined, then replying, counts no call on any day from the upgrade on (council F)", async () => {
    const run = async (upgrade: boolean) => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "migration-16f-"));
      dirs.push(dir);
      const file = path.join(dir, "app.db");
      const call = { id: "p1", channel: "call" as const, branch: "main" as const, window: ALWAYS, steps: [{ ...email("c1", 0), subject: "", body: "" }], start: { kind: "entry" as const }, removed: false, callSkipLimitDays: 30 };
      const def: CampaignDefinition = { ...definition, callScript: "", tracks: [definition.tracks[0]!, call] };
      let h = harness(file);
      await h.tick();
      expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 2, userZone: "Europe/London" })).status).toBe(200);
      const people = [person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", direct_phone: "+442079460111" }), person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", email: "nia@harbour.example", direct_phone: "+442079460112" })];
      const rows = { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })], people };
      const ids: string[] = [];
      for (const name of ["First", "Second"]) {
        const { campaign } = await h.createCampaign(name, rows);
        await h.defineSequence(campaign.id, def);
        expect((await h.launch(campaign.id)).status).toBe(200);
        ids.push(campaign.id);
      }
      await h.advanceTo(MONDAY_9 + H);
      // Pat declines in the first campaign (the stop path): its call task closes.
      const first = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${ids[0]!}`)).body.rows.find((r) => r.name === "Pat Oneil")!.enrollments.find((e) => e.campaign.id === ids[0])!.id;
      const task = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${first}`)).body.tracks.find((t) => t.trackId === "p1")?.callTask?.taskId ?? "";
      const view = (await h.request<{ numbers: { detailId: string }[] }>("GET", `/api/call-tasks/${task}`)).body;
      expect(task).not.toBe("");
      expect((await h.request("POST", `/api/call-tasks/${task}/outcome`, { requestId: "decline", outcome: "not_interested", declinedPath: "stop", numberId: view.numbers[0]?.detailId, note: "" })).status).toBe(200);
      // Tuesday: a reply, which overwrote ended_wall before this ticket.
      await h.advanceTo(MONDAY_9 + DAY + H);
      h.fake.prospectReplies("pat@harbour.example");
      await h.advanceTo(MONDAY_9 + DAY + 2 * H);
      if (upgrade) {
        await h.store.close();
        const db = new DatabaseSync(file);
        db.exec(`
          DROP TABLE hold_intervals;
          DROP TABLE control_requests;
          ALTER TABLE provider_work DROP COLUMN withdraw_wanted;
          ALTER TABLE provider_work DROP COLUMN withdraw_last_wall;
          ALTER TABLE provider_work DROP COLUMN went_wall;
          DELETE FROM schema_migrations WHERE version >= 16;
        `);
        db.close();
        h = new EngineHarness({ start: MONDAY_9 + DAY + 2 * H, databasePath: file, idPrefix: "after", accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
        await h.tick();
      }
      const counts: number[] = [];
      for (const d of [2, 3, 4]) {
        await h.advanceTo(MONDAY_9 + d * DAY + H);
        counts.push((await h.store.engine.callDay(h.clock)).committed);
      }
      await h.store.close();
      return counts;
    };
    const truth = await run(false);
    expect(truth.some((n) => n > 0)).toBe(true);
    expect(await run(true)).toEqual(truth);
  });
});

