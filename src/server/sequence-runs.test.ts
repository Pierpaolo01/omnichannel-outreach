import { describe, expect, test } from "vitest";
import { runSequence } from "../../test/support/generated-sequences.ts";

/**
 * Generated sequences through the engine core (ADR 0003 9.2); the generator, the record and the
 * checks are described in test/support/generated-sequences.ts. 100 seeds, ten to a chunk, each
 * run once as generated and once in its unlimited-capacity variant.
 */
const SEQUENCES = 100;
const CHUNK = 10;
const SEED = 20261113;

describe(`${SEQUENCES} generated sequences keep the engine's invariants (seed ${SEED})`, () => {
  for (let start = 0; start < SEQUENCES; start += CHUNK) {
    test(`seeds ${SEED + start} to ${SEED + start + CHUNK - 1}`, async () => {
      const failures: string[] = [];
      for (let i = start; i < start + CHUNK; i++) {
        for (const unlimited of [false, true]) {
          const { problems } = await runSequence(SEED + i, { unlimited });
          if (problems.length > 0) failures.push(`seed ${SEED + i}${unlimited ? " (unlimited)" : ""}: ${problems.join("; ")}`);
        }
      }
      expect(failures).toEqual([]);
    }, 600_000);
  }
});
