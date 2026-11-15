import { describe } from "vitest";
import { testRunOracle } from "../../test/support/test-run-chunks.ts";

/** Broken test runs (ADR 0003 "Ticket 21"), each killed by the generated test runs. */
describe("the generated test runs catch broken test runs", () => {
  testRunOracle();
});
