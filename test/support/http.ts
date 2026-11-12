import { createApp } from "../../src/server/app.ts";
import { openSqliteStore } from "../../src/server/persistence/sqlite-store.ts";
import type { OutreachStore } from "../../src/server/persistence/store.ts";
import type { Campaign, ImportRecord } from "../../src/shared/api.ts";
import { scraperExport, type FixtureRun } from "./fixtures.ts";
import { sequentialIds } from "./domain.ts";

/** A clock that advances one minute per reading, so later imports are later. */
export function steppingClock(start = "2026-11-12T09:00:00.000Z"): () => string {
  let at = Date.parse(start);
  return () => {
    const reading = new Date(at).toISOString();
    at += 60_000;
    return reading;
  };
}

export interface TestApi {
  readonly store: OutreachStore;
  get<T>(path: string): Promise<{ status: number; body: T }>;
  post<T>(path: string, body: unknown): Promise<{ status: number; body: T }>;
  createCampaign(name: string, defaultTimezone?: string): Promise<Campaign>;
  importRun(campaignId: string, run: FixtureRun): Promise<ImportRecord>;
}

/** The real HTTP app over an in-memory SQLite store. */
export function testApi(): TestApi {
  const store = openSqliteStore(":memory:");
  const app = createApp({ store, now: steppingClock(), newId: sequentialIds() });

  const call = async <T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
    const response = await app.request(path, init);
    // Tests assert on the shape; the app's JSON is the thing under test.
    return { status: response.status, body: (await response.json()) as T };
  };
  const get = <T>(path: string) => call<T>(path);
  const post = <T>(path: string, body: unknown) =>
    call<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  return {
    store,
    get,
    post,
    async createCampaign(name, defaultTimezone) {
      const res = await post<{ campaign: Campaign }>("/api/campaigns", { name, ...(defaultTimezone ? { defaultTimezone } : {}) });
      if (res.status !== 201) throw new Error(`campaign not created: ${JSON.stringify(res.body)}`);
      return res.body.campaign;
    },
    async importRun(campaignId, run) {
      const res = await post<{ import: ImportRecord }>(`/api/campaigns/${campaignId}/imports`, scraperExport(run));
      if (res.status !== 201) throw new Error(`import failed: ${JSON.stringify(res.body)}`);
      return res.body.import;
    },
  };
}
