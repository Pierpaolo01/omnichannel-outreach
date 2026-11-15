import type { CallMeasures, CampaignMeasures, MeasureRate, MessageMeasures } from "../../shared/api.ts";

/**
 * The campaign measures in words (ticket 22; ADR 0003 "Ticket 22"): one function per measure, each saying a figure the
 * server read (`GET /api/campaigns/:id/measures`) and computing none. Every mapping is exhaustive.
 */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Email or SMS: what the provider reported sent, what it refused or bounced, and the leads that replied on it. */
export function messagesLine(m: MessageMeasures): string {
  if (m.sent === 0 && m.failedOrBounced === 0 && m.replies === 0) return "None sent yet";
  return `${m.sent} sent · ${m.failedOrBounced} failed or bounced · ${plural(m.replies, "lead", "leads")} replied`;
}

/** The calls logged: made, connected, interested, declined, and callbacks pending. */
export function callsLine(c: CallMeasures): string {
  if (c.made === 0 && c.callbacksPending === 0) return "None made yet";
  return `${c.made} made · ${c.connected} connected · ${c.interested} interested · ${c.declined} declined · ${plural(c.callbacksPending, "callback pending", "callbacks pending")}`;
}

/** The reply rate, with the leads it is out of. */
export function replyRateText(r: MeasureRate): { figure: string; says: string } {
  if (r.percent === null) return { figure: "—", says: "No email or text has been sent yet" };
  return { figure: `${r.percent}%`, says: `${r.numerator} of the ${plural(r.denominator, "lead", "leads")} you emailed or texted replied` };
}

/** The connect rate, with the calls it is out of. */
export function connectRateText(r: MeasureRate): { figure: string; says: string } {
  if (r.percent === null) return { figure: "—", says: "No call has been made yet" };
  return { figure: `${r.percent}%`, says: `${r.numerator} of ${plural(r.denominator, "call", "calls")} reached the prospect for a conversation` };
}

/** One row per channel the campaign has tracks on, in the read's order. */
export function measureRows(m: CampaignMeasures): { channel: CampaignMeasures["channels"][number]; label: string; line: string }[] {
  return m.channels.map((channel) => {
    switch (channel) {
      case "email":
        return { channel, label: "Email", line: messagesLine(m.email) };
      case "sms":
        return { channel, label: "SMS", line: messagesLine(m.sms) };
      case "call":
        return { channel, label: "Calls", line: callsLine(m.calls) };
      default: {
        const never: never = channel;
        return never;
      }
    }
  });
}

/** How the figures are counted, in plain words (the ADR's definitions and edge cases). */
export const MEASURE_NOTES: readonly string[] = [
  "Every figure counts what was recorded: messages the provider reported, replies it detected, and the call outcomes you logged.",
  "A message counts as sent once the provider reports it sent; one handed over and not yet reported is not counted. A bounced message was sent, so it counts in both.",
  "Replied counts each lead who has replied in this campaign, once, on the channel of their first reply. A lead who replies again, or on the other channel, still counts once, and resuming a lead or moving them to win-back never takes their reply away.",
  "The reply rate is the leads who replied out of the leads you emailed or texted. A call ended interested counts under calls.",
  "A call made is any outcome you logged except Skip for now. Connected means you spoke with them: interested, not interested or a callback asked for. A skipped call step is not a call.",
  "A callback is pending until an outcome other than Skip for now is logged on it, also while the lead is paused (it is then off your call list); not once the lead has replied or been stopped.",
];
