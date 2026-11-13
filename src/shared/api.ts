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
