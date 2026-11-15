/**
 * A reply's identity (ADR 0003 "Ticket 17a", the reply identity rule). A port names a reply by the id of its event
 * (`reply:<email id>` from the Instantly adapter, the provider's message id from an SMS port); the app keeps it as
 * `stored(channel, id)`: the email id as given, an SMS id prefixed `sms:`, so the two channels' ids never collide in
 * the reply events or a lead's replies. Every place that compares a stored reply with a provider's reply converts
 * through this pair (the observation records `stored`, the pre-send check asks with `ofPort` and records its answer
 * with `stored`), so the stored form and the compared form cannot differ.
 */

export type ReplyChannel = "email" | "sms";

const SMS_PREFIX = "sms:";

/** The id the app records for a reply its port names `portId`. */
export function storedReplyId(channel: ReplyChannel, portId: string): string {
  return channel === "sms" ? `${SMS_PREFIX}${portId}` : portId;
}

/**
 * The id the port knows a stored reply by: the inverse of `storedReplyId`. Every stored SMS id carries the prefix
 * (migration 18 rewrote the bare ids a pre-send answer stored before this rule), so a stored reply has one form and
 * replies are compared as stored strings everywhere else.
 */
export function portReplyId(channel: ReplyChannel, storedId: string): string {
  return channel === "sms" && storedId.startsWith(SMS_PREFIX) ? storedId.slice(SMS_PREFIX.length) : storedId;
}
