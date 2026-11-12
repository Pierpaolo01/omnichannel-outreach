/**
 * Seeds the development database with the fictitious fixtures, through the same HTTP interface
 * the app uses: two campaigns, the first imported twice (a later scraper run), the second once.
 *
 *   pnpm seed:dev            refuses to touch a database that already has campaigns
 *   pnpm seed:dev --reset    deletes the development database first
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/server/app.ts";
import { DATABASE_FILE, resolveDataDir } from "../src/server/config.ts";
import { openSqliteStore } from "../src/server/persistence/sqlite-store.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const dataDir = resolveDataDir({ env: process.env, home: os.homedir(), projectRoot, profile: "development" });
const dbPath = path.join(dataDir, DATABASE_FILE);

if (process.argv.includes("--reset")) {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
}
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const fresh = !existsSync(dbPath);
const store = openSqliteStore(dbPath);
if (!fresh && store.listCampaigns().length > 0) {
  console.error(`${dbPath} already has campaigns. Run with --reset to replace it with the fixtures.`);
  process.exit(1);
}

const app = createApp({ store, now: () => new Date().toISOString(), newId: randomUUID });
const fixture = (name: string) => readFileSync(path.join(projectRoot, "test/fixtures/scraper", name), "utf8");
const run = (n: 1 | 2) => ({ businessesCsv: fixture(`businesses-run${n}.csv`), peopleCsv: fixture(`people-run${n}.csv`) });

async function post(url: string, body: unknown): Promise<unknown> {
  const response = await app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: unknown = await response.json();
  if (!response.ok) throw new Error(`${url} failed: ${JSON.stringify(json)}`);
  return json;
}

function campaignId(response: unknown): string {
  if (typeof response === "object" && response !== null && "campaign" in response) {
    const { campaign } = response;
    if (typeof campaign === "object" && campaign !== null && "id" in campaign && typeof campaign.id === "string") {
      return campaign.id;
    }
  }
  throw new Error("unexpected campaign response");
}

function counts(response: unknown): unknown {
  return typeof response === "object" && response !== null && "import" in response ? response.import : response;
}

const physio = campaignId(await post("/api/campaigns", { name: "Physio clinics, London", defaultTimezone: "Europe/London" }));
const first = counts(await post(`/api/campaigns/${physio}/imports`, run(1)));
const second = counts(await post(`/api/campaigns/${physio}/imports`, run(2)));
const spring = campaignId(await post("/api/campaigns", { name: "Spring follow-up, London", defaultTimezone: "Europe/London" }));
const third = counts(await post(`/api/campaigns/${spring}/imports`, run(1)));

for (const [label, record] of [["Physio clinics, first import", first], ["Physio clinics, re-import", second], ["Spring follow-up, import", third]] as const) {
  const summary = typeof record === "object" && record !== null && "summary" in record ? record.summary : null;
  const total = typeof summary === "object" && summary !== null && "counts" in summary ? summary.counts : null;
  console.info(`${label}: ${JSON.stringify(total)}`);
}
console.info(`Seeded ${dbPath}`);
store.close();
