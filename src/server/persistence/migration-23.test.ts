import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { linkedinAccountId } from "../engine/ports.ts";
import { migrate, MIGRATIONS } from "./migrations.ts";

/**
 * Migrations 22 and 23 on a database the integration tip (`3be5674`) left (the re-check of e261ffa, item 3; of dd3969c,
 * item 4). The database is built here, readable in a diff. The tip's schema is migrations 1 to 21: this branch only adds
 * after 21. Its rows are the statements below, the rows the tip's own code wrote when it ran this: Spring clinics texts Pat
 * from +447700900801 at 09:00 on Monday 2 November 2026, with a follow-up due three days later, and the database is closed
 * at 10:00. Fictitious data only.
 *
 * Opened by this branch's code beside a simulated LinkedIn session whose own id is the same number: the pair keeps the
 * channel stored for it (`sms`), the session is another account (`linkedin:+447700900801`), and Pat's text back is the
 * SMS pair's reply.
 */
const TIP_ROWS = [
  "INSERT INTO sender_accounts (id, channel, label, capacity, gap_ms, k, next_slot_at, healthy, wait_until, wait_reason, backoff_ms, reset_zone, problem, daily_limit) VALUES ('inbox-a', 'email', 'Fake inbox inbox-a', 50, 60000, 2, 0, 1, NULL, NULL, 0, 'UTC', NULL, 50);",
  "INSERT INTO sender_accounts (id, channel, label, capacity, gap_ms, k, next_slot_at, healthy, wait_until, wait_reason, backoff_ms, reset_zone, problem, daily_limit) VALUES ('+447700900801', 'sms', 'Simulated SMS (not a provider) +447700900801', 50, 60000, 2, 1793610060000, 1, NULL, NULL, 0, 'Europe/London', NULL, 50);",
  "INSERT INTO companies (id, place_id, name, search_name, category, website, domain, street, neighborhood, city, state_province, postal_code, country, timezone, source_row, created_at, updated_at) VALUES ('id-3', NULL, 'Harbour Lane Physio', 'harbour lane physio', 'Physiotherapist', '', '', '', '', 'London', '', '', 'GB', 'Europe/London', '{\"business_id\":\"b1\",\"place_id\":\"\",\"business_name\":\"Harbour Lane Physio\",\"category\":\"Physiotherapist\",\"phone_e164\":\"+442079460101\",\"phone_original\":\"\",\"general_emails\":\"\",\"website\":\"\",\"domain\":\"\",\"street\":\"\",\"neighborhood\":\"\",\"city\":\"London\",\"state_province\":\"\",\"postal_code\":\"\",\"country\":\"GB\",\"search_area\":\"\",\"search_place\":\"\",\"timezone\":\"Europe/London\",\"tz_check\":\"\",\"rating\":\"\",\"review_count\":\"\",\"maps_url\":\"\",\"facebook\":\"\",\"instagram\":\"\",\"linkedin_company\":\"\",\"chain_flag\":\"\",\"status\":\"\",\"people_count\":\"\",\"run_ids\":\"\",\"first_seen\":\"\",\"last_seen\":\"\",\"phone_extension\":\"\"}', '2026-11-02T09:00:00.000Z', '2026-11-02T09:00:00.000Z');",
  "INSERT INTO company_source_ids (source_business_id, company_id) VALUES ('b1', 'id-3');",
  "INSERT INTO people (id, company_id, full_name, first_name, last_name, display_name, search_name, title, role_tier, timezone, linkedin_url, source_row, created_at, updated_at) VALUES ('id-5', 'id-3', 'Pat Oneil', 'Pat', 'Oneil', 'Pat Oneil', 'pat oneil', 'Owner', 'decision_maker', NULL, '', '{\"person_id\":\"p1\",\"business_id\":\"b1\",\"business_name\":\"\",\"city\":\"\",\"neighborhood\":\"\",\"timezone\":\"\",\"full_name\":\"Pat Oneil\",\"first_name\":\"Pat\",\"last_name\":\"Oneil\",\"title\":\"Owner\",\"role_tier\":\"decision_maker\",\"email\":\"\",\"email_status\":\"\",\"email_source\":\"\",\"direct_phone\":\"\",\"direct_phone_source\":\"\",\"dial_phone\":\"+447700900811\",\"dial_phone_type\":\"mobile\",\"linkedin_url\":\"\",\"sources\":\"\",\"source_urls\":\"\",\"evidence\":\"\",\"confidence\":\"\",\"run_id\":\"\",\"found_at\":\"\"}', '2026-11-02T09:00:00.000Z', '2026-11-02T09:00:00.000Z');",
  "INSERT INTO person_source_ids (person_id, source_person_id) VALUES ('id-5', 'p1');",
  "INSERT INTO contact_details (id, owner_kind, owner_id, channel, phone_kind, value, key, search_digits, bad, added_at, listed_shared, merged_into) VALUES ('id-4', 'company', 'id-3', 'phone', 'main_line', '+442079460101', '+442079460101', '442079460101 02079460101', 0, '2026-11-02T09:00:00.000Z', 0, NULL);",
  "INSERT INTO contact_details (id, owner_kind, owner_id, channel, phone_kind, value, key, search_digits, bad, added_at, listed_shared, merged_into) VALUES ('id-6', 'person', 'id-5', 'phone', 'mobile', '+447700900811', '+447700900811', '447700900811 07700900811', 0, '2026-11-02T09:00:00.000Z', 0, NULL);",
  "INSERT INTO imports (id, campaign_id, imported_at, people_file_name, businesses_file_name, summary) VALUES ('id-2', 'id-1', '2026-11-02T09:00:00.000Z', NULL, NULL, '{\"rows\":{\"businesses\":1,\"people\":1},\"counts\":{\"new\":1,\"already_enrolled\":0,\"updated\":0,\"not_enrolled\":0},\"entries\":[{\"lead\":{\"kind\":\"person\",\"personId\":\"id-5\"},\"name\":\"Pat Oneil\",\"title\":\"Owner\",\"companyId\":\"id-3\",\"companyName\":\"Harbour Lane Physio\",\"peopleAtCompany\":1,\"outcome\":\"new\",\"channels\":{\"email\":false,\"sms\":true,\"call\":true},\"via\":[\"mobile\",\"main_line\"],\"added\":[{\"channel\":\"phone\",\"phoneKind\":\"mobile\",\"value\":\"+44 7700 900811\"}],\"becameMobile\":[],\"stillBad\":[],\"heldElsewhere\":[]}],\"rowRecords\":{\"businesses\":[\"id-3\"],\"people\":[\"id-5\"]}}');",
  "INSERT INTO row_identities (record_kind, record_id, identity) VALUES ('company', 'id-3', '[\"b1\",\"\",\"harbourlanephysio\",\"+442079460101\",[],\"physiotherapist\",\"\",\"\",\"\",\"\",\"london\",\"\",\"\",\"gb\",\"europe/london\"]');",
  "INSERT INTO row_identities (record_kind, record_id, identity) VALUES ('person', 'id-5', '[\"p1\",\"patoneil\",\"\",\"\",\"+447700900811\",\"mobile\",\"owner\",\"decision_maker\",\"\",\"\"]');",
  "INSERT INTO campaigns (id, name, default_timezone, created_at, launched_at, paused_since, version, definition, definition_version, definition_edited_at, definition_session, definition_seq, test_email, test_mobile, edit_version) VALUES ('id-1', 'Spring clinics', 'Europe/London', '2026-11-02T09:00:00.000Z', 1793610000000, NULL, 2, '{\"timezone\":\"Europe/London\",\"callSkipLimitDays\":2,\"emailPool\":[\"inbox-a\"],\"smsPool\":[\"+447700900801\"],\"callScript\":\"\",\"tracks\":[{\"id\":\"t\",\"channel\":\"sms\",\"branch\":\"main\",\"window\":[{\"day\":0,\"start\":0,\"end\":24},{\"day\":1,\"start\":0,\"end\":24},{\"day\":2,\"start\":0,\"end\":24},{\"day\":3,\"start\":0,\"end\":24},{\"day\":4,\"start\":0,\"end\":24},{\"day\":5,\"start\":0,\"end\":24},{\"day\":6,\"start\":0,\"end\":24}],\"steps\":[{\"id\":\"t1\",\"waitDays\":0,\"subject\":\"\",\"body\":\"A text.\",\"threading\":\"new_subject\",\"removed\":false},{\"id\":\"t2\",\"waitDays\":3,\"subject\":\"\",\"body\":\"A follow-up.\",\"threading\":\"new_subject\",\"removed\":false}],\"start\":{\"kind\":\"entry\"},\"removed\":false}]}', 2, '2026-11-02T09:00:00.000Z', NULL, NULL, NULL, NULL, 1);",
  "INSERT INTO subjects (id, kind) VALUES ('id-7', 'enrollment');",
  "INSERT INTO enrollments (id, campaign_id, lead_kind, person_id, company_id, status, enrolled_at, import_id, version, ended, ended_at, ended_wall, lead_paused, branch, branch_entered_at, touched, no_more_calls, frozen_since, frozen_total, email_sender, sms_sender, stop_reply_channel, stop_reply_at) VALUES ('id-7', 'id-1', 'person', 'id-5', 'id-3', 'active', '2026-11-02T09:00:00.000Z', 'id-2', 6, NULL, NULL, NULL, 0, 'main', 0, 1, 0, NULL, 1793610000000, NULL, '+447700900801', NULL, NULL);",
  "INSERT INTO track_progress (subject_id, track_id, start_at, start_basis_at, start_basis_wall, start_zone, started_at, destination_detail_id, next_step_id, basis_at, basis_wall, due_at, due_wall, due_zone, finished_at, finished_wall, finish_reason, conversation_owners) VALUES ('id-7', 't', 0, 0, 1793610000000, 'Europe/London', 0, 'id-6', 't2', 0, 1793610000000, 226800000, 1793836800000, 'Europe/London', NULL, NULL, NULL, NULL);",
  "INSERT INTO attempts (id, subject_id, track_id, step_id, account_id, destination_detail_id, destination, state, copy, threading, thread_ref, retryable, not_sent_final, idempotency_key, calls, claimed_wall, handed_at, handed_wall, last_call_wall, presend_checked_wall, presend_found_reply, ended_by, withdraw_requested, withdraw_called, awaiting_answer, retry, reject_reason) VALUES ('att-1', 'id-7', 't', 't1', '+447700900801', 'id-6', '+447700900811', 'sent', '{\"subject\":\"\",\"body\":\"A text.\"}', 'new_subject', NULL, 0, 0, 'att-1', 1, 1793610000000, 0, 1793610000000, 1793610000000, 1793610000000, 0, 'observed', 0, 0, 0, 'none', NULL);",
  "INSERT INTO provider_work (key, subject_id, track_id, step_id, account_id, destination, calls, first_handed_wall, provider_ref, settled, sent_wall, sent_day, next_lookup_wall, lookup_answer, queued_lookups, unresolved_since, withdraw_wanted, withdraw_last_wall, went_wall) VALUES ('att-1', 'id-7', 't', 't1', '+447700900801', '+447700900811', 1, 1793610000000, 'sms-1', 'sent', 1793610000000, '2026-11-02', NULL, NULL, 0, NULL, 0, NULL, NULL);",
  "INSERT INTO sms_bindings (seq, sender_number, recipient_key, owner_subject, created_at, released_at, unsent) VALUES (1, '+447700900801', '+447700900811', 'id-7', 1793610000000, NULL, 0);",
  "INSERT INTO step_results (subject_id, step_id, track_id, result, reason, at, at_wall, attempt_id) VALUES ('id-7', 't1', 't', 'sent', NULL, 0, 1793610000000, 'att-1');",
  "INSERT INTO freezes (seq, subject_id, from_wall, to_wall) VALUES (1, 'id-7', 1793610000000, 1793610000000);",
  "INSERT INTO engine_meta (key, value) VALUES ('engine_heartbeat', '1793613600000');",
  "INSERT INTO engine_meta (key, value) VALUES ('email_observe_checkpoint', '1793613600000');",
  "INSERT INTO engine_meta (key, value) VALUES ('sms_observe_checkpoint', '1793613600000');",
  "INSERT INTO engine_meta (key, value) VALUES ('engine_tick_ended', '1793613600000');",
  "INSERT INTO engine_meta (key, value) VALUES ('engine_providers', '{\"email\":{\"contactAt\":1793613600000,\"freshForMs\":60000,\"failedAt\":null,\"failedPart\":null},\"sms\":{\"contactAt\":1793613600000,\"freshForMs\":60000,\"failedAt\":null,\"failedPart\":null}}');",
];

const H = 3_600_000;
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const NUMBER = "+447700900801";
const MOBILE = "+447700900811";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("migrations 22 and 23 on the integration tip's own database", () => {
  test("the tip's SMS pair is stored as SMS; a LinkedIn session with the number's id is another account; the text reply is the SMS pair's", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "migration-23-"));
    dirs.push(dir);
    const file = path.join(dir, "app.db");
    const tip = new DatabaseSync(file);
    migrate(tip, () => "2026-11-02T09:00:00.000Z", MIGRATIONS.filter((m) => m.version <= 21));
    // In any order, then every reference checked: the rows are consistent, as the tip left them.
    tip.exec("PRAGMA foreign_keys = OFF");
    for (const row of TIP_ROWS) tip.exec(row);
    tip.exec("PRAGMA foreign_keys = ON");
    expect(tip.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(tip.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: 21 });
    tip.close();

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
    // A pair's channel never changes: not by an update, nor by an INSERT OR REPLACE on its key (the re-check of dd3969c, item 3).
    expect(() => db.exec("UPDATE sms_bindings SET channel = 'linkedin'")).toThrow(/never changes/);
    expect(() =>
      db.exec("INSERT OR REPLACE INTO sms_bindings (seq, sender_number, recipient_key, owner_subject, created_at, channel) SELECT seq, sender_number, recipient_key, owner_subject, created_at, 'linkedin' FROM sms_bindings"),
    ).toThrow(/never changes/);
    // Nor by an INSERT OR REPLACE that leaves out the key but names the active sender and recipient (the re-check of 8c85b2f, item 2).
    expect(() =>
      db.exec("INSERT OR REPLACE INTO sms_bindings (sender_number, recipient_key, owner_subject, created_at, channel) SELECT sender_number, recipient_key, owner_subject, created_at, 'linkedin' FROM sms_bindings"),
    ).toThrow(/never changes/);
    expect(db.prepare("SELECT channel FROM sms_bindings").all()).toEqual([{ channel: "sms" }]);

    await h.tick();
    expect(db.prepare("SELECT id, channel FROM sender_accounts WHERE id IN (?, ?) ORDER BY id").all(NUMBER, linkedinAccountId(NUMBER))).toEqual([
      { id: NUMBER, channel: "sms" },
      { id: linkedinAccountId(NUMBER), channel: "linkedin" },
    ]);
    // An account's channel never changes either, by an update or an INSERT OR REPLACE on its id.
    expect(() => db.exec(`UPDATE sender_accounts SET channel = 'linkedin' WHERE id = '${NUMBER}'`)).toThrow(/never changes/);
    expect(() => db.exec(`INSERT OR REPLACE INTO sender_accounts (id, channel, label, capacity, gap_ms, k, healthy, reset_zone) VALUES ('${NUMBER}', 'linkedin', 'x', 1, 1, 1, 1, 'UTC')`)).toThrow(/never changes/);

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
