/**
 * What Leads says about a bulk action (ticket 18). Every count and reason comes from the server: the confirmation from
 * the preview read it opened on, the result from the answer. History is in the past tense; nothing here computes a state.
 */
import type { BulkAction, BulkAddAnswer, BulkAddPreview, BulkControlAction, BulkControlAnswer, BulkControlPreview, BulkNotEnrolled, BulkRowView } from "../../shared/api.ts";
import { detailWord } from "../importText.tsx";
import { UNENROLLED_SHORT } from "../components.tsx";
import type { BulkLabel } from "./requests.ts";

export const BULK_VERB = { add: "Add to campaign", pause: "Pause", resume: "Resume", stop: "Stop" } as const satisfies Record<BulkAction, string>;
const PAST = { pause: "Paused", resume: "Resumed", stop: "Stopped" } as const satisfies Record<BulkControlAction, string>;
const LOWER = { pause: "pause", resume: "resume", stop: "stop" } as const satisfies Record<BulkControlAction, string>;
const PENDING = { add: "Adding", pause: "Pausing", resume: "Resuming", stop: "Stopping" } as const satisfies Record<BulkAction, string>;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const enrollments = (n: number) => plural(n, "campaign enrollment", "campaign enrollments");

/** "2 people", "1 company lead", "2 people and 1 company lead": who is selected. */
export function selectionWords(rows: readonly Pick<BulkRowView, "kind">[]): string {
  const people = rows.filter((r) => r.kind === "person").length;
  const companies = rows.length - people;
  if (companies === 0) return plural(people, "person", "people");
  if (people === 0) return plural(companies, "company lead", "company leads");
  return `${plural(people, "person", "people")} and ${plural(companies, "company lead", "company leads")}`;
}

/** Why the import's enrollment rule leaves a row out, in the import results' wording. */
export function notEnrolledText(why: BulkNotEnrolled, row: Pick<BulkRowView, "kind">): string {
  switch (why.reason) {
    case "no_usable_channel":
      return UNENROLLED_SHORT[row.kind];
    case "shares_contact": {
      const { detail, lead, companyName, enrolled } = why.shared;
      const what = detailWord(detail, row.kind);
      return enrolled ? `${what} ${detail.value} is already ${lead}’s at ${companyName}, who is in this campaign` : `${what} ${detail.value} is also ${lead}’s at ${companyName}, and nothing shows whose it is`;
    }
    case "decision_makers_on_record":
      return "its decision makers are on record, so it isn’t a company lead; add them instead";
    default: {
      const never: never = why;
      return never;
    }
  }
}

/** The confirmation of a bulk pause, resume or stop, from the preview read: its scope, how many it applies to, and each refusal's reason with its count. */
export function controlConfirmText(p: BulkControlPreview): { readonly text: string; readonly canConfirm: boolean } {
  const scope = p.scope ? ` in ${p.scope.name}` : ", in every campaign they are in";
  const who = selectionWords(p.items.length > 0 ? [...new Map(p.items.map((i) => [`${i.row.kind}:${i.row.id}`, i.row])).values()] : p.outOfScope);
  const left = p.counts.reasons.map((r) => `${r.count} ${r.count === 1 ? "is" : "are"} left alone: ${r.reason}`);
  const outside = p.scope && p.outOfScope.length > 0 ? `${p.outOfScope.length === 1 ? `${p.outOfScope[0]?.name ?? ""} is` : `${p.outOfScope.length} of the selected are`} not in ${p.scope.name}.` : "";
  if (p.counts.applies === 0) {
    const why = p.items.length === 0 ? (p.scope ? `None of the selected is in ${p.scope.name}.` : "None of the selected is in a campaign.") : left.join(" ");
    return { text: [`Nothing to ${LOWER[p.action]}.`, why, p.items.length === 0 ? "" : outside].filter(Boolean).join(" "), canConfirm: false };
  }
  const head = `${BULK_VERB[p.action]} ${enrollments(p.counts.applies)} for ${who}${scope}?`;
  return { text: [head, ...left, outside].filter(Boolean).join(" "), canConfirm: true };
}

/** The confirmation of add to campaign, from the preview read: who is added, who is already in it, who cannot be and why. */
export function addConfirmText(p: BulkAddPreview): { readonly text: string; readonly canConfirm: boolean } {
  const toAdd = p.rows.filter((r) => r.outcome === "enroll");
  const already = p.counts.alreadyEnrolled > 0 ? `${p.counts.alreadyEnrolled === 1 ? "1 is" : `${p.counts.alreadyEnrolled} are`} already in it and left alone.` : "";
  const notEnrolled = p.rows.flatMap((r) => (r.outcome === "not_enrolled" && r.notEnrolled ? [`${r.row.name}: ${notEnrolledText(r.notEnrolled, r.row)}.`] : []));
  const out = notEnrolled.length > 0 ? `Not added: ${notEnrolled.join(" ")}` : "";
  if (toAdd.length === 0) return { text: [`No one to add to ${p.campaign.name}.`, already, out].filter(Boolean).join(" "), canConfirm: false };
  return { text: [`Add ${selectionWords(toAdd.map((r) => r.row))} to ${p.campaign.name}?`, already, out].filter(Boolean).join(" "), canConfirm: true };
}

/** A bulk press on its way. */
export function bulkPendingText(action: BulkAction, campaign: string | null): string {
  return action === "add" ? `${PENDING.add} to ${campaign ?? "the campaign"}…` : `${PENDING[action]}…`;
}

/** What a bulk control did, from the answer: how many applied, and each lead it was not applied to, with the server's reason. */
export function controlResultText(answer: BulkControlAnswer, labels: Readonly<Record<string, BulkLabel>>): { readonly summary: string; readonly refused: readonly string[] } {
  const total = answer.results.length;
  const { applied } = answer.counts;
  const summary =
    applied === total ? `${PAST[answer.action]} ${enrollments(applied)}.` : applied === 0 ? `Nothing was ${PAST[answer.action].toLowerCase()}.` : `${PAST[answer.action]} ${applied} of ${enrollments(total)}.`;
  const refused = answer.results.flatMap((r) => {
    if (r.outcome !== "refused") return [];
    const label = labels[r.enrollmentId];
    return [`${label ? `${label.name} in ${label.campaign}` : "One campaign enrollment"}: ${r.reason ?? "refused"}`];
  });
  return { summary, refused };
}

/** What add to campaign did, from the answer. */
export function addResultText(answer: BulkAddAnswer): { readonly summary: string; readonly refused: readonly string[] } {
  const parts = [
    answer.counts.enrolled > 0 ? `Added ${selectionWords(answer.results.filter((r) => r.outcome === "enrolled").map((r) => r.row))} to ${answer.campaign.name}.` : `No one was added to ${answer.campaign.name}.`,
    answer.counts.alreadyEnrolled > 0 ? `${answer.counts.alreadyEnrolled === 1 ? "1 was" : `${answer.counts.alreadyEnrolled} were`} already in it.` : "",
  ];
  const refused = answer.results.flatMap((r) => (r.outcome === "not_enrolled" && r.notEnrolled ? [`${r.row.name}: ${notEnrolledText(r.notEnrolled, r.row)}`] : []));
  return { summary: parts.filter(Boolean).join(" "), refused };
}

/**
 * Under the table: what the bulk actions change, as the prototype's foot note says it. The scope is the one the press
 * uses, the campaign Leads is filtered to, named once its name has loaded (council item 9 on 3555a3e).
 */
export function scopeNote(scope: { readonly name: string | null } | null, companies: boolean): string {
  const whose = companies ? "the selected people’s and company leads’ campaigns" : "the selected people’s campaigns";
  if (scope === null) return `Bulk actions change ${whose}. Pick a campaign above to limit them to one campaign.`;
  return `Bulk actions change ${whose} in ${scope.name ?? "the campaign Leads is filtered to"} only.`;
}
