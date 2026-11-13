/**
 * One lead in one campaign (ADR 0003 section 2): the status as a total function of the stored
 * state, the endings, evaluation, and the facts that change progress. Every function is pure:
 * it takes a `SubjectState` and the time, and returns the next `SubjectState`.
 */
import type { OutreachStatus } from "../outreach-status.ts";
import { applyAttemptEvent, applyLookup, isLive, isUncertain, markable, withRef, type AttemptEffect, type AttemptEvent, type WorkEvent } from "./attempt.ts";
import { leadNow, sendPoint, span, syncClock, wallOfLead, type Freeze, type LeadClock } from "./clock.ts";
import { liveSteps, type TrackChannel, type TrackDefinition } from "./definition.ts";
import type { Attempt, EndReason, FinishReason, LeadDetail, ProviderWork, SmsBindingRecord, StepResult, SubjectState, TrackProgress } from "./state.ts";

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

/** The newest good mobile the lead may be texted at, or null: a decision maker's own (ADR 0001). */
export function goodMobile(details: readonly LeadDetail[]): LeadDetail | null {
  return [...details].filter((d) => d.channel === "phone" && d.mobile && !d.bad).sort((a, b) => b.order - a.order)[0] ?? null;
}

/** The detail a track on `channel` starts with: the newest good one the lead may be sent to on it. */
export function destinationFor(details: readonly LeadDetail[], channel: TrackChannel): LeadDetail | null {
  return channel === "email" ? goodEmail(details) : channel === "sms" ? goodMobile(details) : null;
}

/** Channels in the lead's branch that can reach the lead now (2.1). */
export function reachable(state: SubjectState): Set<string> {
  const channels = new Set<string>();
  for (const track of liveTracksFor(state)) {
    if (destinationFor(state.lead.details, track.channel)) channels.add(track.channel);
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
export function evaluate(state: SubjectState, now: number, options: { readonly endingsFirst?: boolean } = {}): SubjectState {
  if (!runs(state)) return state;
  // `endingsFirst: false` exists only for the oracle's broken engine (ADR 0003 9.2, "ending check too late").
  let s = options.endingsFirst === false ? state : checkEndings(state, now);
  if (!runs(s)) return s;
  const lead = leadNow(s.subject.clock, now);

  // Starts, until nothing more starts: a track skipped at its start finishes then, so a track
  // after it with no delay starts at the same lead time (spec "a skipped or failed track counts as finished").
  for (let round = 0; round <= s.campaign.definition.tracks.length; round++) {
    const before = s;
    for (const track of liveTracksFor(s)) s = startTrack(s, track, lead, now);
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
  const destination = destinationFor(s.lead.details, track.channel);
  s = withTrack(s, track.id, (t) => ({ ...t, startedAt: startAt, destinationDetailId: destination?.id ?? null }));
  return destination ? advanceTrack(s, track, startAt, startWall) : finishTrack(s, track.id, "skipped_missing_channel", startAt, startWall);
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
  return { startAt: before.finishedAt + span(before.finishedWall, track.start.delayDays, zone), startBasisAt: before.finishedAt, startBasisWall: before.finishedWall, startZone: zone };
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
  const ended = {
    ...recorded,
    subject: { ...recorded.subject, ended: "replied" as const, endedAt: leadNow(recorded.subject.clock, now), endedWall: now, stopReply: { channel: reply.channel, atWall: reply.atWall } },
  };
  return attend(synced(quiesce(ended), now), now);
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
  return attend(checkEndings(finishTrack(marked, attempt.trackId, "failed_bad_destination", leadNow(marked.subject.clock, now), wallOfLead(marked.subject.clock, now)), now), now);
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
    const settled: ProviderWork = { ...referenced, settled: byUser ? "user_sent" : "sent", nextLookupWall: null, sentWall: at, sentDay: options.resetDay(w.accountId, at) };
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
  return advanceTrack(s, track, point.at, point.atWall);
}

function recordRejected(state: SubjectState, attempt: Attempt, reason: Attempt["rejectReason"], now: number): SubjectState {
  const progress = progressOf(state, attempt.trackId);
  const at = leadNow(state.subject.clock, now);
  const atWall = wallOfLead(state.subject.clock, now);
  if (reason === "invalid_destination") {
    const failed = progress && progress.finishedAt === null && !state.results.some((r) => r.stepId === attempt.stepId)
      ? { ...state, results: [...state.results, { stepId: attempt.stepId, trackId: attempt.trackId, result: "failed" as const, reason: channelOf(state, attempt.trackId) === "sms" ? "invalid number" : "invalid address", at, atWall, attemptId: attempt.id }] }
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
  const pair = bindings.filter((b) => b.sender === sender);
  return pair.find((b) => !b.released)?.owner ?? pair.filter((b) => b.released).at(-1)?.owner ?? null;
}

// ---------------------------------------------------------------------------------------------
// Holds (5.4), derived.

export type HoldReason = "unresolved" | "render_failed" | "provider_skipped" | "no_thread" | "sms_conversation_taken";

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
