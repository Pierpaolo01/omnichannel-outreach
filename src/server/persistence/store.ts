import type { Channel, PhoneKind } from "../../domain/contact-details.ts";
import type { DetailOwner, Directory, ImportPlan } from "../../domain/import-plan.ts";
import type { OutreachStatus } from "../../domain/outreach-status.ts";
import type { EngineStore } from "../engine/engine-store.ts";
import type { InstantlyStore } from "../instantly/store.ts";
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
  createCampaign(campaign: Campaign): Promise<void>;
  campaign(id: string): Promise<Campaign | null>;
  /** The campaigns with their lead counts and last import; the HTTP interface adds each one's sequence summary. */
  listCampaigns(): Promise<Omit<CampaignListItem, "sequence">[]>;

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
