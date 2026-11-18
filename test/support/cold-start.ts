/**
 * One application's start on a data folder, as `main.ts` does it up to the lease (ticket 20a, verifier on 2f7cd20): open
 * the database, take the worker's lease, and only then migrate. Prints one JSON line: `ok`, `refused`
 * with its message, or `error` with the message that stopped it. Run as a child process by `cold-start.test.ts`.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { leaseTable } from "../../src/server/persistence/lease-table.ts";
import { openDatabase, openStoreOn } from "../../src/server/persistence/sqlite-store.ts";
import { processAlive, WorkerLeaseHolder } from "../../src/server/worker-lease.ts";

const [dir, startAt] = process.argv.slice(2);
// Both children wait for the same instant, so their opens race.
while (Date.now() < Number(startAt)) {
  // spin
}
try {
  // As main.ts does it: the database opened, the lease taken, and only then the migrations.
  const db = openDatabase(path.join(dir ?? ".", "outreach.db"));
  const taken = await new WorkerLeaseHolder(leaseTable(db), { id: randomUUID(), pid: process.pid, now: () => Date.now(), alive: processAlive }).take();
  console.info(JSON.stringify(taken.ok ? { result: "ok" } : { result: "refused", message: taken.message }));
  if (!taken.ok) {
    db.close();
    process.exit(0);
  }
  const store = openStoreOn(db);
  // Hold the lease a moment, as a running application would.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await store.close();
} catch (error) {
  console.info(JSON.stringify({ result: "error", message: error instanceof Error ? error.message : String(error), stack: process.env["COLD_STACK"] && error instanceof Error ? error.stack : undefined }));
}
