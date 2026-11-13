import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import type { DispatchCampaignRecord, DispatchedLead, InstantlyStore, SendContext } from "../instantly/store.ts";

type Row = Record<string, SQLOutputValue>;

const str = (r: Row, k: string): string => String(r[k]);
const strOrNull = (r: Row, k: string): string | null => (r[k] === null || r[k] === undefined ? null : String(r[k]));
const numOrNull = (r: Row, k: string): number | null => (r[k] === null || r[k] === undefined ? null : Number(r[k]));

const COLUMNS: Readonly<Record<string, string>> = {
  sentEmailId: "sent_email_id",
  threadId: "thread_id",
  sentWall: "sent_wall",
  leadStatus: "lead_status",
  verificationStatus: "verification_status",
};

/** The Instantly adapter's records in the application's SQLite database (migration 7). */
export class SqliteInstantlyStore implements InstantlyStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private campaignOf(r: Row): DispatchCampaignRecord {
    return { key: str(r, "key"), name: str(r, "name"), instantlyId: strOrNull(r, "instantly_id"), timestampUpdated: strOrNull(r, "timestamp_updated") };
  }

  private leadOf(r: Row): DispatchedLead {
    return {
      workKey: str(r, "work_key"),
      ref: str(r, "ref"),
      leadId: str(r, "lead_id"),
      dispatchCampaign: str(r, "dispatch_campaign"),
      instantlyCampaignId: str(r, "instantly_campaign_id"),
      inbox: str(r, "inbox"),
      destination: str(r, "destination"),
      addedWall: Number(r["added_wall"]),
      sentEmailId: strOrNull(r, "sent_email_id"),
      threadId: strOrNull(r, "thread_id"),
      sentWall: numOrNull(r, "sent_wall"),
      leadStatus: numOrNull(r, "lead_status"),
      verificationStatus: numOrNull(r, "verification_status"),
    };
  }

  dispatchCampaign(key: string): DispatchCampaignRecord | null {
    const r = this.db.prepare("SELECT * FROM instantly_dispatch_campaigns WHERE key = ?").get(key);
    return r ? this.campaignOf(r) : null;
  }

  saveDispatchCampaign(record: DispatchCampaignRecord): void {
    this.db
      .prepare(
        `INSERT INTO instantly_dispatch_campaigns (key, name, instantly_id, timestamp_updated) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET instantly_id = excluded.instantly_id, timestamp_updated = excluded.timestamp_updated`,
      )
      .run(record.key, record.name, record.instantlyId, record.timestampUpdated);
  }

  dispatchCampaigns(): DispatchCampaignRecord[] {
    return this.db.prepare("SELECT * FROM instantly_dispatch_campaigns ORDER BY key").all().map((r) => this.campaignOf(r));
  }

  dispatched(workKey: string): DispatchedLead | null {
    const r = this.db.prepare("SELECT * FROM instantly_dispatched WHERE work_key = ?").get(workKey);
    return r ? this.leadOf(r) : null;
  }

  dispatchedByRef(ref: string): DispatchedLead | null {
    const r = this.db.prepare("SELECT * FROM instantly_dispatched WHERE ref = ?").get(ref);
    return r ? this.leadOf(r) : null;
  }

  dispatchedByLead(leadId: string): DispatchedLead | null {
    const r = this.db.prepare("SELECT * FROM instantly_dispatched WHERE lead_id = ? ORDER BY added_wall LIMIT 1").get(leadId);
    return r ? this.leadOf(r) : null;
  }

  dispatchedByThread(threadId: string): DispatchedLead | null {
    const r = this.db.prepare("SELECT * FROM instantly_dispatched WHERE thread_id = ? ORDER BY added_wall LIMIT 1").get(threadId);
    return r ? this.leadOf(r) : null;
  }

  reachedFrom(inbox: string, address: string): boolean {
    return this.db.prepare("SELECT 1 FROM instantly_dispatched WHERE inbox = ? AND destination = ? LIMIT 1").get(inbox, address.toLowerCase()) !== undefined;
  }

  anyDispatched(): boolean {
    return this.db.prepare("SELECT 1 FROM instantly_dispatched LIMIT 1").get() !== undefined;
  }

  sentWallsSince(inbox: string, since: number): number[] {
    return this.db.prepare("SELECT sent_wall FROM instantly_dispatched WHERE inbox = ? AND sent_wall >= ?").all(inbox, since).map((r) => Number(r["sent_wall"]));
  }

  saveDispatched(lead: DispatchedLead): void {
    this.db
      .prepare(
        `INSERT INTO instantly_dispatched (work_key, ref, lead_id, dispatch_campaign, instantly_campaign_id, inbox, destination, added_wall,
           sent_email_id, thread_id, sent_wall, lead_status, verification_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(work_key) DO NOTHING`,
      )
      .run(
        lead.workKey,
        lead.ref,
        lead.leadId,
        lead.dispatchCampaign,
        lead.instantlyCampaignId,
        lead.inbox,
        lead.destination.toLowerCase(),
        lead.addedWall,
        lead.sentEmailId,
        lead.threadId,
        lead.sentWall,
        lead.leadStatus,
        lead.verificationStatus,
      );
  }

  updateDispatched(workKey: string, change: Partial<Pick<DispatchedLead, "sentEmailId" | "threadId" | "sentWall" | "leadStatus" | "verificationStatus">>): void {
    const entries = Object.entries(change).filter(([k]) => k in COLUMNS);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${COLUMNS[k] ?? k} = ?`).join(", ");
    this.db.prepare(`UPDATE instantly_dispatched SET ${sets} WHERE work_key = ?`).run(...entries.map(([, v]) => v as SQLInputValue), workKey);
  }

  sendContext(subjectId: string): SendContext | null {
    const r = this.db.prepare("SELECT campaign_id FROM enrollments WHERE id = ?").get(subjectId);
    return r ? { kind: "enrollment", campaignId: str(r, "campaign_id") } : null;
  }

  meta(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM instantly_meta WHERE key = ?").get(key);
    return r ? str(r, "value") : null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO instantly_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}
