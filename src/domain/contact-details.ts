/** Contact details: normalisation and the keys used to recognise the same detail twice. */

export type Channel = "email" | "phone";

/** direct and mobile belong to a person; main_line belongs to a company. */
export type PhoneKind = "direct" | "mobile" | "main_line";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lower-cased, trimmed address, or null when the value is not email-shaped. */
export function emailKey(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  return EMAIL_SHAPE.test(value) ? value : null;
}

export function digitsOf(raw: string): string {
  return raw.replace(/\D/g, "");
}

const NAME_AFFIXES = new Set([
  "dr", "drs", "mr", "mrs", "ms", "miss", "mx", "prof", "professor", "sir", "dame", "rev",
  "jr", "sr", "phd", "md", "dds", "dmd", "msc", "bsc", "mba", "ii", "iii",
]);

/**
 * A name for matching: accents, case and titles such as "Dr" or "PhD" removed, and punctuation
 * and spacing dropped rather than treated as word breaks, so "Dr. Grace Okafor" matches
 * "grace okafor", "O'Neil" matches "ONeil" and "Mary-Jane" matches "Mary Jane".
 * Empty when no name is left.
 */
export function nameKey(raw: string): string {
  return foldText(raw)
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((word) => word && !NAME_AFFIXES.has(word))
    .join("");
}

/** Lower-case, accent-free text for matching names and search. */
export function foldText(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A detail is marked newer when its owner already had a detail on the same channel from an
 * earlier import. Details added together are equals.
 */
export function isNewerDetail(
  detail: { readonly channel: Channel; readonly addedAt: string },
  sameOwner: readonly { readonly channel: Channel; readonly addedAt: string }[],
): boolean {
  return sameOwner.some((other) => other.channel === detail.channel && other.addedAt < detail.addedAt);
}
