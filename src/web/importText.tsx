import type { ReactNode } from "react";
import type { ContactRoute, DetailNote, ImportSummary, LeadOutcome, SummaryEntry } from "../shared/api.ts";

/** Words for the import summary: outcomes, the routes a lead can be reached on, and what changed. */

export const OUTCOME_LABEL = {
  new: "New",
  already_enrolled: "Already enrolled",
  updated: "Updated",
  not_enrolled: "Not enrolled",
} as const satisfies Record<LeadOutcome, string>;

/** Order of the groups on the results page: what needs a look first. */
export const OUTCOME_ORDER: readonly LeadOutcome[] = ["not_enrolled", "new", "updated", "already_enrolled"];

const ROUTE_WORD = {
  email: "email",
  mobile: "mobile",
  direct: "direct line",
  shared_inbox: "shared inbox",
  main_line: "main line",
} as const satisfies Record<ContactRoute, string>;

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1) ?? ""}`;
}

export function detailWord(detail: DetailNote, owner: "person" | "company"): string {
  if (detail.channel === "email") return owner === "company" ? "shared inbox" : "email";
  if (detail.phoneKind === "main_line") return "main line";
  return detail.phoneKind === "mobile" ? "mobile" : "direct line";
}

function routesSentence(entry: Extract<SummaryEntry, { channels: unknown }>): string {
  const words = entry.via.map((route) => ROUTE_WORD[route]);
  if (entry.lead.kind === "company") {
    const base = `${sentenceCase(joinWords(words))}${words.length === 1 ? " only" : ""}.`;
    return entry.peopleAtCompany > 0
      ? `${base} Its decision makers can’t be reached, so their names stay on the record for calls.`
      : base;
  }
  if (entry.via.length === 1 && entry.via[0] === "main_line") return "Main line only, so phone steps only.";
  if (!entry.via.includes("main_line")) return `${sentenceCase(joinWords(words))} only. No main line for calls.`;
  return `${sentenceCase(joinWords(words))}.`;
}

/** The "What happened" cell for one row of the import summary. */
export function whatHappened(entry: SummaryEntry): ReactNode {
  if (entry.outcome === "not_enrolled") {
    if (entry.reason === "company_not_in_export") return "Their company isn’t in the Businesses file.";
    return entry.lead.kind === "company"
      ? "No main line or shared inbox in the file."
      : `No personal email or mobile, and ${entry.companyName} has no main line in the file.`;
  }
  const owner = entry.lead.kind;
  const added = entry.added.map((d) => `Added ${detailWord(d, owner)} ${d.value}, marked newer.`).join(" ");
  const stillBad = entry.stillBad.map((d) => (
    <span key={`${d.channel}:${d.value}`}>
      {" "}
      {sentenceCase(detailWord(d, owner))} <s className="text-faint">{d.value}</s> is still marked wrong.
    </span>
  ));
  if (entry.outcome === "new") return routesSentence(entry);
  if (entry.outcome === "updated") return <>{added}{stillBad}</>;
  return stillBad.length > 0 ? <>No new details.{stillBad}</> : "No change.";
}

/** The sentence under the results heading. */
export function resultLede(summary: ImportSummary, firstImport: boolean): string {
  const { counts, entries } = summary;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  if (firstImport) {
    const companyLeads = entries.filter((e) => e.outcome === "new" && e.lead.kind === "company").length;
    const people = counts.new - companyLeads;
    parts.push(
      `${plural(counts.new, "new lead", "new leads")}: ${plural(people, "decision maker", "decision makers")} and ${plural(companyLeads, "company lead", "company leads")}.`,
    );
  } else {
    parts.push(`${plural(counts.new, "new lead", "new leads")} and ${counts.updated} updated.`);
    if (counts.already_enrolled > 0) {
      parts.push(`${counts.already_enrolled} ${counts.already_enrolled === 1 ? "was" : "were"} already enrolled and carry on where they are.`);
    }
  }
  if (counts.not_enrolled > 0) {
    parts.push(`${counts.not_enrolled} ${counts.not_enrolled === 1 ? "row wasn’t" : "rows weren’t"} enrolled; the reasons are below.`);
  }
  return parts.join(" ");
}

/** "today at 16:40" or "9 November at 16:40", in the user's time. */
export function whenImported(iso: string, now: Date): string {
  const at = new Date(iso);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  const sameDay = at.toDateString() === now.toDateString();
  const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" }).format(at);
  return sameDay ? `today at ${time}` : `${day} at ${time}`;
}
