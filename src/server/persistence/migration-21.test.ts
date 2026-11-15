import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import type { EnrollmentProgress, LeadSearchResult, NeedsAttention } from "../../shared/api.ts";

/**
 * Migration 21 (ADR 0003, question Q7 answered): a skip records its cause, and a binding none of whose texts went is
 * released as unsent. It starts from `test/fixtures/databases/q7-held-at-231b639.sqlite`, made by the integration tip's
 * own code (`231b639`, ticket 23's merge) through its harness, with fictitious data: Spring clinics texted Pat on the one
 * number at 09:00 on Monday 2 November 2026 and owns that conversation; its text to Nia was refused at the call (her
 * mobile reported invalid), which left a binding though nothing was sent; Autumn clinics' text to Pat, launched at
 * 10:00, is held there under the interim (`sms_conversation_taken` in Needs attention), with an email a day after it.
 */
const MIN = 60_000;
const H = 60 * MIN;
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const N1 = "+447700900001";
const FIXTURE = path.join(import.meta.dirname, "../../../test/fixtures/databases/q7-held-at-231b639.sqlite");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("migration 21 on a database the integration tip made (ADR 0003, question Q7 answered)", () => {
  test("the unsent binding is released, the lead held under the interim is skipped at the first tick with its cause, and its email goes a day later, once", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "migration-21-"));
    dirs.push(dir);
    const file = path.join(dir, "app.db");
    copyFileSync(FIXTURE, file);
    const atTip = new DatabaseSync(file);
    expect(atTip.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: 20 });
    atTip.close();

    // The upgrade: the application as built opens the same database at 11:00, two hours after the tip stopped.
    const h = new EngineHarness({
      start: MONDAY_9 + 2 * H,
      databasePath: file,
      idPrefix: "after-21",
      accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
      sms: { numbers: [{ id: N1, capacity: 50, gapMs: MIN, k: 2, healthy: true, resetZone: "Europe/London" }] },
    });
    const db = (h.store.engine as unknown as { db: DatabaseSync }).db;
    expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: 21 });
    // Nia's binding: nothing went, so it is released as unsent. Pat's: Spring clinics' text went, so it stays.
    expect(db.prepare("SELECT recipient_key AS mobile, released_at IS NOT NULL AS released, unsent FROM sms_bindings ORDER BY seq").all()).toEqual([
      { mobile: "+447700900101", released: 0, unsent: 0 },
      { mobile: "+447700900102", released: 1, unsent: 1 },
    ]);

    await h.tick();
    const rows = (await h.request<LeadSearchResult>("GET", "/api/leads?q=Pat%20Oneil")).body.rows.find((r) => r.name === "Pat Oneil")!;
    const autumn = rows.enrollments.find((e) => e.campaign.name === "Autumn clinics")!.id;
    const skipped = (await h.request<EnrollmentProgress>("GET", `/api/enrollments/${autumn}`)).body;
    expect(skipped.tracks.find((t) => t.trackId === "m")).toMatchObject({ finishReason: "skipped_conversation_taken", finishedAt: new Date(MONDAY_9 + 2 * H).toISOString(), hold: null, conversationOwners: [{ name: "Spring clinics", test: false }] });
    expect((await h.request<NeedsAttention>("GET", "/api/needs-attention")).body.heldTracks).toEqual([]);

    // The email waits one calendar day from the skip, London: Tuesday 00:00. Nothing is texted, nothing twice.
    await h.advanceTo(Date.parse("2026-11-04T00:00:00Z"));
    expect(h.fake.deliveryLog.map((d) => [d.destination, new Date(d.at).toISOString()])).toEqual([["pat@harbour.example", "2026-11-03T00:00:00.000Z"]]);
    expect(h.sms.deliveryLog).toEqual([]);
  });
});
