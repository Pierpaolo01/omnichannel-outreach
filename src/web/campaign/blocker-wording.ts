/**
 * What a launch blocker says, and where it is fixed: one function for all three kinds (ticket 13b,
 * verifier B2). Every blocker is named by the track it is in, from the fact the server sends with it
 * (`trackId`, or for a merge field every message that uses it with no fallback), and by that track's
 * own channel and order ("the SMS track", "email track 2"), never by its position or a default channel.
 */
import type { CampaignDefinition, LaunchBlocker, TrackDefinition } from "../../shared/api.ts";
import { fieldLabel, STEP_NOUN, trackName } from "./model.ts";

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
const channelOf = (track: TrackDefinition | undefined): "email" | "sms" | "call" => track?.channel ?? "email";

export function describeBlocker(b: LaunchBlocker, def: CampaignDefinition): BlockerWording {
  const trackOf = (id: string) => def.tracks.find((t) => t.id === id);
  const named = (track: TrackDefinition | undefined) => (track ? trackName(def, track) : "a track");

  if (b.kind === "missing_merge_field") {
    const places = b.uses.map((u) => {
      const track = trackOf(u.trackId);
      return { ...u, text: `${STEP_NOUN[channelOf(track)]} ${u.stepNumber} of ${named(track)}` };
    });
    const field = fieldLabel(b.field);
    return {
      title: `${capitalise(field)} has no fallback in ${and(places.map((p) => p.text))}`,
      detail: `${b.leadsMissing} ${b.leadsMissing === 1 ? "lead has" : "leads have"} no ${field}. Add a fallback or remove the field.`,
      actions: places.map((p) => ({ label: places.length === 1 ? "Add fallback" : `Add fallback: ${p.text}`, trackId: p.trackId, stepId: p.stepId })),
    };
  }

  const track = trackOf(b.trackId);
  const channel = track ? channelOf(track) : b.kind === "no_sender" && b.channel === "sms" ? "sms" : "email";
  const name = capitalise(named(track));
  if (b.kind === "empty_copy") {
    const noun = `${STEP_NOUN[channel]} ${b.stepNumber}`;
    const what = b.part === "subject" ? `${noun} has no subject` : `${noun} has no ${channel === "email" ? "copy" : "message"}`;
    return {
      title: `${name}: ${what}`,
      detail: b.part === "subject" ? "Give it a subject, or let it continue the thread." : `Write it, or remove the ${channel === "sms" ? "text" : "email"}.`,
      actions: [{ label: "Write it", trackId: b.trackId, stepId: b.stepId }],
    };
  }
  return {
    title: `${name} has no connected sender ${channel === "sms" ? "number" : "inbox"}`,
    detail: channel === "sms" ? "It can’t send until a number is connected, and no SMS provider is set up yet. Remove the track to launch without it." : "It can’t send until an inbox is connected.",
    actions: [{ label: "Open track", trackId: b.trackId }],
  };
}
