import { currentStep } from "../../src/domain/sequence/controls.ts";
import type { SubjectState } from "../../src/domain/sequence/state.ts";
import { DEFAULT_RULES, type Rules } from "../../src/server/engine/rules.ts";
import type { ControlRunOptions } from "./generated-controls.ts";

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
  // After the review bot and the verifier on ca8baee: one per rule they found broken.
  "skip ignores provider work withdrawn on a non-final not-sent": {
    applyControl: (s, action, now) => {
      if (action !== "skip") return R.applyControl(s, action, now);
      // Judged as if called work no live attempt carries had settled: the rule before the fix.
      const carried = (key: string) => s.attempts.some((a) => a.idempotencyKey === key && a.state !== "withdrawn" && a.state !== "sent" && a.state !== "rejected");
      const out = R.applyControl({ ...s, work: s.work.map((w) => (w.settled === null && w.calls > 0 && !carried(w.key) ? { ...w, settled: "not_sent" as const } : w)) }, action, now);
      return out.ok ? { ok: true, state: { ...out.state, work: out.state.work.map((w) => s.work.find((x) => x.key === w.key && x.settled === null && w.settled === "not_sent") ?? w) } } : out;
    },
  },
  "a control's preview skips what fell due": {
    previewAsOf: (s) => s,
  },
  "a refused request runs when sent again": {
    requestStanding: (stored, request) => (stored === null || stored.answer === "refused" ? "new" : R.requestStanding(stored, request)),
  },
  // Pacing is held twice by construction (the slot taken in the handover transaction, and moved after the call), so no
  // one rule removes it: this runs the engine with a one-second gap while the record expects five minutes (options below).
  "the pacing gap ignored": {},
  "a reply the record holds clears the pre-send check": {
    presendAnswer: (answer, known) => (answer.kind === "reply" && "providerRef" in answer && known.includes(String(answer.providerRef)) ? { kind: "clear" as const } : answer),
  },
};

/** The invariant each mutation must break, and the seed offset known to show it (refreshed by the CI search). */
const EXPECTED: Record<string, { invariant: string; seed: number; options?: Partial<ControlRunOptions> }> = {
  "a lead pause holds nothing": { invariant: "P9", seed: 2 },
  "skip skips two steps": { invariant: "P11", seed: 0 },
  "a skipped step is sent all the same": { invariant: "P4", seed: 10 },
  "stop leaves the clock running": { invariant: "P9", seed: 0 },
  "a restart rewinds to the track's first step": { invariant: "P2", seed: 0 },
  "a restart keeps the ending's clock frozen": { invariant: "P9", seed: 0 },
  "move to win-back keeps the main sequence": { invariant: "status", seed: 0 },
  "resuming a lead releases its campaign's pause": { invariant: "P9", seed: 4 },
  "skip ignores provider work withdrawn on a non-final not-sent": { invariant: "P11", seed: 19 },
  "a control's preview skips what fell due": { invariant: "P11", seed: 10 },
  "a refused request runs when sent again": { invariant: "P7", seed: 6 },
  "the pacing gap ignored": { invariant: "P3", seed: 0, options: { gapMs: 1000 } },
  // With the provider answering the first thread's reply, as the adapter did on ca8baee: the defect restored.
  "a reply the record holds clears the pre-send check": { invariant: "P1", seed: 24, options: { presendFirstReply: true } },
};

export const CONTROL_MUTATIONS: Record<string, { readonly rules: Partial<Rules>; readonly invariant: string; readonly seed: number; readonly options?: Partial<ControlRunOptions> }> = Object.fromEntries(
  Object.entries(EXPECTED).map(([name, e]) => {
    const rules = RULES[name];
    if (!rules) throw new Error(`no mutation named ${name}`);
    return [name, { rules, ...e }];
  }),
);
