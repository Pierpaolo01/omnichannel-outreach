import type { Directory, ImportPlan } from "../../domain/import-plan.ts";
import type { OutreachStatus } from "../../domain/outreach-status.ts";
import type {
  Campaign,
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
  readonly limit: number;
}

/**
 * The CRM's persistence. Callers never see SQL or transactions; an import is one atomic call.
 * The SQLite adapter is the only implementation today. Hosting is deferred, so the interface
 * stays small enough for another adapter to satisfy later.
 */
export interface OutreachStore {
  createCampaign(campaign: Campaign): void;
  campaign(id: string): Campaign | null;
  listCampaigns(): CampaignListItem[];

  /**
   * Loads the directory for the campaign, lets `plan` decide the changes, and applies them with
   * the import record, all in one write transaction. Concurrent imports cannot interleave.
   */
  importIntoCampaign(input: {
    campaignId: string;
    importId: string;
    importedAt: string;
    plan: (directory: Directory) => ImportPlan;
  }): ImportRecord;
  listImports(campaignId: string): ImportRecord[];

  searchLeads(query: LeadQuery): LeadSearchResult;
  person(id: string): PersonRecord | null;
  company(id: string): CompanyRecord | null;

  /** Marks one contact detail bad (wrong number, hard bounce). Imports never clear the mark. */
  markContactDetailBad(detailId: string): boolean;

  close(): void;
}
