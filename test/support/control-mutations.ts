import { currentStep } from "../../src/domain/sequence/controls.ts";
import type { SubjectState } from "../../src/domain/sequence/state.ts";
import { DEFAULT_RULES, type Rules } from "../../src/server/engine/rules.ts";

/**
 * Deliberately broken controls (ADR 0003 9.2 step 5, "Ticket 17a"): each replaces one transition; the generated
 * control runs (generated-controls.ts) must fail the invariant it names, on its recorded seed in `pnpm check`.
 * P7 (request ids), P10 (one lead per transaction), P11 (the read and the action share `applyControl`) and P12
 * (the committed-call count) are held in the store and the routes, not in a rule a mutation can swap: example
 * tests guard them (`src/server/engine/controls.test.ts`).
 */

const R = DEFAULT_RULES;
const frozenAsBefore = (before: SubjectState, after: SubjectState): SubjectState => ({ ...after, subject: { ...after.subject, clock: before.subject.clock }, freezes: before.freezes });

const RULES: Record<string, Partial<Rules>> = {
  "a lead pause holds nothing": {
    applyControl: (s, action, now) => (action === "pause" && s.subject.ended === null && !s.subject.leadPaused && s.campaign.launchedAt !== null ? { ok: true, state: s } : R.applyControl(s, action, now)),
  },
  "skip skips two steps": {
    applyControl: (s, action, now) => {
      const out = R.applyControl(s, action, now);
      if (!out.ok || action !== "skip") return out;
      const again = R.applyControl(out.state, "skip", now);
      return again.ok ? again : out;
    },
  },
  "a skipped step is sent all the same": {
    applyControl: (s, action, now) => {
      const out = R.applyControl(s, action, now);
      if (!out.ok || action !== "skip") return out;
      // The skip records nothing: the step stays pending, and is claimed and sent.
      const step = currentStep(s);
      return step && step.track.channel !== "call" ? { ok: true, state: s } : out;
    },
  },
  "stop leaves the clock running": {
    applyControl: (s, action, now) => {
      const out = R.applyControl(s, action, now);
      return out.ok && action === "stop" ? { ok: true, state: frozenAsBefore(s, out.state) } : out;
    },
  },
  "a restart rewinds to the track's first step": {
    applyControl: (s, action, now) => {
      const out = R.applyControl(s, action, now);
      if (!out.ok || action !== "resume_from_next_step") return out;
      const tracks = out.state.tracks.map((p) => {
        const first = out.state.campaign.definition.tracks.find((t) => t.id === p.trackId)?.steps[0]?.id ?? null;
        return p.finishedAt === null && p.nextStepId !== null && first !== null ? { ...p, nextStepId: first } : p;
      });
      return { ok: true, state: { ...out.state, tracks } };
    },
  },
  "a restart keeps the ending's clock frozen": {
    applyControl: (s, action, now) => {
      const out = R.applyControl(s, action, now);
      return out.ok && action === "resume_from_next_step" ? { ok: true, state: frozenAsBefore(s, out.state) } : out;
    },
  },
  "move to win-back keeps the main sequence": {
    applyControl: (s, action, now) => (action === "move_to_win_back" && s.subject.branch === "main" && (s.subject.ended === "replied" || s.subject.ended === "stopped_manually") && s.campaign.definition.tracks.some((t) => t.branch === "win_back") ? R.applyControl(s, "resume_from_next_step", now) : R.applyControl(s, action, now)),
  },
  "resuming a lead releases its campaign's pause": {
    applyControl: (s, action, now) => (action === "resume" ? R.applyControl({ ...s, campaign: { ...s.campaign, pausedSince: null } }, action, now) : R.applyControl(s, action, now)),
  },
};

/** The invariant each mutation must break, and the seed offset known to show it (refreshed by the CI search). */
const EXPECTED: Record<string, { invariant: string; seed: number }> = {
  "a lead pause holds nothing": { invariant: "P9", seed: 2 },
  "skip skips two steps": { invariant: "P11", seed: 6 },
  "a skipped step is sent all the same": { invariant: "P4", seed: 5 },
  "stop leaves the clock running": { invariant: "P9", seed: 0 },
  "a restart rewinds to the track's first step": { invariant: "P2", seed: 0 },
  "a restart keeps the ending's clock frozen": { invariant: "P9", seed: 0 },
  "move to win-back keeps the main sequence": { invariant: "status", seed: 0 },
  "resuming a lead releases its campaign's pause": { invariant: "P9", seed: 4 },
};

export const CONTROL_MUTATIONS: Record<string, { readonly rules: Partial<Rules>; readonly invariant: string; readonly seed: number }> = Object.fromEntries(
  Object.entries(EXPECTED).map(([name, e]) => {
    const rules = RULES[name];
    if (!rules) throw new Error(`no mutation named ${name}`);
    return [name, { rules, ...e }];
  }),
);
