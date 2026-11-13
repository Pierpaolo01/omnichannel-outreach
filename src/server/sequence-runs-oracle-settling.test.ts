import { describe } from "vitest";
import { oracle } from "../../test/support/mutation-oracle.ts";

/** Broken settling and bounded waits (see sequence-runs-oracle.test.ts). */
describe("settling and bounded waits", () => {
  oracle(["mark not sent while queued", "queued unresolved at once", "claim without age limit", "accepted never settles"]);
});
