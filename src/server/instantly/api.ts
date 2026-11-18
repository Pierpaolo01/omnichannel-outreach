/**
 * The parts of Instantly's API v2 the adapter uses, as documented. Every shape below is copied from
 * the published OpenAPI document `https://api.instantly.ai/openapi/api_v2.json` (version 2.0.0,
 * 198 paths, re-read 13 November 2026); the reference pages under
 * `https://developer.instantly.ai/api-reference/` are rendered from it. Each type names its
 * `operationId` there. Only the fields the adapter reads or writes are listed; the provider may
 * send more, and the adapter ignores them.
 *
 * The fake Instantly service in `test/support/fake-instantly.ts` answers with these shapes and
 * nothing else, so a test against it shows the adapter honours the documentation, never that the
 * real service behaves this way (ADR 0002's experiments X1 to X9 are what would show that).
 */

export const INSTANTLY_BASE_URL = "https://api.instantly.ai";

/** `Account.status` (schema `Account`): 1 Active, 2 Paused, 3 maintenance, -1 Connection Error, -2 Soft Bounce Error, -3 Sending Error. */
export type AccountStatusCode = 1 | 2 | 3 | -1 | -2 | -3;

/** Schema `Account`, as listed by `GET /api/v2/accounts` (operationId `listAccount`). */
export interface InstantlyAccount {
  readonly email: string;
  readonly status: AccountStatusCode;
  /** "Daily email sending limit"; nullable. */
  readonly daily_limit: number | null;
}

/** A page of a cursor-paginated list (`listAccount`, `listCampaign`, `listEmail`, `listLeads`). */
export interface Page<T> {
  readonly items: readonly T[];
  /** Absent or empty on the last page. */
  readonly next_starting_after?: string | null;
}

/** `Campaign.status` (schema `Campaign`): 0 Draft, 1 Active, 2 Paused, 3 Completed, 4 Running Subsequences, -99 Account Suspended, -1 Accounts Unhealthy, -2 Bounce Protect. */
export type CampaignStatusCode = -99 | -1 | -2 | 0 | 1 | 2 | 3 | 4;

/** One schedule of `campaign_schedule.schedules[]` (`createCampaign` body). All four fields are required. */
export interface InstantlySchedule {
  readonly name: string;
  readonly timing: { readonly from: string; readonly to: string };
  /** Keys "0" to "6"; at least one. */
  readonly days: Readonly<Record<string, boolean>>;
  /** One of the documented enum of zones. */
  readonly timezone: string;
}

/** One step of `sequences[0].steps[]` (`createCampaign` body): `type`, `delay` and `variants` are required. */
export interface InstantlyStep {
  readonly type: "email";
  readonly delay: number;
  readonly delay_unit?: "minutes" | "hours" | "days";
  readonly variants: readonly { readonly subject: string; readonly body: string }[];
}

/**
 * The settings ADR 0002 ("Openers: dispatch campaigns") puts on every dispatch campaign: the body of
 * `POST /api/v2/campaigns` (operationId `createCampaign`; only `name` and `campaign_schedule` are
 * required) and of `PATCH /api/v2/campaigns/{id}` (operationId `patchCampaign`).
 */
export interface DispatchCampaignSettings {
  readonly name: string;
  readonly campaign_schedule: { readonly schedules: readonly InstantlySchedule[] };
  readonly sequences: readonly { readonly steps: readonly InstantlyStep[] }[];
  readonly email_list: readonly string[];
  readonly daily_limit: number;
  readonly daily_max_leads: number;
  readonly stop_on_reply: boolean;
  readonly stop_on_auto_reply: boolean;
  readonly stop_for_company: boolean;
  readonly insert_unsubscribe_header: boolean;
  readonly open_tracking: boolean;
  readonly link_tracking: boolean;
  readonly prioritize_new_leads: boolean;
  readonly allow_risky_contacts: boolean;
  readonly disable_bounce_protect: boolean;
  readonly match_lead_esp: boolean;
  readonly provider_routing_rules: readonly never[];
  readonly limit_emails_per_company_override: { readonly mode: "disabled" };
}

/** Schema `Campaign`, as `createCampaign`, `getCampaign`, `patchCampaign`, `activateCampaign` and `listCampaign` return it. */
export interface InstantlyCampaign {
  readonly id: string;
  readonly name: string;
  readonly status: CampaignStatusCode;
  readonly timestamp_updated: string;
}

/** The body of `POST /api/v2/leads/add` (operationId `bulkAddLeads`). */
export interface AddLeadsRequest {
  readonly campaign_id: string;
  readonly leads: readonly { readonly email: string; readonly custom_variables: Readonly<Record<string, string>> }[];
  /** "A retry with the same key and the same leads … reports the leads it already created." The key is permanent. */
  readonly idempotency_key: string;
}

/** The 200 answer of `bulkAddLeads`: "A summary of the bulk import operation." */
export interface AddLeadsResponse {
  /** "Indicates the request was processed." It does not say a lead was created. */
  readonly status: string;
  readonly leads_uploaded: number;
  readonly in_blocklist: number;
  readonly duplicated_leads: number;
  readonly skipped_count: number;
  readonly invalid_email_count: number;
  /** "The remaining lead uploads in the current billing plan", present when `campaign_id` is given. */
  readonly remaining_in_plan?: number | null;
  readonly created_leads: readonly { readonly index: number; readonly id: string; readonly email?: string | null }[];
}

/** `Lead.status` (schema `Lead`): 1 Active, 2 Paused, 3 Completed, -1 Bounced, -2 Unsubscribed, -3 Skipped. */
export type LeadStatusCode = 1 | 2 | 3 | -1 | -2 | -3;
/** `Lead.verification_status`: 0 Not verified, 1 Verified, 11 Pending, 12 Pending job, -1 Invalid, -2 Risky, -3 Catch All, -4 Job Change. */
export type VerificationStatusCode = 0 | 1 | 11 | 12 | -1 | -2 | -3 | -4;

/** Schema `Lead`, as `POST /api/v2/leads/list` (operationId `listLeads`, a read that takes POST) returns it. */
export interface InstantlyLead {
  readonly id: string;
  readonly email: string;
  readonly campaign: string | null;
  readonly status: LeadStatusCode;
  readonly verification_status?: VerificationStatusCode | null;
}

/** The body of `listLeads`: `campaign`, `contacts` and `ids` filter; `limit` and `starting_after` page. */
export interface ListLeadsRequest {
  readonly campaign: string;
  readonly contacts?: readonly string[];
  readonly limit: number;
  readonly starting_after?: string;
}

/** `Email.ue_type` (schema `Email`): 1 Sent from campaign, 2 Received, 3 Sent, 4 Scheduled. */
export type EmailTypeCode = 1 | 2 | 3 | 4;

/** Schema `Email`, as `GET /api/v2/emails` (operationId `listEmail`) returns it. */
export interface InstantlyEmail {
  readonly id: string;
  /** "When the email was added to our database", not when it was sent. */
  readonly timestamp_created: string;
  /** "The timestamp of the email, as provided by the email server." */
  readonly timestamp_email?: string | null;
  readonly from_address_email: string | null;
  readonly to_address_email_list: string;
  readonly campaign_id: string | null;
  /** "The email address of the lead that the email is associated with." */
  readonly lead: string | null;
  readonly lead_id: string | null;
  /** "The email account that was used to send the email." */
  readonly eaccount: string;
  readonly ue_type: EmailTypeCode | null;
  readonly thread_id: string | null;
}

/** The query of `listEmail` the adapter sends. `eaccount` takes a comma-separated list. */
export interface ListEmailsQuery {
  readonly eaccount?: string;
  readonly lead?: string;
  readonly campaign_id?: string;
  readonly mode?: "emode_all";
  readonly email_type?: "received" | "sent" | "manual";
  readonly min_timestamp_created?: string;
  readonly sort_order?: "asc" | "desc";
  readonly preview_only?: boolean;
  readonly limit?: number;
  readonly starting_after?: string;
}

/** One entry of `GET /api/v2/accounts/analytics/daily` (operationId `getDailyAccountAnalytics`); the zone of `date` is undocumented. */
export interface DailyAccountAnalytics {
  /** YYYY-MM-DD. */
  readonly date: string;
  readonly email_account: string;
  /** "The total number of campaign emails sent on this date by this account, including emails for subsequences." */
  readonly sent: number;
}

/**
 * The error bodies every operation above documents for 401, 402, 404 and 429, for example `402`:
 * "This request cannot be fulfilled because the workspace does not have an active paid plan".
 */
export interface InstantlyError {
  readonly statusCode: number;
  readonly error: string;
  readonly message: string;
}

/**
 * Operations that read, though one of them takes POST: `listLeads` is "a POST endpoint, instead of
 * GET … because of the complex arguments it accepts". Every other non-GET request writes.
 */
export const READ_OPERATIONS: readonly { readonly method: string; readonly path: string }[] = [{ method: "POST", path: "/api/v2/leads/list" }];
