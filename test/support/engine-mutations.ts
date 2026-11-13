import { ENGINE_PARAMS } from "../../src/domain/sequence/attempt.ts";
import { leadNow, wallOfLead } from "../../src/domain/sequence/clock.ts";
import { renderStep } from "../../src/domain/sequence/dispatch.ts";
import { nextStepOf } from "../../src/domain/sequence/progress.ts";
import type { Attempt, SubjectState } from "../../src/domain/sequence/state.ts";
import { isLive } from "../../src/domain/sequence/attempt.ts";
import { DEFAULT_RULES, type Rules } from "../../src/server/engine/rules.ts";

/**
 * Deliberately broken engines (ADR 0003 9.2 step 5, the ticket 12 row of 9.3). Each replaces one
 * decision; the generated runs must fail on every one.
 */

const R = DEFAULT_RULES;

/** The invariant each mutation must break, and a seed known to show it (refreshed by `pnpm check:full`). */
const EXPECTED: Record<string, { invariant: string; seed: number; unlimited?: boolean }> = {
  "withdraw handed": { invariant: "5", seed: 0 },
  "retry non-retryable": { invariant: "5", seed: 0 },
  "retry after withdraw": { invariant: "5", seed: 0 },
  "retry without slot or predicates": { invariant: "11", seed: 0 },
  "retry re-renders": { invariant: "5", seed: 0 },
  "new key after not-sent": { invariant: "5", seed: 0 },
  "mark not sent while queued": { invariant: "26", seed: 0 },
  "queued unresolved at once": { invariant: "26", seed: 0 },
  "claim without age limit": { invariant: "26", seed: 0 },
  "accepted never settles": { invariant: "26", seed: 0 },
  "stale apply": { invariant: "24", seed: 0 },
  "handover without re-check": { invariant: "2", seed: 0 },
  "handover out of priority order": { invariant: "12", seed: 0 },
  "pacing at claim": { invariant: "11", seed: 0 },
  "sender fixed at claim": { invariant: "1.3", seed: 0 },
  "withdrawal clears deadline": { invariant: "9", seed: 0 },
  "basis from observation": { invariant: "9", seed: 0 },
  "clamp fallback": { invariant: "9", seed: 0 },
  "late send resolves successor": { invariant: "6", seed: 0 },
  "capacity off by one": { invariant: "10", seed: 0 },
  window: { invariant: "13", seed: 0 },
  "touched at claim": { invariant: "1", seed: 0 },
  "uncertain work releases its reservation": { invariant: "10", seed: 0 },
  "send settled on the inheritor": { invariant: "9", seed: 0 },
  "retry blocks settlement": { invariant: "26", seed: 0 },
  "unresolved ignores not-sent": { invariant: "18", seed: 0 },
  "lookup sent without reference": { invariant: "8", seed: 0 },
  "acceptance keeps retry intent": { invariant: "26", seed: 0 },
  "stale guard ignores lead facts": { invariant: "1", seed: 0 },
};

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

const RULES: Record<string, Partial<Rules>> = {
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

  // Review round 1.
  "uncertain work releases its reservation": afterEveryChange((before, after) =>
    mapAttempts(after, (a) => (a.state === "withdrawn" && a.endedBy === "lookup_not_sent" ? { ...a, holdsReservation: false } : a), before),
  ),

  "send settled on the inheritor": {
    applyToAttempt: (s, id, event, now, options) => {
      const target = s.attempts.find((a) => a.id === id);
      const sentFact = event.kind === "sent_observed" || (event.kind === "lookup_answer" && event.answer.kind === "sent");
      if (!target || !sentFact || !isLive(target)) return R.applyToAttempt(s, id, event, now, options);
      // Hide the original work from the routing, so the live inheritor takes the send.
      const hidden = new Map(s.attempts.filter((a) => a.id !== id && a.idempotencyKey === target.idempotencyKey).map((a) => [a.id, a.handedWall]));
      const out = R.applyToAttempt({ ...s, attempts: s.attempts.map((a) => (hidden.has(a.id) ? { ...a, handedWall: null } : a)) }, id, event, now, options);
      return { ...out, state: { ...out.state, attempts: out.state.attempts.map((a) => (hidden.has(a.id) ? { ...a, handedWall: hidden.get(a.id) ?? null } : a)) } };
    },
  },

  "retry blocks settlement": afterEveryChange((before, after) => mapAttempts(after, (a) => (a.retry === "wanted" || a.retry === "wanted_after_not_sent" ? { ...a, nextLookupWall: null } : a), before)),

  "unresolved ignores not-sent": {
    applyToAttempt: (s, id, event, now, options) => {
      const target = s.attempts.find((a) => a.id === id);
      if (target?.unresolvedSince != null && event.kind === "lookup_answer" && event.answer.kind === "not-sent") return { state: s, effects: [] };
      return R.applyToAttempt(s, id, event, now, options);
    },
  },

  "lookup sent without reference": {
    applyToAttempt: (s, id, event, now, options) =>
      R.applyToAttempt(s, id, event.kind === "lookup_answer" && event.answer.kind === "sent" ? { ...event, answer: { ...event.answer, providerRef: null } } : event, now, options),
  },

  // Review bot, round 1.
  "acceptance keeps retry intent": {
    applyToAttempt: (s, id, event, now, options) => {
      const before = s.attempts.find((a) => a.id === id);
      const out = R.applyToAttempt(s, id, event, now, options);
      if (event.kind !== "call_answer" || event.answer.kind !== "accepted" || !before || (before.retry !== "wanted" && before.retry !== "wanted_after_not_sent")) return out;
      return { ...out, state: mapAttempts(out.state, (a) => (a.id === id && a.state === "accepted" ? { ...a, retry: before.retry, nextLookupWall: null } : a), s) };
    },
  },

  "stale guard ignores lead facts": {
    versionsMatch: (a, b) => a.subject.version === b.subject.version && a.campaign.version === b.campaign.version && a.campaign.definitionVersion === b.campaign.definitionVersion,
  },
};

/**
 * Each broken engine with the invariant expected to catch it (ruling 7): its check passes only if
 * that invariant's check fails, and `seed` is a known seed that kills it, run on every `pnpm check`.
 */
export const MUTATIONS: Record<string, { readonly rules: Partial<Rules>; readonly invariant: string; readonly seed: number; readonly unlimited?: boolean }> = Object.fromEntries(
  Object.entries(EXPECTED).map(([name, e]) => {
    const rules = RULES[name];
    if (!rules) throw new Error(`no mutation named ${name}`);
    return [name, { rules, ...e }];
  }),
);
