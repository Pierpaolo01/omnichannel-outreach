/**
 * Exactly three launch blockers (ADR 0003 7.2; spec "Before launch"), plus the interim
 * "nothing to launch" precondition (Q9). Everything else is a warning.
 */
import { mergeUses, render, type MergeData } from "./copy.ts";
import { liveSteps, liveTracks, ownSubject, type CampaignDefinition } from "./definition.ts";

export type LaunchBlocker =
  | { readonly kind: "empty_copy"; readonly trackId: string; readonly stepId: string; readonly stepNumber: number; readonly part: "subject" | "body"; readonly message: string }
  | { readonly kind: "missing_merge_field"; readonly field: string; readonly leadsMissing: number; readonly message: string }
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

  const fieldsWithoutFallback = new Set<string>();
  for (const track of tracks) {
    if (track.channel === "call") continue;
    for (const step of liveSteps(track)) {
      for (const use of [...mergeUses(ownSubject(step)), ...mergeUses(step.body)]) if (use.fallback === null) fieldsWithoutFallback.add(use.field);
    }
  }
  for (const field of [...fieldsWithoutFallback].sort()) {
    const leadsMissing = leads.filter((lead) => !render(`{{${field}}}`, lead).ok).length;
    if (leadsMissing > 0) {
      blockers.push({
        kind: "missing_merge_field",
        field,
        leadsMissing,
        message: `${leadsMissing} ${leadsMissing === 1 ? "lead has" : "leads have"} no ${field.replace(/_/g, " ")}, and {{${field}}} has no fallback.`,
      });
    }
  }

  for (const track of tracks) {
    if (track.channel === "call") continue;
    const pool = track.channel === "email" ? def.emailPool : [];
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
