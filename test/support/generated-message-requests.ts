import type { DatabaseSync } from "node:sqlite";
import { Crash, EngineHarness } from "./engine-harness.ts";
import { business, csvOf, person } from "./export-builder.ts";
import type { AccountScript, FakeSocialPort, FakeSocialSession } from "./fake-social-port.ts";
import { random } from "./generated-sequences.ts";
import { dueAfter, inWindow, local, type Hours } from "./sequence-model.ts";
import type { Rules } from "../../src/server/engine/rules.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../src/domain/sequence/definition.ts";
import type { EnrollmentRead, LeadSearchResult } from "../../src/shared/api.ts";

/**
 * The generated runs of the message-request channels (ADR 0004 13.9; parameterised by channel in ticket 26, 14.7). The real
 * HTTP app, SQLite store and engine run one or two campaigns against the simulated providers of Instagram, of Facebook, or
 * of both at once (each campaign then has a track on each), and beside or after the first of them in a share of runs an
 * email, SMS or LinkedIn track, against the fake email, SMS and LinkedIn providers. Each channel drawn is a **lane**: its own
 * sessions (the same session ids on both channels, so an id read without its channel would collide), allowances, account
 * cells, scripts, tracks, chosen senders and provider logs. The record below imports nothing from `src/domain/`: it keeps
 * its own copy of each definition, its own reading of each channel's account cells, the bad marks the providers' refusals
 * make, the allowances, each lead's holds, the user's marks and stops, the pools, and the providers' own logs, and from them,
 * with its own calendar arithmetic (`sequence-model.ts`), predicts what M1 to M10 and 29 require on every lane. Every
 * account and person is fictitious. A run reports its problems, each prefixed with the invariant it breaks.
 *
 * The first lane draws from the run's main stream exactly as the Instagram-only runs of ticket 25 did, so a seed drawn
 * with one channel is that same world under the channel's names; a second lane draws from streams of its own.
 */

/** The record's own list of the message-request channels: a channel the app gains is added here by hand. */
export type RunChannel = "instagram" | "facebook";
export const RUN_CHANNELS: readonly RunChannel[] = ["instagram", "facebook"];

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const START = Date.parse("2026-11-02T08:00:00Z");
const ZONES = ["Europe/London", "America/New_York", "Australia/Sydney"] as const;
/** The same session ids on every lane: the app's account ids carry the channel; the providers' do not. */
const SESSIONS = ["s-a", "s-b", "s-c"] as const;
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
  /** The lanes, the first drawing from the main stream; drawn from the seed when absent (one channel, the other, or both). */
  readonly channels?: readonly RunChannel[];
}

export interface MessageRequestRun {
  readonly problems: string[];
  readonly stats: { readonly features: Set<string>; readonly writes: number; readonly ticks: number; readonly channels: readonly RunChannel[] };
}

/** The invariant a problem names ("M4: ..."). */
export const messageRequestInvariantsOf = (problem: string): string[] => [problem.split(":")[0] ?? ""];

/** The outreach statuses that end a lead in its campaign: nothing of it runs after them. */
const ENDED = new Set(["replied", "interested_on_call", "declined_on_call", "stopped_manually", "sequence_finished_no_response", "finished_no_usable_channel"]);
const iso = (at: number): string => (Number.isFinite(at) ? new Date(at).toISOString() : "never");
const pickOf = <T>(rnd: () => number, items: readonly T[]): T => items[Math.floor(rnd() * items.length)] as T;

/**
 * Each channel's forms, written here by hand: its name in problems, its CSV column, the cells the generator writes (an
 * account, an address that is not one, a person's own), and the record's own reading of a cell (ADR 0004 13.4, 14.3).
 */
interface ChannelForms {
  readonly name: string;
  /** Its short name in track and step ids: `c0-ig`, `c0-fb-m1`. */
  readonly short: string;
  readonly column: string;
  /** A company's account; on Facebook every other company has a Page with no username (`profile.php?id=`). */
  readonly companyCell: (seed: number, i: number) => string;
  /** A company cell that is an address on the site but not an account. */
  readonly notAnAccount: (i: number) => string;
  /** A person's own account, the `v`th version a re-import gives. */
  readonly ownCell: (seed: number, person: string, v?: number) => string;
  readonly accountKey: (raw: string) => string | null;
}

const FORMS: { readonly [C in RunChannel]: ChannelForms } = {
  instagram: {
    name: "Instagram",
    short: "ig",
    column: "instagram",
    companyCell: (seed, i) => `https://www.instagram.com/example_clinic_${seed}_${i}`,
    notAnAccount: (i) => `https://www.instagram.com/p/EXAMPLE${i}`,
    ownCell: (seed, p, v) => `https://www.instagram.com/example_lead_${seed}_${p}${v === undefined ? "" : `_v${v}`}`,
    accountKey: (raw) => {
      const m = /^\s*https?:\/\/(?:www\.|m\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:[?#].*)?\s*$/i.exec(raw);
      const name = m?.[1]?.toLowerCase();
      if (!name || name.startsWith(".") || name.endsWith(".") || ["p", "reel", "reels", "stories", "explore", "accounts", "direct", "tv", "about", "developer", "legal", "web"].includes(name)) return null;
      return `https://www.instagram.com/${name}`;
    },
  },
  facebook: {
    name: "Facebook",
    short: "fb",
    column: "facebook",
    companyCell: (seed, i) => (i % 2 === 1 ? `https://www.facebook.com/profile.php?id=${9_000_000 + seed * 10 + i}` : `https://www.facebook.com/Example.Clinic.${seed}.${i}/`),
    notAnAccount: (i) => `https://www.facebook.com/groups/example${i}`,
    ownCell: (seed, p, v) => `https://m.facebook.com/example.lead.${seed}.${p}${v === undefined ? "" : `.v${v}`}`,
    accountKey: (raw) => {
      const id = /^\s*https?:\/\/(?:www\.|m\.|web\.)?facebook\.com\/profile\.php\?(?:[^#]*&)?id=(\d+)(?:[&#].*)?\s*$/i.exec(raw)?.[1];
      if (id !== undefined) return `https://www.facebook.com/profile.php?id=${id}`;
      const m = /^\s*https?:\/\/(?:www\.|m\.|web\.)?facebook\.com\/([A-Za-z0-9.-]{1,100})\/?(?:[?#].*)?\s*$/i.exec(raw);
      const name = m?.[1]?.toLowerCase();
      if (!name || name.startsWith(".") || name.endsWith(".") || name.endsWith(".php") || ["groups", "events", "pages", "people", "watch", "marketplace", "login", "share", "sharer", "profile"].includes(name)) return null;
      // Facebook ignores a username's periods: one account however it is dotted.
      return `https://www.facebook.com/${name.split(".").join("")}`;
    },
  },
};

function windowOf(rnd: () => number): Hours[] {
  const days = pickOf(rnd, DAYSETS);
  const [start, end] = pickOf(rnd, HOURS);
  return days.map((day) => ({ day, start, end }));
}

interface Lane {
  readonly channel: RunChannel;
  readonly forms: ChannelForms;
  /** The stream this lane's own draws come from: the run's main one for the first lane. */
  readonly rnd: () => number;
  /** The stream of its second tracks. */
  readonly twoRnd: () => number;
  readonly sessions: FakeSocialSession[];
  readonly allowance: Map<string, number>;
  readonly scripts: Map<string, AccountScript>;
  provider: FakeSocialPort | null;
}

interface Company {
  readonly id: string;
  readonly name: string;
  /** Its account cell on each lane. */
  readonly cells: Partial<Record<RunChannel, string>>;
}

interface Lead {
  readonly campaign: number;
  readonly name: string;
  readonly company: Company;
  /** A company lead: no person. */
  readonly companyLead: boolean;
  /** The person's own cell on each lane now (a re-import can change it); the history is in `cellHistory`. */
  readonly ownCells: Partial<Record<RunChannel, string>>;
  readonly email: string;
  readonly zone: string;
  id: string;
}

/** A campaign's tracks on one lane. */
interface LaneTracks {
  readonly t1: TrackDefinition;
  /**
   * A second track of the channel beside the first, in half the runs, choosing other sessions (the review bot on 0922582):
   * each track sends from its own choice, fixed at its own first handover. Its choice is never edited.
   */
  readonly t2: TrackDefinition | null;
}

interface Campaign {
  id: string;
  readonly definition: CampaignDefinition;
  readonly lanes: Map<RunChannel, LaneTracks>;
  readonly email: TrackDefinition | null;
  readonly sms: TrackDefinition | null;
  readonly li: TrackDefinition | null;
}

/** The lanes a seed draws, from a stream of its own: one channel alone, the other alone, or both (the first drawn first). */
export function channelsOf(seed: number): readonly RunChannel[] {
  const r = random(seed ^ 0x26c4);
  const roll = r();
  if (roll < 1 / 3) return ["instagram"];
  if (roll < 2 / 3) return ["facebook"];
  return r() < 0.5 ? ["instagram", "facebook"] : ["facebook", "instagram"];
}

export async function runMessageRequests(seed: number, options: MessageRequestRunOptions = {}): Promise<MessageRequestRun> {
  const rnd = random(seed);
  const rnd2 = random(seed * 11 + 5);
  /** Which lane an event acts on, when there are two: a stream of its own, so the other draws are unchanged. */
  const laneRnd = random(seed ^ 0x1a7e);
  const features = new Set<string>();
  const problems: string[] = [];
  const problem = (text: string) => {
    if (!problems.includes(text)) problems.push(text);
  };
  const channels = options.channels ?? channelsOf(seed);
  features.add(channels.length === 2 ? "instagram-and-facebook-in-one-campaign" : `${channels[0]}-alone`);
  /** A behaviour on one lane, named with its channel. */
  const laneFeature = (lane: Lane, name: string) => features.add(`${lane.channel}:${name}`);

  // --- The world. The first lane draws from the main stream, in the order ticket 25's runs did; a second from its own.
  const lanes: Lane[] = channels.map((channel, i) => ({
    channel,
    forms: FORMS[channel],
    rnd: i === 0 ? rnd : random(seed ^ 0xfb26),
    twoRnd: i === 0 ? random(seed ^ 0x1912) : random(seed ^ 0x2912),
    sessions: [],
    allowance: new Map(),
    scripts: new Map(),
    provider: null,
  }));
  const primary = lanes[0]!;
  const accountOf = (lane: Lane, session: string) => `${lane.channel}:${session}`;
  const sessionOf = (account: string) => account.replace(/^[a-z]+:/, "");
  for (const lane of lanes) {
    const r = lane.rnd;
    lane.sessions.push(...SESSIONS.slice(0, 1 + Math.floor(r() * 3)).map((id) => ({ id, kind: r() < 0.5 ? ("personal" as const) : ("business" as const), gapMs: pickOf(r, [5 * MIN, 30 * MIN]), k: 1, healthy: true, resetZone: "Europe/London" })));
    for (const s of lane.sessions) lane.allowance.set(s.id, r() < 0.15 ? 0 : 1 + Math.floor(r() * 4));
    if ([...lane.allowance.values()].some((a) => a === 0)) laneFeature(lane, "a-session-with-no-allowance");
    if (lane.sessions.length >= 2) laneFeature(lane, "a-pool-of-several-sessions");
    if (new Set(lane.sessions.map((s) => s.kind)).size === 2) laneFeature(lane, "sessions-of-both-kinds");
  }
  const withLinkedin = rnd2() < 0.25;
  const h = new EngineHarness({
    start: START,
    accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    social: Object.fromEntries(lanes.map((lane) => [lane.channel, { sessions: lane.sessions }])),
    sms: { numbers: [{ id: SMS_NUMBER, capacity: 20, gapMs: 5 * MIN, k: 1, healthy: true, resetZone: "Europe/London" }] },
    ...(withLinkedin ? { linkedin: { sessions: [{ id: LI_SESSION, gapMs: 5 * MIN, k: 1, healthy: true, resetZone: "Europe/London" }] } } : {}),
    ...(options.rules ? { rules: options.rules } : {}),
  });
  for (const lane of lanes) lane.provider = h.social(lane.channel);
  const portOf = (lane: Lane): FakeSocialPort => lane.provider!;
  await h.tick();
  for (const lane of lanes) {
    for (const [id, a] of lane.allowance) {
      const r = await h.request("PUT", `/api/sender-accounts/${accountOf(lane, id)}/allowances`, { invitesPerDay: 0, messagesPerDay: a, notesPerMonth: 0 });
      if (r.status !== 200) problem(`setup: allowance refused for ${lane.channel} ${id}`);
    }
  }
  if (withLinkedin) await h.request("PUT", `/api/sender-accounts/linkedin:${LI_SESSION}/allowances`, { invitesPerDay: 10, messagesPerDay: 10, notesPerMonth: 0 });

  // Companies, shared by both campaigns: a company's account is one destination whoever's lead reaches it.
  const companies: Company[] = Array.from({ length: 2 + Math.floor(rnd() * 2) }, (_, i) => {
    const cells: Partial<Record<RunChannel, string>> = {};
    for (const lane of lanes) {
      const roll = lane.rnd();
      cells[lane.channel] = roll < 0.65 ? lane.forms.companyCell(seed, i) : roll < 0.8 ? lane.forms.notAnAccount(i) : "";
    }
    return { id: `b${i}`, name: `Fictional Clinic ${i}`, cells };
  });
  const scriptFor = (lane: Lane, key: string | null) => {
    if (key === null || lane.scripts.has(key)) return;
    const b = lane.rnd();
    const s: AccountScript = b < 0.07 ? { unreachable: true } : b < 0.14 ? { notAllowed: true } : b < 0.22 ? { rateLimited: 1 } : b < 0.32 ? { loseAnswer: 1 } : {};
    lane.scripts.set(key, s);
    portOf(lane).accountsScript.set(key, { ...s });
  };
  for (const lane of lanes) for (const c of companies) scriptFor(lane, lane.forms.accountKey(c.cells[lane.channel] ?? ""));

  const campaigns: Campaign[] = [];
  const leads: Lead[] = [];
  const campaignCount = rnd() < 0.5 ? 1 : 2;
  let personNo = 0;
  for (let ci = 0; ci < campaignCount; ci++) {
    // Each lane's first track: its messages, their waits and its window.
    const firsts = new Map<RunChannel, TrackDefinition>();
    for (const lane of lanes) {
      const r = lane.rnd;
      const prefix = lane === primary ? `c${ci}` : `c${ci}-${lane.forms.short}`;
      const messages = 1 + Math.floor(r() * 3);
      const steps: StepDefinition[] = Array.from({ length: messages }, (_, i) => ({ id: `${prefix}-m${i + 1}`, waitDays: i === 0 ? 0 : Math.floor(r() * 3), subject: "", body: `Message ${i + 1}, {{first_name|there}}.`, threading: "new_subject" as const, removed: false }));
      firsts.set(lane.channel, { id: `${prefix}-${lane.forms.short}`, channel: lane.channel, branch: "main", window: windowOf(r), steps, start: { kind: "entry" }, removed: false });
    }
    const t1 = firsts.get(primary.channel)!;
    const besideRoll = rnd();
    const after = rnd() < 0.5;
    const start = (): TrackDefinition["start"] => (after ? { kind: "after", trackId: t1.id, delayDays: 0 } : { kind: "entry" });
    const email: TrackDefinition | null = besideRoll < 0.4 ? { id: `c${ci}-em`, channel: "email", branch: "main", window: ALWAYS, steps: [{ id: `c${ci}-e1`, waitDays: 0, subject: "Hello {{first_name|there}}", body: "An email.", threading: "new_subject", removed: false }], start: start(), removed: false } : null;
    const sms: TrackDefinition | null = besideRoll >= 0.4 && besideRoll < 0.6 ? { id: `c${ci}-sms`, channel: "sms", branch: "main", window: ALWAYS, steps: [{ id: `c${ci}-t1`, waitDays: 0, subject: "", body: "A text.", threading: "new_subject", removed: false }], start: start(), removed: false } : null;
    const li: TrackDefinition | null = withLinkedin && ci === 0 ? { id: `c${ci}-li`, channel: "linkedin", branch: "main", window: ALWAYS, steps: [{ id: `c${ci}-inv`, waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false }, { id: `c${ci}-lm`, waitDays: 0, subject: "", body: "A LinkedIn message.", threading: "new_subject", removed: false }], start: { kind: "entry" }, removed: false, acceptWaitDays: 2 } : null;
    if (email) features.add(email.start.kind === "after" ? "email-after-a-message-request-track" : "email-beside-a-message-request-track");
    if (sms) features.add(sms.start.kind === "after" ? "sms-after-a-message-request-track" : "sms-beside-a-message-request-track");
    if (li) features.add("linkedin-beside-a-message-request-track");
    const laneTracks = new Map<RunChannel, LaneTracks>();
    const chosen: TrackDefinition[] = [];
    for (const lane of lanes) {
      const pool = lane.sessions.filter(() => lane.rnd() < 0.7).map((s) => s.id);
      if (pool.length === 0) pool.push(lane.sessions[0]!.id);
      // A second track beside it, whose choice differs from the first's: the sessions the first left out, else another one
      // than the first's first.
      const others = lane.sessions.filter((x) => !pool.includes(x.id)).map((x) => x.id);
      const pool2 = others.length > 0 ? others : lane.sessions.filter((x) => x.id !== pool[0]).slice(0, 1).map((x) => x.id);
      const first = firsts.get(lane.channel)!;
      const prefix = lane === primary ? `c${ci}` : `c${ci}-${lane.forms.short}`;
      const t2: TrackDefinition | null =
        lane.twoRnd() < 0.5 && pool2.length > 0
          ? { id: `${prefix}-${lane.forms.short}2`, channel: lane.channel, branch: "main", window: first.window, steps: [{ id: `${prefix}-n1`, waitDays: 0, subject: "", body: "Another track, {{first_name|there}}.", threading: "new_subject", removed: false }], start: { kind: "entry" }, removed: false, senders: pool2.map((s) => accountOf(lane, s)) }
          : null;
      if (t2) laneFeature(lane, "two-tracks-choosing-other-sessions");
      laneTracks.set(lane.channel, { t1: first, t2 });
      // The user's chosen senders, on each track (ADR 0004 13.5).
      chosen.push({ ...first, senders: pool.map((s) => accountOf(lane, s)) }, ...(t2 ? [t2] : []));
    }
    const definition: CampaignDefinition = {
      timezone: "Europe/London",
      callSkipLimitDays: 2,
      emailPool: ["inbox-a"],
      smsPool: sms ? [SMS_NUMBER] : [],
      ...(li ? { linkedinPool: [`linkedin:${LI_SESSION}`] } : {}),
      tracks: [...chosen, ...(email ? [email] : []), ...(sms ? [sms] : []), ...(li ? [li] : [])],
    };
    campaigns.push({ id: "", definition, lanes: laneTracks, email, sms, li });
    const people = 2 + Math.floor(rnd() * 4);
    for (let p = 0; p < people; p++) {
      personNo++;
      const company = pickOf(rnd, companies);
      const ownCells: Partial<Record<RunChannel, string>> = {};
      for (const lane of lanes) {
        const roll = lane.rnd();
        ownCells[lane.channel] = roll < 0.4 ? lane.forms.ownCell(seed, String(personNo)) : roll < 0.5 ? "@not_a_url" : "";
        scriptFor(lane, lane.forms.accountKey(ownCells[lane.channel] ?? ""));
      }
      leads.push({ campaign: ci, name: `Lead${personNo} Fictional`, company, companyLead: false, ownCells, email: `lead${personNo}@fictional.example`, zone: pickOf(rnd, ZONES), id: "" });
    }
  }
  if (leads.filter((l) => l.ownCells[primary.channel] === "").length >= 2 && new Set(leads.map((l) => `${l.campaign}|${l.company.id}`)).size < leads.length) features.add("two-leads-of-one-company");
  // A company with no decision maker in a campaign's import is enrolled as a company lead (ADR 0004 13.4: its own account).
  for (const [ci] of campaigns.entries()) {
    for (const company of companies) {
      if (leads.some((l) => l.campaign === ci && l.company.id === company.id)) continue;
      leads.push({ campaign: ci, name: company.name, company, companyLead: true, ownCells: {}, email: "", zone: "Europe/London", id: "" });
      features.add("a-company-lead");
    }
  }
  if (campaigns.length === 2) features.add("two-campaigns");
  const personRow = (l: Lead) =>
    person({
      person_id: `p-${l.name.replace(/\D/g, "")}`,
      business_id: l.company.id,
      full_name: l.name,
      email: l.email,
      timezone: l.zone,
      dial_phone: `+4477009${String(1000 + Number(/\d+/.exec(l.name)?.[0] ?? 0)).slice(-5)}`,
      dial_phone_type: "mobile",
      linkedin_url: `https://www.linkedin.com/in/fictional-mr-${seed}-${l.name.replace(/\D/g, "")}`,
      ...Object.fromEntries(lanes.map((lane) => [lane.forms.column, l.ownCells[lane.channel] ?? ""])),
    });
  const businessRow = (c: Company) => business({ business_id: c.id, business_name: c.name, phone_e164: `+4420794601${10 + Number(c.id.slice(1))}`, ...Object.fromEntries(lanes.map((lane) => [lane.forms.column, c.cells[lane.channel] ?? ""])) });
  for (const [ci, c] of campaigns.entries()) {
    const own = leads.filter((l) => l.campaign === ci && !l.companyLead);
    const companyIds = new Set(leads.filter((l) => l.campaign === ci).map((l) => l.company.id));
    const { campaign } = await h.createCampaign(`Campaign ${ci}`, { businesses: companies.filter((x) => companyIds.has(x.id)).map(businessRow), people: own.map(personRow) });
    c.id = campaign.id;
    await h.defineSequence(c.id, c.definition);
    const launched = await h.launch(c.id);
    if (launched.status !== 200) problem(`setup: launch refused ${JSON.stringify(launched.body)}`);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
    for (const l of leads.filter((x) => x.campaign === ci)) l.id = rows.find((r) => r.name === l.name)?.enrollments.find((e) => e.campaign.id === c.id)?.id ?? "";
  }
  /** Each person's own cell through the run, by lane: as imported, then each re-import's. */
  const cellHistory = new Map<string, { at: number; cell: string }[]>(leads.flatMap((l) => lanes.map((lane) => [`${lane.channel}|${l.name}`, [{ at: -Infinity, cell: l.ownCells[lane.channel] ?? "" }]] as const)));
  // A lead the import did not enrol (no usable channel at all) is not in the run.
  for (const l of [...leads]) if (l.id === "") leads.splice(leads.indexOf(l), 1);
  const launchedAt = h.clock;

  const bounded = () => (options.maxWrites !== undefined && h.writes > options.maxWrites) || (options.maxTicks !== undefined && h.ticks > options.maxTicks);

  // --- The record's own log of what the user did.
  const held = new Map<string, { from: number; to: number | null }[]>();
  const campaignHeld = new Map<string, { from: number; to: number | null }[]>();
  /**
   * Accepted marks and stops, each with every lane's handover log length at its instant: nothing of the subject after it on
   * any channel. A mark names its lane.
   */
  const ended = new Map<string, { at: number; handovers: Map<RunChannel, number>; kind: "mark" | "stop"; channel: RunChannel | null }>();
  const handoverLengths = () => new Map(lanes.map((lane) => [lane.channel, portOf(lane).handoverLog.length]));
  const restarts = new Map<string, number>();
  /** The first track's chosen sessions through its edits, by campaign and lane. */
  const pools = new Map<string, { at: number; pool: readonly string[] }[]>(
    campaigns.flatMap((c, i) => lanes.map((lane) => [`${i}|${lane.channel}`, [{ at: -Infinity, pool: (c.definition.tracks.find((t) => t.id === c.lanes.get(lane.channel)!.t1.id)?.senders ?? []).map(sessionOf) }]] as const)),
  );
  const poolAt = (ci: number, lane: Lane, at: number) => (pools.get(`${ci}|${lane.channel}`) ?? []).filter((x) => x.at <= at).at(-1)?.pool ?? [];
  /** The sessions a track of the lane had chosen at an instant: the first's through its edits, the second's as set. */
  const trackPoolAt = (ci: number, lane: Lane, trackId: string, at: number): readonly string[] => {
    const t = campaigns[ci]!.lanes.get(lane.channel)!;
    return trackId === t.t1.id ? poolAt(ci, lane, at) : trackId === t.t2?.id ? (t.t2.senders ?? []).map(sessionOf) : [];
  };
  const crashedAttempts: string[] = [];
  /** Each crash between a handover's commit and its call, with the pair its attempt was for (the account id carries the lane). */
  const crashed: { subjectId: string; stepId: string; at: number; attemptId: string; account: string; sender: string; destination: string }[] = [];
  /** When the user marked a crashed or lost attempt not sent, by attempt id: from then it holds no pair. */
  const markedNotSentAt = new Map<string, number>();
  const signedOut: { lane: Lane; id: string; from: number; until: number; restored: number | null }[] = [];
  const edited = new Set<RunChannel>();
  let requestNo = 0;
  const holdsOf = (l: Lead) => [...(held.get(l.id) ?? []), ...(campaignHeld.get(campaigns[l.campaign]!.id) ?? [])];
  const pickLane = (): Lane => (lanes.length === 1 ? primary : pickOf(laneRnd, lanes));

  // 29: right after each worker tick, a fresh engine at the same instant finds nothing to change and nothing to hand over.
  let draining = false;
  const freshEvery = options.freshEvery ?? 1;
  let ticksSinceFresh = 0;
  let conversationsSeen = "";
  const conversationsNow = () => {
    const row = (h.store.engine as unknown as { db: DatabaseSync }).db.prepare("SELECT COALESCE(SUM(seq), 0) AS s, COUNT(*) AS n FROM conversation_versions").get() as { s: number; n: number };
    return `${row.n}/${row.s}`;
  };
  const handoversNow = () => lanes.reduce((n, lane) => n + portOf(lane).handoverLog.length, 0) + (h.smsProvider?.handoverLog.length ?? 0) + h.fake.handoverLog.length + (h.linkedinProvider?.handoverLog.length ?? 0);
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
  // The review bot on 0922582, from a stream of its own: right after the launch, in half the runs, the user removes each
  // lane's second track, which every lead has started and at least one has had nothing of handed over (its window is
  // closed). Each lead that started it runs it to its end (ADR 0003's running edits): M7 and M8 hold it to that.
  if (random(seed ^ 0x7e3e)() < 0.5) {
    for (const lane of lanes) {
      for (const c of campaigns) {
        const t2 = c.lanes.get(lane.channel)!.t2;
        if (!t2) continue;
        const mine = leads.filter((l) => campaigns[l.campaign] === c);
        const reads = await Promise.all(mine.map(async (l) => (await h.request<EnrollmentRead>("GET", `/api/enrollments/${l.id}`)).body.tracks.find((t) => t.trackId === t2.id)));
        const waiting = mine.some((l, i) => reads[i]?.finishedAt === null && !portOf(lane).handoverLog.some((x) => x.subjectId === l.id && x.trackId === t2.id));
        if (!reads.every((t) => t?.started === true || t?.finishedAt != null) || !waiting) continue;
        const stored = (await h.request<{ definition: CampaignDefinition }>("GET", `/api/campaigns/${c.id}/sequence`)).body.definition;
        const r = await h.request("PUT", `/api/campaigns/${c.id}/sequence`, { ...stored, tracks: stored.tracks.map((t) => (t.id === t2.id ? { ...t, removed: true } : t)) });
        if (r.status !== 200) problem(`setup: removing ${t2.id}, which every lead had started, was refused: ${JSON.stringify(r.body).slice(0, 200)}`);
        else laneFeature(lane, "a-started-track-removed-before-its-first-claim");
      }
    }
  }
  const end = START + 10 * DAY;
  while (h.clock < end && !bounded()) {
    await h.advanceTo(Math.min(end, h.clock + pickOf(rnd, [10 * MIN, 45 * MIN, 3 * H, 9 * H, DAY])));
    for (const s of signedOut) {
      if (s.until > h.clock || s.restored !== null) continue;
      portOf(s.lane).sessions.get(s.id)!.healthy = true;
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
      // The user marks a reply on one lane: refused when nothing reached the person there, or the lead has already ended.
      const lane = pickLane();
      const before = handoverLengths();
      const reached = reachedOn(lane, lead);
      const r = await h.request("POST", `/api/enrollments/${lead.id}/replies`, { requestId: `g-${++requestNo}`, channel: lane.channel });
      const repliedNow = (await h.store.engine.subject(lead.id, h.clock))?.subject.ended === "replied";
      if (r.status === 200 || (repliedNow && ended.get(lead.id)?.kind !== "mark")) {
        if (!reached) problem(`M6: a reply was marked on ${lead.id} at ${iso(h.clock)}, which nothing reached on ${lane.forms.name}`);
        ended.set(lead.id, { at: h.clock, handovers: before, kind: "mark", channel: lane.channel });
        laneFeature(lane, "a-reply-marked");
        if (lanes.length === 2 && lanes.some((other) => other !== lane && portOf(other).handoverLog.some((x) => x.subjectId === lead.id))) features.add("a-reply-marked-on-one-channel-of-a-lead-reached-on-both");
      } else {
        if (reached && ended.get(lead.id)?.kind !== "mark" && (await h.store.engine.subject(lead.id, h.clock))?.subject.ended !== "interested_on_call") problem(`M6: the mark on ${lead.id} at ${iso(h.clock)} was refused on ${lane.forms.name}, though a message reached them there: ${JSON.stringify(r.body).slice(0, 200)}`);
        laneFeature(lane, "a-reply-mark-refused");
      }
    } else if (roll < 0.18) {
      await h.stopFor(pickOf(rnd, [2 * H, 14 * H, 2 * DAY]));
      features.add("the-laptop-was-off");
    }
    await extraEvent(rnd2());
    await check(false);
  }
  for (const s of signedOut) {
    portOf(s.lane).sessions.get(s.id)!.healthy = true;
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
  return { problems, stats: { features, writes: h.writes, ticks: h.ticks, channels } };

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
        const went = [...lanes.map((lane) => portOf(lane).deliveryLog), h.fake.deliveryLog, h.smsProvider?.deliveryLog ?? [], h.linkedinProvider?.deliveryLog ?? []].some((log) => log.some((d) => d.key === w.key));
        if (await h.engine.markAttempt(a.id, went ? "sent" : "not_sent")) {
          features.add("unresolved-marked");
          if (!went) markedNotSentAt.set(a.id, h.clock);
        }
      }
    }
  }

  /** Every track of the lead's campaign on the lane. */
  function tracksOf(lane: Lane, l: Lead): TrackDefinition[] {
    const t = campaigns[l.campaign]!.lanes.get(lane.channel)!;
    return [t.t1, ...(t.t2 ? [t.t2] : [])];
  }

  /** Whether the record knows something of this lead reached the person on the lane: a delivery, or a call whose outcome is untold. */
  function reachedOn(lane: Lane, lead: Lead): boolean {
    const port = portOf(lane);
    const refused = new Set(port.refusals.map((r) => r.key));
    return port.handoverLog.some((x) => x.subjectId === lead.id && !refused.has(x.key)) || crashed.some((x) => x.subjectId === lead.id && tracksOf(lane, lead).some((t) => t.steps.some((s) => s.id === x.stepId)));
  }

  async function extraEvent(roll: number): Promise<void> {
    const lead = pickOf(rnd2, leads);
    const c = campaigns[lead.campaign]!;
    if (roll < 0.03 && !ended.has(lead.id)) {
      const before = handoverLengths();
      const r = await h.request("POST", `/api/enrollments/${lead.id}/controls`, { requestId: `g-${++requestNo}`, action: "stop" });
      if (r.status === 200 || (await h.store.engine.subject(lead.id, h.clock))?.subject.ended === "stopped_manually") {
        ended.set(lead.id, { at: h.clock, handovers: before, kind: "stop", channel: null });
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
      const lane = pickLane();
      const s = pickOf(rnd2, lane.sessions);
      portOf(lane).sessions.get(s.id)!.healthy = false;
      signedOut.push({ lane, id: s.id, from: h.clock, until: h.clock + pickOf(rnd2, [H, 8 * H]), restored: null });
      laneFeature(lane, "a-session-signed-out");
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
      // A running edit of a lane's first track: a message inserted, removed, or two reordered.
      const lane = pickLane();
      const t1 = c.lanes.get(lane.channel)!.t1;
      const stored = (await h.request<{ definition: CampaignDefinition }>("GET", `/api/campaigns/${c.id}/sequence`)).body.definition;
      const kind = pickOf(rnd2, ["insert", "remove", "reorder"] as const);
      const tracks = stored.tracks.map((t) => {
        if (t.id !== t1.id) return t;
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
        edited.add(lane.channel);
        laneFeature(lane, `a-running-edit:${kind}`);
      }
    } else if (roll < 0.21) {
      // A sender edit: a session added to or removed from a lane's first track's chosen senders.
      const lane = pickLane();
      if (lane.sessions.length < 2) return;
      const t1 = c.lanes.get(lane.channel)!.t1;
      const stored = (await h.request<{ definition: CampaignDefinition }>("GET", `/api/campaigns/${c.id}/sequence`)).body.definition;
      const now = poolAt(lead.campaign, lane, h.clock);
      const s = pickOf(rnd2, lane.sessions).id;
      const next = now.includes(s) ? (now.length > 1 ? now.filter((x) => x !== s) : now) : [...now, s];
      if (next === now) return;
      const r = await h.request("PUT", `/api/campaigns/${c.id}/sequence`, { ...stored, tracks: stored.tracks.map((t) => (t.id === t1.id ? { ...t, senders: next.map((x) => accountOf(lane, x)) } : t)) });
      if (r.status === 200) {
        pools.set(`${lead.campaign}|${lane.channel}`, [...(pools.get(`${lead.campaign}|${lane.channel}`) ?? []), { at: h.clock, pool: next }]);
        laneFeature(lane, next.length > now.length ? "a-session-added-to-a-pool" : "a-session-removed-from-a-pool");
      }
    } else if (roll < 0.23 && !lead.companyLead) {
      // A re-import gives the person another own account on one lane, or empties it. Half of them go to a person whose
      // track there has started (a message handed over, by the provider's log), so a started track meets a replaced account
      // (the review of f2824d4, item 8): it must be skipped, never retargeted. The person's cells on other lanes are kept.
      const lane = pickLane();
      const started = leads.filter((l) => !l.companyLead && reachedOn(lane, l));
      const target = started.length > 0 && rnd2() < 0.5 ? pickOf(rnd2, started) : lead;
      const tc = campaigns[target.campaign]!;
      const cell = rnd2() < 0.7 ? lane.forms.ownCell(seed, target.name.replace(/\D/g, ""), requestNo) : "";
      scriptFor(lane, lane.forms.accountKey(cell));
      const r = await h.request("POST", `/api/campaigns/${tc.id}/imports`, csvOf({ businesses: [businessRow(target.company)], people: [personRow({ ...target, ownCells: { ...target.ownCells, [lane.channel]: cell } })] }));
      if (r.status === 201) {
        target.ownCells[lane.channel] = cell;
        cellHistory.set(`${lane.channel}|${target.name}`, [...(cellHistory.get(`${lane.channel}|${target.name}`) ?? []), { at: h.clock, cell }]);
        laneFeature(lane, "an-account-changed-by-a-reimport");
        if (target !== lead) laneFeature(lane, "a-started-track-whose-account-a-reimport-replaced");
      }
    }
  }

  // --- The checks, from the record and the providers' logs, on every lane.
  async function check(drained: boolean): Promise<void> {
    while (crashed.length < crashedAttempts.length) {
      const a = await h.store.engine.attempt(crashedAttempts[crashed.length]!);
      crashed.push({ subjectId: a?.subjectId ?? "", stepId: a?.stepId ?? "", at: h.clock, attemptId: a?.id ?? "", account: a?.accountId ?? "", sender: sessionOf(a?.accountId ?? ""), destination: a?.destination ?? "" });
    }
    const leadOf = (id: string) => leads.find((l) => l.id === id);
    const everyDelivery = [...lanes.map((lane) => portOf(lane).deliveryLog), h.fake.deliveryLog, h.smsProvider?.deliveryLog ?? [], h.linkedinProvider?.deliveryLog ?? []];
    if (lanes.length === 2 && leads.some((l) => lanes.every((lane) => portOf(lane).deliveryLog.some((d) => d.subjectId === l.id)))) features.add("one-lead-reached-on-both-channels");
    for (const lane of lanes) checkLane(lane);
    for (const log of [h.fake.handoverLog, h.smsProvider?.handoverLog ?? []]) {
      for (const x of log) {
        const stop = ended.get(x.subjectId);
        if (stop && x.at > stop.at + MIN) problem(`M3: ${x.subjectId} was handed a message on another channel at ${iso(x.at)}, after its ${stop.kind} at ${iso(stop.at)}`);
      }
    }
    if (!drained) return;
    // M7 and M9, after the drain: nothing pending for ever, and the other tracks carried on.
    for (const l of leads) {
      if (ended.has(l.id)) continue;
      const read = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${l.id}`)).body;
      const first = read.tracks.find((t) => t.trackId === campaigns[l.campaign]!.lanes.get(primary.channel)!.t1.id);
      // M9: an email track at entry, or after the first lane's track that finished, sent its email, whatever the lead's
      // status: the record stopped and marked no such lead, and no other ending can come before its email.
      const em = campaigns[l.campaign]!.email;
      if (em && l.email !== "" && !restarts.has(l.id)) {
        const due = em.start.kind === "entry" || first?.finishedAt !== null;
        if (due && !h.fake.deliveryLog.some((d) => d.subjectId === l.id)) problem(`M9: ${l.id}'s email track (${em.start.kind}) sent nothing after the drain, its ${primary.forms.name} track ${first?.finishReason ?? "unfinished"}, status ${read.status}`);
      }
      if (ENDED.has(read.status)) continue;
      for (const lane of lanes) {
        const owner = ownersOf(lane);
        for (const t of tracksOf(lane, l)) {
          const track = read.tracks.find((x) => x.trackId === t.id);
          if (!track || track.finishedAt !== null || !track.started) continue;
          // The sessions dispatch may use, by the record (ADR 0004 6, 13.6): the track's fixed one, else the sessions that
          // track chose less every session whose pair with the lead's destination another subject owns.
          const sender = portOf(lane).handoverLog.find((x) => x.subjectId === l.id && x.trackId === t.id)?.sender;
          // The destination fixed at the track's start (M2), not the rule's answer now: a re-import since does not move it.
          const destination = destinationAt(lane, l, launchedAt, 0);
          const eligible = sender ? [sender] : trackPoolAt(l.campaign, lane, t.id, h.clock).filter((s) => {
            const o = owner.get(`${s}|${destination}`);
            return o === undefined || o === l.id;
          });
          const zero = eligible.every((s) => (lane.allowance.get(s) ?? 0) === 0);
          const why = track.nextStep?.when.kind === "waits" ? track.nextStep.when.why : track.nextStep?.when.kind ?? "none";
          if (zero && why === "no_allowance") laneFeature(lane, "a-step-waiting-on-a-zero-allowance");
          else if (!(zero && why === "no_allowance") && why !== "lead_paused" && why !== "callback") {
            problem(`M7: after the drain ${l.id}'s ${lane.forms.name} track ${t.id} is still pending (${why}, status ${read.status}); the record's eligible sessions ${eligible.join(",")} ${zero ? "allow none, so it must read no_allowance" : "have room"}`);
          }
        }
      }
    }

    /** The bad marks on the lane, by the record: an account its session refused as unreachable, from that refusal on, by the position of the refused handover in the provider's log (two calls can share an instant; the mark comes after its own call). */
    function marksOf(lane: Lane): Map<string, { at: number; index: number }> {
      const port = portOf(lane);
      const indexOfKey = new Map<string, number>();
      port.handoverLog.forEach((x, i) => indexOfKey.set(x.key, i));
      const markedBadAt = new Map<string, { at: number; index: number }>();
      for (const r of port.refusals) if (r.reason === "invalid_destination" && !markedBadAt.has(r.destination)) markedBadAt.set(r.destination, { at: r.at, index: indexOfKey.get(r.key) ?? -1 });
      return markedBadAt;
    }

    /**
     * The destination on the lane by the record's rule (ADR 0004 13.4) at an instant, as a handover at log position `before`
     * sees it: the person's own usable account, else the company's. A mark counts once its refused call came before that position.
     */
    function destinationAt(lane: Lane, l: Lead, at: number, before: number): string | null {
      const markedBadAt = marksOf(lane);
      const usable = (key: string | null) => {
        const mark = key === null ? undefined : markedBadAt.get(key);
        return key !== null && (mark === undefined || mark.at > at || mark.index >= before);
      };
      const ownCellAt = (cellHistory.get(`${lane.channel}|${l.name}`) ?? []).filter((x) => x.at <= at).at(-1)?.cell ?? "";
      const own = l.companyLead ? null : lane.forms.accountKey(ownCellAt);
      if (usable(own)) return own;
      const company = lane.forms.accountKey(l.company.cells[lane.channel] ?? "");
      return usable(company) ? company : null;
    }

    /** M5's owners on the lane: every message to a (session, account) belongs to the first subject that reached it, until all its work there was refused. */
    function ownersOf(lane: Lane, report = false): Map<string, string> {
      const port = portOf(lane);
      const refusedKeys = new Map(port.refusals.map((r) => [r.key, r.reason]));
      const owner = new Map<string, string>();
      for (const x of port.handoverLog) {
        const pair = `${x.sender}|${x.destination}`;
        const was = owner.get(pair);
        if (was !== undefined && was !== x.subjectId) {
          const wasAll = port.handoverLog.filter((y) => y.subjectId === was && `${y.sender}|${y.destination}` === pair && y.at <= x.at);
          // A crash holds the pair it was for, on its own lane, until the user marks it not sent (two tracks of one lead use two pairs).
          const holding = crashed.some((c) => c.subjectId === was && c.account === accountOf(lane, x.sender) && c.destination === x.destination && !((markedNotSentAt.get(c.attemptId) ?? Infinity) <= x.at));
          const released = wasAll.length > 0 && wasAll.every((y) => refusedKeys.has(y.key)) && !holding;
          if (!released && report) problem(`M5: ${x.subjectId} was handed a ${lane.forms.name} message to ${x.destination} from ${x.sender} at ${iso(x.at)}, a pair ${was} owns`);
          else if (released) owner.set(pair, x.subjectId);
        } else if (was === undefined) owner.set(pair, x.subjectId);
      }
      return owner;
    }

    function checkLane(lane: Lane): void {
      const port = portOf(lane);
      const name = lane.forms.name;
      const lostKeys = new Set(port.deliveryLog.filter((d) => d.visibleAt === Infinity).map((d) => d.key));
      const markedBadAt = marksOf(lane);
      for (const x of port.handoverLog) {
        const l = leadOf(x.subjectId);
        if (!l) continue;
        // M8: its own channel, one of its campaign's tracks on this lane; each track's first from a session that track chose at
        // that instant, never another track's; every later one of the track from that same session, chosen still or not (a
        // fixed sender is never reassigned, ADR 0003 1.3, as on LinkedIn; per track, the review bot on 0922582).
        const own = tracksOf(lane, l).find((t) => t.id === x.trackId);
        if (!own || x.action !== "message") problem(`M8: a ${name} handover for ${x.subjectId} at ${iso(x.at)} is not a message of one of its ${name} tracks (${x.trackId}, ${x.action})`);
        const mine = port.handoverLog.filter((y) => y.subjectId === x.subjectId && y.trackId === x.trackId);
        const first = mine[0]!;
        const chosen = trackPoolAt(l.campaign, lane, x.trackId, x.at);
        if (x === first && !chosen.includes(x.sender)) problem(`M8: ${x.subjectId}'s first ${name} message of ${x.trackId} at ${iso(x.at)} went from ${x.sender}, which that track had not chosen (${chosen.join(",")})`);
        if (x !== first && x.sender !== first.sender) problem(`M8: ${x.subjectId}'s ${name} message of ${x.trackId} at ${iso(x.at)} went from ${x.sender}, after that track's first from ${first.sender}`);
        // M2: the destination the record derives on this lane; never one marked bad before it.
        const position = port.handoverLog.indexOf(x);
        const bad = markedBadAt.get(x.destination);
        if (bad !== undefined && bad.index < position) problem(`M2: ${x.subjectId}'s ${name} message at ${iso(x.at)} went to ${x.destination}, marked bad at ${iso(bad.at)}`);
        // The destination is fixed at the track's start, which the record models as the launch (the track starts at entry),
        // and every message of the track goes there: a re-import that replaces it skips the track, never retargets it (ADR
        // 0004 13.4; the review of f2824d4, item 8). No mark can precede the launch, so none is counted at it.
        const pinned = destinationAt(lane, l, launchedAt, 0);
        if (x.destination !== pinned) problem(`M2: ${x.subjectId}'s ${name} message at ${iso(x.at)} went to ${x.destination}; its track started at ${iso(launchedAt)} on ${pinned ?? "no account"}`);
        // M3: nothing after an accepted mark or a stop, on any lane, until a restart after it.
        const stop = ended.get(x.subjectId);
        if (stop && position >= (stop.handovers.get(lane.channel) ?? Infinity)) problem(`M3: ${x.subjectId} was handed a ${name} message at ${iso(x.at)}, after its ${stop.kind}${stop.channel ? ` on ${FORMS[stop.channel].name}` : ""} at ${iso(stop.at)}`);
      }
      // M1: each step delivered at most once; a step whose answer was lost is never handed over again.
      const bySubjectStep = new Map<string, number>();
      for (const d of port.deliveryLog) bySubjectStep.set(`${d.subjectId}|${d.stepId}`, (bySubjectStep.get(`${d.subjectId}|${d.stepId}`) ?? 0) + 1);
      for (const [k, n] of bySubjectStep) if (n > 1) problem(`M1: ${k} was delivered ${n} times on ${name}`);
      for (const x of port.handoverLog) {
        if (!lostKeys.has(x.key)) continue;
        const later = port.handoverLog.find((y) => y.subjectId === x.subjectId && y.stepId === x.stepId && y.at >= x.at && y !== x);
        if (later) problem(`M1: ${x.subjectId}'s ${name} step ${x.stepId}, whose answer was lost at ${iso(x.at)}, was handed over again at ${iso(later.at)}`);
      }
      // M4: per session of this lane and reset day (London), messages delivered never exceed its allowance on this lane.
      const perDay = new Map<string, number>();
      for (const d of port.deliveryLog) {
        const k = `${d.sender}|${local(d.at, "Europe/London").day}`;
        perDay.set(k, (perDay.get(k) ?? 0) + 1);
      }
      for (const [k, n] of perDay) {
        const a = lane.allowance.get(k.split("|")[0]!) ?? 0;
        if (n > a) problem(`M4: ${name} session ${k} delivered ${n} messages, over its allowance of ${a}`);
      }
      // M5.
      ownersOf(lane, true);
      if (port.refusals.some((r) => r.reason === "invalid_destination")) laneFeature(lane, "an-account-marked-bad");
      if (port.refusals.some((r) => r.reason === "not_allowed")) laneFeature(lane, "a-message-not-allowed");
      if (port.refusals.some((r) => r.reason === "rate_limited")) laneFeature(lane, "a-rate-limit");
      if (lostKeys.size > 0 && port.lookupLog.some((x) => x.answer === "sent")) laneFeature(lane, "a-lost-answer-found-by-lookup");
      if (port.handoverLog.some((x) => port.handoverLog.some((y) => y.destination === x.destination && y.subjectId !== x.subjectId))) laneFeature(lane, "one-account-reached-for-two-subjects");
      // M10: when a session's day was full, a follow-up due before a first message that took a slot that day never went later.
      if (edited.has(lane.channel)) return;
      for (const [k, n] of perDay) {
        const [sender, dayText] = k.split("|");
        const day = Number(dayText);
        if (n < (lane.allowance.get(sender!) ?? 0)) continue;
        // A first contact: the first step of a track to a lead nothing has reached yet, on any channel. A second track's first
        // message to a lead another track reached is a touched lead's, ranked as a follow-up's.
        const reachedBefore = (subjectId: string, at: number) => everyDelivery.some((log) => log.some((d) => d.subjectId === subjectId && d.at < at));
        const firsts = port.deliveryLog.filter((d) => d.sender === sender && local(d.at, "Europe/London").day === day && stepIndex(lane, d.subjectId, d.stepId) === 0 && !reachedBefore(d.subjectId, d.at));
        for (const f of firsts) {
          for (const g of port.deliveryLog.filter((d) => d.sender === sender && local(d.at, "Europe/London").day > day && stepIndex(lane, d.subjectId, d.stepId) > 0)) {
            const l = leadOf(g.subjectId);
            if (!l || holdsOf(l).length > 0 || restarts.has(l.id)) continue;
            const t1 = campaigns[l.campaign]!.lanes.get(lane.channel)!.t1;
            const prev = port.deliveryLog.filter((d) => d.subjectId === g.subjectId && d.at < g.at && t1.steps.some((st) => st.id === d.stepId)).at(-1);
            if (!prev || prev.visibleAt === Infinity) continue;
            const step = t1.steps.find((s) => s.id === g.stepId);
            if (!step) continue;
            const due = dueAfter(prev.at, step.waitDays, l.zone);
            // The first message was claimed at most a pacing gap before it went: the follow-up must have been due before that.
            const gap = lane.sessions.find((x) => x.id === sender)?.gapMs ?? 0;
            const claimedBy = f.at - gap - MIN;
            if (due <= claimedBy && inWindow(t1.window, l.zone, f.at) && inWindow(t1.window, l.zone, claimedBy) && !signedOut.some((o) => o.lane === lane && o.id === sender && o.from <= f.at && f.at < (o.restored ?? Infinity))) {
              problem(`M10: on ${name} session ${sender}'s full day ${iso(f.at)} a first message to ${f.subjectId} went before ${g.subjectId}'s follow-up ${g.stepId}, due ${iso(due)}, which went only at ${iso(g.at)}`);
              laneFeature(lane, "a-contested-slot");
            }
          }
        }
      }
    }
  }

  function stepIndex(lane: Lane, subjectId: string, stepId: string): number {
    const l = leads.find((x) => x.id === subjectId);
    if (!l) return -1;
    const t = campaigns[l.campaign]!.lanes.get(lane.channel)!;
    const at = t.t1.steps.findIndex((s) => s.id === stepId);
    return at >= 0 ? at : (t.t2?.steps.findIndex((s) => s.id === stepId) ?? -1);
  }
}
