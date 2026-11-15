import type { SubjectState } from "../../domain/sequence/state.ts";
import type { Channel, PhoneKind } from "../../domain/contact-details.ts";
import type { DetailOwner, Directory, ImportPlan, NewEnrollment } from "../../domain/import-plan.ts";
import type { OutreachStatus } from "../../domain/outreach-status.ts";
import type { EngineStore } from "../engine/engine-store.ts";
import type { InstantlyStore } from "../instantly/store.ts";
import type {
  AttentionLead,
  Campaign,
  ImportFileNames,
  CampaignListItem, CampaignPauseRead,
  CompanyRecord,
  ImportRecord,
  LeadSearchResult,
  PersonRecord,
  BulkRowRef,
  BulkRowView,
  EnrollmentView,
} from "../../shared/api.ts";

/** A selected Leads row with its name and every enrollment, as the bulk preview resolves scope from (ticket 18). */
export interface LeadRowEnrollments extends BulkRowView {
  readonly enrollments: readonly EnrollmentView[];
}

export interface LeadQuery {
  /** Name, company, email, or three or more digits of a phone number. Empty matches everyone. */
  readonly text: string;
  readonly campaignId: string | null;
  readonly status: OutreachStatus | null;
  /** Only this company's people and its company lead. */
  readonly companyId: string | null;
  readonly limit: number;
}

/** A live contact detail, as the records that reference detail ids read it. */
export interface StoredContactDetail {
  readonly id: string;
  readonly owner: DetailOwner;
  readonly channel: Channel;
  readonly phoneKind: PhoneKind | null;
  /** As written in the export that added it. */
  readonly value: string;
  /** One key per address or number: an email as written, a phone in E.164 form when it can be read. */
  readonly key: string;
  readonly bad: boolean;
  /** A person's copy of an address their company lists as shared: kept, but no destination (ADR 0001). */
  readonly listedShared: boolean;
}

/**
 * The CRM's persistence. Callers never see SQL or transactions; an import is one atomic call.
 * Every method is asynchronous, so a hosted adapter (Postgres, D1, libSQL) can satisfy the same
 * interface later. The SQLite adapter is the only implementation today.
 */
export interface OutreachStore {
  /**
   * Whose lead each enrollment is, by names only, in one query (ticket 20b, council on 7622b8b): the person (null for a
   * company lead), the company and the campaign. An unknown id is left out.
   */
  leadNames(enrollmentIds: readonly string[]): Promise<ReadonlyMap<string, AttentionLead>>;
  createCampaign(campaign: Campaign): Promise<void>;
  campaign(id: string): Promise<Campaign | null>;
  /** The campaigns with their lead counts and last import; the HTTP interface adds each one's sequence summary. */
  listCampaigns(): Promise<Omit<CampaignListItem, "sequence" | keyof CampaignPauseRead>[]>;
  /** One campaign's lead count, by a query for that campaign alone (the campaign read). */
  leadCount(campaignId: string): Promise<number>;

  /**
   * Loads the directory for the campaign, lets `plan` decide the changes, and applies them with
   * the import record, all in one write transaction. Concurrent imports cannot interleave.
   * With `create`, the campaign is created in the same transaction, so a failed import leaves
   * no campaign behind.
   */
  importIntoCampaign(input: {
    campaign: { readonly create: Campaign } | { readonly id: string };
    importId: string;
    importedAt: string;
    fileNames: ImportFileNames;
    plan: (directory: Directory) => ImportPlan;
    /**
     * An import changes leads' zones, which the engine's timing reads: every lead with an open call task
     * is first brought up to `now` under the old zones, in the import's transaction (council on 228cd3b).
     */
    catchUp?: { readonly now: number; readonly asOf: (state: SubjectState) => SubjectState };
  }): Promise<ImportRecord>;
  listImports(campaignId: string): Promise<ImportRecord[]>;
  /**
   * False for a database that holds people from before migration 2 without the rows that were
   * applied to them. Importing into it could duplicate people, so it must be recreated (ADR 0001).
   */
  remembersAppliedRows(): Promise<boolean>;
  importRecord(campaignId: string, importId: string): Promise<ImportRecord | null>;

  searchLeads(query: LeadQuery): Promise<LeadSearchResult>;
  /** The selected rows that exist, with their names and enrollments; a row that does not exist is left out (ticket 18). */
  leadRows(refs: readonly BulkRowRef[]): Promise<LeadRowEnrollments[]>;
  /** A plan over the campaign's directory, read and never written (add to campaign's preview); null for no such campaign. */
  planInCampaign<T>(campaignId: string, plan: (directory: Directory) => T): Promise<T | null>;
  /** Binds a bulk id to its action and body: new, the same as before, or different (refused whole). */
  bindBulkRequest(bulkId: string, action: string, bodySha256: string, at: number): Promise<"new" | "same" | "different">;
  /**
   * Add to campaign (ticket 18): in one write transaction, the plan over the campaign's directory, its enrollments by the
   * import's path, and the answer stored with the bulk id; a retry with the same body replays the stored answer.
   */
  addToCampaign<D>(input: {
    campaignId: string;
    bulkId: string;
    bodySha256: string;
    at: number;
    plan: (directory: Directory) => { readonly decisions: D; readonly enrollments: readonly NewEnrollment[] };
    answer: (decisions: D) => string;
  }): Promise<{ kind: "answered"; answer: string; replayed: boolean } | { kind: "different" } | { kind: "missing" }>;
  person(id: string): Promise<PersonRecord | null>;
  company(id: string): Promise<CompanyRecord | null>;

  /**
   * The live detail an issued id stands for: the detail itself, or, when it was merged into
   * another, the detail at the end of that chain. Null only for an id that was never issued.
   */
  contactDetail(detailId: string): Promise<StoredContactDetail | null>;
  /**
   * Marks a contact detail bad (wrong number, hard bounce): the live detail the id stands for.
   * Imports never clear the mark. False for an id that was never issued.
   */
  markContactDetailBad(detailId: string): Promise<boolean>;

  /** The sequence engine's persistence, in the same database (ADR 0003). */
  readonly engine: EngineStore;
  /** The Instantly adapter's records (ADR 0002). */
  readonly instantly: InstantlyStore;

  close(): Promise<void>;
}
