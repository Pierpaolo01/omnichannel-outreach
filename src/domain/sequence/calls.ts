/**
 * Call tasks (ADR 0003 2.3, 2.4 "Calls", 4.4; ticket 14): which numbers the user may dial, when a
 * due call is placed on the user's list and within which daily capacity, whether a task is listed
 * now and in which part of the queue, and the outcomes the user logs. The application never dials:
 * the user calls on their own phone and logs what happened. Pure: the store runs each decision on
 * current state inside the transaction that writes it.
 */
import { leadNow, localDayNumber, nextWindowOpen, span, startOfLocalDay, wallOfLead, windowOpen, type WindowRule } from "./clock.ts";
import type { ReadyItem } from "./dispatch.ts";
import { advanceTrack, end, evaluate, finishTrack, markDetailBad, progressOf, runs } from "./progress.ts";
import type { CallAttempt, CallDay, CallNumber, CallOutcome, CallTask, NoteDraft, RecordedNumber, SubjectState } from "./state.ts";

export const CALL_OUTCOMES: readonly CallOutcome[] = ["no_answer", "voicemail", "gatekeeper", "wrong_number", "interested", "skip_for_now"];

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

/**
 * The listing rule (ADR 0003 2.3), as far as ticket 14 has holds: the task is open, the subject runs
 * (not ended, not lead-paused, its campaign launched and not paused), the prospect's calling hours
 * open at some point on the current user day, and the task is listed for today or an earlier day.
 * Every outcome is accepted exactly when its task is listed at that moment.
 */
export function isListed(state: SubjectState, task: CallTask): boolean {
  return task.open && runs(state) && task.kind === "call" && task.listDay <= state.callDay.day && hoursOpenOnUserDay(state, task.trackId);
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
  if (windowOpen(callWindow(state, task.trackId), state.lead.zone, now)) return { bucket: "ready_now", opensAt: null };
  const opens = opensToday(state, task.trackId, now);
  return opens === null ? null : { bucket: "later_today", opensAt: opens };
}

/** One ready-now call as the queue orders it. `skippedWall` is set only for a skip for now on the current user day. */
export interface QueueEntry {
  readonly taskId: string;
  readonly subjectId: string;
  readonly stepId: string;
  readonly dueWall: number;
  readonly skippedWall: number | null;
}

/**
 * Ready now's order (4.4): calls not skipped for now today, oldest due first, then by lead and step;
 * calls skipped for now today after them, in the order they were skipped.
 */
export function compareReadyNow(a: QueueEntry, b: QueueEntry): number {
  if ((a.skippedWall === null) !== (b.skippedWall === null)) return a.skippedWall === null ? -1 : 1;
  if (a.skippedWall !== null && b.skippedWall !== null && a.skippedWall !== b.skippedWall) return a.skippedWall - b.skippedWall;
  if (a.dueWall !== b.dueWall) return a.dueWall - b.dueWall;
  if (a.subjectId !== b.subjectId) return a.subjectId < b.subjectId ? -1 : 1;
  return a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0;
}

/**
 * The focused call (spec "The next task opens only after a call outcome is logged"): the call the user
 * is on, which they name, keeps the focus while it is listed, whatever opens or is placed meanwhile;
 * otherwise the first call ready now.
 */
export function focusOf(readyNow: readonly string[], named: { readonly taskId: string; readonly listed: boolean } | null): string | null {
  if (named?.listed) return named.taskId;
  return readyNow[0] ?? null;
}

/** Why a task is on the list: rolled over from an earlier day, or due today (overdue callbacks arrive with ticket 15). */
export function reasonOf(state: SubjectState, task: CallTask): "due" | "rolled_over" {
  return task.listDay < state.callDay.day ? "rolled_over" : "due";
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
 * room. The task keeps the step's original due time, and the skip deadline is resolved once from it (3.5).
 */
export function placeCall(state: SubjectState, item: ReadyItem, now: number, taskId: string): SubjectState | null {
  if (!readyCalls(state, now).some((r) => r.stepId === item.stepId) || !callRoom(state)) return null;
  const p = progressOf(state, item.trackId);
  if (!p || p.dueAt === null || p.dueWall === null) return null;
  const { userZone, day } = state.callDay;
  const task: CallTask = {
    id: taskId,
    subjectId: state.subject.id,
    trackId: item.trackId,
    stepId: item.stepId,
    dueAt: p.dueAt,
    dueWall: p.dueWall,
    dueZone: p.dueZone ?? state.lead.zone,
    skipDeadline: p.dueAt + span(p.dueWall, state.campaign.definition.callSkipLimitDays, userZone),
    listDay: day,
    placedWall: now,
    kind: "call",
    callbackAt: null,
    open: true,
    closedWall: null,
    skippedWall: null,
  };
  return { ...state, callTasks: [...state.callTasks, task], callDay: { ...state.callDay, placedToday: state.callDay.placedToday + 1 } };
}

export interface OutcomeInput {
  /** The client's key for this one action (verifier B3): the same key is answered with the first result and stores nothing again. */
  readonly requestId: string;
  readonly outcome: CallOutcome;
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
  if (!task.open) return { ok: false, reason: "This call is no longer on the list: its outcome was logged or its track has finished." };
  if (!listed(state, task)) {
    return { ok: false, reason: state.subject.ended !== null ? "This lead's outreach has ended in this campaign, so its call is not on today's list." : "This call is not on today's list." };
  }
  const number = input.numberId === null ? null : numberOf(state, input.numberId);
  if (input.outcome !== "skip_for_now") {
    if (!number) return { ok: false, reason: "Choose the number you dialled from the lead's numbers." };
    if (number.bad) return { ok: false, reason: "That number is marked bad: choose another of the lead's numbers." };
  }
  const at = leadNow(state.subject.clock, now);
  const atWall = wallOfLead(state.subject.clock, now);
  const note = input.note.trim();
  const attempt: CallAttempt = { id: ids.attempt, requestId: input.requestId, taskId, outcome: input.outcome, numberDetailId: number?.id ?? null, note, at, atWall: now };
  // The note belongs where the user put it; never inferred from the lead's numbers (review bot on a1399ce).
  const notes: NoteDraft[] = note === "" ? [] : [{ id: ids.note, owner: input.noteScope, callAttemptId: attempt.id, body: note, atWall: now }];
  let s: SubjectState = { ...state, callAttempts: [...state.callAttempts, attempt], newNotes: [...state.newNotes, ...notes] };

  if (input.outcome === "skip_for_now") {
    // Not a call made: the task goes to the end of today's queue, and nothing else changes.
    return { ok: true, state: { ...s, callTasks: s.callTasks.map((t) => (t.id === taskId ? { ...t, skippedWall: now } : t)) } };
  }

  s = { ...s, subject: { ...s.subject, touched: true } };
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
