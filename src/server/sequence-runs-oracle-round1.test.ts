import { describe } from "vitest";
import { oracle } from "../../test/support/mutation-oracle.ts";

/** Broken rules from review round 1 on PR 37 and its review bot (see sequence-runs-oracle.test.ts). */
describe("review round 1", () => {
  oracle([
    "uncertain work releases its reservation",
    "send settled on the inheritor",
    "retry blocks settlement",
    "unresolved ignores not-sent",
    "lookup sent without reference",
    "acceptance keeps retry intent",
    "stale guard ignores lead facts",
  ]);
});
