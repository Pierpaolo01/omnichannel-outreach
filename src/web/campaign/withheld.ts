/**
 * Why the Before launch screen shows no projected load, worded only from the tracks the server names
 * (`LoadProjectionView.withheldBy`), never from which channels the campaign happens to have (review bot
 * on 8edc8dd). One reason remains since ticket 14c, which projects the tracks after a phone track
 * under its stated assumption: a track with no connected sender.
 */
import type { WithheldBy } from "../../shared/api.ts";

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const and = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`);

export function withheldExplanation(withheld: WithheldBy): string {
  // A LinkedIn track the estimate does not model (ticket 24b): said apart, since nothing the user does lifts it.
  const linkedin = withheld.tracks.filter((t) => t.why === "not_modelled");
  if (linkedin.length > 0) return `No load is projected for this campaign: the estimate doesn’t model LinkedIn tracks yet, since when a person accepts an invite can’t be foreseen. ${capital(and(linkedin.map((t) => t.label)))} ${linkedin.length > 1 ? "have" : "has"} no figure, and nor does the rest of the campaign.`;
  const what = withheld.tracks.map((t) => `${t.label} has a connected ${t.channel === "sms" ? "SMS number" : t.channel === "linkedin" ? "LinkedIn session" : "sender inbox"}`);
  const many = withheld.tracks.length > 1;
  return `Can’t project the load until ${and(what)}: ${many ? "their" : "its"} leads, and every track after ${many ? "them" : "it"}, would wait.`;
}
