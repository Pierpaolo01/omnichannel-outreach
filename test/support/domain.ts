import { parseScraperExport, type ScraperExport } from "../../src/domain/scraper-export.ts";
import { scraperExport, type FixtureRun } from "./fixtures.ts";

export function parsedFixture(run: FixtureRun): ScraperExport {
  const result = parseScraperExport(scraperExport(run));
  if (!result.ok) throw new Error(`fixture ${run} did not parse: ${JSON.stringify(result.problems)}`);
  return result.value;
}

/** Deterministic identifiers: id-1, id-2, ... */
export function sequentialIds(prefix = "id"): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}
