import { expect, test } from "vitest";
import type { Rules } from "../../src/server/engine/rules.ts";
import { MUTATIONS } from "./engine-mutations.ts";
import * as REGRESSIONS from "./regressions.ts";
import { invariantsOf, runSequence } from "./generated-sequences.ts";
import { appendFileSync } from "node:fs";
import { FULL_SEARCH, inShard, SEED } from "./sequence-chunks.ts";

const MAX_SEEDS = 60;
/** The seed search per mutation stops trying new seeds after this, well inside the test's 30 minutes. */
const SEARCH_BUDGET_MS = 6 * 60_000;
/** A single run a broken engine makes pathological stops this long after the budget. */
const RUN_GRACE_MS = 3 * 60_000;
/** `pnpm check` allows a mutation's recorded seed this long to kill it. */
const CHECK_SEED_MS = 30_000;

/** One line per mutation in the search's log and, in CI, the job summary: the seed that kills it, or none. */
function report(line: string): void {
  console.info(line);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary) appendFileSync(summary, `- ${line}\n`);
}

/** Runs the mutation's named regression with its broken rules: it must fail. */
async function regressionFails(name: string, mutation: (typeof MUTATIONS)[string]): Promise<boolean> {
  if (!mutation.regression) return false;
  const scenario = REGRESSIONS[mutation.regression] as unknown as (rules: Partial<Rules>) => Promise<void>;
  try {
    await scenario(mutation.rules);
  } catch {
    return true;
  }
  report(`regression "${mutation.regression}" still passes under mutation "${name}"`);
  return false;
}

/**
 * For each named broken engine, the generated runs must fail the invariant it names (ADR 0003
 * 9.2 step 5, ruling 7), or, for a rule the generated test does not reach, a named hand-written
 * regression must fail under it (PR 37 review round 3). `pnpm check` runs each mutation's known
 * killing seed and its regression; the search
 * (`pnpm test:sequence-search`, run in shards by the sequence-search workflow) searches the seeds
 * in order, each as generated and in its unlimited variant, and prints for every mutation the
 * first seed that kills it, which is how the known seeds are recorded and refreshed.
 */
export function oracle(names: readonly string[]): void {
  const all = Object.keys(MUTATIONS);
  for (const name of names) {
    const mutation = MUTATIONS[name];
    // Every mutation runs: by its known killing seed, its named regression, or both; the search runs
    // the shard's share of the mutations.
    const run = inShard(all.indexOf(name)) ? test : test.skip;
    run(`the generated runs fail invariant ${mutation?.invariant ?? "?"} for an engine with "${name}"${mutation?.regression ? `, or regression "${mutation.regression}" fails` : ""}`, async () => {
      if (!mutation) throw new Error(`no mutation named ${name}`);
      if (mutation.seed === null && !mutation.regression) throw new Error(`mutation "${name}" has neither a known killing seed nor a regression`);
      const breaks = (problems: readonly string[]) => problems.some((p) => invariantsOf(p).includes(mutation.invariant));
      if (!FULL_SEARCH) {
        // The fast named regression first; the recorded seed under a deadline, so a seed that
        // became slow fails here instead of stretching the check.
        if (mutation.regression) expect(await regressionFails(name, mutation), `regression "${mutation.regression}" passes under "${name}"`).toBe(true);
        if (mutation.seed !== null) {
          const { problems } = await runSequence(SEED + mutation.seed, { rules: mutation.rules, unlimited: mutation.unlimited ?? false, drain: true, deadline: Date.now() + CHECK_SEED_MS });
          expect(problems.filter((p) => invariantsOf(p).includes(mutation.invariant)), `seed ${SEED + mutation.seed} no longer breaks invariant ${mutation.invariant} within ${CHECK_SEED_MS / 1000} s; run the sequence-search workflow and update its seed. Problems: ${problems.join("; ")}`).not.toEqual([]);
        }
        return;
      }
      // The search: seeds in order, each as generated and unlimited, within a time budget, so no
      // mutation can take a shard's limit; then the regression, if it has one.
      const started = Date.now();
      let caught: string | null = null;
      // The recorded killing seed first, so the budget can never run out before a known seed.
      if (mutation.seed !== null) {
        const { problems } = await runSequence(SEED + mutation.seed, { rules: mutation.rules, unlimited: mutation.unlimited ?? false, drain: true, deadline: started + SEARCH_BUDGET_MS });
        if (breaks(problems)) caught = `recorded seed offset ${mutation.seed}`;
        else report(`recorded seed offset ${mutation.seed} no longer breaks invariant ${mutation.invariant} for "${name}"`);
      }
      for (let i = 0; i < MAX_SEEDS && caught === null && Date.now() - started < SEARCH_BUDGET_MS; i++) {
        for (const unlimited of [false, true]) {
          const { problems } = await runSequence(SEED + i, { rules: mutation.rules, unlimited, drain: true, deadline: started + SEARCH_BUDGET_MS + RUN_GRACE_MS });
          if (breaks(problems)) {
            caught = `seed offset ${i}${unlimited ? " (unlimited)" : ""}`;
            break;
          }
        }
      }
      const byRegression = await regressionFails(name, mutation);
      report(`killing seed: mutation "${name}" (invariant ${mutation.invariant}): ${caught ?? "none tried within the budget"}; recorded seed ${mutation.seed ?? "none"}${mutation.regression ? `; regression "${mutation.regression}" ${byRegression ? "fails under it" : "PASSES under it"}` : ""}`);
      expect(caught !== null || byRegression, `no seed broke invariant ${mutation.invariant} for "${name}" within the budget, and it has no failing regression`).toBe(true);
      if (mutation.regression) expect(byRegression).toBe(true);
    }, 1_800_000);
  }
}
