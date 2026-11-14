import type { Channel, PhoneKind } from "./contact-details.ts";

/** Which channels a lead can be contacted on. Missing channels skip their tracks. */
export interface Reach {
  readonly email: boolean;
  readonly sms: boolean;
  readonly call: boolean;
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
export function decisionMakerReach(own: readonly ContactPoint[], company: readonly ContactPoint[]): Reach {
  return {
    email: usable(own, "email"),
    sms: usable(own, "phone", ["mobile"]),
    call: usable(own, "phone") || usable(company, "phone", ["main_line"]),
  };
}

/**
 * A company lead uses the company's details. A main line is not proof of an SMS-capable
 * number, so a company lead has no SMS channel.
 */
export function companyLeadReach(company: readonly ContactPoint[]): Reach {
  return {
    email: usable(company, "email"),
    sms: false,
    call: usable(company, "phone", ["main_line"]),
  };
}

export function hasUsableChannel(reach: Reach): boolean {
  return reach.email || reach.sms || reach.call;
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
