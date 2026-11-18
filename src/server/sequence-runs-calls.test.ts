import { callChunks } from "../../test/support/call-chunks.ts";

/**
 * Generated sequences with phone tracks, call tasks and the outcomes the user logs (ADR 0003 9.2;
 * the ticket 14 row of 9.3). The generator, the independent record and the checks are in
 * test/support/generated-calls.ts.
 */
callChunks(0, 100);
