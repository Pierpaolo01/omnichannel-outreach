/**
 * Read models for calls (ticket 14): Today's call counts and Up next, the focus queue, and one call
 * task with everything the call screen shows. Built from the engine's stored facts and the CRM, so
 * the screens render them without recomputing anything.
 */
import { bucketOf, CALL_OUTCOMES, callNumbers, callWindow, dayHasRoom, goodNumbers, isListed, listedForDay, queueRank, queueWall, recordedNumberOf, REDIAL_OUTCOMES, skipLimitOf, skippedTonight, unworkedSkipDay, type CallBucket } from "../../domain/sequence/calls.ts";
import { displayPhone } from "../../domain/phone.ts";
import { localDayNumber, nextWindowClose, nextWindowOpen, startOfLocalDay, windowOpen } from "../../domain/sequence/clock.ts";
import { declinedPathOf, liveTracks, winBackAvailable, type DeclinedPath } from "../../domain/sequence/definition.ts";
import { callbackHold, deriveStatus } from "../../domain/sequence/progress.ts";
import type { CallAttempt, CallNumber, CallTask, RecordedNumber, SubjectState } from "../../domain/sequence/state.ts";
import type { DeclinePreviewView, CallColleagueView, CallNumberView, CallOffListView, CallQueueItem, CallRecordView, RecordCallView, RecordCalls, RecordedNumberView, CallsView, CallTaskView, NoteView, SkipLimitView, TodayView, TouchView } from "../../shared/api.ts";
import type { OutreachStore } from "../persistence/store.ts";
import { DEFAULT_DAILY_CALL_CAPACITY } from "../persistence/sqlite-engine-store.ts";
import type { StoredNote } from "./engine-store.ts";
import { DEFAULT_RULES, type Rules } from "./rules.ts";
import { afterDeclineTracks } from "./track-states.ts";

/**
 * The decisions the call read models make, from the engine's rules: each lead's state as of the instant read
 * (the same catch-up a user action gets, council on 228cd3b), the queue order, the focus and the reasons.
 */
export type CallViewRules = Pick<Rules, "readyNowOrder" | "focusOf" | "callReason" | "asOfAction" | "evaluate" | "isListed" | "logCallOutcome">;

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
  declinedPath: c.declinedPath,
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
    noGoodNumber: goodNumbers(s).length === 0,
  };
}

const dateOrNull = (day: number | null): string | null => (day === null ? null : dateOfDay(day));

/** The skip limit on an open call (3.5, ticket 15b), read ahead by the engine's rule; null for a callback. */
function skipLimitView(s: SubjectState, task: CallTask, now: number): SkipLimitView | null {
  if (task.kind !== "call") return null;
  return {
    dueDate: dateOfDay(localDayNumber(task.dueWall, s.callDay.userZone)),
    limitDays: skipLimitOf(s.campaign.definition, task.trackId),
    ifUnworked: dateOrNull(unworkedSkipDay(s, task, now)),
  };
}

/** How many user days ahead the record looks for the first day a call is listed: past the callback Day select's four weeks. */
const RECORD_LOOKAHEAD_DAYS = 60;

/**
 * The first user day, from today, on which the engine's listing rule (2.3; the rule the Calls list and the
 * outcome route accept or refuse by) lists the task, as the lead's state stands now; null when it lists it on
 * none: the lead has ended (a reply, a stop: its tasks are kept for a restart, 2.3), is paused, or the task
 * is a call held by the lead's callback. The rule is applied to a copy whose user day is moved; nothing is written.
 */
export function firstListedDay(s: SubjectState, task: CallTask, rules: CallViewRules): number | null {
  const today = s.callDay.day;
  for (let d = today; d < today + RECORD_LOOKAHEAD_DAYS; d++) if (rules.isListed({ ...s, callDay: { ...s.callDay, day: d } }, task)) return d;
  return null;
}

/**
 * Each enrollment's open calls, as of `now`, for the person and company-lead record (ticket 15b): only a call
 * the user can act on today or on a later day, by the engine's listing rule (`firstListedDay`), and a call that
 * waits on the lead's callback while that callback is itself shown. A lead that replied, was stopped or ended
 * otherwise shows none, though its tasks are kept for a restart (review bot on eac9f6c).
 */
export async function recordCalls(store: OutreachStore, enrollmentIds: readonly string[], now: number, rules: CallViewRules = DEFAULT_RULES): Promise<RecordCalls> {
  const out: RecordCallView[] = [];
  const day = await store.engine.callDay(now);
  // Each enrollment's decline (ticket 16c), from the same snapshot as its calls (council on 4fd9ca4, item 6): the user's
  // date it was logged on, as the engine counts the day, and its path.
  const declines: RecordCalls["declines"][number][] = [];
  for (const id of enrollmentIds) {
    const s = await asOfNow(store, id, now, rules);
    if (!s) continue;
    const declined = s.callAttempts.find((c) => c.outcome === "not_interested" && c.declinedPath !== null);
    if (declined?.declinedPath) declines.push({ enrollmentId: id, date: dateOfDay(localDayNumber(declined.atWall, day.userZone)), path: declined.declinedPath });
    const shown = s.callTasks.flatMap((task) => {
      const first = task.open ? firstListedDay(s, task, rules) : null;
      return first === null ? [] : [{ task, first }];
    });
    const callbackShown = shown.some((x) => x.task.kind === "callback");
    const held = callbackShown ? s.callTasks.filter((t) => t.open && t.kind === "call" && callbackHold(s)).map((task) => ({ task, first: null })) : [];
    for (const { task, first } of [...shown, ...held]) {
      const listed = first === s.callDay.day;
      out.push({
        enrollmentId: id,
        taskId: task.id,
        track: { id: task.trackId, label: trackLabel(s, task.trackId) },
        kind: task.kind,
        listed,
        reason: listed ? rules.callReason(s, task, now) : null,
        listedFor: dateOfDay(first ?? listedForDay(s, task)),
        callbackAt: task.callbackAt === null ? null : iso(task.callbackAt),
        zone: s.lead.zone,
        skipLimit: skipLimitView(s, task, now),
        noGoodNumber: goodNumbers(s).length === 0,
        heldByCallback: first === null,
      });
    }
  }
  return { calls: out, today: dateIn(day.userZone, now), declines };
}

/**
 * What a redial logged now would do (ticket 15b; review bot on eac9f6c): the engine's own outcome function,
 * applied to a copy of the lead's state with no answer and a redial on the first good number, as the outcome
 * route applies it (a callback's hold released first, 2.4), storing nothing. Null when it would be refused, or
 * no number can be logged on (Q13).
 */
function redialPreview(s: SubjectState, task: CallTask, now: number, rules: CallViewRules): CallTaskView["redial"] {
  const number = goodNumbers(s)[0];
  if (!number) return null;
  const out = rules.logCallOutcome(s, task.id, { requestId: `preview:${task.id}`, outcome: "no_answer", redial: true, numberId: number.id, note: "", noteScope: "person" }, now, { attempt: "preview", note: "preview" }, rules.isListed);
  if (!out.ok) return null;
  const after = out.state.callTasks.find((t) => t.id === task.id);
  if (!after) return null;
  const first = after.open ? firstListedDay(out.state, after, rules) : null;
  if (first === null) return null;
  return { listedFor: dateOfDay(first), skipLimit: skipLimitView(out.state, after, now) };
}

/** The paths the user may choose for a lead of this campaign: win back only while it has a win-back branch. */
const declinedPathsOf = (s: SubjectState): DeclinedPath[] => (winBackAvailable(s.campaign.definition) ? ["stop", "continue", "win_back"] : ["stop", "continue"]);

/** Live attempts already handed to a provider and asked to withdraw. */
const withProvider = (s: SubjectState): Set<string> => new Set(s.attempts.filter((a) => (a.state === "handed" || a.state === "accepted") && a.withdrawRequested).map((a) => a.id));

/**
 * What not interested logged now would do on each path offered (ticket 16c), as the redial preview is built: the engine's
 * own outcome (`logCallOutcome`, a callback's hold released first, as the route does) on a copy of the lead's state as of
 * the read, on the first good number, then the lead as a read right after would see it; nothing is stored. Each reports
 * the lead's status, every track the decline leaves unfinished or finishes in its state then, and the work already with
 * a provider that the decline asks to withdraw. Null when no number can be logged on, or the engine would refuse it.
 */
function declinePreviews(s: SubjectState, task: CallTask, now: number, rules: CallViewRules): CallTaskView["declines"] {
  const number = goodNumbers(s)[0];
  if (!number) return null;
  const before = withProvider(s);
  const out: DeclinePreviewView[] = [];
  for (const path of declinedPathsOf(s)) {
    const logged = rules.logCallOutcome(s, task.id, { requestId: `preview:${task.id}:${path}`, outcome: "not_interested", declinedPath: path, numberId: number.id, note: "", noteScope: "person" }, now, { attempt: "preview", note: "preview" }, rules.isListed);
    if (!logged.ok) return null;
    const after = rules.asOfAction(logged.state, now, rules.evaluate);
    out.push({
      path,
      status: deriveStatus(after),
      tracks: afterDeclineTracks(after, task.trackId, now, path, now),
      noMoreCalls: after.subject.noMoreCalls,
      withProvider: [...withProvider(after)].filter((id) => !before.has(id)).length,
    });
  }
  return out;
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
    carriedOverLastDay: listed.filter((x) => (x.reason === "rolled_over" || x.reason === "redial") && x.skippedTonight).length,
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
    storedCalls: s.callAttempts.filter((c) => c.taskId === taskId).map((c) => ({ requestId: c.requestId, ...callRecordView(s, c) })),
    asOf: iso(now),
    skipLimit: task.open ? skipLimitView(s, task, now) : null,
    redial: listed && task.open ? redialPreview(s, task, now, rules) : null,
    listedFrom: task.open ? dateOrNull(firstListedDay(s, task, rules)) : null,
    declinedPath: declinedPathOf(s.campaign.definition.tracks.find((t) => t.id === task.trackId)),
    declinedPaths: declinedPathsOf(s),
    declinedPathSet: s.campaign.definition.tracks.find((t) => t.id === task.trackId)?.declinedPath !== undefined,
    declines: listed && task.open ? declinePreviews(s, task, now, rules) : null,
  };
}
