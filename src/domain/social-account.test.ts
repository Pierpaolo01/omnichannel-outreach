import { describe, expect, it } from "vitest";
import { instagramAccountKey } from "./social-account.ts";

// ADR 0004 13.4. Every account here is fictitious.
describe("instagramAccountKey", () => {
  it("normalises an account URL to one key", () => {
    const key = "https://www.instagram.com/example_harbour.physio";
    for (const url of [
      "https://www.instagram.com/example_harbour.physio",
      "https://www.instagram.com/example_harbour.physio/",
      "  http://instagram.com/Example_Harbour.Physio  ",
      "https://m.instagram.com/example_harbour.physio?igsh=abc#top",
      "https://WWW.Instagram.COM/example_harbour.physio/",
    ]) {
      expect(instagramAccountKey(url), url).toBe(key);
    }
  });

  it("reads anything that is not an account as missing", () => {
    for (const url of [
      "",
      "   ",
      "@example_harbour.physio",
      "instagram.com/example_harbour.physio",
      "https://www.instagram.com/",
      "https://www.instagram.com/p/ABC123/",
      "https://www.instagram.com/reel/ABC123",
      "https://www.instagram.com/stories/example_harbour.physio/123",
      "https://www.instagram.com/explore/tags/physio",
      "https://www.instagram.com/accounts/login",
      "https://www.instagram.com/direct/inbox",
      "https://www.instagram.com/example_harbour.physio/tagged",
      "https://www.instagram.com/.example",
      "https://www.instagram.com/example.",
      "https://www.instagram.com/example-harbour",
      "https://www.instagram.com/" + "a".repeat(31),
      "https://instagram.example/harbourlanephysio",
      "https://notinstagram.com/example",
      "https://instagram.com.evil.example/example",
      "https://business.instagram.com/example",
      "ftp://www.instagram.com/example",
      "https://www.facebook.com/example",
      "not a url",
    ]) {
      expect(instagramAccountKey(url), url).toBeNull();
    }
  });
});
