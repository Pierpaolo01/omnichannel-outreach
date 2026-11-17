import type { Rules } from "../../src/server/engine/rules.ts";
import { SqliteEngineStore } from "../../src/server/persistence/sqlite-engine-store.ts";
import { DEFAULT_RULES } from "../../src/server/engine/rules.ts";
import { viewRules } from "../../src/server/engine/step-when-view.ts";
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

/** A swap of one of progress.ts's rule flags for a replay, undone after it. */
type Flag = "notConnectedMarksBad" | "pairsByChannel" | "waitEditRealigns" | "checksPerSession" | "conversationKeysOwnOnly" | "inmailJudgesStanding" | "inmailWaitsForExpiry" | "acceptanceSkipsInmail" | "refusedInmailEndsTrack" | "switchOffReachesChosen" | "inmailOffWhenRemoved" | "inmailTakesFirstPlace" | "restartAcquires" | "handoverRechecksBacking" | "replacedNamedAtChoice";
/** Several flags swapped at once for one replay, undone after it. */
function flags(values: Partial<Record<Flag, boolean>>): () => () => void {
  return () => {
    const undo = Object.entries(values).map(([name, value]) => flag(name as Flag, value as never)());
    return () => {
      for (const u of undo.reverse()) u();
    };
  };
}
/** A LinkedIn track's InMail step (any, live or removed) that already has a sent result: the one the L18 mutation offers again. */
function sentInmailOf(s: SubjectState, trackId: string): string | null {
  const track = s.campaign.definition.tracks.find((t) => t.id === trackId);
  const step = track?.steps.find((x) => x.role === "inmail" && s.results.some((r) => r.stepId === x.id && r.result === "sent"));
  return step?.id ?? null;
}
function flag<K extends Flag>(name: K, value: (typeof progressRules)[K]): () => () => void {
  return () => {
    const was = progressRules[name];
    progressRules[name] = value;
    return () => {
      progressRules[name] = was;
    };
  };
}

/** The InMail mutations' killing seed offsets (ticket 27), found over offsets 0 to 29; ADR 0004 13.11 records them. */
const INMAIL_SEEDS = { L18: 24, L19: 16, L20: 7, L21: 18, L22: 0, L23: 24, L24: 18, L25: 7, replaced: 0, restart: 0, handover: 0 } as const;

/** The seed offset that reaches a step no session has any allowance for (the search's 24015 on a6c1700). */
const NO_ALLOWANCE_SEED = 15;

export const LINKEDIN_MUTATIONS: Readonly<Record<string, LinkedinMutation>> = {
  // L13 (ticket 24b, item 15): a step no session it may use has any allowance for reads as full for the day.
  "no allowance reads as full for the day": {
    invariant: "L13",
    seed: NO_ALLOWANCE_SEED,
    rules: {},
    patch: () => {
      const was = viewRules.noAllowanceReadAs;
      viewRules.noAllowanceReadAs = "sending_capacity";
      return () => {
        viewRules.noAllowanceReadAs = was;
      };
    },
  },
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
    seed: 10,
    rules: {
      inviteExpired: (state, trackId, now) => {
        const wanted = { ...state, tracks: state.tracks.map((t) => (t.trackId === trackId ? { ...t, inviteWithdrawal: "wanted" as const, inviteWithdrawalLastWall: null } : t)) };
        return finishTrack(wanted, trackId, "invite_not_accepted", leadNow(state.subject.clock, now), wallOfLead(state.subject.clock, now));
      },
    },
  },
  // L9: "connected" ignored, by the connection check (taken as clear) and by the pre-send check: the invite is neither sent
  // nor skipped.
  "an existing connection is ignored": {
    invariant: "L9",
    seed: 1,
    rules: {
      inviteAlreadyConnected: (state) => state,
      connectionChecked: (state, trackId, session, destination, answer, now) => DEFAULT_RULES.connectionChecked(state, trackId, session, destination, answer === "connected" ? "clear" : answer, now),
    },
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
    seed: 24,
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
    seed: 10,
    rules: {
      chooseAccount: (state, now, stepId) => DEFAULT_RULES.chooseAccount(ownPairsOnly(state), now, stepId),
      handoverFailures: (state, attempt, account, now) => DEFAULT_RULES.handoverFailures(ownPairsOnly(state), attempt, account, now),
      // Evaluated on its own pairs, and written with the others' kept: the store refuses a write that removes another's pair.
      evaluate: (state, now, options) => {
        const own = ownPairsOnly(state);
        const out = DEFAULT_RULES.evaluate(own, now, options);
        return { ...out, smsBindings: [...out.smsBindings, ...state.smsBindings.filter((b) => !own.smsBindings.includes(b))] };
      },
      connectionChecksDue: (state, trackId, now) => DEFAULT_RULES.connectionChecksDue(ownPairsOnly(state), trackId, now),
      // The session's "pending" for the owner's own outstanding invite would otherwise stop it: an engine that ignores the
      // owner's pair is one that also ignores what that pair's invite tells it (the per-session check, review bot on e261ffa).
      outstandingInviteStops: () => false,
    },
  },
  // L12: the mark accepted on a lead nothing reached on LinkedIn.
  "a reply marked where nothing reached the person": {
    invariant: "L12",
    seed: 0,
    rules: { markReplied: (state, requestId, now) => ({ ok: true, state: applyReply(state, { channel: "linkedin", atWall: now, providerRef: markedReplyId("linkedin", requestId) }, now) }) },
  },
  // L1 (Q42): the check's and the handover's "pending" taken as clear: an invite pending from elsewhere is sent again.
  "a pending invitation from elsewhere is sent again": {
    invariant: "L1",
    seed: 0,
    rules: { outstandingInviteStops: () => false },
  },
  // L14 (Q37): a message refused because the connection is gone marks the profile bad.
  "a removed connection marks the profile bad": {
    invariant: "L14",
    seed: 16,
    rules: {},
    patch: flag("notConnectedMarksBad", true),
  },
  // Review bot on b21af02: the LinkedIn session taken from any pair the subject owns, whatever its channel. Here an SMS pair
  // taken first leaves the invite waiting for ever on a number no LinkedIn action can use (L13); the SMS track runs, whose
  // LinkedIn track starts after its text, see it as L16.
  "a binding lookup ignores the channel": {
    invariant: "L13",
    seed: 11,
    rules: {},
    patch: flag("pairsByChannel", false),
  },
  // L15 (Q41): a pair whose invite was withdrawn and never accepted, or to which nothing went, is never released.
  "a withheld release": {
    invariant: "L15",
    seed: 0,
    rules: { releaseUnsent: (state) => state },
  },
  // L8 (council on b21af02, item 8): an edit of the wait leaves every waiting deadline where it was.
  "an edited wait keeps the old deadline": {
    invariant: "L8",
    seed: 6,
    rules: {},
    patch: flag("waitEditRealigns", false),
  },
  // L17 (review bot on e261ffa): one connection check's answer kept for the track, asked of its first healthy session only.
  "a check's result is stored for the track, not the session": {
    invariant: "L17",
    seed: 2,
    rules: {},
    patch: flag("checksPerSession", false),
  },
  // 29 (the re-check of dd3969c, item 1): the conversations' version never moves, so every cache keyed on it outlives a
  // change of conversations (the worker's evaluation and readiness caches): a fresh engine then acts where the worker idles.
  "the conversations' version ignores every change": {
    invariant: "29",
    seed: 11,
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
  // 29 (the re-check of 8c85b2f, item 1): a cache remembers only its own pairs' destinations, so a change to another
  // subject's pair on the same destination leaves a subject waiting on it cached.
  "a change to another subject's pair on the same destination does not invalidate a waiting subject": {
    invariant: "29",
    seed: 11,
    rules: {},
    patch: flag("conversationKeysOwnOnly", true),
  },
  // The InMail fallback (ticket 27, ADR 0004 13.11): one mutation per invariant L18 to L25. Their seeds are recorded in 13.11.
  // L18: an InMail already sent is offered again as ready, claimed and handed over again.
  "an InMail sent is sent again": {
    invariant: "L18",
    seed: INMAIL_SEEDS.L18,
    rules: {
      readyItems: (state, now) => [
        ...DEFAULT_RULES.readyItems(state, now),
        ...state.tracks.flatMap((p) => {
          const im = sentInmailOf(state, p.trackId);
          if (!im || p.finishedAt !== null || state.attempts.some((a) => a.stepId === im && (a.state === "claimed" || a.state === "handed" || a.state === "accepted"))) return [];
          return [{ subjectId: state.subject.id, trackId: p.trackId, stepId: im, touched: state.subject.touched, dueWall: now }];
        }),
      ],
      claimRefusal: (state, item, now) => (sentInmailOf(state, item.trackId) === item.stepId ? null : DEFAULT_RULES.claimRefusal(state, item, now)),
      handoverFailures: (state, attempt, account, now) => {
        const failed = DEFAULT_RULES.handoverFailures(state, attempt, account, now);
        return sentInmailOf(state, attempt.trackId) === attempt.stepId ? failed.filter((f) => f !== 3 && f !== 4 && f !== 6 && f !== 7 && f !== 19) : failed;
      },
    },
  },
  // L19: the fallback switched off before it went is ignored: a removed InMail step is still chosen at the expiry and sent.
  "a switched-off InMail is still sent": {
    invariant: "L19",
    seed: INMAIL_SEEDS.L19,
    rules: {},
    patch: flags({ inmailOffWhenRemoved: false }),
  },
  // L20: the InMail is not held for the expiry's choice: it goes as soon as the invite is sent.
  "the InMail goes before the expiry": {
    invariant: "L20",
    seed: INMAIL_SEEDS.L20,
    rules: {},
    patch: flags({ inmailWaitsForExpiry: false }),
  },
  // L21: an acceptance after the expiry does not stop the InMail, and the session's "connected" does not either.
  "an acceptance does not stop the InMail": {
    invariant: "L21",
    seed: INMAIL_SEEDS.L21,
    rules: {},
    patch: flags({ acceptanceSkipsInmail: false }),
  },
  // L22: the expiry takes every session as eligible: no plan and no credit are ignored.
  "every session taken as eligible for InMail": {
    invariant: "L22",
    seed: INMAIL_SEEDS.L22,
    rules: {},
    patch: flags({ inmailJudgesStanding: false }),
  },
  // L23: the InMail does not take the first message's place: the first message goes after it, without a connection.
  "the first message goes after the InMail": {
    invariant: "L23",
    seed: INMAIL_SEEDS.L23,
    rules: {},
    patch: flags({ inmailTakesFirstPlace: false }),
  },
  // L24: a refused InMail leaves the track running (the InMail is asked again, or the track left pending).
  "a refused InMail leaves the track running": {
    invariant: "L24",
    seed: INMAIL_SEEDS.L24,
    rules: {},
    patch: flags({ refusedInmailEndsTrack: false }),
  },
  // L25: switching the fallback off does not reach an InMail already chosen.
  "a switch-off does not reach a chosen InMail": {
    invariant: "L25",
    seed: INMAIL_SEEDS.L25,
    rules: {},
    patch: flags({ switchOffReachesChosen: false }),
  },
  // The council on 8b0c846 (items 1, 7 and 8; ADR 0004 13.5, 13.15).
  // L23: the step the InMail replaces is found among the live steps at its send, so a follow-up an edit promoted is skipped.
  "the replaced step is found among the live steps at the handover": {
    invariant: "L23",
    seed: INMAIL_SEEDS.replaced,
    rules: {},
    patch: flags({ replacedNamedAtChoice: false }),
  },
  // L27: a restart re-takes its InMail's credit without acquiring, at the head of the line, ahead of a lead that holds it now.
  "a restart restores a commitment without acquiring": {
    invariant: "L27",
    seed: INMAIL_SEEDS.restart,
    rules: {},
    patch: flags({ restartAcquires: false }),
  },
  // L22: the handover does not read the session's report again, so a claim made before a report of zero still goes.
  "the handover does not re-read the report": {
    invariant: "L22",
    seed: INMAIL_SEEDS.handover,
    rules: {},
    patch: flags({ handoverRechecksBacking: false }),
  },
  // L13: a taken pair held instead of skipped: the second campaign's lead is left waiting on it for ever.
  "a taken LinkedIn pair is held, not skipped": {
    invariant: "L13",
    seed: 11,
    rules: { evaluate: (state, now, options) => DEFAULT_RULES.evaluate(state, now, { ...options, skipTakenConversations: false }) },
  },
};
