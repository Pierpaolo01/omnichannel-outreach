import { interruptionChunks } from "../../test/support/interruption-chunks.ts";

/**
 * Generated runs with interruptions (ticket 20a; ADR 0003 "Ticket 20a"): the application stops and crashes, the providers
 * are cut off and an answer is held across midnight, at random instants, in the control runs' world. The generator, the
 * record and the checks are in test/support/generated-controls.ts (`interruptions: true`).
 */
interruptionChunks();
