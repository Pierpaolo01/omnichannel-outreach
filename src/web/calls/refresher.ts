/**
 * The one reader and freshness mechanism of Today and Calls (ADR 0003 4.4.1, "Freshness" and "Reads
 * are ordered, and every failure is counted"), one per resource: the queue, the call, Today. It runs
 * one read at a time; a read asked for while one runs is folded into one read after it, so an older
 * answer is never applied after a newer one, and the next scheduled read is always the newest
 * answer's. While visible it reads again every `REFRESH_INTERVAL_MS`, sooner at the server's hint
 * `nextChangeAt`, and whenever the page asks; hidden, it does not poll. A failed read keeps what the screen shows and
 * is retried with backoff; after `STALE_AFTER` failures in a row the screen says it may be out of date.
 */

/**
 * While a screen is visible it reads again every `REFRESH_INTERVAL_MS` (ADR 0003 4.4.1, "Freshness"),
 * a little longer than the worker's tick (15 seconds): what it shows is then at most one tick plus
 * this interval behind stored state while the server is reachable. Hidden, it does not poll.
 */
export const REFRESH_INTERVAL_MS = 20_000;

/** Backoff after a failed read, in milliseconds; the last repeats. */
export const REFRESH_RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;
/** Failed reads in a row after which a screen says it may be out of date. */
export const STALE_AFTER = 2;

/** A read the server times: read again at `nextChangeAt`. A resource without them (a call) is read when asked. */
export interface Timed {
  readonly asOf?: string;
  readonly nextChangeAt?: string | null;
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

export interface RefresherDeps<T> {
  /** One read. */
  read(): Promise<T>;
  /** Applies a successful read; awaited before the read counts as done. */
  onRead(value: T): Promise<void> | void;
  onFailure(error: unknown, freshness: Freshness): void;
  /** Runs `fire` after `ms`; returns a cancel. */
  setTimer(fire: () => void, ms: number): () => void;
  /** Read again every this many milliseconds while visible; a resource read only when asked has none. */
  readonly interval?: number;
  /** Test-only fault: reads overlap, so an older answer can land after a newer one. Never set by a page. */
  readonly overlapFault?: boolean;
}

export class Refresher<T> {
  private readonly deps: RefresherDeps<T>;
  private cancel: (() => void) | null = null;
  private failures = 0;
  private lastReadAt: string | null = null;
  private stopped = true;
  private hidden = false;
  /** The read running now, and the one read folded from every request made meanwhile. */
  private running: Promise<void> | null = null;
  private folded: Promise<void> | null = null;

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

  /** The page was hidden or shown: hidden, nothing is read on a timer; shown, it reads now. */
  setVisible(visible: boolean): void {
    this.hidden = !visible;
    if (!visible) {
      this.cancel?.();
      this.cancel = null;
    } else void this.now();
  }

  /**
   * Reads now, or, if a read is running, once right after it (every request made meanwhile is that one
   * read). Resolves when the read that covers this request is applied.
   */
  now(): Promise<void> {
    if (this.halted()) return Promise.resolve();
    const running = this.running;
    if (running === null || this.deps.overlapFault === true) return this.begin();
    if (this.folded) return this.folded;
    const folded = running.then(() => {
      this.folded = null;
      return this.now();
    });
    this.folded = folded;
    return folded;
  }

  private begin(): Promise<void> {
    const run = this.readOnce().finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  private async readOnce(): Promise<void> {
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
    const timed = value as Timed;
    this.lastReadAt = timed.asOf ?? this.lastReadAt;
    await this.deps.onRead(value);
    if (this.halted()) return;
    // The interval, or sooner at the server's hint (`nextChangeAt`, measured from its own `asOf`).
    const hint = timed.nextChangeAt && timed.asOf ? Math.max(0, Date.parse(timed.nextChangeAt) - Date.parse(timed.asOf)) : null;
    const delays = [this.deps.interval ?? null, hint].filter((d): d is number => d !== null);
    if (delays.length === 0) {
      this.cancel?.();
      this.cancel = null;
    } else this.schedule(Math.min(...delays));
  }

  /** Read through a method: `stop` may run while a read is awaited. */
  private halted(): boolean {
    return this.stopped;
  }

  private schedule(ms: number): void {
    this.cancel?.();
    this.cancel = null;
    if (this.hidden) return;
    this.cancel = this.deps.setTimer(() => {
      this.cancel = null;
      void this.now();
    }, ms);
  }
}
