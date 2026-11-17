/**
 * What the record, Needs attention and the reply mark say about a LinkedIn track (ticket 24b; ADR 0004 sections 3, 7 and
 * 9), each sentence from one field of the server's read (`TrackProgressView.linkedin`, its finish, `NeedsAttention`) and
 * nothing computed beside it. Every mapping over a state is exhaustive, so a state a later ticket adds (the InMail of
 * ticket 27) fails typecheck until it has its words. Days are said in the user's zone, as the read gives them. History is
 * said in the past tense; a present state only as the read says it at its instant. Provisional wording, for the principal.
 */
import type { LinkedinTrackView, NeedsAttention, OutreachStatus, TrackProgressView } from "../../shared/api.ts";
import { statusGroup } from "../../domain/outreach-status.ts";
import type { AttentionItem } from "../calls/wording.ts";
import { dateIn } from "../calls/wording.ts";
import { conversationTaken } from "./sms-wording.ts";

/** How the invite's note went, from the choice stored with the work at the handover (ADR 0004 section 4). */
export function noteLine(note: NonNullable<LinkedinTrackView["note"]>): string {
  switch (note) {
    case "with":
      return "The connection invite went with its note.";
    case "withheld":
      return "The connection invite went without its note: the session’s note allowance for the month was used up.";
    case "none":
      return "The connection invite went without a note, as written.";
    default: {
      const unhandled: never = note;
      throw new Error(`A note state with no words: ${String(unhandled)}`);
    }
  }
}

/** How the track connected, and when (the acceptance, or the check that found a connection). */
function connectionLine(view: LinkedinTrackView, userZone: string): string | null {
  const how = view.connection;
  switch (how) {
    case null:
      return null;
    case "accepted":
      return view.connectedAt ? `They accepted the invite on ${dateIn(userZone, view.connectedAt)}.` : "They accepted the invite.";
    case "already_connected":
      return "Your LinkedIn session was already connected to them, so no invite was sent.";
    default: {
      const unhandled: never = how;
      throw new Error(`A connection with no words: ${String(unhandled)}`);
    }
  }
}

/** What became of the invite after the acceptance wait ended with no acceptance (3.3), by the withdrawal's stored state. */
export function expiryLine(withdrawal: LinkedinTrackView["withdrawal"]): string {
  const ended = "The invite wasn’t accepted within the track’s wait, so the LinkedIn track ended for them";
  switch (withdrawal) {
    case null:
      return `${ended}.`;
    case "wanted":
      return `${ended}. The invite is being withdrawn.`;
    case "withdrawn":
      return `${ended}, and the invite was withdrawn.`;
    case "accepted_first":
      return `${ended}. When it was withdrawn, LinkedIn showed they had accepted it first.`;
    case "kept_by_user":
      return `${ended}. You marked the invite as still there on LinkedIn, so it was left open.`;
    default: {
      const unhandled: never = withdrawal;
      throw new Error(`A withdrawal state with no words: ${String(unhandled)}`);
    }
  }
}

/**
 * Every LinkedIn sentence for one campaign row, in a fixed order: the note, the connection, why the track ended, an
 * acceptance after it ended, an invite left open on an ended lead (Q38), an invite pending from elsewhere (Q42), and a
 * withdrawal LinkedIn never confirmed. `status` is the read's, so "ended" is the read's word, never inferred.
 */
export function linkedinTrackLines(track: Pick<TrackProgressView, "channel" | "finishReason" | "conversationOwners" | "linkedin">, status: OutreachStatus, userZone: string): string[] {
  if (track.channel !== "linkedin") return [];
  const lines: string[] = [];
  const view = track.linkedin;
  if (track.finishReason === "skipped_missing_channel") lines.push("The LinkedIn track was skipped: there is no LinkedIn member profile for them in the import.");
  // A pair another campaign holds (Q41): named by the one conversation wording, in LinkedIn's words.
  if (track.finishReason === "skipped_conversation_taken") lines.push(`The LinkedIn track was skipped: ${conversationTaken(track.conversationOwners, "linkedin")}.`);
  if (view === null) return lines;
  if (view.note !== null) lines.push(noteLine(view.note));
  const connected = connectionLine(view, userZone);
  if (connected) lines.push(connected);
  if (track.finishReason === "invite_not_accepted") lines.push(expiryLine(view.withdrawal));
  if (view.acceptedAfterFinish) {
    lines.push(`${view.acceptedAt ? `They accepted the invite on ${dateIn(userZone, view.acceptedAt)}` : "They accepted the invite"}, after this track had ended. You are connected now, and may want to write to them on LinkedIn yourself.`);
  }
  // Q38's interim: a stop or a reply leaves an invite already sent pending on LinkedIn. Said once the lead no longer runs,
  // and only while no withdrawal was asked for: an expiry's withdrawal is said by its own line.
  if (view.inviteOpen && view.withdrawal === null && (statusGroup(status) === "handed_to_you" || statusGroup(status) === "ended")) lines.push(INVITE_STILL_OPEN);
  if (view.pendingElsewhereSince) lines.push(`An invite to them was already pending on LinkedIn, not sent by this application (first seen ${dateIn(userZone, view.pendingElsewhereSince)}). This track waits until it is accepted or gone.`);
  if (view.withdrawalStuck) lines.push("LinkedIn hasn’t confirmed the invite was withdrawn. Check their profile on LinkedIn and say what you found.");
  return lines;
}

/** Q38's interim, on the record (ADR 0004 3.4). */
export const INVITE_STILL_OPEN = "The connection invite sent from this campaign is still open on LinkedIn: ending their outreach here doesn’t withdraw it. Withdraw it on LinkedIn if you want it gone.";

/** The two answers to a withdrawal LinkedIn never confirmed (ADR 0004 3.3), as the record offers them. */
export const WITHDRAWAL_ANSWERS = [
  { answer: "withdrawn", label: "It’s withdrawn", done: "Marked withdrawn. The invite no longer holds this person for this session." },
  { answer: "kept", label: "It’s still there", done: "Marked still there. The app stops asking LinkedIn to withdraw it." },
] as const;

/**
 * Needs attention's entry for each withdrawal LinkedIn keeps answering unknown (ADR 0004 3.3; council on 194fc44, item 5):
 * one entry per lead, naming them, the campaign and how many answers came back unknown, linking to the record, where the
 * user gives one of the two answers.
 */
export function withdrawalStuckItems(stuck: NonNullable<NeedsAttention["inviteWithdrawalsUnknown"]>): AttentionItem[] {
  return stuck.map((w) => {
    const name = w.person?.name ?? w.company.name;
    return {
      key: `invite-withdrawal-${w.enrollmentId}-${w.trackId}`,
      tone: "pause" as const,
      title: `Check whether ${name}’s LinkedIn invite was withdrawn`,
      body: `In ${w.campaign.name}, the LinkedIn session answered “unknown” ${w.unknownAnswers} times when asked to withdraw the invite. Check on LinkedIn, then mark it withdrawn or still there on their record.`,
      action: { label: "Open record", href: w.person ? `/leads/people/${w.person.id}` : `/leads/companies/${w.company.id}`, ariaLabel: `Open ${name}’s record` },
    };
  });
}

/** The reply mark's confirmation and answer (ADR 0004 section 7): a mark of the user's, never a detected reply. */
export const MARK_REPLIED = {
  label: "Mark replied on LinkedIn",
  pending: "Marking replied on LinkedIn",
  preview: "Mark them replied on LinkedIn? Their outreach in this campaign stops, as any reply stops it, and nothing more goes to them here. Carry on the conversation on LinkedIn.",
  done: "Marked replied on LinkedIn. Carry on the conversation on LinkedIn.",
} as const;
