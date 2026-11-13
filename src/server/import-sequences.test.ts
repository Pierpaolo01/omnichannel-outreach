import { describe, expect, test } from "vitest";
import { runSequence } from "../../test/support/generated-imports.ts";

/**
 * Generated import sequences; the checks are described in test/support/generated-imports.ts.
 * 120 seeds, in chunks of 10 so each test stays short and reports on its own.
 */
const SEQUENCES = 120;
const CHUNK = 10;
const SEED = 20261113;

describe(`${SEQUENCES} generated import sequences keep every identity and ownership invariant (seed ${SEED})`, () => {
  for (let start = 0; start < SEQUENCES; start += CHUNK) {
    test(`seeds ${SEED + start} to ${SEED + start + CHUNK - 1}, in file order and with every file's rows shuffled`, async () => {
      const failures: string[] = [];
      for (let i = start; i < start + CHUNK; i++) {
        const inOrder = await runSequence(SEED + i);
        const reordered = await runSequence(SEED + i, { shuffle: true });
        const problems = [...inOrder.problems, ...reordered.problems.map((p) => `rows shuffled: ${p}`)];
        // Row order never changes the outcome.
        const diverged = inOrder.snapshots.findIndex((snap, k) => snap !== reordered.snapshots[k]);
        if (problems.length === 0 && (diverged >= 0 || inOrder.snapshots.length !== reordered.snapshots.length)) {
          problems.push(`shuffling the rows changed the outcome at ${(inOrder.snapshots[diverged] ?? "").slice(0, 40)}`);
        }
        if (problems.length > 0) failures.push(`seed ${SEED + i}: ${problems.join("; ")}`);
      }
      expect(failures).toEqual([]);
    }, 300_000);
  }
});
