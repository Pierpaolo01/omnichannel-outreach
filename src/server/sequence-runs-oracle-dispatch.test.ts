import { describe } from "vitest";
import { oracle } from "../../test/support/mutation-oracle.ts";

/** Broken claims, handovers, pacing and capacity (see sequence-runs-oracle.test.ts). */
describe("claims and handovers", () => {
  oracle(["stale apply", "handover without re-check", "handover out of priority order", "pacing at claim", "sender fixed at claim", "capacity off by one", "window", "touched at claim"]);
});
