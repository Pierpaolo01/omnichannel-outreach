import { ENGINE_PARAMS } from "../../src/domain/sequence/attempt.ts";
import { leadNow, wallOfLead } from "../../src/domain/sequence/clock.ts";
import { renderStep } from "../../src/domain/sequence/dispatch.ts";
import { nextStepOf } from "../../src/domain/sequence/progress.ts";
import type { Attempt, ProviderWork, SubjectState } from "../../src/domain/sequence/state.ts";
import { isLive } from "../../src/domain/sequence/attempt.ts";
import { DEFAULT_RULES, type Rules } from "../../src/server/engine/rules.ts";
import * as REGRESSIONS from "./regressions.ts";

/**
 * Deliberately broken engines (ADR 0003 9.2 step 5, the ticket 12 row of 9.3). Each replaces one
 * decision; the generated runs must fail on every one.
 */

const R = DEFAULT_RULES;

/**
 * The invariant each mutation must break, and the seed offset known to show it on the current
 * generator (refreshed by the CI search, `.github/workflows/sequence-search.yml`). A mutation the
 * generated test does not reach names instead the hand-written regression (in `regressions.ts`)
 * that fails under it; `pnpm check` runs that, and the search asserts it too. None is skipped.
 */
const EXPECTED: Record<string, { invariant: string; seed: number | null; unlimited?: boolean; regression?: keyof typeof REGRESSIONS }> = {
  "withdraw handed": { invariant: "5", seed: 21 },
  "retry non-retryable": { invariant: "5", seed: 0 },
  "retry after withdraw": { invariant: "2", seed: 56, regression: "noRetryAfterWithdraw" },
  "retry without slot or predicates": { invariant: "11", seed: 0 },
  "retry re-renders": { invariant: "5", seed: 85 },
  "new key after not-sent": { invariant: "5", seed: 72 },
  "mark not sent while queued": { invariant: "26", seed: 73 },
  "queued unresolved at once": { invariant: "26", seed: 2 },
  "claim without age limit": { invariant: "26", seed: 1 },
  "accepted never settles": { invariant: "26", seed: null, regression: "acceptedWorkSettles" },
  "stale apply": { invariant: "24", seed: 6 },
  "handover without re-check": { invariant: "2", seed: 21 },
  "handover out of priority order": { invariant: "12", seed: 0 },
  "pacing at claim": { invariant: "11", seed: 5 },
  "sender fixed at claim": { invariant: "1.3", seed: 0 },
  "withdrawal clears deadline": { invariant: "9", seed: 1 },
  "basis from observation": { invariant: "9", seed: 5 },
  "clamp fallback": { invariant: "9", seed: 5 },
  "late send resolves successor": { invariant: "9", seed: 5 },
  "capacity off by one": { invariant: "10", seed: 3 },
  window: { invariant: "13", seed: 5 },
  "touched at claim": { invariant: "1", seed: 1 },
  "uncertain work releases its reservation": { invariant: "10", seed: 85 },
  "send settled on the inheritor": { invariant: "9", seed: null, regression: "sendSettlesOnOriginalWork" },
  "retry blocks settlement": { invariant: "26", seed: 1 },
  "unresolved ignores not-sent": { invariant: "18", seed: null, regression: "unresolvedThenNotSent" },
  "lookup sent without reference": { invariant: "8", seed: null, regression: "lookupSentKeepsThread" },
  "acceptance keeps retry intent": { invariant: "26", seed: null, regression: "lateAcceptanceSettles" },
  "stale guard ignores lead facts": { invariant: "1", seed: null, regression: "reimportBeatsStaleEnding" },
  "no send pause": { invariant: "2", seed: null, regression: "fallbackScopeAndPause" },
  "user's not sent leaves the work unsettled": { invariant: "27", seed: 72, regression: "markNotSentFreesCapacity" },
  "settled work inherited": { invariant: "5", seed: 72, regression: "settledKeyNotInherited" },
  "fallback matches every call": { invariant: "1", seed: null, regression: "fallbackScopeAndPause" },
  "handover of settled work": { invariant: "2", seed: null, regression: "claimedInheritorRetired" },
};

/** Wraps every rule that returns a new subject state with `fix(before, after, now)`. */
function afterEveryChange(fix: (before: SubjectState, after: SubjectState, now: number) => SubjectState): Partial<Rules> {
  return {
    evaluate: (s, now) => fix(s, R.evaluate(s, now), now),
    applyReply: (s, reply, now) => fix(s, R.applyReply(s, reply, now), now),
    applyBadDestination: (s, a, now) => fix(s, R.applyBadDestination(s, a, now), now),
    applyToAttempt: (s, id, event, now) => {
      const out = R.applyToAttempt(s, id, event, now);
      return { ...out, state: fix(s, out.state, now) };
    },
    applyToWork: (s, key, event, now, options) => {
      const out = R.applyToWork(s, key, event, now, options);
      return { ...out, state: fix(s, out.state, now) };
    },
  };
}

const mapAttempts = (s: SubjectState, f: (a: Attempt, before: Attempt | undefined) => Attempt, before: SubjectState): SubjectState => ({
  ...s,
  attempts: s.attempts.map((a) => f(a, before.attempts.find((b) => b.id === a.id))),
});

const mapWork = (s: SubjectState, f: (w: ProviderWork) => ProviderWork): SubjectState => ({ ...s, work: s.work.map(f) });

const liveOn = (s: SubjectState, key: string) => s.attempts.find((a) => a.idempotencyKey === key && isLive(a));

const RULES: Record<string, Partial<Rules>> = {
  "withdraw handed": afterEveryChange((before, after) =>
    mapAttempts(after, (a, b) => (a.withdrawRequested && !b?.withdrawRequested && (a.state === "handed" || a.state === "accepted") ? { ...a, state: "withdrawn", endedBy: "quiesce" } : a), before),
  ),

  "retry non-retryable": {
    applyToAttempt: (s, id, event, now) => {
      const out = R.applyToAttempt(s, id, event, now);
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
      const claimed = out.attempts.find((x) => x.id === input.attemptId);
      const inherited = claimed && claimed.idempotencyKey !== claimed.id ? out.work.find((w) => w.key === claimed.idempotencyKey) : undefined;
      if (!claimed || !inherited) return out;
      const fresh: ProviderWork = { ...inherited, key: claimed.id, calls: 0, firstHandedWall: null, providerRef: null, settled: null, sentWall: null, sentDay: null, nextLookupWall: null, lookupAnswer: null, queuedLookups: 0, unresolvedSince: null };
      return { ...out, attempts: out.attempts.map((x) => (x.id === claimed.id ? { ...x, idempotencyKey: x.id } : x)), work: [...out.work, fresh] };
    },
  },

  "mark not sent while queued": {
    applyToWork: (s, key, event, now, options) => {
      if (event.kind !== "mark_not_sent") return R.applyToWork(s, key, event, now, options);
      return R.applyToWork(mapWork(s, (w) => (w.key === key && w.lookupAnswer === "queued" ? { ...w, lookupAnswer: "unknown" } : w)), key, event, now, options);
    },
  },

  "queued unresolved at once": {
    applyToWork: (s, key, event, now, options) => {
      const out = R.applyToWork(s, key, event, now, options);
      if (event.kind !== "lookup_answer" || event.answer.kind !== "queued") return out;
      return { ...out, state: mapWork(out.state, (w) => (w.key === key && w.settled === null ? { ...w, unresolvedSince: w.unresolvedSince ?? now } : w)) };
    },
  },

  "claim without age limit": {
    applyToAttempt: (s, id, event, now) => (event.kind === "claim_expired" ? { state: s, effects: [] } : R.applyToAttempt(s, id, event, now)),
  },

  "accepted never settles": afterEveryChange((_before, after) => mapWork(after, (w) => (liveOn(after, w.key)?.state === "accepted" ? { ...w, nextLookupWall: null } : w))),

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
    applyToWork: (s, key, event, now, options) => {
      const out = R.applyToWork(s, key, event, now, options);
      const attempt = out.state.attempts.find((a) => a.idempotencyKey === key && a.state === "sent");
      const track = out.state.campaign.definition.tracks.find((t) => t.id === attempt?.trackId);
      const progress = out.state.tracks.find((t) => t.trackId === attempt?.trackId);
      if (!attempt || !track || !progress || progress.finishedAt === null) return out;
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
  "uncertain work releases its reservation": afterEveryChange((_before, after) =>
    mapWork(after, (w) => (w.settled === null && w.calls > 0 && !liveOn(after, w.key) ? { ...w, settled: "not_sent", nextLookupWall: null } : w)),
  ),

  "send settled on the inheritor": {
    applyToWork: (s, key, event, now, options) => {
      const live = liveOn(s, key);
      const sentFact = event.kind === "sent_observed" || (event.kind === "lookup_answer" && event.answer.kind === "sent");
      if (!live || !sentFact) return R.applyToWork(s, key, event, now, options);
      // Hide the original work's earlier attempts from the routing, so the live inheritor takes the send.
      const hidden = new Map(s.attempts.filter((a) => a.id !== live.id && a.idempotencyKey === key).map((a) => [a.id, a.handedWall]));
      const out = R.applyToWork({ ...s, attempts: s.attempts.map((a) => (hidden.has(a.id) ? { ...a, handedWall: null } : a)) }, key, event, now, options);
      return { ...out, state: { ...out.state, attempts: out.state.attempts.map((a) => (hidden.has(a.id) ? { ...a, handedWall: hidden.get(a.id) ?? null } : a)) } };
    },
  },

  "retry blocks settlement": afterEveryChange((_before, after) => mapWork(after, (w) => {
    const live = liveOn(after, w.key);
    return live && (live.retry === "wanted" || live.retry === "wanted_after_not_sent") ? { ...w, nextLookupWall: null } : w;
  })),

  "unresolved ignores not-sent": {
    applyToWork: (s, key, event, now, options) => {
      const w = s.work.find((x) => x.key === key);
      if (w?.unresolvedSince != null && event.kind === "lookup_answer" && event.answer.kind === "not-sent") return { state: s, effects: [] };
      return R.applyToWork(s, key, event, now, options);
    },
  },

  "lookup sent without reference": {
    applyToWork: (s, key, event, now, options) =>
      R.applyToWork(s, key, event.kind === "lookup_answer" && event.answer.kind === "sent" ? { ...event, answer: { ...event.answer, providerRef: null } } : event, now, options),
  },

  // Review bot, round 1.
  "acceptance keeps retry intent": {
    applyToAttempt: (s, id, event, now) => {
      const before = s.attempts.find((a) => a.id === id);
      const out = R.applyToAttempt(s, id, event, now);
      if (event.kind !== "call_answer" || event.answer.kind !== "accepted" || !before || (before.retry !== "wanted" && before.retry !== "wanted_after_not_sent")) return out;
      const kept = mapAttempts(out.state, (a) => (a.id === id && a.state === "accepted" ? { ...a, retry: before.retry } : a), s);
      return { ...out, state: mapWork(kept, (w) => (w.key === before.idempotencyKey ? { ...w, nextLookupWall: null } : w)) };
    },
  },

  "stale guard ignores lead facts": {
    versionsMatch: (a, b) => a.subject.version === b.subject.version && a.campaign.version === b.campaign.version && a.campaign.definitionVersion === b.campaign.definitionVersion,
  },

  // Review rounds 2 and 3: the send pause, work settlement, inheritance and the reply fallback.
  "no send pause": {
    handoverFailures: (s, a, acc, now) => R.handoverFailures(s, a, acc, now).filter((n) => n !== 18),
    retryFailures: (s, a, acc, now) => R.retryFailures(s, a, acc, now).filter((f) => f !== "predicate 18"),
  },

  "user's not sent leaves the work unsettled": {
    applyToWork: (s, key, event, now, options) => {
      const out = R.applyToWork(s, key, event, now, options);
      if (event.kind !== "mark_not_sent") return out;
      return { ...out, state: mapWork(out.state, (w) => (w.key === key && w.settled === "user_not_sent" ? { ...w, settled: null, nextLookupWall: now + ENGINE_PARAMS.SETTLING } : w)) };
    },
  },

  "settled work inherited": {
    claim: (s, item, acc, input) => {
      const out = R.claim(s, item, acc, input);
      const settled = s.work.find((w) => w.stepId === item.stepId && w.calls > 0 && w.accountId === acc.id && (w.settled === "user_not_sent" || w.settled === "withdrawn" || w.settled === "rejected"));
      const claimed = out.attempts.find((x) => x.id === input.attemptId);
      if (!settled || !claimed || claimed.idempotencyKey !== claimed.id) return out;
      return { ...out, attempts: out.attempts.map((x) => (x.id === claimed.id ? { ...x, idempotencyKey: settled.key } : x)), work: out.work.filter((w) => w.key !== claimed.id) };
    },
  },

  // Review bot on 0dc88ab: a claimed attempt outlives its work's settlement and is handed over.
  "handover of settled work": {
    ...afterEveryChange((before, after) =>
      mapAttempts(after, (a, b) => (b?.state === "claimed" && a.state === "withdrawn" && a.endedBy === "guard" && after.work.some((w) => w.key === a.idempotencyKey && w.settled !== null) ? { ...a, state: "claimed", endedBy: null } : a), before),
    ),
    handoverFailures: (s, a, acc, now) => R.handoverFailures(s, a, acc, now).filter((n) => n !== 15),
  },

  "fallback matches every call": {
    replyMatches: (_s, w, reply) => w.accountId === reply.inbox && w.destination.toLowerCase() === reply.address.toLowerCase() && w.firstHandedWall !== null,
  },
};

/**
 * Each broken engine with the invariant expected to catch it (ruling 7): its check passes only if
 * that invariant's check fails, and `seed` is a known seed that kills it, run on every `pnpm check`.
 */
export const MUTATIONS: Record<string, { readonly rules: Partial<Rules>; readonly invariant: string; readonly seed: number | null; readonly unlimited?: boolean; readonly regression?: keyof typeof REGRESSIONS }> = Object.fromEntries(
  Object.entries(EXPECTED).map(([name, e]) => {
    const rules = RULES[name];
    if (!rules) throw new Error(`no mutation named ${name}`);
    return [name, { rules, ...e }];
  }),
);
