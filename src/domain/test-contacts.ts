import { emailKey } from "./contact-details.ts";
import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import { displayPhone } from "./phone.ts";
import { SOCIAL_CHANNELS, SOCIAL_CHANNEL_LIST, type MessageRequestChannel, type SocialChannel } from "./social-channels.ts";

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

export type TestContacts = {
  readonly email: TestContact | null;
  readonly mobile: TestContact | null;
  /** The user's own test LinkedIn profile (ADR 0004 section 8), keyed by `linkedinProfileKey`. Absent: none. */
  readonly linkedin?: TestContact | null;
} & {
  /** The user's own test account on each message-request channel (ADR 0004 13.8), keyed by its normaliser. Absent: none. */
  readonly [C in MessageRequestChannel]?: TestContact | null;
}

/** What the user typed; a social field is absent where the page does not offer it. */
export type TestContactsInput = { readonly email: string; readonly mobile: string } & { readonly [C in SocialChannel]?: string };

export type ParsedTestContacts = { readonly ok: true; readonly contacts: TestContacts } | { readonly ok: false; readonly field: "email" | "mobile" | SocialChannel; readonly message: string };

/** Why a typed social test address is refused: it is not a profile or account of that channel. */
export const notAnAddress = (channel: SocialChannel): string => {
  const facts = SOCIAL_CHANNELS[channel];
  return `Give your ${facts.name} ${facts.addressNoun}'s address, such as ${facts.exampleAddress}.`;
};

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
  let contacts: TestContacts = { email, mobile };
  for (const channel of SOCIAL_CHANNEL_LIST) {
    const text = (input[channel] ?? "").trim();
    if (text === "") continue;
    const key = SOCIAL_CHANNELS[channel].accountKey(text);
    if (key === null) return { ok: false, field: channel, message: notAnAddress(channel) };
    contacts = { ...contacts, [channel]: { value: key, key } };
  }
  return { ok: true, contacts };
}

/**
 * Whether what the user typed differs from the stored contacts (their values as the server shows them), compared by the
 * keys `parseTestContacts` gives both: "+447700900456" and "+44 7700 900456" are one number, and an address's case is
 * not a difference. What cannot be read is unsaved, so Save stays offered and says why.
 */
export function contactsUnsaved(typed: TestContactsInput, stored: { readonly email: string | null; readonly mobile: string | null } & { readonly [C in SocialChannel]?: string | null }): boolean {
  const mine = parseTestContacts(typed);
  // A social test address is compared only where the page offers it (ticket 24b): a page without the field leaves it as stored.
  const offered = SOCIAL_CHANNEL_LIST.filter((c) => typed[c] !== undefined);
  const theirs = parseTestContacts({ email: stored.email ?? "", mobile: stored.mobile ?? "", ...Object.fromEntries(offered.map((c) => [c, stored[c] ?? ""])) });
  if (!mine.ok || !theirs.ok) return true;
  return (
    mine.contacts.email?.key !== theirs.contacts.email?.key ||
    mine.contacts.mobile?.key !== theirs.contacts.mobile?.key ||
    offered.some((c) => (mine.contacts[c] ?? null)?.key !== (theirs.contacts[c] ?? null)?.key)
  );
}
