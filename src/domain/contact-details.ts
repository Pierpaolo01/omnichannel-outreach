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

/**
 * International numbers keep their "+" so "+44 20..." and "0044 20..." compare equal;
 * national numbers compare by digits. Fewer than six digits is not a phone number.
 */
export function phoneKey(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = digitsOf(trimmed);
  if (digits.length < 6) return null;
  if (trimmed.startsWith("+")) return `+${digits}`;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  return digits;
}

export function digitsOf(raw: string): string {
  return raw.replace(/\D/g, "");
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
