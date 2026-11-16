import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { linkedinAccountId } from "../engine/ports.ts";

/**
 * Migrations 22 and 23 on a database the integration tip's own code wrote (the re-check of e261ffa, item 3).
 * `test/fixtures/upgrade/tip-3be5674-sms-pair.db` was made by running the tip (`3be5674`) in its own checkout: Spring
 * clinics texts Pat from +447700900801 at 09:00 on Monday 2 November 2026, with a follow-up due three days later; the
 * database is then closed at 10:00. Fictitious data only.
 *
 * Opened by this branch's code beside a simulated LinkedIn session whose own id is the same number: the pair keeps the
 * channel stored for it (`sms`), the session is another account (`linkedin:+447700900801`), and Pat's text back is the
 * SMS pair's reply.
 */
const H = 3_600_000;
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const NUMBER = "+447700900801";
const MOBILE = "+447700900811";
const FIXTURE = path.join(import.meta.dirname, "../../../test/fixtures/upgrade/tip-3be5674-sms-pair.db");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("migrations 22 and 23 on the integration tip's own database", () => {
  test("the tip's SMS pair is stored as SMS; a LinkedIn session with the number's id is another account; the text reply is the SMS pair's", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "migration-23-"));
    dirs.push(dir);
    const file = path.join(dir, "app.db");
    copyFileSync(FIXTURE, file);

    const h = new EngineHarness({
      start: MONDAY_9 + 2 * H,
      databasePath: file,
      idPrefix: "after-23",
      accounts: [{ id: "inbox-a", capacity: 50, gapMs: 60_000, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
      sms: { numbers: [{ id: NUMBER, capacity: 50, gapMs: 60_000, k: 2, healthy: true, resetZone: "Europe/London" }] },
      linkedin: { sessions: [{ id: NUMBER, gapMs: 60_000, k: 1, healthy: true, resetZone: "Europe/London" }] },
    });
    const db = (h.store.engine as unknown as { db: DatabaseSync }).db;
    expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: 23 });
    expect(db.prepare("SELECT sender_number, recipient_key, channel FROM sms_bindings").all()).toEqual([{ sender_number: NUMBER, recipient_key: MOBILE, channel: "sms" }]);
    // A pair's channel never changes.
    expect(() => db.exec("UPDATE sms_bindings SET channel = 'linkedin'")).toThrow(/never changes/);

    await h.tick();
    expect(db.prepare("SELECT id, channel FROM sender_accounts WHERE id IN (?, ?) ORDER BY id").all(NUMBER, linkedinAccountId(NUMBER))).toEqual([
      { id: NUMBER, channel: "sms" },
      { id: linkedinAccountId(NUMBER), channel: "linkedin" },
    ]);
    // An account's channel never changes either.
    expect(() => db.exec(`UPDATE sender_accounts SET channel = 'linkedin' WHERE id = '${NUMBER}'`)).toThrow(/never changes/);

    // Pat texts back to the number: the reply is the SMS pair's owner's, which ends; the follow-up never goes.
    expect(h.sms.prospectTexts(MOBILE, "Thanks, not now", NUMBER)).toBe(true);
    await h.advanceTo(h.clock + H);
    const lead = (db.prepare("SELECT owner_subject FROM sms_bindings").get() as { owner_subject: string }).owner_subject;
    const st = await h.store.engine.subject(lead, h.clock);
    expect(st?.subject.ended).toBe("replied");
    expect(st?.replies.map((r) => r.channel)).toEqual(["sms"]);
    await h.advanceTo(MONDAY_9 + 5 * 24 * H);
    expect(h.sms.deliveryLog).toEqual([]);
    await h.store.close();
  });
});
