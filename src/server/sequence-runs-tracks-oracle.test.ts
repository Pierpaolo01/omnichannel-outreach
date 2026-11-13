import { describe } from "vitest";
import { trackOracle } from "../../test/support/track-chunks.ts";

/**
 * The generated track runs must fail on deliberately broken engines (ADR 0003 9.2 step 5; the
 * ticket 13 row of 9.3). The mutations live in test/support/track-mutations.ts.
 */
describe("coordination between tracks", () => {
  trackOracle();
});
