import { describe, expect, test } from "vitest";
import { scraperExport } from "../../test/support/fixtures.ts";
import { parseScraperExport } from "./scraper-export.ts";

describe("parseScraperExport", () => {
  test("joins people to businesses and keeps blank last names", () => {
    const result = parseScraperExport(scraperExport("run1"));
    if (!result.ok) throw new Error(JSON.stringify(result.problems));

    expect(result.value.businesses).toHaveLength(5);
    expect(result.value.people).toHaveLength(6);
    const tom = result.value.people.find((p) => p.sourcePersonId === "pp-tom-02");
    expect(tom).toMatchObject({ fullName: "Tom", firstName: "Tom", lastName: "", title: "Operations lead" });
  });

  test("parses the JSON array inside the source_urls cell", () => {
    const result = parseScraperExport(scraperExport("run1"));
    if (!result.ok) throw new Error("expected ok");
    const amira = result.value.people.find((p) => p.sourcePersonId === "pp-amira-hassan-01");
    expect(amira?.sourceUrls).toEqual([
      "https://www.harbourlanephysio.example/team",
      'https://news.example/2026/harbour-lane, "opening"',
    ]);
  });

  test("reads missing channels as absent, not as empty strings", () => {
    const result = parseScraperExport(scraperExport("run1"));
    if (!result.ok) throw new Error("expected ok");
    const elm = result.value.businesses.find((b) => b.name === "Elm Street Chiropractic");
    expect(elm?.mainPhone).toBeNull();
    expect(elm?.generalEmails).toEqual(["contact@elmstreetchiro.example"]);
    const harbour = result.value.businesses.find((b) => b.name === "Harbour Lane Physio");
    expect(harbour?.mainPhone).toEqual({ e164: "+442079460101", original: "020 7946 0101" });
    expect(harbour?.timezone).toBe("Europe/London");
  });

  test("rejects files whose headers are missing required columns, naming the file and columns", () => {
    const { peopleCsv } = scraperExport("run1");
    const result = parseScraperExport({ businessesCsv: peopleCsv, peopleCsv });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.file).toBe("businesses");
    expect(result.problems[0]?.message).toMatch(/place_id/);
  });

  test("rejects rows with the wrong number of cells", () => {
    const { businessesCsv, peopleCsv } = scraperExport("run1");
    const broken = `${businessesCsv}only,three,cells\n`;
    const result = parseScraperExport({ businessesCsv: broken, peopleCsv });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]).toMatchObject({ file: "businesses" });
    expect(result.problems[0]?.message).toMatch(/line 7/);
  });

  test("ignores an unrecognised timezone instead of guessing one", () => {
    const { businessesCsv, peopleCsv } = scraperExport("run1");
    const result = parseScraperExport({ businessesCsv: businessesCsv.replace(/Europe\/London/, "Mars/Olympus"), peopleCsv });
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.businesses[0]?.timezone).toBeNull();
  });
});
