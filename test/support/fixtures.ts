import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Fictitious paired scraper exports with the verified real headers. */
export type FixtureRun = "run1" | "run2";

export function scraperExport(run: FixtureRun): { businessesCsv: string; peopleCsv: string } {
  return {
    businessesCsv: readFixture(`businesses-${run}.csv`),
    peopleCsv: readFixture(`people-${run}.csv`),
  };
}

function readFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/scraper/${name}`, import.meta.url)), "utf8");
}
