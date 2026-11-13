import { isSupportedCountry, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/min";
import { digitsOf } from "./contact-details.ts";

/**
 * Phone numbers. One number has one key however it is written: "+44 20 7946 0101",
 * "020 7946 0101" in Great Britain and "0044 20 7946 0101" all key to +442079460101.
 * National forms need the country the number belongs to: the company's two-letter country.
 * Without one, a number written in national form is not read: it is kept as its digits.
 */
export interface PhoneNumber {
  /** E.164 when the number can be read, otherwise its digits as written. */
  readonly key: string;
  /** Grouped for reading and dialing, for example "+44 20 7946 0101". */
  readonly display: string;
  /** Digit strings search matches against: international and national forms. */
  readonly searchDigits: string;
  /** The two-letter region the number belongs to, when it can be read. */
  readonly region: string | null;
}

export function countryCode(country: string | null): CountryCode | undefined {
  const code = (country ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && isSupportedCountry(code) ? code : undefined;
}

export function parsePhone(raw: string, country: string | null): PhoneNumber | null {
  const written = raw.trim();
  const digits = digitsOf(written);
  if (digits.length < 6) return null;
  const parsed = parsePhoneNumberFromString(written, countryCode(country));
  if (parsed?.isPossible()) {
    return {
      key: parsed.number,
      display: parsed.formatInternational(),
      searchDigits: [...new Set([digitsOf(parsed.number), digitsOf(parsed.formatNational()), digits])].join(" "),
      region: parsed.country ?? null,
    };
  }
  const key = written.startsWith("+") ? `+${digits}` : digits.startsWith("00") ? `+${digits.slice(2)}` : digits;
  return { key, display: written, searchDigits: digits, region: null };
}

/** A stored phone key shown for reading. Keys that are not E.164 show as they are. */
export function displayPhone(key: string): string {
  if (!key.startsWith("+")) return key;
  const parsed = parsePhoneNumberFromString(key);
  return parsed?.isPossible() ? parsed.formatInternational() : key;
}

/**
 * A business row's main line (ADR 0001, "Phone identity"). With a two-letter country it is read
 * in that country. Without one, the `phone_e164` cell is international by definition, so it is
 * read as international, even without its plus sign when it is valid that way; otherwise the
 * line is read as any number is: as written in international form, or kept as its digits.
 */
export function readMainLine(e164: string, original: string, country: string | null): PhoneNumber | null {
  if (countryCode(country)) return parsePhone(e164, country) ?? parsePhone(original, country);
  const written = e164.trim();
  const digits = digitsOf(written);
  const international = written.startsWith("+") || digits.startsWith("00");
  const withoutPlus = !international && digits.length >= 6 && parsePhoneNumberFromString(`+${digits}`)?.isValid() === true;
  const cell = international ? parsePhone(written, null) : withoutPlus ? parsePhone(`+${digits}`, null) : null;
  return cell ?? parsePhone(original, null) ?? parsePhone(written, null);
}
