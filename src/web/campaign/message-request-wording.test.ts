import { describe, expect, test } from "vitest";
import type { MessageRequestTrackView, TrackProgressView } from "../../shared/api.ts";
import { messageRequestTrackLines } from "./message-request-wording.ts";
import { MARK_REPLIED_WORDS, channelOfMark, markRepliedControl } from "./reply-mark-wording.ts";
import { MESSAGE_REQUEST_STEP_KIND_AT, stepTitle, trackLabel } from "../../shared/track-label.ts";
import { messageRequestStepKind, type CampaignDefinition, type TrackDefinition } from "../../domain/sequence/definition.ts";

/** Ticket 25 (ADR 0004 13.3, 13.4, 13.8): the record's Instagram sentences, each from a stored fact. */
const VIEW: MessageRequestTrackView = { destination: "own", address: "https://www.instagram.com/example_pat", firstMessage: null, sender: null, skipCause: null };
const track = (view: Partial<MessageRequestTrackView>, finishReason: TrackProgressView["finishReason"] = null) => ({ channel: "instagram", finishReason, messageRequest: { ...VIEW, ...view } });

describe("the record's Instagram lines", () => {
  test("“went” only for a first message recorded sent; one handed over is said as not known; nothing about acceptance is promised", () => {
    expect(messageRequestTrackLines(track({ firstMessage: "sent", sender: { id: "instagram:s", kind: "business" } }))).toEqual([
      "The first message went to their own Instagram account from your business session, as a message request if they don’t follow you. Instagram doesn’t tell the app whether it was accepted or read.",
    ]);
    expect(messageRequestTrackLines(track({ firstMessage: "handed", destination: "company" }))).toEqual(["The first message to their company’s Instagram account is with the Instagram session, which hasn’t confirmed whether it went."]);
    expect(messageRequestTrackLines(track({ destination: "company" }))).toEqual(["Messages go to their company’s Instagram account."]);
    expect(messageRequestTrackLines(track({ destination: null }))).toEqual([]);
  });

  test("a skip says its recorded cause, never one worked out again", () => {
    const skip = (skipCause: MessageRequestTrackView["skipCause"]) => messageRequestTrackLines(track({ skipCause, destination: null }, "skipped_missing_channel"))[0];
    expect(skip("no_profile")).toBe("Skipped: neither they nor their company have an Instagram account in the import.");
    expect(skip("not_a_member_profile")).toBe("Skipped: the Instagram address in the import isn’t an account’s address.");
    expect(skip("marked_bad")).toBe("Skipped: every Instagram account they could be messaged on is marked unreachable.");
    expect(skip("replaced")).toBe("Skipped: the Instagram account this track started with was replaced by a later import.");
    expect(skip("unrecorded")).toBe("Skipped: there was no usable Instagram account for them at the time.");
  });

  test("a LinkedIn track has no Instagram lines", () => {
    expect(messageRequestTrackLines({ channel: "linkedin", finishReason: null, messageRequest: null })).toEqual([]);
  });
});

describe("the reply mark carries its channel", () => {
  test("each social channel has its own control and words; LinkedIn's are unchanged", () => {
    expect(markRepliedControl("instagram")).toBe("mark_replied:instagram");
    expect(channelOfMark("mark_replied:instagram")).toBe("instagram");
    expect(channelOfMark("mark_replied:linkedin")).toBe("linkedin");
    expect(channelOfMark("pause")).toBeNull();
    expect(MARK_REPLIED_WORDS.linkedin.label).toBe("Mark replied on LinkedIn");
    expect(MARK_REPLIED_WORDS.instagram.done).toBe("Marked replied on Instagram. Carry on the conversation on Instagram.");
  });
});

describe("Instagram steps by their role", () => {
  test("the shared label names each step as the engine's kind does, at every position", () => {
    const steps = [1, 2, 3, 4].map((n) => ({ id: `s${n}`, waitDays: 0, subject: "", body: "x", threading: "new_subject" as const, removed: false }));
    const t: TrackDefinition = { id: "ig", channel: "instagram", branch: "main", window: [], steps, start: { kind: "entry" }, removed: false };
    steps.forEach((s, i) => expect(MESSAGE_REQUEST_STEP_KIND_AT(i + 1)).toBe(messageRequestStepKind(t, s.id)));
    expect([1, 2, 3].map((n) => stepTitle({ branch: "main" }, "instagram", n))).toEqual(["Message request", "Follow-up 1", "Follow-up 2"]);
    const def: CampaignDefinition = { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: [], tracks: [{ ...t, branch: "win_back" }] };
    expect(trackLabel(def, { id: "ig", channel: "instagram" }).label).toBe("Win-back Instagram track");
  });
});

describe("Before launch says an Instagram session in Instagram's words (found in the evidence of ticket 25)", () => {
  test("the withheld load figure names Instagram, not LinkedIn", async () => {
    const { withheldExplanation } = await import("./withheld.ts");
    const said = withheldExplanation({ tracks: [{ trackId: "ig", channel: "instagram", label: "the Instagram track", why: "not_modelled" }] });
    expect(said).toBe("No load is projected for this campaign: the estimate doesn’t model Instagram tracks yet: it doesn’t read a session’s message allowance. The Instagram track has no figure, and nor does the rest of the campaign.");
    expect(said).not.toContain("LinkedIn");
  });

  test("a session's messages used today say fewer Instagram messages, and no invites are counted", async () => {
    const { usedTodayWarnings } = await import("./BeforeLaunchTab.tsx");
    const warnings = usedTodayWarnings({ id: "instagram:s", label: "Session", channel: "instagram", healthy: true, capacity: 20, gapSeconds: 60, usedToday: 2, waiting: null, kinds: { invite: { capacity: 0, usedToday: 0 }, message: { capacity: 20, usedToday: 2 } } } as never);
    expect(warnings.map((w) => w.detail)).toEqual(["Other campaigns or test runs sent or reserved them, so fewer Instagram messages can go today."]);
  });
});
