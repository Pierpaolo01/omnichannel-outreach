import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { business, csvOf, person } from "../../../test/support/export-builder.ts";
import { sequentialIds } from "../../../test/support/domain.ts";
import { steppingClock } from "../../../test/support/http.ts";
import { createApp } from "../app.ts";
import { MIGRATIONS } from "./migrations.ts";
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

test("a database from before merged details were kept upgrades with every detail live and resolving to itself", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "outreach-store-"));
  dirs.push(dir);
  const file = path.join(dir, "outreach.sqlite");
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const m of MIGRATIONS.filter((m) => m.version <= 3)) {
    old.exec(m.sql);
    old.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(m.version, m.name, "2026-11-12T09:00:00.000Z");
  }
  old.exec(`
    INSERT INTO companies (id, name, search_name, category, website, domain, street, neighborhood, city, state_province, postal_code, country, source_row, created_at, updated_at)
      VALUES ('c1', 'Harbour Lane Physio', 'harbour lane physio', '', '', '', '', '', 'London', '', '', 'GB', '{}', '2026-11-12', '2026-11-12');
    INSERT INTO people (id, company_id, full_name, first_name, last_name, display_name, search_name, title, role_tier, linkedin_url, source_row, created_at, updated_at)
      VALUES ('p1', 'c1', 'Amira Hassan', 'Amira', 'Hassan', 'Amira Hassan', 'amira hassan', '', '', '', '{}', '2026-11-12', '2026-11-12');
    INSERT INTO row_identities VALUES ('person', 'p1', '[]');
    INSERT INTO contact_details (id, owner_kind, owner_id, channel, phone_kind, value, key, search_digits, bad, added_at)
      VALUES ('d1', 'person', 'p1', 'email', NULL, 'amira@harbour.example', 'amira@harbour.example', '', 1, '2026-11-12'),
             ('d2', 'company', 'c1', 'phone', 'main_line', '+442079460101', '+442079460101', '442079460101 02079460101', 0, '2026-11-12');
  `);
  old.close();

  const store = openSqliteStore(file);
  expect((await store.person("p1"))?.contactDetails.map((d) => [d.id, d.bad])).toEqual([["d1", true], ["d2", false]]);
  expect(await store.contactDetail("d1")).toMatchObject({ id: "d1", owner: { kind: "person", personId: "p1" }, bad: true });
  expect(await store.contactDetail("d2")).toMatchObject({ id: "d2", owner: { kind: "company", companyId: "c1" }, phoneKind: "main_line" });
  await store.close();
});

// Merges the import makes never chain more than a few links, but resolution has no hop limit.
test("a chain of any length resolves to the live detail at its end", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "outreach-store-"));
  dirs.push(dir);
  const file = path.join(dir, "outreach.sqlite");
  await openSqliteStoreClosed(file);
  const db = new DatabaseSync(file);
  const hops = 1_500;
  const insert = db.prepare(
    `INSERT INTO contact_details (id, owner_kind, owner_id, channel, phone_kind, value, key, search_digits, added_at, merged_into)
     VALUES (?, 'company', 'c1', 'phone', 'main_line', '020 7946 0188', ?, '', '2026-11-13', ?)`,
  );
  db.exec("BEGIN");
  for (let i = hops; i >= 0; i--) insert.run(`link-${i}`, `key-${i}`, i === hops ? null : `link-${i + 1}`);
  db.exec("COMMIT");
  db.close();
  const store = openSqliteStore(file);
  expect(await store.contactDetail("link-0")).toMatchObject({ id: `link-${hops}` });
  expect(await store.markContactDetailBad("link-0")).toBe(true);
  expect(await store.contactDetail(`link-${hops}`)).toMatchObject({ bad: true });
  await store.close();
});

async function openSqliteStoreClosed(file: string): Promise<void> {
  await openSqliteStore(file).close();
}
