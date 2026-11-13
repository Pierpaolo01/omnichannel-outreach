/**
 * The stored progress of one subject (ADR 0003 1.3), as the pure engine functions read and
 * return it. The store loads a `SubjectState` inside a transaction and writes back whatever a
 * function changed; nothing here is derived that could drift from the facts.
 */
import type { OutreachStatus } from "../outreach-status.ts";
import type { Freeze, LeadClock } from "./clock.ts";
import type { MergeData } from "./copy.ts";
import type { Branch, CampaignDefinition, Threading } from "./definition.ts";

export type EndReason = Extract<
  OutreachStatus,
  "replied" | "interested_on_call" | "declined_on_call" | "stopped_manually" | "sequence_finished_no_response" | "finished_no_usable_channel"
>;

export type FinishReason =
  | "completed"
  | "skipped"
  | "skipped_missing_channel"
  | "skipped_declined"
  | "skipped_by_user"
  | "skipped_unworked"
  | "failed_bad_destination"
  | "dropped_for_win_back"
  | "closed_on_interest";

export interface SubjectRecord {
  readonly id: string;
  readonly campaignId: string;
  /** Bumped by the store on every write to this subject. */
  readonly version: number;
  /** The stored status column; always `deriveStatus` of the rest. */
  readonly status: OutreachStatus;
  readonly ended: EndReason | null;
  readonly endedAt: number | null;
  readonly endedWall: number | null;
  readonly leadPaused: boolean;
  readonly branch: Branch;
  readonly branchEnteredAt: number | null;
  readonly touched: boolean;
  readonly noMoreCalls: boolean;
  readonly clock: LeadClock;
  readonly emailSender: string | null;
}

export interface CampaignState {
  readonly id: string;
  readonly launchedAt: number | null;
  readonly pausedSince: number | null;
  readonly version: number;
  readonly definitionVersion: number;
  readonly definition: CampaignDefinition;
}

export interface TrackProgress {
  readonly trackId: string;
  readonly startAt: number | null;
  readonly startBasisAt: number | null;
  readonly startBasisWall: number | null;
  readonly startZone: string | null;
  readonly startedAt: number | null;
  readonly destinationDetailId: string | null;
  /** The pending step and its stored deadline (ruling 5): unchanged while the step is claimed, in flight or held. */
  readonly nextStepId: string | null;
  readonly basisAt: number | null;
  readonly basisWall: number | null;
  readonly dueAt: number | null;
  readonly dueWall: number | null;
  readonly dueZone: string | null;
  readonly finishedAt: number | null;
  readonly finishedWall: number | null;
  readonly finishReason: FinishReason | null;
}

export type StepOutcome = "sent" | "skipped" | "failed";

export interface StepResult {
  readonly stepId: string;
  readonly trackId: string;
  readonly result: StepOutcome;
  readonly reason: string | null;
  readonly at: number;
  readonly atWall: number;
  readonly attemptId: string | null;
}

export type AttemptState = "claimed" | "handed" | "accepted" | "sent" | "rejected" | "withdrawn";
export type EndedBy = "guard" | "claim_expired" | "quiesce" | "provider" | "lookup_not_sent" | "user" | "call" | "observed" | "lookup";
export type RejectReason = "blocklisted" | "invalid_destination" | "payment_required" | "rate_limited" | "provider_skipped";
export type LookupAnswer = "sent" | "queued" | "not-sent" | "unknown";

export interface RenderedCopy {
  readonly subject: string;
  readonly body: string;
}

export interface Attempt {
  readonly id: string;
  readonly subjectId: string;
  readonly trackId: string;
  readonly stepId: string;
  readonly accountId: string;
  readonly destinationDetailId: string;
  readonly destination: string;
  readonly state: AttemptState;
  /** Rendered in the handover transaction and never changed afterwards. */
  readonly copy: RenderedCopy | null;
  /** The step's threading when claimed: with `retryable` and `notSentIsFinal`, the transport the payload travels by. */
  readonly threading: Threading;
  readonly threadRef: string | null;
  readonly providerRef: string | null;
  readonly retryable: boolean;
  readonly notSentIsFinal: boolean;
  readonly idempotencyKey: string;
  readonly calls: number;
  readonly claimedWall: number;
  readonly handedAt: number | null;
  readonly handedWall: number | null;
  readonly lastCallWall: number | null;
  readonly presendCheckedWall: number | null;
  readonly presendFoundReply: boolean;
  readonly lookupAnswer: LookupAnswer | null;
  readonly queuedLookups: number;
  readonly nextLookupWall: number | null;
  readonly unresolvedSince: number | null;
  readonly endedBy: EndedBy | null;
  readonly withdrawRequested: boolean;
  /** The worker has asked the provider to withdraw; it is not asked again. */
  readonly withdrawCalled: boolean;
  /** A send call was authorized and its answer has not been recorded (a crash leaves this set). */
  readonly awaitingAnswer: boolean;
  /** A same-key retry the worker should try to authorize (5.6); `after_not_sent` withdraws if refused. */
  readonly retry: "none" | "wanted" | "wanted_after_not_sent" | "refused";
  readonly rejectReason: RejectReason | null;
  /** The provider's send time, once sent. */
  readonly sentWall: number | null;
  /** The account's reset day the send counted on. */
  readonly sentDay: string | null;
  /** The user marked this attempt not sent (ADR 0002 P3): its step is excluded from at-most-once. */
  readonly userMarkedNotSent: boolean;
  /**
   * The attempt holds a capacity reservation on its account (ADR 0003 4.2, ruling 3): from the
   * claim until the provider never got the work, refused it, settled it as sent, or stated
   * authoritatively that it will not send. Uncertain work keeps it through a withdrawal.
   */
  readonly holdsReservation: boolean;
}

export interface Reply {
  readonly channel: "email" | "sms";
  readonly atWall: number;
  readonly providerRef: string;
}

/** A live contact detail of the lead, as engine decisions read it. */
export interface LeadDetail {
  readonly id: string;
  readonly channel: "email" | "phone";
  /** The lead may send to it: its own email, or a company lead's shared inbox. */
  readonly ownEmail: boolean;
  readonly value: string;
  readonly bad: boolean;
  /** Ordering: later details are newer. */
  readonly order: number;
}

export interface LeadFacts {
  /** The prospect's zone: the person's, else the company's, else the campaign default (3.4). */
  readonly zone: string;
  readonly details: readonly LeadDetail[];
  /** Every detail id an attempt or track names, resolved to the live detail it stands for now. */
  readonly resolved: Readonly<Record<string, { readonly liveId: string; readonly bad: boolean; readonly owned: boolean }>>;
  readonly mergeData: MergeData;
}

export interface AccountState {
  readonly id: string;
  readonly channel: "email";
  readonly capacity: number;
  readonly gapMs: number;
  readonly k: number;
  readonly nextSlotAt: number;
  readonly healthy: boolean;
  /** An account-level wait after a 402 or 429 (ADR 0003 2.4): no claim until it ends. */
  readonly waitUntil: number | null;
  readonly waitReason: "quota" | "rate_limited" | null;
  readonly backoffMs: number;
  /** The zone the account's daily capacity resets in. */
  readonly resetZone: string;
  /** Sends counted on today's reset day plus open reservations, across every subject. */
  readonly used: number;
  /** Attempts in claimed, handed or accepted, across every subject. */
  readonly inFlight: number;
}

export interface SubjectState {
  readonly subject: SubjectRecord;
  readonly campaign: CampaignState;
  readonly tracks: readonly TrackProgress[];
  readonly results: readonly StepResult[];
  readonly attempts: readonly Attempt[];
  readonly freezes: readonly Freeze[];
  readonly replies: readonly Reply[];
  readonly lead: LeadFacts;
  /** Details this change marks bad. Imports never clear a bad mark. */
  readonly markBad: readonly string[];
  /** Accounts this subject's change reads or writes. */
  readonly accounts: Readonly<Record<string, AccountState>>;
}
