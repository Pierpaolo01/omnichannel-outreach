import { describe, expect, test } from "vitest";
import { calledWork, handed, MOBILE, MONDAY_9, multiTrackState, step, subjectState, track, withAttempts } from "../../test/support/sequence-state.ts";
import { enterMain, evaluate } from "../domain/sequence/progress.ts";
import type { SubjectState } from "../domain/sequence/state.ts";
import { DEFAULT_RULES } from "./engine/rules.ts";
import { stepsOf } from "./test-runs.ts";
import { stepStateText } from "../web/campaign/testRunWording.ts";

/**
 * The Test run tab never shows ordinary progress for a held step (ADR 0003 "Reads that say when"; the verifier on cc9bf55,
 * item 10): each hold, and a step with no good destination, is the row's reason, as in the enrollment read. Fictitious.
 */

const H = 3_600_000;
const open = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
function testRun(steps = [step("s1", { threading: "new_subject" }), step("s2", { waitDays: 1, threading: "new_subject" })], fields: Partial<SubjectState> = {}): SubjectState {
  const base = subjectState(fields);
  const def = { ...base.campaign.definition, tracks: base.campaign.definition.tracks.map((t) => ({ ...t, window: open, steps })) };
  const s: SubjectState = { ...base, subject: { ...base.subject, kind: "test_run" }, campaign: { ...base.campaign, definition: def } };
  return evaluate(enterMain(s, MONDAY_9), MONDAY_9);
}
const rowOf = (s: SubjectState, stepId: string, now = MONDAY_9) => stepsOf(s, DEFAULT_RULES, now).find((r) => r.stepId === stepId);

describe("each hold is the Test run row's held state with its reason, ahead of 'with the provider' (every hold, email and SMS)", () => {
  test("silently sent work whose lookup answered unknown: unresolved, not 'With Instantly'", () => {
    const s = withAttempts(testRun(), [handed({ id: "a-0", idempotencyKey: "a-0" })], [calledWork({ key: "a-0", unresolvedSince: MONDAY_9 + 17 * 60_000 })]);
    expect(rowOf(s, "s1", MONDAY_9 + 18 * 60_000)).toMatchObject({ state: "held", at: null, hold: "unresolved" });
  });
  test("handed over and not yet answered: with the provider (no hold)", () => {
    const s = withAttempts(testRun(), [handed({ id: "a-0", idempotencyKey: "a-0" })]);
    expect(rowOf(s, "s1", MONDAY_9 + 60_000)).toMatchObject({ state: "with_provider" });
  });
  test("the provider skipped it: provider_skipped", () => {
    const s = withAttempts(testRun(), [handed({ id: "a-0", idempotencyKey: "a-0", state: "rejected", rejectReason: "provider_skipped" })], [calledWork({ key: "a-0", settled: "rejected" })]);
    expect(rowOf(s, "s1", MONDAY_9 + 60_000)).toMatchObject({ state: "held", at: null, hold: "provider_skipped" });
  });
  test("copy that cannot render: render_failed", () => {
    expect(rowOf(testRun([step("s1", { threading: "new_subject", body: "Hi {{title}}" })]), "s1")).toMatchObject({ state: "held", at: null, hold: "render_failed" });
  });
  test("a follow-up with no thread to continue: no_thread", () => {
    expect(rowOf(testRun([step("s1", { threading: "continue_thread" })]), "s1")).toMatchObject({ state: "held", at: null, hold: "no_thread" });
  });
  test("no good address to send to: no_destination", () => {
    const s = testRun();
    const bad = { ...s, lead: { ...s.lead, resolved: { "d-email": { liveId: "d-email", bad: true, owned: true } } } };
    expect(rowOf(bad, "s1")).toMatchObject({ state: "due", waits: "no_destination" });
  });
});

describe("an SMS hold on the Test run tab comes before the provider's progress, as an email's does (merge of 2c27d03)", () => {
  test("a text whose work the provider has not confirmed: held as unresolved, not 'With the SMS provider'", () => {
    const base = multiTrackState([track("t2", "sms", [step("m1", { subject: "", body: "Hi {{first_name|there}}." })])]);
    const s = evaluate(enterMain({ ...base, subject: { ...base.subject, kind: "test_run" } }, MONDAY_9), MONDAY_9);
    const sent = withAttempts(s, [handed({ id: "a-0", idempotencyKey: "a-0", trackId: "t2", stepId: "m1", accountId: "+447700900001", destination: MOBILE.key })], [calledWork({ key: "a-0", trackId: "t2", stepId: "m1", accountId: "+447700900001", destination: MOBILE.key, unresolvedSince: MONDAY_9 + 17 * 60_000 })]);
    expect(rowOf(sent, "m1", MONDAY_9 + 18 * 60_000)).toMatchObject({ channel: "sms", state: "held", at: null, hold: "unresolved" });
  });
});

describe("a text held for its transport (the re-check of ff01571)", () => {
  test("the row is an SMS row waiting on no_transport, and the tab words it with the SMS provider", () => {
    const base = multiTrackState([track("t2", "sms", [step("m1", { subject: "", body: "Hi {{first_name|there}}." }), step("m2", { subject: "", body: "Again, {{first_name|there}}." })])]);
    const s = evaluate(enterMain({ ...base, subject: { ...base.subject, kind: "test_run" } }, MONDAY_9), MONDAY_9);
    const row = stepsOf(s, DEFAULT_RULES, MONDAY_9 + H, { transportAvailable: (channel) => channel !== "sms" }).find((r) => r.stepId === "m1");
    expect(row).toMatchObject({ channel: "sms", state: "due", at: null, waits: "no_transport" });
    expect(row && stepStateText(row, "Europe/London", new Date(MONDAY_9 + H).toISOString())).toBe("Waiting: the SMS provider can’t send this text yet");
  });
});
