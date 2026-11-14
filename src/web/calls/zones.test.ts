import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Standing check (council on 32454ea, C; ADR 0003 4.4.1, "Read, not computed"): every sentence about a call states a
 * day, a time or a state from a field of the server's read, formatted in a zone passed in explicitly. So no module
 * under src/web/calls, and not Activity, reads the browser's zone, or takes a zone or `today` that may be left out.
 */
const root = join(import.meta.dirname, "..");
const files = [...readdirSync(join(root, "calls")).filter((f) => /\.tsx?$/.test(f) && !f.includes(".test.")).map((f) => join(root, "calls", f)), join(root, "activity.tsx")];

const FORBIDDEN: readonly [RegExp, string][] = [
  [/localZone\(/, "localZone()"],
  [/resolvedOptions\(\)/, "the browser's resolved zone"],
  [/toDateString\(/, "a date in the browser's zone"],
  [/\.get(Hours|Minutes|Date|Day|Month|FullYear)\(/, "a field in the browser's zone"],
  [/\b(userZone|zone|today)\?\s*:/, "an optional zone or today"],
  [/\b(userZone|zone|today)\s*:\s*string(\s*\|\s*null)?\s*=/, "a zone or today with a default"],
];

describe("no call sentence takes its zone from the browser, or a zone or today that may be left out", () => {
  test("the files are found", () => expect(files.length).toBeGreaterThan(5));
  for (const file of files) {
    test(file.slice(root.length + 1), () => {
      const source = readFileSync(file, "utf8");
      const found = FORBIDDEN.filter(([pattern]) => pattern.test(source)).map(([, what]) => what);
      expect(found).toEqual([]);
    });
  }
});
