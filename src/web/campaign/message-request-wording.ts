import type { MessageRequestTrackView, TrackProgressView } from "../../shared/api.ts";
import { isMessageRequestChannel, SOCIAL_CHANNELS } from "../../domain/social-channels.ts";

/**
 * A message-request track's facts on the record (ticket 25; ADR 0004 13.3, 13.4), one sentence each, from what the engine
 * stored and nothing else. "Went" only for a first message recorded sent; one handed over and not yet known is said as
 * exactly that. Nothing is said about acceptance or reading: the platform never tells the sender. **Provisional**
 * wording, for the principal.
 */
export function messageRequestTrackLines(track: Pick<TrackProgressView, "channel" | "finishReason" | "messageRequest">): string[] {
  const view = track.messageRequest;
  if (view === null || !isMessageRequestChannel(track.channel)) return [];
  const name = SOCIAL_CHANNELS[track.channel].name;
  const lines: string[] = [];
  if (track.finishReason === "skipped_missing_channel") return [skipLine(view.skipCause, name)];
  const whose = view.destination === "company" ? `their company’s ${name} account` : `their own ${name} account`;
  const from = view.sender === null ? "" : view.sender.kind === "business" ? " from your business session" : view.sender.kind === "personal" ? " from your personal session" : "";
  if (view.firstMessage === "sent") lines.push(`The first message went to ${whose}${from}, as a message request if they don’t follow you. ${name} doesn’t tell the app whether it was accepted or read.`);
  else if (view.firstMessage === "handed") lines.push(`The first message to ${whose} is with the ${name} session, which hasn’t confirmed whether it went.`);
  else if (view.destination !== null) lines.push(`Messages go to ${whose}.`);
  return lines;
}

/** Why the track was skipped as a missing channel, as recorded when it finished. */
function skipLine(cause: MessageRequestTrackView["skipCause"], name: string): string {
  switch (cause) {
    case "no_profile":
      return `Skipped: neither they nor their company have an ${name} account in the import.`;
    case "not_a_member_profile":
      return `Skipped: the ${name} address in the import isn’t an account’s address.`;
    case "marked_bad":
      return `Skipped: every ${name} account they could be messaged on is marked unreachable.`;
    case "replaced":
      return `Skipped: the ${name} account this track started with was replaced by a later import.`;
    case "removed_by_import":
      return `Skipped: the ${name} account this track started with was removed by a later import.`;
    case "company_lead":
    case "unrecorded":
    case null:
      return `Skipped: there was no usable ${name} account for them at the time.`;
    default: {
      const unhandled: never = cause;
      throw new Error(`A skip with no sentence: ${String(unhandled)}`);
    }
  }
}

/** What a message-request track does, for the inspector's note (ADR 0004 13.3), in the channel's name. **Provisional.** */
export function messageRequestNote(name: string): string {
  return `An ${name} track sends a text-only message to the decision maker’s own ${name} account from the import, or to their company’s when they have none, then follow-ups after their waits. Someone who doesn’t follow your session gets the first message as a message request; ${name} doesn’t tell the app whether they accept or read it. The messages go on until they answer and you mark them replied.`.replace(/^An (?=[^AEIOU])/, "A ");
}

/**
 * What limits a message-request track's messages, for the inspector (ADR 0004 13.4 to 13.7), with how many first messages one
 * company's account can get from this track: one per chosen session, each about a different lead (question Q46).
 */
export function messageRequestLimits(name: string, sessionsChosen: number): string[] {
  const upTo = sessionsChosen <= 1 ? "one first message from this track: the first lead to reach it keeps it, and the others are skipped here" : `up to ${sessionsChosen} first messages from this track, one from each session you chose, each about a different lead`;
  return [
    `Messages go to the decision maker’s own ${name} account from the import, else to their company’s. A lead with neither skips this track, and the tracks after it start.`,
    `Each session sends only within the messages a day you allow it; with none set, it sends nothing. Follow-ups go before first messages.`,
    `People at one company with no account of their own share their company’s account, which can get ${upTo}. An account another campaign already reached from the same session is skipped here, and who reached it is named on the record.`,
    `A personal profile and a business account are used alike; if ${name} refuses a message, the track ends for that lead and says so.`,
  ];
}

/**
 * Before launch's warnings for a message-request channel (ADR 0004 13.4; question Q46), from the read's counts: the leads with
 * no account to message, and the company accounts several leads would share, with how many first messages each can get.
 */
export function messageRequestWarnings(
  name: string,
  leads: number,
  counts: { readonly own: number; readonly company: number; readonly shared: { readonly accounts: number; readonly leads: number } },
  tracks: string,
  hasAfter: boolean,
  sessionsChosen: number,
): { title: string; detail: string }[] {
  const out: { title: string; detail: string }[] = [];
  const none = leads - counts.own - counts.company;
  if (none > 0) out.push({ title: `${none} ${none === 1 ? "lead has" : "leads have"} no ${name} account to message`, detail: `They skip ${tracks}${hasAfter ? ", and the tracks after it start sooner" : ""}. A decision maker’s own account from the import counts, else their company’s.` });
  if (counts.shared.accounts > 0) {
    const each = sessionsChosen <= 1 ? "one first message from each track: the first lead to reach it keeps it, and the others are skipped" : `up to ${sessionsChosen} first messages from each track, one from each session chosen there, each about a different lead`;
    out.push({
      title: `${counts.shared.leads} leads share ${counts.shared.accounts} company ${name} ${counts.shared.accounts === 1 ? "account" : "accounts"}`,
      detail: `They have no account of their own, so their messages go to their company’s. Each such account can get ${each}.`,
    });
  }
  return out;
}

/**
 * A message-request channel's own reasons, said in its name (ADR 0004 13.3, 13.4, Q44): every reason the engine records for
 * such a step, through one exhaustive mapping; null for a reason no message-request step records.
 */
export const MESSAGE_REQUEST_REASONS = ["no_account", "account unreachable", "not allowed"] as const;
export type MessageRequestReason = (typeof MESSAGE_REQUEST_REASONS)[number];
export function messageRequestReason(name: string, reason: string): string | null {
  const known = (MESSAGE_REQUEST_REASONS as readonly string[]).includes(reason) ? (reason as MessageRequestReason) : null;
  switch (known) {
    case null:
      return null;
    case "no_account":
      return `Neither they nor their company have an ${name} account in the import.`;
    case "account unreachable":
      return `${name} refused the account as unreachable. It is marked wrong.`;
    case "not allowed":
      return `${name} didn’t allow the message: they may have message requests turned off. The account isn’t marked wrong.`;
    default: {
      const unhandled: never = known;
      throw new Error(`A reason with no sentence: ${String(unhandled)}`);
    }
  }
}
