import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EngineHarness, quickWait } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition } from "../../domain/sequence/definition.ts";
import type { LeadSearchResult } from "../../shared/api.ts";
import { openSqliteStore } from "../persistence/sqlite-store.ts";
import { Engine, InboxLocks, TickQueue } from "./engine.ts";

/**
 * A reply we have observed and stored stops a handover, whichever process stored it (council K on 56d599c, case ii): our
 * pre-send check returns clear; then another process observes the lead's reply and stores it; our handover's transaction
 * re-reads the lead (it has ended) and withdraws the claim. Nothing is handed over. Email and SMS. Fictitious data.
 */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const step = (id: string, waitDays: number, subject: string): StepDefinition => ({ id, waitDays, subject, body: "A note for {{company}}.", threading: "new_subject", removed: false });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

for (const channel of ["email", "sms"] as const) {
  describe(`a ${channel} reply stored by another process between the pre-send check and the handover`, () => {
    test("stops the handover: the claim is withdrawn and nothing is sent", async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "reply-handover-"));
      dirs.push(dir);
      const file = path.join(dir, "app.db");
      const number = "+447700900010";
      const h = new EngineHarness({ start: MONDAY_9, databasePath: file, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }], sms: { numbers: [{ id: number, capacity: 50, gapMs: MIN, k: 1, healthy: true, resetZone: "Europe/London" }] } });
      await h.tick();
      const definition: CampaignDefinition = {
        timezone: "Europe/London",
        callSkipLimitDays: 2,
        emailPool: ["inbox-a"],
        smsPool: [number],
        tracks: [{ id: "t1", channel, branch: "main", window: ALWAYS, steps: [step("s1", 0, channel === "email" ? "Hello" : ""), step("s2", 1, channel === "email" ? "Again" : "")], start: { kind: "entry" }, removed: false }],
      };
      const { campaign } = await h.createCampaign("Clinics", { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })], people: [person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", dial_phone: "+447700900101", dial_phone_type: "mobile" })] });
      await h.defineSequence(campaign.id, definition);
      expect((await h.launch(campaign.id)).status).toBe(200);
      const pat = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows[0]!.enrollments[0]!.id;
      await h.advanceTo(MONDAY_9 + 10 * MIN);
      const log = () => (channel === "email" ? h.fake.handoverLog : h.sms.handoverLog);
      expect(log().map((c) => c.stepId)).toEqual(["s1"]);

      // A second process on the same database, observing the same providers.
      const other = new Engine({ store: openSqliteStore(file).engine, port: h.fake, smsPort: h.sms, now: () => h.clock, newId: (() => { let n = 0; return () => `other-${++n}`; })(), waitFor: quickWait, ticks: new TickQueue(), locks: new InboxLocks() });
      let stored = false;
      h.hooks.beforeHandover = async () => {
        if (stored) return;
        stored = true;
        // After our pre-send check said clear: the reply reaches the provider, and the other process observes and stores it.
        if (channel === "email") h.fake.prospectReplies("pat@harbour.example");
        else h.sms.prospectTexts("+447700900101", "Out of office", number);
        await other.tick();
        expect((await h.store.engine.subject(pat, h.clock))?.subject.ended).toBe("replied");
      };
      await h.advanceTo(MONDAY_9 + DAY + 10 * MIN);
      expect(stored).toBe(true);
      expect(log().map((c) => c.stepId)).toEqual(["s1"]);
      const st = await h.store.engine.subject(pat, h.clock);
      // Withdrawn by the reply's own quiesce in the other process, or by our handover's re-check: either way never handed over.
      expect(st?.attempts.find((a) => a.stepId === "s2")?.state).toBe("withdrawn");
      expect(st?.subject.ended).toBe("replied");
    });
  });
}
