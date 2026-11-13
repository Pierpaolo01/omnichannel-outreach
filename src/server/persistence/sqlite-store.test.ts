import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { business, csvOf, person } from "../../../test/support/export-builder.ts";
import { sequentialIds } from "../../../test/support/domain.ts";
import { steppingClock } from "../../../test/support/http.ts";
import { createApp } from "../app.ts";
import { openSqliteStore } from "./sqlite-store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fileStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "outreach-store-"));
  dirs.push(dir);
  const file = path.join(dir, "outreach.sqlite");
  const store = openSqliteStore(file);
  const app = createApp({ store, now: steppingClock(), newId: sequentialIds() });
  const post = async (url: string, body: unknown) =>
    app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { file, store, post };
}

const rows = csvOf({
  businesses: [business({ business_id: "b1", place_id: "P1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })],
  people: [person({ person_id: "p1", business_id: "b1", full_name: "Amira Hassan", email: "amira@harbour.example" })],
});

test("importing the same files again does not touch the records' modification times", async () => {
  const { file, store, post } = fileStore();
  const created = (await (await post("/api/campaigns", { name: "Physio" })).json()) as { campaign: { id: string } };
  await post(`/api/campaigns/${created.campaign.id}/imports`, rows);
  const stamps = () => {
    const db = new DatabaseSync(file, { readOnly: true });
    const read = db.prepare("SELECT id, updated_at FROM companies UNION ALL SELECT id, updated_at FROM people ORDER BY id").all();
    db.close();
    return read;
  };
  const before = stamps();
  expect((await post(`/api/campaigns/${created.campaign.id}/imports`, rows)).status).toBe(201);
  expect(stamps()).toEqual(before);
  await store.close();
});

test("a database holding people from before migration 2 refuses to import and says why", async () => {
  const { file, store, post } = fileStore();
  const created = (await (await post("/api/campaigns", { name: "Physio" })).json()) as { campaign: { id: string } };
  await post(`/api/campaigns/${created.campaign.id}/imports`, rows);
  const db = new DatabaseSync(file);
  db.exec("DELETE FROM row_identities");
  db.close();
  const res = await post(`/api/campaigns/${created.campaign.id}/imports`, rows);
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/created before imports remembered/);
  await store.close();
});
