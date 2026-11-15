import { describe, expect, test } from "vitest";
import type { CampaignMeasures } from "../../shared/api.ts";
import { groupCountText } from "../status.tsx";
import { callsLine, connectRateText, measureRows, messagesLine, replyRateText, MEASURE_NOTES } from "./measuresWording.ts";

const m = (fields: Partial<CampaignMeasures> = {}): CampaignMeasures => ({
  launched: true,
  leads: 17,
  groups: { running: 8, waiting_on_you: 3, handed_to_you: 2, paused: 0, ended: 4 },
  channels: ["email", "sms", "call"],
  email: { sent: 40, failedOrBounced: 2, replies: 3 },
  sms: { sent: 12, failedOrBounced: 1, replies: 1 },
  calls: { made: 9, connected: 4, interested: 1, declined: 2, callbacksPending: 1 },
  replyRate: { numerator: 4, denominator: 16, percent: 25 },
  connectRate: { numerator: 4, denominator: 9, percent: 44 },
  ...fields,
});

describe("the measures' wording (one function per measure)", () => {
  test("a group's count, as the prototype's strip says it, the one wording of the strip and the Paused banner", () => {
    expect(groupCountText("waiting_on_you")).toBe("waiting on you");
    expect(groupCountText("running")).toBe("running");
  });

  test("email and SMS: messages sent, failed or bounced, and the leads who replied (council on 384630e, item 5)", () => {
    expect(messagesLine(m().email)).toBe("40 sent · 2 failed or bounced · 3 leads replied");
    expect(messagesLine({ sent: 2, failedOrBounced: 0, replies: 1 })).toBe("2 sent · 0 failed or bounced · 1 lead replied");
    expect(messagesLine({ sent: 0, failedOrBounced: 0, replies: 0 })).toBe("None sent yet");
  });

  test("calls: made, connected, interested, declined and callbacks pending, singular where one", () => {
    expect(callsLine(m().calls)).toBe("9 made · 4 connected · 1 interested · 2 declined · 1 callback pending");
    expect(callsLine({ made: 0, connected: 0, interested: 0, declined: 0, callbacksPending: 0 })).toBe("None made yet");
    expect(callsLine({ made: 1, connected: 0, interested: 0, declined: 0, callbacksPending: 2 })).toBe("1 made · 0 connected · 0 interested · 0 declined · 2 callbacks pending");
  });

  test("the rates name what they divide, and say plainly when there is nothing to divide", () => {
    expect(replyRateText(m().replyRate)).toEqual({ figure: "25%", says: "4 of the 16 leads you emailed or texted replied" });
    expect(replyRateText({ numerator: 0, denominator: 0, percent: null })).toEqual({ figure: "—", says: "No email or text has been sent yet" });
    expect(replyRateText({ numerator: 1, denominator: 1, percent: 100 }).says).toBe("1 of the 1 lead you emailed or texted replied");
    expect(connectRateText(m().connectRate)).toEqual({ figure: "44%", says: "4 of 9 calls reached the prospect for a conversation" });
    expect(connectRateText({ numerator: 0, denominator: 0, percent: null })).toEqual({ figure: "—", says: "No call has been made yet" });
    expect(connectRateText({ numerator: 1, denominator: 1, percent: 100 }).says).toBe("1 of 1 call reached the prospect for a conversation");
  });

  test("one row per channel the campaign has tracks on, in its order", () => {
    expect(measureRows(m()).map((r) => r.label)).toEqual(["Email", "SMS", "Calls"]);
    expect(measureRows(m({ channels: ["email"] })).map((r) => [r.label, r.line])).toEqual([["Email", "40 sent · 2 failed or bounced · 3 leads replied"]]);
  });

  test("how the figures are counted, in plain words, covering each edge the ADR names", () => {
    const all = MEASURE_NOTES.join(" ");
    for (const phrase of ["once the provider reports it sent", "counts once", "other channel", "Skip for now", "callback"]) expect(all).toContain(phrase);
    // Verifier F4 on 41028f2: Skip for now leaves a callback pending.
    expect(MEASURE_NOTES.find((n) => n.startsWith("A callback is pending"))).toBe(
      "A callback is pending until an outcome other than Skip for now is logged on it, also while the lead is paused (it is then off your call list); not once the lead has replied or been stopped.",
    );
  });
});
