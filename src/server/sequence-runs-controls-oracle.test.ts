import { describe } from "vitest";
import { controlOracle } from "../../test/support/control-chunks.ts";

/** Broken controls (ADR 0003 9.2 step 5, "Ticket 17a"), each killed by the generated control runs. */
describe("the generated control runs catch broken controls", () => {
  controlOracle();
});
