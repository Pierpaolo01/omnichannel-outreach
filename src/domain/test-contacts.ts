import { emailKey } from "./contact-details.ts";
import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import { displayPhone } from "./phone.ts";
import { linkedinProfileKey } from "./linkedin-profile.ts";

/**
 * The user's own test contacts (CONTEXT.md "Test contact"; ADR 0003 "Ticket 21"): an email and a mobile, each optional.
 * Read the way the import reads a detail, so a contact and a lead's detail compare by the same key.
 */
export interface TestContact {
  /** As the user wrote it, tidied for display. */
  readonly value: string;
  /** The key a lead's detail would have: a lower-case address, or the number's E.164 form. */
  readonly key: string;
}

export interface TestContacts {
  readonly email: TestContact | null;
  readonly mobile: TestContact | null;
  /** The user's own test LinkedIn profile (ADR 0004 section 8), keyed by `linkedinProfileKey`. Absent: none. */
  readonly linkedin?: TestContact | null;
}

export type TestContactsInput = { readonly email: string; readonly mobile: string; readonly linkedin?: string };

export type ParsedTestContacts = { readonly ok: true; readonly contacts: TestContacts } | { readonly ok: false; readonly field: "email" | "mobile" | "linkedin"; readonly message: string };

/** Reads what the user typed: blank is none; an email must be an address; a mobile must be an international number. */
export function parseTestContacts(input: TestContactsInput): ParsedTestContacts {
  const emailText = input.email.trim();
  const mobileText = input.mobile.trim();
  let email: TestContact | null = null;
  if (emailText !== "") {
    const key = emailKey(emailText);
    if (key === null) return { ok: false, field: "email", message: "This isn’t an email address." };
    email = { value: key, key };
  }
  let mobile: TestContact | null = null;
  if (mobileText !== "") {
    const parsed = mobileText.startsWith("+") ? parsePhoneNumberFromString(mobileText) : undefined;
    if (!parsed?.isPossible()) return { ok: false, field: "mobile", message: "Write your mobile in international form, starting with + and the country code." };
    mobile = { value: displayPhone(parsed.number), key: parsed.number };
  }
  const linkedinText = (input.linkedin ?? "").trim();
  if (linkedinText === "") return { ok: true, contacts: { email, mobile } };
  const key = linkedinProfileKey(linkedinText);
  if (key === null) return { ok: false, field: "linkedin", message: "Give your LinkedIn profile's address, such as https://www.linkedin.com/in/your-name." };
  return { ok: true, contacts: { email, mobile, linkedin: { value: key, key } } };
}

/**
 * Whether what the user typed differs from the stored contacts (their values as the server shows them), compared by the
 * keys `parseTestContacts` gives both: "+447700900456" and "+44 7700 900456" are one number, and an address's case is
 * not a difference. What cannot be read is unsaved, so Save stays offered and says why.
 */
export function contactsUnsaved(typed: TestContactsInput, stored: { readonly email: string | null; readonly mobile: string | null }): boolean {
  const mine = parseTestContacts(typed);
  const theirs = parseTestContacts({ email: stored.email ?? "", mobile: stored.mobile ?? "" });
  if (!mine.ok || !theirs.ok) return true;
  return mine.contacts.email?.key !== theirs.contacts.email?.key || mine.contacts.mobile?.key !== theirs.contacts.mobile?.key;
}
