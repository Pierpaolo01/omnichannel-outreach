/**
 * Why the Before launch screen shows no projected load, worded only from the tracks the server names
 * (`LoadProjectionView.withheldBy`), never from which channels the campaign happens to have (review bot
 * on 8edc8dd). One reason remains since ticket 14c, which projects the tracks after a phone track
 * under its stated assumption: a track with no connected sender.
 */
import type { WithheldBy } from "../../shared/api.ts";

const and = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`);

export function withheldExplanation(withheld: WithheldBy): string {
  const what = withheld.tracks.map((t) => `${t.label} has a connected ${t.channel === "sms" ? "SMS number" : "sender inbox"}`);
  const many = withheld.tracks.length > 1;
  return `Can’t project the load until ${and(what)}: ${many ? "their" : "its"} leads, and every track after ${many ? "them" : "it"}, would wait.`;
}
