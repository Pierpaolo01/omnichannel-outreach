import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { controlInvariantsOf, runControls } from "./generated-controls.ts";
import { INTERRUPTION_MUTATIONS } from "./interruption-mutations.ts";
import { FULL_SEARCH, inShard } from "./sequence-chunks.ts";

/**
 * The control runs' interruption family (ticket 20a; ADR 0003 "Ticket 20a", the generated test) in `pnpm check` and in
 * the CI search, as the control runs are: `pnpm check` runs the fixed, behaviour-covering seeds and each mutation's known
 * killing seed; the search (`pnpm test:sequence-search`, the `sequence-search` workflow) runs all 100 seeds in shards and
 * a seed search per mutation that prints the seed killing each.
 */

export const INTERRUPTION_SEED = 20_000;
/** Offsets from INTERRUPTION_SEED, chosen from a sweep of all 100 (14 November 2026), cheapest first, to reach every behaviour below. */
export const INTERRUPTION_FIXED_SEEDS: readonly number[] = [11, 16, 19, 23, 27, 34, 40, 70, 88];
const SEARCH_SEEDS = 100;
const MAX_SEEDS = 30;
const RUN_WRITES = 10_000;

/** Every interruption behaviour the fixed seeds must reach between them. A name leaves it only into RETIRED_INTERRUPTION_FEATURES, with its reason. */
export const INTERRUPTION_FEATURES: readonly string[] = [
  "a-crash-during-recovery",
  "a-gap-below-the-threshold",
  "a-notice-with-none-rescheduled",
  "a-notice-with-sends-rescheduled",
  "a-observe-answer-held-across-midnight",
  "a-reply-during-an-outage",
  "app-stopped-across-a-rollover",
  "app-stopped-across-the-clock-change",
  "app-stopped-for-days",
  "app-stopped-for-hours",
  "app-stopped-for-minutes",
  "app-stopped-mid-after_call",
  "app-stopped-mid-after_claim",
  "app-stopped-mid-after_handover_commit",
  "app-stopped-mid-after_lookup",
  "app-stopped-mid-after_observe_event",
  "app-stopped-mid-after_presend",
  "app-stopped-mid-after_retry_commit",
  "app-stopped-while-paused",
  "app-stopped-with-work-unsettled",
  "providers-cut-off-across-a-rollover",
  "providers-cut-off-across-the-clock-change",
  "providers-cut-off-for-days",
  "providers-cut-off-for-hours",
  "providers-cut-off-for-minutes",
  "providers-cut-off-while-paused",
  "providers-cut-off-with-work-unsettled",
];

export const RETIRED_INTERRUPTION_FEATURES: Readonly<Record<string, string>> = {
  "a-lookup-answer-held-across-midnight":
    "A name the generator can form that none of the 100 seeds reached in the sweep of 14 November 2026: no lookup fell due in the tick held across midnight. The held observation reaches the same rule (`answerInstant`); not required of the fixed seeds.",
};

/** The names of this family: everything the interruption events add. Other names the runs reach belong to the control runs' lists. */
const OURS = /^(app-stopped|providers-cut-off|a-notice|a-gap|a-crash-during|a-(observe|lookup)-answer|a-reply-during-an-outage)/;
/** Whether a behaviour name is the interruption family's: the control runs' own lists leave these to this file's. */
export const isInterruptionFeature = (name: string): boolean => OURS.test(name);
const known = (name: string) => INTERRUPTION_FEATURES.includes(name) || name in RETIRED_INTERRUPTION_FEATURES;
const reached = new Set<string>();

export function interruptionChunks(): void {
  const offsets = FULL_SEARCH ? Array.from({ length: SEARCH_SEEDS }, (_, i) => i).filter(inShard) : INTERRUPTION_FIXED_SEEDS;
  describe(`generated runs with interruptions keep the invariants of ticket 20a (${FULL_SEARCH ? "full search" : "fixed seeds"})`, () => {
    if (offsets.length === 0) test.skip("no seed of this run in this shard", () => undefined);
    for (let i = 0; i < offsets.length; i += 5) {
      const chunk = offsets.slice(i, i + 5);
      test(`seeds ${chunk.map((o) => INTERRUPTION_SEED + o).join(", ")}`, async () => {
        const failures: string[] = [];
        for (const offset of chunk) {
          const { problems, stats } = await runControls(INTERRUPTION_SEED + offset, { interruptions: true });
          const ours = stats.features.filter((f) => OURS.test(f));
          for (const f of ours) reached.add(f);
          if (problems.length > 0) failures.push(`seed ${INTERRUPTION_SEED + offset}: ${problems.join("; ")}`);
          const unknown = ours.filter((f) => !known(f));
          if (unknown.length > 0) failures.push(`seed ${INTERRUPTION_SEED + offset} reaches behaviours in neither list: ${unknown.join(", ")}`);
        }
        for (const failure of failures) console.error(failure);
        expect(failures).toEqual([]);
      }, 1_800_000);
    }
    if (!FULL_SEARCH) {
      test("the fixed seeds reach every behaviour they were chosen for", () => {
        expect(INTERRUPTION_FEATURES.filter((f) => !reached.has(f))).toEqual([]);
      });
      test("every literal interruption behaviour name in the generator is listed or retired", () => {
        const source = readFileSync(new URL("./generated-controls.ts", import.meta.url), "utf8");
        const literals = [...source.matchAll(/features\.add\("([^"]+)"\)/g)].map((m) => m[1] ?? "").filter((name) => OURS.test(name));
        expect(literals.filter((name) => !known(name))).toEqual([]);
      });
    }
  });
}

/** Each broken recovery must fail the invariant it names: on its known seed in `pnpm check`; in the search, on it or the first of MAX_SEEDS offsets. */
export function interruptionOracle(): void {
  for (const [index, [name, mutation]] of Object.entries(INTERRUPTION_MUTATIONS).entries()) {
    const run = inShard(index) ? test : test.skip;
    run(`the generated runs with interruptions fail ${mutation.invariant} for an engine with "${name}"`, async () => {
      const breaks = (problems: readonly string[]) => problems.some((p) => controlInvariantsOf(p).includes(mutation.invariant));
      const options = { ...mutation.options, interruptions: true, rules: mutation.rules, maxWrites: RUN_WRITES };
      if (!FULL_SEARCH) {
        const { problems } = await runControls(INTERRUPTION_SEED + mutation.seed, options);
        expect(breaks(problems), `seed ${INTERRUPTION_SEED + mutation.seed} no longer breaks ${mutation.invariant}; run the sequence-search workflow and update its seed. Problems: ${problems.join("; ")}`).toBe(true);
        return;
      }
      let caught: number | null = breaks((await runControls(INTERRUPTION_SEED + mutation.seed, options)).problems) ? mutation.seed : null;
      for (let o = 0; o < MAX_SEEDS && caught === null; o++) if (breaks((await runControls(INTERRUPTION_SEED + o, options)).problems)) caught = o;
      console.info(`killing seed: interruption mutation "${name}" (${mutation.invariant}): ${caught ?? "none"}; recorded ${mutation.seed}`);
      expect(caught).not.toBeNull();
    }, 1_800_000);
  }
}
