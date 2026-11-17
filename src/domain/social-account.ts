/**
 * The account URL rules of the message-request channels (ADR 0004 13.4, 14.3): the one reading of a CSV's account cell,
 * and of a test account the user gives. One function per channel, each by the same contract: a key, or null for anything
 * that is not an account, which reads as missing.
 */

/** The site's own first path segments, which are never a username. */
const INSTAGRAM_RESERVED = new Set(["p", "reel", "reels", "stories", "explore", "accounts", "direct", "tv", "about", "developer", "legal", "web"]);

/**
 * An Instagram account is `http(s)://(www.|m.)instagram.com/<username>`, with an optional trailing slash; query and
 * fragment are dropped and the username lower-cased. A username is 1 to 30 letters, digits, `.` and `_`, not starting or
 * ending with `.`. Its key is `https://www.instagram.com/<username>`. Anything else is not an account (null).
 */
export function instagramAccountKey(raw: string): string | null {
  const url = httpUrl(raw);
  if (url === null) return null;
  const host = url.hostname.toLowerCase();
  if (host !== "instagram.com" && host !== "www.instagram.com" && host !== "m.instagram.com") return null;
  const match = /^\/([^/]+)\/?$/.exec(url.pathname);
  const name = match?.[1]?.toLowerCase();
  if (name === undefined || !/^[a-z0-9._]{1,30}$/.test(name) || name.startsWith(".") || name.endsWith(".")) return null;
  if (INSTAGRAM_RESERVED.has(name)) return null;
  return `https://www.instagram.com/${name}`;
}

/**
 * The site's own first path segments on Facebook, which are never a profile's or a Page's username (ADR 0004 14.3): its
 * sections, its own pages and its scripts.
 */
const FACEBOOK_RESERVED = new Set([
  "about", "ads", "bookmarks", "business", "events", "friends", "fundraisers", "gaming", "groups", "hashtag", "help", "home",
  "legal", "live", "login", "marketplace", "media", "memories", "messages", "notifications", "pages", "people", "permalink",
  "photo", "photos", "places", "plugins", "policies", "privacy", "profile", "reel", "reels", "saved", "search", "settings",
  "share", "sharer", "stories", "story", "terms", "watch",
]);

/**
 * A Facebook profile or Page is `http(s)://(www.|m.|web.)facebook.com/<username>`, with an optional trailing slash, or
 * `http(s)://(www.|m.|web.)facebook.com/profile.php?id=<digits>`, a profile or Page with no username. Other query
 * parameters and the fragment are dropped. A username is 1 to 100 letters, digits, `.` and `-` (a Page with no username
 * of its own has a name and its number joined by `-`), not starting or ending with `.`, not one of the site's own first
 * segments, and lower-cased. The key is `https://www.facebook.com/<username>` or `https://www.facebook.com/profile.php?id=<digits>`.
 * Anything else (empty, a post, a group, an event, a photo, a share link, a `/pages/…` path, another host, a bare handle)
 * is not an account (null).
 */
export function facebookAccountKey(raw: string): string | null {
  const url = httpUrl(raw);
  if (url === null) return null;
  const host = url.hostname.toLowerCase();
  if (host !== "facebook.com" && host !== "www.facebook.com" && host !== "m.facebook.com" && host !== "web.facebook.com") return null;
  if (/^\/profile\.php\/?$/.test(url.pathname)) {
    const id = url.searchParams.get("id") ?? "";
    return /^[0-9]{1,30}$/.test(id) ? `https://www.facebook.com/profile.php?id=${id}` : null;
  }
  const match = /^\/([^/]+)\/?$/.exec(url.pathname);
  const name = match?.[1]?.toLowerCase();
  if (name === undefined || !/^[a-z0-9.-]{1,100}$/.test(name) || name.startsWith(".") || name.endsWith(".") || !/[a-z0-9]/.test(name)) return null;
  if (FACEBOOK_RESERVED.has(name) || name.endsWith(".php")) return null;
  return `https://www.facebook.com/${name}`;
}

function httpUrl(raw: string): URL | null {
  const text = raw.trim();
  if (text === "") return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}
