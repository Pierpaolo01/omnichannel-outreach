import { testRunChunks } from "../../test/support/test-run-chunks.ts";

/**
 * Generated test runs (ticket 21; ADR 0003 "Ticket 21"): Run test, Stop test, test replies, test calls, edits, launch and
 * pauses at random instants beside leads that share the senders. The generator, the record and the checks are in
 * test/support/generated-test-runs.ts.
 */
testRunChunks();
