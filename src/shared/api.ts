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

export interface CampaignListItem extends Campaign {
  readonly leadCount: number;
  readonly lastImport: {
    readonly id: string;
    readonly importedAt: string;
    readonly counts: Readonly<Record<LeadOutcome, number>>;
  } | null;
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
  readonly channel: "email";
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
export type HoldReasonApi = "unresolved" | "render_failed" | "provider_skipped" | "no_thread";

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
  readonly sender: string | null;
  readonly zone: string;
  readonly tracks: readonly TrackProgressView[];
}

/** GET /api/needs-attention (the 12b part: stalled inboxes, held tracks, account waits, provider anomalies). */
export interface NeedsAttention {
  readonly stalledInboxes: readonly { readonly accountId: string; readonly holding: readonly string[] }[];
  readonly heldTracks: readonly { readonly enrollmentId: string; readonly trackId: string; readonly reason: HoldReasonApi }[];
  readonly accountWaits: readonly { readonly accountId: string; readonly reason: "quota" | "rate_limited"; readonly until: string | null }[];
  /** Inboxes the provider reports unhealthy or disconnected: their leads wait on them. */
  readonly unhealthyInboxes: readonly { readonly accountId: string }[];
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
