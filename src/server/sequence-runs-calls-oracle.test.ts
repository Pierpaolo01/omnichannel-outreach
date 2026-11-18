import { describe } from "vitest";
import { callOracle } from "../../test/support/call-chunks.ts";

/**
 * The generated call runs must fail on deliberately broken engines (ADR 0003 9.2 step 5; the
 * ticket 14 row of 9.3). The mutations live in test/support/call-mutations.ts.
 */
describe("phone tracks and call tasks", () => {
  callOracle();
});
