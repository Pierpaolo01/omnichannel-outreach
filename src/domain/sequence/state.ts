/**
 * The stored progress of one subject (ADR 0003 1.3), as the pure engine functions read and
 * return it. The store loads a `SubjectState` inside a transaction and writes back whatever a
 * function changed; nothing here is derived that could drift from the facts.
 */
import type { OutreachStatus } from "../outreach-status.ts";
import type { Freeze, LeadClock } from "./clock.ts";
import type { MergeData } from "./copy.ts";
import type { Branch, CampaignDefinition, DeclinedPath, Threading } from "./definition.ts";
import type { StoredReplyId } from "./reply-identity.ts";

/** The channels a reply can be on: detected for email and SMS, marked by the user for LinkedIn (ADR 0004 section 7). */
export type ReplyChannelName = "email" | "sms" | "linkedin";

export type EndReason = Extract<
  OutreachStatus,
  "replied" | "interested_on_call" | "declined_on_call" | "stopped_manually" | "sequence_finished_no_response" | "finished_no_usable_channel"
>;

export type FinishReason =
  | "completed"
  | "skipped"
  | "skipped_missing_channel"
  /** The mobile's SMS conversation on every number the track may use belongs to another subject (ADR 0003, question Q7 answered). */
  | "skipped_conversation_taken"
  | "skipped_declined"
  | "skipped_by_user"
  | "skipped_unworked"
  | "failed_bad_destination"
  | "dropped_for_win_back"
  | "closed_on_interest"
  /** A LinkedIn invite not accepted within the track's acceptance wait, with the fallback off: withdrawn (ADR 0004 3.3). */
  | "invite_not_accepted";

/** What a subject is (ADR 0003 1.2): a lead in a campaign, or a test run of the campaign's canvas against the user's own contacts (ticket 21). */
export type SubjectKind = "enrollment" | "test_run";

export interface SubjectRecord {
  readonly id: string;
  readonly kind: SubjectKind;
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
  /** The subject's SMS sender number, fixed at its first SMS handover (ADR 0003 1.3), never reassigned. */
  readonly smsSender: string | null;
  /** The subject's LinkedIn sender session, fixed at its first LinkedIn handover (ADR 0004 6), never reassigned. Absent: none. */
  readonly linkedinSender?: string | null;
  /**
   * The reply that stopped the lead: its channel and its time as the provider reported it. Stored in
   * the transaction that ends the lead as replied, and never recomputed from later replies, whatever
   * order they are observed in (ticket 13a, verifier B1).
   */
  readonly stopReply: { readonly channel: ReplyChannelName; readonly atWall: number } | null;
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
  /** For `skipped_conversation_taken`: the conversations that caused the skip, as they were then (question Q7 answered). */
  readonly conversationOwners?: readonly ConversationCause[] | null;
  /**
   * A LinkedIn track's connection (ADR 0004 3.2), set once: the invite accepted, or the sender already connected. Its point
   * on the lead's clock is `connectedAt` and `connectedWall`. Absent or null on other tracks and until connected.
   */
  readonly connection?: "accepted" | "already_connected" | null;
  readonly connectedAt?: number | null;
  readonly connectedWall?: number | null;
  /** The platform's acceptance time, recorded whenever it is observed, also on a finished track (a fact; the measure counts it). */
  readonly acceptedWall?: number | null;
  /** The acceptance deadline in lead time, resolved once from the invite's send point plus the acceptance wait (ADR 0004 3.2). */
  readonly acceptBy?: number | null;
  readonly acceptByWall?: number | null;
  readonly acceptByZone?: string | null;
  /** The wait in days the deadline was resolved with: re-resolved only when the definition's wait differs (council item 8). */
  readonly acceptByDays?: number | null;
  /** The invite's withdrawal after the deadline: wanted, done, or found accepted first (ADR 0004 3.3). */
  readonly inviteWithdrawal?: "wanted" | "withdrawn" | "accepted_first" | "kept_by_user" | null;
  readonly inviteWithdrawalLastWall?: number | null;
  /** How many times in a row the session answered the withdrawal "unknown" (ADR 0004 3.3): listed for the user after a bound. */
  readonly inviteWithdrawalUnknowns?: number;
  /**
   * The connection checks before the invite (ADR 0004 6; review bot on e261ffa), one per session: a connection, an invite
   * pending from elsewhere and "clear" are facts about one (session, profile) pair, never about the track. Each answer
   * holds for a settling period; a `pending` answer keeps when it was first seen (question Q42).
   */
  readonly connectionChecks?: Readonly<Record<string, ConnectionCheck>>;
}

/** One session's connection check of a track's profile: its answer, when, and since when an invite was seen pending. */
export interface ConnectionCheck {
  readonly answer: "clear" | "pending";
  readonly checkedWall: number;
  readonly pendingSince: number | null;
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
export type RejectReason = "blocklisted" | "invalid_destination" | "payment_required" | "rate_limited" | "provider_skipped" | "not_connected";
export type LookupAnswer = "sent" | "queued" | "not-sent" | "unknown";

export interface RenderedCopy {
  readonly subject: string;
  readonly body: string;
}

/**
 * One provider attempt: a claim and the calls made for it. Its own lifecycle only (claimed,
 * handed, accepted, terminal); what is true of the provider work it carries is on that work.
 */
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
  readonly retryable: boolean;
  readonly notSentIsFinal: boolean;
  /** The provider work it carries (its `ProviderWork.key`), sent to the provider as the idempotency key. */
  readonly idempotencyKey: string;
  /** This attempt's own calls. */
  readonly calls: number;
  readonly claimedWall: number;
  readonly handedAt: number | null;
  readonly handedWall: number | null;
  readonly lastCallWall: number | null;
  readonly presendCheckedWall: number | null;
  readonly presendFoundReply: boolean;
  readonly endedBy: EndedBy | null;
  readonly withdrawRequested: boolean;
  /** The worker has asked the provider to withdraw this attempt's work. */
  readonly withdrawCalled: boolean;
  /** A send call was authorized and its answer has not been recorded (a crash leaves this set). */
  readonly awaitingAnswer: boolean;
  /** A same-key retry the worker should try to authorize (5.6); `after_not_sent` withdraws if refused. */
  readonly retry: "none" | "wanted" | "wanted_after_not_sent" | "refused";
  readonly rejectReason: RejectReason | null;
  /** A social step's action, fixed at the claim with the transport (ADR 0004 2.1): the request is built from the attempt alone. */
  readonly action?: "invite" | "message";
}

/** How provider work settled (ADR 0003 4.2): the user's mark settles it too. */
export type WorkSettlement = "sent" | "not_sent" | "withdrawn" | "rejected" | "never_called" | "user_sent" | "user_not_sent";

/**
 * One piece of provider work, by idempotency key (ADR 0003 1.3, PR 37 review round 3): created
 * by a claim, carried on by every attempt that inherits its key. Everything true of the work,
 * not of one attempt, is here, so settlement, release, the user's mark, lookup, reply matching
 * and inheritance read and write one record. It holds a capacity reservation while unsettled.
 */
export interface ProviderWork {
  readonly key: string;
  readonly subjectId: string;
  readonly trackId: string;
  readonly stepId: string;
  readonly accountId: string;
  readonly destination: string;
  /** Calls made for it, across its attempts. */
  readonly calls: number;
  readonly firstHandedWall: number | null;
  readonly providerRef: string | null;
  readonly settled: WorkSettlement | null;
  /** The provider's send time and the account's reset day it counted on, once sent (also a send after settlement). */
  readonly sentWall: number | null;
  readonly sentDay: string | null;
  readonly nextLookupWall: number | null;
  readonly lookupAnswer: LookupAnswer | null;
  readonly queuedLookups: number;
  readonly unresolvedSince: number | null;
  /**
   * A pause, a stop or any quiesce asked for this work to be withdrawn (ticket 17a; council A on 56d599c): kept on the
   * work, not on an attempt, so it outlives an attempt a non-final "not sent" retires. Asked of the provider until the
   * work has a final answer (withdrawn, sent, or a final not sent) or the provider says it is too late.
   */
  readonly withdrawWanted: boolean;
  /** When the provider last answered the withdrawal "unknown": asked again one settling period later. */
  readonly withdrawLastWall: number | null;
  /**
   * When the provider said it is too late to withdraw it: it went (council J on 56d599c). Such work no longer may be sent,
   * so it holds no in-flight place; it settles as sent when its send time is observed or looked up.
   */
  readonly wentWall: number | null;
  /** A social step's action (ADR 0004 2.1), written at the claim: the allowance it counts on. Absent or null on email and SMS. */
  readonly kind?: "invite" | "message" | null;
  /**
   * An invite's note, decided in the handover transaction and never again (ADR 0004 section 4): `with` it went with its note,
   * `withheld` its note was not empty but the sender's note allowance was used, `none` its note was empty. Null until handed.
   */
  readonly note?: "with" | "withheld" | "none" | null;
}

/**
 * An SMS conversation's owner (ADR 0003 4.5): the subject whose first SMS handover from `sender` to
 * `recipient` (an E.164 mobile) committed first. An enrollment's binding is never released or transferred.
 */
export interface SmsBinding {
  readonly sender: string;
  readonly recipient: string;
  readonly owner: string;
  /** The owner's campaign, recorded with a skip's cause (question Q7 answered). */
  readonly ownerCampaignId: string | null;
  /** That campaign's name as stored now; null for a binding this change takes. */
  readonly ownerCampaignName: string | null;
  /** Whether the owner is a test run (ticket 21), whose binding is released when it ends. */
  readonly ownerIsTest: boolean;
  /** Whether the owner has ended. An ended owner keeps its binding all the same (ruling 8). */
  readonly ownerEnded: boolean;
  /**
   * Whether the owner's text on this pair is known sent (question Q7 answered, point 10): only then is the conversation
   * taken for good. Until its work settles the other subject waits; work that ended not sent releases the binding.
   */
  readonly ownerSent: boolean;
  /**
   * Whether a reply has come from the mobile to this number since the binding was taken: proof the owner's text went,
   * whatever its work says (question Q7 answered, the coordinator's ruling on faac357). An answered binding is a
   * conversation: the other subject is skipped, and it is never released as unsent.
   */
  readonly ownerAnswered: boolean;
  /**
   * The conversation's channel: its sender account's stored channel (`sender_accounts.channel`), never inferred from the
   * destination (review bot on b21af02). Every lookup, ownership check and release reads only its own channel's pairs.
   */
  readonly channel: "sms" | "linkedin";
}

/**
 * One conversation that made a track's skip (question Q7 answered): the number, the mobile, and its owner as they were at
 * the skip, recorded with it so later pool edits, releases and renames never change the reason.
 */
export interface ConversationCause {
  readonly sender: string;
  readonly recipient: string;
  readonly owner: string;
  readonly ownerCampaignId: string | null;
  readonly ownerCampaignName: string | null;
  readonly ownerIsTest: boolean;
}

/**
 * One record of a mobile's SMS conversations, as a reply's attribution reads them (oldest first): every binding, and
 * after them every recorded skip for a taken conversation (`kind: "skipped"`), which owns nothing.
 */
export interface SmsBindingRecord {
  readonly kind: "binding" | "skipped";
  readonly sender: string;
  readonly owner: string;
  readonly released: boolean;
  /** Released because none of the owner's texts on the pair was sent (point 10): it never owned a conversation. */
  readonly unsent: boolean;
  /** The owner's text there is known sent, or a reply came on the pair since it was taken. The reply rule ignores it. */
  readonly confirmed: boolean;
}

export interface Reply {
  readonly channel: ReplyChannelName;
  readonly atWall: number;
  /** The reply's stored id (the reply identity rule): one per provider reply. */
  readonly providerRef: StoredReplyId;
}

/**
 * What the user logged on a call task (ADR 0003 2.4 "Calls"). Ticket 14 built these without redial,
 * callback or not interested; ticket 15 adds the callback and the redial (a choice on no answer,
 * voicemail and gatekeeper); ticket 16 adds not interested, which takes the phone track's declined path.
 */
export type CallOutcome = "no_answer" | "voicemail" | "gatekeeper" | "wrong_number" | "interested" | "not_interested" | "callback_requested" | "skip_for_now";

/**
 * One call step's task on the user's list (ADR 0003 1.3): one per step, never a second. `listDay`
 * is the user-local day it is listed for (the day it was placed until a redial, ticket 15, moves it).
 * It closes when its track finishes, for any reason, and never reopens.
 */
export interface CallTask {
  readonly id: string;
  readonly subjectId: string;
  readonly trackId: string;
  readonly stepId: string;
  /** The call step's original due time, in lead time, and the wall instant and zone it was resolved to. */
  readonly dueAt: number;
  readonly dueWall: number;
  readonly dueZone: string;
  /** The call skip limit's deadline in lead time (3.5), stored for ticket 15, which builds its expiry. */
  readonly skipDeadline: number;
  /** User-local day numbers (days since 1970-01-01 in the user's zone). */
  readonly listDay: number;
  readonly placedWall: number;
  readonly kind: "call" | "callback";
  readonly callbackAt: number | null;
  readonly open: boolean;
  readonly closedWall: number | null;
  /** "Skip for now": the task moved to the end of that day's queue at this instant. */
  readonly skippedWall: number | null;
  /**
   * The instant through which the skip limit has been judged (ADR 0003 3.5; council on 228cd3b): its
   * placement, then each user-day rollover the engine has judged, or the instant a change of the user's
   * zone or another timing input was made. A rollover at or before it is never judged again, so a later
   * input never reinterprets a day already past.
   */
  readonly reckonedThrough: number;
}

/** One logged outcome on a call task. Skip for now is recorded too, but is not a call made. */
export interface CallAttempt {
  readonly id: string;
  /** The client's key for the action that logged it: unique, so a retry or a double click is logged once. */
  readonly requestId: string;
  readonly taskId: string;
  readonly outcome: CallOutcome;
  /** The user asked for a redial (no answer, voicemail or gatekeeper): the task moved to their next day. */
  readonly redial: boolean;
  /** For a callback requested: the date and time the prospect asked for, a wall instant. */
  readonly callbackAt: number | null;
  /** For not interested: the declined path applied, the track's or the user's override for this lead (ticket 16). */
  readonly declinedPath: DeclinedPath | null;
  /** The number the user chose to dial; none for skip for now. */
  readonly numberDetailId: string | null;
  readonly note: string;
  readonly at: number;
  readonly atWall: number;
}

/**
 * A note to store with an outcome: on the person, or shared with everyone at the company, as the user
 * chose. The store keeps a company lead's notes on its company, since it has no person.
 */
export interface NoteDraft {
  readonly id: string;
  readonly owner: "person" | "company";
  readonly callAttemptId: string | null;
  readonly body: string;
  readonly atWall: number;
}

/** A number the user may dial for the lead (ADR 0001 "Usable channels"): their own, or the company main line. */
export interface CallNumber {
  readonly id: string;
  readonly kind: "direct" | "mobile" | "main_line";
  readonly owner: "person" | "company";
  /** E.164 where it can be read, else its digits. */
  readonly key: string;
  readonly value: string;
  readonly bad: boolean;
  /** Later details are newer. */
  readonly order: number;
}

/**
 * The number a past call was logged on, as the detail it stands for now (ADR 0001 merges): what was
 * dialled, whoever's detail it has become. History only: whether it may be dialled is `CallNumber`'s.
 */
export interface RecordedNumber {
  /** The live detail the recorded id stands for now. */
  readonly id: string;
  readonly kind: "direct" | "mobile" | "main_line";
  /** The detail's owner now: a person (this lead or a colleague) or the company. */
  readonly owner: "person" | "company";
  readonly key: string;
}

/**
 * The user's call list on the current user day (ADR 0003 4.4), across every subject: read in the
 * transaction that places a task, so capacity is checked against current state.
 */
export interface CallDay {
  readonly userZone: string;
  /** The current user-local day number. */
  readonly day: number;
  readonly capacity: number;
  /** Tasks placed today. */
  readonly placedToday: number;
  /** Tasks placed before today that were open at its start, for leads that had not ended by then. */
  readonly committed: number;
}

/** A live contact detail of the lead, as engine decisions read it. */
export interface LeadDetail {
  readonly id: string;
  /** `linkedin`: the decision maker's profile from the import (ADR 0004 section 5), keyed by `linkedinProfileKey`. */
  readonly channel: "email" | "phone" | "linkedin";
  /** The lead may send to it: its own email, or a company lead's shared inbox. */
  readonly ownEmail: boolean;
  /**
   * The lead may text it: a decision maker's own mobile, read as an international number. A company
   * lead has none, since a main line is not an SMS destination (ADR 0001 "Usable channels").
   */
  readonly mobile: boolean;
  /** The detail's key: a lower-case address, or a number's E.164 form, which SMS is sent to. */
  readonly key: string;
  readonly value: string;
  readonly bad: boolean;
  /** Ordering: later details are newer. */
  readonly order: number;
}

export interface LeadFacts {
  /** The prospect's zone: the person's, else the company's, else the campaign default (3.4). */
  readonly zone: string;
  readonly details: readonly LeadDetail[];
  /**
   * Every detail id an attempt or track names, resolved to the live detail it stands for now.
   * `owned`: the lead may still send to it on its channel (its own email or shared inbox, or its own mobile).
   */
  readonly resolved: Readonly<Record<string, { readonly liveId: string; readonly bad: boolean; readonly owned: boolean }>>;
  readonly mergeData: MergeData;
  /** Every number the user may dial for the lead, good or bad: its own, then the company main line (ticket 14). */
  readonly phones: readonly CallNumber[];
}

/** One allowance of a social account (ADR 0004 1.2, 6): the user's number for the reset day, and what is used of it. */
export interface Allowance {
  readonly capacity: number;
  readonly used: number;
}

export interface AccountState {
  readonly id: string;
  readonly channel: "email" | "sms" | "linkedin";
  /**
   * A social account's allowances per kind of action, today (ADR 0004 6): sent on the reset day plus reservations, from
   * `provider_work.kind`. Absent on email and SMS, whose `capacity` is the one bucket.
   */
  readonly kinds?: { readonly invite: Allowance; readonly message: Allowance };
  /** A LinkedIn account's note allowance this calendar month, in its reset zone (ADR 0004 section 4). */
  readonly notes?: Allowance;
  /** Today's room on its current reset day (0: none). */
  readonly capacity: number;
  /** Its room on any other reset day (council on PR 63): today's room can be less, never the daily limit. */
  readonly dailyLimit: number;
  readonly gapMs: number;
  readonly k: number;
  readonly nextSlotAt: number;
  readonly healthy: boolean;
  /** Why it cannot send while not healthy: its provider's reason, or `not_listed` when its provider stopped listing it. */
  readonly problem: string | null;
  /** An account-level wait after a 402 or 429 (ADR 0003 2.4): no claim until it ends. */
  readonly waitUntil: number | null;
  readonly waitReason: "quota" | "rate_limited" | null;
  readonly backoffMs: number;
  /** The zone the account's daily capacity resets in. */
  readonly resetZone: string;
  /** Sends counted on today's reset day plus open reservations, across every subject. */
  readonly used: number;
  /** Of `used`, the open reservations: unsettled work not yet sent, which a later reset day still counts (4.2). */
  readonly reserved: number;
  /** Provider work holding in-flight places, across every subject: live attempts' work and unsettled work, once per key (`occupyingKeys`). */
  readonly inFlight: number;
}

export interface SubjectState {
  readonly subject: SubjectRecord;
  readonly campaign: CampaignState;
  readonly tracks: readonly TrackProgress[];
  readonly results: readonly StepResult[];
  readonly attempts: readonly Attempt[];
  /** The provider work of the subject's attempts, one per key. */
  readonly work: readonly ProviderWork[];
  readonly freezes: readonly Freeze[];
  readonly replies: readonly Reply[];
  /**
   * Replies waiting for their thread to be known, as inbox and lowercase address: while one
   * waits, nothing more goes from that inbox to that address (ADR 0003 2.4, review round 2).
   */
  readonly pendingReplies: readonly { readonly inbox: string; readonly address: string }[];
  /**
   * The unreleased SMS bindings of the lead's mobiles, whoever owns them (4.5). A binding this
   * subject's handover takes is added here, and the store inserts it in the same transaction.
   */
  readonly smsBindings: readonly SmsBinding[];
  readonly lead: LeadFacts;
  /** Details this change marks bad. Imports never clear a bad mark. */
  readonly markBad: readonly string[];
  /** Accounts this subject's change reads or writes. */
  readonly accounts: Readonly<Record<string, AccountState>>;
  /** The subject's call tasks, open and closed, and the outcomes logged on them. */
  readonly callTasks: readonly CallTask[];
  readonly callAttempts: readonly CallAttempt[];
  /** The number each call was logged on, by the id recorded on it, resolved through merges to the live detail (history only). */
  readonly recordedNumbers: Readonly<Record<string, RecordedNumber>>;
  /** Notes this change adds (with a call outcome); notes are never loaded back into decisions. */
  readonly newNotes: readonly NoteDraft[];
  readonly callDay: CallDay;
}
