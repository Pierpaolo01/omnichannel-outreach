import type { DatabaseSync } from "node:sqlite";
import { Crash, EngineHarness } from "./engine-harness.ts";
import { business, csvOf, person } from "./export-builder.ts";
import type { AccountScript, FakeSocialSession } from "./fake-social-port.ts";
import { random } from "./generated-sequences.ts";
import { dueAfter, inWindow, local, type Hours } from "./sequence-model.ts";
import type { Rules } from "../../src/server/engine/rules.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../src/domain/sequence/definition.ts";
import type { EnrollmentRead, LeadSearchResult } from "../../src/shared/api.ts";

/**
 * The generated runs of the message-request channels (ticket 25, ADR 0004 13.9), Instagram now. The real HTTP app, SQLite
 * store and engine run one or two campaigns with an Instagram track, and beside it or after it in a share of runs an email,
 * SMS or LinkedIn track, against the simulated Instagram provider and the fake email, SMS and LinkedIn providers. The record
 * below imports nothing from `src/domain/`: it keeps its own copy of each definition, the import's account cells, the bad
 * marks the provider's refusals make, the allowances, each lead's holds, the user's marks and stops, the pools, and the
 * providers' own logs, and from them, with its own calendar arithmetic (`sequence-model.ts`), predicts what M1 to M10 and
 * 29 require. Every account and person is fictitious. A run reports its problems, each prefixed with the invariant it breaks.
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const START = Date.parse("2026-11-02T08:00:00Z");
const ZONES = ["Europe/London", "America/New_York", "Australia/Sydney"] as const;
const SESSIONS = ["ig-a", "ig-b", "ig-c"] as const;
const SMS_NUMBER = "+447700900001";
const LI_SESSION = "li-mr";
const DAYSETS = [[1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5, 6], [1, 3, 5]] as const;
const HOURS = [[9, 17], [8, 12], [13, 18], [22, 2], [0, 24], [0, 24]] as const;
const ALWAYS: Hours[] = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));

export interface MessageRequestRunOptions {
  readonly rules?: Partial<Rules>;
  readonly maxWrites?: number;
  readonly maxTicks?: number;
  /** Invariant 29's comparison: 1 after every tick, N after every Nth tick and every tick that moved a conversation, 0 never. */
  readonly freshEvery?: number;
}

export interface MessageRequestRun {
  readonly problems: string[];
  readonly stats: { readonly features: Set<string>; readonly writes: number; readonly ticks: number };
}

/** The invariant a problem names ("M4: ..."). */
export const messageRequestInvariantsOf = (problem: string): string[] => [problem.split(":")[0] ?? ""];

/** The outreach statuses that end a lead in its campaign: nothing of it runs after them. */
const ENDED = new Set(["replied", "interested_on_call", "declined_on_call", "stopped_manually", "sequence_finished_no_response", "finished_no_usable_channel"]);
const iso = (at: number): string => (Number.isFinite(at) ? new Date(at).toISOString() : "never");
const pickOf = <T>(rnd: () => number, items: readonly T[]): T => items[Math.floor(rnd() * items.length)] as T;
const accountOf = (session: string) => `instagram:${session}`;
const sessionOf = (account: string) => account.replace(/^instagram:/, "");

/** The record's own reading of an Instagram cell (ADR 0004 13.4), written again here: a key, or null. */
function accountKey(raw: string): string | null {
  const m = /^\s*https?:\/\/(?:www\.|m\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:[?#].*)?\s*$/i.exec(raw);
  const name = m?.[1]?.toLowerCase();
  if (!name || name.startsWith(".") || name.endsWith(".") || ["p", "reel", "reels", "stories", "explore", "accounts", "direct", "tv", "about", "developer", "legal", "web"].includes(name)) return null;
  return `https://www.instagram.com/${name}`;
}

function windowOf(rnd: () => number): Hours[] {
  const days = pickOf(rnd, DAYSETS);
  const [start, end] = pickOf(rnd, HOURS);
  return days.map((day) => ({ day, start, end }));
}

interface Company {
  readonly id: string;
  readonly name: string;
  readonly cell: string;
}

interface Lead {
  readonly campaign: number;
  readonly name: string;
  readonly company: Company;
  /** A company lead: no person. */
  readonly companyLead: boolean;
  /** The person's own cell now (a re-import can change it); every earlier one is in `formerCells`, with when it changed. */
  ownCell: string;
  cellChanges: { at: number; cell: string }[];
  readonly email: string;
  readonly zone: string;
  id: string;
}

interface Campaign {
  id: string;
  readonly definition: CampaignDefinition;
  readonly ig: TrackDefinition;
  readonly email: TrackDefinition | null;
  readonly sms: TrackDefinition | null;
  readonly li: TrackDefinition | null;
}

export async function runMessageRequests(seed: number, options: MessageRequestRunOptions = {}): Promise<MessageRequestRun> {
  const rnd = random(seed);
  const rnd2 = random(seed * 11 + 5);
  const features = new Set<string>();
  const problems: string[] = [];
  const problem = (text: string) => {
    if (!problems.includes(text)) problems.push(text);
  };

  // --- The world.
  const sessions: FakeSocialSession[] = SESSIONS.slice(0, 1 + Math.floor(rnd() * 3)).map((id) => ({ id, kind: rnd() < 0.5 ? "personal" : "business", gapMs: pickOf(rnd, [5 * MIN, 30 * MIN]), k: 1, healthy: true, resetZone: "Europe/London" }));
  const allowance = new Map<string, number>(sessions.map((s) => [s.id, rnd() < 0.15 ? 0 : 1 + Math.floor(rnd() * 4)]));
  if ([...allowance.values()].some((a) => a === 0)) features.add("a-session-with-no-allowance");
  if (sessions.length >= 2) features.add("a-pool-of-several-sessions");
  if (new Set(sessions.map((s) => s.kind)).size === 2) features.add("sessions-of-both-kinds");
  const withLinkedin = rnd2() < 0.25;
  const h = new EngineHarness({
    start: START,
    accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    instagram: { sessions },
    sms: { numbers: [{ id: SMS_NUMBER, capacity: 20, gapMs: 5 * MIN, k: 1, healthy: true, resetZone: "Europe/London" }] },
    ...(withLinkedin ? { linkedin: { sessions: [{ id: LI_SESSION, gapMs: 5 * MIN, k: 1, healthy: true, resetZone: "Europe/London" }] } } : {}),
    ...(options.rules ? { rules: options.rules } : {}),
  });
  await h.tick();
  for (const [id, a] of allowance) {
    const r = await h.request("PUT", `/api/sender-accounts/${accountOf(id)}/allowances`, { invitesPerDay: 0, messagesPerDay: a, notesPerMonth: 0 });
    if (r.status !== 200) problem(`setup: allowance refused for ${id}`);
  }
  if (withLinkedin) await h.request("PUT", `/api/sender-accounts/linkedin:${LI_SESSION}/allowances`, { invitesPerDay: 10, messagesPerDay: 10, notesPerMonth: 0 });

  // Companies, shared by both campaigns: a company's account is one destination whoever's lead reaches it.
  const companies: Company[] = Array.from({ length: 2 + Math.floor(rnd() * 2) }, (_, i) => {
    const roll = rnd();
    const cell = roll < 0.65 ? `https://www.instagram.com/example_clinic_${seed}_${i}` : roll < 0.8 ? `https://www.instagram.com/p/EXAMPLE${i}` : "";
    return { id: `b${i}`, name: `Fictional Clinic ${i}`, cell };
  });
  const scripts = new Map<string, AccountScript>();
  const scriptFor = (key: string | null) => {
    if (key === null || scripts.has(key)) return;
    const b = rnd();
    const s: AccountScript = b < 0.07 ? { unreachable: true } : b < 0.14 ? { notAllowed: true } : b < 0.22 ? { rateLimited: 1 } : b < 0.32 ? { loseAnswer: 1 } : {};
    scripts.set(key, s);
    h.instagram.accountsScript.set(key, { ...s });
  };
  for (const c of companies) scriptFor(accountKey(c.cell));

  const campaigns: Campaign[] = [];
  const leads: Lead[] = [];
  const campaignCount = rnd() < 0.5 ? 1 : 2;
  let personNo = 0;
  for (let ci = 0; ci < campaignCount; ci++) {
    const messages = 1 + Math.floor(rnd() * 3);
    const steps: StepDefinition[] = Array.from({ length: messages }, (_, i) => ({ id: `c${ci}-m${i + 1}`, waitDays: i === 0 ? 0 : Math.floor(rnd() * 3), subject: "", body: `Message ${i + 1}, {{first_name|there}}.`, threading: "new_subject" as const, removed: false }));
    const ig: TrackDefinition = { id: `c${ci}-ig`, channel: "instagram", branch: "main", window: windowOf(rnd), steps, start: { kind: "entry" }, removed: false };
    const besideRoll = rnd();
    const after = rnd() < 0.5;
    const start = (): TrackDefinition["start"] => (after ? { kind: "after", trackId: ig.id, delayDays: 0 } : { kind: "entry" });
    const email: TrackDefinition | null = besideRoll < 0.4 ? { id: `c${ci}-em`, channel: "email", branch: "main", window: ALWAYS, steps: [{ id: `c${ci}-e1`, waitDays: 0, subject: "Hello {{first_name|there}}", body: "An email.", threading: "new_subject", removed: false }], start: start(), removed: false } : null;
    const sms: TrackDefinition | null = besideRoll >= 0.4 && besideRoll < 0.6 ? { id: `c${ci}-sms`, channel: "sms", branch: "main", window: ALWAYS, steps: [{ id: `c${ci}-t1`, waitDays: 0, subject: "", body: "A text.", threading: "new_subject", removed: false }], start: start(), removed: false } : null;
    const li: TrackDefinition | null = withLinkedin && ci === 0 ? { id: `c${ci}-li`, channel: "linkedin", branch: "main", window: ALWAYS, steps: [{ id: `c${ci}-inv`, waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false }, { id: `c${ci}-lm`, waitDays: 0, subject: "", body: "A LinkedIn message.", threading: "new_subject", removed: false }], start: { kind: "entry" }, removed: false, acceptWaitDays: 2 } : null;
    if (email) features.add(email.start.kind === "after" ? "email-after-instagram" : "email-beside-instagram");
    if (sms) features.add(sms.start.kind === "after" ? "sms-after-instagram" : "sms-beside-instagram");
    if (li) features.add("linkedin-beside-instagram");
    const pool = sessions.filter(() => rnd() < 0.7).map((s) => s.id);
    if (pool.length === 0) pool.push(sessions[0]!.id);
    const definition: CampaignDefinition = {
      timezone: "Europe/London",
      callSkipLimitDays: 2,
      emailPool: ["inbox-a"],
      smsPool: sms ? [SMS_NUMBER] : [],
      ...(li ? { linkedinPool: [`linkedin:${LI_SESSION}`] } : {}),
      // The user's chosen senders, on the Instagram track (ADR 0004 13.5).
      tracks: [{ ...ig, senders: pool.map(accountOf) }, ...(email ? [email] : []), ...(sms ? [sms] : []), ...(li ? [li] : [])],
    };
    campaigns.push({ id: "", definition, ig, email, sms, li });
    const people = 2 + Math.floor(rnd() * 4);
    for (let p = 0; p < people; p++) {
      personNo++;
      const company = pickOf(rnd, companies);
      const roll = rnd();
      const ownCell = roll < 0.4 ? `https://www.instagram.com/example_lead_${seed}_${personNo}` : roll < 0.5 ? "@not_a_url" : "";
      scriptFor(accountKey(ownCell));
      leads.push({ campaign: ci, name: `Lead${personNo} Fictional`, company, companyLead: false, ownCell, cellChanges: [], email: `lead${personNo}@fictional.example`, zone: pickOf(rnd, ZONES), id: "" });
    }
  }
  if (leads.filter((l) => l.ownCell === "").length >= 2 && new Set(leads.map((l) => `${l.campaign}|${l.company.id}`)).size < leads.length) features.add("two-leads-of-one-company");
  // A company with no decision maker in a campaign's import is enrolled as a company lead (ADR 0004 13.4: its own account).
  for (const [ci] of campaigns.entries()) {
    for (const company of companies) {
      if (leads.some((l) => l.campaign === ci && l.company.id === company.id)) continue;
      leads.push({ campaign: ci, name: company.name, company, companyLead: true, ownCell: "", cellChanges: [], email: "", zone: "Europe/London", id: "" });
      features.add("a-company-lead");
    }
  }
  if (campaigns.length === 2) features.add("two-campaigns");
  const personRow = (l: Lead, cell: string) => person({ person_id: `p-${l.name.replace(/\D/g, "")}`, business_id: l.company.id, full_name: l.name, email: l.email, timezone: l.zone, dial_phone: `+4477009${String(1000 + Number(/\d+/.exec(l.name)?.[0] ?? 0)).slice(-5)}`, dial_phone_type: "mobile", linkedin_url: `https://www.linkedin.com/in/fictional-mr-${seed}-${l.name.replace(/\D/g, "")}`, instagram: cell });
  const businessRow = (c: Company) => business({ business_id: c.id, business_name: c.name, phone_e164: `+4420794601${10 + Number(c.id.slice(1))}`, instagram: c.cell });
  for (const [ci, c] of campaigns.entries()) {
    const own = leads.filter((l) => l.campaign === ci && !l.companyLead);
    const companyIds = new Set(leads.filter((l) => l.campaign === ci).map((l) => l.company.id));
    const { campaign } = await h.createCampaign(`Instagram ${ci}`, { businesses: companies.filter((x) => companyIds.has(x.id)).map(businessRow), people: own.map((l) => personRow(l, l.ownCell)) });
    c.id = campaign.id;
    await h.defineSequence(c.id, c.definition);
    const launched = await h.launch(c.id);
    if (launched.status !== 200) problem(`setup: launch refused ${JSON.stringify(launched.body)}`);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
    for (const l of leads.filter((x) => x.campaign === ci)) l.id = rows.find((r) => r.name === l.name)?.enrollments.find((e) => e.campaign.id === c.id)?.id ?? "";
  }
  /** Each person's own cell through the run: as imported, then each re-import's. */
  const cellHistory = new Map<string, { at: number; cell: string }[]>(leads.map((l) => [l.name, [{ at: -Infinity, cell: l.ownCell }]]));
  // A lead the import did not enrol (no usable channel at all) is not in the run.
  for (const l of [...leads]) if (l.id === "") leads.splice(leads.indexOf(l), 1);
  const launchedAt = h.clock;

  const bounded = () => (options.maxWrites !== undefined && h.writes > options.maxWrites) || (options.maxTicks !== undefined && h.ticks > options.maxTicks);

  // --- The record's own log of what the user did.
  const held = new Map<string, { from: number; to: number | null }[]>();
  const campaignHeld = new Map<string, { from: number; to: number | null }[]>();
  /** Accepted marks and stops, each with the handover log's length at its instant: nothing of the subject after it. */
  const ended = new Map<string, { at: number; handovers: number; kind: "mark" | "stop" }>();
  const restarts = new Map<string, number>();
  const pools = new Map<number, { at: number; pool: readonly string[] }[]>(campaigns.map((c, i) => [i, [{ at: -Infinity, pool: (c.definition.tracks.find((t) => t.id === c.ig.id)?.senders ?? []).map(sessionOf) }]]));
  const poolAt = (ci: number, at: number) => (pools.get(ci) ?? []).filter((x) => x.at <= at).at(-1)?.pool ?? [];
  const crashedAttempts: string[] = [];
  const crashed: { subjectId: string; stepId: string; at: number }[] = [];
  const signedOut: { id: string; from: number; until: number; restored: number | null }[] = [];
  let edited = false;
  let requestNo = 0;
  const holdsOf = (l: Lead) => [...(held.get(l.id) ?? []), ...(campaignHeld.get(campaigns[l.campaign]!.id) ?? [])];

  // 29: right after each worker tick, a fresh engine at the same instant finds nothing to change and nothing to hand over.
  let draining = false;
  const freshEvery = options.freshEvery ?? 1;
  let ticksSinceFresh = 0;
  let conversationsSeen = "";
  const conversationsNow = () => {
    const row = (h.store.engine as unknown as { db: DatabaseSync }).db.prepare("SELECT COALESCE(SUM(seq), 0) AS s, COUNT(*) AS n FROM conversation_versions").get() as { s: number; n: number };
    return `${row.n}/${row.s}`;
  };
  const handoversNow = () => h.instagram.handoverLog.length + (h.smsProvider?.handoverLog.length ?? 0) + h.fake.handoverLog.length + (h.linkedinProvider?.handoverLog.length ?? 0);
  h.afterTick = async () => {
    if (draining || bounded() || problems.length > 0 || freshEvery === 0) return;
    ticksSinceFresh++;
    const conversations = conversationsNow();
    const moved = conversations !== conversationsSeen;
    conversationsSeen = conversations;
    if (freshEvery > 1 && !moved && ticksSinceFresh < freshEvery) return;
    ticksSinceFresh = 0;
    const before = handoversNow();
    const changed = await h.freshEngineTick();
    const more = handoversNow() - before;
    if (changed.length > 0 || more > 0) problem(`29: at ${iso(h.clock)} a fresh engine handed over ${more} and changed what the running worker had left: ${changed.join("; ").slice(0, 600)}`);
  };

  // --- Events.
  const end = START + 10 * DAY;
  while (h.clock < end && !bounded()) {
    await h.advanceTo(Math.min(end, h.clock + pickOf(rnd, [10 * MIN, 45 * MIN, 3 * H, 9 * H, DAY])));
    for (const s of signedOut) {
      if (s.until > h.clock || s.restored !== null) continue;
      h.instagram.sessions.get(s.id)!.healthy = true;
      s.restored = h.clock;
    }
    const roll = rnd();
    const lead = pickOf(rnd, leads);
    if (roll < 0.07 && !ended.has(lead.id)) {
      const holds = held.get(lead.id) ?? [];
      const open = holds.find((x) => x.to === null);
      await h.request("POST", `/api/enrollments/${lead.id}/controls`, { requestId: `g-${++requestNo}`, action: open ? "resume" : "pause" });
      if ((await leadPaused(lead.id)) === !open) {
        if (open) open.to = h.clock;
        else holds.push({ from: h.clock, to: null });
        held.set(lead.id, holds);
        features.add(open ? "a-lead-resumed" : "a-lead-paused");
      }
    } else if (roll < 0.14) {
      // The user marks an Instagram reply: refused when nothing reached the person there, or it is already marked.
      const before = h.instagram.handoverLog.length;
      const reached = reachedOnInstagram(lead);
      const r = await h.request("POST", `/api/enrollments/${lead.id}/replies`, { requestId: `g-${++requestNo}`, channel: "instagram" });
      const repliedNow = (await h.store.engine.subject(lead.id, h.clock))?.subject.ended === "replied";
      if (r.status === 200 || (repliedNow && ended.get(lead.id)?.kind !== "mark")) {
        if (!reached) problem(`M6: a reply was marked on ${lead.id} at ${iso(h.clock)}, which nothing reached on Instagram`);
        ended.set(lead.id, { at: h.clock, handovers: before, kind: "mark" });
        features.add("a-reply-marked");
      } else {
        if (reached && ended.get(lead.id)?.kind !== "mark" && (await h.store.engine.subject(lead.id, h.clock))?.subject.ended !== "interested_on_call") problem(`M6: the mark on ${lead.id} at ${iso(h.clock)} was refused, though a message reached them: ${JSON.stringify(r.body).slice(0, 200)}`);
        features.add("a-reply-mark-refused");
      }
    } else if (roll < 0.18) {
      await h.stopFor(pickOf(rnd, [2 * H, 14 * H, 2 * DAY]));
      features.add("the-laptop-was-off");
    }
    await extraEvent(rnd2());
    await check(false);
  }
  for (const s of signedOut) {
    h.instagram.sessions.get(s.id)!.healthy = true;
    s.restored ??= h.clock;
  }
  for (const c of campaigns) {
    const open = (campaignHeld.get(c.id) ?? []).find((x) => x.to === null);
    if (!open) continue;
    await h.request("POST", `/api/campaigns/${c.id}/resume`, { requestId: `g-${++requestNo}` });
    if (!(await campaignPaused(c.id))) open.to = h.clock;
  }
  draining = true;
  for (const l of leads) {
    const open = (held.get(l.id) ?? []).find((x) => x.to === null);
    if (!open) continue;
    await h.request("POST", `/api/enrollments/${l.id}/controls`, { requestId: `g-${++requestNo}`, action: "resume" });
    if (!(await leadPaused(l.id))) open.to = h.clock;
  }
  const drainEnd = h.clock + 20 * DAY;
  while (h.clock < drainEnd && !bounded()) {
    await h.advanceTo(Math.min(drainEnd, h.clock + DAY));
    await markUnresolved();
  }
  await check(true);
  return { problems, stats: { features, writes: h.writes, ticks: h.ticks } };

  async function campaignPaused(id: string): Promise<boolean> {
    return (await h.request<{ pause: { paused: boolean } }>("GET", `/api/campaigns/${id}`)).body.pause.paused;
  }

  async function leadPaused(id: string): Promise<boolean> {
    return (await h.store.engine.subject(id, h.clock))?.subject.leadPaused === true;
  }

  /** The user settles work a crash or a lost answer left unresolved, by what the provider did (ADR 0003 5.3). */
  async function markUnresolved(): Promise<void> {
    for (const l of leads) {
      const st = await h.store.engine.subject(l.id, h.clock);
      for (const w of st?.work ?? []) {
        if (w.settled !== null || w.unresolvedSince === null) continue;
        const a = st?.attempts.filter((x) => x.idempotencyKey === w.key).at(-1);
        if (!a) continue;
        const went = [h.instagram.deliveryLog, h.fake.deliveryLog, h.smsProvider?.deliveryLog ?? [], h.linkedinProvider?.deliveryLog ?? []].some((log) => log.some((d) => d.key === w.key));
        if (await h.engine.markAttempt(a.id, went ? "sent" : "not_sent")) features.add("unresolved-marked");
      }
    }
  }

  /** Whether the record knows something of this lead reached the person on Instagram: a delivery, or a call whose outcome is untold. */
  function reachedOnInstagram(lead: Lead): boolean {
    const refused = new Set(h.instagram.refusals.map((r) => r.key));
    return h.instagram.handoverLog.some((x) => x.subjectId === lead.id && !refused.has(x.key)) || crashed.some((x) => x.subjectId === lead.id && campaigns[lead.campaign]!.ig.steps.some((s) => s.id === x.stepId));
  }

  async function extraEvent(roll: number): Promise<void> {
    const lead = pickOf(rnd2, leads);
    const c = campaigns[lead.campaign]!;
    if (roll < 0.03 && !ended.has(lead.id)) {
      const before = h.instagram.handoverLog.length;
      const r = await h.request("POST", `/api/enrollments/${lead.id}/controls`, { requestId: `g-${++requestNo}`, action: "stop" });
      if (r.status === 200 || (await h.store.engine.subject(lead.id, h.clock))?.subject.ended === "stopped_manually") {
        ended.set(lead.id, { at: h.clock, handovers: before, kind: "stop" });
        features.add("a-lead-stopped");
      }
    } else if (roll < 0.05 && ended.has(lead.id)) {
      const r = await h.request("POST", `/api/enrollments/${lead.id}/controls`, { requestId: `g-${++requestNo}`, action: "resume_from_next_step" });
      if (r.status === 200) {
        ended.delete(lead.id);
        restarts.set(lead.id, h.clock);
        // A restart thaws the clock; the record no longer predicts this lead's timing.
        held.set(lead.id, [...(held.get(lead.id) ?? []), { from: launchedAt, to: h.clock }]);
        features.add("a-stopped-lead-restarted");
      }
    } else if (roll < 0.08) {
      const holds = campaignHeld.get(c.id) ?? [];
      const open = holds.find((x) => x.to === null);
      await h.request("POST", `/api/campaigns/${c.id}/${open ? "resume" : "pause"}`, { requestId: `g-${++requestNo}` });
      if ((await campaignPaused(c.id)) === !open) {
        if (open) open.to = h.clock;
        else holds.push({ from: h.clock, to: null });
        campaignHeld.set(c.id, holds);
        features.add(open ? "a-campaign-resumed" : "a-campaign-paused");
      }
    } else if (roll < 0.12) {
      const r = await h.request("POST", `/api/enrollments/${lead.id}/controls`, { requestId: `g-${++requestNo}`, action: "skip" });
      if (r.status === 200) {
        features.add("a-skip");
        held.set(lead.id, [...(held.get(lead.id) ?? []), { from: launchedAt, to: h.clock }]);
      }
    } else if (roll < 0.14) {
      const s = pickOf(rnd2, sessions);
      h.instagram.sessions.get(s.id)!.healthy = false;
      signedOut.push({ id: s.id, from: h.clock, until: h.clock + pickOf(rnd2, [H, 8 * H]), restored: null });
      features.add("a-session-signed-out");
    } else if (roll < 0.16) {
      let armed = true;
      h.hooks.crashPoint = (point, attemptId) => {
        if (armed && point === "after_handover_commit") {
          armed = false;
          if (attemptId) crashedAttempts.push(attemptId);
          features.add("a-crash-between-the-handover-and-its-answer");
          throw new Crash(point);
        }
      };
    } else if (roll < 0.19) {
      // A running edit of the Instagram track: a message inserted, removed, or two reordered.
      const stored = (await h.request<{ definition: CampaignDefinition }>("GET", `/api/campaigns/${c.id}/sequence`)).body.definition;
      const kind = pickOf(rnd2, ["insert", "remove", "reorder"] as const);
      const tracks = stored.tracks.map((t) => {
        if (t.id !== c.ig.id) return t;
        const live = t.steps.filter((x) => !x.removed);
        if (kind === "insert") return { ...t, steps: [...t.steps, { id: `${t.id}-x${requestNo}`, waitDays: Math.floor(rnd2() * 2), subject: "", body: "An added message.", threading: "new_subject" as const, removed: false }] };
        if (kind === "remove" && live.length > 1) {
          const gone = live[1 + Math.floor(rnd2() * (live.length - 1))]!.id;
          return { ...t, steps: t.steps.map((x) => (x.id === gone ? { ...x, removed: true } : x)) };
        }
        if (kind === "reorder" && live.length > 2) {
          const [a, b, x, ...rest] = t.steps;
          return a && b && x ? { ...t, steps: [a, x, b, ...rest] } : t;
        }
        return t;
      });
      const r = await h.request("PUT", `/api/campaigns/${c.id}/sequence`, { ...stored, tracks });
      if (r.status === 200) {
        edited = true;
        features.add(`a-running-edit:${kind}`);
      }
    } else if (roll < 0.21 && sessions.length > 1) {
      // A sender edit: a session added to or removed from the Instagram track's chosen senders.
      const stored = (await h.request<{ definition: CampaignDefinition }>("GET", `/api/campaigns/${c.id}/sequence`)).body.definition;
      const now = poolAt(lead.campaign, h.clock);
      const s = pickOf(rnd2, sessions).id;
      const next = now.includes(s) ? (now.length > 1 ? now.filter((x) => x !== s) : now) : [...now, s];
      if (next === now) return;
      const r = await h.request("PUT", `/api/campaigns/${c.id}/sequence`, { ...stored, tracks: stored.tracks.map((t) => (t.id === c.ig.id ? { ...t, senders: next.map(accountOf) } : t)) });
      if (r.status === 200) {
        pools.set(lead.campaign, [...(pools.get(lead.campaign) ?? []), { at: h.clock, pool: next }]);
        features.add(next.length > now.length ? "a-session-added-to-a-pool" : "a-session-removed-from-a-pool");
      }
    } else if (roll < 0.23 && !lead.companyLead) {
      // A re-import gives the person another own account, or empties it. Half of them go to a person whose Instagram track
      // has started (a message handed over, by the provider's log), so a started track meets a replaced account (the
      // review of f2824d4, item 8): it must be skipped, never retargeted.
      const started = leads.filter((l) => !l.companyLead && reachedOnInstagram(l));
      const target = started.length > 0 && rnd2() < 0.5 ? pickOf(rnd2, started) : lead;
      const tc = campaigns[target.campaign]!;
      const cell = rnd2() < 0.7 ? `https://www.instagram.com/example_lead_${seed}_${target.name.replace(/\D/g, "")}_v${requestNo}` : "";
      scriptFor(accountKey(cell));
      const r = await h.request("POST", `/api/campaigns/${tc.id}/imports`, csvOf({ businesses: [businessRow(target.company)], people: [personRow(target, cell)] }));
      if (r.status === 201) {
        target.cellChanges.push({ at: h.clock, cell });
        target.ownCell = cell;
        cellHistory.set(target.name, [...(cellHistory.get(target.name) ?? []), { at: h.clock, cell }]);
        features.add("an-account-changed-by-a-reimport");
        if (target !== lead) features.add("a-started-track-whose-account-a-reimport-replaced");
      }
    }
  }

  // --- The checks, from the record and the providers' logs.
  async function check(drained: boolean): Promise<void> {
    const ig = h.instagram;
    while (crashed.length < crashedAttempts.length) {
      const a = await h.store.engine.attempt(crashedAttempts[crashed.length]!);
      crashed.push({ subjectId: a?.subjectId ?? "", stepId: a?.stepId ?? "", at: h.clock });
    }
    const refusedKeys = new Map(ig.refusals.map((r) => [r.key, r.reason]));
    const lostKeys = new Set(ig.deliveryLog.filter((d) => d.visibleAt === Infinity).map((d) => d.key));
    const leadOf = (id: string) => leads.find((l) => l.id === id);
    const igTrackOf = (l: Lead) => campaigns[l.campaign]!.ig;

    // The bad marks, by the record: an account the session refused as unreachable, from that refusal on, by the position of
    // the refused handover in the provider's log (two calls can share an instant; the mark comes after its own call).
    const indexOfKey = new Map<string, number>();
    ig.handoverLog.forEach((x, i) => indexOfKey.set(x.key, i));
    const markedBadAt = new Map<string, { at: number; index: number }>();
    for (const r of ig.refusals) if (r.reason === "invalid_destination" && !markedBadAt.has(r.destination)) markedBadAt.set(r.destination, { at: r.at, index: indexOfKey.get(r.key) ?? -1 });
    /** The lead's own cell at an instant, through the re-imports (every lead of that person shares one history). */
    const ownCellAt = (l: Lead, at: number) => (cellHistory.get(l.name) ?? []).filter((x) => x.at <= at).at(-1)?.cell ?? "";
    /**
     * The destination by the record's rule (ADR 0004 13.4) at an instant, as a handover at log position `before` sees it: the
     * person's own usable account, else the company's. A mark counts once its refused call came before that position.
     */
    const destinationAt = (l: Lead, at: number, before: number): string | null => {
      const usable = (key: string | null) => {
        const mark = key === null ? undefined : markedBadAt.get(key);
        return key !== null && (mark === undefined || mark.at > at || mark.index >= before);
      };
      const own = l.companyLead ? null : accountKey(ownCellAt(l, at));
      if (usable(own)) return own;
      const company = accountKey(l.company.cell);
      return usable(company) ? company : null;
    };

    for (const x of ig.handoverLog) {
      const l = leadOf(x.subjectId);
      if (!l) continue;
      const track = igTrackOf(l);
      // M8: its own channel, its own track; the first from a session the track chose at that instant; every later one from that
      // same session, chosen still or not (a fixed sender is never reassigned, ADR 0003 1.3, as on LinkedIn).
      if (x.trackId !== track.id || x.action !== "message") problem(`M8: an Instagram handover for ${x.subjectId} at ${iso(x.at)} is not a message of its Instagram track (${x.trackId}, ${x.action})`);
      const mine = ig.handoverLog.filter((y) => y.subjectId === x.subjectId);
      const first = mine[0]!;
      if (x === first && !poolAt(l.campaign, x.at).includes(x.sender)) problem(`M8: ${x.subjectId}'s first Instagram message at ${iso(x.at)} went from ${x.sender}, not in its campaign's pool ${poolAt(l.campaign, x.at).join(",")}`);
      if (x !== first && x.sender !== first.sender) problem(`M8: ${x.subjectId}'s Instagram message at ${iso(x.at)} went from ${x.sender}, after its first from ${first.sender}`);
      // M2: the destination the record derives, at an instant between launch and the handover; never one marked bad before it.
      const position = ig.handoverLog.indexOf(x);
      const bad = markedBadAt.get(x.destination);
      if (bad !== undefined && bad.index < position) problem(`M2: ${x.subjectId}'s Instagram message at ${iso(x.at)} went to ${x.destination}, marked bad at ${iso(bad.at)}`);
      // The destination is fixed at the track's start, which the record models as the launch (the Instagram track starts at
      // entry), and every message of the track goes there: a re-import that replaces it skips the track, never retargets it
      // (ADR 0004 13.4; the review of f2824d4, item 8). No mark can precede the launch, so none is counted at it.
      const pinned = destinationAt(l, launchedAt, 0);
      if (x.destination !== pinned) problem(`M2: ${x.subjectId}'s Instagram message at ${iso(x.at)} went to ${x.destination}; its track started at ${iso(launchedAt)} on ${pinned ?? "no account"}`);
      // M3: nothing after an accepted mark or a stop, until a restart after it.
      const stop = ended.get(x.subjectId);
      if (stop && ig.handoverLog.indexOf(x) >= stop.handovers) problem(`M3: ${x.subjectId} was handed an Instagram message at ${iso(x.at)}, after its ${stop.kind} at ${iso(stop.at)}`);
    }
    for (const log of [h.fake.handoverLog, h.smsProvider?.handoverLog ?? []]) {
      for (const x of log) {
        const stop = ended.get(x.subjectId);
        if (stop && x.at > stop.at + MIN) problem(`M3: ${x.subjectId} was handed a message on another channel at ${iso(x.at)}, after its ${stop.kind} at ${iso(stop.at)}`);
      }
    }
    // M1: each step delivered at most once; a step whose answer was lost is never handed over again.
    const bySubjectStep = new Map<string, number>();
    for (const d of ig.deliveryLog) bySubjectStep.set(`${d.subjectId}|${d.stepId}`, (bySubjectStep.get(`${d.subjectId}|${d.stepId}`) ?? 0) + 1);
    for (const [k, n] of bySubjectStep) if (n > 1) problem(`M1: ${k} was delivered ${n} times on Instagram`);
    for (const x of ig.handoverLog) {
      if (!lostKeys.has(x.key)) continue;
      const later = ig.handoverLog.find((y) => y.subjectId === x.subjectId && y.stepId === x.stepId && y.at >= x.at && y !== x);
      if (later) problem(`M1: ${x.subjectId}'s step ${x.stepId}, whose answer was lost at ${iso(x.at)}, was handed over again at ${iso(later.at)}`);
    }
    // M4: per session and reset day (London), messages delivered never exceed its allowance.
    const perDay = new Map<string, number>();
    for (const d of ig.deliveryLog) {
      const k = `${d.sender}|${local(d.at, "Europe/London").day}`;
      perDay.set(k, (perDay.get(k) ?? 0) + 1);
    }
    for (const [k, n] of perDay) {
      const a = allowance.get(k.split("|")[0]!) ?? 0;
      if (n > a) problem(`M4: ${k} delivered ${n} Instagram messages, over its allowance of ${a}`);
    }
    // M5: every message to a (session, account) belongs to the first subject that reached it, until all its work there was refused.
    const owner = new Map<string, string>();
    for (const x of ig.handoverLog) {
      const pair = `${x.sender}|${x.destination}`;
      const was = owner.get(pair);
      if (was !== undefined && was !== x.subjectId) {
        const wasAll = ig.handoverLog.filter((y) => y.subjectId === was && `${y.sender}|${y.destination}` === pair && y.at <= x.at);
        const released = wasAll.length > 0 && wasAll.every((y) => refusedKeys.has(y.key)) && !crashed.some((c) => c.subjectId === was);
        if (!released) problem(`M5: ${x.subjectId} was handed a message to ${x.destination} from ${x.sender} at ${iso(x.at)}, a pair ${was} owns`);
        else owner.set(pair, x.subjectId);
      } else if (was === undefined) owner.set(pair, x.subjectId);
    }
    if (ig.refusals.some((r) => r.reason === "invalid_destination")) features.add("an-account-marked-bad");
    if (ig.refusals.some((r) => r.reason === "not_allowed")) features.add("a-message-not-allowed");
    if (ig.refusals.some((r) => r.reason === "rate_limited")) features.add("a-rate-limit");
    if (lostKeys.size > 0 && ig.lookupLog.some((x) => x.answer === "sent")) features.add("a-lost-answer-found-by-lookup");
    if (ig.handoverLog.some((x) => ig.handoverLog.some((y) => y.destination === x.destination && y.subjectId !== x.subjectId))) features.add("one-account-reached-for-two-subjects");
    // M10: when a session's day was full, a follow-up due before a first message that took a slot that day never went later.
    if (!edited) {
      for (const [k, n] of perDay) {
        const [sender, dayText] = k.split("|");
        const day = Number(dayText);
        if (n < (allowance.get(sender!) ?? 0)) continue;
        const firsts = ig.deliveryLog.filter((d) => d.sender === sender && local(d.at, "Europe/London").day === day && stepIndex(d.subjectId, d.stepId) === 0);
        for (const f of firsts) {
          for (const g of ig.deliveryLog.filter((d) => d.sender === sender && local(d.at, "Europe/London").day > day && stepIndex(d.subjectId, d.stepId) > 0)) {
            const l = leadOf(g.subjectId);
            if (!l || holdsOf(l).length > 0 || restarts.has(l.id)) continue;
            const prev = ig.deliveryLog.filter((d) => d.subjectId === g.subjectId && d.at < g.at).at(-1);
            if (!prev || prev.visibleAt === Infinity) continue;
            const step = igTrackOf(l).steps.find((s) => s.id === g.stepId);
            if (!step) continue;
            const due = dueAfter(prev.at, step.waitDays, l.zone);
            // The first message was claimed at most a pacing gap before it went: the follow-up must have been due before that.
            const gap = sessions.find((x) => x.id === sender)?.gapMs ?? 0;
            const claimedBy = f.at - gap - MIN;
            if (due <= claimedBy && inWindow(igTrackOf(l).window, l.zone, f.at) && inWindow(igTrackOf(l).window, l.zone, claimedBy) && !signedOut.some((o) => o.id === sender && o.from <= f.at && f.at < (o.restored ?? Infinity))) {
              problem(`M10: on ${sender}'s full day ${iso(f.at)} a first message to ${f.subjectId} went before ${g.subjectId}'s follow-up ${g.stepId}, due ${iso(due)}, which went only at ${iso(g.at)}`);
              features.add("a-contested-slot");
            }
          }
        }
      }
    }
    if (!drained) return;
    // M7 and M9, after the drain: nothing pending for ever, and the other tracks carried on.
    for (const l of leads) {
      if (ended.has(l.id)) continue;
      const read = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${l.id}`)).body;
      const track = read.tracks.find((t) => t.trackId === igTrackOf(l).id);
      // M9: an email track at entry, or after an Instagram track that finished, sent its email, whatever the lead's status:
      // the record stopped and marked no such lead, and no other ending can come before its email.
      const em = campaigns[l.campaign]!.email;
      if (em && l.email !== "" && !restarts.has(l.id)) {
        const igFinished = track?.finishedAt !== null;
        const due = em.start.kind === "entry" || igFinished;
        if (due && !h.fake.deliveryLog.some((d) => d.subjectId === l.id)) problem(`M9: ${l.id}'s email track (${em.start.kind}) sent nothing after the drain, its Instagram track ${track?.finishReason ?? "unfinished"}, status ${read.status}`);
      }
      if (ENDED.has(read.status)) continue;
      if (track && track.finishedAt === null && track.started) {
        // The sessions dispatch may use, by the record (ADR 0004 6, 13.6): the fixed one, else the pool less every session
        // whose pair with the lead's destination another subject owns.
        const sender = ig.handoverLog.find((x) => x.subjectId === l.id)?.sender;
        const destination = destinationAt(l, h.clock, ig.handoverLog.length);
        const eligible = sender ? [sender] : poolAt(l.campaign, h.clock).filter((s) => { const o = owner.get(`${s}|${destination}`); return o === undefined || o === l.id; });
        const zero = eligible.every((s) => (allowance.get(s) ?? 0) === 0);
        const why = track.nextStep?.when.kind === "waits" ? track.nextStep.when.why : track.nextStep?.when.kind ?? "none";
        if (zero && why === "no_allowance") features.add("a-step-waiting-on-a-zero-allowance");
        else if (!(zero && why === "no_allowance") && why !== "lead_paused" && why !== "callback") {
          problem(`M7: after the drain ${l.id}'s Instagram track is still pending (${why}, status ${read.status}); the record's eligible sessions ${eligible.join(",")} ${zero ? "allow none, so it must read no_allowance" : "have room"}`);
        }
      }
    }
  }

  function stepIndex(subjectId: string, stepId: string): number {
    const l = leads.find((x) => x.id === subjectId);
    return l ? campaigns[l.campaign]!.ig.steps.findIndex((s) => s.id === stepId) : -1;
  }
}

