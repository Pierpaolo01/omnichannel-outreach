/**
 * The outbox worker (ADR 0003 5.5) and restart settlement (section 6). It runs the pure rules
 * against the store and calls the provider only through the port, and only after the handover or
 * retry write that authorizes the call has committed. One tick runs passes until nothing changes:
 * observe, expire claims, settle, withdraw, evaluate, claim, hand over.
 */
import { ENGINE_PARAMS, isLive, type AttemptEvent, type CallAnswer } from "../../domain/sequence/attempt.ts";
import { launchCheck, type LaunchCheck } from "../../domain/sequence/blockers.ts";
import { leadNow, localDayNumber, nextWindowOpen, resetDayOf, startOfLocalDay } from "../../domain/sequence/clock.ts";
import { windowOf, type ReadyItem } from "../../domain/sequence/dispatch.ts";
import type { Attempt, SubjectState } from "../../domain/sequence/state.ts";
import type { EngineStore } from "./engine-store.ts";
import type { AttemptRef, ProviderEvent, SendPort } from "./ports.ts";
import { DEFAULT_RULES, type Rules } from "./rules.ts";

export type CrashPoint = "after_claim" | "after_presend" | "after_handover_commit" | "after_call" | "after_retry_commit" | "after_lookup" | "after_observe_event";

export interface EngineHooks {
  /** Between computing an evaluation and applying it (ADR 0003 9.2: user events between evaluate and apply). */
  beforeApplyEvaluation?(subjectId: string): Promise<void>;
  /** Between the claim commit and the handover commit. */
  beforeHandover?(attemptId: string): Promise<void>;
  /** Named points at which a test may simulate a crash by throwing. */
  crashPoint?(point: CrashPoint, attemptId: string | null): void;
}

export interface EngineDependencies {
  readonly store: EngineStore;
  readonly port: SendPort;
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  readonly newId: () => string;
  readonly rules?: Partial<Rules>;
  readonly hooks?: EngineHooks;
}

const OBSERVE_CHECKPOINT = "email_observe_checkpoint";
const MAX_PASSES = 50;
const QUOTA_WAIT = Number.MAX_SAFE_INTEGER;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class Engine {
  private readonly store: EngineStore;
  private readonly port: SendPort;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly rules: Rules;
  private readonly hooks: EngineHooks;
  /**
   * Subjects known to need nothing, by version key, until a wall instant: evaluated with no
   * change, or with nothing ready to claim. A change to the subject, its campaign or its lead
   * facts changes the key; the instant is the next time-driven change (a deadline or a start).
   */
  private readonly settled = new Map<string, { key: string; until: number }>();
  private readonly nothingReady = new Map<string, { key: string; until: number }>();
  /** Per subject and version: the wall instants its pending steps fall due, with their windows. */
  private readonly wakeCache = new Map<string, { version: string; due: { wall: number; window: ReturnType<typeof windowOf>; zone: string }[] }>();

  constructor(deps: EngineDependencies) {
    this.store = deps.store;
    this.port = deps.port;
    this.now = deps.now;
    this.newId = deps.newId;
    this.rules = { ...DEFAULT_RULES, ...deps.rules };
    this.hooks = deps.hooks ?? {};
  }

  // -------------------------------------------------------------------------------------------
  // Entry points.

  /** Launches a campaign if nothing blocks it, and runs a tick. */
  async launch(campaignId: string): Promise<{ ok: true } | { ok: false; reason: string; check: LaunchCheck | null }> {
    await this.syncAccounts();
    const now = this.now();
    const outcome = await this.store.launch(campaignId, now, launchCheck, (s) => this.rules.evaluate(this.rules.enterMain(s, now), now));
    if (!outcome.ok) return outcome;
    await this.tick();
    return { ok: true };
  }

  /** Section 6: settle what a crash left open, then run a normal tick. */
  async recover(): Promise<void> {
    for (const a of await this.store.openAttempts()) {
      // The crash row of 5.3: a call whose answer was never recorded is an unknown answer.
      if ((a.state === "handed" || a.state === "accepted") && a.awaitingAnswer) {
        await this.applyAttempt(a, { kind: "call_answer", answer: { kind: "unknown" }, now: this.now() });
      }
    }
    await this.tick();
  }

  async tick(): Promise<void> {
    await this.syncAccounts();
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let changed = false;
      changed = (await this.observe()) || changed;
      changed = (await this.expireClaims()) || changed;
      changed = (await this.settle()) || changed;
      changed = (await this.withdraw()) || changed;
      changed = (await this.evaluateAll()) || changed;
      changed = (await this.claimAll()) || changed;
      changed = (await this.handOverAll()) || changed;
      if (!changed) return;
    }
  }

  /** The next instant at which a tick could change something, for the worker loop and the tests' clock. */
  async nextWakeAt(): Promise<number | null> {
    const now = this.now();
    const times: number[] = [];
    for (const [id, version] of await this.store.runningSubjectVersions()) {
      let cached = this.wakeCache.get(id);
      if (cached?.version !== version) {
        const state = await this.store.subject(id, now);
        if (!state) continue;
        const s = state;
        // A running subject's lead time advances with the wall, so a deadline's wall instant is fixed.
        const due = s.tracks
          .filter((p) => p.finishedAt === null && p.nextStepId !== null && p.dueAt !== null)
          .filter((p) => !s.attempts.some((a) => a.stepId === p.nextStepId && isLive(a)))
          .map((p) => ({ wall: now + ((p.dueAt ?? 0) - leadNow(s.subject.clock, now)), window: windowOf(s, p.trackId), zone: s.lead.zone }));
        cached = { version, due };
        this.wakeCache.set(id, cached);
      }
      for (const d of cached.due) {
        if (d.wall > now) times.push(d.wall);
        else {
          const opens = nextWindowOpen(d.window, d.zone, now);
          if (opens !== null && opens > now) times.push(opens);
        }
      }
    }
    const accounts = new Map((await this.store.accounts(now)).map((a) => [a.id, a]));
    for (const a of await this.store.openAttempts()) {
      const slot = accounts.get(a.accountId)?.nextSlotAt ?? 0;
      if (a.state === "claimed") times.push(a.claimedWall + ENGINE_PARAMS.SETTLING, slot);
      if (a.retry === "wanted" || a.retry === "wanted_after_not_sent") times.push(slot);
      if (a.nextLookupWall !== null) times.push(a.nextLookupWall);
    }
    for (const acc of accounts.values()) {
      if (acc.waitUntil !== null && acc.waitUntil !== QUOTA_WAIT) times.push(acc.waitUntil);
      // Capacity frees at the account's next reset day.
      times.push(startOfLocalDay(localDayNumber(now, acc.resetZone) + 1, acc.resetZone));
    }
    const future = times.filter((t) => t > now);
    return future.length > 0 ? Math.min(...future) : null;
  }

  /** ADR 0002 P3's resolution of an unresolved attempt. The controls arrive with ticket 20; the rule is here. */
  async markAttempt(attemptId: string, mark: "sent" | "not_sent"): Promise<boolean> {
    const a = await this.store.attempt(attemptId);
    if (!a) return false;
    return this.applyAttempt(a, { kind: mark === "sent" ? "mark_sent" : "mark_not_sent", now: this.now() });
  }

  // -------------------------------------------------------------------------------------------
  // Accounts.

  private async syncAccounts(): Promise<void> {
    const statuses = await this.port.accounts();
    await this.store.upsertAccounts(statuses);
    const known = new Map((await this.store.accounts(this.now())).map((a) => [a.id, a]));
    for (const s of statuses) {
      if (s.quotaAvailable && known.get(s.id)?.waitReason === "quota") await this.store.updateAccount(s.id, { waitUntil: null, waitReason: null });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Applying facts to a subject.

  private resetDay(s: SubjectState) {
    return (accountId: string, t: number) => resetDayOf(t, s.accounts[accountId]?.resetZone ?? "UTC");
  }

  /** Applies one attempt event and its consequences in one transaction. True if anything changed. */
  private async applyAttempt(attempt: Pick<Attempt, "id" | "subjectId">, event: AttemptEvent): Promise<boolean> {
    const now = this.now();
    const anomalies: string[] = [];
    const written = await this.store.update(attempt.subjectId, now, (s) => {
      if (!s.attempts.some((a) => a.id === attempt.id)) return null;
      const out = this.rules.applyToAttempt(s, attempt.id, event, now, { resetDay: this.resetDay(s), point: this.rules.sendPoint });
      let next = out.state;
      const accountId = s.attempts.find((a) => a.id === attempt.id)?.accountId ?? "";
      const account = next.accounts[accountId];
      for (const effect of out.effects) {
        if (effect.kind === "anomaly") anomalies.push(effect.what);
        if (effect.kind === "rejected" && account && effect.reason === "payment_required") {
          next = { ...next, accounts: { ...next.accounts, [accountId]: { ...account, waitUntil: QUOTA_WAIT, waitReason: "quota" } } };
        }
        if (effect.kind === "rejected" && account && effect.reason === "rate_limited") {
          const backoffMs = effect.retryAfterMs ?? (account.backoffMs > 0 ? account.backoffMs * 2 : 60_000);
          next = { ...next, accounts: { ...next.accounts, [accountId]: { ...account, waitUntil: now + backoffMs, waitReason: "rate_limited", backoffMs } } };
        }
      }
      if (event.kind === "call_answer" && event.answer.kind === "accepted" && account && account.backoffMs > 0) {
        next = { ...next, accounts: { ...next.accounts, [accountId]: { ...account, backoffMs: 0 } } };
      }
      return same(next, s) ? null : next;
    });
    for (const what of anomalies) await this.store.recordAnomaly(attempt.id, what, now);
    return written !== null;
  }

  private async observe(): Promise<boolean> {
    const checkpoint = await this.store.meta(OBSERVE_CHECKPOINT);
    const { events, checkpoint: next } = await this.port.observe(checkpoint);
    let changed = false;
    for (const event of events) {
      changed = (await this.applyEvent(event)) || changed;
      this.hooks.crashPoint?.("after_observe_event", null);
    }
    if (next !== checkpoint) await this.store.setMeta(OBSERVE_CHECKPOINT, next);
    return changed;
  }

  /** Matches a provider event to its attempt by reference, else by idempotency key (ADR 0002 "Recovery"). */
  private async attemptFor(event: { providerRef: string; key?: string }): Promise<Attempt | null> {
    const byRef = await this.store.attemptByProviderRef(event.providerRef);
    if (byRef || event.key === undefined) return byRef;
    const withKey = (await this.store.openAttempts()).filter((a) => a.idempotencyKey === event.key);
    return withKey.find((a) => isLive(a)) ?? withKey.at(-1) ?? null;
  }

  private async applyEvent(event: ProviderEvent): Promise<boolean> {
    const now = this.now();
    if (event.kind === "reply") {
      const a = await this.attemptFor({ providerRef: event.providerRef });
      if (!a) {
        await this.store.recordAnomaly(null, "a reply on a thread the app does not know", now);
        return false;
      }
      return (await this.store.update(a.subjectId, now, (s) => {
        const next = this.rules.applyReply(s, { channel: "email", atWall: Math.min(event.at, now), providerRef: event.id }, now);
        return same(next, s) ? null : next;
      })) !== null;
    }
    const a = await this.attemptFor(event);
    if (!a) {
      await this.store.recordAnomaly(null, `a ${event.kind} event the app cannot match`, now);
      return false;
    }
    if (event.kind === "sent") return this.applyAttempt(a, { kind: "sent_observed", providerTime: event.sentAt, providerRef: event.providerRef });
    if (event.kind === "rejected") return this.applyAttempt(a, { kind: "provider_rejected", reason: event.reason });
    // A bounce after a send marks the address bad and fails the track if it is unfinished.
    return (await this.store.update(a.subjectId, now, (s) => {
      const current = s.attempts.find((x) => x.id === a.id);
      if (!current) return null;
      const next = this.rules.applyBadDestination(s, current, now);
      return same(next, s) ? null : next;
    })) !== null;
  }

  // -------------------------------------------------------------------------------------------
  // Bounded waiting states (5.3, 5.5 step 5).

  private async expireClaims(): Promise<boolean> {
    const now = this.now();
    let changed = false;
    for (const a of await this.store.openAttempts()) {
      if (a.state === "claimed" && now - a.claimedWall >= ENGINE_PARAMS.SETTLING) changed = (await this.applyAttempt(a, { kind: "claim_expired", now })) || changed;
    }
    return changed;
  }

  private ref(a: Attempt): AttemptRef {
    return { idempotencyKey: a.idempotencyKey, providerRef: a.providerRef, sender: a.accountId, destination: a.destination };
  }

  private async settle(): Promise<boolean> {
    let changed = false;
    for (const a of await this.store.openAttempts()) {
      if (a.state !== "handed" && a.state !== "accepted") continue;
      if (a.retry === "wanted" || a.retry === "wanted_after_not_sent" || a.awaitingAnswer) continue;
      if (a.nextLookupWall === null || a.nextLookupWall > this.now()) continue;
      let answer: Awaited<ReturnType<SendPort["lookup"]>>;
      try {
        answer = await this.port.lookup(this.ref(a));
      } catch {
        answer = { kind: "unknown" };
      }
      this.hooks.crashPoint?.("after_lookup", a.id);
      changed = (await this.applyAttempt(a, { kind: "lookup_answer", answer, now: this.now() })) || changed;
    }
    return changed;
  }

  private async withdraw(): Promise<boolean> {
    let changed = false;
    for (const a of await this.store.openAttempts()) {
      if (!a.withdrawRequested || a.withdrawCalled || (a.state !== "handed" && a.state !== "accepted")) continue;
      let answer: "withdrawn" | "too-late" | "unknown";
      try {
        answer = await this.port.withdraw(this.ref(a));
      } catch {
        answer = "unknown";
      }
      changed = (await this.applyAttempt(a, { kind: "withdraw_answer", answer, now: this.now() })) || changed;
    }
    return changed;
  }

  // -------------------------------------------------------------------------------------------
  // Evaluation (2.6) with the version guard (2.5).

  private async evaluateAll(): Promise<boolean> {
    let changed = false;
    for (const [id, version] of await this.store.runningSubjectVersions()) {
      const now = this.now();
      const known = this.settled.get(id);
      if (known?.key === version && now < known.until) continue;
      const snapshot = await this.store.subject(id, now);
      if (!snapshot) continue;
      const next = this.rules.evaluate(snapshot, now);
      if (same(next, snapshot)) {
        const lead = leadNow(snapshot.subject.clock, now);
        const starts = snapshot.tracks.filter((p) => p.startedAt === null && p.startAt !== null).map((p) => now + ((p.startAt ?? 0) - lead));
        this.settled.set(id, { key: version, until: Math.min(Infinity, ...starts.filter((t) => t > now)) });
        continue;
      }
      await this.hooks.beforeApplyEvaluation?.(id);
      const written = await this.store.update(id, now, (current) => (this.rules.versionsMatch(snapshot, current) ? { ...next, accounts: current.accounts } : null));
      changed = changed || written !== null;
    }
    return changed;
  }

  // -------------------------------------------------------------------------------------------
  // Claims (4.2) in priority order (4.3).

  private async claimAll(): Promise<boolean> {
    const now = this.now();
    const ready: { item: ReadyItem; snapshot: SubjectState }[] = [];
    for (const [id, version] of await this.store.runningSubjectVersions()) {
      const known = this.nothingReady.get(id);
      if (known?.key === version && now < known.until) continue;
      const snapshot = await this.store.subject(id, now);
      if (!snapshot) continue;
      const items = this.rules.readyItems(snapshot, now);
      if (items.length === 0) {
        const lead = leadNow(snapshot.subject.clock, now);
        const dues = snapshot.tracks.filter((p) => p.finishedAt === null && p.dueAt !== null).map((p) => now + ((p.dueAt ?? 0) - lead));
        this.nothingReady.set(id, { key: version, until: Math.min(Infinity, ...dues.filter((t) => t > now)) });
      }
      for (const item of items) ready.push({ item, snapshot });
    }
    ready.sort((a, b) => this.rules.claimOrder(a.item, b.item));
    let changed = false;
    for (const { item, snapshot } of ready) {
      // Cheap refusals on the snapshot first; the transaction checks everything again on current state.
      if (this.rules.claimRefusal(snapshot, item, now) !== null) continue;
      const step = snapshot.campaign.definition.tracks.find((t) => t.id === item.trackId)?.steps.find((s) => s.id === item.stepId);
      const transport = this.port.transportFor({ threading: step?.threading ?? "new_subject" });
      const attemptId = this.newId();
      const written = await this.store.update(item.subjectId, now, (s) => {
        if (!this.rules.versionsMatch(snapshot, s)) return null;
        if (this.rules.claimRefusal(s, item, now) !== null) return null;
        const account = this.rules.chooseAccount(s, now);
        if (!account) return null;
        return this.rules.claim(s, item, account, { attemptId, retryable: transport.retryable, notSentIsFinal: transport.notSentIsFinal, now });
      });
      if (written) {
        changed = true;
        this.hooks.crashPoint?.("after_claim", attemptId);
      }
    }
    return changed;
  }

  // -------------------------------------------------------------------------------------------
  // Handovers and retries (5.5, 5.6), per account in priority order.

  private async handOverAll(): Promise<boolean> {
    let changed = false;
    const waiting = new Set(
      (await this.store.openAttempts())
        .filter((a) => a.state === "claimed" || (a.state === "handed" && (a.retry === "wanted" || a.retry === "wanted_after_not_sent")))
        .map((a) => a.accountId),
    );
    for (const account of await this.store.accounts(this.now())) {
      if (!waiting.has(account.id)) continue;
      const skipped = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const now = this.now();
        const current = (await this.store.accounts(now)).find((a) => a.id === account.id);
        if (!current || now < current.nextSlotAt) break;
        const next = await this.nextForSlot(account.id, skipped, now);
        if (!next) break;
        const outcome = next.retry ? await this.tryRetry(next.attempt) : await this.tryHandover(next.attempt);
        if (outcome === "skip") skipped.add(next.attempt.id);
        else changed = true;
        if (outcome === "waiting") break;
      }
    }
    return changed;
  }

  /** The attempt the account's next slot goes to: same-key retries first, then claims, each by priority. */
  private async nextForSlot(accountId: string, skipped: ReadonlySet<string>, now: number): Promise<{ attempt: Attempt; retry: boolean } | null> {
    const open = (await this.store.openAttempts()).filter((a) => a.accountId === accountId && !skipped.has(a.id) && isLive(a));
    const candidates: { attempt: Attempt; retry: boolean; item: ReadyItem }[] = [];
    for (const a of open) {
      const retry = a.state === "handed" && (a.retry === "wanted" || a.retry === "wanted_after_not_sent");
      if (a.state !== "claimed" && !retry) continue;
      const s = await this.store.subject(a.subjectId, now);
      const dueWall = s?.tracks.find((t) => t.trackId === a.trackId)?.dueWall ?? 0;
      candidates.push({ attempt: a, retry, item: { subjectId: a.subjectId, trackId: a.trackId, stepId: a.stepId, touched: s?.subject.touched ?? false, dueWall } });
    }
    candidates.sort((x, y) => (x.retry !== y.retry ? (x.retry ? -1 : 1) : this.rules.handoverOrder(x.item, y.item)));
    return candidates[0] ?? null;
  }

  /** ADR 0002's pre-send check, recorded on the attempt. False when it could not run or found a reply. */
  private async presend(a: Attempt): Promise<boolean> {
    const now = this.now();
    if (a.presendCheckedWall !== null && a.presendCheckedWall >= now - ENGINE_PARAMS.PRESEND_MAX_AGE && !a.presendFoundReply) return true;
    const subject = await this.store.subject(a.subjectId, now);
    const threadRefs = (subject?.attempts ?? []).filter((x) => x.providerRef !== null).map((x) => x.providerRef ?? "");
    let result: Awaited<ReturnType<SendPort["presendCheck"]>>;
    try {
      result = await this.port.presendCheck({ sender: a.accountId, destination: a.destination, threadRefs });
    } catch {
      result = { kind: "unavailable" };
    }
    if (result.kind === "unavailable") return false;
    await this.store.update(a.subjectId, now, (s) => {
      let next: SubjectState = { ...s, attempts: s.attempts.map((x) => (x.id === a.id ? { ...x, presendCheckedWall: now, presendFoundReply: result.kind === "reply" } : x)) };
      if (result.kind === "reply") next = this.rules.applyReply(next, { channel: "email", atWall: Math.min(result.at, now), providerRef: result.providerRef }, now);
      return next;
    });
    this.hooks.crashPoint?.("after_presend", a.id);
    return result.kind === "clear";
  }

  /** A call answer that arrives after the call returned, such as a response delivered twice (5.3: ignored unless it moves forward). */
  async receiveLateAnswer(attemptId: string, answer: CallAnswer): Promise<void> {
    const a = await this.store.attempt(attemptId);
    if (a && a.state !== "claimed") await this.applyAttempt(a, { kind: "call_answer", answer, now: this.now() });
  }

  private async call(a: Attempt): Promise<CallAnswer> {
    if (!a.copy) throw new Error(`attempt ${a.id} has no stored copy`);
    const subject = await this.store.subject(a.subjectId, this.now());
    const threading = subject?.campaign.definition.tracks.find((t) => t.id === a.trackId)?.steps.find((s) => s.id === a.stepId)?.threading ?? "new_subject";
    const request = {
      threading,
      attemptId: a.id,
      idempotencyKey: a.idempotencyKey,
      sender: a.accountId,
      destination: a.destination,
      rendered: a.copy,
      threadRef: a.threadRef,
      subjectId: a.subjectId,
      stepId: a.stepId,
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<CallAnswer>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "unknown" }), ENGINE_PARAMS.CALL_TIMEOUT);
      });
      return await Promise.race([this.port.handover(request), timeout]);
    } catch {
      return { kind: "unknown" };
    } finally {
      clearTimeout(timer);
    }
  }

  private async tryHandover(a: Attempt): Promise<"handed" | "withdrawn" | "waiting" | "skip"> {
    if (!(await this.presend(a))) {
      const after = await this.store.attempt(a.id);
      return after?.state === "claimed" ? "skip" : "withdrawn";
    }
    await this.hooks.beforeHandover?.(a.id);
    const now = this.now();
    const out: { handed: Attempt | null; onlySlot: boolean } = { handed: null, onlySlot: false };
    await this.store.update(a.subjectId, now, (s) => {
      const current = s.attempts.find((x) => x.id === a.id);
      const account = current ? s.accounts[current.accountId] : undefined;
      if (!current || current.state !== "claimed" || !account) return null;
      const failed = this.rules.handoverFailures(s, current, account, now);
      if (failed.length === 0) {
        const next = this.rules.handOver(s, current, account, now);
        out.handed = next.attempts.find((x) => x.id === a.id) ?? null;
        return next;
      }
      if (failed.every((f) => f === 16)) {
        out.onlySlot = true;
        return null;
      }
      return this.rules.applyToAttempt(s, current.id, { kind: "guard_failed" }, now, { resetDay: this.resetDay(s) }).state;
    });
    const handed = out.handed;
    if (!handed) return out.onlySlot ? "waiting" : "withdrawn";
    this.hooks.crashPoint?.("after_handover_commit", a.id);
    const answer = await this.call(handed);
    this.hooks.crashPoint?.("after_call", a.id);
    await this.applyAttempt(handed, { kind: "call_answer", answer, now: this.now() });
    return "handed";
  }

  private async tryRetry(a: Attempt): Promise<"handed" | "withdrawn" | "waiting" | "skip"> {
    const fresh = await this.presend(a);
    const now = this.now();
    const out: { handed: Attempt | null; onlySlot: boolean } = { handed: null, onlySlot: false };
    await this.store.update(a.subjectId, now, (s) => {
      const current = s.attempts.find((x) => x.id === a.id);
      const account = current ? s.accounts[current.accountId] : undefined;
      if (!current || !account || (current.retry !== "wanted" && current.retry !== "wanted_after_not_sent")) return null;
      const failed = fresh ? this.rules.retryFailures(s, current, account, now) : ["predicate 14"];
      if (failed.length === 0) {
        const next = this.rules.authorizeRetry(s, current, account, now);
        out.handed = next.attempts.find((x) => x.id === a.id) ?? null;
        return next;
      }
      if (failed.every((f) => f === "slot")) {
        out.onlySlot = true;
        return null;
      }
      return this.rules.applyToAttempt(s, current.id, { kind: "retry_refused", now }, now, { resetDay: this.resetDay(s) }).state;
    });
    const authorized = out.handed;
    if (!authorized) return out.onlySlot ? "waiting" : "withdrawn";
    this.hooks.crashPoint?.("after_retry_commit", a.id);
    const answer = await this.call(authorized);
    this.hooks.crashPoint?.("after_call", a.id);
    await this.applyAttempt(authorized, { kind: "call_answer", answer, now: this.now() });
    return "handed";
  }
}
