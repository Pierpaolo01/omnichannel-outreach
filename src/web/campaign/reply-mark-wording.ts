import type { ReplyMark, SocialChannel } from "../../shared/api.ts";

/**
 * The reply mark's words on each social channel (ADR 0004 7, 13.8): a mark of the user's, never a detected reply. One entry
 * per channel; LinkedIn's are ticket 24b's, unchanged.
 */
export const MARK_REPLIED_WORDS: { readonly [C in SocialChannel]: { readonly label: string; readonly pending: string; readonly preview: string; readonly done: string } } = {
  linkedin: {
    label: "Mark replied on LinkedIn",
    pending: "Marking replied on LinkedIn",
    preview: "Mark them replied on LinkedIn? Their outreach in this campaign stops, as any reply stops it, and nothing more goes to them here. Carry on the conversation on LinkedIn.",
    done: "Marked replied on LinkedIn. Carry on the conversation on LinkedIn.",
  },
  instagram: {
    label: "Mark replied on Instagram",
    pending: "Marking replied on Instagram",
    preview: "Mark them replied on Instagram? Their outreach in this campaign stops, as any reply stops it, and nothing more goes to them here. Carry on the conversation on Instagram.",
    done: "Marked replied on Instagram. Carry on the conversation on Instagram.",
  },
};

/** The record control that carries a mark's channel (ADR 0004 13.8): the channel is part of the action, never assumed. */
export type MarkRepliedControl = `mark_replied:${SocialChannel}`;
export const markRepliedControl = (channel: SocialChannel): MarkRepliedControl => `mark_replied:${channel}`;
export const channelOfMark = (action: string): SocialChannel | null => {
  const channel = action.startsWith("mark_replied:") ? action.slice("mark_replied:".length) : null;
  return channel === "linkedin" || channel === "instagram" ? channel : null;
};

/**
 * What a test run's message-request reply mark is for, said from the work that allows it (as LinkedIn's `testReplyHelper`):
 * a message recorded sent, or one with the session that hasn't confirmed whether it went.
 */
export function messageRequestTestHelper(channel: Exclude<SocialChannel, "linkedin">, work: Extract<ReplyMark, { allowed: true }>["work"]): string {
  const name = MARK_REPLIED_WORDS[channel].label.replace("Mark replied on ", "");
  return work.state === "sent" ? `Once you have answered a test message on your ${name} test account.` : `A test message is with the ${name} session, which hasn’t confirmed whether it went: mark it once you have written back from your test account.`;
}
