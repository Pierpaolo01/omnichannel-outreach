import { describe, expect, test } from "vitest";
import { renderSegments } from "./copy-preview.ts";
import { render } from "./sequence/copy.ts";

describe("copy rendered in pieces for the preview", () => {
  const lead = { first_name: "Pat", company: "Harbour Lane Physio", title: "  " };

  test("joined, the pieces are exactly what the handover's render sends", () => {
    const texts = [
      "Hi {{first_name|there}}, about {{ company }}.",
      "{{title|your role}} and {{ title | spaced }} {{company}}{{company}}",
      "No fields at all.",
      "{{first_name}}",
      "Unclosed {{first_name and {single} braces",
      "",
    ];
    for (const text of texts) {
      const rendered = render(text, lead);
      expect(rendered.ok).toBe(true);
      expect(renderSegments(text, lead).map((s) => s.text).join("")).toBe(rendered.ok ? rendered.text : null);
    }
  });

  test("marks the lead's values, fallbacks for blank or absent fields, and fields with no fallback", () => {
    expect(renderSegments("Hi {{first_name}} at {{title|your desk}}{{city}}!", lead)).toEqual([
      { text: "Hi ", kind: "literal" },
      { text: "Pat", kind: "value", field: "first_name" },
      { text: " at ", kind: "literal" },
      { text: "your desk", kind: "fallback", field: "title" },
      { text: "", kind: "missing", field: "city" },
      { text: "!", kind: "literal" },
    ]);
    expect(render("{{city}}", lead)).toEqual({ ok: false, missing: ["city"] });
  });
});
