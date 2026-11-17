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
  // Another campaign on the same senders (council on dee365d, item 8): named, since this campaign's figure depends on it.
  const elsewhere = [...new Set(linkedin.flatMap((t) => (t.campaign === undefined ? [] : [t.campaign])))];
  if (linkedin.some((t) => t.campaign === undefined)) return `No load is projected for this campaign: the estimate doesn’t model LinkedIn tracks yet, since when a person accepts an invite can’t be foreseen. ${capital(and(linkedin.filter((t) => t.campaign === undefined).map((t) => t.label)))} ${linkedin.filter((t) => t.campaign === undefined).length > 1 ? "have" : "has"} no figure, and nor does the rest of the campaign.`;
  if (elsewhere.length > 0) return `No load is projected for this campaign: ${and(elsewhere.map((n) => `campaign ${n}`))} ${elsewhere.length > 1 ? "share" : "shares"} its senders and ${elsewhere.length > 1 ? "have LinkedIn tracks" : "has a LinkedIn track"}, which the estimate doesn’t model yet, so a figure here would leave out what ${elsewhere.length > 1 ? "they send" : "it sends"} after ${elsewhere.length > 1 ? "them" : "it"}.`;
  const what = withheld.tracks.map((t) => `${t.label} has a connected ${t.channel === "sms" ? "SMS number" : t.channel === "linkedin" ? "LinkedIn session" : "sender inbox"}`);
  const many = withheld.tracks.length > 1;
  return `Can’t project the load until ${and(what)}: ${many ? "their" : "its"} leads, and every track after ${many ? "them" : "it"}, would wait.`;
}
