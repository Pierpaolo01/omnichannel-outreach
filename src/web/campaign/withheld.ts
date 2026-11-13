/**
 * Why the Before launch screen shows no projected load, worded only from the tracks the server names
 * (`LoadProjectionView.withheldBy`), never from which channels the campaign happens to have (review bot
 * on 8edc8dd). Two reasons remain since the projection runs the engine's own rules (ADR 0003, ticket
 * 13b): a track with no connected sender, and a track that waits on a phone track's call.
 */
import type { WithheldBy } from "../../shared/api.ts";

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const and = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`);

export function withheldExplanation(withheld: WithheldBy): string {
  const sentences: string[] = [];
  const noSender = withheld.tracks.filter((t) => t.why === "no_sender");
  if (noSender.length > 0) {
    const what = noSender.map((t) => `${t.label} has a connected ${t.channel === "sms" ? "SMS number" : "sender inbox"}`);
    const many = noSender.length > 1;
    sentences.push(`Can’t project the load until ${and(what)}: ${many ? "their" : "its"} leads, and every track after ${many ? "them" : "it"}, would wait.`);
  }
  const afterCall = withheld.tracks.filter((t) => t.why === "after_a_phone_track");
  if (afterCall.length > 0) {
    const what = afterCall.map((t) => `${t.label} starts after ${t.phoneTrack ?? "a phone track"}`);
    sentences.push(
      `${noSender.length > 0 ? "And it can’t" : "Can’t"} project ${afterCall.length > 1 ? "the tracks that wait" : "a track that waits"} on a call: ${and(what)}, which finishes only when you log the call, and no estimate can know when that is.`,
    );
  }
  return capitalise(sentences.join(" "));
}
