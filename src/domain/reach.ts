import type { Channel, PhoneKind } from "./contact-details.ts";
import { linkedinProfileKey } from "./linkedin-profile.ts";
import { MESSAGE_REQUEST_CHANNELS, MESSAGE_REQUEST_COLUMNS, SOCIAL_CHANNELS, type MessageRequestChannel } from "./social-channels.ts";

/** Which channels a lead can be contacted on. Missing channels skip their tracks. */
export type Reach = {
  readonly email: boolean;
  readonly sms: boolean;
  readonly call: boolean;
  /** A member profile from the CSV, read by the one normaliser and not marked unreachable (ADR 0004 section 5). */
  readonly linkedin: boolean;
} & {
  /** A message-request channel: the decision maker's own usable account, else the company's (ADR 0004 13.4). */
  readonly [C in MessageRequestChannel]: boolean;
};

/**
 * The account cells of the message-request channels, as the import holds them (ADR 0004 13.4): read from the latest source
 * row of the person and of the company by the columns `MESSAGE_REQUEST_COLUMNS` names, and the keys marked bad. A company
 * lead has no person cell.
 */
export interface AccountCells {
  readonly person: Readonly<Record<string, string>> | null;
  readonly company: Readonly<Record<string, string>>;
  readonly bad: ReadonlySet<string>;
}

/** Whether a cell is a usable account on the channel: its normaliser reads it, and its key is not marked bad. */
export function usableAccount(channel: MessageRequestChannel, cell: string, bad: ReadonlySet<string>): boolean {
  const key = SOCIAL_CHANNELS[channel].accountKey(cell);
  return key !== null && !bad.has(key);
}

/** Per message-request channel, whether the lead has a usable account there: its own, else its company's. */
function accountReach(cells: AccountCells | undefined): { readonly [C in MessageRequestChannel]: boolean } {
  const of = (channel: MessageRequestChannel): boolean => {
    if (!cells) return false;
    const columns = MESSAGE_REQUEST_COLUMNS[channel];
    return usableAccount(channel, cells.person?.[columns.people] ?? "", cells.bad) || usableAccount(channel, cells.company[columns.businesses] ?? "", cells.bad);
  };
  return Object.fromEntries(MESSAGE_REQUEST_CHANNELS.map((c) => [c, of(c)])) as { readonly [C in MessageRequestChannel]: boolean };
}

/** Whether a CSV's LinkedIn cell is a usable profile: a member profile (a company page is not, Q35) whose key is not marked bad. */
export function usableProfile(url: string, badProfileKeys: ReadonlySet<string> = new Set()): boolean {
  const key = linkedinProfileKey(url);
  return key !== null && !badProfileKeys.has(key);
}

export interface ContactPoint {
  readonly channel: Channel;
  readonly phoneKind: PhoneKind | null;
  readonly bad: boolean;
}

const usable = (points: readonly ContactPoint[], channel: Channel, kinds?: readonly PhoneKind[]): boolean =>
  points.some((p) => !p.bad && p.channel === channel && (!kinds || (p.phoneKind !== null && kinds.includes(p.phoneKind))));

/**
 * A decision maker's email and SMS go only to their own address and mobile.
 * Calls may use any of their own numbers or the company main line.
 */
export function decisionMakerReach(
  own: readonly ContactPoint[],
  company: readonly ContactPoint[],
  profile: { readonly url: string; readonly bad: ReadonlySet<string> } = { url: "", bad: new Set() },
  accounts?: AccountCells,
): Reach {
  return {
    email: usable(own, "email"),
    sms: usable(own, "phone", ["mobile"]),
    call: usable(own, "phone") || usable(company, "phone", ["main_line"]),
    linkedin: usableProfile(profile.url, profile.bad),
    ...accountReach(accounts),
  };
}

/**
 * A company lead uses the company's details. A main line is not proof of an SMS-capable
 * number, so a company lead has no SMS channel.
 */
export function companyLeadReach(company: readonly ContactPoint[], accounts?: Omit<AccountCells, "person">): Reach {
  return {
    email: usable(company, "email"),
    sms: false,
    call: usable(company, "phone", ["main_line"]),
    // A company page cannot take a connection invite (question Q35).
    linkedin: false,
    // A message-request channel goes to the company's own account (ADR 0004 13.4).
    ...accountReach(accounts ? { ...accounts, person: null } : undefined),
  };
}

export function hasUsableChannel(reach: Reach): boolean {
  return reach.email || reach.sms || reach.call || reach.linkedin || MESSAGE_REQUEST_CHANNELS.some((c) => reach[c]);
}

/** The contact details a lead can be reached through, in the order the user reads them. */
export type ContactRoute = "email" | "mobile" | "direct" | "shared_inbox" | "main_line";

const has = (points: readonly ContactPoint[], channel: ContactPoint["channel"], kind: ContactPoint["phoneKind"]): boolean =>
  points.some((p) => !p.bad && p.channel === channel && (channel === "email" || p.phoneKind === kind));

export function decisionMakerRoutes(own: readonly ContactPoint[], company: readonly ContactPoint[]): ContactRoute[] {
  return [
    ...(has(own, "email", null) ? (["email"] as const) : []),
    ...(has(own, "phone", "mobile") ? (["mobile"] as const) : []),
    ...(has(own, "phone", "direct") ? (["direct"] as const) : []),
    ...(has(company, "phone", "main_line") ? (["main_line"] as const) : []),
  ];
}

export function companyLeadRoutes(company: readonly ContactPoint[]): ContactRoute[] {
  return [
    ...(has(company, "email", null) ? (["shared_inbox"] as const) : []),
    ...(has(company, "phone", "main_line") ? (["main_line"] as const) : []),
  ];
}
