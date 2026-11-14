/**
 * A track's state at a read, as the screens say it (verifier on 2027f24; ticket 16c): every state the engine's stored
 * progress can be in, mapped once, in exhaustive switches, so a state a later ticket adds fails typecheck until it has
 * one here and a sentence on the page. Activity's unworked skip, Activity's decline, and the decline's preview before
 * Log all read tracks through `dependentStateOf`.
 */
import type { DeclinedPath } from "../../domain/sequence/definition.ts";
import { runs, wallAtLead } from "../../domain/sequence/progress.ts";
import type { FinishReason, SubjectState } from "../../domain/sequence/state.ts";
import type { DeclineTrackView, DependentTrackState } from "../../shared/api.ts";
import { trackLabel } from "../../shared/track-label.ts";

/** A finished track's state: every finish reason the engine stores, in one exhaustive switch. */
export function finishedStateOf(reason: FinishReason): Exclude<DependentTrackState["state"], "waiting"> {
  switch (reason) {
    case "completed":
    case "failed_bad_destination":
    case "closed_on_interest":
      return "finished";
    case "skipped_declined":
      return "skipped_declined";
    case "skipped_unworked":
      return "skipped_unworked";
    case "skipped_missing_channel":
      return "skipped_no_channel";
    case "skipped":
    case "skipped_by_user":
      return "skipped";
    case "dropped_for_win_back":
      return "dropped_for_win_back";
    default: {
      const unhandled: never = reason;
      throw new Error(`A finish reason Activity has no state for: ${String(unhandled)}`);
    }
  }
}

/**
 * A track's state from the engine's stored progress at the read (`live`), never from how another track ended: a
 * finished track by its stored finish; once the lead has stopped or ended, one that had started sends nothing more
 * (`stopped_after_start`) and one that had not will not start (`stopped`); a phone track of a lead that declined never
 * calls (`no_more_calls`: the engine skips it at its start, ticket 16a); a started one is started; with its start
 * resolved it waits out its delay, or waits while the lead is held (council on 32454ea, D; verifier on 2027f24).
 */
export function dependentStateOf(live: SubjectState, p: SubjectState["tracks"][number] | undefined, now: number): DependentTrackState {
  if (p?.finishReason) return { state: finishedStateOf(p.finishReason), startsAt: null };
  if (live.subject.ended !== null) return { state: p && p.startedAt !== null ? "stopped_after_start" : "stopped", startsAt: null };
  if (p && live.subject.noMoreCalls && live.campaign.definition.tracks.find((t) => t.id === p.trackId)?.channel === "call") return { state: "no_more_calls", startsAt: null };
  if (p && p.startedAt !== null) return { state: "started", startsAt: null };
  if (!p || p.startAt === null) return { state: "not_started", startsAt: null };
  if (!runs(live)) return { state: "held", startsAt: null };
  return { state: "waiting", startsAt: new Date(wallAtLead(live.subject.clock, live.freezes, p.startAt, now)).toISOString() };
}

/**
 * The tracks a decline on `declinedTrackId` at `atWall` left unfinished or finished (ticket 16c), each in its state as
 * `live` holds it: every main track other than the declined call's own that had not finished before the decline (a
 * track with no progress yet included), in the definition's order; then, on the win-back path once the lead is in the
 * branch, the branch's tracks. One selection for the preview before Log (a copy after the engine's outcome) and for
 * Activity (the lead as of the read).
 */
export function afterDeclineTracks(live: SubjectState, declinedTrackId: string, atWall: number, path: DeclinedPath, now: number): DeclineTrackView[] {
  const def = live.campaign.definition;
  const progress = (id: string) => live.tracks.find((t) => t.trackId === id);
  const main = def.tracks.filter((t) => {
    if (t.branch !== "main" || t.id === declinedTrackId) return false;
    const p = progress(t.id);
    if (t.removed && (!p || p.startedAt === null)) return false;
    return !p || p.finishedWall === null || p.finishedWall >= atWall;
  });
  const branch = path === "win_back" && live.subject.branch === "win_back" ? def.tracks.filter((t) => t.branch === "win_back" && (!t.removed || progress(t.id)?.startedAt != null)) : [];
  return [...main, ...branch].map((t) => ({ track: trackLabel(def, t), branch: t.branch, ...dependentStateOf(live, progress(t.id), now) }));
}
