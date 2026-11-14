import type { BulkRules } from "../../src/server/bulk.ts";
import type { BulkInvariant } from "./generated-bulk.ts";

/**
 * Deliberately broken bulk rules (ADR 0003 "Ticket 18", the mutations): each replaces one part of the bulk rule; the
 * generated bulk runs (generated-bulk.ts) must fail the invariant it names, on its recorded seed in `pnpm check`.
 */
let counter = 0;
/** One broken bulk rule per invariant, each with the seed (offset from BULK_SEED) known to kill it. */
export const BULK_MUTATIONS: Readonly<Record<string, { invariant: BulkInvariant; seed: number; rules: Partial<BulkRules> }>> = {
  "a fresh per-lead request id on every send": { invariant: "B2", seed: 2, rules: { perLeadRequestId: (bulkId, enrollmentId) => `${bulkId}/${enrollmentId}/${++counter}` } },
  "the confirmation's precondition is not sent": { invariant: "B3", seed: 6, rules: { precondition: () => null } },
  "the scope ignores the campaign filter": { invariant: "B1", seed: 0, rules: { inScope: () => true } },
  "a refused item reported as applied": { invariant: "B4", seed: 2, rules: { report: (r) => ({ ...r, outcome: "applied", reason: null }) } },
  "add enrolls a person with no usable channel": { invariant: "B6", seed: 0, rules: { usable: () => true } },
};

