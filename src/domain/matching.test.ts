import { expect, test } from "vitest";
import { resolveMatches } from "./matching.ts";

test("weaker evidence never chooses between several decisive matches", () => {
  const [resolution] = resolveMatches([
    { tiers: [{ kind: "email", decisive: true, ids: ["x", "y"] }, { kind: "person_id", ids: ["x"] }], byName: ["x", "y"] },
  ]);
  expect(resolution).toEqual({ kind: "ambiguous", conflict: "several_records", disagreeing: [] });
});
