import type { Rules } from "../../src/server/engine/rules.ts";
import { DEFAULT_RULES } from "../../src/server/engine/rules.ts";
import { SqliteEngineStore } from "../../src/server/persistence/sqlite-engine-store.ts";
import { viewRules } from "../../src/server/engine/step-when-view.ts";
import { comparePriority } from "../../src/domain/sequence/dispatch.ts";
import { end, goodAccount } from "../../src/domain/sequence/progress.ts";

/** The first of offsets 0 to 29 that killed it (17 November 2026). */
const RETARGET_SEED = 20;
import { markedReplyId } from "../../src/domain/sequence/reply-identity.ts";
import { isMessageRequestChannel } from "../../src/domain/social-channels.ts";
import type { SubjectState } from "../../src/domain/sequence/state.ts";

/**
 * Deliberately broken engines for the generated message-request runs (ADR 0004 13.9): one per invariant, each a swap of one
 * rule or one module seam. Each must make the runs fail the invariant it names, at its recorded seed offset (from
 * MESSAGE_REQUEST_SEED) in `pnpm check`; each seed is the first of offsets 0 to 29 that killed it on 17 November 2026.
 */
export interface MessageRequestMutation {
  readonly invariant: string;
  readonly seed: number;
  readonly rules: Partial<Rules>;
  /** A swap outside the engine's rules, applied for the replay and undone after it. */
  readonly patch?: () => () => void;
}

const isInstagramTrack = (s: SubjectState, trackId: string) => isMessageRequestChannel(s.campaign.definition.tracks.find((t) => t.id === trackId)?.channel);

/** The subject with its message-request details reordered: the company's account newer than the person's own (M2's mutation). */
function companyFirst(s: SubjectState): SubjectState {
  return { ...s, lead: { ...s.lead, details: s.lead.details.map((d) => (isMessageRequestChannel(d.channel) ? { ...d, order: d.belongsTo === "company" ? 1 : 0 } : d)) } };
}

/** The subject with only its own message-request pairs: other subjects' conversations with its accounts unseen (M5's mutation). */
function ownPairsOnly(s: SubjectState): SubjectState {
  return { ...s, smsBindings: s.smsBindings.filter((b) => b.owner === s.subject.id || !isMessageRequestChannel(b.channel)) };
}

/** The subject with no fixed message-request sender: neither its stored one nor its own pairs (M8's mutation). */
function unfixed(s: SubjectState): SubjectState {
  return { ...s, subject: { ...s.subject, socialSenders: {} }, smsBindings: s.smsBindings.filter((b) => !(b.owner === s.subject.id && isMessageRequestChannel(b.channel))) };
}

/**
 * The subject with each started message-request track whose account a re-import replaced pointed at the lead's account now
 * (M2's second mutation, the review of f2824d4 item 8): retargeted, where the engine skips it.
 */
function retargeted(s: SubjectState): SubjectState {
  const tracks = s.tracks.map((p) => {
    const channel = s.campaign.definition.tracks.find((t) => t.id === p.trackId)?.channel;
    if (!isMessageRequestChannel(channel) || p.startedAt === null || p.finishedAt !== null || p.destinationDetailId === null) return p;
    const dest = s.lead.resolved[p.destinationDetailId];
    if (!dest || dest.bad || dest.owned) return p;
    const now = goodAccount(s.lead.details, channel);
    return now ? { ...p, destinationDetailId: now.id } : p;
  });
  const resolved = { ...s.lead.resolved };
  for (const p of tracks) if (p.destinationDetailId !== null && resolved[p.destinationDetailId] === undefined) resolved[p.destinationDetailId] = { liveId: p.destinationDetailId, bad: false, owned: true };
  return { ...s, tracks, lead: { ...s.lead, resolved } };
}

/** Every message-request session with room for anything (M4's mutation): its allowance not read. */
function unlimited(s: SubjectState): SubjectState {
  const accounts = Object.fromEntries(
    Object.entries(s.accounts).map(([id, a]) => [id, isMessageRequestChannel(a.channel) && a.kinds ? { ...a, capacity: 99, dailyLimit: 99, kinds: { ...a.kinds, message: { capacity: 99, used: a.kinds.message.used } } } : a]),
  );
  return { ...s, accounts };
}

export const MESSAGE_REQUEST_MUTATIONS: Readonly<Record<string, MessageRequestMutation>> = {
  // M1: a message-request step's work is retryable, so a lost answer is handed over again under its key.
  "a lost answer handed over again": {
    invariant: "M1",
    seed: 2,
    rules: { claim: (state, item, account, input) => DEFAULT_RULES.claim(state, item, account, isInstagramTrack(state, item.trackId) ? { ...input, retryable: true } : input) },
  },
  // M2: the company's account preferred to the person's own.
  "the company's account preferred to the person's own": {
    invariant: "M2",
    seed: 0,
    rules: { evaluate: (state, now, options) => DEFAULT_RULES.evaluate(companyFirst(state), now, options) },
  },
  // M3: a reply mark recorded without ending the lead.
  "a mark recorded without ending the lead": {
    invariant: "M3",
    seed: 29,
    rules: {
      markReplied: (state, requestId, now, channel) => {
        const refused = DEFAULT_RULES.markReplied(state, requestId, now, channel);
        if (!refused.ok) return refused;
        return { ok: true, state: { ...state, replies: [...state.replies, { channel, atWall: now, providerRef: markedReplyId(channel, requestId) }] } };
      },
    },
  },
  // M4: one bucket for every session: the message allowance not read.
  "the message allowance ignored": {
    invariant: "M4",
    seed: 1,
    rules: { chooseAccount: (state, now, stepId) => DEFAULT_RULES.chooseAccount(unlimited(state), now, stepId) },
  },
  // M2: a started track whose account a re-import replaced is retargeted to the new account, not skipped (review of f2824d4, item 8).
  "a started track retargeted by a re-import": {
    invariant: "M2",
    seed: RETARGET_SEED,
    rules: { evaluate: (state, now, options) => DEFAULT_RULES.evaluate(retargeted(state), now, options) },
  },
  // M5: a pair another subject owns is ignored, in the account choice and the handover.
  "a taken pair ignored": {
    invariant: "M5",
    seed: 0,
    rules: {
      evaluate: (state, now, options) => DEFAULT_RULES.evaluate(ownPairsOnly(state), now, options),
      chooseAccount: (state, now, stepId) => DEFAULT_RULES.chooseAccount(ownPairsOnly(state), now, stepId),
      handoverFailures: (state, attempt, account, now) => DEFAULT_RULES.handoverFailures(ownPairsOnly(state), attempt, account, now),
    },
  },
  // M6: a mark accepted where nothing reached the person.
  "a mark accepted with nothing reached": {
    invariant: "M6",
    seed: 1,
    rules: {
      markReplied: (state, requestId, now, channel) => {
        const out = DEFAULT_RULES.markReplied(state, requestId, now, channel);
        if (out.ok || state.subject.ended === "replied") return out;
        return { ok: true, state: end({ ...state, replies: [...state.replies, { channel, atWall: now, providerRef: markedReplyId(channel, requestId) }] }, "replied", now) };
      },
    },
  },
  // M7: a step no eligible session has any allowance for reads as full for the day, a time it can never keep.
  "no allowance reads as full for the day": {
    invariant: "M7",
    seed: 6,
    rules: {},
    patch: () => {
      const was = viewRules.noAllowanceReadAs;
      viewRules.noAllowanceReadAs = "sending_capacity";
      return () => {
        viewRules.noAllowanceReadAs = was;
      };
    },
  },
  // M8: the track's session is not fixed: each message may go from any session of the pool.
  "the pair's session not fixed": {
    invariant: "M8",
    seed: 0,
    rules: {
      chooseAccount: (state, now, stepId) => DEFAULT_RULES.chooseAccount(unfixed(state), now, stepId),
      handoverFailures: (state, attempt, account, now) => DEFAULT_RULES.handoverFailures(unfixed(state), attempt, account, now),
    },
  },
  // M9: an Instagram track that finishes ends the lead, so the tracks beside and after it stop.
  "a finished Instagram track ends the lead": {
    invariant: "M9",
    seed: 3,
    rules: {
      evaluate: (state, now, options) => {
        const next = DEFAULT_RULES.evaluate(state, now, options);
        const done = next.tracks.some((p) => p.finishedAt !== null && isInstagramTrack(next, p.trackId));
        return done && next.subject.ended === null ? end(next, "sequence_finished_no_response", now) : next;
      },
    },
  },
  // M10: priority by the due time alone: a first contact as likely as a follow-up to take a contested slot.
  "priority by the due time alone": {
    invariant: "M10",
    seed: 3,
    rules: { claimOrder: (a, b) => comparePriority({ ...a, touched: false }, { ...b, touched: false }), handoverOrder: (a, b) => comparePriority({ ...a, touched: false }, { ...b, touched: false }) },
  },
  // 29: the conversations' version ignores every change, so a cache outlives a pair taken on an Instagram account.
  "the conversations' version ignores every change": {
    invariant: "29",
    seed: 4,
    rules: {},
    patch: () => {
      const proto = SqliteEngineStore.prototype as unknown as { conversationVersions: () => Promise<ReadonlyMap<string, number>> };
      const was = proto.conversationVersions;
      proto.conversationVersions = () => Promise.resolve(new Map());
      return () => {
        proto.conversationVersions = was;
      };
    },
  },
};
