import type { BulkRules, PressItem } from "../../src/server/bulk.ts";
import type { BulkInvariant } from "./generated-bulk.ts";
import { pressOf } from "../../src/web/bulk/press.ts";

/**
 * Deliberately broken bulk rules (ADR 0003 "Ticket 18", the mutations): each replaces one part of the bulk rule; the
 * generated bulk runs (generated-bulk.ts) must fail the invariant it names, on its recorded seed in `pnpm check`.
 */
let counter = 0;
/** One broken bulk rule per invariant, each with the seed (offset from BULK_SEED) known to kill it. */
export const BULK_MUTATIONS: Readonly<Record<string, { invariant: BulkInvariant; seed: number; rules: Partial<BulkRules>; pressOf?: typeof pressOf }>> = {
  // Council item 8 on 3555a3e (Sol): an add's press sends every previewed row, so a row its confirmation showed as not
  // added is enrolled once it became reachable.
  "an add's press sends every previewed row": {
    invariant: "B1",
    seed: 5,
    rules: {},
    pressOf: (preview) => {
      const plan = pressOf(preview);
      return preview.action === "add" ? { ...plan, body: { ...plan.body, rows: preview.rows.map((r) => ({ kind: r.row.kind, id: r.row.id })) } } : plan;
    },
  },
  "a fresh per-lead request id on every send": { invariant: "B2", seed: 2, rules: { perLeadRequestId: (bulkId, enrollmentId) => `${bulkId}/${enrollmentId}/${++counter}` } },
  "the confirmation's precondition is not sent": { invariant: "B3", seed: 6, rules: { precondition: () => null } },
  "the scope ignores the campaign filter": { invariant: "B1", seed: 0, rules: { inScope: () => true } },
  "a refused item reported as applied": { invariant: "B4", seed: 2, rules: { report: (r) => ({ ...r, outcome: "applied", reason: null }) } },
  "add enrolls a person with no usable channel": { invariant: "B6", seed: 0, rules: { usable: () => true } },
  // The verifier's mutant on 4363270: the press re-reads each selected row's enrollments and adds those in scope now,
  // so a lead that joined the scope after the confirmation is changed too.
  "the scope is resolved again at the press": {
    invariant: "B1",
    seed: 2,
    rules: {
      pressItems: async (items, { store, scope, action, at, readOf }) => {
        const rows = (await store.searchLeads({ text: "", campaignId: null, companyId: null, status: null, limit: 500 })).rows;
        const selected = rows.filter((r) => r.enrollments.some((e) => items.some((i) => i.enrollmentId === e.id)));
        const extra: PressItem[] = [];
        for (const e of selected.flatMap((r) => r.enrollments)) {
          if (items.some((i) => i.enrollmentId === e.id) || (scope !== null && e.campaign.id !== scope)) continue;
          const state = await store.engine.subject(e.id, at);
          const control = state ? readOf(state, at).controls.find((c) => c.action === action) : undefined;
          if (state && control?.allowed) extra.push({ enrollmentId: e.id, expect: { status: readOf(state, at).status, preview: control.digest } });
        }
        return [...items, ...extra];
      },
    },
  },
};

