/**
 * The engine's decisions, gathered in one object so the engine calls nothing else. The defaults
 * are the pure domain functions; `src/server/sequence-runs-oracle.test.ts` swaps single entries
 * for deliberately broken ones to prove the generated test catches each (ADR 0003 9.2 step 5).
 */
import { sendPoint } from "../../domain/sequence/clock.ts";
import {
  authorizeRetry,
  chooseAccount,
  claim,
  claimRefusal,
  comparePriority,
  handOver,
  handoverFailures,
  readyItems,
  retryFailures,
  stepWhen,
} from "../../domain/sequence/dispatch.ts";
import { compareReadyNow, focusOf, isListed, logCallOutcome, placeCall, readyCalls, reasonOf } from "../../domain/sequence/calls.ts";
import { applyBadDestination, applyReply, applyToAttempt, applyToWork, asOfAction, enterMain, evaluate, releaseUnsentBindings, replyMatches, sameConversations, smsReplyOwner, stillSettled, withdrawalDue } from "../../domain/sequence/progress.ts";
import type { SubjectState } from "../../domain/sequence/state.ts";
import { inviteAlreadyConnected, inviteExpired, inviteWithdrawalAnswer, inviteWithdrawalDue, recordAcceptance } from "../../domain/sequence/progress.ts";
import { actionOfStep } from "../../domain/sequence/dispatch.ts";
import { markPrecondition, markReplied } from "../../domain/sequence/controls.ts";
import { reconcileEdit, stillRunnable } from "../../domain/sequence/reconcile.ts";
import { launchCheck } from "../../domain/sequence/blockers.ts";
import { applyControl, campaignPaused, campaignPrecondition, campaignResumed, controlPrecondition, judgeControl } from "../../domain/sequence/controls.ts";
import type { RequestStanding, StoredRequest } from "./engine-store.ts";
import { portReplyId, storedReplyId, type ReplyChannel, type StoredReplyId } from "../../domain/sequence/reply-identity.ts";
import { afterInterruption, interruptionOf, rescheduledSteps } from "../../domain/sequence/interruption.ts";
import type { CallAnswer } from "../../domain/sequence/attempt.ts";
import { runTestRefusal } from "../../domain/sequence/test-runs.ts";

/** A port's pre-send answer: a reply named by its event's id (ports.ts). */
export type PortPresendAnswer = { readonly kind: "clear" } | { readonly kind: "unavailable" } | { readonly kind: "reply"; readonly providerRef: string; readonly at: number };
/** The pre-send answer the engine records: a reply by its stored id. */
export type PresendAnswer = { readonly kind: "clear" } | { readonly kind: "unavailable" } | { readonly kind: "reply"; readonly providerRef: StoredReplyId; readonly at: number };

export interface Rules {
  readonly evaluate: typeof evaluate;
  /** LinkedIn (ADR 0004 section 3): an acceptance the session reports, recorded and, before the deadline, connecting the track. */
  readonly recordAcceptance: typeof recordAcceptance;
  /** The acceptance expiry with the fallback off (3.3; ticket 27 attaches here). `evaluate` reads it through its option. */
  readonly inviteExpired: typeof inviteExpired;
  /** The pre-send check found the sender already connected: the invite skipped, the track connected (3.3). */
  readonly inviteAlreadyConnected: typeof inviteAlreadyConnected;
  readonly inviteWithdrawalDue: typeof inviteWithdrawalDue;
  readonly inviteWithdrawalAnswer: typeof inviteWithdrawalAnswer;
  /** The social action a step asks for (ADR 0004 2.1, 6): what the pre-send check's "connected" means for it. */
  readonly actionOfStep: typeof actionOfStep;
  /**
   * Whether the pre-send check's `pending` (an invite outstanding on LinkedIn) stops the handover (council on 194fc44, item
   * 1): a second layer under the connection gate and the pair's ownership. A rule, so the generated runs can prove each.
   */
  readonly outstandingInviteStops: () => boolean;
  /** The user's LinkedIn reply mark (ADR 0004 section 7). */
  readonly markReplied: typeof markReplied;
  /** The mark's confirmation, checked after its own rule (council on 194fc44, item 7). */
  readonly markPrecondition: typeof markPrecondition;
  readonly enterMain: typeof enterMain;
  readonly applyToAttempt: typeof applyToAttempt;
  readonly applyToWork: typeof applyToWork;
  /** Whether a reply outside a known thread falls back to a piece of provider work (2.4). */
  readonly replyMatches: typeof replyMatches;
  readonly applyReply: typeof applyReply;
  /** Which subject an SMS reply belongs to, from the mobile's conversations and the number it reached (4.5). */
  readonly smsReplyOwner: typeof smsReplyOwner;
  readonly applyBadDestination: typeof applyBadDestination;
  readonly sendPoint: typeof sendPoint;
  readonly readyItems: typeof readyItems;
  /** When a pending step goes, as every read says it (ADR 0003 "Reads that say when"): a rule so a mutation can swap the read alone. */
  readonly stepWhen: typeof stepWhen;
  /** The same read for a control's preview of its next step: its own rule, so a mutation can break the preview alone. */
  readonly previewStepWhen: typeof stepWhen;
  /**
   * The lead a confirmation's expectation is checked against, given the stored lead and the lead as of the action's instant:
   * the evaluated one, as the read that produced the expectation showed it (the review bot on 712884b). A rule so a
   * mutation can judge the stored one.
   */
  readonly confirmedAgainst: (stored: SubjectState, evaluated: SubjectState) => SubjectState;
  /** Claims are made in this order (4.3). */
  readonly claimOrder: typeof comparePriority;
  /** Claimed attempts on one account are handed over in this order (5.5 step 2). */
  readonly handoverOrder: typeof comparePriority;
  readonly claimRefusal: typeof claimRefusal;
  readonly chooseAccount: typeof chooseAccount;
  readonly claim: typeof claim;
  readonly handoverFailures: typeof handoverFailures;
  readonly handOver: typeof handOver;
  readonly retryFailures: typeof retryFailures;
  readonly authorizeRetry: typeof authorizeRetry;
  /** Due calls waiting to be placed on the user's list (ticket 14). */
  readonly readyCalls: typeof readyCalls;
  /** Ready calls are placed in this order (4.4: the priority classes of 4.3). */
  readonly callOrder: typeof comparePriority;
  /** Places one call within the day's capacity, or refuses. */
  readonly placeCall: typeof placeCall;
  /** The listing rule (2.3), which decides whether an outcome is accepted. */
  readonly isListed: typeof isListed;
  readonly logCallOutcome: typeof logCallOutcome;
  /** Brings a lead's state up to a user action's instant before the action is judged (2.4). */
  readonly asOfAction: typeof asOfAction;
  /** The order of ready-now calls in the queue the read models show (4.4). */
  readonly readyNowOrder: typeof compareReadyNow;
  /** Which call the focus queue shows (part b): the one the user is on while it is listed. */
  readonly focusOf: typeof focusOf;
  /** Why a call is on the list (ticket 15): due, rolled over, a redial, a callback, or an overdue callback. */
  readonly callReason: typeof reasonOf;
  /** One user control on one lead (ticket 17a): pause, resume, skip, stop, and the two restarts. */
  readonly applyControl: typeof applyControl;
  /** Whether a control still applies as it was confirmed (ticket 17b): a mutation can replace it. */
  readonly controlPrecondition: typeof controlPrecondition;
  /** The one refusal order the read and the action share: the action's rule first, then the precondition. */
  readonly judgeControl: typeof judgeControl;
  readonly campaignPrecondition: typeof campaignPrecondition;
  /** The campaign pause and resume as each of its leads takes them (ticket 17a). */
  readonly campaignPaused: typeof campaignPaused;
  readonly campaignResumed: typeof campaignResumed;
  /** Whether a piece of work's withdrawal is to be asked now (ticket 17a; council A): its own intent and schedule. */
  readonly withdrawalDue: typeof withdrawalDue;
  /** How a request id stands against its stored first answer (verifier B5): new, a replay of it, or reused. */
  readonly requestStanding: (stored: StoredRequest | null, request: { readonly target: string; readonly action: string; readonly body: string }) => RequestStanding;
  /**
   * What the engine makes of the pre-send check's answer (ADR 0002): a reply is recorded under `storedReplyId` of the id
   * the port named it by (the reply event's own id), so the pre-send check and the observation store one id for one
   * reply. The mutations: ca8baee's defect clears a known reply; the defect of PR 62 stores the port's bare id.
   */
  readonly presendAnswer: (answer: PortPresendAnswer, channel: ReplyChannel, knownReplies: readonly StoredReplyId[]) => PresendAnswer;
  /** A reply's identity, stored and as its port names it (ADR 0003 "Ticket 17a", the reply identity rule): one pair for every channel. */
  readonly storedReplyId: typeof storedReplyId;
  readonly portReplyId: typeof portReplyId;
  /** What the reads apply first when they preview a control: what fell due by the read's instant, as the action does. */
  readonly previewAsOf: typeof asOfAction;
  /** Brings one lead's progress in line with an edit of a running campaign (ticket 19, ADR 0003 "Ticket 19"). */
  readonly reconcileEdit: typeof reconcileEdit;
  /** A running edit's three launch blockers, over what its leads as the edit leaves them can still run (review bot on 7afa03d). */
  readonly runningCheck: (definition: Parameters<typeof launchCheck>[0], leadsAfter: readonly SubjectState[], leads: Parameters<typeof launchCheck>[1], accounts: Parameters<typeof launchCheck>[2]) => ReturnType<typeof launchCheck>;
  /**
   * The version guard (2.5): a change computed from `computedFrom` applies only if nothing it read has changed, the SMS
   * conversations of its mobiles included (another subject's state: question Q7 answered).
   */
  readonly versionsMatch: (computedFrom: SubjectState, current: SubjectState) => boolean;
  /** Releases the subject's own bindings with nothing sent, in every write (question Q7 answered, point 10). */
  readonly releaseUnsent: typeof releaseUnsentBindings;
  /** Whether the claim stage's "nothing ready" for a subject still holds (`stillSettled`): the seam of its mutation. */
  readonly readinessHolds: typeof stillSettled;
  /** Ticket 20a: the interruption ending at an instant, from the last heartbeat (more than INTERRUPTION_GAP before it). */
  readonly interruptionOf: typeof interruptionOf;
  /** Ticket 20a: what an interruption does to a lead: nothing (it is not a pause). */
  readonly afterInterruption: typeof afterInterruption;
  /** Ticket 20a: the sends an interruption rescheduled, for its notice. */
  readonly rescheduled: typeof rescheduledSteps;
  /** Ticket 20a, follow-up 42 item 39: the instant a provider's answer is applied at: when it arrived, not when it was asked for. */
  readonly answerInstant: (askedAt: number, answeredAt: number) => number;
  /**
   * Ticket 20a (PR 56 review bot): the instant a dispatch decision is judged at: the clock read at that decision, never
   * the tick's start (a machine can sleep in between).
   */
  readonly dispatchInstant: (tickStarted: number, now: number) => number;
  /**
   * Ticket 20a (PR 56 review bot): whether a round with a provider is contact. Every read the engine relies on for safety
   * must have answered in it: the account read and the observation. A partial answer is not contact.
   */
  readonly contactFrom: (answered: { readonly accounts: boolean; readonly observation: boolean }) => boolean;
  /** The answer a call whose answer was never recorded is taken to have (5.3's crash row): unknown. */
  readonly lostAnswer: CallAnswer;
  /** Ticket 21: Run test's boundary, judged on the facts its transaction reads. */
  readonly runTestRefusal: typeof runTestRefusal;
  /** Ticket 21 (question Q27's interim): what an accepted edit does to the campaign's running test: stops it. */
  readonly stopTestOnEdit: (state: SubjectState, now: number) => SubjectState;
}

/**
 * The rules an engine or a read runs by: the defaults with `given` in place, and `evaluate` reading the acceptance expiry
 * through the rules (ADR 0004 3.5), so a swapped `inviteExpired` (ticket 27's attach point, and a mutation) is the one every
 * evaluation applies. Every place that merges rules calls this.
 */
export function rulesWith(given: Partial<Rules> = {}): Rules {
  const rules: Rules = { ...DEFAULT_RULES, ...given };
  if (rules.inviteExpired === DEFAULT_RULES.inviteExpired) return rules;
  const evaluateAt = rules.evaluate;
  return { ...rules, evaluate: (state, now, options) => evaluateAt(state, now, { inviteExpired: rules.inviteExpired, ...options }) };
}

export const DEFAULT_RULES: Rules = {
  recordAcceptance,
  inviteExpired,
  inviteAlreadyConnected,
  inviteWithdrawalDue,
  inviteWithdrawalAnswer,
  actionOfStep,
  outstandingInviteStops: () => true,
  markReplied,
  markPrecondition,
  evaluate,
  enterMain,
  applyToAttempt,
  applyToWork,
  replyMatches,
  applyReply,
  smsReplyOwner,
  applyBadDestination,
  sendPoint,
  readyItems,
  stepWhen,
  previewStepWhen: stepWhen,
  confirmedAgainst: (_stored, evaluated) => evaluated,
  claimOrder: comparePriority,
  handoverOrder: comparePriority,
  claimRefusal,
  chooseAccount,
  claim,
  handoverFailures,
  handOver,
  retryFailures,
  authorizeRetry,
  readyCalls,
  callOrder: comparePriority,
  placeCall,
  isListed,
  logCallOutcome,
  asOfAction,
  readyNowOrder: compareReadyNow,
  focusOf,
  callReason: reasonOf,
  applyControl,
  controlPrecondition,
  judgeControl,
  campaignPrecondition,
  campaignPaused,
  campaignResumed,
  withdrawalDue,
  requestStanding: (stored, request) => (stored === null ? "new" : stored.target !== request.target || stored.action !== request.action ? "reused" : stored.body !== request.body ? "different" : "replay"),
  previewAsOf: asOfAction,
  reconcileEdit,
  runningCheck: (definition, leadsAfter, leads, accounts) => launchCheck(stillRunnable(definition, leadsAfter), leads, accounts),
  presendAnswer: (answer, channel) => (answer.kind === "reply" ? { ...answer, providerRef: storedReplyId(channel, answer.providerRef) } : answer),
  storedReplyId,
  portReplyId,
  // Everything an evaluation reads: the subject's and campaign's versions cover its progress and the
  // definition; the lead's facts (contact details and their marks, zone, merge data) change without
  // bumping them (an import, a mark elsewhere), so they are compared as they were read.
  versionsMatch: (a, b) =>
    a.subject.version === b.subject.version &&
    a.campaign.version === b.campaign.version &&
    a.campaign.definitionVersion === b.campaign.definitionVersion &&
    JSON.stringify(a.lead) === JSON.stringify(b.lead) &&
    sameConversations(a, b),
  releaseUnsent: releaseUnsentBindings,
  readinessHolds: stillSettled,
  interruptionOf,
  afterInterruption,
  rescheduled: rescheduledSteps,
  answerInstant: (_asked, answered) => answered,
  dispatchInstant: (_started, now) => now,
  contactFrom: (answered) => answered.accounts && answered.observation,
  lostAnswer: { kind: "unknown" },
  runTestRefusal,
  stopTestOnEdit: (state, now) => {
    const stopped = applyControl(asOfAction(state, now, evaluate), "stop", now);
    return stopped.ok ? stopped.state : state;
  },
};
