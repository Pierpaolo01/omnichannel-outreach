import { trackChunks } from "../../test/support/track-chunks.ts";

/**
 * Generated sequences of email and SMS tracks, together and after (ADR 0003 9.2; the ticket 13 row
 * of 9.3). The generator, the independent record and the checks are in
 * test/support/generated-tracks.ts.
 */
trackChunks(0, 100);
