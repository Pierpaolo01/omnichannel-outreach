import { finishTrack, progressOf } from "../../src/domain/sequence/progress.ts";
import { leadNow, wallOfLead } from "../../src/domain/sequence/clock.ts";
import type { SubjectState, TrackProgress } from "../../src/domain/sequence/state.ts";
import { DEFAULT_RULES, type Rules } from "../../src/server/engine/rules.ts";

/**
 * Deliberately broken engines for coordination between tracks (ADR 0003 9.2 step 5, the ticket 13
 * row of 9.3): the ADR's four, and one for each further rule ticket 13 adds. Each replaces one
 * decision; the generated track runs (generated-tracks.ts) must fail the invariant it names.
 */

const R = DEFAULT_RULES;
const DAY = 86_400_000;

/** Replaces each track progress `evaluate` resolves or starts with `fix(before, after)`. */
function onStarts(fix: (s: SubjectState, before: TrackProgress | undefined, after: TrackProgress) => TrackProgress | null): Partial<Rules> {
  return {
    evaluate: (s, now, options) => {
      const out = R.evaluate(s, now, options);
      const tracks = out.tracks.flatMap((t) => {
        const before = progressOf(s, t.trackId);
        if (before?.startAt != null) return [t];
        const fixed = fix(out, before, t);
        return fixed ? [fixed] : before ? [before] : [];
      });
      return { ...out, tracks };
    },
  };
}

const startRule = (s: SubjectState, trackId: string) => s.campaign.definition.tracks.find((t) => t.id === trackId)?.start;
const smsAccount = (s: SubjectState, id: string) => s.accounts[id]?.channel === "sms";
/** The bindings other subjects hold whose owner has ended, which a broken engine treats as free. */
const withoutEndedOwners = (s: SubjectState): SubjectState => ({ ...s, smsBindings: s.smsBindings.filter((b) => !b.ownerEnded || b.owner === s.subject.id) });

const RULES: Record<string, Partial<Rules>> = {
  // ADR 0003 9.3, ticket 13.
  "SMS reply to the newest campaign": {
    smsReplyOwner: (bindings) => bindings.filter((b) => !b.released).at(-1)?.owner ?? null,
  },
  "binding transferred after an end": {
    chooseAccount: (s, now, stepId) => R.chooseAccount(withoutEndedOwners(s), now, stepId),
    handoverFailures: (s, a, acc, now) => R.handoverFailures(withoutEndedOwners(s), a, acc, now),
    handOver: (s, a, acc, now) => {
      const out = R.handOver(withoutEndedOwners(s), a, acc, now);
      return { ...out, smsBindings: out.smsBindings.filter((b) => b.sender !== acc.id || b.recipient !== a.destination || b.owner === s.subject.id) };
    },
  },
  "binding fixed at claim": {
    claim: (s, item, acc, input) => {
      const out = R.claim(s, item, acc, input);
      const claimed = out.attempts.find((x) => x.id === input.attemptId);
      if (!claimed || acc.channel !== "sms" || out.smsBindings.some((b) => b.sender === acc.id && b.recipient === claimed.destination)) return out;
      return { ...out, smsBindings: [...out.smsBindings, { sender: acc.id, recipient: claimed.destination, owner: s.subject.id, ownerCampaignId: s.campaign.id, ownerEnded: false }] };
    },
  },
  "ending check too late": {
    evaluate: (s, now) => R.evaluate(s, now, { endingsFirst: false }),
  },

  // One per further rule of ticket 13.
  "after counts from the earlier track's start": onStarts((s, _before, t) => {
    const rule = startRule(s, t.trackId);
    const earlier = rule?.kind === "after" ? progressOf(s, rule.trackId) : undefined;
    if (!earlier || earlier.startedAt === null || earlier.finishedAt === null || t.startAt === null) return t;
    return { ...t, startAt: t.startAt - (earlier.finishedAt - earlier.startedAt), startedAt: t.startedAt === null ? null : t.startedAt - (earlier.finishedAt - earlier.startedAt) };
  }),
  "after delay ignored": onStarts((s, _before, t) => {
    const rule = startRule(s, t.trackId);
    const earlier = rule?.kind === "after" ? progressOf(s, rule.trackId) : undefined;
    if (!earlier || earlier.finishedAt === null || t.startAt === null || t.startAt === earlier.finishedAt) return t;
    return { ...t, startAt: earlier.finishedAt };
  }),
  "together tracks not together": onStarts((s, _before, t) => {
    const rule = startRule(s, t.trackId);
    const first = s.campaign.definition.tracks.find((x) => x.start.kind === "entry");
    if (rule?.kind !== "entry" || first?.id === t.trackId || t.startAt === null) return t;
    return { ...t, startAt: t.startAt + DAY, startedAt: null, destinationDetailId: null, nextStepId: null, finishedAt: null, finishedWall: null, finishReason: null };
  }),
  "a skipped or failed track releases nothing": onStarts((s, _before, t) => {
    const rule = startRule(s, t.trackId);
    const earlier = rule?.kind === "after" ? progressOf(s, rule.trackId) : undefined;
    return earlier && earlier.finishReason !== "completed" ? null : t;
  }),
  "SMS reply stops only the SMS tracks": {
    applyReply: (s, reply, now) => {
      if (reply.channel !== "sms") return R.applyReply(s, reply, now);
      if (s.replies.some((r) => r.providerRef === reply.providerRef)) return s;
      let out: SubjectState = { ...s, replies: [...s.replies, reply] };
      for (const t of s.campaign.definition.tracks) if (t.channel === "sms") out = finishTrack(out, t.id, "skipped_by_user", leadNow(out.subject.clock, now), wallOfLead(out.subject.clock, now));
      return out;
    },
  },
  "SMS capacity ignored": {
    chooseAccount: (s, now, stepId) => R.chooseAccount({ ...s, accounts: Object.fromEntries(Object.entries(s.accounts).map(([id, a]) => [id, smsAccount(s, id) ? { ...a, used: 0 } : a])) }, now, stepId),
  },
  "SMS sender not fixed": {
    handOver: (s, a, acc, now) => {
      const out = R.handOver(s, a, acc, now);
      return acc.channel === "sms" ? { ...out, subject: { ...out.subject, smsSender: null } } : out;
    },
  },
  "SMS to any phone": {
    evaluate: (s, now, options) => R.evaluate({ ...s, lead: { ...s.lead, details: s.lead.details.map((d) => (d.channel === "phone" ? { ...d, mobile: true } : d)) } }, now, options),
  },
};

/** The invariant each mutation must break, and the seed offset known to show it (refreshed by the CI search). */
const EXPECTED: Record<string, { invariant: string; seed: number }> = {
  "SMS reply to the newest campaign": { invariant: "14", seed: 7 },
  "binding transferred after an end": { invariant: "14", seed: 0 },
  "binding fixed at claim": { invariant: "14", seed: 12 },
  "ending check too late": { invariant: "20", seed: 0 },
  "after counts from the earlier track's start": { invariant: "7", seed: 22 },
  "after delay ignored": { invariant: "7", seed: 3 },
  "together tracks not together": { invariant: "7", seed: 0 },
  "a skipped or failed track releases nothing": { invariant: "7", seed: 0 },
  "SMS reply stops only the SMS tracks": { invariant: "14", seed: 0 },
  "SMS capacity ignored": { invariant: "10", seed: 0 },
  "SMS sender not fixed": { invariant: "14", seed: 16 },
  "SMS to any phone": { invariant: "20", seed: 0 },
};

export const TRACK_MUTATIONS: Record<string, { readonly rules: Partial<Rules>; readonly invariant: string; readonly seed: number }> = Object.fromEntries(
  Object.entries(EXPECTED).map(([name, e]) => {
    const rules = RULES[name];
    if (!rules) throw new Error(`no mutation named ${name}`);
    return [name, { rules, ...e }];
  }),
);
