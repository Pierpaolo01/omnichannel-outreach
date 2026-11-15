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
 * Migration 18: one stored form for a text's reply id (ADR 0003 "Ticket 17a", the reply identity rule). Before it, a
 * pre-send check that found a text before its observation stored the provider's bare id; the observation stores
 * `sms:<id>`. The migration rewrites every bare SMS reply id to `sms:<id>`, merging the two when a lead holds both, so
 * the same text is one reply wherever replies are compared. Fictitious data only.
 */
const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const TUESDAY_0 = Date.parse("2026-11-03T00:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const NUMBER = "+447700900010";
const MOBILE = "+447700900101";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const text = (id: string, waitDays: number): StepDefinition => ({ id, waitDays, subject: "", body: "A note for {{company}}.", threading: "new_subject", removed: false });
const definition: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: [],
  smsPool: [NUMBER],
  callScript: "Ask who looks after bookings.",
  tracks: [{ id: "x1", channel: "sms", branch: "main", window: ALWAYS, steps: [text("sms1", 0), text("sms2", 1), text("sms3", 2)], start: { kind: "entry" }, removed: false }],
};
const harness = (databasePath: string, start: number, idPrefix = "att") => new EngineHarness({ start, databasePath, idPrefix, accounts: [], sms: { numbers: [{ id: NUMBER, capacity: 50, gapMs: MIN, k: 2, healthy: true, resetZone: "UTC" }] } });

describe("migration 18 on a database written before it", () => {
  test("a text the pre-send check stored bare, observed late after a resume, is the same reply: the third text goes (verifier B1 on PR 62)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "migration-18-"));
    dirs.push(dir);
    const file = path.join(dir, "app.db");

    // Before: sms1 goes Monday 09:00. Pat texts back just before sms2 falls due at Tuesday 00:00; the provider's
    // messages show the text at once, its event only at Tuesday 09:02. The pre-send check of sms2 finds it.
    const before = harness(file, MONDAY_9);
    await before.tick();
    const { campaign } = await before.createCampaign("Before 18", { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })], people: [person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", dial_phone: MOBILE, dial_phone_type: "mobile" })] });
    await before.defineSequence(campaign.id, definition);
    expect((await before.launch(campaign.id)).status).toBe(200);
    await before.advanceTo(TUESDAY_0 - MIN);
    expect(before.sms.deliveryLog.map((d) => d.stepId)).toEqual(["sms1"]);
    expect(before.sms.prospectTexts(MOBILE, "Not now", NUMBER, null, 9 * H + 3 * MIN)).toBe(true);
    await before.advanceTo(TUESDAY_0 + 30 * MIN);
    const id = (await before.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows[0]?.enrollments[0]?.id ?? "";
    expect((await before.request<EnrollmentRead>("GET", `/api/enrollments/${id}`)).body.status).toBe("replied");
    expect(before.sms.deliveryLog.map((d) => d.stepId)).toEqual(["sms1"]);
    await before.store.close();

    // The database as the integration tip (bf27344) leaves it: the pre-send answer stored under the provider's bare id,
    // no reply event for the text (it was never observed), and no migration 18.
    const db = new DatabaseSync(file);
    expect(db.prepare("SELECT provider_ref FROM replies").all().map((r) => r["provider_ref"])).toEqual(["sms:text-1"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM reply_events").get()?.["n"]).toBe(0);
    db.exec(`
      UPDATE replies SET provider_ref = 'text-1';
      DELETE FROM schema_migrations WHERE version >= 18;
    `);
    db.close();

    // After the upgrade, Tuesday 09:01: the user resumes Pat, sms2 goes. At 09:02 the provider's delayed event for the
    // same text arrives (the provider keeps its messages across the app's restart). It is the reply already held.
    const after = harness(file, TUESDAY_0 + 9 * H + MIN, "after");
    await after.tick();
    expect((await after.request("POST", `/api/enrollments/${id}/controls`, { requestId: "resume-1", action: "resume_from_next_step" })).status).toBe(200);
    await after.advanceTo(TUESDAY_0 + 9 * H + 2 * MIN);
    expect(after.sms.prospectTexts(MOBILE, "Not now", NUMBER, TUESDAY_0 - MIN)).toBe(true);
    expect(after.sms.replyLog.map((r) => r.id)).toEqual(["text-1"]);
    await after.advanceTo(MONDAY_9 + 6 * DAY);
    expect(after.sms.deliveryLog.map((d) => d.stepId)).toEqual(["sms2", "sms3"]);
    expect((await after.request<EnrollmentRead>("GET", `/api/enrollments/${id}`)).body.status).not.toBe("replied");
    expect((await after.store.engine.subject(id, after.clock))?.replies.map((r) => r.providerRef)).toEqual(["sms:text-1"]);
    await after.store.close();
  });

  test("a lead holding a text under both ids keeps one reply, at the earlier instant; an email reply is untouched", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "migration-18-"));
    dirs.push(dir);
    const file = path.join(dir, "app.db");
    const h = harness(file, MONDAY_9);
    await h.tick();
    const { campaign } = await h.createCampaign("Both", { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })], people: [person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", dial_phone: MOBILE, dial_phone_type: "mobile" })] });
    await h.defineSequence(campaign.id, definition);
    expect((await h.launch(campaign.id)).status).toBe(200);
    const id = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows[0]?.enrollments[0]?.id ?? "";
    await h.store.close();

    const db = new DatabaseSync(file);
    const insert = db.prepare("INSERT INTO replies (provider_ref, subject_id, channel, at_wall) VALUES (?, ?, ?, ?)");
    insert.run("text-1", id, "sms", MONDAY_9 + H);
    insert.run("sms:text-1", id, "sms", MONDAY_9 + 2 * H);
    insert.run("text-2", id, "sms", MONDAY_9 + 3 * H);
    insert.run("reply:em-1", id, "email", MONDAY_9 + 4 * H);
    insert.run("em-2", id, "email", MONDAY_9 + 5 * H);
    db.exec("DELETE FROM schema_migrations WHERE version >= 18");
    db.close();

    const after = harness(file, MONDAY_9 + DAY, "after");
    await after.tick();
    await after.store.close();
    const rows = new DatabaseSync(file).prepare("SELECT provider_ref, channel, at_wall FROM replies ORDER BY at_wall").all();
    expect(rows.map((r) => [r["provider_ref"], r["channel"], r["at_wall"]])).toEqual([
      ["sms:text-1", "sms", MONDAY_9 + H],
      ["sms:text-2", "sms", MONDAY_9 + 3 * H],
      ["reply:em-1", "email", MONDAY_9 + 4 * H],
      ["em-2", "email", MONDAY_9 + 5 * H],
    ]);
  });
});
