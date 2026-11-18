import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MESSAGE_REQUEST_CHANNELS, SOCIAL_CHANNEL_LIST, SOCIAL_CHANNELS, type SocialChannelFacts } from "../domain/social-channels.ts";
import { noUsableChannelItem } from "./calls/interruption.ts";
import { soFarSentence } from "./controls/wording.ts";
import { messageRequestNote, messageRequestReason, messageRequestTrackLines } from "./campaign/message-request-wording.ts";
import { blockedOnlyBy } from "./campaign/blocker-wording.ts";
import { conversationTaken } from "./campaign/sms-wording.ts";
import { sendsOnItsOwn } from "./campaign/model.ts";

/**
 * The article before a channel's name is the registry's fact (`aName`), never written beside the name (the council on
 * 5a30b9f, item 4): with a channel whose name starts with a consonant, every sentence says "a", never "an".
 */
const channel = MESSAGE_REQUEST_CHANNELS[0]!;
const facts = SOCIAL_CHANNELS as unknown as Record<string, SocialChannelFacts>;
let saved: SocialChannelFacts;

describe("a channel whose name starts with a consonant", () => {
  beforeEach(() => {
    saved = facts[channel]!;
    facts[channel] = { ...saved, name: "Facebook", aName: "a Facebook" };
  });
  afterEach(() => {
    facts[channel] = saved;
  });

  test("every sentence that puts an article before the name says it from the registry", () => {
    const sentences = [
      messageRequestNote(channel),
      messageRequestReason(channel, "no_account") ?? "",
      messageRequestTrackLines({ channel, finishReason: "skipped_missing_channel", messageRequest: { destination: null, address: null, firstMessage: null, sender: null, skipCause: "no_profile" } }).join(" "),
      soFarSentence({ state: "unknown", channel }),
      blockedOnlyBy(),
      conversationTaken([{ name: "Spring clinics", test: false, lead: null }], channel),
      sendsOnItsOwn({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: [], smsPool: [], tracks: [{ id: "t", channel, branch: "main", window: [], steps: [], start: { kind: "entry" }, removed: false }] }),
      noUsableChannelItem([{ enrollmentId: "e1", campaignId: "c1", endedAt: "2026-11-02T09:00:00.000Z", person: { id: "p1", name: "Pat Oneil" }, company: { id: "k1", name: "Harbour" }, campaign: { id: "c1", name: "Clinics" }, channels: [{ channel, why: "missing", owners: [] }] }], "2026-11-02", "Europe/London")?.body ?? "",
    ];
    for (const s of sentences) {
      expect(s, s).toMatch(/\b[Aa] Facebook\b/);
      expect(s, s).not.toMatch(/\b[Aa]n Facebook\b/);
    }
  });
});

test("each channel's phrase is its name with the article it takes", () => {
  for (const c of SOCIAL_CHANNEL_LIST) expect(SOCIAL_CHANNELS[c].aName).toMatch(new RegExp(`^an? ${SOCIAL_CHANNELS[c].name}$`));
});
