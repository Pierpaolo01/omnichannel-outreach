import type { MessageRequestTrackView, TrackProgressView } from "../../shared/api.ts";
import { isMessageRequestChannel, SOCIAL_CHANNELS } from "../../domain/social-channels.ts";

/**
 * A message-request track's facts on the record (ticket 25; ADR 0004 13.3, 13.4), one sentence each, from what the engine
 * stored and nothing else. "Went" only for a first message recorded sent; one handed over and not yet known is said as
 * exactly that. Nothing is said about acceptance or reading: the platform never tells the sender. **Provisional**
 * wording, for the principal.
 */
export function messageRequestTrackLines(track: Pick<TrackProgressView, "channel" | "finishReason" | "messageRequest">): string[] {
  const view = track.messageRequest;
  if (view === null || !isMessageRequestChannel(track.channel)) return [];
  const name = SOCIAL_CHANNELS[track.channel].name;
  const lines: string[] = [];
  if (track.finishReason === "skipped_missing_channel") return [skipLine(view.skipCause, name)];
  const whose = view.destination === "company" ? `their company’s ${name} account` : `their own ${name} account`;
  const from = view.sender === null ? "" : view.sender.kind === "business" ? " from your business session" : view.sender.kind === "personal" ? " from your personal session" : "";
  if (view.firstMessage === "sent") lines.push(`The first message went to ${whose}${from}, as a message request if they don’t follow you. ${name} doesn’t tell the app whether it was accepted or read.`);
  else if (view.firstMessage === "handed") lines.push(`The first message to ${whose} is with the ${name} session, which hasn’t confirmed whether it went.`);
  else if (view.destination !== null) lines.push(`Messages go to ${whose}.`);
  return lines;
}

/** Why the track was skipped as a missing channel, as recorded when it finished. */
function skipLine(cause: MessageRequestTrackView["skipCause"], name: string): string {
  switch (cause) {
    case "no_profile":
      return `Skipped: neither they nor their company have an ${name} account in the import.`;
    case "not_a_member_profile":
      return `Skipped: the ${name} address in the import isn’t an account’s address.`;
    case "marked_bad":
      return `Skipped: every ${name} account they could be messaged on is marked unreachable.`;
    case "replaced":
      return `Skipped: the ${name} account this track started with was replaced by a later import.`;
    case "removed_by_import":
      return `Skipped: the ${name} account this track started with was removed by a later import.`;
    case "company_lead":
    case "unrecorded":
    case null:
      return `Skipped: there was no usable ${name} account for them at the time.`;
    default: {
      const unhandled: never = cause;
      throw new Error(`A skip with no sentence: ${String(unhandled)}`);
    }
  }
}
