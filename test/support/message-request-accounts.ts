import { MESSAGE_REQUEST_CHANNELS, MESSAGE_REQUEST_COLUMNS, type MessageRequestChannel } from "../../src/domain/social-channels.ts";
import type { FakeSocialSession } from "./fake-social-port.ts";

/**
 * Fictitious accounts on each message-request channel (ADR 0004 13.4, 14.3), for tests that run one case per channel: an
 * address of the channel's own form, written here by hand (never through the production normaliser), and the CSV cells
 * that carry it. Every name gets the `example` prefix, so no address is anyone's.
 */
export function exampleAccount(channel: MessageRequestChannel, name: string): string {
  const plain = name.toLowerCase();
  switch (channel) {
    case "instagram":
      return `https://www.instagram.com/example_${plain.replace(/[^a-z0-9._]/g, "_")}`;
    case "facebook":
      // Letters and digits only: Facebook drops a username's periods from its key, and a hyphen makes it no username.
      return `https://www.facebook.com/example${plain.replace(/[^a-z0-9]/g, "")}`;
    default: {
      const unhandled: never = channel;
      throw new Error(`no example account form for ${String(unhandled)}`);
    }
  }
}

/** A people-file row's cell for the channel's account (the optional column of question Q43). */
export const personAccountCell = (channel: MessageRequestChannel, value: string): Record<string, string> => ({ [MESSAGE_REQUEST_COLUMNS[channel].people]: value });
/** A businesses-file row's cell for the channel's account. */
export const businessAccountCell = (channel: MessageRequestChannel, value: string): Record<string, string> => ({ [MESSAGE_REQUEST_COLUMNS[channel].businesses]: value });
/** The person's cells on every message-request channel, each its own fictitious account under one name. */
export const everyPersonAccountCell = (name: string): Record<string, string> => accountCells("people", Object.fromEntries(MESSAGE_REQUEST_CHANNELS.map((c) => [c, exampleAccount(c, name)])));
/** A row's cells for the accounts given, by channel, in the people or the businesses file. */
export const accountCells = (file: "people" | "businesses", cells: { readonly [C in MessageRequestChannel]?: string }): Record<string, string> =>
  Object.fromEntries(MESSAGE_REQUEST_CHANNELS.flatMap((c) => (cells[c] === undefined ? [] : [[MESSAGE_REQUEST_COLUMNS[c][file], cells[c]]])));
/** The harness's `social` option: the same simulated sessions on every message-request channel. */
export const everyChannelSessions = (sessions: readonly FakeSocialSession[]): { readonly [C in MessageRequestChannel]?: { readonly sessions: readonly FakeSocialSession[] } } =>
  Object.fromEntries(MESSAGE_REQUEST_CHANNELS.map((c) => [c, { sessions: sessions.map((s) => ({ ...s })) }]));
