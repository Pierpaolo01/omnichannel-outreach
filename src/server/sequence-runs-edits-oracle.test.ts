import { describe } from "vitest";
import { editOracle } from "../../test/support/edit-chunks.ts";

/** Broken running edits (ADR 0003 9.2 step 5, "Ticket 19"), each killed by the generated edit runs. */
describe("the generated edit runs catch broken running edits", () => {
  editOracle();
});
