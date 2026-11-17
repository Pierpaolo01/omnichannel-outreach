import type { ReplyMark, SocialChannel } from "../../shared/api.ts";
import { isSocialChannel, SOCIAL_CHANNEL_LIST, SOCIAL_CHANNELS, type MessageRequestChannel } from "../../domain/social-channels.ts";

/**
 * The reply mark's words on each social channel (ADR 0004 7, 13.8): a mark of the user's, never a detected reply. Made from
 * the channel's name in the registry, so a new channel needs no entry here; LinkedIn's are ticket 24b's, word for word.
 */
export function markRepliedWords(channel: SocialChannel): { readonly label: string; readonly pending: string; readonly preview: string; readonly done: string } {
  const name = SOCIAL_CHANNELS[channel].name;
  return {
    label: `Mark replied on ${name}`,
    pending: `Marking replied on ${name}`,
    preview: `Mark them replied on ${name}? Their outreach in this campaign stops, as any reply stops it, and nothing more goes to them here. Carry on the conversation on ${name}.`,
    done: `Marked replied on ${name}. Carry on the conversation on ${name}.`,
  };
}

/** The record control that carries a mark's channel (ADR 0004 13.8): the channel is part of the action, never assumed. */
export type MarkRepliedControl = `mark_replied:${SocialChannel}`;
export const markRepliedControl = (channel: SocialChannel): MarkRepliedControl => `mark_replied:${channel}`;
/** The channel a mark's action carries, by the registry's own guard; null for any other action. */
export const channelOfMark = (action: string): SocialChannel | null => {
  const channel = action.startsWith("mark_replied:") ? action.slice("mark_replied:".length) : null;
  return isSocialChannel(channel) ? channel : null;
};
/** One entry per social channel's mark, for the controls' label tables. */
export const markLabels = (of: (channel: SocialChannel) => string): { readonly [K in MarkRepliedControl]: string } =>
  Object.fromEntries(SOCIAL_CHANNEL_LIST.map((c) => [markRepliedControl(c), of(c)])) as { readonly [K in MarkRepliedControl]: string };

/**
 * What a test run's message-request reply mark is for, said from the work that allows it (as LinkedIn's `testReplyHelper`):
 * a message recorded sent, or one with the session that hasn't confirmed whether it went.
 */
export function messageRequestTestHelper(channel: MessageRequestChannel, work: Extract<ReplyMark, { allowed: true }>["work"]): string {
  const name = SOCIAL_CHANNELS[channel].name;
  return work.state === "sent" ? `Once you have answered a test message on your ${name} test account.` : `A test message is with the ${name} session, which hasn’t confirmed whether it went: mark it once you have written back from your test account.`;
}
