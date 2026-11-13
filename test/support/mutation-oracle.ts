import { expect, test } from "vitest";
import { MUTATIONS } from "./engine-mutations.ts";
import { invariantsOf, runSequence } from "./generated-sequences.ts";
import { appendFileSync } from "node:fs";
import { FULL_SEARCH, inShard, SEED } from "./sequence-chunks.ts";

const MAX_SEEDS = 60;

/** One line per mutation in the search's log and, in CI, the job summary: the seed that kills it, or none. */
function report(line: string): void {
  console.info(line);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary) appendFileSync(summary, `- ${line}\n`);
}

/**
 * For each named broken engine, the generated runs must fail the invariant it names (ADR 0003
 * 9.2 step 5, ruling 7). `pnpm check` runs each mutation's known killing seed; the search
 * (`pnpm test:sequence-search`, run in shards by the sequence-search workflow) searches the seeds
 * in order, each as generated and in its unlimited variant, and prints for every mutation the
 * first seed that kills it, which is how the known seeds are recorded and refreshed.
 */
export function oracle(names: readonly string[]): void {
  const all = Object.keys(MUTATIONS);
  for (const name of names) {
    const mutation = MUTATIONS[name];
    const knownSeed = mutation?.seed ?? null;
    // Without a known killing seed, only the search runs it (reported, not hidden); the search runs
    // the shard's share of the mutations.
    const run = (FULL_SEARCH || knownSeed !== null) && inShard(all.indexOf(name)) ? test : test.skip;
    run(`the generated runs fail invariant ${mutation?.invariant ?? "?"} for an engine with "${name}"`, async () => {
      if (!mutation) throw new Error(`no mutation named ${name}`);
      const breaks = (problems: readonly string[]) => problems.some((p) => invariantsOf(p).includes(mutation.invariant));
      if (!FULL_SEARCH && mutation.seed !== null) {
        const { problems } = await runSequence(SEED + mutation.seed, { rules: mutation.rules, unlimited: mutation.unlimited ?? false, drain: true });
        expect(problems.filter((p) => invariantsOf(p).includes(mutation.invariant)), `seed ${SEED + mutation.seed} no longer breaks invariant ${mutation.invariant}; run the sequence-search workflow and update its seed. Problems: ${problems.join("; ")}`).not.toEqual([]);
        return;
      }
      let caught: string | null = null;
      for (let i = 0; i < MAX_SEEDS && caught === null; i++) {
        for (const unlimited of [false, true]) {
          const { problems } = await runSequence(SEED + i, { rules: mutation.rules, unlimited, drain: true });
          if (breaks(problems)) {
            caught = `seed offset ${i}${unlimited ? " (unlimited)" : ""}`;
            break;
          }
        }
      }
      report(`killing seed: mutation "${name}" (invariant ${mutation.invariant}): ${caught ?? `none in offsets 0-${MAX_SEEDS - 1}`}${knownSeed === null ? "; pnpm check skips it until its seed is recorded" : `; recorded seed offset ${knownSeed}`}`);
      expect(caught, `no seed in ${MAX_SEEDS} broke invariant ${mutation.invariant} for "${name}"`).not.toBeNull();
    }, 1_800_000);
  }
}
