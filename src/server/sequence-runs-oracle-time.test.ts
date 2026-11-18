import { describe } from "vitest";
import { oracle } from "../../test/support/mutation-oracle.ts";

/** Broken deadlines and late facts (see sequence-runs-oracle.test.ts). */
describe("deadlines and late facts", () => {
  oracle(["withdrawal clears deadline", "basis from observation", "clamp fallback", "late send resolves successor"]);
});
