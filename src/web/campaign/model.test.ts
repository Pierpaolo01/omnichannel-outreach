import { describe, expect, test } from "vitest";
import { render } from "../../domain/sequence/copy.ts";
import type { StepDefinition, TrackDefinition } from "../../shared/api.ts";
import { fallbackIn, removeStep, setWindow, threadSubjectOf, withFallback } from "./model.ts";
import { draftProblems } from "./saveQueue.ts";

describe("the editor's fallback field rewrites every use of the field in a step", () => {
  test("adds, changes and removes a fallback, leaving other fields alone", () => {
    const text = "Hi {{first_name}}, {{ first_name | there }} at {{company}}.";
    const added = withFallback(text, "first_name", "there");
    expect(added).toBe("Hi {{first_name|there}}, {{first_name|there}} at {{company}}.");
    expect(render(added, { company: "Elm" })).toEqual({ ok: true, text: "Hi there, there at Elm." });
    expect(withFallback(added, "first_name", "")).toBe("Hi {{first_name}}, {{first_name}} at {{company}}.");
    // Braces and bars would end the token early, so they are dropped from a fallback.
    expect(withFallback("{{city}}", "city", "a|b}")).toBe("{{city|ab}}");
    expect(fallbackIn({ id: "s", waitDays: 0, subject: "{{city}}", body: "{{city|London}}", threading: "new_subject", removed: false }, "city")).toBe("London");
  });

  test("a sending window is one hours range on each chosen day, Monday first", () => {
    expect(setWindow([0, 1, 5], { start: 9, end: 17 })).toEqual([
      { day: 1, start: 9, end: 17 },
      { day: 5, start: 9, end: 17 },
      { day: 0, start: 9, end: 17 },
    ]);
  });
});

describe("removing an email and following a thread (review: SequenceTab.tsx:220 and :274)", () => {
  const step = (id: string, fields: Partial<StepDefinition> = {}): StepDefinition => ({ id, waitDays: 2, subject: "", body: `${id} copy`, threading: "continue_thread", removed: false, ...fields });
  const track = (steps: StepDefinition[]): TrackDefinition => ({ id: "t1", channel: "email", branch: "main", window: [{ day: 1, start: 9, end: 17 }], steps, start: { kind: "entry" }, removed: false });

  test("removing Email 1 makes the next email a first email: no wait, its own subject, its copy kept", () => {
    const next = removeStep(track([step("s1", { waitDays: 0, subject: "Hello", threading: "new_subject" }), step("s2"), step("s3", { waitDays: 4 })]), "s1");
    expect(next.steps.map((s) => [s.id, s.waitDays, s.threading, s.subject, s.body])).toEqual([
      ["s2", 0, "new_subject", "", "s2 copy"],
      ["s3", 4, "continue_thread", "", "s3 copy"],
    ]);
    expect(draftProblems({ timezone: "UTC", callSkipLimitDays: 2, emailPool: [], tracks: [next] })).toEqual([]);
  });

  test("removing a later email leaves the others as they were", () => {
    const steps = [step("s1", { waitDays: 0, subject: "Hello", threading: "new_subject" }), step("s2"), step("s3")];
    expect(removeStep(track(steps), "s2").steps).toEqual([steps[0], steps[2]]);
  });

  test("a continue-thread email continues the nearest earlier email that started a thread", () => {
    const steps = [step("s1", { waitDays: 0, subject: "A", threading: "new_subject" }), step("s2", { subject: "B", threading: "new_subject" }), step("s3"), step("s4")];
    expect([1, 2, 3].map((i) => threadSubjectOf(steps, i))).toEqual(["A", "B", "B"]);
  });
});
