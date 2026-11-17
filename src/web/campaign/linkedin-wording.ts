/**
 * What the record, Needs attention and the reply mark say about a LinkedIn track (ticket 24b; ADR 0004 sections 3, 7 and
 * 9), each sentence from one field of the server's read (`TrackProgressView.linkedin`, its finish, `NeedsAttention`) and
 * nothing computed beside it. Every mapping over a state is exhaustive, so a state a later ticket adds (the InMail of
 * ticket 27) fails typecheck until it has its words. Days are said in the user's zone, as the read gives them. History is
 * said in the past tense; a present state only as the read says it at its instant. Provisional wording, for the principal.
 */
import type { ReplyMark, LinkedinTrackView, NeedsAttention, OutreachStatus, TrackProgressView } from "../../shared/api.ts";
import { statusGroup } from "../../domain/outreach-status.ts";
import type { AttentionItem } from "../calls/wording.ts";
import { dateIn } from "../calls/wording.ts";
import { conversationTaken } from "./sms-wording.ts";
import { markRepliedWords } from "./reply-mark-wording.ts";

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

/**
 * What became of the invite after the acceptance wait ended with no acceptance recorded (3.3), by the withdrawal's stored
 * state, and nothing more: "withdrawn" only once LinkedIn or the user said so (council on dee365d, item 2). `whom` is "them"
 * on the record and "this test" on the Test run tab, which says it through this same function.
 */
export function expiryLine(withdrawal: LinkedinTrackView["withdrawal"], whom: "them" | "this test" = "them", ask: Pick<LinkedinTrackView, "withdrawalAsked" | "withdrawalStuck"> = { withdrawalAsked: false, withdrawalStuck: false }): string {
  const ended = `No acceptance was recorded within the track’s wait, so the LinkedIn track ended for ${whom}`;
  switch (withdrawal) {
    case null:
      return `${ended}.`;
    // Asked only once the read says the session was asked (council on a6c1700, item 9); stuck said once, here (item 7).
    case "wanted":
      if (ask.withdrawalStuck) return `${ended}. The app has asked LinkedIn to withdraw the invite, and LinkedIn hasn’t answered whether it did: check ${whom === "them" ? "their profile" : "your test profile"} on LinkedIn and say what you found.`;
      return ask.withdrawalAsked ? `${ended}. The app has asked LinkedIn to withdraw the invite; it isn’t confirmed withdrawn yet.` : `${ended}. The invite is to be withdrawn; the app hasn’t asked LinkedIn yet.`;
    case "withdrawn":
      return `${ended}, and the invite was withdrawn.`;
    case "accepted_first":
      return `${ended}. Asked to withdraw the invite, LinkedIn showed it had been accepted first, so it wasn’t withdrawn.`;
    case "kept_by_user":
      return `${ended}. You marked the invite as still there on LinkedIn, so it wasn’t withdrawn.`;
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
  if (track.finishReason === "skipped_missing_channel") lines.push(`The LinkedIn track was skipped: ${SKIP_CAUSE[view?.skipCause ?? "no_profile"]}.`);
  // A pair another campaign holds (Q41): named by the one conversation wording, in LinkedIn's words.
  if (track.finishReason === "skipped_conversation_taken") lines.push(`The LinkedIn track was skipped: ${conversationTaken(track.conversationOwners, "linkedin")}.`);
  if (view === null) return lines;
  // The note as it went only once the invite is recorded sent (council on dee365d, item 11); handed over and not known to
  // have gone, it is said as the engine holds it, in the unresolved state's words.
  if (view.invite === "sent" && view.note !== null) lines.push(noteLine(view.note));
  if (view.invite === "handed") lines.push(INVITE_HANDED);
  const connected = connectionLine(view, userZone);
  if (connected) lines.push(connected);
  const inmail = inmailLine(view, userZone);
  if (inmail) lines.push(inmail);
  // An acceptance recorded after the InMail went, on its own line (council on 8b0c846, item 9).
  if (view.inmail.state === "sent" && view.acceptedAt && view.connection === null && !view.acceptedAfterFinish) lines.push(`They accepted the invite by ${dateIn(userZone, view.acceptedAt)}, after the InMail went; the follow-ups go on as before.`);
  if (view.inmail.on && view.inmail.state === null && view.invite === "sent" && view.connection === null && track.finishReason === null) lines.push(INMAIL_AT_THE_END);
  if (track.finishReason === "invite_not_accepted") lines.push(expiryLine(view.withdrawal, "them", view));
  // An acceptance recorded after the track ended (council on dee365d, item 14): said as recorded late, with the time
  // LinkedIn gave for it, which the port's contract allows to be an upper bound ("by"), never as accepted late.
  if (view.acceptedAfterFinish) {
    lines.push(`Their acceptance of the invite was recorded after this track had ended${view.acceptedAt ? `; LinkedIn shows they had accepted it by ${dateIn(userZone, view.acceptedAt)}` : ""}. You are connected now, and may want to write to them on LinkedIn yourself.`);
  }
  // Q38's interim, and every other ending the engine leaves an invite open through (council on dee365d, item 6): only the
  // acceptance expiry asks for a withdrawal, so a stop, a reply on any channel, a move to win-back, an ending with no
  // channel left or an edit that removes the track leaves a sent invite open. Said once the track has ended or the lead no
  // longer runs, and only while no withdrawal was asked for: an expiry's withdrawal is said by its own line.
  // With the InMail fallback chosen, the InMail's own line says the invite stays open (ADR 0004 14.7).
  const fallbackTaken = view.inmail.state === "chosen" || view.inmail.state === "sent";
  if (view.inviteOpen && view.withdrawal === null && !fallbackTaken && (track.finishReason !== null || statusGroup(status) === "handed_to_you" || statusGroup(status) === "ended")) lines.push(INVITE_STILL_OPEN);
  if (view.pendingElsewhereSince) lines.push(`An invite to them was already pending on LinkedIn, not sent by this application (first seen ${dateIn(userZone, view.pendingElsewhereSince)}). This track waits until it is accepted or gone.`);
  return lines;
}

/**
 * The InMail fallback on the record (ticket 27; ADR 0004 14.7), one sentence by its stored facts and nothing more: the InMail
 * said as gone only once recorded sent, with the session while handed over, to go while chosen; why it did not go, by its
 * stored cause, before the expiry's own line; while still waiting for acceptance with the fallback on, what the end of the
 * wait does. Provisional sentences, for the principal.
 */
export function inmailLine(view: Pick<LinkedinTrackView, "inmail" | "inviteOpen">, userZone: string): string | null {
  const inmail = view.inmail;
  const state = inmail.state;
  // Eligibility is said as of the session's report the expiry read (council on 8b0c846, item 5).
  const asReported = inmail.reportedAt ? `as your session last reported on ${dateIn(userZone, inmail.reportedAt)}` : "your session had reported nothing about InMail";
  // The invite is said as open only while the read says so (council on 8b0c846, item 9).
  const open = view.inviteOpen ? " The invite stays open on LinkedIn." : "";
  switch (state) {
    case null:
      return null;
    // Chosen is not a promise (item 6): it may wait on a credit; the next step's line says why it waits.
    case "chosen":
      return inmail.work === "handed"
        ? `No acceptance was recorded within the track’s wait, so the InMail fallback was chosen; the InMail is with the LinkedIn session, which hasn’t confirmed whether it went.${open}`
        : `No acceptance was recorded within the track’s wait, so the InMail fallback was chosen (${asReported}, it had a credit free). It hasn’t gone.${open}`;
    case "sent":
      return `No acceptance was recorded within the track’s wait, so the InMail went instead${inmail.sentAt ? ` on ${dateIn(userZone, inmail.sentAt)}` : ""}. The first message isn’t sent; the follow-ups wait their days from the InMail.${open}`;
    case "accepted":
      return "They accepted the invite after the wait ended and before any InMail was handed over, so none was sent; the first message follows their acceptance.";
    case "no_plan":
      return inmail.reportedAt ? `The InMail fallback didn’t go: when the wait ended, the session that sent the invite didn’t report Premium or Sales Navigator, ${asReported}.` : "The InMail fallback didn’t go: when the wait ended, the session that sent the invite had reported nothing about InMail.";
    case "no_credit":
      return `The InMail fallback didn’t go: when the wait ended, the session that sent the invite had no InMail credit free, ${asReported}.`;
    case "stale_report":
      return `The InMail fallback didn’t go: when the wait ended, the session that sent the invite hadn’t reported for over a day${inmail.reportedAt ? ` (its last report was on ${dateIn(userZone, inmail.reportedAt)})` : ""}, too long to judge it on.`;
    case "refused":
      return "The InMail fallback didn’t go: LinkedIn refused the InMail for this person. Their profile isn’t marked wrong.";
    case "switched_off":
      return "The InMail fallback didn’t go: you switched it off before it was handed over.";
    case "skipped_by_user":
      return "The InMail fallback didn’t go: you skipped it.";
    default: {
      const unhandled: never = state;
      throw new Error(`An InMail state with no words: ${String(unhandled)}`);
    }
  }
}

/**
 * What the end of the wait does on the withdrawal path, as every editor sentence says it (council on 8b0c846, item 11): the
 * app asks LinkedIn to withdraw the invite; it is never said as withdrawn before LinkedIn or the user says so.
 */
export const ENDS_AND_ASKS_WITHDRAWAL = "this track ends for them and the app asks LinkedIn to withdraw the invite";

/** While a lead waits for acceptance on a track with the fallback on: what the end of the wait does (ADR 0004 14.7). */
export const INMAIL_AT_THE_END = "If they haven’t accepted by the end of the wait, an InMail goes instead, if your session can send one then.";

/** Q38's interim, on the record (ADR 0004 3.4), for every ending but the acceptance expiry (council on a6c1700, item 6). */
export const INVITE_STILL_OPEN = "The connection invite sent from this campaign is still open on LinkedIn. The app asks LinkedIn to withdraw an invite only when the wait for acceptance runs out, so this one stays until they answer it or you withdraw it on LinkedIn.";

/** Why a LinkedIn track was skipped as a missing channel, by the read's stored cause (council on a6c1700, item 10). */
export const SKIP_CAUSE: Readonly<Record<NonNullable<LinkedinTrackView["skipCause"]>, string>> = {
  no_profile: "there is no LinkedIn address for them in the import",
  not_a_member_profile: "the LinkedIn address in the import isn’t a member profile (a company page, for one), so it can’t receive an invite",
  company_lead: "a company lead has no member profile to invite",
  replaced: "a later import gave them a different LinkedIn profile, so the one this track started with is no longer theirs",
  removed_by_import: "a later import no longer has the LinkedIn profile this track started with",
  // A skip recorded before its cause was kept: only what is known.
  unrecorded: "there was no usable LinkedIn member profile for them at the time",
  marked_bad: "their LinkedIn profile is marked unreachable",
};

/** An invite handed to the session and not known to have gone: the unresolved state's words (`HOLD_CLAUSE.unresolved`). */
export const INVITE_HANDED = "The connection invite is with the LinkedIn session, which hasn’t confirmed whether it went.";

/** What a stop or a move to win-back leaves on LinkedIn, in its confirmation, while the read says an invite is open (item 6). */
export const INVITE_STAYS_OPEN = {
  stop: "The LinkedIn invite already sent stays open on LinkedIn: stopping doesn’t withdraw it.",
  move_to_win_back: "The LinkedIn invite already sent stays open on LinkedIn: moving to win-back doesn’t withdraw it.",
} as const;

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
export const MARK_REPLIED = markRepliedWords("linkedin");

/**
 * What a test run's LinkedIn reply mark is for, said from the work that allows it (review bot on c20c8f0): the read's own
 * `linkedinReply.work`, the work the engine's rule found, by its kind and whether it is recorded sent. Four sentences, one
 * per case, through an exhaustive mapping; nothing is inferred from which other fields are empty.
 */
export function testReplyHelper(work: Extract<ReplyMark, { allowed: true }>["work"]): string {
  const after = "mark it once you have written back on LinkedIn from your test profile.";
  switch (`${work.kind}:${work.state}` as const) {
    case "message:sent":
      return "Once you have answered a test message on your test profile.";
    case "invite:sent":
      return `Only the test invite has gone so far: ${after}`;
    case "message:handed":
      return `A test message is with the LinkedIn session, which hasn’t confirmed whether it went: ${after}`;
    case "invite:handed":
      return `The test invite is with the LinkedIn session, which hasn’t confirmed whether it went: ${after}`;
    default: {
      const unhandled: never = `${work.kind}:${work.state}` as never;
      throw new Error(`A reply mark's work with no words: ${String(unhandled)}`);
    }
  }
}
