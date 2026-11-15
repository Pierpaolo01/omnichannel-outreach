import { describe, expect, test } from "vitest";
import { EDIT_MUTATIONS } from "./edit-mutations.ts";
import { editInvariantsOf, runEdits } from "./generated-edits.ts";
import { FULL_SEARCH, inShard } from "./sequence-chunks.ts";

/**
 * The generated edit runs (ticket 19; ADR 0003 "Ticket 19") in `pnpm check` and in the CI search (ADR 0003 9.2), as the
 * control runs are: `pnpm check` runs the fixed, behaviour-covering seeds and each mutation's known killing seed; the
 * search (`pnpm test:sequence-search`, the `sequence-search` workflow) runs all 100 seeds in shards and a seed search per
 * mutation that prints the seed killing each.
 */

export const EDIT_SEED = 19_000;
/** Offsets from EDIT_SEED, chosen greedily from a sweep of all 100 (15 November 2026) to reach every behaviour below, with each mutation's killing seed. */
// Re-chosen after the council on 93bed86 (zone and window edits, the read checked against the run): each mutation's
// killing seed, which between them reach every behaviour below.
export const EDIT_FIXED_SEEDS: readonly number[] = [0, 2, 6, 14, 23, 25, 31, 44, 290];
const SEARCH_SEEDS = 100;
const MAX_SEEDS = 30;
const RUN_WRITES = 10_000;

/** Every behaviour the fixed seeds must reach between them. A name leaves it only into RETIRED_EDIT_FEATURES, with its reason. */
export const EDIT_FEATURES: readonly string[] = [
  "a-copy-edit-while-that-step-is-with-the-provider",
  "a-follow-up-timed",
  "a-read-count-checked-step_added",
  "a-read-count-checked-step_removed",
  "a-read-count-checked-track_removed",
  "a-reply",
  "a-stale-skip-after-an-edit-refused",
  "a-step-added-ahead-of-a-lead",
  "a-step-added-behind-a-lead",
  "a-step-removed-after-a-lead-reached-it",
  "a-step-removed-while-with-the-provider",
  "a-track-reconnected-while-a-lead-waits-for-it",
  "a-track-removed",
  "a-track-start-timed",
  "an-edit-between-a-claim-and-its-handover",
  "an-edit-with-work-at-the-provider",
  "an-empty-email-in-a-removed-track-nobody-runs-saved",
  "campaign-paused",
  "campaign-resumed",
  "edit-add-step",
  "edit-add-step-while-paused",
  "edit-add-track-after-another",
  "edit-add-track-after-another-while-paused",
  "edit-add-track-at-launch",
  "edit-add-track-at-launch-while-paused",
  "edit-campaign-zone",
  "edit-campaign-zone-while-paused",
  "edit-copy",
  "edit-copy-while-paused",
  "edit-longer-wait",
  "edit-longer-wait-while-paused",
  "edit-reconnect",
  "edit-reconnect-while-paused",
  "edit-remove-step",
  "edit-remove-step-while-paused",
  "edit-remove-track",
  "edit-remove-track-while-paused",
  "edit-shorter-wait",
  "edit-shorter-wait-while-paused",
  "edit-window",
  "edit-window-while-paused",
  "late-sends",
  "refused-a-deleted-step",
  "refused-a-restored-step",
  "refused-an-empty-email-in-a-removed-track-a-lead-runs",
  "refused-empty-copy",
];
export const RETIRED_EDIT_FEATURES: Readonly<Record<string, string>> = {};

const known = (name: string) => EDIT_FEATURES.includes(name) || name in RETIRED_EDIT_FEATURES;
const reached = new Set<string>();

export function editChunks(): void {
  const offsets = FULL_SEARCH ? Array.from({ length: SEARCH_SEEDS }, (_, i) => i).filter(inShard) : EDIT_FIXED_SEEDS;
  describe(`generated edit runs keep the invariants of ticket 19 (${FULL_SEARCH ? "full search" : "fixed seeds"})`, () => {
    if (offsets.length === 0) test.skip("no seed of this run in this shard", () => undefined);
    for (let i = 0; i < offsets.length; i += 10) {
      const chunk = offsets.slice(i, i + 10);
      test(`seeds ${chunk.map((o) => EDIT_SEED + o).join(", ")}`, async () => {
        const failures: string[] = [];
        for (const offset of chunk) {
          const { problems, stats } = await runEdits(EDIT_SEED + offset);
          for (const f of stats.features) reached.add(f);
          if (problems.length > 0) failures.push(`seed ${EDIT_SEED + offset}: ${problems.join("; ")}`);
          const unknown = stats.features.filter((f) => !known(f));
          if (unknown.length > 0) failures.push(`seed ${EDIT_SEED + offset} reaches behaviours in neither list: ${unknown.join(", ")}`);
        }
        for (const failure of failures) console.error(failure);
        expect(failures).toEqual([]);
      }, 1_800_000);
    }
    if (!FULL_SEARCH) {
      test("the fixed seeds reach every behaviour they were chosen for", () => {
        expect(EDIT_FEATURES.filter((f) => !reached.has(f))).toEqual([]);
      });
    }
  });
}

/** Each broken edit must fail the invariant it names: on its known seed in `pnpm check`; in the search, on it or the first of MAX_SEEDS offsets. */
export function editOracle(): void {
  for (const [index, [name, mutation]] of Object.entries(EDIT_MUTATIONS).entries()) {
    const run = inShard(index) ? test : test.skip;
    run(`the generated edit runs fail ${mutation.invariant} for an engine with "${name}"`, async () => {
      const breaks = (problems: readonly string[]) => problems.some((p) => editInvariantsOf(p).includes(mutation.invariant));
      if (!FULL_SEARCH) {
        const { problems } = await runEdits(EDIT_SEED + mutation.seed, { ...mutation.options, rules: mutation.rules, maxWrites: RUN_WRITES });
        expect(breaks(problems), `seed ${EDIT_SEED + mutation.seed} no longer breaks ${mutation.invariant}; run the sequence-search workflow and update its seed. Problems: ${problems.join("; ")}`).toBe(true);
        return;
      }
      let caught: number | null = breaks((await runEdits(EDIT_SEED + mutation.seed, { ...mutation.options, rules: mutation.rules, maxWrites: RUN_WRITES })).problems) ? mutation.seed : null;
      for (let o = 0; o < MAX_SEEDS && caught === null; o++) if (breaks((await runEdits(EDIT_SEED + o, { ...mutation.options, rules: mutation.rules, maxWrites: RUN_WRITES })).problems)) caught = o;
      console.info(`killing seed: edit mutation "${name}" (${mutation.invariant}): ${caught ?? "none"}; recorded ${mutation.seed}`);
      expect(caught).not.toBeNull();
    }, 1_800_000);
  }
}
