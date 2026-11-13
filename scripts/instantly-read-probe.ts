/**
 * A read-only probe of the real Instantly workspace through the adapter, with writes off. It sends
 * GET requests only: a fetch wrapper refuses every other method before it leaves the machine. It
 * prints aggregate counts and the names of documented fields present, never an address, a name, a
 * subject or a body.
 *
 *   OUTREACH_RUNTIME_ENV=~/.config/omnichannel-outreach/runtime.env \
 *     node --import ./src/server/quiet-sqlite-warning.ts scripts/instantly-read-probe.ts
 */
import { readFileSync } from "node:fs";
import type { InstantlyEmail, Page } from "../src/server/instantly/api.ts";
import { InstantlyClient, type Fetch } from "../src/server/instantly/client.ts";
import { instantlyRuntime } from "../src/server/instantly/config.ts";
import { InstantlyEmailPort } from "../src/server/instantly/port.ts";
import { openSqliteStore } from "../src/server/persistence/sqlite-store.ts";

const runtime = instantlyRuntime(process.env, (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
});
if (!runtime) {
  console.error("No Instantly key: set OUTREACH_RUNTIME_ENV to the credentials file.");
  process.exit(1);
}

const requests: string[] = [];
const getOnly: Fetch = (input, init) => {
  const method = init?.method ?? "GET";
  const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
  requests.push(`${method} ${path}`);
  if (method !== "GET") return Promise.reject(new Error(`the probe refuses ${method} ${path}`));
  return fetch(input, init);
};

const now = () => Date.now();
const store = openSqliteStore(":memory:");
const client = new InstantlyClient({ apiKey: runtime.apiKey, fetch: getOnly, writes: false, now });
const port = new InstantlyEmailPort({ client, store: store.instantly, now, config: { resetZone: runtime.resetZone } });

const observed = await port.observe(null);
const accounts = await port.accounts();
const status = port.status();
const count = <T>(items: readonly T[], key: (t: T) => string) => Object.fromEntries([...new Set(items.map(key))].sort().map((k) => [k, items.filter((t) => key(t) === k).length]));

console.info(`Instantly read-only probe, ${new Date().toISOString().slice(0, 10)}`);
console.info(`  sending: ${status.sending}; follow-ups: ${status.followUps}; quota: ${status.quota}; polled: ${status.lastPolledAt === null ? "no" : "yes"}`);
console.info(`  sender inboxes read: ${accounts.length}`);
console.info(`  by Instantly status: ${JSON.stringify(count(status.inboxes, (i) => String(i.status)))}`);
console.info(`  with a daily limit: ${status.inboxes.filter((i) => (i.dailyLimit ?? 0) > 0).length}; healthy for sending: ${accounts.filter((a) => a.healthy).length}`);
console.info(`  hold reasons: ${JSON.stringify(count(status.inboxes, (i) => i.reason ?? "none"))}`);
console.info(`  events reported with nothing dispatched: ${observed.events.length}`);

// The documented Email fields the poller relies on, checked on one page of the workspace's mail.
const page = await client.get<Page<InstantlyEmail>>("/api/v2/emails", { limit: 10, sort_order: "desc", preview_only: true });
if (page.ok) {
  const fields = ["id", "timestamp_created", "timestamp_email", "from_address_email", "campaign_id", "lead", "lead_id", "eaccount", "ue_type", "thread_id"] as const;
  const present = fields.map((f) => `${f}=${page.body.items.filter((e) => e[f] !== undefined).length}/${page.body.items.length}`);
  console.info(`  GET /emails field presence: ${present.join(" ")}`);
  console.info(`  GET /emails ue_type counts: ${JSON.stringify(count(page.body.items, (e) => String(e.ue_type)))}`);
} else {
  console.info(`  GET /emails: ${String(page.status)}`);
}
console.info(`  requests made: ${JSON.stringify(count(requests, (r) => r))}`);
await store.close();
