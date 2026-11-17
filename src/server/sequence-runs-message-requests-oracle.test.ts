import { describe } from "vitest";
import { messageRequestOracle } from "../../test/support/message-request-chunks.ts";

/** The generated message-request runs must fail on deliberately broken engines, one per invariant (ADR 0004 13.9). */
describe("the message-request channels' invariants bite", () => {
  messageRequestOracle();
});
