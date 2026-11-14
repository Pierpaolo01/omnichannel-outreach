/**
 * Editing a running campaign (ADR 0003 "Ticket 19"): one pure function brings one lead's stored progress in line with
 * a new definition, in the save's transaction, after the lead was caught up under the old one. The save, the editor's
 * read of what an edit will do, and the generated test's broken engines all call it; nothing else computes an edit's
 * effect.
 */
import { skipDeadlineOf, skipLimitOf } from "./calls.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "./definition.ts";
import { alignPending, inFlight, progressOf, withdrawClaims } from "./progress.ts";
import type { SubjectState } from "./state.ts";

export { alignPending, inFlight } from "./progress.ts";

const sameContent = (a: StepDefinition, b: StepDefinition) => a.subject === b.subject && a.body === b.body && a.threading === b.threading && a.waitDays === b.waitDays && a.removed === b.removed;
const sameStart = (a: TrackDefinition, b: TrackDefinition) => JSON.stringify(a.start) === JSON.stringify(b.start);

/**
 * `state` is the lead as stored under the new definition (its `lead.zone` read with it); `previous` the definition it
 * replaces and `previousZone` the lead's zone under it. In order: claims on a step whose content changed are withdrawn;
 * a lead whose zone the edit moved has its pending deadlines re-resolved in the new zone; an unstarted track whose
 * start rule changed, that was removed, or whose zone moved forgets its resolved start; open call tasks of a phone
 * track whose skip limit changed get their deadline re-resolved; and every track not in flight gets the pending step
 * 5.1 names (`alignPending`). Finished tracks, results and started instants are never touched.
 */
export function reconcileEdit(state: SubjectState, previous: CampaignDefinition, previousZone: string, now: number): SubjectState {
  const def = state.campaign.definition;
  const before = new Map(previous.tracks.map((t) => [t.id, t]));
  const oldStep = new Map(previous.tracks.flatMap((t) => t.steps.map((st) => [st.id, st] as const)));
  const zoneMoved = previousZone !== state.lead.zone;
  let s = state;

  for (const track of def.tracks) {
    const p = progressOf(s, track.id);
    if (!p || p.finishedAt !== null) continue;
    const was = before.get(track.id);
    if (p.startedAt !== null) {
      if (inFlight(s, track.id)) continue;
      // A claim on a step whose content changed (its copy, threading or wait) is withdrawn (ruling 1).
      if (s.attempts.some((a) => a.trackId === track.id && a.state === "claimed" && !sameContentById(oldStep, track, a.stepId))) s = withdrawClaims(s, track.id);
      if (zoneMoved && p.dueZone !== null) s = { ...s, tracks: s.tracks.map((t) => (t.trackId === track.id ? { ...t, dueZone: state.lead.zone } : t)) };
      continue;
    }
    if (p.startAt === null) continue;
    if (track.removed || !was || !sameStart(was, track) || zoneMoved) {
      s = { ...s, tracks: s.tracks.map((t) => (t.trackId === track.id ? { ...t, startAt: null, startBasisAt: null, startBasisWall: null, startZone: null } : t)) };
    }
  }

  s = {
    ...s,
    callTasks: s.callTasks.map((task) => {
      if (!task.open) return task;
      const limit = skipLimitOf(def, task.trackId);
      if (limit === skipLimitOf(previous, task.trackId)) return task;
      return { ...task, skipDeadline: skipDeadlineOf(task, limit, s.callDay.userZone) };
    }),
  };
  return alignPending(s, now);
}

function sameContentById(oldStep: ReadonlyMap<string, StepDefinition>, track: TrackDefinition, stepId: string): boolean {
  const old = oldStep.get(stepId);
  const now = track.steps.find((st) => st.id === stepId);
  return old !== undefined && now !== undefined && sameContent(old, now);
}
