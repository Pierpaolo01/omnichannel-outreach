import { describe } from "vitest";
import { oracle } from "../../test/support/mutation-oracle.ts";

/**
 * The generated sequence runs must fail on deliberately broken engines (ADR 0003 9.2 step 5; the
 * ticket 12 row of 9.3). The mutations live in test/support/engine-mutations.ts. They are split
 * across four files so they run in parallel; this file holds the attempt-table mutations.
 */
describe("the attempt table", () => {
  oracle(["withdraw handed", "retry non-retryable", "retry after withdraw", "retry without slot or predicates", "retry re-renders", "new key after not-sent"]);
});
