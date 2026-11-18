/**
 * The account URL rules of the message-request channels (ADR 0004 13.4, 14.3), two readings per channel:
 *
 * - `…AccountKey`: what a track messages, and what ownership and bad marks compare. One key per account the application
 *   can open, or null for anything else, which reads as missing (its safe side: skip rather than message).
 * - `…MayName`: every key an imported cell may name, for the test-contact boundary. A superset of the account key: it adds
 *   forms the application never messages but that plainly carry an account's username or number. Refusing a test contact
 *   is the boundary's safe side, so where two forms could be one account and the application cannot know, this reading
 *   treats them as one.
 *
 * ADR 0004 14.3 lists every form and what each reading gives it.
 */

/** The site's own first path segments, which are never a username. */
const INSTAGRAM_RESERVED = new Set(["p", "reel", "reels", "stories", "explore", "accounts", "direct", "tv", "about", "developer", "legal", "web"]);

const instagramUsernameKey = (segment: string | undefined): string | null => {
  const name = segment?.toLowerCase();
  if (name === undefined || !/^[a-z0-9._]{1,30}$/.test(name) || name.startsWith(".") || name.endsWith(".") || INSTAGRAM_RESERVED.has(name)) return null;
  return `https://www.instagram.com/${name}`;
};

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
  return instagramUsernameKey(match?.[1]);
}

/**
 * Every Instagram key an imported cell may name (ADR 0004 14.3): its account key; a bare `@username`; the first segment
 * of a longer path on an account host (`/<username>/reels`).
 */
export function instagramMayName(raw: string): readonly string[] {
  const exact = instagramAccountKey(raw);
  if (exact !== null) return [exact];
  const text = raw.trim();
  const handle = /^@([^\s/@]+)$/.exec(text)?.[1];
  if (handle !== undefined) return keys(instagramUsernameKey(handle));
  const url = httpUrl(text);
  if (url === null) return [];
  const host = url.hostname.toLowerCase();
  if (host !== "instagram.com" && host !== "www.instagram.com" && host !== "m.instagram.com") return [];
  return keys(instagramUsernameKey(segments(url)[0]));
}

/**
 * The site's own first path segments on Facebook, which are never a profile's or a Page's username (ADR 0004 14.3): its
 * sections, its own pages and its scripts, and `me` (whoever is signed in).
 */
const FACEBOOK_RESERVED = new Set([
  "about", "ads", "bookmarks", "business", "events", "friends", "fundraisers", "gaming", "groups", "hashtag", "help", "home",
  "legal", "live", "login", "marketplace", "me", "media", "memories", "messages", "notifications", "pages", "people", "permalink",
  "photo", "photos", "places", "plugins", "policies", "privacy", "profile", "reel", "reels", "saved", "search", "settings",
  "share", "sharer", "stories", "story", "terms", "watch",
]);

/**
 * The hosts that are only other names for facebook.com with the same path (ADR 0004 14.3): `www.`, `m.`, `mbasic.`,
 * `web.`, a locale such as `en-gb.`, and `fb.com`. Not `business.facebook.com` (the business tools, not profiles), not
 * `fb.me` or `m.me` (short links whose target the application cannot know), not any other host.
 */
const isFacebookHost = (host: string): boolean =>
  ["facebook.com", "www.facebook.com", "m.facebook.com", "mbasic.facebook.com", "web.facebook.com", "fb.com", "www.fb.com"].includes(host) || /^[a-z]{2}-[a-z]{2}\.facebook\.com$/.test(host);

const facebookNumberKey = (digits: string): string | null => {
  const n = digits.replace(/^0+/, "");
  return /^[0-9]{1,30}$/.test(n) ? `https://www.facebook.com/profile.php?id=${n}` : null;
};

/**
 * One path segment as a Facebook account: a number; a Page with no username, `<name>-<number>` (a username has no hyphen,
 * so the trailing five or more digits are its number); or a username, lower-cased with its periods dropped (Facebook
 * documents that periods and capitals do not tell usernames apart). Null for anything else, a reserved segment included.
 */
function facebookSegmentKey(segment: string | undefined): string | null {
  if (segment === undefined) return null;
  const s = segment.toLowerCase();
  if (/^[0-9]+$/.test(s)) return facebookNumberKey(s);
  if (s.includes("-")) {
    const number = /^[a-z0-9.-]*[a-z0-9.]-([0-9]{5,30})$/.exec(s)?.[1];
    return number === undefined ? null : facebookNumberKey(number);
  }
  if (!/^[a-z0-9.]{1,100}$/.test(s) || s.startsWith(".") || s.endsWith(".") || !/[a-z]/.test(s)) return null;
  if (FACEBOOK_RESERVED.has(s) || s.endsWith(".php")) return null;
  return `https://www.facebook.com/${s.replace(/\./g, "")}`;
}

/** A `profile.php?id=<digits>` address's key, or undefined when the path is not `profile.php`. */
function profilePhpKey(url: URL): string | null | undefined {
  if (!/^\/profile\.php\/?$/.test(url.pathname)) return undefined;
  return facebookNumberKey(url.searchParams.get("id") ?? "");
}

/**
 * A Facebook profile or Page (ADR 0004 14.3's table): on a host that is another name for facebook.com, one path segment read by
 * `facebookSegmentKey` (a username, a number, or a Page's `<name>-<number>`), or `profile.php?id=<digits>`; query and
 * fragment dropped. Every form that carries a number is keyed by that number, `https://www.facebook.com/profile.php?id=N`;
 * a username is keyed `https://www.facebook.com/<username>`. A username and a number are two keys: nothing in an address
 * joins them. Anything else is not an account (null).
 */
export function facebookAccountKey(raw: string): string | null {
  const url = httpUrl(raw);
  if (url === null || !isFacebookHost(url.hostname.toLowerCase())) return null;
  const php = profilePhpKey(url);
  if (php !== undefined) return php;
  const path = segments(url);
  return path.length === 1 ? facebookSegmentKey(path[0]) : null;
}

/**
 * Every Facebook key an imported cell may name (ADR 0004 14.3): its account key; `/pages/<name>/N` and `/people/<name>/N`
 * by their number; the first segment of a longer path; a bare `@username` or `username`. Hosts as `facebookAccountKey`.
 */
export function facebookMayName(raw: string): readonly string[] {
  const exact = facebookAccountKey(raw);
  if (exact !== null) return [exact];
  const text = raw.trim();
  const bare = /^@?([A-Za-z0-9.]+)$/.exec(text)?.[1];
  if (bare !== undefined) return keys(facebookSegmentKey(bare));
  const url = httpUrl(text);
  if (url === null) return [];
  const host = url.hostname.toLowerCase();
  if (!isFacebookHost(host)) return [];
  const php = profilePhpKey(url);
  if (php !== undefined) return keys(php);
  const path = segments(url);
  if ((path[0] === "pages" || path[0] === "people") && path.length >= 3) return keys(facebookNumberKey(path[2] ?? ""));
  return keys(facebookSegmentKey(path[0]));
}

const keys = (key: string | null): readonly string[] => (key === null ? [] : [key]);
const segments = (url: URL): string[] => url.pathname.split("/").filter((s) => s !== "").map(decoded);
const decoded = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

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
