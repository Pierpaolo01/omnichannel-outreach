/**
 * Every sentence the Today page and the call focus queue say about calls, one function each. Each
 * reads only what the server reported (the queue, the call task, an outcome's answer, Needs
 * attention); none decides anything about order, counts, hours, capacity or an outcome's effect.
 */
import type { CallNumberView, CallOffListView, CallOutcomeApi, CallQueueItem, CallsView, CallTaskView, NeedsAttention, RecordedNumberView, WindowRule } from "../../shared/api.ts";
import { STATUS_LABEL } from "../status.tsx";
import type { DeskSnapshot } from "./callDesk.ts";

/** The outcome buttons, as the approved prototype labels them. */
export const OUTCOME_LABEL = {
  no_answer: "No answer",
  voicemail: "Left voicemail",
  gatekeeper: "Didn’t reach them",
  wrong_number: "Wrong number",
  interested: "Interested",
  skip_for_now: "Skip for now",
} as const satisfies Record<CallOutcomeApi, string>;

/** A logged call's title in Activity and in previous touches. */
export const OUTCOME_TITLE = {
  no_answer: "Call: no answer",
  voicemail: "Call: left voicemail",
  gatekeeper: "Call: didn’t reach them",
  wrong_number: "Call: wrong number",
  interested: "Call: interested",
  skip_for_now: "Call skipped for now",
} as const satisfies Record<CallOutcomeApi, string>;

const NUMBER_KIND = { direct: "direct", mobile: "mobile", main_line: "main line" } as const;

export const numberKind = (n: Pick<CallNumberView, "kind">): string => NUMBER_KIND[n.kind];

/** "+44 20 7946 0111, direct": the number a past call was logged on. */
export const dialledLine = (n: RecordedNumberView | null): string | null => (n ? `${n.value}, ${NUMBER_KIND[n.kind]}` : null);

const timeIn = (zone: string, iso: string): string => new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

/** The place a zone names, for the local time under a call: "Europe/London" is London. */
export const zonePlace = (zone: string): string => (zone.split("/").at(-1) ?? zone).replaceAll("_", " ");

/** Why a call is on the list, or when it opens, as Up next and the queue say it. */
export function reasonLine(item: CallQueueItem, userZone: string): { text: string; tone: "muted" | "pause" | "crit" } {
  if (item.bucket === "later_today" && item.opensAt) return { text: `Their calling hours start at ${timeIn(userZone, item.opensAt)} your time`, tone: "muted" };
  switch (item.reason) {
    case "rolled_over":
      return { text: "Rolled over from an earlier day", tone: "pause" };
    case "overdue":
      return { text: "Overdue", tone: "crit" };
    default:
      return { text: "Due today", tone: "muted" };
  }
}

/** The user's date as the server counts it ("2026-11-09" is Monday 9 November), with the time now. */
export function dateHeading(date: string, now: Date, userZone: string): string {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(`${date}T12:00:00Z`)).replace(",", "");
  return `${day}, ${new Intl.DateTimeFormat("en-GB", { timeZone: userZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now)}`;
}

/** Today's lede. */
export function todayLede(readyNow: number, laterToday: number): string {
  if (readyNow === 0) return laterToday === 0 ? "Nothing to call right now." : `Nothing to call right now. ${laterToday === 1 ? "One call opens" : `${laterToday} calls open`} later today.`;
  const ready = readyNow === 1 ? "One call is ready now" : `${readyNow} calls are ready now`;
  return laterToday === 0 ? `${ready}.` : `${ready}, and ${laterToday} more later today.`;
}

/** The capacity line under the queue. */
export function capacityLine(view: Pick<CallsView, "dailyCapacity" | "defaultDailyCapacity">): string {
  const n = view.dailyCapacity;
  return `Your daily call capacity is ${n} ${n === 1 ? "call" : "calls"}${n === view.defaultDailyCapacity ? ", the default until you set one" : ""}.`;
}

export const CAPACITY_USED = "Today’s call capacity is used. Calls that fall due now wait for tomorrow; none is dropped.";

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const hour = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;

/** A phone track's calling hours, "Mon–Fri, 09:00–17:00", Monday first; days with other hours each listed. */
export function callingHoursLine(rules: readonly WindowRule[]): string {
  if (rules.length === 0) return "No calling hours";
  const order = [1, 2, 3, 4, 5, 6, 0];
  const sorted = [...rules].sort((a, b) => order.indexOf(a.day) - order.indexOf(b.day));
  const groups: { days: number[]; start: number; end: number }[] = [];
  for (const r of sorted) {
    const last = groups.at(-1);
    const prev = last?.days.at(-1);
    if (last && last.start === r.start && last.end === r.end && prev !== undefined && order.indexOf(r.day) === order.indexOf(prev) + 1) last.days.push(r.day);
    else groups.push({ days: [r.day], start: r.start, end: r.end });
  }
  return groups
    .map((g) => {
      const first = DAY[g.days[0] ?? 0];
      const last = DAY[g.days.at(-1) ?? 0];
      const days = g.days.length === 1 ? first : g.days.length === 2 ? `${first}, ${last}` : `${first}–${last}`;
      return `${days}, ${hour(g.start)}–${hour(g.end)}`;
    })
    .join("; ");
}

/** Under the prospect's clock on the call sheet. */
export function clockLine(task: Pick<CallTaskView, "task" | "listed">, userZone: string): { text: string; tone: "ok" | "warn" | "plain" } {
  // A call off the list says nothing about its calling hours now.
  if (!task.listed) return { text: "Their time", tone: "plain" };
  if (task.task?.bucket === "ready_now") return { text: "Their time, inside calling hours", tone: "ok" };
  if (task.task?.bucket === "later_today" && task.task.opensAt) return { text: `Their time. Calling hours start at ${timeIn(userZone, task.task.opensAt)} your time`, tone: "warn" };
  return { text: "Their time, outside calling hours", tone: "warn" };
}

/** While an action is on its way. */
export function pendingLine(pending: NonNullable<DeskSnapshot["pending"]>): string {
  const what = pending.body.outcome === "skip_for_now" ? `Skipping ${pending.who} for now` : `Logging ${OUTCOME_LABEL[pending.body.outcome].toLowerCase()} for ${pending.who}`;
  return pending.unconfirmed ? `${what}: not confirmed yet. It is being sent again, and it is logged only once.` : `${what}…`;
}

/** What the server did with the last accepted action, read from its answer. */
export function loggedLine(logged: NonNullable<DeskSnapshot["logged"]>): string {
  const { body, task, who } = logged;
  if (body.outcome === "skip_for_now") return `${who} skipped for now.${task.listed ? " The call stays on today’s list." : ""}`;
  const parts = [`${who}: ${OUTCOME_LABEL[body.outcome].toLowerCase()} logged.`];
  const dialled = task.numbers.find((n) => n.detailId === body.numberId);
  if (body.outcome === "wrong_number" && dialled?.bad) parts.push(`${dialled.value} is marked wrong.`);
  if (task.status === "interested_on_call") parts.push(`${STATUS_LABEL.interested_on_call} in ${task.campaign.name}. Nothing else is recorded.`);
  else if (!task.open) parts.push(`The ${task.track.label.toLowerCase()} is finished.`);
  // Where the note is, as the server's answer stores it: never from what was asked.
  const note = body.note.trim();
  if (note !== "" && task.companyNotes.some((n) => n.body === note)) parts.push(`The note is saved for everyone at ${task.company.name}.`);
  else if (note !== "" && task.personNotes.some((n) => n.body === note)) parts.push(`The note is saved on ${who}.`);
  return parts.join(" ");
}

/** Why the call the page was on is off the list, from the server's `offList`. */
export function offListLine(who: string, off: CallOffListView | null, message: string | null, zone: string): string {
  if (off === null) return message ?? `${who}’s call is no longer on the list.`;
  switch (off.reason) {
    case "logged":
      return `${who}’s call is already logged: ${OUTCOME_LABEL[off.outcome].toLowerCase()} at ${timeIn(zone, off.at)}.`;
    case "lead_ended":
      if (off.status === "replied") return `${who} replied, so automation stopped and the call left the list.`;
      if (off.status === "interested_on_call") return `${who} was marked interested on another call, so automation stopped and the call left the list.`;
      return `${who}’s outreach in this campaign has ended (${STATUS_LABEL[off.status].toLowerCase()}), so the call left the list.`;
    case "track_finished":
      return off.finish === "skipped_missing_channel" ? `No good number is left for ${who}, so the phone track was skipped.` : `${who}’s phone track has finished, so the call left the list.`;
    case "not_listed_today":
      return `${who}’s call is not on today’s list.`;
  }
}

/** A sender account's problem, as Needs attention says it. */
const SENDER_PROBLEM: Readonly<Record<string, string>> = {
  sending_off: "Sending is switched off for it in Instantly.",
  not_active: "Instantly reports it as not active.",
  no_daily_limit: "It has no daily sending limit in Instantly.",
  stale: "Instantly hasn’t reported on it recently.",
  disconnected: "It is disconnected.",
  not_listed: "Its provider no longer lists it.",
  unhealthy: "Its provider reports that it can’t send.",
};

const HOLD_REASON: Readonly<Record<string, string>> = {
  unresolved: "the provider hasn’t confirmed whether a message went",
  render_failed: "a message couldn’t be put together from its copy",
  provider_skipped: "the provider skipped the lead",
  no_thread: "a follow-up has no earlier email to continue",
  sms_conversation_taken: "the mobile is in another campaign’s SMS conversation from every number this campaign may use",
};

export interface AttentionItem {
  readonly key: string;
  readonly tone: "crit" | "pause" | "end";
  readonly title: string;
  readonly body: string;
}

/** Everything Needs attention reports, each once. */
export function attentionItems(n: NeedsAttention, userZone: string): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const p of n.senderProblems) {
    items.push({
      key: `sender-${p.accountId}`,
      tone: "crit",
      title: p.channel === "sms" ? `Your SMS number ${p.label} can’t send` : `Your inbox ${p.label} can’t send`,
      body: `${SENDER_PROBLEM[p.problem] ?? `The provider says: ${p.problem}.`} Leads that send from it wait; nothing is dropped.`,
    });
  }
  for (const w of n.accountWaits) {
    items.push({
      key: `wait-${w.accountId}`,
      tone: "pause",
      title: `${w.accountId} is waiting`,
      body: w.reason === "quota" ? "Instantly refused more sends for now. Sending resumes when it allows; nothing is dropped." : `Instantly asked to slow down. Sending resumes${w.until ? ` at ${timeIn(userZone, w.until)}` : ""}; nothing is dropped.`,
    });
  }
  for (const s of n.stalledInboxes) {
    items.push({ key: `stalled-${s.accountId}`, tone: "pause", title: `Sends from ${s.accountId} are stalled`, body: `${s.holding.length} ${s.holding.length === 1 ? "send waits" : "sends wait"} on it. Nothing is dropped.` });
  }
  for (const c of n.heldCapacity) {
    items.push({ key: `held-${c.accountId}`, tone: "pause", title: `${c.held} of ${c.accountId}’s ${c.capacity} sends today are held`, body: "The provider hasn’t confirmed whether those messages went, so their room is kept until it does." });
  }
  const byReason = new Map<string, number>();
  for (const t of n.heldTracks) byReason.set(t.reason, (byReason.get(t.reason) ?? 0) + 1);
  for (const [reason, count] of byReason) {
    items.push({ key: `tracks-${reason}`, tone: "pause", title: count === 1 ? "One lead’s track is on hold" : `${count} leads’ tracks are on hold`, body: `On hold because ${HOLD_REASON[reason] ?? reason}. Nothing is dropped.` });
  }
  for (const [i, a] of n.anomalies.entries()) items.push({ key: `anomaly-${i}`, tone: "end", title: "The provider reported something unexpected", body: a.what });
  return items;
}

/** While this page sends an outcome for another call, chosen here or in another tab, that has no answer yet. */
export function recoveringLine(who: string): string {
  return `Sending an outcome for ${who} that has no answer yet. It is logged only once.`;
}

/** A kept refusal: what was not logged, and why, from the server's `offList` when it said. */
export function refusedRecordLine(
  record: { readonly who: string; readonly body: { readonly outcome: CallOutcomeApi }; readonly refused: { readonly message: string; readonly offList: CallOffListView | null } },
  zone: string,
): string {
  const what = record.body.outcome === "skip_for_now" ? `skip for now on ${record.who}` : `${OUTCOME_LABEL[record.body.outcome].toLowerCase()} for ${record.who}`;
  const why = record.refused.offList ? offListLine(record.who, record.refused.offList, null, zone) : record.refused.message;
  return `Not logged: ${what}. ${why}`;
}

/** What the outcome box says of the number: before Log, while it is on its way. */
export function outcomeNumberLine(outcome: CallOutcomeApi, number: { readonly value: string; readonly kind: CallNumberView["kind"] } | null, pending: boolean): string {
  if (number === null) return "Choose the number you dialled above.";
  const n = `${number.value} (${NUMBER_KIND[number.kind]})`;
  if (outcome === "wrong_number") return pending ? `Logging ${n} as a wrong number…` : `${n}, the number you dial above, will be marked wrong.`;
  return pending ? `Logging on ${n}…` : `To be logged on ${n}.`;
}

/** Under the numbers, when the one the user chose can no longer be logged on. */
export function numberProblemLine(problem: { readonly kind: "bad" | "gone"; readonly value: string | null }): string {
  return problem.kind === "bad" ? `The number you chose, ${problem.value ?? ""}, is now marked wrong. Choose the number you dial.` : "The number you chose is no longer one of this lead’s. Choose the number you dial.";
}

/** When the server says its worker has work due that it has not finished (ADR 0003 4.4). */
export const BEHIND_LINE = "Calls that have just fallen due may still be being placed. This page updates when they are.";

/** A press this device's storage refused (ADR 0003 4.4.1, the boundary): nothing was sent. */
/**
 * A kept refusal says only what is true of it: that outcome was not logged, why, and the note typed
 * with it. Whether that text is saved anywhere is not its to say (re-check on 12f0303, R2).
 */
export const REFUSED_NOTE_LEAD = "The note typed with it:";

/** A refusal this device's storage would not record: shown from the page, its write retried. */
export const UNSTORED_REFUSAL_LINE = "This device’s storage is full or blocked, so this refusal could not be recorded on it.";

export const NOT_QUEUED_LINE = "This outcome couldn’t be queued on this device: its storage is full or blocked, so nothing was sent. Your choice and note are kept. Free some space, or allow this site to store data, then press Log again.";
