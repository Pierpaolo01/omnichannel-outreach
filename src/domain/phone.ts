import { isSupportedCountry, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/min";
import { digitsOf } from "./contact-details.ts";

/**
 * Phone numbers. One number has one key however it is written: "+44 20 7946 0101",
 * "020 7946 0101" in Great Britain and "0044 20 7946 0101" all key to +442079460101.
 * National forms need the country the number belongs to (the company's country).
 */
export interface PhoneNumber {
  /** E.164 when the number can be read, otherwise its digits as written. */
  readonly key: string;
  /** Grouped for reading and dialing, for example "+44 20 7946 0101". */
  readonly display: string;
  /** Digit strings search matches against: international and national forms. */
  readonly searchDigits: string;
}

function countryCode(country: string | null): CountryCode | undefined {
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
    };
  }
  const key = written.startsWith("+") ? `+${digits}` : digits.startsWith("00") ? `+${digits.slice(2)}` : digits;
  return { key, display: written, searchDigits: digits };
}

/** A stored phone key shown for reading. Keys that are not E.164 show as they are. */
export function displayPhone(key: string): string {
  if (!key.startsWith("+")) return key;
  const parsed = parsePhoneNumberFromString(key);
  return parsed?.isPossible() ? parsed.formatInternational() : key;
}
