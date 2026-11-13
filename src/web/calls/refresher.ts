/**
 * The one freshness mechanism of Today and Calls (ADR 0003 4.4.1, "Freshness"): a clock-driven read
 * that is read again at the server's `nextChangeAt` (measured from its `asOf`, so the browser's clock
 * does not matter), and whenever the page asks (showing the tab, focus, coming back online, a storage
 * change, an action). A failed read keeps what the screen shows and is retried with backoff; after
 * `STALE_AFTER` failures in a row the screen says it may be out of date. Refreshing always resumes.
 */

/** Backoff after a failed read, in milliseconds; the last repeats. */
export const REFRESH_RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;
/** Failed reads in a row after which a screen says it may be out of date. */
export const STALE_AFTER = 2;

export interface Timed {
  readonly asOf: string;
  readonly nextChangeAt: string | null;
}

export interface Freshness {
  /** Failed reads in a row since the last successful one. */
  readonly failures: number;
  /** The server's instant of the last successful read, if any. */
  readonly lastReadAt: string | null;
  /** The screen may be out of date: `STALE_AFTER` failures in a row. */
  readonly stale: boolean;
}

export const FRESH: Freshness = { failures: 0, lastReadAt: null, stale: false };

export interface RefresherDeps<T extends Timed> {
  read(): Promise<T>;
  /** Applies a successful read; awaited before the read counts as done. */
  onRead(value: T): Promise<void> | void;
  onFailure(error: unknown, freshness: Freshness): void;
  /** Runs `fire` after `ms`; returns a cancel. */
  setTimer(fire: () => void, ms: number): () => void;
}

export class Refresher<T extends Timed> {
  private readonly deps: RefresherDeps<T>;
  private cancel: (() => void) | null = null;
  private failures = 0;
  private lastReadAt: string | null = null;
  private stopped = true;

  constructor(deps: RefresherDeps<T>) {
    this.deps = deps;
  }

  freshness(): Freshness {
    return { failures: this.failures, lastReadAt: this.lastReadAt, stale: this.failures >= STALE_AFTER };
  }

  start(): void {
    this.stopped = false;
  }

  stop(): void {
    this.stopped = true;
    this.cancel?.();
    this.cancel = null;
  }

  /** Reads now; the next read is then scheduled from the answer, or from the backoff after a failure. */
  async now(): Promise<void> {
    if (this.halted()) return;
    let value: T;
    try {
      value = await this.deps.read();
    } catch (error) {
      if (this.halted()) return;
      this.failures++;
      this.deps.onFailure(error, this.freshness());
      this.schedule(REFRESH_RETRY_MS[Math.min(this.failures - 1, REFRESH_RETRY_MS.length - 1)] ?? 60_000);
      return;
    }
    if (this.halted()) return;
    this.failures = 0;
    this.lastReadAt = value.asOf;
    await this.deps.onRead(value);
    if (this.halted()) return;
    if (value.nextChangeAt === null) {
      this.cancel?.();
      this.cancel = null;
    } else this.schedule(Math.max(0, Date.parse(value.nextChangeAt) - Date.parse(value.asOf)));
  }

  /** Read through a method: `stop` may run while a read is awaited. */
  private halted(): boolean {
    return this.stopped;
  }

  private schedule(ms: number): void {
    this.cancel?.();
    this.cancel = this.deps.setTimer(() => {
      this.cancel = null;
      void this.now();
    }, ms);
  }
}
