/**
 * The outbox worker (ADR 0003 5.5) and restart settlement (section 6). It runs the pure rules
 * against the store and calls the provider only through the port, and only after the handover or
 * retry write that authorizes the call has committed. One tick runs passes until nothing changes:
 * observe, expire claims, settle, withdraw, evaluate, claim, hand over.
 */
import { ENGINE_PARAMS, isLive, type AttemptEffect, type AttemptEvent, type CallAnswer, type WorkEvent } from "../../domain/sequence/attempt.ts";
import { launchCheck, type LaunchCheck } from "../../domain/sequence/blockers.ts";
import { REQUEST_ID_DIFFERENT, REQUEST_ID_REUSED, type OutcomeInput } from "../../domain/sequence/calls.ts";
import { leadNow, localDayNumber, nextWindowOpen, resetDayOf, runningCredit, startOfLocalDay } from "../../domain/sequence/clock.ts";
import { windowOf, type ReadyItem } from "../../domain/sequence/dispatch.ts";
import { runs, sealReckoning, settledEvaluation, stillSettled, type SettledEvaluation } from "../../domain/sequence/progress.ts";
import { definitionProblems, type CampaignDefinition } from "../../domain/sequence/definition.ts";
import type { Attempt, ProviderWork, SubjectState } from "../../domain/sequence/state.ts";
import { judgeCampaignControl, type LeadControl, type LeadExpectation } from "../../domain/sequence/controls.ts";
import type { ControlView } from "../../shared/api.ts";
import { effectOf } from "./controls-view.ts";
import { impactDigest } from "./edit-impact.ts";
import { storableAccount, type ControlRecord, type DefinitionSave, type EngineStore, type ReplyEvent, type SaveResult, type StoredDefinition } from "./engine-store.ts";
import type { StoredReplyId } from "../../domain/sequence/reply-identity.ts";

/** A control's answer. `effect`: the control's own effect, which the read previewed at that instant; null for a campaign's. */
export type ControlAnswer = { readonly ok: true; readonly replayed: boolean; readonly effect: ControlView | null } | { readonly ok: false; readonly reason: string };
export const CONTROL_REQUEST_REUSED = "This request id was already used for another action: send a new one.";

/** An outcome request's body as stored with its id (council I on 56d599c): the same id with another body is refused. */
function outcomeBody(input: OutcomeInput): string {
  return JSON.stringify({ outcome: input.outcome, redial: input.redial, callbackAt: input.callbackAt, declinedPath: input.declinedPath, numberId: input.numberId, note: input.note, noteScope: input.noteScope });
}
import { callOutcome, UnprovisionedSmsPort, type AttemptRef, type CallOutcome, type PortCallResult, type HandoverRequest, type ProviderEvent, type SendPort } from "./ports.ts";
import { DEFAULT_RULES, type Rules } from "./rules.ts";
import { HEARTBEAT_KEY, NOTICE_KEY, parseInstant, PROVIDERS_KEY, TICK_ENDED_KEY, TICK_FAILED_KEY } from "./worker-state.ts";
import { relevantChannels, waitingOn, type ProviderEvidence } from "../../domain/sequence/providers.ts";

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
}

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
  /**
   * Whether this process still holds the worker's lease (ticket 20a, council E): its last successful renewal is within
   * the lease's staleness window. While false, the dispatch gate sends nothing. Absent: always held (tests).
   */
  readonly leaseHeld?: () => boolean;
  /**
   * This process's lease, checked against the stored holder (ticket 20a; review bot and verifier on 592d679): inside the
   * transaction that authorizes a send, and immediately before each provider call. Absent: always held (tests).
   */
  readonly leaseOwner?: { readonly id: string; readonly staleMs: number };
  /** Where this engine's ticks queue; the process's by default. A test's second worker stands for another process. */
  readonly ticks?: TickQueue;
}

type Channel = "email" | "sms";
const OBSERVE_CHECKPOINT: Record<Channel, string> = { email: "email_observe_checkpoint", sms: "sms_observe_checkpoint" };
const CHANNELS: readonly Channel[] = ["email", "sms"];
const MAX_PASSES = 50;
const QUOTA_WAIT = Number.MAX_SAFE_INTEGER;
/** Ticket 20a: how long a port's last answer stands for "it answers", for a port that does not report its own freshness: four ticks. */
export const ENGINE_CONTACT_FRESH_MS = 60_000;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class Engine {
  private readonly store: EngineStore;
  private readonly ports: Record<Channel, SendPort>;
  /** Each sender account's channel, so its attempts reach the right port. */
  private readonly channels = new Map<string, Channel>();
  private readonly now: () => number;
  /** While a provider's answer is applied: the instant the rules say it is applied at (`answerInstant`); null otherwise. */
  private applyingAt: number | null = null;
  /** Ticket 20a: each provider's last actual answer, for a port that does not report its own (`SendPort.contact`). */
  private readonly answeredAt: Record<Channel, number | null> = { email: null, sms: null };
  /** Ticket 20a: which reads of each provider answered in the current round (a tick, or the dispatch gate's own asking). */
  private round: Record<Channel, { accounts: boolean; observation: boolean }> = { email: { accounts: false, observation: false }, sms: { accounts: false, observation: false } };

  /** Ticket 20a (council D): the last call each provider answered while its contact stood, extending it. */
  private readonly extendedAt: Record<Channel, number | null> = { email: null, sms: null };
  /** Ticket 20a (council G): each provider's last failed read, as evidence. */
  private readonly failedRead: Record<Channel, { at: number; part: "accounts" | "observation" | "call" } | null> = { email: null, sms: null };
  /** Whether the dispatch gate has asked every provider again in this round. */
  private askedThisRound = false;

  /** The last instant any provider answered anything, and the start of a silence longer than the gap since then (council D). */
  private lastAnyAnswer: number | null = null;
  private silenceFrom: number | null = null;

  /** Every answer from any provider: a gap since the previous one longer than INTERRUPTION_GAP is a silence, evidence of an interruption. */
  private anyAnswer(now: number): void {
    if (this.lastAnyAnswer !== null && this.rules.interruptionOf(this.lastAnyAnswer, now) !== null) this.silenceFrom = Math.min(this.silenceFrom ?? this.lastAnyAnswer, this.lastAnyAnswer);
    this.lastAnyAnswer = Math.max(this.lastAnyAnswer ?? now, now);
  }

  /** The contact each self-reporting port last reported, to see it jump (below). */
  private readonly reportedSeen: Record<Channel, number | null> = { email: null, sms: null };

  /**
   * A port that reports its own contact (the adapter, which answers from a cache between polls) may answer every call
   * while not reaching its provider: when its contact moves forward by more than the gap, that span was a silence for
   * it, evidence of an interruption. For any other port a silence is read from its answers (`anyAnswer`).
   */
  private noteReportedContact(channel: Channel): void {
    if (!this.ports[channel].contact) return;
    const at = this.contactOf(channel).at;
    if (at === null) return;
    const before = this.reportedSeen[channel];
    if (before !== null && this.rules.interruptionOf(before, at) !== null) this.silenceFrom = Math.min(this.silenceFrom ?? before, before);
    this.reportedSeen[channel] = at;
  }

  private callAnswered(channel: Channel): void {
    const now = this.clockNow();
    this.anyAnswer(now);
    // A port that reports its own contact (the adapter) is never extended from call results: only its round trips count.
    if (this.ports[channel].contact) return;
    const { at, freshForMs } = this.contactOf(channel);
    if (at !== null && now - at <= freshForMs) this.extendedAt[channel] = now;
    this.advanceHeartbeat(now);
  }

  /** While every provider is fresh, the heartbeat moves up with their oldest contact, inside a tick too (council D). */
  private advanceHeartbeat(at: number): void {
    const fresh = this.freshHeartbeat(at);
    if (fresh === null) return;
    if (this.heartbeatSeen === null || (fresh >= this.heartbeatSeen && this.rules.interruptionOf(this.heartbeatSeen, fresh) === null)) this.heartbeatSeen = Math.max(this.heartbeatSeen ?? fresh, fresh);
  }

  /** Every provider's evidence, as the gate and the reads decide by it. */
  private evidence(): Record<Channel, ProviderEvidence> {
    const of = (c: Channel): ProviderEvidence => {
      const { at, freshForMs } = this.contactOf(c);
      const failed = this.failedRead[c];
      return { contactAt: at, freshForMs, failedAt: failed?.at ?? null, failedPart: failed?.part ?? null };
    };
    return { email: of("email"), sms: of("sms") };
  }

  private async saveEvidence(): Promise<void> {
    await this.store.setMeta(PROVIDERS_KEY, JSON.stringify(this.evidence()));
  }

  private newRound(): void {
    this.round = { email: { accounts: false, observation: false }, sms: { accounts: false, observation: false } };
  }

  /** A read answered: the round is contact only once every read the engine relies on has answered in it (`contactFrom`). */
  private readAnswered(channel: Channel, part: "accounts" | "observation"): void {
    this.round[channel][part] = true;
    this.anyAnswer(this.clockNow());
    this.noteReportedContact(channel);
    if (this.rules.contactFrom(this.round[channel])) this.answeredAt[channel] = this.clockNow();
    this.advanceHeartbeat(this.clockNow());
  }

  /** A read failed: the round is not contact, and the read model says which channel and part (ticket 20a). */
  private async readFailed(channel: Channel, part: "accounts" | "observation" | "call"): Promise<void> {
    this.failedRead[channel] = { at: this.clockNow(), part };
    await this.saveEvidence();
  }
  /** The heartbeat as last read or written by this engine; the dispatch gate re-reads the store before acting on a gap. */
  private heartbeatSeen: number | null = null;
  /** The instant the running tick started, for the rule a mutation replaces (`dispatchInstant`). */
  private tickStarted = 0;
  private readonly clockNow: () => number;
  private readonly newId: () => string;
  private readonly rules: Rules;
  private readonly hooks: EngineHooks;
  private readonly waitFor: <T>(promise: Promise<T>, ms: number, timedOut: T) => Promise<T>;
  private readonly locks: InboxLocks;
  private readonly ticks: TickQueue;
  private readonly leaseHeld: (() => boolean) | null;
  private readonly leaseOwner: { readonly id: string; readonly staleMs: number } | null;
  /**
   * Subjects known to need nothing, by version key, until a wall instant: evaluated with no
   * change, or with nothing ready to claim. A change to the subject, its campaign or its lead
   * facts changes the key; the instant is the next time-driven change (a deadline or a start).
   * Correct only while `runningSubjectVersions` names every input of `evaluate` and
   * `readyItems`: a ticket that adds an input (a call task, a pause) adds it to that key.
   */
  private readonly settled = new Map<string, { key: string } & SettledEvaluation>();

  /**
   * Every write the worker makes to a subject (question Q7 answered, point 10): a binding of its own whose texts all ended
   * not sent is released in the same write that settles the last of them, so it never stands as a conversation.
   */
  private update(subjectId: string, now: number, decide: (state: SubjectState) => SubjectState | null): Promise<SubjectState | null> {
    return this.store.update(subjectId, now, (s) => {
      const next = decide(s);
      return next === null ? null : this.rules.releaseUnsent(next);
    });
  }
  private updateNow(subjectId: string, now: number, decide: (state: SubjectState) => SubjectState | null): SubjectState | null {
    return this.store.updateNow(subjectId, now, (s) => {
      const next = decide(s);
      return next === null ? null : this.rules.releaseUnsent(next);
    });
  }
  private readonly nothingReady = new Map<string, { key: string; until: number }>();
  /** Subjects with no due call to place, by version key and call settings, until a wall instant. */
  private readonly noCallsReady = new Map<string, { key: string; until: number }>();
  /** Per subject and version: the wall instants its pending steps fall due, with their windows. */
  private readonly wakeCache = new Map<string, { version: string; due: { wall: number; window: ReturnType<typeof windowOf> | null; zone: string }[]; openCall: boolean }>();

  constructor(deps: EngineDependencies) {
    this.store = deps.store;
    this.ports = { email: deps.port, sms: deps.smsPort ?? new UnprovisionedSmsPort() };
    this.clockNow = deps.now;
    this.now = () => this.applyingAt ?? deps.now();
    this.newId = deps.newId;
    this.rules = { ...DEFAULT_RULES, ...deps.rules };
    this.hooks = deps.hooks ?? {};
    this.waitFor = deps.waitFor ?? waitWithTimer;
    this.locks = deps.locks ?? PROCESS_LOCKS;
    this.ticks = deps.ticks ?? PROCESS_TICKS;
    this.leaseHeld = deps.leaseHeld ?? null;
    this.leaseOwner = deps.leaseOwner ?? null;
  }

  /** A port call bounded by CALL_TIMEOUT; a throw counts as the timed-out answer. */
  private bounded<T>(call: () => Promise<T>, timedOut: T, channel: Channel | null = null, classify: ((value: T) => PortCallResult) | null = null): Promise<T> {
    let started: Promise<T>;
    let answered = false;
    try {
      started = call().then(
        (value) => {
          answered = true;
          return value;
        },
        () => timedOut,
      );
    } catch {
      return Promise.resolve(timedOut);
    }
    return this.waitFor(started, ENGINE_PARAMS.CALL_TIMEOUT, timedOut).then(async (value) => {
      if (channel === null || classify === null) return value;
      // Ticket 20a (council D; review bot on 592d679): only a call the provider answered is contact, decided by the one
      // classification of its result; a timeout, an error or a failure resolved as a value is evidence of failure.
      const outcome: CallOutcome = answered ? callOutcome(classify(value)) : "failed";
      switch (outcome) {
        case "answered":
          this.callAnswered(channel);
          break;
        case "failed":
          await this.readFailed(channel, "call");
          break;
        default:
          throw new Error(`an outcome the engine does not know: ${String(outcome satisfies never)}`);
      }
      return value;
    });
  }

  // -------------------------------------------------------------------------------------------
  // Entry points.

  /** Launches a campaign if nothing blocks it, and runs a tick. */
  launch(campaignId: string, expectedDefinitionVersion?: number): Promise<{ ok: true; stored: StoredDefinition } | { ok: false; reason: string; check: LaunchCheck | null }> {
    return this.ticks.run(async () => {
      await this.syncAccounts();
      const now = this.now();
      const outcome = await this.store.launch(campaignId, now, launchCheck, (s) => this.rules.evaluate(this.rules.enterMain(s, now), now), expectedDefinitionVersion);
      if (!outcome.ok) return outcome;
      await this.runTick();
      return { ok: true as const, stored: outcome.stored };
    });
  }

  /**
   * Saves a campaign's definition by the save rule (ADR 0003 1.1.1). On a launched campaign (ticket 19) the save is
   * applied in its transaction: the boundary and the three launch blockers, then each lead caught up under the old
   * definition and reconciled under the new one (ADR 0003 "Ticket 19"); it queues behind the running tick as a launch
   * does, and a tick follows an accepted one.
   */
  saveDefinition(campaignId: string, definition: CampaignDefinition, editedAt: string, save: DefinitionSave | null, options: { readonly tick?: boolean; readonly impact?: string } = {}): Promise<SaveResult> {
    return this.ticks.run(async () => {
      await this.syncAccounts();
      const now = this.now();
      const result = await this.store.saveDefinition(campaignId, definition, editedAt, save, {
        now,
        problems: (next, previous) => definitionProblems(next, previous, { launched: true }),
        check: (definition, leadsAfter, leads, accounts) => this.rules.runningCheck(definition, leadsAfter, leads, accounts),
        catchUp: (s) => sealReckoning(this.rules.asOfAction(s, now), now),
        reconcile: (s, previous, previousZone) => this.rules.reconcileEdit(s, previous, previousZone, now),
        ...(options.impact !== undefined ? { impact: { expected: options.impact, digest: impactDigest } } : {}),
      }, { now, stop: (s) => this.rules.stopTestOnEdit(s, now) });
      if (result.outcome === "saved" && result.stored.launchedAt !== null && options.tick !== false) await this.runTick();
      return result;
    });
  }

  /**
   * Section 6: settle what a crash left open, then run a normal tick. The time the application was
   * not running is not counted as a held reply's wait; outstanding provider events are observed and
   * uncertain work looked up before any held reply is evaluated (PR 37 review round 3).
   */
  recover(): Promise<void> {
    return this.ticks.run(async () => {
      await this.startSilenceClock();
      const now = this.now();
      for (const r of await this.store.pendingReplies()) await this.store.updateReplyEvent(r.eventId, { lastCountedWall: now });
      for (const a of await this.store.openAttempts()) {
        // The crash row of 5.3: a call whose answer was never recorded is an unknown answer.
        if ((a.state === "handed" || a.state === "accepted") && a.awaitingAnswer) {
          await this.applyAttempt(a, { kind: "call_answer", answer: this.rules.lostAnswer, now: this.now() });
        }
      }
      await this.observe();
      await this.settle();
      await this.runTick();
    }).catch(async (error: unknown) => {
      await this.noteTickFailed();
      throw error;
    });
  }

  tick(): Promise<void> {
    return this.ticks.run(() => this.runTick()).catch(async (error: unknown) => {
      await this.noteTickFailed();
      throw error;
    });
  }

  /** A tick that threw completed nothing and writes no heartbeat; the read says ticks are failing (follow-up 42 item 45). */
  private async noteTickFailed(): Promise<void> {
    try {
      await this.store.setMeta(TICK_FAILED_KEY, String(this.clockNow()));
    } catch {
      // The store itself may be what fails; the heartbeat's age says enough then.
    }
  }

  /** Ticket 20a: the instant of a provider's last actual answer, and how long it stands for "it answers". */
  private contactOf(channel: Channel): { at: number | null; freshForMs: number } {
    const base = this.ports[channel].contact?.() ?? { at: this.answeredAt[channel], freshForMs: ENGINE_CONTACT_FRESH_MS };
    const extended = this.extendedAt[channel];
    return { at: base.at === null ? null : Math.max(base.at, extended ?? base.at), freshForMs: base.freshForMs };
  }

  /** The heartbeat the providers' actual answers support at `at`: the oldest of their last answers, if every one is fresh; else null. */
  private freshHeartbeat(at: number): number | null {
    let oldest = Infinity;
    for (const channel of CHANNELS) {
      const { at: contact, freshForMs } = this.contactOf(channel);
      if (contact === null || at - contact > freshForMs) return null;
      oldest = Math.min(oldest, contact);
    }
    return Math.min(oldest, at);
  }

  /**
   * The dispatch gate (ADR 0003 "Ticket 20a"): judged at the instant of each dispatch decision, read then. With a
   * heartbeat within the gap, work goes. Otherwise sending was interrupted until now: every provider is asked again, and
   * if each actually answers, the interruption is recorded, with the sends it rescheduled, before anything is sent; if
   * not, nothing is dispatched yet. Synchronous on the common path, so no ordinary decision waits on anything more.
   */
  private dispatchAllowed(at: number, relevant: () => Promise<readonly Channel[]>): true | false | Promise<boolean> {
    // A process whose lease another took (it was suspended past the stale limit) sends nothing (council E).
    if (this.leaseHeld && !this.leaseHeld()) return false;
    this.advanceHeartbeat(at);
    // The rule decides what a gap is, here as everywhere: synchronous, so an ordinary decision waits on nothing more.
    if (this.heartbeatSeen !== null && this.rules.interruptionOf(this.heartbeatSeen, at) === null) return true;
    return this.resumeIfAnswering(relevant);
  }

  private async resumeIfAnswering(relevant: () => Promise<readonly Channel[]>): Promise<boolean> {
    this.heartbeatSeen = parseInstant(await this.store.meta(HEARTBEAT_KEY));
    const decided = this.rules.dispatchInstant(this.tickStarted, this.now());
    this.advanceHeartbeat(decided);
    if (this.heartbeatSeen !== null && this.rules.interruptionOf(this.heartbeatSeen, decided) === null) return true;
    // Asked again, once a round, every read the engine relies on: the accounts and the observation (whose events are
    // applied as ever).
    if (!this.askedThisRound) {
      this.askedThisRound = true;
      this.newRound();
      await this.syncAccounts();
      await this.observe();
      await this.saveEvidence();
    }
    const at = this.rules.dispatchInstant(this.tickStarted, this.now());
    const fresh = this.freshHeartbeat(at);
    if (fresh === null) {
      // Some provider is not answering: a lead goes only when every provider relevant to it answers (council C).
      return waitingOn(this.evidence(), await relevant(), at).length === 0;
    }
    const gap = this.rules.interruptionOf(this.heartbeatSeen, at);
    // Evidence that sending was interrupted (council D and G), not the heartbeat's age alone: a provider read failed since
    // the heartbeat, or no provider answered anything for longer than the gap (a process starting counts from the stored
    // heartbeat, the last answer anyone heard). A slow tick in which a provider was merely not asked is neither.
    const heartbeat = this.heartbeatSeen;
    const evidenced = heartbeat !== null && (this.silenceFrom !== null || (["email", "sms"] as const).some((c) => (this.failedRead[c]?.at ?? -Infinity) > heartbeat));
    if (gap === null || !evidenced) {
      // No heartbeat before (a new database), or no interruption: the heartbeat moves up, and nothing is reported.
      await this.store.setMeta(HEARTBEAT_KEY, String(fresh));
      this.heartbeatSeen = fresh;
      return true;
    }
    this.silenceFrom = null;
    // Question Q21's interim, as intervals (review bot on 592d679): each reset day's part of the interruption in which the
    // account had room (sends counted that day under capacity), from its pacing slot on.
    const room = new Map<string, { from: number; to: number }[]>();
    for (const a of await this.store.accounts(this.now())) {
      const stretches: { from: number; to: number }[] = [];
      // Today's room on today's reset day, the daily limit on the earlier days of the gap (council on PR 63).
      const today = localDayNumber(this.now(), a.resetZone);
      for (let t = gap.from; t < gap.to; ) {
        const next = startOfLocalDay(localDayNumber(t, a.resetZone) + 1, a.resetZone);
        const from = Math.max(t, a.nextSlotAt);
        const to = Math.min(next, gap.to);
        const room = localDayNumber(t, a.resetZone) === today ? a.capacity : a.dailyLimit;
        if (from < to && (await this.store.sentToday(a.id, t)) < room) stretches.push({ from, to });
        t = next;
      }
      room.set(a.id, stretches);
    }
    let rescheduled = 0;
    // The worker runs every subject, leads and test runs alike.
    for (const id of [...(await this.store.runningLeadIds()), ...(await this.store.runningTestRunIds())]) {
      const now = this.now();
      const s = await this.store.subject(id, now);
      if (!s) continue;
      rescheduled += this.rules.rescheduled(s, gap, now, (accountId) => room.get(accountId) ?? []).length;
      const after = this.rules.afterInterruption(s, gap, now);
      if (!same(after, s)) await this.update(id, now, (current) => (this.rules.versionsMatch(s, current) ? { ...after, accounts: current.accounts } : null));
    }
    await this.store.setMetas({ [NOTICE_KEY]: JSON.stringify({ from: gap.from, to: gap.to, rescheduled }), [HEARTBEAT_KEY]: String(at) });
    this.heartbeatSeen = at;
    return true;
  }

  /** A process's first silence counts from the stored heartbeat: the last answer any worker heard. */
  private async startSilenceClock(): Promise<void> {
    if (this.lastAnyAnswer === null) this.lastAnyAnswer = parseInstant(await this.store.meta(HEARTBEAT_KEY));
  }

  private async runTick(): Promise<void> {
    await this.startSilenceClock();
    this.tickStarted = this.now();
    this.askedThisRound = false;
    this.newRound();
    this.heartbeatSeen = parseInstant(await this.store.meta(HEARTBEAT_KEY));
    await this.syncAccounts();
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let changed = false;
      const observed = await this.observe();
      changed = observed.changed || changed;
      changed = (await this.correlate(observed.ok, false)) || changed;
      changed = (await this.expireClaims()) || changed;
      changed = (await this.recoverStuckAnswers()) || changed;
      changed = (await this.settle()) || changed;
      // A held reply falls back only after this pass's lookups have had their chance to attach its reference.
      changed = (await this.correlate(false, true)) || changed;
      changed = (await this.withdraw()) || changed;
      changed = (await this.evaluateAll()) || changed;
      changed = (await this.placeCallsAll()) || changed;
      changed = (await this.claimAll()) || changed;
      changed = (await this.handOverAll()) || changed;
      if (!changed) break;
    }
    const ended = this.now();
    // The heartbeat comes only from the providers' actual answers (ticket 20a): the oldest of them, while every one is
    // fresh. It never moves back, and a gap the dispatch gate has not recorded yet is left for it to record.
    const fresh = this.freshHeartbeat(ended);
    const beat = fresh !== null && (this.heartbeatSeen === null || (fresh >= this.heartbeatSeen && this.rules.interruptionOf(this.heartbeatSeen, fresh) === null));
    await this.store.setMetas({ ...(beat ? { [HEARTBEAT_KEY]: String(fresh) } : {}), [TICK_ENDED_KEY]: String(ended), [PROVIDERS_KEY]: JSON.stringify(this.evidence()) });
    if (beat) this.heartbeatSeen = fresh;
  }

  /** The next instant at which a tick could change something, for the worker loop and the tests' clock. */
  async nextWakeAt(): Promise<number | null> {
    const now = this.now();
    const times: number[] = [];
    const nextDay = await this.nextUserDay(now);
    for (const [id, version] of await this.store.runningSubjectVersions()) {
      let cached = this.wakeCache.get(id);
      if (cached?.version !== version) {
        const state = await this.store.subject(id, now);
        if (!state) continue;
        const s = state;
        // A held lead's clock is frozen: nothing of it falls due by time (ADR 0003 3.2). Its callback's
        // instants are below.
        if (!runs(s)) {
          cached = { version, due: [], openCall: s.callTasks.some((t) => t.open) };
          this.wakeCache.set(id, cached);
          continue;
        }
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
        // An open call task can expire at the user's next day (the skip limit, ticket 15).
        cached = { version, due, openCall: s.callTasks.some((t) => t.open && t.kind === "call") };
        this.wakeCache.set(id, cached);
      }
      if (cached.openCall) times.push(nextDay);
      for (const d of cached.due) {
        if (d.wall > now) times.push(d.wall);
        else if (d.window === null) times.push(nextDay);
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
      if (a.awaitingAnswer) times.push((a.lastCallWall ?? a.claimedWall) + ENGINE_PARAMS.CALL_TIMEOUT);
      if (a.retry === "wanted" || a.retry === "wanted_after_not_sent") times.push(slot);
    }
    for (const w of await this.store.openWork()) if (w.nextLookupWall !== null) times.push(w.nextLookupWall);
    // A withdrawal answered "unknown" is asked again one settling period later (council A on 56d599c).
    for (const w of await this.store.workToWithdraw()) times.push(w.withdrawLastWall === null ? now : w.withdrawLastWall + ENGINE_PARAMS.SETTLING);
    // A callback changes on the list by the clock (ticket 15): listed from the start of its day, ready at
    // its time. No engine write happens then; the wake is there so the screens' next change covers it.
    for (const t of await this.store.openCallbackInstants()) times.push(t);
    // A held reply falls back once it has waited one settling period of running time.
    // Each observation credits at most MAX_RUNNING_CREDIT, so the worker wakes at least that often while one waits.
    for (const r of await this.store.pendingReplies()) times.push(r.lastCountedWall + Math.min(ENGINE_PARAMS.SETTLING - r.waitedMs, ENGINE_PARAMS.MAX_RUNNING_CREDIT));
    for (const acc of accounts.values()) {
      if (acc.waitUntil !== null && acc.waitUntil !== QUOTA_WAIT) times.push(acc.waitUntil);
      // Capacity frees at the account's next reset day.
      times.push(startOfLocalDay(localDayNumber(now, acc.resetZone) + 1, acc.resetZone));
    }
    const future = times.filter((t) => t > now);
    return future.length > 0 ? Math.min(...future) : null;
  }

  /** Whether this process holds the lease at `now`, by the stored holder and its renewal: synchronous, no await. */
  private leaseIsMine(now: number): boolean {
    return this.leaseOwner === null || this.store.holdsLease(this.leaseOwner.id, now, this.leaseOwner.staleMs);
  }

  /** Whether a step on `channel` with `threading` can be handed to its port now (a transport may be unavailable: ADR 0002 X2). */
  transportAvailable(channel: Channel, threading: "new_subject" | "continue_thread"): boolean {
    return this.ports[channel].transportFor({ threading }).available !== false;
  }

  /** ADR 0002 P3's resolution of unresolved work, by any attempt carrying it. The controls arrive with ticket 20; the rule is here. */
  markAttempt(attemptId: string, mark: "sent" | "not_sent"): Promise<boolean> {
    return this.ticks.run(async () => {
      const a = await this.store.attempt(attemptId);
      if (!a) return false;
      // A user action, judged as of its own instant (ADR 0003 2.4): what fell due is applied first.
      return this.applyWork(a.subjectId, a.idempotencyKey, { kind: mark === "sent" ? "mark_sent" : "mark_not_sent", now: this.now() }, true);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Accounts.

  /** Syncs every port's accounts; false when a port did not answer (ticket 20a: it could not send). */
  private async syncAccounts(): Promise<boolean> {
    let all = true;
    for (const channel of CHANNELS) {
      let statuses = await this.bounded(() => this.ports[channel].accounts(), null);
      if (statuses === null) {
        all = false;
        await this.readFailed(channel, "accounts");
        continue;
      }
      this.readAnswered(channel, "accounts");
      // One account's report the store cannot hold holds that account alone; it never fails the tick (`storableAccount`).
      statuses = statuses.flatMap((s) => storableAccount(s, channel) ?? []);
      await this.store.upsertAccounts(statuses);
      // An account its provider no longer lists is disconnected: claims for it wait, and Needs attention lists it.
      await this.store.disconnectUnlisted(channel, statuses.map((a) => a.id));
      const known = new Map((await this.store.accounts(this.now())).map((a) => [a.id, a]));
      for (const s of statuses) {
        this.channels.set(s.id, channel);
        if (s.quotaAvailable && known.get(s.id)?.waitReason === "quota") await this.store.updateAccount(s.id, { waitUntil: null, waitReason: null });
      }
    }
    return all;
  }

  /**
   * Applies a provider's answer at the instant the rules say (`answerInstant`: when it arrived, follow-up 42 item 39):
   * a request held across a day boundary is applied after it, never at the instant it was asked.
   */
  private async answered<T>(askedAt: number, apply: () => Promise<T>): Promise<T> {
    const arrived = this.clockNow();
    const at = this.rules.answerInstant(askedAt, arrived);
    if (at === arrived) return apply();
    this.applyingAt = at;
    try {
      return await apply();
    } finally {
      this.applyingAt = null;
    }
  }

  /** The port an account's sends travel by. */
  private async portOf(accountId: string): Promise<SendPort> {
    let channel = this.channels.get(accountId);
    if (channel === undefined) {
      for (const a of await this.store.accounts(this.now())) this.channels.set(a.id, a.channel);
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
  private async applyAttempt(attempt: Pick<Attempt, "id" | "subjectId">, event: AttemptEvent): Promise<boolean> {
    return this.applyChange(attempt.subjectId, attempt.id, (s, now) => {
      if (!s.attempts.some((a) => a.id === attempt.id)) return null;
      return { out: this.rules.applyToAttempt(s, attempt.id, event, now), accountId: s.attempts.find((a) => a.id === attempt.id)?.accountId ?? "" };
    }, event.kind === "call_answer" && event.answer.kind === "accepted");
  }

  /** Applies one event about provider work, to the work and every attempt carrying it, in one transaction. */
  private async applyWork(subjectId: string, key: string, event: WorkEvent, userAction = false): Promise<boolean> {
    return this.applyChange(subjectId, null, (stored, now) => {
      const s = userAction ? this.rules.asOfAction(stored, now, this.rules.evaluate) : stored;
      const w = s.work.find((x) => x.key === key);
      if (!w) return null;
      return { out: this.rules.applyToWork(s, key, event, now, { resetDay: this.resetDay(s), point: this.rules.sendPoint }), accountId: w.accountId };
    }, false);
  }

  private async applyChange(
    subjectId: string,
    attemptId: string | null,
    decide: (s: SubjectState, now: number) => { out: { state: SubjectState; effects: readonly AttemptEffect[] }; accountId: string } | null,
    accepted: boolean,
  ): Promise<boolean> {
    const now = this.now();
    const anomalies: string[] = [];
    const written = await this.update(subjectId, now, (s) => {
      const decided = decide(s, now);
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
  private async observe(): Promise<{ changed: boolean; ok: boolean; all: boolean }> {
    let changed = false;
    let ok = true;
    let all = true;
    for (const channel of CHANNELS) {
      const checkpoint = await this.store.meta(OBSERVE_CHECKPOINT[channel]);
      const asked = this.now();
      const observed = await this.bounded(() => this.ports[channel].observe(checkpoint), null);
      if (observed === null) {
        if (channel === "email") ok = false;
        all = false;
        await this.readFailed(channel, "observation");
        continue;
      }
      this.readAnswered(channel, "observation");
      const { events, checkpoint: next } = observed;
      await this.answered(asked, async () => {
        for (const event of events) {
          changed = (await (channel === "sms" ? this.applySmsEvent(event) : this.applyEvent(event))) || changed;
          this.hooks.crashPoint?.("after_observe_event", null);
        }
      });
      if (next !== checkpoint) await this.store.setMeta(OBSERVE_CHECKPOINT[channel], next);
    }
    return { changed, ok, all };
  }

  /**
   * An SMS provider's event (ticket 13). A reply carries only the two numbers, so it is recorded on
   * the subject that owns that conversation (ADR 0003 4.5), never matched by thread or address; it
   * stops that lead in its campaign, and nothing else. It is applied before its event is kept, so a
   * crash in between replays it harmlessly. Sends, failures and refusals are matched by their work.
   */
  private async applySmsEvent(event: ProviderEvent): Promise<boolean> {
    const now = this.now();
    if (event.kind === "reply") {
      const eventId = this.rules.storedReplyId("sms", event.id);
      if (await this.store.replyEvent(eventId)) return false;
      const owner = this.rules.smsReplyOwner(await this.store.smsBindingsOf(event.from), event.inbox);
      const reply: ReplyEvent = { eventId, providerRef: null, inbox: event.inbox, address: event.from, atWall: Math.min(event.at, now), receivedWall: now, state: owner ? "resolved" : "unmatched", waitedMs: 0, lastCountedWall: now };
      if (owner) await this.recordReply([owner], { id: eventId, at: reply.atWall }, "sms");
      else await this.store.recordAnomaly(null, "a text from a mobile no number of the app's has a conversation with", now);
      await this.store.recordReplyEvent(reply);
      return owner !== null;
    }
    const w = (await this.store.work(event.key)) ?? (await this.store.workByProviderRef(event.providerRef));
    if (!w) {
      await this.store.recordAnomaly(null, `an SMS ${event.kind} event the app cannot match`, now);
      return false;
    }
    return this.applyEvent(event, w);
  }

  /** Records a reply on each subject it belongs to. */
  private async recordReply(subjects: readonly string[], reply: { id: StoredReplyId; at: number }, channel: Channel = "email"): Promise<boolean> {
    const now = this.now();
    let changed = false;
    for (const subjectId of subjects) {
      const written = await this.update(subjectId, now, (s) => {
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
  private async replyByAddress(reply: ReplyEvent): Promise<string[]> {
    const now = this.now();
    const subjects = new Set<string>();
    for (const w of await this.store.workReachedFrom(reply.inbox, reply.address)) {
      if (subjects.has(w.subjectId)) continue;
      const s = await this.store.subject(w.subjectId, now);
      if (s && this.rules.replyMatches(s, w, { inbox: reply.inbox, address: reply.address, atWall: reply.atWall })) subjects.add(w.subjectId);
    }
    return [...subjects];
  }

  /** Resolves a reply event on its subjects, or keeps it unmatched by its reference. */
  private async resolveReply(reply: ReplyEvent, subjects: readonly string[]): Promise<void> {
    if (subjects.length === 0) {
      await this.store.recordAnomaly(null, "a reply from an address the app never wrote to from that inbox", this.now());
      await this.store.updateReplyEvent(reply.eventId, { state: "unmatched" });
      return;
    }
    await this.recordReply(subjects, { id: reply.eventId, at: reply.atWall });
    await this.store.updateReplyEvent(reply.eventId, { state: "resolved" });
  }

  /**
   * A reply's life (ADR 0003 2.4, PR 37 review round 3). It is identified by its event for good:
   * an observation replay is a no-op. A reply on a known thread is recorded on that lead; one with
   * no thread falls back at once; one on a thread not known yet is held, pausing sends from the
   * inbox to the address, until its reference attaches or it has waited one settling period of
   * running time, then falls back. One that matches nothing stays unmatched by its reference.
   */
  private async applyReplyEvent(event: Extract<ProviderEvent, { kind: "reply" }>): Promise<boolean> {
    const eventId = this.rules.storedReplyId("email", event.id);
    if (await this.store.replyEvent(eventId)) return false;
    const now = this.now();
    const reply: ReplyEvent = {
      eventId,
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
    if (owner) await this.resolveReply(reply, [owner.subjectId]);
    else if (event.providerRef === null) await this.resolveReply(reply, await this.replyByAddress(reply));
    return true;
  }

  private async applyEvent(event: ProviderEvent, matched: ProviderWork | null = null): Promise<boolean> {
    if (event.kind === "reply") return this.applyReplyEvent(event);
    const now = this.now();
    const w = matched ?? (await this.store.workByProviderRef(event.providerRef)) ?? (await this.store.work(event.key));
    if (!w) {
      await this.store.recordAnomaly(null, `a ${event.kind} event the app cannot match`, now);
      return false;
    }
    if (event.kind === "sent") return this.applyWork(w.subjectId, w.key, { kind: "sent_observed", providerTime: event.sentAt, providerRef: event.providerRef });
    if (event.kind === "rejected") return this.applyWork(w.subjectId, w.key, { kind: "provider_rejected", reason: event.reason });
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
    return (await this.update(w.subjectId, now, (s) => {
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
  private async correlate(countTime: boolean, fallback: boolean): Promise<boolean> {
    const now = this.now();
    let changed = false;
    for (const reply of await this.store.openReplyEvents()) {
      const owner = reply.providerRef === null ? null : await this.store.workByProviderRef(reply.providerRef);
      if (owner) {
        await this.resolveReply(reply, [owner.subjectId]);
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
      await this.resolveReply(reply, await this.replyByAddress(reply));
      changed = true;
    }
    return changed;
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

  /**
   * A call whose answer was never recorded, though no call is in progress (an error while applying
   * it), is the crash row of 5.3, without waiting for a restart (ruling 5).
   */
  private async recoverStuckAnswers(): Promise<boolean> {
    const now = this.now();
    let changed = false;
    for (const a of await this.store.openAttempts()) {
      if (!a.awaitingAnswer || this.locks.calling.has(a.id) || now - (a.lastCallWall ?? a.claimedWall) < ENGINE_PARAMS.CALL_TIMEOUT) continue;
      changed = (await this.applyAttempt(a, { kind: "call_answer", answer: this.rules.lostAnswer, now })) || changed;
    }
    return changed;
  }

  private ref(w: ProviderWork): AttemptRef {
    return { idempotencyKey: w.key, providerRef: w.providerRef, sender: w.accountId, destination: w.destination };
  }

  /** Looks up provider work whose lookup is due, one call per work (5.3, 5.6). */
  private async settle(): Promise<boolean> {
    let changed = false;
    for (const due of await this.store.openWork()) {
      if (due.nextLookupWall === null || due.nextLookupWall > this.now()) continue;
      const live = (await this.store.openAttempts()).find((a) => a.idempotencyKey === due.key);
      if (live?.awaitingAnswer) continue;
      // Settlement runs on its own clock: a retry still waiting for its slot when the lookup is due
      // is refused, and the work settles (ruling 5).
      if (live && (live.retry === "wanted" || live.retry === "wanted_after_not_sent")) {
        await this.applyAttempt(live, { kind: "retry_refused", now: this.now() });
        changed = true;
        const after = await this.store.work(due.key);
        if (!after || after.settled !== null || after.nextLookupWall === null || after.nextLookupWall > this.now()) continue;
      }
      const w = (await this.store.work(due.key)) ?? due;
      const port = await this.portOf(w.accountId);
      if (!this.leaseIsMine(this.clockNow())) return changed;
      const asked = this.now();
      const answer = await this.bounded(() => port.lookup(this.ref(w)), { kind: "unknown" as const }, port.channel, (result) => ({ call: "lookup", result }));
      this.hooks.crashPoint?.("after_lookup", live?.id ?? null);
      changed = (await this.answered(asked, () => this.applyWork(w.subjectId, w.key, { kind: "lookup_answer", answer, now: this.now() }))) || changed;
    }
    return changed;
  }

  /**
   * Withdrawals are asked of the provider work, not of an attempt (ticket 17a; council A on 56d599c): work a quiesce
   * wants withdrawn is asked at once, and again each settling period while the answer is unknown, until the work has a
   * final answer, whether or not an attempt still carries it, and across restarts (the intent is stored on the work).
   */
  private async withdraw(): Promise<boolean> {
    let changed = false;
    const carried = new Set((await this.store.openAttempts()).map((a) => a.idempotencyKey));
    for (const w of await this.store.workToWithdraw()) {
      if (!this.rules.withdrawalDue(w, this.now(), carried.has(w.key))) continue;
      const port = await this.portOf(w.accountId);
      if (!this.leaseIsMine(this.clockNow())) return changed;
      const answer = await this.bounded(() => port.withdraw(this.ref(w)), "unknown" as const, port.channel, (result) => ({ call: "withdraw", result }));
      // "Too late" means it went: the lookup is asked for its send time first, so its successor counts from the real send.
      if (answer === "too-late") {
        if (!this.leaseIsMine(this.clockNow())) return changed;
        const asked = this.now();
        const looked = await this.bounded(() => port.lookup(this.ref(w)), { kind: "unknown" as const }, port.channel, (result) => ({ call: "lookup", result }));
        if (looked.kind === "sent") {
          changed = (await this.answered(asked, () => this.applyWork(w.subjectId, w.key, { kind: "lookup_answer", answer: looked, now: this.now() }))) || changed;
          continue;
        }
      }
      changed = (await this.applyWork(w.subjectId, w.key, { kind: "withdraw_answer", answer, now: this.now() })) || changed;
    }
    return changed;
  }

  // -------------------------------------------------------------------------------------------
  // Evaluation (2.6) with the version guard (2.5).

  private async evaluateAll(): Promise<boolean> {
    let changed = false;
    // The user's zone decides the day an unworked call expires at, so it is part of the cache key.
    const settings = JSON.stringify(await this.store.callSettings());
    // Another subject's conversations change without touching this subject's version (question Q7 answered).
    const conversations = await this.store.conversationsVersion();
    for (const [id, subjectVersion] of await this.store.runningSubjectVersions()) {
      const version = `${subjectVersion}|${settings}`;
      const now = this.now();
      const known = this.settled.get(id);
      if (known?.key === version && stillSettled(known, now, conversations)) continue;
      const snapshot = await this.store.subject(id, now);
      if (!snapshot) continue;
      const next = this.rules.evaluate(snapshot, now);
      if (same(next, snapshot)) {
        // The one settling rule the projection uses too.
        const day = snapshot.callTasks.some((t) => t.open) ? await this.nextUserDay(now) : Infinity;
        this.settled.set(id, { key: version, ...settledEvaluation(snapshot, now, day, conversations) });
        continue;
      }
      await this.hooks.beforeApplyEvaluation?.(id);
      // The evaluation is stored only if nothing it read has changed since its snapshot, the SMS conversations it read
      // included (`versionsMatch`, checked in the write's own transaction): a binding taken, released or found sent since
      // refuses it, and the next pass decides again on the state as it is (question Q7 answered). Accounts it never reads.
      // Written over the current accounts and bindings: an evaluation adds or removes no binding, so with the guard
      // above they are the snapshot's; without it, it could never remove one another process released or add one taken.
      await this.update(id, now, (current) => (this.rules.versionsMatch(snapshot, current) ? { ...next, accounts: current.accounts, smsBindings: current.smsBindings } : null));
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
   * Places due calls on today's list in priority order (4.4), each in its own transaction that
   * re-checks the day's capacity against current state. A call that does not fit waits for the next
   * user day and is never dropped.
   */
  private async placeCallsAll(): Promise<boolean> {
    const now = this.now();
    const settings = JSON.stringify(await this.store.callSettings());
    const ready: { item: ReadyItem; snapshot: SubjectState }[] = [];
    for (const [id, version] of await this.store.runningSubjectVersions()) {
      const key = `${version}|${settings}`;
      const known = this.noCallsReady.get(id);
      if (known?.key === key && now < known.until) continue;
      const snapshot = await this.store.subject(id, now);
      if (!snapshot) continue;
      const items = this.rules.readyCalls(snapshot, now);
      if (items.length === 0) {
        // Nothing to place until a call falls due, or the next user day (its hours may open then).
        const lead = leadNow(snapshot.subject.clock, now);
        const dues = snapshot.tracks.filter((p) => p.finishedAt === null && p.dueAt !== null && p.dueAt > lead).map((p) => now + ((p.dueAt ?? 0) - lead));
        this.noCallsReady.set(id, { key, until: Math.min(await this.nextUserDay(now), ...dues) });
      }
      for (const item of items) ready.push({ item, snapshot });
    }
    ready.sort((a, b) => this.rules.callOrder(a.item, b.item));
    let changed = false;
    for (const { item } of ready) {
      const taskId = this.newId();
      const written = await this.update(item.subjectId, now, (s) => this.rules.placeCall(s, item, now, taskId));
      changed = written !== null || changed;
    }
    return changed;
  }

  /**
   * The user logs what happened on a call task (ADR 0003 2.4 "Calls"): accepted only while the task
   * is listed, checked in the transaction that records it. The application never dials.
   */
  logCallOutcome(taskId: string, input: OutcomeInput): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.ticks.run(async () => {
      const subjectId = await this.store.callTaskSubject(taskId);
      if (subjectId === null) return { ok: false as const, reason: "There is no such call task." };
      // A key logged on another subject's call before request ids were kept (a database from before migration 16).
      const loggedOn = await this.store.callRequestTask(input.requestId);
      if (loggedOn !== null && loggedOn !== taskId) return { ok: false as const, reason: REQUEST_ID_REUSED };
      const now = this.now();
      const ids = { attempt: this.newId(), note: this.newId() };
      let record: ControlRecord;
      try {
        // The request id is read, the outcome judged and applied, and the answer recorded in one transaction (review bot
        // and council on 56d599c, item E): two requests with one id, in any process, give one execution and one answer.
        record = await this.store.controlSubject(subjectId, now, { id: input.requestId, action: "call_outcome", target: taskId, body: outcomeBody(input) }, this.rules.requestStanding, (stored) => {
          // Judged as of the action's instant: what fell due since the last tick (an expiry at the rollover)
          // is applied first, in this transaction, and stands whatever the answer (ADR 0003 2.4).
          const s = this.rules.asOfAction(stored, now, this.rules.evaluate);
          const caughtUp = same(s, stored) ? null : s;
          const out = this.rules.logCallOutcome(s, taskId, input, now, ids, this.rules.isListed);
          if (!out.ok) return { write: caughtUp, answer: "refused", reason: out.reason, effect: null };
          return { write: out.replayed ? caughtUp : out.state, answer: "accepted", reason: null, effect: null };
        });
      } catch (error) {
        // Another process logged this key on another subject's call between the check and this write.
        if (error instanceof Error && error.message.includes("call_attempts.request_id")) return { ok: false as const, reason: REQUEST_ID_REUSED };
        throw error;
      }
      if (record.kind === "reused") return { ok: false as const, reason: REQUEST_ID_REUSED };
      if (record.kind === "different") return { ok: false as const, reason: REQUEST_ID_DIFFERENT };
      if (record.answer === "refused") return { ok: false as const, reason: record.reason ?? "Refused." };
      if (record.kind === "answered") await this.runTick();
      return { ok: true as const };
    });
  }

  // -------------------------------------------------------------------------------------------
  // The user's controls (ticket 17a). Each is judged as of its own instant (2.4) and recorded with its request id.

  /** One control on one lead: accepted, refused with its reason, or the answer to its request id's first send. */
  controlLead(subjectId: string, action: LeadControl, requestId: string, expected: LeadExpectation | null = null): Promise<ControlAnswer> {
    return this.ticks.run(async () => {
      const now = this.now();
      // The precondition is part of the body an id is bound to (ticket 17b): the same id with another is refused.
      const body = JSON.stringify(expected === null ? { action } : { action, expect: expected });
      const record = await this.store.controlSubject(subjectId, now, { id: requestId, action, body }, this.rules.requestStanding, (stored) => {
        const s = this.rules.asOfAction(stored, now, this.rules.evaluate);
        const caughtUp = same(s, stored) ? null : s;
        // Judged in the transaction that checks the request id, in the one order the read uses (`judgeControl`): the lead's
        // state first, then whether it still applies as confirmed, whichever tab or process sent first (ticket 17b).
        const out = this.rules.judgeControl(stored, s, action, now, expected, this.rules);
        if (!out.ok) return { write: caughtUp, answer: "refused", reason: out.reason, effect: null };
        // The answer's effect is the read's preview at this instant: the same transition on the same state (verifier B4).
        return { write: out.state, answer: "accepted", reason: null, effect: JSON.stringify(effectOf(s, action, out.state, now)) };
      });
      return this.answerOf(record);
    });
  }

  /**
   * Run test (ADR 0003 "Ticket 21"): in one transaction with its request id, the boundary is judged on what the
   * transaction reads, and an accepted run is inserted and entered as launch enters a lead; a tick follows, as after
   * any accepted control. Answers the run's id.
   */
  runTest(campaignId: string, requestId: string, renderAs: string, expectVersion: number): Promise<{ ok: true; replayed: boolean; runId: string } | { ok: false; reason: string }> {
    return this.ticks.run(async () => {
      const now = this.now();
      const record = await this.store.startTestRun(
        campaignId,
        now,
        { id: requestId, renderAs, expectVersion, runId: `test-${this.newId()}` },
        this.rules.requestStanding,
        (facts) => this.rules.runTestRefusal(facts),
        (s) => this.rules.evaluate(this.rules.enterMain(s, now), now),
      );
      if (record.kind === "reused" || record.kind === "different") return { ok: false as const, reason: CONTROL_REQUEST_REUSED };
      if (record.answer === "refused") return { ok: false as const, reason: record.reason ?? "Refused." };
      if (record.kind === "answered") await this.runTick();
      const effect = JSON.parse(record.effect ?? "{}") as { runId?: string };
      return { ok: true as const, replayed: record.kind === "replayed", runId: effect.runId ?? "" };
    });
  }

  /** Pauses or resumes a campaign: every lead of it that has not ended, in one transaction. */
  setCampaignPause(campaignId: string, pause: boolean, requestId: string, expected: { readonly pausedSince: number | null } | null = null): Promise<ControlAnswer> {
    return this.ticks.run(async () => {
      const now = this.now();
      const out = await this.store.setCampaignPause(
        campaignId,
        now,
        { id: requestId, pause, ...(expected === null ? {} : { expect: expected }) },
        this.rules.requestStanding,
        // The campaign's own rule, then the pause read the confirmation showed, in the read's order (ticket 17b).
        (row) => judgeCampaignControl(row, pause, expected, this.rules),
        (stored) => {
          const s = this.rules.asOfAction(stored, now, this.rules.evaluate);
          return pause ? this.rules.campaignPaused(s, now) : this.rules.campaignResumed(s, now);
        },
      );
      return this.answerOf(out);
    });
  }

  /** A request's answer: its first answer, refused or accepted, whether given now or replayed (verifier B5). */
  private async answerOf(record: ControlRecord): Promise<ControlAnswer> {
    if (record.kind === "reused" || record.kind === "different") return { ok: false, reason: CONTROL_REQUEST_REUSED };
    if (record.answer === "refused") return { ok: false, reason: record.reason ?? "Refused." };
    if (record.kind === "answered") await this.runTick();
    return { ok: true, replayed: record.kind === "replayed", effect: record.effect === null ? null : (JSON.parse(record.effect) as ControlView) };
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
    // Ticket 20a: the dispatch phase is a decision too, so an interruption is recorded even when nothing is ready.
    // At the opening no lead is named: a held phase waits for the first lead whose providers all answer.
    const opening = this.dispatchAllowed(this.rules.dispatchInstant(this.tickStarted, this.now()), () => Promise.resolve([]));
    if (opening === false) return false;
    if (opening !== true) await opening;
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
      const allowed = this.dispatchAllowed(this.rules.dispatchInstant(this.tickStarted, this.now()), () => Promise.resolve(relevantChannels(snapshot, item.trackId)));
      if (allowed === false || (allowed !== true && !(await allowed))) continue;
      const attemptId = this.newId();
      const written = await this.update(item.subjectId, now, (s) => {
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
        const next = await this.nextForSlot(account.id, skipped, now);
        if (!current || !next) break;
        // A claim waits for the slot before its pre-send check (5.5 steps 2-3); a retry's own
        // authorization decides whether it waits (5.6).
        if (!next.retry && now < current.nextSlotAt) break;
        // Ticket 20a: judged at this decision's own instant, before anything is sent.
        const subjectId = next.attempt.subjectId;
        const trackId = next.attempt.trackId;
        const allowed = this.dispatchAllowed(this.rules.dispatchInstant(this.tickStarted, this.now()), async () => {
          const st = await this.store.subject(subjectId, this.now());
          return st ? relevantChannels(st, trackId) : ["email", "sms"];
        });
        if (allowed === false || (allowed !== true && !(await allowed))) break;
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
    // A handover always reads the provider afresh, right before its authorization (council K on 56d599c): an earlier check,
    // even a recent one, is not reused, so the window in which a reply can reach the provider unseen is the time between this
    // read and the authorization's commit, with no provider call between them but a wait for the inbox's lock.
    const subject = await this.store.subject(a.subjectId, now);
    const threadRefs = (subject?.work ?? []).flatMap((w) => (w.providerRef === null ? [] : [w.providerRef]));
    const port = await this.portOf(a.accountId);
    const channel = port === this.ports.sms ? "sms" : "email";
    // The replies the lead's record holds are not news (a restart after an auto-reply): the port reports any other reply,
    // in any of the lead's threads (ticket 17a; review bot on ca8baee, item 1; ADR 0002's correlation rules). The port is
    // asked by its own ids, and its answer is recorded by the stored one: the reply identity rule (ADR 0003 "Ticket 17a").
    const knownReplies = (subject?.replies ?? []).filter((r) => r.channel === channel).map((r) => r.providerRef);
    const asked = await this.bounded(() => port.presendCheck({ sender: a.accountId, destination: a.destination, threadRefs, knownReplies: knownReplies.map((id) => this.rules.portReplyId(channel, id)) }), { kind: "unavailable" as const }, port.channel, (result) => ({ call: "presendCheck", result }));
    const result = this.rules.presendAnswer(asked, channel, knownReplies);
    if (result.kind === "unavailable") return false;
    await this.update(a.subjectId, now, (s) => {
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
      if (a && a.state !== "claimed") await this.applyAttempt(a, { kind: "call_answer", answer, now: this.now() });
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
  ): Promise<{ outcome: "handed" | "withdrawn" | "waiting" | "skip"; answer?: CallAnswer; authorized?: Attempt }> {
    const port = await this.portOf(a.accountId);
    return this.locks.run(a.accountId, async () => {
      const { authorized, onlySlot, skip } = authorize(this.now());
      if (!authorized) return { outcome: skip ? "skip" : onlySlot ? "waiting" : "withdrawn" };
      const request = this.request(authorized);
      this.hooks.crashPoint?.(crashPoint, a.id);
      this.hooks.afterAuthorization?.(a.id);
      // Ownership again, immediately before the call: a process frozen since its authorization, whose lease another took,
      // makes no call and leaves the work as committed, for the new owner to settle (the stated limit is the instant
      // between this check and the call itself).
      if (!this.leaseIsMine(this.clockNow())) return { outcome: "skip" };
      const callStart = this.now();
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
        return { outcome: "handed", answer, authorized };
      } finally {
        this.locks.calling.delete(a.id);
      }
    });
  }

  private async tryHandover(a: Attempt): Promise<"handed" | "withdrawn" | "waiting" | "skip"> {
    if (!(await this.presend(a))) {
      const after = await this.store.attempt(a.id);
      return after?.state === "claimed" ? "skip" : "withdrawn";
    }
    await this.hooks.beforeHandover?.(a.id);
    const result = await this.authorizeAndCall(
      a,
      (now) => {
        const out: { authorized: Attempt | null; onlySlot: boolean; skip?: boolean } = { authorized: null, onlySlot: false };
        this.updateNow(a.subjectId, now, (s) => {
          // Ownership, in the transaction that authorizes the send: a process that lost the lease records no handover.
          if (!this.leaseIsMine(now)) {
            out.skip = true;
            return null;
          }
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
    );
    if (result.outcome !== "handed" || !result.answer || !result.authorized) return result.outcome;
    this.hooks.crashPoint?.("after_call", a.id);
    await this.applyAttempt(result.authorized, { kind: "call_answer", answer: result.answer, now: this.now() });
    return "handed";
  }

  private async tryRetry(a: Attempt): Promise<"handed" | "withdrawn" | "waiting" | "skip"> {
    const snapshot = await this.store.subject(a.subjectId, this.now());
    const account = snapshot?.accounts[a.accountId];
    if (snapshot && account) {
      const pending = this.rules.retryFailures(snapshot, a, account, this.now()).filter((f) => f !== "predicate 14");
      if (pending.length > 0 && pending.every((f) => f === "slot")) return "waiting";
    }
    await this.hooks.beforeRetry?.(a.id);
    const fresh = await this.presend(a);
    const result = await this.authorizeAndCall(
      a,
      (now) => {
        const out: { authorized: Attempt | null; onlySlot: boolean; skip?: boolean } = { authorized: null, onlySlot: false };
        this.updateNow(a.subjectId, now, (s) => {
          // Ownership, in the transaction that authorizes the send: a process that lost the lease records no handover.
          if (!this.leaseIsMine(now)) {
            out.skip = true;
            return null;
          }
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
    );
    if (result.outcome !== "handed" || !result.answer || !result.authorized) return result.outcome;
    this.hooks.crashPoint?.("after_call", a.id);
    await this.applyAttempt(result.authorized, { kind: "call_answer", answer: result.answer, now: this.now() });
    return "handed";
  }
}
