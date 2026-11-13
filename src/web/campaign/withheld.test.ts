import { describe, expect, test } from "vitest";
import { withheldExplanation } from "./withheld.ts";

/** The Before launch screen's reason for withholding the load figure, worded only from what the server names (review bot on 8edc8dd; ticket 13b). */
describe("why the load is not projected", () => {
  test("a track with no connected sender, alone and with another", () => {
    expect(withheldExplanation({ tracks: [{ trackId: "m1", channel: "sms", label: "the SMS track", why: "no_sender" }] })).toBe(
      "Can’t project the load until the SMS track has a connected SMS number: its leads, and every track after it, would wait.",
    );
    expect(withheldExplanation({ tracks: [{ trackId: "e1", channel: "email", label: "email track 1", why: "no_sender" }, { trackId: "m1", channel: "sms", label: "the SMS track", why: "no_sender" }] })).toBe(
      "Can’t project the load until email track 1 has a connected sender inbox and the SMS track has a connected SMS number: their leads, and every track after them, would wait.",
    );
  });

  test("a track that waits on a phone track's call is named with the phone track", () => {
    expect(withheldExplanation({ tracks: [{ trackId: "e2", channel: "email", label: "email track 2", why: "after_a_phone_track", phoneTrack: "the phone track" }] })).toBe(
      "Can’t project a track that waits on a call: email track 2 starts after the phone track, which finishes only when you log the call, and no estimate can know when that is.",
    );
  });

  test("both reasons together", () => {
    expect(
      withheldExplanation({
        tracks: [
          { trackId: "m1", channel: "sms", label: "the SMS track", why: "no_sender" },
          { trackId: "e2", channel: "email", label: "email track 2", why: "after_a_phone_track", phoneTrack: "the phone track" },
        ],
      }),
    ).toBe(
      "Can’t project the load until the SMS track has a connected SMS number: its leads, and every track after it, would wait. And it can’t project a track that waits on a call: email track 2 starts after the phone track, which finishes only when you log the call, and no estimate can know when that is.",
    );
  });
});
