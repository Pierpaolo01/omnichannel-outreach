/**
 * Why an SMS track has no sender number, from the SMS provider's status (`GET /api/sms-provider`):
 * the one wording the inspector and the launch blocker both use (council on 10121d3, item 3), so it
 * stays true when a provider exists and a number is merely not connected. Null when the status has
 * not loaded: nothing is claimed.
 */
import type { ConversationOwnerView, SmsProviderStatus } from "../../shared/api.ts";
import type { ConversationChannel } from "../../domain/sequence/definition.ts";

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

/**
 * A conversation's channel in words (ADR 0004, question Q41; council on b21af02, item 1): the destination, what reached it,
 * and the sender accounts. One entry per channel of conversations: a channel `holdsConversations` gains fails typecheck here
 * until it has its words, so no sentence names another channel's destination. The stored reason ids keep "sms" in their
 * names (ADR 0004, follow-up); the sentences never do.
 */
const CONVERSATION_WORDS: Readonly<Record<ConversationChannel, { readonly destination: string; readonly conversation: string; readonly first: string; readonly senders: string }>> = {
  sms: { destination: "mobile", conversation: "a text conversation", first: "the first text", senders: "on every number this campaign can use" },
  linkedin: { destination: "LinkedIn profile", conversation: "a LinkedIn conversation (an invite or a message)", first: "the first invite or message", senders: "on every LinkedIn session this campaign can use" },
};

/** The channel of a taken or unsettled conversation, from a read's channel: only SMS and LinkedIn tracks have one. */
export function conversationChannelOf(channel: string | undefined): ConversationChannel {
  switch (channel) {
    case "linkedin":
      return "linkedin";
    case "sms":
      return "sms";
    default:
      // A taken or unsettled conversation is only ever an SMS or LinkedIn track's; a read that names none is an SMS one's
      // (reads stored before ticket 24 name no channel).
      return "sms";
  }
}

export function conversationTaken(owners: readonly ConversationOwnerView[], channel: ConversationChannel, whose: "their" | "your test" = "their", tense: "past" | "now" = "past"): string {
  const w = CONVERSATION_WORDS[channel];
  return `${whose} ${w.destination} ${tense === "past" ? "was already" : "is"} in ${w.conversation} with ${ownersPhrase(owners)} ${w.senders}`;
}

/** A wait on another subject's first action whose fate is not known yet (`sms_conversation_unsettled`), in its channel's words. */
export function conversationUnsettled(owners: readonly ConversationOwnerView[], channel: ConversationChannel): string {
  const w = CONVERSATION_WORDS[channel];
  return `${w.first} from ${ownersPhrase(owners)} to the same ${w.destination}, ${w.senders}, isn’t known to have gone or not yet`;
}
