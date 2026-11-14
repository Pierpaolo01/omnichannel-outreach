import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { leaseTable } from "./persistence/lease-table.ts";
import { MIGRATIONS } from "./persistence/migrations.ts";
import { openDatabase, openSqliteStore, openStoreOn } from "./persistence/sqlite-store.ts";
import { LEASE_STALE_MS, WorkerLeaseHolder } from "./worker-lease.ts";

/**
 * One worker per database (ticket 20a; follow-up 42 item 15; ADR 0003 "Ticket 20a"): a second process is refused while
 * the first holds a live lease; a dead or stale holder is taken over. Two connections to one file stand for two
 * processes, each with a process id of its own.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function file(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lease-"));
  dirs.push(dir);
  return path.join(dir, "outreach.db");
}

const T0 = Date.parse("2026-11-02T09:00:00Z");

describe("one worker per database", () => {
  test("a second process is refused while the first's lease is live, and takes it once the first releases it", async () => {
    const db = file();
    let now = T0;
    const alive = new Set([101, 202]);
    const first = new WorkerLeaseHolder(openSqliteStore(db).engine, { id: "first", pid: 101, now: () => now, alive: (pid) => alive.has(pid) });
    const second = new WorkerLeaseHolder(openSqliteStore(db).engine, { id: "second", pid: 202, now: () => now, alive: (pid) => alive.has(pid) });
    expect(await first.take()).toEqual({ ok: true });
    const refused = await second.take();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toMatch(/Another process \(101\) is running the worker on this database/);
    now += 30_000;
    expect(await first.renew()).toBe(true);
    expect((await second.take()).ok).toBe(false);
    await first.release();
    expect(await second.take()).toEqual({ ok: true });
  });

  test("a crashed holder (its process gone) or a stale one is taken over, and the first learns it lost the lease", async () => {
    const db = file();
    let now = T0;
    const alive = new Set([101, 202]);
    const first = new WorkerLeaseHolder(openSqliteStore(db).engine, { id: "first", pid: 101, now: () => now, alive: (pid) => alive.has(pid) });
    const second = new WorkerLeaseHolder(openSqliteStore(db).engine, { id: "second", pid: 202, now: () => now, alive: (pid) => alive.has(pid) });
    expect((await first.take()).ok).toBe(true);
    alive.delete(101);
    expect(await second.take()).toEqual({ ok: true });
    alive.add(101);
    expect(await first.renew()).toBe(false);

    // Stale: not renewed for longer than LEASE_STALE_MS, though its process id is alive.
    const db2 = file();
    const a = new WorkerLeaseHolder(openSqliteStore(db2).engine, { id: "a", pid: 101, now: () => now, alive: () => true });
    const b = new WorkerLeaseHolder(openSqliteStore(db2).engine, { id: "b", pid: 202, now: () => now, alive: () => true });
    expect((await a.take()).ok).toBe(true);
    now += LEASE_STALE_MS;
    expect((await b.take()).ok).toBe(false);
    now += 1;
    expect((await b.take()).ok).toBe(true);
  });

  test("a lease that cannot be read is no lease", async () => {
    const db = file();
    const store = openSqliteStore(db).engine;
    await store.setMeta("worker_lease", "{not json");
    expect(await new WorkerLeaseHolder(store, { id: "x", pid: 303, now: () => T0, alive: () => true }).take()).toEqual({ ok: true });
  });

  test("a process suspended past the lease no longer holds it once another takes over (council E)", async () => {
    const db = file();
    let now = T0;
    const first = new WorkerLeaseHolder(openSqliteStore(db).engine, { id: "first", pid: 101, now: () => now, alive: () => true });
    const second = new WorkerLeaseHolder(openSqliteStore(db).engine, { id: "second", pid: 202, now: () => now, alive: () => true });
    expect((await first.take()).ok).toBe(true);
    expect(first.heldAt(now)).toBe(true);
    // The first is suspended: its clock jumps past the lease, and the second takes the stale lease meanwhile.
    now += LEASE_STALE_MS + 1;
    expect(first.heldAt(now)).toBe(false);
    expect((await second.take()).ok).toBe(true);
    expect(second.heldAt(now)).toBe(true);
    // The first resumes: its renewal is refused, and it still does not hold the lease.
    expect(await first.renew()).toBe(false);
    expect(first.heldAt(now)).toBe(false);
  });

  test("a newer build started beside a running one is refused before it migrates anything (council F)", async () => {
    const path = file();
    // The running build knows fifteen migrations and holds the lease.
    const runningDb = openDatabase(path);
    const running = new WorkerLeaseHolder(leaseTable(runningDb), { id: "running", pid: 101, now: () => T0, alive: (pid) => pid === 101 });
    expect((await running.take()).ok).toBe(true);
    openStoreOn(runningDb, MIGRATIONS.slice(0, 15));
    // The newer build opens the same file, is refused by the lease, and so never reaches its migrations.
    const newerDb = openDatabase(path);
    const newer = new WorkerLeaseHolder(leaseTable(newerDb), { id: "newer", pid: 202, now: () => T0 + 1000, alive: (pid) => pid === 101 });
    expect((await newer.take()).ok).toBe(false);
    newerDb.close();
    const check = new DatabaseSync(path);
    expect(Number(check.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.["v"])).toBe(15);
    check.close();
  });
});
