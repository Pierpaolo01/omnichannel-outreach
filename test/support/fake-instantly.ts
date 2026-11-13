import type {
  AddLeadsRequest,
  AddLeadsResponse,
  DailyAccountAnalytics,
  DispatchCampaignSettings,
  InstantlyAccount,
  InstantlyCampaign,
  InstantlyEmail,
  InstantlyError,
  InstantlyLead,
  LeadStatusCode,
  VerificationStatusCode,
} from "../../src/server/instantly/api.ts";

/**
 * A fake Instantly HTTP service for the adapter's tests, behind the same `fetch` the real client
 * uses. Every request and response shape is the documented one in `src/server/instantly/api.ts`
 * (each cites its operation in `api_v2.json`). Behavior the documentation does not state is marked
 * "assumed" where the fake has to choose one, and is exactly what ADR 0002's experiments X1 to X9
 * would test against the real service. **A test that passes here is not provider proof.**
 *
 * The fake also acts on its own: an added lead in an active campaign is sent `sendDelayMs` later,
 * and the prospect may reply. Data is fictitious.
 */

const DAY = 24 * 3_600_000;

interface FakeLead extends InstantlyLead {
  readonly campaign: string;
  status: LeadStatusCode;
  verification_status: VerificationStatusCode | null;
  readonly addedAt: number;
  readonly variables: Readonly<Record<string, string>>;
  sendAt: number | null;
  sentEmailId: string | null;
  deleted: boolean;
}

interface FakeCampaign extends InstantlyCampaign {
  status: InstantlyCampaign["status"];
  timestamp_updated: string;
  settings: DispatchCampaignSettings;
}

export interface FakeInstantlyOptions {
  readonly now: () => number;
  readonly accounts: readonly InstantlyAccount[];
  /** The key the fake accepts. */
  readonly apiKey?: string;
}

export interface FakeRequest {
  readonly at: number;
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
}

const iso = (t: number) => new Date(t).toISOString();
const error = (statusCode: number, error: string, message: string): Response => Response.json({ statusCode, error, message } satisfies InstantlyError, { status: statusCode });

export class FakeInstantly {
  readonly requests: FakeRequest[] = [];
  readonly accounts: InstantlyAccount[];
  readonly campaigns: FakeCampaign[] = [];
  readonly leads: FakeLead[] = [];
  readonly emails: InstantlyEmail[] = [];
  /** Addresses on the workspace block list, refused by `bulkAddLeads` as `in_blocklist`. */
  readonly blocklist = new Set<string>();
  /** Addresses that bounce once sent to: the lead becomes status -1 Bounced. */
  readonly bouncing = new Set<string>();
  /** Addresses Instantly skips (status -3), with the verification status it gives, or null for an unexplained skip. */
  readonly skipping = new Map<string, VerificationStatusCode | null>();
  /** Answer every request with this status and its documented error body (402, 429, 500). */
  failWith: number | null = null;
  /** Answer only `bulkAddLeads` with this status. */
  failAddWith: number | null = null;
  /** `bulkAddLeads` processes the lead, then the connection drops before its answer arrives. */
  loseAddResponses = false;
  /** `remaining_in_plan` (assumed to count down by one per created lead). */
  remainingInPlan = 1_000;
  /** How long after an add an active campaign sends to the lead (assumed; X1 measures it). */
  sendDelayMs = 60_000;
  /** How long after a send its Email record becomes visible to `listEmail` (assumed). */
  visibleDelayMs = 0;
  /** Campaign emails other campaigns sent today, per account, for `getDailyAccountAnalytics`. */
  readonly otherSentToday = new Map<string, number>();

  private readonly now: () => number;
  private readonly apiKey: string;
  private nextId = 0;
  private readonly addResults = new Map<string, AddLeadsResponse>();
  private readonly visibleAt = new Map<string, number>();

  constructor(options: FakeInstantlyOptions) {
    this.now = options.now;
    this.accounts = [...options.accounts];
    this.apiKey = options.apiKey ?? "test-key-not-real";
  }

  private id(prefix: string): string {
    this.nextId++;
    return `${prefix}-${String(this.nextId).padStart(6, "0")}`;
  }

  /** Requests that were not reads: everything but GET and `listLeads`. */
  writes(): FakeRequest[] {
    return this.requests.filter((r) => r.method !== "GET" && r.path !== "/api/v2/leads/list");
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    this.requests.push({ at: this.now(), method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    this.advance();
    if (!headers.get("user-agent")) return error(403, "Forbidden", "Forbidden");
    if (headers.get("authorization") !== `Bearer ${this.apiKey}`) return error(401, "Unauthorized", "Unauthorized");
    if (this.failWith !== null) return this.failure(this.failWith);
    return this.route(method, url, body);
  };

  private failure(status: number): Response {
    if (status === 402) return error(402, "Payment Required", "This request cannot be fulfilled because the workspace does not have an active paid plan");
    if (status === 429) return error(429, "Too Many Requests", "Rate limit exceeded");
    return error(status, "Error", "Internal error");
  }

  private async route(method: string, url: URL, body: unknown): Promise<Response> {
    const path = url.pathname;
    const q = url.searchParams;
    if (method === "GET" && path === "/api/v2/accounts") return Response.json(this.page(this.accounts, q, (a) => a.email));
    if (method === "GET" && path === "/api/v2/accounts/analytics/daily") return Response.json(this.analytics(q));
    if (method === "GET" && path === "/api/v2/campaigns") {
      const search = q.get("search");
      return Response.json(this.page(this.campaigns.filter((c) => search === null || c.name.includes(search)).map((c) => this.campaignView(c)), q, (c) => c.id));
    }
    if (method === "POST" && path === "/api/v2/campaigns") return this.createCampaign(body as DispatchCampaignSettings);
    const campaignPath = /^\/api\/v2\/campaigns\/([^/]+)(\/activate)?$/.exec(path);
    if (campaignPath) {
      const c = this.campaigns.find((x) => x.id === campaignPath[1]);
      if (!c) return error(404, "Not Found", "Campaign not found");
      if (method === "GET" && !campaignPath[2]) return Response.json(this.campaignView(c));
      if (method === "PATCH" && !campaignPath[2]) {
        c.settings = { ...c.settings, ...(body as Partial<DispatchCampaignSettings>) };
        c.timestamp_updated = iso(this.now());
        return Response.json(this.campaignView(c));
      }
      if (method === "POST" && campaignPath[2]) {
        c.status = 1;
        c.timestamp_updated = iso(this.now());
        this.scheduleWaiting(c);
        return Response.json(this.campaignView(c));
      }
    }
    if (method === "POST" && path === "/api/v2/leads/add") return this.addLeads(body as AddLeadsRequest);
    if (method === "POST" && path === "/api/v2/leads/list") {
      const b = body as { campaign?: string; contacts?: string[]; limit?: number; starting_after?: string };
      const items = this.leads.filter((l) => !l.deleted && (b.campaign === undefined || l.campaign === b.campaign) && (b.contacts === undefined || b.contacts.map((x) => x.toLowerCase()).includes(l.email.toLowerCase())));
      const params = new URLSearchParams();
      if (b.limit !== undefined) params.set("limit", String(b.limit));
      if (b.starting_after !== undefined) params.set("starting_after", b.starting_after);
      return Response.json(this.page(items.map((l) => this.leadView(l)), params, (l) => l.id));
    }
    const leadPath = /^\/api\/v2\/leads\/([^/]+)$/.exec(path);
    if (leadPath && method === "DELETE") {
      const l = this.leads.find((x) => x.id === leadPath[1] && !x.deleted);
      if (!l) return error(404, "Not Found", "Lead not found");
      l.deleted = true;
      return Response.json(this.leadView(l));
    }
    if (method === "GET" && path === "/api/v2/emails") return Response.json(this.listEmails(q));
    return error(404, "Not Found", `no route for ${method} ${path}`);
  }

  /** Cursor pagination as documented: `limit` items, `next_starting_after` the last id when more follow. */
  private page<T>(all: readonly T[], q: URLSearchParams, idOf: (t: T) => string): { items: T[]; next_starting_after?: string } {
    const limit = Number(q.get("limit") ?? 100);
    const after = q.get("starting_after");
    const start = after === null ? 0 : all.findIndex((x) => idOf(x) === after) + 1;
    const items = all.slice(start, start + limit);
    const last = items.at(-1);
    return start + limit < all.length && last !== undefined ? { items, next_starting_after: idOf(last) } : { items };
  }

  private campaignView(c: FakeCampaign): InstantlyCampaign & { email_list: readonly string[] } {
    return { id: c.id, name: c.name, status: c.status, timestamp_updated: c.timestamp_updated, email_list: c.settings.email_list };
  }

  private leadView(l: FakeLead): InstantlyLead {
    return { id: l.id, email: l.email, campaign: l.campaign, status: l.status, verification_status: l.verification_status };
  }

  private createCampaign(settings: DispatchCampaignSettings): Response {
    // `name` and `campaign_schedule` are the documented required fields; `createCampaign` has no idempotency key.
    if (typeof settings.name !== "string" || typeof settings.campaign_schedule !== "object") return error(400, "Bad Request", "name and campaign_schedule are required");
    const c: FakeCampaign = { id: this.id("camp"), name: settings.name, status: 0, timestamp_updated: iso(this.now()), settings };
    this.campaigns.push(c);
    return Response.json(this.campaignView(c));
  }

  /** The campaign a test finds by its name. */
  campaignNamed(name: string): FakeCampaign | undefined {
    return this.campaigns.find((c) => c.name === name);
  }

  /** Someone edits a dispatch campaign directly in Instantly. */
  editDirectly(campaignId: string, change: Partial<DispatchCampaignSettings>): void {
    const c = this.campaigns.find((x) => x.id === campaignId);
    if (!c) throw new Error("no such campaign");
    c.settings = { ...c.settings, ...change };
    c.timestamp_updated = iso(this.now() + 1);
  }

  private addLeads(request: AddLeadsRequest): Promise<Response> {
    if (this.failAddWith !== null) return Promise.resolve(this.failure(this.failAddWith));
    const campaign = this.campaigns.find((c) => c.id === request.campaign_id);
    if (!campaign) return Promise.resolve(error(404, "Not Found", "Campaign not found"));
    const previous = this.addResults.get(request.idempotency_key);
    if (previous) return Promise.resolve(Response.json(previous));
    const result: { -readonly [K in keyof AddLeadsResponse]: AddLeadsResponse[K] } = {
      status: "success",
      leads_uploaded: 0,
      in_blocklist: 0,
      duplicated_leads: 0,
      skipped_count: 0,
      invalid_email_count: 0,
      remaining_in_plan: this.remainingInPlan,
      created_leads: [],
    };
    request.leads.forEach((lead, index) => {
      const email = lead.email.toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) result.invalid_email_count++;
      else if (this.blocklist.has(email)) result.in_blocklist++;
      else if (this.leads.some((l) => !l.deleted && l.campaign === campaign.id && l.email === email)) result.duplicated_leads++;
      else {
        const skipped = this.skipping.has(email);
        const l: FakeLead = {
          id: this.id("lead"),
          email,
          campaign: campaign.id,
          status: skipped ? -3 : 1,
          verification_status: skipped ? (this.skipping.get(email) ?? null) : 0,
          addedAt: this.now(),
          variables: lead.custom_variables,
          sendAt: null,
          sentEmailId: null,
          deleted: false,
        };
        this.leads.push(l);
        if (!skipped && campaign.status === 1) l.sendAt = this.now() + this.sendDelayMs;
        this.remainingInPlan = Math.max(0, this.remainingInPlan - 1);
        result.leads_uploaded++;
        result.created_leads = [...result.created_leads, { index, id: l.id, email }];
      }
    });
    result.remaining_in_plan = this.remainingInPlan;
    this.addResults.set(request.idempotency_key, result);
    if (this.loseAddResponses) return Promise.reject(new TypeError("fetch failed: the connection closed before the response"));
    return Promise.resolve(Response.json(result));
  }

  private scheduleWaiting(c: FakeCampaign): void {
    for (const l of this.leads) if (l.campaign === c.id && !l.deleted && l.status === 1 && l.sendAt === null && l.sentEmailId === null) l.sendAt = this.now() + this.sendDelayMs;
  }

  private analytics(q: URLSearchParams): DailyAccountAnalytics[] {
    const date = q.get("start_date") ?? iso(this.now()).slice(0, 10);
    const wanted = q.get("emails")?.split(",");
    return this.accounts
      .filter((a) => wanted === undefined || wanted.includes(a.email))
      .map((a) => {
        const app = this.emails.filter((e) => e.ue_type === 1 && e.eaccount === a.email && e.timestamp_created.slice(0, 10) === date).length;
        return { date, email_account: a.email, sent: app + (this.otherSentToday.get(a.email) ?? 0) };
      });
  }

  private listEmails(q: URLSearchParams): { items: InstantlyEmail[]; next_starting_after?: string } {
    const now = this.now();
    const accounts = q.get("eaccount")?.split(",");
    const lead = q.get("lead")?.toLowerCase();
    const campaign = q.get("campaign_id");
    const min = q.get("min_timestamp_created");
    const type = q.get("email_type");
    let items = this.emails.filter((e) => (this.visibleAt.get(e.id) ?? 0) <= now);
    if (accounts) items = items.filter((e) => accounts.includes(e.eaccount));
    if (lead) items = items.filter((e) => e.lead === lead);
    if (campaign) items = items.filter((e) => e.campaign_id === campaign);
    if (min) items = items.filter((e) => e.timestamp_created > min);
    if (type === "received") items = items.filter((e) => e.ue_type === 2);
    if (type === "sent") items = items.filter((e) => e.ue_type === 1 || e.ue_type === 3);
    items = [...items].sort((a, b) => (a.timestamp_created < b.timestamp_created ? -1 : a.timestamp_created > b.timestamp_created ? 1 : 0));
    if (q.get("sort_order") !== "asc") items.reverse();
    return this.page(items, q, (e) => e.id);
  }

  /** Sends whatever is due by now. */
  advance(): void {
    const now = this.now();
    for (const l of this.leads) {
      if (l.deleted || l.sendAt === null || l.sendAt > now || l.sentEmailId !== null) continue;
      const campaign = this.campaigns.find((c) => c.id === l.campaign);
      if (campaign?.status !== 1) continue;
      const inbox = campaign.settings.email_list[0] ?? "";
      const id = this.id("email");
      const email: InstantlyEmail = {
        id,
        timestamp_created: iso(l.sendAt),
        timestamp_email: iso(l.sendAt),
        from_address_email: inbox,
        to_address_email_list: l.email,
        campaign_id: campaign.id,
        lead: l.email,
        lead_id: l.id,
        eaccount: inbox,
        ue_type: 1,
        thread_id: this.id("thread"),
      };
      this.emails.push(email);
      this.visibleAt.set(id, l.sendAt + this.visibleDelayMs);
      l.sentEmailId = id;
      l.status = this.bouncing.has(l.email) ? -1 : 3;
    }
  }

  nextActivityAt(): number | null {
    const now = this.now();
    const times = [
      ...this.leads.filter((l) => !l.deleted && l.sendAt !== null && l.sentEmailId === null && l.sendAt > now).map((l) => l.sendAt ?? 0),
      ...[...this.visibleAt.values()].filter((t) => t > now),
    ];
    return times.length > 0 ? Math.min(...times) : null;
  }

  /** What was actually sent: each campaign email with its copy, for the tests' independent record. */
  deliveries(): { at: number; inbox: string; to: string; leadId: string; subject: string; body: string }[] {
    return this.emails
      .filter((e) => e.ue_type === 1)
      .map((e) => {
        const l = this.leads.find((x) => x.id === e.lead_id);
        return { at: Date.parse(e.timestamp_created), inbox: e.eaccount, to: e.lead ?? "", leadId: e.lead_id ?? "", subject: l?.variables["oo_subject"] ?? "", body: l?.variables["oo_body"] ?? "" };
      });
  }

  /**
   * A message arrives in an inbox: the prospect's reply in the thread of the latest email they
   * received, a new conversation, or (with `inThreadOf`) any sender's message in that address's
   * thread, such as a delivery notice. `withLead: false` leaves out `lead_id` and `campaign_id`,
   * which the documentation gives only "if any".
   */
  reply(from: string, options: { onThread?: boolean; inbox?: string; inThreadOf?: string; withLead?: boolean } = {}): InstantlyEmail {
    const address = (/<([^>]+)>/.exec(from)?.[1] ?? from).toLowerCase();
    const threadOf = options.inThreadOf?.toLowerCase() ?? address;
    const last = this.emails.filter((e) => e.ue_type === 1 && e.lead === threadOf).at(-1);
    const inbox = options.inbox ?? last?.eaccount ?? this.accounts[0]?.email ?? "";
    const withLead = options.withLead !== false && options.inThreadOf === undefined;
    const email: InstantlyEmail = {
      id: this.id("email"),
      timestamp_created: iso(this.now()),
      timestamp_email: iso(this.now()),
      from_address_email: from,
      to_address_email_list: inbox,
      campaign_id: withLead ? (last?.campaign_id ?? null) : null,
      lead: withLead ? address : null,
      lead_id: withLead ? (last?.lead_id ?? null) : null,
      eaccount: inbox,
      ue_type: 2,
      thread_id: options.onThread === false || !last ? this.id("thread") : last.thread_id,
    };
    this.emails.push(email);
    return email;
  }

  /** The user writes to a lead by hand from the Unibox: `ue_type` 3, "Sent", in the lead's thread. */
  manualSend(to: string): InstantlyEmail {
    const last = this.emails.filter((e) => e.ue_type === 1 && e.lead === to.toLowerCase()).at(-1);
    const email: InstantlyEmail = { ...(last ?? ({} as InstantlyEmail)), id: this.id("email"), timestamp_created: iso(this.now()), timestamp_email: iso(this.now()), ue_type: 3 };
    this.emails.push(email);
    return email;
  }

  /** Leads added to a campaign outside this test's handovers, so a campaign can hold thousands. */
  seedLeads(campaignId: string, count: number, status: LeadStatusCode = 3): InstantlyLead[] {
    const out: InstantlyLead[] = [];
    for (let i = 0; i < count; i++) {
      const l: FakeLead = { id: this.id("lead"), email: `seed-${String(i)}@seeded.example`, campaign: campaignId, status, verification_status: 0, addedAt: this.now(), variables: {}, sendAt: null, sentEmailId: null, deleted: false };
      this.leads.push(l);
      out.push(this.leadView(l));
    }
    return out;
  }

  /** A campaign created outside the adapter, such as an older one whose name contains a dispatch name. */
  seedCampaign(name: string): void {
    this.campaigns.push({ id: this.id("camp"), name, status: 0, timestamp_updated: iso(this.now()), settings: { name } as DispatchCampaignSettings });
  }

  /** A lead's status changes in Instantly (an unsubscribe, a late skip). */
  setLeadStatus(email: string, status: LeadStatusCode, verification: VerificationStatusCode | null = null): void {
    for (const l of this.leads) if (l.email === email.toLowerCase() && !l.deleted) Object.assign(l, { status, ...(verification === null ? {} : { verification_status: verification }) });
  }

  /** Sets one lead's status by id. */
  setLeadStatusById(id: string, status: LeadStatusCode): void {
    const l = this.leads.find((x) => x.id === id);
    if (l) l.status = status;
  }

  /** The start of the UTC day of `t`, for tests that cross a reset. */
  static dayStart(t: number): number {
    return Math.floor(t / DAY) * DAY;
  }
}
