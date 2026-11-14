import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from "node:sqlite";
import { displayPhone, displayPhonesIn } from "../../domain/phone.ts";
import type { SenderAccountView } from "../../domain/sequence/blockers.ts";
import { isTimeZone, localDayNumber, prospectZone, resetDayOf, startOfLocalDay, type WindowRule } from "../../domain/sequence/clock.ts";
import { defaultGap } from "../../domain/sequence/dispatch.ts";
import type { MergeData } from "../../domain/sequence/copy.ts";
import { emptyDefinition, poolOf, type CampaignDefinition } from "../../domain/sequence/definition.ts";
import { callableOnDay, skipDeadlineOf, skipLimitOf } from "../../domain/sequence/calls.ts";
import { deriveStatus } from "../../domain/sequence/progress.ts";
import type {
  AccountState,
  Attempt,
  AttemptState,
  CallAttempt,
  CallDay,
  CallNumber,
  CallOutcome,
  CallTask,
  EndReason,
  RecordedNumber,
  FinishReason,
  LeadDetail,
  LookupAnswer,
  ProviderWork,
  RejectReason,
  StepOutcome,
  SubjectState,
  SmsBindingRecord,
  TrackProgress,
  WorkSettlement,
} from "../../domain/sequence/state.ts";
import { isOutreachStatus } from "../../domain/outreach-status.ts";
import type { BounceEvent, CallNoteRecord, CallSettings, CampaignEngineRow, DefinitionSave, EngineStore, LaunchOutcome, ReplyEvent, SaveResult, SenderAccountConfig, StoredDefinition, StoredNote } from "../engine/engine-store.ts";
import { liveDetailRowOf } from "./sqlite-store.ts";

type Row = Record<string, SQLOutputValue>;

const LIVE_STATES = "('claimed', 'handed', 'accepted')";

/**
 * The default daily call capacity until the user sets one: a factory default, configurable over
 * HTTP (PUT /api/call-settings), not a product decision.
 */
export const DEFAULT_DAILY_CALL_CAPACITY = 50;
/** The user's zone until they set one: the machine's (ADR 0003 3.4). */
const machineZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The engine's tables in the same SQLite database as the CRM (ADR 0003 1.3). */
export class SqliteEngineStore implements EngineStore {
  private readonly db: DatabaseSync;

  private readonly statements = new Map<string, StatementSync>();

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** A prepared statement, compiled once per store. */
  private sql(text: string): StatementSync {
    let statement = this.statements.get(text);
    if (!statement) {
      statement = this.db.prepare(text);
      this.statements.set(text, statement);
    }
    return statement;
  }

  async campaign(campaignId: string): Promise<CampaignEngineRow | null> {
    const row = this.sql("SELECT * FROM campaigns WHERE id = ?").get(campaignId);
    if (!row) return null;
    return {
      id: campaignId,
      definition: row["definition"] == null ? null : parseDefinition(row),
      definitionVersion: num(row, "definition_version"),
      definitionEditedAt: strOrNull(row, "definition_edited_at"),
      launchedAt: numOrNull(row, "launched_at"),
      version: num(row, "version"),
    };
  }

  async saveDefinition(campaignId: string, definition: CampaignDefinition, editedAt: string, save: DefinitionSave | null = null): Promise<SaveResult> {
    return this.transaction((): SaveResult => {
      const text = JSON.stringify(definition);
      // ADR 0003 1.1.1, in the statement that stores: accepted if it continues the stored session
      // with a higher number, or starts from the stored revision. A save with no session is stored.
      const changed = this.sql(
        `UPDATE campaigns SET definition = ?, definition_version = definition_version + 1, definition_edited_at = ?, version = version + 1,
           definition_session = ?, definition_seq = ?
         WHERE id = ? AND launched_at IS NULL
           AND (? IS NULL OR (definition_session = ? AND definition_seq < ?) OR definition_version = ?)`,
      ).run(text, editedAt, save?.session ?? null, save?.seq ?? null, campaignId, save?.session ?? null, save?.session ?? null, save?.seq ?? null, save?.base ?? null).changes;
      // The row as this transaction leaves it: the answer is built from it, never read afterwards.
      const row = this.sql("SELECT * FROM campaigns WHERE id = ?").get(campaignId);
      if (!row) return { outcome: "missing" };
      const stored = storedDefinitionOf(row);
      const hash = createHash("sha256").update(text).digest("hex");
      if (Number(changed) > 0) {
        // Each session's newest accepted number, kept after another session writes (migration 13).
        if (save) {
          this.run(
            `INSERT INTO definition_saves (campaign_id, session, seq, content_sha256) VALUES (?, ?, ?, ?)
             ON CONFLICT(campaign_id, session) DO UPDATE SET seq = excluded.seq, content_sha256 = excluded.content_sha256 WHERE excluded.seq >= definition_saves.seq`,
            [campaignId, save.session, save.seq, hash],
          );
        }
        return { outcome: "saved", stored };
      }
      if (row["launched_at"] != null) return { outcome: "launched", stored };
      if (save && strOrNull(row, "definition_session") === save.session) {
        const seq = numOrNull(row, "definition_seq") ?? 0;
        if (seq > save.seq) return { outcome: "superseded", stored };
        if (seq === save.seq && row["definition"] === text) return { outcome: "unchanged", stored };
      }
      // Another session wrote last: this session's own newest accepted save still answers for it.
      if (save) {
        const mine = this.sql("SELECT seq, content_sha256 FROM definition_saves WHERE campaign_id = ? AND session = ?").get(campaignId, save.session);
        if (mine) {
          const seq = num(mine, "seq");
          // An older save of a page that has since saved a newer one: superseded, as in its own session.
          if (save.seq < seq) return { outcome: "superseded", stored };
          // A retry of what was accepted, then replaced by a page that had seen it: saved, then replaced.
          if (save.seq === seq && strOrNull(mine, "content_sha256") === hash) return { outcome: "replaced", stored };
        }
      }
      return { outcome: "conflict", stored };
    });
  }

  async launchInputs(campaignId: string): Promise<{ leads: MergeData[]; accounts: SenderAccountView[] }> {
    return this.launchInputsNow(campaignId);
  }

  private launchInputsNow(campaignId: string): { leads: MergeData[]; accounts: SenderAccountView[] } {
    const leads = this.sql("SELECT * FROM enrollments WHERE campaign_id = ? AND ended IS NULL ORDER BY enrolled_at, id")
      .all(campaignId)
      .map((e) => this.mergeDataOf(e));
    const accounts = this.sql("SELECT id, channel, healthy FROM sender_accounts ORDER BY id")
      .all()
      .map((a) => ({ id: str(a, "id"), channel: str(a, "channel") === "sms" ? ("sms" as const) : ("email" as const), healthy: num(a, "healthy") === 1 }));
    return { leads, accounts };
  }

  async launch(
    campaignId: string,
    now: number,
    decide: Parameters<EngineStore["launch"]>[2],
    enter: (state: SubjectState) => SubjectState,
    expectedDefinitionVersion?: number,
  ): Promise<LaunchOutcome> {
    return this.transaction((): LaunchOutcome => {
      const row = this.sql("SELECT * FROM campaigns WHERE id = ?").get(campaignId);
      if (!row || row["definition"] == null) return { ok: false, check: null, reason: "no_definition" };
      if (row["launched_at"] != null) return { ok: false, check: null, reason: "already_launched" };
      if (expectedDefinitionVersion !== undefined && num(row, "definition_version") !== expectedDefinitionVersion) return { ok: false, check: null, reason: "changed" };
      const { leads, accounts } = this.launchInputsNow(campaignId);
      const check = decide(parseDefinition(row), leads, accounts);
      if (!check.canLaunch) return { ok: false, check, reason: "blocked" };
      this.run("UPDATE campaigns SET launched_at = ?, version = version + 1 WHERE id = ?", [now, campaignId]);
      // A launched campaign's definition takes no more saves (until ticket 19), so its sessions' saves
      // answer nothing any more: they go with the launch (ADR 0003 1.1.1, council on aebeb80, item 7).
      this.run("DELETE FROM definition_saves WHERE campaign_id = ?", [campaignId]);
      const launchedRow = this.sql("SELECT * FROM campaigns WHERE id = ?").get(campaignId);
      for (const e of this.sql("SELECT id FROM enrollments WHERE campaign_id = ? ORDER BY enrolled_at, id").all(campaignId)) {
        const base = this.load(str(e, "id"), now);
        if (base) this.write(base, enter(base), now);
      }
      return { ok: true, stored: storedDefinitionOf(launchedRow ?? row) };
    });
  }

  async subject(subjectId: string, now: number): Promise<SubjectState | null> {
    return this.load(subjectId, now);
  }

  async update(subjectId: string, now: number, decide: (state: SubjectState) => SubjectState | null): Promise<SubjectState | null> {
    return this.updateNow(subjectId, now, decide);
  }

  updateNow(subjectId: string, now: number, decide: (state: SubjectState) => SubjectState | null): SubjectState | null {
    return this.transaction(() => {
      const base = this.load(subjectId, now);
      if (!base) return null;
      const next = decide(base);
      if (!next) return null;
      return this.write(base, next, now);
    });
  }

  async runningSubjectIds(): Promise<string[]> {
    return this.sql(
        `SELECT e.id FROM enrollments e JOIN campaigns c ON c.id = e.campaign_id
         WHERE c.launched_at IS NOT NULL AND e.ended IS NULL ORDER BY e.id`,
      )
      .all()
      .map((r) => str(r, "id"));
  }

  async runningSubjectVersions(): Promise<Map<string, string>> {
    // The subject's and campaign's versions, plus the lead facts decisions read that no subject
    // write bumps: the lead's live details and their bad marks, and its records' last update.
    return new Map(
      this.sql(
        `SELECT e.id, e.version || '/' || c.version || '/' || c.definition_version || '/' ||
           COALESCE((SELECT group_concat(d.id || ':' || d.bad, ',') FROM live_contact_details d
             WHERE (e.person_id IS NOT NULL AND d.owner_kind = 'person' AND d.owner_id = e.person_id)
                OR (d.owner_kind = 'company' AND d.owner_id = e.company_id)), '') || '/' ||
           COALESCE((SELECT p.updated_at FROM people p WHERE p.id = e.person_id), '') || '/' ||
           (SELECT co.updated_at FROM companies co WHERE co.id = e.company_id) AS v
         FROM enrollments e JOIN campaigns c ON c.id = e.campaign_id
         WHERE c.launched_at IS NOT NULL AND e.ended IS NULL ORDER BY e.id`,
      )
        .all()
        .map((r) => [str(r, "id"), str(r, "v")]),
    );
  }

  async subjectsOf(campaignId: string): Promise<string[]> {
    return this.sql("SELECT id FROM enrollments WHERE campaign_id = ? ORDER BY enrolled_at, id").all(campaignId).map((r) => str(r, "id"));
  }

  async openAttempts(): Promise<Attempt[]> {
    return this.sql(`SELECT * FROM attempts WHERE state IN ${LIVE_STATES} ORDER BY claimed_wall, rowid`).all().map(toAttempt);
  }

  async attempt(attemptId: string): Promise<Attempt | null> {
    const row = this.sql("SELECT * FROM attempts WHERE id = ?").get(attemptId);
    return row ? toAttempt(row) : null;
  }

  async heldOnAccounts(): Promise<{ readonly accountId: string; readonly subjectId: string; readonly reservations: number; readonly live: number }[]> {
    // The same two counts `accountState` adds: reserved work (unsettled, not sent) and live attempts.
    return this.sql(
      `SELECT account_id, subject_id, SUM(reserved) AS reservations, SUM(live) AS live FROM (
         SELECT account_id, subject_id, 1 AS reserved, 0 AS live FROM provider_work WHERE settled IS NULL AND sent_wall IS NULL
         UNION ALL
         SELECT account_id, subject_id, 0, 1 FROM attempts WHERE state IN ${LIVE_STATES}
       ) GROUP BY account_id, subject_id ORDER BY account_id, subject_id`,
    )
      .all()
      .map((r) => ({ accountId: str(r, "account_id"), subjectId: str(r, "subject_id"), reservations: num(r, "reservations"), live: num(r, "live") }));
  }

  async openWork(): Promise<ProviderWork[]> {
    return this.sql("SELECT * FROM provider_work WHERE settled IS NULL AND next_lookup_wall IS NOT NULL ORDER BY next_lookup_wall, rowid").all().map(toWork);
  }

  async work(key: string): Promise<ProviderWork | null> {
    const row = this.sql("SELECT * FROM provider_work WHERE key = ?").get(key);
    return row ? toWork(row) : null;
  }

  async workByProviderRef(providerRef: string): Promise<ProviderWork | null> {
    const row = this.sql("SELECT * FROM provider_work WHERE provider_ref = ? ORDER BY rowid LIMIT 1").get(providerRef);
    return row ? toWork(row) : null;
  }

  async workReachedFrom(inbox: string, address: string): Promise<ProviderWork[]> {
    return this.sql("SELECT * FROM provider_work WHERE account_id = ? AND lower(destination) = lower(?) AND first_handed_wall IS NOT NULL ORDER BY subject_id, rowid")
      .all(inbox, address)
      .map(toWork);
  }

  async unresolvedWork(): Promise<ProviderWork[]> {
    return this.sql("SELECT * FROM provider_work WHERE settled IS NULL AND unresolved_since IS NOT NULL ORDER BY account_id, unresolved_since, rowid").all().map(toWork);
  }

  async sentToday(accountId: string, now: number): Promise<number> {
    const a = this.sql("SELECT reset_zone FROM sender_accounts WHERE id = ?").get(accountId);
    if (!a) return 0;
    return num(this.sql("SELECT COUNT(*) AS n FROM provider_work WHERE account_id = ? AND sent_day = ?").get(accountId, resetDayOf(now, str(a, "reset_zone"))) ?? {}, "n");
  }

  async replyEvent(eventId: string): Promise<ReplyEvent | null> {
    const row = this.sql("SELECT * FROM reply_events WHERE event_id = ?").get(eventId);
    return row ? toReplyEvent(row) : null;
  }

  async recordReplyEvent(reply: ReplyEvent): Promise<void> {
    this.run(
      `INSERT OR IGNORE INTO reply_events (event_id, provider_ref, inbox, address, at_wall, received_wall, state, waited_ms, last_counted_wall)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [reply.eventId, reply.providerRef, reply.inbox, reply.address.toLowerCase(), reply.atWall, reply.receivedWall, reply.state, reply.waitedMs, reply.lastCountedWall],
    );
  }

  async updateReplyEvent(eventId: string, change: Partial<Pick<ReplyEvent, "state" | "waitedMs" | "lastCountedWall">>): Promise<void> {
    this.transaction(() => {
      if (change.state !== undefined) this.run("UPDATE reply_events SET state = ? WHERE event_id = ?", [change.state, eventId]);
      if (change.waitedMs !== undefined) this.run("UPDATE reply_events SET waited_ms = ? WHERE event_id = ?", [change.waitedMs, eventId]);
      if (change.lastCountedWall !== undefined) this.run("UPDATE reply_events SET last_counted_wall = ? WHERE event_id = ?", [change.lastCountedWall, eventId]);
    });
  }

  async openReplyEvents(): Promise<ReplyEvent[]> {
    return this.sql("SELECT * FROM reply_events WHERE state <> 'resolved' ORDER BY received_wall, event_id").all().map(toReplyEvent);
  }

  async pendingReplies(): Promise<ReplyEvent[]> {
    return this.sql("SELECT * FROM reply_events WHERE state = 'pending' ORDER BY received_wall, event_id").all().map(toReplyEvent);
  }

  async upsertAccounts(accounts: readonly SenderAccountConfig[]): Promise<void> {
    this.transaction(() => {
      for (const a of accounts) {
        this.run(
          `INSERT INTO sender_accounts (id, channel, label, capacity, gap_ms, k, healthy, problem, reset_zone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET channel = excluded.channel, label = excluded.label, capacity = excluded.capacity,
             gap_ms = excluded.gap_ms, k = excluded.k, healthy = excluded.healthy, problem = excluded.problem, reset_zone = excluded.reset_zone`,
          [a.id, a.channel, a.label, a.capacity, a.gapMs, a.k, a.healthy ? 1 : 0, a.healthy ? null : (a.problem ?? "unhealthy"), a.resetZone],
        );
      }
    });
  }

  async disconnectUnlisted(channel: "email" | "sms", listed: readonly string[]): Promise<void> {
    this.transaction(() => {
      for (const r of this.sql("SELECT id FROM sender_accounts WHERE channel = ? AND (healthy = 1 OR problem IS NOT 'not_listed')").all(channel)) {
        if (!listed.includes(str(r, "id"))) this.run("UPDATE sender_accounts SET healthy = 0, problem = 'not_listed' WHERE id = ?", [str(r, "id")]);
      }
    });
  }

  async smsBindingsOf(recipient: string): Promise<SmsBindingRecord[]> {
    return this.sql("SELECT sender_number, owner_subject, released_at FROM sms_bindings WHERE recipient_key = ? ORDER BY COALESCE(released_at, created_at), seq")
      .all(recipient)
      .map((b) => ({ sender: str(b, "sender_number"), owner: str(b, "owner_subject"), released: b["released_at"] != null }));
  }

  async accounts(now: number): Promise<AccountState[]> {
    return this.sql("SELECT id FROM sender_accounts ORDER BY id").all().map((r) => this.accountState(str(r, "id"), now)).filter((a): a is AccountState => a !== null);
  }

  async pushSlot(accountId: string, callStart: number): Promise<void> {
    const account = this.accountState(accountId, callStart);
    if (account) this.run("UPDATE sender_accounts SET next_slot_at = MAX(next_slot_at, ?) WHERE id = ?", [callStart + account.gapMs, accountId]);
  }

  async accountLabels(): Promise<Record<string, string>> {
    // One formatter for a phone number wherever it is shown (council on 10121d3, item 5): a number in a label reads grouped.
    return Object.fromEntries(this.sql("SELECT id, label FROM sender_accounts").all().map((r) => [str(r, "id"), displayPhonesIn(str(r, "label") || displayPhone(str(r, "id")))]));
  }

  async updateAccount(accountId: string, change: Partial<Pick<AccountState, "healthy" | "waitUntil" | "waitReason" | "backoffMs">>): Promise<void> {
    this.transaction(() => {
      if (change.healthy !== undefined) this.run("UPDATE sender_accounts SET healthy = ?, problem = ? WHERE id = ?", [change.healthy ? 1 : 0, change.healthy ? null : "unhealthy", accountId]);
      if (change.waitUntil !== undefined) this.run("UPDATE sender_accounts SET wait_until = ? WHERE id = ?", [change.waitUntil, accountId]);
      if (change.waitReason !== undefined) this.run("UPDATE sender_accounts SET wait_reason = ? WHERE id = ?", [change.waitReason, accountId]);
      if (change.backoffMs !== undefined) this.run("UPDATE sender_accounts SET backoff_ms = ? WHERE id = ?", [change.backoffMs, accountId]);
    });
  }

  async meta(key: string): Promise<string | null> {
    const row = this.sql("SELECT value FROM engine_meta WHERE key = ?").get(key);
    return row ? str(row, "value") : null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.run("INSERT INTO engine_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
  }

  async recordBounce(b: BounceEvent): Promise<void> {
    this.run(
      `INSERT OR IGNORE INTO bounce_events (event_id, subject_id, work_key, track_id, step_id, destination, at_wall, received_wall)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [b.eventId, b.subjectId, b.workKey, b.trackId, b.stepId, b.destination, b.atWall, b.receivedWall],
    );
  }

  async bouncesOf(subjectId: string): Promise<BounceEvent[]> {
    return this.sql("SELECT * FROM bounce_events WHERE subject_id = ? ORDER BY at_wall, event_id")
      .all(subjectId)
      .map((r) => ({
        eventId: str(r, "event_id"),
        subjectId: str(r, "subject_id"),
        workKey: str(r, "work_key"),
        trackId: str(r, "track_id"),
        stepId: str(r, "step_id"),
        destination: str(r, "destination"),
        atWall: num(r, "at_wall"),
        receivedWall: num(r, "received_wall"),
      }));
  }

  async recordAnomaly(attemptId: string | null, what: string, atWall: number): Promise<void> {
    this.run("INSERT INTO provider_anomalies (attempt_id, what, at_wall) VALUES (?, ?, ?)", [attemptId, what, atWall]);
  }

  async anomalies(): Promise<{ attemptId: string | null; what: string; atWall: number }[]> {
    return this.sql("SELECT * FROM provider_anomalies ORDER BY seq")
      .all()
      .map((r) => ({ attemptId: strOrNull(r, "attempt_id"), what: str(r, "what"), atWall: num(r, "at_wall") }));
  }

  async callSettings(): Promise<CallSettings> {
    return this.callSettingsNow();
  }

  private callSettingsNow(): CallSettings {
    const row = this.sql("SELECT value FROM engine_meta WHERE key = 'call_settings'").get();
    // Written by setCallSettings from validated settings.
    const stored = row ? (JSON.parse(str(row, "value")) as Partial<CallSettings>) : {};
    const zone = stored.userZone && isTimeZone(stored.userZone) ? stored.userZone : machineZone();
    return { dailyCapacity: stored.dailyCapacity ?? DEFAULT_DAILY_CALL_CAPACITY, userZone: zone };
  }

  async callDay(now: number): Promise<CallDay> {
    return this.callDayAt(now);
  }

  async subjectParties(subjectId: string): Promise<{ personId: string | null; companyId: string; campaignId: string } | null> {
    const e = this.sql("SELECT person_id, company_id, campaign_id FROM enrollments WHERE id = ?").get(subjectId);
    return e ? { personId: strOrNull(e, "person_id"), companyId: str(e, "company_id"), campaignId: str(e, "campaign_id") } : null;
  }

  /**
   * Brings every lead with an open call task up to `now` with `asOf`, inside the caller's transaction (a
   * route that changes a timing input, council on 228cd3b): what fell due is applied under the old inputs
   * before the change is written. Expiry is the one judgment of a past day that those inputs feed.
   */
  catchUpWithin(now: number, asOf: (state: SubjectState) => SubjectState): void {
    const ids = this.sql(
      `SELECT DISTINCT t.subject_id FROM call_tasks t JOIN enrollments e ON e.id = t.subject_id
       WHERE t.open = 1 AND e.ended IS NULL ORDER BY t.subject_id`,
    )
      .all()
      .map((r) => str(r, "subject_id"));
    for (const id of ids) {
      const base = this.load(id, now);
      if (!base) continue;
      const next = asOf(base);
      if (JSON.stringify(next) !== JSON.stringify(base)) this.write(base, next, now);
    }
  }

  async setCallSettings(settings: CallSettings, catchUp?: { readonly now: number; readonly asOf: (state: SubjectState) => SubjectState }): Promise<void> {
    if (catchUp) {
      // What fell due under the old day and zone is applied first, in the same transaction.
      this.transaction(() => {
        this.catchUpWithin(catchUp.now, catchUp.asOf);
        this.run("INSERT INTO engine_meta (key, value) VALUES ('call_settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(settings)]);
      });
      return;
    }
    this.run("INSERT INTO engine_meta (key, value) VALUES ('call_settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(settings)]);
  }

  async callRequestTask(requestId: string): Promise<string | null> {
    const row = this.sql("SELECT task_id FROM call_attempts WHERE request_id = ?").get(requestId);
    return row ? str(row, "task_id") : null;
  }

  async callTaskSubject(taskId: string): Promise<string | null> {
    const row = this.sql("SELECT subject_id FROM call_tasks WHERE id = ?").get(taskId);
    return row ? str(row, "subject_id") : null;
  }

  async subjectsWithOpenCallTasks(): Promise<string[]> {
    return this.sql("SELECT DISTINCT subject_id FROM call_tasks WHERE open = 1 ORDER BY subject_id").all().map((r) => str(r, "subject_id"));
  }

  async openCallbackInstants(): Promise<number[]> {
    const { userZone } = this.callSettingsNow();
    return this.sql(
      `SELECT t.callback_at FROM call_tasks t JOIN enrollments e ON e.id = t.subject_id
       WHERE t.open = 1 AND t.kind = 'callback' AND t.callback_at IS NOT NULL AND e.ended IS NULL`,
    )
      .all()
      .flatMap((r) => {
        const at = num(r, "callback_at");
        return [startOfLocalDay(localDayNumber(at, userZone), userZone), at];
      });
  }

  async notesOf(owner: "person" | "company", ownerId: string): Promise<StoredNote[]> {
    return this.sql("SELECT * FROM notes WHERE owner_kind = ? AND owner_id = ? ORDER BY at_wall DESC, rowid DESC")
      .all(owner, ownerId)
      .map((r) => ({ id: str(r, "id"), owner, ownerId, body: str(r, "body"), atWall: num(r, "at_wall"), subjectId: strOrNull(r, "subject_id"), callAttemptId: strOrNull(r, "call_attempt_id") }));
  }

  async lastCallNotes(subjectIds: readonly string[]): Promise<CallNoteRecord[]> {
    return subjectIds.flatMap((id) => {
      const r = this.sql("SELECT * FROM call_attempts WHERE subject_id = ? AND note <> '' AND outcome <> 'skip_for_now' ORDER BY at_wall DESC, rowid DESC LIMIT 1").get(id);
      return r ? [{ subjectId: id, outcome: str(r, "outcome"), note: str(r, "note"), atWall: num(r, "at_wall") }] : [];
    });
  }

  // -------------------------------------------------------------------------------------------

  /**
   * The user's call list on the user day of `now` (ADR 0003 4.4), across every subject: tasks placed
   * today, and committed tasks, placed before today and open at its start for leads that had not
   * ended by then. Committed tasks are always listed, so they count first against the capacity.
   */
  private callDayAt(now: number): CallDay {
    const { dailyCapacity, userZone } = this.callSettingsNow();
    const day = localDayNumber(now, userZone);
    const start = startOfLocalDay(day, userZone);
    const end = startOfLocalDay(day + 1, userZone);
    const placed = num(this.sql("SELECT COUNT(*) AS n FROM call_tasks WHERE placed_wall >= :start AND placed_wall < :end").get({ start, end }) ?? {}, "n");
    // A carried call counts only on a day it can be listed: its prospect's calling hours open that day
    // (council on 7902093), so a weekday call left on Friday takes none of the weekend's room; a callback
    // from its own day on, at any hour (ticket 15). A task counts as it stood at the day's start, a
    // callback if the last call logged on it before then asked for one (with that time), so the count is
    // stable through the day: working a carried call, a callback request and a redial free no room. A task
    // closed at the instant the day starts (a call skipped by the skip limit at that rollover) was not carried into it.
    // A call of a lead a callback held at the day's start cannot be listed that day, and nor can any call of a lead
    // with no good number left to log it on (Q13): neither counts (council on 228cd3b).
    const committed = this.sql(
      `SELECT t.track_id, c.id AS campaign_id, c.definition_version, c.definition, c.default_timezone, p.timezone AS person_zone, co.timezone AS company_zone,
         (SELECT a.outcome || '|' || COALESCE(a.callback_at, '') FROM call_attempts a
           WHERE a.task_id = t.id AND a.at_wall < :start AND a.outcome <> 'skip_for_now'
           ORDER BY a.at_wall DESC, a.rowid DESC LIMIT 1) AS last_call
       FROM call_tasks t JOIN enrollments e ON e.id = t.subject_id JOIN campaigns c ON c.id = e.campaign_id
         LEFT JOIN people p ON p.id = e.person_id JOIN companies co ON co.id = e.company_id
       WHERE t.placed_wall < :start AND (t.closed_wall IS NULL OR t.closed_wall > :start) AND (e.ended_wall IS NULL OR e.ended_wall >= :start)
         AND NOT EXISTS (
           SELECT 1 FROM call_tasks h WHERE h.subject_id = t.subject_id AND h.id <> t.id AND h.placed_wall < :start AND (h.closed_wall IS NULL OR h.closed_wall > :start)
             AND (SELECT a.outcome FROM call_attempts a WHERE a.task_id = h.id AND a.at_wall < :start AND a.outcome <> 'skip_for_now' ORDER BY a.at_wall DESC, a.rowid DESC LIMIT 1) = 'callback_requested')
         AND EXISTS (
           SELECT 1 FROM live_contact_details d WHERE d.channel = 'phone' AND d.bad = 0
             AND ((d.owner_kind = 'person' AND d.owner_id = COALESCE(e.person_id, '')) OR (d.owner_kind = 'company' AND d.owner_id = e.company_id AND d.phone_kind = 'main_line')))`,
    )
      .all({ start })
      .filter((r) => {
        const [outcome, callbackAt] = (strOrNull(r, "last_call") ?? "").split("|");
        if (outcome === "callback_requested") return localDayNumber(Number(callbackAt), userZone) <= day;
        const definition = r["definition"] == null ? null : this.definitionOf({ ...r, id: str(r, "campaign_id") });
        const window = definition?.tracks.find((t) => t.id === str(r, "track_id"))?.window ?? [];
        const zone = prospectZone([strOrNull(r, "person_zone"), strOrNull(r, "company_zone")], definition?.timezone ?? "UTC");
        return callableOnDay(window, zone, start, end);
      }).length;
    return { userZone, day, capacity: dailyCapacity, placedToday: placed, committed };
  }

  private accountState(id: string, now: number): AccountState | null {
    const a = this.sql("SELECT * FROM sender_accounts WHERE id = ?").get(id);
    if (!a) return null;
    const resetZone = str(a, "reset_zone");
    // The ledger counts provider work (keys): sent on today's reset day, plus work not yet sent
    // that holds a reservation, live or withdrawn with its outcome uncertain (ADR 0003 4.2, ruling 3).
    // The ledger counts provider work: sent on today's reset day, plus unsettled work not yet sent,
    // which holds a reservation (ADR 0003 4.2).
    const counts =
      this.sql(
        `SELECT
           (SELECT COUNT(*) FROM attempts WHERE account_id = :id AND state IN ${LIVE_STATES}) AS live,
           (SELECT COUNT(*) FROM provider_work WHERE account_id = :id AND sent_day = :today) AS sent_today,
           (SELECT COUNT(*) FROM provider_work WHERE account_id = :id AND settled IS NULL AND sent_wall IS NULL) AS reserved`,
      ).get({ id, today: resetDayOf(now, resetZone) }) ?? {};
    const capacity = num(a, "capacity");
    const channel = str(a, "channel") === "sms" ? ("sms" as const) : ("email" as const);
    return {
      id,
      channel,
      capacity,
      gapMs: numOrNull(a, "gap_ms") ?? defaultGap(this.windowsServedBy(id, channel), capacity),
      k: num(a, "k"),
      nextSlotAt: num(a, "next_slot_at"),
      healthy: num(a, "healthy") === 1,
      problem: num(a, "healthy") === 1 ? null : (strOrNull(a, "problem") ?? "unhealthy"),
      waitUntil: numOrNull(a, "wait_until"),
      waitReason: strOrNull(a, "wait_reason") as AccountState["waitReason"],
      backoffMs: num(a, "backoff_ms"),
      resetZone,
      used: num(counts, "sent_today") + num(counts, "reserved"),
      inFlight: num(counts, "live"),
    };
  }

  /** The windows of every live track on the account's channel whose pool includes it (ADR 0003 4.1's default gap). */
  private windowsServedBy(accountId: string, channel: "email" | "sms"): WindowRule[][] {
    return this.sql("SELECT * FROM campaigns WHERE definition IS NOT NULL")
      .all()
      .map((c) => this.definitionOf(c))
      .filter((d) => poolOf(d, channel).includes(accountId))
      .flatMap((d) => d.tracks.filter((t) => !t.removed && t.channel === channel).map((t) => [...t.window]));
  }

  /** Parsed definitions, by campaign and definition version: a version is never rewritten. */
  private readonly definitions = new Map<string, CampaignDefinition>();

  private definitionOf(c: Row): CampaignDefinition {
    const key = `${str(c, "id")}/${num(c, "definition_version")}`;
    let def = this.definitions.get(key);
    if (!def) {
      def = parseDefinition(c);
      this.definitions.set(key, def);
    }
    return def;
  }

  private mergeDataOf(e: Row): MergeData {
    const company = this.sql("SELECT name, city FROM companies WHERE id = ?").get(str(e, "company_id"));
    const person = e["person_id"] == null ? undefined : this.sql("SELECT * FROM people WHERE id = ?").get(str(e, "person_id"));
    const data: Record<string, string> = { company: company ? str(company, "name") : "", city: company ? str(company, "city") : "" };
    if (person) {
      data["first_name"] = str(person, "first_name");
      data["last_name"] = str(person, "last_name");
      data["full_name"] = str(person, "display_name");
      data["title"] = str(person, "title");
    }
    return data;
  }

  private load(subjectId: string, now: number): SubjectState | null {
    const e = this.sql("SELECT * FROM enrollments WHERE id = ?").get(subjectId);
    if (!e) return null;
    const c = this.sql("SELECT * FROM campaigns WHERE id = ?").get(str(e, "campaign_id"));
    if (!c) throw new Error(`enrollment ${subjectId} has no campaign`);
    const definition = c["definition"] == null ? emptyDefinition(strOrNull(c, "default_timezone") ?? "UTC") : this.definitionOf(c);
    const personId = strOrNull(e, "person_id");
    const companyId = str(e, "company_id");
    const person = personId === null ? undefined : this.sql("SELECT timezone FROM people WHERE id = ?").get(personId);
    const company = this.sql("SELECT timezone FROM companies WHERE id = ?").get(companyId);

    const owner = personId === null ? { kind: "company", id: companyId } : { kind: "person", id: personId };
    const details: LeadDetail[] = this.sql("SELECT * FROM live_contact_details WHERE owner_kind = ? AND owner_id = ? ORDER BY row_order")
      .all(owner.kind, owner.id)
      .map((d) => ({
        id: str(d, "id"),
        channel: str(d, "channel") === "email" ? ("email" as const) : ("phone" as const),
        ownEmail: str(d, "channel") === "email" && num(d, "listed_shared") === 0,
        mobile: textable(d, owner.kind),
        key: str(d, "key"),
        value: str(d, "value"),
        bad: num(d, "bad") === 1,
        order: num(d, "row_order"),
      }));

    // Every number the user may dial for the lead: its own direct and mobile numbers, and the company main line (ADR 0001).
    const phones: CallNumber[] = this.sql(
      `SELECT * FROM live_contact_details WHERE channel = 'phone'
         AND ((owner_kind = 'person' AND owner_id = ?) OR (owner_kind = 'company' AND owner_id = ? AND phone_kind = 'main_line'))
       ORDER BY row_order`,
    )
      .all(personId ?? "", companyId)
      .map((d) => ({
        id: str(d, "id"),
        kind: str(d, "owner_kind") === "company" ? ("main_line" as const) : strOrNull(d, "phone_kind") === "mobile" ? ("mobile" as const) : ("direct" as const),
        owner: str(d, "owner_kind") === "company" ? ("company" as const) : ("person" as const),
        key: str(d, "key"),
        value: str(d, "value"),
        bad: num(d, "bad") === 1,
        order: num(d, "row_order"),
      }));

    const tracks = this.sql("SELECT * FROM track_progress WHERE subject_id = ? ORDER BY track_id").all(subjectId).map(toTrack);
    const attempts = this.sql("SELECT * FROM attempts WHERE subject_id = ? ORDER BY claimed_wall, rowid").all(subjectId).map(toAttempt);
    const callAttempts = this.sql("SELECT * FROM call_attempts WHERE subject_id = ? ORDER BY at_wall, rowid")
      .all(subjectId)
      .map((r): CallAttempt => ({ id: str(r, "id"), requestId: str(r, "request_id"), taskId: str(r, "task_id"), outcome: str(r, "outcome") as CallOutcome, redial: num(r, "redial") === 1, callbackAt: numOrNull(r, "callback_at"), numberDetailId: strOrNull(r, "number_detail_id"), note: str(r, "note"), at: num(r, "at"), atWall: num(r, "at_wall") }));
    // Every id that can name one of the lead's numbers resolves through the merge pointer (ADR 0001, ticket 12a):
    // the numbers recorded on its calls, and every detail a re-import folded into one of its numbers, so a
    // screen read before the merge names the same number.
    const mergedIntoPhones = this.sql(
      `WITH RECURSIVE merged(id) AS (
         SELECT d.id FROM contact_details d WHERE d.merged_into IN (SELECT value FROM json_each(?))
         UNION
         SELECT d.id FROM contact_details d JOIN merged m ON d.merged_into = m.id)
       SELECT id FROM merged`,
    )
      .all(JSON.stringify(phones.map((p) => p.id)))
      .map((r) => str(r, "id"));
    const referenced = new Set(
      [
        ...details.map((d) => d.id),
        ...tracks.map((t) => t.destinationDetailId),
        ...attempts.map((a) => a.destinationDetailId),
        ...callAttempts.map((c) => c.numberDetailId),
        ...mergedIntoPhones,
      ].filter((id): id is string => id !== null),
    );
    const resolved: Record<string, { liveId: string; bad: boolean; owned: boolean }> = {};
    for (const id of referenced) {
      const live = liveDetailRowOf(this.db, id);
      if (!live) continue;
      resolved[id] = {
        liveId: str(live, "id"),
        bad: num(live, "bad") === 1,
        // The lead may still send to it on its channel: its own email or shared inbox, or its own mobile.
        owned:
          str(live, "owner_kind") === owner.kind &&
          str(live, "owner_id") === owner.id &&
          (str(live, "channel") === "email" ? num(live, "listed_shared") === 0 : textable(live, owner.kind)),
      };
    }

    const accountIds = new Set([
      ...definition.emailPool,
      ...poolOf(definition, "sms"),
      ...attempts.map((a) => a.accountId),
      ...(e["email_sender"] == null ? [] : [str(e, "email_sender")]),
      ...(e["sms_sender"] == null ? [] : [str(e, "sms_sender")]),
    ]);
    const accounts: Record<string, AccountState> = {};
    for (const id of accountIds) {
      const a = this.accountState(id, now);
      if (a) accounts[id] = a;
    }

    const status = str(e, "status");
    if (!isOutreachStatus(status)) throw new Error(`unknown status ${status}`);
    return {
      subject: {
        id: subjectId,
        campaignId: str(e, "campaign_id"),
        version: num(e, "version"),
        status,
        ended: strOrNull(e, "ended") as EndReason | null,
        endedAt: numOrNull(e, "ended_at"),
        endedWall: numOrNull(e, "ended_wall"),
        leadPaused: num(e, "lead_paused") === 1,
        branch: str(e, "branch") === "win_back" ? "win_back" : "main",
        branchEnteredAt: numOrNull(e, "branch_entered_at"),
        touched: num(e, "touched") === 1,
        noMoreCalls: num(e, "no_more_calls") === 1,
        clock: { frozenSince: numOrNull(e, "frozen_since"), frozenTotal: num(e, "frozen_total") },
        emailSender: strOrNull(e, "email_sender"),
        smsSender: strOrNull(e, "sms_sender"),
        stopReply: e["stop_reply_channel"] == null ? null : { channel: str(e, "stop_reply_channel") === "sms" ? "sms" : "email", atWall: num(e, "stop_reply_at") },
      },
      campaign: {
        id: str(c, "id"),
        launchedAt: numOrNull(c, "launched_at"),
        pausedSince: numOrNull(c, "paused_since"),
        version: num(c, "version"),
        definitionVersion: num(c, "definition_version"),
        definition,
      },
      tracks,
      results: this.sql("SELECT * FROM step_results WHERE subject_id = ? ORDER BY at, rowid")
        .all(subjectId)
        .map((r) => ({
          stepId: str(r, "step_id"),
          trackId: str(r, "track_id"),
          result: str(r, "result") as StepOutcome,
          reason: strOrNull(r, "reason"),
          at: num(r, "at"),
          atWall: num(r, "at_wall"),
          attemptId: strOrNull(r, "attempt_id"),
        })),
      attempts,
      work: this.sql("SELECT * FROM provider_work WHERE subject_id = ? ORDER BY rowid").all(subjectId).map(toWork),
      freezes: this.sql("SELECT * FROM freezes WHERE subject_id = ? ORDER BY seq")
        .all(subjectId)
        .map((f) => ({ fromWall: num(f, "from_wall"), toWall: numOrNull(f, "to_wall") })),
      replies: this.sql("SELECT * FROM replies WHERE subject_id = ? ORDER BY at_wall, rowid")
        .all(subjectId)
        .map((r) => ({ channel: str(r, "channel") === "sms" ? ("sms" as const) : ("email" as const), atWall: num(r, "at_wall"), providerRef: str(r, "provider_ref") })),
      pendingReplies: this.sql(
        `SELECT DISTINCT inbox, address FROM reply_events
         WHERE state = 'pending'
           AND (address IN (SELECT lower(destination) FROM attempts WHERE subject_id = ?)
             OR address IN (SELECT lower(value) FROM live_contact_details WHERE owner_kind = ? AND owner_id = ? AND channel = 'email'))`,
      )
        .all(subjectId, owner.kind, owner.id)
        .map((r) => ({ inbox: str(r, "inbox"), address: str(r, "address") })),
      // Every unreleased conversation of the lead's numbers and of the numbers its texts went to, whoever owns it (4.5).
      smsBindings: this.sql(
        `SELECT b.sender_number, b.recipient_key, b.owner_subject, e.campaign_id AS owner_campaign, e.ended AS owner_ended FROM sms_bindings b
         LEFT JOIN enrollments e ON e.id = b.owner_subject
         WHERE b.released_at IS NULL
           AND (b.recipient_key IN (SELECT key FROM live_contact_details WHERE owner_kind = ? AND owner_id = ? AND channel = 'phone')
             OR b.recipient_key IN (SELECT destination FROM attempts WHERE subject_id = ?))
         ORDER BY b.seq`,
      )
        .all(owner.kind, owner.id, subjectId)
        .map((b) => ({ sender: str(b, "sender_number"), recipient: str(b, "recipient_key"), owner: str(b, "owner_subject"), ownerCampaignId: strOrNull(b, "owner_campaign"), ownerEnded: b["owner_ended"] != null })),
      lead: {
        zone: prospectZone([strOrNull(person ?? {}, "timezone"), company ? strOrNull(company, "timezone") : null], definition.timezone),
        details,
        resolved,
        mergeData: this.mergeDataOf(e),
        phones,
      },
      markBad: [],
      accounts,
      callTasks: this.sql("SELECT * FROM call_tasks WHERE subject_id = ? ORDER BY placed_wall, rowid").all(subjectId).map(toCallTask),
      callAttempts,
      recordedNumbers: Object.fromEntries(
        callAttempts.flatMap((c): [string, RecordedNumber][] => {
          const live = c.numberDetailId === null ? undefined : liveDetailRowOf(this.db, c.numberDetailId);
          if (!live || c.numberDetailId === null) return [];
          const company = str(live, "owner_kind") === "company";
          return [[c.numberDetailId, { id: str(live, "id"), kind: company ? "main_line" : strOrNull(live, "phone_kind") === "mobile" ? "mobile" : "direct", owner: company ? "company" : "person", key: str(live, "key") }]];
        }),
      ),
      newNotes: [],
      callDay: this.callDayAt(now),
    };
  }

  /** Writes what `next` changed relative to `base`, with the version bump and the derived status. */
  private write(base: SubjectState, next: SubjectState, now: number): SubjectState {
    const id = base.subject.id;
    if (next.subject.id !== id) throw new Error("a change may not move to another subject");
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    let changed = false;

    for (const t of next.tracks) {
      if (same(base.tracks.find((b) => b.trackId === t.trackId), t)) continue;
      changed = true;
      this.run(
        `INSERT OR REPLACE INTO track_progress (subject_id, track_id, start_at, start_basis_at, start_basis_wall, start_zone, started_at,
           destination_detail_id, next_step_id, basis_at, basis_wall, due_at, due_wall, due_zone, finished_at, finished_wall, finish_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, t.trackId, t.startAt, t.startBasisAt, t.startBasisWall, t.startZone, t.startedAt, t.destinationDetailId, t.nextStepId, t.basisAt, t.basisWall, t.dueAt, t.dueWall, t.dueZone, t.finishedAt, t.finishedWall, t.finishReason],
      );
    }
    for (const r of next.results) {
      const before = base.results.find((b) => b.stepId === r.stepId);
      if (before) {
        if (!same(before, r)) throw new Error(`a step result is never changed (${r.stepId})`);
        continue;
      }
      changed = true;
      this.run("INSERT INTO step_results (subject_id, step_id, track_id, result, reason, at, at_wall, attempt_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
        id, r.stepId, r.trackId, r.result, r.reason, r.at, r.atWall, r.attemptId,
      ]);
    }
    if (base.results.some((b) => !next.results.some((r) => r.stepId === b.stepId))) throw new Error("a step result is never deleted");

    // Provider work first: attempts point at it.
    for (const w of next.work) {
      const before = base.work.find((b) => b.key === w.key);
      if (same(before, w)) continue;
      if (before?.settled && before.settled !== w.settled) throw new Error(`provider work is settled once (${w.key})`);
      changed = true;
      this.run(
        `INSERT INTO provider_work (key, subject_id, track_id, step_id, account_id, destination, calls, first_handed_wall, provider_ref, settled,
           sent_wall, sent_day, next_lookup_wall, lookup_answer, queued_lookups, unresolved_since)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET calls = excluded.calls, first_handed_wall = excluded.first_handed_wall, provider_ref = excluded.provider_ref,
           settled = excluded.settled, sent_wall = excluded.sent_wall, sent_day = excluded.sent_day, next_lookup_wall = excluded.next_lookup_wall,
           lookup_answer = excluded.lookup_answer, queued_lookups = excluded.queued_lookups, unresolved_since = excluded.unresolved_since`,
        [w.key, id, w.trackId, w.stepId, w.accountId, w.destination, w.calls, w.firstHandedWall, w.providerRef, w.settled, w.sentWall, w.sentDay, w.nextLookupWall, w.lookupAnswer, w.queuedLookups, w.unresolvedSince],
      );
    }
    if (base.work.some((b) => !next.work.some((w) => w.key === b.key))) throw new Error("provider work is never deleted");
    for (const a of next.attempts) {
      if (same(base.attempts.find((b) => b.id === a.id), a)) continue;
      changed = true;
      this.run(
        `INSERT INTO attempts (id, subject_id, track_id, step_id, account_id, destination_detail_id, destination, state, copy, threading, thread_ref,
           retryable, not_sent_final, idempotency_key, calls, claimed_wall, handed_at, handed_wall, last_call_wall, presend_checked_wall,
           presend_found_reply, ended_by, withdraw_requested, withdraw_called, awaiting_answer, retry, reject_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, copy = excluded.copy, thread_ref = excluded.thread_ref,
           calls = excluded.calls, handed_at = excluded.handed_at, handed_wall = excluded.handed_wall,
           last_call_wall = excluded.last_call_wall, presend_checked_wall = excluded.presend_checked_wall, presend_found_reply = excluded.presend_found_reply,
           ended_by = excluded.ended_by, withdraw_requested = excluded.withdraw_requested,
           withdraw_called = excluded.withdraw_called, awaiting_answer = excluded.awaiting_answer, retry = excluded.retry,
           reject_reason = excluded.reject_reason`,
        [
          a.id, id, a.trackId, a.stepId, a.accountId, a.destinationDetailId, a.destination, a.state, a.copy ? JSON.stringify(a.copy) : null, a.threading, a.threadRef,
          a.retryable ? 1 : 0, a.notSentIsFinal ? 1 : 0, a.idempotencyKey, a.calls, a.claimedWall, a.handedAt, a.handedWall, a.lastCallWall, a.presendCheckedWall,
          a.presendFoundReply ? 1 : 0, a.endedBy, a.withdrawRequested ? 1 : 0, a.withdrawCalled ? 1 : 0, a.awaitingAnswer ? 1 : 0, a.retry, a.rejectReason,
        ],
      );
    }

    if (!same(base.freezes, next.freezes)) {
      changed = true;
      next.freezes.forEach((f, i) => {
        const before = base.freezes[i];
        if (!before) this.run("INSERT INTO freezes (subject_id, from_wall, to_wall) VALUES (?, ?, ?)", [id, f.fromWall, f.toWall]);
        else if (before.fromWall !== f.fromWall) throw new Error("the freezes record is append-only");
        else if (before.toWall !== f.toWall) {
          if (before.toWall !== null) throw new Error("a closed freeze never reopens");
          this.run("UPDATE freezes SET to_wall = ? WHERE subject_id = ? AND to_wall IS NULL", [f.toWall, id]);
        }
      });
    }
    for (const r of next.replies) {
      if (base.replies.some((b) => b.providerRef === r.providerRef)) continue;
      changed = true;
      this.run("INSERT INTO replies (provider_ref, subject_id, channel, at_wall) VALUES (?, ?, ?, ?)", [r.providerRef, id, r.channel, r.atWall]);
    }
    for (const b of next.smsBindings) {
      if (base.smsBindings.some((x) => x.sender === b.sender && x.recipient === b.recipient)) continue;
      if (b.owner !== id) throw new Error("a subject takes SMS bindings only for itself");
      changed = true;
      // The partial unique index refuses a second unreleased owner of the pair (4.5).
      this.run("INSERT INTO sms_bindings (sender_number, recipient_key, owner_subject, created_at) VALUES (?, ?, ?, ?)", [b.sender, b.recipient, id, now]);
    }
    if (base.smsBindings.some((b) => !next.smsBindings.some((x) => x.sender === b.sender && x.recipient === b.recipient))) throw new Error("an SMS binding is never removed by a subject's change");
    for (const t of next.callTasks) {
      const before = base.callTasks.find((b) => b.id === t.id);
      if (same(before, t)) continue;
      if (before && !before.open && t.open) throw new Error(`a closed call task never reopens (${t.id})`);
      // Fixed when the task is placed, and never updated below: a change is refused, not silently dropped (review bot on e489037).
      if (before && (before.dueAt !== t.dueAt || before.dueWall !== t.dueWall || before.dueZone !== t.dueZone)) throw new Error(`a call task keeps its original due time (${t.id})`);
      if (before && (before.placedWall !== t.placedWall || before.trackId !== t.trackId || before.stepId !== t.stepId || before.subjectId !== t.subjectId)) {
        throw new Error(`a call task keeps its placement, track and step (${t.id})`);
      }
      // The skip deadline changes only as the re-resolution of an edited limit from the task's own due time (ADR 0003
      // 3.5, 5.2): with the limit in force for its track and the user's zone now. Nothing else moves it.
      if (before && before.skipDeadline !== t.skipDeadline && t.skipDeadline !== skipDeadlineOf(t, skipLimitOf(next.campaign.definition, t.trackId), next.callDay.userZone)) {
        throw new Error(`a call task keeps its skip deadline unless its limit is edited (${t.id})`);
      }
      if (before && t.reckonedThrough < before.reckonedThrough) throw new Error(`a call task's skip limit is never judged again for a day already judged (${t.id})`);
      changed = true;
      this.run(
        `INSERT INTO call_tasks (id, subject_id, track_id, step_id, due_at, due_wall, due_zone, skip_deadline, list_day, placed_wall, kind, callback_at, open, closed_wall, skipped_wall, reckoned_through)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET skip_deadline = excluded.skip_deadline, list_day = excluded.list_day, kind = excluded.kind, callback_at = excluded.callback_at,
           open = excluded.open, closed_wall = excluded.closed_wall, skipped_wall = excluded.skipped_wall, reckoned_through = excluded.reckoned_through`,
        [t.id, id, t.trackId, t.stepId, t.dueAt, t.dueWall, t.dueZone, t.skipDeadline, t.listDay, t.placedWall, t.kind, t.callbackAt, t.open ? 1 : 0, t.closedWall, t.skippedWall, t.reckonedThrough],
      );
    }
    if (base.callTasks.some((b) => !next.callTasks.some((t) => t.id === b.id))) throw new Error("a call task is never deleted");
    for (const a of next.callAttempts) {
      if (base.callAttempts.some((b) => b.id === a.id)) continue;
      changed = true;
      // The unique request id refuses a second record of one action, even from another process.
      this.run("INSERT INTO call_attempts (id, request_id, task_id, subject_id, outcome, redial, callback_at, number_detail_id, note, at, at_wall) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [a.id, a.requestId, a.taskId, id, a.outcome, a.redial ? 1 : 0, a.callbackAt, a.numberDetailId, a.note, a.at, a.atWall]);
    }
    if (next.newNotes.length > 0) {
      const e = this.sql("SELECT person_id, company_id FROM enrollments WHERE id = ?").get(id);
      for (const n of next.newNotes) {
        if (base.newNotes.some((b) => b.id === n.id)) continue;
        changed = true;
        // The user's choice; a company lead has no person, so its notes are its company's.
        const personId = e ? strOrNull(e, "person_id") : null;
        const owner = n.owner === "person" && personId !== null ? { kind: "person", id: personId } : { kind: "company", id: e ? str(e, "company_id") : "" };
        this.run("INSERT INTO notes (id, owner_kind, owner_id, body, at_wall, subject_id, call_attempt_id) VALUES (?, ?, ?, ?, ?, ?, ?)", [n.id, owner.kind, owner.id, n.body, n.atWall, id, n.callAttemptId]);
      }
    }
    for (const detailId of next.markBad) {
      if (base.markBad.includes(detailId)) continue;
      const live = liveDetailRowOf(this.db, detailId);
      if (live) this.run("UPDATE contact_details SET bad = 1 WHERE id = ?", [str(live, "id")]);
    }
    for (const [accountId, a] of Object.entries(next.accounts)) {
      const b = base.accounts[accountId];
      if (!b) continue;
      if (a.nextSlotAt !== b.nextSlotAt) this.run("UPDATE sender_accounts SET next_slot_at = ? WHERE id = ?", [a.nextSlotAt, accountId]);
      if (a.waitUntil !== b.waitUntil || a.waitReason !== b.waitReason || a.backoffMs !== b.backoffMs) {
        this.run("UPDATE sender_accounts SET wait_until = ?, wait_reason = ?, backoff_ms = ? WHERE id = ?", [a.waitUntil, a.waitReason, a.backoffMs, accountId]);
      }
    }

    const s = next.subject;
    const subjectChanged = !same({ ...base.subject, status: null, version: null }, { ...s, status: null, version: null });
    if (!changed && !subjectChanged && next.markBad.length === base.markBad.length) return next;
    const status = deriveStatus(next);
    const version = base.subject.version + 1;
    this.run(
      `UPDATE enrollments SET version = ?, status = ?, ended = ?, ended_at = ?, ended_wall = ?, lead_paused = ?, branch = ?, branch_entered_at = ?,
         touched = ?, no_more_calls = ?, frozen_since = ?, frozen_total = ?, email_sender = ?, sms_sender = ?,
         stop_reply_channel = ?, stop_reply_at = ? WHERE id = ? AND version = ?`,
      [version, status, s.ended, s.endedAt, s.endedWall, s.leadPaused ? 1 : 0, s.branch, s.branchEnteredAt, s.touched ? 1 : 0, s.noMoreCalls ? 1 : 0, s.clock.frozenSince, s.clock.frozenTotal, s.emailSender, s.smsSender, s.stopReply?.channel ?? null, s.stopReply?.atWall ?? null, id, base.subject.version],
    );
    return { ...next, subject: { ...s, status, version } };
  }

  private run(sql: string, values: readonly SQLInputValue[]): void {
    this.sql(sql).run(...values);
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function parseDefinition(row: Row): CampaignDefinition {
  // Written by this module from a validated CampaignDefinition. One saved before ticket 13 has no SMS pool.
  const def = JSON.parse(str(row, "definition")) as CampaignDefinition;
  return def.smsPool ? def : { ...def, smsPool: [] };
}

/**
 * Whether a phone detail is an SMS destination of its owner (ADR 0001 "Usable channels"): a
 * person's own mobile, read as an international number. A company's main line never is.
 */
function textable(d: Row, ownerKind: string): boolean {
  return ownerKind === "person" && str(d, "channel") === "phone" && strOrNull(d, "phone_kind") === "mobile" && str(d, "key").startsWith("+");
}

function toCallTask(r: Row): CallTask {
  return {
    id: str(r, "id"),
    subjectId: str(r, "subject_id"),
    trackId: str(r, "track_id"),
    stepId: str(r, "step_id"),
    dueAt: num(r, "due_at"),
    dueWall: num(r, "due_wall"),
    dueZone: str(r, "due_zone"),
    skipDeadline: num(r, "skip_deadline"),
    listDay: num(r, "list_day"),
    placedWall: num(r, "placed_wall"),
    kind: str(r, "kind") === "callback" ? "callback" : "call",
    callbackAt: numOrNull(r, "callback_at"),
    open: num(r, "open") === 1,
    closedWall: numOrNull(r, "closed_wall"),
    skippedWall: numOrNull(r, "skipped_wall"),
    reckonedThrough: numOrNull(r, "reckoned_through") ?? num(r, "placed_wall"),
  };
}

function toTrack(r: Row): TrackProgress {
  return {
    trackId: str(r, "track_id"),
    startAt: numOrNull(r, "start_at"),
    startBasisAt: numOrNull(r, "start_basis_at"),
    startBasisWall: numOrNull(r, "start_basis_wall"),
    startZone: strOrNull(r, "start_zone"),
    startedAt: numOrNull(r, "started_at"),
    destinationDetailId: strOrNull(r, "destination_detail_id"),
    nextStepId: strOrNull(r, "next_step_id"),
    basisAt: numOrNull(r, "basis_at"),
    basisWall: numOrNull(r, "basis_wall"),
    dueAt: numOrNull(r, "due_at"),
    dueWall: numOrNull(r, "due_wall"),
    dueZone: strOrNull(r, "due_zone"),
    finishedAt: numOrNull(r, "finished_at"),
    finishedWall: numOrNull(r, "finished_wall"),
    finishReason: strOrNull(r, "finish_reason") as FinishReason | null,
  };
}

function toAttempt(r: Row): Attempt {
  return {
    id: str(r, "id"),
    subjectId: str(r, "subject_id"),
    trackId: str(r, "track_id"),
    stepId: str(r, "step_id"),
    accountId: str(r, "account_id"),
    destinationDetailId: str(r, "destination_detail_id"),
    destination: str(r, "destination"),
    state: str(r, "state") as AttemptState,
    // Written by this module from a RenderedCopy.
    copy: r["copy"] == null ? null : (JSON.parse(str(r, "copy")) as Attempt["copy"]),
    threading: str(r, "threading") === "continue_thread" ? "continue_thread" : "new_subject",
    threadRef: strOrNull(r, "thread_ref"),
    retryable: num(r, "retryable") === 1,
    notSentIsFinal: num(r, "not_sent_final") === 1,
    idempotencyKey: str(r, "idempotency_key"),
    calls: num(r, "calls"),
    claimedWall: num(r, "claimed_wall"),
    handedAt: numOrNull(r, "handed_at"),
    handedWall: numOrNull(r, "handed_wall"),
    lastCallWall: numOrNull(r, "last_call_wall"),
    presendCheckedWall: numOrNull(r, "presend_checked_wall"),
    presendFoundReply: num(r, "presend_found_reply") === 1,
    endedBy: strOrNull(r, "ended_by") as Attempt["endedBy"],
    withdrawRequested: num(r, "withdraw_requested") === 1,
    withdrawCalled: num(r, "withdraw_called") === 1,
    awaitingAnswer: num(r, "awaiting_answer") === 1,
    retry: str(r, "retry") as Attempt["retry"],
    rejectReason: strOrNull(r, "reject_reason") as RejectReason | null,
  };
}

function toWork(r: Row): ProviderWork {
  return {
    key: str(r, "key"),
    subjectId: str(r, "subject_id"),
    trackId: str(r, "track_id"),
    stepId: str(r, "step_id"),
    accountId: str(r, "account_id"),
    destination: str(r, "destination"),
    calls: num(r, "calls"),
    firstHandedWall: numOrNull(r, "first_handed_wall"),
    providerRef: strOrNull(r, "provider_ref"),
    settled: strOrNull(r, "settled") as WorkSettlement | null,
    sentWall: numOrNull(r, "sent_wall"),
    sentDay: strOrNull(r, "sent_day"),
    nextLookupWall: numOrNull(r, "next_lookup_wall"),
    lookupAnswer: strOrNull(r, "lookup_answer") as LookupAnswer | null,
    queuedLookups: num(r, "queued_lookups"),
    unresolvedSince: numOrNull(r, "unresolved_since"),
  };
}

function toReplyEvent(r: Row): ReplyEvent {
  return {
    eventId: str(r, "event_id"),
    providerRef: strOrNull(r, "provider_ref"),
    inbox: str(r, "inbox"),
    address: str(r, "address"),
    atWall: num(r, "at_wall"),
    receivedWall: num(r, "received_wall"),
    state: str(r, "state") as ReplyEvent["state"],
    waitedMs: num(r, "waited_ms"),
    lastCountedWall: num(r, "last_counted_wall"),
  };
}

function str(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new Error(`column ${column} is not text`);
  return value;
}

function strOrNull(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`column ${column} is not text`);
  return value;
}

function num(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`column ${column} is not a number`);
}

function numOrNull(row: Row, column: string): number | null {
  const value = row[column];
  return value === null || value === undefined ? null : num(row, column);
}

/** The definition as a row holds it, for an answer built inside the transaction that wrote it. */
function storedDefinitionOf(row: Row): StoredDefinition {
  return {
    definition: parseDefinition(row),
    definitionVersion: num(row, "definition_version"),
    definitionEditedAt: strOrNull(row, "definition_edited_at"),
    launchedAt: numOrNull(row, "launched_at"),
  };
}
