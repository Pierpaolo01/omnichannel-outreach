import { expect, test } from "vitest";
import { runSequence } from "../../test/support/generated-imports.ts";

/** Generated import sequences; the checks are described in test/support/generated-imports.ts. */
const SEQUENCES = 120;
const SEED = 20261113;

test(`${SEQUENCES} generated import sequences keep every identity and ownership invariant (seed ${SEED})`, async () => {
  const failures: string[] = [];
  for (let i = 0; i < SEQUENCES; i++) {
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
}, 1_200_000);
