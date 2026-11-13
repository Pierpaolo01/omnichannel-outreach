/**
 * The Instantly adapter's own records (ADR 0002): which dispatch campaign each (app campaign, email
 * track, opening step, sender inbox) uses, which Instantly lead each piece of provider work
 * created, and the sent email and thread each one produced. They let the adapter translate between
 * the engine's provider work and Instantly's records across a restart. No message body is stored.
 */

export interface DispatchCampaignRecord {
  /** `<subject kind>|<app campaign>|<track>|<step>|<inbox>`. */
  readonly key: string;
  /** Deterministic, prefixed `oo·` (`oo·test·` for test runs), so a retried create finds it. */
  readonly name: string;
  /** Null until Instantly has created it. */
  readonly instantlyId: string | null;
  /** The `timestamp_updated` the adapter last saw after asserting its settings. */
  readonly timestampUpdated: string | null;
}

export interface DispatchedLead {
  readonly workKey: string;
  /** The provider reference the engine holds for this work. */
  readonly ref: string;
  readonly leadId: string;
  readonly dispatchCampaign: string;
  readonly instantlyCampaignId: string;
  readonly inbox: string;
  /** Bare and lowercase. */
  readonly destination: string;
  readonly addedWall: number;
  readonly sentEmailId: string | null;
  readonly threadId: string | null;
  readonly sentWall: number | null;
  readonly leadStatus: number | null;
  readonly verificationStatus: number | null;
}

/** What the adapter needs to know about the subject a send is for. */
export interface SendContext {
  readonly kind: "enrollment" | "test_run";
  readonly campaignId: string;
}

export interface InstantlyStore {
  dispatchCampaign(key: string): DispatchCampaignRecord | null;
  saveDispatchCampaign(record: DispatchCampaignRecord): void;
  dispatchCampaigns(): DispatchCampaignRecord[];

  dispatched(workKey: string): DispatchedLead | null;
  dispatchedByRef(ref: string): DispatchedLead | null;
  dispatchedByLead(leadId: string): DispatchedLead | null;
  dispatchedByThread(threadId: string): DispatchedLead | null;
  /** Whether the adapter ever dispatched to `address` from `inbox`. */
  reachedFrom(inbox: string, address: string): boolean;
  anyDispatched(): boolean;
  /** Send times of observed dispatch sends from `inbox` since `since`. */
  sentWallsSince(inbox: string, since: number): number[];
  saveDispatched(lead: DispatchedLead): void;
  updateDispatched(workKey: string, change: Partial<Pick<DispatchedLead, "sentEmailId" | "threadId" | "sentWall" | "leadStatus" | "verificationStatus">>): void;

  sendContext(subjectId: string): SendContext | null;

  meta(key: string): string | null;
  setMeta(key: string, value: string): void;
}
