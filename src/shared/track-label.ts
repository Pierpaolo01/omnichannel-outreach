/**
 * A track's name, from its own channel and its order among that channel's tracks, never its
 * position among all tracks (ticket 13b): "Email track" when it is the only one on its channel,
 * otherwise "Email track 2". The editor, Before launch and Activity all name tracks this way. A track
 * of the win-back branch is counted within that branch and named for it: "Win-back email track" (ticket 16).
 */
import type { CampaignDefinition, TrackDefinition } from "../domain/sequence/definition.ts";

const WORD = { email: "Email", sms: "SMS", call: "Phone" } as const;

export interface TrackLabel {
  readonly label: string;
  /** The campaign has more than one track on this channel, so the label carries a number. */
  readonly several: boolean;
}

export function trackLabel(def: CampaignDefinition, track: Pick<TrackDefinition, "id" | "channel">): TrackLabel {
  const branch = def.tracks.find((t) => t.id === track.id)?.branch ?? "main";
  const same = def.tracks.filter((t) => t.channel === track.channel && t.branch === branch && (!t.removed || t.id === track.id));
  const word = branch === "win_back" ? `Win-back ${WORD[track.channel] === "SMS" ? "SMS" : WORD[track.channel].toLowerCase()}` : WORD[track.channel];
  if (same.length <= 1) return { label: `${word} track`, several: false };
  return { label: `${word} track ${same.findIndex((t) => t.id === track.id) + 1}`, several: true };
}

/** A track's name inside a sentence: "the email track", "the SMS track", "email track 2", "SMS track 2", "the phone track". */
export function trackPhrase(def: CampaignDefinition, track: Pick<TrackDefinition, "id" | "channel">): string {
  const { label, several } = trackLabel(def, track);
  const lower = track.channel === "sms" ? label : label.charAt(0).toLowerCase() + label.slice(1);
  return several ? lower : `the ${lower}`;
}
