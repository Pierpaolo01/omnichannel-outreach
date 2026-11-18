import { describe, expect, test } from "vitest";
import { runTestRuns, testRunInvariantOf } from "./generated-test-runs.ts";
import { FULL_SEARCH, inShard } from "./sequence-chunks.ts";
import { TEST_RUN_MUTATIONS } from "./test-run-mutations.ts";

/**
 * The generated test runs (ticket 21; ADR 0003 "Ticket 21", the generated test) in `pnpm check` and in the CI search, as
 * the other generators are: `pnpm check` runs the fixed, behaviour-covering seeds and each mutation's known killing seed;
 * the search (`pnpm test:sequence-search`, the `sequence-search` workflow) runs all 100 seeds in shards and a seed search
 * per mutation that prints the seed killing each.
 */

export const TEST_RUN_SEED = 21_000;
/** Offsets from TEST_RUN_SEED, re-chosen from a sweep of all 100 after the call stream (review bot on 55d6ac6), to reach every behaviour below, and each mutation's killing seed. */
// 25 (question Q7 answered, after the reviews of bebdc06): a test skips its text for another campaign's test's
// conversation, and that conversation is released between a test's evaluation and its write.
export const TEST_RUN_FIXED_SEEDS: readonly number[] = [0, 1, 2, 7, 8, 10, 25, 59];
const SEARCH_SEEDS = 100;
const MAX_SEEDS = 30;
const RUN_WRITES = 10_000;

/** Every behaviour the fixed seeds must reach between them. A name leaves it only into RETIRED_TEST_RUN_FEATURES, with its reason. */
export const TEST_RUN_FEATURES: readonly string[] = [
  "a-campaign-pause",
  "a-conversation-released-during-a-write",
  "a-test-skips-its-text-for-another-test-s-conversation",
  "another-campaign-test-runs",
  "another-campaign-tests-on-the-same-mobile",
  "a-lead-reply",
  "a-lead-s-email-refused-as-a-test-contact",
  "a-test-after-another-ended",
  "a-test-before-launch",
  "a-test-call-carried-while-paused",
  "a-test-call-interested",
  "a-test-call-no-answer",
  "a-test-call-not-interested-continue",
  "a-test-call-not-interested-stop",
  "a-test-call-not-interested-win-back",
  "a-test-email-reply",
  "a-test-in-win-back",
  "a-test-on-a-paused-campaign",
  "a-test-on-a-running-campaign",
  "a-test-reply",
  "a-test-text",
  "an-edit-during-a-test",
  "launch-after-a-test",
  "launch-with-the-warning",
  "run-test-refused-while-one-runs",
  "stop-test",
  "tests-and-leads-share-senders",
];

export const RETIRED_TEST_RUN_FEATURES: Readonly<Record<string, string>> = {};

const known = (name: string) => TEST_RUN_FEATURES.includes(name) || name in RETIRED_TEST_RUN_FEATURES;
const reached = new Set<string>();

export function testRunChunks(): void {
  const offsets = FULL_SEARCH ? Array.from({ length: SEARCH_SEEDS }, (_, i) => i).filter(inShard) : TEST_RUN_FIXED_SEEDS;
  describe(`generated test runs keep the invariants of ticket 21 (${FULL_SEARCH ? "full search" : "fixed seeds"})`, () => {
    if (offsets.length === 0) test.skip("no seed of this run in this shard", () => undefined);
    for (let i = 0; i < offsets.length; i += 5) {
      const chunk = offsets.slice(i, i + 5);
      test(`seeds ${chunk.map((o) => TEST_RUN_SEED + o).join(", ")}`, async () => {
        const failures: string[] = [];
        for (const offset of chunk) {
          const { problems, stats } = await runTestRuns(TEST_RUN_SEED + offset);
          for (const f of stats.features) reached.add(f);
          if (problems.length > 0) failures.push(`seed ${TEST_RUN_SEED + offset}: ${problems.join("; ")}`);
          const unknown = stats.features.filter((f) => !known(f));
          if (unknown.length > 0) failures.push(`seed ${TEST_RUN_SEED + offset} reaches behaviours in neither list: ${unknown.join(", ")}`);
        }
        for (const failure of failures) console.error(failure);
        expect(failures).toEqual([]);
      }, 1_800_000);
    }
    if (!FULL_SEARCH) {
      test("the fixed seeds reach every behaviour they were chosen for", () => {
        expect(TEST_RUN_FEATURES.filter((f) => !reached.has(f))).toEqual([]);
      });
    }
  });
}

/** Each broken test run must fail the invariant it names: on its known seed in `pnpm check`; in the search, on it or the first of MAX_SEEDS offsets. */
export function testRunOracle(): void {
  for (const [index, [name, mutation]] of Object.entries(TEST_RUN_MUTATIONS).entries()) {
    const run = inShard(index) ? test : test.skip;
    run(`the generated test runs fail ${mutation.invariant} for an engine with "${name}"`, async () => {
      const breaks = (problems: readonly string[]) => problems.some((p) => testRunInvariantOf(p) === mutation.invariant);
      const options = { ...mutation, maxWrites: RUN_WRITES };
      if (!FULL_SEARCH) {
        const { problems } = await runTestRuns(TEST_RUN_SEED + mutation.seed, options);
        expect(breaks(problems), `seed ${TEST_RUN_SEED + mutation.seed} no longer breaks ${mutation.invariant}; run the sequence-search workflow and update its seed. Problems: ${problems.join("; ")}`).toBe(true);
        return;
      }
      let caught: number | null = breaks((await runTestRuns(TEST_RUN_SEED + mutation.seed, options)).problems) ? mutation.seed : null;
      for (let o = 0; o < MAX_SEEDS && caught === null; o++) if (breaks((await runTestRuns(TEST_RUN_SEED + o, options)).problems)) caught = o;
      console.info(`killing seed: test-run mutation "${name}" (${mutation.invariant}): ${caught ?? "none"}; recorded ${mutation.seed}`);
      expect(caught).not.toBeNull();
    }, 1_800_000);
  }
}
