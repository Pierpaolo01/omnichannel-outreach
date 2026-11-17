import { describe, expect, it } from "vitest";
import { facebookAccountKey, instagramAccountKey } from "./social-account.ts";

// ADR 0004 13.4 and 14.3. Every account here is fictitious.
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

describe("facebookAccountKey", () => {
  it("normalises a profile's or a Page's username URL to one key", () => {
    const key = "https://www.facebook.com/exampleharbourphysio";
    for (const url of [
      "https://www.facebook.com/example.harbour.physio",
      "https://www.facebook.com/example.harbour.physio/",
      "  http://facebook.com/Example.Harbour.Physio  ",
      "https://m.facebook.com/example.harbour.physio?mibextid=abc#top",
      "https://web.facebook.com/example.harbour.physio",
      "https://WWW.Facebook.COM/example.harbour.physio/",
    ]) {
      expect(facebookAccountKey(url), url).toBe(key);
    }
  });

  it("reads usernames that differ only in their periods as one account, as Facebook does (the review bot on c072ae8)", () => {
    const key = facebookAccountKey("https://www.facebook.com/examplejohnsmith55");
    for (const url of ["https://www.facebook.com/Example.John.Smith55", "https://www.facebook.com/example.john.smith.55/", "https://m.facebook.com/examplejohn.smith55"]) expect(facebookAccountKey(url), url).toBe(key);
    // Instagram's periods stay part of the name.
    expect(instagramAccountKey("https://www.instagram.com/example.pat")).not.toBe(instagramAccountKey("https://www.instagram.com/examplepat"));
  });

  it("reads a Page with no username of its own, its name and number joined by dashes, as one", () => {
    expect(facebookAccountKey("https://www.facebook.com/Example-Harbour-Physio-100012345678901/")).toBe("https://www.facebook.com/example-harbour-physio-100012345678901");
    expect(facebookAccountKey("https://www.facebook.com/Example.Harbour-Physio-100012345678901")).toBe("https://www.facebook.com/exampleharbour-physio-100012345678901");
  });

  it("normalises a profile.php address by its number, dropping every other parameter", () => {
    const key = "https://www.facebook.com/profile.php?id=100012345678901";
    for (const url of ["https://www.facebook.com/profile.php?id=100012345678901", "https://m.facebook.com/profile.php?id=100012345678901&sk=about#x", "http://facebook.com/profile.php/?ref=x&id=100012345678901"]) {
      expect(facebookAccountKey(url), url).toBe(key);
    }
  });

  it("reads anything that is not a profile or a Page as missing", () => {
    for (const url of [
      "",
      "   ",
      "@example.harbour",
      "facebook.com/example.harbour",
      "https://www.facebook.com/",
      "https://www.facebook.com/profile.php",
      "https://www.facebook.com/profile.php?id=",
      "https://www.facebook.com/profile.php?id=abc",
      "https://www.facebook.com/groups/example.group",
      "https://www.facebook.com/groups",
      "https://www.facebook.com/events/123456",
      "https://www.facebook.com/pages/Example-Harbour/123456",
      "https://www.facebook.com/people/Example-Harbour/100012345678901/",
      "https://www.facebook.com/example.harbour/posts/123",
      "https://www.facebook.com/example.harbour/photos/a.1/2/",
      "https://www.facebook.com/photo.php?fbid=1",
      "https://www.facebook.com/permalink.php?story_fbid=1&id=2",
      "https://www.facebook.com/sharer/sharer.php?u=x",
      "https://www.facebook.com/share/abc123/",
      "https://www.facebook.com/watch",
      "https://www.facebook.com/marketplace",
      "https://www.facebook.com/login",
      "https://www.facebook.com/home.php",
      "https://www.facebook.com/.example",
      "https://www.facebook.com/example.",
      "https://www.facebook.com/example_harbour",
      "https://www.facebook.com/---",
      "https://www.facebook.com/" + "a".repeat(101),
      "https://facebook.example/harbourlanephysio",
      "https://notfacebook.com/example",
      "https://facebook.com.evil.example/example",
      "https://business.facebook.com/example",
      "https://fb.com/example",
      "ftp://www.facebook.com/example",
      "https://www.instagram.com/example",
      "not a url",
    ]) {
      expect(facebookAccountKey(url), url).toBeNull();
    }
  });
});
