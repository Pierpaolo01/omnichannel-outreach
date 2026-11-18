/**
 * The LinkedIn profile URL rule (ADR 0004 section 5): the one reading of the CSV's `linkedin_url` cell, and of a test
 * profile the user gives. A member profile is `http(s)://(<sub>.)linkedin.com/in/<slug>`, with an optional trailing
 * slash; query and fragment are dropped and the slug is percent-decoded and lower-cased. Its key is
 * `https://www.linkedin.com/in/<slug>`. Anything else is not a member profile, and reads as missing (null).
 */
export function linkedinProfileKey(raw: string): string | null {
  const text = raw.trim();
  if (text === "") return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
  const match = /^\/in\/([^/]+)\/?$/.exec(url.pathname);
  if (!match?.[1]) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(match[1]).toLowerCase();
  } catch {
    return null;
  }
  if (slug === "" || slug.includes("/") || /\s/.test(slug)) return null;
  return `https://www.linkedin.com/in/${slug}`;
}
