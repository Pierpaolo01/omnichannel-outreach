import { describe, expect, test } from "vitest";
import { withheldExplanation } from "./withheld.ts";

/** The Before launch screen's reason for withholding the load figure, worded only from what the server names (review bot on 8edc8dd). */
describe("why the load is not projected", () => {
  const phone = { trackId: "p1", channel: "call" as const, label: "the phone track", why: "not_after_the_email_track" as const };
  const sms = { trackId: "m1", channel: "sms" as const, label: "the SMS track", why: "not_after_the_email_track" as const };
  const email = { trackId: "e2", channel: "email" as const, label: "email track 2", why: "another_email_track" as const };

  test("a phone track beside the email track is named, with what a call does to the emails", () => {
    expect(withheldExplanation({ campaign: null, tracks: [phone] })).toBe(
      "Can’t project the load yet: the estimate covers one email track that starts at launch, and the phone track doesn’t start after it: a logged call puts the lead’s emails first, a track after the phone track starts when the call is logged, and an interested call ends the lead. A track that starts after the email track keeps the estimate.",
    );
  });

  test("an SMS track and a second email track, alone and together", () => {
    expect(withheldExplanation({ campaign: null, tracks: [sms] })).toBe("Can’t project the load yet: the estimate covers one email track that starts at launch, and the SMS track doesn’t start after it: a text puts the lead’s emails first. A track that starts after the email track keeps the estimate.");
    expect(withheldExplanation({ campaign: null, tracks: [email] })).toBe("Can’t project the load yet: the estimate covers one email track that starts at launch, and email track 2 also sends from these inboxes.");
    expect(withheldExplanation({ campaign: null, tracks: [phone, sms, email] })).toContain("the phone track doesn’t start after it: a logged call puts the lead’s emails first, a track after the phone track starts when the call is logged, and an interested call ends the lead; the SMS track doesn’t start after it: a text puts the lead’s emails first; and email track 2 also sends from these inboxes.");
  });

  test("the email track itself starting later, and another campaign's tracks, by name", () => {
    expect(withheldExplanation({ campaign: null, tracks: [{ trackId: "t1", channel: "email", label: "the email track", why: "email_track_not_at_launch" }] })).toBe("Can’t project the load yet: the email track doesn’t start at launch, and the estimate covers only an email track that does.");
    expect(withheldExplanation({ campaign: { id: "c2", name: "Winter physio" }, tracks: [phone, sms] })).toBe("Can’t project the load yet: Winter physio, also running on these inboxes, has the phone track and the SMS track, which can change when its emails go, and the estimate doesn’t include them yet.");
  });
});
