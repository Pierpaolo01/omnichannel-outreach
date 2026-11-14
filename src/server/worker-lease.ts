/**
 * One worker per database (ADR 0003 "Ticket 20a"; follow-up 42 item 15). The process that runs the worker takes a
 * lease in the store, renews it on a timer of its own (independent of the tick, so a slow tick never loses it) and
 * releases it on shutdown. A second process is refused while the lease is held by another owner, renewed within
 * LEASE_STALE_MS, whose process is alive on this machine; a crashed or stale holder is taken over.
 */
import type { EngineStore } from "./engine/engine-store.ts";

/** How often the lease is renewed: the worker's tick interval. */
export const LEASE_RENEW_MS = 15_000;
/** A lease not renewed for longer than this is stale: four renewals missed. */
export const LEASE_STALE_MS = 60_000;

/** Whether a process id is alive on this machine: signal 0 checks without sending anything. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class WorkerLeaseHolder {
  private readonly store: Pick<EngineStore, "takeLease" | "releaseLease">;
  private readonly owner: { readonly id: string; readonly pid: number; readonly now: () => number; readonly alive: (pid: number) => boolean };

  constructor(store: Pick<EngineStore, "takeLease" | "releaseLease">, owner: { readonly id: string; readonly pid: number; readonly now: () => number; readonly alive: (pid: number) => boolean }) {
    this.store = store;
    this.owner = owner;
  }

  /** The instant of this process's last successful take or renewal. */
  private lastHeld: number | null = null;

  /**
   * Whether this process still holds the lease at `now` (council E): its last successful renewal is within the lease's
   * staleness window, so no other process can have taken it. The engine's dispatch gate reads this.
   */
  heldAt(now: number): boolean {
    return this.lastHeld !== null && now - this.lastHeld <= LEASE_STALE_MS;
  }

  /** Takes the lease, or says plainly who holds it. */
  async take(): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
    const now = this.owner.now();
    const result = await this.store.takeLease({ id: this.owner.id, pid: this.owner.pid, renewedWall: now }, now, LEASE_STALE_MS, this.owner.alive);
    if (result.ok) this.lastHeld = now;
    else this.lastHeld = null;
    if (result.ok) return { ok: true };
    return {
      ok: false,
      message: `Another process (${result.holder.pid}) is running the worker on this database; it last checked in at ${new Date(result.holder.renewedWall).toISOString()}. Stop it first, or wait a minute if it has stopped.`,
    };
  }

  /** Renews the lease; false when another process has taken it (this one was stale or presumed dead). */
  async renew(): Promise<boolean> {
    return (await this.take()).ok;
  }

  async release(): Promise<void> {
    this.lastHeld = null;
    await this.store.releaseLease(this.owner.id);
  }
}
