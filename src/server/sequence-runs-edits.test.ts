import { editChunks } from "../../test/support/edit-chunks.ts";

/**
 * Generated runs of running edits (ticket 19; ADR 0003 "Ticket 19"): copy, waits, steps and tracks added, removed and
 * reconnected at random instants, while paused and with work at the provider. The generator, the independent record
 * and the checks are in test/support/generated-edits.ts.
 */
editChunks();
