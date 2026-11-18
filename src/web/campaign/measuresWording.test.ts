import { describe, expect, test } from "vitest";
import type { CampaignMeasures } from "../../shared/api.ts";
import { groupCountText } from "../status.tsx";
import { callsLine, connectRateText, linkedinLine, measureNotes, measureRows, messagesLine, replyRateText, LINKEDIN_MEASURE_NOTE, MEASURE_NOTES } from "./measuresWording.ts";

const msg = (sent: number, failedOrBounced: number, replies: number, fromTests = { sent: 0, failedOrBounced: 0, replies: 0 }) => ({ sent, failedOrBounced, replies, fromTests });
const NO_CALL_TESTS = { made: 0, connected: 0, interested: 0, declined: 0, callbacksPending: 0 };
const r = (numerator: number, denominator: number, percent: number | null, fromTests = { numerator: 0, denominator: 0 }) => ({ numerator, denominator, percent, fromTests });
const m = (fields: Partial<CampaignMeasures> = {}): CampaignMeasures => ({
  launched: true,
  leads: 17,
  groups: { running: 8, waiting_on_you: 3, handed_to_you: 2, paused: 0, ended: 4 },
  channels: ["email", "sms", "call"],
  email: msg(40, 2, 3),
  sms: msg(12, 1, 1),
  linkedin: { invitesSent: 0, invitesAccepted: 0, inmailsSent: 0, messagesSent: 0, failed: 0, replies: 0, fromTests: { invitesSent: 0, invitesAccepted: 0, inmailsSent: 0, messagesSent: 0, failed: 0, replies: 0 } },
  messageRequests: { instagram: { messagesSent: 0, failed: 0, replies: 0, fromTests: { messagesSent: 0, failed: 0, replies: 0 } }, facebook: { messagesSent: 0, failed: 0, replies: 0, fromTests: { messagesSent: 0, failed: 0, replies: 0 } } },
  calls: { made: 9, connected: 4, interested: 1, declined: 2, callbacksPending: 1, fromTests: NO_CALL_TESTS },
  replyRate: r(4, 16, 25),
  connectRate: r(4, 9, 44),
  ...fields,
});

describe("the measures' wording (one function per measure)", () => {
  test("a group's count, as the prototype's strip says it, the one wording of the strip and the Paused banner", () => {
    expect(groupCountText("waiting_on_you")).toBe("waiting on you");
    expect(groupCountText("running")).toBe("running");
  });

  test("email and SMS: messages sent, failed or bounced, and the leads who replied (council on 384630e, item 5)", () => {
    expect(messagesLine(m().email)).toBe("40 sent · 2 failed or bounced · 3 leads replied");
    expect(messagesLine(msg(2, 0, 1))).toBe("2 sent · 0 failed or bounced · 1 lead replied");
    expect(messagesLine(msg(0, 0, 0))).toBe("None sent yet");
  });

  test("calls: made, connected, interested, declined and callbacks pending, singular where one", () => {
    expect(callsLine(m().calls)).toBe("9 made · 4 connected · 1 interested · 2 declined · 1 callback pending");
    expect(callsLine({ ...NO_CALL_TESTS, fromTests: NO_CALL_TESTS })).toBe("None made yet");
    expect(callsLine({ made: 1, connected: 0, interested: 0, declined: 0, callbacksPending: 2, fromTests: NO_CALL_TESTS })).toBe("1 made · 0 connected · 0 interested · 0 declined · 2 callbacks pending");
  });

  test("the rates name what they divide, and say plainly when there is nothing to divide", () => {
    expect(replyRateText(m().replyRate)).toEqual({ figure: "25%", says: "4 of the 16 leads you emailed or texted replied" });
    expect(replyRateText(r(0, 0, null))).toEqual({ figure: "—", says: "No email or text has been sent yet" });
    expect(replyRateText(r(1, 1, 100)).says).toBe("1 of the 1 lead you emailed or texted replied");
    expect(connectRateText(m().connectRate)).toEqual({ figure: "44%", says: "4 of 9 calls reached the prospect for a conversation" });
    expect(connectRateText(r(0, 0, null))).toEqual({ figure: "—", says: "No call has been made yet" });
    expect(connectRateText(r(1, 1, 100)).says).toBe("1 of 1 call reached the prospect for a conversation");
  });

  test("test runs count in every figure, which says how many came from them (the principal's decision, 15 November 2026)", () => {
    expect(messagesLine(msg(3, 1, 2, { sent: 1, failedOrBounced: 0, replies: 1 }))).toBe("3 sent (1 from test runs) · 1 failed or bounced · 2 replied (1 from test runs)");
    expect(callsLine({ made: 3, connected: 2, interested: 1, declined: 0, callbacksPending: 1, fromTests: { made: 1, connected: 1, interested: 0, declined: 0, callbacksPending: 1 } })).toBe(
      "3 made (1 from test runs) · 2 connected (1 from test runs) · 1 interested · 0 declined · 1 callback pending (1 from test runs)",
    );
    expect(replyRateText(r(2, 5, 40, { numerator: 1, denominator: 1 }))).toEqual({ figure: "40%", says: "2 of the 5 you emailed or texted replied (test runs: 1 of 1)" });
    expect(connectRateText(r(2, 3, 67, { numerator: 1, denominator: 1 }))).toEqual({ figure: "67%", says: "2 of 3 calls reached the prospect for a conversation (test runs: 1 of 1)" });
  });

  test("one row per channel the campaign has tracks on, in its order", () => {
    expect(measureRows(m()).map((r) => r.label)).toEqual(["Email", "SMS", "Calls"]);
    expect(measureRows(m({ channels: ["email"] })).map((r) => [r.label, r.line])).toEqual([["Email", "40 sent · 2 failed or bounced · 3 leads replied"]]);
  });

  test("how the figures are counted, in plain words, covering each edge the ADR names", () => {
    const all = MEASURE_NOTES.join(" ");
    for (const phrase of ["once the provider reports it sent", "counts once", "other channel", "Skip for now", "callback", "Test runs count too", "lead groups count leads only"]) expect(all).toContain(phrase);
    // Verifier F4 on 41028f2: Skip for now leaves a callback pending.
    expect(MEASURE_NOTES.find((n) => n.startsWith("A callback is pending"))).toBe(
      "A callback is pending until an outcome other than Skip for now is logged on it, also while the lead is paused (it is then off your call list); not once the lead has replied or been stopped.",
    );
  });
});

describe("LinkedIn measures in words (ADR 0004 section 8)", () => {
  test("invites sent and accepted, messages sent, failures and replies marked; none sent yet before anything went", () => {
    const zero = { invitesSent: 0, invitesAccepted: 0, inmailsSent: 0, messagesSent: 0, failed: 0, replies: 0 };
    expect(linkedinLine({ ...zero, fromTests: zero })).toBe("None sent yet");
    expect(linkedinLine({ invitesSent: 5, invitesAccepted: 2, inmailsSent: 0, messagesSent: 3, failed: 1, replies: 1, fromTests: { ...zero, invitesSent: 1 } })).toBe(
      "5 invites sent (1 from test runs) · 2 accepted · 3 messages sent · 1 failed · 1 lead marked replied",
    );
  });
});

describe("a marked LinkedIn reply from a test run is never called a lead (ticket 24b)", () => {
  test("with a test run among them, replies are said as replies", () => {
    const zero = { invitesSent: 0, invitesAccepted: 0, inmailsSent: 0, messagesSent: 0, failed: 0, replies: 0 };
    expect(linkedinLine({ invitesSent: 2, invitesAccepted: 2, inmailsSent: 0, messagesSent: 2, failed: 0, replies: 2, fromTests: { ...zero, replies: 1 } })).toBe("2 invites sent · 2 accepted · 2 messages sent · 0 failed · 2 marked replied (1 from test runs)");
  });
});

describe("how LinkedIn figures are counted (ticket 24b)", () => {
  test("said only for a campaign with a LinkedIn track, claiming no delivery or reading", () => {
    expect(measureNotes(["email"])).toEqual(MEASURE_NOTES);
    const notes = measureNotes(["email", "linkedin"]);
    expect(notes.length).toBe(MEASURE_NOTES.length + 1);
    expect(notes.at(-1)).toBe(LINKEDIN_MEASURE_NOTE);
    expect(LINKEDIN_MEASURE_NOTE).not.toMatch(/delivered|read by|opened/);
  });
});
