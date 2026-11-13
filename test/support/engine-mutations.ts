import { ENGINE_PARAMS } from "../../src/domain/sequence/attempt.ts";
import { leadNow, wallOfLead } from "../../src/domain/sequence/clock.ts";
import { renderStep } from "../../src/domain/sequence/dispatch.ts";
import { nextStepOf } from "../../src/domain/sequence/progress.ts";
import type { Attempt, SubjectState } from "../../src/domain/sequence/state.ts";
import { DEFAULT_RULES, type Rules } from "../../src/server/engine/rules.ts";

/**
 * Deliberately broken engines (ADR 0003 9.2 step 5, the ticket 12 row of 9.3). Each replaces one
 * decision; the generated runs must fail on every one.
 */

const R = DEFAULT_RULES;

/** Wraps every rule that returns a new subject state with `fix(before, after, now)`. */
function afterEveryChange(fix: (before: SubjectState, after: SubjectState, now: number) => SubjectState): Partial<Rules> {
  return {
    evaluate: (s, now) => fix(s, R.evaluate(s, now), now),
    applyReply: (s, reply, now) => fix(s, R.applyReply(s, reply, now), now),
    applyBadDestination: (s, a, now) => fix(s, R.applyBadDestination(s, a, now), now),
    applyToAttempt: (s, id, event, now, options) => {
      const out = R.applyToAttempt(s, id, event, now, options);
      return { ...out, state: fix(s, out.state, now) };
    },
  };
}

const mapAttempts = (s: SubjectState, f: (a: Attempt, before: Attempt | undefined) => Attempt, before: SubjectState): SubjectState => ({
  ...s,
  attempts: s.attempts.map((a) => f(a, before.attempts.find((b) => b.id === a.id))),
});

export const MUTATIONS: Record<string, Partial<Rules>> = {
  "withdraw handed": afterEveryChange((before, after) =>
    mapAttempts(after, (a, b) => (a.withdrawRequested && !b?.withdrawRequested && (a.state === "handed" || a.state === "accepted") ? { ...a, state: "withdrawn", endedBy: "quiesce" } : a), before),
  ),

  "retry non-retryable": {
    applyToAttempt: (s, id, event, now, options) => {
      const out = R.applyToAttempt(s, id, event, now, options);
      if (event.kind !== "call_answer" || event.answer.kind !== "unknown") return out;
      return { ...out, state: mapAttempts(out.state, (a) => (a.id === id && a.state === "handed" && !a.retryable && a.calls < ENGINE_PARAMS.MAX_CALLS ? { ...a, retry: "wanted" } : a), s) };
    },
    retryFailures: (s, a, acc, now) => R.retryFailures(s, a, acc, now).filter((f) => f !== "not retryable"),
  },

  "retry after withdraw": {
    ...afterEveryChange((before, after) => mapAttempts(after, (a, b) => (b?.retry === "wanted" && a.retry === "refused" && a.withdrawRequested && a.state === "handed" ? { ...a, retry: "wanted" } : a), before)),
    retryFailures: (s, a, acc, now) => R.retryFailures(s, a, acc, now).filter((f) => f !== "withdraw requested" && !f.startsWith("predicate")),
  },

  "retry without slot or predicates": {
    retryFailures: (s, a, acc, now) => R.retryFailures(s, a, acc, now).filter((f) => f !== "slot" && !f.startsWith("predicate")),
  },

  "retry re-renders": {
    authorizeRetry: (s, a, acc, now) => {
      const out = R.authorizeRetry(s, a, acc, now);
      return { ...out, attempts: out.attempts.map((x) => (x.id === a.id ? { ...x, copy: renderStep(s, x.trackId, x.stepId) ?? x.copy } : x)) };
    },
  },

  "new key after not-sent": {
    claim: (s, item, acc, input) => {
      const out = R.claim(s, item, acc, input);
      return { ...out, attempts: out.attempts.map((x) => (x.id === input.attemptId ? { ...x, idempotencyKey: x.id } : x)) };
    },
  },

  "mark not sent while queued": {
    applyToAttempt: (s, id, event, now, options) => {
      if (event.kind !== "mark_not_sent") return R.applyToAttempt(s, id, event, now, options);
      const unqueued = { ...s, attempts: s.attempts.map((a) => (a.id === id && a.lookupAnswer === "queued" ? { ...a, lookupAnswer: "unknown" as const } : a)) };
      return R.applyToAttempt(unqueued, id, event, now, options);
    },
  },

  "queued unresolved at once": {
    applyToAttempt: (s, id, event, now, options) => {
      const out = R.applyToAttempt(s, id, event, now, options);
      if (event.kind !== "lookup_answer" || event.answer.kind !== "queued") return out;
      return { ...out, state: mapAttempts(out.state, (a) => (a.id === id ? { ...a, unresolvedSince: a.unresolvedSince ?? now } : a), s) };
    },
  },

  "claim without age limit": {
    applyToAttempt: (s, id, event, now, options) => (event.kind === "claim_expired" ? { state: s, effects: [] } : R.applyToAttempt(s, id, event, now, options)),
  },

  "accepted never settles": afterEveryChange((before, after) => mapAttempts(after, (a) => (a.state === "accepted" ? { ...a, nextLookupWall: null } : a), before)),

  "stale apply": { versionsMatch: () => true },

  "handover without re-check": {
    handoverFailures: (s, a, acc, now) => R.handoverFailures(s, a, acc, now).filter((n) => n === 16 || n === 15),
  },

  "handover out of priority order": { handoverOrder: (a, b) => -R.handoverOrder(a, b) },

  "pacing at claim": {
    claim: (s, item, acc, input) => {
      const out = R.claim(s, item, acc, input);
      const account = out.accounts[acc.id];
      return account ? { ...out, accounts: { ...out.accounts, [acc.id]: { ...account, nextSlotAt: input.now + account.gapMs } } } : out;
    },
    handoverFailures: (s, a, acc, now) => R.handoverFailures(s, a, acc, now).filter((n) => n !== 16),
    handOver: (s, a, acc, now) => {
      const out = R.handOver(s, a, acc, now);
      return { ...out, accounts: { ...out.accounts, [acc.id]: { ...out.accounts[acc.id]!, nextSlotAt: acc.nextSlotAt } } };
    },
    retryFailures: (s, a, acc, now) => R.retryFailures(s, a, acc, now).filter((f) => f !== "slot"),
  },

  "sender fixed at claim": {
    claim: (s, item, acc, input) => {
      const out = R.claim(s, item, acc, input);
      return { ...out, subject: { ...out.subject, emailSender: out.subject.emailSender ?? acc.id } };
    },
  },

  "withdrawal clears deadline": afterEveryChange((before, after, now) => {
    const withdrawn = after.attempts.filter((a) => a.state === "withdrawn" && before.attempts.find((b) => b.id === a.id)?.state === "claimed");
    if (withdrawn.length === 0) return after;
    const lead = leadNow(after.subject.clock, now);
    return {
      ...after,
      tracks: after.tracks.map((t) => (withdrawn.some((a) => a.trackId === t.trackId) && t.finishedAt === null ? { ...t, basisAt: lead, dueAt: lead, dueWall: wallOfLead(after.subject.clock, now) } : t)),
    };
  }),

  "basis from observation": { sendPoint: (clock, freezes, _t, handed, now) => R.sendPoint(clock, freezes, now, handed, now) },

  "clamp fallback": {
    sendPoint: (clock, _freezes, t, handed, now) => {
      const sent = Math.min(Math.max(t, handed), now);
      return { at: leadNow(clock, now) - (now - sent), atWall: sent };
    },
  },

  "late send resolves successor": {
    applyToAttempt: (s, id, event, now, options) => {
      const out = R.applyToAttempt(s, id, event, now, options);
      const attempt = out.state.attempts.find((a) => a.id === id);
      const track = out.state.campaign.definition.tracks.find((t) => t.id === attempt?.trackId);
      const progress = out.state.tracks.find((t) => t.trackId === attempt?.trackId);
      if (!attempt || attempt.state !== "sent" || !track || !progress || progress.finishedAt === null) return out;
      const next = nextStepOf(out.state, track);
      return { ...out, state: { ...out.state, tracks: out.state.tracks.map((t) => (t === progress ? { ...t, nextStepId: next } : t)) } };
    },
  },

  "capacity off by one": {
    chooseAccount: (s, now) => R.chooseAccount({ ...s, accounts: Object.fromEntries(Object.entries(s.accounts).map(([k, a]) => [k, { ...a, capacity: a.capacity + 1 }])) }, now),
  },

  window: {
    claimRefusal: (s, item, now) => {
      const refusal = R.claimRefusal(s, item, now);
      return refusal === "the sending window is closed" ? null : refusal;
    },
    handoverFailures: (s, a, acc, now) => R.handoverFailures(s, a, acc, now).filter((n) => n !== 8),
  },

  "touched at claim": {
    claim: (s, item, acc, input) => {
      const out = R.claim(s, item, acc, input);
      return { ...out, subject: { ...out.subject, touched: true } };
    },
  },
};
