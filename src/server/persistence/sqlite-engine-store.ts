import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from "node:sqlite";
import type { SenderAccountView } from "../../domain/sequence/blockers.ts";
import { prospectZone, resetDayOf, type WindowRule } from "../../domain/sequence/clock.ts";
import { defaultGap } from "../../domain/sequence/dispatch.ts";
import type { MergeData } from "../../domain/sequence/copy.ts";
import { emptyDefinition, type CampaignDefinition } from "../../domain/sequence/definition.ts";
import { deriveStatus } from "../../domain/sequence/progress.ts";
import type {
  AccountState,
  Attempt,
  AttemptState,
  EndReason,
  FinishReason,
  LeadDetail,
  LookupAnswer,
  RejectReason,
  StepOutcome,
  SubjectState,
  TrackProgress,
} from "../../domain/sequence/state.ts";
import { isOutreachStatus } from "../../domain/outreach-status.ts";
import type { CampaignEngineRow, EngineStore, LaunchOutcome, SenderAccountConfig } from "../engine/engine-store.ts";
import { liveDetailRowOf } from "./sqlite-store.ts";

type Row = Record<string, SQLOutputValue>;

const LIVE_STATES = "('claimed', 'handed', 'accepted')";

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

  async saveDefinition(campaignId: string, definition: CampaignDefinition, editedAt: string): Promise<"saved" | "launched" | "missing"> {
    return this.transaction(() => {
      const row = this.sql("SELECT launched_at FROM campaigns WHERE id = ?").get(campaignId);
      if (!row) return "missing";
      if (row["launched_at"] != null) return "launched";
      this.run(
        "UPDATE campaigns SET definition = ?, definition_version = definition_version + 1, definition_edited_at = ?, version = version + 1 WHERE id = ?",
        [JSON.stringify(definition), editedAt, campaignId],
      );
      return "saved";
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
  ): Promise<LaunchOutcome> {
    return this.transaction((): LaunchOutcome => {
      const row = this.sql("SELECT * FROM campaigns WHERE id = ?").get(campaignId);
      if (!row || row["definition"] == null) return { ok: false, check: null, reason: "no_definition" };
      if (row["launched_at"] != null) return { ok: false, check: null, reason: "already_launched" };
      const { leads, accounts } = this.launchInputsNow(campaignId);
      const check = decide(parseDefinition(row), leads, accounts);
      if (!check.canLaunch) return { ok: false, check, reason: "blocked" };
      this.run("UPDATE campaigns SET launched_at = ?, version = version + 1 WHERE id = ?", [now, campaignId]);
      for (const e of this.sql("SELECT id FROM enrollments WHERE campaign_id = ? ORDER BY enrolled_at, id").all(campaignId)) {
        const base = this.load(str(e, "id"), now);
        if (base) this.write(base, enter(base));
      }
      return { ok: true };
    });
  }

  async subject(subjectId: string, now: number): Promise<SubjectState | null> {
    return this.load(subjectId, now);
  }

  async update(subjectId: string, now: number, decide: (state: SubjectState) => SubjectState | null): Promise<SubjectState | null> {
    return this.transaction(() => {
      const base = this.load(subjectId, now);
      if (!base) return null;
      const next = decide(base);
      if (!next) return null;
      return this.write(base, next);
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
                OR (e.person_id IS NULL AND d.owner_kind = 'company' AND d.owner_id = e.company_id)), '') || '/' ||
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
    return this.sql(`SELECT * FROM attempts WHERE state IN ${LIVE_STATES} OR (state = 'withdrawn' AND ended_by = 'lookup_not_sent') ORDER BY claimed_wall, rowid`)
      .all()
      .map(toAttempt);
  }

  async attempt(attemptId: string): Promise<Attempt | null> {
    const row = this.sql("SELECT * FROM attempts WHERE id = ?").get(attemptId);
    return row ? toAttempt(row) : null;
  }

  async attemptsByKey(key: string): Promise<Attempt[]> {
    return this.sql("SELECT * FROM attempts WHERE idempotency_key = ? ORDER BY claimed_wall, rowid").all(key).map(toAttempt);
  }

  async subjectsReachedFrom(inbox: string, address: string): Promise<string[]> {
    // A reply outside any known thread is reconciled by the inbox it reached and the lead's address (ruling 1).
    return this.sql(
      `SELECT DISTINCT a.subject_id FROM attempts a WHERE a.account_id = ? AND lower(a.destination) = lower(?) AND a.calls > 0 ORDER BY a.subject_id`,
    )
      .all(inbox, address)
      .map((r) => str(r, "subject_id"));
  }

  async attemptByProviderRef(providerRef: string): Promise<Attempt | null> {
    const row = this.sql("SELECT * FROM attempts WHERE provider_ref = ? ORDER BY rowid LIMIT 1").get(providerRef);
    return row ? toAttempt(row) : null;
  }

  async upsertAccounts(accounts: readonly SenderAccountConfig[]): Promise<void> {
    this.transaction(() => {
      for (const a of accounts) {
        this.run(
          `INSERT INTO sender_accounts (id, channel, label, capacity, gap_ms, k, healthy, reset_zone) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET channel = excluded.channel, label = excluded.label, capacity = excluded.capacity,
             gap_ms = excluded.gap_ms, k = excluded.k, healthy = excluded.healthy, reset_zone = excluded.reset_zone`,
          [a.id, a.channel, a.label, a.capacity, a.gapMs, a.k, a.healthy ? 1 : 0, a.resetZone],
        );
      }
    });
  }

  async accounts(now: number): Promise<AccountState[]> {
    return this.sql("SELECT id FROM sender_accounts ORDER BY id").all().map((r) => this.accountState(str(r, "id"), now)).filter((a): a is AccountState => a !== null);
  }

  async pushSlot(accountId: string, callStart: number): Promise<void> {
    const account = this.accountState(accountId, callStart);
    if (account) this.run("UPDATE sender_accounts SET next_slot_at = MAX(next_slot_at, ?) WHERE id = ?", [callStart + account.gapMs, accountId]);
  }

  async accountLabels(): Promise<Record<string, string>> {
    return Object.fromEntries(this.sql("SELECT id, label FROM sender_accounts").all().map((r) => [str(r, "id"), str(r, "label")]));
  }

  async updateAccount(accountId: string, change: Partial<Pick<AccountState, "healthy" | "waitUntil" | "waitReason" | "backoffMs">>): Promise<void> {
    this.transaction(() => {
      if (change.healthy !== undefined) this.run("UPDATE sender_accounts SET healthy = ? WHERE id = ?", [change.healthy ? 1 : 0, accountId]);
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

  async recordAnomaly(attemptId: string | null, what: string, atWall: number): Promise<void> {
    this.run("INSERT INTO provider_anomalies (attempt_id, what, at_wall) VALUES (?, ?, ?)", [attemptId, what, atWall]);
  }

  async anomalies(): Promise<{ attemptId: string | null; what: string; atWall: number }[]> {
    return this.sql("SELECT * FROM provider_anomalies ORDER BY seq")
      .all()
      .map((r) => ({ attemptId: strOrNull(r, "attempt_id"), what: str(r, "what"), atWall: num(r, "at_wall") }));
  }

  // -------------------------------------------------------------------------------------------

  private accountState(id: string, now: number): AccountState | null {
    const a = this.sql("SELECT * FROM sender_accounts WHERE id = ?").get(id);
    if (!a) return null;
    const resetZone = str(a, "reset_zone");
    // The ledger counts provider work (keys): sent on today's reset day, plus work not yet sent
    // that holds a reservation, live or withdrawn with its outcome uncertain (ADR 0003 4.2, ruling 3).
    const counts =
      this.sql(
        `SELECT
           (SELECT COUNT(*) FROM attempts WHERE account_id = :id AND state IN ${LIVE_STATES}) AS live,
           (SELECT COUNT(DISTINCT idempotency_key) FROM attempts WHERE account_id = :id AND sent_wall IS NOT NULL AND sent_day = :today) AS sent_today,
           (SELECT COUNT(DISTINCT a.idempotency_key) FROM attempts a WHERE a.account_id = :id AND a.holds_reservation = 1
              AND NOT EXISTS (SELECT 1 FROM attempts s WHERE s.idempotency_key = a.idempotency_key AND s.sent_wall IS NOT NULL)) AS reserved`,
      ).get({ id, today: resetDayOf(now, resetZone) }) ?? {};
    const capacity = num(a, "capacity");
    return {
      id,
      channel: "email",
      capacity,
      gapMs: numOrNull(a, "gap_ms") ?? defaultGap(this.windowsServedBy(id), capacity),
      k: num(a, "k"),
      nextSlotAt: num(a, "next_slot_at"),
      healthy: num(a, "healthy") === 1,
      waitUntil: numOrNull(a, "wait_until"),
      waitReason: strOrNull(a, "wait_reason") as AccountState["waitReason"],
      backoffMs: num(a, "backoff_ms"),
      resetZone,
      used: num(counts, "sent_today") + num(counts, "reserved"),
      inFlight: num(counts, "live"),
    };
  }

  /** The windows of every live email track whose pool includes the account (ADR 0003 4.1's default gap). */
  private windowsServedBy(accountId: string): WindowRule[][] {
    return this.sql("SELECT * FROM campaigns WHERE definition IS NOT NULL")
      .all()
      .map((c) => this.definitionOf(c))
      .filter((d) => d.emailPool.includes(accountId))
      .flatMap((d) => d.tracks.filter((t) => !t.removed && t.channel === "email").map((t) => [...t.window]));
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
        value: str(d, "value"),
        bad: num(d, "bad") === 1,
        order: num(d, "row_order"),
      }));

    const tracks = this.sql("SELECT * FROM track_progress WHERE subject_id = ? ORDER BY track_id").all(subjectId).map(toTrack);
    const attempts = this.sql("SELECT * FROM attempts WHERE subject_id = ? ORDER BY claimed_wall, rowid").all(subjectId).map(toAttempt);
    const referenced = new Set(
      [...details.map((d) => d.id), ...tracks.map((t) => t.destinationDetailId), ...attempts.map((a) => a.destinationDetailId)].filter((id): id is string => id !== null),
    );
    const resolved: Record<string, { liveId: string; bad: boolean; owned: boolean }> = {};
    for (const id of referenced) {
      const live = liveDetailRowOf(this.db, id);
      if (!live) continue;
      resolved[id] = {
        liveId: str(live, "id"),
        bad: num(live, "bad") === 1,
        owned: str(live, "owner_kind") === owner.kind && str(live, "owner_id") === owner.id && str(live, "channel") === "email" && num(live, "listed_shared") === 0,
      };
    }

    const accountIds = new Set([...definition.emailPool, ...attempts.map((a) => a.accountId), ...(e["email_sender"] == null ? [] : [str(e, "email_sender")])]);
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
      freezes: this.sql("SELECT * FROM freezes WHERE subject_id = ? ORDER BY seq")
        .all(subjectId)
        .map((f) => ({ fromWall: num(f, "from_wall"), toWall: numOrNull(f, "to_wall") })),
      replies: this.sql("SELECT * FROM replies WHERE subject_id = ? ORDER BY at_wall, rowid")
        .all(subjectId)
        .map((r) => ({ channel: str(r, "channel") === "sms" ? ("sms" as const) : ("email" as const), atWall: num(r, "at_wall"), providerRef: str(r, "provider_ref") })),
      lead: {
        zone: prospectZone([strOrNull(person ?? {}, "timezone"), company ? strOrNull(company, "timezone") : null], definition.timezone),
        details,
        resolved,
        mergeData: this.mergeDataOf(e),
      },
      markBad: [],
      accounts,
    };
  }

  /** Writes what `next` changed relative to `base`, with the version bump and the derived status. */
  private write(base: SubjectState, next: SubjectState): SubjectState {
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

    for (const a of next.attempts) {
      if (same(base.attempts.find((b) => b.id === a.id), a)) continue;
      changed = true;
      this.run(
        `INSERT INTO attempts (id, subject_id, track_id, step_id, account_id, destination_detail_id, destination, state, copy, threading, thread_ref, provider_ref,
           retryable, not_sent_final, idempotency_key, calls, claimed_wall, handed_at, handed_wall, last_call_wall, presend_checked_wall,
           presend_found_reply, lookup_answer, queued_lookups, next_lookup_wall, unresolved_since, ended_by, withdraw_requested, withdraw_called,
           awaiting_answer, retry, reject_reason, sent_wall, sent_day, user_marked_not_sent, holds_reservation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, copy = excluded.copy, thread_ref = excluded.thread_ref,
           provider_ref = excluded.provider_ref, calls = excluded.calls, handed_at = excluded.handed_at, handed_wall = excluded.handed_wall,
           last_call_wall = excluded.last_call_wall, presend_checked_wall = excluded.presend_checked_wall, presend_found_reply = excluded.presend_found_reply,
           lookup_answer = excluded.lookup_answer, queued_lookups = excluded.queued_lookups, next_lookup_wall = excluded.next_lookup_wall,
           unresolved_since = excluded.unresolved_since, ended_by = excluded.ended_by, withdraw_requested = excluded.withdraw_requested,
           withdraw_called = excluded.withdraw_called, awaiting_answer = excluded.awaiting_answer, retry = excluded.retry,
           reject_reason = excluded.reject_reason, sent_wall = excluded.sent_wall, sent_day = excluded.sent_day,
           user_marked_not_sent = excluded.user_marked_not_sent, holds_reservation = excluded.holds_reservation`,
        [
          a.id, id, a.trackId, a.stepId, a.accountId, a.destinationDetailId, a.destination, a.state, a.copy ? JSON.stringify(a.copy) : null, a.threading, a.threadRef, a.providerRef,
          a.retryable ? 1 : 0, a.notSentIsFinal ? 1 : 0, a.idempotencyKey, a.calls, a.claimedWall, a.handedAt, a.handedWall, a.lastCallWall, a.presendCheckedWall,
          a.presendFoundReply ? 1 : 0, a.lookupAnswer, a.queuedLookups, a.nextLookupWall, a.unresolvedSince, a.endedBy, a.withdrawRequested ? 1 : 0, a.withdrawCalled ? 1 : 0,
          a.awaitingAnswer ? 1 : 0, a.retry, a.rejectReason, a.sentWall, a.sentDay, a.userMarkedNotSent ? 1 : 0, a.holdsReservation ? 1 : 0,
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
         touched = ?, no_more_calls = ?, frozen_since = ?, frozen_total = ?, email_sender = ? WHERE id = ? AND version = ?`,
      [version, status, s.ended, s.endedAt, s.endedWall, s.leadPaused ? 1 : 0, s.branch, s.branchEnteredAt, s.touched ? 1 : 0, s.noMoreCalls ? 1 : 0, s.clock.frozenSince, s.clock.frozenTotal, s.emailSender, id, base.subject.version],
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
  // Written by this module from a validated CampaignDefinition.
  return JSON.parse(str(row, "definition")) as CampaignDefinition;
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
    providerRef: strOrNull(r, "provider_ref"),
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
    lookupAnswer: strOrNull(r, "lookup_answer") as LookupAnswer | null,
    queuedLookups: num(r, "queued_lookups"),
    nextLookupWall: numOrNull(r, "next_lookup_wall"),
    unresolvedSince: numOrNull(r, "unresolved_since"),
    endedBy: strOrNull(r, "ended_by") as Attempt["endedBy"],
    withdrawRequested: num(r, "withdraw_requested") === 1,
    withdrawCalled: num(r, "withdraw_called") === 1,
    awaitingAnswer: num(r, "awaiting_answer") === 1,
    retry: str(r, "retry") as Attempt["retry"],
    rejectReason: strOrNull(r, "reject_reason") as RejectReason | null,
    sentWall: numOrNull(r, "sent_wall"),
    sentDay: strOrNull(r, "sent_day"),
    userMarkedNotSent: num(r, "user_marked_not_sent") === 1,
    holdsReservation: num(r, "holds_reservation") === 1,
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
