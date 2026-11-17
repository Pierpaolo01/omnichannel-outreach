/**
 * The account URL rules of the message-request channels (ADR 0004 13.4): the one reading of a CSV's account cell, and of
 * a test account the user gives. Facebook (ticket 26) adds its own function by the same contract: a key, or null for
 * anything that is not an account, which reads as missing.
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
