import { expect, test, vi } from "vitest";
import { runSequence } from "../../test/support/generated-imports.ts";

/**
 * The generated-sequence checks must fail an importer that refuses every row as ambiguous, which
 * would otherwise pass every identity check by creating nothing (review round 4).
 */
vi.mock("../domain/matching.ts", () => ({
  resolveMatches: (evidence: readonly unknown[]) => evidence.map(() => ({ kind: "ambiguous", conflict: "several_records", disagreeing: [] })),
}));

test("the generated-sequence checks fail an importer that refuses every row", async () => {
  for (let seed = 20261113; seed < 20261113 + 10; seed++) {
    expect((await runSequence(seed)).problems).not.toEqual([]);
  }
}, 120_000);
