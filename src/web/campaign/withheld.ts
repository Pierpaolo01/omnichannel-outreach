/**
 * Why the Before launch screen shows no projected load, worded only from the tracks the server names
 * (`LoadProjectionView.withheldBy`), never from which channels the campaign happens to have (review bot
 * on 8edc8dd). One reason remains since ticket 14c, which projects the tracks after a phone track
 * under its stated assumption: a track with no connected sender.
 */
import type { WithheldBy } from "../../shared/api.ts";

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const and = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`);

/** Why another campaign or test competes with this one for the estimate (council on a6c1700, item 4). */
const COMPETES: Record<NonNullable<WithheldBy["tracks"][number]["competing"]>["why"], string> = {
  inbox: "shares a sender inbox with it",
  number: "shares an SMS number with it",
  session: "shares a LinkedIn session with it",
  calls: "shares your call list with it",
  through_another: "shares senders with a campaign this one shares with",
};

export function withheldExplanation(withheld: WithheldBy): string {
  // A LinkedIn track the estimate does not model (ticket 24b): said apart, since nothing the user does lifts it.
  const linkedin = withheld.tracks.filter((t) => t.why === "not_modelled");
  const own = linkedin.filter((t) => t.competing === undefined);
  if (own.length > 0) return `No load is projected for this campaign: the estimate doesn’t model LinkedIn tracks yet, since when a person accepts an invite can’t be foreseen. ${capital(and(own.map((t) => t.label)))} ${own.length > 1 ? "have" : "has"} no figure, and nor does the rest of the campaign.`;
  // Another campaign or a running test whose LinkedIn track is still to finish (council on dee365d, item 8; on a6c1700,
  // items 3 to 5): named as an SMS owner is named, with why it competes; this campaign's own test says when it ends.
  const others = [...new Map(linkedin.flatMap((t) => (t.competing ? [[`${t.competing.name}|${t.competing.test}`, t.competing] as const] : []))).values()];
  if (others.length > 0) {
    const ownTest = others.find((o) => o.own);
    if (ownTest) return "No load is projected while this campaign’s own test is running: its LinkedIn track, which the estimate doesn’t model yet, uses the same senders. The figure returns when the test ends.";
    const said = others.map((o) => `${o.test ? `the test run of campaign ${o.name}` : `campaign ${o.name}`}, which ${COMPETES[o.why]}`);
    return `No load is projected for this campaign: ${and(said)}, still ${others.length > 1 ? "have LinkedIn tracks" : "has a LinkedIn track"} to finish, which the estimate doesn’t model yet, so a figure here would leave out what ${others.length > 1 ? "they send" : "it sends"} after ${others.length > 1 ? "them" : "it"}.`;
  }
  const what = withheld.tracks.map((t) => `${t.label} has a connected ${t.channel === "sms" ? "SMS number" : t.channel === "linkedin" ? "LinkedIn session" : "sender inbox"}`);
  const many = withheld.tracks.length > 1;
  return `Can’t project the load until ${and(what)}: ${many ? "their" : "its"} leads, and every track after ${many ? "them" : "it"}, would wait.`;
}
