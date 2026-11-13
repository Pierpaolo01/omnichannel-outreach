import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { runSequence } from "../../test/support/generated-imports.ts";
import { openSqliteStore } from "./persistence/sqlite-store.ts";
import type { OutreachStore } from "./persistence/store.ts";

/**
 * The generated-sequence checks must fail a store that deletes the row of a contact detail it
 * merges into another, as the store did before migration 4: a detail id, once issued, must keep
 * resolving (docs/adr/0001).
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A real store that, after every import, deletes the rows of details merged into others. */
function storeDeletingMergedRows(): { store: OutreachStore; deleted: () => number } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "outreach-merge-mutation-"));
  dirs.push(dir);
  const file = path.join(dir, "outreach.sqlite");
  const store = openSqliteStore(file);
  let deleted = 0;
  const importIntoCampaign = store.importIntoCampaign.bind(store);
  store.importIntoCampaign = async (input) => {
    const record = await importIntoCampaign(input);
    const db = new DatabaseSync(file);
    deleted += Number(db.prepare("DELETE FROM contact_details WHERE merged_into IS NOT NULL").run().changes);
    db.close();
    return record;
  };
  return { store, deleted: () => deleted };
}

// The generator merges only when a company first seen without a region later gets one while a
// person holds its line in international form, so every seed of the main test is run.
test("the generated-sequence checks fail a store that deletes a merged detail's row", async () => {
  const lost: string[] = [];
  let deleted = 0;
  for (let seed = 20261113; seed < 20261113 + 120; seed++) {
    const mutated = storeDeletingMergedRows();
    const { problems } = await runSequence(seed, { store: mutated.store });
    await mutated.store.close();
    deleted += mutated.deleted();
    lost.push(...problems.filter((p) => /resolves to nothing/.test(p)));
  }
  expect(deleted).toBeGreaterThan(0);
  expect(lost).not.toEqual([]);
}, 600_000);
