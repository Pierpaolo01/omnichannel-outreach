/**
 * Bulk add, pause, resume and stop on Leads (ticket 18; ADR 0003 "Ticket 18"). A bulk control is the set of per-lead
 * controls its confirmation showed: each is `Engine.controlLead`, with a request id derived from the bulk id, the
 * precondition its confirmation's read showed and `judgeControl`'s one refusal order. Add to campaign is the import's
 * enrollment rule (`planEnrollment`) applied by the import's enrollment path, its answer stored with the bulk id.
 * Nothing here changes a lead any other way.
 */
import { createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { planEnrollment, type EnrollmentDecision, type LeadRef } from "../domain/import-plan.ts";
import { OUTREACH_STATUSES } from "../domain/outreach-status.ts";
import type { Reach } from "../domain/reach.ts";
import { CHANGED_SINCE_CONFIRMED, PREVIEW_CHANGED, type LeadExpectation } from "../domain/sequence/controls.ts";
import type { SubjectState } from "../domain/sequence/state.ts";
import type {
  ApiError,
  BulkAddAnswer,
  BulkAddPreview,
  BulkAddResult,
  BulkAddRow,
  BulkControlAction,
  BulkControlAnswer,
  BulkControlPreview,
  BulkControlResult,
  BulkNotEnrolled,
  BulkPreviewItem,
  BulkRowRef,
  BulkRowView,
  ControlView,
  EnrollmentRead,
} from "../shared/api.ts";
import type { ControlAnswer } from "./engine/engine.ts";
import type { OutreachStore } from "./persistence/store.ts";
import { invalidBodyMessage, requestObject } from "./request-body.ts";

/** The search's bound: a selection is at most the rows one search can show. */
export const BULK_MAX = 500;
/**
 * The bound on items: a preview of at most BULK_MAX rows, each in every campaign it is in, has at most this many, and
 * its press carries all it allowed (review bot on 9daf7c0: a 500-item bound refused a valid all-campaign press). A
 * preview over it is refused, so a confirmation is never shown that its press cannot send.
 */
export const BULK_ITEMS_MAX = 5_000;
/**
 * The per-lead precondition refusals, as Leads says them (council item 9 on 3555a3e): a Leads row has no confirm of its
 * own, so the user selects it again; the engine's own sentence stays as it is for the person page.
 */
export const BULK_CHANGED_SINCE_CONFIRMED = "This lead changed since you confirmed this, so nothing was changed. Select it again to see what a bulk change would do now.";
export const BULK_PREVIEW_CHANGED = "What this would do changed since you confirmed it, so nothing was changed. Select it again to see what a bulk change would do now.";
const bulkReason = (reason: string): string => (reason === CHANGED_SINCE_CONFIRMED ? BULK_CHANGED_SINCE_CONFIRMED : reason === PREVIEW_CHANGED ? BULK_PREVIEW_CHANGED : reason);

export const BULK_REQUEST_REUSED = "This request id was already used for another action: send a new one.";

/**
 * The bulk rule's replaceable parts: the generated bulk runs swap one at a time to prove each invariant's check fails
 * (ADR 0003 "Ticket 18", the mutations). The app runs `DEFAULT_BULK_RULES`.
 */
export interface BulkRules {
  /** The per-lead request id of one item of a bulk (B2). */
  perLeadRequestId(bulkId: string, enrollmentId: string): string;
  /** The precondition sent with an item: what its confirmation showed (B3). */
  precondition(expect: LeadExpectation): LeadExpectation | null;
  /** Whether an enrollment of a selected row is in a bulk's scope (B1). */
  inScope(campaignId: string, scope: string | null): boolean;
  /** One per-lead answer as the bulk reports it (B4). */
  report(result: BulkControlResult): BulkControlResult;
  /**
   * The items a press applies (B1): the confirmation's, as sent, never the scope resolved again at the press. `context`
   * gives what a mutation that re-resolves the scope would read; the app never calls it.
   */
  pressItems(items: readonly PressItem[], context: PressContext): Promise<readonly PressItem[]>;
  /** The enrollment rule's channel test, for add (B6); `undefined` keeps the import's own. */
  usable: ((reach: Reach) => boolean) | undefined;
}

/** One item of a press: an enrollment and the precondition its confirmation showed. */
export interface PressItem {
  readonly enrollmentId: string;
  readonly expect: LeadExpectation;
}
/** What the press could read at its instant, for `BulkRules.pressItems`. */
export interface PressContext {
  readonly store: OutreachStore;
  readonly scope: string | null;
  readonly action: BulkControlAction;
  readonly at: number;
  readonly readOf: (state: SubjectState, at: number) => EnrollmentRead;
}

export const DEFAULT_BULK_RULES: BulkRules = {
  pressItems: (items) => Promise.resolve(items),
  perLeadRequestId: (bulkId, enrollmentId) => `${bulkId}/${enrollmentId}`,
  precondition: (expect) => expect,
  inScope: (campaignId, scope) => scope === null || campaignId === scope,
  report: (result) => result,
  usable: undefined,
};

const rowRef = requestObject({ kind: z.enum(["person", "company"]), id: z.string().min(1).max(200) });
const rows = z.array(rowRef).min(1, "Select at least one person or company lead.").max(BULK_MAX, `Select at most ${BULK_MAX} rows.`);
const campaignId = z.string().min(1).max(200);
const bulkId = z
  .string()
  .trim()
  .min(1, "Send a request id with each action.")
  .max(80)
  .refine((id) => !id.includes("/"), "A bulk request id cannot contain a slash.");
const action = z.enum(["add", "pause", "resume", "stop"], { message: "Choose one of: add, pause, resume, stop." });
const item = requestObject({ enrollmentId: z.string().min(1).max(100), expect: requestObject({ status: z.enum(OUTREACH_STATUSES), preview: z.string().max(500) }) });

/** Add names a campaign; a control's scope is a campaign or null (every campaign). One strict object, so an unknown field is named. */
const previewBody = requestObject({ action, rows, campaignId: campaignId.nullable() }).refine((b) => b.action !== "add" || b.campaignId !== null, { message: "Choose the campaign to add them to.", path: ["campaignId"] });
const pressBody = requestObject({
  bulkId,
  action,
  campaignId: campaignId.nullable(),
  rows: rows.optional(),
  items: z.array(item).min(1, "Send at least one item.").max(BULK_ITEMS_MAX, `Send at most ${BULK_ITEMS_MAX} items.`).optional(),
})
  .refine((b) => b.action !== "add" || (b.campaignId !== null && b.rows !== undefined && b.items === undefined), { message: "Add to campaign sends the campaign and the selected rows.", path: ["rows"] })
  .refine((b) => b.action === "add" || (b.items !== undefined && b.rows === undefined), { message: "A bulk pause, resume or stop sends the items its confirmation showed.", path: ["items"] });

export interface BulkDependencies {
  readonly store: OutreachStore;
  readonly engine: { controlLead(subjectId: string, action: BulkControlAction, requestId: string, expected: LeadExpectation | null): Promise<ControlAnswer> };
  readonly now: () => string;
  readonly newId: () => string;
  /** The enrollment's read, as GET /api/enrollments/:id gives it. */
  readonly readOf: (state: SubjectState, at: number) => EnrollmentRead;
  readonly rules?: Partial<BulkRules>;
}

const leadOf = (ref: BulkRowRef): LeadRef => (ref.kind === "person" ? { kind: "person", personId: ref.id } : { kind: "company", companyId: ref.id });
const keyOf = (ref: { kind: string; id: string }) => `${ref.kind}:${ref.id}`;
const refOfLead = (lead: LeadRef): BulkRowRef => (lead.kind === "person" ? { kind: "person", id: lead.personId } : { kind: "company", id: lead.companyId });
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function notEnrolledOf(decision: EnrollmentDecision): BulkNotEnrolled | null {
  if (decision.outcome !== "not_enrolled") return null;
  return decision.reason === "shares_contact" ? { reason: "shares_contact", shared: decision.shared } : { reason: decision.reason };
}

export function bulkRoutes(app: Hono, deps: BulkDependencies): void {
  const rules: BulkRules = { ...DEFAULT_BULK_RULES, ...deps.rules };
  const { store } = deps;

  /** The rows that exist, in the order selected, each once. */
  const resolveRows = async (refs: readonly BulkRowRef[]) => {
    const unique = [...new Map(refs.map((r) => [keyOf(r), r])).values()];
    return store.leadRows(unique);
  };

  const campaignName = async (id: string) => (await store.campaign(id))?.name ?? null;

  /** Add's plan over the campaign's directory, with the rows' names, in the order selected. */
  const addPlan = (rowsSelected: readonly BulkRowView[], at: string) => (directory: Parameters<typeof planEnrollment>[0]["directory"]) =>
    planEnrollment({ directory, leads: rowsSelected.map(leadOf), now: at, newId: deps.newId, ...(rules.usable ? { usable: rules.usable } : {}) });

  app.post("/bulk/preview", async (c) => {
    const body = previewBody.safeParse(await readJson(c));
    if (!body.success) return invalid(c, body.error);
    const at = Date.parse(deps.now());
    const selected = await resolveRows(body.data.rows);
    if (body.data.action === "add") {
      const target = body.data.campaignId ?? "";
      const name = await campaignName(target);
      const plan = name === null ? null : await store.planInCampaign(target, addPlan(selected, new Date(at).toISOString()));
      if (name === null || plan === null) return notFound(c, "campaign");
      const byLead = new Map(plan.decisions.map((d) => [keyOf(refOfLead(d.lead)), d]));
      const out: BulkAddRow[] = selected.flatMap((row) => {
        const d = byLead.get(keyOf(row));
        if (!d) return [];
        const view = { kind: row.kind, id: row.id, name: row.name };
        return [{ row: view, outcome: d.outcome === "new" ? "enroll" : d.outcome, notEnrolled: notEnrolledOf(d) }];
      });
      return c.json<BulkAddPreview>({
        asOf: new Date(at).toISOString(),
        action: "add",
        campaign: { id: target, name },
        rows: out,
        counts: { enroll: out.filter((r) => r.outcome === "enroll").length, alreadyEnrolled: out.filter((r) => r.outcome === "already_enrolled").length, notEnrolled: out.filter((r) => r.outcome === "not_enrolled").length },
      });
    }
    const scope = body.data.campaignId;
    const scopeName = scope === null ? null : await campaignName(scope);
    if (scope !== null && scopeName === null) return notFound(c, "campaign");
    const action: BulkControlAction = body.data.action;
    // Every enrollment in scope, loaded once, at one instant: its read's entry for the action is the item (B1).
    const items: BulkPreviewItem[] = [];
    const outOfScope: BulkRowView[] = [];
    for (const row of selected) {
      const view = { kind: row.kind, id: row.id, name: row.name };
      const inScope = row.enrollments.filter((e) => rules.inScope(e.campaign.id, scope));
      if (inScope.length === 0) outOfScope.push(view);
      for (const e of inScope) {
        const state = await store.engine.subject(e.id, at);
        if (!state) continue;
        const read = deps.readOf(state, at);
        const control = read.controls.find((x) => x.action === action);
        if (!control) continue;
        items.push({ row: view, enrollmentId: e.id, campaign: e.campaign, status: read.status, control });
      }
    }
    if (items.length > BULK_ITEMS_MAX) {
      return c.json<ApiError>({ error: { code: "invalid_request", message: `These rows are in more than ${BULK_ITEMS_MAX.toLocaleString("en-GB")} campaign enrollments. Filter by a campaign, or select fewer.` } }, 400);
    }
    const refused = items.flatMap((i) => (i.control.allowed ? [] : [i.control]));
    const reasons = [...new Map(refused.map((r: Extract<ControlView, { allowed: false }>) => [r.reason, refused.filter((x) => x.reason === r.reason).length])).entries()].map(([reason, count]) => ({ reason, count }));
    return c.json<BulkControlPreview>({
      asOf: new Date(at).toISOString(),
      action,
      scope: scope === null || scopeName === null ? null : { id: scope, name: scopeName },
      rows: selected.length,
      items,
      outOfScope,
      counts: { applies: items.length - refused.length, refused: refused.length, reasons },
    });
  });

  app.post("/bulk", async (c) => {
    const body = pressBody.safeParse(await readJson(c));
    if (!body.success) return invalid(c, body.error);
    const at = Date.parse(deps.now());
    const bodyHash = sha256(body.data);
    if (body.data.action === "add") {
      const target = body.data.campaignId ?? "";
      const refs = body.data.rows ?? [];
      const name = await campaignName(target);
      if (name === null) return notFound(c, "campaign");
      const selected = await resolveRows(refs);
      const out = await store.addToCampaign({
        campaignId: target,
        bulkId: body.data.bulkId,
        bodySha256: bodyHash,
        at,
        plan: addPlan(selected, new Date(at).toISOString()),
        answer: (decisions: readonly EnrollmentDecision[]) => {
          const byLead = new Map(decisions.map((d) => [keyOf(refOfLead(d.lead)), d]));
          const results: BulkAddResult[] = selected.flatMap((row) => {
            const d = byLead.get(keyOf(row));
            if (!d) return [];
            return [{ row: { kind: row.kind, id: row.id, name: row.name }, outcome: d.outcome === "new" ? "enrolled" : d.outcome, notEnrolled: notEnrolledOf(d), enrollmentId: d.outcome === "new" ? d.enrollmentId : null }];
          });
          const answer: Omit<BulkAddAnswer, "replayed"> = {
            bulkId: body.data.bulkId,
            action: "add",
            campaign: { id: target, name },
            results,
            counts: { enrolled: results.filter((r) => r.outcome === "enrolled").length, alreadyEnrolled: results.filter((r) => r.outcome === "already_enrolled").length, notEnrolled: results.filter((r) => r.outcome === "not_enrolled").length },
          };
          return JSON.stringify(answer);
        },
      });
      if (out.kind === "missing") return notFound(c, "campaign");
      if (out.kind === "different") return refused(c, BULK_REQUEST_REUSED);
      return c.json<BulkAddAnswer>({ ...(JSON.parse(out.answer) as Omit<BulkAddAnswer, "replayed">), replayed: out.replayed });
    }
    const pressed: BulkControlAction = body.data.action;
    const items = body.data.items ?? [];
    // The bulk id is bound to its body before any lead is touched; each item is then its own per-lead request (B2).
    if ((await store.bindBulkRequest(body.data.bulkId, pressed, bodyHash, at)) === "different") return refused(c, BULK_REQUEST_REUSED);
    const results: BulkControlResult[] = [];
    const applied = await rules.pressItems(items, { store, scope: body.data.campaignId, action: pressed, at, readOf: deps.readOf });
    for (const item of applied) {
      if (!(await store.engine.subject(item.enrollmentId, Date.parse(deps.now())))) {
        results.push(rules.report({ enrollmentId: item.enrollmentId, outcome: "refused", reason: "There is no such lead.", replayed: false }));
        continue;
      }
      const answer = await deps.engine.controlLead(item.enrollmentId, pressed, rules.perLeadRequestId(body.data.bulkId, item.enrollmentId), rules.precondition(item.expect));
      results.push(rules.report(answer.ok ? { enrollmentId: item.enrollmentId, outcome: "applied", reason: null, replayed: answer.replayed } : { enrollmentId: item.enrollmentId, outcome: "refused", reason: bulkReason(answer.reason), replayed: false }));
    }
    return c.json<BulkControlAnswer>({
      bulkId: body.data.bulkId,
      action: pressed,
      results,
      counts: { applied: results.filter((r) => r.outcome === "applied").length, refused: results.filter((r) => r.outcome === "refused").length },
    });
  });
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function invalid(c: Context, error: z.ZodError) {
  return c.json<ApiError>({ error: { code: "invalid_request", message: invalidBodyMessage(error) } }, 400);
}

function notFound(c: Context, what: string) {
  return c.json<ApiError>({ error: { code: "not_found", message: `No such ${what}.` } }, 404);
}

function refused(c: Context, message: string) {
  return c.json<ApiError>({ error: { code: "bulk_refused", message } }, 409);
}
