import { rescheduledSteps } from "../../src/domain/sequence/interruption.ts";
import { channelOf } from "../../src/domain/sequence/progress.ts";
import type { SubjectState } from "../../src/domain/sequence/state.ts";
import { DEFAULT_RULES, type Rules } from "../../src/server/engine/rules.ts";
import type { ControlRunOptions } from "./generated-controls.ts";

/**
 * Deliberately broken recoveries (ADR 0003 "Ticket 20a", the generated test): each replaces one rule; the control runs'
 * interruption family (generated-controls.ts, `interruptions: true`) must fail the invariant it names, on its recorded
 * seed in `pnpm check`. R8 (the notice and the heartbeat are one write), R10 (the lease) and R11's reads are held by the
 * store and the routes, not by a rule a mutation can swap: example tests guard them (`src/server/engine/interruption.test.ts`,
 * `src/server/worker-lease.test.ts`, `src/server/engine/attention.test.ts`).
 */

const R = DEFAULT_RULES;

const RULES: Record<string, Partial<Rules>> = {
  // R1: the crash row of 5.3 read as a refusal, so the step is claimed again with new work and a new key.
  "a call whose answer a crash lost is taken as refused": { lostAnswer: { kind: "rejected", reason: "rate_limited" } },
  // R2: the steps the interruption made late are skipped at recovery.
  "the steps that fell due during an interruption are skipped": {
    afterInterruption: (s, gap, now) => {
      let state: SubjectState = s;
      for (let i = rescheduledSteps(s, gap, now).length; i > 0; i--) {
        const out = R.applyControl(state, "skip", now);
        if (out.ok) state = out.state;
      }
      return state;
    },
  },
  // R3: pacing is held twice by construction (the slot is taken in the handover transaction and moved after the call), so
  // no one rule removes it: this runs the engine with a one-second gap while the record expects five minutes.
  "the pacing gap ignored while missed work catches up": {},
  // R4: new leads and follow-ups ranked alike after a recovery.
  "the claim order ignores follow-ups first": {
    claimOrder: (a, b) => R.claimOrder({ ...a, touched: false }, { ...b, touched: false }),
  },
  // R5: a lead paused before the interruption is running after it.
  "an interruption releases the leads' pauses": {
    afterInterruption: (s, _gap, now) => {
      if (!s.subject.leadPaused) return s;
      const out = R.applyControl(s, "resume", now);
      return out.ok ? out.state : s;
    },
  },
  // R6: the interruption counted as a pause: every deadline moves by its length.
  "an interruption freezes the clock like a pause": {
    afterInterruption: (s, gap) =>
      s.subject.clock.frozenSince !== null
        ? s
        : { ...s, subject: { ...s.subject, clock: { ...s.subject.clock, frozenTotal: s.subject.clock.frozenTotal + (gap.to - gap.from) } }, freezes: [...s.freezes, { fromWall: gap.from, toWall: gap.to }] },
  },
  // R7: the notice counts every email and text whose stored due instant fell in the interruption, whatever happened to its lead.
  "the count is the steps due during the interruption": {
    rescheduled: (s, gap) =>
      s.tracks.flatMap((p) => {
        const channel = channelOf(s, p.trackId);
        return (channel === "email" || channel === "sms") && p.finishedAt === null && p.nextStepId !== null && p.dueWall !== null && p.dueWall >= gap.from && p.dueWall < gap.to ? [{ trackId: p.trackId, stepId: p.nextStepId }] : [];
      }),
  },
  // R7: a short gap reported as an interruption.
  "a gap of any length is an interruption": {
    interruptionOf: (last, now) => (last === null || now <= last ? null : { from: last, to: now }),
  },
  // R7, the same rule (PR 56 review bot): the dispatch judged at the tick's start, so a sleep in the middle of a tick
  // dispatches overdue work before the interruption is counted.
  "a dispatch is judged at the tick's start": { dispatchInstant: (started) => started },
  // R7, the same rule (PR 56 review bot on 13dad92): an account read alone counts as contact, so a provider whose
  // observation fails while its account reads answer keeps the heartbeat fresh.
  "contact is marked after the account read only": { contactFrom: (answered) => answered.accounts },
  // R9 (follow-up 42 item 39): a provider answer applied at the instant its request was made.
  "a late answer is applied at the instant its request was made": { answerInstant: (asked) => asked },
};

/**
 * Mutations with state of their own, built afresh for each run (verifier on 2f7cd20): after the first recovery, no
 * withdrawal is asked again (check A).
 */
const FRESH: Record<string, () => Partial<Rules>> = {
  "no withdrawal retries after recovery": () => {
    let recovered = false;
    return {
      afterInterruption: (s, gap, now) => {
        recovered = true;
        return R.afterInterruption(s, gap, now);
      },
      rescheduled: (s, gap, now) => {
        recovered = true;
        return R.rescheduled(s, gap, now);
      },
      withdrawalDue: (w, now, carried) => !recovered && R.withdrawalDue(w, now, carried),
    };
  },
};

/** The invariant each mutation must break, and the seed offset known to show it (refreshed by the CI search). */
const EXPECTED: Record<string, { invariant: string; seed: number; options?: Partial<ControlRunOptions> }> = {
  "a call whose answer a crash lost is taken as refused": { invariant: "P2", seed: 16 },
  "the steps that fell due during an interruption are skipped": { invariant: "P2", seed: 0 },
  "the pacing gap ignored while missed work catches up": { invariant: "P3", seed: 0, options: { gapMs: 1000 } },
  "the claim order ignores follow-ups first": { invariant: "18", seed: 5 },
  "an interruption releases the leads' pauses": { invariant: "P1", seed: 2 },
  // W2 since ADR 0003 "Reads that say when": the read's instant checked against the record's due instant catches the frozen
  // clock first, and the run stops there (it was P2, the same due instant checked against the engine's own progress).
  "an interruption freezes the clock like a pause": { invariant: "W2", seed: 1 },
  "the count is the steps due during the interruption": { invariant: "R7", seed: 0 },
  "a gap of any length is an interruption": { invariant: "R7", seed: 2 },
  "a late answer is applied at the instant its request was made": { invariant: "P12", seed: 16 },
  "a dispatch is judged at the tick's start": { invariant: "R7", seed: 0 },
  "contact is marked after the account read only": { invariant: "R7", seed: 5 },
  "no withdrawal retries after recovery": { invariant: "A", seed: 3, options: { withdrawalAcrossARecovery: true } },
};

export const INTERRUPTION_MUTATIONS: Record<string, { readonly rules: Partial<Rules>; readonly fresh?: () => Partial<Rules>; readonly invariant: string; readonly seed: number; readonly options?: Partial<ControlRunOptions> }> = Object.fromEntries(
  Object.entries(EXPECTED).map(([name, e]) => {
    const fresh = FRESH[name];
    const rules = RULES[name] ?? fresh?.();
    if (!rules) throw new Error(`no mutation named ${name}`);
    return [name, { rules, ...(fresh ? { fresh } : {}), ...e }];
  }),
);
