/**
 * Every sentence the Today page and the call focus queue say about calls, one function each. Each
 * reads only what the server reported (the queue, the call task, an outcome's answer, Needs
 * attention); none decides anything about order, counts, hours, capacity or an outcome's effect.
 */
import type { CallNumberView, CallOffListView, CallOutcomeApi, CallQueueItem, CallsView, CallTaskView, NeedsAttention, RecordCallView, RecordedNumberView, TodayView, WindowRule } from "../../shared/api.ts";
import { STATUS_LABEL } from "../status.tsx";
import type { DeskSnapshot } from "./callDesk.ts";
import { dayLabel, type CallbackProblem } from "./callbackTime.ts";

/** The outcome buttons, as the approved prototype labels them. */
export const OUTCOME_LABEL = {
  no_answer: "No answer",
  voicemail: "Left voicemail",
  gatekeeper: "Didn’t reach them",
  wrong_number: "Wrong number",
  interested: "Interested",
  callback_requested: "Callback requested",
  skip_for_now: "Skip for now",
} as const satisfies Record<CallOutcomeApi, string>;

/** A logged call's title in Activity and in previous touches. */
export const OUTCOME_TITLE = {
  no_answer: "Call: no answer",
  voicemail: "Call: left voicemail",
  gatekeeper: "Call: didn’t reach them",
  wrong_number: "Call: wrong number",
  interested: "Call: interested",
  callback_requested: "Call: callback requested",
  skip_for_now: "Call skipped for now",
} as const satisfies Record<CallOutcomeApi, string>;

const NUMBER_KIND = { direct: "direct", mobile: "mobile", main_line: "main line" } as const;

export const numberKind = (n: Pick<CallNumberView, "kind">): string => NUMBER_KIND[n.kind];

/** "+44 20 7946 0111, direct": the number a past call was logged on. */
export const dialledLine = (n: RecordedNumberView | null): string | null => (n ? `${n.value}, ${NUMBER_KIND[n.kind]}` : null);

const timeIn = (zone: string, iso: string): string => new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

/** "Thu 5 Nov": the date of an instant in a zone. */
export const dateIn = (zone: string, iso: string): string => new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short" }).format(new Date(iso)).replace(",", "");

/** YYYY-MM-DD of an instant in a zone. */
const isoDateIn = (zone: string, iso: string): string => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

/**
 * A callback's time as the prospect asked for it, in their time, and in the user's when the zones read differently:
 * "Thu 5 Nov at 14:30 their time" or "Thu 5 Nov at 14:30 their time, 15:30 your time".
 */
export function callbackWhen(iso: string, zone: string, userZone: string): string {
  const theirs = `${dateIn(zone, iso)} at ${timeIn(zone, iso)} their time`;
  const yours = `${dateIn(userZone, iso)} at ${timeIn(userZone, iso)}`;
  if (yours === `${dateIn(zone, iso)} at ${timeIn(zone, iso)}`) return `${theirs}, the same as yours`;
  return `${theirs}, ${dateIn(userZone, iso) === dateIn(zone, iso) ? timeIn(userZone, iso) : yours} your time`;
}

/** "the end of Tue 3 Nov", from a user date. */
const endOf = (date: string): string => `the end of ${dayLabel(date)}`;

/** The place a zone names, for the local time under a call: "Europe/London" is London. */
export const zonePlace = (zone: string): string => (zone.split("/").at(-1) ?? zone).replaceAll("_", " ");

/**
 * Why a call is on the list, or when it opens, as Up next and the queue say it: the server's reason, the
 * original due date of a carried call, a callback's time in the prospect's and the user's time, and the
 * server's word that an unworked call is skipped tonight. `today` is the user's date as the server counts it.
 */
export function reasonLine(item: CallQueueItem, userZone: string, today?: string): { text: string; tone: "muted" | "pause" | "crit" } {
  const tonight = item.skippedTonight ? ", last day before it’s skipped" : "";
  // A callback waits for the time the prospect asked for, not for calling hours: said as a callback.
  if (item.bucket === "later_today" && item.opensAt && item.reason !== "callback" && item.reason !== "overdue") return { text: `Their calling hours start at ${timeIn(userZone, item.opensAt)} your time${tonight}`, tone: "muted" };
  const due = dateIn(userZone, item.dueAt);
  switch (item.reason) {
    case "rolled_over":
      return { text: `Rolled over, due ${due}${tonight}`, tone: "pause" };
    case "redial":
      return { text: `Redial, due ${due}${tonight}`, tone: "pause" };
    case "callback": {
      if (!item.callbackAt) return { text: "Callback", tone: "pause" };
      const yours = timeIn(userZone, item.callbackAt);
      const theirs = timeIn(item.zone, item.callbackAt);
      return { text: `Callback they asked for at ${theirs} their time${theirs === yours ? "" : `, ${yours} yours`}`, tone: "pause" };
    }
    case "overdue": {
      if (!item.callbackAt) return { text: "Callback overdue", tone: "crit" };
      const day = today !== undefined && isoDateIn(item.zone, item.callbackAt) === today ? "today" : dateIn(item.zone, item.callbackAt);
      return { text: `Callback overdue since ${day} at ${timeIn(item.zone, item.callbackAt)} their time${item.noGoodNumber ? ", no good number left" : ""}`, tone: "crit" };
    }
    case "due":
      return { text: `Due today${tonight}`, tone: "muted" };
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
export function clockLine(task: Pick<CallTaskView, "task" | "listed" | "callingHoursNow">, userZone: string): { text: string; tone: "ok" | "warn" | "plain" } {
  // A call off the list says nothing about its calling hours now.
  if (!task.listed) return { text: "Their time", tone: "plain" };
  // The server's fact about the hours at this instant, never the queue's bucket: a callback is listed by the time asked for (re-check 7, R10).
  const { open, opensLaterToday } = task.callingHoursNow;
  if (open) return { text: "Their time, inside calling hours", tone: "ok" };
  // Outside the hours a callback is still the prospect's own time to call: said plainly, not as a warning.
  const tone = task.task?.reason === "callback" || task.task?.reason === "overdue" ? "plain" : "warn";
  if (opensLaterToday !== null) return { text: `Their time. Calling hours start at ${timeIn(userZone, opensLaterToday)} your time`, tone };
  return { text: "Their time, outside calling hours", tone };
}

/** While an action is on its way. */
export function pendingLine(pending: NonNullable<DeskSnapshot["pending"]>): string {
  const what = pending.body.outcome === "skip_for_now" ? `Skipping ${pending.who} for now` : `Logging ${OUTCOME_LABEL[pending.body.outcome].toLowerCase()}${pending.body.redial ? " with a redial" : ""} for ${pending.who}`;
  // Another window's press: nothing has failed, it is simply being logged there (council on b8c65f9, item 5).
  if (!pending.own) return `${what} from another window. It is logged only once.`;
  return pending.unconfirmed ? `${what}: not confirmed yet. It is being sent again, and it is logged only once.` : `${what}…`;
}

/** While the server's word on this tab's press is read: its outbox entry has just gone. */
export function confirmingLine(who: string): string {
  return `Checking with the server whether ${who}’s outcome is logged…`;
}

/** What the server did with the last accepted action, read from its answer. */
export function loggedLine(logged: NonNullable<DeskSnapshot["logged"]>, userZone: string = logged.task.zone): string {
  const { body, task, who } = logged;
  if (body.outcome === "skip_for_now") return `${who} skipped for now.${task.listed ? (task.kind === "callback" ? " The callback stays on today’s list, and their outreach stays held." : " The call stays on today’s list.") : ""}`;
  // What the server stored for this press: its outcome, redial and callback time (ticket 15b), never the draft's.
  const stored = task.storedCalls.find((c) => c.requestId === logged.requestId);
  if (stored?.outcome === "callback_requested" && stored.callbackAt !== null) {
    const parts = [`${who}: callback requested for ${callbackWhen(stored.callbackAt, task.zone, userZone)}.`];
    if (task.open && task.kind === "callback" && task.callbackAt === stored.callbackAt) parts.push(`Their automated outreach in ${task.campaign.name} is held until you log how the callback went.`);
    return withNote(parts, body, task, who);
  }
  if (stored?.redial) {
    const parts = [`${who}: ${OUTCOME_LABEL[stored.outcome].toLowerCase()} logged, with a redial.`];
    if (task.open && !task.listed) parts.push(`The call is on the list for ${dayLabel(task.listedFor)}, and the ${task.track.label.toLowerCase()} stays open.`);
    if (task.open && task.skipLimit?.ifUnworked) parts.push(`If it isn’t worked, it is skipped at ${endOf(task.skipLimit.ifUnworked)}.`);
    return withNote(parts, body, task, who);
  }
  const parts = [`${who}: ${OUTCOME_LABEL[body.outcome].toLowerCase()} logged.`];
  const dialled = task.numbers.find((n) => n.detailId === body.numberId);
  if (body.outcome === "wrong_number" && dialled?.bad) parts.push(`${dialled.value} is marked wrong.`);
  if (task.status === "interested_on_call") parts.push(`${STATUS_LABEL.interested_on_call} in ${task.campaign.name}. Nothing else is recorded.`);
  else if (!task.open) parts.push(`The ${task.track.label.toLowerCase()} is finished.`);
  return withNote(parts, body, task, who);
}

/** Where the note is, as the server's answer stores it: never from what was asked. */
function withNote(parts: string[], body: { readonly note: string }, task: CallTaskView, who: string): string {
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
      // This tab's own press, once stored, is shown as logged by it (reconcile); this one came from elsewhere.
      return `${who}’s call was already logged from another window or device: ${OUTCOME_LABEL[off.outcome].toLowerCase()} at ${timeIn(zone, off.at)}.`;
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
  /** Where to act: Calls for an overdue callback, Campaigns otherwise. */
  readonly action?: { readonly label: string; readonly href: string };
}

/**
 * Overdue callbacks first, as the prototype puts them (ticket 15b), from Today's read, which names whose
 * they are; GET /api/needs-attention reports the same callbacks without names, so they are said once.
 */
function overdueItem(today: Pick<TodayView, "overdueCallbacks" | "userZone" | "date">): AttentionItem | null {
  const od = today.overdueCallbacks;
  const first = od[0];
  if (!first) return null;
  const name = (x: CallQueueItem) => x.person?.name ?? x.company.name;
  const asked = od.map((x) => `${name(x)} asked for ${x.callbackAt ? callbackWhen(x.callbackAt, x.zone, today.userZone) : "a callback"}.`).join(" ");
  const stuck = od.filter((x) => x.noGoodNumber);
  const q13 =
    stuck.length === 0
      ? ""
      : ` Every number for ${stuck.map(name).join(" and ")} is marked wrong, so nothing can be logged on ${stuck.length === 1 ? "that callback" : "those callbacks"} until a new number arrives by import or they reply.`;
  return {
    key: "overdue-callbacks",
    tone: "crit",
    title: od.length === 1 ? `${name(first)}’s callback is overdue` : `${od.length} callbacks are overdue`,
    body: `${asked} ${od.length === 1 ? "It stays" : "They stay"} on your call list, flagged overdue, and automated outreach to ${od.length === 1 ? "them" : "each"} stays held until you log what happened.${q13}`,
    action: { label: "Open Calls", href: "/calls" },
  };
}

/** Everything Needs attention reports, each once; with Today's read, overdue callbacks first. */
export function attentionItems(n: NeedsAttention, userZone: string, today?: Pick<TodayView, "overdueCallbacks" | "userZone" | "date"> | null): AttentionItem[] {
  const items: AttentionItem[] = [];
  const overdue = today ? overdueItem(today) : null;
  if (overdue) items.push(overdue);
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
  record: { readonly who: string; readonly body: { readonly outcome: CallOutcomeApi; readonly redial?: true; readonly callbackAt?: string }; readonly refused: { readonly message: string; readonly offList: CallOffListView | null } },
  zone: string,
): string {
  const { body } = record;
  const extra = body.redial ? " with a redial" : body.callbackAt ? ` for ${dateIn(zone, body.callbackAt)} at ${timeIn(zone, body.callbackAt)} your time` : "";
  const what = body.outcome === "skip_for_now" ? `skip for now on ${record.who}` : `${OUTCOME_LABEL[body.outcome].toLowerCase()}${extra} for ${record.who}`;
  // The server's own message, unless it refused because the call was already logged, which the off-list facts say with what and when.
  const why = record.refused.offList?.reason === "logged" ? offListLine(record.who, record.refused.offList, null, zone) : record.refused.message;
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


/** A press this device's storage refused (ADR 0003 4.4.1, the boundary): nothing was sent. */
/**
 * A kept refusal says only what is true of it: that outcome was not logged, why, and the note typed
 * with it. Whether that text is saved anywhere is not its to say (re-check on 12f0303, R2).
 */
export const REFUSED_NOTE_LEAD = "The note typed with it:";

/** A refusal this device's storage would not record: shown from the page, its write retried. */
export const UNSTORED_REFUSAL_LINE = "This device’s storage is full or blocked, so this refusal could not be recorded on it.";

/** The draft's copy in this tab's storage failed (ADR 0003 4.4.1): what it means, and only that. */
export const DRAFT_NOT_KEPT_LINE = "This note is not being kept on this device if you leave the page.";

export const NOT_QUEUED_LINE = "This outcome couldn’t be queued on this device: its storage is full or blocked, so nothing was sent. Your choice and note are kept. Free some space, or allow this site to store data, then press Log again.";

// ---------------------------------------------------------------------------------------------
// Redials and callbacks (ticket 15b). What the engine does, said from the server's read of the call before
// Log (its `redial` and `skipLimit` facts) and from its answer after; nothing here computes a date.

/** Under "Call again tomorrow", from the call's read: where a redial puts the call, and when the skip limit still ends it. */
export function redialLines(task: Pick<CallTaskView, "redial" | "skipLimit" | "track">): { checked: string; unchecked: string } {
  const track = task.track.label.toLowerCase();
  const moves = task.redial ? `The call moves to the list for ${dayLabel(task.redial.listedFor)}, and the ${track} stays open, so the tracks after it keep waiting.` : `The call moves to tomorrow’s list, and the ${track} stays open.`;
  const limit = task.skipLimit
    ? ` The skip limit still counts from ${dayLabel(task.skipLimit.dueDate)}, its original due date${task.redial?.ifUnworked ? `: if it isn’t worked, it is skipped at ${endOf(task.redial.ifUnworked)}` : ""}.`
    : "";
  return { checked: `${moves}${limit}`, unchecked: `Without a redial, this call is done: the ${track} finishes, and nothing calls them again unless you ask.` };
}

/** What the callback controls say about the time entered: shown back in both times, and what the engine will make of it. */
export function callbackLine(
  callback: { readonly at: number | null; readonly problem: CallbackProblem | null },
  advice: "inside" | "outside" | "closed_day" | null,
  task: Pick<CallTaskView, "zone" | "callingHours">,
  userZone: string,
): { text: string; tone: "plain" | "crit" } {
  if (callback.problem === "missing") return { text: "Enter the day and time they asked for, in their time.", tone: "plain" };
  if (callback.problem === "no_such_time") return { text: "That time doesn’t exist in their time zone on that day: the clocks change. Choose another time.", tone: "crit" };
  if (callback.problem === "past" || callback.at === null) return { text: "That time has passed. Choose a time still to come; a callback in the past isn’t accepted.", tone: "crit" };
  const when = callbackWhen(new Date(callback.at).toISOString(), task.zone, userZone);
  const hours = callingHoursLine(task.callingHours);
  const note =
    advice === "inside"
      ? "Inside their calling hours."
      : advice === "outside"
        ? `Outside their calling hours (${hours}), and still accepted: a callback is listed at the time they asked for.`
        : `Their calling hours never open on that day (${hours}), and it is still accepted: a callback is listed at the time they asked for.`;
  return { text: `Callback on ${when}. ${note}`, tone: "plain" };
}

/** What a callback does to the lead, before Log (ADR 0003 2.3, Q12): the hold, and that nothing ends it but an outcome. */
export function callbackHoldLine(task: Pick<CallTaskView, "kind" | "campaign">, who: string): string {
  if (task.kind === "callback") return `A new time keeps the hold: ${who}’s automated outreach in ${task.campaign.name} stays held until you log how the callback went.`;
  return `${who}’s automated outreach in ${task.campaign.name} is held from now until you log how the callback went. The call stays open: it is never skipped, and nothing resumes by itself.`;
}

/** Any other outcome on a callback ends its hold (ADR 0003 2.4: the hold is released first, then the outcome is logged). */
export const CALLBACK_RELEASE_LINE = "Logging this ends the callback’s hold on their automated outreach in this campaign.";

/** Skip for now, before Log. */
export function skipLine(task: Pick<CallTaskView, "kind">): string {
  return task.kind === "callback" ? "The callback goes to the end of today’s list and stays open; their outreach stays held." : "The call goes to the end of today’s list. Nothing else changes.";
}

/** Question Q13's interim, said plainly: a callback whose lead has no good number left. */
export function noGoodNumberLine(who: string): string {
  return `Every number for ${who} is marked wrong, so nothing but skip for now can be logged on this callback. It stays on your list, flagged overdue once its time passes, and their other outreach in this campaign stays held until a new number arrives by import or they reply. Pausing them or skipping the step arrives with a later release.`;
}

/** One sentence per open call on the person and company-lead record (ticket 15b), from the server's read as of `today`. */
export function recordCallLine(call: RecordCallView, today: string): string {
  const limit = call.skipLimit
    ? ` It was due ${dayLabel(call.skipLimit.dueDate)}${call.skipLimit.ifUnworked ? `; if it isn’t worked, it is skipped at ${endOf(call.skipLimit.ifUnworked)}` : ""}.`
    : "";
  if (call.kind === "callback") {
    const at = call.callbackAt ? `${dateIn(call.zone, call.callbackAt)} at ${timeIn(call.zone, call.callbackAt)} their time` : "at the time they asked for";
    const overdue = call.reason === "overdue";
    const lines = [overdue ? `Callback ${at}, now overdue. It stays on your call list until you log what happened, and their automated outreach in this campaign stays held until then.` : `Callback ${at}. Their automated outreach in this campaign is held until you log how it went.`];
    if (call.noGoodNumber) lines.push("Every number is marked wrong, so nothing can be logged on it until a new number arrives by import or they reply. Pausing them or skipping the step arrives with a later release.");
    return lines.join(" ");
  }
  if (call.heldByCallback) return `Their call on the ${call.track.label.toLowerCase()} waits while their callback is open: only the callback is on the list.`;
  if (call.listed) {
    const why = call.reason === "rolled_over" ? "Their call rolled over to today’s list." : call.reason === "redial" ? "Their call is back on today’s list: you asked for a redial." : "Their call is on today’s list.";
    return `${why}${limit}`;
  }
  if (call.listedFor > today) return `Their call is on the list for ${dayLabel(call.listedFor)}.${limit}`;
  return `Their call waits for a day their calling hours open.${limit}`;
}
