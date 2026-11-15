import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition } from "../../domain/sequence/definition.ts";
import type { EnrollmentRead, LeadSearchResult } from "../../shared/api.ts";

/**
 * Migration 19: one stored form for a reply's id (ADR 0003 "Ticket 17a", the reply identity rule). Before it, a pre-send
 * check that found a reply before its observation stored the provider's bare id: a text's (until PR 62), an email's
 * (the Instantly adapter until ticket 17a). The observation stores `sms:<id>` or `reply:<email id>`. The migration
 * rewrites every bare id to the observed form, merging the two when a lead holds both, so the same reply is one reply
 * wherever replies are compared. Fictitious data only.
 */
const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const TUESDAY_0 = Date.parse("2026-11-03T00:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const NUMBER = "+447700900010";
const MOBILE = "+447700900101";
const ADDRESS = "pat@harbour.example";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const step = (channel: "email" | "sms", id: string, waitDays: number): StepDefinition => ({ id, waitDays, subject: channel === "email" ? `Subject ${id}` : "", body: "A note for {{company}}.", threading: "new_subject", removed: false });
const definition = (channel: "email" | "sms"): CampaignDefinition => ({
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["inbox-a"],
  smsPool: [NUMBER],
  callScript: "Ask who looks after bookings.",
  tracks: [{ id: "t1", channel, branch: "main", window: ALWAYS, steps: [step(channel, "m1", 0), step(channel, "m2", 1), step(channel, "m3", 2)], start: { kind: "entry" }, removed: false }],
});
const harness = (databasePath: string, start: number, idPrefix = "att") =>
  new EngineHarness({ start, databasePath, idPrefix, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }], sms: { numbers: [{ id: NUMBER, capacity: 50, gapMs: MIN, k: 2, healthy: true, resetZone: "UTC" }] } });
const pat = () => person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: ADDRESS, dial_phone: MOBILE, dial_phone_type: "mobile" });
const sentBy = (h: EngineHarness, channel: "email" | "sms") => (channel === "sms" ? h.sms.deliveryLog : h.fake.deliveryLog).map((d) => d.stepId);

describe("migration 19 on a database written before it", () => {
  const cases = [
    // The text's id as the integration tip (bf27344) stores a pre-send answer, and as the observation names it.
    { channel: "sms", bare: "text-1", stored: "sms:text-1", until: "the integration tip, bf27344 (verifier B1 on PR 62)" },
    // The email's id as the integration branch stored a pre-send answer from cb31184 until ticket 17a's merge (b40fc87).
    { channel: "email", bare: "em-1", stored: "reply:em-1", until: "the integration branch before ticket 17a (council on PR 62)" },
  ] as const;
  for (const c of cases) {
    test(`${c.channel}: a reply the pre-send check stored bare, as ${c.until} did, observed late after a resume, is the same reply: the third message goes`, async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "migration-19-"));
      dirs.push(dir);
      const file = path.join(dir, "app.db");

      // Before: m1 goes Monday 09:00. Pat replies just before m2 falls due at Tuesday 00:00; the provider's messages
      // show the reply at once, its event only at Tuesday 09:02. The pre-send check of m2 finds it.
      const before = harness(file, MONDAY_9);
      await before.tick();
      const { campaign } = await before.createCampaign("Before 19", { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })], people: [pat()] });
      await before.defineSequence(campaign.id, definition(c.channel));
      expect((await before.launch(campaign.id)).status).toBe(200);
      await before.advanceTo(TUESDAY_0 - MIN);
      expect(sentBy(before, c.channel)).toEqual(["m1"]);
      const firstEmail = before.fake.deliveryLog[0];
      const hiddenForMs = 9 * H + 3 * MIN;
      expect(c.channel === "sms" ? before.sms.prospectTexts(MOBILE, "Not now", NUMBER, null, hiddenForMs) : before.fake.prospectReplies(ADDRESS, true, null, { hiddenForMs })).toBe(true);
      await before.advanceTo(TUESDAY_0 + 30 * MIN);
      const id = (await before.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows[0]?.enrollments[0]?.id ?? "";
      expect((await before.request<EnrollmentRead>("GET", `/api/enrollments/${id}`)).body.status).toBe("replied");
      expect(sentBy(before, c.channel)).toEqual(["m1"]);
      await before.store.close();

      // The database as that code leaves it: the pre-send answer stored under the provider's bare id, no reply event
      // for the reply (it was never observed), and no migration 19.
      const db = new DatabaseSync(file);
      expect(db.prepare("SELECT provider_ref FROM replies").all().map((r) => r["provider_ref"])).toEqual([c.stored]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM reply_events").get()?.["n"]).toBe(0);
      db.prepare("UPDATE replies SET provider_ref = ?").run(c.bare);
      // The database has the integration branch's migration 18 (ticket 21's test runs): 19 applies after it.
      expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.["v"]).toBe(19);
      db.exec("DELETE FROM schema_migrations WHERE version >= 19");
      expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.["v"]).toBe(18);
      expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'test_runs'").get()?.["n"]).toBe(1);
      db.close();

      // After the upgrade, Tuesday 09:01: the user resumes Pat, m2 goes. At 09:02 the provider's delayed event for the
      // same reply arrives (the provider keeps its messages across the app's restart). It is the reply already held.
      const after = harness(file, TUESDAY_0 + 9 * H + MIN, "after");
      await after.tick();
      expect((await after.request("POST", `/api/enrollments/${id}/controls`, { requestId: "resume-1", action: "resume_from_next_step" })).status).toBe(200);
      await after.advanceTo(TUESDAY_0 + 9 * H + 2 * MIN);
      if (c.channel === "sms") expect(after.sms.prospectTexts(MOBILE, "Not now", NUMBER, TUESDAY_0 - MIN)).toBe(true);
      else expect(after.fake.prospectReplies(ADDRESS, true, TUESDAY_0 - MIN, { inThreadOf: firstEmail! })).toBe(true);
      expect((c.channel === "sms" ? after.sms.replyLog : after.fake.replyLog).map((r) => r.id)).toEqual([c.channel === "sms" ? c.bare : c.stored]);
      await after.advanceTo(MONDAY_9 + 6 * DAY);
      expect(sentBy(after, c.channel)).toEqual(["m2", "m3"]);
      expect((await after.request<EnrollmentRead>("GET", `/api/enrollments/${id}`)).body.status).not.toBe("replied");
      expect((await after.store.engine.subject(id, after.clock))?.replies.map((r) => r.providerRef)).toEqual([c.stored]);
      await after.store.close();
      expect(new DatabaseSync(file).prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => Number(r["version"])).slice(-2)).toEqual([18, 19]);
    });
  }

  test("a lead holding a reply under both ids keeps one, at the earlier instant; observed and unsubscribe ids are kept exactly", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "migration-19-"));
    dirs.push(dir);
    const file = path.join(dir, "app.db");
    const h = harness(file, MONDAY_9);
    await h.tick();
    const { campaign } = await h.createCampaign("Both", { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })], people: [pat()] });
    await h.defineSequence(campaign.id, definition("sms"));
    expect((await h.launch(campaign.id)).status).toBe(200);
    const id = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows[0]?.enrollments[0]?.id ?? "";
    await h.store.close();

    const db = new DatabaseSync(file);
    const insert = db.prepare("INSERT INTO replies (provider_ref, subject_id, channel, at_wall) VALUES (?, ?, ?, ?)");
    insert.run("text-1", id, "sms", MONDAY_9 + H);
    insert.run("sms:text-1", id, "sms", MONDAY_9 + 2 * H);
    insert.run("text-2", id, "sms", MONDAY_9 + 3 * H);
    insert.run("sms:text-3", id, "sms", MONDAY_9 + 4 * H);
    insert.run("sms:text-4", id, "sms", MONDAY_9 + 5 * H);
    insert.run("text-4", id, "sms", MONDAY_9 + 6 * H);
    insert.run("reply:em-1", id, "email", MONDAY_9 + 7 * H);
    insert.run("em-1", id, "email", MONDAY_9 + 8 * H);
    insert.run("em-2", id, "email", MONDAY_9 + 9 * H);
    insert.run("unsubscribed:lead-9", id, "email", MONDAY_9 + 10 * H);
    insert.run("em-3", id, "email", MONDAY_9 + 11 * H);
    insert.run("reply:em-3", id, "email", MONDAY_9 + 12 * H);
    db.exec("DELETE FROM schema_migrations WHERE version >= 19");
    db.close();

    const after = harness(file, MONDAY_9 + DAY, "after");
    await after.tick();
    await after.store.close();
    const rows = new DatabaseSync(file).prepare("SELECT provider_ref, channel, at_wall FROM replies ORDER BY at_wall, provider_ref").all();
    expect(rows.map((r) => [r["provider_ref"], r["channel"], (Number(r["at_wall"]) - MONDAY_9) / H])).toEqual([
      ["sms:text-1", "sms", 1],
      ["sms:text-2", "sms", 3],
      ["sms:text-3", "sms", 4],
      ["sms:text-4", "sms", 5],
      ["reply:em-1", "email", 7],
      ["reply:em-2", "email", 9],
      ["unsubscribed:lead-9", "email", 10],
      ["reply:em-3", "email", 11],
    ]);
  });
});
