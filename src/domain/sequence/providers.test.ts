import { describe, expect, test } from "vitest";
import { MOBILE, multiTrackState, step, track } from "../../../test/support/sequence-state.ts";
import { providerFresh, relevantChannels, waitingOn, type ProviderEvidence } from "./providers.ts";

/** Which providers a lead's send waits on (ADR 0003 "Ticket 20a", after the council on 13dad92). Data is fictitious. */

const T = Date.parse("2026-11-02T09:00:00Z");
const evidence = (email: number | null, sms: number | null, linkedin: number | null = T): Record<"email" | "sms" | "linkedin", ProviderEvidence> => ({
  email: { contactAt: email, freshForMs: 60_000, failedAt: null, failedPart: null },
  sms: { contactAt: sms, freshForMs: 60_000, failedAt: null, failedPart: null },
  linkedin: { contactAt: linkedin, freshForMs: 60_000, failedAt: null, failedPart: null },
});

describe("a provider is fresh while its last contact stands", () => {
  test("within its freshness, and never with no contact", () => {
    expect(providerFresh(evidence(T, null).email, T + 60_000)).toBe(true);
    expect(providerFresh(evidence(T, null).email, T + 60_001)).toBe(false);
    expect(providerFresh(evidence(null, null).email, T)).toBe(false);
  });
});

describe("the providers a lead's send waits on", () => {
  test("an email-only lead waits on email only; an SMS outage does not hold it", () => {
    const s = multiTrackState([track("e1", "email", [step("s1", { threading: "new_subject" })])], "both");
    expect(relevantChannels(s, "e1")).toEqual(["email"]);
    expect(waitingOn(evidence(T, null), relevantChannels(s, "e1"), T)).toEqual([]);
  });

  test("a lead with email and SMS tracks waits on both: a reply on either would stop it", () => {
    const s = multiTrackState([track("e1", "email", [step("s1", { threading: "new_subject" })]), track("x1", "sms", [step("t1")])], "both");
    expect(relevantChannels(s, "e1")).toEqual(["email", "sms"]);
    expect(waitingOn(evidence(T, null), relevantChannels(s, "e1"), T)).toEqual(["sms"]);
    expect(waitingOn(evidence(null, T), relevantChannels(s, "x1"), T)).toEqual(["email"]);
  });

  test("a channel the lead cannot be reached on is not relevant (no mobile: no texts, no text replies)", () => {
    const s = multiTrackState([track("e1", "email", [step("s1", { threading: "new_subject" })]), track("x1", "sms", [step("t1")])], "email");
    expect(relevantChannels(s, "e1")).toEqual(["email"]);
    expect(MOBILE.mobile).toBe(true);
  });
});
