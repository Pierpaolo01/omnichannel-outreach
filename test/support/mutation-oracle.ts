import { expect, test } from "vitest";
import { MUTATIONS } from "./engine-mutations.ts";
import { runSequence } from "./generated-sequences.ts";

const SEED = 20261113;
const MAX_SEEDS = 40;

/**
 * For each named broken engine, the generated runs must fail (ADR 0003 9.2 step 5): seeds are
 * tried in order, each as generated and in its unlimited variant, until one fails.
 */
export function oracle(names: readonly string[], options: { drain?: boolean } = {}): void {
  for (const name of names) {
    const rules = MUTATIONS[name];
    test(`the generated runs fail an engine with "${name}"`, async () => {
      if (!rules) throw new Error(`no mutation named ${name}`);
      let caught: string | null = null;
      for (let i = 0; i < MAX_SEEDS && caught === null; i++) {
        for (const unlimited of [false, true]) {
          const { problems } = await runSequence(SEED + i, { rules, unlimited, drain: options.drain ?? false });
          if (problems.length > 0) {
            caught = `seed ${SEED + i}${unlimited ? " (unlimited)" : ""}: ${problems[0] ?? ""}`;
            break;
          }
        }
      }
      expect(caught, `no seed in ${MAX_SEEDS} caught "${name}"`).not.toBeNull();
    }, 900_000);
  }
}
