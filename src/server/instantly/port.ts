import type { CallAnswer } from "../../domain/sequence/attempt.ts";
import { resetDayOf } from "../../domain/sequence/clock.ts";
import type { AccountStatus, AttemptRef, HandoverRequest, LookupResult, ProviderEvent, SendPort, Transport } from "../engine/ports.ts";
import type {
  AddLeadsRequest,
  AddLeadsResponse,
  DailyAccountAnalytics,
  DispatchCampaignSettings,
  InstantlyAccount,
  InstantlyCampaign,
  InstantlyEmail,
  InstantlyLead,
  ListEmailsQuery,
  ListLeadsRequest,
  Page,
} from "./api.ts";
import { WritesDisabled, type InstantlyClient, type InstantlyResult } from "./client.ts";
import type { EmailProviderStatus, InboxHoldReasonApi } from "../../shared/api.ts";
import type { DispatchCampaignRecord, DispatchedLead, InstantlyStore, SendContext } from "./store.ts";

/**
 * The Instantly adapter behind the engine's email port (ADR 0002, ADR 0003 5.3).
 *
 * - **Sender inboxes** are read from `GET /accounts`. An inbox can send only while real writes are
 *   on, it is Active in Instantly, it has a daily limit, and its last successful poll is within the
 *   freshness bound (the stale-inbox hold). Its capacity is its daily limit less what other
 *   campaigns sent from it today (ADR 0002 "Other senders", applied while P1 is open).
 * - **Openers** go out through the dispatch manager: one dispatch campaign per (app campaign, email
 *   track, opening step, inbox), found by its deterministic `oo·` name, its settings re-asserted
 *   whenever its `timestamp_updated` changes, and the lead added under the attempt's idempotency key.
 *   Every add result is reconciled.
 * - **Follow-ups** (continue thread) sit behind `FollowUpTransport`, which stays absent until X2
 *   picks one; until then the port reports them unavailable and the engine claims none.
 * - **The poller** reads sent and received emails from one paged `GET /emails` over every inbox, and
 *   lead statuses from `POST /leads/list` per dispatch campaign, and reports them as provider events
 *   with stable ids.
 *
 * The engine holds one provider reference per piece of work: `il:<Instantly lead id>` for an opener.
 * The adapter keeps the mapping to the sent email and its thread, and translates a reply's thread
 * back to the reference. A received email in a thread the adapter does not know is reported as
 * `it:<thread id>` only when it comes from an address the adapter wrote to from that inbox; other
 * mail is not the app's to report.
 */

/** A continue-thread transport, chosen by ADR 0002's X2 among reply, reply with recipients, and forward. */
export interface FollowUpTransport {
  readonly transport: Transport;
  send(request: HandoverRequest, replyTo: DispatchedLead): Promise<CallAnswer>;
}

export interface InstantlyPortConfig {
  /** The zone Instantly's daily limits reset in: UTC unless ADR 0002's S5 reports another. */
  readonly resetZone: string;
  /** How old the last successful poll may be before every inbox is held as stale. */
  readonly freshnessMs?: number;
  /** The least time between two polls; a call to `observe` sooner reports nothing new. */
  readonly pollIntervalMs?: number;
  /** How long a read of `/accounts` serves `accounts()` between polls. */
  readonly analyticsCacheMs?: number;
  /** In-flight bound per inbox (ADR 0002's k): 1 until X1 shows 2 is needed. */
  readonly k?: number;
  /** After a 402 or an exhausted lead quota, how long every dispatch handover is held before one probes again. */
  readonly quotaRecheckMs?: number;
  /** How far back each poll re-reads, so a late record is not missed. */
  readonly overlapMs?: number;
  /** How long a reply whose work cannot be proved yet is held before it is reported with no reference (ADR 0003 `SETTLING`). */
  readonly replyHoldMs?: number;
}

export interface InstantlyPortDependencies {
  readonly client: InstantlyClient;
  readonly store: InstantlyStore;
  readonly now: () => number;
  readonly config: InstantlyPortConfig;
  /** Which campaign a subject belongs to; by default the store's enrollments. */
  readonly subjectCampaign?: (subjectId: string) => Promise<SendContext | null>;
  /** Absent until X2 passes. */
  readonly followUps?: FollowUpTransport | null;
}

export type InboxHoldReason = InboxHoldReasonApi;

/** What the provider status endpoint shows, but the leads waiting on a follow-up, which the route adds. */
export type InstantlyStatus = Omit<EmailProviderStatus, "provider" | "waitingFollowUps"> & { readonly provider: "instantly" };

const MINUTE = 60_000;
const DEFAULTS = { freshnessMs: 10 * MINUTE, pollIntervalMs: MINUTE, analyticsCacheMs: 5 * MINUTE, k: 1, quotaRecheckMs: 60 * MINUTE, overlapMs: 10 * MINUTE, replyHoldMs: 15 * MINUTE };
const PAGE = 100;
const MAX_PAGES = 20;

const META = {
  /** When the last poll ran, complete or not: polls are spaced by it. */
  lastPollRun: "last_poll_run_wall",
  /** When the last mail scan that reached its end began. */
  lastMailScan: "last_complete_mail_scan_wall",
  mailScan: "mail_scan",
  quotaHeld: "quota_held_wall",
  /** The last batch reported, kept until the engine passes back its checkpoint. */
  batch: "unacknowledged_batch",
  batchSeq: "batch_seq",
  heldReplies: "held_replies",
  statusCursor: (campaignKey: string) => `status_cursor|${campaignKey}`,
  statusScanStarted: (campaignKey: string) => `status_scan_started|${campaignKey}`,
  /** When the last status scan of the campaign that reached its end began. */
  statusScanComplete: (campaignKey: string) => `status_scan_complete|${campaignKey}`,
  analytics: (day: string, inbox: string) => `analytics_sent_max|${day}|${inbox}`,
} as const;

const OPENER: Transport = { retryable: true, notSentIsFinal: false, available: true };
const NO_FOLLOW_UP: Transport = { retryable: false, notSentIsFinal: false, available: false };

const iso = (t: number) => new Date(t).toISOString();
const bare = (address: string | null): string => (/<([^>]+)>/.exec(address ?? "")?.[1] ?? address ?? "").trim().toLowerCase();
const emailTime = (e: InstantlyEmail): number => Date.parse(e.timestamp_email ?? e.timestamp_created);

/** The app's copy is plain text; the dispatch step's body is HTML ("Use `<br/>` tags for delivered email line breaks", `createCampaign`). */
export function htmlBody(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\r?\n/g, "<br/>");
}

/** One batch reported to the engine: its events, and the lead statuses recorded once it is applied. */
interface Batch {
  readonly token: string;
  readonly events: readonly ProviderEvent[];
  readonly changes: Readonly<Record<string, readonly [number, number | null]>>;
}

/** A mail scan in progress: its fixed lower bound, the page cursor to resume from, and when it began. */
interface MailScan {
  readonly since: string;
  readonly after: string | null;
  readonly startedWall: number;
  readonly newest: string | null;
}

/** A received email from an address the app wrote to from that inbox, whose work is not proved yet. */
interface HeldReply {
  readonly emailId: string;
  readonly threadId: string | null;
  readonly inbox: string;
  readonly from: string;
  readonly at: number;
  readonly heldWall: number;
  readonly released: boolean;
}

export class InstantlyEmailPort implements SendPort {
  readonly channel = "email";
  private readonly client: InstantlyClient;
  private readonly store: InstantlyStore;
  private readonly now: () => number;
  private readonly config: Required<InstantlyPortConfig>;
  private readonly subjectCampaign: (subjectId: string) => Promise<SendContext | null>;
  private readonly followUps: FollowUpTransport | null;
  private inboxes: InstantlyAccount[] | null = null;
  private analyticsReadWall: number | null = null;

  constructor(deps: InstantlyPortDependencies) {
    this.client = deps.client;
    this.store = deps.store;
    this.now = deps.now;
    this.config = { ...DEFAULTS, ...deps.config };
    this.subjectCampaign = deps.subjectCampaign ?? ((id) => Promise.resolve(deps.store.sendContext(id)));
    this.followUps = deps.followUps ?? null;
  }

  transportFor(step: { readonly threading: "new_subject" | "continue_thread" }): Transport {
    if (step.threading === "new_subject") return OPENER;
    return this.followUps?.transport ?? NO_FOLLOW_UP;
  }

  // -------------------------------------------------------------------------------------------
  // Sender inboxes.

  private async readInboxes(): Promise<InstantlyAccount[]> {
    const read = await this.readPages<InstantlyAccount>((after) => this.client.get("/api/v2/accounts", { limit: PAGE, starting_after: after }));
    if (!read) throw new Error("Instantly accounts could not be read");
    // An inbox list that did not reach its end is not the inbox list.
    if (!read.complete) throw new Error("Instantly accounts could not be read to the end");
    this.inboxes = [...read.items].sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
    return this.inboxes;
  }

  private async readAnalytics(): Promise<void> {
    const now = this.now();
    if (this.analyticsReadWall !== null && now - this.analyticsReadWall < this.config.analyticsCacheMs) return;
    const day = resetDayOf(now, this.config.resetZone);
    const emails = (this.inboxes ?? []).map((a) => a.email).join(",");
    if (emails === "") return;
    const result = await this.client.get<DailyAccountAnalytics[]>("/api/v2/accounts/analytics/daily", { start_date: day, end_date: day, emails });
    if (!result.ok) return;
    this.analyticsReadWall = now;
    for (const entry of result.body) {
      if (entry.date !== day) continue;
      // A running maximum through the day, so analytics lag never lowers it (ADR 0002).
      const key = META.analytics(day, entry.email_account);
      const previous = Number(this.store.meta(key) ?? 0);
      if (entry.sent > previous) this.store.setMeta(key, String(entry.sent));
    }
  }

  /** Dispatch sends observed from the inbox on its reset day: the app's own share of analytics' count. */
  private appSentToday(inbox: string, day: string): number {
    return this.store.sentWallsSince(inbox, this.now() - 2 * 24 * 60 * MINUTE).filter((t) => resetDayOf(t, this.config.resetZone) === day).length;
  }

  private quotaHeld(): boolean {
    const held = this.store.meta(META.quotaHeld);
    return held !== null && this.now() - Number(held) < this.config.quotaRecheckMs;
  }

  private holdQuota(): void {
    this.store.setMeta(META.quotaHeld, String(this.now()));
  }

  private inboxView(a: InstantlyAccount): InstantlyStatus["inboxes"][number] {
    const now = this.now();
    const day = resetDayOf(now, this.config.resetZone);
    const fresh = this.fresh(a.email, now);
    const limit = a.daily_limit ?? 0;
    const other = Math.max(0, Number(this.store.meta(META.analytics(day, a.email)) ?? 0) - this.appSentToday(a.email, day));
    const reason: InboxHoldReason | null = !this.client.writes ? "sending_off" : a.status !== 1 ? "not_active" : limit <= 0 ? "no_daily_limit" : !fresh ? "stale" : null;
    return { id: a.email, status: a.status, dailyLimit: a.daily_limit, capacity: Math.max(0, limit - other), healthy: reason === null, reason };
  }

  /**
   * The stale-inbox hold: the inbox's mail and the statuses of every dispatch campaign on it were
   * each read to the end by a scan that began within the freshness bound.
   */
  private fresh(inbox: string, now: number): boolean {
    const within = (raw: string | null) => raw !== null && raw !== "" && now - Number(raw) <= this.config.freshnessMs;
    if (!within(this.store.meta(META.lastMailScan))) return false;
    return this.store
      .dispatchCampaigns()
      .filter((c) => c.instantlyId !== null && c.key.endsWith(`|${inbox}`))
      .every((c) => within(this.store.meta(META.statusScanComplete(c.key))));
  }

  async accounts(): Promise<AccountStatus[]> {
    const inboxes = this.inboxes ?? (await this.readInboxes());
    const quotaAvailable = !this.quotaHeld();
    return inboxes.map((a) => {
      const view = this.inboxView(a);
      return { id: a.email, channel: "email" as const, label: a.email, capacity: view.capacity, gapMs: null, k: this.config.k, healthy: view.healthy, resetZone: this.config.resetZone, quotaAvailable };
    });
  }

  status(): InstantlyStatus {
    const lastPoll = this.store.meta(META.lastMailScan);
    return {
      provider: "instantly",
      sending: this.client.writes ? "on" : "off",
      followUps: this.followUps ? "available" : "unavailable",
      quota: this.quotaHeld() ? "exhausted" : "available",
      lastPolledAt: lastPoll === null ? null : iso(Number(lastPoll)),
      inboxes: (this.inboxes ?? []).map((a) => this.inboxView(a)),
    };
  }

  // -------------------------------------------------------------------------------------------
  // The dispatch manager.

  private settings(name: string, inbox: InstantlyAccount): DispatchCampaignSettings {
    const limit = inbox.daily_limit ?? 0;
    return {
      name,
      // Open every day; the app applies the prospect's window. Africa/Abidjan is UTC with no
      // daylight saving and is in the documented zone enum.
      campaign_schedule: { schedules: [{ name: "oo always open", timing: { from: "00:00", to: "23:59" }, days: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true }, timezone: "Africa/Abidjan" }] },
      sequences: [{ steps: [{ type: "email", delay: 0, delay_unit: "minutes", variants: [{ subject: "{{oo_subject}}", body: "{{oo_body}}" }] }] }],
      email_list: [inbox.email],
      daily_limit: limit,
      daily_max_leads: limit,
      stop_on_reply: true,
      stop_on_auto_reply: true,
      stop_for_company: false,
      insert_unsubscribe_header: true,
      open_tracking: false,
      link_tracking: false,
      prioritize_new_leads: false,
      allow_risky_contacts: false,
      disable_bounce_protect: false,
      match_lead_esp: false,
      provider_routing_rules: [],
      limit_emails_per_company_override: { mode: "disabled" },
    };
  }

  /** The dispatch campaign for this send, created, re-asserted and active; null when Instantly could not be brought there. */
  private async dispatchCampaign(context: SendContext, request: HandoverRequest, inbox: InstantlyAccount): Promise<DispatchCampaignRecord | null> {
    const key = [context.kind, context.campaignId, request.trackId, request.stepId, request.sender].join("|");
    const name = `${context.kind === "test_run" ? "oo·test·" : "oo·"}${[context.campaignId, request.trackId, request.stepId, request.sender].join("·")}`;
    let record = this.store.dispatchCampaign(key);
    if (!record) {
      // The intent is recorded before the create, which has no idempotency key: a retry searches by name.
      record = { key, name, instantlyId: null, timestampUpdated: null };
      this.store.saveDispatchCampaign(record);
    }
    const wanted = this.settings(name, inbox);
    let campaign: InstantlyCampaign | null = null;
    if (record.instantlyId === null) {
      // Every page of the search: a create only once the whole result shows no campaign by that name.
      const found = await this.readPages<InstantlyCampaign>((after) => this.client.get("/api/v2/campaigns", { search: name, limit: PAGE, starting_after: after }));
      if (!found?.complete) return null;
      campaign = found.items.find((c) => c.name === name) ?? null;
      if (!campaign) {
        const created = await this.client.post<InstantlyCampaign>("/api/v2/campaigns", wanted);
        if (!created.ok) return null;
        campaign = created.body;
        record = { ...record, instantlyId: campaign.id, timestampUpdated: campaign.timestamp_updated };
        // A new campaign holds no lead yet: its statuses are fully known.
        this.store.setMeta(META.statusScanComplete(key), String(this.now()));
      } else {
        record = { ...record, instantlyId: campaign.id };
      }
      this.store.saveDispatchCampaign(record);
    }
    const id = record.instantlyId;
    if (id === null) return null;
    if (!campaign || campaign.timestamp_updated !== record.timestampUpdated) {
      const current = await this.client.get<InstantlyCampaign>(`/api/v2/campaigns/${encodeURIComponent(id)}`, {});
      if (!current.ok) return null;
      campaign = current.body;
    }
    if (campaign.timestamp_updated !== record.timestampUpdated) {
      // Edited outside the app, or found by name: the app's settings win (ADR 0002).
      const patched = await this.client.patch<InstantlyCampaign>(`/api/v2/campaigns/${encodeURIComponent(id)}`, wanted);
      if (!patched.ok) return null;
      campaign = patched.body;
      record = { ...record, timestampUpdated: campaign.timestamp_updated };
      this.store.saveDispatchCampaign(record);
    }
    if (campaign.status !== 1) {
      const activated = await this.client.post<InstantlyCampaign>(`/api/v2/campaigns/${encodeURIComponent(id)}/activate`, {});
      if (!activated.ok) return null;
      record = { ...record, timestampUpdated: activated.body.timestamp_updated };
      this.store.saveDispatchCampaign(record);
    }
    return record;
  }

  async handover(request: HandoverRequest): Promise<CallAnswer> {
    if (request.threading === "continue_thread") {
      if (!this.followUps) throw new Error("Instantly has no follow-up transport until experiment X2: nothing was sent.");
      const replyTo = request.threadRef === null ? null : this.store.dispatchedByRef(request.threadRef);
      if (!replyTo) throw new Error("the thread to continue is not known to the Instantly adapter: nothing was sent.");
      return this.followUps.send(request, replyTo);
    }
    if (!this.client.writes) throw new WritesDisabled("POST", "/api/v2/leads/add");
    // The lead quota is held workspace-wide: refused as Instantly's 402 would be, before any request,
    // so the engine's quota wait starts (ADR 0002 "Quota exhausted").
    if (this.quotaHeld()) return { kind: "rejected", reason: "payment_required" };
    const context = await this.subjectCampaign(request.subjectId);
    if (!context) throw new Error(`no campaign for subject ${request.subjectId}: nothing was sent.`);
    const inbox = (this.inboxes ?? (await this.readInboxes())).find((a) => a.email === request.sender);
    if (!inbox) throw new Error(`inbox ${request.sender} is not in Instantly: nothing was sent.`);
    const campaign = await this.dispatchCampaign(context, request, inbox);
    // Nothing was added, but the engine has no answer for "not sent, try later" on a keyed call:
    // unknown leads to a same-key retry, which is safe.
    if (!campaign?.instantlyId) return { kind: "unknown" };
    const destination = request.destination.toLowerCase();
    const body: AddLeadsRequest = {
      campaign_id: campaign.instantlyId,
      idempotency_key: request.idempotencyKey,
      leads: [{ email: destination, custom_variables: { oo_subject: request.rendered.subject, oo_body: htmlBody(request.rendered.body) } }],
    };
    const result = await this.client.post<AddLeadsResponse>("/api/v2/leads/add", body);
    return this.reconcile(result, request, campaign, destination);
  }

  /** ADR 0002: every add result is reconciled; `status: "success"` can mean nothing was created. */
  private reconcile(result: InstantlyResult<AddLeadsResponse>, request: HandoverRequest, campaign: DispatchCampaignRecord, destination: string): CallAnswer {
    if (!result.ok) {
      if (result.status === 402) {
        this.holdQuota();
        return { kind: "rejected", reason: "payment_required" };
      }
      if (result.status === 429) return { kind: "rejected", reason: "rate_limited" };
      // 401, 404, a 5xx, a timeout or a lost response: the add may or may not have happened.
      return { kind: "unknown" };
    }
    const r = result.body;
    if (r.remaining_in_plan === 0) this.holdQuota();
    const created = r.created_leads.find((l) => (l.email ?? "").toLowerCase() === destination) ?? (r.created_leads.length === 1 ? r.created_leads[0] : undefined);
    if (created && campaign.instantlyId) {
      const ref = `il:${created.id}`;
      this.store.saveDispatched({
        workKey: request.idempotencyKey,
        ref,
        leadId: created.id,
        dispatchCampaign: campaign.key,
        instantlyCampaignId: campaign.instantlyId,
        inbox: request.sender,
        destination,
        addedWall: this.now(),
        sentEmailId: null,
        threadId: null,
        sentWall: null,
        leadStatus: null,
        verificationStatus: null,
      });
      return { kind: "accepted", providerRef: this.store.dispatched(request.idempotencyKey)?.ref ?? ref };
    }
    if (r.in_blocklist > 0) return { kind: "rejected", reason: "blocklisted" };
    if (r.invalid_email_count > 0) return { kind: "rejected", reason: "invalid_destination" };
    // `duplicated_leads`: the lead is already in this dispatch campaign under other work. It is
    // never assumed sent, and never taken as this work's lead; lookups settle it or the user does.
    return { kind: "unknown" };
  }

  // -------------------------------------------------------------------------------------------
  // The poller.
  //
  // Two rules, after the review bot's findings on `7de601e`:
  //
  // - **Signal identity.** An event names a piece of work only when the message's own identity
  //   proves it: its thread or its Instantly lead, with the sender being the work's destination and
  //   the receiving inbox being the work's inbox. Only a campaign email (`ue_type` 1) is a dispatch
  //   send. The reference on an event is always one the engine already holds for that work, or none:
  //   a reply whose work cannot be proved yet is held here, pausing sends from that inbox to that
  //   address through the pre-send check, until its thread becomes known or the settling period
  //   passes, and is then reported with its work's reference or with none.
  // - **Completeness.** Every scan resumes where it stopped (a persisted page cursor), and an inbox
  //   counts as fresh only when the mail scan and the status scan of each of its dispatch campaigns
  //   both reached their end within the freshness bound, counted from when that scan began. Every
  //   batch is reported under a checkpoint of its own, and reported again, with its status changes
  //   unapplied, until the engine passes that checkpoint back, which it does only after it applied
  //   the batch and stored the checkpoint.

  async observe(checkpoint: string | null): Promise<{ events: readonly ProviderEvent[]; checkpoint: string }> {
    const now = this.now();
    const lastRun = this.store.meta(META.lastPollRun);
    if (checkpoint !== null && lastRun !== null && now - Number(lastRun) < this.config.pollIntervalMs) return { events: [], checkpoint };
    this.store.setMeta(META.lastPollRun, String(now));
    const replay = this.acknowledge(checkpoint);
    const inboxes = await this.readInboxes();
    await this.readAnalytics();
    const events = new Map<string, ProviderEvent>(replay.events.map((e) => [e.id, e]));
    const changes: Record<string, readonly [number, number | null]> = { ...replay.changes };
    if (this.store.anyDispatched()) {
      await this.pollEmails(inboxes, events);
      await this.pollLeadStatuses(events, changes);
      this.releaseHeldReplies(events);
    } else {
      this.store.setMeta(META.lastMailScan, String(now));
    }
    const seq = Number(this.store.meta(META.batchSeq) ?? 0) + 1;
    this.store.setMeta(META.batchSeq, String(seq));
    const token = `oo-batch-${String(seq)}-${iso(now)}`;
    const batch: Batch = { token, events: [...events.values()], changes };
    this.store.setMeta(META.batch, JSON.stringify(batch));
    return { events: batch.events, checkpoint: token };
  }

  /**
   * The previous batch: applied when the engine passes back its checkpoint (its status changes are
   * then recorded as known), otherwise returned to be reported again.
   */
  private acknowledge(checkpoint: string | null): { events: readonly ProviderEvent[]; changes: Readonly<Record<string, readonly [number, number | null]>> } {
    const raw = this.store.meta(META.batch);
    if (raw === null) return { events: [], changes: {} };
    const batch = JSON.parse(raw) as Batch;
    if (checkpoint !== batch.token) return { events: batch.events, changes: batch.changes };
    for (const [workKey, [status, verification]] of Object.entries(batch.changes)) this.store.updateDispatched(workKey, { leadStatus: status, verificationStatus: verification });
    return { events: [], changes: {} };
  }

  /** Reads pages from `start` until the end or `maxPages`; null when a page could not be read. */
  private async readPages<T>(read: (after: string | undefined) => Promise<InstantlyResult<Page<T>>>, start?: string): Promise<{ items: T[]; complete: boolean; next: string | undefined } | null> {
    const items: T[] = [];
    let after = start;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await read(after);
      if (!page.ok) return null;
      items.push(...page.body.items);
      after = page.body.next_starting_after ?? undefined;
      if (!after) return { items, complete: true, next: undefined };
    }
    return { items, complete: false, next: after };
  }

  /** One mail scan, resumed where the previous poll stopped; fresh only once it reaches the end. */
  private async pollEmails(inboxes: readonly InstantlyAccount[], events: Map<string, ProviderEvent>): Promise<void> {
    const now = this.now();
    const saved = this.store.meta(META.mailScan);
    const previous = saved ? (JSON.parse(saved) as MailScan) : null;
    // A scan that has not read its first page yet begins now: freshness counts from here.
    const scan: MailScan = previous?.after ? previous : { since: previous?.since ?? iso(now - this.config.overlapMs), after: null, startedWall: now, newest: null };
    const query: ListEmailsQuery = { eaccount: inboxes.map((a) => a.email).join(","), mode: "emode_all", min_timestamp_created: scan.since, sort_order: "asc", preview_only: false, limit: PAGE };
    const read = await this.readPages<InstantlyEmail>((after) => this.client.get("/api/v2/emails", { ...query, starting_after: after }), scan.after ?? undefined);
    if (!read) throw new Error("Instantly emails could not be read");
    let newest = scan.newest;
    for (const email of read.items) {
      const event = this.classify(email);
      if (event) events.set(event.id, event);
      if (newest === null || email.timestamp_created > newest) newest = email.timestamp_created;
    }
    if (read.complete) {
      // The next scan starts from the newest record seen, less the overlap.
      const from = newest === null ? now : Math.max(Date.parse(newest), Date.parse(scan.since) + this.config.overlapMs);
      this.store.setMeta(META.mailScan, JSON.stringify({ since: iso(from - this.config.overlapMs), after: null, startedWall: now, newest: null } satisfies MailScan));
      this.store.setMeta(META.lastMailScan, String(scan.startedWall));
    } else {
      this.store.setMeta(META.mailScan, JSON.stringify({ ...scan, after: read.next ?? null, newest } satisfies MailScan));
    }
  }

  /** The work a received email proves it answers: by its thread, else by its Instantly lead, with the sender and inbox matching. */
  private ownerOf(email: InstantlyEmail, from: string): DispatchedLead | null {
    const matches = (d: DispatchedLead | null) => d !== null && d.inbox === email.eaccount && d.destination === from;
    const byThread = email.thread_id ? this.store.dispatchedByThread(email.thread_id) : null;
    if (byThread && matches(byThread)) return byThread;
    const byLead = email.lead_id ? this.store.dispatchedByLead(email.lead_id) : null;
    if (byLead && matches(byLead) && byLead.instantlyCampaignId === email.campaign_id) return byLead;
    return null;
  }

  private classify(email: InstantlyEmail): ProviderEvent | null {
    if (email.ue_type === 1 && email.lead_id) {
      const d = this.store.dispatchedByLead(email.lead_id);
      if (!d || d.instantlyCampaignId !== email.campaign_id || d.inbox !== email.eaccount) return null;
      if (d.sentEmailId === null) this.store.updateDispatched(d.workKey, { sentEmailId: email.id, threadId: email.thread_id, sentWall: emailTime(email) });
      if (d.sentEmailId !== null && d.sentEmailId !== email.id) return null;
      return { id: `sent:${email.id}`, kind: "sent", key: d.workKey, providerRef: d.ref, sentAt: emailTime(email) };
    }
    if (email.ue_type !== 2) return null;
    const from = bare(email.from_address_email);
    const owner = this.ownerOf(email, from);
    const held = this.heldReplies();
    if (owner) {
      if (held.some((h) => h.emailId === email.id && !h.released)) this.saveHeld(held.map((h) => (h.emailId === email.id ? { ...h, released: true } : h)));
      return { id: `reply:${email.id}`, kind: "reply", providerRef: owner.ref, at: emailTime(email), inbox: email.eaccount, from };
    }
    // Not provably the app's: held only when it comes from an address the app wrote to from that inbox.
    if (this.store.reachedFrom(email.eaccount, from) && !held.some((h) => h.emailId === email.id)) {
      this.saveHeld([...held, { emailId: email.id, threadId: email.thread_id, inbox: email.eaccount, from, at: emailTime(email), heldWall: this.now(), released: false }]);
    }
    return null;
  }

  private heldReplies(): HeldReply[] {
    const raw = this.store.meta(META.heldReplies);
    return raw === null ? [] : (JSON.parse(raw) as HeldReply[]);
  }

  private saveHeld(held: readonly HeldReply[]): void {
    const keep = held.filter((h) => !h.released || this.now() - h.heldWall < 24 * 60 * MINUTE);
    this.store.setMeta(META.heldReplies, JSON.stringify(keep));
  }

  /** A held reply is reported once its thread names its work, or after the settling period with no reference (ADR 0003 2.4's fallback). */
  private releaseHeldReplies(events: Map<string, ProviderEvent>): void {
    const now = this.now();
    const held = this.heldReplies();
    const next: HeldReply[] = [];
    let changed = false;
    for (const h of held) {
      const byThread = !h.released && h.threadId ? this.store.dispatchedByThread(h.threadId) : null;
      const owner = byThread && byThread.inbox === h.inbox && byThread.destination === h.from ? byThread : null;
      if (h.released || (!owner && now - h.heldWall < this.config.replyHoldMs)) {
        next.push(h);
        continue;
      }
      events.set(`reply:${h.emailId}`, { id: `reply:${h.emailId}`, kind: "reply", providerRef: owner ? owner.ref : null, at: h.at, inbox: h.inbox, from: h.from });
      next.push({ ...h, released: true });
      changed = true;
    }
    if (changed) this.saveHeld(next);
  }

  /** Each dispatch campaign's status scan, resumed where the previous poll stopped. */
  private async pollLeadStatuses(events: Map<string, ProviderEvent>, changes: Record<string, readonly [number, number | null]>): Promise<void> {
    for (const campaign of this.store.dispatchCampaigns()) {
      const campaignId = campaign.instantlyId;
      if (campaignId === null) continue;
      const cursor = this.store.meta(META.statusCursor(campaign.key)) || undefined;
      if (!cursor) this.store.setMeta(META.statusScanStarted(campaign.key), String(this.now()));
      const read = await this.readPages<InstantlyLead>((after) => this.client.post("/api/v2/leads/list", { campaign: campaignId, limit: PAGE, ...(after ? { starting_after: after } : {}) } satisfies ListLeadsRequest), cursor);
      // A page that could not be read leaves the scan where it was: this campaign is not current.
      if (!read) continue;
      for (const lead of read.items) {
        const d = this.store.dispatchedByLead(lead.id);
        if (!d || d.instantlyCampaignId !== campaignId || d.leadStatus === lead.status) continue;
        const event = this.statusEvent(d, lead);
        if (event) events.set(event.id, event);
        changes[d.workKey] = [lead.status, lead.verification_status ?? null];
      }
      if (read.complete) {
        this.store.setMeta(META.statusCursor(campaign.key), "");
        this.store.setMeta(META.statusScanComplete(campaign.key), this.store.meta(META.statusScanStarted(campaign.key)) ?? String(this.now()));
      } else {
        this.store.setMeta(META.statusCursor(campaign.key), read.next ?? "");
      }
    }
  }

  private statusEvent(d: DispatchedLead, lead: InstantlyLead): ProviderEvent | null {
    const at = this.now();
    if (lead.status === -1) return { id: `bounced:${lead.id}`, kind: "bounced", key: d.workKey, providerRef: d.ref, at };
    // An unsubscribe stops the lead in that campaign, like a reply (ADR 0002).
    if (lead.status === -2) return { id: `unsubscribed:${lead.id}`, kind: "reply", providerRef: d.ref, at, inbox: d.inbox, from: d.destination };
    if (lead.status === -3) {
      // An invalid address is explained; Risky and Catch All have no reason the engine can apply yet,
      // so they wait in Needs attention as provider skips, like an unexplained one (ADR 0002 amendment).
      return { id: `skipped:${lead.id}`, kind: "rejected", key: d.workKey, providerRef: d.ref, reason: lead.verification_status === -1 ? "invalid_destination" : "provider_skipped" };
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // Lookup, withdrawal and the pre-send check.

  /** The campaign email Instantly sent for this work, recorded once seen. Null when none is visible; undefined when Instantly could not be read. */
  private async sentEmail(d: DispatchedLead): Promise<InstantlyEmail | null | undefined> {
    const read = await this.readPages<InstantlyEmail>((after) =>
      this.client.get("/api/v2/emails", { lead: d.destination, eaccount: d.inbox, campaign_id: d.instantlyCampaignId, mode: "emode_all", sort_order: "asc", limit: PAGE, starting_after: after }),
    );
    if (!read) return undefined;
    // Only the campaign's own email is the dispatch send.
    const email = read.items.find((e) => e.ue_type === 1 && e.lead_id === d.leadId && e.eaccount === d.inbox) ?? null;
    if (!email && !read.complete) return undefined;
    if (email && d.sentEmailId === null) this.store.updateDispatched(d.workKey, { sentEmailId: email.id, threadId: email.thread_id, sentWall: emailTime(email) });
    return email;
  }

  async lookup(attempt: AttemptRef): Promise<LookupResult> {
    const d = this.store.dispatched(attempt.idempotencyKey);
    // No lead was recorded for this key: not sent as far as Instantly told the app. Not final, so
    // the engine's same-key retry may ask again, and Instantly reports any lead the key created.
    if (!d) return { kind: "not-sent" };
    if (d.sentEmailId !== null && d.sentWall !== null) return { kind: "sent", sentAt: d.sentWall, providerRef: d.ref };
    const email = await this.sentEmail(d);
    if (email === undefined) return { kind: "unknown" };
    if (email) return { kind: "sent", sentAt: emailTime(email), providerRef: d.ref };
    const leads = await this.readPages<InstantlyLead>((after) => this.client.post("/api/v2/leads/list", { campaign: d.instantlyCampaignId, contacts: [d.destination], limit: PAGE, ...(after ? { starting_after: after } : {}) } satisfies ListLeadsRequest));
    if (!leads) return { kind: "unknown" };
    const lead = leads.items.find((l) => l.id === d.leadId);
    if (!lead) return leads.complete ? { kind: "not-sent" } : { kind: "unknown" };
    if (lead.status === 1 || lead.status === 2) return { kind: "queued" };
    if (lead.status === -3) return { kind: "not-sent" };
    return { kind: "unknown" };
  }

  async withdraw(attempt: AttemptRef): Promise<"withdrawn" | "too-late" | "unknown"> {
    const d = this.store.dispatched(attempt.idempotencyKey);
    if (!d) return "unknown";
    if (d.sentEmailId !== null) return "too-late";
    const email = await this.sentEmail(d);
    if (email) return "too-late";
    // Deleting the lead is the only request Instantly documents that could stop its send. No signal
    // proves it worked (ADR 0002 X5), so the answer stays unknown and the attempt settles by lookup.
    try {
      await this.client.delete<InstantlyLead>(`/api/v2/leads/${encodeURIComponent(d.leadId)}`);
    } catch (error) {
      if (!(error instanceof WritesDisabled)) throw error;
    }
    return "unknown";
  }

  async presendCheck(request: { readonly sender: string; readonly destination: string; readonly threadRefs: readonly string[] }): Promise<{ readonly kind: "clear" } | { readonly kind: "reply"; readonly providerRef: string; readonly at: number } | { readonly kind: "unavailable" }> {
    const destination = request.destination.toLowerCase();
    // A reply from this address to this inbox whose work is not proved yet pauses the send.
    if (this.heldReplies().some((h) => !h.released && h.inbox === request.sender && h.from === destination)) return { kind: "unavailable" };
    const recorded = request.threadRefs.map((ref) => this.store.dispatchedByRef(ref)).filter((d): d is DispatchedLead => d !== null && d.inbox === request.sender);
    const threads = new Set(recorded.flatMap((d) => (d.threadId === null ? [] : [d.threadId])));
    // No thread recorded for this lead from this inbox: a reply in one cannot exist yet.
    if (threads.size === 0) return { kind: "clear" };
    const since = Math.min(...recorded.map((d) => d.addedWall)) - this.config.overlapMs;
    const read = await this.readPages<InstantlyEmail>((after) =>
      this.client.get("/api/v2/emails", { lead: destination, eaccount: request.sender, mode: "emode_all", min_timestamp_created: iso(since), sort_order: "desc", limit: PAGE, starting_after: after }),
    );
    if (!read) return { kind: "unavailable" };
    const reply = read.items.find((e) => e.ue_type === 2 && e.eaccount === request.sender && e.thread_id !== null && threads.has(e.thread_id) && bare(e.from_address_email) === destination);
    if (reply) return { kind: "reply", providerRef: reply.id, at: emailTime(reply) };
    // Only a scan that reached the end can say there is no reply.
    return read.complete ? { kind: "clear" } : { kind: "unavailable" };
  }
}
