import { createApp } from "../../src/server/app.ts";
import { Engine, TickQueue, type EngineDependencies, type EngineHooks } from "../../src/server/engine/engine.ts";
import type { SendPort } from "../../src/server/engine/ports.ts";
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
  readonly hooks?: EngineHooks;
  /** A provider other than the generated test's fake, such as a scripted one, or one built on the harness's store and clock. */
  readonly port?: Provider | ((store: OutreachStore, now: () => number) => Provider);
  /** Further engine dependencies, such as how port waits are bounded. */
  readonly engine?: Partial<EngineDependencies>;
  /** A database file instead of an in-memory one, so a test can reopen it (migration tests). */
  readonly databasePath?: string;
  /** A fake SMS provider's numbers (ticket 13). Without them the engine has the unprovisioned SMS port. */
  readonly sms?: { readonly numbers: readonly FakeNumber[]; readonly modes?: readonly FakeSmsMode[] };
  /** A worker the HTTP app reads its progress from (ticket 14b's freshness rule); the harness ticks itself otherwise. */
  readonly worker?: import("../../src/server/worker.ts").WorkerProgress;
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
  private readonly engineIds = sequentialIds("att");

  constructor(options: EngineHarnessOptions) {
    this.options = options;
    this.hooks = options.hooks ?? {};
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
      engine: { launch: (id, expected) => this.engine.launch(id, expected), logCallOutcome: (id, input) => this.engine.logCallOutcome(id, input), nextWakeAt: () => this.engine.nextWakeAt() },
      emailProvider: "status" in this.provider ? (this.provider as Provider & EmailProviderSource) : null,
      smsProvider: this.smsProvider ? "test-simulator" : "none",
      ...(options.rules ? { rules: options.rules } : {}),
      ...(options.worker ? { worker: options.worker } : {}),
    });
  }

  /** Answers one HTTP request with the app, as a server would: the browser tests serve it this way. */
  fetch(request: Request): Promise<Response> {
    return Promise.resolve(this.app.fetch(request));
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

  private newEngine(): Engine {
    return new Engine({
      ...this.options.engine,
      store: this.store.engine,
      port: this.provider,
      ...(this.smsProvider ? { smsPort: this.smsProvider } : {}),
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
    try {
      await this.engine.tick();
    } catch (error) {
      if (error instanceof TransientError) return;
      if (!(error instanceof Crash)) throw error;
      this.crashes.push(error.message);
      await this.restart();
    }
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
    await this.tick();
    for (let guard = 0; guard < 100_000 && this.clock < target && !this.stopped; guard++) {
      const wakes = [await this.engine.nextWakeAt(), this.provider.nextActivityAt(), this.smsProvider?.nextActivityAt() ?? null, target].filter((t): t is number => t !== null && t > this.clock);
      this.clock = Math.min(...wakes);
      await this.tick();
      await onInstant?.();
    }
  }
}
