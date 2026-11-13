import { describe, expect, test } from "vitest";
import { render } from "../../domain/sequence/copy.ts";
import { fallbackIn, setWindow, withFallback } from "./model.ts";

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
