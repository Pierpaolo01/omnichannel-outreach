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

export type InboxHoldReason = "sending_off" | "not_active" | "no_daily_limit" | "stale";

/** What the provider status endpoint shows. */
export interface InstantlyStatus {
  readonly provider: "instantly";
  readonly sending: "on" | "off";
  readonly followUps: "unavailable" | "available";
  readonly quota: "available" | "exhausted";
  readonly lastPolledAt: string | null;
  readonly inboxes: readonly {
    readonly id: string;
    readonly status: number;
    readonly dailyLimit: number | null;
    readonly capacity: number;
    readonly healthy: boolean;
    readonly reason: InboxHoldReason | null;
  }[];
}

const MINUTE = 60_000;
const DEFAULTS = { freshnessMs: 10 * MINUTE, pollIntervalMs: MINUTE, analyticsCacheMs: 5 * MINUTE, k: 1, quotaRecheckMs: 60 * MINUTE, overlapMs: 10 * MINUTE };
const PAGE = 100;
const MAX_PAGES = 20;

const META = {
  lastPoll: "last_successful_poll_wall",
  quotaHeld: "quota_held_wall",
  pendingStatuses: "pending_lead_statuses",
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

interface PendingStatuses {
  readonly token: string;
  readonly changes: Readonly<Record<string, readonly [number, number | null]>>;
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
    const all: InstantlyAccount[] = [];
    let after: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await this.client.get<Page<InstantlyAccount>>("/api/v2/accounts", { limit: PAGE, starting_after: after });
      if (!page.ok) throw new Error(`Instantly accounts could not be read (${String(page.status)})`);
      all.push(...page.body.items);
      after = page.body.next_starting_after ?? undefined;
      if (!after) break;
    }
    this.inboxes = [...all].sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
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
    const lastPoll = this.store.meta(META.lastPoll);
    const fresh = lastPoll !== null && now - Number(lastPoll) <= this.config.freshnessMs;
    const limit = a.daily_limit ?? 0;
    const other = Math.max(0, Number(this.store.meta(META.analytics(day, a.email)) ?? 0) - this.appSentToday(a.email, day));
    const reason: InboxHoldReason | null = !this.client.writes ? "sending_off" : a.status !== 1 ? "not_active" : limit <= 0 ? "no_daily_limit" : !fresh ? "stale" : null;
    return { id: a.email, status: a.status, dailyLimit: a.daily_limit, capacity: Math.max(0, limit - other), healthy: reason === null, reason };
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
    const lastPoll = this.store.meta(META.lastPoll);
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
      const found = await this.client.get<Page<InstantlyCampaign>>("/api/v2/campaigns", { search: name, limit: PAGE });
      if (!found.ok) return null;
      campaign = found.body.items.find((c) => c.name === name) ?? null;
      if (!campaign) {
        const created = await this.client.post<InstantlyCampaign>("/api/v2/campaigns", wanted);
        if (!created.ok) return null;
        campaign = created.body;
        record = { ...record, instantlyId: campaign.id, timestampUpdated: campaign.timestamp_updated };
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

  async observe(checkpoint: string | null): Promise<{ events: readonly ProviderEvent[]; checkpoint: string }> {
    const now = this.now();
    const lastPoll = this.store.meta(META.lastPoll);
    if (checkpoint !== null && lastPoll !== null && now - Number(lastPoll) < this.config.pollIntervalMs) return { events: [], checkpoint };
    this.acknowledgeStatuses(checkpoint);
    const inboxes = await this.readInboxes();
    await this.readAnalytics();
    const events: ProviderEvent[] = [];
    let next = checkpoint ?? iso(now);
    if (this.store.anyDispatched()) {
      next = await this.pollEmails(inboxes, checkpoint, events);
      await this.pollLeadStatuses(next, events);
    }
    this.store.setMeta(META.lastPoll, String(now));
    return { events, checkpoint: next };
  }

  private async pollEmails(inboxes: readonly InstantlyAccount[], checkpoint: string | null, events: ProviderEvent[]): Promise<string> {
    const since = checkpoint !== null && !Number.isNaN(Date.parse(checkpoint)) ? Date.parse(checkpoint) : this.now();
    let newest = checkpoint !== null && !Number.isNaN(Date.parse(checkpoint)) ? checkpoint : iso(this.now() - this.config.overlapMs);
    let after: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const query: ListEmailsQuery = {
        eaccount: inboxes.map((a) => a.email).join(","),
        mode: "emode_all",
        min_timestamp_created: iso(since - this.config.overlapMs),
        sort_order: "asc",
        preview_only: false,
        limit: PAGE,
        ...(after ? { starting_after: after } : {}),
      };
      const page = await this.client.get<Page<InstantlyEmail>>("/api/v2/emails", { ...query });
      if (!page.ok) throw new Error(`Instantly emails could not be read (${String(page.status)})`);
      for (const email of page.body.items) {
        const event = this.classify(email);
        if (event) events.push(event);
        if (email.timestamp_created > newest) newest = email.timestamp_created;
      }
      after = page.body.next_starting_after ?? undefined;
      if (!after) break;
    }
    return newest;
  }

  private classify(email: InstantlyEmail): ProviderEvent | null {
    if ((email.ue_type === 1 || email.ue_type === 3) && email.lead_id) {
      const d = this.store.dispatchedByLead(email.lead_id);
      if (!d || d.instantlyCampaignId !== email.campaign_id) return null;
      if (d.sentEmailId === null) this.store.updateDispatched(d.workKey, { sentEmailId: email.id, threadId: email.thread_id, sentWall: emailTime(email) });
      return { id: `sent:${email.id}`, kind: "sent", key: d.workKey, providerRef: d.ref, sentAt: emailTime(email) };
    }
    if (email.ue_type === 2) {
      const from = bare(email.from_address_email);
      const owner = email.thread_id ? this.store.dispatchedByThread(email.thread_id) : null;
      if (owner) return { id: `reply:${email.id}`, kind: "reply", providerRef: owner.ref, at: emailTime(email), inbox: email.eaccount, from };
      // Outside every thread the adapter knows: reported only when the app wrote to that address from that inbox.
      if (!this.store.reachedFrom(email.eaccount, from)) return null;
      return { id: `reply:${email.id}`, kind: "reply", providerRef: email.thread_id ? `it:${email.thread_id}` : null, at: emailTime(email), inbox: email.eaccount, from };
    }
    return null;
  }

  /** Lead statuses the engine has applied: it passes back the checkpoint they were reported with. */
  private acknowledgeStatuses(checkpoint: string | null): void {
    const raw = this.store.meta(META.pendingStatuses);
    if (raw === null || checkpoint === null) return;
    const pending = JSON.parse(raw) as PendingStatuses;
    if (pending.token !== checkpoint) return;
    for (const [workKey, [status, verification]] of Object.entries(pending.changes)) this.store.updateDispatched(workKey, { leadStatus: status, verificationStatus: verification });
    this.store.setMeta(META.pendingStatuses, JSON.stringify({ token: "", changes: {} }));
  }

  private async pollLeadStatuses(token: string, events: ProviderEvent[]): Promise<void> {
    const changes: Record<string, readonly [number, number | null]> = {};
    for (const campaign of this.store.dispatchCampaigns()) {
      if (campaign.instantlyId === null) continue;
      let after: string | undefined;
      for (let i = 0; i < MAX_PAGES; i++) {
        const body: ListLeadsRequest = { campaign: campaign.instantlyId, limit: PAGE, ...(after ? { starting_after: after } : {}) };
        const page = await this.client.post<Page<InstantlyLead>>("/api/v2/leads/list", body);
        if (!page.ok) throw new Error(`Instantly leads could not be read (${String(page.status)})`);
        for (const lead of page.body.items) {
          const d = this.store.dispatchedByLead(lead.id);
          if (!d || d.leadStatus === lead.status) continue;
          const event = this.statusEvent(d, lead);
          if (event) events.push(event);
          changes[d.workKey] = [lead.status, lead.verification_status ?? null];
        }
        after = page.body.next_starting_after ?? undefined;
        if (!after) break;
      }
    }
    this.store.setMeta(META.pendingStatuses, JSON.stringify({ token, changes } satisfies PendingStatuses));
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
    const page = await this.client.get<Page<InstantlyEmail>>("/api/v2/emails", { lead: d.destination, eaccount: d.inbox, campaign_id: d.instantlyCampaignId, mode: "emode_all", sort_order: "asc", limit: PAGE });
    if (!page.ok) return undefined;
    const email = page.body.items.find((e) => (e.ue_type === 1 || e.ue_type === 3) && e.lead_id === d.leadId) ?? null;
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
    const leads = await this.client.post<Page<InstantlyLead>>("/api/v2/leads/list", { campaign: d.instantlyCampaignId, contacts: [d.destination], limit: PAGE } satisfies ListLeadsRequest);
    if (!leads.ok) return { kind: "unknown" };
    const lead = leads.body.items.find((l) => l.id === d.leadId);
    if (!lead) return { kind: "not-sent" };
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
    const recorded = request.threadRefs.map((ref) => this.store.dispatchedByRef(ref)).filter((d): d is DispatchedLead => d !== null && d.inbox === request.sender);
    const threads = new Set(recorded.flatMap((d) => (d.threadId === null ? [] : [d.threadId])));
    // No thread recorded for this lead from this inbox: a reply in one cannot exist yet.
    if (threads.size === 0) return { kind: "clear" };
    const since = Math.min(...recorded.map((d) => d.addedWall)) - this.config.overlapMs;
    const page = await this.client.get<Page<InstantlyEmail>>("/api/v2/emails", { lead: request.destination.toLowerCase(), eaccount: request.sender, mode: "emode_all", min_timestamp_created: iso(since), sort_order: "desc", limit: PAGE });
    if (!page.ok) return { kind: "unavailable" };
    const destination = request.destination.toLowerCase();
    const reply = page.body.items.find((e) => e.ue_type === 2 && e.thread_id !== null && threads.has(e.thread_id) && bare(e.from_address_email) === destination);
    return reply ? { kind: "reply", providerRef: reply.id, at: emailTime(reply) } : { kind: "clear" };
  }
}
