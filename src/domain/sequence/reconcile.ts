/**
 * Editing a running campaign (ADR 0003 "Ticket 19"): one pure function brings one lead's stored progress in line with
 * a new definition, in the save's transaction, after the lead was caught up under the old one. The save, the editor's
 * read of what an edit will do, and the generated test's broken engines all call it; nothing else computes an edit's
 * effect.
 */
import { skipDeadlineOf, skipLimitOf } from "./calls.ts";
import { allPools, type CampaignDefinition, type StepDefinition, type TrackDefinition } from "./definition.ts";
import { alignPending, inFlight, liveTracksFor, progressOf, remainingSteps, withdrawClaims, awaitingAcceptance } from "./progress.ts";
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
      // The zone a pending deadline is resolved in follows a zone the edit moved, in flight or not (council on 93bed86,
      // item 8): an in-flight step keeps its handed-over work, and if that work comes back to pending, `alignPending`
      // re-resolves its deadline from the basis in this zone, with the wait now in force.
      if (zoneMoved && p.dueZone !== null) s = { ...s, tracks: s.tracks.map((t) => (t.trackId === track.id ? { ...t, dueZone: state.lead.zone } : t)) };
      if (inFlight(s, track.id)) continue;
      // A claim on a step whose content changed (its copy, threading or wait) is withdrawn (ruling 1).
      if (s.attempts.some((a) => a.trackId === track.id && a.state === "claimed" && !sameContentById(oldStep, track, a.stepId))) s = withdrawClaims(s, track.id);
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

/**
 * One change between the stored definition and a draft, by identity (ADR 0003 "Ticket 19", what the editor shows):
 * what it is about and the track and step it names. The editor words it with the track's current name.
 */
export type EditChangeKind =
  | "step_copy"
  | "step_wait"
  | "step_added"
  | "step_removed"
  | "track_added"
  | "track_removed"
  | "track_start"
  | "track_window"
  | "declined_path"
  | "skip_limit"
  /** A LinkedIn track's wait for acceptance (ADR 0004 3.2): it reaches every lead still waiting, deadline re-resolved. */
  | "accept_wait"
  | "call_script"
  | "timezone"
  | "sender_pool";
export interface EditChange {
  readonly kind: EditChangeKind;
  readonly trackId: string | null;
  readonly stepId: string | null;
}

/** What one change does to one lead: it reaches work still ahead of them, skips work they had not reached, is with a provider now, or leaves them untouched. */
export type LeadImpact = "reaches" | "skips" | "in_flight" | "untouched";

/** Every change from `previous` to `next`, in the order of `next`'s tracks and steps, campaign-wide changes last. */
export function changesBetween(previous: CampaignDefinition, next: CampaignDefinition): EditChange[] {
  const out: EditChange[] = [];
  const add = (kind: EditChangeKind, trackId: string | null = null, stepId: string | null = null) => out.push({ kind, trackId, stepId });
  const before = new Map(previous.tracks.map((t) => [t.id, t]));
  for (const track of next.tracks) {
    const was = before.get(track.id);
    if (!was || (was.removed && !track.removed)) {
      if (!track.removed) add("track_added", track.id);
      continue;
    }
    if (track.removed) {
      if (!was.removed) add("track_removed", track.id);
      continue;
    }
    const oldSteps = new Map(was.steps.map((st) => [st.id, st]));
    for (const st of track.steps) {
      const old = oldSteps.get(st.id);
      if (!old || (old.removed && !st.removed)) {
        if (!st.removed) add("step_added", track.id, st.id);
        continue;
      }
      if (st.removed) {
        if (!old.removed) add("step_removed", track.id, st.id);
        continue;
      }
      if (old.subject !== st.subject || old.body !== st.body || old.threading !== st.threading) add("step_copy", track.id, st.id);
      if (old.waitDays !== st.waitDays) add("step_wait", track.id, st.id);
    }
    for (const old of was.steps) if (!old.removed && !track.steps.some((st) => st.id === old.id)) add("step_removed", track.id, old.id);
    if (!sameStart(was, track)) add("track_start", track.id);
    if (JSON.stringify(was.window) !== JSON.stringify(track.window)) add("track_window", track.id);
    if (was.declinedPath !== track.declinedPath) add("declined_path", track.id);
    if (track.channel === "call" && skipLimitOf(previous, track.id) !== skipLimitOf(next, track.id)) add("skip_limit", track.id);
    if (track.channel === "linkedin" && was.acceptWaitDays !== track.acceptWaitDays) add("accept_wait", track.id);
  }
  for (const was of previous.tracks) if (!was.removed && !next.tracks.some((t) => t.id === was.id)) add("track_removed", was.id);
  if ((previous.callScript ?? "") !== (next.callScript ?? "")) add("call_script");
  if (previous.timezone !== next.timezone) add("timezone");
  // The pools follow the connected senders: a change rides along with Apply, so it is listed (council on 93bed86, item 12).
  const same = (a: readonly string[] | undefined, b: readonly string[] | undefined) => [...(a ?? [])].sort().join("\n") === [...(b ?? [])].sort().join("\n");
  const poolsBefore = allPools(previous);
  if (allPools(next).some((pool, i) => !same(poolsBefore[i], pool))) add("sender_pool");
  return out;
}

/**
 * What each change does to one lead, read from the engine's own state: `before` is the lead caught up under the stored
 * definition, `after` the same lead after `reconcileEdit` under the draft. Nothing here decides anything the engine
 * does; it says where the lead stands relative to what changed.
 */
export function editImpact(before: SubjectState, after: SubjectState, changes: readonly EditChange[]): LeadImpact[] {
  return changes.map((change) => impactOf(change.kind === "step_removed" || change.kind === "track_removed" ? before : after, change));
}

function impactOf(state: SubjectState, change: EditChange): LeadImpact {
  if (state.subject.ended !== null) return "untouched";
  if (change.trackId === null) return "reaches";
  const track = state.campaign.definition.tracks.find((t) => t.id === change.trackId);
  if (!track) return "untouched";
  const p = progressOf(state, track.id);
  if (change.kind === "track_added") return track.branch === state.subject.branch ? "reaches" : "untouched";
  if (!liveTracksFor(state).some((t) => t.id === track.id) || p?.finishedAt != null) return "untouched";
  switch (change.kind) {
    case "track_removed":
      return p?.startedAt == null ? "skips" : "untouched";
    case "track_start":
      return p?.startedAt == null ? "reaches" : "untouched";
    case "track_window":
    case "declined_path":
    case "skip_limit":
      return "reaches";
    // A waiting lead's deadline is re-resolved; one whose invite has not gone yet takes the new wait when it goes.
    case "accept_wait":
      return awaitingAcceptance(state, track.id) || p?.connection == null ? "reaches" : "untouched";
    case "step_copy":
    case "step_wait":
    case "step_added":
    case "step_removed": {
      const stepId = change.stepId ?? "";
      if (p?.startedAt != null && p.nextStepId === stepId && inFlight(state, track.id)) return "in_flight";
      const ahead = p?.startedAt == null ? !state.results.some((r) => r.stepId === stepId) : stepsAhead(state, track).includes(stepId);
      if (!ahead) return "untouched";
      return change.kind === "step_removed" ? "skips" : "reaches";
    }
    case "call_script":
    case "timezone":
    case "sender_pool":
      return "reaches";
    default: {
      const unreachable: never = change.kind;
      throw new Error(`no impact rule for ${String(unreachable)}`);
    }
  }
}

/**
 * The definition a running edit is checked against (ADR 0003 "Ticket 19", the boundary; review bot on 7afa03d): its live
 * tracks, which any lead may still start, and every removed track some lead still runs (started and not finished:
 * `liveTracksFor`, the engine's own reading of 5.1), restored for the check with only the steps such a lead can still
 * reach (`remainingSteps`, from which `nextStepOf` takes the next one). `leads` are the campaign's leads as the edit will
 * leave them (`reconcileEdit` applied). The three launch blockers are then checked over this, so an empty or
 * unrenderable message a lead would still be sent is refused, wherever it sits.
 */
export function stillRunnable(def: CampaignDefinition, leads: readonly SubjectState[]): CampaignDefinition {
  const reachable = new Map<string, Set<string>>();
  for (const lead of leads) {
    for (const track of liveTracksFor(lead)) {
      if (!track.removed) continue;
      const p = progressOf(lead, track.id);
      if (!p || p.startedAt === null || p.finishedAt !== null) continue;
      const steps = reachable.get(track.id) ?? new Set<string>();
      for (const id of remainingSteps(lead, track)) steps.add(id);
      reachable.set(track.id, steps);
    }
  }
  return {
    ...def,
    tracks: def.tracks.map((t) => {
      const steps = reachable.get(t.id);
      if (!t.removed || !steps) return t;
      return { ...t, removed: false, steps: t.steps.map((s) => ({ ...s, removed: !steps.has(s.id) })) };
    }),
  };
}

/**
 * The steps still ahead of a lead in a started track, as the engine will run them (council on 93bed86, item 9): 5.1's
 * steps (`remainingSteps`), and while the pending step's work is with a provider, the steps after it, since once that
 * work resolves it is the lead's last resolved step and a step inserted before it is behind the lead (question Q22's
 * interim; the read counts as the run then does).
 */
export function stepsAhead(state: SubjectState, track: TrackDefinition): string[] {
  const p = progressOf(state, track.id);
  if (!p || p.nextStepId === null || !inFlight(state, track.id)) return remainingSteps(state, track);
  const resolved = { ...state, results: [...state.results, { stepId: p.nextStepId, trackId: track.id, result: "sent" as const, reason: null, at: 0, atWall: 0, attemptId: null }] };
  return remainingSteps(resolved, track);
}
