import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";

export const fixture = (name: string): string => fileURLToPath(new URL(`../test/fixtures/scraper/${name}`, import.meta.url));

export async function chooseFiles(page: Page, run: "run1" | "run2"): Promise<void> {
  await page.getByLabel("People file", { exact: true }).setInputFiles(fixture(`people-${run}.csv`));
  await page.getByLabel("Businesses file", { exact: true }).setInputFiles(fixture(`businesses-${run}.csv`));
}

/** A link in the four-area navigation rail. */
export function nav(page: Page, area: "Today" | "Calls" | "Leads" | "Campaigns"): Locator {
  return page.getByRole("navigation", { name: "Areas" }).getByRole("link", { name: area, exact: true });
}
