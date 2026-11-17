/**
 * The social channels (ADR 0004): LinkedIn, and the message-request channels of section 13, Instagram now and Facebook
 * with ticket 26. What differs between channels is written once here, in exhaustive mappings: a new channel is a compile
 * error until it has its entry.
 */
import { linkedinProfileKey } from "./linkedin-profile.ts";
import { instagramAccountKey } from "./social-account.ts";

/**
 * A social channel whose track is messages only: a text-only first message, which reaches someone who does not follow the
 * sender as a message request, then follow-ups after their waits (ADR 0004 13.1). Facebook joins this union in ticket 26.
 */
export type MessageRequestChannel = "instagram";
export const MESSAGE_REQUEST_CHANNELS: readonly MessageRequestChannel[] = ["instagram"];
export const isMessageRequestChannel = (channel: string | undefined | null): channel is MessageRequestChannel => (MESSAGE_REQUEST_CHANNELS as readonly string[]).includes(channel ?? "");

/** Every channel driven through the user's logged-in browser sessions (ADR 0004 1.1). */
export type SocialChannel = "linkedin" | MessageRequestChannel;
export const SOCIAL_CHANNEL_LIST: readonly SocialChannel[] = ["linkedin", ...MESSAGE_REQUEST_CHANNELS];
export const isSocialChannel = (channel: string | undefined | null): channel is SocialChannel => (SOCIAL_CHANNEL_LIST as readonly string[]).includes(channel ?? "");

export interface SocialChannelFacts {
  /** The channel's name in sentences, capitalised as the platform writes it. */
  readonly name: string;
  /** The one normaliser of an address on the channel (ADR 0004 5, 13.4): its key, or null when it is not one. */
  readonly accountKey: (raw: string) => string | null;
  /** The prefix that makes a session's own id an account id of the app (ADR 0004 1.1, "Identity"). */
  readonly accountPrefix: string;
  /** What an address on the channel is called: a profile on LinkedIn, an account on Instagram. */
  readonly addressNoun: string;
  /** A fictitious address of the right form, for a sentence that asks for one. */
  readonly exampleAddress: string;
}

export const SOCIAL_CHANNELS: { readonly [C in SocialChannel]: SocialChannelFacts } = {
  linkedin: { name: "LinkedIn", accountKey: linkedinProfileKey, accountPrefix: "linkedin:", addressNoun: "profile", exampleAddress: "https://www.linkedin.com/in/your-name" },
  instagram: { name: "Instagram", accountKey: instagramAccountKey, accountPrefix: "instagram:", addressNoun: "account", exampleAddress: "https://www.instagram.com/your.name" },
};

/**
 * The CSV columns a message-request channel reads (ADR 0004 13.4): the people file's (absent from the verified schema,
 * question Q43, so read when a file has it) and the businesses file's.
 */
export const MESSAGE_REQUEST_COLUMNS: { readonly [C in MessageRequestChannel]: { readonly people: string; readonly businesses: string } } = {
  instagram: { people: "instagram", businesses: "instagram" },
};

/** The kind a session reports of itself (ADR 0004 13.5): a personal profile, or a business account (a Page, on Facebook). */
export type SocialSenderKind = "personal" | "business";

/** A record with one entry per message-request channel (ADR 0004 13.2): a new channel is never left out of one. */
export function messageRequestRecord<T>(of: (channel: MessageRequestChannel) => T): { readonly [C in MessageRequestChannel]: T } {
  return Object.fromEntries(MESSAGE_REQUEST_CHANNELS.map((c) => [c, of(c)])) as { readonly [C in MessageRequestChannel]: T };
}

/**
 * A message-request account as a detail id (ADR 0004 13.4): the channel, whose it is (`p` a person's own, `c` a company's),
 * that person's or company's id, and the key, fixed at a track's start. The destination triggers of migration 26 accept it.
 */
export function accountDetailId(channel: MessageRequestChannel, belongsTo: "person" | "company", ownerId: string, key: string): string {
  return `${channel}:${belongsTo === "person" ? "p" : "c"}:${ownerId}:${key}`;
}

/** The channel, owner and key a message-request account detail id names, or null for any other id. */
export function accountOfDetailId(id: string): { channel: MessageRequestChannel; belongsTo: "person" | "company"; ownerId: string; key: string } | null {
  const match = /^([a-z]+):([pc]):([^:]+):(.+)$/.exec(id);
  const channel = match?.[1];
  if (!match || !isMessageRequestChannel(channel)) return null;
  return { channel, belongsTo: match[2] === "p" ? "person" : "company", ownerId: match[3] ?? "", key: match[4] ?? "" };
}
