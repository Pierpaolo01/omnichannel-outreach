import { describe, expect, test } from "vitest";
import { withheldExplanation } from "./withheld.ts";

/**
 * The Before launch screen's reason for withholding the load figure, worded only from what the server
 * names (review bot on 8edc8dd; ticket 13b). Since ticket 14c a track after a phone track is projected
 * (its call is assumed worked on its day), so a track with no connected sender is the one reason left.
 */
describe("why the load is not projected", () => {
  test("a track with no connected sender, alone and with another", () => {
    expect(withheldExplanation({ tracks: [{ trackId: "m1", channel: "sms", label: "the SMS track", why: "no_sender" }] })).toBe(
      "Can’t project the load until the SMS track has a connected SMS number: its leads, and every track after it, would wait.",
    );
    expect(withheldExplanation({ tracks: [{ trackId: "e1", channel: "email", label: "email track 1", why: "no_sender" }, { trackId: "m1", channel: "sms", label: "the SMS track", why: "no_sender" }] })).toBe(
      "Can’t project the load until email track 1 has a connected sender inbox and the SMS track has a connected SMS number: their leads, and every track after them, would wait.",
    );
  });
});
