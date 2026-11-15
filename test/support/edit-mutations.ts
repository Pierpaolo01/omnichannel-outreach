import { leadNow, span, wallOfLead } from "../../src/domain/sequence/clock.ts";
import { inFlight, progressOf, remainingSteps, runs } from "../../src/domain/sequence/progress.ts";
import type { SubjectState, TrackProgress } from "../../src/domain/sequence/state.ts";
import { DEFAULT_RULES, type Rules } from "../../src/server/engine/rules.ts";
import { launchCheck } from "../../src/domain/sequence/blockers.ts";

/**
 * Deliberately broken running edits (ADR 0003 "Ticket 19"): each replaces `reconcileEdit` (or, for E12, the control's
 * precondition); the generated edit runs (generated-edits.ts) must fail the invariant it names, on its recorded seed in
 * `pnpm check`. E1, E2, E8 and E13 are held by the store's guards and the save's one transaction, and E5 and E6 by the
 * handover's predicates (a removed step, the copy rendered at the handover) and `alignPending`, which every change to
 * provider work and every evaluation runs: no swap of a rule breaks them, and example tests guard them
 * (`reconcile.test.ts`, `running-edits.test.ts`).
 */

const R = DEFAULT_RULES;
const reconciled = (f: (before: SubjectState, after: SubjectState, now: number) => SubjectState): Partial<Rules> => ({
  reconcileEdit: (s, previous, zone, now) => f(s, R.reconcileEdit(s, previous, zone, now), now),
});
const withTrack = (s: SubjectState, trackId: string, change: (t: TrackProgress) => TrackProgress): SubjectState => ({ ...s, tracks: s.tracks.map((t) => (t.trackId === trackId ? change(t) : t)) });
const waitOf = (s: SubjectState, trackId: string, stepId: string) => s.campaign.definition.tracks.find((t) => t.id === trackId)?.steps.find((x) => x.id === stepId)?.waitDays ?? 0;

export const EDIT_MUTATIONS: Record<string, { readonly rules: Partial<Rules>; readonly invariant: string; readonly seed: number; readonly options?: { readonly changeHandedCopy?: boolean } }> = {
  // Verifier F7 on 7afa03d: what the provider delivers differs from what it was handed over (the record compares them).
  "a handed-over email delivered with other copy": {
    invariant: "E6",
    seed: 0,
    rules: {},
    options: { changeHandedCopy: true },
  },
  "an edit re-resolves a wait from the edit's instant, not its basis": {
    seed: 1,
    invariant: "E7",
    rules: reconciled((_, s, now) => {
      let out = s;
      for (const p of s.tracks) {
        if (p.startedAt === null || p.finishedAt !== null || p.nextStepId === null || inFlight(s, p.trackId)) continue;
        const at = leadNow(s.subject.clock, now);
        const wall = wallOfLead(s.subject.clock, now);
        const w = span(wall, waitOf(s, p.trackId, p.nextStepId), p.dueZone ?? s.lead.zone);
        out = withTrack(out, p.trackId, (t) => ({ ...t, basisAt: at, basisWall: wall, dueAt: at + w, dueWall: wall + w }));
      }
      return out;
    }),
  },
  "reconciliation skips held leads": {
    seed: 81,
    invariant: "E9",
    rules: { reconcileEdit: (s, previous, zone, now) => (runs(s) ? R.reconcileEdit(s, previous, zone, now) : s) },
  },
  "a reconnected track keeps the start it had resolved": {
    seed: 5,
    invariant: "E9",
    rules: reconciled((before, after) => ({ ...after, tracks: after.tracks.map((t) => (t.startedAt === null ? (progressOf(before, t.trackId) ?? t) : t)) })),
  },
  "an added step reopens a finished track": {
    seed: 6,
    invariant: "E3",
    rules: reconciled((_, s, now) => {
      let out = s;
      for (const p of s.tracks) {
        const track = s.campaign.definition.tracks.find((t) => t.id === p.trackId);
        if (!track || p.finishReason !== "completed" || p.basisAt === null || p.basisWall === null) continue;
        const next = remainingSteps(s, track)[0];
        if (!next) continue;
        const at = leadNow(s.subject.clock, now);
        out = withTrack(out, p.trackId, (t) => ({ ...t, finishedAt: null, finishedWall: null, finishReason: null, nextStepId: next, basisAt: at, basisWall: wallOfLead(s.subject.clock, now), dueAt: at, dueWall: wallOfLead(s.subject.clock, now) }));
      }
      return out;
    }),
  },
  "a removed step with the provider is passed over at once": {
    seed: 23,
    invariant: "E11",
    rules: reconciled((_, s) => {
      let out = s;
      for (const p of s.tracks) {
        const track = s.campaign.definition.tracks.find((t) => t.id === p.trackId);
        const pending = track?.steps.find((x) => x.id === p.nextStepId);
        if (!track || !pending?.removed || p.finishedAt !== null || !inFlight(s, p.trackId) || p.basisAt === null || p.basisWall === null) continue;
        const next = remainingSteps(s, track).find((id) => id !== pending.id);
        if (!next) continue;
        const basisAt = p.basisAt;
        const basisWall = p.basisWall;
        out = withTrack(out, p.trackId, (t) => ({ ...t, nextStepId: next, dueAt: basisAt, dueWall: basisWall }));
      }
      return out;
    }),
  },
  "the pending step is the first unsent step, wherever the lead is": {
    seed: 6,
    invariant: "E4",
    rules: {
      evaluate: (s, now, o) => {
        const evaluated = R.evaluate(s, now, o);
        let out = evaluated;
        for (const p of evaluated.tracks) {
          const track = evaluated.campaign.definition.tracks.find((t) => t.id === p.trackId);
          if (!track || p.startedAt === null || p.finishedAt !== null || p.nextStepId === null || inFlight(evaluated, p.trackId) || p.basisAt === null || p.basisWall === null) continue;
          const first = track.steps.find((x) => !x.removed && !evaluated.results.some((r) => r.stepId === x.id));
          if (!first || first.id === p.nextStepId) continue;
          const basisAt = p.basisAt;
          const basisWall = p.basisWall;
          out = withTrack(out, p.trackId, (t) => ({ ...t, nextStepId: first.id, dueAt: basisAt, dueWall: basisWall }));
        }
        return out;
      },
    },
  },
  "a running edit's blockers checked over its live tracks only": {
    invariant: "E14",
    seed: 32,
    rules: { runningCheck: (definition, _leadsAfter, leads, accounts) => launchCheck(definition, leads, accounts) },
  },
  "a control applied after an edit changed what it previews": {
    seed: 31,
    invariant: "E12",
    rules: { controlPrecondition: () => null },
  },
};
