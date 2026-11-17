/**
 * A reply's identity (ADR 0003 "Ticket 17a", the reply identity rule). A port names a reply by the id of its event
 * (`reply:<email id>` or `unsubscribed:<lead id>` from the Instantly adapter, the provider's message id from an SMS
 * port), and a pre-send answer names it by that same id. The app keeps it as `storedReplyId(channel, id)`: an email
 * event's id as given, an SMS id prefixed `sms:`, so the two channels' ids never collide in the reply events or a
 * lead's replies. `StoredReplyId` is branded: only `storedReplyId` makes one from a port's id, and a lead's replies,
 * `applyReply`, the pre-send check's known replies and the store's insert take nothing else, so a write site that
 * stores a port's bare id does not typecheck. The port is asked about a stored reply by `portReplyId`, the inverse.
 * Migration 19 rewrote the bare ids stored before this rule, so a stored reply has exactly one form.
 */
import type { SocialChannel } from "../social-channels.ts";

export type ReplyChannel = "email" | "sms";

declare const stored: unique symbol;
/** A reply's id as the app stores it; made only by `storedReplyId` (and read back by the store). */
export type StoredReplyId = string & { readonly [stored]: true };

const SMS_PREFIX = "sms:";

/** The id the app records for a reply its port names `eventId`. */
export function storedReplyId(channel: ReplyChannel, eventId: string): StoredReplyId {
  return (channel === "sms" ? `${SMS_PREFIX}${eventId}` : eventId) as StoredReplyId;
}

/**
 * The id of a reply the user marked (ADR 0004 section 7): there is no provider event, so it is the control's request id,
 * prefixed by its channel, which no port's id can be.
 */
export function markedReplyId(channel: SocialChannel, requestId: string): StoredReplyId {
  return `${channel}:mark:${requestId}` as StoredReplyId;
}

/** The id the port knows a stored reply by: the inverse of `storedReplyId`. */
export function portReplyId(channel: ReplyChannel, id: StoredReplyId): string {
  return channel === "sms" && id.startsWith(SMS_PREFIX) ? id.slice(SMS_PREFIX.length) : id;
}

/**
 * A stored reply id read back from the database. Only the store calls this: every row was written from a
 * `StoredReplyId`, or rewritten to that form by migration 19.
 */
export function storedReplyIdFromRow(raw: string): StoredReplyId {
  return raw as StoredReplyId;
}
