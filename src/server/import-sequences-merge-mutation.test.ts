import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { runSequence } from "../../test/support/generated-imports.ts";
import { openSqliteStore } from "./persistence/sqlite-store.ts";
import type { OutreachStore } from "./persistence/store.ts";

/**
 * The generated-sequence checks must fail a store that loses track of merged contact details:
 * a detail id, once issued, must keep resolving to the detail it is (docs/adr/0001).
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A real store that runs `mutation`'s statements on its database after every import, counting the rows they change. */
function storeMutatedAfterImports(mutation: readonly string[]): { store: OutreachStore; changed: () => number } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "outreach-merge-mutation-"));
  dirs.push(dir);
  const file = path.join(dir, "outreach.sqlite");
  const store = openSqliteStore(file);
  let changed = 0;
  const importIntoCampaign = store.importIntoCampaign.bind(store);
  store.importIntoCampaign = async (input) => {
    const record = await importIntoCampaign(input);
    const db = new DatabaseSync(file);
    for (const statement of mutation) changed += Number(db.prepare(statement).run().changes);
    db.close();
    return record;
  };
  return { store, changed: () => changed };
}

/** Runs every seed of the main test against the mutated store; returns the rows changed and the problems found. */
async function mutatedRuns(mutation: readonly string[], problem: RegExp): Promise<{ changed: number; found: string[] }> {
  let changed = 0;
  const found: string[] = [];
  for (let seed = 20261113; seed < 20261113 + 120; seed++) {
    const mutated = storeMutatedAfterImports(mutation);
    const { problems } = await runSequence(seed, { store: mutated.store });
    await mutated.store.close();
    changed += mutated.changed();
    found.push(...problems.filter((p) => problem.test(p)));
  }
  return { changed, found };
}

// Only seeds whose sequences merge a detail are changed, so every seed of the main test is run.
test("the generated-sequence checks fail a store that deletes a merged detail's row", async () => {
  const { changed, found } = await mutatedRuns(["DELETE FROM contact_details WHERE merged_into IS NOT NULL"], /resolves to nothing/);
  expect(changed).toBeGreaterThan(0);
  expect(found).not.toEqual([]);
}, 600_000);

test("the generated-sequence checks fail a store that points a merged detail at another live detail", async () => {
  const { changed, found } = await mutatedRuns(
    [
      `UPDATE contact_details SET merged_into = (
         SELECT l.id FROM contact_details l WHERE l.merged_into IS NULL AND l.key <> contact_details.key ORDER BY l.id LIMIT 1)
       WHERE merged_into IS NOT NULL`,
    ],
    /resolves to another detail/,
  );
  expect(changed).toBeGreaterThan(0);
  expect(found).not.toEqual([]);
}, 600_000);

test("the generated-sequence checks fail a store that points a merged detail at the same number held by another company", async () => {
  const { changed, found } = await mutatedRuns(
    [
      // A copy of each merge target, the same number, on another company...
      `INSERT INTO contact_details (id, owner_kind, owner_id, channel, phone_kind, value, key, search_digits, bad, added_at)
       SELECT 'elsewhere-' || t.id, 'company', (SELECT c.id FROM companies c WHERE c.id <> t.owner_id ORDER BY c.id LIMIT 1),
         t.channel, t.phone_kind, t.value, t.key, t.search_digits, t.bad, t.added_at
       FROM contact_details t
       WHERE t.id IN (SELECT merged_into FROM contact_details) AND t.id NOT LIKE 'elsewhere-%'
         AND NOT EXISTS (SELECT 1 FROM contact_details e WHERE e.id = 'elsewhere-' || t.id)`,
      // ...and every merged row pointed at that copy.
      `UPDATE contact_details SET merged_into = 'elsewhere-' || merged_into
       WHERE merged_into IS NOT NULL AND merged_into NOT LIKE 'elsewhere-%'`,
    ],
    /resolves to a detail held by/,
  );
  expect(changed).toBeGreaterThan(0);
  expect(found).not.toEqual([]);
}, 600_000);
