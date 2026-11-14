import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createApp } from "./app.ts";
import { Engine } from "./engine/engine.ts";
import { UnconnectedEmailPort, UnprovisionedSmsPort, type SendPort } from "./engine/ports.ts";
import { InstantlyClient } from "./instantly/client.ts";
import { instantlyRuntime } from "./instantly/config.ts";
import { InstantlyEmailPort } from "./instantly/port.ts";
import { DATABASE_FILE, resolveDataDir } from "./config.ts";
import { checkHost, isLoopbackAddress } from "./guard.ts";
import { leaseTable } from "./persistence/lease-table.ts";
import { openDatabase, openStoreOn } from "./persistence/sqlite-store.ts";
import { LEASE_RENEW_MS, processAlive, WorkerLeaseHolder } from "./worker-lease.ts";

/**
 * Runs the whole application locally: the HTTP interface under /api and the web client.
 * Development serves the client through Vite with hot reload; production serves the built dist/.
 */
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const production = process.env["NODE_ENV"] === "production";
const port = Number(process.env["OUTREACH_PORT"] ?? 4310);
const host = process.env["OUTREACH_HOST"] ?? "127.0.0.1";
if (!isLoopbackAddress(host)) {
  console.error(`OUTREACH_HOST=${host} is not a loopback address. The app only listens on this machine (127.0.0.1, ::1 or localhost).`);
  process.exit(1);
}

// Resolved before anything is opened: a data-folder variable set but empty is refused, never the default folder (ticket 20a).
let dataDir: string;
try {
  dataDir = resolveDataDir({
    env: process.env,
    home: os.homedir(),
    projectRoot,
    profile: production ? "app" : "development",
  });
} catch (error) {
  console.error(JSON.stringify({ level: "error", event: "data_dir_refused", message: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
}
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
// One worker per database (ADR 0003 "Ticket 20a"): a second application on this data directory is refused before it
// listens, so two processes never recover and send from one database at once; and before it migrates (council F), so a
// newer build started beside a running one changes nothing. The lease lives in a table of its own, needing no schema.
const database = openDatabase(path.join(dataDir, DATABASE_FILE));
const lease = new WorkerLeaseHolder(leaseTable(database), { id: randomUUID(), pid: process.pid, now: () => Date.now(), alive: processAlive });
const taken = await lease.take();
if (!taken.ok) {
  console.error(JSON.stringify({ level: "error", event: "worker_refused", message: taken.message }));
  database.close();
  process.exit(1);
}
const store = openStoreOn(database);
// Email goes through Instantly when a key is configured (ADR 0002); real writes stay off unless the
// run sets OUTREACH_INSTANTLY_WRITES=on. Without a key every email track meets launch blocker 3.
const readText = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};
const instantly = instantlyRuntime(process.env, readText);
const emailPort: SendPort = instantly
  ? new InstantlyEmailPort({
      client: new InstantlyClient({ apiKey: instantly.apiKey, fetch: (input, init) => fetch(input, init), writes: instantly.writes, now: () => Date.now() }),
      store: store.instantly,
      now: () => Date.now(),
      config: { resetZone: instantly.resetZone },
    })
  : new UnconnectedEmailPort();
console.info(JSON.stringify({ level: "info", event: "email_provider", provider: instantly ? "instantly" : "none", sending: instantly?.writes ? "on" : "off" }));
// No SMS provider is provisioned or chosen (#28): SMS has no connected sender, so SMS tracks cannot launch.
console.info(JSON.stringify({ level: "info", event: "sms_provider", provider: "none" }));
const engine = new Engine({ store: store.engine, port: emailPort, smsPort: new UnprovisionedSmsPort(), now: () => Date.now(), newId: randomUUID, leaseHeld: () => lease.heldAt(Date.now()) });
const api = getRequestListener(
  createApp({ store, now: () => new Date().toISOString(), newId: randomUUID, engine, emailProvider: emailPort instanceof InstantlyEmailPort ? emailPort : null }).fetch,
);

/** The worker: restart settlement once (ADR 0003 section 6), then a tick on an interval. */
const TICK_MS = 15_000;
let ticking: ReturnType<typeof setTimeout> | undefined;
let stopped = false;
/** Renews the lease; a worker another process took over from (it was suspended past the stale limit) stops. */
async function stillHeld(): Promise<boolean> {
  const held = await lease.renew().catch(() => false);
  if (!held) {
    console.error(JSON.stringify({ level: "error", event: "worker_lease_lost", message: "Another process took over this database's worker. This one stops." }));
    shutdown(1);
  }
  return held;
}
async function work(first: boolean): Promise<void> {
  // A tick renews the lease first (council E): a process that resumes after losing it never ticks.
  if (!(await stillHeld())) return;
  try {
    if (first) await engine.recover();
    else await engine.tick();
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "engine_tick_failed", message: error instanceof Error ? error.message : String(error) }));
  }
  if (!stopped) ticking = setTimeout(() => void work(false), TICK_MS);
}
// Set before the first tick: a shutdown on a lost lease may run before it would otherwise be.
const renewing = setInterval(() => void stillHeld(), LEASE_RENEW_MS);
void work(true);
// The lease is renewed on a timer of its own, so a slow tick never loses it. A worker whose lease another process took
// (this one was suspended past the stale limit) stops: two workers must not send from one database.

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function webHandler(): Promise<Handler> {
  if (!production) {
    const { createServer: createVite } = await import("vite");
    const vite = await createVite({ root: projectRoot, server: { middlewareMode: true }, appType: "spa" });
    return (req, res) => vite.middlewares(req, res);
  }
  const dist = path.relative(process.cwd(), path.join(projectRoot, "dist")) || ".";
  const web = new Hono();
  web.use("/assets/*", serveStatic({ root: dist }));
  web.get("*", serveStatic({ root: dist, path: "index.html" }));
  const listener = getRequestListener(web.fetch);
  return (req, res) => void listener(req, res);
}

const web = await webHandler();
const server = createServer((req, res) => {
  // The API checks its own requests; pages need the Host check too, against DNS rebinding.
  if (req.url === "/api" || req.url?.startsWith("/api/")) {
    void api(req, res);
    return;
  }
  const host = checkHost(req.headers.host ?? null);
  if (!host.ok) {
    res.writeHead(host.status, { "content-type": "text/plain; charset=utf-8" }).end(host.message);
    return;
  }
  web(req, res);
});

server.listen(port, host, () => {
  console.info(JSON.stringify({ level: "info", event: "listening", url: `http://${host}:${port}`, dataDir, production }));
});

function shutdown(code: number): void {
  stopped = true;
  clearTimeout(ticking);
  clearInterval(renewing);
  server.close();
  void lease
    .release()
    .catch(() => undefined)
    .finally(() => void store.close().finally(() => process.exit(code)));
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => shutdown(0));
