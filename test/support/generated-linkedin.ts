import type { DatabaseSync } from "node:sqlite";
import { Crash, EngineHarness } from "./engine-harness.ts";
import { linkedinAccountId } from "../../src/server/engine/ports.ts";
import { business, csvOf, person } from "./export-builder.ts";
import { connectedOn, pendingOn, type ProfileScript } from "./fake-linkedin-port.ts";
import { random } from "./generated-sequences.ts";
import { dueAfter, firstOpen, local, type Hours } from "./sequence-model.ts";
import type { Rules } from "../../src/server/engine/rules.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../src/domain/sequence/definition.ts";
import type { LeadSearchResult } from "../../src/shared/api.ts";

/**
 * The generated LinkedIn runs (ticket 24, ADR 0004 section 10). The real HTTP app, SQLite store and engine run one or two
 * campaigns with a LinkedIn track (and in half of them an email track together with it or after it) against the simulated
 * LinkedIn provider and the fake email provider. The record below imports nothing from `src/domain/sequence/`: it keeps
 * its own copy of each definition, the allowances, each lead's held intervals, the user's marks and the providers' logs,
 * and from them, with its own calendar arithmetic (`sequence-model.ts`), predicts what L1 to L10 require. Every profile and
 * person is fictitious. A run reports its problems, each prefixed with the invariant it breaks.
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const SETTLING = 15 * MIN;
/** Monday 2 November 2026, 08:00 UTC. */
const START = Date.parse("2026-11-02T08:00:00Z");
const ZONES = ["Europe/London", "America/New_York", "Australia/Sydney"] as const;
const SESSIONS = ["li-a", "li-b"] as const;
/** A third session, from the second stream (review bot on e261ffa): pools of two and three sessions. */
const THIRD_SESSION = "li-c";
/** One simulated SMS number, for the SMS tracks drawn beside LinkedIn (review bot on b21af02). */
const SMS_NUMBER = "+447700900001";

/** Sending windows as the control runs draw them (ADR 0003 "Reads that say when"): weekdays, hours, all day often. */
const DAYSETS = [[1, 2, 3, 4, 5], [2, 3, 4, 5, 6], [0, 1, 2, 3, 4, 5, 6], [1, 3, 5]] as const;
const HOURS = [[9, 17], [8, 12], [13, 18], [20, 24], [22, 2], [0, 24], [0, 24], [0, 24]] as const;

export interface LinkedinRunOptions {
  readonly rules?: Partial<Rules>;
  readonly maxWrites?: number;
  /** A replay also stops after this many engine ticks: a broken engine can tick for ever writing little. */
  readonly maxTicks?: number;
  /**
   * How often invariant 29's fresh engine is compared with the worker (a fresh engine per check doubles a run's engine work):
   * 1 (the default) after every tick; N after every Nth tick and after every tick that moved a conversation's version (the
   * per-push fixed seeds); 0 never (a replay of a mutation that breaks another invariant).
   */
  readonly freshEvery?: number;
}

export interface LinkedinRun {
  readonly problems: string[];
  readonly stats: { readonly features: Set<string>; readonly writes: number; readonly ticks: number };
}

/**
 * The wall instant a span of `running` milliseconds of the lead's clock, counted from `from`, ends at: the clock stands
 * still through every held interval (a pause; the record's own list), so each one it meets moves the end by its length.
 */
export function afterHolds(from: number, running: number, holds: readonly { readonly from: number; readonly to: number | null }[]): number {
  let cursor = from;
  let left = running;
  for (const x of [...holds].sort((a, b) => a.from - b.from)) {
    const to = x.to ?? Infinity;
    if (to <= cursor) continue;
    if (x.from > cursor) {
      if (cursor + left <= x.from) return cursor + left;
      left -= x.from - cursor;
    }
    cursor = to;
  }
  return cursor + left;
}

/** How long the holds cover of [from, to): the lead's clock stands still through each. */
export function heldWithin(from: number, to: number, holds: readonly { readonly from: number; readonly to: number | null }[]): number {
  let total = 0;
  const merged = [...holds].sort((a, b) => a.from - b.from);
  let cursor = from;
  for (const x of merged) {
    const a = Math.max(cursor, x.from);
    const b = Math.min(to, x.to ?? Infinity);
    if (b > a) {
      total += b - a;
      cursor = b;
    }
  }
  return total;
}

/** An instant as a problem states it: a deadline the record finds never reached (held for good) is "never". */
const iso = (at: number): string => (Number.isFinite(at) ? new Date(at).toISOString() : "never");

/** A session as the app names it (`linkedin:` and its id), and back: the record keeps the provider's own ids. */
const sessionOfAccount = (id: string): string => id.replace(/^linkedin:/, "");
const toApp = (d: CampaignDefinition): CampaignDefinition => ({ ...d, linkedinPool: (d.linkedinPool ?? []).map(linkedinAccountId) });

/** The invariant a problem names ("L4: ..."). */
export const linkedinInvariantsOf = (problem: string): string[] => [problem.split(":")[0] ?? ""];

interface Allowance {
  readonly invites: number;
  readonly messages: number;
  readonly notes: number;
}

interface Lead {
  readonly campaign: number;
  readonly name: string;
  /** The person's profile now: a re-import can change it (the earlier ones are `former`). */
  profile: string | null;
  former?: string[];
  readonly email: string;
  readonly zone: string;
  script: ProfileScript | null;
  id: string;
}

interface Campaign {
  id: string;
  /** The record's copy: its LinkedIn pool follows the run's pool edits. */
  definition: CampaignDefinition;
  readonly li: TrackDefinition;
  readonly email: TrackDefinition | null;
  readonly sms: TrackDefinition | null;
}

/** A fictitious mobile per person, by its name's number. */
const mobileOf = (l: { readonly name: string }) => `+4477009${String(1000 + Number(/\d+/.exec(l.name)?.[0] ?? 0)).slice(-5)}`;

const pickOf = <T>(rnd: () => number, items: readonly T[]): T => items[Math.floor(rnd() * items.length)] as T;

function windowOf(rnd: () => number): Hours[] {
  const days = pickOf(rnd, DAYSETS);
  const [start, end] = pickOf(rnd, HOURS);
  return days.map((day) => ({ day, start, end }));
}

export async function runLinkedin(seed: number, options: LinkedinRunOptions = {}): Promise<LinkedinRun> {
  const rnd = random(seed);
  // The events the review of 194fc44 added (council item 2) draw from a stream of their own, so the first stream's draws
  // are unchanged: two campaigns sharing people, stops, campaign pauses, skips, a crash, a session signing out, running edits.
  const rnd2 = random(seed * 7 + 13);
  // The InMail fallback (ticket 27, ADR 0004 13.11) draws from a third stream: the first two streams' draws are unchanged.
  const rnd3 = random(seed * 11 + 29);
  // A fourth stream schedules an early switch-off (L19's case): the other streams' draws are unchanged.
  const rnd4 = random(seed * 13 + 31);
  // A fifth stream decides a run built for a contested credit (L27): the first session with two credits, the first campaign's
  // fallback on and a short weekday morning window, so InMails chosen at a midnight deadline wait together for it.
  const fifth = random(seed * 17 + 37);
  const contested = fifth() < 0.3;
  // In half of those, the first message is removed once an InMail there is chosen: those InMails go at the window's
  // opening, so the first live message at the send is then a follow-up the user kept (item 1's case).
  const removeWhenChosen = contested && fifth() < 0.5;
  const features = new Set<string>();
  const problems: string[] = [];
  const problem = (text: string) => {
    if (!problems.includes(text)) problems.push(text);
  };

  // --- The world.
  // In a share of runs the second session's own id is the SMS number's (the re-check of e261ffa, item 3): two accounts,
  // whose pairs and handovers L16 keeps apart. Drawn from the second stream; its draws come after the first stream's here.
  const sameIdAsNumber = rnd2() < 0.3;
  const sessions = SESSIONS.slice(0, rnd() < 0.5 ? 1 : 2).map((raw) => (raw === "li-b" && sameIdAsNumber ? SMS_NUMBER : raw)).map((id): { id: string; gapMs: number; k: number; healthy: boolean; resetZone: string } => ({ id, gapMs: pickOf(rnd, [5 * MIN, 30 * MIN]), k: 1, healthy: true, resetZone: "Europe/London" }));
  const allowances = new Map<string, Allowance>(sessions.map((s) => [s.id, { invites: Math.floor(rnd() * 4) + 1, messages: Math.floor(rnd() * 4) + 1, notes: Math.floor(rnd() * 4) }]));
  // Allowances of zero (council on b21af02, item 6): no invites, or no messages, for a session, from the second stream.
  for (const [id, a] of allowances) {
    const roll = rnd2();
    if (roll < 0.2) allowances.set(id, { ...a, invites: 0 });
    else if (roll < 0.35) allowances.set(id, { ...a, messages: 0 });
  }
  if (sessions.some((x) => x.id === SMS_NUMBER)) features.add("a-session-id-that-is-a-number");
  if (sessions.length === 2 && rnd2() < 0.5) {
    sessions.push({ id: THIRD_SESSION, gapMs: 5 * MIN, k: 1, healthy: true, resetZone: "Europe/London" });
    allowances.set(THIRD_SESSION, { invites: Math.floor(rnd2() * 3), messages: Math.floor(rnd2() * 3) + 1, notes: Math.floor(rnd2() * 3) });
    features.add("a-third-session");
  }
  // Each session's InMail standing as it reports it (13.5): Premium, Sales Navigator, no plan, or no report at all, with
  // credits from 0 to 3. The record keeps its own copy (`standingOf`); the simulated session spends one per InMail sent.
  const inmailPlans = new Map<string, { plan: "premium" | "sales_navigator" | "none"; credits: number } | null>();
  for (const s of sessions) {
    const roll = rnd3();
    const report = roll < 0.4 ? { plan: "premium" as const, credits: Math.floor(rnd3() * 4) } : roll < 0.65 ? { plan: "sales_navigator" as const, credits: Math.floor(rnd3() * 4) } : roll < 0.85 ? { plan: "none" as const, credits: 0 } : null;
    const given = contested && s === sessions[0] ? { plan: "premium" as const, credits: 2 } : report;
    inmailPlans.set(s.id, given);
    if (given) (s as { inmail?: { plan: "premium" | "sales_navigator" | "none"; credits: number } }).inmail = { ...given };
  }
  const h = new EngineHarness({
    start: START,
    accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    linkedin: { sessions },
    sms: { numbers: [{ id: SMS_NUMBER, capacity: 20, gapMs: 5 * MIN, k: 1, healthy: true, resetZone: "Europe/London" }] },
    ...(options.rules ? { rules: options.rules } : {}),
  });
  await h.tick();
  for (const [id, a] of allowances) {
    const r = await h.request("PUT", `/api/sender-accounts/${linkedinAccountId(id)}/allowances`, { invitesPerDay: a.invites, messagesPerDay: a.messages, notesPerMonth: a.notes });
    if (r.status !== 200) problem(`setup: allowances refused for ${id}`);
  }

  const campaigns: Campaign[] = [];
  const leads: Lead[] = [];
  const campaignCount = rnd() < 0.5 ? 1 : 2;
  let personNo = 0;
  for (let ci = 0; ci < campaignCount; ci++) {
    const noted = rnd() < 0.7;
    const messages = 1 + Math.floor(rnd() * 3);
    const steps: StepDefinition[] = [
      { id: `c${ci}-inv`, waitDays: 0, subject: "", body: noted ? "Hello {{first_name|there}}, I help clinics like {{company}}." : "", threading: "new_subject", removed: false },
      ...Array.from({ length: messages }, (_, i): StepDefinition => ({ id: `c${ci}-m${i + 1}`, waitDays: i === 0 ? Math.floor(rnd() * 2) : Math.floor(rnd() * 3), subject: "", body: `Message ${i + 1}, {{first_name|there}}.`, threading: "new_subject", removed: false })),
    ];
    // The InMail fallback switched on in a share of campaigns, from the third stream: an InMail step right after the invite.
    const drawnOn = rnd3() < 0.45;
    if (drawnOn || (contested && ci === 0)) steps.splice(1, 0, { id: `c${ci}-im`, waitDays: 0, subject: "", body: "An InMail, {{first_name|there}}.", threading: "new_subject", removed: false, role: "inmail" });
    const drawnWindow = windowOf(rnd);
    const window = contested && ci === 0 ? [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 12 })) : drawnWindow;
    const li: TrackDefinition = { id: `c${ci}-li`, channel: "linkedin", branch: "main", window, steps, start: { kind: "entry" }, removed: false, acceptWaitDays: 1 + Math.floor(rnd() * 4) };
    const withEmail = rnd() < 0.5;
    const email: TrackDefinition | null = withEmail
      ? { id: `c${ci}-em`, channel: "email", branch: "main", window: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 })), steps: [{ id: `c${ci}-e1`, waitDays: 0, subject: "Hello {{first_name|there}}", body: "An email.", threading: "new_subject", removed: false }], start: rnd() < 0.5 ? { kind: "entry" } : { kind: "after", trackId: li.id, delayDays: Math.floor(rnd() * 2) }, removed: false }
      : null;
    if (email) features.add(email.start.kind === "after" ? "email-after-linkedin" : "email-beside-linkedin");
    const base = sessions.length === 1 ? [sessions[0]!.id] : pickOf(rnd, [[sessions[0]!.id], [sessions[1]!.id], [sessions[0]!.id, sessions[1]!.id]]);
    // Pools of two and three sessions often (review bot on e261ffa), from the second stream.
    const second = sessions.length >= 2 && base.length === 1 && rnd2() < 0.5 ? [...base, sessions.find((x) => !base.includes(x.id) && x.id !== THIRD_SESSION)!.id] : base;
    const pool = sessions.length === 3 && rnd2() < 0.7 ? [...second, THIRD_SESSION] : second;
    // An SMS track beside the LinkedIn one, at entry or after it, in a share of campaigns: one person's mobile and profile
    // are then pairs of two channels, which must never be mixed (review bot on b21af02).
    const smsRoll = rnd2();
    const sms: TrackDefinition | null = smsRoll < 0.45
      ? { id: `c${ci}-sms`, channel: "sms", branch: "main", window: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 })), steps: [{ id: `c${ci}-t1`, waitDays: 0, subject: "", body: "A text.", threading: "new_subject", removed: false }], start: smsRoll < 0.2 ? { kind: "entry" } : { kind: "after", trackId: li.id, delayDays: 0 }, removed: false }
      : null;
    if (sms) features.add(sms.start.kind === "entry" ? "sms-beside-linkedin" : "sms-after-linkedin");
    const definition: CampaignDefinition = { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: sms ? [SMS_NUMBER] : [], linkedinPool: pool, tracks: [li, ...(email ? [email] : []), ...(sms ? [sms] : [])] };
    campaigns.push({ id: "", definition, li, email, sms });
    const people = 3 + Math.floor(rnd() * 4);
    for (let p = 0; p < people; p++) {
      personNo++;
      const kind = rnd();
      const zone = pickOf(rnd, ZONES);
      const profile = kind < 0.75 ? `https://www.linkedin.com/in/fictional-lead-${seed}-${personNo}` : null;
      const cell = profile ?? (kind < 0.88 ? `https://www.linkedin.com/company/fictional-${personNo}` : "");
      const behaviour = rnd();
      const script: ProfileScript | null =
        profile === null
          ? null
          : behaviour < 0.35
            ? { acceptAfterMs: Math.floor(rnd() * 3 * DAY) + MIN, ...(rnd() < 0.3 ? { acceptReportDelayMs: Math.floor(rnd() * 6 * H) } : {}) }
            : behaviour < 0.55
              ? {}
              : behaviour < 0.68
                ? { connected: true }
                : behaviour < 0.76
                  ? { unreachable: true }
                  : behaviour < 0.84
                    ? { rateLimited: 1, acceptAfterMs: Math.floor(rnd() * 2 * DAY) + MIN }
                    : behaviour < 0.92
                      ? { loseAnswer: 1, acceptAfterMs: rnd() < 0.5 ? Math.floor(rnd() * 2 * DAY) + MIN : null }
                      : { withdrawUnknown: 1 };
      // Q42's and Q37's states, from the second stream: an invite pending from elsewhere, and a connection removed after it.
      const extra = rnd2();
      if (profile !== null && extra < 0.1) {
        // Pending from elsewhere on one session of the pool only, or on every session (review bot on e261ffa). Mostly on the
        // pool's first session: the one session a check kept for the track would ask, the case it gets wrong.
        if (pool.length > 1 && rnd2() < 0.6) Object.assign(script ?? {}, { connected: false, sessions: { [rnd2() < 0.67 ? pool[0]! : pool[Math.floor(rnd2() * pool.length)]!]: { pendingElsewhere: true } } });
        else Object.assign(script ?? {}, { pendingElsewhere: true, connected: false });
      }
      else if (profile !== null && extra < 0.18 && script && !script.connected && !script.unreachable) Object.assign(script, { acceptAfterMs: H, connectionRemoved: true });
      // A withdrawal the session keeps answering unknown, past the count that lists it for the user (item 7's event).
      else if (profile !== null && extra < 0.3 && script && !script.connected && !script.unreachable) Object.assign(script, { withdrawUnknown: 5, acceptAfterMs: null });
      // Pending from elsewhere on the pool's first session only, the others clear (the review bot's reproduction on e261ffa).
      else if (profile !== null && extra < 0.4 && pool.length > 1 && script && !script.connected && !script.unreachable) Object.assign(script, { sessions: { [pool[0]!]: { pendingElsewhere: true } } });
      // Already connected on one session of the pool only, a later one than the first (review bot on e261ffa): the session a
      // check of the first session alone would never find.
      if (script?.connected && pool.length > 1 && rnd2() < 0.5) Object.assign(script, { connected: false, sessions: { [pool[1 + Math.floor(rnd2() * (pool.length - 1))]!]: { connected: true } } });
      if (script?.sessions) features.add("an-answer-of-one-session");
      // A recipient LinkedIn refuses an InMail for (their settings), from the third stream.
      if (script && rnd3() < 0.15) Object.assign(script, { refusesInmail: true });
      // A contested run's first campaign: people who neither accept nor refuse, so InMails chosen together wait together.
      const kept = contested && ci === 0 && profile !== null ? {} : script;
      leads.push({ campaign: ci, name: `Lead${personNo} Fictional`, profile, email: `lead${personNo}@fictional.example`, zone, script: kept, id: "" });
      if (profile && kept) h.linkedin.profiles.set(profile, { ...kept });
      (leads.at(-1) as Lead & { cell?: string }).cell = cell;
    }
  }
  // Two campaigns sharing people (question Q41): the second also enrols some of the first's, with the same profile.
  const rowOf = new Map<Lead, { personId: string; businessId: string }>();
  for (const [ci] of campaigns.entries()) leads.filter((l) => l.campaign === ci).forEach((l, i) => rowOf.set(l, { personId: `p${ci}-${i}`, businessId: `b${ci}` }));
  if (campaigns.length === 2 && rnd2() < 0.7) {
    const firsts = leads.filter((l) => l.campaign === 0 && l.profile !== null);
    for (const l of firsts.slice(0, 1 + Math.floor(rnd2() * 2))) {
      const shared: Lead & { cell?: string } = { ...l, campaign: 1, id: "" };
      leads.push(shared);
      rowOf.set(shared, rowOf.get(l)!);
      features.add("a-person-in-two-campaigns");
    }
  }
  for (const [ci, c] of campaigns.entries()) {
    const own = leads.filter((l) => l.campaign === ci);
    const businessIds = [...new Set(own.map((l) => rowOf.get(l)!.businessId))];
    const { campaign } = await h.createCampaign(`LinkedIn ${ci}`, {
      businesses: businessIds.map((b) => business({ business_id: b, business_name: `Fictional Clinic ${b}`, phone_e164: `+4420794601${10 + Number(b.slice(1))}` })),
      people: own.map((l) => person({ person_id: rowOf.get(l)!.personId, business_id: rowOf.get(l)!.businessId, full_name: l.name, email: l.email, timezone: l.zone, linkedin_url: (l as Lead & { cell?: string }).cell ?? "", dial_phone: mobileOf(l), dial_phone_type: "mobile" })),
    });
    c.id = campaign.id;
    await h.defineSequence(c.id, toApp(c.definition));
    const launched = await h.launch(c.id);
    if (launched.status !== 200) problem(`setup: launch refused ${JSON.stringify(launched.body)}`);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
    for (const l of own) l.id = rows.find((r) => r.name === l.name)?.enrollments.find((e) => e.campaign.id === c.id)?.id ?? "";
  }

  const bounded = () => (options.maxWrites !== undefined && h.writes > options.maxWrites) || (options.maxTicks !== undefined && h.ticks > options.maxTicks);

  // --- The record's own log of what the user did.
  const held = new Map<string, { from: number; to: number | null }[]>();
  const marked = new Map<string, number>();
  const stopped = new Map<string, number>();
  const restarted = new Map<string, number>();
  /** Every stop of a lead, closed by its restart: L3 asks nothing between them. */
  const stops = new Map<string, { from: number; to: number | null }[]>();
  /** Each campaign's LinkedIn pool through the run's pool edits. */
  const pools = new Map<number, { at: number; pool: readonly string[] }[]>(campaigns.map((c, i) => [i, [{ at: -Infinity, pool: c.definition.linkedinPool ?? [] }]]));
  const poolAt = (ci: number, at: number) => (pools.get(ci) ?? []).filter((x) => x.at <= at).at(-1)?.pool ?? [];
  /** Attempts whose handover committed and whose call never happened (the crash): their work is unresolved, with no handover logged. */
  const crashedAttempts: string[] = [];
  const crashTimes: number[] = [];
  const crashed: { subjectId: string; stepId: string; at: number }[] = [];
  /** The user's marks of a stuck withdrawal as withdrawn, by subject and time. */
  const userWithdrawn = new Map<string, number>();
  const campaignHeld = new Map<string, { from: number; to: number | null }[]>();
  const waitEdits = new Map<number, { at: number; days: number }[]>();
  /** Each campaign's InMail fallback through the run's edits (13.8): on while its LinkedIn track has a live InMail step. */
  const fallbackOn = (d: CampaignDefinition, ci: number) => d.tracks.some((t) => t.id === campaigns[ci]!.li.id && t.steps.some((s) => s.role === "inmail" && !s.removed));
  const switches = new Map<number, { at: number; on: boolean }[]>(campaigns.map((c, i) => [i, [{ at: -Infinity, on: fallbackOn(c.definition, i) }]]));
  const fallbackAt = (ci: number, at: number) => (switches.get(ci) ?? []).filter((x) => x.at <= at).at(-1)?.on ?? false;
  /** The switch as the expiry judged it: an edit at the deadline's own instant comes after that instant's tick (seed 24006). */
  const fallbackJudgedAt = (ci: number, at: number) => (switches.get(ci) ?? []).filter((x) => x.at < at).at(-1)?.on ?? false;
  /**
   * The record's own model of each LinkedIn track's steps through the run's edits (council on 8b0c846, item 10): taken from
   * the definitions the run itself sends, never read back from the application.
   */
  const stepsModel = new Map<number, { at: number; steps: readonly StepDefinition[] }[]>(campaigns.map((c, i) => [i, [{ at: -Infinity, steps: c.li.steps }]]));
  /** The steps as an expiry judged at `at` saw them: an edit at that very instant comes after its tick. */
  const stepsJudgedAt = (ci: number, at: number) => (stepsModel.get(ci) ?? []).filter((x) => x.at < at).at(-1)?.steps ?? [];
  const noteSwitch = (ci: number, d: CampaignDefinition) => {
    const on = fallbackOn(d, ci);
    if (on !== fallbackAt(ci, h.clock)) switches.get(ci)!.push({ at: h.clock, on });
    const steps = d.tracks.find((tr) => tr.id === campaigns[ci]!.li.id)?.steps;
    if (steps) stepsModel.get(ci)!.push({ at: h.clock, steps });
  };
  /**
   * The fallback switched off early, before most leads' deadlines, in a share of the campaigns that start with it on (L19:
   * an InMail never goes for a lead whose wait ends after it), drawn from the fourth stream.
   */
  const earlyOff = new Map<number, number>(campaigns.flatMap((c, i) => (fallbackOn(c.definition, i) && rnd4() < 0.35 ? [[i, START + Math.floor((0.5 + rnd4() * 1.5) * DAY)] as const] : [])));
  /** The fallback switched off while a chosen InMail waits to go (L25's case), in a share of the others, from the fourth stream. */
  const offWhenChosen = new Set<number>(campaigns.flatMap((c, i) => (fallbackOn(c.definition, i) && !earlyOff.has(i) && rnd4() < 0.5 ? [i] : [])));
  /**
   * The council's draws on `8b0c846` (items 1, 2, 7, 8), from the fourth stream, each once per campaign or run, at the moment
   * it bites: a running edit of the messages while an InMail is chosen (the first removed, one added, two reordered); a lead
   * with its InMail chosen stopped and restarted later; and the session's report changed between an InMail's claim and its
   * handover (no credit, or no plan), with credits returning a day later.
   */
  // Only where no switch-off is drawn, which would cancel the InMail the edit is about.
  const editWhenChosen = new Map<number, "remove" | "insert" | "reorder">(campaigns.flatMap((c, i) => (fallbackOn(c.definition, i) && !earlyOff.has(i) && !offWhenChosen.has(i) && rnd4() < 0.8 ? [[i, pickOf(rnd4, ["remove", "remove", "insert", "reorder"] as const)] as const] : [])));
  let stopWhenChosen = rnd4() < 0.7 || contested;
  // A contested run leaves campaign 0 and the first session to the contest: its other draws are made and then dropped.
  if (contested) {
    earlyOff.delete(0);
    offWhenChosen.delete(0);
    editWhenChosen.delete(0);
  }
  /** With the drawn stop, the session's credits set to one, so the lead that chooses during the stop holds the last (L27). */
  const contestCredit = rnd4() < 0.6;
  /** Campaigns drawn for an edit or a switch-off while an InMail is chosen: the drawn stop leaves their leads alone. */
  const noStop = new Set<number>([...editWhenChosen.keys(), ...offWhenChosen]);
  // Set after `noStop`: the contest's stop and restart stay on campaign 0.
  if (removeWhenChosen) editWhenChosen.set(0, "remove");
  const restarts: { id: string; at: number }[] = [];
  const drawnAtClaim: "no_credit" | "no_plan" | null = rnd4() < 0.35 ? (rnd4() < 0.7 ? "no_credit" : "no_plan") : null;
  let reportAtClaim = contested ? null : drawnAtClaim;
  const reportsBack: { session: string; at: number; plan: "premium" | "sales_navigator" | "none"; credits: number }[] = [];
  /** The user spending a session's credits by hand (its credits at 0 from then): when, by session. */
  const creditDrops: { session: string; at: number }[] = [];
  /** Each sign-out: from when, until when it was drawn to last, and when the run actually restored it. */
  const signedOut: { id: string; from: number; until: number; restored: number | null }[] = [];
  const healthyAt = (session: string, at: number) => !signedOut.some((o) => o.id === session && o.from <= at && at < (o.restored ?? Infinity));
  const skipped = new Map<string, number[]>();
  /** Every hold of a lead: its own pauses and its campaign's. */
  // A stop freezes the lead's clock as a pause does (ADR 0004 3.4): a stopped lead restarted from its next step was held
  // from its stop to its restart (seed 24093).
  const holdsOf = (l: Lead) => [...(held.get(l.id) ?? []), ...(campaignHeld.get(campaigns[l.campaign]!.id) ?? []), ...(stops.get(l.id) ?? [])];
  const outages: { from: number; to: number }[] = [];
  /**
   * The acceptance deadline by the record's own rule (ADR 0004 9; council on b21af02, item 8): the wait in force at the
   * invite's send, in calendar days in the person's zone, on the lead's clock from the send; each edit of the wait after the
   * send that changes it re-resolves it from the send, and one that puts it before the edit's instant makes it that instant.
   * As a span of the lead's clock from the send, and the edit's instant when that is what it became.
   */
  const deadlineOf = (lead: Lead, sentAt: number, until: number): { span: number; clampedAt: number | null } => {
    const edits = waitEdits.get(lead.campaign) ?? [];
    let days = edits.filter((e) => e.at <= sentAt).at(-1)?.days ?? campaigns[lead.campaign]!.li.acceptWaitDays ?? 1;
    let span = dueAfter(sentAt, days, lead.zone) - sentAt;
    let clampedAt: number | null = null;
    for (const e of edits.filter((x) => x.at > sentAt && x.at <= until)) {
      if (e.days === days) continue;
      days = e.days;
      const reached = e.at - sentAt - heldWithin(sentAt, e.at, holdsOf(lead));
      const fresh = dueAfter(sentAt, days, lead.zone) - sentAt;
      span = Math.max(fresh, reached);
      clampedAt = fresh < reached ? e.at : null;
    }
    return { span, clampedAt };
  };
  /**
   * A session's credits as the engine can know them at `at` (13.5): the last report the session gave by then (a signed-out
   * session reports nothing, so its last report stands; seed 24016), less the InMails it delivered at or after that report.
   */
  /** The report the tick at `at` began with (its first at that instant), else the last before it (seed 24024). */
  const reportAt = (session: string, at: number) => {
    const reports = h.linkedin.inmailReportLog.filter((r) => r.session === session && r.at <= at);
    return reports.find((r) => r.at === at) ?? reports.at(-1);
  };
  const creditsAt = (session: string, at: number): number => {
    // The InMails delivered from that report up to, not including, `at` (an InMail the same tick sends is after its judgment).
    const report = reportAt(session, at);
    if (!report) return 0;
    const since = h.linkedin.deliveryLog.filter((d) => d.action === "inmail" && d.sender === session && d.at >= report.at && d.at < at).length;
    return Math.max(0, report.credits - since);
  };
  /**
   * The deadline the expiry judged at (13.3): an edit of the wait moves it only while the lead still waits, so an edit at or
   * after the deadline it would have had is not applied (the InMail already judged; seed 24016).
   */
  const judgedDeadline = (lead: Lead, sentAt: number): number => {
    let until = sentAt;
    for (const e of [...(waitEdits.get(lead.campaign) ?? [])].sort((a, b) => a.at - b.at)) {
      if (e.at <= sentAt) continue;
      if (deadlineWall(lead, sentAt, until) <= e.at) break;
      until = e.at;
    }
    return deadlineWall(lead, sentAt, until);
  };
  /** Whether the session's report at `at` says Premium or Sales Navigator (its plan can change: the draws of 13.5). */
  const planned = (session: string, at: number = h.clock) => {
    const plan = reportAt(session, at)?.plan;
    return plan === "premium" || plan === "sales_navigator";
  };
  /** Whether that report is fresh enough to judge on (13.5, question Q58's interim: a day). */
  const freshAt = (session: string, at: number) => {
    const report = reportAt(session, at);
    return report !== undefined && at - report.at <= DAY;
  };
  /** The wall instant the deadline is reached: the lead's clock runs only outside its holds (a clamp held: at the resume). */
  const deadlineWall = (lead: Lead, sentAt: number, until: number): number => {
    const { span, clampedAt } = deadlineOf(lead, sentAt, until);
    return clampedAt !== null ? afterHolds(clampedAt, 0, holdsOf(lead)) : afterHolds(sentAt, span, holdsOf(lead));
  };

  // 29 (ADR 0003's invariant 29, as the track runs assert it; the re-check of dd3969c, item 1): the worker's caches follow the
  // stored facts. Right after each of its ticks, a freshly started engine at the same instant, on the same store and
  // providers, finds nothing to change and nothing to hand over. A cache keyed on less than what it read (a change of
  // conversations) leaves the worker idle where a fresh one acts. Not while draining, after a problem, or past the bound.
  let draining = false;
  const freshEvery = options.freshEvery ?? 1;
  let ticksSinceFresh = 0;
  let conversationsSeen = "";
  const conversationsNow = () => {
    const row = (h.store.engine as unknown as { db: DatabaseSync }).db.prepare("SELECT COALESCE(SUM(seq), 0) AS s, COUNT(*) AS n FROM conversation_versions").get() as { s: number; n: number };
    return `${row.n}/${row.s}`;
  };
  h.afterTick = async () => {
    if (draining || bounded() || problems.length > 0 || freshEvery === 0) return;
    // Counted: every Nth tick, and every tick after which a conversation's version moved.
    ticksSinceFresh++;
    const conversations = conversationsNow();
    const moved = conversations !== conversationsSeen;
    conversationsSeen = conversations;
    if (freshEvery > 1 && !moved && ticksSinceFresh < freshEvery) return;
    ticksSinceFresh = 0;
    const handovers = () => h.linkedin.handoverLog.length + (h.smsProvider?.handoverLog.length ?? 0) + h.fake.handoverLog.length;
    const handed = handovers();
    const changed = await h.freshEngineTick();
    const more = handovers() - handed;
    if (changed.length > 0 || more > 0) problem(`29: at ${iso(h.clock)} a fresh engine handed over ${more} and changed what the running worker had left: ${changed.join("; ").slice(0, 600)}`);
  };

  // The report changed between an InMail's claim and its handover (council on 8b0c846, item 8), once per run.
  h.hooks.afterClaim = async (attemptId) => {
    if (reportAtClaim === null) return;
    const a = await h.store.engine.attempt(attemptId);
    if (a?.action !== "inmail") return;
    const session = sessionOfAccount(a.accountId);
    const was = h.linkedin.sessions.get(session)?.inmail;
    if (!was) return;
    const kind = reportAtClaim;
    reportAtClaim = null;
    await storeReport(session, kind === "no_plan" ? { plan: "none", credits: 0 } : { plan: was.plan, credits: 0 });
    reportsBack.push({ session, at: h.clock + DAY, plan: was.plan, credits: was.credits + 1 });
    features.add(`a-report-between-an-inmail-claim-and-its-handover:${kind}`);
  };

  // --- Events.
  const end = START + 12 * DAY;
  let requestNo = 0;
  while (h.clock < end && !bounded()) {
    const step = pickOf(rnd, [10 * MIN, 45 * MIN, 3 * H, 9 * H, DAY]);
    await h.advanceTo(Math.min(end, h.clock + step));
    const roll = rnd();
    const lead = pickOf(rnd, leads);
    if (roll < 0.07 && !stopped.has(lead.id) && !marked.has(lead.id)) {
      // The user pauses a lead, and resumes it later.
      const holds = held.get(lead.id) ?? [];
      const open = holds.find((x) => x.to === null);
      await h.request("POST", `/api/enrollments/${lead.id}/controls`, { requestId: `g-${++requestNo}`, action: open ? "resume" : "pause" });
      if ((await leadPaused(lead.id)) === !open) {
        if (open) open.to = h.clock;
        else holds.push({ from: h.clock, to: null });
        held.set(lead.id, holds);
        features.add(open ? "a-lead-resumed" : "a-lead-paused");
      }
    } else if (roll < 0.13) {
      // The user marks a social reply; refused when nothing went on LinkedIn, or the lead had already replied.
      const r = await h.request("POST", `/api/enrollments/${lead.id}/replies`, { requestId: `g-${++requestNo}`, channel: "linkedin" });
      // By the lead's stored state as well as the answer: a crash armed for the next handover can fail it after its write.
      const repliedNow = (await h.store.engine.subject(lead.id, h.clock))?.subject.ended === "replied";
      if ((r.status === 200 || repliedNow) && !marked.has(lead.id)) {
        marked.set(lead.id, h.clock);
        features.add("a-reply-marked");
      } else if (r.status !== 200) features.add("a-reply-mark-refused");
    } else if (roll < 0.17) {
      // The laptop is off for a while: nothing ticks; the platform carries on (acceptances happen).
      const ms = pickOf(rnd, [2 * H, 14 * H, 2 * DAY]);
      outages.push({ from: h.clock, to: h.clock + ms });
      await h.stopFor(ms);
      features.add("the-laptop-was-off");
    }
    await extraEvent(rnd2());
    await inmailEvent(rnd3());
    for (const [ci, at] of [...earlyOff]) {
      if (at > h.clock) continue;
      earlyOff.delete(ci);
      await switchOff(ci);
    }
    await chosenEvents();
    for (const ci of [...offWhenChosen]) {
      for (const l of leads.filter((x) => x.campaign === ci)) {
        const tp = (await h.store.engine.subject(l.id, h.clock))?.tracks.find((x) => x.trackId === campaigns[ci]!.li.id);
        if (tp?.inmail !== "chosen" || h.linkedin.handoverLog.some((x) => x.subjectId === l.id && x.action === "inmail")) continue;
        offWhenChosen.delete(ci);
        await switchOff(ci);
        features.add("the-fallback-switched-off-while-an-inmail-waits");
        break;
      }
    }
    await check(false);
  }
  for (const s of signedOut) {
    h.linkedin.sessions.get(s.id)!.healthy = true;
    s.restored ??= h.clock;
  }
  await markUnresolved();
  for (const c of campaigns) {
    const open = (campaignHeld.get(c.id) ?? []).find((x) => x.to === null);
    if (!open) continue;
    await h.request("POST", `/api/campaigns/${c.id}/resume`, { requestId: `g-${++requestNo}` });
    if (!(await campaignPaused(c.id))) open.to = h.clock;
    else problem(`setup: the drain's resume of campaign ${c.id} did not take`);
  }
  draining = true;
  // The drain: time passes with no new event, every hold released first.
  for (const l of leads) {
    const open = (held.get(l.id) ?? []).find((x) => x.to === null);
    if (!open) continue;
    await h.request("POST", `/api/enrollments/${l.id}/controls`, { requestId: `g-${++requestNo}`, action: "resume" });
    // A lead stopped while paused cannot be resumed: its hold stays, and nothing of it runs again.
    if (!(await leadPaused(l.id))) open.to = h.clock;
    else if ((await h.store.engine.subject(l.id, h.clock))?.subject.ended == null) problem(`setup: the drain's resume of ${l.id} did not take`);
  }
  // A day at a time, so a broken engine that loops (a claim expired and made again every tick) stops at the same count of
  // engine writes on every machine; the drain's checks then judge what was reached.
  const drainEnd = h.clock + 25 * DAY;
  while (h.clock < drainEnd && !bounded()) {
    await h.advanceTo(Math.min(drainEnd, h.clock + DAY));
    await markUnresolved();
  }
  await check(true);
  return { problems, stats: { features, writes: h.writes, ticks: h.ticks } };

  /**
   * The user settles LinkedIn work the session could not confirm (ADR 0003 5.3, the user's mark; ADR 0004 2.2): after
   * checking LinkedIn they mark it by what the session actually did, as the other generated users do.
   */
  async function markUnresolved(): Promise<void> {
    const attention = (await h.request<{ inviteWithdrawalsUnknown?: { enrollmentId: string; trackId: string }[] }>("GET", "/api/needs-attention")).body;
    for (const w of attention.inviteWithdrawalsUnknown ?? []) {
      const l = leads.find((x) => x.id === w.enrollmentId);
      if (l?.profile) h.linkedin.withdrawByHand(l.profile);
      if ((await h.request("POST", `/api/enrollments/${w.enrollmentId}/invite-withdrawal`, { requestId: `g-${++requestNo}`, trackId: w.trackId, answer: "withdrawn" })).status === 200) {
        userWithdrawn.set(w.enrollmentId, h.clock);
        features.add("a-stuck-withdrawal-marked-by-the-user");
      }
    }
    for (const l of leads) {
      const st = await h.store.engine.subject(l.id, h.clock);
      for (const w of st?.work ?? []) {
        // Every channel's: work a crash left unresolved holds its sender's place in flight until the user settles it.
        if (w.settled !== null || w.unresolvedSince === null) continue;
        const a = st?.attempts.filter((x) => x.idempotencyKey === w.key).at(-1);
        if (!a) continue;
        const went = h.linkedin.deliveryLog.some((d) => d.key === w.key) || (h.smsProvider?.deliveryLog ?? []).some((d) => d.key === w.key) || h.fake.deliveryLog.some((d) => d.key === w.key);
        if (await h.engine.markAttempt(a.id, went ? "sent" : "not_sent")) features.add(went ? "unresolved-marked-sent" : "unresolved-marked-not-sent");
      }
    }
  }

  function li() {
    return h.linkedin;
  }

  /** L18 to L25 (ADR 0004 13.11), from the record's own model of the switch, the deadline, the acceptances and the credits. */
  async function checkInmail(drained: boolean): Promise<void> {
    const li = h.linkedin;
    const now = h.clock;
    const leadOf = (id: string) => leads.find((l) => l.id === id);
    const inviteOf = (id: string) => li.deliveryLog.find((x) => x.subjectId === id && x.action === "invite");
    // L22 (a): the simulated session never had to refuse an InMail for want of a plan or a credit.
    for (const r of li.refusals) if (r.reason === "payment_required") problem(`L22: an InMail was handed to ${r.destination} at ${iso(r.at)} from a session with no plan or no credit`);
    const counted = new Map<string, number>();
    for (const x of li.handoverLog.filter((y) => y.action === "inmail")) {
      const lead = leadOf(x.subjectId);
      if (!lead) continue;
      const refusal = li.refusals.find((r) => r.key === x.key);
      // L18: at most one InMail per lead and session (a refusal for a limit is not one: it is asked again).
      if (refusal?.reason !== "rate_limited") {
        const k = `${x.subjectId}|${x.sender}`;
        counted.set(k, (counted.get(k) ?? 0) + 1);
        if ((counted.get(k) ?? 0) > 1) problem(`L18: ${x.subjectId} was handed a second InMail from ${x.sender} at ${iso(x.at)}`);
      }
      // L19: only while the campaign's fallback is on.
      if (!fallbackAt(lead.campaign, x.at)) problem(`L19: ${x.subjectId}'s InMail was handed over at ${iso(x.at)} with the fallback off`);
      const invite = inviteOf(x.subjectId);
      if (!invite) {
        problem(`L20: ${x.subjectId}'s InMail was handed over with no invite sent`);
        continue;
      }
      // L20: never before the record's own deadline.
      const deadline = judgedDeadline(lead, invite.at);
      if (x.at < deadline) problem(`L20: ${x.subjectId}'s InMail was handed over at ${iso(x.at)}, before the deadline ${iso(deadline)}`);
      // L21: never after the person accepted (the session would have found them connected), nor once connected in time.
      const acceptance = li.acceptanceLog.find((a) => a.key === invite.key);
      if (acceptance && acceptance.at <= x.at && !lead.script?.connectionRemoved) problem(`L21: ${x.subjectId}'s InMail was handed over at ${iso(x.at)}, after they accepted at ${iso(acceptance.at)}`);
      // L22 at the handover (council on 8b0c846, item 8): handed over only on a report, read by then, with a plan and a credit.
      // The last report before the handover, by the provider's own order (seed 24024: a report and a handover at one instant).
      const last = li.inmailReportLog.filter((r) => r.session === x.sender && r.seq < x.seq).at(-1);
      const handedSince = last ? li.handoverLog.filter((y) => y.action === "inmail" && y.sender === x.sender && y.seq > last.seq && y.seq < x.seq && li.deliveryLog.some((d) => d.key === y.key)).length : 0;
      const free = last ? last.credits - handedSince : 0;
      const planOk = last?.plan === "premium" || last?.plan === "sales_navigator";
      if (refusal?.reason !== "rate_limited" && (!planOk || free < 1)) problem(`L22: ${x.subjectId}'s InMail was handed over at ${iso(x.at)} with ${x.sender} reporting ${planOk ? `${free} credits free` : "no plan"}`);
      if (refusal?.reason === "inmail_refused") features.add("an-inmail-refused");
      else if (!refusal) features.add("an-inmail-sent");
    }
    for (const lead of leads) {
      const st = await h.store.engine.subject(lead.id, now);
      const c = campaigns[lead.campaign]!;
      const tp = st?.tracks.find((x) => x.trackId === c.li.id);
      const invite = inviteOf(lead.id);
      if (!st || !tp || !invite) continue;
      const deadline = judgedDeadline(lead, invite.at);
      // A deadline the record cannot place (a hold still open where the lead's clock would reach it): nothing to judge by.
      if (!Number.isFinite(deadline)) continue;
      const sender = invite.sender;
      const state = tp.inmail ?? null;
      const judged = state !== null;
      // L19, at the expiry: judged only with the fallback on then; with it on and no connection, never ignored.
      if (judged && state !== "accepted" && !fallbackJudgedAt(lead.campaign, deadline)) problem(`L19: ${lead.id}'s InMail fallback was judged (${state}) though it was off at the deadline ${iso(deadline)}`);
      if (!judged && tp.finishReason === "invite_not_accepted" && fallbackJudgedAt(lead.campaign, deadline) && !li.deliveryLog.some((x) => x.subjectId === lead.id && x.action !== "invite")) {
        // Edited out after the deadline is the only way the record allows (none happens while the lead's clock stands still).
        problem(`L19: ${lead.id}'s invite expired with the fallback on and no InMail judged`);
      }
      // L22 (b, c): the choice by the session's own standing at the expiry, by the record's plan and credits.
      const choseIt = state !== null && state !== "no_plan" && state !== "no_credit" && state !== "stale_report";
      // The expiry is judged at the first tick at or after the deadline: the deadline, or the end of a laptop outage over it
      // (seed 24018), with the report that tick read.
      const judgedAt = outages.find((o) => o.from <= deadline && deadline < o.to)?.to ?? deadline;
      if (state === "no_plan" && planned(sender, judgedAt)) problem(`L22: ${lead.id}'s InMail was refused as no plan, though ${sender} reported a plan at ${iso(judgedAt)}`);
      if (choseIt && state !== "accepted" && !planned(sender, judgedAt)) problem(`L22: ${lead.id}'s InMail was ${state} from ${sender}, which reported no Premium or Sales Navigator`);
      if (choseIt && !freshAt(sender, judgedAt)) problem(`L22: ${lead.id}'s InMail was chosen on a report older than a day`);
      // Stale only when signed out then: an old report from a signed-in session waits for its next sync (seed 24018).
      if (state === "stale_report" && (freshAt(sender, judgedAt) || healthyAt(sender, judgedAt))) problem(`L22: ${lead.id}'s InMail was refused for an old report, though ${sender} ${freshAt(sender, judgedAt) ? `reported within a day of ${iso(judgedAt)}` : "was signed in"}`);
      if (state === "stale_report") features.add("an-inmail-on-a-stale-report");
      if (choseIt && state !== "accepted" && creditsAt(sender, judgedAt) < 1) problem(`L22: ${lead.id}'s InMail was chosen at ${iso(deadline)} with ${sender} out of credits by the record`);
      if (state === "no_credit") {
        // The credits other tracks had chosen before and not yet spent: a credit is free only beyond them.
        let committed = 0;
        for (const o of leads) {
          if (o.id === lead.id) continue;
          const ot = (await h.store.engine.subject(o.id, now))?.tracks.find((x) => x.trackId === campaigns[o.campaign]!.li.id);
          const oi = inviteOf(o.id);
          if (!ot || !oi || oi.sender !== sender || ot.inmail == null || ot.inmail === "no_plan" || ot.inmail === "no_credit") continue;
          const od = judgedDeadline(o, oi.at);
          const spent = li.deliveryLog.some((x) => x.subjectId === o.id && x.action === "inmail" && x.at <= deadline) || li.refusals.some((r) => r.at <= deadline && li.handoverLog.some((y) => y.key === r.key && y.subjectId === o.id && y.action === "inmail"));
          if (od <= deadline && !spent) committed++;
        }
        if (creditsAt(sender, deadline) - committed >= 1) problem(`L22: ${lead.id}'s InMail was refused for want of a credit at ${iso(deadline)}, though ${sender} had ${creditsAt(sender, deadline)} with ${committed} committed`);
        else features.add("an-inmail-without-a-credit");
      }
      if (state === "no_plan") features.add("an-inmail-without-a-plan");
      // L24: a refused InMail ends the track on the withdrawal path; the profile stays good.
      const refused = li.refusals.some((r) => r.reason === "inmail_refused" && li.handoverLog.some((y) => y.key === r.key && y.subjectId === lead.id));
      if (refused && (state !== "refused" || tp.finishReason !== "invite_not_accepted" || (tp.inviteWithdrawal ?? null) === null)) problem(`L24: ${lead.id}'s InMail was refused, and its track is ${tp.finishReason ?? "running"} (InMail ${state}, withdrawal ${tp.inviteWithdrawal ?? "none"})`);
      if (refused && st.lead.details.some((d) => d.channel === "linkedin" && d.bad)) problem(`L24: ${lead.id}'s profile was marked bad after LinkedIn refused an InMail`);
      // L25: an InMail that went is never undone by a later switch-off: its track does not take the withdrawal path.
      const went = li.deliveryLog.some((x) => x.subjectId === lead.id && x.action === "inmail");
      if (went && tp.finishReason === "invite_not_accepted") problem(`L25: ${lead.id}'s InMail went, and its track took the withdrawal path`);
      // L25, after the drain: a chosen InMail not yet handed over, with the fallback switched off since, takes the withdrawal path.
      // Any switch-off after the choice and before a handover reaches the InMail then, whatever the switch does later.
      const handedAt = li.handoverLog.find((x) => x.subjectId === lead.id && x.action === "inmail")?.at ?? Infinity;
      const judged2 = outages.find((o) => o.from <= deadline && deadline < o.to)?.to ?? deadline;
      const offBefore = (switches.get(lead.campaign) ?? []).find((x) => !x.on && x.at > judged2 && x.at < handedAt);
      const runningAt = (at: number) => !(stops.get(lead.id) ?? []).some((x) => x.from <= at && (x.to === null || at < x.to)) && !(marked.get(lead.id) !== undefined && (marked.get(lead.id) ?? Infinity) <= at);
      if (drained && offBefore && (state === "chosen" || state === "sent") && runningAt(offBefore.at)) problem(`L25: ${lead.id}'s InMail is ${state} though the fallback was switched off at ${iso(offBefore.at)}, after its choice and before any handover`);
      if (state === "switched_off") features.add("an-inmail-switched-off-before-it-went");
      if (state === "accepted") features.add("an-acceptance-before-the-inmail-went");
      // L23, after the drain: the first message never follows an InMail (it took its place).
      if (drained && went) {
        const stored = (await h.request<{ definition: CampaignDefinition }>("GET", `/api/campaigns/${c.id}/sequence`)).body.definition;
        const track = stored.tracks.find((x) => x.id === c.li.id);
        // The message the InMail replaced, as the record's own model had the steps when the expiry chose it, by its place among
        // every step, removed ones included (council on 8b0c846, item 10): a later reorder or removal never moves it.
        const modelled = stepsJudgedAt(lead.campaign, judgedAt);
        const first = modelled.filter((s) => s.role !== "inmail")[1]?.id;
        const at = li.deliveryLog.find((x) => x.subjectId === lead.id && x.action === "inmail")?.at ?? Infinity;
        if (first && li.deliveryLog.some((x) => x.subjectId === lead.id && x.stepId === first && x.at > at)) problem(`L23: ${lead.id}'s first message went after its InMail`);
        // L23, the other side (council on 8b0c846, item 1): a follow-up the user kept is never skipped for the InMail. Every
        // message of the record's own definition after the first, live now, went by the drain on a completed track.
        const kept = modelled.filter((s) => s.role !== "inmail" && !s.removed).slice(1).map((s) => s.id).filter((id) => id !== first && track?.steps.some((s) => s.id === id && !s.removed));
        const untouched = st.subject.ended === null && !stopped.has(lead.id) && !marked.has(lead.id) && !(skipped.get(lead.id)?.length) && tp.finishReason === "completed";
        for (const id of untouched ? kept : []) if (!li.deliveryLog.some((x) => x.subjectId === lead.id && x.stepId === id)) problem(`L23: ${lead.id}'s follow-up ${id} never went after its InMail, its track completed`);
        // And without waiting for completion: a kept follow-up that never went while a later one, in today's order, did.
        if (!(skipped.get(lead.id)?.length)) {
          const order = (track?.steps ?? []).filter((s) => !s.removed && kept.includes(s.id)).map((s) => s.id);
          const sentIds = new Set(li.deliveryLog.filter((x) => x.subjectId === lead.id).map((x) => x.stepId));
          order.forEach((id, i) => {
            if (!sentIds.has(id) && order.slice(i + 1).some((later) => sentIds.has(later))) problem(`L23: ${lead.id}'s follow-up ${id} never went, though a later one did after the InMail`);
          });
        }
      }
    }
    if (drained) await checkCredits();
  }

  /**
   * L26 and L27 (ADR 0004 13.5; council on 8b0c846, items 2 and 7), after the drain, from the record's reports and logs.
   * L26: with c credits reported and n InMails chosen on a session, min(c, n) go: none waits for want of sharing while the
   * session reports a credit free. L27: a lead stopped with its InMail chosen and restarted after another lead's expiry chose
   * on the same session never takes that credit back: it does not go while the other's waits for ever.
   */
  async function checkCredits(): Promise<void> {
    const li = h.linkedin;
    const now = h.clock;
    const states = new Map<string, NonNullable<Awaited<ReturnType<typeof h.store.engine.subject>>>>();
    for (const l of leads) {
      const st = await h.store.engine.subject(l.id, now);
      if (st) states.set(l.id, st);
    }
    const trackOf = (l: Lead) => states.get(l.id)?.tracks.find((t) => t.trackId === campaigns[l.campaign]!.li.id);
    const senderOf = (l: Lead) => li.deliveryLog.find((x) => x.subjectId === l.id && x.action === "invite")?.sender;
    const inmailed = (l: Lead) => li.handoverLog.some((x) => x.subjectId === l.id && x.action === "inmail");
    const running = (l: Lead) => {
      const st = states.get(l.id);
      return st !== undefined && st.subject.ended === null && !st.subject.leadPaused && !campaignHeld.get(campaigns[l.campaign]!.id)?.some((x) => x.to === null);
    };
    for (const s of sessions) {
      const waiting = leads.filter((l) => senderOf(l) === s.id && trackOf(l)?.inmail === "chosen" && trackOf(l)?.finishedAt === null && !inmailed(l) && running(l));
      if (waiting.length === 0) continue;
      if (!planned(s.id, now) || !freshAt(s.id, now) || !li.sessions.get(s.id)?.healthy || (allowances.get(s.id)?.messages ?? 0) === 0) continue;
      if (creditsAt(s.id, now) >= 1) problem(`L26: ${waiting.map((l) => l.id).join(" and ")} still wait for an InMail from ${s.id}, which reports ${creditsAt(s.id, now)} credits free`);
      else features.add("chosen-inmails-beyond-the-credits");
    }
    for (const a of leads) {
      const ta = trackOf(a);
      if (!ta || (ta.inmail !== "chosen" && ta.inmail !== "sent")) continue;
      for (const stop of stops.get(a.id) ?? []) {
        if (stop.to === null) continue;
        for (const b of leads) {
          const tb = trackOf(b);
          const ib = li.deliveryLog.find((x) => x.subjectId === b.id && x.action === "invite");
          if (b.id === a.id || !tb || !ib || senderOf(b) !== senderOf(a) || (tb.inmail !== "chosen" && tb.inmail !== "sent")) continue;
          const db = judgedDeadline(b, ib.at);
          // Chosen before the restart (during the stop, or before it while the stopped lead held the credit).
          if (!(db < stop.to)) continue;
          features.add("a-restart-after-another-took-a-credit");
          if (inmailed(a) && !inmailed(b) && running(b)) problem(`L27: ${a.id}, restarted at ${iso(stop.to)}, had its InMail sent while ${b.id}'s, chosen at ${iso(db)} during its stop, still waits`);
        }
      }
    }
  }

  /** A session's report as it gives it now, stored as an account sync would store it (another process's sync). */
  async function storeReport(session: string, standing: { plan: "premium" | "sales_navigator" | "none"; credits: number }): Promise<void> {
    h.linkedin.sessions.get(session)!.inmail = { ...standing };
    const listed = (await h.linkedin.accounts()).map((a) => ({ ...a, id: linkedinAccountId(a.id) }));
    await h.store.engine.upsertAccounts(listed, h.clock);
  }

  /** The council's draws on `8b0c846`, each at the moment it bites (see `editWhenChosen`). */
  async function chosenEvents(): Promise<void> {
    for (const r of [...restarts]) {
      if (r.at > h.clock) continue;
      restarts.splice(restarts.indexOf(r), 1);
      // Already restarted by the run's own restart event, or ended otherwise since: nothing to restart.
      if (!stopped.has(r.id)) continue;
      if ((await h.request("POST", `/api/enrollments/${r.id}/controls`, { requestId: `g-${++requestNo}`, action: "resume_from_next_step" })).status === 200) {
        restarted.set(r.id, h.clock);
        stopped.delete(r.id);
        const open = (stops.get(r.id) ?? []).find((x) => x.to === null);
        if (open) open.to = h.clock;
        features.add("a-lead-with-a-chosen-inmail-restarted");
      }
    }
    for (const b of [...reportsBack]) {
      if (b.at > h.clock) continue;
      reportsBack.splice(reportsBack.indexOf(b), 1);
      await storeReport(b.session, { plan: b.plan, credits: b.credits });
      features.add("inmail-credits-returned");
    }
    const chosen: Lead[] = [];
    for (const l of leads) {
      const tp = (await h.store.engine.subject(l.id, h.clock))?.tracks.find((x) => x.trackId === campaigns[l.campaign]!.li.id);
      if (tp?.inmail === "chosen" && tp.finishedAt === null && !h.linkedin.handoverLog.some((x) => x.subjectId === l.id && x.action === "inmail")) chosen.push(l);
    }
    for (const l of chosen) {
      const kind = editWhenChosen.get(l.campaign);
      if (kind === undefined) continue;
      editWhenChosen.delete(l.campaign);
      const c = campaigns[l.campaign]!;
      const stored = (await h.request<{ definition: CampaignDefinition }>("GET", `/api/campaigns/${c.id}/sequence`)).body.definition;
      const tracks = stored.tracks.map((tr) => {
        if (tr.id !== c.li.id) return tr;
        const messages = tr.steps.filter((s) => s.role !== "inmail" && !s.removed).slice(1);
        if (kind === "remove" && messages.length > 1) return { ...tr, steps: tr.steps.map((s) => (s.id === messages[0]!.id ? { ...s, removed: true } : s)) };
        if (kind === "insert") {
          const at = tr.steps.findIndex((s) => s.id === messages[0]?.id);
          const added = { id: `${tr.id}-y${++requestNo}`, waitDays: 1, subject: "", body: "A message added while the InMail waits.", threading: "new_subject" as const, removed: false };
          return at < 0 ? tr : { ...tr, steps: [...tr.steps.slice(0, at), added, ...tr.steps.slice(at)] };
        }
        if (kind === "reorder" && messages.length > 2) {
          const [, a, b] = messages;
          const steps = [...tr.steps];
          const ia = steps.findIndex((s) => s.id === a!.id);
          const ib = steps.findIndex((s) => s.id === b!.id);
          [steps[ia], steps[ib]] = [steps[ib]!, steps[ia]!];
          return { ...tr, steps };
        }
        return tr;
      });
      // A track with too few messages for the edit is left alone.
      if (JSON.stringify(tracks) === JSON.stringify(stored.tracks)) continue;
      if ((await h.request("PUT", `/api/campaigns/${c.id}/sequence`, { ...stored, tracks })).status === 200) {
        noteSwitch(l.campaign, { ...stored, tracks });
        features.add(`a-running-edit-while-an-inmail-is-chosen:${kind}`);
      }
    }
    // A lead whose session another lead still waits on (its deadline ahead, its fallback on): the case L27 is about.
    const partnerDeadline = async (l: Lead): Promise<number> => {
      const session = h.linkedin.deliveryLog.find((x) => x.subjectId === l.id && x.action === "invite")?.sender;
      let next = Infinity;
      for (const o of leads) {
        if (o.id === l.id || h.linkedin.deliveryLog.find((x) => x.subjectId === o.id && x.action === "invite")?.sender !== session) continue;
        // Another lead's InMail chosen and waiting now (the common case: one session, waits ending together, a window shut).
        if (chosen.some((x) => x.id === o.id)) return h.clock;
        if (!fallbackAt(o.campaign, h.clock)) continue;
        const ot = (await h.store.engine.subject(o.id, h.clock))?.tracks.find((x) => x.trackId === campaigns[o.campaign]!.li.id);
        if (ot?.acceptByWall != null && (ot.inmail ?? null) === null && ot.finishedAt === null && (ot.connection ?? null) === null && ot.acceptByWall > h.clock) next = Math.min(next, ot.acceptByWall);
      }
      return next;
    };
    const stoppable: Lead[] = [];
    for (const x of chosen) if (!noStop.has(x.campaign) && Number.isFinite(await partnerDeadline(x))) stoppable.push(x);
    if (stopWhenChosen && stoppable.length > 0) {
      stopWhenChosen = false;
      const l = stoppable[0]!;
      const r = await h.request("POST", `/api/enrollments/${l.id}/controls`, { requestId: `g-${++requestNo}`, action: "stop" });
      if (r.status === 200 || (await h.store.engine.subject(l.id, h.clock))?.subject.ended === "stopped_manually") {
        stopped.set(l.id, h.clock);
        stops.set(l.id, [...(stops.get(l.id) ?? []), { from: h.clock, to: null }]);
        // The event is scheduled from what the run observes (the other leads' deadlines on this session); the checks stay the
        // record's own. Restart after the next of them, so another lead may choose while this one is stopped.
        const session = h.linkedin.deliveryLog.find((x) => x.subjectId === l.id && x.action === "invite")?.sender;
        // Restarted just after the other lead's deadline (a minute after the stop when it is chosen already), while its InMail
        // still waits for its window or its sender's next slot.
        const partner = await partnerDeadline(l);
        if (contestCredit && session) {
          const was = h.linkedin.sessions.get(session)?.inmail;
          if (was && (was.plan === "premium" || was.plan === "sales_navigator")) {
            await storeReport(session, { plan: was.plan, credits: 1 });
            features.add("a-credit-contested-by-a-stop");
          }
        }
        // Restart a minute after the other lead's InMail is chosen (now, or at its deadline), before it can go, so the restart
        // meets a credit that lead holds. The event moves the clock itself, to be there at that moment.
        {
          await h.advanceTo(Math.max(h.clock, partner) + MIN);
          if ((await h.request("POST", `/api/enrollments/${l.id}/controls`, { requestId: `g-${++requestNo}`, action: "resume_from_next_step" })).status === 200) {
            restarted.set(l.id, h.clock);
            stopped.delete(l.id);
            const open = (stops.get(l.id) ?? []).find((x) => x.to === null);
            if (open) open.to = h.clock;
            features.add("a-lead-with-a-chosen-inmail-restarted");
          }
        }
        features.add("a-lead-with-a-chosen-inmail-stopped");
      }
    }
  }

  /** The fallback switched off for a campaign, if it is on: its InMail step removed. */
  async function switchOff(ci: number): Promise<void> {
    const c = campaigns[ci]!;
    const stored = (await h.request<{ definition: CampaignDefinition }>("GET", `/api/campaigns/${c.id}/sequence`)).body.definition;
    if (!fallbackOn(stored, ci)) return;
    const tracks = stored.tracks.map((t) => (t.id === c.li.id ? { ...t, steps: t.steps.map((s) => (s.role === "inmail" ? { ...s, removed: true } : s)) } : t));
    if ((await h.request("PUT", `/api/campaigns/${c.id}/sequence`, { ...stored, tracks })).status === 200) {
      noteSwitch(ci, { ...stored, tracks });
      features.add("the-fallback-switched-off-early");
    }
  }

  /**
   * The InMail fallback's events (13.11), from the third stream: the switch turned off (its step removed) or on again (a new
   * InMail step after the invite), the InMail's text changed, and a session's credits spent by the user by hand.
   */
  async function inmailEvent(roll: number): Promise<void> {
    if (roll >= 0.08) return;
    const ci = Math.floor(rnd3() * campaigns.length);
    const c = campaigns[ci]!;
    if (roll < 0.05) {
      if (contested && ci === 0) return;
      const stored = (await h.request<{ definition: CampaignDefinition }>("GET", `/api/campaigns/${c.id}/sequence`)).body.definition;
      const on = fallbackOn(stored, ci);
      const text = roll < 0.015 && on;
      const tracks = stored.tracks.map((t) => {
        if (t.id !== c.li.id) return t;
        if (text) return { ...t, steps: t.steps.map((s) => (s.role === "inmail" && !s.removed ? { ...s, body: `An edited InMail ${requestNo}, {{first_name|there}}.` } : s)) };
        if (on) return { ...t, steps: t.steps.map((s) => (s.role === "inmail" ? { ...s, removed: true } : s)) };
        const at = t.steps.findIndex((s) => !s.removed);
        const added = { id: `${t.id}-im${++requestNo}`, waitDays: 0, subject: "", body: "A new InMail, {{first_name|there}}.", threading: "new_subject" as const, removed: false, role: "inmail" as const };
        return { ...t, steps: [...t.steps.slice(0, at + 1), added, ...t.steps.slice(at + 1)] };
      });
      if ((await h.request("PUT", `/api/campaigns/${c.id}/sequence`, { ...stored, tracks })).status === 200) {
        noteSwitch(ci, { ...stored, tracks });
        features.add(text ? "an-inmail-text-edited" : on ? "the-fallback-switched-off" : "the-fallback-switched-on");
      }
      return;
    }
    const s = pickOf(rnd3, sessions);
    const standing = h.linkedin.sessions.get(s.id)?.inmail;
    if (standing && standing.credits > 0 && !(contested && s === sessions[0])) {
      standing.credits = 0;
      creditDrops.push({ session: s.id, at: h.clock });
      features.add("inmail-credits-spent-by-hand");
    }
  }

  /** Whether the campaign is paused, by its read. */
  async function campaignPaused(id: string): Promise<boolean> {
    return (await h.request<{ pause: { paused: boolean } }>("GET", `/api/campaigns/${id}`)).body.pause.paused;
  }

  /** Whether the lead is paused, by its own stored state. */
  async function leadPaused(id: string): Promise<boolean> {
    return (await h.store.engine.subject(id, h.clock))?.subject.leadPaused === true;
  }

  async function extraEvent(roll: number): Promise<void> {
    if (roll > 0.9) await markUnresolved();
    if (roll >= 0.2 && roll < 0.24) {
      // A stopped lead restarted from its next step: L3 holds only between its stop and its restart.
      const target = leads.find((l) => stopped.has(l.id));
      if (target && (await h.request("POST", `/api/enrollments/${target.id}/controls`, { requestId: `g-${++requestNo}`, action: "resume_from_next_step" })).status === 200) {
        restarted.set(target.id, h.clock);
        stopped.delete(target.id);
        const open = (stops.get(target.id) ?? []).find((x) => x.to === null);
        if (open) open.to = h.clock;
        features.add("a-stopped-lead-restarted");
      }
      return;
    }
    if (roll >= 0.24 && roll < 0.27 && sessions.length >= 2) {
      // A pool edit: a session added to or removed from a campaign's pool (a fixed sender keeps its lead's track).
      const c = campaigns[Math.floor(rnd2() * campaigns.length)]!;
      const stored = (await h.request<{ definition: CampaignDefinition }>("GET", `/api/campaigns/${c.id}/sequence`)).body.definition;
      // The app names a session `linkedin:` and its id; the record keeps the provider's own ids.
      const pool = (stored.linkedinPool ?? []).map(sessionOfAccount);
      // Add a session the pool lacks, or remove one, half and half when both can be (pools of up to three).
      const missing = sessions.map((x) => x.id).filter((id) => !pool.includes(id));
      const add = missing.length > 0 && (pool.length < 2 || rnd2() < 0.5);
      const next = add ? [...pool, missing[Math.floor(rnd2() * missing.length)]!] : pool.filter((_, i) => i !== Math.floor(rnd2() * pool.length));
      if ((await h.request("PUT", `/api/campaigns/${c.id}/sequence`, { ...stored, linkedinPool: next.map(linkedinAccountId) })).status === 200) {
        c.definition = { ...c.definition, linkedinPool: next };
        pools.get(campaigns.indexOf(c))!.push({ at: h.clock, pool: next });
      }
      if (c.definition.linkedinPool === next) features.add(next.length > pool.length ? "a-session-added-to-a-pool" : "a-session-removed-from-a-pool");
      return;
    }
    if (roll >= 0.27 && roll < 0.29) {
      // A re-import that gives a person another profile: their started track's old profile is no longer theirs.
      const pool = leads.filter((l) => l.profile !== null && leads.filter((x) => x.name === l.name).length === 1);
      // Drawn before the pool is checked, so an empty pool takes the same draw from the stream.
      const draw = rnd2();
      if (pool.length === 0) return;
      const target = pool[Math.floor(draw * pool.length)]!;
      const row = rowOf.get(target)!;
      const url = `https://www.linkedin.com/in/fictional-lead-${seed}-moved-${requestNo}`;
      const r = await h.request("POST", `/api/campaigns/${campaigns[target.campaign]!.id}/imports`, csvOf({
        businesses: [business({ business_id: row.businessId, business_name: `Fictional Clinic ${row.businessId}`, phone_e164: `+4420794601${10 + Number(row.businessId.slice(1))}` })],
        people: [person({ person_id: row.personId, business_id: row.businessId, full_name: target.name, email: target.email, timezone: target.zone, linkedin_url: url, dial_phone: mobileOf(target), dial_phone_type: "mobile" })],
      }));
      if (r.status === 201) {
        target.former = [...(target.former ?? []), target.profile!];
        target.profile = url;
        target.script = {};
        h.linkedin.profiles.set(url, {});
        features.add("a-profile-changed-by-a-reimport");
      }
      return;
    }
    if (roll >= 0.29 && roll < 0.33 && campaigns.length === 2) {
      // A person of the first campaign imported into the second later (Q41): after the first's invite was withdrawn and
      // never accepted (the pair is free again: the second campaign invites), or while the first owns the pair (it skips).
      const inSecond = new Set(leads.filter((l) => l.campaign === 1).map((l) => l.name));
      const candidates = leads.filter((l) => l.campaign === 0 && l.profile !== null && !inSecond.has(l.name) && (l.former ?? []).length === 0);
      const freed = candidates.filter((l) => li().deliveryLog.some((d) => d.subjectId === l.id && d.action === "invite" && (li().withdrawalLog.some((w) => w.key === d.key && w.answer === "withdrawn") || li().handWithdrawalLog.some((w) => w.key === d.key))));
      const pool = freed.length > 0 && rnd2() < 0.8 ? freed : candidates;
      const draw = rnd2();
      if (pool.length === 0) return;
      const target = pool[Math.floor(draw * pool.length)]!;
      const row = rowOf.get(target)!;
      const r = await h.request("POST", `/api/campaigns/${campaigns[1]!.id}/imports`, csvOf({
        businesses: [business({ business_id: row.businessId, business_name: `Fictional Clinic ${row.businessId}`, phone_e164: `+4420794601${10 + Number(row.businessId.slice(1))}` })],
        people: [person({ person_id: row.personId, business_id: row.businessId, full_name: target.name, email: target.email, timezone: target.zone, linkedin_url: target.profile!, dial_phone: mobileOf(target), dial_phone_type: "mobile" })],
      }));
      if (r.status !== 201) return;
      const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaigns[1]!.id}`)).body.rows;
      const id = rows.find((x) => x.name === target.name)?.enrollments.find((e) => e.campaign.id === campaigns[1]!.id)?.id;
      if (!id) return;
      const late: Lead = { ...target, campaign: 1, id };
      leads.push(late);
      rowOf.set(late, row);
      features.add(freed.includes(target) ? "a-person-enrolled-after-a-release" : "a-person-enrolled-later");
      return;
    }
    for (const s of signedOut) {
      if (s.until > h.clock || s.restored !== null) continue;
      h.linkedin.sessions.get(s.id)!.healthy = true;
      s.restored = h.clock;
    }
    const lead = pickOf(rnd2, leads);
    const c = campaigns[lead.campaign]!;
    if (roll < 0.04 && !stopped.has(lead.id)) {
      const r = await h.request("POST", `/api/enrollments/${lead.id}/controls`, { requestId: `g-${++requestNo}`, action: "stop" });
      if (r.status === 200 || (await h.store.engine.subject(lead.id, h.clock))?.subject.ended === "stopped_manually") {
        stopped.set(lead.id, h.clock);
        stops.set(lead.id, [...(stops.get(lead.id) ?? []), { from: h.clock, to: null }]);
        features.add("a-lead-stopped");
      }
    } else if (roll < 0.07) {
      const holds = campaignHeld.get(c.id) ?? [];
      const open = holds.find((x) => x.to === null);
      await h.request("POST", `/api/campaigns/${c.id}/${open ? "resume" : "pause"}`, { requestId: `g-${++requestNo}` });
      // By the campaign's read, not the answer's status: a crash armed for the next handover can fail the request after its
      // write committed.
      if ((await campaignPaused(c.id)) === !open) {
        if (open) open.to = h.clock;
        else holds.push({ from: h.clock, to: null });
        campaignHeld.set(c.id, holds);
        features.add(open ? "a-campaign-resumed" : "a-campaign-paused");
      }
    } else if (roll < 0.11) {
      // Skips at every state, aimed at a lead waiting for acceptance more than half the time (the review bot's item 9).
      const waiting: Lead[] = [];
      for (const l of leads) {
        const t = (await h.store.engine.subject(l.id, h.clock))?.tracks.find((x) => x.trackId === campaigns[l.campaign]!.li.id);
        if (t?.acceptBy != null && t.connection == null && t.finishedAt === null) waiting.push(l);
      }
      if (waiting.length > 0 && rnd2() < 0.6) {
        const target = pickOf(rnd2, waiting);
        const r = await h.request("POST", `/api/enrollments/${target.id}/controls`, { requestId: `g-${++requestNo}`, action: "skip" });
        // Noted as every skip is, so the checks that read the record's skips see it (seed 24024: two messages skipped this way).
        if (r.status === 200) {
          skipped.set(target.id, [...(skipped.get(target.id) ?? []), h.clock]);
          features.add("a-skip-while-waiting-for-acceptance");
        }
        return;
      }
      const st = await h.store.engine.subject(lead.id, h.clock);
      const tp = st?.tracks.find((t) => t.trackId === c.li.id);
      const r = await h.request("POST", `/api/enrollments/${lead.id}/controls`, { requestId: `g-${++requestNo}`, action: "skip" });
      if (r.status === 200) {
        skipped.set(lead.id, [...(skipped.get(lead.id) ?? []), h.clock]);
        features.add(tp?.acceptBy != null && tp.connection == null && tp.finishedAt === null ? "a-skip-while-waiting-for-acceptance" : tp?.nextStepId === c.li.steps[0]?.id ? "a-skip-of-the-invite" : "a-skip");
      }
    } else if (roll < 0.13) {
      const s = pickOf(rnd2, sessions);
      h.linkedin.sessions.get(s.id)!.healthy = false;
      signedOut.push({ id: s.id, from: h.clock, until: h.clock + pickOf(rnd2, [H, 8 * H]), restored: null });
      features.add("a-session-signed-out");
    } else if (roll < 0.15) {
      let armed = true;
      h.hooks.crashPoint = (point, attemptId) => {
        if (armed && point === "after_handover_commit") {
          armed = false;
          if (attemptId) {
            crashedAttempts.push(attemptId);
            crashTimes.push(h.clock);
          }
          features.add("a-crash-between-the-handover-and-its-answer");
          throw new Crash(point);
        }
      };
    } else if (roll < 0.2) {
      // A running edit of the LinkedIn track (ticket 19's rules): the wait for acceptance, or the messages.
      const stored = (await h.request<{ definition: CampaignDefinition }>("GET", `/api/campaigns/${c.id}/sequence`)).body.definition;
      const kind = pickOf(rnd2, ["wait", "wait", "insert", "remove", "reorder"] as const);
      const tracks = stored.tracks.map((t) => {
        if (t.id !== c.li.id) return t;
        const live = t.steps.filter((x) => !x.removed);
        if (kind === "wait") return { ...t, acceptWaitDays: 1 + Math.floor(rnd2() * 4) };
        if (kind === "insert") return { ...t, steps: [...t.steps, { id: `${t.id}-x${requestNo}`, waitDays: Math.floor(rnd2() * 2), subject: "", body: "An added message.", threading: "new_subject" as const, removed: false }] };
        if (kind === "remove" && live.length > 2) {
          const gone = live[1 + Math.floor(rnd2() * (live.length - 1))]!.id;
          return { ...t, steps: t.steps.map((x) => (x.id === gone ? { ...x, removed: true } : x)) };
        }
        if (kind === "reorder" && live.length > 2) {
          const [inv, a, b, ...rest] = t.steps;
          return a && b && inv ? { ...t, steps: [inv, b, a, ...rest] } : t;
        }
        return t;
      });
      const r = await h.request("PUT", `/api/campaigns/${c.id}/sequence`, { ...stored, tracks });
      if (r.status === 200) {
        noteSwitch(lead.campaign, { ...stored, tracks });
        features.add(`a-running-edit:${kind}`);
        const days = tracks.find((t) => t.id === c.li.id)?.acceptWaitDays;
        if (kind === "wait" && days !== undefined) {
          waitEdits.set(lead.campaign, [...(waitEdits.get(lead.campaign) ?? []), { at: h.clock, days }]);
          // L8 at the edit itself: every lead still waiting has the deadline the record works out, on the lead's clock.
          await h.tick();
          for (const l of leads.filter((x) => x.campaign === lead.campaign)) {
            const st = await h.store.engine.subject(l.id, h.clock);
            const t = st?.tracks.find((x) => x.trackId === c.li.id);
            const invite = h.linkedin.deliveryLog.find((x) => x.subjectId === l.id && x.action === "invite" && x.visibleAt !== Infinity);
            const sent = st?.results.find((r) => r.trackId === c.li.id && r.stepId === c.li.steps[0]!.id && r.result === "sent");
            // A lead whose InMail fallback the expiry already judged waits no more (13.3): its deadline is spent. An ended lead's
            // clock stopped with it, so its deadline is not the record's to work out (seeds 24044, 24049: a reply marked).
            if (!st || st.subject.ended !== null || !t || !invite || !sent || t.finishedAt !== null || (t.connection ?? null) !== null || t.acceptBy == null || (t.inmail ?? null) !== null) continue;
            const { span } = deadlineOf(l, invite.at, h.clock);
            if (t.acceptBy !== sent.at + span) problem(`L8: after the wait was edited to ${days} days at ${iso(h.clock)}, ${l.id}'s deadline is ${t.acceptBy - sent.at} ms of its clock after the send, not ${span}`);
            else features.add("a-deadline-checked-at-an-edit");
          }
        }
      }
    }
  }

  // --- The checks, from the record and the providers' logs.
  async function check(drained: boolean): Promise<void> {
    const li = h.linkedin;
    const now = h.clock;
    while (crashed.length < crashedAttempts.length) {
      const a = await h.store.engine.attempt(crashedAttempts[crashed.length]!);
      crashed.push({ subjectId: a?.subjectId ?? "", stepId: a?.stepId ?? "", at: crashTimes[crashed.length] ?? 0 });
    }
    // A lead that replied may be restarted from its next unsent step (ADR 0003: "for a lead that replied or was stopped"):
    // L3 asks nothing after a mark only until a restart after it.
    const restartedSince = (subjectId: string, mark: number, at: number): boolean => {
      const restart = restarted.get(subjectId);
      return restart !== undefined && restart > mark && at >= restart;
    };
    const allowanceOf = (session: string) => allowances.get(session) ?? { invites: 0, messages: 0, notes: 0 };
    const leadOfSubject = (id: string) => leads.find((l) => l.id === id);
    // The sessions a lead's LinkedIn step may go from, by the record: the session of its conversation once one is taken (its
    // invite's handover, or the check that found it connected), else its campaign's pool now.
    const poolsEver = (ci: number) => new Set((pools.get(ci) ?? []).flatMap((x) => x.pool));
    // The session of the first check that found this subject connected, from the provider's own log (the re-check of dd3969c,
    // item 5): the check is the subject's own, on any profile the person has had.
    // A connection the check found, not one its own accepted invite made: a "connected" answer before any invite of its own
    // went (the check before a message answers "connected" too, once an invite is accepted).
    const connectedCheckOf = (lead: Lead): { session: string; at: number } | undefined => {
      const found = li.presendLog.find((x) => x.subjectId === lead.id && x.answer === "connected" && [lead.profile, ...(lead.former ?? [])].includes(x.destination) && poolsEver(lead.campaign).has(x.sender));
      if (!found || li.deliveryLog.some((d) => d.subjectId === lead.id && d.action === "invite" && d.at <= found.at)) return undefined;
      return { session: found.sender, at: found.at };
    };
    const connectedSessionOf = (lead: Lead): string | undefined => connectedCheckOf(lead)?.session;
    const sessionsOf = (lead: Lead): readonly string[] => {
      const invited = li.deliveryLog.find((d) => d.subjectId === lead.id && d.action === "invite")?.sender;
      if (invited) return [invited];
      const connected = connectedSessionOf(lead);
      return connected ? [connected] : (campaigns[lead.campaign]!.definition.linkedinPool ?? []);
    };
    /** Whether another subject holds this session's conversation with the lead's profile now, by the record's rule (Q41). */
    const ownedByOther = (lead: Lead, session: string): boolean =>
      lead.profile !== null &&
      (li.handoverLog.some((x) => x.subjectId !== lead.id && x.sender === session && x.destination === lead.profile && releaseOf(x.subjectId, session, x.destination) === null) ||
        leads.some((o) => o.id !== lead.id && o.profile === lead.profile && connectedSessionOf(o) === session));
    /** Whether the lead's profile, now or before, is no other lead's: no other subject's pair can take a session out. */
    const soleOwnerOf = (lead: Lead): boolean => {
      const mine = [lead.profile, ...(lead.former ?? [])];
      return !leads.some((o) => o.id !== lead.id && [o.profile, ...(o.former ?? [])].some((p) => p !== null && mine.includes(p)));
    };
    /** The sessions the lead's LinkedIn step may go from now: its own, less those whose pair another subject holds (seed 24069). */
    const usableSessions = (lead: Lead): readonly string[] => sessionsOf(lead).filter((id) => !ownedByOther(lead, id) && healthyAt(id, now));

    // A handover whose outcome the session never told: neither refused nor delivered visibly.
    const unknownOutcome = (key: string) => !li.refusals.some((r) => r.key === key) && !li.deliveryLog.some((d) => d.key === key && d.visibleAt !== Infinity);
    /**
     * When a subject's conversation on a pair ends by the record's rule (Q41), or null while it holds: nothing went (each
     * handover refused, for a reason that is not a wait), or every invite it sent was withdrawn, by the session or by the
     * user's hand and mark, and never accepted, with no message.
     */
    const releaseOf = (subject: string, sender: string, destination: string): number | null => {
      const handed = li.handoverLog.filter((x) => x.subjectId === subject && x.sender === sender && x.destination === destination);
      const delivered = li.deliveryLog.filter((d) => d.subjectId === subject && d.sender === sender && d.destination === destination);
      if (delivered.some((d) => d.action !== "invite")) return null;
      if (delivered.length === 0) {
        const refused = handed.map((x) => li.refusals.find((r) => r.key === x.key && r.reason !== "rate_limited")?.at);
        return refused.length > 0 && refused.every((r) => r !== undefined) ? Math.max(...(refused)) : null;
      }
      if (delivered.some((d) => li.acceptanceLog.some((a) => a.key === d.key))) return null;
      const outs = delivered.map((d) => li.withdrawalLog.find((w) => w.key === d.key && w.answer === "withdrawn")?.at ?? (li.handWithdrawalLog.some((w) => w.key === d.key) ? (userWithdrawn.get(subject) ?? null) : null));
      return outs.every((o) => o !== null) ? Math.max(...(outs)) : null;
    };

    /**
     * Whether a subject's invite on a pair was being withdrawn at `at` by the record's own rule (seed 24046): delivered, its
     * acceptance deadline passed before `at`, and neither the session nor the user had answered the withdrawal by then.
     * Its conversation's fate is then unknown: another subject waits on it, never skips.
     */
    // Each lead's InMail fallback as the engine stored it, which L22 to L25 check against the record's own judgment. A
    // track whose InMail was chosen, went, or was overtaken by an acceptance left its invite open (Q50): its conversation
    // is held, not being withdrawn (seed 24071).
    const inmailHeld = new Set<string>();
    for (const l of leads) {
      const t = (await h.store.engine.subject(l.id, now))?.tracks.find((x) => x.trackId === campaigns[l.campaign]!.li.id);
      if (t?.inmail === "chosen" || t?.inmail === "sent" || t?.inmail === "accepted") inmailHeld.add(l.id);
    }
    const beingWithdrawn = (subject: string, session: string, profile: string, at: number): boolean => {
      if (inmailHeld.has(subject)) return false;
      const owner = leadOfSubject(subject);
      const invite = li.deliveryLog.find((d) => d.subjectId === subject && d.sender === session && d.destination === profile && d.action === "invite");
      if (!owner || !invite || li.deliveryLog.some((d) => d.subjectId === subject && d.destination === profile && d.action !== "invite")) return false;
      const answered = li.withdrawalLog.some((w) => w.key === invite.key && w.answer !== "unknown" && w.at <= at) || li.handWithdrawalLog.some((w) => w.key === invite.key && w.at <= at);
      // An invite accepted, and the acceptance reported, by then is a known conversation, not one being withdrawn (seeds 24035, 24071).
      const accepted = li.acceptanceLog.some((a) => a.key === invite.key && a.at + (owner.script?.acceptReportDelayMs ?? 0) <= at);
      return !answered && !accepted && deadlineWall(owner, invite.at, at) < at;
    };

    /** Whether the record finds the hold the read states (L13 takes no hold on the engine's word). */
    const derivable = (lead: Lead, trackId: string, stepId: string, hold: string): boolean => {
      const c = campaigns[lead.campaign]!;
      if (trackId === c.li.id) {
        // Held as pending from elsewhere only when every session it may use has an invite pending there (review bot on e261ffa).
        if (hold === "invite_pending_elsewhere") return stepId === c.li.steps[0]!.id && lead.profile !== null && usableSessions(lead).length > 0 && usableSessions(lead).every((id) => pendingOn(li.profiles.get(lead.profile!) ?? {}, id));
        if (hold === "unresolved") return crashed.some((x) => x.subjectId === lead.id && x.stepId === stepId) || li.handoverLog.some((x) => x.subjectId === lead.id && x.stepId === stepId && unknownOutcome(x.key));
        if (hold === "sms_conversation_unsettled") return li.handoverLog.some((x) => x.subjectId !== lead.id && x.destination === lead.profile && sessionsOf(lead).includes(x.sender) && (unknownOutcome(x.key) || beingWithdrawn(x.subjectId, x.sender, x.destination, now)));
        return false;
      }
      const log = trackId === c.sms?.id ? (h.smsProvider?.handoverLog ?? []) : h.fake.handoverLog;
      if (hold === "unresolved") return crashed.some((x) => x.subjectId === lead.id && x.stepId === stepId) || log.some((x) => x.subjectId === lead.id && x.stepId === stepId);
      if (hold === "sms_conversation_unsettled") return log.some((x) => x.subjectId !== lead.id && x.destination === mobileOf(lead));
      return false;
    };

    // L1: one invite per (session, profile) across every campaign and test run, unless every earlier one was withdrawn
    // before it (a withdrawn, never-accepted invite leaves no conversation, Q41); and each step delivered at most once.
    const seen = new Set<string>();
    for (const d of li.deliveryLog) {
      if (d.action === "invite") {
        const earlier = li.deliveryLog.filter((x) => x.action === "invite" && x.sender === d.sender && x.destination === d.destination && x.at < d.at);
        // Withdrawn by the session, or by the user's own hand on LinkedIn (then marked withdrawn; seed 24073).
        const outstanding = earlier.filter((x) => !(li.withdrawalLog.some((w) => w.key === x.key && w.answer === "withdrawn" && w.at <= d.at) || li.handWithdrawalLog.some((w) => w.key === x.key && w.at <= d.at)) || li.acceptanceLog.some((a) => a.key === x.key));
        if (outstanding.length > 0) problem(`L1: ${d.sender} invited ${d.destination} again at ${iso(d.at)} (for ${d.subjectId}) with an earlier invite outstanding`);
        if (earlier.length > 0) features.add("a-second-invite-after-a-withdrawal");
      }
      const key = `${d.subjectId}|${d.stepId}`;
      if (seen.has(key)) problem(`L1: ${d.subjectId} was sent step ${d.stepId} twice`);
      seen.add(key);
    }
    // L11: no pair ever moves: every action to a (session, profile) is its first subject's, until that subject's invite there
    // was withdrawn unaccepted with no message; and L12: a reply is marked only on the subject that reached the person.
    const ownerOf = new Map<string, { subject: string; releasedAt: number | null }>();
    for (const x of [...li.handoverLog].sort((a, b) => a.at - b.at)) {
      const pair = `${x.sender}|${x.destination}`;
      const own = ownerOf.get(pair);
      if (own && own.subject !== x.subjectId && (own.releasedAt === null || own.releasedAt > x.at)) problem(`L11: ${x.subjectId}'s ${x.action} to ${x.destination} from ${x.sender} at ${iso(x.at)}, a pair ${own.subject} owns`);
      if (!own || own.subject !== x.subjectId) {
        const invites = li.deliveryLog.filter((d) => d.subjectId === x.subjectId && d.sender === x.sender && d.destination === x.destination && d.action === "invite");
        const messaged = li.deliveryLog.some((d) => d.subjectId === x.subjectId && d.sender === x.sender && d.destination === x.destination && d.action !== "invite");
        // Withdrawn by the session, or by the user's hand and released by their mark (seed 24073), as the release rule has it.
        const withdrawn = invites.map((d) => li.withdrawalLog.find((w) => w.key === d.key && w.answer === "withdrawn")?.at ?? (li.handWithdrawalLog.some((w) => w.key === d.key) ? (userWithdrawn.get(x.subjectId) ?? null) : null));
        const released = !messaged && invites.length > 0 && withdrawn.every((w) => w !== null) && !invites.some((d) => li.acceptanceLog.some((a) => a.key === d.key)) ? Math.max(...withdrawn.map(Number)) : null;
        if (!own || (own.releasedAt !== null && own.releasedAt <= x.at)) ownerOf.set(pair, { subject: x.subjectId, releasedAt: released });
      }
    }
    for (const [id] of marked) {
      // Reached: something delivered, or handed over with its outcome still untold at the mark; a refused handover or a
      // connection found by the check is not outreach (council on b21af02, item 5).
      const at = marked.get(id) ?? 0;
      const untold = (key: string) => !li.refusals.some((r) => r.key === key && r.at <= at) && !li.deliveryLog.some((d) => d.key === key && d.at <= at);
      // A handover the application committed and then crashed before asking the session is, to the application, handed with
      // its outcome untold: it may have reached them (seed 24084), so the mark is allowed.
      const crashedBefore = crashed.some((x) => x.subjectId === id && x.at <= at);
      if (!crashedBefore && !li.deliveryLog.some((d) => d.subjectId === id && d.at <= at) && !li.handoverLog.some((x) => x.subjectId === id && x.at <= at && untold(x.key))) problem(`L12: ${id} was marked replied on LinkedIn though nothing reached them there`);
    }

    // L2, on the handover log: the engine never even asks the session for a message before the track's connection (an
    // acceptance of its invite, or the check found it connected). The platform would refuse it; the engine must not try.
    for (const d of li.handoverLog.filter((x) => x.action === "message")) {
      const invite = li.deliveryLog.find((x) => x.subjectId === d.subjectId && x.trackId === d.trackId && x.action === "invite");
      const accepted = invite ? li.acceptanceLog.find((a) => a.key === invite.key && a.at <= d.at) : undefined;
      const connected = li.presendLog.some((p) => p.destination === d.destination && p.sender === d.sender && p.answer === "connected" && p.at <= d.at) && !invite;
      // L23: a follow-up goes without a connection only after an InMail delivered from that session to that profile (13.4).
      const afterInmail = li.deliveryLog.some((x) => x.subjectId === d.subjectId && x.action === "inmail" && x.sender === d.sender && x.destination === d.destination && x.at <= d.at && x.visibleAt <= d.at);
      if (!accepted && !connected && !afterInmail) problem(`${invite && li.deliveryLog.some((x) => x.subjectId === d.subjectId && x.action === "inmail") ? "L23" : "L2"}: ${d.subjectId}'s ${d.stepId} was handed over at ${iso(d.at)} before any connection or InMail known sent`);
      if (afterInmail && !accepted) features.add("a-follow-up-after-an-inmail");
    }
    for (const d of li.deliveryLog.filter((x) => x.action === "message")) {
      const invite = li.deliveryLog.find((x) => x.subjectId === d.subjectId && x.trackId === d.trackId && x.action === "invite");
      const accepted = invite ? li.acceptanceLog.find((a) => a.key === invite.key && a.at <= d.at) : undefined;
      const connected = !invite;
      if (accepted) features.add("a-message-after-acceptance");
      if (connected) features.add("a-message-to-an-existing-connection");
      // L3: nothing after a marked reply.
      const mark = marked.get(d.subjectId);
      if (mark !== undefined && d.at > mark && !restartedSince(d.subjectId, mark, d.at)) problem(`L3: ${d.subjectId} was sent ${d.stepId} at ${iso(d.at)}, after the reply marked at ${iso(mark)}`);
    }
    for (const x of li.handoverLog) {
      const mark = marked.get(x.subjectId);
      if (mark !== undefined && x.at > mark && !restartedSince(x.subjectId, mark, x.at)) problem(`L3: ${x.subjectId}'s ${x.stepId} was handed over after the reply marked at ${iso(mark)}`);
      const stop = (stops.get(x.subjectId) ?? []).find((y) => y.from < x.at && (y.to === null || x.at < y.to))?.from;
      // Q42's interim: an invite pending from elsewhere is never sent again (L1).
      if (x.action === "invite" && pendingOn(h.linkedin.profiles.get(x.destination) ?? {}, x.sender)) problem(`L1: ${x.subjectId} was handed an invite to ${x.destination}, which already has one pending from elsewhere`);
      if (stop !== undefined && x.at > stop) problem(`L3: ${x.subjectId}'s ${x.stepId} was handed over after the lead was stopped at ${iso(stop)}`);
    }
    // L16: every handover goes on its own channel, from the sender the record expects: a LinkedIn action to the person's
    // profile on the LinkedIn track (an invite from a session of its campaign's pool then, a message from its conversation's
    // session), and a text to their mobile from the SMS number on the SMS track (review bot and council on b21af02).
    for (const x of li.handoverLog) {
      const lead = leadOfSubject(x.subjectId);
      if (!lead) continue;
      const c = campaigns[lead.campaign]!;
      if (x.trackId !== c.li.id) problem(`L16: ${x.subjectId}'s LinkedIn ${x.action} is for track ${x.trackId}`);
      if (![lead.profile, ...(lead.former ?? [])].includes(x.destination)) problem(`L16: ${x.subjectId}'s LinkedIn ${x.action} went to ${x.destination}, not the person's profile`);
      if (x.action === "invite") {
        const retried = li.handoverLog.some((y) => y.key === x.key && y.at < x.at && y.sender === x.sender);
        if (!poolAt(lead.campaign, x.at).includes(x.sender) && !retried) problem(`L16: ${x.subjectId}'s invite went from ${x.sender}, not in its campaign's pool at ${iso(x.at)}`);
      } else {
        // The delivered invite's own sender: a rate-limited invite retried from another session can keep its key.
        const own = li.deliveryLog.find((d) => d.subjectId === x.subjectId && d.trackId === x.trackId && d.action === "invite")?.sender ?? connectedSessionOf(lead);
        if (own !== x.sender) problem(`L16: ${x.subjectId}'s message ${x.stepId} went from ${x.sender}, not its conversation's session ${own ?? "(none)"}`);
      }
    }
    for (const x of h.smsProvider?.handoverLog ?? []) {
      const lead = leadOfSubject(x.subjectId);
      if (!lead) continue;
      const smsStep = campaigns[lead.campaign]!.sms?.steps[0]?.id;
      if (x.stepId !== smsStep || x.sender !== SMS_NUMBER || x.destination !== mobileOf(lead)) problem(`L16: ${x.subjectId}'s text ${x.stepId} went from ${x.sender} to ${x.destination}, not the SMS track's number to their mobile`);
    }
    for (const x of h.fake.handoverLog) {
      const mark = marked.get(x.subjectId);
      if (mark !== undefined && x.at > mark && !restartedSince(x.subjectId, mark, x.at)) problem(`L3: ${x.subjectId}'s email ${x.stepId} was handed over after the reply marked at ${iso(mark)}`);
    }

    // L5: allowances, per session and reset day (the user's zone, London), and the notes per calendar month.
    const perDay = new Map<string, number>();
    const notesPerMonth = new Map<string, number>();
    for (const d of li.deliveryLog) {
      const day = local(d.at, "Europe/London").day;
      // An InMail spends one of the session's messages (13.5).
      const bucket = d.action === "invite" ? "invite" : "message";
      const k = `${d.sender}|${bucket}|${day}`;
      perDay.set(k, (perDay.get(k) ?? 0) + 1);
      const cap = bucket === "invite" ? allowanceOf(d.sender).invites : allowanceOf(d.sender).messages;
      if ((perDay.get(k) ?? 0) > cap) problem(`L5: ${d.sender} sent more than ${cap} ${bucket}s on day ${day}`);
      if (d.action === "invite" && d.rendered.body !== "") {
        const month = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit" }).format(new Date(d.at));
        const mk = `${d.sender}|${month}`;
        notesPerMonth.set(mk, (notesPerMonth.get(mk) ?? 0) + 1);
        if ((notesPerMonth.get(mk) ?? 0) > allowanceOf(d.sender).notes) problem(`L5: ${d.sender} sent more than ${allowanceOf(d.sender).notes} notes in ${month}`);
      }
    }

    // L7: the note goes exactly while the allowance lasts, from the record's own count of notes before each invite.
    const notesBefore = new Map<string, number>();
    for (const d of [...li.deliveryLog].filter((x) => x.action === "invite").sort((a, b) => a.at - b.at)) {
      const lead = leadOfSubject(d.subjectId);
      const c = lead ? campaigns[lead.campaign] : undefined;
      const noted = (c?.li.steps[0]?.body ?? "") !== "";
      const used = notesBefore.get(d.sender) ?? 0;
      const want = noted && used < allowanceOf(d.sender).notes;
      if (want !== (d.rendered.body !== "")) problem(`L7: ${d.subjectId}'s invite went ${d.rendered.body !== "" ? "with" : "without"} its note, with ${used} of ${allowanceOf(d.sender).notes} notes used`);
      if (d.rendered.body !== "") notesBefore.set(d.sender, used + 1);
      else if (noted) features.add("an-invite-without-its-note");
    }

    for (const lead of leads) {
      const st = await h.store.engine.subject(lead.id, now);
      if (!st) continue;
      const c = campaigns[lead.campaign]!;
      const tp = st.tracks.find((t) => t.trackId === c.li.id);
      const invite = li.deliveryLog.find((x) => x.subjectId === lead.id && x.action === "invite");
      // L13 (every channel): after the drain, no pending step of a running lead is left with nothing that can make it due: a
      // due time, a hold with its reason, or a LinkedIn acceptance wait; and none is due long ago with nothing holding it,
      // which is a lead left waiting on a taken pair (council items 1 and 9).
      if (drained && st.subject.ended === null && !st.subject.leadPaused) {
        const read = (await h.request<{ tracks: { trackId: string; hold: string | null; nextStep?: { stepId: string; when: { kind: string; why?: string } } | null }[] }>("GET", `/api/enrollments/${lead.id}`)).body;
        for (const p of st.tracks) {
          if (p.startedAt === null || p.finishedAt !== null || p.nextStepId === null) continue;
          const shown = read.tracks.find((t) => t.trackId === p.trackId);
          // A LinkedIn step whose kind every pool session allows none of (the user's zero) waits, said so: no room.
          const kind = p.trackId === c.li.id ? (p.nextStepId === c.li.steps[0]!.id ? "invites" : "messages") : null;
          // A chosen InMail's time has come by the expiry, not a connection, and it goes only from the session that sent the
          // invite, by its messages per day (13.5; seeds 24071, 24084: its session had none, the pool's others had some).
          const inmailPending = p.trackId === c.li.id && st.campaign.definition.tracks.find((t) => t.id === c.li.id)?.steps.find((s) => s.id === p.nextStepId)?.role === "inmail";
          // Only a step whose time has come by its connection: a message still waiting for acceptance says that first.
          const awaiting = (p.acceptBy ?? null) !== null && (p.connection ?? null) === null && !inmailPending;
          const inviter = invite?.sender ?? null;
          // An invite goes only from a session with no invite pending from elsewhere (section 6; seeds 24062, 24094).
          const fromWhich = inmailPending ? (inviter === null ? [] : [inviter]) : kind === "invites" && lead.profile !== null ? usableSessions(lead).filter((id) => !pendingOn(li.profiles.get(lead.profile!) ?? {}, id)) : usableSessions(lead);
          const noRoom = kind !== null && !awaiting && fromWhich.length > 0 && fromWhich.every((id) => (allowances.get(id)?.[kind] ?? 0) === 0);
          // The read says no allowance exactly when the record finds none on any session the step may use (zero or never
          // set), and full for the day only where an allowance exists and is used up (ticket 24b, item 15).
          // A chosen InMail with no credit backing it says that first: its credit, then its session's room (13.5).
          if (noRoom && (shown?.hold ?? null) === null && !(inmailPending && shown?.nextStep?.when.why === "inmail_unavailable")) {
            if (shown?.nextStep?.when.why !== "no_allowance") problem(`L13: ${lead.id}'s ${p.nextStepId} has no allowance on any session and its read does not say so (${JSON.stringify(shown?.nextStep?.when)})`);
            else features.add("a-step-waiting-on-a-zero-allowance");
            continue;
          }
          if (shown?.nextStep?.when.why === "no_allowance") problem(`L13: ${lead.id}'s ${p.nextStepId} reads no allowance, though ${fromWhich.filter((id) => kind !== null && (allowances.get(id)?.[kind] ?? 0) > 0).join(" and ") || "a session it may use"} has one`);
          const hold = shown?.hold ?? null;
          // L17 (review bot on e261ffa): a track is never held on one session's answer while another session of its pool
          // could act: held as pending only while every session it may use is pending, and never left at its invite while
          // one of them is already connected. On a profile no other subject shares (another's pair takes a session out).
          if (p.trackId === c.li.id && p.nextStepId === c.li.steps[0]!.id && lead.profile !== null && soleOwnerOf(lead)) {
            const script = li.profiles.get(lead.profile) ?? {};
            const usable = usableSessions(lead);
            const notPending = usable.filter((id) => !pendingOn(script, id));
            if (hold === "invite_pending_elsewhere" && notPending.length > 0) problem(`L17: ${lead.id}'s invite is held as pending from elsewhere, though ${notPending.join(" and ")} could act`);
            const connected = usable.filter((id) => connectedOn(script, id));
            if (connected.length > 0) problem(`L17: ${lead.id}'s track still waits at its invite, though ${connected.join(" and ")} is already connected`);
            if (usable.length > 1) features.add("an-invite-decided-over-several-sessions");
          }
          if (hold !== null && !derivable(lead, p.trackId, p.nextStepId, hold) && !(hold === "invite_pending_elsewhere" && soleOwnerOf(lead))) problem(`L13: ${lead.id}'s ${p.nextStepId} is held (${hold}) for no reason the record can find`);
          if (p.dueAt === null && (p.acceptBy ?? null) === null && hold === null) problem(`L13: ${lead.id}'s ${p.nextStepId} is pending with nothing that can make it due`);
          // A chosen InMail whose session the record finds out of credit, or with no plan, waits, said so (13.3).
          const inmailBlocked = p.inmail === "chosen" && shown?.nextStep?.when.why === "inmail_unavailable";
          if (inmailBlocked) {
            const session = li.deliveryLog.find((x) => x.subjectId === lead.id && x.action === "invite")?.sender ?? "";
            // Whether it should have gone is L26's, from every lead's InMail on the session together (13.5: credits are shared).
            features.add(planned(session, now) && creditsAt(session, now) >= 1 ? "an-inmail-waiting-behind-earlier-holdings" : "an-inmail-waiting-for-a-credit");
            continue;
          }
          if (p.dueWall !== null && p.dueWall < now - 3 * DAY && hold === null && !st.attempts.some((a) => a.stepId === p.nextStepId && a.state !== "withdrawn" && a.state !== "rejected" && a.state !== "sent")) problem(`L13: ${lead.id}'s ${p.nextStepId} has been due since ${iso(p.dueWall)} with nothing holding it`);
        }
      }
      // L14 (Q37's interim): a profile whose connection was removed is still the person's: never marked bad.
      if (lead.script?.connectionRemoved && st.lead.details.some((d) => d.channel === "linkedin" && d.bad)) problem(`L14: ${lead.id}'s profile was marked bad after its connection was removed`);
      if (lead.script?.connectionRemoved && tp?.finishReason === "failed_bad_destination") features.add("a-removed-connection");
      if (lead.script?.pendingElsewhere && tp?.finishedAt == null) features.add("an-invite-pending-elsewhere");
      // L6: acceptance is never a reply: only the record's marks end a lead replied.
      if (st.subject.ended === "replied" && !marked.has(lead.id)) problem(`L6: ${lead.id} ended replied with no reply marked`);
      // L9: an existing connection gets no invite, and its first message goes by the drain unless held or ended.
      // Connected on a session of its pool (the profile's own answer, or one session's: review bot on e261ffa).
      const connectedOnPool = lead.script ? [...poolsEver(lead.campaign)].filter((id) => connectedOn(lead.script!, id)) : [];
      if (connectedOnPool.length > 0) {
        // No invite while a session of its pool, healthy then, was already connected: the connection is preferred.
        for (const x of li.handoverLog.filter((y) => y.subjectId === lead.id && y.action === "invite")) {
          const ready = poolAt(lead.campaign, x.at).filter((id) => connectedOn(lead.script!, id) && healthyAt(id, x.at));
          if (ready.length > 0 && soleOwnerOf(lead)) problem(`L9: ${lead.id} was sent an invite from ${x.sender} though ${ready.join(" and ")} was already connected`);
        }
        features.add("already-connected");
        // A track skipped (by the user, or because another campaign owns the pair, Q41) or ended otherwise sends nothing: L9 asks
        // the first message of a track that is still running, or completed, to have gone.
        // Messages wait, said so, while every session the lead may use allows none (L13 checks the read).
        const room = sessionsOf(lead).some((id) => (allowances.get(id)?.messages ?? 0) > 0);
        const shouldSend = room && tp?.startedAt != null && (tp.finishedAt === null || tp.finishReason === "completed");
        if (drained && shouldSend && st.subject.ended === null && !stopped.has(lead.id) && !li.deliveryLog.some((x) => x.subjectId === lead.id && x.action === "message")) {
          problem(`L9: ${lead.id} is already connected and its first message never went`);
        }
      }
      if (!tp || !invite) continue;
      // L8: the expiry is at the record's deadline: the invite's send plus the wait in calendar days in the prospect's
      // zone, moved by every interval the lead was held after the send.
      // The deadline on the lead's clock: the calendar-day span from the send, then every held interval before it reaches it.
      // The wait in force: the track's, as last edited before the track finished (or now); an edit after the send re-resolves
      // the deadline from the send, and one that puts it in the past makes it the edit's instant (council item 3).
      const until = tp.finishedWall ?? now;
      const lastEdit = (waitEdits.get(lead.campaign) ?? []).filter((e) => e.at > invite.at && e.at <= until).at(-1);
      const deadline = deadlineWall(lead, invite.at, until);
      if (lastEdit) features.add("an-edit-of-the-wait-while-waiting");
      const acceptance = li.acceptanceLog.find((a) => a.key === invite.key);
      const reportedBy = acceptance ? acceptance.at + (lead.script?.acceptReportDelayMs ?? 0) : Infinity;
      // The withdrawal path at the expiry itself, or later: a refused InMail, the switch turned off, or the user's skip (13.3).
      const atExpiry = tp.inmail == null || tp.inmail === "no_plan" || tp.inmail === "no_credit";
      const endedAt = atExpiry ? deadline : (tp.finishedWall ?? deadline);
      if (tp.finishReason === "invite_not_accepted") {
        features.add(atExpiry ? "an-invite-expired" : `the-withdrawal-path-after-an-inmail-${tp.inmail}`);
        if (outages.some((o) => o.from < deadline && deadline < o.to)) features.add("an-expiry-while-the-laptop-was-off");
        if (atExpiry && tp.finishedWall !== deadline) problem(`L8: ${lead.id}'s invite expired at ${iso(tp.finishedWall ?? 0)}, not at the deadline ${iso(deadline)}`);
        if (!atExpiry && (tp.finishedWall ?? 0) < deadline) problem(`L20: ${lead.id}'s track took the InMail's withdrawal path at ${iso(tp.finishedWall ?? 0)}, before the deadline ${iso(deadline)}`);
        if (acceptance && acceptance.at < deadline && reportedBy <= deadline && !outages.some((o) => o.from <= deadline && reportedBy <= o.to)) problem(`L8: ${lead.id}'s invite expired though it was accepted at ${iso(acceptance.at)}, before the deadline`);
        // L4: no message after a withdrawn invite, and the withdrawal asked within a settling period of the expiry.
        if (li.deliveryLog.some((x) => x.subjectId === lead.id && x.trackId === c.li.id && x.action === "message")) problem(`L4: ${lead.id} was sent a message after its invite expired`);
        if (now > endedAt + SETTLING + 2 * H && !outages.some((o) => o.to > endedAt && o.from < now) && !li.withdrawalLog.some((w) => w.key === invite.key)) problem(`${atExpiry ? "L4" : "L24"}: ${lead.id}'s expired invite was never withdrawn`);
        if (li.withdrawalLog.some((w) => w.key === invite.key && w.answer === "already_accepted")) features.add("a-withdrawal-found-it-accepted");
        if (li.withdrawalLog.some((w) => w.key === invite.key && w.answer === "unknown")) features.add("a-withdrawal-answered-unknown");
        // L10: the lead's other tracks carry on: an email track after the LinkedIn track starts from the expiry.
        if (c.email && c.email.start.kind === "after" && drained && st.subject.ended !== "replied" && !stopped.has(lead.id)) {
          const due = firstOpen(c.email.window, lead.zone, dueAfter(endedAt, c.email.start.delayDays, lead.zone));
          const sent = h.fake.deliveryLog.find((x) => x.subjectId === lead.id);
          if (!sent) problem(`L10: ${lead.id}'s email track after LinkedIn never went after the expiry`);
          else if (sent.at < due) problem(`L10: ${lead.id}'s email went at ${iso(sent.at)}, before its start after the expiry ${iso(due)}`);
          features.add("released-after-an-expiry");
        }
      }
      if (st.subject.ended === "finished_no_usable_channel" && tp.finishReason === "invite_not_accepted" && c.email) problem(`L10: ${lead.id} ended with no usable channel at the expiry, though email reaches it`);
      if (tp.connection === "accepted") features.add("connected-by-acceptance");
      if (drained && tp.finishedAt === null && (tp.connection ?? null) === null && tp.inmail !== "chosen" && tp.inmail !== "sent" && (tp.acceptByWall ?? Infinity) + 30 * MIN < now && st.subject.ended === null) problem(`L8: ${lead.id}'s invite still waits past its deadline ${iso(tp.acceptByWall ?? 0)}`);
    }
    await checkInmail(drained);

    // L15 (Q41's release): a LinkedIn track skipped because its pair is taken was skipped only while, on every session its
    // campaign's pool had, another subject held the conversation by the record's rule; a pair released (nothing went, or
    // the invite withdrawn and never accepted) is free again, and a later subject is served on it.
    if (drained) {
      const claims: { subject: string; session: string; profile: string; from: number; connected: boolean }[] = [];
      for (const x of li.handoverLog) if (!claims.some((y) => y.subject === x.subjectId && y.session === x.sender && y.profile === x.destination)) claims.push({ subject: x.subjectId, session: x.sender, profile: x.destination, from: x.at, connected: false });
      const skippedTaken: { lead: Lead; at: number }[] = [];
      for (const l of leads) {
        const st = await h.store.engine.subject(l.id, now);
        const t = st?.tracks.find((x) => x.trackId === campaigns[l.campaign]!.li.id);
        const found = connectedCheckOf(l);
        if (found && l.profile) claims.push({ subject: l.id, session: found.session, profile: l.profile, from: found.at, connected: true });
        if (t?.finishReason === "skipped_conversation_taken" && t.finishedWall != null) skippedTaken.push({ lead: l, at: t.finishedWall });
      }
      // An already-connected owner keeps the pair for good; one that reached it holds it until its release, and grounds a
      // skip only while its conversation is known: not while its invite is being withdrawn (seed 24046).
      const heldBy = (other: (typeof claims)[number], at: number) => {
        if (other.from > at) return false;
        if (other.connected) return true;
        const release = releaseOf(other.subject, other.session, other.profile);
        return (release === null || release > at) && !beingWithdrawn(other.subject, other.session, other.profile, at);
      };
      for (const { lead, at } of skippedTaken) {
        const free = poolAt(lead.campaign, at).filter((session) => !claims.some((y) => y.subject !== lead.id && y.session === session && y.profile === lead.profile && heldBy(y, at)));
        if (free.length > 0) problem(`L15: ${lead.id}'s LinkedIn track was skipped as taken at ${iso(at)}, though ${free.join(" and ")}'s conversation with ${lead.profile} was free by the record`);
        else features.add("a-skip-of-a-taken-pair");
      }
      for (const l of leads) {
        const invited = li.handoverLog.find((x) => x.subjectId === l.id && x.action === "invite");
        if (!invited) continue;
        const before = claims.find((y) => y.subject !== l.id && y.session === invited.sender && y.profile === invited.destination && y.from < invited.at);
        if (before && releaseOf(before.subject, before.session, before.profile) !== null) features.add("a-pair-released-then-invited-by-another");
      }
    }
    if (li.refusals.some((r) => r.reason === "rate_limited")) features.add("a-rate-limit");
    if (li.lookupLog.some((l) => l.answer === "sent")) features.add("a-lost-answer-found-by-lookup");
  }
}
