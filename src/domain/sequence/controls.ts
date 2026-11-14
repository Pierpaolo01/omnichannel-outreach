/**
 * The user's controls on one lead, and the campaign pause as it applies to each lead (ADR 0003, "Ticket 17a").
 * Every control is a pure transition of one `SubjectState`: it sets or clears one stored fact that `runs`
 * reads (the lead pause, the campaign pause, the ending), quiesces when the lead stops running, and ends with
 * `synced`, so there is one clock and one freeze record for every hold. The engine brings the lead up to the
 * action's instant first (`asOfAction`), then calls these; the reads call the same functions on a copy.
 */
import { leadNow, wallOfLead } from "./clock.ts";
import type { TrackDefinition } from "./definition.ts";
import { advanceTrack, channelReaches, end, enterMain, enterWinBack, evaluate, finishTrack, hasWorkLeft, liveTracksFor, progressOf, quiesce, runs, synced } from "./progress.ts";
import { isUncertain } from "./attempt.ts";
import type { SubjectState } from "./state.ts";

export const LEAD_CONTROLS = ["pause", "resume", "skip", "stop", "resume_from_next_step", "move_to_win_back"] as const;
export type LeadControl = (typeof LEAD_CONTROLS)[number];

export type ControlResult = { readonly ok: true; readonly state: SubjectState } | { readonly ok: false; readonly reason: string };

const refuse = (reason: string): ControlResult => ({ ok: false, reason });
const accept = (state: SubjectState): ControlResult => ({ ok: true, state });

export const NOT_LAUNCHED = "This campaign has not launched: nothing of this lead runs yet.";
export const ENDED = "Outreach to them has ended in this campaign.";
export const NOT_RESTARTABLE = "Only a lead that replied or was stopped can be resumed or moved to win-back.";

/**
 * A lead's release from a hold: its clock syncs, it enters its branch if it never ran (a lead enrolled while
 * held enters at lead time 0), and, if it runs now, it is evaluated at once, as the tick would.
 */
export function released(state: SubjectState, now: number): SubjectState {
  const entered = enterMain(state, now);
  return runs(entered) ? evaluate(entered, now) : entered;
}

/** The campaign pause applied to one of its leads that has not ended: it quiesces and its clock freezes. */
export function campaignPaused(state: SubjectState, now: number): SubjectState {
  const paused = { ...state, campaign: { ...state.campaign, pausedSince: now } };
  if (state.subject.ended !== null) return paused;
  return synced(quiesce(paused), now);
}

/** The campaign resumed for one of its leads: the clock syncs, and the lead runs on if no other hold remains. */
export function campaignResumed(state: SubjectState, now: number): SubjectState {
  const resumed = { ...state, campaign: { ...state.campaign, pausedSince: null } };
  if (state.subject.ended !== null) return resumed;
  return released(resumed, now);
}

/**
 * The lead's current step (question Q3's interim): among its started, unfinished tracks with a pending step,
 * the one due first in lead time, ties broken by track id. Null when every track is waiting out a delay,
 * not started, or finished.
 */
export function currentStep(state: SubjectState): { readonly track: TrackDefinition; readonly stepId: string; readonly dueAt: number | null } | null {
  return pendingSteps(state)[0] ?? null;
}

/**
 * The step a skip skips (council D2 on 56d599c, as 2.4's interim says): the lead's pending steps in order (`currentStep`),
 * the first whose provider work may not still be sent. Null when there is none, with every pending step with a provider.
 */
export function skipTarget(state: SubjectState): { readonly track: TrackDefinition; readonly stepId: string; readonly dueAt: number | null } | null {
  return pendingSteps(state).find((p) => !withProvider(state, p.stepId)) ?? null;
}

/** Every pending step of the lead's started, unfinished tracks, due first in lead time, ties by track id. */
function pendingSteps(state: SubjectState): { readonly track: TrackDefinition; readonly stepId: string; readonly dueAt: number | null }[] {
  const candidates = liveTracksFor(state).flatMap((track) => {
    const p = progressOf(state, track.id);
    if (!p || p.startedAt === null || p.finishedAt !== null || p.nextStepId === null) return [];
    return [{ track, stepId: p.nextStepId, dueAt: p.dueAt }];
  });
  candidates.sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || (a.track.id < b.track.id ? -1 : a.track.id > b.track.id ? 1 : 0));
  return candidates;
}

/** Why a lead has no step to skip: what it is waiting for. */
function noStepReason(state: SubjectState): string {
  const waiting = liveTracksFor(state).some((t) => {
    const p = progressOf(state, t.id);
    return !p || (p.finishedAt === null && p.startedAt === null);
  });
  return waiting ? "No step is waiting: the next track has not started yet." : "No step is waiting: every track has finished.";
}

/** Whether a step's provider work may still be sent: an attempt past its claim, or called work not yet settled. */
export function withProvider(state: SubjectState, stepId: string): boolean {
  // An attempt past its claim has called its work, so this is unsettled work (`isUncertain`): work that may still be sent
  // (`maySend`, which the in-flight bound and `mayStillSend` count), and work the provider said went ("too late") whose
  // send is not recorded yet, which a skip cannot skip either (council on 56d599c).
  return state.work.some((w) => w.stepId === stepId && isUncertain(w));
}

const PROVIDER_NAME = { email: "email provider", sms: "SMS provider", call: "call list" } as const;

/** Skip the current step (ADR 0003 "Ticket 17a", "Skip step"): exactly one step, never sent. */
function skip(state: SubjectState, now: number): ControlResult {
  const first = currentStep(state);
  if (!first) return refuse(noStepReason(state));
  const current = skipTarget(state) ?? first;
  const { track, stepId } = current;
  // Refused while the provider may still send it: an attempt past its claim, or provider work that was called and
  // has not settled, whether or not a live attempt carries it (a non-final "not sent" withdraws the attempt and keeps
  // the work uncertain; a new claim may inherit it). A skip never sends the skipped step (P4), so it waits for the
  // provider's final word (review bot on ca8baee, item 2).
  if (withProvider(state, stepId)) {
    return refuse(`This step is already with the ${PROVIDER_NAME[track.channel]} and may still be sent, so it cannot be skipped until the provider says whether it was sent.`);
  }
  let s = state;
  // On a callback, the hold is released first, as an outcome's is (2.4 "Calls"): the result sits on a running clock.
  if (s.callTasks.some((t) => t.open && t.stepId === stepId && t.kind === "callback")) {
    s = synced({ ...s, callTasks: s.callTasks.map((t) => (t.open && t.stepId === stepId ? { ...t, kind: "call" as const, callbackAt: null } : t)) }, now);
  }
  const at = leadNow(s.subject.clock, now);
  const atWall = wallOfLead(s.subject.clock, now);
  s = quiesce(s, track.id);
  s = { ...s, results: [...s.results, { stepId, trackId: track.id, result: "skipped", reason: "by_user", at, atWall, attemptId: null }] };
  if (track.channel === "call") s = finishTrack(s, track.id, "skipped_by_user", at, atWall);
  else s = advanceTrack({ ...s, tracks: s.tracks.map((p) => (p.trackId === track.id ? { ...p, nextStepId: null } : p)) }, track, at, atWall);
  s = synced(s, now);
  return accept(runs(s) ? evaluate(s, now) : s);
}

/** Why nothing would run after a restart: the reason the engine would end the lead with at once. */
/**
 * Why nothing would run after a restart (question Q16; council D1 on 56d599c): no track is left, or none of the tracks left
 * can reach the lead (a finished track's channel does not count), or the engine's own transition, applied to a copy as if
 * no hold remained, ends the lead at once. Null when the lead would run.
 */
function nothingLeft(state: SubjectState, now: number): string | null {
  if (!hasWorkLeft(state)) return "every track has finished";
  const runnable = liveTracksFor(state).some((t) => {
    const p = progressOf(state, t.id);
    return (!p || p.finishedAt === null) && channelReaches(state, t.channel);
  });
  if (!runnable) return "no track left in it can reach them";
  const copy = released({ ...state, campaign: { ...state.campaign, pausedSince: null }, subject: { ...state.subject, leadPaused: false } }, now);
  if (copy.subject.ended === "sequence_finished_no_response") return "every track left would finish at once";
  if (copy.subject.ended === "finished_no_usable_channel") return "no track left in it can reach them";
  return null;
}

/** A replied or stopped lead's ending undone (the restarts of 2.4): its other facts stay. */
function unended(state: SubjectState): SubjectState {
  return { ...state, subject: { ...state.subject, ended: null, endedAt: null, endedWall: null, stopReply: null, leadPaused: false } };
}

const restartable = (state: SubjectState) => state.subject.ended === "replied" || state.subject.ended === "stopped_manually";

/**
 * One control on one lead, judged on `state` as it stands (the caller first applies what fell due, 2.4).
 * Refused with a plain reason, or the next state.
 */
export function applyControl(state: SubjectState, action: LeadControl, now: number): ControlResult {
  const { subject, campaign } = state;
  switch (action) {
    case "pause":
      if (campaign.launchedAt === null) return refuse(NOT_LAUNCHED);
      if (subject.ended !== null) return refuse(ENDED);
      if (subject.leadPaused) return refuse("They are already paused.");
      return accept(synced(quiesce({ ...state, subject: { ...subject, leadPaused: true } }), now));
    case "resume":
      if (subject.ended !== null) return refuse(ENDED);
      if (!subject.leadPaused) return refuse("They are not paused.");
      return accept(released({ ...state, subject: { ...subject, leadPaused: false } }, now));
    case "skip":
      if (campaign.launchedAt === null) return refuse(NOT_LAUNCHED);
      if (subject.ended !== null) return refuse(ENDED);
      return skip(state, now);
    case "stop":
      if (campaign.launchedAt === null) return refuse(NOT_LAUNCHED);
      if (subject.ended !== null) return refuse(ENDED);
      return accept(end(state, "stopped_manually", now));
    case "resume_from_next_step": {
      if (!restartable(state)) return refuse(NOT_RESTARTABLE);
      const s = unended(state);
      const why = nothingLeft(s, now);
      if (why !== null) return refuse(`Nothing is left to send them in this campaign: ${why}.`);
      return accept(released(s, now));
    }
    case "move_to_win_back": {
      if (!restartable(state)) return refuse(NOT_RESTARTABLE);
      if (subject.branch === "win_back") return refuse("They are already in the win-back branch.");
      if (!campaign.definition.tracks.some((t) => t.branch === "win_back" && !t.removed)) return refuse("This campaign has no win-back branch.");
      const s = enterWinBack(unended(state), now);
      // The branch's tracks, judged as a restart's are (council D1): refused when none of them can run.
      if (nothingLeft(s, now) !== null) return refuse("The win-back branch cannot reach them: none of its channels has a usable address or number for them.");
      return accept(released(s, now));
    }
    default: {
      const never: never = action;
      return refuse(`Unknown action ${String(never)}.`);
    }
  }
}

/** Why a campaign pause (`pause`) or resume is refused, or null: the one judgment the action and the read share. */
export function campaignRefusal(row: { readonly launchedAt: number | null; readonly pausedSince: number | null } | null, pause: boolean): string | null {
  if (row === null) return "There is no such campaign.";
  if (pause) return row.launchedAt === null ? "This campaign has not launched." : row.pausedSince !== null ? "This campaign is already paused." : null;
  return row.pausedSince === null ? "This campaign is not paused." : null;
}
