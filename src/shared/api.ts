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
  /** The leads the email track would send to; the rest have no email and skip it. */
  readonly leadsWithEmail: number;
  readonly accounts: readonly {
    readonly id: string;
    readonly label: string;
    readonly capacity: number;
    /** Sends already counted or reserved today on this inbox, across every campaign. */
    readonly usedToday: number;
    /** The most this campaign would send from it on one day. */
    readonly busiestDay: number;
    readonly gapSeconds: number;
  }[];
  /**
   * Calendar days, counting launch day as day 1, until every lead with an email has had its first
   * email; null when no connected inbox can send, or not all start within the projection's horizon.
   */
  readonly daysUntilAllStart: number | null;
  /** Leads that would not have started within the projection's horizon. */
  readonly notStartedWithinHorizon: number;
  readonly horizonDays: number;
  /**
   * Pool inboxes that cannot send now with no known end: the provider reports them unable to send
   * (stale, sending off, not active), or the lead quota is held. While any is listed there is no
   * projection, because none can be honest. A rate limit has an end, and the projection resumes there.
   */
  readonly cannotProject: readonly { readonly accountId: string; readonly label: string; readonly reason: "cannot_send" | "quota" }[];
  /**
   * Another track can change when emails go, which the estimate does not simulate yet (SMS sends
   * arrive in it with ticket 13b): an SMS track, or a second email track, that does not start after
   * this campaign's email track, here or in another running campaign on the same inboxes. While set
   * there is no projection.
   */
  readonly otherTracksChangeTiming: "this_campaign" | "other_campaign" | null;
  /** The projection counts email only: this campaign's SMS track, which starts after its emails, is left out. */
  readonly leavesOutSms: boolean;
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
    readonly number: number;
    /** The earliest day it can go, counting the first email as day 1: one plus every wait before it. */
    readonly day: number;
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
  | {
      readonly kind: "sent";
      readonly stepNumber: number;
      readonly from: string;
      readonly to: string;
      readonly copy: { readonly subject: string; readonly body: string } | null;
    }
  | { readonly kind: "failed"; readonly stepNumber: number; readonly to: string; readonly reason: string }
  | { readonly kind: "skipped"; readonly stepNumber: number | null; readonly reason: string }
  /** A hard bounce the provider reported for an email of this campaign: the address is marked bad. */
  | { readonly kind: "bounced"; readonly stepNumber: number | null; readonly to: string }
  /** The track's address was marked bad elsewhere (another campaign's bounce), so the track ended. */
  | { readonly kind: "address_bad"; readonly to: string }
  | { readonly kind: "replied"; readonly channel: "email" | "sms" }
  | { readonly kind: "ended"; readonly status: "sequence_finished_no_response" | "finished_no_usable_channel" }
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
