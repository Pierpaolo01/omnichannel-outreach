import { describe, expect, it } from "vitest";
import { linkedinProfileKey } from "./linkedin-profile.ts";

// ADR 0004 section 5. Every URL here is fictitious.
describe("linkedinProfileKey", () => {
  it("normalises a member profile URL to one key", () => {
    const key = "https://www.linkedin.com/in/fictional-pat-oneil";
    for (const url of [
      "https://www.linkedin.com/in/fictional-pat-oneil",
      "https://www.linkedin.com/in/fictional-pat-oneil/",
      "  http://linkedin.com/in/Fictional-Pat-ONeil  ",
      "https://uk.linkedin.com/in/fictional-pat-oneil?trk=public#about",
      "https://WWW.LinkedIn.com/in/fictional%2Dpat%2Doneil/",
    ]) {
      expect(linkedinProfileKey(url), url).toBe(key);
    }
  });

  it("reads anything that is not a member profile as missing", () => {
    for (const url of [
      "",
      "   ",
      "linkedin.com/in/fictional-pat",
      "https://www.linkedin.com/company/fictional-clinic",
      "https://www.linkedin.com/pub/fictional-pat/1/2/3",
      "https://www.linkedin.com/sales/people/ABC",
      "https://www.linkedin.com/search/results/people/?keywords=pat",
      "https://www.linkedin.com/in/",
      "https://www.linkedin.com/in/a/b",
      "https://linkedin.example/in/fictional-pat",
      "https://notlinkedin.com/in/fictional-pat",
      "https://linkedin.com.evil.example/in/fictional-pat",
      "ftp://www.linkedin.com/in/fictional-pat",
      "https://www.linkedin.com/in/%E0%A4%A",
      "not a url",
    ]) {
      expect(linkedinProfileKey(url), url).toBeNull();
    }
  });
});
