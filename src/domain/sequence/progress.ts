/**
 * One lead in one campaign (ADR 0003 section 2): the status as a total function of the stored
 * state, the endings, evaluation, and the facts that change progress. Every function is pure:
 * it takes a `SubjectState` and the time, and returns the next `SubjectState`.
 */
import type { OutreachStatus } from "../outreach-status.ts";
import { applyAttemptEvent, applyLookup, ENGINE_PARAMS, isLive, isUncertain, markable, maySend, withRef, type AttemptEffect, type AttemptEvent, type WorkEvent } from "./attempt.ts";
import { leadNow, localDayNumber, nextWindowOpen, sendPoint, span, startOfLocalDay, syncClock, waitSpan, wallOfLead, windowOpensAt, type Freeze, type LeadClock } from "./clock.ts";
import { render } from "./copy.ts";
import { holdsConversations, type ConversationChannel, linkedinStepKind, liveSteps, ownSubject, poolOf, trackPool, type DeclinedPath, type TrackChannel, type TrackDefinition } from "./definition.ts";
import { isMessageRequestChannel, type MessageRequestChannel, type SocialChannel } from "../social-channels.ts";
import type { StoredReplyId } from "./reply-identity.ts";
import type { Attempt, ConnectionCheck, ConversationCause, EndReason, FinishReason, LeadDetail, LinkedinSkipCause, SocialSkipCause, ProviderWork, RenderedCopy, ReplyChannelName, SmsBinding, SmsBindingRecord, StepResult, SubjectState, TrackProgress } from "./state.ts";

// ---------------------------------------------------------------------------------------------
// Running, status and reach.

/**
 * The callback hold (ADR 0003 2.3, ticket 15): an open callback task. It *is* the hold, so "held by a
 * callback" and "has an open callback task" cannot disagree.
 */
export function callbackHold(state: SubjectState): boolean {
  return state.callTasks.some((t) => t.open && t.kind === "callback");
}

/**
 * `runs(s)` (2.2): launched, its campaign not paused, not ended, and held by none of the three holds
 * (2.3): the lead pause, the callback hold (ticket 15), and the campaign pause. Every change to any of
 * these ends with `synced`, which freezes or thaws the lead's clock. Campaign and lead pauses arrive
 * with ticket 17 on this same function.
 */
export function runs(state: SubjectState): boolean {
  const { subject } = state;
  return campaignLets(state) && subject.ended === null && !subject.leadPaused && !callbackHold(state);
}

/**
 * Whether the campaign lets the subject run: launched and not paused. A test run reads neither the launch nor the
 * campaign pause (ADR 0003 3.6, "Ticket 21"): it runs "at any time". `runs` and the listing rule both read this.
 */
export function campaignLets(state: SubjectState): boolean {
  const { subject, campaign } = state;
  return subject.kind === "test_run" || (campaign.launchedAt !== null && campaign.pausedSince === null);
}

/** The status (2.1): rules in order, first match wins. */
export function deriveStatus(state: SubjectState): OutreachStatus {
  const { subject } = state;
  if (subject.ended !== null) return subject.ended;
  if (subject.leadPaused) return "paused";
  // Rule 3: the callback hold (ticket 15).
  if (callbackHold(state)) return "callback_scheduled";
  if (subject.branch === "win_back") return "in_win_back";
  // Rule 5: an open call task, whatever today's listing (ticket 14).
  if (state.callTasks.some((t) => t.open)) return "waiting_on_call";
  if (!subject.touched) return "queued";
  return "active";
}

/** The wall instant at which the lead's clock stood at lead time `at` while running. */
export function wallAtLead(clock: LeadClock, freezes: readonly Freeze[], at: number, now: number): number {
  let cursor = wallOfLead(clock, now);
  let remaining = leadNow(clock, now) - at;
  const closed = freezes.filter((f) => f.toWall !== null && f.toWall <= cursor).sort((x, y) => y.fromWall - x.fromWall);
  for (const f of closed) {
    const to = f.toWall ?? cursor;
    if (remaining <= cursor - to) return cursor - remaining;
    remaining -= cursor - to;
    cursor = f.fromWall;
  }
  return cursor - remaining;
}

/** The track's live definition for this lead: not removed, or already started by the lead (5.1). */
export function liveTracksFor(state: SubjectState): TrackDefinition[] {
  return state.campaign.definition.tracks.filter((t) => t.branch === state.subject.branch && (!t.removed || progressOf(state, t.id)?.startedAt != null));
}

export const progressOf = (state: SubjectState, trackId: string): TrackProgress | undefined => state.tracks.find((t) => t.trackId === trackId);

/** The newest good email the lead may be sent to, or null. */
export function goodEmail(details: readonly LeadDetail[]): LeadDetail | null {
  return [...details].filter((d) => d.channel === "email" && d.ownEmail && !d.bad).sort((a, b) => b.order - a.order)[0] ?? null;
}

/** The newest good mobile the lead may be texted at, or null: a decision maker's own (ADR 0001). */
export function goodMobile(details: readonly LeadDetail[]): LeadDetail | null {
  return [...details].filter((d) => d.channel === "phone" && d.mobile && !d.bad).sort((a, b) => b.order - a.order)[0] ?? null;
}

/** The lead's LinkedIn profile from the import, when it is a member profile not marked bad (ADR 0004 section 5). */
export function goodProfile(details: readonly LeadDetail[]): LeadDetail | null {
  return [...details].filter((d) => d.channel === "linkedin" && !d.bad).sort((a, b) => b.order - a.order)[0] ?? null;
}

/**
 * A message-request channel's destination (ADR 0004 13.4): the decision maker's own usable account, else the company's. The
 * store gives the own account the newer order, so the newest one not marked bad is that rule.
 */
export function goodAccount(details: readonly LeadDetail[], channel: MessageRequestChannel): LeadDetail | null {
  return [...details].filter((d) => d.channel === channel && !d.bad).sort((a, b) => b.order - a.order)[0] ?? null;
}

/** The detail a track on `channel` starts with: the newest good one the lead may be sent to on it. */
export function destinationFor(details: readonly LeadDetail[], channel: TrackChannel): LeadDetail | null {
  switch (channel) {
    case "email":
      return goodEmail(details);
    case "sms":
      return goodMobile(details);
    case "linkedin":
      return goodProfile(details);
    case "call":
      return null;
    default:
      return goodAccount(details, channel);
  }
}

/** Whether the user has a good number to dial for the lead: its own, or the company main line (ADR 0001 "Usable channels"). */
export function hasGoodNumber(state: SubjectState): boolean {
  return state.lead.phones.some((p) => !p.bad);
}

/**
 * Whether a track on `channel` can reach the lead now. A phone track cannot once the lead declined: it is never
 * called again in this campaign (council on f5fdeee, item 1), so a lead with nothing else left ends with no usable
 * channel at the decline. `startTrack` still skips a phone track after a decline as `skipped_declined`.
 */
export function channelReaches(state: SubjectState, channel: TrackChannel): boolean {
  if (channel === "call") return hasGoodNumber(state) && !state.subject.noMoreCalls;
  return destinationFor(state.lead.details, channel) !== null && !(holdsConversations(channel) && conversationLost(state, channel));
}

/** The SMS reading of `conversationLost`, kept under its name for its callers. */
export const smsConversationLost = (state: SubjectState): boolean => conversationLost(state, "sms");

/**
 * Whether SMS can no longer reach the lead in this campaign because its conversation is taken (ADR 0003, question Q7
 * answered; spec "A lead with no usable channel left in the campaign is marked finished, with the reason shown"): every
 * live SMS track of its branch has finished, one of them skipped for a taken conversation, and none of them texted it.
 * While an SMS track of the branch is still to run, SMS still reaches the lead: a free number may join the pool first.
 */
export function conversationLost(state: SubjectState, channel: ConversationChannel): boolean {
  const sms = liveTracksFor(state).filter((t) => t.channel === channel);
  const progress = sms.map((t) => progressOf(state, t.id));
  if (progress.some((p) => !p || p.finishedAt === null)) return false;
  if (!progress.some((p) => p?.finishReason === "skipped_conversation_taken")) return false;
  return !state.results.some((r) => r.result === "sent" && sms.some((t) => t.id === r.trackId));
}

/**
 * Why a channel cannot reach the lead (ticket 20a, Needs attention): null when it can; `declined` for calls after a
 * decline; `conversation_taken` for a good mobile whose SMS tracks were skipped for another campaign's conversation
 * (question Q7 answered); `bad` when the lead has such a detail but every one is marked bad; `missing` when it has none.
 */
export function unreachableWhy(state: SubjectState, channel: TrackChannel): "missing" | "bad" | "declined" | "conversation_taken" | null {
  if (channelReaches(state, channel)) return null;
  if (channel === "call") return state.subject.noMoreCalls && hasGoodNumber(state) ? "declined" : state.lead.phones.length > 0 ? "bad" : "missing";
  // A good mobile whose conversation was taken on every number its SMS tracks could use (question Q7 answered).
  if (holdsConversations(channel) && destinationFor(state.lead.details, channel) !== null) return "conversation_taken";
  return destinationFor(state.lead.details.map((d) => ({ ...d, bad: false })), channel) !== null ? "bad" : "missing";
}

/** Channels in the lead's branch that can reach the lead now (2.1). */
export function reachable(state: SubjectState): Set<string> {
  const channels = new Set<string>();
  for (const track of liveTracksFor(state)) {
    if (channelReaches(state, track.channel)) channels.add(track.channel);
  }
  return channels;
}

// ---------------------------------------------------------------------------------------------
// Small state updates.

const withTrack = (state: SubjectState, trackId: string, change: (t: TrackProgress) => TrackProgress): SubjectState => ({
  ...state,
  tracks: state.tracks.map((t) => (t.trackId === trackId ? change(t) : t)),
});

const withAttempt = (state: SubjectState, attempt: Attempt): SubjectState => ({
  ...state,
  attempts: state.attempts.map((a) => (a.id === attempt.id ? attempt : a)),
});

/** The provider work an attempt carries. */
export function workOf(state: SubjectState, key: string): ProviderWork {
  const w = state.work.find((x) => x.key === key);
  if (!w) throw new Error(`no provider work ${key}`);
  return w;
}

const withWork = (state: SubjectState, work: ProviderWork): SubjectState => ({
  ...state,
  work: state.work.map((w) => (w.key === work.key ? work : w)),
});

/** Brings the clock in line with `runs`, recording the freeze (3.2). */
export function synced(state: SubjectState, now: number): SubjectState {
  const { clock, freezes } = syncClock(state.subject.clock, state.freezes, runs(state), now);
  return { ...state, subject: { ...state.subject, clock }, freezes };
}

/** Quiesce (2.5): claimed attempts are withdrawn; handed and accepted ones are asked to withdraw. */
export function quiesce(state: SubjectState, trackId: string | null = null): SubjectState {
  let next = state;
  for (const attempt of state.attempts) {
    if (!isLive(attempt) || (trackId !== null && attempt.trackId !== trackId)) continue;
    const step = applyAttemptEvent(attempt, workOf(next, attempt.idempotencyKey), { kind: "quiesce" });
    next = withWork(withAttempt(next, step.attempt), step.work);
  }
  // Every piece of work in scope the provider may still send is to be withdrawn, live attempt or not: the intent is kept
  // on the work, so a non-final "not sent" that retires its attempt does not end it (ticket 17a; council A on 56d599c).
  for (const w of next.work) {
    if ((trackId !== null && w.trackId !== trackId) || !maySend(w) || w.withdrawWanted) continue;
    next = withWork(next, { ...w, withdrawWanted: true, withdrawLastWall: null });
  }
  return next;
}

/**
 * Work whose withdrawal is to be asked of the provider at `now`: wanted, unsettled, and not asked within a settling period,
 * whether or not a live attempt still carries it (`carried`, which the rule deliberately ignores; a mutation reads it).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the rule ignores it by design; a mutation reads it
export function withdrawalDue(w: ProviderWork, now: number, carried = true): boolean {
  return w.withdrawWanted && maySend(w) && (w.withdrawLastWall === null || now >= w.withdrawLastWall + ENGINE_PARAMS.SETTLING);
}

/**
 * A track finishes once and stays finished. Finishing quiesces its live attempts and closes its open
 * call task in the same change (2.3), whatever the reason.
 */
export function finishTrack(state: SubjectState, trackId: string, reason: FinishReason, at: number, atWall: number): SubjectState {
  const progress = progressOf(state, trackId);
  if (!progress || progress.finishedAt !== null) return state;
  // A LinkedIn track skipped as a missing channel records why, as the facts stand at its finish (ticket 24b): a read never
  // works it out again from today's import, marks or decision makers.
  const channel = channelOf(state, trackId);
  const cause =
    reason !== "skipped_missing_channel"
      ? {}
      : channel === "linkedin"
        ? { skipCause: linkedinSkipCauseOf(state, progress.destinationDetailId) }
        : isMessageRequestChannel(channel)
          ? { skipCause: accountSkipCauseOf(state, channel, progress.destinationDetailId) }
          : {};
  const finished = withTrack(state, trackId, (t) => ({ ...t, finishedAt: at, finishedWall: atWall, finishReason: reason, ...cause }));
  const closed = { ...finished, callTasks: finished.callTasks.map((t) => (t.trackId === trackId && t.open ? { ...t, open: false, closedWall: atWall } : t)) };
  return quiesce(closed, trackId);
}

/** Ends the lead in this campaign: its outreach quiesces and its clock freezes. */
export function end(state: SubjectState, reason: EndReason, now: number): SubjectState {
  const ended = { ...state, subject: { ...state.subject, ended: reason, endedAt: leadNow(state.subject.clock, now), endedWall: now } };
  return synced(quiesce(ended), now);
}

// ---------------------------------------------------------------------------------------------
// Endings (2.1), checked first in every evaluation and after every fact that removes work or reach.

export function hasWorkLeft(state: SubjectState): boolean {
  return liveTracksFor(state).some((t) => {
    const p = progressOf(state, t.id);
    return !p || p.finishedAt === null;
  });
}

export function checkEndings(state: SubjectState, now: number): SubjectState {
  if (state.subject.ended !== null || !runs(state)) return state;
  if (reachable(state).size === 0) return end(state, "finished_no_usable_channel", now);
  if (!hasWorkLeft(state)) return end(state, "sequence_finished_no_response", now);
  return state;
}

// ---------------------------------------------------------------------------------------------
// Deadlines and the pending step (3.3, 5.1).

/** The step 5.1 names: the first live step after the last resolved one, with no result. */
export function nextStepOf(state: SubjectState, track: TrackDefinition): string | null {
  return remainingSteps(state, track)[0] ?? null;
}

/** The steps still ahead of the lead in a track, in order (5.1): live, after its last resolved step, with no result. */
export function remainingSteps(state: SubjectState, track: TrackDefinition): string[] {
  const resolved = new Set(state.results.filter((r) => r.trackId === track.id).map((r) => r.stepId));
  let lastResolved = -1;
  track.steps.forEach((s, i) => {
    if (resolved.has(s.id)) lastResolved = i;
  });
  return track.steps.filter((s, i) => i > lastResolved && !s.removed && !resolved.has(s.id)).map((s) => s.id);
}

/**
 * The connection gate (ADR 0004 3.2): a LinkedIn message step of any kind, first or follow-up, waits while the track has no
 * connection. A mutable seam, so the generated runs can prove they see a gate that covers only the first message.
 */
export const rules = {
  /**
   * Pairs are read per channel (review bot on b21af02); false only for the generated runs' mutation, which also takes the
   * LinkedIn session from any pair the subject owns (the bot's reproduction). Pair keys never coincide across channels (a
   * session is not a number, a profile not a mobile), so the per-channel filter in the other reads is defence in depth.
   */
  pairsByChannel: true,
  /** A refusal because the connection is gone fails the track and keeps the profile good (Q37); true only for a mutation. */
  notConnectedMarksBad: false,
  /** An edit of the acceptance wait re-resolves every waiting deadline (ADR 0004 3.2); false only for a mutation. */
  waitEditRealigns: true,
  /**
   * A connection check's answer is kept per session (review bot on e261ffa); false only for the mutation that keeps one
   * answer for the track and asks only its first healthy session, as `b21af02` to `e261ffa` did.
   */
  checksPerSession: true,
  /**
   * A cached evaluation remembers the versions of every destination it could take or wait on; true only for the mutation
   * that remembers only the destinations of pairs it owns, so another subject's pair on its destination never moves it.
   */
  conversationKeysOwnOnly: false,
  connectionGate: (track: TrackDefinition, stepId: string, progress: TrackProgress): boolean => {
    const kind = linkedinStepKind(track, stepId);
    return kind !== null && kind !== "invite" && (progress.connection ?? null) === null;
  },
};

/**
 * Resolves the track's next step from basis `at`/`atWall`, or finishes the track when no live
 * step is left (2.6 step 3). The deadline is resolved once and stored.
 */
export function advanceTrack(state: SubjectState, track: TrackDefinition, at: number, atWall: number): SubjectState {
  const progress = progressOf(state, track.id);
  if (!progress || progress.finishedAt !== null) return state;
  const stepId = nextStepOf(state, track);
  if (stepId === null) {
    const own = state.results.filter((r) => r.trackId === track.id);
    const reason: FinishReason = own.length > 0 && own.every((r) => r.result === "skipped") ? "skipped" : "completed";
    return finishTrack(state, track.id, reason, at, atWall);
  }
  const step = track.steps.find((s) => s.id === stepId);
  const zone = state.lead.zone;
  // Every LinkedIn message waits for a connection (ADR 0004 3.2; review bot on 194fc44): the gate is the connection's, not one
  // step's, so a skip, an edit or a restart cannot reach a message before it. Until then the step is pending with no due time.
  if (rules.connectionGate(track, stepId, progress)) {
    // No invite went (the user skipped it, or it was never sent) and none is pending: nothing can ever connect the track, so
    // it finishes now with that reason, releasing what waits on it, rather than leave a message pending for ever (council
    // on 194fc44, item 9). A pre-existing connection is found only by the invite's own pre-send check, never after a skip.
    const invite = inviteResult(state, track);
    if ((progress.acceptBy ?? null) === null && (!invite || invite.result !== "sent")) {
      const byUser = invite?.reason === "by_user";
      return finishTrack(state, track.id, byUser ? "skipped_by_user" : "skipped", at, atWall);
    }
    return withTrack(state, track.id, (t) => ({ ...t, nextStepId: stepId, basisAt: null, basisWall: null, dueAt: null, dueWall: null, dueZone: null }));
  }
  const s = waitSpan(state.subject.kind, atWall, step?.waitDays ?? 0, zone);
  return withTrack(state, track.id, (t) => ({
    ...t,
    nextStepId: stepId,
    basisAt: at,
    basisWall: atWall,
    dueAt: at + s,
    dueWall: atWall + s,
    dueZone: zone,
  }));
}

const emptyProgress = (trackId: string): TrackProgress => ({
  trackId,
  startAt: null,
  startBasisAt: null,
  startBasisWall: null,
  startZone: null,
  startedAt: null,
  destinationDetailId: null,
  nextStepId: null,
  basisAt: null,
  basisWall: null,
  dueAt: null,
  dueWall: null,
  dueZone: null,
  finishedAt: null,
  finishedWall: null,
  finishReason: null,
});

// ---------------------------------------------------------------------------------------------
// Evaluation (2.6).

/**
 * What evaluation does for a running subject: endings first, track starts, next steps, then
 * endings again. Ready items are the dispatcher's (dispatch.ts). Reads no clock and no store.
 */
export function evaluate(
  state: SubjectState,
  now: number,
  options: { readonly endingsFirst?: boolean; readonly skipTakenConversations?: boolean; readonly inviteExpired?: typeof inviteExpired } = {},
): SubjectState {
  // Unworked calls past the skip limit are skipped at the rollover they expired at, before any start, so
  // the tracks after them start in this same evaluation (3.5; ticket 15). Judged for a held lead too, which
  // only records the rollovers judged (it did not run at them), so none is judged later under other inputs.
  const judged = state.subject.ended === null && (state.campaign.launchedAt !== null || state.subject.kind === "test_run") ? expireUnworked(state, now) : state;
  if (!runs(judged)) return judged;
  // `endingsFirst: false` exists only for the oracle's broken engine (ADR 0003 9.2, "ending check too late").
  let s = options.endingsFirst === false ? judged : checkEndings(judged, now);
  if (!runs(s)) return s;
  const lead = leadNow(s.subject.clock, now);

  // Starts, until nothing more starts: a track skipped at its start finishes then, so a track
  // after it with no delay starts at the same lead time (spec "a skipped or failed track counts as finished").
  // An SMS track whose mobile's conversation is taken on every number it may use, at the moment its claim
  // would be made, is skipped in the same fixpoint, so the tracks after it start as after any skip (Q7 answered).
  // `skipTakenConversations: false` exists only for the oracle's broken engine ("held instead of skipped").
  for (let round = 0; round <= 2 * s.campaign.definition.tracks.length; round++) {
    const before = s;
    for (const track of liveTracksFor(s)) s = startTrack(s, track, lead, now);
    if (options.skipTakenConversations !== false) s = skipTakenConversations(s, now);
    if (before === s) break;
  }

  // A started track whose destination went bad, or stopped being the lead's, finishes (2.4).
  for (const track of liveTracksFor(s)) {
    const progress = progressOf(s, track.id);
    if (!progress || progress.startedAt === null || progress.finishedAt !== null || progress.destinationDetailId === null) continue;
    const dest = s.lead.resolved[progress.destinationDetailId];
    if (!dest || dest.bad) s = finishTrack(s, track.id, "failed_bad_destination", lead, wallOfLead(s.subject.clock, now));
    else if (!dest.owned) s = finishTrack(s, track.id, "skipped_missing_channel", lead, wallOfLead(s.subject.clock, now));
  }

  // A started phone track with no good number left is skipped (spec "Phone steps are skipped when no good number remains").
  for (const track of liveTracksFor(s)) {
    const progress = progressOf(s, track.id);
    if (track.channel !== "call" || !progress || progress.startedAt === null || progress.finishedAt !== null || hasGoodNumber(s)) continue;
    s = finishTrack(s, track.id, "skipped_missing_channel", lead, wallOfLead(s.subject.clock, now));
  }

  // A LinkedIn invite whose acceptance wait has ended with no connection (ADR 0004 3.3): before the next steps, so the
  // tracks after it start in this same evaluation from the deadline. `inviteExpired` is a rule, where ticket 27 attaches.
  for (const track of liveTracksFor(s)) {
    if (awaitingAcceptance(s, track.id) && (progressOf(s, track.id)?.acceptBy ?? Infinity) <= lead) s = (options.inviteExpired ?? inviteExpired)(s, track.id, now);
  }

  // Next steps for started tracks with no pending step and no live attempt.
  for (const track of liveTracksFor(s)) {
    const progress = progressOf(s, track.id);
    if (!progress || progress.startedAt === null || progress.finishedAt !== null || progress.nextStepId !== null) continue;
    if (s.attempts.some((a) => a.trackId === track.id && isLive(a))) continue;
    const latest = latestResult(s, track.id);
    s = advanceTrack(s, track, latest?.at ?? progress.startedAt, latest?.atWall ?? wallAtLead(s.subject.clock, s.freezes, progress.startedAt, now));
  }

  return attend(checkEndings(s, now), now);
}

/**
 * A user action is judged on the lead's state as of the action's own instant (ADR 0003 2.4, review bot
 * on eda5fa0): in the transaction that records it, everything already due at or before that instant is
 * applied first, by the same evaluation the worker's tick runs (an expiry at a rollover, the starts and
 * endings it releases), whether or not the worker has ticked since. Read models and every route that
 * changes a timing input use it too (council on 228cd3b).
 */
export function asOfAction(state: SubjectState, now: number, evaluateAt: typeof evaluate = evaluate): SubjectState {
  return evaluateAt(state, now);
}

/**
 * Marks every open call task as judged through `now` (council on 228cd3b): run after `asOfAction` by a
 * route that changes an input the skip limit reads (the user's zone, a prospect's zone), so the days
 * already past are never judged again under the new input, and the new zone's days count from now.
 */
export function sealReckoning(state: SubjectState, now: number): SubjectState {
  return { ...state, callTasks: state.callTasks.map((t) => (t.open && t.kind === "call" && t.reckonedThrough < now ? { ...t, reckonedThrough: now } : t)) };
}

/**
 * The call skip limit (ADR 0003 3.5; ticket 15). An open call task (not a callback) expires at a user-day
 * rollover e, the end of day d, when all of these held:
 * - it was listed on day d: d is on or after its list day (a redial moves that to the next day), and
 *   the prospect's calling hours open at some point of day d;
 * - the lead ran at e, read from its freezes record, so a hold (a callback, a pause, an ending) at the
 *   rollover means no expiry then; and so it was listed at the last moment of day d;
 * - lead time at e had reached its skip deadline, which was resolved once from the call's original
 *   due time and is frozen with the lead's clock.
 * Only rollovers after `reckonedThrough` are judged, and it moves on to the last one judged: a rollover is
 * judged once, with the inputs in force then, and never again (council on 228cd3b). A rollover the app was
 * off for is judged where it fell. The call step is skipped (`unworked`), and the track finishes
 * `skipped_unworked` at e, closing the task; the tracks after it start after their delay. A task worked on
 * day d is not open with a list day at or before d (a redial moves it on, a callback holds the lead, any
 * other outcome closes it), so "not worked" needs no record of its own.
 */
export function expireUnworked(state: SubjectState, now: number): SubjectState {
  let s = state;
  const zone = s.callDay.userZone;
  for (const task of state.callTasks) {
    if (!task.open || task.kind !== "call") continue;
    const window = s.campaign.definition.tracks.find((t) => t.id === task.trackId)?.window ?? [];
    let judged = task.reckonedThrough;
    let expired = false;
    for (let k = localDayNumber(task.reckonedThrough, zone) + 1; ; k++) {
      const e = startOfLocalDay(k, zone);
      if (e > now) break;
      if (e <= task.reckonedThrough) continue;
      judged = e;
      const d = k - 1;
      if (d < task.listDay) continue;
      const point = sendPoint(s.subject.clock, s.freezes, e, e, now);
      // `atWall` is the start of the freeze holding e; e itself only while the lead ran at e.
      if (point.atWall !== e || point.at < task.skipDeadline) continue;
      const opens = nextWindowOpen(window, s.lead.zone, startOfLocalDay(d, zone));
      if (opens === null || opens >= e) continue;
      s = { ...s, results: [...s.results, { stepId: task.stepId, trackId: task.trackId, result: "skipped", reason: "unworked", at: point.at, atWall: e, attemptId: null }] };
      s = finishTrack(s, task.trackId, "skipped_unworked", point.at, e);
      expired = true;
      break;
    }
    if (!expired && judged > task.reckonedThrough) s = { ...s, callTasks: s.callTasks.map((t) => (t.id === task.id ? { ...t, reckonedThrough: judged } : t)) };
  }
  return s;
}

/**
 * Resolves a track's start once its rule is satisfied, and starts it once lead time reaches it
 * (2.6 step 2). `entry` resolves to the branch entry; `after(P, d)` to d calendar days in the
 * prospect's zone after P finished all its steps (3.3), from P's stored finish. A track whose
 * channel cannot reach the lead starts and finishes `skipped_missing_channel` at that lead time.
 */
function startTrack(state: SubjectState, track: TrackDefinition, lead: number, now: number): SubjectState {
  let s = state;
  let progress = progressOf(s, track.id);
  if (progress?.startedAt == null && progress?.startAt == null) {
    const resolved = resolveStart(s, track, now);
    if (resolved) {
      s = progress ? withTrack(s, track.id, (t) => ({ ...t, ...resolved })) : { ...s, tracks: [...s.tracks, { ...emptyProgress(track.id), ...resolved }] };
      progress = progressOf(s, track.id);
    }
  }
  if (!progress || progress.startedAt !== null || progress.startAt === null || progress.startAt > lead) return s;
  const startAt = progress.startAt;
  const startWall = wallAtLead(s.subject.clock, s.freezes, startAt, now);
  // A phone track has no single destination: the user chooses among the lead's numbers at each call.
  const destination = destinationFor(s.lead.details, track.channel);
  s = withTrack(s, track.id, (t) => ({ ...t, startedAt: startAt, destinationDetailId: destination?.id ?? null }));
  // A phone track after a decline starts and is skipped at once: no call is made to the lead again (2.4).
  if (track.channel === "call" && s.subject.noMoreCalls) return finishTrack(s, track.id, "skipped_declined", startAt, startWall);
  return channelReaches(s, track.channel) ? advanceTrack(s, track, startAt, startWall) : finishTrack(s, track.id, "skipped_missing_channel", startAt, startWall);
}

function resolveStart(s: SubjectState, track: TrackDefinition, now: number): Pick<TrackProgress, "startAt" | "startBasisAt" | "startBasisWall" | "startZone"> | null {
  const zone = s.lead.zone;
  if (track.start.kind === "entry") {
    const entered = s.subject.branchEnteredAt;
    if (entered === null) return null;
    return { startAt: entered, startBasisAt: entered, startBasisWall: wallAtLead(s.subject.clock, s.freezes, entered, now), startZone: zone };
  }
  const before = progressOf(s, track.start.trackId);
  if (!before || before.finishedAt === null || before.finishedWall === null) return null;
  return { startAt: before.finishedAt + waitSpan(s.subject.kind, before.finishedWall, track.start.delayDays, zone), startBasisAt: before.finishedAt, startBasisWall: before.finishedWall, startZone: zone };
}

function latestResult(state: SubjectState, trackId: string): StepResult | undefined {
  return state.results.filter((r) => r.trackId === trackId).sort((a, b) => b.at - a.at)[0];
}

// ---------------------------------------------------------------------------------------------
// Lifecycle and facts (2.4).

/** Launch: the clock syncs and `main` is entered at lead time 0 (or the enrollment's first running instant). */
export function enterMain(state: SubjectState, now: number): SubjectState {
  const s = synced(state, now);
  if (s.subject.branchEnteredAt !== null || !runs(s)) return s;
  return { ...s, subject: { ...s.subject, branch: "main", branchEnteredAt: leadNow(s.subject.clock, now) } };
}

/**
 * A declined call (ADR 0003 2.4 "Calls", ticket 16), after the declined call's own result has completed its
 * track at `at`: no call is made to the lead again in this campaign (`noMoreCalls`, never cleared), so every
 * other phone track it has started finishes `skipped_declined` at the same instant, closing its task (an open
 * redial or callback closes without an outcome and holds nothing), and a later one is skipped at its start.
 * Then by path: stop ends the lead `declined_on_call`; continue leaves it running on its other channels;
 * win back enters the campaign's win-back branch (`enterWinBack`). Other campaigns and colleagues are untouched.
 */
export function decline(state: SubjectState, path: DeclinedPath, at: number, atWall: number, now: number): SubjectState {
  let s: SubjectState = { ...state, subject: { ...state.subject, noMoreCalls: true } };
  for (const track of s.campaign.definition.tracks) {
    const p = progressOf(s, track.id);
    if (track.channel === "call" && p && p.startedAt !== null && p.finishedAt === null) s = finishTrack(s, track.id, "skipped_declined", at, atWall);
  }
  if (path === "stop") return end(s, "declined_on_call", now);
  if (path === "win_back") s = enterWinBack(s, now);
  return runs(s) ? evaluate(s, now) : s;
}

/**
 * Entering win-back (2.4): every unfinished main track finishes `dropped_for_win_back` now, started or not,
 * closing its call task and quiescing its live attempts, so nothing of it is claimed afterwards; an attempt
 * already with a provider resolves by the attempt rules, on a finished track (ruling 7). Then the lead's branch
 * is `win_back`, entered at the current lead time, from which the branch's entry tracks start.
 */
export function enterWinBack(state: SubjectState, now: number): SubjectState {
  const at = leadNow(state.subject.clock, now);
  const atWall = wallOfLead(state.subject.clock, now);
  let s = state;
  for (const track of liveTracksFor(s)) {
    if (track.branch !== "main" || progressOf(s, track.id)?.finishedAt != null) continue;
    if (!progressOf(s, track.id)) s = { ...s, tracks: [...s.tracks, emptyProgress(track.id)] };
    s = finishTrack(s, track.id, "dropped_for_win_back", at, atWall);
  }
  return { ...s, subject: { ...s.subject, branch: "win_back", branchEnteredAt: at } };
}

/** A reply ends outreach in this campaign (2.4), unless the lead already replied or was interested. */
export function applyReply(state: SubjectState, reply: { channel: ReplyChannelName; atWall: number; providerRef: StoredReplyId }, now: number): SubjectState {
  if (state.replies.some((r) => r.providerRef === reply.providerRef)) return state;
  const recorded = { ...state, replies: [...state.replies, reply] };
  if (state.subject.ended === "replied" || state.subject.ended === "interested_on_call") return recorded;
  const ended = {
    ...recorded,
    subject: { ...recorded.subject, ended: "replied" as const, endedAt: leadNow(recorded.subject.clock, now), endedWall: now, stopReply: { channel: reply.channel, atWall: reply.atWall } },
  };
  return attend(synced(quiesce(ended), now), now);
}

/** A bounce or invalid address after a send: the detail is marked bad, and an unfinished track fails (2.4). */
export function applyBadDestination(state: SubjectState, attempt: Attempt, now: number): SubjectState {
  const liveId = state.lead.resolved[attempt.destinationDetailId]?.liveId ?? attempt.destinationDetailId;
  const marked = markDetailBad(state, liveId);
  const progress = progressOf(marked, attempt.trackId);
  if (!progress || progress.finishedAt !== null) return marked;
  return attend(checkEndings(finishTrack(marked, attempt.trackId, "failed_bad_destination", leadNow(marked.subject.clock, now), wallOfLead(marked.subject.clock, now)), now), now);
}

/** Marks a live contact detail bad, in this change and in the store (ADR 0001: bad marks are never cleared). */
export function markDetailBad(state: SubjectState, liveId: string): SubjectState {
  return {
    ...state,
    markBad: [...new Set([...state.markBad, liveId])],
    lead: {
      ...state.lead,
      details: state.lead.details.map((d) => (d.id === liveId ? { ...d, bad: true } : d)),
      phones: state.lead.phones.map((p) => (p.id === liveId ? { ...p, bad: true } : p)),
      resolved: Object.fromEntries(Object.entries(state.lead.resolved).map(([id, r]) => [id, r.liveId === liveId ? { ...r, bad: true } : r])),
    },
  };
}

/** The attempt the work's send settles on (PR 37 ruling 4): its first attempt handed over, unless that one was refused. */
function carrierOf(state: SubjectState, key: string): Attempt | undefined {
  const handed = state.attempts.filter((a) => a.idempotencyKey === key && a.handedWall !== null).sort((x, y) => (x.handedWall ?? 0) - (y.handedWall ?? 0));
  return handed.find((a) => a.state !== "rejected") ?? handed[0];
}

/**
 * Run after every change to provider work. When work settles, by any route, every attempt still
 * carrying it that has not been handed over is withdrawn in the same change (review bot on
 * 0dc88ab). Unsettled work the provider may hold that no live attempt carries any more is
 * unresolved from then on (4.2, PR 37 review round 2 ruling 2), so it is listed until the provider
 * or the user settles it.
 */
export function attend(state: SubjectState, now: number): SubjectState {
  return alignPending(attendWork(state, now), now);
}

function attendWork(state: SubjectState, now: number): SubjectState {
  let s = state;
  for (const a of state.attempts) {
    if (a.state === "claimed" && state.work.some((w) => w.key === a.idempotencyKey && w.settled !== null)) s = withAttempt(s, { ...a, state: "withdrawn", endedBy: "guard" });
  }
  for (const w of s.work) {
    if (!isUncertain(w) || w.unresolvedSince !== null) continue;
    if (s.attempts.some((a) => a.idempotencyKey === w.key && isLive(a))) continue;
    s = withWork(s, { ...w, unresolvedSince: now });
  }
  return s;
}

/**
 * Applies one event about an attempt, with its work, and its consequences for the step (2.4
 * "Sending"). A result on a finished track changes nothing else.
 */
export function applyToAttempt(state: SubjectState, attemptId: string, event: AttemptEvent, now: number): { state: SubjectState; effects: readonly AttemptEffect[] } {
  const target = state.attempts.find((a) => a.id === attemptId);
  if (!target) throw new Error(`no attempt ${attemptId}`);
  const work = workOf(state, target.idempotencyKey);
  const { attempt, work: nextWork, effects } = applyAttemptEvent(target, work, event);
  let s = withWork(withAttempt(state, attempt), nextWork);
  for (const effect of effects) if (effect.kind === "rejected") s = recordRejected(s, attempt, effect.reason, now);
  s = attend(s, now);
  return { state: runs(s) ? evaluate(s, now) : s, effects };
}

/**
 * Applies one event about provider work to the work and every attempt carrying it, in one change
 * (PR 37 review round 3): a send, a lookup, a provider refusal, the user's mark. A send is timed
 * by the provider's send time mapped onto the lead's clock, settles on the work's first attempt
 * handed over (ruling 4), and resolves the next step in the same change whether or not the
 * subject runs.
 */
export function applyToWork(
  state: SubjectState,
  key: string,
  event: WorkEvent,
  now: number,
  options: { readonly resetDay: (accountId: string, t: number) => string; readonly point?: typeof sendPoint } = { resetDay: () => "" },
): { state: SubjectState; effects: readonly AttemptEffect[] } {
  const w = workOf(state, key);
  const live = state.attempts.find((a) => a.idempotencyKey === key && isLive(a)) ?? null;
  const carrier = carrierOf(state, key) ?? live ?? undefined;
  const done = (s: SubjectState, effects: readonly AttemptEffect[]) => {
    const attended = attend(s, now);
    return { state: runs(attended) ? evaluate(attended, now) : attended, effects };
  };
  const sentFact = event.kind === "sent_observed" || (event.kind === "lookup_answer" && event.answer.kind === "sent") || event.kind === "mark_sent";
  if (sentFact) {
    const byUser = event.kind === "mark_sent";
    if (byUser && !markable(w)) return { state, effects: [{ kind: "ignored", what: "mark sent is only for unresolved work" }] };
    const ref = event.kind === "sent_observed" ? event.providerRef : event.kind === "lookup_answer" ? (event.answer.providerRef ?? null) : null;
    const providerTime = event.kind === "sent_observed" ? event.providerTime : event.kind === "lookup_answer" ? (event.answer.sentAt ?? event.now) : event.now;
    const referenced = withRef(event.kind === "lookup_answer" ? { ...w, lookupAnswer: "sent" } : w, ref);
    if (w.settled === "sent" || w.settled === "user_sent") return { state: withWork(state, referenced), effects: [{ kind: "ignored", what: "the work was already settled as sent" }] };
    const at = Math.min(Math.max(providerTime, w.firstHandedWall ?? providerTime), now);
    if (w.settled !== null || !carrier) {
      // Work already settled otherwise (refused, withdrawn, or marked not sent by the user): an
      // anomaly, counted on its send day for capacity, never a second send of the step.
      const counted = w.sentWall === null ? { ...referenced, sentWall: at, sentDay: options.resetDay(w.accountId, at) } : referenced;
      return { state: withWork(state, counted), effects: [{ kind: "anomaly", what: `the provider sent work that was ${w.settled === "user_not_sent" ? "marked not sent" : (w.settled ?? "never handed over")}` }] };
    }
    const settled: ProviderWork = { ...referenced, settled: byUser ? "user_sent" : "sent", nextLookupWall: null, sentWall: at, sentDay: options.resetDay(w.accountId, at), withdrawWanted: false };
    const endedBy = byUser ? "user" : event.kind === "lookup_answer" ? "lookup" : "observed";
    let s = withWork(state, settled);
    // Every other live attempt carrying the work is settled by the same statement.
    for (const a of s.attempts) {
      if (a.idempotencyKey !== key || a.id === carrier.id || !isLive(a)) continue;
      s = withAttempt(s, { ...a, state: "withdrawn", endedBy: byUser ? "user" : "provider", awaitingAnswer: false, retry: "refused" });
    }
    if (s.attempts.some((a) => a.stepId === carrier.stepId && a.state === "sent")) return done(s, [{ kind: "ignored", what: "the step was already sent" }]);
    s = withAttempt(s, { ...carrier, state: "sent", endedBy, awaitingAnswer: false, retry: carrier.retry === "none" ? "none" : "refused" });
    s = recordSent(s, s.attempts.find((a) => a.id === carrier.id) ?? carrier, providerTime, now, options);
    return done(s, [{ kind: "sent", providerTime }]);
  }
  switch (event.kind) {
    case "lookup_answer": {
      const kind = event.answer.kind;
      if (kind === "sent") throw new Error("unreachable");
      const transport = live ?? carrier ?? { retryable: false, notSentIsFinal: false };
      const out = applyLookup(w, live, transport, kind, event.now);
      let s = withWork(state, out.work);
      if (out.live) s = withAttempt(s, out.live);
      return done(s, []);
    }
    case "provider_rejected": {
      // Only a provider signal that it will not send moves accepted work (Instantly's skip, P4).
      if (w.settled !== null) return { state, effects: [{ kind: "ignored", what: "a refusal of settled work" }] };
      let s = withWork(state, { ...w, settled: "rejected", nextLookupWall: null });
      const refused = live && live.state !== "claimed" ? live : carrier;
      if (live && live.state !== "claimed") s = withAttempt(s, { ...live, state: "rejected", endedBy: "provider", rejectReason: event.reason, awaitingAnswer: false });
      // Work no attempt holds at the provider: the refusal's reason is kept on the attempt that handed it over.
      else if (refused) s = withAttempt(s, { ...refused, rejectReason: event.reason });
      if (refused) s = recordRejected(s, s.attempts.find((a) => a.id === refused.id) ?? refused, event.reason, now);
      return done(s, [{ kind: "rejected", reason: event.reason }]);
    }
    case "withdraw_answer": {
      if (w.settled !== null || !w.withdrawWanted) return { state, effects: [{ kind: "ignored", what: "a withdrawal answer for work not being withdrawn" }] };
      // Every live attempt carrying the work has now been asked (it is never called again).
      let s = state;
      for (const a of s.attempts) if (a.idempotencyKey === key && isLive(a) && a.state !== "claimed") s = withAttempt(s, { ...a, withdrawRequested: true, withdrawCalled: true, retry: a.retry === "none" ? "none" : "refused" });
      if (event.answer === "withdrawn") {
        // A confirmed withdrawal settles the work (4.2) and ends every attempt still carrying it.
        s = withWork(s, { ...w, settled: "withdrawn", nextLookupWall: null, withdrawWanted: false, withdrawLastWall: event.now });
        for (const a of s.attempts) if (a.idempotencyKey === key && isLive(a)) s = withAttempt(s, { ...a, state: "withdrawn", endedBy: a.state === "claimed" ? "guard" : "provider", awaitingAnswer: false });
        return done(s, []);
      }
      // "too late" is the provider's final word that the message went (council J on 56d599c): the work is marked gone, so it
      // no longer counts as work that may still be sent nor holds an in-flight place, and is not withdrawn again; its send
      // time, from which the next step counts (ruling 4), comes from the observation or a lookup, asked at once.
      // "unknown": asked again one settling period on, and looked up meanwhile.
      const next: ProviderWork =
        event.answer === "too-late"
          ? { ...w, withdrawWanted: false, withdrawLastWall: event.now, wentWall: event.now, nextLookupWall: Math.min(w.nextLookupWall ?? event.now, event.now) }
          : { ...w, withdrawLastWall: event.now, nextLookupWall: w.nextLookupWall ?? event.now + ENGINE_PARAMS.SETTLING };
      return done(withWork(s, next), []);
    }
    case "mark_not_sent": {
      if (!markable(w)) return { state, effects: [{ kind: "ignored", what: "mark not sent is only for unresolved work" }] };
      if (w.lookupAnswer === "queued") return { state, effects: [{ kind: "ignored", what: "the provider reports the work queued" }] };
      // The user's decision settles the work: its reservation goes, it is no longer looked up, and
      // every attempt still carrying it ends (PR 37 review round 3). A send observed later is still
      // counted on its send day; the step's next attempt takes new work.
      let s = withWork(state, { ...w, settled: "user_not_sent", nextLookupWall: null });
      for (const a of s.attempts) {
        if (a.idempotencyKey === key && isLive(a)) s = withAttempt(s, { ...a, state: "withdrawn", endedBy: "user", awaitingAnswer: false, retry: "refused" });
      }
      return done(s, []);
    }
  }
  return { state, effects: [] };
}

function recordSent(
  state: SubjectState,
  attempt: Attempt,
  providerTime: number,
  now: number,
  options: { readonly resetDay: (accountId: string, t: number) => string; readonly point?: typeof sendPoint },
): SubjectState {
  const point = (options.point ?? sendPoint)(state.subject.clock, state.freezes, providerTime, attempt.handedWall ?? attempt.claimedWall, now);
  let s: SubjectState = { ...state, subject: { ...state.subject, touched: true } };
  if (s.results.some((r) => r.stepId === attempt.stepId)) return s;
  s = { ...s, results: [...s.results, { stepId: attempt.stepId, trackId: attempt.trackId, result: "sent", reason: null, at: point.at, atWall: point.atWall, attemptId: attempt.id }] };
  const progress = progressOf(s, attempt.trackId);
  const track = s.campaign.definition.tracks.find((t) => t.id === attempt.trackId);
  if (!progress || !track || progress.finishedAt !== null) return s;
  // A sent LinkedIn invite starts its acceptance wait, resolved once from the send point (ADR 0004 3.2).
  if (linkedinStepKind(track, attempt.stepId) === "invite") s = withTrack(s, track.id, (t) => ({ ...t, ...acceptDeadline(s, track, point.at, point.atWall) }));
  return advanceTrack(s, track, point.at, point.atWall);
}

const failedReasonOf = (channel: TrackChannel | undefined): string =>
  channel === "sms" ? "invalid number" : channel === "linkedin" ? "profile unreachable" : isMessageRequestChannel(channel) ? "account unreachable" : "invalid address";

function recordRejected(state: SubjectState, attempt: Attempt, reason: Attempt["rejectReason"], now: number): SubjectState {
  const progress = progressOf(state, attempt.trackId);
  const at = leadNow(state.subject.clock, now);
  const atWall = wallOfLead(state.subject.clock, now);
  if (reason === "invalid_destination") {
    const failed = progress && progress.finishedAt === null && !state.results.some((r) => r.stepId === attempt.stepId)
      ? { ...state, results: [...state.results, { stepId: attempt.stepId, trackId: attempt.trackId, result: "failed" as const, reason: failedReasonOf(channelOf(state, attempt.trackId)), at, atWall, attemptId: attempt.id }] }
      : state;
    return applyBadDestination(failed, attempt, now);
  }
  if (reason === "blocklisted") {
    if (!progress || progress.finishedAt !== null) return state;
    const skipped = state.results.some((r) => r.stepId === attempt.stepId)
      ? state
      : { ...state, results: [...state.results, { stepId: attempt.stepId, trackId: attempt.trackId, result: "skipped" as const, reason: "address on the provider's block list", at, atWall, attemptId: attempt.id }] };
    return checkEndings(finishTrack(skipped, attempt.trackId, "skipped_missing_channel", at, atWall), now);
  }
  // A LinkedIn message refused because the connection is gone (ADR 0004 2.2, question Q37): the track fails, the profile
  // stays good (it is still theirs), and the lead's other tracks continue.
  if (reason === "not_connected" && rules.notConnectedMarksBad) return applyBadDestination(state, attempt, now);
  if (reason === "not_connected") {
    if (!progress || progress.finishedAt !== null) return state;
    const failed = state.results.some((r) => r.stepId === attempt.stepId)
      ? state
      : { ...state, results: [...state.results, { stepId: attempt.stepId, trackId: attempt.trackId, result: "failed" as const, reason: "not connected", at, atWall, attemptId: attempt.id }] };
    return checkEndings(finishTrack(failed, attempt.trackId, "failed_bad_destination", at, atWall), now);
  }
  // A message the platform does not let this session send to this account (ADR 0004 13.3, question Q44): requests turned
  // off, or a sender that cannot start a conversation there. The track fails, the account stays good (it is still theirs).
  if (reason === "not_allowed") {
    if (!progress || progress.finishedAt !== null) return state;
    const failed = state.results.some((r) => r.stepId === attempt.stepId)
      ? state
      : { ...state, results: [...state.results, { stepId: attempt.stepId, trackId: attempt.trackId, result: "failed" as const, reason: "not allowed", at, atWall, attemptId: attempt.id }] };
    return checkEndings(finishTrack(failed, attempt.trackId, "failed_bad_destination", at, atWall), now);
  }
  // 402 and 429 wait at the account; an unexplained provider skip holds the track (5.4).
  return state;
}

/**
 * Whether a reply outside any known thread falls back to this provider work (2.4, PR 37 review
 * rounds 2 and 3): work handed over from that inbox to that address at or before the reply, that
 * was sent or is uncertain, counting work the user marked not sent (the mark settles capacity, not
 * the facts); never work the provider refused or confirmed withdrawn, and only while the lead still
 * owns the address.
 */
export function replyMatches(state: SubjectState, work: ProviderWork, reply: { readonly inbox: string; readonly address: string; readonly atWall: number }): boolean {
  const address = reply.address.toLowerCase();
  if (work.accountId !== reply.inbox || work.destination.toLowerCase() !== address) return false;
  if (work.firstHandedWall === null || work.firstHandedWall > reply.atWall) return false;
  const reached = work.settled === null || work.settled === "sent" || work.settled === "user_sent" || work.settled === "user_not_sent" || work.sentWall !== null;
  return reached && state.lead.details.some((d) => d.channel === "email" && d.ownEmail && d.value.toLowerCase() === address);
}

/**
 * The subject an SMS reply belongs to (ADR 0003 4.5): a reply carries only the mobile and the number
 * it reached, so it goes to the owner of that pair's conversation: its unreleased owner, else its
 * most recent released owner (always an ended test run), else nobody. Never to another number's
 * conversation with the same mobile, however recent.
 */
export function smsReplyOwner(bindings: readonly SmsBindingRecord[], sender: string): string | null {
  // A skip owns nothing, and an unsent binding never owned a conversation (question Q7 answered, point 10).
  const pair = bindings.filter((b) => b.kind === "binding" && !b.unsent && b.sender === sender);
  return pair.find((b) => !b.released)?.owner ?? pair.filter((b) => b.released).at(-1)?.owner ?? null;
}

// ---------------------------------------------------------------------------------------------
// The pending step under the definition in force (ADR 0003 "Ticket 19", step 4).

/**
 * Whether a started track's pending step is in flight (ADR 0003 "Ticket 19"): a live attempt past its claim, provider
 * work called and without a final answer, or an open call task. Such a track is left as it is by an edit, and brought
 * in line once that work settles.
 */
export function inFlight(state: SubjectState, trackId: string): boolean {
  return (
    state.attempts.some((a) => a.trackId === trackId && isLive(a) && a.state !== "claimed") ||
    state.work.some((w) => w.trackId === trackId && isUncertain(w)) ||
    state.callTasks.some((t) => t.trackId === trackId && t.open)
  );
}

/** Withdraws the track's `claimed` attempts (ruling 1, 2.5): a later claim renders the definition current at its handover. */
export function withdrawClaims(state: SubjectState, trackId: string): SubjectState {
  let s = state;
  for (const a of state.attempts) {
    if (a.trackId !== trackId || a.state !== "claimed") continue;
    const step = applyAttemptEvent(a, workOf(s, a.idempotencyKey), { kind: "quiesce" });
    s = withWork(withAttempt(s, step.attempt), step.work);
  }
  return s;
}

/**
 * Brings every started, unfinished track that is not in flight in line with the definition in force (ADR 0003
 * "Ticket 19", step 4; invariant 22): its pending step is the step 5.1 names (`nextStepOf`), due at its stored basis
 * plus that step's wait, in the zone its deadline was resolved in. With nothing edited this changes nothing: both hold
 * by construction. When 5.1 names no step (an edit removed every step left), the track finishes at the lead's current
 * instant (question Q23). A change withdraws the track's claim.
 */
export function alignPending(state: SubjectState, now: number): SubjectState {
  let s = realignAcceptance(state, now);
  for (const p of state.tracks) {
    if (p.startedAt === null || p.finishedAt !== null || p.nextStepId === null || p.basisAt === null || p.basisWall === null) continue;
    const track = s.campaign.definition.tracks.find((t) => t.id === p.trackId);
    if (!track || inFlight(s, p.trackId)) continue;
    const want = nextStepOf(s, track);
    if (want === null) {
      const own = s.results.filter((r) => r.trackId === track.id);
      const reason: FinishReason = own.length > 0 && own.every((r) => r.result === "skipped") ? "skipped" : "completed";
      s = finishTrack(withdrawClaims(s, track.id), track.id, reason, leadNow(s.subject.clock, now), wallOfLead(s.subject.clock, now));
      continue;
    }
    const zone = p.dueZone ?? s.lead.zone;
    const wait = waitSpan(s.subject.kind, p.basisWall, track.steps.find((x) => x.id === want)?.waitDays ?? 0, zone);
    if (want === p.nextStepId && p.dueAt === p.basisAt + wait && p.dueWall === p.basisWall + wait && p.dueZone === zone) continue;
    const basisAt = p.basisAt;
    const basisWall = p.basisWall;
    s = withTrack(withdrawClaims(s, track.id), track.id, (t) => ({ ...t, nextStepId: want, dueAt: basisAt + wait, dueWall: basisWall + wait, dueZone: zone }));
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// The claim's step guard and the SMS conversation candidates (ADR 0003 4.2, 4.5). Evaluation reads them to skip a track
// whose mobile's conversation is taken on every number it may use (question Q7 answered); dispatch re-exports them.

export const stepDef = (state: SubjectState, trackId: string, stepId: string) =>
  state.campaign.definition.tracks.find((t) => t.id === trackId)?.steps.find((s) => s.id === stepId);

/** The copy for one step and lead, rendered from the current definition. A text has no subject. */
export function renderStep(state: SubjectState, trackId: string, stepId: string): RenderedCopy | null {
  const step = stepDef(state, trackId, stepId);
  if (!step) return null;
  // A text has no subject; an email renders only a subject it starts (a continuing one has none).
  const channel = channelOf(state, trackId);
  const subject = render(channel === "email" ? ownSubject(step) : "", state.lead.mergeData);
  const body = render(step.body, state.lead.mergeData);
  return subject.ok && body.ok ? { subject: subject.text, body: body.text } : null;
}

/** The thread a continue-thread step continues: the provider reference of the track's latest send. */
export function threadOf(state: SubjectState, trackId: string): string | null {
  const sent = state.work
    .filter((w) => w.trackId === trackId && (w.settled === "sent" || w.settled === "user_sent") && state.attempts.some((a) => a.idempotencyKey === w.key && a.state === "sent"))
    .sort((a, b) => (a.sentWall ?? 0) - (b.sentWall ?? 0));
  return sent.at(-1)?.providerRef ?? null;
}

/** A continue-thread email with no thread to continue is held, not sent (ruling 1). A text has no thread. */
export function lacksThread(state: SubjectState, trackId: string, stepId: string): boolean {
  return channelOf(state, trackId) === "email" && stepDef(state, trackId, stepId)?.threading === "continue_thread" && threadOf(state, trackId) === null;
}

/** The subject's fixed sender on a channel (1.3). */
export function senderOf(state: SubjectState, channel: TrackChannel): string | null {
  switch (channel) {
    case "linkedin":
      return linkedinSessionOf(state);
    case "sms":
      return state.subject.smsSender;
    case "email":
      return state.subject.emailSender;
    case "call":
      return null;
    default:
      return messageSessionOf(state, channel);
  }
}

/**
 * Whether `sender` may text `recipient` for this subject (4.5): the pair has no unreleased owner,
 * or this subject owns it. An enrollment's binding is never transferred.
 */
export function pairFree(state: SubjectState, sender: string, recipient: string, channel: ConversationChannel): boolean {
  return pairsOn(state, channel).every((b) => b.sender !== sender || b.recipient !== recipient || b.owner === state.subject.id);
}

/** The subject's known pairs of one channel only (review bot on b21af02): no rule reads another channel's conversations. */
export function pairsOn(state: SubjectState, channel: ConversationChannel): readonly SmsBinding[] {
  return rules.pairsByChannel ? state.smsBindings.filter((b) => b.channel === channel) : state.smsBindings;
}

/** The mobile an SMS track texts: its destination's key (E.164). */
function recipientOf(state: SubjectState, trackId: string): string | null {
  const id = progressOf(state, trackId)?.destinationDetailId;
  const live = id ? state.lead.resolved[id]?.liveId : undefined;
  return state.lead.details.find((d) => d.id === live)?.key ?? null;
}

/**
 * The accounts a claim for a step on this track may choose from: the fixed sender, else the pool;
 * for SMS, only numbers whose conversation with the mobile is free or this subject's (4.5).
 */
export function candidatesFor(state: SubjectState, trackId: string): string[] {
  const channel = channelOf(state, trackId) ?? "email";
  const fixed = senderOf(state, channel);
  const ids = fixed !== null ? [fixed] : [...trackPoolOf(state, trackId)];
  if (!holdsConversations(channel)) return ids;
  const recipient = recipientOf(state, trackId);
  return recipient === null ? ids : ids.filter((id) => pairFree(state, id, recipient, channel));
}

/** The track's sending window (4.1). */
export function windowOf(state: SubjectState, trackId: string) {
  return state.campaign.definition.tracks.find((t) => t.id === trackId)?.window ?? [];
}

/**
 * The first instant at or after `now` at which the claim's time conditions hold for the track's pending email or text,
 * the lead running (ADR 0003 "Reads that say when"): its wait has ended in lead time, and its track's window is open in
 * the prospect's zone. The claim's step guard refuses "the sending window is closed" exactly when it is not `now`. Null
 * when there is no pending step with a due time, or the window never opens.
 */
export function sendableFrom(state: SubjectState, trackId: string, now: number, from: number = now): number | null {
  const p = progressOf(state, trackId);
  if (!p || p.dueAt === null) return null;
  const dueWall = now + Math.max(0, p.dueAt - leadNow(state.subject.clock, now));
  return windowOpensAt(windowOf(state, trackId), state.lead.zone, Math.max(dueWall, from));
}

/** The claim's step guard (4.2 step 1). Null when it holds; otherwise why not. */
export function claimRefusal(state: SubjectState, item: { readonly trackId: string; readonly stepId: string }, now: number): string | null {
  if (!runs(state)) return "the lead is not running";
  const p = progressOf(state, item.trackId);
  if (!p || p.startedAt === null || p.finishedAt !== null) return "the track is not running";
  if (p.nextStepId !== item.stepId) return "the step is not the track's pending step";
  const step = stepDef(state, item.trackId, item.stepId);
  if (!step || step.removed) return "the step was removed";
  if (state.results.some((r) => r.stepId === item.stepId)) return "the step already has a result";
  if (state.attempts.some((a) => a.stepId === item.stepId && isLive(a))) return "the step already has a live attempt";
  if (p.dueAt === null || p.dueAt > leadNow(state.subject.clock, now)) return "the step is not due";
  // The step's time conditions hold exactly at the instant the reads give (`sendableFrom`, ADR 0003 "Reads that say when").
  if (sendableFrom(state, item.trackId, now) !== now) return "the sending window is closed";
  const dest = p.destinationDetailId ? state.lead.resolved[p.destinationDetailId] : undefined;
  if (!dest || dest.bad || !dest.owned) return "the destination is not a good address of the lead";
  if (!renderStep(state, item.trackId, item.stepId)) return "the copy does not render for this lead";
  if (lacksThread(state, item.trackId, item.stepId)) return "there is no thread to continue";
  return null;
}

/** The numbers an SMS track may text from: the subject's fixed sender, else its pool as the definition holds it now. */
function usableNumbers(state: SubjectState, trackId: string, channel: ConversationChannel): readonly string[] {
  const fixed = senderOf(state, channel);
  return fixed !== null ? [fixed] : trackPoolOf(state, trackId);
}

/** The sender accounts a track of this subject may use (ADR 0004 13.5): its own chosen senders, or its channel's pool. */
export function trackPoolOf(state: SubjectState, trackId: string): readonly string[] {
  const track = state.campaign.definition.tracks.find((t) => t.id === trackId);
  return track ? trackPool(state.campaign.definition, track) : [];
}

/** Another subject's binding of `sender` with the track's mobile, if any. */
function otherBinding(state: SubjectState, sender: string, recipient: string, channel: ConversationChannel): SmsBinding | undefined {
  return pairsOn(state, channel).find((b) => b.sender === sender && b.recipient === recipient && b.owner !== state.subject.id);
}

/**
 * Whether the track's pending step would be claimed now but for its numbers (ADR 0003, question Q7 answered): the claim's
 * step guard holds, the track may use at least one number (never vacuously), and none is a candidate: each is in another
 * subject's conversation with the mobile. Null when not; otherwise the bindings that take them.
 */
function blockedNumbers(state: SubjectState, trackId: string, now: number): SmsBinding[] | null {
  const channel = channelOf(state, trackId);
  if (!holdsConversations(channel)) return null;
  const stepId = progressOf(state, trackId)?.nextStepId;
  if (!stepId || claimRefusal(state, { trackId, stepId }, now) !== null) return null;
  const numbers = usableNumbers(state, trackId, channel);
  const recipient = recipientOf(state, trackId);
  if (numbers.length === 0 || recipient === null || candidatesFor(state, trackId).length > 0) return null;
  return numbers.flatMap((n) => otherBinding(state, n, recipient, channel) ?? []);
}

/**
 * Whether an SMS track's mobile is in another subject's conversation on every number it may use, at the moment its
 * pending step's claim would be made, each owner's text known sent (question Q7 answered; point 10: a conversation
 * exists once a text is known to have gone). A free number's capacity, pacing, health or wait never makes it taken.
 */
export function conversationTaken(state: SubjectState, trackId: string, now: number): boolean {
  const blocked = blockedNumbers(state, trackId, now);
  return blocked !== null && blocked.length > 0 && blocked.every(isConversation);
}

/**
 * Whether the track waits on another subject's first text whose fate is not known yet (question Q7 answered, point 10):
 * every number is in another subject's conversation, and some owner's text on it is not known sent. No final decision
 * is taken on it; the track is held, with that reason, until the work settles: then it is skipped, or the binding,
 * released as unsent, leaves the number free.
 */
export function conversationUnsettled(state: SubjectState, trackId: string, now: number): boolean {
  const blocked = blockedNumbers(state, trackId, now);
  return blocked !== null && blocked.some((b) => !isConversation(b));
}

/**
 * Whether a binding is a conversation (question Q7 answered, point 10 and the ruling on faac357): its owner's text there
 * is known sent, or a reply has come on the pair since it was taken, which proves the text went.
 */
export const isConversation = (b: Pick<SmsBinding, "ownerSent" | "ownerAnswered">): boolean => b.ownerSent || b.ownerAnswered;

/**
 * Whether the subject's own binding owns no conversation (question Q7 answered, point 10): none of its texts on the pair
 * was sent, and none may still go (every piece of its work there settled not sent). It is then released, as unsent.
 */
export function bindingUnsent(state: SubjectState, binding: Pick<SmsBinding, "sender" | "recipient" | "ownerAnswered">): boolean {
  // Answered: a reply came on the pair, so a text went whatever the work says; it stays the owner's for good.
  if (binding.ownerAnswered) return false;
  const notSent = (w: ProviderWork) => w.settled !== null && w.settled !== "sent" && w.settled !== "user_sent" && w.sentWall === null;
  // A LinkedIn invite withdrawn and never accepted leaves no conversation (ADR 0004, question Q41): the pair is free again.
  const withdrawnUnaccepted = (w: ProviderWork) => {
    const p = progressOf(state, w.trackId);
    return w.kind === "invite" && p?.inviteWithdrawal === "withdrawn" && (p.acceptedWall ?? null) === null && (p.connection ?? null) === null;
  };
  // A LinkedIn track skipped as already connected owns the pair from the skip: the connection is the conversation.
  if (state.tracks.some((p) => p.connection === "already_connected" && recipientOf(state, p.trackId) === binding.recipient)) return false;
  return state.work.filter((w) => w.accountId === binding.sender && w.destination === binding.recipient).every((w) => notSent(w) || withdrawnUnaccepted(w));
}

/**
 * Whether two loads of a subject read the same SMS conversations (question Q7 answered): the same bindings of its mobiles,
 * by number, mobile and owner, each with the same answer to whether its owner's text is known sent. A binding taken,
 * released or found sent between an evaluation and its write makes them differ, and the write is refused.
 */
export function sameConversations(a: SubjectState, b: SubjectState): boolean {
  const key = (s: SubjectState) => s.smsBindings.map((x) => `${x.channel}|${x.sender}|${x.recipient}|${x.owner}|${x.ownerSent ? 1 : 0}|${x.ownerAnswered ? 1 : 0}`).sort().join("\n");
  return key(a) === key(b);
}

/** Releases the subject's own bindings that own no conversation (`bindingUnsent`), in the write that settles their work. */
export function releaseUnsentBindings(state: SubjectState): SubjectState {
  const keep = state.smsBindings.filter((b) => b.owner !== state.subject.id || !bindingUnsent(state, b));
  return keep.length === state.smsBindings.length ? state : { ...state, smsBindings: keep };
}

/** A campaign whose subject owns a mobile's SMS conversation, as a skipped track's reason names it. */
export interface ConversationOwner {
  readonly campaignId: string;
  readonly name: string;
  /** The owner is that campaign's test run. */
  readonly test: boolean;
  /**
   * A lead of this same campaign owns it (verifier on f2824d4, item 9): its name as stored with the cause, "" when a cause
   * stored before names were kept has none. Null when the owner is another campaign or a test run: the campaign is named.
   */
  readonly lead: string | null;
}

/** The owner as said: a lead of the subject's own campaign by its name, else the owner's campaign (item 9). */
function ownerOf(state: SubjectState, c: { readonly owner: string; readonly ownerCampaignId: string | null; readonly ownerCampaignName: string | null; readonly ownerIsTest: boolean; readonly ownerLeadName?: string | null }): ConversationOwner | null {
  if (c.ownerCampaignId === null || c.ownerCampaignName === null) return null;
  const lead = !c.ownerIsTest && c.ownerCampaignId === state.campaign.id ? (c.ownerLeadName ?? "") : null;
  return { campaignId: c.ownerCampaignId, name: c.ownerCampaignName, test: c.ownerIsTest, lead };
}
const sameOwnerAs = (a: ConversationOwner, b: ConversationOwner): boolean => a.campaignId === b.campaignId && a.test === b.test && a.lead === b.lead;

/**
 * Who owned the conversation a track was skipped for (ADR 0003, question Q7 answered), once each, in the order the skip
 * recorded them: from the cause stored with the skip, never from the bindings or the pool as they are now, so a pool
 * edit, a test run ending or a campaign renamed since leaves the reason as it was. The name is the campaign's name at the
 * skip, so it stays even if that campaign is renamed or no longer exists. Empty for any other finish.
 */
export function conversationOwnersOf(state: SubjectState, trackId: string): ConversationOwner[] {
  const p = progressOf(state, trackId);
  if (p?.finishReason !== "skipped_conversation_taken") return [];
  const owners: ConversationOwner[] = [];
  for (const c of p.conversationOwners ?? []) {
    const o = ownerOf(state, c);
    if (o && !owners.some((x) => sameOwnerAs(x, o))) owners.push(o);
  }
  return owners;
}

/**
 * Whose first text the track waits on (`sms_conversation_unsettled`, point 10): the campaigns of the subjects holding its
 * numbers whose text there is not known sent and not answered yet, once each. Empty when the track is not so held.
 */
export function unsettledOwnersOf(state: SubjectState, trackId: string, now: number): ConversationOwner[] {
  const owners: ConversationOwner[] = [];
  for (const b of (blockedNumbers(state, trackId, now) ?? []).filter((x) => !isConversation(x))) {
    const o = ownerOf(state, b);
    if (o && !owners.some((x) => sameOwnerAs(x, o))) owners.push(o);
  }
  return owners;
}

/**
 * When an evaluation that changed nothing must look at the subject again for the skip of question Q7, though none of
 * its own facts changes: each SMS track waiting to hand over its pending step (started, unfinished, due or not yet,
 * no live attempt) falls due for the check at its due instant, then whenever its window opens; and another subject's
 * new conversation with the mobile may take its last free number (`onNewBinding`). `at` is null when no instant applies.
 */
export function conversationRecheck(state: SubjectState, now: number): { readonly at: number | null; readonly onNewBinding: boolean } {
  if (!runs(state)) return { at: null, onNewBinding: false };
  const lead = leadNow(state.subject.clock, now);
  let at: number | null = null;
  let onNewBinding = false;
  for (const track of liveTracksFor(state)) {
    const p = progressOf(state, track.id);
    if (!holdsConversations(track.channel) || !p || p.startedAt === null || p.finishedAt !== null || p.nextStepId === null || p.dueAt === null) continue;
    const stepId = p.nextStepId;
    if (state.attempts.some((a) => a.stepId === stepId && isLive(a))) continue;
    onNewBinding = true;
    const due = now + (p.dueAt - lead);
    const next = due > now ? due : nextWindowOpen(track.window, state.lead.zone, now);
    if (next !== null && next > now && (at === null || next < at)) at = next;
  }
  return { at, onNewBinding };
}

/**
 * How long an evaluation that changed nothing holds (ADR 0003, question Q7 answered, "One rule for the evaluation
 * caches"). The worker's evaluation cache and the Before launch projection's both settle a subject with this function
 * and look at it again with `stillSettled`, so the two cannot look at different instants or facts: until its next delayed
 * track start, its user's next day while a call task is open (the skip limit), its waiting SMS track's due instant or
 * window opening; and, while an SMS or LinkedIn track waits to hand over, until the conversations it could read change:
 * the versions of its own destinations' pairs (`conversationKeysOf`; ADR 0004, "The conversations' version"), remembered
 * with the keys they were read for. Null when no conversation matters.
 */
export interface SettledEvaluation {
  readonly until: number;
  readonly conversations: string | null;
  /** The destinations whose pairs it read (its own mobiles and profiles, and where its attempts went). */
  readonly conversationKeys?: readonly string[];
}

/**
 * The conversations' versions as a cache reads them (ADR 0004, "The conversations' version"): for the given destinations,
 * the version of each one's pairs, as one string. The worker reads the store's per-destination versions; the projection
 * its own.
 */
export type ConversationVersions = (destinations: readonly string[]) => string;

/**
 * The destinations whose pairs a subject could take or wait on: its lead's mobiles and profiles (every detail's key), and
 * where its attempts went. Another subject's write to a pair of one of these moves its version; nothing else does.
 */
export function conversationKeysOf(state: SubjectState): string[] {
  if (rules.conversationKeysOwnOnly) return [...new Set(state.smsBindings.filter((b) => b.owner === state.subject.id).map((b) => b.recipient))].sort();
  return [...new Set([...state.lead.details.map((d) => d.key), ...state.attempts.map((a) => a.destination)])].sort();
}

function remembered(state: SubjectState, matters: boolean, conversations: ConversationVersions): Pick<SettledEvaluation, "conversations" | "conversationKeys"> {
  if (!matters) return { conversations: null };
  const keys = conversationKeysOf(state);
  return { conversations: conversations(keys), conversationKeys: keys };
}

export function settledEvaluation(state: SubjectState, now: number, nextUserDay: number, conversations: ConversationVersions): SettledEvaluation {
  const lead = leadNow(state.subject.clock, now);
  const at = state.tracks.filter((p) => p.startedAt === null && p.startAt !== null).map((p) => now + ((p.startAt ?? 0) - lead));
  // A LinkedIn invite's acceptance deadline: the evaluation at it finishes the track (ADR 0004 3.3).
  for (const p of state.tracks) if (awaitingAcceptance(state, p.trackId) && p.acceptBy != null) at.push(now + (p.acceptBy - lead));
  if (state.callTasks.some((t) => t.open)) at.push(nextUserDay);
  const recheck = conversationRecheck(state, now);
  if (recheck.at !== null) at.push(recheck.at);
  return { until: Math.min(Infinity, ...at.filter((t) => t > now)), ...remembered(state, recheck.onNewBinding, conversations) };
}
/**
 * How long a readiness check that found nothing to claim holds (the worker's `nothingReady`, the projection's `ready`):
 * until the subject's next due step or delayed track start, and, while an SMS track waits to hand over, until the
 * conversations change: a hold on an unsettled conversation (`sms_conversation_unsettled`) makes `readyItems` return
 * nothing, and a release or a text found sent changes that with no change to the subject itself.
 */
export function settledReadiness(state: SubjectState, now: number, conversations: ConversationVersions): SettledEvaluation {
  const lead = leadNow(state.subject.clock, now);
  const at = [
    // An invite held as pending elsewhere is checked again at the end of its settling period (question Q42's interim).
    ...state.tracks.flatMap((p) => invitePendingUntil(state, p.trackId) ?? []),
    // A clear connection check stands for a settling period; then the invite is checked again before it is claimed.
    ...state.tracks.flatMap((p) => Object.values(p.connectionChecks ?? {}).map((c) => c.checkedWall + ENGINE_PARAMS.SETTLING)),
    ...state.tracks.filter((p) => p.finishedAt === null && p.dueAt !== null).map((p) => now + ((p.dueAt ?? 0) - lead)),
    ...state.tracks.filter((p) => p.startedAt === null && p.startAt !== null).map((p) => now + ((p.startAt ?? 0) - lead)),
  ];
  return { until: Math.min(Infinity, ...at.filter((t) => t > now)), ...remembered(state, conversationRecheck(state, now).onNewBinding, conversations) };
}

/** Whether a settled evaluation still holds at `now`, with its own destinations' conversations as they are now. */
export function stillSettled(entry: SettledEvaluation, now: number, conversations: ConversationVersions): boolean {
  return now < entry.until && (entry.conversations === null || entry.conversations === conversations(entry.conversationKeys ?? []));
}

/**
 * Skips every SMS track whose conversation is taken (`conversationTaken`), at the evaluation's instant, with no step
 * result: like a missing channel, nothing of the track is sent. The skip is final (a finished track never restarts).
 */
export function skipTakenConversations(state: SubjectState, now: number): SubjectState {
  let s = state;
  for (const track of liveTracksFor(s)) {
    if (!conversationTaken(s, track.id, now)) continue;
    // The cause is recorded with the skip, as it is now: each number's owner and its campaign's name.
    const cause: ConversationCause[] = (blockedNumbers(s, track.id, now) ?? []).map((b) => ({
      sender: b.sender,
      recipient: b.recipient,
      owner: b.owner,
      ownerCampaignId: b.ownerCampaignId,
      ownerCampaignName: b.ownerCampaignName,
      ownerIsTest: b.ownerIsTest,
      ownerLeadName: b.ownerLeadName ?? null,
    }));
    s = withTrack(finishTrack(s, track.id, "skipped_conversation_taken", leadNow(s.subject.clock, now), wallOfLead(s.subject.clock, now)), track.id, (t) => ({ ...t, conversationOwners: cause }));
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// Holds (5.4), derived.

export type HoldReason = "unresolved" | "render_failed" | "provider_skipped" | "no_thread" | "sms_conversation_unsettled" | "invite_pending_elsewhere";

/** Why a started, unfinished track cannot proceed without guessing or the user, or null. */
export function trackHold(state: SubjectState, trackId: string): HoldReason | null {
  const progress = progressOf(state, trackId);
  if (!progress || progress.finishedAt !== null || progress.nextStepId === null) return null;
  const attempts = state.attempts.filter((a) => a.stepId === progress.nextStepId);
  if (attempts.some((a) => isLive(a) && state.work.some((w) => w.key === a.idempotencyKey && w.unresolvedSince !== null && w.settled === null))) return "unresolved";
  const latest = attempts.at(-1);
  if (latest && latest.state === "rejected" && latest.rejectReason === "provider_skipped") return "provider_skipped";
  // The step's latest work was skipped by the provider, whichever of its attempts handed it over.
  const work = state.work.filter((w) => w.stepId === progress.nextStepId).at(-1);
  if (work?.settled === "rejected" && attempts.some((a) => a.idempotencyKey === work.key && a.rejectReason === "provider_skipped")) return "provider_skipped";
  return null;
}

export const channelOf = (state: SubjectState, trackId: string): TrackChannel | undefined => state.campaign.definition.tracks.find((t) => t.id === trackId)?.channel;

export function stepsOf(state: SubjectState, trackId: string) {
  const track = state.campaign.definition.tracks.find((t) => t.id === trackId);
  return track ? liveSteps(track) : [];
}

// ---------------------------------------------------------------------------------------------
// The LinkedIn track (ADR 0004 section 3): the connection, the acceptance deadline and its expiry.

/** A LinkedIn track whose invite was sent and which is not connected yet, unfinished: its first message has no due time. */
export function awaitingAcceptance(state: SubjectState, trackId: string): boolean {
  const p = progressOf(state, trackId);
  const track = state.campaign.definition.tracks.find((t) => t.id === trackId);
  if (!p || !track || track.channel !== "linkedin" || p.startedAt === null || p.finishedAt !== null) return false;
  return (p.connection ?? null) === null && (p.acceptBy ?? null) !== null;
}

/**
 * The acceptance deadline (ADR 0004 3.2): the invite's send point plus the track's acceptance wait in calendar days in the
 * prospect's zone, in lead time. Not cut short for a test run (question Q40): a person accepts the test invite by hand.
 */
export function acceptDeadline(state: SubjectState, track: TrackDefinition, at: number, atWall: number): Pick<TrackProgress, "acceptBy" | "acceptByWall" | "acceptByZone" | "acceptByDays"> {
  const zone = state.lead.zone;
  const days = track.acceptWaitDays ?? 1;
  const s = span(atWall, days, zone);
  return { acceptBy: at + s, acceptByWall: atWall + s, acceptByZone: zone, acceptByDays: days };
}

/** The invite's own sent result on the track, if any: the basis of its acceptance deadline. */
export function inviteResult(state: SubjectState, track: TrackDefinition): StepResult | undefined {
  return state.results.find((r) => r.trackId === track.id && linkedinStepKind(track, r.stepId) === "invite");
}

/**
 * The connection (ADR 0004 3.3): stored once on the track, at its point on the lead's clock, and the first message (the step
 * 5.1 names now) resolved from it with its own wait, whether or not the lead runs, as a send's successor is (ADR 0003 2.4).
 */
export function connect(state: SubjectState, trackId: string, how: "accepted" | "already_connected", at: number, atWall: number): SubjectState {
  const p = progressOf(state, trackId);
  const track = state.campaign.definition.tracks.find((t) => t.id === trackId);
  if (!p || !track || p.finishedAt !== null || (p.connection ?? null) !== null) return state;
  const connected = withTrack(state, trackId, (t) => ({ ...t, connection: how, connectedAt: at, connectedWall: atWall, nextStepId: null, dueAt: null, dueWall: null, dueZone: null, basisAt: null, basisWall: null }));
  return advanceTrack(connected, track, at, atWall);
}

/**
 * An acceptance the platform reports, at its own time `providerTime` (ADR 0004 3.3). Always recorded as a fact on the track
 * (`acceptedWall`). It connects the track only while the track awaits acceptance and the acceptance came before the
 * deadline, read on the lead's clock: an acceptance after the deadline, or on a finished track, starts nothing.
 */
export function recordAcceptance(state: SubjectState, trackId: string, providerTime: number, handedWall: number, now: number, point: typeof sendPoint = sendPoint): SubjectState {
  const p = progressOf(state, trackId);
  if (!p) return state;
  const s = (p.acceptedWall ?? null) === null ? withTrack(state, trackId, (t) => ({ ...t, acceptedWall: Math.min(Math.max(providerTime, handedWall), now) })) : state;
  if (!awaitingAcceptance(s, trackId)) return s;
  const at = point(s.subject.clock, s.freezes, providerTime, handedWall, now);
  if (at.at >= (p.acceptBy ?? Infinity)) return s;
  return connect(s, trackId, "accepted", at.at, at.atWall);
}

/**
 * The acceptance expiry with the fallback off (ADR 0004 3.3; ticket 27 attaches here): the invite is to be withdrawn, and the
 * track finishes `invite_not_accepted` at the deadline, in lead time and the wall instant it stood at, so what waits on it
 * starts after its delay from then. The lead's other tracks carry on; the endings are checked after it by evaluation.
 */
export function inviteExpired(state: SubjectState, trackId: string, now: number): SubjectState {
  const p = progressOf(state, trackId);
  if (!p || (p.acceptBy ?? null) === null) return state;
  const at = p.acceptBy ?? 0;
  const atWall = wallAtLead(state.subject.clock, state.freezes, at, now);
  const wanted = withTrack(state, trackId, (t) => ({ ...t, inviteWithdrawal: "wanted", inviteWithdrawalLastWall: null }));
  return finishTrack(wanted, trackId, "invite_not_accepted", at, atWall);
}

/**
 * The sender is already connected to the profile, found by the pre-send check at the invite's slot (ADR 0004 3.3): in the
 * handover's own write, no provider call. The claim is withdrawn (its reservation released), the invite gets the result
 * skipped, `already_connected`, and the track is connected at that instant, so the first message follows with its wait.
 */
export function inviteAlreadyConnected(state: SubjectState, attemptId: string, now: number): SubjectState {
  const a = state.attempts.find((x) => x.id === attemptId);
  if (!a || a.state !== "claimed") return state;
  const step = applyAttemptEvent(a, workOf(state, a.idempotencyKey), { kind: "quiesce" });
  let s = withWork(withAttempt(state, { ...step.attempt, endedBy: "guard" }), step.work);
  const at = leadNow(s.subject.clock, now);
  const atWall = wallOfLead(s.subject.clock, now);
  if (!s.results.some((r) => r.stepId === a.stepId)) s = { ...s, results: [...s.results, { stepId: a.stepId, trackId: a.trackId, result: "skipped", reason: "already_connected", at, atWall, attemptId: a.id }] };
  // The conversation is taken in this same write, as a handover takes it (ADR 0004, question Q41): the session and the
  // profile are this subject's from the skip, and the sender is fixed.
  const binds = !s.smsBindings.some((b) => b.sender === a.accountId && b.recipient === a.destination);
  s = {
    ...s,
    subject: { ...s.subject, linkedinSender: s.subject.linkedinSender ?? a.accountId },
    smsBindings: binds ? [...s.smsBindings, { sender: a.accountId, recipient: a.destination, owner: s.subject.id, ownerCampaignId: s.campaign.id, ownerCampaignName: null, ownerIsTest: s.subject.kind === "test_run", ownerEnded: false, ownerSent: true, ownerAnswered: false, channel: "linkedin" as const }] : s.smsBindings,
  };
  return attend(connect(s, a.trackId, "already_connected", at, atWall), now);
}

/** An invite withdrawal's answer (ADR 0004 3.3): withdrawn, found accepted first (recorded as a fact), or asked again later. */
export function inviteWithdrawalAnswer(state: SubjectState, trackId: string, answer: "withdrawn" | "already_accepted" | "unknown", now: number, acceptedAt: number | null = null): SubjectState {
  const p = progressOf(state, trackId);
  if (!p || p.inviteWithdrawal !== "wanted") return state;
  if (answer === "unknown") return withTrack(state, trackId, (t) => ({ ...t, inviteWithdrawalLastWall: now, inviteWithdrawalUnknowns: (t.inviteWithdrawalUnknowns ?? 0) + 1 }));
  if (answer === "withdrawn") return withTrack(state, trackId, (t) => ({ ...t, inviteWithdrawal: "withdrawn", inviteWithdrawalLastWall: now }));
  return withTrack(state, trackId, (t) => ({ ...t, inviteWithdrawal: "accepted_first", inviteWithdrawalLastWall: now, acceptedWall: t.acceptedWall ?? acceptedAt ?? now }));
}

/** Whether a track's invite withdrawal is to be asked of the session at `now`: wanted, and not answered unknown within a settling period. */
export function inviteWithdrawalDue(p: TrackProgress, now: number): boolean {
  return p.inviteWithdrawal === "wanted" && ((p.inviteWithdrawalLastWall ?? null) === null || now >= (p.inviteWithdrawalLastWall ?? 0) + ENGINE_PARAMS.SETTLING);
}

/** After this many unknown answers in a row, a withdrawal is listed for the user (ADR 0004 3.3; council on 194fc44, item 5). */
export const INVITE_WITHDRAWAL_UNKNOWNS = 3;

/** Whether a wanted withdrawal has stayed unknown for INVITE_WITHDRAWAL_UNKNOWNS answers: Needs attention lists it. */
export const inviteWithdrawalStuck = (p: TrackProgress): boolean => p.inviteWithdrawal === "wanted" && (p.inviteWithdrawalUnknowns ?? 0) >= INVITE_WITHDRAWAL_UNKNOWNS;

/**
 * The user settles a withdrawal the session cannot answer (ADR 0004 3.3): they checked LinkedIn, and the invite is gone
 * (`withdrawn`, which frees the pair if it was never accepted) or still there (`kept`, which stops the asking and keeps the
 * pair the lead's). Only while the withdrawal is wanted.
 */
export function markInviteWithdrawal(state: SubjectState, trackId: string, answer: "withdrawn" | "kept", now: number): SubjectState | null {
  const p = progressOf(state, trackId);
  if (!p || p.inviteWithdrawal !== "wanted") return null;
  return withTrack(state, trackId, (t) => ({ ...t, inviteWithdrawal: answer === "withdrawn" ? "withdrawn" : "kept_by_user", inviteWithdrawalLastWall: now }));
}

/**
 * An invite to the profile already pending on LinkedIn that this application did not send (the pre-send check's `pending`,
 * question Q42's interim): never sent again. The claim is withdrawn, the sighting recorded, and the invite step held, checked
 * again one settling period later; once the person accepts, the check answers `connected` (a connection that existed before
 * this application reached them), and the invite is skipped as already connected.
 */
export function invitePendingElsewhere(state: SubjectState, attemptId: string, now: number): SubjectState {
  const a = state.attempts.find((x) => x.id === attemptId);
  if (!a || a.state !== "claimed") return state;
  const step = applyAttemptEvent(a, workOf(state, a.idempotencyKey), { kind: "quiesce" });
  const s = withWork(withAttempt(state, { ...step.attempt, endedBy: "guard" }), step.work);
  return attend(recordCheck(s, a.trackId, a.accountId, "pending", now), now);
}

/**
 * Whether the track's invite is held as pending elsewhere, and until its next check (question Q42's interim, per session;
 * review bot on e261ffa): only when no session can invite, that is every healthy session it may use has last answered
 * `pending`. A session not yet checked, or one that answered `clear` (with invite room or not), is a session that may
 * invite, so the track does not hold on another session's answer: it waits for that check, or for that session's room.
 * Null when not held; otherwise the earliest instant one of those sessions is due a check again.
 */
export function invitePendingUntil(state: SubjectState, trackId: string): number | null {
  const p = progressOf(state, trackId);
  const track = state.campaign.definition.tracks.find((t) => t.id === trackId);
  if (!p || !track || p.nextStepId === null || linkedinStepKind(track, p.nextStepId) !== "invite") return null;
  const sessions = checkedSessions(state, trackId);
  if (sessions.length === 0) return null;
  const answers = sessions.map((id) => checkOf(p, id));
  if (answers.some((c) => c?.answer !== "pending")) return null;
  return Math.min(...answers.map((c) => (c?.checkedWall ?? 0) + ENGINE_PARAMS.SETTLING));
}

/** The healthy sessions a track's invite may go from: the ones its connection checks ask (its fixed sender, else its pool). */
function checkedSessions(state: SubjectState, trackId: string): string[] {
  return candidatesFor(state, trackId).filter((id) => state.accounts[id]?.healthy === true);
}

/** A session's latest check of the track's profile: its own, or under the mutation the one answer kept for the track. */
export function checkOf(p: TrackProgress, session: string): ConnectionCheck | undefined {
  return p.connectionChecks?.[rules.checksPerSession ? session : TRACK_CHECK];
}

/** The key the mutation keeps one answer under. */
const TRACK_CHECK = "*";

const fresh = (c: ConnectionCheck | undefined, now: number): c is ConnectionCheck => c !== undefined && now < c.checkedWall + ENGINE_PARAMS.SETTLING;

/** The track's invite is decided only once every session it may use has an answer within a settling period. */
function checksComplete(state: SubjectState, trackId: string, now: number): boolean {
  const p = progressOf(state, trackId);
  return !!p && checkedSessions(state, trackId).every((id) => fresh(checkOf(p, id), now));
}

/**
 * The sessions an invite may be claimed on (review bot on e261ffa): with every session's answer fresh, those whose answer
 * is `clear`; the account choice then picks among them by room, as for any step. Before the checks are complete nothing
 * claims the invite (`readyItems`), and the reads judge every candidate.
 */
export function inviteSessions(state: SubjectState, trackId: string, ids: readonly string[], now: number): string[] {
  const p = progressOf(state, trackId);
  if (!p) return [...ids];
  // Every session's latest answer, fresh or not (the search on e261ffa, seed 24062): outside the window the answers age
  // unasked, and a read still judges the invite's room on the sessions that may send it. A claim waits for fresh answers
  // (`inviteClaimable`), so only reads see an aged one. With a session never asked, every session is still a candidate.
  const answered = checkedSessions(state, trackId).every((id) => checkOf(p, id) !== undefined);
  if (!answered && !checksComplete(state, trackId, now)) return [...ids];
  return ids.filter((id) => checkOf(p, id)?.answer === "clear");
}

/** Whether the track's pending invite may be claimed now: every session checked within a settling period, one of them clear. */
export function inviteClaimable(state: SubjectState, trackId: string, now: number): boolean {
  const p = progressOf(state, trackId);
  return !!p && checksComplete(state, trackId, now) && checkedSessions(state, trackId).some((id) => checkOf(p, id)?.answer === "clear");
}

/** Records one session's answer (or, under the mutation, the track's one answer). */
function recordCheck(state: SubjectState, trackId: string, session: string, answer: "clear" | "pending", now: number): SubjectState {
  const key = rules.checksPerSession ? session : TRACK_CHECK;
  return withTrack(state, trackId, (t) => {
    const was = t.connectionChecks?.[key];
    const check: ConnectionCheck = { answer, checkedWall: now, pendingSince: answer === "pending" ? (was?.answer === "pending" ? was.pendingSince : now) : null };
    return { ...t, connectionChecks: { ...(t.connectionChecks ?? {}), [key]: check } };
  });
}

/**
 * The LinkedIn session a subject's track goes from (ADR 0004 6; review bot on 194fc44, item 10): the session of its own
 * conversation with its profile, taken in the write that first reaches it (the invite's handover, or the already-connected
 * skip). One fact: the connection, the pair and the sender are that binding. Every later message goes from it, or waits for
 * it (a fixed sender that is full, unavailable or removed from the pool keeps it, by ADR 0003 5.2's rule). Null before.
 */
export function linkedinSessionOf(state: SubjectState): string | null {
  // Only LinkedIn pairs, and only the LinkedIn tracks' profiles (review bot on b21af02: an SMS pair is never a session).
  const profiles = new Set(state.lead.details.filter((d) => d.channel === "linkedin").map((d) => d.key));
  for (const p of state.tracks) {
    if (channelOf(state, p.trackId) !== "linkedin") continue;
    const key = recipientOf(state, p.trackId);
    if (key !== null) profiles.add(key);
  }
  // The mutation (`pairsByChannel` false) is the review bot's bug itself: any pair the subject owns, whatever its channel.
  if (!rules.pairsByChannel) return state.smsBindings.find((b) => b.owner === state.subject.id)?.sender ?? state.subject.linkedinSender ?? null;
  return pairsOn(state, "linkedin").find((b) => b.owner === state.subject.id && profiles.has(b.recipient))?.sender ?? state.subject.linkedinSender ?? null;
}

/**
 * The session a subject's message-request track goes from (ADR 0004 13.5): the session of its own conversation with one of
 * its accounts on the channel, else the one stored at its first handover there. Fixed once, never reassigned. Null before.
 */
export function messageSessionOf(state: SubjectState, channel: MessageRequestChannel): string | null {
  const accounts = new Set(state.lead.details.filter((d) => d.channel === channel).map((d) => d.key));
  for (const p of state.tracks) {
    if (channelOf(state, p.trackId) !== channel) continue;
    const key = recipientOf(state, p.trackId);
    if (key !== null) accounts.add(key);
  }
  const stored = state.subject.socialSenders?.[channel] ?? null;
  if (!rules.pairsByChannel) return state.smsBindings.find((b) => b.owner === state.subject.id)?.sender ?? stored;
  return pairsOn(state, channel).find((b) => b.owner === state.subject.id && accounts.has(b.recipient))?.sender ?? stored;
}

/** The subject with its sender on a social channel fixed, if it had none (ADR 0004 6, 13.5): the one write of it. */
export function withSocialSender(state: SubjectState, channel: SocialChannel, session: string): SubjectState {
  if (channel === "linkedin") return { ...state, subject: { ...state.subject, linkedinSender: state.subject.linkedinSender ?? session } };
  if (state.subject.socialSenders?.[channel] !== undefined) return state;
  return { ...state, subject: { ...state.subject, socialSenders: { ...state.subject.socialSenders, [channel]: session } } };
}

/**
 * A running edit of a LinkedIn track's acceptance wait (ADR 0004 3.2; council on 194fc44, item 3): every track still waiting
 * for acceptance has its deadline re-resolved from its invite's send point with the wait in force, in the zone it was
 * resolved in. A new deadline already passed is the lead's present instant, so it expires at the next evaluation, once, and
 * never in the past. With nothing edited this changes nothing.
 */
export function realignAcceptance(state: SubjectState, now: number): SubjectState {
  let s = state;
  for (const p of state.tracks) {
    if (!awaitingAcceptance(s, p.trackId) || p.acceptBy == null) continue;
    const track = s.campaign.definition.tracks.find((t) => t.id === p.trackId);
    // The pending message is the step 5.1 names under the definition in force (verifier on 194fc44, item 14): an edit that
    // removes or reorders messages moves it; one that removes every message left finishes the track, as alignPending does.
    if (track) {
      const want = nextStepOf(s, track);
      if (want === null) {
        s = finishTrack(s, track.id, "completed", leadNow(s.subject.clock, now), wallOfLead(s.subject.clock, now));
        continue;
      }
      if (want !== p.nextStepId) s = withTrack(s, track.id, (t) => ({ ...t, nextStepId: want }));
    }
    const sent = track ? inviteResult(s, track) : undefined;
    if (!track || !sent || sent.result !== "sent") continue;
    // Stored once (council on b21af02, item 8): re-resolved only when the definition's wait differs from the one the stored
    // deadline was resolved with, so a later change of provider work never moves an edited, already-passed deadline again.
    const days = track.acceptWaitDays ?? 1;
    if ((p.acceptByDays ?? days) === days || !rules.waitEditRealigns) continue;
    const zone = p.acceptByZone ?? s.lead.zone;
    const span_ = span(sent.atWall, days, zone);
    const lead = leadNow(s.subject.clock, now);
    const passed = sent.at + span_ < lead;
    const acceptBy = passed ? lead : sent.at + span_;
    const acceptByWall = passed ? wallOfLead(s.subject.clock, now) : sent.atWall + span_;
    s = withTrack(s, p.trackId, (t) => ({ ...t, acceptBy, acceptByWall, acceptByZone: zone, acceptByDays: days }));
  }
  return s;
}

/**
 * The connection check (ADR 0004 3.3 and 6; council on b21af02, item 4): before an invite is claimed, the session is asked
 * whether the person is already connected, or an invite is already pending. It spends no allowance and needs none: it
 * runs whatever the invite allowance, so an existing connection moves the track on to its messages, which spend the
 * message allowance only when one goes. Due for a running subject's LinkedIn track whose pending step is the invite, due
 * and inside its window, with a good profile. Returns the sessions to ask now: every healthy session the track may use (its
 * fixed sender once it has one, else its pool), in the pool's order, whose own answer is older than a settling period.
 */
export function connectionChecksDue(state: SubjectState, trackId: string, now: number): string[] {
  const p = progressOf(state, trackId);
  const track = state.campaign.definition.tracks.find((t) => t.id === trackId);
  if (!p || !track || track.channel !== "linkedin" || p.nextStepId === null || linkedinStepKind(track, p.nextStepId) !== "invite") return [];
  if (claimRefusal(state, { trackId, stepId: p.nextStepId }, now) !== null) return [];
  // Every healthy session it may use, in the pool's order, each whose own answer is older than a settling period (or none).
  const sessions = checkedSessions(state, trackId);
  if (!rules.checksPerSession) return fresh(p.connectionChecks?.[TRACK_CHECK], now) ? [] : sessions.slice(0, 1);
  return sessions.filter((id) => !fresh(p.connectionChecks?.[id], now));
}

/**
 * One session's answer, applied in one write: `connected` skips the invite as already connected, takes the pair and fixes
 * that session as the sender, and the first message follows with its own wait (a connected session is preferred to an
 * invite from another: the invite waits until every session has answered); `pending` and `clear` are kept for that session
 * for one settling period: an invite goes only from a clear session, and the track holds only when every session is
 * pending (`invitePendingUntil`).
 */
export function connectionChecked(state: SubjectState, trackId: string, session: string, destination: string, answer: "connected" | "pending" | "clear", now: number): SubjectState {
  const p = progressOf(state, trackId);
  if (!p || p.nextStepId === null) return state;
  if (answer !== "connected") return recordCheck(state, trackId, session, answer, now);
  const at = leadNow(state.subject.clock, now);
  const atWall = wallOfLead(state.subject.clock, now);
  let s: SubjectState = { ...state, results: [...state.results, { stepId: p.nextStepId, trackId, result: "skipped", reason: "already_connected", at, atWall, attemptId: null }] };
  const binds = !s.smsBindings.some((b) => b.sender === session && b.recipient === destination);
  s = {
    ...s,
    subject: { ...s.subject, linkedinSender: s.subject.linkedinSender ?? session },
    smsBindings: binds ? [...s.smsBindings, { sender: session, recipient: destination, owner: s.subject.id, ownerCampaignId: s.campaign.id, ownerCampaignName: null, ownerIsTest: s.subject.kind === "test_run", ownerEnded: false, ownerSent: true, ownerAnswered: false, channel: "linkedin" as const }] : s.smsBindings,
  };
  return attend(connect(s, trackId, "already_connected", at, atWall), now);
}

/**
 * The invite work that counts for a LinkedIn track (council on a6c1700, item 8): the one known sent (by the session, a lookup
 * or the user's mark), else the latest handed over and not yet settled; never an earlier attempt that settled not sent,
 * withdrawn or refused. The record's read, `inviteOpenOn` and with it the controls' digest read this one choice.
 */
export function invitingWork(state: SubjectState, trackId: string): { readonly work: SubjectState["work"][number]; readonly sent: boolean } | null {
  const handed = state.work.filter((w) => w.trackId === trackId && w.kind === "invite" && w.firstHandedWall !== null);
  const sent = handed.find((w) => w.settled === "sent" || w.settled === "user_sent" || w.sentWall !== null);
  if (sent) return { work: sent, sent: true };
  const open = handed.filter((w) => w.settled === null).sort((a, b) => (b.firstHandedWall ?? 0) - (a.firstHandedWall ?? 0))[0];
  return open ? { work: open, sent: false } : null;
}

/**
 * Whether an invite this subject sent on a LinkedIn track is still open on LinkedIn (ADR 0004 3.4; ticket 24b): sent, not
 * accepted, not connected, not withdrawn and not found accepted. Only the acceptance expiry asks for a withdrawal, so an
 * invite stays open through a stop, a reply, a move to win-back, an ending with no channel or a removing edit. The one test
 * the record's read and the controls' preview digest share.
 */
export function inviteOpenOn(state: SubjectState, trackId: string): boolean {
  const p = state.tracks.find((x) => x.trackId === trackId);
  const sent = invitingWork(state, trackId)?.sent === true;
  const withdrawal = p?.inviteWithdrawal ?? null;
  return sent && p?.acceptedWall == null && (p?.connection ?? null) === null && withdrawal !== "withdrawn" && withdrawal !== "accepted_first";
}

/** Whether any LinkedIn track of the subject has an invite still open on LinkedIn (`inviteOpenOn`). */
export const anyInviteOpen = (state: SubjectState): boolean => state.tracks.some((t) => inviteOpenOn(state, t.trackId));

/**
 * Why a message-request track is skipped as a missing channel, from the facts at its finish (ADR 0004 13.4): an account it
 * started with that is no longer theirs (replaced by another, or emptied by a re-import); every account it could use marked
 * bad; an address that is not an account; or no address in either file.
 */
export function accountSkipCauseOf(state: SubjectState, channel: MessageRequestChannel, startedWith: string | null): SocialSkipCause {
  const imported = state.lead.importedAccounts?.[channel];
  const cells = imported ? [imported.person, imported.company].filter((c): c is NonNullable<typeof c> => c !== null) : [];
  if (startedWith !== null) {
    const ownerCell = startedWith.startsWith(`${channel}:p:`) ? imported?.person : imported?.company;
    return ownerCell === "account" ? "replaced" : "removed_by_import";
  }
  if (state.lead.details.some((d) => d.channel === channel && d.bad)) return "marked_bad";
  return cells.includes("not_account") ? "not_a_member_profile" : "no_profile";
}

/**
 * Why a LinkedIn track is skipped as a missing channel, from the facts at its finish (ticket 24b): a profile it started with
 * that is no longer theirs (another member profile imported since, or none); a bad mark; the import's own address (none,
 * or one that is not a member profile); or a company lead, which has no member profile (Q35).
 */
export function linkedinSkipCauseOf(state: SubjectState, startedWith: string | null): LinkedinSkipCause {
  if (startedWith !== null) return state.lead.importedProfile === "member" ? "replaced" : "removed_by_import";
  if (state.lead.details.some((d) => d.channel === "linkedin" && d.bad)) return "marked_bad";
  switch (state.lead.importedProfile) {
    case undefined:
      return "company_lead";
    case "not_member":
      return "not_a_member_profile";
    case "none":
    case "member":
      return "no_profile";
    default: {
      const unhandled: never = state.lead.importedProfile;
      throw new Error(`An imported profile with no cause: ${String(unhandled)}`);
    }
  }
}
