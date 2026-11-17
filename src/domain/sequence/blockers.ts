/**
 * Exactly three launch blockers (ADR 0003 7.2; spec "Before launch"), plus the interim
 * "nothing to launch" precondition (Q9). Everything else is a warning.
 */
import { mergeUses, render, type MergeData } from "./copy.ts";
import { liveSteps, liveTracks, ownSubject, trackPool, type CampaignDefinition, type SendChannel, linkedinStepKind } from "./definition.ts";
import { isMessageRequestChannel, SOCIAL_CHANNELS } from "../social-channels.ts";

export type LaunchBlocker =
  | { readonly kind: "empty_copy"; readonly trackId: string; readonly stepId: string; readonly stepNumber: number; readonly part: "subject" | "body"; readonly message: string }
  | {
      readonly kind: "missing_merge_field";
      readonly field: string;
      readonly leadsMissing: number;
      readonly message: string;
      /** Every live message that uses the field with no fallback, by track and its number in the track (ticket 13b). */
      readonly uses: readonly { readonly trackId: string; readonly stepId: string; readonly stepNumber: number }[];
    }
  /** `noneChosen`: a message-request track whose user chose no sender session (ADR 0004 13.5). */
  | { readonly kind: "no_sender"; readonly trackId: string; readonly channel: string; readonly noneChosen?: boolean; readonly message: string };

export interface SenderAccountView {
  readonly id: string;
  readonly channel: SendChannel;
  readonly healthy: boolean;
}

export const NOTHING_TO_LAUNCH = "Add a track to launch.";

/** A step's noun in an empty-copy blocker, per sending channel. */
const STEP_NOUN = (channel: SendChannel): string => (channel === "email" ? "Email" : channel === "sms" ? "Text" : channel === "linkedin" ? "LinkedIn step" : `${SOCIAL_CHANNELS[channel].name} message`);

/** Launch blocker 3's sentence per sending channel (ADR 0003 7.2; ADR 0004 1.1, 13.1): a social channel's from the registry. */
function noSenderMessage(channel: SendChannel): string {
  if (channel === "email") return "The email track has no connected sender inbox.";
  if (channel === "sms") return "The SMS track has no connected sender number.";
  const name = SOCIAL_CHANNELS[channel].name;
  return `The ${name} track has no connected ${name} session.`;
}

export interface LaunchCheck {
  readonly blockers: readonly LaunchBlocker[];
  /** The main sequence has no live track (ADR 0003 7.2, Q9). Not a blocker: there is nothing to launch. */
  readonly nothingToLaunch: boolean;
  readonly canLaunch: boolean;
}

/**
 * `leads` are the merge data of every enrollment of the campaign that has not ended.
 */
export function launchCheck(def: CampaignDefinition, leads: readonly MergeData[], accounts: readonly SenderAccountView[]): LaunchCheck {
  const blockers: LaunchBlocker[] = [];
  const tracks = [...liveTracks(def, "main"), ...liveTracks(def, "win_back")];

  for (const track of tracks) {
    if (track.channel === "call") continue;
    liveSteps(track).forEach((step, i) => {
      // A LinkedIn invite with no note is a plain invite, a choice, not empty copy (ADR 0004 3.1).
      if (linkedinStepKind(track, step.id) === "invite") return;
      if (track.channel === "email" && step.threading === "new_subject" && step.subject.trim() === "") {
        blockers.push({ kind: "empty_copy", trackId: track.id, stepId: step.id, stepNumber: i + 1, part: "subject", message: `Email ${i + 1} has no subject.` });
      }
      if (step.body.trim() === "") {
        blockers.push({ kind: "empty_copy", trackId: track.id, stepId: step.id, stepNumber: i + 1, part: "body", message: `${STEP_NOUN(track.channel as SendChannel)} ${i + 1} has no message.` });
      }
    });
  }

  const fieldsWithoutFallback = new Map<string, { trackId: string; stepId: string; stepNumber: number }[]>();
  for (const track of tracks) {
    if (track.channel === "call") continue;
    liveSteps(track).forEach((step, i) => {
      for (const use of [...mergeUses(track.channel === "email" ? ownSubject(step) : ""), ...mergeUses(step.body)]) {
        if (use.fallback !== null) continue;
        const uses = fieldsWithoutFallback.get(use.field) ?? [];
        if (!uses.some((u) => u.stepId === step.id)) uses.push({ trackId: track.id, stepId: step.id, stepNumber: i + 1 });
        fieldsWithoutFallback.set(use.field, uses);
      }
    });
  }
  for (const field of [...fieldsWithoutFallback.keys()].sort()) {
    const leadsMissing = leads.filter((lead) => !render(`{{${field}}}`, lead).ok).length;
    if (leadsMissing > 0) {
      blockers.push({
        kind: "missing_merge_field",
        field,
        leadsMissing,
        message: `${leadsMissing} ${leadsMissing === 1 ? "lead has" : "leads have"} no ${field.replace(/_/g, " ")}, and {{${field}}} has no fallback.`,
        uses: fieldsWithoutFallback.get(field) ?? [],
      });
    }
  }

  for (const track of tracks) {
    if (track.channel === "call") continue;
    // Per channel: an email inbox never counts for an SMS track, nor a number for an email track.
    const pool = trackPool(def, track);
    const connected = accounts.some((a) => a.channel === track.channel && a.healthy && pool.includes(a.id));
    // Launch blocker 3 (ADR 0003 7.2): a track none of whose senders is connected; on a message-request track, also one whose
    // user chose no session at all (ADR 0004 13.5), said as that.
    const noneChosen = isMessageRequestChannel(track.channel) && pool.length === 0;
    if (!connected) {
      blockers.push({
        kind: "no_sender",
        trackId: track.id,
        channel: track.channel,
        noneChosen,
        message: noneChosen && isMessageRequestChannel(track.channel) ? `The ${SOCIAL_CHANNELS[track.channel].name} track has no sender session chosen.` : noSenderMessage(track.channel),
      });
    }
  }

  const nothingToLaunch = liveTracks(def, "main").length === 0;
  return { blockers, nothingToLaunch, canLaunch: blockers.length === 0 && !nothingToLaunch };
}
