import { expect, test } from "vitest";
import { MUTATIONS } from "./engine-mutations.ts";
import { invariantsOf, runSequence } from "./generated-sequences.ts";
import { FULL_SEARCH, SEED } from "./sequence-chunks.ts";

const MAX_SEEDS = 60;

/**
 * For each named broken engine, the generated runs must fail the invariant it names (ADR 0003
 * 9.2 step 5, ruling 7). `pnpm check` runs each mutation's known killing seed; `pnpm check:full`
 * searches the seeds in order, each as generated and in its unlimited variant, and reports the
 * first seed that kills it, which is how the known seeds are refreshed.
 */
export function oracle(names: readonly string[]): void {
  for (const name of names) {
    const mutation = MUTATIONS[name];
    test(`the generated runs fail invariant ${mutation?.invariant ?? "?"} for an engine with "${name}"`, async () => {
      if (!mutation) throw new Error(`no mutation named ${name}`);
      const breaks = (problems: readonly string[]) => problems.some((p) => invariantsOf(p).includes(mutation.invariant));
      if (!FULL_SEARCH) {
        const { problems } = await runSequence(SEED + mutation.seed, { rules: mutation.rules, unlimited: mutation.unlimited ?? false, drain: true });
        expect(problems.filter((p) => invariantsOf(p).includes(mutation.invariant)), `seed ${SEED + mutation.seed} no longer breaks invariant ${mutation.invariant}; run pnpm check:full and update its seed. Problems: ${problems.join("; ")}`).not.toEqual([]);
        return;
      }
      let caught: string | null = null;
      for (let i = 0; i < MAX_SEEDS && caught === null; i++) {
        for (const unlimited of [false, true]) {
          const { problems } = await runSequence(SEED + i, { rules: mutation.rules, unlimited, drain: true });
          if (breaks(problems)) {
            caught = `seed offset ${i}${unlimited ? " (unlimited)" : ""}`;
            console.info(`mutation "${name}" breaks invariant ${mutation.invariant} at ${caught}`);
            break;
          }
        }
      }
      expect(caught, `no seed in ${MAX_SEEDS} broke invariant ${mutation.invariant} for "${name}"`).not.toBeNull();
    }, 1_800_000);
  }
}
