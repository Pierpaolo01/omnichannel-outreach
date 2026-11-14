/**
 * The engine's worker: restart settlement once (ADR 0003 section 6), then a tick every `TICK_MS` after
 * the last one ends. It also tells the read models how far it has got (ADR 0003 4.4.1, "the instant
 * the server advertises"): when its last tick started, and a promise of the end of the next tick, so a
 * read the clock says should show a change can wait for the worker to have made it.
 */
export const TICK_MS = 15_000;

export interface WorkerDeps {
  recover(): Promise<void>;
  tick(): Promise<void>;
  now(): number;
  /** Runs `fire` after `ms`; returns a cancel. */
  setTimer(fire: () => void, ms: number): () => void;
  onError?(error: unknown): void;
}

/** What the HTTP app reads from the worker. */
export interface WorkerProgress {
  /** When the worker's last tick (or restart settlement) started; null before the first. */
  lastTickStartedAt(): number | null;
  /** Resolves once a tick that starts after this call has ended. */
  caughtUp(): Promise<void>;
}

export class Worker implements WorkerProgress {
  private readonly deps: WorkerDeps;
  private lastStart: number | null = null;
  private waiting: (() => void)[] = [];
  private cancel: (() => void) | null = null;
  private stopped = false;

  constructor(deps: WorkerDeps) {
    this.deps = deps;
  }

  start(): void {
    this.stopped = false;
    void this.work(true);
  }

  stop(): void {
    this.stopped = true;
    this.cancel?.();
    this.cancel = null;
  }

  lastTickStartedAt(): number | null {
    return this.lastStart;
  }

  caughtUp(): Promise<void> {
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private async work(first: boolean): Promise<void> {
    // Those waiting now are answered by the end of this tick, which starts after they asked.
    const answering = this.waiting;
    this.waiting = [];
    this.lastStart = this.deps.now();
    try {
      if (first) await this.deps.recover();
      else await this.deps.tick();
    } catch (error) {
      this.deps.onError?.(error);
    }
    for (const resolve of answering) resolve();
    if (!this.halted()) this.cancel = this.deps.setTimer(() => void this.work(false), TICK_MS);
  }

  /** Read through a method: `stop` may run while a tick is awaited. */
  private halted(): boolean {
    return this.stopped;
  }
}
