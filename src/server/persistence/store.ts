import type { Directory, ImportPlan } from "../../domain/import-plan.ts";
import type { OutreachStatus } from "../../domain/outreach-status.ts";
import type {
  Campaign,
  ImportFileNames,
  CampaignListItem,
  CompanyRecord,
  ImportRecord,
  LeadSearchResult,
  PersonRecord,
} from "../../shared/api.ts";

export interface LeadQuery {
  /** Name, company, email, or three or more digits of a phone number. Empty matches everyone. */
  readonly text: string;
  readonly campaignId: string | null;
  readonly status: OutreachStatus | null;
  /** Only this company's people and its company lead. */
  readonly companyId: string | null;
  readonly limit: number;
}

/**
 * The CRM's persistence. Callers never see SQL or transactions; an import is one atomic call.
 * Every method is asynchronous, so a hosted adapter (Postgres, D1, libSQL) can satisfy the same
 * interface later. The SQLite adapter is the only implementation today.
 */
export interface OutreachStore {
  createCampaign(campaign: Campaign): Promise<void>;
  campaign(id: string): Promise<Campaign | null>;
  listCampaigns(): Promise<CampaignListItem[]>;

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
  }): Promise<ImportRecord>;
  listImports(campaignId: string): Promise<ImportRecord[]>;
  /**
   * False for a database that holds people from before migration 2 without the rows that were
   * applied to them. Importing into it could duplicate people, so it must be recreated (ADR 0001).
   */
  remembersAppliedRows(): Promise<boolean>;
  importRecord(campaignId: string, importId: string): Promise<ImportRecord | null>;

  searchLeads(query: LeadQuery): Promise<LeadSearchResult>;
  person(id: string): Promise<PersonRecord | null>;
  company(id: string): Promise<CompanyRecord | null>;

  /** Marks one contact detail bad (wrong number, hard bounce). Imports never clear the mark. */
  markContactDetailBad(detailId: string): Promise<boolean>;

  close(): Promise<void>;
}
