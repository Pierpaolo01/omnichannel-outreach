import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { CallAnswer } from "../src/domain/sequence/attempt.ts";
import type { AccountStatus, AttemptRef, HandoverRequest, LookupResult, PresendRequest, ProviderEvent, Transport } from "../src/server/engine/ports.ts";
import { EngineHarness, type Provider } from "../test/support/engine-harness.ts";

/**
 * Ticket 23, item 13: the application as its own process, for the interruption proof in e2e/acceptance-proofs.spec.ts.
 * It runs the real HTTP app, SQLite store and engine on the database file it is given; the email provider is the test's
 * fake, which lives in the test's process and answers over HTTP, so the provider carries on while this process is gone.
 * The test drives the clock: each tick comes from the test with its instant. With CRASH_AT_EMAIL_HANDOVER=n the process
 * exits at once (process.exit, no clean-up) when the engine reaches `after_call` on its n-th email handover: the provider
 * has accepted the send and the application has not yet recorded that it did.
 *
 * Environment: ACCEPTANCE_DB (a database file inside the system temporary folder; required), ACCEPTANCE_PROVIDER (the
 * test's provider URL), ACCEPTANCE_START (the clock), ACCEPTANCE_RESTART=1 for a process started after a stop (it runs
 * restart settlement first), ACCEPTANCE_IDS (the engine's id prefix), CRASH_AT_EMAIL_HANDOVER.
 */

const db = process.env["ACCEPTANCE_DB"] ?? "";
// Never a data folder from a variable a failed step could leave unset: refuse anything but a file in the temp folder.
if (db === "" || !db.startsWith(os.tmpdir()) || !existsSync(path.dirname(db))) {
  console.error("ACCEPTANCE_DB must name a file in an existing folder inside the system temporary folder");
  process.exit(2);
}
const providerUrl = process.env["ACCEPTANCE_PROVIDER"] ?? "";
const crashAt = Number(process.env["CRASH_AT_EMAIL_HANDOVER"] ?? 0);
let emailHandovers = 0;

async function call<T>(method: string, args: unknown[]): Promise<T> {
  const res = await fetch(`${providerUrl}/port/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
  const body = (await res.json()) as { ok: true; value: T } | { ok: false; error: string };
  if (!body.ok) throw new Error(body.error);
  return body.value;
}

/** The test's fake email provider, reached over HTTP. The test advances it before each tick; here advance does nothing. */
const port: Provider = {
  channel: "email",
  transportFor: (step): Transport => ({ retryable: step.threading === "new_subject", notSentIsFinal: false }),
  accounts: () => call<AccountStatus[]>("accounts", []),
  presendCheck: (request: PresendRequest) => call("presendCheck", [request]),
  handover: async (request: HandoverRequest) => {
    emailHandovers++;
    const answer: CallAnswer = await call<CallAnswer>("handover", [request]);
    return answer;
  },
  withdraw: (attempt: AttemptRef) => call("withdraw", [attempt]),
  observe: (checkpoint: string | null) => call<{ events: ProviderEvent[]; checkpoint: string }>("observe", [checkpoint]),
  lookup: (attempt: AttemptRef) => call<LookupResult>("lookup", [attempt]),
  advance: () => undefined,
  nextActivityAt: () => null,
};

const harness = new EngineHarness({
  start: Number(process.env["ACCEPTANCE_START"]),
  accounts: [],
  databasePath: db,
  idPrefix: process.env["ACCEPTANCE_IDS"] ?? "att",
  port,
  hooks: {
    crashPoint: (point) => {
      // The process dies here, as with a power cut: nothing after this line of the engine runs, nothing is flushed.
      if (crashAt > 0 && point === "after_call" && emailHandovers === crashAt) process.exit(70);
    },
  },
});

if (process.env["ACCEPTANCE_RESTART"] === "1") {
  // As a process starting after a stop: the heartbeat is where the last process left it, and restart settlement runs.
  harness.stopMarkingAlive();
  await harness.restart();
}

const web = new Hono();
web.post("/control/tick", async (c) => {
  const { clock } = await c.req.json<{ clock: number }>();
  harness.clock = clock;
  await harness.tick();
  return c.json({ nextWake: await harness.engine.nextWakeAt() });
});
web.all("/api/*", (c) => harness.fetch(c.req.raw));
web.use("/assets/*", serveStatic({ root: "dist" }));
web.get("*", serveStatic({ root: "dist", path: "index.html" }));
serve({ fetch: web.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => console.info(`listening ${info.port}`));
