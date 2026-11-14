import { createApp } from "../../src/server/app.ts";
import type { BulkRules } from "../../src/server/bulk.ts";
import { Engine, TickQueue, type EngineDependencies, type EngineHooks } from "../../src/server/engine/engine.ts";
import type { AttemptRef, HandoverRequest, SendPort } from "../../src/server/engine/ports.ts";
import type { EmailProviderSource } from "../../src/server/instantly/routes.ts";
import type { Rules } from "../../src/server/engine/rules.ts";
import { openSqliteStore } from "../../src/server/persistence/sqlite-store.ts";
import type { OutreachStore } from "../../src/server/persistence/store.ts";
import type { CampaignDefinition } from "../../src/domain/sequence/definition.ts";
import type { Campaign, EnrollmentProgress, ImportRecord, PersonRecord, SequenceView } from "../../src/shared/api.ts";
import { sequentialIds } from "./domain.ts";
import { csvOf, type ExportRows } from "./export-builder.ts";
import { FakeEmailPort, type FakeAccount, type FakeMode } from "./fake-email-port.ts";
import { FakeSmsPort, type FakeNumber, type FakeSmsMode } from "./fake-sms-port.ts";
import { HEARTBEAT_KEY } from "../../src/server/engine/worker-state.ts";

/** The values a failed call resolves with when `failuresResolve` is set, as the Instantly adapter's do (review bot on 592d679). */
const FAILURE_VALUES: Readonly<Record<string, unknown>> = { presendCheck: { kind: "unavailable" }, lookup: { kind: "unknown" }, withdraw: "unknown", handover: { kind: "unknown" } };

/** The port calls an outage refuses, and the ones a held answer delays (ticket 20a). */
const PORT_CALLS = new Set(["accounts", "presendCheck", "handover", "withdraw", "observe", "lookup"]);

/**
 * The real HTTP app and SQLite store with the engine over a fake email provider, on a clock the
 * test advances. A crash is simulated by dropping the engine and starting a fresh one on the same
 * store and provider, which then runs restart settlement (ADR 0003 section 6).
 */
export interface EngineHarnessOptions {
  readonly start: number;
  readonly accounts: readonly FakeAccount[];
  readonly modes?: readonly FakeMode[];
  readonly random?: () => number;
  readonly rules?: Partial<Rules>;
  /** The bulk rule's parts (ticket 18): the generated bulk runs' mutations replace one. */
  readonly bulkRules?: Partial<BulkRules>;
  readonly hooks?: EngineHooks;
  /** A provider other than the generated test's fake, such as a scripted one, or one built on the harness's store and clock. */
  readonly port?: Provider | ((store: OutreachStore, now: () => number) => Provider);
  /** Further engine dependencies, such as how port waits are bounded. */
  readonly engine?: Partial<EngineDependencies>;
  /** A database file instead of an in-memory one, so a test can reopen it (migration tests). */
  readonly databasePath?: string;
  /** The prefix of the engine's new ids: a harness reopening a database another wrote gives a fresh one, so its ids do not collide. */
  readonly idPrefix?: string;
  /** A fake SMS provider's numbers (ticket 13). Without them the engine has the unprovisioned SMS port. */
  readonly sms?: { readonly numbers: readonly FakeNumber[]; readonly modes?: readonly FakeSmsMode[] };
}

/** A provider the harness can drive: it acts on its own at instants the harness advances to. */
export type Provider = SendPort & { advance(): void; nextActivityAt(): number | null };

export class Crash extends Error {
  constructor(point: string) {
    super(`simulated crash at ${point}`);
  }
}

/** An error the worker loop logs and carries on from, with the same engine (no restart). */
export class TransientError extends Error {
  constructor(point: string) {
    super(`simulated transient error at ${point}`);
  }
}

/** Bounded port waits for tests: a port call not answered by the next turn of the event loop has timed out. */
export function quickWait<T>(promise: Promise<T>, _ms: number, timedOut: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setImmediate(() => resolve(timedOut)))]);
}

export class EngineHarness {
  clock: number;
  readonly store: OutreachStore;
  readonly provider: Provider;
  /** The fake SMS provider, when the harness has one. */
  readonly smsProvider: FakeSmsPort | null;
  engine: Engine;
  readonly crashes: string[] = [];
  /** Engine ticks run so far. */
  ticks = 0;
  /** Hooks every engine this harness starts calls through, so a test may set them at any time. */
  hooks: EngineHooks;
  /** The HTTP app, for tests that walk its routes. */
  readonly app;
  private readonly options: EngineHarnessOptions;
  private readonly engineIds: () => string;

  constructor(options: EngineHarnessOptions) {
    this.options = options;
    this.hooks = options.hooks ?? {};
    this.engineIds = sequentialIds(options.idPrefix ?? "att");
    this.clock = options.start;
    this.store = openSqliteStore(options.databasePath ?? ":memory:");
    // Count the engine's subject writes: a deterministic measure of a run's work, the same on every machine.
    const store = this.store.engine;
    const update = store.update.bind(store);
    const updateNow = store.updateNow.bind(store);
    store.update = async (...args) => {
      const written = await update(...args);
      if (written) this.writes++;
      return written;
    };
    store.updateNow = (...args) => {
      const written = updateNow(...args);
      if (written) this.writes++;
      return written;
    };
    this.provider =
      typeof options.port === "function" ? options.port(this.store, () => this.clock)
      : options.port ?? new FakeEmailPort({ now: () => this.clock, random: options.random ?? (() => 0.5), accounts: options.accounts, modes: options.modes ?? ["honest"] });
    this.smsProvider = options.sms ? new FakeSmsPort({ now: () => this.clock, random: options.random ?? (() => 0.5), numbers: options.sms.numbers, modes: options.sms.modes ?? ["honest"] }) : null;
    this.engine = this.newEngine();
    this.app = createApp({
      store: this.store,
      now: () => new Date(this.clock).toISOString(),
      newId: sequentialIds(),
      engine: { launch: (id, expected) => this.engine.launch(id, expected), logCallOutcome: (id, input) => this.engine.logCallOutcome(id, input), controlLead: (id, action, requestId, expected) => this.engine.controlLead(id, action, requestId, expected), setCampaignPause: (id, pause, requestId, expected) => this.engine.setCampaignPause(id, pause, requestId, expected), transportAvailable: (channel, threading) => this.engine.transportAvailable(channel, threading) },
      emailProvider: "status" in this.provider ? (this.provider as Provider & EmailProviderSource) : null,
      smsProvider: this.smsProvider ? "test-simulator" : "none",
      ...(options.rules ? { rules: options.rules } : {}),
      ...(options.bulkRules ? { bulkRules: options.bulkRules } : {}),
    });
  }

  /** Answers one HTTP request with the app, as a server would: the browser tests serve it this way. */
  fetch(request: Request): Promise<Response> {
    this.markAliveForRequest();
    return Promise.resolve(this.app.fetch(request));
  }

  /**
   * While the world runs, a request finds the worker alive at its instant, as production's 15-second ticks would leave
   * it: the harness moves the clock between requests without ticking, so the heartbeat would otherwise look old. The
   * store writes it synchronously; nothing is awaited, so no request's interleaving with others changes.
   */
  private markAliveForRequest(): void {
    if (this.live && this.standsIn && this.reachable) void this.store.engine.setMeta(HEARTBEAT_KEY, String(this.clock));
  }

  /** The fake SMS provider. */
  get sms(): FakeSmsPort {
    if (!this.smsProvider) throw new Error("this harness has no SMS provider");
    return this.smsProvider;
  }

  /** Both providers act on whatever is due by now. */
  private advanceProviders(): void {
    this.provider.advance();
    this.smsProvider?.advance();
  }

  /** The generated test's fake provider. */
  get fake(): FakeEmailPort {
    if (!(this.provider instanceof FakeEmailPort)) throw new Error("this harness runs a different provider");
    return this.provider;
  }

  // ---------------------------------------------------------------------------------------------
  // Interruptions (ADR 0003 "Ticket 20a").

  /**
   * Whether the application runs continuously. Production's worker ticks every 15 seconds; the harness skips the
   * ticks that would change nothing, so while the world runs it marks the worker alive (the heartbeat) at each tick
   * it does run, as those quiet ticks would have. Only the stops and outages a test makes are interruptions.
   */
  private live = true;
  /** False when a test runs every tick itself, production-like: the harness then never stands in for a quiet tick. */
  standsIn = true;
  /** While set, every provider call the engine makes fails, as with the network down (the providers still act). */
  providersDownUntil: number | null = null;
  /** A provider answer held while the clock moves on (follow-up 42 item 39): the next call of this kind arrives `ms` later. */
  heldAnswer: { readonly kind: "observe" | "lookup"; readonly ms: number } | null = null;
  /** Called when a held answer arrives, the clock already moved and the providers caught up, before the call returns. */
  onHeldAnswer: ((askedAt: number, answeredAt: number) => void) | null = null;
  /**
   * Ticket 20a (PR 56 review bot): providers that, like the Instantly adapter between polls, answer their account read and
   * observation from a cache while unreachable, and report their freshness: the last real answer, standing for one
   * minute's polling interval twice over.
   */
  cachedPolls = false;
  /** During an outage, the calls that have a failure value resolve with it (pre-send unavailable, lookup and withdrawal unknown), as the adapter's do. */
  failuresResolve = false;
  /**
   * Ticket 20a (PR 56 review bot): during an outage only the reads that carry replies, bounces and sends fail (the
   * observation, the pre-send check, lookups); account reads, send calls and withdrawals still answer.
   */
  partialOutage = false;
  private static readonly PARTIAL = new Set(["observe", "presendCheck", "lookup"]);
  /** Send calls an outage swallowed: committed by the engine, never received by the provider (the app cannot know which). */
  /** Withdrawal asks an outage swallowed: the engine asked, the provider never heard; the engine counts it as an ask answered unknown. */
  readonly swallowedWithdrawals: { readonly channel: string; readonly key: string; readonly at: number }[] = [];
  readonly swallowedHandovers: { readonly channel: string; readonly key: string; readonly subjectId: string; readonly stepId: string; readonly sender: string; readonly at: number }[] = [];
  private readonly lastReal = new Map<SendPort, number>();
  private readonly cachedAccounts = new Map<SendPort, unknown>();
  /** The instants held answers arrived at, as asked and as answered. */
  readonly heldAnswers: { readonly kind: string; readonly askedAt: number; readonly answeredAt: number }[] = [];

  private get reachable(): boolean {
    return this.providersDownUntil === null || this.clock >= this.providersDownUntil;
  }

  /** While set, only these channels' providers are cut off by an outage (council on 13dad92: an SMS outage alone). */
  outageChannels: ReadonlySet<string> | null = null;
  /** Every call of this kind takes `ms` of the clock before it answers (council on 13dad92: a slow tick with no outage). */
  slowCalls: { readonly kind: string; readonly ms: number } | null = null;

  private reachableFor(channel: string): boolean {
    return this.reachable || (this.outageChannels !== null && !this.outageChannels.has(channel));
  }

  /** The port as the engine sees it: unreachable during an outage, and with a held answer arriving late. */
  private gated(port: SendPort): SendPort {
    return new Proxy(port, {
      get: (target, prop, receiver) => {
        if (prop === "contact" && this.cachedPolls) return () => ({ at: this.lastReal.get(target) ?? null, freshForMs: 2 * 60_000 });
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof prop !== "string" || !PORT_CALLS.has(prop) || typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const failing = !this.reachableFor(target.channel) && (!this.partialOutage || EngineHarness.PARTIAL.has(prop));
          if (this.slowCalls && this.slowCalls.kind === prop && !failing) {
            this.clock += this.slowCalls.ms;
            this.advanceProviders();
          }
          // As the adapter does (review bot on 592d679): a failed call that resolves with a failure value instead of throwing.
          if (failing && this.failuresResolve && FAILURE_VALUES[prop] !== undefined) return Promise.resolve(FAILURE_VALUES[prop]);
          if (failing && this.cachedPolls && prop === "observe") return Promise.resolve({ events: [], checkpoint: args[0] ?? "" });
          if (failing && this.cachedPolls && prop === "accounts" && this.cachedAccounts.has(target)) return Promise.resolve(this.cachedAccounts.get(target));
          if (failing) {
            if (prop === "withdraw") {
              const r = args[0] as AttemptRef;
              this.swallowedWithdrawals.push({ channel: target.channel, key: r.idempotencyKey, at: this.clock });
            }
            if (prop === "handover") {
              const r = args[0] as HandoverRequest;
              this.swallowedHandovers.push({ channel: target.channel, key: r.idempotencyKey, subjectId: r.subjectId, stepId: r.stepId, sender: r.sender, at: this.clock });
            }
            return Promise.reject(new Error("the provider is unreachable"));
          }
          // As the adapter does: contact only once the observation, the last read relied on, has answered.
          if (prop === "observe" && (this.reachable || !this.partialOutage)) this.lastReal.set(target, this.clock);
          const held = this.heldAnswer;
          if (held && held.kind === prop) {
            this.heldAnswer = null;
            const askedAt = this.clock;
            this.clock += held.ms;
            this.advanceProviders();
            this.heldAnswers.push({ kind: prop, askedAt, answeredAt: this.clock });
            this.lastReal.set(target, this.clock);
            this.onHeldAnswer?.(askedAt, this.clock);
          }
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (prop === "accounts") void (result as Promise<unknown>).then((answer) => this.cachedAccounts.set(target, answer), () => undefined);
          return result;
        };
      },
    });
  }

  /** Called when a stop ends, with its first and last instant, the clock at the restart and the providers caught up, before restart settlement. */
  onStop: ((from: number, to: number) => void) | null = null;
  /** Called once restart settlement after a stop has run. */
  onResumed: (() => Promise<void>) | null = null;
  /** Called at each tick, after the providers act and before the engine runs. */
  beforeTick: (() => void) | null = null;
  /** Called after each tick the engine completed. */
  afterTick: (() => Promise<void>) | null = null;
  /** When set, the next simulated crash stops the application for this long before it restarts. */
  downAfterCrash: number | null = null;
  /** True while restart settlement runs. */
  recovering = false;
  /** Set by a crash that stopped the application: the advance under way ends, as the world it was advancing stopped. */
  private halt = false;

  /**
   * Stops the application for `ms`: nothing ticks while the providers carry on; then a fresh engine on the same store
   * runs restart settlement. The heartbeat stays where the last tick left it.
   */
  async stopFor(ms: number): Promise<void> {
    this.live = false;
    const from = this.clock;
    this.clock += ms;
    this.advanceProviders();
    this.onStop?.(from, this.clock);
    await this.restart();
    await this.resumeLive();
    await this.onResumed?.();
  }

  /** Whether a crash stopped the world during the advance under way (a method: the tick it ran in sets it). */
  private halted(): boolean {
    return this.halt;
  }

  /** The world runs again once the engine has recorded a heartbeat at this instant. */
  private async resumeLive(): Promise<void> {
    if ((await this.store.engine.meta(HEARTBEAT_KEY)) === String(this.clock)) this.live = true;
  }

  /** The application keeps ticking, but the harness stops standing in for its quiet ticks: until a tick of the engine's own succeeds. */
  stopMarkingAlive(): void {
    this.live = false;
  }

  /** Cuts every provider off until `until`, while the application keeps ticking. */
  cutProvidersOff(until: number): void {
    this.providersDownUntil = until;
    this.live = false;
  }

  private newEngine(): Engine {
    return new Engine({
      ...this.options.engine,
      store: this.store.engine,
      port: this.gated(this.provider),
      ...(this.smsProvider ? { smsPort: this.gated(this.smsProvider) } : {}),
      now: () => this.clock,
      newId: this.engineIds,
      ...(this.options.rules ? { rules: this.options.rules } : {}),
      hooks: {
        beforeApplyEvaluation: async (id) => this.hooks.beforeApplyEvaluation?.(id),
        beforeHandover: async (id) => this.hooks.beforeHandover?.(id),
        afterClaim: async (id) => this.hooks.afterClaim?.(id),
        beforeRetry: async (id) => this.hooks.beforeRetry?.(id),
        afterAuthorization: (id) => this.hooks.afterAuthorization?.(id),
        crashPoint: (point, id) => this.hooks.crashPoint?.(point, id),
      },
    });
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    this.markAliveForRequest();
    const response = await this.app.request(path, {
      method,
      ...(method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }),
    });
    return { status: response.status, body: (await response.json()) as T };
  }

  async createCampaign(name: string, rows: ExportRows, defaultTimezone = "Europe/London"): Promise<{ campaign: Campaign; import: ImportRecord }> {
    const res = await this.request<{ campaign: Campaign; import: ImportRecord }>("POST", "/api/campaigns", { name, defaultTimezone, ...csvOf(rows) });
    if (res.status !== 201) throw new Error(`campaign not created: ${JSON.stringify(res.body)}`);
    return res.body;
  }

  async reimport(campaignId: string, rows: ExportRows): Promise<ImportRecord> {
    const res = await this.request<{ import: ImportRecord }>("POST", `/api/campaigns/${campaignId}/imports`, csvOf(rows));
    if (res.status !== 201) throw new Error(`import failed: ${JSON.stringify(res.body)}`);
    return res.body.import;
  }

  async defineSequence(campaignId: string, definition: CampaignDefinition): Promise<SequenceView> {
    const res = await this.request<SequenceView>("PUT", `/api/campaigns/${campaignId}/sequence`, definition);
    if (res.status !== 200) throw new Error(`sequence refused: ${JSON.stringify(res.body)}`);
    return res.body;
  }

  async launch(campaignId: string): Promise<{ status: number; body: unknown }> {
    this.advanceProviders();
    return this.request("POST", `/api/campaigns/${campaignId}/launch`);
  }

  async progress(enrollmentId: string): Promise<EnrollmentProgress> {
    const res = await this.request<EnrollmentProgress>("GET", `/api/enrollments/${enrollmentId}`);
    if (res.status !== 200) throw new Error(`no enrollment ${enrollmentId}`);
    return res.body;
  }

  async person(personId: string): Promise<PersonRecord> {
    return (await this.request<PersonRecord>("GET", `/api/people/${personId}`)).body;
  }

  /** One engine tick at the current instant, recovering from a simulated crash. */
  async tick(): Promise<void> {
    this.ticks++;
    // Yield to the event loop, so the test runner's worker can answer its RPC on long runs.
    await new Promise((resolve) => setImmediate(resolve));
    this.advanceProviders();
    if (this.providersDownUntil !== null && this.clock >= this.providersDownUntil) {
      this.providersDownUntil = null;
      this.partialOutage = false;
      this.outageChannels = null;
    }
    if (this.live && this.standsIn) await this.store.engine.setMeta(HEARTBEAT_KEY, String(this.clock));
    this.beforeTick?.();
    try {
      await this.engine.tick();
      // The world runs again once the engine itself has recorded a heartbeat (the first tick after a stop, an outage or
      // a long sleep inside a tick is the engine's to report).
      if (!this.live && this.providersDownUntil === null && (await this.store.engine.meta(HEARTBEAT_KEY)) === String(this.clock)) this.live = true;
    } catch (error) {
      if (error instanceof TransientError) return;
      if (!(error instanceof Crash)) throw error;
      this.crashes.push(error.message);
      if (this.downAfterCrash !== null) {
        // The crash stops the application: it stays down, then restarts.
        const ms = this.downAfterCrash;
        this.downAfterCrash = null;
        this.live = false;
        this.halt = true;
        const from = this.clock;
        this.clock += ms;
        this.advanceProviders();
        this.onStop?.(from, this.clock);
        await this.restart();
        await this.resumeLive();
        await this.onResumed?.();
        return;
      }
      await this.restart();
    }
    await this.afterTick?.();
  }

  /**
   * A second worker on the same store and provider, with the test's rules but none of its hooks:
   * it applies an injected event at once, while the main engine is between two steps.
   */
  async otherWorker(): Promise<void> {
    this.advanceProviders();
    // Another process: its ticks do not queue behind this one's.
    await new Engine({ ...this.options.engine, ticks: new TickQueue(), store: this.store.engine, port: this.provider, ...(this.smsProvider ? { smsPort: this.smsProvider } : {}), now: () => this.clock, newId: this.engineIds, ...(this.options.rules ? { rules: this.options.rules } : {}) }).tick();
  }

  /** A fresh engine on the same store and provider, settling what the crash left open. */
  async restart(): Promise<void> {
    this.engine = this.newEngine();
    this.recovering = true;
    try {
      for (let i = 0; i < 20; i++) {
        try {
          this.advanceProviders();
          await this.engine.recover();
          return;
        } catch (error) {
          if (error instanceof TransientError) return;
          if (!(error instanceof Crash)) throw error;
          this.crashes.push(error.message);
          this.engine = this.newEngine();
        }
      }
      throw new Error("the engine crashed on every restart");
    } finally {
      this.recovering = false;
    }
  }

  /** Advances the clock to `target`, ticking at every instant the engine or the provider has work. */
  /** Engine writes to subjects so far: every claim, handover, settlement and evaluation that changed state. */
  writes = 0;
  /** A run's bound: the number of engine writes after which every advance stops at once. */
  maxWrites: number | null = null;
  /** An outer safety net only: a wall-clock instant (Date.now) after which every advance stops. */
  stopAt: number | null = null;

  /** Whether the run's bound is spent: its engine writes, or, as a safety net, its wall-clock instant. */
  get stopped(): boolean {
    return (this.maxWrites !== null && this.writes > this.maxWrites) || (this.stopAt !== null && Date.now() > this.stopAt);
  }

  async advanceTo(target: number, onInstant?: () => Promise<void>): Promise<void> {
    this.halt = false;
    await this.tick();
    for (let guard = 0; guard < 100_000 && this.clock < target && !this.stopped && !this.halted(); guard++) {
      const wakes = [await this.engine.nextWakeAt(), this.provider.nextActivityAt(), this.smsProvider?.nextActivityAt() ?? null, this.providersDownUntil, target].filter((t): t is number => t !== null && t > this.clock);
      this.clock = Math.min(...wakes);
      await this.tick();
      await onInstant?.();
    }
  }
}
