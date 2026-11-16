import { describe, expect, test } from "vitest";
import type { DeclineTrackView, NeedsAttention, TestStepRow, TrackLabel } from "../../shared/api.ts";
import { CONVERSATION_CHANNELS } from "../../domain/sequence/definition.ts";
import { describeEntry, dependentLine } from "../activity.tsx";
import { noUsableChannelItem } from "../calls/interruption.ts";
import { attentionItems, declineTrackLine, holdReasonClause } from "../calls/wording.ts";
import { stepWhenPhrase } from "../controls/wording.ts";
import { stepDetail } from "./testRunWording.ts";
import { conversationTaken, conversationUnsettled } from "./sms-wording.ts";

/** A taken or unsettled conversation in its own channel's words (ADR 0004, Q41; council on b21af02, item 1). */
const OWNERS = [{ name: "Spring clinics", test: false }];
const OWNER_A = [{ name: "Owner A", test: false }];
const ZONE = "Europe/London";
const AT = "2026-11-02T09:05:00.000Z";
const CAMPAIGN = { id: "c1", name: "Autumn physio" };
const LINKEDIN_TRACK: TrackLabel = { label: "LinkedIn track", several: false, branch: "main" };
const RUN = { email: "alex.own@personal-mail.example", mobile: "+44 7700 900456", running: true };
const row = (fields: Partial<TestStepRow>): TestStepRow => ({ trackId: "li", stepId: "li1", channel: "linkedin", branch: "main", name: "Invite", track: "LinkedIn track", state: "sent", at: AT, taskId: null, outcome: null, reason: null, waits: null, ...fields });
const LEAD = { person: { id: "p1", name: "Pat Oneil" }, company: { id: "k1", name: "Harbour Lane Physio" }, campaign: { id: "c1", name: "Clinics, London" } };
const NOTHING: NeedsAttention = { overdueCallbacks: [], stalledInboxes: [], heldTracks: [], accountWaits: [], senderProblems: [], heldCapacity: [], anomalies: [], waitingForCapacity: [], noUsableChannel: [], waitingOnProvider: [], waitingOnTransport: [], sendingInterrupted: null };

describe("a conversation's sentences name its own channel", () => {
  test("SMS: a mobile and a text", () => {
    expect(conversationTaken(OWNERS, "sms")).toBe("their mobile was already in a text conversation with campaign Spring clinics on every number this campaign can use");
    expect(conversationUnsettled(OWNERS, "sms")).toContain("the first text from campaign Spring clinics to the same mobile");
    expect(holdReasonClause("sms_conversation_unsettled", OWNERS, "sms")).toContain("mobile");
  });

  /**
   * The re-check of b21af02 ran the wording on LinkedIn states and got a mobile or a text in each of these, the owner's
   * name right and the channel wrong. Each case is the screen's own function on a LinkedIn read.
   */
  const cases: Record<string, () => string | null | undefined> = {
    "a held step's wait on the record (held: the first … to the same …)": () => stepWhenPhrase({ kind: "waits", why: "sms_conversation_unsettled", channel: "linkedin" }, ZONE),
    "Activity: a skip because the conversation is taken (… so a reply couldn't show which campaign it answers)": () =>
      describeEntry({ campaign: CAMPAIGN, at: AT, kind: "skipped", channel: "linkedin", track: LINKEDIN_TRACK, stepNumber: null, reason: "sms_conversation_taken", owners: OWNER_A }, ZONE).body,
    "Activity: a dependent track skipped (LinkedIn track was skipped: …)": () => dependentLine({ track: LINKEDIN_TRACK, state: "skipped_conversation_taken", startsAt: null, owners: OWNER_A, channel: "linkedin" }, ZONE),
    "the Test run tab: a skipped step (Skipped: your test …)": () => stepDetail(row({ state: "skipped", reason: "sms_conversation_taken", owners: OWNER_A }), RUN),
    "the Test run tab: a held step (On hold because …)": () => stepDetail(row({ state: "held", at: null, hold: "sms_conversation_unsettled", holdOwners: OWNER_A }), RUN),
    "Needs attention: no usable channel (What stops a channel now: …)": () =>
      noUsableChannelItem([{ enrollmentId: "e1", campaignId: "c1", person: LEAD.person, company: LEAD.company, campaign: LEAD.campaign, endedAt: AT, channels: [{ channel: "linkedin", why: "conversation_taken", owners: OWNER_A }] }], "2026-11-02", ZONE)?.body,
    "Needs attention: a held track (On hold because …)": () =>
      attentionItems({ ...NOTHING, heldTracks: [{ ...LEAD, enrollmentId: "e1", trackId: "li", channel: "linkedin", reason: "sms_conversation_unsettled", owners: OWNER_A }] }, { overdueCallbacks: [], userZone: ZONE, date: "2026-11-02", carriedOver: 0, carriedOverLastDay: 0 })[0]?.body,
    "a decline's line about a LinkedIn track, previewed and recorded": () => {
      const a = { track: LINKEDIN_TRACK, state: "skipped_conversation_taken", startsAt: null, owners: OWNER_A, channel: "linkedin" } as DeclineTrackView;
      return `${declineTrackLine(a, "preview", ZONE)} ${declineTrackLine(a, "record", ZONE)}`;
    },
    "Activity: a reply marked on LinkedIn (Automation stopped in this campaign. …)": () => describeEntry({ campaign: CAMPAIGN, at: AT, kind: "replied", channel: "linkedin" }, ZONE).body,
  };
  for (const [name, say] of Object.entries(cases)) {
    test(`LinkedIn, never a mobile, a text or a phone: ${name}`, () => {
      const sentence = say() ?? "";
      expect(sentence).toContain("LinkedIn");
      expect(sentence).not.toMatch(/mobile|\btexts?\b|phone|number/i);
      // The record's step wait carries no owners ("another campaign"); every other sentence names the owner.
      if (!name.startsWith("Activity: a reply") && !name.startsWith("a held step's wait")) expect(sentence).toContain("Owner A");
    });
  }

  test("every channel of conversations has its words (a channel added without them fails here and in typecheck)", () => {
    for (const channel of CONVERSATION_CHANNELS) {
      expect(conversationTaken(OWNERS, channel)).not.toContain("undefined");
      expect(conversationUnsettled(OWNERS, channel)).not.toContain("undefined");
    }
  });
});
