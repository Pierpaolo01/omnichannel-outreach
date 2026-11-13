/**
 * Why the Before launch screen shows no projected load, worded only from the tracks the server names
 * (`LoadProjectionView.withheldBy`), never from which channels the campaign happens to have (review bot
 * on 8edc8dd).
 */
import type { WithheldBy, WithheldTrack } from "../../shared/api.ts";

/** What a track that does not start after the email track does to the emails, by its channel. */
const EFFECT: Readonly<Record<WithheldTrack["channel"], string>> = {
  call: "a logged call puts the lead’s emails first, a track after the phone track starts when the call is logged, and an interested call ends the lead",
  sms: "a text puts the lead’s emails first",
  email: "its emails share the inboxes and the lead’s turn",
};

const list = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join("; ")}; and ${items.at(-1) ?? ""}`);
const names = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`);

function clause(t: WithheldTrack): string {
  if (t.why === "another_email_track") return `${t.label} also sends from these inboxes`;
  return `${t.label} doesn’t start after it: ${EFFECT[t.channel]}`;
}

export function withheldExplanation(withheld: WithheldBy): string {
  if (withheld.campaign !== null) {
    const many = withheld.tracks.length > 1;
    return `Can’t project the load yet: ${withheld.campaign.name}, also running on these inboxes, has ${names(withheld.tracks.map((t) => t.label))}, which can change when its emails go, and the estimate doesn’t include ${many ? "them" : "it"} yet.`;
  }
  const late = withheld.tracks.find((t) => t.why === "email_track_not_at_launch");
  if (late) return `Can’t project the load yet: ${late.label} doesn’t start at launch, and the estimate covers only an email track that does.`;
  const keeps = withheld.tracks.some((t) => t.why === "not_after_the_email_track") ? " A track that starts after the email track keeps the estimate." : "";
  return `Can’t project the load yet: the estimate covers one email track that starts at launch, and ${list(withheld.tracks.map(clause))}.${keeps}`;
}
