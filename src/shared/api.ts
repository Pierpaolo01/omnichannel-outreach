/**
 * The HTTP interface's response shapes, shared by the server and the web client.
 * Types only: nothing here runs.
 */
import type { Channel, PhoneKind } from "../domain/contact-details.ts";
import type { ImportSummary, NotEnrolledReason } from "../domain/import-plan.ts";
import type { OutreachStatus } from "../domain/outreach-status.ts";

export type { ImportSummary, LeadOutcome, NotEnrolledReason, SummaryEntry } from "../domain/import-plan.ts";
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
}

export interface ImportRecord {
  readonly id: string;
  readonly campaignId: string;
  readonly importedAt: string;
  readonly summary: ImportSummary;
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
      readonly enrollments: readonly EnrollmentView[];
      readonly unenrolledReason: UnenrolledReason;
    }
  | {
      readonly kind: "company";
      readonly id: string;
      readonly name: string;
      readonly city: string;
      readonly enrollments: readonly EnrollmentView[];
      readonly unenrolledReason: UnenrolledReason;
    };

export interface LeadSearchResult {
  readonly rows: readonly LeadRow[];
  /** Matching rows before the limit was applied. */
  readonly total: number;
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
