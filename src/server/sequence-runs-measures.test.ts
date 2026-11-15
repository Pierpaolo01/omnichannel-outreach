import { measureChunks } from "../../test/support/measure-chunks.ts";

/**
 * Generated runs of the campaign measures (ticket 22; ADR 0003 "Ticket 22"): every figure of the read against the record's own
 * tally, at random instants. The generator, the record and the checks are in test/support/generated-measures.ts.
 */
measureChunks();
