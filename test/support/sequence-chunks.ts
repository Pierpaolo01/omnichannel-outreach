import { describe, expect, test } from "vitest";
import { runSequence } from "./generated-sequences.ts";

export const SEED = 20261113;
const CHUNK = 10;

/**
 * Generated sequences `from` to `to` (offsets from SEED), ten to a chunk, each run as generated
 * and in its unlimited-capacity variant. The checks are described in generated-sequences.ts.
 */
export function generatedChunks(from: number, to: number): void {
  describe(`generated sequences keep the engine's invariants (seeds ${SEED + from} to ${SEED + to - 1})`, () => {
    for (let start = from; start < to; start += CHUNK) {
      test(`seeds ${SEED + start} to ${SEED + start + CHUNK - 1}`, async () => {
        const failures: string[] = [];
        for (let i = start; i < start + CHUNK; i++) {
          for (const unlimited of [false, true]) {
            const { problems } = await runSequence(SEED + i, { unlimited });
            if (problems.length > 0) failures.push(`seed ${SEED + i}${unlimited ? " (unlimited)" : ""}: ${problems.join("; ")}`);
          }
        }
        for (const failure of failures) console.error(failure);
        expect(failures).toEqual([]);
      }, 900_000);
    }
  });
}
