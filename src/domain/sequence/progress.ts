/**
 * One lead in one campaign (ADR 0003 section 2): the status as a total function of the stored
 * state, the endings, evaluation, and the facts that change progress. Every function is pure:
 * it takes a `SubjectState` and the time, and returns the next `SubjectState`.
 */
import type { OutreachStatus } from "../outreach-status.ts";
import { applyAttemptEvent, isLive, type AttemptEffect, type AttemptEvent } from "./attempt.ts";
import { leadNow, sendPoint, span, syncClock, wallOfLead, type Freeze, type LeadClock } from "./clock.ts";
import { liveSteps, type TrackDefinition } from "./definition.ts";
import type { Attempt, EndReason, FinishReason, LeadDetail, StepResult, SubjectState, TrackProgress } from "./state.ts";

// ---------------------------------------------------------------------------------------------
// Running, status and reach.

/** `runs(s)` (2.2). Ticket 12b has no callback tasks; campaign and lead pauses arrive in #17. */
export function runs(state: SubjectState): boolean {
  const { subject, campaign } = state;
  return campaign.launchedAt !== null && campaign.pausedSince === null && subject.ended === null && !subject.leadPaused;
}

/** The status (2.1): rules in order, first match wins. */
export function deriveStatus(state: SubjectState): OutreachStatus {
  const { subject } = state;
  if (subject.ended !== null) return subject.ended;
  if (subject.leadPaused) return "paused";
  if (subject.branch === "win_back") return "in_win_back";
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

/** Channels in the lead's branch that can reach the lead now (2.1). */
export function reachable(state: SubjectState): Set<string> {
  const channels = new Set<string>();
  for (const track of liveTracksFor(state)) {
    if (track.channel === "email" && goodEmail(state.lead.details)) channels.add("email");
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
    next = withAttempt(next, applyAttemptEvent(attempt, { kind: "quiesce" }).attempt);
  }
  return next;
}

/** A track finishes once and stays finished; finishing quiesces its live attempts (2.3). */
export function finishTrack(state: SubjectState, trackId: string, reason: FinishReason, at: number, atWall: number): SubjectState {
  const progress = progressOf(state, trackId);
  if (!progress || progress.finishedAt !== null) return state;
  return quiesce(withTrack(state, trackId, (t) => ({ ...t, finishedAt: at, finishedWall: atWall, finishReason: reason })), trackId);
}

function end(state: SubjectState, reason: EndReason, now: number): SubjectState {
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
  const resolved = new Set(state.results.filter((r) => r.trackId === track.id).map((r) => r.stepId));
  let lastResolved = -1;
  track.steps.forEach((s, i) => {
    if (resolved.has(s.id)) lastResolved = i;
  });
  return track.steps.find((s, i) => i > lastResolved && !s.removed && !resolved.has(s.id))?.id ?? null;
}

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
  const s = span(atWall, step?.waitDays ?? 0, zone);
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
export function evaluate(state: SubjectState, now: number): SubjectState {
  if (!runs(state)) return state;
  let s = checkEndings(state, now);
  if (!runs(s)) return s;
  const lead = leadNow(s.subject.clock, now);

  for (const track of liveTracksFor(s)) {
    let progress = progressOf(s, track.id);
    if (progress?.startedAt == null && track.start.kind === "entry" && progress?.startAt == null && s.subject.branchEnteredAt !== null) {
      const basisWall = wallAtLead(s.subject.clock, s.freezes, s.subject.branchEnteredAt, now);
      const resolved = { startAt: s.subject.branchEnteredAt, startBasisAt: s.subject.branchEnteredAt, startBasisWall: basisWall, startZone: s.lead.zone };
      s = progress ? withTrack(s, track.id, (t) => ({ ...t, ...resolved })) : { ...s, tracks: [...s.tracks, { ...emptyProgress(track.id), ...resolved }] };
      progress = progressOf(s, track.id);
    }
    if (progress && progress.startedAt === null && progress.startAt !== null && progress.startAt <= lead) {
      const startAt = progress.startAt;
      const startWall = wallAtLead(s.subject.clock, s.freezes, startAt, now);
      const destination = track.channel === "email" ? goodEmail(s.lead.details) : null;
      s = withTrack(s, track.id, (t) => ({ ...t, startedAt: startAt, destinationDetailId: destination?.id ?? null }));
      s = destination ? advanceTrack(s, track, startAt, startWall) : finishTrack(s, track.id, "skipped_missing_channel", startAt, startWall);
    }
  }

  // A started track whose destination went bad, or stopped being the lead's, finishes (2.4).
  for (const track of liveTracksFor(s)) {
    const progress = progressOf(s, track.id);
    if (!progress || progress.startedAt === null || progress.finishedAt !== null || progress.destinationDetailId === null) continue;
    const dest = s.lead.resolved[progress.destinationDetailId];
    if (!dest || dest.bad) s = finishTrack(s, track.id, "failed_bad_destination", lead, wallOfLead(s.subject.clock, now));
    else if (!dest.owned) s = finishTrack(s, track.id, "skipped_missing_channel", lead, wallOfLead(s.subject.clock, now));
  }

  // Next steps for started tracks with no pending step and no live attempt.
  for (const track of liveTracksFor(s)) {
    const progress = progressOf(s, track.id);
    if (!progress || progress.startedAt === null || progress.finishedAt !== null || progress.nextStepId !== null) continue;
    if (s.attempts.some((a) => a.trackId === track.id && isLive(a))) continue;
    const latest = latestResult(s, track.id);
    s = advanceTrack(s, track, latest?.at ?? progress.startedAt, latest?.atWall ?? wallAtLead(s.subject.clock, s.freezes, progress.startedAt, now));
  }

  return checkEndings(s, now);
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

/** A reply ends outreach in this campaign (2.4), unless the lead already replied or was interested. */
export function applyReply(state: SubjectState, reply: { channel: "email" | "sms"; atWall: number; providerRef: string }, now: number): SubjectState {
  if (state.replies.some((r) => r.providerRef === reply.providerRef)) return state;
  const recorded = { ...state, replies: [...state.replies, reply] };
  if (state.subject.ended === "replied" || state.subject.ended === "interested_on_call") return recorded;
  const ended = { ...recorded, subject: { ...recorded.subject, ended: "replied" as const, endedAt: leadNow(recorded.subject.clock, now), endedWall: now } };
  return synced(quiesce(ended), now);
}

/** A bounce or invalid address after a send: the detail is marked bad, and an unfinished track fails (2.4). */
export function applyBadDestination(state: SubjectState, attempt: Attempt, now: number): SubjectState {
  const liveId = state.lead.resolved[attempt.destinationDetailId]?.liveId ?? attempt.destinationDetailId;
  const marked: SubjectState = {
    ...state,
    markBad: [...new Set([...state.markBad, liveId])],
    lead: {
      ...state.lead,
      details: state.lead.details.map((d) => (d.id === liveId ? { ...d, bad: true } : d)),
      resolved: Object.fromEntries(Object.entries(state.lead.resolved).map(([id, r]) => [id, r.liveId === liveId ? { ...r, bad: true } : r])),
    },
  };
  const progress = progressOf(marked, attempt.trackId);
  if (!progress || progress.finishedAt !== null) return marked;
  return checkEndings(finishTrack(marked, attempt.trackId, "failed_bad_destination", leadNow(marked.subject.clock, now), wallOfLead(marked.subject.clock, now)), now);
}

/**
 * Applies one attempt event and its consequences for the step (2.4 "Sending"). A send is timed
 * by the provider's send time mapped onto the lead's clock, and the next step is resolved in the
 * same change whether or not the subject runs. A result on a finished track changes nothing else.
 */
export function applyToAttempt(
  state: SubjectState,
  attemptId: string,
  event: AttemptEvent,
  now: number,
  options: { readonly resetDay: (accountId: string, t: number) => string; readonly point?: typeof sendPoint } = { resetDay: () => "" },
): { state: SubjectState; effects: readonly AttemptEffect[] } {
  const target = state.attempts.find((a) => a.id === attemptId);
  if (!target) throw new Error(`no attempt ${attemptId}`);
  const sentFact = event.kind === "sent_observed" || (event.kind === "lookup_answer" && event.answer.kind === "sent");
  if (sentFact) {
    const ref = event.kind === "sent_observed" ? event.providerRef : event.kind === "lookup_answer" ? (event.answer.providerRef ?? null) : null;
    const sentAlready = state.attempts.find((a) => a.stepId === target.stepId && a.state === "sent");
    if (sentAlready && sentAlready.idempotencyKey === target.idempotencyKey) {
      // A later fact about work already settled as sent: attach a missing reference (ruling 1); an
      // attempt still live for that same work is settled by the provider's statement (ruling 4).
      let s = withAttempt(state, sentAlready.providerRef === null && ref ? { ...sentAlready, providerRef: ref } : sentAlready);
      if (isLive(target)) s = withAttempt(s, { ...target, state: "withdrawn", endedBy: "provider", holdsReservation: false, nextLookupWall: null, awaitingAnswer: false, retry: "refused" });
      return { state: runs(s) ? evaluate(s, now) : s, effects: [{ kind: "ignored", what: "the work was already settled as sent" }] };
    }
    // A provider send belongs to the provider work that produced it: the step's first attempt
    // handed over under this key, with its own handover time, payload and send basis (ruling 4).
    const work = state.attempts
      .filter((a) => a.stepId === target.stepId && a.idempotencyKey === target.idempotencyKey && a.handedWall !== null)
      .sort((x, y) => (x.handedWall ?? 0) - (y.handedWall ?? 0))[0];
    if (work && work.id !== target.id) return applyToAttempt(state, work.id, event, now, options);
  }
  const { attempt, effects } = applyAttemptEvent(target, event);
  let s = withAttempt(state, attempt);
  for (const effect of effects) {
    if (effect.kind === "sent") {
      s = recordSent(s, attempt, effect.providerTime, now, options);
      // Its inheritors under the same key are quiesced, whether claimed or handed.
      for (const other of s.attempts) {
        if (other.id !== attempt.id && other.stepId === attempt.stepId && other.idempotencyKey === attempt.idempotencyKey && isLive(other)) {
          s = withAttempt(s, applyAttemptEvent(other, { kind: "quiesce" }).attempt);
        }
      }
    }
    if (effect.kind === "sent_after_withdrawal") {
      // Counted on its send day for capacity; it is never a second send of the step.
      const at = Math.min(Math.max(effect.providerTime, attempt.handedWall ?? attempt.claimedWall), now);
      s = withAttempt(s, { ...attempt, sentWall: at, sentDay: options.resetDay(attempt.accountId, at), holdsReservation: false });
    }
    if (effect.kind === "rejected") s = recordRejected(s, attempt, effect.reason, now);
  }
  return { state: runs(s) ? evaluate(s, now) : s, effects };
}

function recordSent(
  state: SubjectState,
  attempt: Attempt,
  providerTime: number,
  now: number,
  options: { readonly resetDay: (accountId: string, t: number) => string; readonly point?: typeof sendPoint },
): SubjectState {
  const point = (options.point ?? sendPoint)(state.subject.clock, state.freezes, providerTime, attempt.handedWall ?? attempt.claimedWall, now);
  const sentWall = Math.min(Math.max(providerTime, attempt.handedWall ?? attempt.claimedWall), now);
  let s = withAttempt(state, { ...attempt, sentWall, sentDay: options.resetDay(attempt.accountId, sentWall), holdsReservation: false });
  s = { ...s, subject: { ...s.subject, touched: true } };
  if (s.results.some((r) => r.stepId === attempt.stepId)) return s;
  s = { ...s, results: [...s.results, { stepId: attempt.stepId, trackId: attempt.trackId, result: "sent", reason: null, at: point.at, atWall: point.atWall, attemptId: attempt.id }] };
  const progress = progressOf(s, attempt.trackId);
  const track = s.campaign.definition.tracks.find((t) => t.id === attempt.trackId);
  if (!progress || !track || progress.finishedAt !== null) return s;
  return advanceTrack(s, track, point.at, point.atWall);
}

function recordRejected(state: SubjectState, attempt: Attempt, reason: Attempt["rejectReason"], now: number): SubjectState {
  const progress = progressOf(state, attempt.trackId);
  const at = leadNow(state.subject.clock, now);
  const atWall = wallOfLead(state.subject.clock, now);
  if (reason === "invalid_destination") {
    const failed = progress && progress.finishedAt === null && !state.results.some((r) => r.stepId === attempt.stepId)
      ? { ...state, results: [...state.results, { stepId: attempt.stepId, trackId: attempt.trackId, result: "failed" as const, reason: "invalid address", at, atWall, attemptId: attempt.id }] }
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
  // 402 and 429 wait at the account; an unexplained provider skip holds the track (5.4).
  return state;
}

// ---------------------------------------------------------------------------------------------
// Holds (5.4), derived.

export type HoldReason = "unresolved" | "render_failed" | "provider_skipped" | "no_thread";

/** Why a started, unfinished track cannot proceed without guessing or the user, or null. */
export function trackHold(state: SubjectState, trackId: string): HoldReason | null {
  const progress = progressOf(state, trackId);
  if (!progress || progress.finishedAt !== null || progress.nextStepId === null) return null;
  const attempts = state.attempts.filter((a) => a.stepId === progress.nextStepId);
  if (attempts.some((a) => isLive(a) && a.unresolvedSince !== null)) return "unresolved";
  const latest = attempts.at(-1);
  if (latest && latest.state === "rejected" && latest.rejectReason === "provider_skipped") return "provider_skipped";
  return null;
}

export function stepsOf(state: SubjectState, trackId: string) {
  const track = state.campaign.definition.tracks.find((t) => t.id === trackId);
  return track ? liveSteps(track) : [];
}
