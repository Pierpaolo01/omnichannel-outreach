import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createApp } from "./app.ts";
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
const api = getRequestListener(createApp({ store, now: () => new Date().toISOString(), newId: randomUUID }).fetch);

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
    server.close();
    void store.close().finally(() => process.exit(0));
  });
}
