import { expect, test } from "@playwright/test";
import { FOCUS_TRANSITIONS, seedData, type SeedData } from "./screens.ts";

/**
 * Standing check: every transition in FOCUS_TRANSITIONS leaves focus on a deliberate, visible
 * control, never on the page body (PR 41 verification, F3).
 */
let data: SeedData;
test.beforeAll(async ({ request }) => {
  data = await seedData(request);
});

for (const transition of FOCUS_TRANSITIONS) {
  test(transition.name, async ({ page }) => {
    await transition.open(page, data);
    await transition.act(page);
    await expect(transition.focused(page)).toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
    // Focus that moved by script is still shown: the focused control draws its ring.
    expect(await page.evaluate(() => document.activeElement?.matches(":focus-visible") ?? false)).toBe(true);
  });
}
