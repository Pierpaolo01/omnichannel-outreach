import type { Rules } from "../../src/server/engine/rules.ts";
import { DEFAULT_RULES } from "../../src/server/engine/rules.ts";
import { applyReply, awaitingAcceptance, connect, end, finishTrack, progressOf, rules as progressRules } from "../../src/domain/sequence/progress.ts";
import { linkedinStepKind } from "../../src/domain/sequence/definition.ts";
import { markedReplyId } from "../../src/domain/sequence/reply-identity.ts";
import { wallAtLead } from "../../src/domain/sequence/progress.ts";
import { leadNow, wallOfLead } from "../../src/domain/sequence/clock.ts";
import type { SubjectState } from "../../src/domain/sequence/state.ts";

/**
 * Deliberately broken engines for the generated LinkedIn runs (ADR 0004 10.3): one per invariant, each a swap of one rule.
 * Each must make the runs fail the invariant it names, at its recorded seed offset (from LINKEDIN_SEED) in `pnpm check`.
 */
export interface LinkedinMutation {
  readonly invariant: string;
  readonly seed: number;
  readonly rules: Partial<Rules>;
  /** A swap outside the engine's rules (a module seam), applied for the replay and undone after it. */
  readonly patch?: () => () => void;
}

/** The subject's state with only its own LinkedIn pairs (L11's mutation): other subjects' conversations with its profile unseen. */
function ownPairsOnly(s: SubjectState): SubjectState {
  const profiles = new Set(s.lead.details.filter((d) => d.channel === "linkedin").map((d) => d.key));
  return { ...s, smsBindings: s.smsBindings.filter((b) => b.owner === s.subject.id || !profiles.has(b.recipient)) };
}

/** A LinkedIn track's invite step: its first live step. */
function inviteStepOf(s: SubjectState, trackId: string): string | null {
  const track = s.campaign.definition.tracks.find((t) => t.id === trackId);
  return track?.channel === "linkedin" ? (track.steps.find((x) => !x.removed)?.id ?? null) : null;
}

/** Each track waiting for acceptance, connected at once at its invite's send point instead (L2's mutation). */
function connectedAtTheSend(s: SubjectState): SubjectState {
  let next = s;
  for (const p of s.tracks) {
    if (!awaitingAcceptance(next, p.trackId)) continue;
    const sent = next.results.find((r) => r.trackId === p.trackId && r.result === "sent");
    if (sent) next = connect(next, p.trackId, "accepted", sent.at, sent.atWall);
  }
  return next;
}

export const LINKEDIN_MUTATIONS: Readonly<Record<string, LinkedinMutation>> = {
  // L1: an invite waiting for acceptance is offered again as ready, and claimed and handed over again.
  "an invite waiting for acceptance is sent again": {
    invariant: "L1",
    seed: 0,
    rules: {
      readyItems: (state, now) => [
        ...DEFAULT_RULES.readyItems(state, now),
        ...state.tracks.flatMap((p) => {
          const invite = inviteStepOf(state, p.trackId);
          if (!invite || !awaitingAcceptance(state, p.trackId) || state.attempts.some((a) => a.stepId === invite && a.state !== "sent" && a.state !== "withdrawn" && a.state !== "rejected")) return [];
          return [{ subjectId: state.subject.id, trackId: p.trackId, stepId: invite, touched: state.subject.touched, dueWall: now }];
        }),
      ],
      claimRefusal: (state, item, now) => (inviteStepOf(state, item.trackId) === item.stepId && awaitingAcceptance(state, item.trackId) ? null : DEFAULT_RULES.claimRefusal(state, item, now)),
      handoverFailures: (state, attempt, account, now) => {
        const failed = DEFAULT_RULES.handoverFailures(state, attempt, account, now);
        return inviteStepOf(state, attempt.trackId) === attempt.stepId ? failed.filter((f) => f !== 3 && f !== 4 && f !== 6 && f !== 7) : failed;
      },
      outstandingInviteStops: () => false,
    },
  },
  // L2: the first message is due at the invite's send, as if every invite were accepted at once.
  "the first message is due at the invite's send": {
    invariant: "L2",
    seed: 0,
    rules: { evaluate: (state, now, options) => DEFAULT_RULES.evaluate(connectedAtTheSend(state), now, options), outstandingInviteStops: () => false },
  },
  // L3: the mark is recorded, but the lead is not ended.
  "a reply mark that does not end the lead": {
    invariant: "L3",
    seed: 4,
    rules: {
      markReplied: (state, requestId, now) => {
        const refused = DEFAULT_RULES.markReplied(state, requestId, now);
        if (!refused.ok) return refused;
        return { ok: true, state: { ...state, replies: [...state.replies, { channel: "linkedin", atWall: now, providerRef: markedReplyId("linkedin", requestId) }] } };
      },
    },
  },
  // L4: the expiry finishes the track and never asks for the withdrawal.
  "the expiry does not withdraw the invite": {
    invariant: "L4",
    seed: 0,
    rules: {
      inviteExpired: (state, trackId, now) => {
        const p = progressOf(state, trackId);
        const at = p?.acceptBy ?? leadNow(state.subject.clock, now);
        return finishTrack(state, trackId, "invite_not_accepted", at, wallAtLead(state.subject.clock, state.freezes, at, now));
      },
    },
  },
  // L5: one bucket for every LinkedIn action: the invite allowance is not checked on its own.
  "the invite allowance ignored": {
    invariant: "L5",
    seed: 0,
    rules: {
      chooseAccount: (state, now, stepId) => {
        const accounts = Object.fromEntries(Object.entries(state.accounts).map(([id, a]) => {
          if (!a.kinds) return [id, a];
          const { kinds, ...rest } = a;
          return [id, { ...rest, capacity: kinds.invite.capacity + kinds.message.capacity }];
        }));
        return DEFAULT_RULES.chooseAccount({ ...state, accounts }, now, stepId);
      },
    },
  },
  // L6: an acceptance taken as a reply.
  "an acceptance applied as a reply": {
    invariant: "L6",
    seed: 0,
    rules: {
      recordAcceptance: (state, trackId, providerTime, handedWall, now, point) => {
        const recorded = DEFAULT_RULES.recordAcceptance(state, trackId, providerTime, handedWall, now, point);
        return applyReply(recorded, { channel: "linkedin", atWall: providerTime, providerRef: markedReplyId("linkedin", `accepted-${trackId}`) }, now);
      },
    },
  },
  // L7: every invite carries its note, whatever the allowance.
  "the note allowance ignored": {
    invariant: "L7",
    seed: 0,
    rules: {
      handOver: (state, attempt, account, now) => {
        const base = state.accounts[account.id] ?? account;
        const unlimited = base.notes ? { ...base, notes: { capacity: Number.MAX_SAFE_INTEGER, used: 0 } } : base;
        return DEFAULT_RULES.handOver({ ...state, accounts: { ...state.accounts, [account.id]: unlimited } }, attempt, unlimited, now);
      },
    },
  },
  // L8: the expiry finishes the track when it is evaluated, not at its deadline.
  "the expiry finishes at the instant evaluated": {
    invariant: "L8",
    seed: 5,
    rules: {
      inviteExpired: (state, trackId, now) => {
        const wanted = { ...state, tracks: state.tracks.map((t) => (t.trackId === trackId ? { ...t, inviteWithdrawal: "wanted" as const, inviteWithdrawalLastWall: null } : t)) };
        return finishTrack(wanted, trackId, "invite_not_accepted", leadNow(state.subject.clock, now), wallOfLead(state.subject.clock, now));
      },
    },
  },
  // L9: the pre-send check's "connected" is ignored: the invite is neither sent nor skipped.
  "an existing connection is ignored": {
    invariant: "L9",
    seed: 1,
    rules: { inviteAlreadyConnected: (state) => state },
  },
  // L10: the expiry ends the lead instead of finishing the track.
  "the expiry ends the lead": {
    invariant: "L10",
    seed: 0,
    rules: {
      inviteExpired: (state, trackId, now) => end(DEFAULT_RULES.inviteExpired(state, trackId, now), "finished_no_usable_channel", now),
    },
  },
  // L2, the gate in full (review bot on 194fc44): the gate covers only the first message, so a skip reaches a follow-up.
  "the connection gate covers only the first message": {
    invariant: "L2",
    seed: 22,
    rules: { outstandingInviteStops: () => false },
    patch: () => {
      const was = progressRules.connectionGate;
      progressRules.connectionGate = (track, stepId, progress) => linkedinStepKind(track, stepId) === "first_message" && (progress.connection ?? null) === null;
      return () => {
        progressRules.connectionGate = was;
      };
    },
  },
  // L11: other subjects' pairs ignored on LinkedIn: a second campaign reaches a profile another campaign's session owns.
  "a LinkedIn pair owned by another subject is ignored": {
    invariant: "L11",
    seed: 25,
    rules: {
      chooseAccount: (state, now, stepId) => DEFAULT_RULES.chooseAccount(ownPairsOnly(state), now, stepId),
      handoverFailures: (state, attempt, account, now) => DEFAULT_RULES.handoverFailures(ownPairsOnly(state), attempt, account, now),
      evaluate: (state, now, options) => DEFAULT_RULES.evaluate(ownPairsOnly(state), now, options),
    },
  },
  // L12: the mark accepted on a lead nothing reached on LinkedIn.
  "a reply marked where nothing reached the person": {
    invariant: "L12",
    seed: 0,
    rules: { markReplied: (state, requestId, now) => ({ ok: true, state: applyReply(state, { channel: "linkedin", atWall: now, providerRef: markedReplyId("linkedin", requestId) }, now) }) },
  },
  // L13: a taken pair held instead of skipped: the second campaign's lead is left waiting on it for ever.
  "a taken LinkedIn pair is held, not skipped": {
    invariant: "L13",
    seed: 10,
    rules: { evaluate: (state, now, options) => DEFAULT_RULES.evaluate(state, now, { ...options, skipTakenConversations: false }) },
  },
};
