/**
 * The worker's lease in a table of its own (ticket 20a, council F): created and taken before any migration, so a newer
 * build started beside a running one is refused before it changes the database. It needs no schema but itself.
 */
import type { DatabaseSync } from "node:sqlite";
import type { WorkerLease } from "../engine/engine-store.ts";

export type LeaseResult = { readonly ok: true } | { readonly ok: false; readonly holder: WorkerLease };

function ensure(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS worker_lease (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, pid INTEGER NOT NULL, renewed_wall INTEGER NOT NULL)");
}

function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Takes or renews the lease in one BEGIN IMMEDIATE transaction: refused while another owner holds it, renewed it within `staleMs`, and its process is alive. */
export function takeLeaseOn(db: DatabaseSync, owner: WorkerLease, now: number, staleMs: number, alive: (pid: number) => boolean): LeaseResult {
  ensure(db);
  return inTransaction(db, () => {
    const row = db.prepare("SELECT owner, pid, renewed_wall FROM worker_lease WHERE id = 1").get();
    const holder = row ? { id: String(row["owner"]), pid: Number(row["pid"]), renewedWall: Number(row["renewed_wall"]) } : null;
    if (holder && holder.id !== owner.id && now - holder.renewedWall <= staleMs && holder.pid !== owner.pid && alive(holder.pid)) return { ok: false as const, holder };
    db.prepare("INSERT INTO worker_lease (id, owner, pid, renewed_wall) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, pid = excluded.pid, renewed_wall = excluded.renewed_wall").run(owner.id, owner.pid, now);
    return { ok: true as const };
  });
}

export function releaseLeaseOn(db: DatabaseSync, ownerId: string): void {
  ensure(db);
  inTransaction(db, () => db.prepare("DELETE FROM worker_lease WHERE id = 1 AND owner = ?").run(ownerId));
}

/** The lease as `WorkerLeaseHolder` uses it, over a database opened but not yet migrated. */
export function leaseTable(db: DatabaseSync): { takeLease: (owner: WorkerLease, now: number, staleMs: number, alive: (pid: number) => boolean) => Promise<LeaseResult>; releaseLease: (ownerId: string) => Promise<void> } {
  return {
    takeLease: (owner, now, staleMs, alive) => Promise.resolve(takeLeaseOn(db, owner, now, staleMs, alive)),
    releaseLease: (ownerId) => Promise.resolve(releaseLeaseOn(db, ownerId)),
  };
}
