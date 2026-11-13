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

/** A real store that runs `mutation` on its database after every import, counting the rows it changes. */
function storeMutatedAfterImports(mutation: string): { store: OutreachStore; changed: () => number } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "outreach-merge-mutation-"));
  dirs.push(dir);
  const file = path.join(dir, "outreach.sqlite");
  const store = openSqliteStore(file);
  let changed = 0;
  const importIntoCampaign = store.importIntoCampaign.bind(store);
  store.importIntoCampaign = async (input) => {
    const record = await importIntoCampaign(input);
    const db = new DatabaseSync(file);
    changed += Number(db.prepare(mutation).run().changes);
    db.close();
    return record;
  };
  return { store, changed: () => changed };
}

/** Runs every seed of the main test against the mutated store; returns the rows changed and the problems found. */
async function mutatedRuns(mutation: string, problem: RegExp): Promise<{ changed: number; found: string[] }> {
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
  const { changed, found } = await mutatedRuns("DELETE FROM contact_details WHERE merged_into IS NOT NULL", /resolves to nothing/);
  expect(changed).toBeGreaterThan(0);
  expect(found).not.toEqual([]);
}, 600_000);

test("the generated-sequence checks fail a store that points a merged detail at another live detail", async () => {
  const { changed, found } = await mutatedRuns(
    `UPDATE contact_details SET merged_into = (
       SELECT l.id FROM contact_details l WHERE l.merged_into IS NULL AND l.key <> contact_details.key ORDER BY l.id LIMIT 1)
     WHERE merged_into IS NOT NULL`,
    /resolves to another detail/,
  );
  expect(changed).toBeGreaterThan(0);
  expect(found).not.toEqual([]);
}, 600_000);
