import { describe, expect, test } from "vitest";
import { scraperExport } from "../../test/support/fixtures.ts";
import { parseScraperExport } from "./scraper-export.ts";

describe("parseScraperExport", () => {
  test("joins people to businesses and keeps blank last names", () => {
    const result = parseScraperExport(scraperExport("run1"));
    if (!result.ok) throw new Error(JSON.stringify(result.problems));

    expect(result.value.businesses).toHaveLength(6);
    expect(result.value.people).toHaveLength(7);
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
    const { businessesCsv, peopleCsv } = scraperExport("run1");
    const withoutPlace = businessesCsv.replace("business_id,place_id,", "business_id,place,");
    const result = parseScraperExport({ businessesCsv: withoutPlace, peopleCsv });
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
    expect(result.problems[0]?.message).toMatch(/line 8/);
  });

  test("rejects a people file whose rows belong to none of the businesses, as from another scraper run", () => {
    const { peopleCsv } = scraperExport("run1");
    const header = scraperExport("run1").businessesCsv.split("\n")[0] ?? "";
    const result = parseScraperExport({ businessesCsv: `${header}\n`, peopleCsv });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([{ file: "pair", message: expect.stringMatching(/same scraper run/) }]);
  });

  test("tells the user when the two files are swapped", () => {
    const { businessesCsv, peopleCsv } = scraperExport("run1");
    const result = parseScraperExport({ businessesCsv: peopleCsv, peopleCsv: businessesCsv });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((p) => p.message)).toEqual([
      expect.stringMatching(/People file/),
      expect.stringMatching(/Businesses file/),
    ]);
  });

  test("ignores an unrecognised timezone instead of guessing one", () => {
    const { businessesCsv, peopleCsv } = scraperExport("run1");
    const result = parseScraperExport({ businessesCsv: businessesCsv.replace(/Europe\/London/, "Mars/Olympus"), peopleCsv });
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.businesses[0]?.timezone).toBeNull();
  });
});
