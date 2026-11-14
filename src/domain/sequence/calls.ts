/**
 * Call tasks (ADR 0003 2.3, 2.4 "Calls", 4.4; ticket 14): which numbers the user may dial, when a
 * due call is placed on the user's list and within which daily capacity, whether a task is listed
 * now and in which part of the queue, and the outcomes the user logs. The application never dials:
 * the user calls on their own phone and logs what happened. Pure: the store runs each decision on
 * current state inside the transaction that writes it.
 */
import { leadNow, localDayNumber, nextWindowOpen, span, startOfLocalDay, wallOfLead, windowOpen, type WindowRule } from "./clock.ts";
import type { CampaignDefinition } from "./definition.ts";
import type { ReadyItem } from "./dispatch.ts";
import { advanceTrack, callbackHold, end, evaluate, finishTrack, markDetailBad, progressOf, quiesce, runs, synced } from "./progress.ts";
import type { CallAttempt, CallDay, CallNumber, CallOutcome, CallTask, NoteDraft, RecordedNumber, SubjectState } from "./state.ts";

export const CALL_OUTCOMES: readonly CallOutcome[] = ["no_answer", "voicemail", "gatekeeper", "wrong_number", "interested", "callback_requested", "skip_for_now"];

/** The user-local day a task is listed for: a callback's own day, else its list day (a redial moves it on). */
export const listedForDay = (state: SubjectState, task: CallTask): number => (task.kind === "callback" ? callbackDay(state, task) : task.listDay);

const KIND_ORDER = { direct: 0, mobile: 1, main_line: 2 } as const;

/** Every number of the lead, labelled by kind, direct first, then mobile, then the company main line; newest first within a kind. */
export function callNumbers(state: SubjectState): CallNumber[] {
  return [...state.lead.phones].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.order - a.order);
}

/**
 * The lead's dialable number a submitted detail id stands for, following merges (ADR 0001 "Merged
 * contact details", ticket 12a): a screen read before a re-import folded the detail into another names
 * the same number. Null when the id names none of the numbers the lead may be called on now. For a
 * new outcome only: a past call's number is `recordedNumberOf`'s.
 */
export function numberOf(state: SubjectState, detailId: string): CallNumber | null {
  const live = state.lead.resolved[detailId]?.liveId ?? detailId;
  return state.lead.phones.find((n) => n.id === live) ?? null;
}

/**
 * The number a past call was logged on, as the detail it stands for now through every merge, whoever's
 * detail that has become (verifier re-check on 7902093): history records what was dialled, not what may
 * be dialled now. Null only for a call with no number (skip for now).
 */
export function recordedNumberOf(state: SubjectState, detailId: string | null): RecordedNumber | null {
  return detailId === null ? null : (state.recordedNumbers[detailId] ?? null);
}

/** The numbers the user may dial now: not marked bad. */
export function goodNumbers(state: SubjectState): CallNumber[] {
  return callNumbers(state).filter((n) => !n.bad);
}

export function callWindow(state: SubjectState, trackId: string): readonly WindowRule[] {
  return state.campaign.definition.tracks.find((t) => t.id === trackId)?.window ?? [];
}

/** The current user day, as wall instants: [start, end). */
export function userDay(state: SubjectState): { start: number; end: number } {
  const { day, userZone } = state.callDay;
  return { start: startOfLocalDay(day, userZone), end: startOfLocalDay(day + 1, userZone) };
}

/** When the prospect's calling hours next open at or after `now`, if that is before the user day ends. */
function opensToday(state: SubjectState, trackId: string, now: number): number | null {
  const opens = nextWindowOpen(callWindow(state, trackId), state.lead.zone, now);
  return opens !== null && opens < userDay(state).end ? opens : null;
}

/** Whether the prospect's calling hours open at some point on the current user day (2.3). */
function hoursOpenOnUserDay(state: SubjectState, trackId: string): boolean {
  const { start, end } = userDay(state);
  return callableOnDay(callWindow(state, trackId), state.lead.zone, start, end);
}

/**
 * Whether calling hours open at some point of a user day [start, end): the day a call can be listed
 * on (2.3), and so the only day a carried call counts against capacity (4.4).
 */
export function callableOnDay(window: readonly WindowRule[], zone: string, start: number, end: number): boolean {
  const opens = nextWindowOpen(window, zone, start);
  return opens !== null && opens < end;
}

/** The user-local day a callback is for: it is listed from that day on (2.3). */
export function callbackDay(state: SubjectState, task: CallTask): number {
  return task.callbackAt === null ? Number.POSITIVE_INFINITY : localDayNumber(task.callbackAt, state.callDay.userZone);
}

/**
 * The listing rule (ADR 0003 2.3). An open task is listed while the subject has not ended, is not
 * lead-paused, and its campaign is launched and not paused; and, by kind:
 * - a call: the lead has no callback hold, the task is listed for today or an earlier day (a redial
 *   moved to tomorrow is not listed today), and the prospect's calling hours open at some point today;
 * - a callback: from the user-local day of the time the prospect asked for, at any hour, every day
 *   until its outcome is logged (an overdue callback stays listed; the prospect chose the time).
 * Every outcome is accepted exactly when its task is listed at that moment.
 */
export function isListed(state: SubjectState, task: CallTask): boolean {
  const { subject, campaign } = state;
  if (!task.open || campaign.launchedAt === null || campaign.pausedSince !== null || subject.ended !== null || subject.leadPaused) return false;
  if (task.kind === "callback") return callbackDay(state, task) <= state.callDay.day;
  return !callbackHold(state) && task.listDay <= state.callDay.day && hoursOpenOnUserDay(state, task.trackId);
}

export type CallBucket = "ready_now" | "later_today";

/**
 * Where a listed task sits in the queue now (4.4): ready now inside the prospect's calling hours;
 * later today when they open later on the user's day. A listed task whose hours have closed for the
 * day is in neither: it waits for its next calling hours (spec "Tasks outside calling hours wait
 * until those hours start"), and an outcome logged on it is still accepted.
 */
export function bucketOf(state: SubjectState, task: CallTask, now: number): { bucket: CallBucket; opensAt: number | null } | null {
  if (!isListed(state, task)) return null;
  // A callback is later today until the time the prospect asked for, and ready from then, whatever the calling hours.
  if (task.kind === "callback") return task.callbackAt !== null && now < task.callbackAt ? { bucket: "later_today", opensAt: task.callbackAt } : { bucket: "ready_now", opensAt: null };
  if (windowOpen(callWindow(state, task.trackId), state.lead.zone, now)) return { bucket: "ready_now", opensAt: null };
  const opens = opensToday(state, task.trackId, now);
  return opens === null ? null : { bucket: "later_today", opensAt: opens };
}

/**
 * One ready-now call as the queue orders it. `rank` is its class (`queueRank`); `dueWall` is the instant
 * it is ordered by within the class: the time asked for on a callback, the original due time otherwise.
 * `skippedWall` is set only for a skip for now on the current user day.
 */
export interface QueueEntry {
  readonly taskId: string;
  readonly subjectId: string;
  readonly stepId: string;
  readonly rank: 0 | 1 | 2;
  readonly dueWall: number;
  readonly skippedWall: number | null;
}

/**
 * Ready now's order (4.4 as amended by ticket 15): calls not skipped for now today first, by class:
 * callbacks, then calls carried from an earlier day (rolled over or redialed, spec "roll over to the top
 * of the next day's list"), then today's; within a class oldest first, then by lead and step. Calls
 * skipped for now today come after them, in the order they were skipped.
 */
export function compareReadyNow(a: QueueEntry, b: QueueEntry): number {
  if ((a.skippedWall === null) !== (b.skippedWall === null)) return a.skippedWall === null ? -1 : 1;
  if (a.skippedWall !== null && b.skippedWall !== null && a.skippedWall !== b.skippedWall) return a.skippedWall - b.skippedWall;
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.dueWall !== b.dueWall) return a.dueWall - b.dueWall;
  if (a.subjectId !== b.subjectId) return a.subjectId < b.subjectId ? -1 : 1;
  return a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0;
}

/** A listed task's class in the queue: 0 a callback, 1 a call carried from an earlier day, 2 a call due today. */
export function queueRank(state: SubjectState, task: CallTask, now: number): 0 | 1 | 2 {
  const reason = reasonOf(state, task, now);
  return reason === "callback" || reason === "overdue" ? 0 : reason === "due" ? 2 : 1;
}

/** The instant a listed task is ordered by within its class: the time asked for on a callback, else its original due time. */
export const queueWall = (task: CallTask): number => (task.kind === "callback" && task.callbackAt !== null ? task.callbackAt : task.dueWall);

/**
 * The focused call (spec "The next task opens only after a call outcome is logged"): the call the user
 * is on, which they name, keeps the focus while it is listed, whatever opens or is placed meanwhile;
 * otherwise the first call ready now.
 */
export function focusOf(readyNow: readonly string[], named: { readonly taskId: string; readonly listed: boolean } | null): string | null {
  if (named?.listed) return named.taskId;
  return readyNow[0] ?? null;
}

/**
 * Whether a listed call, left unworked, is skipped at the end of today (3.5): the lead runs, and lead time
 * at the end of the user's day reaches the call's skip deadline. The same condition `expireUnworked`
 * applies at the rollover, read ahead for the screen.
 */
export function skippedTonight(state: SubjectState, task: CallTask, now: number): boolean {
  if (task.kind !== "call" || !isListed(state, task) || !runs(state)) return false;
  return leadNow(state.subject.clock, now) + (userDay(state).end - now) >= task.skipDeadline;
}

/**
 * Read ahead for the screens (ticket 15b; read-only): the user day at whose end a call left unworked is
 * skipped by the skip limit (3.5), counting from `fromDay` (its list day, or the day after today for a
 * redial asked for now), if the lead keeps running and nothing else changes. Each day is judged by the
 * condition `expireUnworked` applies at its rollover, as `skippedTonight` reads it for today: the
 * prospect's calling hours open on that day, and lead time at its end reaches the skip deadline. Null for
 * a callback, which is never skipped, and while a hold freezes the lead's clock, when no day can be named.
 */
export function unworkedSkipDay(state: SubjectState, task: CallTask, now: number, fromDay: number = task.listDay): number | null {
  if (task.kind !== "call" || !task.open || !runs(state)) return null;
  const { userZone, day } = state.callDay;
  const window = callWindow(state, task.trackId);
  const lead = leadNow(state.subject.clock, now);
  const first = Math.max(fromDay, day);
  // A year of days with no calling hours means none opens: nothing can be named.
  for (let d = first; d < first + 366; d++) {
    const end = startOfLocalDay(d + 1, userZone);
    if (!callableOnDay(window, state.lead.zone, startOfLocalDay(d, userZone), end)) continue;
    if (lead + (end - now) >= task.skipDeadline) return d;
  }
  return null;
}

/** Whether the task's calling hours opened on some user day in [from, to). */
function listedBetween(state: SubjectState, task: CallTask, from: number, to: number): boolean {
  const { userZone } = state.callDay;
  const window = callWindow(state, task.trackId);
  for (let d = Math.max(from, to - 60); d < to; d++) if (callableOnDay(window, state.lead.zone, startOfLocalDay(d, userZone), startOfLocalDay(d + 1, userZone))) return true;
  return false;
}

export type CallReason = "due" | "rolled_over" | "redial" | "callback" | "overdue";

/**
 * Why a task is on the list (spec "Up next ... why it's on the list"; ticket 15): a callback before the
 * time the prospect asked for, and overdue once that time has passed with no outcome logged (question
 * Q12); a call listed for an earlier day than today, rolled over; a call a redial moved onto today; due
 * today otherwise.
 */
export function reasonOf(state: SubjectState, task: CallTask, now: number): CallReason {
  if (task.kind === "callback") return task.callbackAt !== null && now < task.callbackAt ? "callback" : "overdue";
  const today = state.callDay.day;
  const redialed = state.callAttempts.some((a) => a.taskId === task.id && a.redial && userDayOf(a.atWall, state.callDay.userZone) + 1 === task.listDay);
  // A redial stays a redial until its first listed day has passed: one logged on a Friday for Saturday,
  // with weekday calling hours, is still a redial on Monday (council on 228cd3b).
  if (task.listDay < today && (!redialed || listedBetween(state, task, task.listDay, today))) return "rolled_over";
  return redialed ? "redial" : "due";
}

/**
 * Due call steps waiting to be placed on the user's list (2.6 step 4): the lead runs, the step is its
 * track's pending step and due, it has no task yet, and the prospect's calling hours are open now or
 * open later on the user's day, so a placed task is callable on the day whose capacity it takes.
 */
export function readyCalls(state: SubjectState, now: number): ReadyItem[] {
  if (!runs(state)) return [];
  const lead = leadNow(state.subject.clock, now);
  return state.tracks.flatMap((p): ReadyItem[] => {
    const track = state.campaign.definition.tracks.find((t) => t.id === p.trackId);
    if (track?.channel !== "call" || p.startedAt === null || p.finishedAt !== null || p.nextStepId === null || p.dueAt === null || p.dueWall === null) return [];
    const stepId = p.nextStepId;
    if (p.dueAt > lead || state.callTasks.some((t) => t.stepId === stepId)) return [];
    if (opensToday(state, p.trackId, now) === null) return [];
    return [{ subjectId: state.subject.id, trackId: p.trackId, stepId, touched: state.subject.touched, dueWall: p.dueWall }];
  });
}

/** Whether the user's list has room for one more new task today (4.4): new tasks placed today stay below capacity minus committed tasks. */
export function callRoom(state: SubjectState): boolean {
  return dayHasRoom(state.callDay);
}

/** The day's rule behind `callRoom`, for the read models that say when today's capacity is used (ticket 14b). */
export function dayHasRoom(day: Pick<CallDay, "capacity" | "placedToday" | "committed">): boolean {
  return day.placedToday < day.capacity - day.committed;
}

/**
 * Places a ready call on today's list (4.4), or returns null when it is not ready or the list has no
 * room. The task keeps the step's original due time, and the skip deadline is resolved once from it (3.5),
 * with the phone track's own skip limit (ticket 14c).
 */
export function placeCall(state: SubjectState, item: ReadyItem, now: number, taskId: string): SubjectState | null {
  if (!readyCalls(state, now).some((r) => r.stepId === item.stepId) || !callRoom(state)) return null;
  const p = progressOf(state, item.trackId);
  if (!p || p.dueAt === null || p.dueWall === null) return null;
  const { userZone, day } = state.callDay;
  const track = state.campaign.definition.tracks.find((t) => t.id === item.trackId);
  if (!track) return null;
  const task: CallTask = {
    id: taskId,
    subjectId: state.subject.id,
    trackId: item.trackId,
    stepId: item.stepId,
    dueAt: p.dueAt,
    dueWall: p.dueWall,
    dueZone: p.dueZone ?? state.lead.zone,
    skipDeadline: skipDeadlineOf({ dueAt: p.dueAt, dueWall: p.dueWall }, skipLimitOf(state.campaign.definition, item.trackId), userZone),
    listDay: day,
    placedWall: now,
    kind: "call",
    callbackAt: null,
    open: true,
    closedWall: null,
    skippedWall: null,
    reckonedThrough: now,
  };
  return { ...state, callTasks: [...state.callTasks, task], callDay: { ...state.callDay, placedToday: state.callDay.placedToday + 1 } };
}

/**
 * The skip limit in force for a phone track, in days (ADR 0003 3.5): the track's own when it has one (set on
 * each phone track since ticket 14c), else the campaign's. It is read here, and only here: the engine, the
 * store's re-resolution of an edited limit and the editor's inspector all call this.
 */
export function skipLimitOf(definition: Pick<CampaignDefinition, "tracks" | "callSkipLimitDays">, trackId: string): number {
  return definition.tracks.find((t) => t.id === trackId)?.callSkipLimitDays ?? definition.callSkipLimitDays;
}

/**
 * A call task's skip deadline, in lead time (3.5): the start of the user's day `limit` days after the call's
 * original due date, from its stored `dueAt` and `dueWall`. Resolved when the task is placed, and again only
 * when the limit is edited (5.2); the store refuses any other change to it, so a redial can never reset it.
 */
export function skipDeadlineOf(task: Pick<CallTask, "dueAt" | "dueWall">, limitDays: number, userZone: string): number {
  return task.dueAt + span(task.dueWall, limitDays, userZone);
}

export interface OutcomeInput {
  /** The client's key for this one action (verifier B3): the same key is answered with the first result and stores nothing again. */
  readonly requestId: string;
  readonly outcome: CallOutcome;
  /** A redial (ticket 15): only with no answer, voicemail or gatekeeper. The task moves to the user's next day. */
  readonly redial?: boolean;
  /** A callback requested (ticket 15): the wall instant the prospect asked to be called back, still to come. */
  readonly callbackAt?: number | null;
  /** The number the user dialled; required for every outcome but skip for now. */
  readonly numberId: string | null;
  readonly note: string;
  /**
   * A person note, or a company note shown for everyone at the company: the user's choice, "person"
   * when they make none (the HTTP default). A company lead has no person, so the store keeps its notes
   * on its company.
   */
  readonly noteScope: "person" | "company";
}

export type OutcomeResult = { readonly ok: true; readonly state: SubjectState; readonly replayed?: boolean } | { readonly ok: false; readonly reason: string };

export const REQUEST_ID_REUSED = "This request id was already used for another call: send a new one.";

/** The outcomes after which the user may ask for a redial (spec "Call outcomes and their effect on the lead"). */
export const REDIAL_OUTCOMES: readonly CallOutcome[] = ["no_answer", "voicemail", "gatekeeper"];

/**
 * Logs one outcome on a call task (ADR 0003 2.4 "Calls"), accepted only while the task is listed.
 * No answer, voicemail and gatekeeper close the task and complete the track, so the tracks after it
 * start after their delay. A wrong number also marks that number bad. Interested completes this track,
 * closes every other open call task of the lead, and ends the lead in this campaign only. Skip for now
 * moves the task to the end of today's queue and changes nothing else. Every outcome but skip for now
 * is a call made, so it touches the lead. Activity on the company main line is the intended lead's.
 */
export function logCallOutcome(
  state: SubjectState,
  taskId: string,
  input: OutcomeInput,
  now: number,
  ids: { attempt: string; note: string },
  listed: (state: SubjectState, task: CallTask) => boolean = isListed,
): OutcomeResult {
  // A key already logged is the same action again: it is answered with the first result, before any
  // other check, so a retry of an outcome that closed its task is not refused as a stale screen.
  const earlier = state.callAttempts.find((a) => a.requestId === input.requestId);
  if (earlier) return earlier.taskId === taskId ? { ok: true, state, replayed: true } : { ok: false, reason: REQUEST_ID_REUSED };
  const task = state.callTasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, reason: "There is no such call task." };
  if (!task.open) {
    // Said plainly when the skip limit closed it: an action is judged as of its own instant, so a call that
    // expired at a rollover before the action arrived is refused even if the screen still showed it.
    const finish = progressOf(state, task.trackId);
    if (finish?.finishReason === "skipped_unworked" && task.closedWall !== null) return { ok: false, reason: `This call was skipped at ${new Date(task.closedWall).toISOString()}: it was not worked within its skip limit, so it is no longer on the list.` };
    return { ok: false, reason: "This call is no longer on the list: its outcome was logged or its track has finished." };
  }
  if (!listed(state, task)) {
    return { ok: false, reason: state.subject.ended !== null ? "This lead's outreach has ended in this campaign, so its call is not on today's list." : "This call is not on today's list." };
  }
  const redial = input.redial === true;
  if (redial && !REDIAL_OUTCOMES.includes(input.outcome)) return { ok: false, reason: "A redial follows no answer, voicemail left, or gatekeeper or not reached." };
  const callbackAt = input.callbackAt ?? null;
  if (input.outcome === "callback_requested" && callbackAt === null) return { ok: false, reason: "Give the date and time the prospect asked to be called back." };
  if (input.outcome !== "callback_requested" && callbackAt !== null) return { ok: false, reason: "A date and time goes with a callback requested only." };
  if (callbackAt !== null && callbackAt <= now) return { ok: false, reason: "A callback is for a date and time still to come." };
  const number = input.numberId === null ? null : numberOf(state, input.numberId);
  if (input.outcome !== "skip_for_now") {
    if (!number) return { ok: false, reason: "Choose the number you dialled from the lead's numbers." };
    if (number.bad) return { ok: false, reason: "That number is marked bad: choose another of the lead's numbers." };
  }
  const note = input.note.trim();
  let s: SubjectState = state;
  // An outcome that ends the callback hold (anything but skip for now or a new callback time) releases it
  // first, in the same change: the clock thaws, so the call is logged at this instant on a running clock.
  if (task.kind === "callback" && input.outcome !== "skip_for_now" && input.outcome !== "callback_requested") {
    s = synced({ ...s, callTasks: s.callTasks.map((t) => (t.id === taskId ? { ...t, kind: "call", callbackAt: null } : t)) }, now);
  }
  const at = leadNow(s.subject.clock, now);
  const atWall = wallOfLead(s.subject.clock, now);
  const attempt: CallAttempt = { id: ids.attempt, requestId: input.requestId, taskId, outcome: input.outcome, redial, callbackAt, numberDetailId: number?.id ?? null, note, at, atWall: now };
  // The note belongs where the user put it; never inferred from the lead's numbers (review bot on a1399ce).
  const notes: NoteDraft[] = note === "" ? [] : [{ id: ids.note, owner: input.noteScope, callAttemptId: attempt.id, body: note, atWall: now }];
  s = { ...s, callAttempts: [...s.callAttempts, attempt], newNotes: [...s.newNotes, ...notes] };

  if (input.outcome === "skip_for_now") {
    // Not a call made: the task goes to the end of today's queue, and nothing else changes; a callback keeps its hold.
    return { ok: true, state: { ...s, callTasks: s.callTasks.map((t) => (t.id === taskId ? { ...t, skippedWall: now } : t)) } };
  }

  s = { ...s, subject: { ...s.subject, touched: true } };
  if (input.outcome === "callback_requested") {
    // The callback hold: the call step stays open at the time the prospect asked for, and the lead's
    // automated outreach in this campaign pauses until its outcome is logged (its clock freezes).
    const held = { ...s, callTasks: s.callTasks.map((t) => (t.id === taskId ? { ...t, kind: "callback" as const, callbackAt, skippedWall: null } : t)) };
    return { ok: true, state: synced(quiesce(held), now) };
  }
  if (redial) {
    // The call step stays open: the task moves onto the user's next day, keeping its original due time
    // and skip deadline (spec "the unfinished-task limit still counts from the original due date").
    const tomorrow = userDayOf(now, s.callDay.userZone) + 1;
    const moved = { ...s, callTasks: s.callTasks.map((t) => (t.id === taskId ? { ...t, listDay: tomorrow, skippedWall: null } : t)) };
    return { ok: true, state: runs(moved) ? evaluate(moved, now) : moved };
  }
  if (input.outcome === "wrong_number" && number) s = markDetailBad(s, number.id);
  // The call step is done: its result records the outcome, and the track finishes (a phone track is one call).
  s = { ...s, results: [...s.results, { stepId: task.stepId, trackId: task.trackId, result: "sent", reason: input.outcome, at, atWall, attemptId: null }] };
  const track = s.campaign.definition.tracks.find((t) => t.id === task.trackId);
  if (track) s = advanceTrack(s, track, at, atWall);
  if (input.outcome === "interested") {
    for (const other of s.callTasks) if (other.open) s = finishTrack(s, other.trackId, "closed_on_interest", at, atWall);
    return { ok: true, state: end(s, "interested_on_call", now) };
  }
  return { ok: true, state: runs(s) ? evaluate(s, now) : s };
}

/** The user-local day number of instant `t` in the user's zone. */
export const userDayOf = (t: number, userZone: string) => localDayNumber(t, userZone);
