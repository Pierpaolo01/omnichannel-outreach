import { bulkChunks } from "../../test/support/bulk-chunks.ts";

/**
 * Generated runs of the bulk actions on Leads (ticket 18; ADR 0003 "Ticket 18"): two tabs, random selections, scopes
 * and actions, lost answers, retries and reloads, and leads changing between a confirmation and its press. The
 * generator, the independent record and the checks are in test/support/generated-bulk.ts.
 */
bulkChunks();
