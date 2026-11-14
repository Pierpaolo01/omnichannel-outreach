/**
 * The HTTP interface's response shapes, shared by the server and the web client.
 * Types only: nothing here runs.
 */
import type { Channel, PhoneKind } from "../domain/contact-details.ts";
import type { ImportSummary, LeadOutcome, NotEnrolledReason } from "../domain/import-plan.ts";
import type { FileCheck } from "../domain/scraper-export.ts";
import type { OutreachStatus } from "../domain/outreach-status.ts";

export type { DetailNote, EvidenceKind, ImportSummary, LeadOutcome, NotEnrolledReason, SummaryEntry } from "../domain/import-plan.ts";
export type { ContactRoute } from "../domain/reach.ts";
export type { FileCheck } from "../domain/scraper-export.ts";
export type { OutreachStatus, StatusGroup } from "../domain/outreach-status.ts";

export interface Campaign {
  readonly id: string;
  readonly name: string;
  /** IANA time zone used when neither the lead nor its company has one. */
  readonly defaultTimezone: string | null;
  readonly createdAt: string;
}

/** Whether a campaign has launched, and the channels of its live main-sequence tracks, in order. */
export interface CampaignSequenceSummary {
  readonly launchedAt: string | null;
  readonly tracks: readonly ("email" | "sms" | "call")[];
}

export interface CampaignListItem extends Campaign {
  readonly leadCount: number;
  readonly sequence: CampaignSequenceSummary;
  readonly lastImport: {
    readonly id: string;
    readonly importedAt: string;
    readonly counts: Readonly<Record<LeadOutcome, number>>;
  } | null;
}

/** GET /api/campaigns/:id */
export interface CampaignDetail {
  readonly campaign: Campaign;
  readonly imports: readonly ImportRecord[];
  readonly leadCount: number;
  readonly sequence: CampaignSequenceSummary;
}

export interface ImportFileNames {
  readonly people: string | null;
  readonly businesses: string | null;
}

export interface ImportRecord {
  readonly id: string;
  readonly campaignId: string;
  readonly importedAt: string;
  readonly fileNames: ImportFileNames;
  readonly summary: ImportSummary;
}

/** POST /api/scraper-files/check: each chosen file on its own, then the pair together. */
export interface FileCheckResult {
  readonly businesses: FileCheck | null;
  readonly people: FileCheck | null;
  /** Why the two files don't belong together, when both are valid on their own. */
  readonly pair: string | null;
}

export interface EnrollmentView {
  readonly id: string;
  readonly campaign: { readonly id: string; readonly name: string };
  readonly status: OutreachStatus;
  readonly enrolledAt: string;
}

export interface ContactDetailView {
  readonly id: string;
  /** Person details belong to the decision maker; company details are the shared main line and inbox. */
  readonly owner: "person" | "company";
  readonly channel: Channel;
  readonly phoneKind: PhoneKind | null;
  readonly value: string;
  readonly bad: boolean;
  /** Added by a later import alongside an older detail on the same channel. */
  readonly newer: boolean;
}

/** Why someone on record has no enrollment. Null when they have one, or nothing stops one. */
export type UnenrolledReason = Extract<NotEnrolledReason, "no_usable_channel"> | null;

export interface CompanyRef {
  readonly id: string;
  readonly name: string;
  readonly city: string;
}

export type LeadRow =
  | {
      readonly kind: "person";
      readonly id: string;
      readonly name: string;
      readonly title: string;
      readonly company: CompanyRef;
      /** The company is a company lead, contacted through its own details. */
      readonly companyIsLead: boolean;
      readonly enrollments: readonly EnrollmentView[];
      readonly unenrolledReason: UnenrolledReason;
    }
  | {
      readonly kind: "company";
      readonly id: string;
      readonly name: string;
      readonly city: string;
      /** Named decision makers on record. */
      readonly peopleOnRecord: number;
      /** Of them, those enrolled or with a usable channel now. A later import can make one reachable. */
      readonly peopleReachable: number;
      readonly enrollments: readonly EnrollmentView[];
      readonly unenrolledReason: UnenrolledReason;
    };

export interface LeadSearchResult {
  readonly rows: readonly LeadRow[];
  /** Matching rows before the limit was applied, and how many of them are people or companies. */
  readonly total: number;
  readonly people: number;
  readonly companies: number;
  readonly limit: number;
}

export interface ColleagueView {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly enrollments: readonly EnrollmentView[];
  readonly unenrolledReason: UnenrolledReason;
}

export interface PersonRecord {
  readonly kind: "person";
  readonly id: string;
  readonly name: string;
  readonly title: string;
  /** The person's time zone, else the company's, else the first campaign default. */
  readonly timezone: string | null;
  readonly company: CompanyRef;
  /** The company itself is enrolled as a company lead, contacted through its own details. */
  readonly companyIsLead: boolean;
  readonly contactDetails: readonly ContactDetailView[];
  readonly enrollments: readonly EnrollmentView[];
  readonly unenrolledReason: UnenrolledReason;
  readonly colleagues: readonly ColleagueView[];
}

export interface CompanyRecord {
  readonly kind: "company";
  readonly id: string;
  readonly name: string;
  readonly city: string;
  readonly timezone: string | null;
  readonly contactDetails: readonly ContactDetailView[];
  /** Company-lead enrollments: outreach to the company through its own details. */
  readonly enrollments: readonly EnrollmentView[];
  readonly unenrolledReason: UnenrolledReason;
  /** Decision makers on record at the company, enrolled or not. */
  readonly people: readonly ColleagueView[];
}

export interface ApiError {
  readonly error: { readonly code: string; readonly message: string; readonly problems?: readonly { file: string; message: string }[] };
}

/** A refused call outcome: the call's off-list facts as the server read them when it refused (ticket 14b). */
export interface CallOutcomeRefusal extends ApiError {
  readonly offList: CallOffListView | null;
}

// ---------------------------------------------------------------------------------------------
// The sequence engine (ADR 0003), ticket 12b: one email track, launch, and each lead's progress.

export type {
  CampaignDefinition,
  StepDefinition,
  TrackDefinition,
  StartRule,
  Threading,
} from "../domain/sequence/definition.ts";
export type { WindowRule } from "../domain/sequence/clock.ts";
export type { LaunchBlocker } from "../domain/sequence/blockers.ts";
export type { TrackLabel } from "./track-label.ts";
import type { TrackLabel } from "./track-label.ts";

/** A sender account the engine may send from, as the provider reports it. */
export interface SenderAccountViewApi {
  readonly id: string;
  readonly label: string;
  readonly channel: "email" | "sms";
  readonly healthy: boolean;
  readonly capacity: number;
  /** The pacing gap between two sends from this account, in seconds. */
  readonly gapSeconds: number;
  /** Sends counted today plus open reservations. */
  readonly usedToday: number;
  /** An account-level wait after a quota (402) or rate-limit (429) refusal. */
  readonly waiting: "quota" | "rate_limited" | null;
}

/** GET /api/campaigns/:id/sequence */
export interface SequenceView {
  readonly campaignId: string;
  readonly definition: import("../domain/sequence/definition.ts").CampaignDefinition;
  readonly definitionVersion: number;
  readonly editedAt: string | null;
  readonly launchedAt: string | null;
  /** Exactly three blockers; "nothing to launch" is separate (ADR 0003 7.2). */
  readonly launch: {
    readonly blockers: readonly import("../domain/sequence/blockers.ts").LaunchBlocker[];
    readonly nothingToLaunch: boolean;
    readonly canLaunch: boolean;
  };
  readonly accounts: readonly SenderAccountViewApi[];
}

export type FinishReasonApi = import("../domain/sequence/state.ts").FinishReason;
/**
 * Why a track waits for the user (ADR 0003 5.4). `sms_conversation_taken`: every number the SMS
 * track may use is in another campaign's conversation with this mobile (4.5, question Q7).
 */
export type HoldReasonApi = "unresolved" | "render_failed" | "provider_skipped" | "no_thread" | "sms_conversation_taken";

export interface SendView {
  readonly attemptId: string;
  /** claimed, handed, accepted, sent, rejected or withdrawn (ADR 0003 5.3). */
  readonly state: import("../domain/sequence/state.ts").AttemptState;
  readonly sender: string;
  readonly destination: string;
  /** The copy as handed over; null before the handover. */
  readonly copy: { readonly subject: string; readonly body: string } | null;
  readonly handedAt: string | null;
  /** The provider's send time. */
  readonly sentAt: string | null;
  readonly endedBy: string | null;
  readonly rejectReason: string | null;
  /** The app cannot tell whether it was sent; resolution controls arrive with ticket 20. */
  readonly unresolved: boolean;
}

export interface StepProgressView {
  readonly stepId: string;
  readonly number: number;
  readonly removed: boolean;
  readonly result: "sent" | "skipped" | "failed" | null;
  readonly reason: string | null;
  readonly at: string | null;
  readonly sends: readonly SendView[];
  /** A call step's logged outcomes, skip for now included (ticket 14); empty on email and SMS steps. */
  readonly calls: readonly CallRecordView[];
}

export interface TrackProgressView {
  readonly trackId: string;
  readonly channel: string;
  readonly started: boolean;
  readonly finishReason: FinishReasonApi | null;
  readonly finishedAt: string | null;
  readonly hold: HoldReasonApi | null;
  /** The pending step and the wall instant it is due, if the lead keeps running. */
  readonly nextStep: { readonly stepId: string; readonly number: number; readonly dueAt: string } | null;
  /** A phone track's call task once placed on the user's list (ticket 14): open until its outcome or its track's finish. */
  readonly callTask: {
    readonly taskId: string;
    readonly open: boolean;
    readonly placedAt: string;
    readonly listed: boolean;
    /** A callback holds the lead's outreach in this campaign until its outcome (ticket 15). */
    readonly kind: "call" | "callback";
    /** For a callback: the date and time the prospect asked for. */
    readonly callbackAt: string | null;
    /** The user's date the call is listed for, YYYY-MM-DD: a redial moves it to the next day. */
    readonly listedFor: string;
    /** The call step's original due time, which the skip limit counts from. */
    readonly dueAt: string;
  } | null;
  readonly steps: readonly StepProgressView[];
}

/** GET /api/enrollments/:id */
export interface EnrollmentProgress {
  readonly id: string;
  readonly campaignId: string;
  readonly status: OutreachStatus;
  readonly endedAt: string | null;
  /** "replied, automation stopped" with channel and date only. */
  readonly reply: { readonly channel: "email" | "sms"; readonly at: string } | null;
  /** The lead's email inbox, fixed at its first email. */
  readonly sender: string | null;
  /** The lead's SMS number, fixed at its first text (ticket 13). */
  readonly smsSender: string | null;
  readonly zone: string;
  readonly tracks: readonly TrackProgressView[];
}

/** GET /api/needs-attention (the 12b part: stalled inboxes, held tracks, account waits, provider anomalies). */
export interface NeedsAttention {
  /**
   * Callbacks whose time has passed with no outcome logged (ticket 15): each holds its lead's automated
   * outreach in that campaign until the user logs what happened. Oldest first.
   */
  readonly overdueCallbacks: readonly { readonly taskId: string; readonly enrollmentId: string; readonly campaignId: string; readonly callbackAt: string; readonly dueAt: string }[];
  readonly stalledInboxes: readonly { readonly accountId: string; readonly holding: readonly string[] }[];
  readonly heldTracks: readonly { readonly enrollmentId: string; readonly trackId: string; readonly reason: HoldReasonApi }[];
  readonly accountWaits: readonly { readonly accountId: string; readonly reason: "quota" | "rate_limited"; readonly until: string | null }[];
  /**
   * Sender accounts on any channel that cannot send, each listed once (ticket 13; spec "Needs
   * attention": sender account problems such as a disconnected SMS number). `problem` is the
   * provider's own reason (for Instantly an `InboxHoldReasonApi`, for SMS "disconnected"),
   * `not_listed` when the provider no longer lists the account, or `unhealthy` when no reason was
   * given. Their leads wait on them; nothing is dropped. (Replaces 12b's `unhealthyInboxes`.)
   */
  readonly senderProblems: readonly { readonly accountId: string; readonly channel: "email" | "sms"; readonly label: string; readonly problem: string }[];
  /**
   * Inboxes some of whose daily sends are held by unresolved provider work (ADR 0003 4.2): how
   * many, and the work holding them, until the provider or the user settles it.
   */
  readonly heldCapacity: readonly {
    readonly accountId: string;
    readonly held: number;
    readonly capacity: number;
    /** Sends already counted on the inbox's current reset day. */
    readonly sentToday: number;
    readonly work: readonly {
      readonly attemptId: string;
      readonly enrollmentId: string;
      readonly stepId: string;
      readonly destination: string;
      readonly unresolvedSince: string;
      /** The latest lookup answer: while it is `queued`, "not sent" is refused. */
      readonly lookupAnswer: "sent" | "queued" | "not-sent" | "unknown" | null;
      readonly canMarkNotSent: boolean;
    }[];
  }[];
  readonly anomalies: readonly { readonly what: string; readonly at: string }[];
}

// ---------------------------------------------------------------------------------------------
// The campaign editor's Before launch tab and the person timeline (ticket 12c). Read models only.

/** A lead of the campaign the copy can be rendered for: an enrollment that has not ended. */
export interface PreviewLead {
  /** The enrollment id. */
  readonly id: string;
  readonly kind: "person" | "company";
  /** The person's or company lead's record id, for its page. */
  readonly recordId: string;
  readonly name: string;
  readonly title: string;
  readonly company: string;
  /** The address the email track would send to: the lead's own email, or a company lead's shared inbox. */
  readonly email: string | null;
  /** A good mobile of the decision maker's own; company leads are never texted. */
  readonly mobile: boolean;
  /** A good phone number to call: their own, or the company's main line. */
  readonly phone: boolean;
  /** Merge fields the live copy uses that this lead has no value for. */
  readonly lacks: readonly string[];
}

/** GET /api/campaigns/:id/before-launch */
export interface BeforeLaunchView {
  readonly campaignId: string;
  readonly leads: readonly PreviewLead[];
  /** Spec "Before launch": how many leads have an email, a mobile or a phone number. */
  readonly coverage: { readonly leads: number; readonly email: number; readonly mobile: number; readonly phone: number };
  /** Every merge field the live copy uses, with how many leads lack it and the fallbacks written for it. */
  readonly mergeFields: readonly {
    readonly field: string;
    readonly leadsMissing: number;
    /** Of them, company leads, which have no person's name or title. */
    readonly companyLeadsMissing: number;
    /** The distinct fallback texts written for this field; empty when some use has none. */
    readonly fallbacks: readonly string[];
    /** Some use of the field has no fallback. */
    readonly someUseWithoutFallback: boolean;
  }[];
  /** Null once the campaign has launched: the projection is a before-launch estimate. */
  readonly load: LoadProjectionView | null;
}

export interface LoadProjectionView {
  /**
   * This campaign's leads some live track can reach: they would start. Null when nothing is
   * projected (see `cannotProject` and `noSender`).
   */
  readonly leadsToStart: number | null;
  /**
   * Leads only a phone track can reach. Since ticket 14c they start when their first call goes on the
   * user's list, and are counted in `leadsToStart` and `daysUntilAllStart`.
   */
  readonly onlyCalled: number;
  /** Every sender account in a live track's pool, on either channel. */
  readonly accounts: readonly {
    readonly id: string;
    readonly label: string;
    readonly channel: "email" | "sms";
    readonly capacity: number;
    /** Sends already counted or reserved today on this account, across every campaign. */
    readonly usedToday: number;
    /** The most this campaign would send from it on one day. */
    readonly busiestDay: number;
    readonly gapSeconds: number;
  }[];
  /**
   * Calendar days, counting launch day as day 1, until every lead some live track can reach has had
   * its first message on any channel or its first call placed on the user's list; null when nothing
   * is projected, or not all start within the projection's horizon.
   */
  readonly daysUntilAllStart: number | null;
  /** Some lead would not have started within the projection's horizon (said without a count: that run stopped at the horizon). */
  readonly someNotStartedWithinHorizon: boolean;
  readonly horizonDays: number;
  /**
   * Pool accounts that cannot send now with no known end: the provider reports them unable to send
   * (stale, sending off, not active, disconnected), or the lead quota is held. While any is listed
   * there is no projection, because none can be honest. A rate limit has an end, and the projection resumes there.
   */
  readonly cannotProject: readonly {
    readonly accountId: string;
    readonly label: string;
    readonly channel: "email" | "sms";
    /**
     * `unsettled_work`: work whose outcome only the provider or the user can settle holds some of its
     * sends (Needs attention lists it); `reply_being_matched`: a reply to it is being matched to its
     * lead, which may stop that lead (ADR 0003, ticket 13b).
     */
    readonly reason: "cannot_send" | "quota" | "unsettled_work" | "reply_being_matched";
  }[];
  /**
   * The tracks that withhold the figure, whenever one does (ADR 0003, ticket 13b): a track whose
   * channel has no connected sender (launch blocker 3). A track after a phone track is projected since
   * ticket 14c, under the stated assumption about calls. The screen words any "no figure because" from
   * these alone (`src/web/campaign/withheld.ts`). Null when none does.
   */
  readonly withheldBy: WithheldBy | null;
  /**
   * Why the projection stopped before its end, as the run says on itself, so no figure is shown
   * (ADR 0003, ticket 14c): `bound`, it reached its bound on work (`PROJECTION_MAX_STEPS`, calls into
   * the engine's rules) and the campaign is too large to estimate; `horizon`, something it would do lies
   * past its `horizonDays`. Null when it reached its end, or did not run (see `withheldBy` and `cannotProject`).
   */
  readonly stoppedEarly: "bound" | "horizon" | null;
  /**
   * The user's calls, when the campaign has a live phone track (ADR 0003, ticket 14c); null otherwise.
   * A call is a task on the user's list, not a send: the projection places due calls by the engine's
   * own rules within the daily call capacity, assuming the user works through each day's list, and
   * foresees no call outcome.
   */
  readonly calls: {
    /** The user's daily call capacity, across every campaign (GET /api/call-settings). */
    readonly capacity: number;
    /** Calls on today's list across every campaign: placed today, and carried from earlier days. */
    readonly onListToday: number;
    /** The most calls of this campaign placed on one day; null when nothing is projected. */
    readonly busiestDay: number | null;
  } | null;
  /**
   * Other campaigns, sharing these senders or the call list, whose calls the estimate also assumes are
   * worked on their day with no answer (ADR 0003, ticket 14c). The screen names them.
   */
  readonly callsNotCounted: readonly { readonly id: string; readonly name: string }[];
}

/** Rendered copy, in pieces, so a fallback the lead gets can be shown as one. */
export interface CopySegment {
  readonly text: string;
  /** A literal, the lead's own value, a fallback for a field it lacks, or a missing field with no fallback. */
  readonly kind: "literal" | "value" | "fallback" | "missing";
  /** The merge field, for every kind but literal. */
  readonly field?: string;
}

/** GET /api/campaigns/:id/preview/:enrollmentId */
export interface CopyPreview {
  readonly lead: PreviewLead;
  readonly steps: readonly {
    readonly trackId: string;
    readonly stepId: string;
    readonly channel: "email" | "sms";
    /** Its number within its track: Email 2, Text 1. */
    readonly number: number;
    /** The day the projection sends it to this lead, counting launch day as day 1; null with `noDay` otherwise. */
    readonly day: number | null;
    /**
     * Why the message shows no day, when it shows none (review bot on 93bcc0c): every day shown is the
     * day the projection sends it, and nothing else. `skipped`: the lead skips its track. `no_estimate`:
     * no figure is projected (withheld, too large, or the campaign has launched). `beyond_horizon`: the
     * projection's horizon ends before it. `not_sent`: a merge field with no fallback the lead lacks
     * holds it. The rest of its track then shows no day either, for the same reason.
     */
    readonly noDay: "skipped" | "no_estimate" | "beyond_horizon" | "not_sent" | null;
    /** The phone track this message waits on, through its track's chain, if any. */
    readonly waitsOnCall: string | null;
    /** This lead lacks the track's channel (no email; no mobile of their own, or a company lead), so the track is skipped and the tracks after it start sooner. */
    readonly skipped: boolean;
    readonly threading: "new_subject" | "continue_thread";
    /** The subject the step writes; on a continue-thread step, the subject of the thread it continues. */
    readonly subject: readonly CopySegment[];
    readonly body: readonly CopySegment[];
    /** Merge fields this lead lacks that have no fallback: the copy cannot be sent to them. */
    readonly missing: readonly string[];
  }[];
}

/** One line of a person's or company lead's timeline (GET /api/people/:id/activity). Newest first. */
export type ActivityEntry = { readonly campaign: { readonly id: string; readonly name: string }; readonly at: string } & (
  | ({ readonly channel: "email" | "sms"; readonly track: TrackLabel } & (
      | {
          readonly kind: "sent";
          readonly stepNumber: number;
          readonly from: string;
          /** The address, or the mobile grouped for reading. */
          readonly to: string;
          /** A text's subject is empty. */
          readonly copy: { readonly subject: string; readonly body: string } | null;
        }
      | { readonly kind: "failed"; readonly stepNumber: number; readonly to: string; readonly reason: string }
      /** `no_email`, `no_mobile`, `company_lead` (a company lead is never texted, ADR 0003 Q10), `block_list`, or the step's reason. */
      | { readonly kind: "skipped"; readonly stepNumber: number | null; readonly reason: string }
      /** A hard bounce, or a number the carrier reported invalid after a text: the address or number is marked bad. */
      | { readonly kind: "bounced"; readonly stepNumber: number | null; readonly to: string }
      /** The track ended because its address or number is marked bad, with no bounce event of this campaign's. */
      | { readonly kind: "address_bad"; readonly to: string }
      /** The track started after `after`, which was skipped or failed for this lead (ticket 13b). */
      | { readonly kind: "released"; readonly after: TrackLabel; readonly because: "skipped" | "failed" }
    ))
  | { readonly kind: "replied"; readonly channel: "email" | "sms" }
  | { readonly kind: "ended"; readonly status: "sequence_finished_no_response" | "finished_no_usable_channel" }
  /**
   * A phone track's entries (ticket 14b): each call outcome the user logged, skip for now included,
   * with the number dialled (none on a skip) and its note; a skip for want of a good number
   * (`no_number`); and its start after a track that was skipped or failed.
   */
  | ({ readonly channel: "call"; readonly track: TrackLabel } & (
      | { readonly kind: "call"; readonly outcome: CallOutcomeApi; readonly number: RecordedNumberView | null; readonly note: string }
      | { readonly kind: "skipped"; readonly stepNumber: null; readonly reason: "no_number" }
      | { readonly kind: "released"; readonly after: TrackLabel; readonly because: "skipped" | "failed" }
    ))
);

export interface ActivityView {
  readonly entries: readonly ActivityEntry[];
}

/**
 * GET /api/sms-provider (ticket 13). No SMS provider is provisioned or chosen (#28), so the running
 * app reports `none` with no numbers, and every SMS track is blocked by "no connected sender".
 * `test-simulator` appears only in the test harness and the scripted scenario: it is a fake, not
 * a provider integration.
 */
export interface SmsProviderStatus {
  readonly provider: "none" | "test-simulator";
  readonly message: string;
  readonly numbers: readonly { readonly id: string; readonly label: string; readonly healthy: boolean; readonly capacity: number; readonly usedToday: number }[];
}

/** Why a sender inbox of the email provider cannot send now. */
export type InboxHoldReasonApi = "sending_off" | "not_active" | "no_daily_limit" | "stale";

/** GET /api/email-provider (ticket 12c): the email provider, its sender inboxes, and why any cannot send. */
export interface EmailProviderStatus {
  readonly provider: "instantly" | "none";
  /** Real provider writes: "off" unless the runtime setting turns them on. */
  readonly sending: "on" | "off";
  /** Continue-thread follow-ups: unavailable until ADR 0002's experiment X2 picks a transport. */
  readonly followUps: "available" | "unavailable";
  /** "exhausted" after a 402 or an exhausted lead quota: every dispatch handover waits. */
  readonly quota: "available" | "exhausted";
  readonly lastPolledAt: string | null;
  readonly inboxes: readonly {
    readonly id: string;
    /** Instantly's account status: 1 Active, 2 Paused, 3 maintenance, -1 to -3 errors. */
    readonly status: number;
    readonly dailyLimit: number | null;
    /** The daily limit less what other campaigns sent from the inbox today. */
    readonly capacity: number;
    readonly healthy: boolean;
    readonly reason: InboxHoldReasonApi | null;
  }[];
  /** Leads whose next email is a continue-thread follow-up the provider cannot send yet: they wait, and nothing is sent. */
  readonly waitingFollowUps: readonly { readonly enrollmentId: string; readonly trackId: string; readonly stepId: string }[];
}

// ---------------------------------------------------------------------------------------------
// Calls (ticket 14, part a): phone tracks, the user's call list, and the outcomes the user logs.
// The user dials on their own phone; the application never dials and has no telephony provider.

/**
 * What the user logs on a call task. A callback requested carries `callbackAt`; no answer, voicemail and
 * gatekeeper may carry `redial` (ticket 15). Not interested arrives with ticket 16.
 */
export type CallOutcomeApi = import("../domain/sequence/state.ts").CallOutcome;

/**
 * Why a call is on the list (ticket 15): `due` today; `rolled_over` from an earlier day, unworked; `redial`,
 * moved onto today by the user's redial; `callback`, before the time the prospect asked for; `overdue`, a
 * callback whose time has passed with no outcome logged.
 */
export type CallReasonApi = import("../domain/sequence/calls.ts").CallReason;

/** One logged call, as the task's touches and the lead's progress show it. */
export interface CallRecordView {
  readonly outcome: CallOutcomeApi;
  readonly at: string;
  readonly number: RecordedNumberView | null;
  readonly note: string;
  /** The user asked for a redial with it. */
  readonly redial: boolean;
  /** With a callback requested: the date and time the prospect asked for. */
  readonly callbackAt: string | null;
}

/** GET and PUT /api/call-settings: the user's daily call capacity and the zone the call list's day is counted in. */
export interface CallSettingsView {
  readonly dailyCapacity: number;
  readonly userZone: string;
}

/** A number the user may dial, labelled by kind: direct first, then mobile, then the company main line. */
export interface CallNumberView {
  readonly detailId: string;
  readonly kind: "direct" | "mobile" | "main_line";
  /** A main line is the company's: a call to it reaching a gatekeeper still counts as a call to the lead. */
  readonly owner: "person" | "company";
  readonly value: string;
  /** Marked bad (struck through); the user cannot log an outcome on it. */
  readonly bad: boolean;
}

/** One task on the call list. */
export interface CallQueueItem {
  readonly taskId: string;
  readonly enrollmentId: string;
  /** The decision maker; null for a company lead, called on the company's main line. */
  readonly person: { readonly id: string; readonly name: string; readonly title: string } | null;
  readonly company: { readonly id: string; readonly name: string };
  readonly campaign: { readonly id: string; readonly name: string };
  /** The phone track the call comes from, named as the canvas names it ("Phone track", "Phone track 2"). */
  readonly track: { readonly id: string; readonly label: string };
  /** The prospect's zone and their local time now, as HH:MM. */
  readonly zone: string;
  readonly localTime: string;
  readonly reason: CallReasonApi;
  /** A callback holds the lead's other outreach in this campaign until its outcome. */
  readonly kind: "call" | "callback";
  /** For a callback: the date and time the prospect asked for. */
  readonly callbackAt: string | null;
  /**
   * The call step's original due time. The skip limit counts from it, whatever rolled the call over or
   * redialed it.
   */
  readonly dueAt: string;
  readonly bucket: "ready_now" | "later_today";
  /** For later today: when the prospect's calling hours open, or a callback's time. */
  readonly opensAt: string | null;
  /** Left unworked today, this call is skipped at the end of the day (the skip limit) and the tracks after it start. */
  readonly skippedTonight: boolean;
}

/** A track whose channel has no connected sender, so the load is not projected (Before launch). */
export interface WithheldTrack {
  readonly trackId: string;
  readonly channel: "email" | "sms" | "call";
  /** As the canvas names it: "the SMS track", "email track 2". */
  readonly label: string;
  /** Its channel has no connected sender, so its leads and every track after it would wait. */
  readonly why: "no_sender";
}

export interface WithheldBy {
  readonly tracks: readonly WithheldTrack[];
}

/** GET /api/today: the landing page's call part. Needs attention is GET /api/needs-attention. */
export interface TodayView {
  /** The user's date, YYYY-MM-DD in their zone. */
  readonly date: string;
  /** The server's instant for this answer. */
  readonly asOf: string;
  /**
   * A hint (ADR 0003 4.4.1, "Freshness"): an instant at which this answer is known to change by the
   * clock (calling hours opening or closing, the user's next day). A screen may refresh then, sooner
   * than its interval; nothing depends on it being complete.
   */
  readonly nextChangeAt: string | null;
  readonly userZone: string;
  readonly readyNow: number;
  readonly laterToday: number;
  /** Today's call capacity is used: calls due after this wait for the next day, and none is dropped (4.4). */
  readonly capacityReached: boolean;
  /** The next calls, in queue order: ready now first, then later today. */
  readonly upNext: readonly CallQueueItem[];
  /** Needs attention (ticket 15): every overdue callback on the list, oldest first, each holding its lead's outreach. */
  readonly overdueCallbacks: readonly CallQueueItem[];
  /** Calls on today's list carried from an earlier day: rolled over or redialed. */
  readonly carriedOver: number;
}

/** GET /api/calls: the focus queue. The focused task is the first ready now; the queue moves on only after an outcome. */
export interface CallsView {
  readonly date: string;
  /** The server's instant for this answer. */
  readonly asOf: string;
  /** As on TodayView: a hint of when the queue changes by the clock. */
  readonly nextChangeAt: string | null;
  readonly userZone: string;
  readonly dailyCapacity: number;
  /** The capacity the user has until they set one. */
  readonly defaultDailyCapacity: number;
  /** Today's call capacity is used: no new call is placed today (4.4: new placed today < capacity − committed). */
  readonly capacityReached: boolean;
  /** New tasks placed today, and tasks carried into today from earlier days, which count first. */
  readonly placedToday: number;
  readonly committed: number;
  /** Inside the prospect's calling hours: oldest due first; tasks skipped for now today go last, in the order skipped. */
  readonly readyNow: readonly CallQueueItem[];
  /** Callable later on the user's day: the calling hours open later today. Soonest first. */
  readonly laterToday: readonly CallQueueItem[];
  /**
   * The focused call. Send the call the screen is on as `?focus=`: it stays the focus while it is
   * listed, so the queue moves on only after an outcome. With none, the first call ready now.
   */
  readonly focusTaskId: string | null;
}

/** POST /api/call-tasks/:id/outcome: the task after the outcome, and the call the focus queue moves on to. */
export interface CallOutcomeAnswer {
  readonly task: CallTaskView;
  readonly nextFocusTaskId: string | null;
}

/** One earlier touch on the lead in this campaign. Replies show channel and date only. */
export type TouchView =
  | { readonly kind: "email" | "sms"; readonly at: string; readonly stepId: string; readonly copy: { readonly subject: string; readonly body: string } | null }
  | { readonly kind: "reply"; readonly channel: "email" | "sms"; readonly at: string }
  | ({ readonly kind: "call" } & CallRecordView);

/**
 * The number a past call was logged on, as the detail it stands for now: what was dialled, kept through
 * re-imports that merge it, even into a colleague's detail. It says nothing about whether it may be
 * dialled now; the task's `numbers` say that.
 */
export interface RecordedNumberView {
  readonly detailId: string;
  readonly kind: "direct" | "mobile" | "main_line";
  /** The detail's owner now: a person (the lead or a colleague) or the company. */
  readonly owner: "person" | "company";
  readonly value: string;
}

export interface NoteView {
  readonly id: string;
  readonly body: string;
  readonly at: string;
}

/** Someone else at the company, enrolled or not, with their outreach statuses and their last call note. */
export interface CallColleagueView {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly statuses: readonly { readonly campaign: { readonly id: string; readonly name: string }; readonly status: OutreachStatus }[];
  readonly lastCallNote: { readonly note: string; readonly outcome: string; readonly at: string } | null;
}

/**
 * Why a call task is not on today's list (ADR 0003 4.4.1), from the stored task and its call records:
 * `logged`, an outcome was logged on it (by any tab or client); `track_finished`, its phone track
 * finished otherwise (with the reason); `lead_ended`, the lead's outreach ended in this campaign;
 * `not_listed_today`, it waits for a day its calling hours open. `status` is the lead's status now.
 */
export type CallOffListView =
  | { readonly reason: "logged"; readonly outcome: CallOutcomeApi; readonly at: string; readonly status: OutreachStatus }
  | { readonly reason: "track_finished"; readonly finish: FinishReasonApi | null; readonly status: OutreachStatus }
  | { readonly reason: "lead_ended"; readonly status: OutreachStatus }
  | { readonly reason: "not_listed_today"; readonly status: OutreachStatus };

/** GET /api/call-tasks/:id: everything the call screen shows for one task. */
export interface CallTaskView {
  readonly task: CallQueueItem | null;
  readonly taskId: string;
  readonly enrollmentId: string;
  /** Open until its outcome is logged or its track finishes. */
  readonly open: boolean;
  /** On today's list now, so an outcome is accepted. */
  readonly listed: boolean;
  /** Why it is not on today's list; null while it is. */
  readonly offList: CallOffListView | null;
  readonly status: OutreachStatus;
  readonly person: { readonly id: string; readonly name: string; readonly title: string } | null;
  readonly company: { readonly id: string; readonly name: string };
  readonly campaign: { readonly id: string; readonly name: string };
  readonly track: { readonly id: string; readonly label: string };
  readonly zone: string;
  readonly localTime: string;
  readonly numbers: readonly CallNumberView[];
  /** The phone track's calling hours, in the prospect's local time (its window: days 0 = Sunday, whole hours). */
  readonly callingHours: readonly import("../domain/sequence/clock.ts").WindowRule[];
  /**
   * Whether the prospect is inside those calling hours at this read's instant, by the engine's own window
   * rule (re-check 7, R10), and, when not, the instant they open later on the user's day (null if not
   * today). A fact about the hours only: a callback is listed by the time asked for, whatever the hours.
   */
  readonly callingHoursNow: { readonly open: boolean; readonly opensLaterToday: string | null };
  /** The campaign's call script or talking points. */
  readonly script: string;
  /** Every earlier touch on this lead in this campaign, oldest first. Engagement (opens, clicks) is not tracked. */
  readonly touches: readonly TouchView[];
  readonly personNotes: readonly NoteView[];
  /** Shown for everyone at the company. */
  readonly companyNotes: readonly NoteView[];
  /** Every other decision maker at the company, including people not enrolled. */
  readonly colleagues: readonly CallColleagueView[];
  /** The outcomes the user can log now; empty when the task is not listed. */
  readonly outcomes: readonly CallOutcomeApi[];
  /** Of those, the ones the user may log with a redial (no answer, voicemail, gatekeeper). */
  readonly redialOutcomes: readonly CallOutcomeApi[];
  /** A callback holds the lead's other outreach in this campaign until its outcome (ticket 15). */
  readonly kind: "call" | "callback";
  readonly callbackAt: string | null;
  /** The call step's original due time, which the skip limit counts from. */
  readonly dueAt: string;
  /** The user's date the call is listed for, YYYY-MM-DD: a redial moves it to the next day. */
  readonly listedFor: string;
  /**
   * The request id of every outcome stored on this task, skips for now included: the server's word on
   * whether a press was logged, whoever received its answer (ADR 0003 4.4.1, "One reconciliation").
   */
  readonly storedRequestIds: readonly string[];
}
