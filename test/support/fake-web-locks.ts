/**
 * Web Locks as the call desk uses them (ADR 0003 4.4.1), shared by the tabs of one test: `claim`
 * asks once (`ifAvailable`), `wait` queues until granted or aborted. Releasing a lock grants it to the
 * first live waiter, as the browser does when a tab leaves.
 */
export class FakeWebLocks {
  private readonly held = new Map<string, symbol>();
  private readonly queues = new Map<string, { grant: (release: () => void) => void; signal: AbortSignal }[]>();

  claim = (name: string): Promise<(() => void) | null> => Promise.resolve(this.held.has(name) ? null : this.take(name));

  wait = (name: string, signal: AbortSignal): Promise<(() => void) | null> => {
    if (signal.aborted) return Promise.resolve(null);
    if (!this.held.has(name)) return Promise.resolve(this.take(name));
    return new Promise((resolve) => {
      const queue = this.queues.get(name) ?? [];
      const waiter = { grant: (release: () => void) => resolve(release), signal };
      queue.push(waiter);
      this.queues.set(name, queue);
      signal.addEventListener("abort", () => {
        const q = this.queues.get(name) ?? [];
        const i = q.indexOf(waiter);
        if (i >= 0) q.splice(i, 1);
        resolve(null);
      });
    });
  };

  /** Whether anyone holds `name`. */
  isHeld = (name: string): boolean => this.held.has(name);

  private take(name: string): () => void {
    const token = Symbol(name);
    this.held.set(name, token);
    return () => {
      if (this.held.get(name) !== token) return;
      this.held.delete(name);
      const queue = this.queues.get(name) ?? [];
      let next = queue.shift();
      while (next?.signal.aborted) next = queue.shift();
      if (next) next.grant(this.take(name));
    };
  }
}
