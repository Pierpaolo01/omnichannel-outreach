import { describe, expect, test } from "vitest";
import { BULK_MUTATIONS } from "./bulk-mutations.ts";
import { bulkInvariantsOf, runBulk } from "./generated-bulk.ts";
import { FULL_SEARCH, inShard } from "./sequence-chunks.ts";

/**
 * The generated bulk runs (ticket 18) in `pnpm check` and in the CI search (ADR 0003 9.2), as the control runs are:
 * `pnpm check` runs the fixed, behaviour-covering seeds and each mutation's known killing seed; the search
 * (`pnpm test:sequence-search`, the `sequence-search` workflow) runs all 100 seeds in shards and a seed search per
 * mutation that prints the seed killing each.
 */

export const BULK_SEED = 18_000;
/**
 * Offsets from BULK_SEED, chosen from a sweep of all 100 (14 November 2026; every one passed) to reach every behaviour
 * below between them, with the mutations' killing seeds.
 */
export const BULK_FIXED_SEEDS: readonly number[] = [0, 2, 4, 5, 6, 8, 17];
const SEARCH_SEEDS = 100;
const MAX_SEEDS = 40;

/** Every behaviour the fixed seeds must reach between them. */
export const BULK_FEATURES: readonly string[] = [
  // Verifier F2 on 4363270: a selected row joins a confirmation's scope before its press (seed 2 among the fixed seeds).
  "a-lead-joined-the-scope-before-the-press",
  "add-already-enrolled",
  "add-confirmation",
  "add-enrolled",
  "add-no-usable-channel",
  "add-replayed",
  "changed-between-confirmation-and-press",
  "item-refused-at-the-press",
  "lead-put-back-before-a-resend",
  "lost-after-arrival",
  "lost-before-arrival",
  "press-sent-again",
  "preview-with-refusals",
  "resent-after-a-reload",
  "resent-by-the-other-tab",
  "scope-every-campaign",
  "scope-one-campaign",
  "two-tabs-one-read",
];

const reached = new Set<string>();

export function bulkChunks(): void {
  const offsets = FULL_SEARCH ? Array.from({ length: SEARCH_SEEDS }, (_, i) => i).filter(inShard) : BULK_FIXED_SEEDS;
  describe(`generated bulk runs keep the invariants of ticket 18 (${FULL_SEARCH ? "full search" : "fixed seeds"})`, () => {
    if (offsets.length === 0) test.skip("no seed of this run in this shard", () => undefined);
    for (let i = 0; i < offsets.length; i += 10) {
      const chunk = offsets.slice(i, i + 10);
      test(`seeds ${chunk.map((o) => BULK_SEED + o).join(", ")}`, async () => {
        const failures: string[] = [];
        for (const offset of chunk) {
          const { problems, stats } = await runBulk(BULK_SEED + offset);
          for (const f of stats.features) reached.add(f);
          if (problems.length > 0) failures.push(`seed ${BULK_SEED + offset}: ${problems.join("; ")}`);
        }
        for (const failure of failures) console.error(failure);
        expect(failures).toEqual([]);
      }, 1_800_000);
    }
    if (!FULL_SEARCH) {
      test("the fixed seeds reach every behaviour they were chosen for", () => {
        expect(BULK_FEATURES.filter((f) => !reached.has(f))).toEqual([]);
      });
    }
  });
}

export function bulkOracle(): void {
  for (const [index, [name, mutation]] of Object.entries(BULK_MUTATIONS).entries()) {
    const run = inShard(index) ? test : test.skip;
    run(`the generated bulk runs fail ${mutation.invariant} for an app with "${name}"`, async () => {
      const breaks = (problems: readonly string[]) => problems.some((p) => bulkInvariantsOf(p).includes(mutation.invariant));
      if (!FULL_SEARCH) {
        const { problems } = await runBulk(BULK_SEED + mutation.seed, { bulkRules: mutation.rules });
        expect(breaks(problems), `seed ${BULK_SEED + mutation.seed} no longer breaks ${mutation.invariant}; run the sequence-search workflow and update its seed. Problems: ${problems.join("; ")}`).toBe(true);
        return;
      }
      let caught: number | null = breaks((await runBulk(BULK_SEED + mutation.seed, { bulkRules: mutation.rules })).problems) ? mutation.seed : null;
      for (let o = 0; o < MAX_SEEDS && caught === null; o++) if (breaks((await runBulk(BULK_SEED + o, { bulkRules: mutation.rules })).problems)) caught = o;
      console.info(`killing seed: bulk mutation "${name}" (${mutation.invariant}): ${caught ?? "none"}; recorded ${mutation.seed}`);
      expect(caught).not.toBeNull();
    }, 1_800_000);
  }
}
