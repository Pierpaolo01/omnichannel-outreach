/**
 * What a bulk confirmation sends (ticket 18; ADR 0003 "Ticket 18"), one function for Leads and the generated bulk runs:
 * the confirmation's snapshot and nothing more. A bulk control sends the items the preview allowed, each with the
 * precondition its read showed; add sends only the rows the preview showed as to be enrolled, and keeps the rows it
 * showed as already enrolled or not added aside, to report them from the preview (council item 8 on 3555a3e: a press
 * changes nothing outside what its confirmation said it would). The server still judges each row it is sent.
 */
import type { BulkAction, BulkAddAnswer, BulkAddPreview, BulkAddRow, BulkControlPreview } from "../../shared/api.ts";
import type { BulkLabel } from "./requests.ts";

export interface BulkPressPlan {
  readonly action: BulkAction;
  readonly body: Readonly<Record<string, unknown>>;
  readonly labels: Readonly<Record<string, BulkLabel>>;
  readonly campaign: string | null;
  readonly notSent: readonly BulkAddRow[];
}

export function pressOf(preview: BulkControlPreview | BulkAddPreview): BulkPressPlan {
  if (preview.action === "add") {
    const toEnroll = preview.rows.filter((r) => r.outcome === "enroll");
    return {
      action: "add",
      body: { action: "add", campaignId: preview.campaign.id, rows: toEnroll.map((r) => ({ kind: r.row.kind, id: r.row.id })) },
      labels: Object.fromEntries(preview.rows.map((r) => [`${r.row.kind}:${r.row.id}`, { name: r.row.name, campaign: preview.campaign.name }])),
      campaign: preview.campaign.name,
      notSent: preview.rows.filter((r) => r.outcome !== "enroll"),
    };
  }
  return {
    action: preview.action,
    body: {
      action: preview.action,
      campaignId: preview.scope?.id ?? null,
      items: preview.items.flatMap((i) => (i.control.allowed ? [{ enrollmentId: i.enrollmentId, expect: { status: i.status, preview: i.control.digest } }] : [])),
    },
    labels: Object.fromEntries(preview.items.map((i) => [i.enrollmentId, { name: i.row.name, campaign: i.campaign.name }])),
    campaign: preview.scope?.name ?? null,
    notSent: [],
  };
}

/** An add's whole outcome: the server's answer for the rows sent, and, from the preview, the rows it did not send. */
export function addOutcome(answer: BulkAddAnswer, notSent: readonly BulkAddRow[]): BulkAddAnswer {
  const kept = notSent
    .filter((r) => !answer.results.some((x) => x.row.kind === r.row.kind && x.row.id === r.row.id))
    .map((r) => ({ row: r.row, outcome: r.outcome === "already_enrolled" ? ("already_enrolled" as const) : ("not_enrolled" as const), notEnrolled: r.notEnrolled, enrollmentId: null }));
  const results = [...answer.results, ...kept];
  return {
    ...answer,
    results,
    counts: {
      enrolled: results.filter((r) => r.outcome === "enrolled").length,
      alreadyEnrolled: results.filter((r) => r.outcome === "already_enrolled").length,
      notEnrolled: results.filter((r) => r.outcome === "not_enrolled").length,
    },
  };
}
