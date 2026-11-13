import { expect, test } from "vitest";
import { runSequence } from "../../test/support/generated-imports.ts";

/** Generated import sequences; the checks are described in test/support/generated-imports.ts. */
const SEQUENCES = 120;
const SEED = 20261113;

test(`${SEQUENCES} generated import sequences keep every identity and ownership invariant (seed ${SEED})`, async () => {
  const failures: string[] = [];
  for (let i = 0; i < SEQUENCES; i++) {
    const problems = await runSequence(SEED + i);
    if (problems.length > 0) failures.push(`seed ${SEED + i}: ${problems.join("; ")}`);
  }
  expect(failures).toEqual([]);
}, 1_200_000);
