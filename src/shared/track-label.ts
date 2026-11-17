/**
 * A track's name, from its own channel and its order among that channel's tracks, never its
 * position among all tracks (ticket 13b): "Email track" when it is the only one on its channel,
 * otherwise "Email track 2". The editor, Before launch and Activity all name tracks this way. A track
 * of the win-back branch is counted within that branch and named for it: "Win-back email track" (ticket 16).
 */
import type { SendChannelApi, TrackChannelApi } from "./api.ts";
import { isMessageRequestChannel, SOCIAL_CHANNEL_LIST, SOCIAL_CHANNELS } from "../domain/social-channels.ts";
import type { CampaignDefinition, TrackDefinition } from "../domain/sequence/definition.ts";

const WORD = (channel: TrackChannelApi): string => (channel === "email" ? "Email" : channel === "sms" ? "SMS" : channel === "call" ? "Phone" : SOCIAL_CHANNELS[channel].name);
/** The channel words that keep their capital mid-sentence: product names and SMS. */
const PROPER = new Set(["SMS", ...SOCIAL_CHANNEL_LIST.map((c) => SOCIAL_CHANNELS[c].name)]);

export interface TrackLabel {
  readonly label: string;
  /** The campaign has more than one track on this channel, so the label carries a number. */
  readonly several: boolean;
  /** The main sequence, or the campaign's win-back branch (ticket 16): what a step of the track is called says it. */
  readonly branch: "main" | "win_back";
}

export function trackLabel(def: CampaignDefinition, track: Pick<TrackDefinition, "id" | "channel">): TrackLabel {
  const branch = def.tracks.find((t) => t.id === track.id)?.branch ?? "main";
  const same = def.tracks.filter((t) => t.channel === track.channel && t.branch === branch && (!t.removed || t.id === track.id));
  const word = branch === "win_back" ? `Win-back ${PROPER.has(WORD(track.channel)) ? WORD(track.channel) : WORD(track.channel).toLowerCase()}` : WORD(track.channel);
  if (same.length <= 1) return { label: `${word} track`, several: false, branch };
  return { label: `${word} track ${same.findIndex((t) => t.id === track.id) + 1}`, several: true, branch };
}

/**
 * What one step of a track is called in a title (council on 4fd9ca4, item 5): "Email" or "Text" in the main sequence,
 * "Win-back email" or "Win-back text" in the win-back branch, so a step of the branch never reads as the main sequence's.
 */
export function stepNoun(track: Pick<TrackLabel, "branch">, channel: SendChannelApi): string {
  const noun = channel === "sms" ? "Text" : channel === "linkedin" ? "LinkedIn step" : channel === "email" ? "Email" : `${SOCIAL_CHANNELS[channel].name} message`;
  switch (track.branch) {
    case "main":
      return noun;
    case "win_back":
      return `Win-back ${noun.toLowerCase()}`;
    default: {
      const unhandled: never = track.branch;
      throw new Error(`A branch with no name: ${String(unhandled)}`);
    }
  }
}

/**
 * A LinkedIn step's role by its number among the track's live steps, counted from 1 (ADR 0004 3.1): the engine's
 * `linkedinStepKind` decides it by position, and a test holds the two equal at every position. Reads give a step's number
 * (`stepNumber`), never its kind, so the screens name the step from it.
 */
export const LINKEDIN_STEP_KIND_AT = (number: number): "invite" | "first_message" | "follow_up" => (number <= 1 ? "invite" : number === 2 ? "first_message" : "follow_up");

/**
 * A message-request step's role by its number among the track's live steps (ADR 0004 13.3): the engine's
 * `messageRequestStepKind` decides it by position, and a test holds the two equal at every position.
 */
export const MESSAGE_REQUEST_STEP_KIND_AT = (number: number): "message_request" | "follow_up" => (number <= 1 ? "message_request" : "follow_up");

/**
 * What one step is called in a title (ticket 24b): "Email 2", "Text 1", "Win-back email 1"; a LinkedIn step by its role,
 * "Connection invite", "First message", "Follow-up 1" (CONTEXT.md's "connection invite"), "Win-back first message".
 */
export function stepTitle(track: Pick<TrackLabel, "branch">, channel: SendChannelApi, number: number): string {
  if (channel !== "linkedin" && !isMessageRequestChannel(channel)) return `${stepNoun(track, channel)} ${number}`;
  const role = isMessageRequestChannel(channel)
    ? MESSAGE_REQUEST_STEP_KIND_AT(number) === "message_request"
      ? "Message request"
      : `Follow-up ${number - 1}`
    : LINKEDIN_STEP_KIND_AT(number) === "invite"
      ? "Connection invite"
      : LINKEDIN_STEP_KIND_AT(number) === "first_message"
        ? "First message"
        : `Follow-up ${number - 2}`;
  return track.branch === "win_back" ? `Win-back ${role.charAt(0).toLowerCase()}${role.slice(1)}` : role;
}

/** A label's first word lower case mid-sentence, but "SMS" and "LinkedIn" keep their capitals. */
export const lowerLabel = (label: string): string => ([...PROPER].some((w) => label.startsWith(w)) ? label : label.charAt(0).toLowerCase() + label.slice(1));

/** A track's name inside a sentence: "the email track", "the SMS track", "email track 2", "SMS track 2", "the phone track", "the win-back SMS track". */
export function trackPhrase(def: CampaignDefinition, track: Pick<TrackDefinition, "id" | "channel">): string {
  const { label, several } = trackLabel(def, track);
  // "SMS" and "LinkedIn" keep their capitals; any other first word, "Win-back" included, is lower case mid-sentence (ticket 16b).
  const lower = lowerLabel(label);
  return several ? lower : `the ${lower}`;
}
