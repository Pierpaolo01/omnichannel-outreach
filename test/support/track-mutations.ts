import { applyReply, candidatesFor, finishTrack, progressOf } from "../../src/domain/sequence/progress.ts";
import { leadNow, wallOfLead } from "../../src/domain/sequence/clock.ts";
import type { StoredReplyId } from "../../src/domain/sequence/reply-identity.ts";
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

/** Moves every track this change finished with `reason` one day later, finish and lead time alike. */
function finishesLate(reason: TrackProgress["finishReason"]): Partial<Rules> {
  const fix = (before: SubjectState, after: SubjectState): SubjectState => ({
    ...after,
    tracks: after.tracks.map((t) => (t.finishReason === reason && progressOf(before, t.trackId)?.finishedAt == null && t.finishedAt !== null && t.finishedWall !== null ? { ...t, finishedAt: t.finishedAt + DAY, finishedWall: t.finishedWall + DAY } : t)),
  });
  return {
    evaluate: (s, now, options) => fix(s, R.evaluate(s, now, options)),
    applyBadDestination: (s, a, now) => fix(s, R.applyBadDestination(s, a, now)),
    applyToAttempt: (s, id, event, now) => {
      const out = R.applyToAttempt(s, id, event, now);
      return { ...out, state: fix(s, out.state) };
    },
    applyToWork: (s, key, event, now, options) => {
      const out = R.applyToWork(s, key, event, now, options);
      return { ...out, state: fix(s, out.state) };
    },
  };
}

/** Priority with one ordering rule broken, at the claim and at the handover alike. */
function priority(compare: Rules["claimOrder"]): Partial<Rules> {
  return { claimOrder: compare, handoverOrder: compare };
}

const startRule = (s: SubjectState, trackId: string) => s.campaign.definition.tracks.find((t) => t.id === trackId)?.start;
const smsAccount = (s: SubjectState, id: string) => s.accounts[id]?.channel === "sms";
/** The mobile each of the subject's started SMS tracks texts (E.164), by track. */
function smsMobiles(s: SubjectState): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of s.tracks) {
    if (s.campaign.definition.tracks.find((t) => t.id === p.trackId)?.channel !== "sms" || p.destinationDetailId === null) continue;
    const live = s.lead.resolved[p.destinationDetailId]?.liveId;
    const key = s.lead.details.find((d) => d.id === live)?.key;
    if (key) out.set(p.trackId, key);
  }
  return out;
}
const PRETEND = "mutation-pretended-owner";
/** The state with every pool number `which` picks bound to someone else for the subject's mobiles; the bindings come off again after. */
function pretendTaken(s: SubjectState, which: (accountId: string, s: SubjectState, trackId: string) => boolean): SubjectState {
  const fake = [...smsMobiles(s)].flatMap(([trackId, recipient]) =>
    (s.campaign.definition.smsPool ?? [])
      .filter((n) => which(n, s, trackId) && !s.smsBindings.some((b) => b.sender === n && b.recipient === recipient))
      .map((n) => ({ sender: n, recipient, owner: PRETEND, ownerCampaignId: null, ownerCampaignName: null, ownerIsTest: false, ownerEnded: false, ownerSent: true, ownerAnswered: false, channel: "sms" as const })),
  );
  return fake.length === 0 ? s : { ...s, smsBindings: [...s.smsBindings, ...fake] };
}
const unpretend = (out: SubjectState): SubjectState => (out.smsBindings.some((b) => b.owner === PRETEND) ? { ...out, smsBindings: out.smsBindings.filter((b) => b.owner !== PRETEND) } : out);
/** Another subject's binding on one of the subject's mobiles: the conversation is taken on that number. */
const takenByOther = (s: SubjectState, n: string, trackId: string) => s.smsBindings.some((b) => b.sender === n && b.recipient === smsMobiles(s).get(trackId) && b.owner !== s.subject.id);
/** The other subjects' bindings on the mobile of any of the subject's SMS tracks with no free number left. */
function withoutTakenOwners(s: SubjectState): SubjectState {
  const mobiles = new Set([...smsMobiles(s)].filter(([trackId]) => candidatesFor(s, trackId).length === 0).map(([, m]) => m));
  return mobiles.size === 0 ? s : { ...s, smsBindings: s.smsBindings.filter((b) => !mobiles.has(b.recipient) || b.owner === s.subject.id) };
}

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
      return { ...out, smsBindings: [...out.smsBindings, { sender: acc.id, recipient: claimed.destination, owner: s.subject.id, ownerCampaignId: s.campaign.id, ownerCampaignName: null, ownerIsTest: s.subject.kind === "test_run", ownerEnded: false, ownerSent: false, ownerAnswered: false, channel: "sms" as const }] };
    },
  },
  "ending check too late": {
    evaluate: (s, now) => R.evaluate(s, now, { endingsFirst: false }),
  },

  // Question Q7 answered (ADR 0003, 15 November 2026): one per rule of the skip.
  "held instead of skipped": {
    evaluate: (s, now, options) => R.evaluate(s, now, { ...options, skipTakenConversations: false }),
  },
  // "Any" instead of "every": one number taken by someone else is taken as all of them.
  "skipped although a free number had room": {
    evaluate: (s, now, options) => unpretend(R.evaluate(pretendTaken(s, (_n, x, trackId) => (x.campaign.definition.smsPool ?? []).some((m) => takenByOther(x, m, trackId))), now, options)),
  },
  // A free number with no room left today is taken as taken.
  "skipped because today's capacity ran out": {
    evaluate: (s, now, options) => unpretend(R.evaluate(pretendTaken(s, (n, x) => { const a = x.accounts[n]; return a !== undefined && a.used >= a.capacity; }), now, options)),
  },
  "a later free number reopens the track": {
    evaluate: (s, now, options) => {
      const out = R.evaluate(s, now, options);
      const reopened = out.tracks.map((p) => (p.finishReason === "skipped_conversation_taken" && candidatesFor(out, p.trackId).length > 0 ? { ...p, finishedAt: null, finishedWall: null, finishReason: null } : p));
      return reopened.some((p, i) => p !== out.tracks[i]) ? { ...out, tracks: reopened } : out;
    },
  },
  // The second campaign texts the mobile from a number whose conversation another subject owns.
  "the binding moves to the second campaign": {
    evaluate: (s, now, options) => R.evaluate(s, now, { ...options, skipTakenConversations: false }),
    chooseAccount: (s, now, stepId) => R.chooseAccount(withoutTakenOwners(s), now, stepId),
    handoverFailures: (s, a, acc, now) => R.handoverFailures(withoutTakenOwners(s), a, acc, now),
    handOver: (s, a, acc, now) => {
      const out = R.handOver(withoutTakenOwners(s), a, acc, now);
      return { ...out, smsBindings: [...s.smsBindings, ...out.smsBindings.filter((b) => !s.smsBindings.some((x) => x.sender === b.sender && x.recipient === b.recipient))] };
    },
  },
  // Inside the reply rule itself: the newest record of the number's conversations with the mobile, a recorded skip
  // included, takes the reply, so the lead that skipped is stopped by the owner's reply on the real reply path.
  "the skipping lead is stopped by the owner's reply": {
    smsReplyOwner: (records, sender) => records.filter((r) => r.sender === sender && (r.kind === "skipped" || !r.unsent)).at(-1)?.owner ?? null,
  },
  // Point 10: a first text refused or never sent keeps its conversation, as if a text had gone.
  "a binding with nothing sent counts as taken": {
    releaseUnsent: (s) => s,
    evaluate: (s, now, options) => ({ ...R.evaluate({ ...s, smsBindings: s.smsBindings.map((b) => ({ ...b, ownerSent: true, ownerAnswered: false, channel: "sms" as const })) }, now, options), smsBindings: s.smsBindings }),
  },

  // The worker's readiness cache ("nothing is ready until") kept across a change of conversations: a lead held on an
  // unsettled conversation is not looked at again when the owner's text becomes known (sent, or released as unsent).
  "a claim cache ignores a change of conversations": {
    readinessHolds: (entry, now) => now < entry.until,
  },

  // The reply rule while the owner's first text is unknown (the coordinator's ruling on item 3 of faac357's review):
  // inside the reply rule, a binding without a text known sent or answered takes no reply, so the reply is dropped as
  // from an unknown sender and the owner runs on.
  "a reply while unsettled is dropped": {
    smsReplyOwner: (records, sender) => R.smsReplyOwner(records.filter((r) => r.kind !== "binding" || r.confirmed || r.released), sender),
  },
  // The waiting subject treated as answered by the reply on the owner's unsettled pair. The reply rule names one owner and
  // cannot reach another subject, so this lives where the waiting subject reads that pair: its evaluation, which sees the
  // binding answered while its text is not known sent.
  "a reply while unsettled stops the waiting subject": {
    evaluate: (s, now, options) => {
      const out = R.evaluate(s, now, options);
      const answered = out.subject.ended === null && out.smsBindings.some((b) => b.owner !== s.subject.id && b.ownerAnswered && !b.ownerSent && [...smsMobiles(out).values()].includes(b.recipient));
      return answered ? applyReply(out, { channel: "sms", atWall: now, providerRef: `sms:mutation-${s.subject.id}` as StoredReplyId }, now) : out;
    },
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
  "an email reply stops only the email tracks": {
    applyReply: (s, reply, now) => {
      if (reply.channel !== "email") return R.applyReply(s, reply, now);
      if (s.replies.some((r) => r.providerRef === reply.providerRef)) return s;
      let out: SubjectState = { ...s, replies: [...s.replies, reply] };
      for (const t of s.campaign.definition.tracks) if (t.channel === "email") out = finishTrack(out, t.id, "skipped_by_user", leadNow(out.subject.clock, now), wallOfLead(out.subject.clock, now));
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

  // Verifier B2: a finish the record derives on its own, so a late one shows in every release after it.
  "a failed track finishes a day late": finishesLate("failed_bad_destination"),
  "a skipped track finishes a day late": finishesLate("skipped_missing_channel"),

  // Verifier F1: each ordering rule of 4.3, across both channels.
  "first messages before follow-ups": priority((a, b) => R.claimOrder({ ...a, touched: !a.touched }, { ...b, touched: !b.touched })),
  "newest due first": priority((a, b) => (a.touched !== b.touched || a.dueWall === b.dueWall ? R.claimOrder(a, b) : b.dueWall - a.dueWall)),
};

/** The invariant each mutation must break, and the seed offset known to show it (refreshed by the CI search). */
const EXPECTED: Record<string, { invariant: string; seed: number }> = {
  "SMS reply to the newest campaign": { invariant: "14", seed: 0 },
  "binding transferred after an end": { invariant: "14", seed: 0 },
  // Moved twice by question Q7's answer. At bebdc06 a conversation bound at a claim skipped the other lead's track (28).
  // Since point 10 a binding without a text known sent never makes a skip: it holds the other lead only while it is
  // unsettled and is released when the claim ends. What it still breaks is priority: the claim keeps another lead's
  // higher-priority item off that number (12).
  "binding fixed at claim": { invariant: "12", seed: 7 },
  "ending check too late": { invariant: "20", seed: 0 },
  "held instead of skipped": { invariant: "28", seed: 0 },
  "skipped although a free number had room": { invariant: "28", seed: 0 },
  "skipped because today's capacity ran out": { invariant: "28", seed: 3 },
  "a later free number reopens the track": { invariant: "6", seed: 43 },
  "the binding moves to the second campaign": { invariant: "14", seed: 0 },
  "the skipping lead is stopped by the owner's reply": { invariant: "14", seed: 0 },
  "a binding with nothing sent counts as taken": { invariant: "28", seed: 7 },
  "a claim cache ignores a change of conversations": { invariant: "29", seed: 50 },
  "a reply while unsettled is dropped": { invariant: "14", seed: 16 },
  "a reply while unsettled stops the waiting subject": { invariant: "14", seed: 14 },
  "after counts from the earlier track's start": { invariant: "7", seed: 12 },
  "after delay ignored": { invariant: "7", seed: 3 },
  "together tracks not together": { invariant: "7", seed: 0 },
  "a skipped or failed track releases nothing": { invariant: "7", seed: 0 },
  "SMS reply stops only the SMS tracks": { invariant: "14", seed: 0 },
  "an email reply stops only the email tracks": { invariant: "14", seed: 0 },
  "SMS capacity ignored": { invariant: "10", seed: 0 },
  "SMS sender not fixed": { invariant: "14", seed: 16 },
  "SMS to any phone": { invariant: "20", seed: 0 },
  "a failed track finishes a day late": { invariant: "7", seed: 0 },
  "a skipped track finishes a day late": { invariant: "7", seed: 0 },
  "first messages before follow-ups": { invariant: "12", seed: 3 },
  "newest due first": { invariant: "12", seed: 3 },
};

export const TRACK_MUTATIONS: Record<string, { readonly rules: Partial<Rules>; readonly invariant: string; readonly seed: number }> = Object.fromEntries(
  Object.entries(EXPECTED).map(([name, e]) => {
    const rules = RULES[name];
    if (!rules) throw new Error(`no mutation named ${name}`);
    return [name, { rules, ...e }];
  }),
);
