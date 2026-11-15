import type { AttentionLead, InterruptionNoticeView, NeedsAttention, SendingInterruptedView } from "../../shared/api.ts";
import { dateIn, isoDateIn, timeIn, type AttentionItem } from "./wording.ts";

/**
 * An instant as Today says it (ticket 20b): the time in the user's zone, with its date when that is not `today`, the
 * user's date as the same read counts it.
 */
export function atYourTime(iso: string, userZone: string, today: string): string {
  return isoDateIn(userZone, iso) === today ? timeIn(userZone, iso) : `${dateIn(userZone, iso)} at ${timeIn(userZone, iso)}`;
}

/** "1 send", "14 sends", "no sends". */
const sends = (n: number): string => (n === 0 ? "no sends" : n === 1 ? "1 send" : `${n} sends`);

/**
 * Today's one line (spec: "sending was interrupted from X to Y; N sends rescheduled"), from GET /api/today's
 * `interruption`, `date` and `userZone`: nothing is computed but the words. When X carries a date and Y is today, Y
 * says "today", so the line never reads as zero length ("from Mon 9 Nov at 12:00 to 12:00"; council on 7622b8b).
 */
export function interruptionLine(notice: InterruptionNoticeView, today: string, userZone: string): string {
  const from = atYourTime(notice.from, userZone, today);
  const fromDated = isoDateIn(userZone, notice.from) !== today;
  const toToday = isoDateIn(userZone, notice.to) === today;
  const to = fromDated && toToday ? `today at ${timeIn(userZone, notice.to)}` : atYourTime(notice.to, userZone, today);
  return `Sending was interrupted from ${from} to ${to}; ${sends(notice.rescheduled)} rescheduled.`;
}

/** "at 09:10" today, "on Sat 14 Nov at 22:10" on another day. */
const whenPhrase = (iso: string, userZone: string, today: string): string => `${isoDateIn(userZone, iso) === today ? "at" : "on"} ${atYourTime(iso, userZone, today)}`;

/** "a", "a and b", "a, b, and c": with a serial comma for three or more, as the rest of the product writes lists. */
const listOf = (parts: readonly string[]): string => (parts.length <= 2 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`);
/** "a", "a or b", "a, b, or c". */
const eitherOf = (parts: readonly string[]): string => (parts.length <= 2 ? parts.join(" or ") : `${parts.slice(0, -1).join(", ")}, or ${parts.at(-1)}`);

type Channel = "email" | "sms";
type Why = NeedsAttention["noUsableChannel"][number]["channels"][number]["why"];
type ReachChannel = NeedsAttention["noUsableChannel"][number]["channels"][number]["channel"];

/** Every word that depends on a sending channel, in one table per channel: a new channel fails typecheck here. */
const CHANNEL_WORDS: Record<Channel, { provider: string; accounts: string; account: string; send: (n: number) => string; due: (n: number) => string }> = {
  email: { provider: "Instantly", accounts: "inboxes", account: "inbox", send: (n) => `${n} email ${n === 1 ? "send" : "sends"}`, due: (n) => (n === 1 ? "email" : "emails") },
  sms: { provider: "the SMS provider", accounts: "numbers", account: "SMS number", send: (n) => `${n} ${n === 1 ? "text" : "texts"}`, due: (n) => (n === 1 ? "text" : "texts") },
};

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** What a lead entry links to: the person's record, or the company lead's. */
const recordAction = (lead: AttentionLead): NonNullable<AttentionItem["action"]> => {
  const name = leadName(lead);
  return { label: "Open record", href: lead.person ? `/leads/people/${lead.person.id}` : `/leads/companies/${lead.company.id}`, ariaLabel: `Open ${name}’s record` };
};
const leadName = (lead: AttentionLead): string => lead.person?.name ?? lead.company.name;

/** Which read of a round failed last, as the entry says it (`SendingInterruptedView.lastFailedRead.part`). */
function failedReadLine(read: NonNullable<SendingInterruptedView["lastFailedRead"]>): string {
  const words = CHANNEL_WORDS[read.channel];
  switch (read.part) {
    case "accounts":
      return `${words.provider}’s list of ${words.accounts}`;
    case "observation":
      return `${words.provider}’s report of replies, bounces and sends`;
    case "call":
      return `a request to ${words.provider}`;
    default: {
      const unhandled: never = read.part;
      throw new Error(`A failed read with no sentence: ${String(unhandled)}`);
    }
  }
}

/**
 * Sending interrupted now (`sendingInterrupted` of GET /api/needs-attention, the same read as the other entries), one
 * entry, by the read's cause. It has no link: no page in the application restarts sending (a provisional choice, listed
 * in the pull request).
 */
export function sendingInterruptedItem(s: SendingInterruptedView, today: string, userZone: string): AttentionItem {
  const since = atYourTime(s.since, userZone, today);
  const base = { key: "sending-interrupted", tone: "crit" as const, action: null };
  switch (s.cause) {
    case "not_running":
      return { ...base, title: "Sending is not running", body: `No sending round has run since ${since}. Due email and texts wait, and due calls may not reach your list until it runs again; nothing is dropped.` };
    case "ticks_failing": {
      // Rounds may have ended between `since` and the failure (council on 7622b8b): never "every round failed".
      const last = s.lastRoundFailedAt ? `, and the last sending round failed ${whenPhrase(s.lastRoundFailedAt, userZone, today)}` : "";
      return { ...base, title: "Sending is failing", body: `Sending has been interrupted since ${since}${last}. Due email and texts wait, and due calls may not reach your list until a round succeeds; nothing is dropped.` };
    }
    case "providers_unreachable": {
      const last = s.lastFailedRead ? `; ${failedReadLine(s.lastFailedRead)} last failed ${whenPhrase(s.lastFailedRead.at, userZone, today)}. Due sends that depend on it wait` : ". Due sends that depend on a provider not answering wait";
      return { ...base, title: "Sending is interrupted", body: `Since ${since} not every provider has answered${last}; nothing is dropped.` };
    }
    default: {
      const unhandled: never = s.cause;
      throw new Error(`An interruption cause with no sentence: ${String(unhandled)}`);
    }
  }
}

/** Sends the dispatch gate holds on a provider that is not answering (`waitingOnProvider`): one entry per provider. */
export function providerWaitItems(waits: NeedsAttention["waitingOnProvider"], today: string, userZone: string): AttentionItem[] {
  return waits.map((w) => {
    const words = CHANNEL_WORDS[w.channel];
    const since = w.since === null ? "It hasn’t answered yet." : `It hasn’t answered since ${atYourTime(w.since, userZone, today)}.`;
    const one = w.sends === 1;
    return {
      key: `provider-${w.channel}`,
      tone: "crit" as const,
      title: `${capital(words.provider)} isn’t answering`,
      body: `${since} ${words.send(w.sends)} ${one ? "waits" : "wait"} on it; ${one ? "it goes" : "they go"} once it answers, and nothing is dropped.`,
    };
  });
}

/**
 * Leads waiting for sending capacity (`waitingForCapacity`): one entry per campaign, in the read's order, counting
 * leads (a lead with an email and a text due is one) and, for the words, the due steps on each channel, with the
 * earliest reset the read gives.
 */
export function capacityItems(waiting: NeedsAttention["waitingForCapacity"], today: string, userZone: string): AttentionItem[] {
  const groups = new Map<string, NeedsAttention["waitingForCapacity"][number][]>();
  for (const w of waiting) groups.set(w.campaign.id, [...(groups.get(w.campaign.id) ?? []), w]);
  return [...groups.values()].map((steps) => {
    const first = steps[0] as NeedsAttention["waitingForCapacity"][number];
    const leads = new Set(steps.map((w) => w.enrollmentId)).size;
    const byChannel = (["email", "sms"] as const satisfies readonly Channel[]).flatMap((c) => {
      const n = steps.filter((w) => w.channel === c).length;
      return n > 0 ? [{ words: CHANNEL_WORDS[c], n }] : [];
    });
    const single = steps.length === 1;
    const resets = steps.map((w) => w.resetsAt).reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
    const waits = `their due ${byChannel.map((c) => c.words.due(c.n)).join(" and ")} ${single ? "waits" : "wait"}: every ${byChannel.map((c) => c.words.account).join(" and ")} ${single ? "it" : "they"} may use is full for the day. The first resets ${whenPhrase(resets, userZone, today)}; nothing is dropped.`;
    if (leads === 1) {
      return { key: `capacity-${first.campaign.id}`, tone: "pause" as const, title: `${leadName(first)} is waiting for sending capacity`, body: `In ${first.campaign.name}, ${waits}`, action: recordAction(first) };
    }
    return {
      key: `capacity-${first.campaign.id}`,
      tone: "pause" as const,
      title: `${leads} leads in ${first.campaign.name} are waiting for sending capacity`,
      body: capital(waits),
      action: { label: "Open campaign", href: `/campaigns/${encodeURIComponent(first.campaign.id)}/leads`, ariaLabel: `Open ${first.campaign.name}` },
    };
  });
}

/** What a channel is called where a lead has none or it is marked wrong. */
function detailLine(channel: ReachChannel, why: "missing" | "bad"): string {
  switch (channel) {
    case "email":
      return why === "missing" ? "they have no email address" : "their email address is marked wrong";
    case "sms":
      return why === "missing" ? "they have no mobile number" : "their mobile number is marked wrong";
    case "call":
      return why === "missing" ? "they have no number to call" : "every number to call is marked wrong";
    default: {
      const unhandled: never = channel;
      throw new Error(`A channel with no sentence: ${String(unhandled)}`);
    }
  }
}

/** Why one channel cannot reach a lead now, as `noUsableChannel` gives it. */
function unreachableLine(c: NeedsAttention["noUsableChannel"][number]["channels"][number]): string {
  switch (c.why) {
    case "declined":
      return "they have declined on a call";
    case "missing":
    case "bad":
      return detailLine(c.channel, c.why);
    default: {
      const unhandled: never = c.why;
      throw new Error(`A reason with no sentence: ${String(unhandled)}`);
    }
  }
}

/** Each reason the read can give, as a cause of several leads' endings: a new reason fails typecheck here. */
const CAUSE: Record<Why, string> = { missing: "a missing detail", bad: "a detail marked wrong", declined: "a decline on a call" };

/**
 * Leads left with no usable channel (`noUsableChannel`, most recently ended first): one entry. They stay listed while the
 * read lists them (question Q20's interim); one lead links to their record, several to them in Leads. The ending is said
 * as past and final: `channels` are the reasons that hold now for the campaign's own channels (its branch's tracks), and a
 * later import can restore details (review bot on 487de7c), leaving none; nothing is said about channels it does not use.
 */
export function noUsableChannelItem(ended: NeedsAttention["noUsableChannel"], today: string, userZone: string): AttentionItem | null {
  const first = ended[0];
  if (!first) return null;
  if (ended.length === 1) {
    const now = first.channels.length === 0 ? "Each channel this campaign uses could reach them now, but the ending is final." : `Now ${listOf(first.channels.map(unreachableLine))}.`;
    return {
      key: "no-usable-channel",
      tone: "end",
      title: `No way was left to reach ${leadName(first)}`,
      body: `In ${first.campaign.name}, their outreach ended ${whenPhrase(first.endedAt, userZone, today)}, when no channel could reach them. ${now}`,
      action: recordAction(first),
    };
  }
  // The causes the read gives now, in the table's order; with none left (every detail restored), the ending alone.
  const given = new Set(ended.flatMap((e) => e.channels.map((c) => c.why)));
  const causes = (Object.keys(CAUSE) as Why[]).filter((w) => given.has(w)).map((w) => CAUSE[w]);
  return {
    key: "no-usable-channel",
    tone: "end",
    title: `No way was left to reach ${ended.length} leads`,
    body: `Their outreach ended when no channel could reach them.${causes.length > 0 ? ` What stops a channel now: ${eitherOf(causes)}.` : ""} The most recent is ${leadName(first)} in ${first.campaign.name}, ${whenPhrase(first.endedAt, userZone, today)}.`,
    action: { label: "Show them", href: "/leads?status=finished_no_usable_channel" },
  };
}
