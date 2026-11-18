import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
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
      // axe skips text it cannot resolve (a select's chevron image, for one) and placeholders;
      // measure both here, so nothing on the screen goes unchecked.
      const unresolved = results.incomplete
        .filter((v) => v.id === "color-contrast")
        .flatMap((v) => v.nodes.map((n) => String(n.target[0])));
      expect([...found, ...(await contrastProblemsAxeSkips(page, unresolved))]).toEqual([]);
    });
  }
}

/**
 * What axe leaves out:
 * - text axe could not resolve, measured against its nearest solid background;
 * - every visible placeholder in an enabled field, against the field;
 * - readable text faded by opacity (a refreshing list must not dim its rows).
 */
async function contrastProblemsAxeSkips(page: Page, unresolved: readonly string[]): Promise<string[]> {
  return page.evaluate((selectors) => {
    const problems: string[] = [];
    const rgba = (css: string): [number, number, number, number] => {
      const m = /rgba?\(([^)]+)\)/.exec(css);
      if (!m?.[1]) return [0, 0, 0, 0];
      const [r = 0, g = 0, b = 0, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return [r, g, b, a];
    };
    const luminance = ([r, g, b]: number[]) =>
      [r, g, b]
        .map((v) => (v ?? 0) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((sum, v, i) => sum + v * ([0.2126, 0.7152, 0.0722][i] ?? 0), 0);
    const ratio = (a: number[], b: number[]) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
    };
    const backgroundOf = (el: Element): [number, number, number] => {
      for (let node: Element | null = el; node; node = node.parentElement) {
        const [r, g, b, a] = rgba(getComputedStyle(node).backgroundColor);
        if (a > 0.99) return [r, g, b];
      }
      return [255, 255, 255];
    };
    const visible = (el: Element) => {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return box.width > 1 && box.height > 1 && style.visibility !== "hidden" && style.display !== "none";
    };

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (!el || !visible(el)) continue;
      const style = getComputedStyle(el);
      const size = parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      const contrast = ratio(rgba(style.color), backgroundOf(el));
      if (contrast < (large ? 3 : 4.5)) problems.push(`"${el.textContent.trim().slice(0, 40)}" (${selector}) is ${contrast.toFixed(2)}:1`);
    }

    for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input[placeholder], textarea[placeholder]")) {
      if (field.disabled || field.value !== "" || !visible(field)) continue;
      const style = getComputedStyle(field, "::placeholder");
      const [r, g, b, a] = rgba(style.color);
      const alpha = a * Number(style.opacity || 1);
      const bg = backgroundOf(field);
      const shown = [r, g, b].map((c, i) => c * alpha + (bg[i] ?? 0) * (1 - alpha));
      const contrast = ratio(shown, bg);
      if (contrast < 4.5) problems.push(`placeholder "${field.placeholder}" is ${contrast.toFixed(2)}:1`);
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const faded = new Set<Element>();
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const el = text.parentElement;
      if (!el || !text.textContent?.trim() || !visible(el) || el.closest("[disabled], [aria-disabled='true'], .sr-only")) continue;
      let opacity = 1;
      for (let node: Element | null = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
      if (opacity < 0.999) faded.add(el);
    }
    for (const el of faded) problems.push(`text "${el.textContent.trim().slice(0, 40)}" is faded by opacity`);
    return problems;
  }, unresolved);
}
