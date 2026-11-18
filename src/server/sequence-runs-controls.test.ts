import { controlChunks } from "../../test/support/control-chunks.ts";

/**
 * Generated runs of the user's controls (ticket 17a; ADR 0003 "Ticket 17a"): skip, stop, restart, win-back, pauses
 * and replies at random instants. The generator, the independent record and the checks are in
 * test/support/generated-controls.ts.
 */
controlChunks();
