import { describe, expect, test } from "vitest";
import { isMessageRequestChannel, SOCIAL_CHANNEL_LIST, SOCIAL_CHANNELS, type SocialChannel } from "../domain/social-channels.ts";
import { nothingSentOn } from "../domain/sequence/controls.ts";
import { accountIsALead } from "../domain/sequence/test-runs.ts";
import { stepWaitWords } from "./controls/wording.ts";
import { endingDetail, failureWords } from "./campaign/testRunWording.ts";
import { markRepliedWords } from "./campaign/reply-mark-wording.ts";
import { MESSAGE_REQUEST_REASONS, messageRequestReason } from "./campaign/message-request-wording.ts";

/**
 * Every social channel × every explanation that speaks of it (verifier on f2824d4, item 6): each sentence is said from the
 * stored channel of the thing it speaks about, names that channel, and never another social channel. A channel added to
 * the registry joins every row here by itself.
 */
const others = (c: SocialChannel) => SOCIAL_CHANNEL_LIST.filter((o) => o !== c).map((o) => SOCIAL_CHANNELS[o].name);
const speaksOf = (c: SocialChannel, sentence: string) => {
  expect(sentence, sentence).toContain(SOCIAL_CHANNELS[c].name);
  for (const name of others(c)) expect(sentence, `${sentence} names ${name}`).not.toContain(name);
};
const FAILURES = Object.fromEntries(SOCIAL_CHANNEL_LIST.map((c) => [c, isMessageRequestChannel(c) ? ["account unreachable", "not allowed"] : ["profile unreachable", "not connected"]])) as unknown as Readonly<Record<SocialChannel, readonly string[]>>;

describe.each(SOCIAL_CHANNEL_LIST)("%s, in its own name", (channel) => {
  test("the wait for a session with no allowance", () => speaksOf(channel, stepWaitWords("no_allowance", channel)));

  test("the reply mark: its control, its confirmation, its result, and its refusal when nothing reached them", () => {
    for (const words of Object.values(markRepliedWords(channel))) speaksOf(channel, words);
    speaksOf(channel, nothingSentOn(channel));
  });

  test("a test run stopped by a reply the user marked there", () => speaksOf(channel, endingDetail("your_reply", { steps: [], stopReply: channel })));

  test("each failure reason the engine records for its steps, each its own sentence", () => {
    const said = FAILURES[channel].map((reason) => failureWords({ channel, reason }));
    expect(new Set(said).size).toBe(said.length);
    for (const s of said) for (const name of others(channel)) expect(s, s).not.toContain(name);
    if (isMessageRequestChannel(channel)) speaksOf(channel, failureWords({ channel, reason: "not allowed" }));
  });

  if (isMessageRequestChannel(channel)) {
    test("each reason a message-request step records, each its own sentence; a test account that belongs to a lead", () => {
      const said = MESSAGE_REQUEST_REASONS.map((r) => messageRequestReason(channel, r) ?? "");
      expect(new Set(said).size).toBe(said.length);
      for (const s of said) speaksOf(channel, s);
      speaksOf(channel, accountIsALead(channel));
    });
  }
});

test("a test run stopped by a reply whose channel is not stored names every channel a reply can be marked on", () => {
  const sentence = endingDetail("your_reply", { steps: [] });
  for (const c of SOCIAL_CHANNEL_LIST) expect(sentence).toContain(SOCIAL_CHANNELS[c].name);
});
