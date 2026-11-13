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
 * The adapter keeps the mapping to the sent email and its thread, and translates a reply's thread or
 * lead back to that reference. A reply whose work it cannot prove yet is held, and reported with its
 * work's reference or with none; the rules are at "The poller" below.
 *
 * The engine may stop waiting for a call without cancelling it, so every entry point that writes
 * runs single-flight: a handover per idempotency key, a dispatch campaign per key, and polls.
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
  /** How long, in running time, a reply whose work cannot be proved yet is held before it is reported with no reference (ADR 0003 `SETTLING`). */
  readonly replyHoldMs?: number;
  /** Items per page of every paged read (the documented `limit`). */
  readonly pageSize?: number;
  /** Pages one scan reads per poll before it resumes at the next. */
  readonly pagesPerPoll?: number;
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
  /** Tests only: called at points inside a poll, where a test may simulate the process dying. */
  readonly crashPoint?: (point: string) => void;
}

export type InboxHoldReason = InboxHoldReasonApi;

/** What the provider status endpoint shows, but the leads waiting on a follow-up, which the route adds. */
export type InstantlyStatus = Omit<EmailProviderStatus, "provider" | "waitingFollowUps"> & { readonly provider: "instantly" };

const MINUTE = 60_000;
const DEFAULTS = { freshnessMs: 10 * MINUTE, pollIntervalMs: MINUTE, analyticsCacheMs: 5 * MINUTE, k: 1, quotaRecheckMs: 60 * MINUTE, overlapMs: 10 * MINUTE, replyHoldMs: 15 * MINUTE, pageSize: 100, pagesPerPoll: 20 };

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

/** The most pages one thread is read to; a thread longer than that keeps its reply held. */
const THREAD_PAGES = 1_000;

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
  /** Running time waited: polls of one process, never the time it was stopped. */
  readonly waitedMs: number;
  readonly lastCountedWall: number;
  readonly released: boolean;
}

/** What one poll will commit, kept apart until its single transaction. */
interface Draft {
  readonly meta: Map<string, string>;
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
  private readonly crashPoint: ((point: string) => void) | null;
  /** Whether this process has committed a poll: before that, the gap since the last one is not running time. */
  private observedInThisProcess = false;
  private readonly flights = new Map<string, Promise<unknown>>();

  constructor(deps: InstantlyPortDependencies) {
    this.client = deps.client;
    this.store = deps.store;
    this.now = deps.now;
    this.config = { ...DEFAULTS, ...deps.config };
    this.subjectCampaign = deps.subjectCampaign ?? ((id) => Promise.resolve(deps.store.sendContext(id)));
    this.followUps = deps.followUps ?? null;
    this.crashPoint = deps.crashPoint ?? null;
  }

  /** Runs `run` unless a call with the same key is still running, which is joined instead. */
  private single<T>(key: string, run: () => Promise<T>): Promise<T> {
    const running = this.flights.get(key);
    if (running) return running as Promise<T>;
    const flight: Promise<T> = run().finally(() => {
      if (this.flights.get(key) === flight) this.flights.delete(key);
    });
    this.flights.set(key, flight);
    return flight;
  }

  transportFor(step: { readonly threading: "new_subject" | "continue_thread" }): Transport {
    if (step.threading === "new_subject") return OPENER;
    return this.followUps?.transport ?? NO_FOLLOW_UP;
  }

  // -------------------------------------------------------------------------------------------
  // Sender inboxes.

  private async readInboxes(): Promise<InstantlyAccount[]> {
    const read = await this.readPages<InstantlyAccount>((after) => this.client.get("/api/v2/accounts", { limit: this.config.pageSize, starting_after: after }));
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
  private dispatchCampaign(context: SendContext, request: HandoverRequest, inbox: InstantlyAccount): Promise<DispatchCampaignRecord | null> {
    const key = [context.kind, context.campaignId, request.trackId, request.stepId, request.sender].join("|");
    const name = `${context.kind === "test_run" ? "oo·test·" : "oo·"}${[context.campaignId, request.trackId, request.stepId, request.sender].join("·")}`;
    return this.single(`dispatch|${key}`, () => this.ensureDispatchCampaign(key, name, inbox));
  }

  private async ensureDispatchCampaign(key: string, name: string, inbox: InstantlyAccount): Promise<DispatchCampaignRecord | null> {
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
      const found = await this.readPages<InstantlyCampaign>((after) => this.client.get("/api/v2/campaigns", { search: name, limit: this.config.pageSize, starting_after: after }));
      if (!found?.complete) return null;
      campaign = found.items.find((c) => c.name === name) ?? null;
      if (!campaign) {
        const created = await this.client.post<InstantlyCampaign>("/api/v2/campaigns", wanted);
        if (!created.ok) return null;
        campaign = created.body;
        // Another process may have saved an id first: that one is kept.
        const saved = this.store.dispatchCampaign(key);
        if (saved?.instantlyId) return this.ensureDispatchCampaign(key, name, inbox);
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

  handover(request: HandoverRequest): Promise<CallAnswer> {
    // A same-key retry while the call the engine stopped waiting for is still running joins it.
    return this.single(`handover|${request.idempotencyKey}`, () => this.handoverOnce(request));
  }

  private async handoverOnce(request: HandoverRequest): Promise<CallAnswer> {
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
    // Recorded before the request: from here the app may have written to this address from this inbox.
    this.store.saveIntent(request.idempotencyKey, request.sender, destination, this.now());
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
  // Four rules (review bot on `7de601e` and `387a19b`, council on `387a19b`):
  //
  // - **Signal identity.** An event names a piece of work only when the message's own identity
  //   proves it: its thread or its Instantly lead, with the sender being the work's destination and
  //   the receiving inbox being the work's inbox. Only a campaign email (`ue_type` 1) is a dispatch
  //   send. Mail whose campaign, or whose thread's campaign email, is outside the app's dispatch
  //   campaigns is not the app's. The reference on an event is always one the engine already holds
  //   for that work, or none: a reply whose work cannot be proved yet is held here, pausing sends
  //   from that inbox to that address through the pre-send check.
  // - **Completeness.** A paged read reaches its end or counts as incomplete; scans resume from
  //   saved cursors; an inbox is fresh only when every scan it depends on reached its end, counted
  //   from when that scan began.
  // - **One commit per poll.** Everything a poll decides about what is read or reported again (scan
  //   cursors and completion, held replies, the acknowledgement of the previous batch, and the new
  //   batch) is kept in a draft and written in one transaction at the end, so a poll that dies
  //   anywhere before it returns changes none of it. Facts learned from Instantly on the way (which
  //   email and thread a lead's send is) are written as found: they are true whatever happens next,
  //   and writing them again changes nothing. Every batch is reported again until the engine passes
  //   its checkpoint back.
  // - **Running time.** A held reply's wait counts only the time between two polls of one running
  //   process; a restart counts nothing for the gap. It falls back only from a poll whose mail scan
  //   reached its end, after asking Instantly for the reply's thread.

  observe(checkpoint: string | null): Promise<{ events: readonly ProviderEvent[]; checkpoint: string }> {
    // One poll at a time: a call the engine stopped waiting for is joined, never run beside another.
    return this.single("observe", () => this.observeOnce(checkpoint));
  }

  private async observeOnce(checkpoint: string | null): Promise<{ events: readonly ProviderEvent[]; checkpoint: string }> {
    const now = this.now();
    const lastRun = this.store.meta(META.lastPollRun);
    if (checkpoint !== null && lastRun !== null && now - Number(lastRun) < this.config.pollIntervalMs) return { events: [], checkpoint };
    this.store.setMeta(META.lastPollRun, String(now));
    const draft: Draft = { meta: new Map() };
    const previous = this.previousBatch(checkpoint);
    const inboxes = await this.readInboxes();
    await this.readAnalytics();
    const events = new Map<string, ProviderEvent>(previous.replay.map((e) => [e.id, e]));
    const changes: Record<string, readonly [number, number | null]> = { ...previous.unapplied };
    if (this.store.anyDispatched()) {
      const mailComplete = await this.pollEmails(inboxes, events, draft);
      await this.pollLeadStatuses(events, changes, draft, previous.applied);
      await this.releaseHeldReplies(events, draft, mailComplete);
    } else {
      draft.meta.set(META.lastMailScan, String(now));
    }
    const seq = Number(this.store.meta(META.batchSeq) ?? 0) + 1;
    draft.meta.set(META.batchSeq, String(seq));
    const token = `oo-batch-${String(seq)}-${iso(now)}`;
    const batch: Batch = { token, events: [...events.values()], changes };
    this.crash("observe:before_commit");
    this.store.transaction(() => {
      for (const [workKey, [status, verification]] of Object.entries(previous.applied)) this.store.updateDispatched(workKey, { leadStatus: status, verificationStatus: verification });
      for (const [key, value] of draft.meta) this.store.setMeta(key, value);
      this.store.setMeta(META.batch, JSON.stringify(batch));
    });
    this.observedInThisProcess = true;
    this.crash("observe:after_commit");
    return { events: batch.events, checkpoint: token };
  }

  private crash(point: string): void {
    this.crashPoint?.(point);
  }

  /** A meta value as this poll sees it: its own unwritten draft first. */
  private draftMeta(draft: Draft, key: string): string | null {
    return draft.meta.has(key) ? (draft.meta.get(key) ?? null) : this.store.meta(key);
  }

  /**
   * The previous batch. When the engine passes back its checkpoint it was applied, and its status
   * changes are recorded with this poll's commit; otherwise it is reported again.
   */
  private previousBatch(checkpoint: string | null): { replay: readonly ProviderEvent[]; unapplied: Batch["changes"]; applied: Batch["changes"] } {
    const raw = this.store.meta(META.batch);
    if (raw === null) return { replay: [], unapplied: {}, applied: {} };
    const batch = JSON.parse(raw) as Batch;
    if (checkpoint !== batch.token) return { replay: batch.events, unapplied: batch.changes, applied: {} };
    return { replay: [], unapplied: {}, applied: batch.changes };
  }

  /** Reads pages from `start` until the end or the page budget; null when a page could not be read. */
  private async readPages<T>(read: (after: string | undefined) => Promise<InstantlyResult<Page<T>>>, start?: string, maxPages = this.config.pagesPerPoll): Promise<{ items: T[]; complete: boolean; next: string | undefined } | null> {
    const items: T[] = [];
    let after = start;
    for (let i = 0; i < maxPages; i++) {
      const page = await read(after);
      if (!page.ok) return null;
      items.push(...page.body.items);
      this.crash("observe:page");
      after = page.body.next_starting_after ?? undefined;
      if (!after) return { items, complete: true, next: undefined };
    }
    return { items, complete: false, next: after };
  }

  /** One mail scan, resumed where the previous poll stopped. True when it reached the end. */
  private async pollEmails(inboxes: readonly InstantlyAccount[], events: Map<string, ProviderEvent>, draft: Draft): Promise<boolean> {
    const now = this.now();
    const saved = this.store.meta(META.mailScan);
    const previous = saved ? (JSON.parse(saved) as MailScan) : null;
    // A scan that has not read its first page yet begins now: freshness counts from here.
    // The first scan ever reads from the first lead add, so mail that came before the first poll is read.
    const firstSince = iso(Math.min(now, this.store.earliestDispatchWall() ?? now) - this.config.overlapMs);
    const scan: MailScan = previous?.after ? previous : { since: previous?.since ?? firstSince, after: null, startedWall: now, newest: null };
    const query: ListEmailsQuery = { eaccount: inboxes.map((a) => a.email).join(","), mode: "emode_all", min_timestamp_created: scan.since, sort_order: "asc", preview_only: false, limit: this.config.pageSize };
    const read = await this.readPages<InstantlyEmail>((after) => this.client.get("/api/v2/emails", { ...query, starting_after: after }), scan.after ?? undefined);
    if (!read) throw new Error("Instantly emails could not be read");
    let newest = scan.newest;
    const ours = new Set(this.store.dispatchCampaigns().flatMap((c) => (c.instantlyId === null ? [] : [c.instantlyId])));
    for (const email of read.items) {
      const event = this.classify(email, draft, ours);
      if (event) events.set(event.id, event);
      if (newest === null || email.timestamp_created > newest) newest = email.timestamp_created;
    }
    if (read.complete) {
      // The next scan starts from the newest record seen, less the overlap.
      const from = newest === null ? now : Math.max(Date.parse(newest), Date.parse(scan.since) + this.config.overlapMs);
      draft.meta.set(META.mailScan, JSON.stringify({ since: iso(from - this.config.overlapMs), after: null, startedWall: now, newest: null } satisfies MailScan));
      draft.meta.set(META.lastMailScan, String(scan.startedWall));
    } else {
      draft.meta.set(META.mailScan, JSON.stringify({ ...scan, after: read.next ?? null, newest } satisfies MailScan));
    }
    return read.complete;
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

  private classify(email: InstantlyEmail, draft: Draft, ours: ReadonlySet<string>): ProviderEvent | null {
    if (email.ue_type === 1 && email.lead_id) {
      const d = this.store.dispatchedByLead(email.lead_id);
      if (!d || d.instantlyCampaignId !== email.campaign_id || d.inbox !== email.eaccount) return null;
      // A fact about Instantly's records, written as found (see "One commit per poll").
      if (d.sentEmailId === null) this.store.updateDispatched(d.workKey, { sentEmailId: email.id, threadId: email.thread_id, sentWall: emailTime(email) });
      if (d.sentEmailId !== null && d.sentEmailId !== email.id) return null;
      return { id: `sent:${email.id}`, kind: "sent", key: d.workKey, providerRef: d.ref, sentAt: emailTime(email) };
    }
    if (email.ue_type !== 2) return null;
    const from = bare(email.from_address_email);
    const owner = this.ownerOf(email, from);
    const held = this.heldReplies(draft);
    if (owner) {
      if (held.some((h) => h.emailId === email.id && !h.released)) this.saveHeld(draft, held.map((h) => (h.emailId === email.id ? { ...h, released: true } : h)));
      return { id: `reply:${email.id}`, kind: "reply", providerRef: owner.ref, at: emailTime(email), inbox: email.eaccount, from };
    }
    // Another campaign's mail by its own identity is not the app's.
    if (email.campaign_id !== null && !ours.has(email.campaign_id)) return null;
    // Not provably the app's: held only when it comes from an address the app wrote to, or may have written to, from that inbox.
    if (this.store.reachedFrom(email.eaccount, from) && !held.some((h) => h.emailId === email.id)) {
      this.saveHeld(draft, [...held, { emailId: email.id, threadId: email.thread_id, inbox: email.eaccount, from, at: emailTime(email), waitedMs: 0, lastCountedWall: this.now(), released: false }]);
    }
    return null;
  }

  /** Held replies as committed, or as this poll's draft has them. */
  private heldReplies(draft?: Draft): HeldReply[] {
    const raw = draft ? this.draftMeta(draft, META.heldReplies) : this.store.meta(META.heldReplies);
    return raw === null ? [] : (JSON.parse(raw) as HeldReply[]);
  }

  private saveHeld(draft: Draft, held: readonly HeldReply[]): void {
    // A released entry is kept for a day so a re-read in the overlap does not hold it again.
    const keep = held.filter((h) => !h.released || this.now() - h.lastCountedWall < 24 * 60 * MINUTE);
    draft.meta.set(META.heldReplies, JSON.stringify(keep));
  }

  /**
   * Reports a held reply once its thread names its work. Otherwise, after it has waited the settling
   * period in running time, and only from a poll whose mail scan reached its end, it asks Instantly
   * for the thread: a campaign email of the app's work names it, another campaign's drops it, and
   * with neither it is reported with no reference for the engine's fallback (ADR 0003 2.4).
   */
  private async releaseHeldReplies(events: Map<string, ProviderEvent>, draft: Draft, mailComplete: boolean): Promise<void> {
    const now = this.now();
    const counting = this.observedInThisProcess;
    const next: HeldReply[] = [];
    let changed = false;
    for (const h of this.heldReplies(draft)) {
      if (h.released) {
        next.push(h);
        continue;
      }
      const waited: HeldReply = { ...h, waitedMs: h.waitedMs + (counting ? Math.max(0, now - h.lastCountedWall) : 0), lastCountedWall: now };
      changed = true;
      const byThread = h.threadId ? this.store.dispatchedByThread(h.threadId) : null;
      let owner = byThread && byThread.inbox === h.inbox && byThread.destination === h.from ? byThread : null;
      if (!owner && (waited.waitedMs < this.config.replyHoldMs || !mailComplete)) {
        next.push(waited);
        continue;
      }
      if (!owner) {
        const verdict = await this.threadVerdict(waited);
        if (verdict === "unavailable") {
          next.push(waited);
          continue;
        }
        if (verdict === "foreign") {
          next.push({ ...waited, released: true });
          continue;
        }
        owner = verdict === "none" ? null : verdict;
      }
      events.set(`reply:${h.emailId}`, { id: `reply:${h.emailId}`, kind: "reply", providerRef: owner ? owner.ref : null, at: h.at, inbox: h.inbox, from: h.from });
      next.push({ ...waited, released: true });
    }
    if (changed) this.saveHeld(draft, next);
  }

  /** What the held reply's thread shows: the app's work, another campaign, neither, or nothing readable. */
  private async threadVerdict(h: HeldReply): Promise<DispatchedLead | "foreign" | "none" | "unavailable"> {
    if (h.threadId === null) return "none";
    const thread = h.threadId;
    // One thread, read whole: its own bound, well beyond any real thread, not the scan's budget.
    const read = await this.readPages<InstantlyEmail>((after) => this.client.get("/api/v2/emails", { search: `thread:${thread}`, eaccount: h.inbox, mode: "emode_all", limit: this.config.pageSize, starting_after: after }), undefined, THREAD_PAGES);
    if (!read?.complete) return "unavailable";
    const ours = new Set(this.store.dispatchCampaigns().flatMap((c) => (c.instantlyId === null ? [] : [c.instantlyId])));
    let foreign = false;
    for (const e of read.items) {
      if (e.ue_type !== 1) continue;
      const d = e.lead_id ? this.store.dispatchedByLead(e.lead_id) : null;
      if (d && d.inbox === h.inbox && d.destination === h.from && d.instantlyCampaignId === e.campaign_id) return d;
      if (e.campaign_id !== null && !ours.has(e.campaign_id)) foreign = true;
    }
    return foreign ? "foreign" : "none";
  }

  /** Each dispatch campaign's status scan, resumed where the previous poll stopped. */
  private async pollLeadStatuses(events: Map<string, ProviderEvent>, changes: Record<string, readonly [number, number | null]>, draft: Draft, applied: Batch["changes"]): Promise<void> {
    for (const campaign of this.store.dispatchCampaigns()) {
      const campaignId = campaign.instantlyId;
      if (campaignId === null) continue;
      const cursor = this.store.meta(META.statusCursor(campaign.key)) || undefined;
      if (!cursor) draft.meta.set(META.statusScanStarted(campaign.key), String(this.now()));
      const read = await this.readPages<InstantlyLead>((after) => this.client.post("/api/v2/leads/list", { campaign: campaignId, limit: this.config.pageSize, ...(after ? { starting_after: after } : {}) } satisfies ListLeadsRequest), cursor);
      // A page that could not be read leaves the scan where it was: this campaign is not current.
      if (!read) continue;
      for (const lead of read.items) {
        const d = this.store.dispatchedByLead(lead.id);
        // Known as of this poll: recorded, or applied by the engine and recorded with this poll's commit.
        const known = d ? (applied[d.workKey]?.[0] ?? d.leadStatus) : null;
        if (!d || d.instantlyCampaignId !== campaignId || known === lead.status) continue;
        const event = this.statusEvent(d, lead);
        if (event) events.set(event.id, event);
        changes[d.workKey] = [lead.status, lead.verification_status ?? null];
      }
      if (read.complete) {
        draft.meta.set(META.statusCursor(campaign.key), "");
        draft.meta.set(META.statusScanComplete(campaign.key), this.draftMeta(draft, META.statusScanStarted(campaign.key)) ?? String(this.now()));
      } else {
        draft.meta.set(META.statusCursor(campaign.key), read.next ?? "");
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
      this.client.get("/api/v2/emails", { lead: d.destination, eaccount: d.inbox, campaign_id: d.instantlyCampaignId, mode: "emode_all", sort_order: "asc", limit: this.config.pageSize, starting_after: after }),
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
    const leads = await this.readPages<InstantlyLead>((after) => this.client.post("/api/v2/leads/list", { campaign: d.instantlyCampaignId, contacts: [d.destination], limit: this.config.pageSize, ...(after ? { starting_after: after } : {}) } satisfies ListLeadsRequest));
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
    // Each recorded thread is read whole: a reply in it need not carry the lead's metadata.
    for (const thread of threads) {
      const read = await this.readPages<InstantlyEmail>((after) => this.client.get("/api/v2/emails", { search: `thread:${thread}`, eaccount: request.sender, mode: "emode_all", sort_order: "desc", limit: this.config.pageSize, starting_after: after }), undefined, THREAD_PAGES);
      if (!read) return { kind: "unavailable" };
      const reply = read.items.find((e) => e.ue_type === 2 && e.eaccount === request.sender && e.thread_id === thread && bare(e.from_address_email) === destination);
      if (reply) return { kind: "reply", providerRef: reply.id, at: emailTime(reply) };
      // Only a read that reached the end can say there is no reply.
      if (!read.complete) return { kind: "unavailable" };
    }
    return { kind: "clear" };
  }
}
