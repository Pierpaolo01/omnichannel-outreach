/**
 * What a launch blocker says, and where it is fixed: one function for all three kinds (ticket 13b,
 * verifier B2). Every blocker is named by the track it is in, from the fact the server sends with it
 * (`trackId`, or for a merge field every message that uses it with no fallback), and by that track's
 * own channel and order ("the SMS track", "email track 2"), never by its position or a default channel.
 */
import { isMessageRequestChannel, isSocialChannel, MESSAGE_REQUEST_CHANNELS, SOCIAL_CHANNEL_LIST, SOCIAL_CHANNELS } from "../../domain/social-channels.ts";
import type { CampaignDefinition, LaunchBlocker, LinkedinProviderStatus, SmsProviderStatus, TrackDefinition } from "../../shared/api.ts";
import { stepTitle } from "../../shared/track-label.ts";
import { fieldLabel, STEP_NOUN, trackName } from "./model.ts";
import { whyNoSmsNumber } from "./sms-wording.ts";

export interface BlockerAction {
  readonly label: string;
  readonly trackId: string;
  readonly stepId?: string;
}

export interface BlockerWording {
  readonly title: string;
  readonly detail: string;
  readonly actions: readonly BlockerAction[];
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const and = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`);
/** A step's title in its track, which the sentence names beside it: "Email 2", "Text 1", a LinkedIn step by its role ("First message"). */
const stepName = (track: TrackDefinition | undefined, number: number, stepId?: string): string => {
  const channel = track?.channel ?? "email";
  // The InMail fallback by its role (ADR 0004 14.9), from the step the blocker names.
  const role = track?.steps.some((s) => s.id === stepId && s.role === "inmail") ? ("inmail" as const) : undefined;
  return channel === "call" ? `${STEP_NOUN.call} ${number}` : stepTitle({ branch: "main" }, channel, number, role);
};
const channelOf = (track: TrackDefinition | undefined): TrackDefinition["channel"] => track?.channel ?? "email";

export function describeBlocker(b: LaunchBlocker, def: CampaignDefinition, sms: SmsProviderStatus | null = null, linkedin: LinkedinProviderStatus | null = null): BlockerWording {
  const trackOf = (id: string) => def.tracks.find((t) => t.id === id);
  const named = (track: TrackDefinition | undefined) => (track ? trackName(def, track) : "a track");

  if (b.kind === "missing_merge_field") {
    const places = b.uses.map((u) => {
      const track = trackOf(u.trackId);
      return { ...u, text: `${stepName(track, u.stepNumber, u.stepId)} of ${named(track)}` };
    });
    const field = fieldLabel(b.field);
    return {
      title: `${capitalise(field)} has no fallback in ${and(places.map((p) => p.text))}`,
      detail: `${b.leadsMissing} ${b.leadsMissing === 1 ? "lead has" : "leads have"} no ${field}. Add a fallback or remove the field.`,
      actions: places.map((p) => ({ label: places.length === 1 ? "Add fallback" : `Add fallback: ${p.text}`, trackId: p.trackId, stepId: p.stepId })),
    };
  }

  const track = trackOf(b.trackId);
  const channel = track ? channelOf(track) : b.kind === "no_sender" && (b.channel === "sms" || isSocialChannel(b.channel)) ? b.channel : "email";
  const name = capitalise(named(track));
  if (b.kind === "empty_copy") {
    const noun = stepName(track, b.stepNumber, b.stepId);
    const what = b.part === "subject" ? `${noun} has no subject` : `${noun} has no ${channel === "email" ? "copy" : "message"}`;
    const inmail = track?.steps.some((s) => s.id === b.stepId && s.role === "inmail") === true;
    return {
      title: `${name}: ${what}`,
      detail: b.part === "subject" ? "Give it a subject, or let it continue the thread." : inmail ? "Write it, or switch the InMail fallback off." : `Write it, or remove the ${channel === "sms" ? "text" : isSocialChannel(channel) ? "message" : "email"}.`,
      actions: [{ label: "Write it", trackId: b.trackId, stepId: b.stepId }],
    };
  }
  // LinkedIn (ADR 0004 1.1): the domain's own words, and the provider read's; nothing says a session can be connected here.
  // Instagram (ADR 0004 13.1): as LinkedIn's, in the server's own sentence; nothing says a session can be connected here.
  if (isMessageRequestChannel(channel)) {
    const platform = SOCIAL_CHANNELS[channel].name;
    // ADR 0004 13.5: no session chosen for the track is said as that; no chosen session connected, as LinkedIn's is.
    return b.noneChosen === true
      ? { title: `${name} has no sender session chosen`, detail: `Choose the ${platform} sessions it sends from in the track’s Timing and sender. Remove the track to launch without it.`, actions: [{ label: "Open track", trackId: b.trackId }] }
      : { title: `${name} has no connected ${platform} session`, detail: `No ${platform} session is connected, so ${platform} tracks cannot launch. Remove the track to launch without it.`, actions: [{ label: "Open track", trackId: b.trackId }] };
  }
  if (channel === "linkedin")
    return {
      title: `${name} has no connected LinkedIn session`,
      detail: [linkedin?.message ?? null, "Remove the track to launch without it."].filter((x) => x !== null).join(" "),
      actions: [{ label: "Open track", trackId: b.trackId }],
    };
  return {
    title: `${name} has no connected sender ${channel === "sms" ? "number" : "inbox"}`,
    detail: channel === "sms" ? ["It can’t send until a number is connected.", whyNoSmsNumber(sms), "Remove the track to launch without it."].filter((x) => x !== null).join(" ") : "It can’t send until an inbox is connected.",
    actions: [{ label: "Open track", trackId: b.trackId }],
  };
}

/**
 * Each way launch can be blocked, as Before launch names it when nothing blocks (the council on 5a30b9f, item 3): one entry
 * per blocker the domain has, and the no-sender blocker's "none chosen" case of its own, so a new blocker fails typecheck here
 * until both sentences name it. `cause`: what blocks; `holds`: what is true when it does not, for this definition (null when
 * the campaign has nothing it applies to).
 */
type BlockerCase = LaunchBlocker["kind"] | "no_sender_chosen";
const BLOCKER_CASES: Readonly<Record<BlockerCase, { readonly cause: () => string; readonly holds: (def: CampaignDefinition) => string | null }>> = {
  empty_copy: { cause: () => "empty copy", holds: () => "every message has copy" },
  missing_merge_field: { cause: () => "a merge field with no fallback that a lead lacks", holds: () => "every merge field has a fallback where a lead lacks it" },
  no_sender: { cause: () => "no connected sender", holds: (def) => `every ${senderTracksPhrase(def)} has a sender` },
  no_sender_chosen: {
    cause: () => `${MESSAGE_REQUEST_CHANNELS.map((c) => SOCIAL_CHANNELS[c].aName).join(" or ")} track with no sender session chosen`,
    holds: (def) => {
      const names = MESSAGE_REQUEST_CHANNELS.filter((c) => def.tracks.some((t) => !t.removed && t.channel === c)).map((c) => SOCIAL_CHANNELS[c].name);
      return names.length === 0 ? null : `every ${names.join(" and ")} track has a sender session chosen`;
    },
  },
};
const listed = (parts: readonly string[], last: "and" | "or") => (parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")}${parts.length > 2 ? "," : ""} ${last} ${parts.at(-1) ?? ""}`);

/** The tracks that need a sender, by channel, in a sentence: "email, SMS and Instagram track". */
export function senderTracksPhrase(def: CampaignDefinition): string {
  const has = (c: string) => def.tracks.some((t) => !t.removed && t.channel === c);
  const words = ["email", "SMS", ...SOCIAL_CHANNEL_LIST.filter(has).map((c) => SOCIAL_CHANNELS[c].name)];
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1) ?? ""} track`;
}

/** With no track yet: everything that can block launch once there is one, from every blocker the domain has. */
export function blockedOnlyBy(): string {
  return `With a track, launch is blocked only by ${listed(Object.values(BLOCKER_CASES).map((c) => c.cause()), "or")}.`;
}

/** With tracks and no blocker: what holds, for each blocker that applies to this definition. */
export function nothingBlocks(def: CampaignDefinition): string {
  const parts = Object.values(BLOCKER_CASES).flatMap((c) => c.holds(def) ?? []);
  const sentence = listed(parts, "and");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}
