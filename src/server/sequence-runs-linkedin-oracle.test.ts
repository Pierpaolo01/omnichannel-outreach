import { describe } from "vitest";
import { linkedinOracle } from "../../test/support/linkedin-chunks.ts";

/** The generated LinkedIn runs must fail on deliberately broken engines, one per invariant (ADR 0004 10.3). */
describe("the LinkedIn track's invariants bite", () => {
  linkedinOracle();
});
