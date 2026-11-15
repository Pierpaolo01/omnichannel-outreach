import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import { UNDO_21 } from "../../../test/support/undo-migrations.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { EnrollmentProgress, LeadSearchResult, NeedsAttention } from "../../shared/api.ts";
import { DEFAULT_RULES, type Rules } from "../engine/rules.ts";

/**
 * Migration 21 (ADR 0003, question Q7 answered): a skip records its cause, and a binding none of whose texts went is
 * released as unsent. The database before it is built here, as the integration tip (`231b639`) left one, then taken
 * back to 20 (`UNDO_21`), as the other upgrade tests do: the tip's engine held a lead whose mobile's conversation was
 * taken instead of skipping it, and released no binding when a first text was refused. So the old world is written by
 * the current build with exactly those two rules as the tip had them: the skip switched off, no unsent release. Fictitious
 * data only.
 *
 * Spring clinics texts Pat on the one number at 09:00 on Monday 2 November 2026 and owns that conversation; its text to
 * Nia is refused at the call (her mobile reported invalid), which leaves a binding though nothing was sent; Autumn
 * clinics' text to Pat, launched at 10:00, is held there (`sms_conversation_taken` at the tip), with an email a day after.
 */
const MIN = 60_000;
const H = 60 * MIN;
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const N1 = "+447700900001";
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const text = (id: string): StepDefinition => ({ id, waitDays: 0, subject: "", body: `Text ${id}, {{first_name|there}}.`, threading: "new_subject", removed: false });
const email = (id: string): StepDefinition => ({ id, waitDays: 0, subject: "Hello", body: `Email ${id}.`, threading: "new_subject", removed: false });
const track = (id: string, channel: "sms" | "email", steps: StepDefinition[], start: TrackDefinition["start"] = { kind: "entry" }): TrackDefinition => ({ id, channel, branch: "main", window: ALWAYS, steps, start, removed: false });
const definition = (tracks: TrackDefinition[]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: [N1], tracks });
const harbour = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });
const pat = person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", dial_phone: "+447700900101", dial_phone_type: "mobile" });
const nia = person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", email: "nia@harbour.example", dial_phone: "+447700900102", dial_phone_type: "mobile" });
const accounts = [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }];
const sms = { numbers: [{ id: N1, capacity: 50, gapMs: MIN, k: 2, healthy: true, resetZone: "Europe/London" }] };

/** The integration tip's two rules on taken conversations: a taken conversation held, not skipped; no unsent release. */
const AT_THE_TIP: Partial<Rules> = {
  evaluate: (s, now, options) => DEFAULT_RULES.evaluate(s, now, { ...options, skipTakenConversations: false }),
  releaseUnsent: (s) => s,
};

describe("migration 21 on a database as the integration tip left it (ADR 0003, question Q7 answered)", () => {
  test("the unsent binding is released, the lead held there is skipped at the first tick with its cause, and its email goes a day later, once", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "migration-21-"));
    dirs.push(dir);
    const file = path.join(dir, "app.db");

    const before = new EngineHarness({ start: MONDAY_9, databasePath: file, accounts, sms, rules: AT_THE_TIP });
    await before.tick();
    before.sms.invalid.add("+447700900102");
    const spring = (await before.createCampaign("Spring clinics", { businesses: [harbour], people: [pat, nia] })).campaign.id;
    await before.defineSequence(spring, definition([track("m", "sms", [text("a1")])]));
    expect((await before.launch(spring)).status).toBe(200);
    await before.advanceTo(MONDAY_9 + H);
    const autumn = (await before.createCampaign("Autumn clinics", { businesses: [harbour], people: [pat] })).campaign.id;
    await before.defineSequence(autumn, definition([track("m", "sms", [text("b1")]), track("e", "email", [email("e1")], { kind: "after", trackId: "m", delayDays: 1 })]));
    expect((await before.launch(autumn)).status).toBe(200);
    await before.advanceTo(MONDAY_9 + 2 * H);
    expect(before.sms.deliveryLog.map((d) => d.destination)).toEqual(["+447700900101"]);
    expect(before.sms.refusals.map((r) => r.destination)).toEqual(["+447700900102"]);
    await before.store.close();

    // Back to 20, as the tip's schema has it.
    const old = new DatabaseSync(file);
    old.exec(UNDO_21);
    expect(old.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: 20 });
    expect(old.prepare("SELECT name FROM pragma_table_info('sms_bindings') WHERE name = 'unsent'").all()).toEqual([]);
    // As the tip left it: both first texts' bindings unreleased, Autumn's SMS track open, nothing skipped.
    expect(old.prepare("SELECT recipient_key AS mobile, released_at FROM sms_bindings ORDER BY seq").all()).toEqual([
      { mobile: "+447700900101", released_at: null },
      { mobile: "+447700900102", released_at: null },
    ]);
    expect(old.prepare("SELECT COUNT(*) AS n FROM track_progress WHERE finish_reason IS NULL AND track_id = 'm'").get()).toEqual({ n: 1 });
    old.close();

    // The upgrade: the application as built opens the same database at 11:00.
    const h = new EngineHarness({ start: MONDAY_9 + 2 * H, databasePath: file, idPrefix: "after-21", accounts, sms });
    const db = (h.store.engine as unknown as { db: DatabaseSync }).db;
    expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: 21 });
    // Nia's binding: nothing went, so it is released as unsent. Pat's: Spring clinics' text went, so it stays.
    expect(db.prepare("SELECT recipient_key AS mobile, released_at IS NOT NULL AS released, unsent FROM sms_bindings ORDER BY seq").all()).toEqual([
      { mobile: "+447700900101", released: 0, unsent: 0 },
      { mobile: "+447700900102", released: 1, unsent: 1 },
    ]);

    await h.tick();
    const rows = (await h.request<LeadSearchResult>("GET", "/api/leads?q=Pat%20Oneil")).body.rows.find((r) => r.name === "Pat Oneil")!;
    const held = rows.enrollments.find((e) => e.campaign.name === "Autumn clinics")!.id;
    const skipped = (await h.request<EnrollmentProgress>("GET", `/api/enrollments/${held}`)).body;
    expect(skipped.tracks.find((t) => t.trackId === "m")).toMatchObject({ finishReason: "skipped_conversation_taken", finishedAt: new Date(MONDAY_9 + 2 * H).toISOString(), hold: null, conversationOwners: [{ name: "Spring clinics", test: false }] });
    expect((await h.request<NeedsAttention>("GET", "/api/needs-attention")).body.heldTracks).toEqual([]);

    // The email waits one calendar day from the skip, London: Tuesday 00:00. Nothing is texted, nothing twice.
    await h.advanceTo(Date.parse("2026-11-04T00:00:00Z"));
    expect(h.fake.deliveryLog.map((d) => [d.destination, new Date(d.at).toISOString()])).toEqual([["pat@harbour.example", "2026-11-03T00:00:00.000Z"]]);
    expect(h.sms.deliveryLog).toEqual([]);
  });
});
