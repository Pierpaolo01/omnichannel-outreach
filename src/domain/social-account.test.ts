import { describe, expect, it } from "vitest";
import { facebookAccountKey, facebookMayName, instagramAccountKey, instagramMayName } from "./social-account.ts";

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

/**
 * ADR 0004 14.3's address table, row by row: each form, what a track messages (`accountKey`) and what the test-contact
 * boundary reads (`mayName`). The expected keys are written out here, not derived. Fictitious accounts only.
 */
const N = "100012345678901";
const FB_ID = `https://www.facebook.com/profile.php?id=${N}`;
const FB_USER = "https://www.facebook.com/exampleharbour";
const FACEBOOK_TABLE: readonly (readonly [form: string, accountKey: string | null, mayName: readonly string[]])[] = [
  // A username, on every host that is another name for facebook.com; periods and capitals dropped.
  ["https://www.facebook.com/exampleharbour", FB_USER, [FB_USER]],
  ["https://www.facebook.com/Example.Harbour/", FB_USER, [FB_USER]],
  ["  http://facebook.com/example.harbour?ref=x#top  ", FB_USER, [FB_USER]],
  ["https://m.facebook.com/example.harbour", FB_USER, [FB_USER]],
  ["https://mbasic.facebook.com/exampleharbour", FB_USER, [FB_USER]],
  ["https://web.facebook.com/exampleharbour/", FB_USER, [FB_USER]],
  ["https://en-gb.facebook.com/exampleharbour", FB_USER, [FB_USER]],
  ["https://de-de.facebook.com/example.harbour", FB_USER, [FB_USER]],
  ["https://fb.com/exampleharbour", FB_USER, [FB_USER]],
  // Every form that carries the number: one id key.
  [`https://www.facebook.com/${N}`, FB_ID, [FB_ID]],
  [`https://www.facebook.com/${N}/`, FB_ID, [FB_ID]],
  [`https://www.facebook.com/profile.php?id=${N}`, FB_ID, [FB_ID]],
  [`https://m.facebook.com/profile.php?id=${N}&sk=about#x`, FB_ID, [FB_ID]],
  [`http://facebook.com/profile.php/?ref=x&id=00${N}`, FB_ID, [FB_ID]],
  [`https://www.facebook.com/Example-Clinic-${N}/`, FB_ID, [FB_ID]],
  [`https://mbasic.facebook.com/Example.Clinic-${N}`, FB_ID, [FB_ID]],
  // A hyphen with no number is no username and no number.
  ["https://www.facebook.com/Example-Harbour-Physio", null, []],
  ["https://www.facebook.com/example-clinic-123", null, []],
  // Forms the app never messages but that carry an account: the boundary reads them.
  [`https://www.facebook.com/pages/Example-Clinic/${N}`, null, [FB_ID]],
  [`https://www.facebook.com/people/Example-Clinic/${N}/`, null, [FB_ID]],
  ["https://www.facebook.com/exampleharbour/about", null, [FB_USER]],
  [`https://www.facebook.com/${N}/posts/1`, null, [FB_ID]],
  ["@example.harbour", null, [FB_USER]],
  ["exampleharbour", null, [FB_USER]],
  // Not an account in either reading.
  ["https://www.facebook.com/me", null, []],
  ["https://www.facebook.com/groups/example.group", null, []],
  ["https://www.facebook.com/events/123456", null, []],
  ["https://www.facebook.com/photo.php?fbid=1", null, []],
  ["https://www.facebook.com/sharer/sharer.php?u=x", null, []],
  ["https://www.facebook.com/profile.php", null, []],
  ["https://www.facebook.com/profile.php?id=abc", null, []],
  ["https://www.facebook.com/home.php", null, []],
  ["https://www.facebook.com/.example", null, []],
  ["https://www.facebook.com/example_harbour", null, []],
  ["https://business.facebook.com/exampleharbour", null, []],
  ["https://fb.me/exampleharbour", null, []],
  ["https://m.me/exampleharbour", null, []],
  ["https://facebook.com.evil.example/exampleharbour", null, []],
  ["https://facebook.example/harbourlanephysio", null, []],
  ["https://www.instagram.com/exampleharbour", null, []],
  ["ftp://www.facebook.com/exampleharbour", null, []],
  ["", null, []],
  ["not a url", null, []],
];

const IG = "https://www.instagram.com/example_harbour";
const INSTAGRAM_TABLE: readonly (readonly [form: string, accountKey: string | null, mayName: readonly string[]])[] = [
  ["https://www.instagram.com/example_harbour", IG, [IG]],
  ["http://instagram.com/Example_Harbour/", IG, [IG]],
  ["https://m.instagram.com/example_harbour?igsh=abc#top", IG, [IG]],
  ["https://www.instagram.com/example_harbour/reels", null, [IG]],
  ["@example_harbour", null, [IG]],
  ["@Example_Harbour", null, [IG]],
  ["https://instagr.am/example_harbour", null, []],
  ["https://business.instagram.com/example_harbour", null, []],
  ["https://www.instagram.com/p/ABC123/", null, []],
  ["example_harbour", null, []],
  ["", null, []],
];

describe("ADR 0004 14.3's address table, Facebook", () => {
  for (const [form, key, mayName] of FACEBOOK_TABLE) {
    it(`${JSON.stringify(form)}: messaged as ${key ?? "nothing"}; the boundary reads ${mayName.join(", ") || "nothing"}`, () => {
      expect(facebookAccountKey(form)).toBe(key);
      expect(facebookMayName(form)).toEqual(mayName);
    });
  }
  it("a username and a number are two keys: nothing in an address joins them", () => {
    expect(facebookAccountKey(FB_USER)).not.toBe(facebookAccountKey(`https://www.facebook.com/${N}`));
  });
});

describe("ADR 0004 14.3's address table, Instagram", () => {
  for (const [form, key, mayName] of INSTAGRAM_TABLE) {
    it(`${JSON.stringify(form)}: messaged as ${key ?? "nothing"}; the boundary reads ${mayName.join(", ") || "nothing"}`, () => {
      expect(instagramAccountKey(form)).toBe(key);
      expect(instagramMayName(form)).toEqual(mayName);
    });
  }
  it("periods stay part of an Instagram name", () => {
    expect(instagramAccountKey("https://www.instagram.com/example.pat")).not.toBe(instagramAccountKey("https://www.instagram.com/examplepat"));
  });
});
