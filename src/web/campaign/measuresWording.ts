import type { CallMeasures, CampaignMeasures, LinkedinMeasures, MeasureRate, MessageMeasures } from "../../shared/api.ts";

/**
 * The campaign measures in words (ticket 22; ADR 0003 "Ticket 22"): one function per measure, each saying a figure the
 * server read (`GET /api/campaigns/:id/measures`) and computing none. Every mapping is exhaustive.
 */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** How many of a figure came from test runs, after it: nothing when none did (the principal's decision, 15 November 2026). */
const fromTests = (n: number) => (n > 0 ? ` (${n} from test runs)` : "");

/** Email or SMS: what the provider reported sent, what it refused or bounced, and who replied on it, test runs included. */
export function messagesLine(m: MessageMeasures): string {
  if (m.sent === 0 && m.failedOrBounced === 0 && m.replies === 0) return "None sent yet";
  // Replies are leads (council on 384630e, item 5); with a test run among them, they are said as replies.
  const replied = m.fromTests.replies > 0 ? `${m.replies} replied${fromTests(m.fromTests.replies)}` : `${plural(m.replies, "lead", "leads")} replied`;
  return `${m.sent} sent${fromTests(m.fromTests.sent)} · ${m.failedOrBounced} failed or bounced${fromTests(m.fromTests.failedOrBounced)} · ${replied}`;
}

/** LinkedIn (ADR 0004 section 8): invites sent and accepted, messages sent, failures, and replies the user marked. */
export function linkedinLine(m: LinkedinMeasures): string {
  if (m.invitesSent === 0 && m.inmailsSent === 0 && m.messagesSent === 0 && m.failed === 0 && m.replies === 0) return "None sent yet";
  const t = m.fromTests;
  // InMails only once one went (ADR 0004 13.6): a campaign without the fallback reads as before.
  const inmails = m.inmailsSent > 0 ? ` · ${m.inmailsSent} ${m.inmailsSent === 1 ? "InMail" : "InMails"} sent${fromTests(t.inmailsSent)}` : "";
  return `${m.invitesSent} ${m.invitesSent === 1 ? "invite" : "invites"} sent${fromTests(t.invitesSent)} · ${m.invitesAccepted} accepted${fromTests(t.invitesAccepted)}${inmails} · ${m.messagesSent} ${m.messagesSent === 1 ? "message" : "messages"} sent${fromTests(t.messagesSent)} · ${m.failed} failed${fromTests(t.failed)} · ${t.replies > 0 ? `${m.replies} marked replied${fromTests(t.replies)}` : `${plural(m.replies, "lead", "leads")} marked replied`}`;
}

/** The calls logged, test calls included: made, connected, interested, declined, and callbacks pending. */
export function callsLine(c: CallMeasures): string {
  if (c.made === 0 && c.callbacksPending === 0) return "None made yet";
  const t = c.fromTests;
  return `${c.made} made${fromTests(t.made)} · ${c.connected} connected${fromTests(t.connected)} · ${c.interested} interested${fromTests(t.interested)} · ${c.declined} declined${fromTests(t.declined)} · ${plural(c.callbacksPending, "callback pending", "callbacks pending")}${fromTests(t.callbacksPending)}`;
}

const testShare = (r: MeasureRate) => (r.fromTests.denominator > 0 ? ` (test runs: ${r.fromTests.numerator} of ${r.fromTests.denominator})` : "");

/** The reply rate, with what it is out of: leads, and test runs when any were sent to. */
export function replyRateText(r: MeasureRate): { figure: string; says: string } {
  if (r.percent === null) return { figure: "—", says: "No email or text has been sent yet" };
  if (r.fromTests.denominator > 0) return { figure: `${r.percent}%`, says: `${r.numerator} of the ${r.denominator} you emailed or texted replied${testShare(r)}` };
  return { figure: `${r.percent}%`, says: `${r.numerator} of the ${plural(r.denominator, "lead", "leads")} you emailed or texted replied` };
}

/** The connect rate, with the calls it is out of. */
export function connectRateText(r: MeasureRate): { figure: string; says: string } {
  if (r.percent === null) return { figure: "—", says: "No call has been made yet" };
  return { figure: `${r.percent}%`, says: `${r.numerator} of ${plural(r.denominator, "call", "calls")} reached the prospect for a conversation${testShare(r)}` };
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
      case "linkedin":
        return { channel, label: "LinkedIn", line: linkedinLine(m.linkedin) };
      default: {
        const never: never = channel;
        return never;
      }
    }
  });
}

/** How the figures are counted, in plain words (the ADR's definitions and edge cases). */
export const MEASURE_NOTES: readonly string[] = [
  "Every figure counts what was recorded: messages the provider reported, replies it detected, and the call outcomes you logged. Test runs count too, and each figure says how many came from them; the lead groups count leads only.",
  "A message counts as sent once the provider reports it sent; one handed over and not yet reported is not counted. A bounced message was sent, so it counts in both.",
  "Replied counts each lead who has replied in this campaign, once, on the channel of their first reply. A lead who replies again, or on the other channel, still counts once, and resuming a lead or moving them to win-back never takes their reply away.",
  "The reply rate is the leads who replied out of the leads you emailed or texted. A call ended interested counts under calls.",
  "A call made is any outcome you logged except Skip for now. Connected means you spoke with them: interested, not interested or a callback asked for. A skipped call step is not a call.",
  "A callback is pending until an outcome other than Skip for now is logged on it, also while the lead is paused (it is then off your call list); not once the lead has replied or been stopped.",
];

/** How LinkedIn figures are counted (ADR 0004 section 8; ticket 24b). Nothing claims a message was delivered or read. */
export const LINKEDIN_MEASURE_NOTE =
  "On LinkedIn, an invite or message counts once your session reports it sent; nothing shows whether it was seen. Accepted counts every acceptance recorded, also one after a track had ended. Replied counts the leads you marked replied on LinkedIn: the app detects no LinkedIn reply.";

/** The notes for a campaign's channels: the LinkedIn note only when it has a LinkedIn track. */
export function measureNotes(channels: CampaignMeasures["channels"]): readonly string[] {
  return channels.includes("linkedin") ? [...MEASURE_NOTES, LINKEDIN_MEASURE_NOTE] : MEASURE_NOTES;
}
