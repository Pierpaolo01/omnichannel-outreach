import { describe, expect, test } from "vitest";
import { CONVERSATION_CHANNELS } from "../../domain/sequence/definition.ts";
import { holdReasonClause } from "../calls/wording.ts";
import { conversationTaken, conversationUnsettled } from "./sms-wording.ts";

/** A taken or unsettled conversation in its own channel's words (ADR 0004, Q41; council on b21af02, item 1). */
const OWNERS = [{ name: "Spring clinics", test: false }];

describe("a conversation's sentences name its own channel", () => {
  test("SMS: a mobile and a text", () => {
    expect(conversationTaken(OWNERS, "sms")).toBe("their mobile was already in a text conversation with campaign Spring clinics on every number this campaign can use");
    expect(conversationUnsettled(OWNERS, "sms")).toContain("the first text from campaign Spring clinics to the same mobile");
    expect(holdReasonClause("sms_conversation_unsettled", OWNERS, "sms")).toContain("mobile");
  });

  test("LinkedIn: a profile and an invite or message, never a mobile or a text", () => {
    for (const sentence of [conversationTaken(OWNERS, "linkedin"), conversationTaken(OWNERS, "linkedin", "your test", "now"), conversationUnsettled(OWNERS, "linkedin"), holdReasonClause("sms_conversation_unsettled", OWNERS, "linkedin")]) {
      expect(sentence).toContain("LinkedIn");
      expect(sentence).not.toMatch(/mobile|text/);
    }
  });

  test("every channel of conversations has its words (a channel added without them fails here and in typecheck)", () => {
    for (const channel of CONVERSATION_CHANNELS) {
      expect(conversationTaken(OWNERS, channel)).not.toContain("undefined");
      expect(conversationUnsettled(OWNERS, channel)).not.toContain("undefined");
    }
  });
});
