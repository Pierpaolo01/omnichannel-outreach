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
} from "../../domain/sequence/dispatch.ts";
import { compareReadyNow, focusOf, isListed, logCallOutcome, placeCall, readyCalls } from "../../domain/sequence/calls.ts";
import { applyBadDestination, applyReply, applyToAttempt, applyToWork, enterMain, evaluate, replyMatches, smsReplyOwner } from "../../domain/sequence/progress.ts";
import type { SubjectState } from "../../domain/sequence/state.ts";

export interface Rules {
  readonly evaluate: typeof evaluate;
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
  /** The order of ready-now calls in the queue the read models show (4.4). */
  readonly readyNowOrder: typeof compareReadyNow;
  /** Which call the focus queue shows (part b): the one the user is on while it is listed. */
  readonly focusOf: typeof focusOf;
  /** The version guard (2.5): a change computed from `computedFrom` applies only if nothing it read has changed. */
  readonly versionsMatch: (computedFrom: SubjectState, current: SubjectState) => boolean;
}

export const DEFAULT_RULES: Rules = {
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
  readyNowOrder: compareReadyNow,
  focusOf,
  // Everything an evaluation reads: the subject's and campaign's versions cover its progress and the
  // definition; the lead's facts (contact details and their marks, zone, merge data) change without
  // bumping them (an import, a mark elsewhere), so they are compared as they were read.
  versionsMatch: (a, b) =>
    a.subject.version === b.subject.version &&
    a.campaign.version === b.campaign.version &&
    a.campaign.definitionVersion === b.campaign.definitionVersion &&
    JSON.stringify(a.lead) === JSON.stringify(b.lead),
};
