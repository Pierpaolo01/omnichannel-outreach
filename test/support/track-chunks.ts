import { appendFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { runTracks, trackInvariantsOf } from "./generated-tracks.ts";
import { FULL_SEARCH, inShard, SEED } from "./sequence-chunks.ts";
import { TRACK_MUTATIONS } from "./track-mutations.ts";

/**
 * The generated track runs (ticket 13) in `pnpm check` and in the CI search (ADR 0003 9.2).
 * `pnpm check` runs a fixed, rule-covering seed set and each mutation's known killing seed; the
 * search (`pnpm test:sequence-search`, the `sequence-search` workflow) runs all 100 seeds, in
 * shards, and a seed search per mutation that prints the seed killing each.
 */

/**
 * Offsets from SEED. Chosen greedily from a sweep of all 100 seeds so that together they reach
 * every behaviour the runs report (`stats.features`): every profile, both connection kinds, both
 * channels, several campaigns, a conversation taken and one held by an ended owner, invalid and
 * numbers invalid at the call or after a send, bounces, releases after a skip and after a failure, replies on both
 * channels, reported late, between a claim and its handover and during a text, a second worker's handovers, claims
 * withdrawn by the guard and by age, and all three endings. Refresh it when the generator changes.
 */
// 29 and 78 (seeds 20261142, 20261191): regressions for the Activity check's record at the instant a
// lead ends or a number goes bad (the search on 7401eb2, shards 6 and 7).
export const TRACK_FIXED_SEEDS: readonly number[] = [2, 3, 4, 29, 61, 78];
const SEARCH_SEEDS = 100;
/** Seed offsets each mutation's search tries after its recorded seed. */
const MAX_SEEDS = 30;
/** Every mutation replay stops after this many engine writes; an unmutated sweep needs under 3,000. */
const RUN_WRITES = 10_000;

function report(line: string): void {
  console.info(line);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary) appendFileSync(summary, `- ${line}\n`);
}

/** The generated track runs from `from` to `to` (offsets from SEED): all of them under the full search, otherwise the fixed seeds in that range. */
export function trackChunks(from: number, to: number): void {
  const offsets = FULL_SEARCH ? Array.from({ length: Math.min(to, SEARCH_SEEDS) - from }, (_, i) => from + i).filter(inShard) : TRACK_FIXED_SEEDS.filter((o) => o >= from && o < to);
  describe(`generated track runs keep the engine's invariants (${FULL_SEARCH ? "full search" : "fixed seeds"}, ${SEED + from} to ${SEED + to - 1})`, () => {
    if (offsets.length === 0) test.skip("no seed of this run in this range", () => undefined);
    for (let i = 0; i < offsets.length; i += 10) {
      const chunk = offsets.slice(i, i + 10);
      test(`seeds ${chunk.map((o) => SEED + o).join(", ")}`, async () => {
        const failures: string[] = [];
        for (const offset of chunk) {
          const { problems } = await runTracks(SEED + offset);
          if (problems.length > 0) failures.push(`seed ${SEED + offset}: ${problems.join("; ")}`);
        }
        for (const failure of failures) console.error(failure);
        expect(failures).toEqual([]);
      }, 1_800_000);
    }
  });
}

/**
 * Each broken engine must fail the invariant it names: in `pnpm check` on its known seed; in the
 * search on its known seed or the first of MAX_SEEDS offsets, which is printed.
 */
export function trackOracle(): void {
  const names = Object.keys(TRACK_MUTATIONS);
  for (const [index, name] of names.entries()) {
    const mutation = TRACK_MUTATIONS[name]!;
    const run = inShard(index) ? test : test.skip;
    run(`the generated track runs fail invariant ${mutation.invariant} for an engine with "${name}"`, async () => {
      const breaks = (problems: readonly string[]) => problems.some((p) => trackInvariantsOf(p).includes(mutation.invariant));
      if (!FULL_SEARCH) {
        const { problems } = await runTracks(SEED + mutation.seed, { rules: mutation.rules, maxWrites: RUN_WRITES });
        expect(problems.filter((p) => trackInvariantsOf(p).includes(mutation.invariant)), `seed ${SEED + mutation.seed} no longer breaks invariant ${mutation.invariant}; run the sequence-search workflow and update its seed. Problems: ${problems.join("; ")}`).not.toEqual([]);
        return;
      }
      let caught: string | null = null;
      if (breaks((await runTracks(SEED + mutation.seed, { rules: mutation.rules, maxWrites: RUN_WRITES })).problems)) caught = `recorded seed offset ${mutation.seed}`;
      else report(`recorded seed offset ${mutation.seed} no longer breaks invariant ${mutation.invariant} for track mutation "${name}"`);
      for (let i = 0; i < MAX_SEEDS && caught === null; i++) {
        if (breaks((await runTracks(SEED + i, { rules: mutation.rules, maxWrites: RUN_WRITES })).problems)) caught = `seed offset ${i}`;
      }
      report(`killing seed: track mutation "${name}" (invariant ${mutation.invariant}): ${caught ?? `none in offsets 0-${MAX_SEEDS - 1}`}; recorded seed ${mutation.seed}`);
      expect(caught, `no seed broke invariant ${mutation.invariant} for "${name}"`).not.toBeNull();
    }, 1_800_000);
  }
}
