/**
 * Exactly three launch blockers (ADR 0003 7.2; spec "Before launch"), plus the interim
 * "nothing to launch" precondition (Q9). Everything else is a warning.
 */
import { mergeUses, render, type MergeData } from "./copy.ts";
import { liveSteps, liveTracks, ownSubject, poolOf, type CampaignDefinition } from "./definition.ts";

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
  | { readonly kind: "no_sender"; readonly trackId: string; readonly channel: string; readonly message: string };

export interface SenderAccountView {
  readonly id: string;
  readonly channel: "email" | "sms";
  readonly healthy: boolean;
}

export const NOTHING_TO_LAUNCH = "Add a track to launch.";

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
      if (track.channel === "email" && step.threading === "new_subject" && step.subject.trim() === "") {
        blockers.push({ kind: "empty_copy", trackId: track.id, stepId: step.id, stepNumber: i + 1, part: "subject", message: `Email ${i + 1} has no subject.` });
      }
      if (step.body.trim() === "") {
        blockers.push({ kind: "empty_copy", trackId: track.id, stepId: step.id, stepNumber: i + 1, part: "body", message: `${track.channel === "email" ? "Email" : "Text"} ${i + 1} has no message.` });
      }
    });
  }

  const fieldsWithoutFallback = new Map<string, { trackId: string; stepId: string; stepNumber: number }[]>();
  for (const track of tracks) {
    if (track.channel === "call") continue;
    liveSteps(track).forEach((step, i) => {
      for (const use of [...mergeUses(track.channel === "sms" ? "" : ownSubject(step)), ...mergeUses(step.body)]) {
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
    const pool = poolOf(def, track.channel);
    const connected = accounts.some((a) => a.channel === track.channel && a.healthy && pool.includes(a.id));
    if (!connected) {
      blockers.push({
        kind: "no_sender",
        trackId: track.id,
        channel: track.channel,
        message: track.channel === "email" ? "The email track has no connected sender inbox." : "The SMS track has no connected sender number.",
      });
    }
  }

  const nothingToLaunch = liveTracks(def, "main").length === 0;
  return { blockers, nothingToLaunch, canLaunch: blockers.length === 0 && !nothingToLaunch };
}
