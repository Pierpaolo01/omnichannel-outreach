/**
 * Why an SMS track has no sender number, from the SMS provider's status (`GET /api/sms-provider`):
 * the one wording the inspector and the launch blocker both use (council on 10121d3, item 3), so it
 * stays true when a provider exists and a number is merely not connected. Null when the status has
 * not loaded: nothing is claimed.
 */
import type { ConversationOwnerView, SmsProviderStatus } from "../../shared/api.ts";

export function whyNoSmsNumber(status: SmsProviderStatus | null): string | null {
  if (status === null) return null;
  if (status.provider === "none") return "No SMS provider is set up, so no number can be connected yet.";
  if (status.numbers.length === 0) return "The SMS provider lists no number.";
  if (!status.numbers.some((n) => n.healthy)) return "The SMS provider’s numbers can’t send now.";
  return "The SMS provider has numbers, but none is in this campaign’s SMS senders.";
}

/** "campaign Spring clinics", "the test run of campaign Spring clinics". */
const ownerName = (o: ConversationOwnerView): string => (o.test ? `the test run of campaign ${o.name}` : `campaign ${o.name}`);

/**
 * Why an SMS track was skipped for a taken conversation (ADR 0003, question Q7 answered): the mobile was already in a
 * text conversation with another campaign on every number this campaign can use. An SMS thread is one conversation
 * between two numbers, so the campaign that texted first keeps it. The one wording every screen uses, as a clause:
 * Activity, a decline's line about the track, the Test run tab and Needs attention. `whose` names the mobile; `tense`
 * is "past" where the skip is told, "now" where Needs attention says what stops a channel today.
 */
/** "campaign A", "campaign A and the test run of campaign B"; "another campaign" when none is named. */
export function ownersPhrase(owners: readonly ConversationOwnerView[]): string {
  const names = owners.map(ownerName);
  const last = names.at(-1);
  return last === undefined ? "another campaign" : names.length === 1 ? last : `${names.slice(0, -1).join(", ")} and ${last}`;
}

export function conversationTaken(owners: readonly ConversationOwnerView[], whose: "their" | "your test" = "their", tense: "past" | "now" = "past"): string {
  const with_ = ownersPhrase(owners);
  return `${whose} mobile ${tense === "past" ? "was already" : "is"} in a text conversation with ${with_} on every number this campaign can use`;
}
