/**
 * The engine's worker: restart settlement once (ADR 0003 section 6), then a tick every `TICK_MS` after
 * the last one ends. It keeps the **completed-tick marker** the read models rely on (ADR 0003 4.4, "A
 * read and the worker's placements"): `completedThrough`, the instant its last finished tick began. A
 * tick evaluates and places at its own start or later and commits each placement before it finishes,
 * so the stored state shows everything due at or before that instant. A tick that has begun and not
 * finished covers nothing yet.
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

/** What the HTTP app reads from the worker. */
export interface WorkerProgress {
  /** The instant the last finished tick began: everything due at or before it is stored. Null before the first finishes. */
  completedThrough(): number | null;
  /**
   * Resolves true once a tick that began at or after `at` has finished, or false after `boundMs`
   * (the worker's own timer), whichever comes first.
   */
  caughtUpTo(at: number, boundMs: number): Promise<boolean>;
  /** When the worker's next tick is due to begin; null while none is scheduled. */
  nextTickAt(): number | null;
}

interface Waiter {
  readonly at: number;
  readonly resolve: (done: boolean) => void;
  cancel: () => void;
}

export class Worker implements WorkerProgress {
  private readonly deps: WorkerDeps;
  private completed: number | null = null;
  private next: number | null = null;
  private waiters: Waiter[] = [];
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

  completedThrough(): number | null {
    return this.completed;
  }

  nextTickAt(): number | null {
    return this.next;
  }

  caughtUpTo(at: number, boundMs: number): Promise<boolean> {
    if (this.completed !== null && this.completed >= at) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter: Waiter = { at, resolve, cancel: () => undefined };
      waiter.cancel = this.deps.setTimer(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(false);
      }, boundMs);
      this.waiters.push(waiter);
    });
  }

  private async work(first: boolean): Promise<void> {
    const began = this.deps.now();
    this.next = null;
    try {
      if (first) await this.deps.recover();
      else await this.deps.tick();
    } catch (error) {
      this.deps.onError?.(error);
    }
    // Finished: everything due at or before `began` is stored now.
    this.completed = this.completed === null ? began : Math.max(this.completed, began);
    const done = this.waiters.filter((w) => w.at <= began);
    this.waiters = this.waiters.filter((w) => w.at > began);
    for (const w of done) {
      w.cancel();
      w.resolve(true);
    }
    if (this.halted()) return;
    this.next = this.deps.now() + TICK_MS;
    this.cancel = this.deps.setTimer(() => void this.work(false), TICK_MS);
  }

  /** Read through a method: `stop` may run while a tick is awaited. */
  private halted(): boolean {
    return this.stopped;
  }
}
