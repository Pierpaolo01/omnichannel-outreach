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
import { Worker } from "./worker.ts";
import { Engine } from "./engine/engine.ts";
import { UnconnectedEmailPort, UnprovisionedSmsPort, type SendPort } from "./engine/ports.ts";
import { InstantlyClient } from "./instantly/client.ts";
import { instantlyRuntime } from "./instantly/config.ts";
import { InstantlyEmailPort } from "./instantly/port.ts";
import { DATABASE_FILE, resolveDataDir } from "./config.ts";
import { checkHost, isLoopbackAddress } from "./guard.ts";
import { openSqliteStore } from "./persistence/sqlite-store.ts";

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

const dataDir = resolveDataDir({
  env: process.env,
  home: os.homedir(),
  projectRoot,
  profile: production ? "app" : "development",
});
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const store = openSqliteStore(path.join(dataDir, DATABASE_FILE));
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
const engine = new Engine({ store: store.engine, port: emailPort, smsPort: new UnprovisionedSmsPort(), now: () => Date.now(), newId: randomUUID });
const worker = new Worker({
  recover: () => engine.recover(),
  tick: () => engine.tick(),
  now: () => Date.now(),
  setTimer: (fire, ms) => {
    const t = setTimeout(fire, ms);
    return () => clearTimeout(t);
  },
  onError: (error) => console.error(JSON.stringify({ level: "error", event: "engine_tick_failed", message: error instanceof Error ? error.message : String(error) })),
});
const api = getRequestListener(
  createApp({ store, now: () => new Date().toISOString(), newId: randomUUID, engine, worker, emailProvider: emailPort instanceof InstantlyEmailPort ? emailPort : null }).fetch,
);

// The worker: restart settlement once, then a tick every 15 seconds (src/server/worker.ts).
worker.start();

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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    worker.stop();
    server.close();
    void store.close().finally(() => process.exit(0));
  });
}
