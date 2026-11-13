/**
 * A track's name, from its own channel and its order among that channel's tracks, never its
 * position among all tracks (ticket 13b): "Email track" when it is the only one on its channel,
 * otherwise "Email track 2". The editor, Before launch and Activity all name tracks this way.
 */
import type { CampaignDefinition, TrackDefinition } from "../domain/sequence/definition.ts";

const WORD = { email: "Email", sms: "SMS", call: "Phone" } as const;

export interface TrackLabel {
  readonly label: string;
  /** The campaign has more than one track on this channel, so the label carries a number. */
  readonly several: boolean;
}

export function trackLabel(def: CampaignDefinition, track: Pick<TrackDefinition, "id" | "channel">): TrackLabel {
  const same = def.tracks.filter((t) => t.channel === track.channel && (!t.removed || t.id === track.id));
  const word = WORD[track.channel];
  if (same.length <= 1) return { label: `${word} track`, several: false };
  return { label: `${word} track ${same.findIndex((t) => t.id === track.id) + 1}`, several: true };
}
