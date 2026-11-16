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
 * Migration 21 (ADR 0003, question Q7 answered): a skip records its cause; the migration releases no binding, and the
 * engine's first tick after it starts applies its one release rule (a binding none of whose texts went, and none
 * answered, is released as unsent). The database before it is not made by the integration tip's (`231b639`) own code:
 * it is written by this branch's code with two of the tip's rules substituted (`AT_THE_TIP`: a taken conversation held,
 * not skipped; no unsent release), then its schema is taken back to version 20 (`UNDO_21`), as the other upgrade tests
 * do. Fictitious data only.
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
    // The migration releases nothing itself; the engine's first tick applies its own rule to every binding's owner.
    expect(db.prepare("SELECT COUNT(*) AS n FROM sms_bindings WHERE released_at IS NOT NULL").get()).toEqual({ n: 0 });

    await h.tick();
    // Nia's binding: nothing went, so it is released as unsent, though Nia's lead has ended. Pat's: Spring clinics' text
    // went, so it stays.
    expect(db.prepare("SELECT recipient_key AS mobile, released_at IS NOT NULL AS released, unsent FROM sms_bindings ORDER BY seq").all()).toEqual([
      { mobile: "+447700900101", released: 0, unsent: 0 },
      { mobile: "+447700900102", released: 1, unsent: 1 },
    ]);
    const niaLead = (await h.request<LeadSearchResult>("GET", "/api/leads?q=Nia%20Cole")).body.rows.find((r) => r.name === "Nia Cole")!.enrollments[0]!.id;
    expect((await h.request<EnrollmentProgress>("GET", `/api/enrollments/${niaLead}`)).body.status).not.toMatch(/queued|active/);
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

  test("an answered binding whose text was then marked not sent stays its holder's at the upgrade: later replies are its, and another campaign skips naming it (review bot on 50788ac)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "migration-21-"));
    dirs.push(dir);
    const file = path.join(dir, "app.db");
    const PAT = "+447700900101";

    // Under the tip's rules: Spring clinics' first text to Pat gets no answer, Pat replies on the number anyway, and the
    // user marks the text not sent after the lookups. The binding stands, the reply is resolved to Spring clinics.
    const before = new EngineHarness({ start: MONDAY_9, databasePath: file, accounts, sms, rules: AT_THE_TIP });
    await before.tick();
    before.sms.dropUnanswered.set(PAT, 1);
    const spring = (await before.createCampaign("Spring clinics", { businesses: [harbour], people: [pat] })).campaign.id;
    await before.defineSequence(spring, definition([track("m", "sms", [text("a1")])]));
    expect((await before.launch(spring)).status).toBe(200);
    await before.advanceTo(MONDAY_9 + 2 * MIN);
    before.sms.prospectTexts(PAT, "Who is this?", N1);
    await before.advanceTo(MONDAY_9 + H);
    const holder = (await before.request<LeadSearchResult>("GET", "/api/leads?q=Pat%20Oneil")).body.rows.find((r) => r.name === "Pat Oneil")!.enrollments[0]!.id;
    expect((await before.request<EnrollmentProgress>("GET", `/api/enrollments/${holder}`)).body.status).toBe("replied");
    const attempt = (await before.store.engine.subject(holder, before.clock))!.attempts[0]!;
    expect(await before.engine.markAttempt(attempt.id, "not_sent")).toBe(true);
    await before.tick();
    await before.store.close();

    const old = new DatabaseSync(file);
    old.exec(UNDO_21);
    expect(old.prepare("SELECT released_at FROM sms_bindings").all()).toEqual([{ released_at: null }]);
    expect(old.prepare("SELECT settled, sent_wall FROM provider_work").all()).toEqual([{ settled: "user_not_sent", sent_wall: null }]);
    expect(old.prepare("SELECT state FROM reply_events WHERE event_id LIKE 'sms:%'").all()).toEqual([{ state: "resolved" }]);
    old.close();

    // The upgrade, and the engine's first tick: the answered binding is kept, not released as unsent.
    const h = new EngineHarness({ start: MONDAY_9 + 2 * H, databasePath: file, idPrefix: "after-21", appIdPrefix: "app-after-21", accounts, sms });
    await h.tick();
    const db = (h.store.engine as unknown as { db: DatabaseSync }).db;
    expect(db.prepare("SELECT owner_subject AS owner, released_at, unsent FROM sms_bindings").all()).toEqual([{ owner: holder, released_at: null, unsent: 0 }]);

    // A later reply is still Spring clinics' lead's: no unknown-sender anomaly, and its replies count two. This process's
    // fake numbers its replies from 1 again, so its first repeats the old reply's id (and is known); the second is new.
    h.sms.prospectTexts(PAT, "Who is this?", N1);
    h.sms.prospectTexts(PAT, "Still me", N1);
    await h.advanceTo(h.clock + MIN);
    expect((await h.request<NeedsAttention>("GET", "/api/needs-attention")).body.anomalies).toEqual([]);
    expect((await h.store.engine.subject(holder, h.clock))!.replies.filter((r) => r.channel === "sms")).toHaveLength(2);

    // Another campaign's SMS track to Pat on the same number is skipped, Spring clinics named.
    const autumn = (await h.createCampaign("Autumn clinics", { businesses: [harbour], people: [pat] })).campaign.id;
    await h.defineSequence(autumn, definition([track("m", "sms", [text("b1")]), track("e", "email", [email("e1")], { kind: "after", trackId: "m", delayDays: 1 })]));
    expect((await h.launch(autumn)).status).toBe(200);
    await h.advanceTo(h.clock + 5 * MIN);
    const rows = (await h.request<LeadSearchResult>("GET", "/api/leads?q=Pat%20Oneil")).body.rows.find((r) => r.name === "Pat Oneil")!;
    const waiting = rows.enrollments.find((e) => e.campaign.name === "Autumn clinics")!.id;
    expect((await h.request<EnrollmentProgress>("GET", `/api/enrollments/${waiting}`)).body.tracks.find((t) => t.trackId === "m")).toMatchObject({ finishReason: "skipped_conversation_taken", conversationOwners: [{ name: "Spring clinics", test: false }] });
    expect(h.sms.deliveryLog.filter((d) => d.subjectId === waiting)).toEqual([]);
  });
});
