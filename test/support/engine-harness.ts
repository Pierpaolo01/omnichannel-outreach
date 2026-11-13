import { createApp } from "../../src/server/app.ts";
import { Engine, type EngineHooks } from "../../src/server/engine/engine.ts";
import type { Rules } from "../../src/server/engine/rules.ts";
import { openSqliteStore } from "../../src/server/persistence/sqlite-store.ts";
import type { OutreachStore } from "../../src/server/persistence/store.ts";
import type { CampaignDefinition } from "../../src/domain/sequence/definition.ts";
import type { Campaign, EnrollmentProgress, ImportRecord, PersonRecord, SequenceView } from "../../src/shared/api.ts";
import { sequentialIds } from "./domain.ts";
import { csvOf, type ExportRows } from "./export-builder.ts";
import { FakeEmailPort, type FakeAccount, type FakeMode } from "./fake-email-port.ts";

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
}

export class Crash extends Error {
  constructor(point: string) {
    super(`simulated crash at ${point}`);
  }
}

export class EngineHarness {
  clock: number;
  readonly store: OutreachStore;
  readonly fake: FakeEmailPort;
  engine: Engine;
  readonly crashes: string[] = [];
  /** Engine ticks run so far. */
  ticks = 0;
  /** Hooks every engine this harness starts calls through, so a test may set them at any time. */
  hooks: EngineHooks;
  private readonly app;
  private readonly options: EngineHarnessOptions;
  private readonly engineIds = sequentialIds("att");

  constructor(options: EngineHarnessOptions) {
    this.options = options;
    this.hooks = options.hooks ?? {};
    this.clock = options.start;
    this.store = openSqliteStore(":memory:");
    this.fake = new FakeEmailPort({ now: () => this.clock, random: options.random ?? (() => 0.5), accounts: options.accounts, modes: options.modes ?? ["honest"] });
    this.engine = this.newEngine();
    this.app = createApp({
      store: this.store,
      now: () => new Date(this.clock).toISOString(),
      newId: sequentialIds(),
      engine: { launch: (id) => this.engine.launch(id) },
    });
  }

  private newEngine(): Engine {
    return new Engine({
      store: this.store.engine,
      port: this.fake,
      now: () => this.clock,
      newId: this.engineIds,
      ...(this.options.rules ? { rules: this.options.rules } : {}),
      hooks: {
        beforeApplyEvaluation: async (id) => this.hooks.beforeApplyEvaluation?.(id),
        beforeHandover: async (id) => this.hooks.beforeHandover?.(id),
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
    this.fake.advance();
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
    this.fake.advance();
    try {
      await this.engine.tick();
    } catch (error) {
      if (!(error instanceof Crash)) throw error;
      this.crashes.push(error.message);
      await this.restart();
    }
  }

  /** A fresh engine on the same store and provider, settling what the crash left open. */
  async restart(): Promise<void> {
    this.engine = this.newEngine();
    for (let i = 0; i < 20; i++) {
      try {
        this.fake.advance();
        await this.engine.recover();
        return;
      } catch (error) {
        if (!(error instanceof Crash)) throw error;
        this.crashes.push(error.message);
        this.engine = this.newEngine();
      }
    }
    throw new Error("the engine crashed on every restart");
  }

  /** Advances the clock to `target`, ticking at every instant the engine or the provider has work. */
  async advanceTo(target: number, onInstant?: () => Promise<void>): Promise<void> {
    await this.tick();
    for (let guard = 0; guard < 100_000 && this.clock < target; guard++) {
      const wakes = [await this.engine.nextWakeAt(), this.fake.nextActivityAt(), target].filter((t): t is number => t !== null && t > this.clock);
      this.clock = Math.min(...wakes);
      await this.tick();
      await onInstant?.();
    }
  }
}
