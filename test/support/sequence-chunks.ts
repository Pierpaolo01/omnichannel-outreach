import { describe, expect, test } from "vitest";
import { runSequence } from "./generated-sequences.ts";

export const SEED = 20261113;

/** `pnpm check:full` sets this: the full seed and mutation search, run before a merge (ruling 11). */
export const FULL_SEARCH = process.env["SEQUENCE_SEARCH"] === "full";

/**
 * The fixed seeds `pnpm check` runs, as offsets from SEED: together they exercise every fake mode,
 * crashes and transient errors at the outbox stages, both reply kinds, the user's marks, hanging
 * ports, clock advances between authorization and call, default gaps, k = 2, two campaigns and the
 * not-sent-then-sent capacity case. Chosen from a sweep of all 100 seeds by `scripts/choose-seeds.ts`.
 */
export const FIXED_SEEDS: readonly number[] = [];

const CHUNK = 10;

/**
 * Generated sequences `from` to `to` (offsets from SEED), each run as generated and in its
 * unlimited-capacity variant: all of them under the full search, otherwise the fixed seeds in that
 * range. The checks are described in generated-sequences.ts.
 */
export function generatedChunks(from: number, to: number): void {
  const offsets = FULL_SEARCH ? Array.from({ length: to - from }, (_, i) => from + i) : FIXED_SEEDS.filter((o) => o >= from && o < to);
  describe(`generated sequences keep the engine's invariants (${FULL_SEARCH ? "full search" : "fixed seeds"}, ${SEED + from} to ${SEED + to - 1})`, () => {
    if (offsets.length === 0) test.skip("no fixed seed in this range", () => undefined);
    for (let i = 0; i < offsets.length; i += CHUNK) {
      const chunk = offsets.slice(i, i + CHUNK);
      test(`seeds ${chunk.map((o) => SEED + o).join(", ")}`, async () => {
        const failures: string[] = [];
        for (const offset of chunk) {
          for (const unlimited of [false, true]) {
            const { problems } = await runSequence(SEED + offset, { unlimited });
            if (problems.length > 0) failures.push(`seed ${SEED + offset}${unlimited ? " (unlimited)" : ""}: ${problems.join("; ")}`);
          }
        }
        for (const failure of failures) console.error(failure);
        expect(failures).toEqual([]);
      }, 1_800_000);
    }
  });
}
