import { expect, test } from "@playwright/test";
import { SCREENS, seedData, type SeedData } from "./screens.ts";

/**
 * Standing check: no route or state scrolls sideways or clips content, at laptop widths and
 * down to a phone. Both the page and every scrollable or clipping element inside it are measured.
 */
const WIDTHS = [1440, 1024, 768, 390] as const;

let data: SeedData;
test.beforeAll(async ({ request }) => {
  data = await seedData(request);
});

for (const width of WIDTHS) {
  for (const screen of SCREENS) {
    test(`${screen.name} fits without sideways scrolling at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await screen.open(page, data);
      const overflow = await page.evaluate(() => {
        const viewport = document.documentElement.clientWidth;
        const problems: string[] = [];
        const describe = (el: Element) => {
          const text = el.textContent.trim().slice(0, 40);
          return `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}> "${text}"`;
        };
        if (document.documentElement.scrollWidth > viewport) {
          problems.push(`page is ${document.documentElement.scrollWidth}px wide in a ${viewport}px viewport`);
        }
        // Screen-reader-only text (including responsive sr-only) is clipped to a 1px box on purpose.
        const visuallyHidden = (el: Element) => {
          for (let node: Element | null = el; node; node = node.parentElement) {
            const r = node.getBoundingClientRect();
            if (r.width <= 1 && r.height <= 1 && getComputedStyle(node).position === "absolute") return true;
          }
          return false;
        };
        for (const el of document.querySelectorAll("body *")) {
          if (["INPUT", "SELECT", "TEXTAREA", "OPTION"].includes(el.tagName) || visuallyHidden(el)) continue;
          const style = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          if (style.display === "none" || style.visibility === "hidden" || box.width === 0 || box.height === 0) continue;
          if (["auto", "scroll", "hidden", "clip"].includes(style.overflowX) && el.scrollWidth > el.clientWidth + 1) {
            problems.push(`${describe(el)} needs ${el.scrollWidth}px but has ${el.clientWidth}px`);
          }
          if (box.right > viewport + 1 || box.left < -1) problems.push(`${describe(el)} reaches past the viewport edge`);
        }
        return problems;
      });
      expect(overflow).toEqual([]);
    });
  }
}
