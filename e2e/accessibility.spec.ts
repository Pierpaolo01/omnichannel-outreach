import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { SCREENS, seedData, type SeedData } from "./screens.ts";

/**
 * Standing check: an axe scan (WCAG 2.1 A and AA, colour contrast included) of every route and
 * state in both themes. A new screen joins the scan by being added to e2e/screens.ts.
 */
let data: SeedData;
test.beforeAll(async ({ request }) => {
  data = await seedData(request);
});

for (const scheme of ["light", "dark"] as const) {
  for (const screen of SCREENS) {
    test(`${screen.name} has no accessibility violations in the ${scheme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await screen.open(page, data);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const found = results.violations.flatMap((v) =>
        v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}: ${n.failureSummary?.split("\n").slice(1).join(" ").trim() ?? ""}`),
      );
      expect(found).toEqual([]);
    });
  }
}
