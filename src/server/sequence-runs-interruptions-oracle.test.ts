import { describe } from "vitest";
import { interruptionOracle } from "../../test/support/interruption-chunks.ts";

/** Broken recoveries (ADR 0003 "Ticket 20a"), each killed by the generated runs with interruptions. */
describe("the generated runs with interruptions catch broken recoveries", () => {
  interruptionOracle();
});
