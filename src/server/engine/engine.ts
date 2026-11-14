/**
 * The outbox worker (ADR 0003 5.5) and restart settlement (section 6). It runs the pure rules
 * against the store and calls the provider only through the port, and only after the handover or
 * retry write that authorizes the call has committed. One tick runs passes until nothing changes:
 * observe, expire claims, settle, withdraw, evaluate, claim, hand over.
 */
import { ENGINE_PARAMS, isLive, type AttemptEffect, type AttemptEvent, type CallAnswer, type WorkEvent } from "../../domain/sequence/attempt.ts";
import { launchCheck, type LaunchCheck } from "../../domain/sequence/blockers.ts";
import { REQUEST_ID_REUSED, type OutcomeInput } from "../../domain/sequence/calls.ts";
import { leadNow, localDayNumber, nextWindowOpen, resetDayOf, runningCredit, startOfLocalDay } from "../../domain/sequence/clock.ts";
import { windowOf, type ReadyItem } from "../../domain/sequence/dispatch.ts";
import type { Attempt, ProviderWork, SubjectState } from "../../domain/sequence/state.ts";
import type { EngineStore, ReplyEvent, StoredDefinition } from "./engine-store.ts";
import { UnprovisionedSmsPort, type AttemptRef, type HandoverRequest, type ProviderEvent, type SendPort } from "./ports.ts";
import { DEFAULT_RULES, type Rules } from "./rules.ts";

export type CrashPoint = "after_claim" | "after_presend" | "after_handover_commit" | "after_call" | "after_retry_commit" | "after_lookup" | "after_observe_event";

export interface EngineHooks {
  /** Between computing an evaluation and applying it (ADR 0003 9.2: user events between evaluate and apply). */
  beforeApplyEvaluation?(subjectId: string): Promise<void>;
  /** Between the claim commit and the handover commit. */
  beforeHandover?(attemptId: string): Promise<void>;
  /** Right after a claim commits, before the next claim (ADR 0003 invariant 12: the tests check priority at the claim). */
  afterClaim?(attemptId: string): Promise<void>;
  /** Before a same-key retry is authorized (ADR 0003 9.2: retries racing a quiesce). */
  beforeRetry?(attemptId: string): Promise<void>;
  /**
   * Between a send's authorization commit and its provider call. Synchronous: nothing
   * asynchronous may happen there (ruling 2). Tests inject a reply and a clock advance here.
   */
  afterAuthorization?(attemptId: string): void;
  /** Named points at which a test may simulate a crash by throwing. */
  crashPoint?(point: CrashPoint, attemptId: string | null): void;
  /** After each step of a tick's pass (ADR 0003 4.4): the tests move the clock here, between every pair of steps. */
  afterStep?(step: TickStep): void;
}

/** A tick's steps, in the order each pass runs them (ADR 0003 2.6, 4.4). */
export const TICK_STEPS = ["sync accounts", "observe", "correlate", "expire claims", "recover stuck answers", "settle", "fall back held replies", "withdraw", "evaluate", "place calls", "claim", "hand over"] as const;
export type TickStep = (typeof TICK_STEPS)[number];

/**
 * Serializes, per inbox, a send's authorization, its provider call and the pacing slot it takes,
 * across every engine in the process (ruling 2), and knows which calls are in progress.
 */
export class InboxLocks {
  private readonly tails = new Map<string, Promise<void>>();
  readonly calling = new Set<string>();

  async run<T>(inbox: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(inbox) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => mine);
    this.tails.set(inbox, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(inbox) === tail) this.tails.delete(inbox);
    }
  }
}

const PROCESS_LOCKS = new InboxLocks();

/**
 * Runs one engine tick at a time in a process (ruling 1 of review round 2): the timer, a launch,
 * restart settlement, the user's mark and a late answer each queue behind the running one.
 */
export class TickQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

const PROCESS_TICKS = new TickQueue();

/** Waits for a port call at most `ms`; the default uses a real timer. */
export function waitWithTimer<T>(promise: Promise<T>, ms: number, timedOut: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface EngineDependencies {
  readonly store: EngineStore;
  /** The email port. */
  readonly port: SendPort;
  /** The SMS port (ticket 13); the unprovisioned one when absent, since no SMS provider exists (#28). */
  readonly smsPort?: SendPort;
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  readonly newId: () => string;
  readonly rules?: Partial<Rules>;
  readonly hooks?: EngineHooks;
  /**
   * Bounds every wait on the provider (ruling 5): a pre-send check, lookup, withdrawal,
   * observation or send call that has not answered within `ms` counts as `timedOut`.
   */
  readonly waitFor?: <T>(promise: Promise<T>, ms: number, timedOut: T) => Promise<T>;
  readonly locks?: InboxLocks;
  /** Where this engine's ticks queue; the process's by default. A test's second worker stands for another process. */
  readonly ticks?: TickQueue;
}

type Channel = "email" | "sms";
const OBSERVE_CHECKPOINT: Record<Channel, string> = { email: "email_observe_checkpoint", sms: "sms_observe_checkpoint" };
const CHANNELS: readonly Channel[] = ["email", "sms"];
const MAX_PASSES = 50;
const QUOTA_WAIT = Number.MAX_SAFE_INTEGER;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class Engine {
  private readonly store: EngineStore;
  private readonly ports: Record<Channel, SendPort>;
  /** Each sender account's channel, so its attempts reach the right port. */
  private readonly channels = new Map<string, Channel>();
  /**
   * The clock. A tick reads it once, at its start, and passes that instant to every step (ADR 0003
   * 4.4, "One instant per tick"); only the entry points and the send act read it (eslint.config.js).
   */
  private readonly clock: () => number;
  /**
   * The latest instant a send act recorded in the running tick (its pre-send check, authorization,
   * call start or answer). The tick's next pass is as of no earlier instant, so nothing it records
   * runs before a send already recorded (ADR 0003 4.4, "One instant per tick").
   */
  private lastActAt = 0;
  private readonly newId: () => string;
  private readonly rules: Rules;
  private readonly hooks: EngineHooks;
  private readonly waitFor: <T>(promise: Promise<T>, ms: number, timedOut: T) => Promise<T>;
  private readonly locks: InboxLocks;
  private readonly ticks: TickQueue;
  /**
   * Subjects known to need nothing, by version key, until a wall instant: evaluated with no
   * change, or with nothing ready to claim. A change to the subject, its campaign or its lead
   * facts changes the key; the instant is the next time-driven change (a deadline or a start).
   * Correct only while `runningSubjectVersions` names every input of `evaluate` and
   * `readyItems`: a ticket that adds an input (a call task, a pause) adds it to that key.
   */
  private readonly settled = new Map<string, { key: string; until: number }>();
  private readonly nothingReady = new Map<string, { key: string; until: number }>();
  /** Subjects with no due call to place, by version key and call settings, until a wall instant. */
  private readonly noCallsReady = new Map<string, { key: string; until: number }>();
  /** Per subject and version: the wall instants its pending steps fall due, with their windows. */
  private readonly wakeCache = new Map<string, { version: string; due: { wall: number; window: ReturnType<typeof windowOf> | null; zone: string }[] }>();

  constructor(deps: EngineDependencies) {
    this.store = deps.store;
    this.ports = { email: deps.port, sms: deps.smsPort ?? new UnprovisionedSmsPort() };
    this.clock = deps.now;
    this.newId = deps.newId;
    this.rules = { ...DEFAULT_RULES, ...deps.rules };
    this.hooks = deps.hooks ?? {};
    this.waitFor = deps.waitFor ?? waitWithTimer;
    this.locks = deps.locks ?? PROCESS_LOCKS;
    this.ticks = deps.ticks ?? PROCESS_TICKS;
  }

  /** A port call bounded by CALL_TIMEOUT; a throw counts as the timed-out answer. */
  private bounded<T>(call: () => Promise<T>, timedOut: T): Promise<T> {
    let started: Promise<T>;
    try {
      started = call().catch(() => timedOut);
    } catch {
      return Promise.resolve(timedOut);
    }
    return this.waitFor(started, ENGINE_PARAMS.CALL_TIMEOUT, timedOut);
  }

  // -------------------------------------------------------------------------------------------
  // Entry points.

  /** Launches a campaign if nothing blocks it, and runs a tick. */
  launch(campaignId: string, expectedDefinitionVersion?: number): Promise<{ ok: true; stored: StoredDefinition } | { ok: false; reason: string; check: LaunchCheck | null }> {
    return this.ticks.run(async () => {
      const now = this.clock();
      await this.syncAccounts(now);
      const outcome = await this.store.launch(campaignId, now, launchCheck, (s) => this.rules.evaluate(this.rules.enterMain(s, now), now), expectedDefinitionVersion);
      if (!outcome.ok) return outcome;
      await this.runTick(now);
      return { ok: true as const, stored: outcome.stored };
    });
  }

  /**
   * Section 6: settle what a crash left open, then run a normal tick. The time the application was
   * not running is not counted as a held reply's wait; outstanding provider events are observed and
   * uncertain work looked up before any held reply is evaluated (PR 37 review round 3).
   */
  recover(): Promise<void> {
    return this.ticks.run(async () => {
      const now = this.clock();
      for (const r of await this.store.pendingReplies()) await this.store.updateReplyEvent(r.eventId, { lastCountedWall: now });
      for (const a of await this.store.openAttempts()) {
        // The crash row of 5.3: a call whose answer was never recorded is an unknown answer.
        if ((a.state === "handed" || a.state === "accepted") && a.awaitingAnswer) {
          await this.applyAttempt(a, { kind: "call_answer", answer: { kind: "unknown" }, now }, now);
        }
      }
      await this.observe(now);
      await this.settle(now);
      await this.runTick(now);
    });
  }

  tick(): Promise<void> {
    return this.ticks.run(() => this.runTick(this.clock()));
  }

  /**
   * One tick, as of the one instant `now` (ADR 0003 4.4, "One instant per tick"): every step and
   * every pass decides as of it, and the call placement's marker is set to it. No step reads the
   * clock; only the send act takes its own instants, for the provider exchange it is (5.5 step 6).
   */
  private async runTick(start: number): Promise<void> {
    const step = (name: TickStep) => this.hooks.afterStep?.(name);
    let now = start;
    this.lastActAt = start;
    await this.syncAccounts(now);
    step("sync accounts");
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      // A pass after a send act is as of the latest instant that act recorded; no step reads the clock.
      now = Math.max(now, this.lastActAt);
      let changed = false;
      const observed = await this.observe(now);
      changed = observed.changed || changed;
      step("observe");
      changed = (await this.correlate(now, observed.ok, false)) || changed;
      step("correlate");
      changed = (await this.expireClaims(now)) || changed;
      step("expire claims");
      changed = (await this.recoverStuckAnswers(now)) || changed;
      step("recover stuck answers");
      changed = (await this.settle(now)) || changed;
      step("settle");
      // A held reply falls back only after this pass's lookups have had their chance to attach its reference.
      changed = (await this.correlate(now, false, true)) || changed;
      step("fall back held replies");
      changed = (await this.withdraw(now)) || changed;
      step("withdraw");
      changed = (await this.evaluateAll(now)) || changed;
      step("evaluate");
      changed = (await this.placeCallsAll(now)) || changed;
      step("place calls");
      changed = (await this.claimAll(now)) || changed;
      step("claim");
      changed = (await this.handOverAll(now)) || changed;
      step("hand over");
      if (!changed) return;
    }
  }

  /** The instant through which call placement is complete and stored (ADR 0003 4.4); null before the first pass. */
  callsPlacedThrough(): Promise<number | null> {
    return this.store.callsPlacedThrough();
  }

  /**
   * The earliest instant after `after` at which the call list can change by placement (ADR 0003 4.4):
   * a phone track due to start, a due call step not yet placed (at its due time, or, once due, at the
   * next user day after `after`, when hours and room are counted again). Email and SMS work is left out.
   */
  async nextCallWakeAt(after: number, now: number = this.clock()): Promise<number | null> {
    const times: number[] = [];
    for (const id of await this.store.runningSubjectIds()) {
      const s = await this.store.subject(id, now);
      if (!s) continue;
      const lead = leadNow(s.subject.clock, now);
      for (const p of s.tracks) {
        if (s.campaign.definition.tracks.find((t) => t.id === p.trackId)?.channel !== "call" || p.finishedAt !== null) continue;
        if (p.startedAt === null) {
          if (p.startAt !== null) times.push(now + (p.startAt - lead));
          continue;
        }
        if (p.nextStepId === null || p.dueAt === null || s.callTasks.some((t) => t.stepId === p.nextStepId)) continue;
        const due = now + (p.dueAt - lead);
        times.push(due > after ? due : await this.nextUserDay(after));
      }
    }
    const later = times.filter((t) => t > after);
    return later.length > 0 ? Math.min(...later) : null;
  }

  /** The next instant at which a tick could change something, for the worker loop and the tests' clock. */
  async nextWakeAt(now: number = this.clock()): Promise<number | null> {
    const from = now;
    const times: number[] = [];
    for (const [id, version] of await this.store.runningSubjectVersions()) {
      let cached = this.wakeCache.get(id);
      if (cached?.version !== version) {
        const state = await this.store.subject(id, now);
        if (!state) continue;
        const s = state;
        // A running subject's lead time advances with the wall, so a deadline's wall instant is fixed.
        const isCall = (trackId: string) => s.campaign.definition.tracks.find((t) => t.id === trackId)?.channel === "call";
        const due = s.tracks
          .filter((p) => p.finishedAt === null && p.nextStepId !== null && p.dueAt !== null)
          .filter((p) => !s.attempts.some((a) => a.stepId === p.nextStepId && isLive(a)))
          .filter((p) => !s.callTasks.some((t) => t.stepId === p.nextStepId))
          // A due call not yet placed waits for the next user day: its calling hours or the day's capacity (4.4).
          .map((p) => ({ wall: now + ((p.dueAt ?? 0) - leadNow(s.subject.clock, now)), window: isCall(p.trackId) ? null : windowOf(s, p.trackId), zone: s.lead.zone }));
        // A track waiting to start after another (ticket 13) starts at its resolved instant; it has no window of its own to wait for then.
        for (const p of s.tracks) if (p.startedAt === null && p.startAt !== null) due.push({ wall: now + (p.startAt - leadNow(s.subject.clock, now)), window: [], zone: s.lead.zone });
        cached = { version, due };
        this.wakeCache.set(id, cached);
      }
      for (const d of cached.due) {
        if (d.wall > from) times.push(d.wall);
        else if (d.window === null) times.push(await this.nextUserDay(from));
        else {
          const opens = nextWindowOpen(d.window, d.zone, from);
          if (opens !== null && opens > from) times.push(opens);
        }
      }
    }
    const accounts = new Map((await this.store.accounts(now)).map((a) => [a.id, a]));
    for (const a of await this.store.openAttempts()) {
      const slot = accounts.get(a.accountId)?.nextSlotAt ?? 0;
      if (a.state === "claimed") times.push(a.claimedWall + ENGINE_PARAMS.SETTLING, slot);
      if (a.awaitingAnswer) times.push((a.lastCallWall ?? a.claimedWall) + ENGINE_PARAMS.CALL_TIMEOUT);
      if (a.retry === "wanted" || a.retry === "wanted_after_not_sent") times.push(slot);
    }
    for (const w of await this.store.openWork()) if (w.nextLookupWall !== null) times.push(w.nextLookupWall);
    // A held reply falls back once it has waited one settling period of running time.
    // Each observation credits at most MAX_RUNNING_CREDIT, so the worker wakes at least that often while one waits.
    for (const r of await this.store.pendingReplies()) times.push(r.lastCountedWall + Math.min(ENGINE_PARAMS.SETTLING - r.waitedMs, ENGINE_PARAMS.MAX_RUNNING_CREDIT));
    for (const acc of accounts.values()) {
      if (acc.waitUntil !== null && acc.waitUntil !== QUOTA_WAIT) times.push(acc.waitUntil);
      // Capacity frees at the account's next reset day.
      times.push(startOfLocalDay(localDayNumber(from, acc.resetZone) + 1, acc.resetZone));
    }
    const future = times.filter((t) => t > from);
    return future.length > 0 ? Math.min(...future) : null;
  }

  /** ADR 0002 P3's resolution of unresolved work, by any attempt carrying it. The controls arrive with ticket 20; the rule is here. */
  markAttempt(attemptId: string, mark: "sent" | "not_sent"): Promise<boolean> {
    return this.ticks.run(async () => {
      const a = await this.store.attempt(attemptId);
      if (!a) return false;
      const now = this.clock();
      return this.applyWork(a.subjectId, a.idempotencyKey, { kind: mark === "sent" ? "mark_sent" : "mark_not_sent", now }, now);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Accounts.

  private async syncAccounts(now: number): Promise<void> {
    for (const channel of CHANNELS) {
      const statuses = await this.bounded(() => this.ports[channel].accounts(), null);
      if (statuses === null) continue;
      await this.store.upsertAccounts(statuses);
      // An account its provider no longer lists is disconnected: claims for it wait, and Needs attention lists it.
      await this.store.disconnectUnlisted(channel, statuses.map((a) => a.id));
      const known = new Map((await this.store.accounts(now)).map((a) => [a.id, a]));
      for (const s of statuses) {
        this.channels.set(s.id, channel);
        if (s.quotaAvailable && known.get(s.id)?.waitReason === "quota") await this.store.updateAccount(s.id, { waitUntil: null, waitReason: null });
      }
    }
  }

  /** The port an account's sends travel by. */
  private async portOf(accountId: string, now: number): Promise<SendPort> {
    let channel = this.channels.get(accountId);
    if (channel === undefined) {
      for (const a of await this.store.accounts(now)) this.channels.set(a.id, a.channel);
      channel = this.channels.get(accountId) ?? "email";
    }
    return this.ports[channel];
  }

  // -------------------------------------------------------------------------------------------
  // Applying facts to a subject.

  private resetDay(s: SubjectState) {
    return (accountId: string, t: number) => resetDayOf(t, s.accounts[accountId]?.resetZone ?? "UTC");
  }

  /** Applies one attempt event and its consequences in one transaction. True if anything changed. */
  private async applyAttempt(attempt: Pick<Attempt, "id" | "subjectId">, event: AttemptEvent, now: number): Promise<boolean> {
    return this.applyChange(now, attempt.subjectId, attempt.id, (s) => {
      if (!s.attempts.some((a) => a.id === attempt.id)) return null;
      return { out: this.rules.applyToAttempt(s, attempt.id, event, now), accountId: s.attempts.find((a) => a.id === attempt.id)?.accountId ?? "" };
    }, event.kind === "call_answer" && event.answer.kind === "accepted");
  }

  /** Applies one event about provider work, to the work and every attempt carrying it, in one transaction. */
  private async applyWork(subjectId: string, key: string, event: WorkEvent, now: number): Promise<boolean> {
    return this.applyChange(now, subjectId, null, (s) => {
      const w = s.work.find((x) => x.key === key);
      if (!w) return null;
      return { out: this.rules.applyToWork(s, key, event, now, { resetDay: this.resetDay(s), point: this.rules.sendPoint }), accountId: w.accountId };
    }, false);
  }

  private async applyChange(
    now: number,
    subjectId: string,
    attemptId: string | null,
    decide: (s: SubjectState) => { out: { state: SubjectState; effects: readonly AttemptEffect[] }; accountId: string } | null,
    accepted: boolean,
  ): Promise<boolean> {
    const anomalies: string[] = [];
    const written = await this.store.update(subjectId, now, (s) => {
      const decided = decide(s);
      if (!decided) return null;
      let next = decided.out.state;
      const accountId = decided.accountId;
      const account = next.accounts[accountId];
      for (const effect of decided.out.effects) {
        if (effect.kind === "anomaly") anomalies.push(effect.what);
        if (effect.kind === "rejected" && account && effect.reason === "payment_required") {
          next = { ...next, accounts: { ...next.accounts, [accountId]: { ...account, waitUntil: QUOTA_WAIT, waitReason: "quota" } } };
        }
        if (effect.kind === "rejected" && account && effect.reason === "rate_limited") {
          const backoffMs = effect.retryAfterMs ?? (account.backoffMs > 0 ? account.backoffMs * 2 : 60_000);
          next = { ...next, accounts: { ...next.accounts, [accountId]: { ...account, waitUntil: now + backoffMs, waitReason: "rate_limited", backoffMs } } };
        }
      }
      if (accepted && account && account.backoffMs > 0) next = { ...next, accounts: { ...next.accounts, [accountId]: { ...account, backoffMs: 0 } } };
      return same(next, s) ? null : next;
    });
    for (const what of anomalies) await this.store.recordAnomaly(attemptId, what, now);
    return written !== null;
  }

  /**
   * Observes every provider; `ok` is false when the email provider could not be observed, which is
   * what a held email reply's running time depends on.
   */
  private async observe(now: number): Promise<{ changed: boolean; ok: boolean }> {
    let changed = false;
    let ok = true;
    for (const channel of CHANNELS) {
      const checkpoint = await this.store.meta(OBSERVE_CHECKPOINT[channel]);
      const observed = await this.bounded(() => this.ports[channel].observe(checkpoint), null);
      if (observed === null) {
        if (channel === "email") ok = false;
        continue;
      }
      const { events, checkpoint: next } = observed;
      for (const event of events) {
        changed = (await (channel === "sms" ? this.applySmsEvent(event, now) : this.applyEvent(event, now))) || changed;
        this.hooks.crashPoint?.("after_observe_event", null);
      }
      if (next !== checkpoint) await this.store.setMeta(OBSERVE_CHECKPOINT[channel], next);
    }
    return { changed, ok };
  }

  /**
   * An SMS provider's event (ticket 13). A reply carries only the two numbers, so it is recorded on
   * the subject that owns that conversation (ADR 0003 4.5), never matched by thread or address; it
   * stops that lead in its campaign, and nothing else. It is applied before its event is kept, so a
   * crash in between replays it harmlessly. Sends, failures and refusals are matched by their work.
   */
  private async applySmsEvent(event: ProviderEvent, now: number): Promise<boolean> {
    if (event.kind === "reply") {
      const eventId = `sms:${event.id}`;
      if (await this.store.replyEvent(eventId)) return false;
      const owner = this.rules.smsReplyOwner(await this.store.smsBindingsOf(event.from), event.inbox);
      const reply: ReplyEvent = { eventId, providerRef: null, inbox: event.inbox, address: event.from, atWall: Math.min(event.at, now), receivedWall: now, state: owner ? "resolved" : "unmatched", waitedMs: 0, lastCountedWall: now };
      if (owner) await this.recordReply([owner], { id: eventId, at: reply.atWall }, now, "sms");
      else await this.store.recordAnomaly(null, "a text from a mobile no number of the app's has a conversation with", now);
      await this.store.recordReplyEvent(reply);
      return owner !== null;
    }
    const w = (await this.store.work(event.key)) ?? (await this.store.workByProviderRef(event.providerRef));
    if (!w) {
      await this.store.recordAnomaly(null, `an SMS ${event.kind} event the app cannot match`, now);
      return false;
    }
    return this.applyEvent(event, now, w);
  }

  /** Records a reply on each subject it belongs to. */
  private async recordReply(subjects: readonly string[], reply: { id: string; at: number }, now: number, channel: Channel = "email"): Promise<boolean> {
    let changed = false;
    for (const subjectId of subjects) {
      const written = await this.store.update(subjectId, now, (s) => {
        const next = this.rules.applyReply(s, { channel, atWall: Math.min(reply.at, now), providerRef: reply.id }, now);
        return same(next, s) ? null : next;
      });
      changed = changed || written !== null;
    }
    return changed;
  }

  /**
   * The subjects a reply outside every known thread falls back to by the inbox it reached and the
   * bare address it came from (2.4): the rule `replyMatches` decides, work by work.
   */
  private async replyByAddress(reply: ReplyEvent, now: number): Promise<string[]> {
    const subjects = new Set<string>();
    for (const w of await this.store.workReachedFrom(reply.inbox, reply.address)) {
      if (subjects.has(w.subjectId)) continue;
      const s = await this.store.subject(w.subjectId, now);
      if (s && this.rules.replyMatches(s, w, { inbox: reply.inbox, address: reply.address, atWall: reply.atWall })) subjects.add(w.subjectId);
    }
    return [...subjects];
  }

  /** Resolves a reply event on its subjects, or keeps it unmatched by its reference. */
  private async resolveReply(reply: ReplyEvent, subjects: readonly string[], now: number): Promise<void> {
    if (subjects.length === 0) {
      await this.store.recordAnomaly(null, "a reply from an address the app never wrote to from that inbox", now);
      await this.store.updateReplyEvent(reply.eventId, { state: "unmatched" });
      return;
    }
    await this.recordReply(subjects, { id: reply.eventId, at: reply.atWall }, now);
    await this.store.updateReplyEvent(reply.eventId, { state: "resolved" });
  }

  /**
   * A reply's life (ADR 0003 2.4, PR 37 review round 3). It is identified by its event for good:
   * an observation replay is a no-op. A reply on a known thread is recorded on that lead; one with
   * no thread falls back at once; one on a thread not known yet is held, pausing sends from the
   * inbox to the address, until its reference attaches or it has waited one settling period of
   * running time, then falls back. One that matches nothing stays unmatched by its reference.
   */
  private async applyReplyEvent(event: Extract<ProviderEvent, { kind: "reply" }>, now: number): Promise<boolean> {
    if (await this.store.replyEvent(event.id)) return false;
    const reply: ReplyEvent = {
      eventId: event.id,
      providerRef: event.providerRef,
      inbox: event.inbox,
      address: event.from.toLowerCase(),
      atWall: Math.min(event.at, now),
      receivedWall: now,
      state: "pending",
      waitedMs: 0,
      lastCountedWall: now,
    };
    await this.store.recordReplyEvent(reply);
    const owner = event.providerRef === null ? null : await this.store.workByProviderRef(event.providerRef);
    if (owner) await this.resolveReply(reply, [owner.subjectId], now);
    else if (event.providerRef === null) await this.resolveReply(reply, await this.replyByAddress(reply, now), now);
    return true;
  }

  private async applyEvent(event: ProviderEvent, now: number, matched: ProviderWork | null = null): Promise<boolean> {
    if (event.kind === "reply") return this.applyReplyEvent(event, now);
    const w = matched ?? (await this.store.workByProviderRef(event.providerRef)) ?? (await this.store.work(event.key));
    if (!w) {
      await this.store.recordAnomaly(null, `a ${event.kind} event the app cannot match`, now);
      return false;
    }
    if (event.kind === "sent") return this.applyWork(w.subjectId, w.key, { kind: "sent_observed", providerTime: event.sentAt, providerRef: event.providerRef }, now);
    if (event.kind === "rejected") return this.applyWork(w.subjectId, w.key, { kind: "provider_rejected", reason: event.reason }, now);
    // A bounce after a send marks the address bad and fails the track if it is unfinished. It
    // applies only to work some attempt handed over; for other work nothing is applied, so nothing
    // is recorded (PR 41 council, item 5). Handing over is never undone, so this check and the
    // update's agree. The bounce is kept first, by its event id, so the timeline shows it even on a
    // track that had already completed; a repeat of the event, after a restart, records nothing new.
    const handedBy = (s: SubjectState) => s.attempts.filter((a) => a.idempotencyKey === w.key && a.handedWall !== null).sort((x, y) => (x.handedWall ?? 0) - (y.handedWall ?? 0))[0];
    const before = await this.store.subject(w.subjectId, now);
    if (!before || !handedBy(before)) return false;
    await this.store.recordBounce({
      eventId: event.id,
      subjectId: w.subjectId,
      workKey: w.key,
      trackId: w.trackId,
      stepId: w.stepId,
      destination: w.destination,
      atWall: Math.min(event.at, now),
      receivedWall: now,
    });
    return (await this.store.update(w.subjectId, now, (s) => {
      const sentBy = handedBy(s);
      if (!sentBy) return null;
      const next = this.rules.applyBadDestination(s, sentBy, now);
      return same(next, s) ? null : next;
    })) !== null;
  }

  /**
   * Held and unmatched replies. First (`attach`), every reply whose reference now belongs to work
   * resolves to that lead, and a held reply counts this pass's running time when the provider
   * could be observed. Then (`fallback`), after the pass's lookups, a held reply that has waited
   * one settling period falls back by address.
   */
  private async correlate(now: number, countTime: boolean, fallback: boolean): Promise<boolean> {
    let changed = false;
    for (const reply of await this.store.openReplyEvents()) {
      const owner = reply.providerRef === null ? null : await this.store.workByProviderRef(reply.providerRef);
      if (owner) {
        await this.resolveReply(reply, [owner.subjectId], now);
        changed = true;
        continue;
      }
      if (reply.state !== "pending") continue;
      if (!fallback) {
        const waitedMs = reply.waitedMs + (countTime ? runningCredit(reply.lastCountedWall, now, ENGINE_PARAMS.MAX_RUNNING_CREDIT) : 0);
        if (waitedMs !== reply.waitedMs || reply.lastCountedWall !== now) await this.store.updateReplyEvent(reply.eventId, { waitedMs, lastCountedWall: now });
        continue;
      }
      if (reply.waitedMs < ENGINE_PARAMS.SETTLING) continue;
      await this.resolveReply(reply, await this.replyByAddress(reply, now), now);
      changed = true;
    }
    return changed;
  }

  // -------------------------------------------------------------------------------------------
  // Bounded waiting states (5.3, 5.5 step 5).

  private async expireClaims(now: number): Promise<boolean> {
    let changed = false;
    for (const a of await this.store.openAttempts()) {
      if (a.state === "claimed" && now - a.claimedWall >= ENGINE_PARAMS.SETTLING) changed = (await this.applyAttempt(a, { kind: "claim_expired", now }, now)) || changed;
    }
    return changed;
  }

  /**
   * A call whose answer was never recorded, though no call is in progress (an error while applying
   * it), is the crash row of 5.3, without waiting for a restart (ruling 5).
   */
  private async recoverStuckAnswers(now: number): Promise<boolean> {
    let changed = false;
    for (const a of await this.store.openAttempts()) {
      if (!a.awaitingAnswer || this.locks.calling.has(a.id) || now - (a.lastCallWall ?? a.claimedWall) < ENGINE_PARAMS.CALL_TIMEOUT) continue;
      changed = (await this.applyAttempt(a, { kind: "call_answer", answer: { kind: "unknown" }, now }, now)) || changed;
    }
    return changed;
  }

  private ref(w: ProviderWork): AttemptRef {
    return { idempotencyKey: w.key, providerRef: w.providerRef, sender: w.accountId, destination: w.destination };
  }

  /** Looks up provider work whose lookup is due, one call per work (5.3, 5.6). */
  private async settle(now: number): Promise<boolean> {
    let changed = false;
    for (const due of await this.store.openWork()) {
      if (due.nextLookupWall === null || due.nextLookupWall > now) continue;
      const live = (await this.store.openAttempts()).find((a) => a.idempotencyKey === due.key);
      if (live?.awaitingAnswer) continue;
      // Settlement runs on its own clock: a retry still waiting for its slot when the lookup is due
      // is refused, and the work settles (ruling 5).
      if (live && (live.retry === "wanted" || live.retry === "wanted_after_not_sent")) {
        await this.applyAttempt(live, { kind: "retry_refused", now }, now);
        changed = true;
        const after = await this.store.work(due.key);
        if (!after || after.settled !== null || after.nextLookupWall === null || after.nextLookupWall > now) continue;
      }
      const w = (await this.store.work(due.key)) ?? due;
      const port = await this.portOf(w.accountId, now);
      const answer = await this.bounded(() => port.lookup(this.ref(w)), { kind: "unknown" as const });
      this.hooks.crashPoint?.("after_lookup", live?.id ?? null);
      changed = (await this.applyWork(w.subjectId, w.key, { kind: "lookup_answer", answer, now }, now)) || changed;
    }
    return changed;
  }

  private async withdraw(now: number): Promise<boolean> {
    let changed = false;
    for (const a of await this.store.openAttempts()) {
      if (!a.withdrawRequested || a.withdrawCalled || (a.state !== "handed" && a.state !== "accepted")) continue;
      const w = await this.store.work(a.idempotencyKey);
      if (!w) continue;
      const port = await this.portOf(w.accountId, now);
      const answer = await this.bounded(() => port.withdraw(this.ref(w)), "unknown" as const);
      changed = (await this.applyAttempt(a, { kind: "withdraw_answer", answer, now }, now)) || changed;
    }
    return changed;
  }

  // -------------------------------------------------------------------------------------------
  // Evaluation (2.6) with the version guard (2.5).

  private async evaluateAll(now: number): Promise<boolean> {
    let changed = false;
    for (const [id, version] of await this.store.runningSubjectVersions()) {
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
      // Shared facts other subjects write are taken as they are now: the accounts, and the SMS
      // bindings, which another process's first handover to the same mobile may have added since the
      // snapshot (review bot on 5ca8c5e). An evaluation never removes a binding; one it added is kept.
      await this.store.update(id, now, (current) =>
        this.rules.versionsMatch(snapshot, current)
          ? { ...next, accounts: current.accounts, smsBindings: [...current.smsBindings, ...next.smsBindings.filter((b) => !snapshot.smsBindings.some((x) => x.sender === b.sender && x.recipient === b.recipient) && !current.smsBindings.some((x) => x.sender === b.sender && x.recipient === b.recipient))] }
          : null,
      );
      // Written, or discarded as stale: either way another pass follows, so a discarded change is
      // re-evaluated on fresh state in this tick (2.5).
      changed = true;
    }
    return changed;
  }

  // -------------------------------------------------------------------------------------------
  // Calls (ticket 14): due calls are placed on the user's list; the user dials and logs outcomes.

  private async nextUserDay(now: number): Promise<number> {
    const { userZone } = await this.store.callSettings();
    return startOfLocalDay(localDayNumber(now, userZone) + 1, userZone);
  }

  /**
   * Places due calls on today's list in priority order (4.4), as of the tick's instant `now`, in one
   * transaction with the completed-placement marker (ADR 0003 4.4, "One instant per tick"): each
   * candidate subject is evaluated as of `now` in that transaction, so a track that starts by `now` is
   * started before its calls are looked for, then its ready calls are placed, each re-checking the
   * day's capacity, and the marker is set to `now`. A call that does not fit waits for the next user
   * day and is never dropped.
   */
  private async placeCallsAll(now: number): Promise<boolean> {
    const settings = JSON.stringify(await this.store.callSettings());
    const candidates: { id: string; key: string }[] = [];
    for (const [id, version] of await this.store.runningSubjectVersions()) {
      const key = `${version}|${settings}`;
      const known = this.noCallsReady.get(id);
      if (known?.key === key && now < known.until) continue;
      candidates.push({ id, key });
    }
    const nextDay = await this.nextUserDay(now);
    const idle: { id: string; key: string; until: number }[] = [];
    const placed = await this.store.placeCalls(now, (tx) => {
      const ready: ReadyItem[] = [];
      for (const { id, key } of candidates) {
        const base = tx.subject(id);
        if (!base) continue;
        const evaluated = this.rules.evaluate(base, now);
        const s = same(evaluated, base) ? base : (tx.apply(id, () => evaluated) ?? base);
        const items = this.rules.readyCalls(s, now);
        if (items.length === 0) {
          // Nothing to place until a call falls due, a track starts, or the next user day (its hours may open then).
          const lead = leadNow(s.subject.clock, now);
          const later = s.tracks.flatMap((p) => [p.finishedAt === null ? p.dueAt : null, p.startedAt === null ? p.startAt : null]).filter((t): t is number => t !== null && t > lead);
          idle.push({ id, key, until: Math.min(nextDay, ...later.map((t) => now + (t - lead))) });
        }
        ready.push(...items);
      }
      ready.sort((a, b) => this.rules.callOrder(a, b));
      let count = 0;
      for (const item of ready) if (tx.apply(item.subjectId, (s) => this.rules.placeCall(s, item, now, this.newId()))) count++;
      return count;
    });
    for (const x of idle) this.noCallsReady.set(x.id, { key: x.key, until: x.until });
    return placed > 0;
  }

  /**
   * The user logs what happened on a call task (ADR 0003 2.4 "Calls"): accepted only while the task
   * is listed, checked in the transaction that records it. The application never dials.
   */
  logCallOutcome(taskId: string, input: OutcomeInput): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.ticks.run(async () => {
      const subjectId = await this.store.callTaskSubject(taskId);
      if (subjectId === null) return { ok: false as const, reason: "There is no such call task." };
      // A key logged on another subject's call: the subject's own transaction cannot see it.
      const loggedOn = await this.store.callRequestTask(input.requestId);
      if (loggedOn !== null && loggedOn !== taskId) return { ok: false as const, reason: REQUEST_ID_REUSED };
      const now = this.clock();
      const refused: { reason: string | null } = { reason: null };
      const ids = { attempt: this.newId(), note: this.newId() };
      try {
        await this.store.update(subjectId, now, (s) => {
          const out = this.rules.logCallOutcome(s, taskId, input, now, ids, this.rules.isListed);
          if (!out.ok) {
            refused.reason = out.reason;
            return null;
          }
          return out.replayed ? null : out.state;
        });
      } catch (error) {
        // Another process logged this key on another subject's call between the check and this write.
        if (error instanceof Error && error.message.includes("call_attempts.request_id")) return { ok: false as const, reason: REQUEST_ID_REUSED };
        throw error;
      }
      if (refused.reason !== null) return { ok: false as const, reason: refused.reason };
      await this.runTick(now);
      return { ok: true as const };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Claims (4.2) in priority order (4.3).

  private async claimAll(now: number): Promise<boolean> {
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
    // A subject's own claims bump its version: its later items in this pass are checked against the
    // state its claim wrote, not the snapshot it superseded, so a lead with items on two channels
    // keeps each item's priority turn (found by ticket 13a's generated priority check).
    const latest = new Map<string, SubjectState>();
    for (const entry of ready) {
      const { item } = entry;
      const snapshot = latest.get(item.subjectId) ?? entry.snapshot;
      // Cheap refusals on the snapshot first; the transaction checks everything again on current state.
      if (this.rules.claimRefusal(snapshot, item, now) !== null) continue;
      const track = snapshot.campaign.definition.tracks.find((t) => t.id === item.trackId);
      const step = track?.steps.find((s) => s.id === item.stepId);
      const transport = this.ports[track?.channel === "sms" ? "sms" : "email"].transportFor({ threading: step?.threading ?? "new_subject" });
      // A step the port cannot send yet is not claimed: it waits, and nothing is sent for it.
      if (transport.available === false) continue;
      const attemptId = this.newId();
      const written = await this.store.update(item.subjectId, now, (s) => {
        if (!this.rules.versionsMatch(snapshot, s)) return null;
        if (this.rules.claimRefusal(s, item, now) !== null) return null;
        const account = this.rules.chooseAccount(s, now, item.stepId);
        if (!account) return null;
        return this.rules.claim(s, item, account, { attemptId, retryable: transport.retryable, notSentIsFinal: transport.notSentIsFinal, now });
      });
      if (written) {
        changed = true;
        latest.set(item.subjectId, written);
        await this.hooks.afterClaim?.(attemptId);
        this.hooks.crashPoint?.("after_claim", attemptId);
      }
    }
    return changed;
  }

  // -------------------------------------------------------------------------------------------
  // Handovers and retries (5.5, 5.6), per account in priority order.

  private async handOverAll(now: number): Promise<boolean> {
    let changed = false;
    const waiting = new Set(
      (await this.store.openAttempts())
        .filter((a) => a.state === "claimed" || (a.state === "handed" && (a.retry === "wanted" || a.retry === "wanted_after_not_sent")))
        .map((a) => a.accountId),
    );
    for (const account of await this.store.accounts(now)) {
      if (!waiting.has(account.id)) continue;
      const skipped = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const current = (await this.store.accounts(now)).find((a) => a.id === account.id);
        const next = await this.nextForSlot(account.id, skipped, now);
        if (!current || !next) break;
        // A claim waits for the slot before its pre-send check (5.5 steps 2-3); a retry's own
        // authorization decides whether it waits (5.6).
        if (!next.retry && now < current.nextSlotAt) break;
        const outcome = next.retry ? await this.tryRetry(next.attempt, now) : await this.tryHandover(next.attempt, now);
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

  /**
   * ADR 0002's pre-send check, recorded on the attempt. False when it could not run or found a reply.
   * Part of the send act: it is recorded at the instant it is made, since the authorization measures
   * its age (`PRESEND_MAX_AGE`) at the instant of the call.
   */
  private async presend(a: Attempt): Promise<boolean> {
    const now = this.clock();
    this.lastActAt = Math.max(this.lastActAt, now);
    if (a.presendCheckedWall !== null && a.presendCheckedWall >= now - ENGINE_PARAMS.PRESEND_MAX_AGE && !a.presendFoundReply) return true;
    const subject = await this.store.subject(a.subjectId, now);
    const threadRefs = (subject?.work ?? []).flatMap((w) => (w.providerRef === null ? [] : [w.providerRef]));
    const port = await this.portOf(a.accountId, now);
    const channel = port === this.ports.sms ? "sms" : "email";
    const result = await this.bounded(() => port.presendCheck({ sender: a.accountId, destination: a.destination, threadRefs }), { kind: "unavailable" as const });
    if (result.kind === "unavailable") return false;
    await this.store.update(a.subjectId, now, (s) => {
      let next: SubjectState = { ...s, attempts: s.attempts.map((x) => (x.id === a.id ? { ...x, presendCheckedWall: now, presendFoundReply: result.kind === "reply" } : x)) };
      if (result.kind === "reply") next = this.rules.applyReply(next, { channel, atWall: Math.min(result.at, now), providerRef: result.providerRef }, now);
      return next;
    });
    this.hooks.crashPoint?.("after_presend", a.id);
    return result.kind === "clear";
  }

  /** A call answer that arrives after the call returned, such as a response delivered twice (5.3: ignored unless it moves forward). */
  receiveLateAnswer(attemptId: string, answer: CallAnswer): Promise<void> {
    return this.ticks.run(async () => {
      const a = await this.store.attempt(attemptId);
      const now = this.clock();
      if (a && a.state !== "claimed") await this.applyAttempt(a, { kind: "call_answer", answer, now }, now);
    });
  }

  /** The immutable send request, from the authorized attempt alone: nothing is read to build it (ruling 2). */
  private request(a: Attempt): HandoverRequest {
    if (!a.copy) throw new Error(`attempt ${a.id} has no stored copy`);
    return {
      threading: a.threading,
      attemptId: a.id,
      idempotencyKey: a.idempotencyKey,
      sender: a.accountId,
      destination: a.destination,
      rendered: a.copy,
      threadRef: a.threadRef,
      subjectId: a.subjectId,
      trackId: a.trackId,
      stepId: a.stepId,
    };
  }

  /**
   * Authorizes a send and calls the provider as one serialized step per inbox (ruling 2; review
   * round 2, ruling 1): `authorize` commits synchronously, the request is built from what it
   * committed, and the call starts on the same synchronous run, so no other write in this process
   * can land between the commit and the call. The pacing slot then counts from the call's start.
   */
  private async authorizeAndCall(
    a: Attempt,
    authorize: (now: number) => { authorized: Attempt | null; onlySlot: boolean; skip?: boolean },
    crashPoint: CrashPoint,
    now: number,
  ): Promise<{ outcome: "handed" | "withdrawn" | "waiting" | "skip"; answer?: CallAnswer; authorized?: Attempt; answeredAt?: number }> {
    const port = await this.portOf(a.accountId, now);
    return this.locks.run(a.accountId, async () => {
      const authorizedAt = this.clock();
      this.lastActAt = Math.max(this.lastActAt, authorizedAt);
      const { authorized, onlySlot, skip } = authorize(authorizedAt);
      if (!authorized) return { outcome: skip ? "skip" : onlySlot ? "waiting" : "withdrawn" };
      const request = this.request(authorized);
      this.hooks.crashPoint?.(crashPoint, a.id);
      this.hooks.afterAuthorization?.(a.id);
      const callStart = this.clock();
      this.lastActAt = Math.max(this.lastActAt, callStart);
      this.locks.calling.add(a.id);
      let pending: Promise<CallAnswer>;
      try {
        pending = port.handover(request);
      } catch {
        pending = Promise.resolve({ kind: "unknown" });
      }
      try {
        const answer = await this.waitFor(pending.catch((): CallAnswer => ({ kind: "unknown" })), ENGINE_PARAMS.CALL_TIMEOUT, { kind: "unknown" });
        await this.store.pushSlot(a.accountId, callStart);
        const answeredAt = this.clock();
        this.lastActAt = Math.max(this.lastActAt, answeredAt);
        return { outcome: "handed", answer, authorized, answeredAt };
      } finally {
        this.locks.calling.delete(a.id);
      }
    });
  }

  private async tryHandover(a: Attempt, now: number): Promise<"handed" | "withdrawn" | "waiting" | "skip"> {
    if (!(await this.presend(a))) {
      const after = await this.store.attempt(a.id);
      return after?.state === "claimed" ? "skip" : "withdrawn";
    }
    await this.hooks.beforeHandover?.(a.id);
    const result = await this.authorizeAndCall(
      a,
      (now) => {
        const out: { authorized: Attempt | null; onlySlot: boolean; skip?: boolean } = { authorized: null, onlySlot: false };
        this.store.updateNow(a.subjectId, now, (s) => {
          const current = s.attempts.find((x) => x.id === a.id);
          const account = current ? s.accounts[current.accountId] : undefined;
          if (!current || current.state !== "claimed" || !account) return null;
          const failed = this.rules.handoverFailures(s, current, account, now);
          if (failed.length === 0) {
            const next = this.rules.handOver(s, current, account, now);
            out.authorized = next.attempts.find((x) => x.id === a.id) ?? null;
            return next;
          }
          // A reply awaiting correlation pauses this inbox's sends to the address: the claim waits.
          if (failed.every((f) => f === 16 || f === 18) && failed.includes(18)) {
            out.skip = true;
            return null;
          }
          if (failed.every((f) => f === 16)) {
            out.onlySlot = true;
            return null;
          }
          return this.rules.applyToAttempt(s, current.id, { kind: "guard_failed" }, now).state;
        });
        return out;
      },
      "after_handover_commit",
      now,
    );
    if (result.outcome !== "handed" || !result.answer || !result.authorized) return result.outcome;
    this.hooks.crashPoint?.("after_call", a.id);
    const answeredAt = result.answeredAt ?? now;
    await this.applyAttempt(result.authorized, { kind: "call_answer", answer: result.answer, now: answeredAt }, answeredAt);
    return "handed";
  }

  private async tryRetry(a: Attempt, now: number): Promise<"handed" | "withdrawn" | "waiting" | "skip"> {
    const snapshot = await this.store.subject(a.subjectId, now);
    const account = snapshot?.accounts[a.accountId];
    if (snapshot && account) {
      const pending = this.rules.retryFailures(snapshot, a, account, now).filter((f) => f !== "predicate 14");
      if (pending.length > 0 && pending.every((f) => f === "slot")) return "waiting";
    }
    await this.hooks.beforeRetry?.(a.id);
    const fresh = await this.presend(a);
    const result = await this.authorizeAndCall(
      a,
      (now) => {
        const out: { authorized: Attempt | null; onlySlot: boolean; skip?: boolean } = { authorized: null, onlySlot: false };
        this.store.updateNow(a.subjectId, now, (s) => {
          const current = s.attempts.find((x) => x.id === a.id);
          const acc = current ? s.accounts[current.accountId] : undefined;
          if (!current || !acc || (current.retry !== "wanted" && current.retry !== "wanted_after_not_sent")) return null;
          const failed = fresh ? this.rules.retryFailures(s, current, acc, now) : ["predicate 14"];
          if (failed.includes("predicate 18")) {
            out.skip = true;
            return null;
          }
          if (failed.length === 0) {
            const next = this.rules.authorizeRetry(s, current, acc, now);
            out.authorized = next.attempts.find((x) => x.id === a.id) ?? null;
            return next;
          }
          if (failed.every((f) => f === "slot")) {
            out.onlySlot = true;
            return null;
          }
          return this.rules.applyToAttempt(s, current.id, { kind: "retry_refused", now }, now).state;
        });
        return out;
      },
      "after_retry_commit",
      now,
    );
    if (result.outcome !== "handed" || !result.answer || !result.authorized) return result.outcome;
    this.hooks.crashPoint?.("after_call", a.id);
    const answeredAt = result.answeredAt ?? now;
    await this.applyAttempt(result.authorized, { kind: "call_answer", answer: result.answer, now: answeredAt }, answeredAt);
    return "handed";
  }
}
