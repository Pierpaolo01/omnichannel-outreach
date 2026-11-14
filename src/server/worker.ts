/**
 * The engine's worker: restart settlement once (ADR 0003 section 6), then a tick every `TICK_MS` after
 * the last one ends. The completed-placement marker a read relies on is not kept here: the engine
 * stores it in the transaction that stores its placements (ADR 0003 4.4). The worker only lets a read
 * wait for its next tick to end, and says when that tick is due.
 */
export const TICK_MS = 15_000;
/** How long a read waits for the worker before it answers with what is stored, marked `behind`. */
export const READ_WAIT_MS = 3_000;

export interface WorkerDeps {
  recover(): Promise<void>;
  tick(): Promise<void>;
  now(): number;
  /** Runs `fire` after `ms`; returns a cancel. */
  setTimer(fire: () => void, ms: number): () => void;
  onError?(error: unknown): void;
}

/** What the HTTP app reads from the worker: only when its ticks end. The marker itself is stored (ADR 0003 4.4). */
export interface WorkerProgress {
  /** Resolves when the worker's next tick ends, whether it succeeded or threw, or after `boundMs`, whichever is first. */
  tickEnded(boundMs: number): Promise<void>;
  /** When the worker's next tick is due to begin; null while one runs or none is scheduled. */
  nextTickAt(): number | null;
}

export class Worker implements WorkerProgress {
  private readonly deps: WorkerDeps;
  private next: number | null = null;
  private waiters: (() => void)[] = [];
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
    this.next = null;
  }

  nextTickAt(): number | null {
    return this.next;
  }

  tickEnded(boundMs: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        cancelBound();
        resolve();
      };
      const cancelBound = this.deps.setTimer(finish, boundMs);
      this.waiters.push(finish);
    });
  }

  private async work(first: boolean): Promise<void> {
    this.next = null;
    try {
      if (first) await this.deps.recover();
      else await this.deps.tick();
    } catch (error) {
      this.deps.onError?.(error);
    }
    // Only a wake-up: what a read relies on is the stored marker, written with the placements.
    const waiting = this.waiters;
    this.waiters = [];
    for (const w of waiting) w();
    if (this.halted()) return;
    this.next = this.deps.now() + TICK_MS;
    this.cancel = this.deps.setTimer(() => void this.work(false), TICK_MS);
  }

  /** Read through a method: `stop` may run while a tick is awaited. */
  private halted(): boolean {
    return this.stopped;
  }
}
