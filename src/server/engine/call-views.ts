/**
 * Read models for calls (ticket 14): Today's call counts and Up next, the focus queue, and one call
 * task with everything the call screen shows. Built from the engine's stored facts and the CRM, so
 * the screens render them without recomputing anything.
 */
import { bucketOf, CALL_OUTCOMES, callNumbers, callWindow, dayHasRoom, isListed, listedForDay, queueRank, queueWall, recordedNumberOf, REDIAL_OUTCOMES, skippedTonight, type CallBucket } from "../../domain/sequence/calls.ts";
import { displayPhone } from "../../domain/phone.ts";
import { localDayNumber, nextWindowClose, nextWindowOpen, startOfLocalDay, windowOpen } from "../../domain/sequence/clock.ts";
import { liveTracks } from "../../domain/sequence/definition.ts";
import { deriveStatus } from "../../domain/sequence/progress.ts";
import type { CallAttempt, CallNumber, CallTask, RecordedNumber, SubjectState } from "../../domain/sequence/state.ts";
import type { CallColleagueView, CallNumberView, CallOffListView, CallQueueItem, CallRecordView, RecordedNumberView, CallsView, CallTaskView, NoteView, TodayView, TouchView } from "../../shared/api.ts";
import type { OutreachStore } from "../persistence/store.ts";
import { DEFAULT_DAILY_CALL_CAPACITY } from "../persistence/sqlite-engine-store.ts";
import type { StoredNote } from "./engine-store.ts";
import { DEFAULT_RULES, type Rules } from "./rules.ts";

/**
 * The decisions the call read models make, from the engine's rules: each lead's state as of the instant read
 * (the same catch-up a user action gets, council on 228cd3b), the queue order, the focus and the reasons.
 */
export type CallViewRules = Pick<Rules, "readyNowOrder" | "focusOf" | "callReason" | "asOfAction" | "evaluate">;

/** A lead's state as of `now`: what fell due since the worker's last tick is applied (nothing is written). */
async function asOfNow(store: OutreachStore, id: string, now: number, rules: CallViewRules): Promise<SubjectState | null> {
  const stored = await store.engine.subject(id, now);
  return stored ? rules.asOfAction(stored, now, rules.evaluate) : null;
}

const iso = (t: number) => new Date(t).toISOString();

/** HH:MM on a 24-hour clock in `zone`. */
export function localTimeIn(zone: string, t: number): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t);
}

/** The user's date, YYYY-MM-DD in their zone. */
function dateIn(zone: string, t: number): string {
  return dateOfDay(localDayNumber(t, zone));
}

/** A user-local day number as YYYY-MM-DD. */
export const dateOfDay = (day: number): string => new Date(day * 86_400_000).toISOString().slice(0, 10);

/** One logged call as the screens show it: the number dialled, and a redial or the callback time asked for. */
export const callRecordView = (s: SubjectState, c: CallAttempt): CallRecordView => ({
  outcome: c.outcome,
  at: iso(c.atWall),
  number: recordedView(recordedNumberOf(s, c.numberDetailId)),
  note: c.note,
  redial: c.redial,
  callbackAt: c.callbackAt === null ? null : iso(c.callbackAt),
});

/** A phone track's name as the canvas gives it: "Phone track", or "Phone track 2" when the campaign has several. */
function trackLabel(s: SubjectState, trackId: string): string {
  const phones = liveTracks(s.campaign.definition).filter((t) => t.channel === "call");
  const position = phones.findIndex((t) => t.id === trackId);
  return phones.length <= 1 || position < 0 ? "Phone track" : `Phone track ${position + 1}`;
}

/** Shown as the person and company pages show numbers: read from the key, so one number always looks the same. */
const numberView = (n: CallNumber): CallNumberView => ({ detailId: n.id, kind: n.kind, owner: n.owner, value: displayPhone(n.key), bad: n.bad });
/** A past call's number: what was dialled, with no claim about dialling it now. */
export const recordedView = (n: RecordedNumber | null): RecordedNumberView | null => (n ? { detailId: n.id, kind: n.kind, owner: n.owner, value: displayPhone(n.key) } : null);
const noteView = (n: StoredNote): NoteView => ({ id: n.id, body: n.body, at: iso(n.atWall) });

interface Parties {
  readonly person: { id: string; name: string; title: string } | null;
  readonly company: { id: string; name: string };
  readonly campaign: { id: string; name: string };
}

async function partiesOf(store: OutreachStore, subjectId: string): Promise<Parties | null> {
  const parties = await store.engine.subjectParties(subjectId);
  if (!parties) return null;
  const person = parties.personId === null ? null : await store.person(parties.personId);
  const company = await store.company(parties.companyId);
  const campaign = await store.campaign(parties.campaignId);
  return {
    person: person ? { id: person.id, name: person.name, title: person.title } : null,
    company: { id: parties.companyId, name: company?.name ?? "" },
    campaign: { id: parties.campaignId, name: campaign?.name ?? "" },
  };
}

function queueItem(s: SubjectState, task: CallTask, parties: Parties, place: { bucket: CallBucket; opensAt: number | null }, now: number, rules: CallViewRules = DEFAULT_RULES): CallQueueItem {
  return {
    taskId: task.id,
    enrollmentId: s.subject.id,
    ...parties,
    track: { id: task.trackId, label: trackLabel(s, task.trackId) },
    zone: s.lead.zone,
    localTime: localTimeIn(s.lead.zone, now),
    reason: rules.callReason(s, task, now),
    kind: task.kind,
    callbackAt: task.callbackAt === null ? null : iso(task.callbackAt),
    dueAt: iso(task.dueWall),
    bucket: place.bucket,
    opensAt: place.opensAt === null ? null : iso(place.opensAt),
    skippedTonight: skippedTonight(s, task, now),
  };
}

/**
 * The call list now (4.4): ready now, oldest due first, with tasks skipped for now today after the
 * rest in the order they were skipped; later today, soonest opening first.
 */
async function callList(store: OutreachStore, now: number, rules: CallViewRules = DEFAULT_RULES) {
  const day = await store.engine.callDay(now);
  const items: { item: CallQueueItem; task: CallTask; skippedToday: boolean; subjectId: string; opensAt: number; rank: 0 | 1 | 2 }[] = [];
  /** Instants at which the list changes by the clock: hours opening (later today) and closing (ready now). */
  const changes: number[] = [startOfLocalDay(day.day + 1, day.userZone)];
  /** Every open task listed now, in a queue part or not (its hours closed for the day). */
  const listed = new Set<string>();
  for (const id of await store.engine.subjectsWithOpenCallTasks()) {
    const s = await asOfNow(store, id, now, rules);
    if (!s) continue;
    for (const task of s.callTasks) {
      if (task.open && isListed(s, task)) listed.add(task.id);
      const place = task.open ? bucketOf(s, task, now) : null;
      if (!place) continue;
      const parties = await partiesOf(store, id);
      if (!parties) continue;
      if (place.bucket === "later_today" && place.opensAt !== null) changes.push(place.opensAt);
      const closes = place.bucket === "ready_now" ? nextWindowClose(callWindow(s, task.trackId), s.lead.zone, now) : null;
      if (closes !== null) changes.push(closes);
      const skippedToday = task.skippedWall !== null && localDayNumber(task.skippedWall, day.userZone) === day.day;
      items.push({ item: queueItem(s, task, parties, place, now, rules), task, skippedToday, subjectId: id, opensAt: place.opensAt ?? now, rank: queueRank(s, task, now) });
    }
  }
  const byDue = (a: (typeof items)[number], b: (typeof items)[number]) =>
    a.task.dueWall - b.task.dueWall || (a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : 0) || (a.task.stepId < b.task.stepId ? -1 : 1);
  const entry = (x: (typeof items)[number]) => ({ taskId: x.task.id, subjectId: x.subjectId, stepId: x.task.stepId, rank: x.rank, dueWall: queueWall(x.task), skippedWall: x.skippedToday ? x.task.skippedWall : null });
  const readyNow = items
    .filter((x) => x.item.bucket === "ready_now")
    .sort((a, b) => rules.readyNowOrder(entry(a), entry(b)))
    .map((x) => x.item);
  const laterToday = items
    .filter((x) => x.item.bucket === "later_today")
    .sort((a, b) => a.opensAt - b.opensAt || byDue(a, b))
    .map((x) => x.item);
  return { day, readyNow, laterToday, listed, changes };
}

/** A hint of the next instant the list changes by the clock: calling hours opening or closing, the next user day. */
function nextChange(changes: readonly number[], now: number): string | null {
  const next = changes.filter((t) => t > now);
  return next.length === 0 ? null : iso(Math.min(...next));
}

/**
 * The focus queue. `focus` is the call the user's screen is on: it keeps the focus while it is listed,
 * so the queue moves on only after an outcome (or a skip for now) is logged on it.
 */
export async function callsView(store: OutreachStore, now: number, options: { readonly focus?: string | null; readonly rules?: CallViewRules } = {}): Promise<CallsView> {
  const { day, readyNow, laterToday, listed, changes } = await callList(store, now, options.rules);
  const focus = options.focus ?? null;
  return {
    date: dateIn(day.userZone, now),
    asOf: iso(now),
    nextChangeAt: nextChange(changes, now),
    userZone: day.userZone,
    dailyCapacity: day.capacity,
    defaultDailyCapacity: DEFAULT_DAILY_CALL_CAPACITY,
    capacityReached: !dayHasRoom(day),
    placedToday: day.placedToday,
    committed: day.committed,
    readyNow,
    laterToday,
    focusTaskId: (options.rules ?? DEFAULT_RULES).focusOf(
      readyNow.map((x) => x.taskId),
      focus === null ? null : { taskId: focus, listed: listed.has(focus) },
    ),
  };
}

/** How many calls Up next shows on Today. */
const UP_NEXT = 5;

export async function todayView(store: OutreachStore, now: number, rules?: CallViewRules): Promise<TodayView> {
  const { day, readyNow, laterToday, changes } = await callList(store, now, rules);
  const listed = [...readyNow, ...laterToday];
  return {
    date: dateIn(day.userZone, now),
    asOf: iso(now),
    nextChangeAt: nextChange(changes, now),
    userZone: day.userZone,
    readyNow: readyNow.length,
    laterToday: laterToday.length,
    capacityReached: !dayHasRoom(day),
    upNext: listed.slice(0, UP_NEXT),
    // Oldest first, by the time the prospect asked for.
    overdueCallbacks: readyNow.filter((x) => x.reason === "overdue").sort((a, b) => Date.parse(a.callbackAt ?? "") - Date.parse(b.callbackAt ?? "") || (a.taskId < b.taskId ? -1 : 1)),
    carriedOver: listed.filter((x) => x.reason === "rolled_over" || x.reason === "redial").length,
  };
}

/**
 * Why a task is not on today's list (ADR 0003 4.4.1), read from the stored task and its call records:
 * an outcome logged on it comes first, then the lead's ending, then its track's finish.
 */
function offListOf(s: SubjectState, task: CallTask, listed: boolean): CallOffListView | null {
  if (listed) return null;
  const status = deriveStatus(s);
  const logged = s.callAttempts.filter((a) => a.taskId === task.id && a.outcome !== "skip_for_now").at(-1);
  if (logged) return { reason: "logged", outcome: logged.outcome, at: iso(logged.atWall), status };
  if (s.subject.ended !== null) return { reason: "lead_ended", status };
  if (!task.open) return { reason: "track_finished", finish: s.tracks.find((p) => p.trackId === task.trackId)?.finishReason ?? null, status };
  return { reason: "not_listed_today", status };
}

/** Whether the hours are open at `now`, by the engine's window rule, and, if not, when they open later on the user's day. */
function callingHoursAt(window: ReturnType<typeof callWindow>, zone: string, now: number, userZone: string): CallTaskView["callingHoursNow"] {
  if (windowOpen(window, zone, now)) return { open: true, opensLaterToday: null };
  const opens = nextWindowOpen(window, zone, now);
  const today = opens !== null && localDayNumber(opens, userZone) === localDayNumber(now, userZone);
  return { open: false, opensLaterToday: today ? iso(opens) : null };
}

/** One call task with everything the call screen shows, or null for an unknown task. */
export async function callTaskView(store: OutreachStore, taskId: string, now: number, rules: CallViewRules = DEFAULT_RULES): Promise<CallTaskView | null> {
  const subjectId = await store.engine.callTaskSubject(taskId);
  const s = subjectId === null ? null : await asOfNow(store, subjectId, now, rules);
  const task = s?.callTasks.find((t) => t.id === taskId);
  const parties = subjectId === null ? null : await partiesOf(store, subjectId);
  if (!s || !task || !parties) return null;
  const place = task.open ? bucketOf(s, task, now) : null;
  const numbers = callNumbers(s);
  const item = place ? queueItem(s, task, parties, place, now, rules) : null;
  const listed = isListed(s, task);

  const touches: { touch: TouchView; t: number }[] = [];
  for (const a of s.attempts) {
    if (a.state !== "sent") continue;
    const sentWall = s.work.find((w) => w.key === a.idempotencyKey)?.sentWall ?? a.handedWall ?? a.claimedWall;
    const channel = s.campaign.definition.tracks.find((t) => t.id === a.trackId)?.channel === "sms" ? "sms" : "email";
    touches.push({ touch: { kind: channel, at: iso(sentWall), stepId: a.stepId, copy: a.copy }, t: sentWall });
  }
  for (const r of s.replies) touches.push({ touch: { kind: "reply", channel: r.channel, at: iso(r.atWall) }, t: r.atWall });
  for (const c of s.callAttempts) {
    if (c.outcome === "skip_for_now") continue;
    touches.push({ touch: { kind: "call", ...callRecordView(s, c) }, t: c.atWall });
  }
  touches.sort((a, b) => a.t - b.t);

  // Everyone else at the company, enrolled or not, with each campaign's status and their last call note.
  const company = await store.company(parties.company.id);
  const others = (company?.people ?? []).filter((p) => p.id !== parties.person?.id);
  const notes = await store.engine.lastCallNotes(others.flatMap((p) => p.enrollments.map((e) => e.id)));
  const colleagues: CallColleagueView[] = others.map((p) => {
    const last = notes.filter((n) => p.enrollments.some((e) => e.id === n.subjectId)).sort((a, b) => b.atWall - a.atWall)[0];
    return {
      id: p.id,
      name: p.name,
      title: p.title,
      statuses: p.enrollments.map((e) => ({ campaign: e.campaign, status: e.status })),
      lastCallNote: last ? { note: last.note, outcome: last.outcome, at: iso(last.atWall) } : null,
    };
  });

  return {
    task: item,
    taskId,
    enrollmentId: s.subject.id,
    open: task.open,
    listed,
    offList: offListOf(s, task, listed),
    status: deriveStatus(s),
    ...parties,
    track: { id: task.trackId, label: trackLabel(s, task.trackId) },
    zone: s.lead.zone,
    localTime: localTimeIn(s.lead.zone, now),
    numbers: numbers.map(numberView),
    callingHours: callWindow(s, task.trackId),
    callingHoursNow: callingHoursAt(callWindow(s, task.trackId), s.lead.zone, now, s.callDay.userZone),
    script: s.campaign.definition.callScript ?? "",
    touches: touches.map((x) => x.touch),
    personNotes: parties.person ? (await store.engine.notesOf("person", parties.person.id)).map(noteView) : [],
    companyNotes: (await store.engine.notesOf("company", parties.company.id)).map(noteView),
    colleagues,
    outcomes: listed ? CALL_OUTCOMES : [],
    storedRequestIds: s.callAttempts.filter((c) => c.taskId === taskId).map((c) => c.requestId),
    redialOutcomes: listed ? REDIAL_OUTCOMES : [],
    kind: task.kind,
    callbackAt: task.callbackAt === null ? null : iso(task.callbackAt),
    dueAt: iso(task.dueWall),
    listedFor: dateOfDay(listedForDay(s, task)),
  };
}
