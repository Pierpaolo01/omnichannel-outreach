import { generatedChunks } from "../../test/support/sequence-chunks.ts";

/**
 * 100 generated sequences through the engine core (ADR 0003 9.2), split across this file and
 * sequence-runs-{2..5}.test.ts so they run in parallel. The generator, the independent record and
 * the checks are in test/support/generated-sequences.ts and test/support/sequence-model.ts.
 */
generatedChunks(0, 20);
