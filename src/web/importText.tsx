import type { ReactNode } from "react";
import type { ContactRoute, DetailNote, EvidenceKind, ImportSummary, LeadOutcome, SummaryEntry } from "../shared/api.ts";

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

/** A row that could not be matched safely, and so changed nothing. */
export type UnmatchedEntry = Extract<SummaryEntry, { reason: "ambiguous_match" }>;

export function isUnmatched(entry: SummaryEntry): entry is UnmatchedEntry {
  return entry.outcome === "not_enrolled" && entry.reason === "ambiguous_match";
}

/** The Result cell: a row that changed nothing is not matched, whatever its person's enrollments. */
export function resultLabel(entry: SummaryEntry): string {
  return isUnmatched(entry) ? "Not matched" : OUTCOME_LABEL[entry.outcome];
}

const EVIDENCE_WORD = {
  place_id: "place ID",
  business_id: "business ID",
  main_line: "main line",
  address: "address",
  name: "name",
  email: "email",
  person_id: "person ID",
  phone: "number",
} as const satisfies Record<EvidenceKind, string>;

/** Where the row is, so it can be found in the file: "People file, row 5". */
export function rowReference(entry: UnmatchedEntry): string {
  const file = entry.file === "people" ? "People file" : "Businesses file";
  return `${file}, ${entry.rowNumbers.length === 1 ? "row" : "rows"} ${joinWords(entry.rowNumbers.map(String))}`;
}

/** Why a row that could not be matched safely changed nothing. */
function unmatchedSentence(entry: UnmatchedEntry): string {
  const kind = entry.record === "person" ? "person" : "company";
  const scope = entry.file === "businesses" ? " for this company or its people" : entry.record === "company" ? " for this person" : "";
  const subject = entry.record === "company" && entry.file === "people" ? "Their company’s row" : "The row";
  if (entry.conflict === "contradiction") {
    const [first, second] = entry.disagreeing;
    if (first === "business_id" && second === "place_id") {
      return `Their business ID is on two businesses with different place IDs in the Businesses file, so nothing was changed${scope}.`;
    }
    if (first === "business_id" && second === undefined) {
      return `Their business ID is on rows of two different businesses in the Businesses file, so nothing was changed${scope}.`;
    }
    const other = entry.disagreeing.filter((d) => d !== "name").map((d) => EVIDENCE_WORD[d]);
    if (entry.disagreeing.includes("name")) {
      return `${subject}’s ${joinWords(other)} ${other.length === 1 ? "belongs" : "belong"} to a ${kind} on record with a different name, so nothing was changed${scope}.`;
    }
    return `${subject}’s ${joinWords(entry.disagreeing.map((d) => EVIDENCE_WORD[d]))} point to different ${kind === "person" ? "people" : "companies"} on record, so nothing was changed${scope}.`;
  }
  if (entry.conflict === "another_row") return `Another row in this file fits the same ${kind} on record, so nothing was changed${scope || " for this row"}.`;
  return entry.record === "person"
    ? `Matches more than one person on record at ${entry.companyName}, and nothing in the row tells them apart. Nothing was changed.`
    : `${entry.file === "businesses" ? "This company" : "Their company"} matches more than one company on record, and nothing in the row tells them apart. Nothing was changed${scope}.`;
}

/** A number or address the row listed that a colleague or another enrolled lead already has, so it stayed theirs. */
function heldSentences(entry: Extract<SummaryEntry, { heldElsewhere: unknown }>): string {
  return entry.heldElsewhere
    .map(({ detail, holder, holderHasIt }) =>
      holderHasIt
        ? ` ${sentenceCase(detailWord(detail, entry.lead.kind))} ${detail.value} is already ${holder}’s, so it wasn’t added.`
        : ` ${sentenceCase(detailWord(detail, entry.lead.kind))} ${detail.value} is also listed for ${holder}, so it was added for neither.`,
    )
    .join("");
}

/** The "What happened" cell for one row of the import summary. */
export function whatHappened(entry: SummaryEntry): ReactNode {
  if (entry.outcome === "not_enrolled") {
    if (entry.reason === "company_not_in_export") return "Their company isn’t in the Businesses file.";
    if (entry.reason === "ambiguous_match") return unmatchedSentence(entry);
    if (entry.reason === "shares_contact") {
      const { detail, lead, companyName, enrolled } = entry.shared;
      const what = `${sentenceCase(detailWord(detail, entry.lead.kind))} ${detail.value}`;
      // The refusal already explains this detail; other details the row lost are still named.
      const others = heldSentences({ ...entry, heldElsewhere: entry.heldElsewhere.filter((h) => h.detail.value !== detail.value) });
      return enrolled
        ? `${what} is already ${lead}’s at ${companyName}, who is enrolled in this campaign, so this lead wasn’t enrolled.${others}`
        : `${what} is also ${lead}’s at ${companyName}, and nothing shows whose it is, so neither lead was enrolled with it in this campaign.${others}`;
    }
    return entry.lead.kind === "company"
      ? "No usable main line or shared inbox."
      : `No personal email or mobile, and ${entry.companyName} has no usable main line.${heldSentences(entry)}`;
  }
  const owner = entry.lead.kind;
  const held = heldSentences(entry);
  const added = [
    ...entry.added.map((d) => `Added ${detailWord(d, owner)} ${d.value}, marked newer.`),
    ...entry.becameMobile.map((d) => `Number ${d.value} is now known to be a mobile, so it can take SMS.`),
  ].join(" ");
  const stillBad = entry.stillBad.map((d) => (
    <span key={`${d.channel}:${d.value}`}>
      {" "}
      {sentenceCase(detailWord(d, owner))} <s className="text-faint">{d.value}</s> is still marked wrong.
    </span>
  ));
  if (entry.outcome === "new") return `${routesSentence(entry)}${held}`;
  if (entry.outcome === "updated") return <>{added}{stillBad}{held}</>;
  return stillBad.length > 0 || held ? <>No new details.{stillBad}{held}</> : "No change.";
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
      parts.push(`${counts.already_enrolled} ${counts.already_enrolled === 1 ? "was already enrolled and carries" : "were already enrolled and carry"} on where they are.`);
    }
  }
  const unmatched = entries.filter(isUnmatched).length;
  const notEnrolled = counts.not_enrolled - unmatched;
  if (notEnrolled > 0) parts.push(`${notEnrolled} ${notEnrolled === 1 ? "row wasn’t" : "rows weren’t"} enrolled; the reasons are below.`);
  if (unmatched > 0) {
    parts.push(`${unmatched} ${unmatched === 1 ? "row couldn’t" : "rows couldn’t"} be matched safely and changed nothing; anyone already enrolled carries on.`);
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
