import type { CampaignDefinition, StepDefinition, TrackChannel, TrackDefinition } from "../../src/domain/sequence/definition.ts";
import type { SubjectState } from "../../src/domain/sequence/state.ts";
import { heldReason } from "../../src/domain/sequence/dispatch.ts";
import { DEFAULT_RULES, type Rules } from "../../src/server/engine/rules.ts";
import type { ActivityView, CompanyRecord, EnrollmentProgress, LeadSearchResult, NeedsAttention, OutreachStatus, PersonRecord } from "../../src/shared/api.ts";
import { trackLabel } from "../../src/shared/track-label.ts";
import { EngineHarness, quickWait } from "./engine-harness.ts";
import { business, person, type ExportRows } from "./export-builder.ts";
import type { FakeAccount, FakeMode, HandoverLogEntry } from "./fake-email-port.ts";
import type { FakeNumber, FakeSmsMode } from "./fake-sms-port.ts";
import { random } from "./generated-sequences.ts";
import { dueAfter, firstOpen, higherPriority, inWindow, local, renderCopy, zoneOf, type Hours } from "./sequence-model.ts";

/**
 * Generated sequences for coordination between tracks (ADR 0003 9.2; the ticket 13 row of 9.3),
 * run through the real HTTP app and SQLite store against the fake email provider and the fake SMS
 * provider, on a clock the test advances.
 *
 * Generated: one to three campaigns sharing inboxes and SMS numbers, each a tree of one to four
 * email and SMS tracks, connected together (the same start rule) or after another track with a
 * delay of zero to three days, with waits, windows (overnight ones too) and zones with
 * daylight-saving changes in the period; decision makers with and without an email or a mobile, a
 * company lead (no SMS), people in several campaigns on one mobile; addresses that bounce, mobiles
 * the provider refuses as invalid or the carrier reports invalid after a send; SMS replies (STOP
 * included) and email replies; numbers disconnected or no longer listed; one number shared by every
 * campaign, so conversations are taken; slow pacing, so claims expire; and user and prospect events,
 * and a second worker's handovers, injected between a claim and its handover. Each run ends with a
 * drain.
 *
 * The attempt lifecycle under crashes, lost answers and every email fake mode is the ticket 12
 * generator's (generated-sequences.ts); this one keeps the providers' modes to those whose outcome
 * the record can know, and checks coordination.
 *
 * The record imports nothing from src/domain/sequence/. It knows the definitions, the people and
 * the providers' own logs, and from them predicts: each track's start (entry, or the record's
 * calendar days after the earlier track's finish, which it derives from the delivery log), each
 * step's earliest handover, its window and copy, which subject owns each SMS conversation (the
 * first number to text a mobile, by the SMS provider's call log), whom each reply stops, when a
 * detail is known bad, and each subject's final track outcomes and ending.
 *
 * Checked after every event: invariants 1-4, 6-8, 10, 11, 13, 14, 19, 20 and 28 of ADR 0003 section 8,
 * and 18 after the drain.
 *
 * Question Q7 answered (15 November 2026): an SMS track whose mobile's conversation is taken on every number it may
 * use is skipped. The record predicts whether, and the earliest instant, from the SMS provider's handover log (who first
 * texted each pair, and when), the pool in force at each instant (one campaign's pool may gain a late number, from the
 * run's own stream) and the window. A claim already waiting on a number another lead has just taken delays the skip
 * until its own handover fails, which no provider log shows, so the record takes the skip's instant from the lead's
 * progress only once invariant 28(b) has validated it (at or after the earliest, every usable number taken by then, the
 * window open), and 28(a) bounds it from above at every event.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The engine's settling period, as ADR 0003 5.6 states it: an unhanded claim expires after it. */
const SETTLING = 15 * MINUTE;
const DAY = 24 * HOUR;
const ZONES = ["Europe/London", "America/New_York", "Europe/Paris", "Asia/Kolkata", "Australia/Sydney", ""];
const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));

export interface TrackRunOptions {
  readonly rules?: Partial<Rules>;
  readonly events?: number;
  readonly drain?: boolean;
  readonly maxWrites?: number;
  readonly deadline?: number;
}

export interface TrackRunResult {
  readonly problems: string[];
  readonly stats: { texts: number; emails: number; subjects: number; ticks: number; writes: number; features: readonly string[] };
}

interface WorldPerson {
  readonly key: string;
  readonly company: number;
  readonly name: string;
  readonly email: string | null;
  readonly mobile: string | null;
  readonly zone: string;
}

interface WorldCompany {
  readonly key: string;
  readonly name: string;
  readonly zone: string;
  readonly inbox: string | null;
  readonly line: string;
}

interface Subject {
  readonly id: string;
  /** The person's or company lead's record, whose Activity shows this subject. */
  readonly recordId: string;
  readonly kind: "person" | "company";
  readonly campaign: number;
  readonly person: WorldPerson | null;
  readonly company: WorldCompany;
  readonly enrolledAt: number;
}

interface Campaign {
  id: string;
  /** The main sequence, which the record models. */
  readonly definition: CampaignDefinition;
  /**
   * Its win-back branch (ticket 16), saved with it. No lead here declines (there is no call), so no lead
   * enters it: the record leaves it out, and the app must show nothing of it on any lead (review bot on 654907b).
   */
  readonly branch: readonly TrackDefinition[];
  readonly companies: number[];
  launchedAt: number | null;
  /** A number added to its SMS pool while it runs, and when (question Q7 answered). */
  joined: { readonly number: string; readonly at: number } | null;
  /** Its SMS pool as each edit the record made left it, in order (a number joining, a number removed). */
  readonly poolEdits: { readonly at: number; readonly pool: readonly string[] }[];
}

type Pick = <T>(items: readonly T[]) => T;

/** The invariants a problem names: the numbers before its first colon. */
export function trackInvariantsOf(problem: string): string[] {
  return (problem.split(":")[0] ?? "").split("/").map((x) => x.trim());
}

/** The store's construction guards (ADR 0003 4.5): a second owner of one SMS conversation is refused by its unique index. */
const BINDING_GUARDS = [/UNIQUE constraint failed: sms_bindings/, /an SMS binding is never removed/];

export async function runTracks(seed: number, options: TrackRunOptions = {}): Promise<TrackRunResult> {
  try {
    return await runTracksUnguarded(seed, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const id = BINDING_GUARDS.some((r) => r.test(message)) ? "14" : "throw";
    return { problems: [`${id}: the engine threw: ${message}`], stats: { texts: 0, emails: 0, subjects: 0, ticks: 0, writes: 0, features: [] } };
  }
}

async function runTracksUnguarded(seed: number, options: TrackRunOptions): Promise<TrackRunResult> {
  const rand = random(seed);
  const pick: Pick = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(rand() * items.length)];
    if (item === undefined) throw new Error("empty pick");
    return item;
  };
  const chance = (p: number) => rand() < p;
  const problems: string[] = [];
  const problem = (what: string) => {
    if (problems.length < 25) problems.push(what);
  };
  const features = new Set<string>();

  const start = Date.parse("2026-10-19T00:00:00Z") + Math.floor(rand() * 11 * DAY) + Math.floor(rand() * 24) * HOUR;
  const profile = pick(["open", "open", "one-number", "busy", "failing"] as const);
  features.add(`profile:${profile}`);

  const inboxes: FakeAccount[] = Array.from({ length: 1 + Math.floor(rand() * 2) }, (_, i) => ({
    id: `inbox-${String.fromCharCode(97 + i)}`,
    capacity: pick([2, 3, 5, 8]),
    gapMs: pick([MINUTE, 2 * MINUTE, 5 * MINUTE]),
    k: pick([1, 2]),
    healthy: true,
    quotaAvailable: true,
    resetZone: "UTC",
  }));
  const numbers: FakeNumber[] = Array.from({ length: profile === "one-number" ? 1 : 1 + Math.floor(rand() * 3) }, (_, i) => ({
    id: `+4477009000${i + 1}0`,
    capacity: profile === "busy" ? pick([1, 2]) : pick([1, 2, 3, 5, 8]),
    gapMs: profile === "busy" ? pick([20 * MINUTE, 30 * MINUTE]) : pick([MINUTE, 2 * MINUTE, 5 * MINUTE]),
    k: pick([1, 2]),
    healthy: true,
    resetZone: "Europe/London",
  }));
  // Question Q7 answered, from its own stream so the draws above and below are unchanged: in some runs a fourth
  // number, in no pool at first, joins one campaign's pool at one event, before or after a skip on it.
  const lateRand = random(seed ^ 0x0a7e);
  const lateNumber: FakeNumber | null = lateRand() < 0.5 ? { id: "+447700900090", capacity: 5, gapMs: MINUTE, k: 2, healthy: true, resetZone: "Europe/London" } : null;
  const lateAt = { campaign: lateRand(), event: lateRand() };
  // After the reviews of bebdc06, from the same stream after its earlier draws: a number refusing its next text for an
  // account reason (point 10); a pool edit removing a number; a person's mobile changing between two SMS tracks (a later
  // export); and leads held under the interim engine until an upgrade part way through.
  const refusalAt = lateRand() < 0.4 ? { event: lateRand(), number: lateRand(), retryMs: (lateRand() < 0.5 ? 5 : 20) * MINUTE } : null;
  const removalAt = lateRand() < 0.3 ? { event: lateRand(), campaign: lateRand(), which: lateRand() } : null;
  const mobileChangeAt = lateRand() < 0.35 ? { event: lateRand(), person: lateRand() } : null;
  const interimUntil = lateRand() < 0.25 ? { event: lateRand() } : null;
  // After the reviews of faac357, from the same stream after its earlier draws: the next text to a mobile two campaigns
  // share is never known sent (point 10): accepted then refused by the provider, or never answered. Its binding is
  // unsettled meanwhile, then released as unsent, and the other campaign's lead held on it becomes ready again.
  const unsentAt = lateRand() < 0.45 ? { event: lateRand(), failAfterAccept: lateRand() < 0.5, refusedAfterMs: lateRand() < 0.5 ? 2 * HOUR : 9 * HOUR } : null;
  /** The mobile whose next text is never known sent, from when, until a text to it is handed over. */
  let unsentArmed: "armed" | "used" | null = null;
  // The mobile answers a first text the app does not yet know went, while another campaign's lead on that mobile waits
  // (the coordinator's ruling on item 3 of faac357's review): the reply stops the owner only, and makes the conversation.
  const answerUnknownAt = lateRand() < 0.4 ? { event: lateRand() } : null;
  let answerUnknownArmed = false;
  /** The text whose answer the provider loses, which the mobile answers right after the tick that handed it over. */
  let answerAfterTick: { mobile: string; sender: string } | null = null;
  /** A text never answered: its outcome stays unknown until the user marks it, which the drain does as the user would. */
  const unanswered: { attemptId: string; at: number; mark: "sent" | "not_sent" }[] = [];
  /** Texts the user marked sent, by idempotency key, and when: known sent from then on. */
  const markedSent = new Map<string, number>();
  /** A text the provider accepted and then refused (`provider_skipped`): its step is held until the user acts (5.4). */
  const refusedAfterAcceptance = new Set<string>();
  /** When the interim engine was replaced by the engine as built, in a run that starts under it. */
  let upgradeAt: number | null = null;
  /** People whose mobile a later export changed, and when. */
  const mobileChanges = new Map<string, { mobile: string; at: number }>();
  const emailModes: FakeMode[] = [...new Set([pick(["honest", "late-send", "duplicate-and-reorder"] as const), pick(["honest", "lost-response", "late-send"] as const)])];
  const smsModes: FakeSmsMode[] = [...new Set([pick(["honest", "late-send"] as const), pick(["honest", "lost-response", "late-send"] as const)])];

  const companies: WorldCompany[] = [
    { key: "c1", name: "Harbour Lane Physio", zone: "Europe/London", inbox: null, line: "+442079460101" },
    { key: "c2", name: "Northgate Dental", zone: pick(ZONES), inbox: null, line: "+442079460202" },
    // No decision maker: a company lead, on its shared inbox and main line, with no SMS.
    { key: "c3", name: "Elm Street Clinic", zone: pick(ZONES), inbox: "hello@elm.example", line: "+442079460303" },
  ];
  const firstNames = ["Pat", "Sam", "Nia", "Omar", "Grace", "Ravi"];
  const people: WorldPerson[] = firstNames.map((first, i) => {
    const both = i === 0;
    const email = both || chance(0.7);
    return {
      key: `p${i + 1}`,
      company: i < 3 ? 0 : 1,
      name: `${first} ${["Oneil", "Lee", "Cole", "Reed", "Okafor", "Patel"][i] ?? "Doe"}`,
      email: email ? `${first.toLowerCase()}@${i < 3 ? "harbour" : "northgate"}.example` : null,
      mobile: both || !email || chance(0.6) ? `+4477009001${String(i).padStart(2, "0")}` : null,
      zone: pick(ZONES),
    };
  });

  // The run's rules: the mutation's, if any; under the interim engine until its upgrade, with the skip switched off.
  const rulesNow: { -readonly [K in keyof Rules]?: Rules[K] } = { ...(options.rules ?? {}) };
  const asBuilt = options.rules?.evaluate ?? DEFAULT_RULES.evaluate;
  if (interimUntil) rulesNow.evaluate = (st, now, o) => asBuilt(st, now, { ...o, skipTakenConversations: false });
  const h = new EngineHarness({
    start,
    accounts: inboxes,
    modes: emailModes,
    random: random(seed ^ 0x5eed),
    engine: { waitFor: quickWait },
    sms: { numbers: lateNumber ? [...numbers, lateNumber] : numbers, modes: smsModes },
    rules: rulesNow,
  });
  h.maxWrites = options.maxWrites ?? null;
  h.stopAt = options.deadline ?? null;
  const email = h.fake;
  const sms = h.sms;

  const failRate = profile === "failing" ? 0.35 : 0.12;
  for (const p of people) {
    if (p.email && chance(failRate)) email.bouncing.add(p.email);
    if (p.mobile) {
      const r = rand();
      if (r < failRate) sms.invalid.add(p.mobile);
      else if (r < 2 * failRate) sms.invalidAfterSend.add(p.mobile);
    }
  }

  const window = (): Hours[] => {
    const kind = rand();
    if (kind < 0.4) return ALL_DAY;
    if (kind < 0.55) return [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 20, end: 3 }));
    const days = [0, 1, 2, 3, 4, 5, 6].filter(() => rand() < 0.7);
    const startHour = pick([7, 8, 9, 13]);
    return (days.length > 0 ? days : [pick([1, 2, 3, 4, 5])]).map((day) => ({ day, start: startHour, end: Math.min(24, startHour + pick([3, 6, 10])) }));
  };
  const stepsOf = (channel: "email" | "sms", prefix: string): StepDefinition[] =>
    Array.from({ length: 1 + Math.floor(rand() * 3) }, (_, i) => ({
      id: `${prefix}s${i + 1}`,
      waitDays: i === 0 ? 0 : pick([0, 1, 1, 2, 3]),
      subject: channel === "email" ? pick(["Hello {{first_name|there}}", "A question for {{company}}"]) : "",
      body: channel === "email" ? pick(["{{first_name|Hi}}, a note for {{company}}.", "Following up, {{first_name|there}}."]) : pick(["Hi {{first_name|there}}, {{company}} here.", "A quick text, {{first_name|there}}."]),
      threading: channel === "sms" || i === 0 || chance(0.3) ? "new_subject" : "continue_thread",
      removed: false,
    }));
  const campaignCount = 1 + Math.floor(rand() * 3);
  const campaigns: Campaign[] = [];
  for (let ci = 0; ci < campaignCount; ci++) {
    const tracks: TrackDefinition[] = [];
    const n = 1 + Math.floor(rand() * 4);
    for (let ti = 0; ti < n; ti++) {
      const channel = ti === 0 && ci === 0 ? "sms" : pick(["email", "sms"] as const);
      const earlier = tracks[Math.floor(rand() * tracks.length)];
      // The canvas compiler: "together" with a track gives the same start rule; "after" gives after(X, d).
      const start: TrackDefinition["start"] = !earlier ? { kind: "entry" } : chance(0.35) ? earlier.start : { kind: "after", trackId: earlier.id, delayDays: pick([0, 0, 1, 2, 3]) };
      tracks.push({ id: `c${ci}t${ti + 1}`, channel, branch: "main", window: window(), steps: stepsOf(channel, `c${ci}t${ti + 1}`), start, removed: false });
    }
    const smsPool = profile === "one-number" ? [numbers[0]!.id] : numbers.filter(() => chance(0.7)).map((x) => x.id);
    const definition: CampaignDefinition = {
      timezone: pick(["Europe/London", "America/New_York"]),
      callSkipLimitDays: 2,
      emailPool: inboxes.map((a) => a.id),
      smsPool: smsPool.length > 0 ? smsPool : [numbers[0]!.id],
      tracks,
    };
    // Ticket 16's branch, from its own stream, so the runs above keep every draw they had.
    const branchRand = random(seed ^ 0x16b ^ ci);
    const branch: TrackDefinition[] = branchRand() < 0.5
      ? Array.from({ length: 1 + Math.floor(branchRand() * 2) }, (_, i) => {
          const channel = branchRand() < 0.6 ? ("email" as const) : ("sms" as const);
          const id = `c${ci}w${i + 1}`;
          return { id, channel, branch: "win_back" as const, window: ALL_DAY, steps: [{ id: `${id}s1`, waitDays: 0, subject: channel === "email" ? "Still here, {{first_name|there}}" : "", body: "One more note for {{company}}.", threading: "new_subject" as const, removed: false }], start: { kind: "entry" as const }, removed: false };
        })
      : [];
    campaigns.push({ id: "", definition, branch, companies: ci === 0 ? [0, 1, 2] : ci === 1 ? [0, 1] : [1, 2], launchedAt: null, joined: null, poolEdits: [] });
  }
  for (const c of campaigns) {
    if (c.definition.tracks.some((t) => t.start.kind === "after")) features.add("after");
    if (c.definition.tracks.filter((t) => t.start.kind === "entry").length > 1) features.add("together");
    if (new Set(c.definition.tracks.map((t) => t.channel)).size > 1) features.add("both-channels");
    if (c.branch.length > 0) features.add("a-win-back-branch-never-entered");
  }
  if (campaigns.length > 1) features.add("several-campaigns");

  const rowsFor = (c: Campaign, mobiles: ReadonlyMap<string, string> = new Map()): ExportRows => ({
    businesses: c.companies.map((i) => {
      const co = companies[i]!;
      return business({ business_id: co.key, business_name: co.name, timezone: co.zone, phone_e164: co.line, general_emails: co.inbox ?? "" });
    }),
    people: people
      .filter((p) => c.companies.includes(p.company))
      .map((p) =>
        person({ person_id: p.key, business_id: companies[p.company]!.key, full_name: p.name, timezone: p.zone, email: p.email ?? "", ...(mobiles.get(p.key) ?? p.mobile ? { dial_phone: mobiles.get(p.key) ?? p.mobile ?? "", dial_phone_type: "mobile" } : {}) }),
      ),
  });

  // ------------------------------------------------------------------------------------------
  const subjects = new Map<string, Subject>();
  const discover = async () => {
    for (const [ci, c] of campaigns.entries()) {
      if (!c.id) continue;
      for (const row of (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}&limit=500`)).body.rows) {
        const e = row.enrollments.find((x) => x.campaign.id === c.id);
        if (!e || subjects.has(e.id)) continue;
        const p = row.kind === "person" ? (people.find((x) => x.name === row.name) ?? null) : null;
        const company = p ? companies[p.company]! : companies.find((x) => x.name === row.name)!;
        subjects.set(e.id, { id: e.id, recordId: row.id, kind: row.kind, campaign: ci, person: p, company, enrolledAt: h.clock });
      }
    }
  };

  let hookBudget = 0;
  const injectAround = async (subjectId: string | null) => {
    if (hookBudget <= 0 || !chance(0.3)) return;
    hookBudget--;
    const r = rand();
    const target = subjectId ? subjects.get(subjectId) : undefined;
    if (r < 0.35) {
      // A second worker's handovers race this one's: two first handovers for one conversation.
      features.add("second-worker");
      await h.otherWorker();
    } else if (r < 0.6 && target?.person?.mobile) {
      if (textBack(target.person.mobile, null)) features.add("reply-between-claim-and-handover");
    } else if (r < 0.8 && target) {
      const address = email.deliveryLog.filter((d) => d.subjectId === target.id).at(-1)?.destination;
      if (address) replyOnKnownThread(address);
    } else {
      // The provider disconnects a number, and the app learns it at once (as the ticket 12 generator does for inboxes).
      const n = pick(numbers);
      n.healthy = !n.healthy;
      await h.store.engine.updateAccount(n.id, { healthy: n.healthy && n.listed !== false });
      features.add("number-health");
    }
  };
  /**
   * A reply the provider reports late: its own time is earlier than now, after the send it answers
   * (verifier B1). The app observes it now either way.
   */
  function lateTime(after: number): number | null {
    return (chance(0.4) ? Math.max(after, h.clock - Math.floor(rand() * 6 * HOUR)) : null);
  }
  /** The prospect replies to the latest email to `address`, only once the app has seen that send, so the thread is known. */
  function replyOnKnownThread(address: string): boolean {
    const last = email.deliveryLog.filter((x) => x.destination === address && x.at <= h.clock).at(-1);
    if (!last || last.visibleAt > h.clock) return false;
    const providerAt = lateTime(last.at);
    if (!email.prospectReplies(address, true, providerAt)) return false;
    features.add(providerAt === null ? "email-reply" : "email-reply-reported-late");
    return true;
  }
  /** The prospect texts back the number that last texted them, or `to`. */
  function textBack(mobile: string, to: string | null): boolean {
    const last = sms.deliveryLog.filter((d) => d.destination === mobile && d.at <= h.clock && (to === null || d.sender === to)).at(-1);
    if (!last) return false;
    const first = sms.deliveryLog.find((d) => d.destination === mobile && d.sender === last.sender)!;
    const providerAt = lateTime(first.at);
    if (!sms.prospectTexts(mobile, pick(["STOP", "Thanks, not now", "Who is this?"]), last.sender, providerAt)) return false;
    features.add(providerAt === null ? "sms-reply" : "sms-reply-reported-late");
    return true;
  }
  /**
   * The user marks each text whose outcome stays unknown, as Needs attention asks: one never answered as not sent (its
   * binding is released as unsent), one the mobile answered as sent.
   */
  async function markUnanswered(): Promise<void> {
    for (const { attemptId: id, mark } of unanswered.splice(0)) {
      // Refused when its outcome is no longer unknown (a later call of the same attempt went, or the lead stopped).
      if ((await h.engine.markAttempt(id, mark)) && mark === "sent") markedSent.set(id, h.clock);
    }
    await h.tick();
  }
  /** The record's decided skips, by subject and track: each fixed once its instant has come, in track order. */
  const decidedSkips = new Map<string, number>();
  /** Every claim the record saw made (the `afterClaim` hook): which subject, step and number, and when. */
  const claims: { attemptId: string; subjectId: string; stepId: string; accountId: string; at: number }[] = [];
  h.hooks = {
    beforeHandover: async (attemptId) => injectAround((await h.store.engine.attempt(attemptId))?.subjectId ?? null),
    afterClaim: async (attemptId) => {
      const a = await h.store.engine.attempt(attemptId);
      if (a) claims.push({ attemptId, subjectId: a.subjectId, stepId: a.stepId, accountId: a.accountId, at: h.clock });
      await checkClaimPriority(attemptId);
    },
  };

  for (const [ci, c] of campaigns.entries()) {
    const created = await h.createCampaign(`Campaign ${ci + 1}`, rowsFor(c), c.definition.timezone);
    c.id = created.campaign.id;
    await h.defineSequence(c.id, { ...c.definition, tracks: [...c.definition.tracks, ...c.branch] });
  }
  await discover();
  email.onHandover = probe(h, problem, "email", checkHandoverPriority);
  const smsProbe = probe(h, problem, "sms", checkHandoverPriority);
  sms.onHandover = async (call) => {
    await smsProbe(call);
    // The drawn text never known sent (point 10): the first text on its pair after the draw, once; the provider's answer
    // is decided after this hook.
    sms.failAfterAccept.clear();
    if (answerUnknownArmed && answerAfterTick === null) {
      const owner = subjects.get(call.subjectId);
      const firstOnPair = sms.handoverLog.filter((x) => x.sender === call.sender && x.destination === call.destination).length === 1;
      if (owner && firstOnPair && [...subjects.values()].some((o) => o.campaign !== owner.campaign && mobileOf(o) === call.destination && !sms.deliveryLog.some((x) => x.subjectId === o.id))) {
        // It goes, but the provider never reports it and every lookup answers unknown; the mobile answers it meanwhile.
        sms.silentTo.add(call.destination);
        unanswered.push({ attemptId: call.attemptId, at: call.at, mark: "sent" });
        answerUnknownArmed = false;
        answerAfterTick = { mobile: call.destination, sender: call.sender };
      }
    }
    if (unsentAt && unsentArmed === "armed") {
      // The first text on its pair to a mobile another campaign's lead, not yet texted, may text from the same number.
      const firstOnPair = sms.handoverLog.filter((x) => x.sender === call.sender && x.destination === call.destination).length === 1;
      const owner = subjects.get(call.subjectId);
      // That lead's first SMS track has started and its window is open: it would text now.
      const dueNow = (o: Subject) => campaigns[o.campaign]!.definition.tracks.some((t) => t.channel === "sms" && (startOf(o, t) ?? Infinity) <= h.clock && inWindow(t.window, zoneFor(o), h.clock));
      // Every other number that lead may use already has someone else's text to the mobile, so it waits on this one.
      const onlyThis = (o: Subject) => poolAt(o.campaign, h.clock).every((n) => n === call.sender || sms.handoverLog.some((x) => x.sender === n && x.destination === call.destination && x.subjectId !== o.id));
      const other = owner && [...subjects.values()].some((o) => o.campaign !== owner.campaign && mobileOf(o) === call.destination && poolAt(o.campaign, h.clock).includes(call.sender) && onlyThis(o) && !sms.deliveryLog.some((d) => d.subjectId === o.id) && dueNow(o));
      if (firstOnPair && other) {
        unsentArmed = "used";
        if (unsentAt.failAfterAccept) {
          sms.failAfterAccept.add(call.destination);
          sms.failAfterAcceptDelayMs = unsentAt.refusedAfterMs;
          refusedAfterAcceptance.add(call.attemptId);
        } else {
          sms.dropUnanswered.set(call.destination, 1);
          unanswered.push({ attemptId: call.attemptId, at: call.at, mark: "not_sent" });
        }
        features.add(unsentAt.failAfterAccept ? "a-first-text-refused-after-acceptance" : "a-first-text-never-answered");
      }
    }
    // An email reply from the same lead while its text is with the provider: it must stop the SMS track too.
    if (hookBudget <= 0 || !chance(0.3)) return;
    const address = email.deliveryLog.filter((d) => d.subjectId === call.subjectId).at(-1)?.destination;
    if (address && replyOnKnownThread(address)) {
      hookBudget--;
      features.add("email-reply-during-a-text");
    }
  };
  // 29. The worker's caches follow the stored facts: right after each of its ticks, a freshly started engine at the same
  // instant finds nothing to change and nothing to hand over. A cache keyed on less than what it read (a change of
  // conversations, say) leaves the worker idle where a fresh one acts; checked at every tick, since the cache's own
  // horizon heals the stall before a later check would see it.
  let draining = false;
  h.afterTick = async () => {
    await freshCheck();
    if (answerAfterTick && sms.deliveryLog.some((d) => d.destination === answerAfterTick!.mobile && d.sender === answerAfterTick!.sender)) {
      sms.silentTo.delete(answerAfterTick.mobile);
      const replied = textBack(answerAfterTick.mobile, answerAfterTick.sender);
      answerAfterTick = null;
      if (replied) {
        features.add("a-reply-before-its-text-was-known-sent");
        // Observed at once, before the lookup that would find the text sent.
        await h.tick();
      }
    }
  };
  async function freshCheck(): Promise<void> {
    if (draining || h.stopped || problems.length > 0) return;
    const handed = sms.handoverLog.length + email.handoverLog.length;
    const changed = await h.freshEngineTick();
    const more = sms.handoverLog.length + email.handoverLog.length - handed;
    if (changed.length > 0 || more > 0) problem(`29: at ${new Date(h.clock).toISOString()} a fresh engine handed over ${more} and changed what the running worker had left: ${changed.join("; ").slice(0, 600)}`);
  }
  await h.tick();
  for (const [ci, c] of campaigns.entries()) {
    const wait = Math.floor(rand() * 3) * HOUR;
    if (ci === 0) h.clock += wait;
    else await h.advanceTo(h.clock + wait);
    const launched = await h.launch(c.id);
    if (launched.status !== 200) {
      problem(`launch refused: ${JSON.stringify(launched.body)}`);
      return { problems, stats: { texts: 0, emails: 0, subjects: subjects.size, ticks: h.ticks, writes: h.writes, features: [...features] } };
    }
    c.launchedAt = h.clock;
  }
  hookBudget = 8;

  // ------------------------------------------------------------------------------------------
  // The record's knowledge, derived from the definitions, the people and the providers' own logs,
  // never read back from the engine.

  /** When the app knew a mobile was bad: the provider refused it, or the carrier reported it invalid after a text. */
  function mobileBadAt(mobile: string): number {
    const refused = sms.refusals.find((r) => r.destination === mobile && r.reason === "invalid_destination")?.at ?? Infinity;
    const failed = sms.invalidAfterSend.has(mobile) ? (sms.deliveryLog.find((d) => d.destination === mobile)?.at ?? Infinity) + 2 * MINUTE : Infinity;
    return Math.min(refused, failed);
  }
  function emailBadAt(address: string): number {
    return (email.bouncing.has(address) ? (email.deliveryLog.find((d) => d.destination === address)?.at ?? Infinity) + 5 * MINUTE : Infinity);
  }
  /**
   * The conversation's owner by the SMS provider's delivery log: the subject the number's first text that went to that
   * mobile was for (question Q7 answered, point 10: a conversation exists once a text is known to have gone; a text refused
   * or never sent owns nothing).
   */
  function ownerOf(sender: string, mobile: string) {
    return sms.deliveryLog.find((d) => d.sender === sender && d.destination === mobile)?.subjectId ?? null;
  }
  /**
   * The replies that reached a subject, in the order the app observed them (the providers' reply
   * logs, in order): an SMS on a conversation it owned when the text was observed, or an email on its
   * thread, which the generator only answers once the app knows it. `seenAt`: when the app observed
   * it; `at`: its own time as the provider reported it.
   */
  function repliesOf(id: string): { channel: "email" | "sms"; seenAt: number; at: number }[] {
    return [
      ...sms.replyLog.filter((r) => ownerOf(r.to, r.from) === id && (sms.deliveryLog.find((d) => d.sender === r.to && d.destination === r.from)?.at ?? Infinity) <= r.at).map((r) => ({ channel: "sms" as const, seenAt: r.at, at: Math.min(r.providerAt, r.at), order: sms.replyLog.indexOf(r) })),
      ...email.replyLog.filter((r) => r.subjectId === id).map((r) => ({ channel: "email" as const, seenAt: r.at, at: Math.min(r.providerAt, r.at), order: email.replyLog.indexOf(r) })),
    ].sort((a, b) => a.seenAt - b.seenAt || a.order - b.order);
  }
  /** The reply that stopped the subject: the first the app observed, whatever replies follow (verifier B1). */
  function stopOf(id: string) {
    return repliesOf(id)[0] ?? null;
  }
  function stoppedAt(id: string) {
    return stopOf(id)?.seenAt ?? Infinity;
  }
  function zoneFor(s: Subject) {
    return zoneOf(s.person?.zone ?? "", s.company.zone, campaigns[s.campaign]!.definition.timezone);
  }
  function runStartOf(s: Subject) {
    return Math.max(s.enrolledAt, campaigns[s.campaign]!.launchedAt ?? Infinity);
  }
  function addressOf(s: Subject) {
    return s.person?.email ?? (s.person ? null : s.company.inbox);
  }
  function mobileOf(s: Subject) {
    return s.person?.mobile ?? null;
  }
  /** Whether the subject's channel has a good detail at instant t, by the record. */
  function reachesAt(s: Subject, channel: TrackChannel, t: number): boolean {
    const detail = channel === "email" ? addressOf(s) : mobileOf(s);
    return detail !== null && (channel === "email" ? emailBadAt(detail) : mobileBadAt(detail)) > t;
  }
  function deliveriesOf(channel: TrackChannel) {
    return (channel === "sms" ? sms.deliveryLog : email.deliveryLog);
  }
  function deliveryOf(channel: TrackChannel, subjectId: string, stepId: string) {
    return deliveriesOf(channel).find((d) => d.subjectId === subjectId && d.stepId === stepId);
  }
  /** When the app can start a track: its start, once it can know the track it waits on finished. */
  function startSeenAt(s: Subject, t: TrackDefinition): number | null {
    const start = startOf(s, t);
    if (start === null || t.start.kind === "entry") return start;
    const rule = t.start;
    const before = campaigns[s.campaign]!.definition.tracks.find((x) => x.id === rule.trackId);
    const seen = before ? finishSeenAt(s, before) : null;
    return seen === null ? null : Math.max(start, seen);
  }
  /** When the app could first know of a send: its sent event, or a lookup that confirmed it. */
  function knownAt(channel: TrackChannel, d: { key: string; at: number; visibleAt: number }): number {
    const looked = (channel === "sms" ? sms.lookupLog : email.lookupLog).find((l) => l.key === d.key && l.answer === "sent" && l.at >= d.at)?.at ?? Infinity;
    return Math.min(d.visibleAt, looked, channel === "sms" ? (markedSent.get(d.key) ?? Infinity) : Infinity);
  }
  function badAtOf(s: Subject, channel: TrackChannel): number {
    const detail = channel === "email" ? addressOf(s) : mobileOf(s);
    return detail === null ? -Infinity : channel === "email" ? emailBadAt(detail) : mobileBadAt(detail);
  }
  /**
   * The instant the lead stops running, by the record: the first reply it observed, or the moment
   * no channel of its campaign reaches it any more (the last of its channels' details known bad).
   */
  function endLimitOf(s: Subject): number {
    const channels = [...new Set(campaigns[s.campaign]!.definition.tracks.map((t) => t.channel))];
    return Math.min(stoppedAt(s.id), Math.max(...channels.map((c) => (c === "sms" ? Math.min(badAtOf(s, c), smsLostAt(s)) : badAtOf(s, c)))));
  }
  /**
   * A track's start, by the record: launch for an entry track; for after(P, d), the start of the
   * prospect's local day d days after the record's own finish of P (3.3). Null when it never starts
   * (its predecessor never finished, or the lead stopped first).
   */
  function startOf(s: Subject, t: TrackDefinition): number | null {
    const def = campaigns[s.campaign]!.definition;
    const runStart = runStartOf(s);
    if (!Number.isFinite(runStart)) return null;
    const rule = t.start;
    let start: number | null = runStart;
    if (rule.kind === "after") {
      const before = def.tracks.find((x) => x.id === rule.trackId);
      const f = before ? finishOf(s, before) : null;
      start = f === null ? null : dueAfter(f, rule.delayDays, zoneFor(s));
    }
    // Resolved when the earlier track finishes, even if the lead stops before it comes (it then never starts).
    return start;
  }
  /**
   * A track's finish, by the record, and when the app can know it: at its start when its channel has
   * no detail or the detail is already known bad (skipped); at its last send when every step reached
   * the provider and the app knew of that send before it knew the detail was bad (completed; known
   * once its sent event or a confirming lookup came); otherwise at the instant the app learned the
   * detail was bad (failed). Null while it runs, or when the lead stopped first.
   */
  function finishFacts(s: Subject, t: TrackDefinition): { at: number; seen: number } | null {
    const start = startOf(s, t);
    if (start === null || start > endLimitOf(s)) return null;
    const bad = badAtOf(s, t.channel);
    // Skipped at its start; the app can know it once it can know the start (its predecessor's finish seen).
    if (bad <= start) return { at: start, seen: Math.max(start, startSeenAt(s, t) ?? start) };
    // A taken conversation (question Q7 answered): finished at the record's own skip instant, once it has come.
    const skipped = decidedSkips.get(`${s.id}/${t.id}`);
    if (skipped !== undefined && skipped < bad) return { at: skipped, seen: skipped };
    const sends = t.steps.map((st) => deliveryOf(t.channel, s.id, st.id));
    const lastSend = sends.at(-1);
    if (lastSend && sends.every((d) => d !== undefined) && knownAt(t.channel, lastSend) < bad) {
      const at = Math.max(lastSend.at, firstCall(t.channel, s.id, t.steps.at(-1)!.id)?.at ?? 0);
      return { at, seen: Math.max(at, knownAt(t.channel, lastSend)) };
    }
    return Number.isFinite(bad) && bad <= endLimitOf(s) ? { at: bad, seen: bad } : null;
  }
  function finishOf(s: Subject, t: TrackDefinition): number | null {
    return finishFacts(s, t)?.at ?? null;
  }
  function finishSeenAt(s: Subject, t: TrackDefinition): number | null {
    return finishFacts(s, t)?.seen ?? null;
  }


  // ------------------------------------------------------------------------------------------
  // Question Q7 answered: the record's own view of taken conversations, from the SMS provider's logs, the pool edits it
  // made, the mobiles it changed, the claims it saw made and its own upgrade from the interim engine.

  /** The SMS pool in force for a campaign at instant `t`: its definition's, as the edits the record made left it by then. */
  function poolAt(ci: number, t: number): string[] {
    const c = campaigns[ci]!;
    return [...(c.poolEdits.filter((e) => e.at <= t).at(-1)?.pool ?? c.definition.smsPool ?? [])];
  }
  /** The mobile a person had at `t`: their own, or the one a later export gave them (the record's re-import). */
  function mobileAt(s: Subject, t: number): string | null {
    const changed = s.person ? mobileChanges.get(s.person.key) : undefined;
    // A change at the very instant a track started came after it: that instant's tick started the track first.
    return changed && changed.at < t ? changed.mobile : (s.person?.mobile ?? null);
  }
  /** The mobile an SMS track texts: the newest the person had when it started. */
  function trackMobile(s: Subject, t: TrackDefinition): string | null {
    const start = startOf(s, t);
    return start === null ? null : mobileAt(s, start);
  }
  /** The numbers a subject may text from at `t`: the number its first handover was from by then (fixed), else its pool. */
  function usableAt(s: Subject, t: number): string[] {
    const first = sms.handoverLog.find((c) => c.subjectId === s.id && c.at <= t);
    return first ? [first.sender] : poolAt(s.campaign, t);
  }
  /**
   * When `mobile`'s conversation on `sender` became another subject's for good: when the app could know that subject's
   * text, the first that went there, was sent (point 10). Null if nobody's text went there, or `s`'s went first.
   */
  function takenFor(s: Subject, sender: string, mobile: string): number | null {
    const first = sms.deliveryLog.find((d) => d.sender === sender && d.destination === mobile);
    if (!first || first.subjectId === s.id) return null;
    // Point 10 and the reply rule: a conversation once a text is known sent, or once the mobile answered on that number.
    const answered = sms.replyLog.find((r) => r.from === mobile && r.to === sender && r.at >= first.at)?.at ?? Infinity;
    return Math.min(knownAt("sms", first), answered);
  }
  /** Whether every number `s` may use at `t` had a text known sent to `mobile` for someone else by `t` (4.5, point 10). */
  function allTakenAt(s: Subject, t: number, mobile: string): boolean {
    const usable = usableAt(s, t);
    return usable.length > 0 && usable.every((n) => {
      const at = takenFor(s, n, mobile);
      return at !== null && at <= t;
    });
  }
  /**
   * A pending step's priority item by the record (4.3): touched once a send of the subject's was known by then; due at its
   * track's start for a first step, else its wait after the step before it went.
   */
  function itemAt(subjectId: string, stepId: string, at: number): { touched: boolean; dueWall: number; subjectId: string; stepId: string } | null {
    const rec = subjects.get(subjectId);
    const t = rec ? campaigns[rec.campaign]!.definition.tracks.find((x) => x.steps.some((st) => st.id === stepId)) : undefined;
    if (!rec || !t) return null;
    const i = t.steps.findIndex((st) => st.id === stepId);
    const prev = i > 0 ? deliveryOf(t.channel, rec.id, t.steps[i - 1]!.id) : undefined;
    const due = i === 0 ? startOf(rec, t) : prev ? dueAfter(prev.at, t.steps[i]!.waitDays, zoneFor(rec)) : null;
    const touched = (["sms", "email"] as const).some((c) => deliveriesOf(c).some((d) => d.subjectId === subjectId && knownAt(c, d) <= at));
    return { touched, dueWall: due ?? Infinity, subjectId, stepId };
  }
  /** The pacing gap of a number, as the generator gave it. */
  const gapOf = (accountId: string) => [...numbers, ...(lateNumber ? [lateNumber] : [])].find((n) => n.id === accountId)?.gapMs ?? 0;
  /**
   * When a claim the subject made on `accountId` at or before `t`, still waiting there, ends (the engine's claim: 4.2,
   * 5.5): its handover is tried when the number's pacing slot next frees (the last handover on it, plus its gap), and
   * fails there because the conversation is taken; or it expires one settling period after it was made. Null when no
   * such claim waits at `t`.
   */
  function claimEnd(s: Subject, stepId: string, t: number): number | null {
    const waiting = claims.filter((c) => c.subjectId === s.id && c.stepId === stepId && c.at <= t && !sms.handoverLog.some((x) => x.attemptId === c.attemptId) && c.at + SETTLING > t).at(-1);
    if (!waiting) return null;
    const onNumber = sms.handoverLog.filter((x) => x.sender === waiting.accountId);
    const ours = itemAt(s.id, stepId, t);
    const aheadOf = (x: { subjectId: string; stepId: string; at: number }) => {
      const theirs = itemAt(x.subjectId, x.stepId, x.at);
      return ours === null || theirs === null || higherPriority(theirs, ours);
    };
    // Claims on one number are taken in priority order (4.3, 5.5). A handover at an instant for someone ahead of this claim
    // took the slot first; one behind it came after this claim was tried in that instant (a claim whose handover fails
    // takes no slot), so it does not hold this claim back there.
    const before = (x: { subjectId: string; stepId: string; at: number }, at: number) => x.at < at || (x.at === at && x.subjectId !== s.id && aheadOf(x));
    let at = t;
    for (let guard = 0; guard < 1000; guard++) {
      // The slot frees a gap after the number's last handover that came before this claim.
      const free = Math.max(at, Math.max(-Infinity, ...onNumber.filter((x) => before(x, at)).map((x) => x.at)) + gapOf(waiting.accountId));
      if (free > at && onNumber.some((x) => x.at === free && before(x, free))) {
        at = free;
        continue;
      }
      return Math.min(free, waiting.at + SETTLING);
    }
    return waiting.at + SETTLING;
  }
  /**
   * The record's own instant for an SMS track's skip for a taken conversation, or null: the first instant from its start
   * (its first step's due instant) at which every number it may use has another subject's text known sent to its mobile,
   * inside its window, and no claim of its own still waits (a waiting claim's handover fails, or it expires, first); never
   * while the interim engine runs, and never after the lead stopped. Its candidate instants are the start, every instant a
   * text to that mobile became known sent, every pool edit and the upgrade.
   */
  function skipAtOf(s: Subject, t: TrackDefinition): number | null {
    if (t.channel !== "sms") return null;
    const mobile = trackMobile(s, t);
    const start = startOf(s, t);
    const stepId = t.steps[0]?.id;
    if (mobile === null || start === null || stepId === undefined) return null;
    if (sms.deliveryLog.some((d) => d.subjectId === s.id && t.steps.some((st) => st.id === d.stepId))) return null;
    if (interimUntil && upgradeAt === null) return null;
    const zone = zoneFor(s);
    // Never before the app can know the track started: its predecessor's finish seen (a send reported late).
    const seen = Math.max(start, startSeenAt(s, t) ?? start);
    const instants = [seen, upgradeAt ?? seen, ...sms.deliveryLog.filter((d) => d.destination === mobile && d.subjectId !== s.id).map((d) => knownAt("sms", d)), ...campaigns[s.campaign]!.poolEdits.map((e) => e.at)]
      .filter((x) => Number.isFinite(x) && x >= Math.max(seen, upgradeAt ?? seen))
      .sort((a, b) => a - b);
    for (const from of instants) {
      if (!allTakenAt(s, from, mobile)) continue;
      let at = firstOpen(t.window, zone, from);
      for (let guard = 0; guard < 20 && Number.isFinite(at); guard++) {
        const end = claimEnd(s, stepId, at);
        if (end === null || end <= at) break;
        at = firstOpen(t.window, zone, end);
      }
      if (!Number.isFinite(at) || !allTakenAt(s, at, mobile) || at >= endLimitOf(s) || mobileBadAt(mobile) <= at) continue;
      return at;
    }
    return null;
  }
  function decideSkips(now: number): void {
    for (const rec of subjects.values()) {
      for (const t of campaigns[rec.campaign]!.definition.tracks) {
        const key = `${rec.id}/${t.id}`;
        if (decidedSkips.has(key)) continue;
        const at = skipAtOf(rec, t);
        if (at !== null && at <= now) decidedSkips.set(key, at);
      }
    }
  }
  /** When SMS stopped reaching the lead: every SMS track of its campaign skipped for a taken conversation (2.1). */
  function smsLostAt(s: Subject): number {
    const tracks = campaigns[s.campaign]!.definition.tracks.filter((t) => t.channel === "sms");
    const skips = tracks.flatMap((t) => decidedSkips.get(`${s.id}/${t.id}`) ?? []);
    return tracks.length > 0 && skips.length === tracks.length ? Math.max(...skips) : Infinity;
  }

  // ------------------------------------------------------------------------------------------
  const finishedSnapshots = new Map<string, string>();
  const eventCount = options.events ?? 18;
  // Mostly the campaign launched last, which is the one that finds conversations taken, and mostly in the run's second
  // half, so the number joins both before and after a skip on it.
  const lateCampaign = lateAt.campaign < 0.75 ? campaigns.length - 1 : Math.floor(((lateAt.campaign - 0.75) / 0.25) * campaigns.length);
  const lateEvent = Math.floor((lateAt.event < 0.7 ? 0.5 + lateAt.event / 1.4 : (lateAt.event - 0.7) / 0.6) * eventCount);
  for (let e = 0; e < eventCount; e++) {
    const at = (x: number) => Math.floor(x * eventCount);
    // The interim engine is simulated by switching the skip off in `rules.evaluate`; a running campaign's save and an
    // import evaluate through the domain itself, so no edit or import is made while it runs: the upgrade comes first.
    const edits = [refusalAt, removalAt, mobileChangeAt].some((x) => x && e === at(x.event)) || (lateNumber !== null && e === lateEvent);
    if (interimUntil && upgradeAt === null && (e === at(interimUntil.event) || edits)) {
      // The upgrade: the same database under the engine as built, at the first tick after it (question Q7 answered).
      if (options.rules?.evaluate) rulesNow.evaluate = options.rules.evaluate;
      else delete rulesNow.evaluate;
      await h.restart();
      upgradeAt = h.clock;
      await h.tick();
      features.add("leads-held-under-the-interim-upgraded");
      // An edit due at this event comes a minute after the upgrade's tick, never at the same instant.
      if (edits) await h.advanceTo(h.clock + MINUTE);
    }
    if (refusalAt && e === at(refusalAt.event)) {
      // A number refuses its next text for an account reason (point 10): that binding is released as unsent.
      const n = numbers[Math.floor(refusalAt.number * numbers.length)]!;
      sms.refuseFrom.set(n.id, { calls: 1, reason: "rate_limited", retryAfterMs: refusalAt.retryMs });
      features.add("a-number-refuses-a-text");
    }
    if (unsentAt && e === at(unsentAt.event)) unsentArmed = "armed";
    if (answerUnknownAt && e === at(answerUnknownAt.event)) answerUnknownArmed = true;
    // The user marks a text whose outcome stays unknown a day after it went to the provider, as Needs attention asks.
    if (unanswered.some((u) => u.at <= h.clock - DAY)) await markUnanswered();
    if (removalAt && e === at(removalAt.event)) {
      // The user removes a number from a running campaign's SMS senders.
      const ci = Math.floor(removalAt.campaign * campaigns.length);
      const c = campaigns[ci]!;
      const pool = poolAt(ci, h.clock);
      if (pool.length >= 2) {
        const next = pool.filter((_, i) => i !== Math.floor(removalAt.which * pool.length));
        // Refused (409) when no number left in the pool can send now: a launch blocker of the running edit (ticket 19).
        const saved = await h.request("PUT", `/api/campaigns/${c.id}/sequence`, { ...c.definition, smsPool: next, tracks: [...c.definition.tracks, ...c.branch] });
        if (saved.status === 200) {
          c.poolEdits.push({ at: h.clock, pool: next });
          features.add("a-number-left-a-pool");
        } else features.add("a-number-removal-refused");
      }
    }
    if (mobileChangeAt && e === at(mobileChangeAt.event)) {
      // A later export gives a person a new mobile (newer than the old one, which stays theirs); later SMS tracks text it.
      const candidates = people.filter((p) => p.mobile && !sms.invalid.has(p.mobile) && !sms.invalidAfterSend.has(p.mobile) && campaigns.some((c) => c.id && c.companies.includes(p.company)));
      const p = candidates[Math.floor(mobileChangeAt.person * candidates.length)];
      const c = p ? campaigns.find((x) => x.id && x.companies.includes(p.company)) : undefined;
      if (p && c) {
        const mobile = `+4477009009${String(50 + people.indexOf(p))}`;
        await h.reimport(c.id, rowsFor(c, new Map([[p.key, mobile]])));
        mobileChanges.set(p.key, { mobile, at: h.clock });
        features.add("a-mobile-changed");
      }
    }
    if (lateNumber && e === lateEvent) {
      // The user adds the fourth number to one running campaign's SMS senders (a pool edit stores nothing, ticket 19).
      const c = campaigns[lateCampaign]!;
      const pool = [...poolAt(lateCampaign, h.clock), lateNumber.id];
      await h.defineSequence(c.id, { ...c.definition, smsPool: pool, tracks: [...c.definition.tracks, ...c.branch] });
      c.joined = { number: lateNumber.id, at: h.clock };
      c.poolEdits.push({ at: h.clock, pool });
      features.add("a-number-joined-a-pool");
    }
    const r = rand();
    if (r < 0.5) {
      await h.advanceTo(h.clock + pick([2 * MINUTE, 20 * MINUTE, 2 * HOUR, 7 * HOUR, DAY, 2 * DAY, 3 * DAY]));
    } else if (r < 0.68) {
      const texted = sms.deliveryLog.filter((d) => d.at <= h.clock);
      if (texted.length > 0) {
        const d = pick(texted);
        textBack(d.destination, d.sender);
      }
      await h.tick();
    } else if (r < 0.8) {
      // An email reply on a thread the app already knows.
      const visible = email.deliveryLog.filter((d) => d.visibleAt <= h.clock);
      if (visible.length > 0) replyOnKnownThread(pick(visible).destination);
      await h.tick();
    } else if (r < 0.9) {
      const n = pick(numbers);
      if (chance(0.5)) n.healthy = !n.healthy;
      else n.listed = n.listed === false;
      features.add("number-health");
      await h.tick();
    } else {
      await h.advanceTo(h.clock + pick([MINUTE, HOUR, DAY]));
    }
    await checkAll(false);
    if (problems.length > 0 || h.stopped) break;
  }

  if (problems.length === 0 && options.drain !== false) {
    hookBudget = 0;
    draining = true;
    // The user marks each text whose outcome stays unknown (Needs attention lists it).
    await markUnanswered();
    for (const n of numbers) {
      n.healthy = true;
      n.listed = true;
    }
    await h.advanceTo(h.clock + 21 * DAY);
    await markUnanswered();
    for (let week = 0; week < 6; week++) {
      let waiting = false;
      for (const id of await h.store.engine.runningLeadIds()) {
        const p = (await h.request<EnrollmentProgress>("GET", `/api/enrollments/${id}`)).body;
        if (p.tracks.some((t) => t.finishReason === null && t.nextStep !== null && t.hold === null)) waiting = true;
      }
      if (!waiting) break;
      await h.advanceTo(h.clock + 7 * DAY);
    }
    // A run stopped by its bound reports what it found before, not an unfinished drain.
    if (!h.stopped) await checkAll(true);
    if (!h.stopped) await checkActivity();
  }

  for (const id of subjects.keys()) {
    const st = await h.store.engine.subject(id, h.clock);
    if (!st) continue;
    const def = campaigns[subjects.get(id)!.campaign]!.definition;
    for (const a of st.attempts) if (a.endedBy === "claim_expired" || a.endedBy === "guard") features.add(`withdrawn:${a.endedBy}`);
    for (const p of st.tracks) {
      const rule = def.tracks.find((t) => t.id === p.trackId)?.start;
      const before = rule?.kind === "after" ? st.tracks.find((x) => x.trackId === rule.trackId) : undefined;
      if (before && p.startedAt !== null && before.finishReason !== "completed") features.add(`released-after:${before.finishReason}`);
    }
    if (st.smsBindings.some((b) => b.owner !== id && b.ownerEnded)) features.add("conversation-of-ended-owner");
    if (st.subject.ended) features.add(`ended:${st.subject.ended}`);
  }
  // A number joined the pool of a campaign that had skipped a track for a taken conversation, after the skip (Q7 answered).
  for (const [key, at] of decidedSkips) {
    const joined = campaigns[subjects.get(key.split("/")[0]!)!.campaign]!.joined;
    if (joined && joined.at > at) features.add("a-number-joined-after-a-skip-in-its-campaign");
  }
  if (sms.refusals.length > 0) features.add("invalid-number");
  if (sms.deliveryLog.some((d) => sms.invalidAfterSend.has(d.destination))) features.add("invalid-after-send");
  if (email.deliveryLog.some((d) => email.bouncing.has(d.destination))) features.add("bounce");
  return { problems, stats: { texts: sms.deliveryLog.length, emails: email.deliveryLog.length, subjects: subjects.size, ticks: h.ticks, writes: h.writes, features: [...features] } };

  // ------------------------------------------------------------------------------------------
  // The checks.

  async function checkAll(drained: boolean): Promise<void> {
    const now = h.clock;
    const states = new Map<string, SubjectState>();
    for (const id of subjects.keys()) {
      const s = await h.store.engine.subject(id, now);
      if (s) states.set(id, s);
    }
    for (const st of states.values()) {
      if (st.subject.ended === null && st.tracks.some((p) => p.finishedAt === null && heldReason(st, p.trackId, now) === "sms_conversation_unsettled")) features.add("held-on-an-unsettled-conversation");
    }
    // Needs attention answers at every check; a taken conversation is no longer one of its holds (28).
    if ((await h.request<NeedsAttention>("GET", "/api/needs-attention")).status !== 200) problem("18: Needs attention did not answer");

    // 28. A skip for a taken conversation happens exactly at the record's own instant (`skipAtOf`): (a) never later, so
    // no lead is left waiting on a taken conversation; (b) never earlier, never without every usable number taken by a
    // text known sent, whatever a free number's capacity, health or pacing. The record decides its skips first, in track
    // order, so a later track's start reads its predecessor's skip; 6 keeps a stored skip from changing after.
    decideSkips(now);
    for (const [id, s] of states) {
      const rec = subjects.get(id)!;
      for (const t of campaigns[rec.campaign]!.definition.tracks) {
        const p = s.tracks.find((x) => x.trackId === t.id);
        const key = `${id}/${t.id}`;
        const decided = decidedSkips.get(key);
        const stored = p?.finishReason === "skipped_conversation_taken" ? p.finishedWall : null;
        if (decided === undefined && stored === null) continue;
        if (decided !== undefined && stored === null && s.subject.ended === null && (p?.finishedAt ?? null) === null) {
          problem(`28: ${key} waits on a taken conversation at ${new Date(now).toISOString()}; the record skipped it at ${new Date(decided).toISOString()}`);
        } else if (stored !== null && stored !== decided) {
          problem(`28: ${key} was skipped for a taken conversation at ${new Date(stored).toISOString()}; the record ${decided === undefined ? "has no skip for it" : `skipped it at ${new Date(decided).toISOString()}`}`);
        }
        if (stored !== null) {
          features.add("conversation-taken");
          if (claims.some((c) => c.subjectId === id && c.stepId === t.steps[0]?.id && c.at <= stored && !sms.handoverLog.some((x) => x.attemptId === c.attemptId))) features.add("conversation-taken-skip-after-a-claim");
          if (upgradeAt !== null && stored === upgradeAt) features.add("conversation-taken-held-under-the-interim");
          if (s.subject.smsSender !== null) features.add("conversation-taken-on-a-fixed-sender");
        }
      }
    }

    for (const [id, s] of states) {
      const rec = subjects.get(id)!;
      const def = campaigns[rec.campaign]!.definition;
      const zone = zoneFor(rec);
      const runStart = runStartOf(rec);
      const progress = (await h.request<EnrollmentProgress>("GET", `/api/enrollments/${id}`)).body;

      // 1. One status: the stored column equals the derived one.
      const column = await storedStatus(rec, id);
      if (column !== progress.status) problem(`1: ${id} stores ${String(column)} but derives ${progress.status}`);

      // 14 and 2.4. A reply stops exactly the subject that owns it, and the status shows the reply
      // that stopped it, whatever replies the app observes later, in any order and on either channel.
      const stop = stopOf(id);
      if (stop && stop.seenAt <= now && progress.status !== "replied") problem(`14: ${id} replied (observed ${new Date(stop.seenAt).toISOString()}) but is ${progress.status}`);
      if (progress.status === "replied" && (!stop || stop.seenAt > now)) problem(`14: ${id} is replied, but no reply on its own conversation or thread reached it`);
      // Replies observed at the same instant reach the app in one pass, in an order the record does not model: either may be the one that stopped it.
      const firsts = stop ? repliesOf(id).filter((r) => r.seenAt === stop.seenAt) : [];
      if (stop && progress.reply && !firsts.some((r) => progress.reply?.channel === r.channel && progress.reply.at === new Date(r.at).toISOString())) {
        problem(`14: ${id} shows a ${progress.reply.channel} reply at ${progress.reply.at}; the reply that stopped it was ${stop.channel} at ${new Date(stop.at).toISOString()}`);
      }

      // 20. Correct endings.
      const channels = [...new Set(def.tracks.map((t) => t.channel))];
      // A mobile whose every SMS track was skipped for a taken conversation no longer reaches the lead (question Q7 answered).
      const usableOn = (c: TrackChannel, t: number) => reachesAt(rec, c, t) && !(c === "sms" && smsLostAt(rec) <= t);
      if (s.subject.ended === "finished_no_usable_channel" && channels.some((c) => usableOn(c, s.subject.endedWall ?? now))) {
        problem(`20: ${id} ended with no usable channel at ${new Date(s.subject.endedWall ?? 0).toISOString()}, though the record has a good ${channels.filter((c) => usableOn(c, s.subject.endedWall ?? now)).join(" and ")} detail`);
      }
      if (s.subject.ended === "sequence_finished_no_response" && s.tracks.length < def.tracks.length) problem(`20: ${id} finished with a track never started`);
      if (s.subject.ended === "sequence_finished_no_response" && s.tracks.some((p) => p.finishedAt === null)) problem(`20: ${id} finished with a track still open`);
      // 2.1: a lead no channel of the campaign reaches at launch ends before any track is started. A
      // detail found bad at the launch instant itself (refused in the launch tick) was good when the tracks started.
      if (runStart <= now && !channels.some((c) => reachesAt(rec, c, runStart - 1)) && s.tracks.some((p) => p.startedAt !== null)) {
        problem(`20: ${id} had no usable channel at launch but started ${JSON.stringify(s.tracks.map((p) => [p.trackId, p.finishReason]))}`);
      }

      // 7. Starts and finishes, and so every release, are the record's own: compared after every event.
      const endLimit = endLimitOf(rec);
      for (const t of def.tracks) {
        const p = s.tracks.find((x) => x.trackId === t.id);
        const start = startOf(rec, t);
        const finish = finishOf(rec, t);
        const startWall = p?.startAt != null ? runStart + p.startAt : null;
        if (startWall !== null && startWall !== start) problem(`7: ${id}/${t.id} starts at ${new Date(startWall).toISOString()}; the record says ${start === null ? "never" : new Date(start).toISOString()} (${t.start.kind === "after" ? `${t.start.delayDays} day(s) after ${t.start.trackId}` : "entry"}, ${zone})`);
        const startSeen = startSeenAt(rec, t);
        if (start !== null && startSeen !== null && startSeen <= now && start < endLimit && p?.startedAt == null) problem(`7: ${id}/${t.id} was due to start at ${new Date(start).toISOString()} but has not`);
        if (start !== null && startSeen !== null && startSeen <= now && startWall === null && s.subject.ended === null) problem(`7: ${id}/${t.id} has no start, though the record has it at ${new Date(start).toISOString()}`);
        if (p?.finishedWall != null && p.finishedWall !== finish) {
          // After the lead stopped, its clock is frozen: a late fact may finish a track at that frozen instant.
          const frozen = s.subject.endedWall !== null && p.finishedWall === s.subject.endedWall && (finish === null || finish >= s.subject.endedWall);
          if (!frozen) problem(`7: ${id}/${t.id} finished ${p.finishReason ?? ""} at ${new Date(p.finishedWall).toISOString()}; the record says ${finish === null ? "it has not finished" : new Date(finish).toISOString()}`);
        }
        const finishSeen = finishSeenAt(rec, t);
        if (finish !== null && finishSeen !== null && finishSeen <= now && finish < endLimit && p?.finishedWall == null) problem(`7: ${id}/${t.id} should have finished at ${new Date(finish).toISOString()} but has not`);
      }

      // 6. A finished track never changes; nothing is called for it after it finished.
      for (const p of s.tracks) {
        if (p.finishedAt === null) {
          if (finishedSnapshots.has(`${id}/${p.trackId}`)) problem(`6: finished track ${id}/${p.trackId} reopened: ${finishedSnapshots.get(`${id}/${p.trackId}`)} -> unfinished`);
          continue;
        }
        const key = `${id}/${p.trackId}`;
        const snap = JSON.stringify([p.finishReason, p.finishedAt, p.startedAt]);
        const was = finishedSnapshots.get(key);
        if (was === undefined) finishedSnapshots.set(key, snap);
        else if (was !== snap) problem(`6: finished track ${key} changed: ${was} -> ${snap}`);
        const t = def.tracks.find((x) => x.id === p.trackId)!;
        for (const c of callsOf(t.channel)) if (c.subjectId === id && t.steps.some((st) => st.id === c.stepId) && c.at > (p.finishedWall ?? Infinity)) problem(`6: ${key} was called for ${c.stepId} after it finished`);
      }

      // 1.3 and 14. The SMS sender is fixed by the first text, and every text of the subject comes from it.
      const own = sms.handoverLog.filter((c) => c.subjectId === id);
      if (new Set(own.map((c) => c.sender)).size > 1) problem(`14: ${id} was texted from ${[...new Set(own.map((c) => c.sender))].join(" and ")}`);
      if ((own[0]?.sender ?? null) !== s.subject.smsSender) problem(`1.3: ${id} has SMS sender ${s.subject.smsSender ?? "none"}; its first text came from ${own[0]?.sender ?? "none"}`);

      if (h.sms.deliveryLog.some((d) => d.subjectId === id && d.sender === campaigns[rec.campaign]!.joined?.number)) features.add("a-joined-number-texted");

      // 18 and 20 after the drain: the record's outcome for every track, and nothing left undone.
      if (drained) checkOutcome(rec, s, progress, now);
    }

    checkLogs(states);
  }

  /**
   * Activity against the record (council on 10121d3, item 8): after the drain, each subject's timeline
   * lists exactly the entries the record derives from its own starts, finishes, the providers' logs and
   * the replies, so it can neither omit nor invent one. Entries are compared as kind, channel, track
   * label and message number; "ended" against the stored ending, which invariant 20 checks.
   */
  async function checkActivity(): Promise<void> {
    const now = h.clock;
    for (const rec of subjects.values()) {
      const def = campaigns[rec.campaign]!.definition;
      const campaignId = campaigns[rec.campaign]!.id;
      const state = await h.store.engine.subject(rec.id, now);
      if (!state || !campaignId) continue;
      const path = rec.kind === "person" ? `/api/people/${rec.recordId}/activity` : `/api/companies/${rec.recordId}/activity`;
      const shown = (await h.request<ActivityView>("GET", path)).body.entries
        .filter((e) => e.campaign.id === campaignId)
        // The controls' entries (ticket 17b) are checked by example, in controls-screens.test.ts.
        .filter((e): e is Exclude<ActivityView["entries"][number], { kind: "control" | "campaign_paused" | "campaign_resumed" }> => e.kind !== "control" && e.kind !== "campaign_paused" && e.kind !== "campaign_resumed")
        .map((e) => (e.kind === "replied" ? `replied|${e.channel}` : e.kind === "ended" ? "ended" : `${e.kind}|${e.channel}|${e.track.label}|${"stepNumber" in e && e.stepNumber !== null ? e.stepNumber : "-"}`))
        .sort();

      const expected: string[] = [];
      const runStart = runStartOf(rec);
      const channels = [...new Set(def.tracks.map((t) => t.channel))];
      const atLaunch = runStart <= now && !channels.some((c) => reachesAt(rec, c, runStart - 1));
      const branch = campaigns[rec.campaign]!.branch;
      if (branch.length > 0) features.add(atLaunch ? "no-channel-at-launch-beside-a-branch" : "a-lead-beside-a-branch-never-entered");
      // A branch the lead never entered has no progress and is in none of its reads (review bot on 654907b).
      const progress = (await h.request<EnrollmentProgress>("GET", `/api/enrollments/${rec.id}`)).body;
      if (progress.branch !== "main" || progress.tracks.some((t) => branch.some((b) => b.id === t.trackId))) problem(`activity: ${rec.id}'s progress shows the win-back branch it never entered (${JSON.stringify(progress.tracks.map((t) => t.trackId))})`);
      const ownCall = (t: TrackDefinition) => callsOf(t.channel).filter((c) => c.subjectId === rec.id && t.steps.some((st) => st.id === c.stepId));
      const completed = (t: TrackDefinition) => {
        const sends = t.steps.map((st) => deliveryOf(t.channel, rec.id, st.id));
        const last = sends.at(-1);
        return last !== undefined && sends.every((d) => d !== undefined) && knownAt(t.channel, last) < badAtOf(rec, t.channel);
      };
      // At the instant the lead ends (its first reply, or its last channel known bad), the record does
      // not model the order within the engine's pass: a track that starts then may be stored or not.
      // The provider's log of calls (independent of the engine's store) settles it when the track
      // called; otherwise Activity must show either all of what the record expects of that track, or
      // none of it (search on 7401eb2: seeds 20261124, 20261125, 20261142, 20261191 and others).
      const called = (t: TrackDefinition) => ownCall(t).length > 0;
      const started = (t: TrackDefinition) => {
        const start = startOf(rec, t);
        return start !== null && start <= now && start <= endLimitOf(rec) ? start : null;
      };
      const entriesOf = (t: TrackDefinition, start: number): string[] => {
        const out: string[] = [];
        const label = trackLabel(def, t).label;
        const rule = t.start;
        const before = rule.kind === "after" ? def.tracks.find((x) => x.id === rule.trackId) : undefined;
        if (before) {
          const beforeStart = started(before);
          if (beforeStart !== null && (!reachesAt(rec, before.channel, beforeStart) || !completed(before))) out.push(`released|${t.channel}|${label}|-`);
        }
        // Skipped for a taken conversation: one entry for the track, nothing sent (question Q7 answered).
        if (decidedSkips.has(`${rec.id}/${t.id}`)) {
          out.push(`skipped|${t.channel}|${label}|-`);
          return out;
        }
        const owned = { failure: false };
        t.steps.forEach((st, i) => {
          const d = deliveryOf(t.channel, rec.id, st.id);
          if (d && knownAt(t.channel, d) <= now) out.push(`sent|${t.channel}|${label}|${i + 1}`);
          const refused = ownCall(t).some((c) => c.stepId === st.id && sms.refusals.some((r) => r.attemptId === c.attemptId && r.reason === "invalid_destination"));
          if (t.channel === "sms" && refused) {
            out.push(`failed|sms|${label}|${i + 1}`);
            owned.failure = true;
          }
          const bad = t.channel === "sms" ? sms.invalidAfterSend : email.bouncing;
          if (d && bad.has(d.destination)) {
            out.push(`bounced|${t.channel}|${label}|${i + 1}`);
            owned.failure = true;
          }
        });
        // Skipped when its detail was missing or already bad at its start, unless its own first call
        // found it bad at that very instant (then it failed); ended on a bad detail with no failure or
        // bounce of its own: marked bad elsewhere.
        const own = owned.failure;
        // A track that starts at the very instant another track's call finds the detail bad: stored
        // skipped (started after the detail went bad) or failed (started first, then found bad), both
        // of which the engine may store (check 20). Activity must say whichever it is (seed 20261142).
        if (!own && badAtOf(rec, t.channel) === start && !called(t)) {
          const either = [`skipped|${t.channel}|${label}|-`, `address_bad|${t.channel}|${label}|-`];
          out.push(either.find((x) => shown.includes(x)) ?? either[0]!);
          return out;
        }
        const skipped = !own && !reachesAt(rec, t.channel, start);
        if (skipped) out.push(`skipped|${t.channel}|${label}|-`);
        if (!skipped && !own && !completed(t) && badAtOf(rec, t.channel) < Math.min(now + 1, endLimitOf(rec))) out.push(`address_bad|${t.channel}|${label}|-`);
        return out;
      };
      for (const t of def.tracks) {
        if (t.channel === "call") continue;
        if (atLaunch) {
          expected.push(`skipped|${t.channel}|${trackLabel(def, t).label}|-`);
          continue;
        }
        const start = started(t);
        if (start === null) continue;
        const entries = entriesOf(t, start);
        if (start < endLimitOf(rec) || called(t) || entries.every((e) => shown.includes(e))) expected.push(...entries);
      }
      const stop = stopOf(rec.id);
      if (stop && stop.seenAt <= now) {
        // Replies observed in the same pass reach the app in an order the record does not model: either may be the one that stopped it.
        const firsts = repliesOf(rec.id).filter((r) => r.seenAt === stop.seenAt).map((r) => `replied|${r.channel}`);
        expected.push(firsts.find((x) => shown.includes(x)) ?? `replied|${stop.channel}`);
      }
      else if (state.subject.ended === "sequence_finished_no_response" || state.subject.ended === "finished_no_usable_channel") expected.push("ended");
      expected.sort();
      if (JSON.stringify(shown) !== JSON.stringify(expected)) problem(`activity: ${rec.id} shows ${JSON.stringify(shown)}; the record has ${JSON.stringify(expected)}`);
    }
  }

  function callsOf(channel: TrackChannel): HandoverLogEntry[] {
    return channel === "sms" ? sms.handoverLog : email.handoverLog;
  }
  function firstCall(channel: TrackChannel, subjectId: string, stepId: string) {
    return callsOf(channel).find((c) => c.subjectId === subjectId && c.stepId === stepId);
  }

  /** After the drain: each track's finish is the one the record expects, and the lead is ended, held or replied. */
  function checkOutcome(rec: Subject, s: SubjectState, progress: EnrollmentProgress, now: number): void {
    const id = rec.id;
    const def = campaigns[rec.campaign]!.definition;
    if (s.subject.ended === null) {
      if (!progress.tracks.some((t) => t.hold !== null)) problem(`18: ${id} is ${progress.status} after the drain with nothing held (${JSON.stringify(progress.tracks.map((t) => [t.trackId, t.finishReason, t.nextStep?.stepId ?? null]))})`);
      return;
    }
    if (s.subject.ended === "replied") return;
    for (const p of s.tracks) {
      const t = def.tracks.find((x) => x.id === p.trackId)!;
      const detail = t.channel === "email" ? addressOf(rec) : mobileOf(rec);
      const startWall = p.startAt === null ? null : runStartOf(rec) + p.startAt;
      const sentAll = t.steps.every((st) => deliveryOf(t.channel, id, st.id) !== undefined);
      const expected: string[] = [];
      if (detail === null || (startWall !== null && !reachesAt(rec, t.channel, startWall))) expected.push("skipped_missing_channel");
      // A detail known bad while the track is open fails it, in this campaign or any other.
      if (detail !== null) expected.push("failed_bad_destination");
      if (sentAll) expected.push("completed");
      if (decidedSkips.has(`${id}/${t.id}`)) expected.push("skipped_conversation_taken");
      if (p.finishReason !== null && !expected.includes(p.finishReason)) problem(`20: ${id}/${t.id} finished ${p.finishReason}; the record expects ${expected.join(" or ")}`);
      if (p.finishReason === "completed" && !sentAll) problem(`20: ${id}/${t.id} completed though ${t.steps.filter((st) => !deliveryOf(t.channel, id, st.id)).map((st) => st.id).join(", ")} never reached the provider`);
      if (p.finishReason === "failed_bad_destination" && detail !== null && (t.channel === "email" ? emailBadAt(detail) : mobileBadAt(detail)) > now) problem(`20: ${id}/${t.id} failed though the record never saw ${detail} go bad`);
    }
    // Every reachable track of the definition ran to its end, unless the lead was left with no usable channel.
    if (s.subject.ended === "sequence_finished_no_response") {
      for (const t of def.tracks) if (!s.tracks.some((p) => p.trackId === t.id && p.finishedAt !== null)) problem(`20: ${id} finished with ${t.id} never finished`);
    }
  }

  /** Checks on the providers' own logs. */
  function checkLogs(states: ReadonlyMap<string, SubjectState>): void {
    // 3. At most one live attempt and one sent attempt per step.
    for (const s of states.values()) {
      const byStep = new Map<string, { live: number; sent: number }>();
      for (const a of s.attempts) {
        const x = byStep.get(a.stepId) ?? { live: 0, sent: 0 };
        if (["claimed", "handed", "accepted"].includes(a.state)) x.live++;
        if (a.state === "sent") x.sent++;
        byStep.set(a.stepId, x);
      }
      for (const [step, x] of byStep) if (x.live > 1 || x.sent > 1) problem(`3: ${s.subject.id}/${step} has ${x.live} live and ${x.sent} sent attempts`);
    }
    for (const channel of ["email", "sms"] as const) {
      const calls = callsOf(channel);
      const deliveries = deliveriesOf(channel);
      // 4. Sent at most once.
      const delivered = new Map<string, number>();
      for (const d of deliveries) delivered.set(`${d.subjectId}/${d.stepId}`, (delivered.get(`${d.subjectId}/${d.stepId}`) ?? 0) + 1);
      for (const [key, n] of delivered) if (n > 1) problem(`4: ${channel} ${key} was delivered ${n} times`);
      // 10. Capacity per account per reset day, across campaigns.
      const accounts = channel === "email" ? inboxes : lateNumber ? [...numbers, lateNumber] : numbers;
      for (const acc of accounts) {
        const perDay = new Map<number, number>();
        for (const d of deliveries) if (d.sender === acc.id) perDay.set(local(d.at, acc.resetZone).day, (perDay.get(local(d.at, acc.resetZone).day) ?? 0) + 1);
        for (const [day, n] of perDay) if (n > acc.capacity) problem(`10: ${acc.id} sent ${n} on reset day ${new Date(day * DAY).toISOString().slice(0, 10)} against a capacity of ${acc.capacity}`);
        // 11. Pacing: two calls from one account never closer than its gap.
        const times = calls.filter((c) => c.sender === acc.id).map((c) => c.at);
        for (let i = 1; i < times.length; i++) if (times[i]! - times[i - 1]! < (acc.gapMs ?? 0)) problem(`11: ${acc.id} called ${times[i]! - times[i - 1]!} ms apart, under its gap of ${acc.gapMs}`);
      }
      // 2. No call from a disconnected sender.
      for (const c of calls) if (!c.healthy) problem(`2: ${c.subjectId}/${c.stepId} was called from ${c.sender} while it was disconnected`);
    }
    // 14. One owner per conversation: every text that went from a number to a mobile is for one subject. A first text
    // refused or never sent owns nothing (point 10), so another subject may hand one over there after it.
    const pairs = new Map<string, Set<string>>();
    for (const c of sms.deliveryLog) pairs.set(`${c.sender}>${c.destination}`, (pairs.get(`${c.sender}>${c.destination}`) ?? new Set()).add(c.subjectId));
    for (const [pair, owners] of pairs) if (owners.size > 1) problem(`14: the conversation ${pair} was texted for ${owners.size} subjects`);

    // 8, 13, 19 and 2, per subject and track on the call logs.
    for (const rec of subjects.values()) {
      const def = campaigns[rec.campaign]!.definition;
      const zone = zoneFor(rec);
      const replied = stoppedAt(rec.id);
      for (const t of def.tracks) {
        const calls = callsOf(t.channel).filter((c) => c.subjectId === rec.id && t.steps.some((st) => st.id === c.stepId));
        const startWall = startOf(rec, t);
        let previous: HandoverLogEntry | undefined;
        t.steps.forEach((step, i) => {
          const c = calls.find((x) => x.stepId === step.id);
          if (!c) {
            previous = undefined;
            return;
          }
          if (i > 0 && !previous) problem(`8: ${rec.id}/${step.id} was handed over before an earlier step`);
          const prev = i > 0 ? deliveryOf(t.channel, rec.id, t.steps[i - 1]!.id) : undefined;
          const due = i === 0 ? (startWall ?? Infinity) : prev ? dueAfter(prev.at, step.waitDays, zone) : Infinity;
          if (c.at < due) problem(`8: ${rec.id}/${step.id} handed over at ${new Date(c.at).toISOString()} before it was due at ${Number.isFinite(due) ? new Date(due).toISOString() : "never"}`);
          if (!inWindow(t.window, zone, c.at)) problem(`13: ${rec.id}/${step.id} handed over outside its window at ${new Date(c.at).toISOString()} (${zone})`);
          const data = mergeData(rec);
          // A text has no subject; a continue-thread email has none of its own (PR 41 council, item 3).
          const expected = { subject: t.channel === "sms" || step.threading !== "new_subject" ? "" : renderCopy(step.subject, data), body: renderCopy(step.body, data) };
          if (expected.subject !== c.rendered.subject || expected.body !== c.rendered.body) problem(`8: ${rec.id}/${step.id} carried ${JSON.stringify(c.rendered)}; the copy was ${JSON.stringify(expected)}`);
          // 2. Nothing after the lead replied.
          if (c.at > replied) problem(`2: ${rec.id}/${step.id} was called at ${new Date(c.at).toISOString()} after the lead replied at ${new Date(replied).toISOString()}`);
          // 19. Nothing to a detail after the app knew it was bad, for any campaign.
          const badAt = t.channel === "email" ? emailBadAt(c.destination) : mobileBadAt(c.destination);
          if (c.at > badAt) problem(`19: ${rec.id}/${step.id} was called for ${c.destination} after it was known bad at ${new Date(badAt).toISOString()}`);
          // The destination is the lead's own: a decision maker's mobile, never a main line.
          const own = t.channel === "email" ? addressOf(rec) : trackMobile(rec, t);
          if (c.destination !== own) problem(`19: ${rec.id}/${step.id} was sent to ${c.destination}, not the lead's own ${t.channel === "email" ? "address" : "mobile"} (${own ?? "none"})`);
          previous = c;
        });
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // 12. Priority, by the checker's own eligibility (ADR 0003 4.3, ruling 7): follow-ups before first
  // messages to new leads, then oldest due, then subject and step id, among the items an account
  // could take.

  /** The account's state at the provider, as the fakes hold it. */
  function accountUp(accountId: string): boolean {
    const n = [...numbers, ...(lateNumber ? [lateNumber] : [])].find((x) => x.id === accountId);
    if (n) return n.healthy && n.listed !== false;
    return inboxes.find((x) => x.id === accountId)?.healthy ?? false;
  }

  /**
   * Whether the subject's pending step on `trackId` could go on `accountId` now, slot and pre-send
   * check aside: the lead runs, the step is due and unclaimed, the window is open in its zone, the
   * account is up and one it may use (its fixed sender, else its pool), the detail is good by the
   * record, and for SMS the conversation from that number is free or its own by the call log.
   */
  function eligible(st: SubjectState, trackId: string, accountId: string, now: number, ignoreAttempt: string | null): boolean {
    const rec = subjects.get(st.subject.id);
    if (!rec || st.subject.ended !== null || stoppedAt(rec.id) <= now) return false;
    const def = campaigns[rec.campaign]!.definition;
    const t = def.tracks.find((x) => x.id === trackId);
    const p = st.tracks.find((x) => x.trackId === trackId);
    if (!t || !p || p.startedAt === null || p.finishedAt !== null || p.nextStepId === null || p.dueAt === null) return false;
    const stepId = p.nextStepId;
    if (st.results.some((r) => r.stepId === stepId)) return false;
    if (st.attempts.some((a) => a.id !== ignoreAttempt && a.stepId === stepId && ["claimed", "handed", "accepted"].includes(a.state))) return false;
    // The provider refused this step's text after accepting it: held until the user skips or resumes it (5.4).
    if (st.attempts.some((a) => a.stepId === stepId && refusedAfterAcceptance.has(a.id))) return false;
    if (p.dueAt > (st.subject.clock.frozenSince ?? now) - st.subject.clock.frozenTotal) return false;
    if (!inWindow(t.window, zoneFor(rec), now)) return false;
    if (!accountUp(accountId)) return false;
    const fixed = t.channel === "sms" ? st.subject.smsSender : st.subject.emailSender;
    if (fixed !== null ? fixed !== accountId : !(t.channel === "sms" ? poolAt(rec.campaign, now) : def.emailPool).includes(accountId)) return false;
    if (badAtOf(rec, t.channel) <= now) return false;
    if (t.channel === "sms") {
      // The conversation is held by whoever handed a text there first that was not refused (the binding, 4.5).
      const mobile = trackMobile(rec, t) ?? "";
      const holder = sms.handoverLog.find((c) => c.sender === accountId && c.destination === mobile && !sms.refusals.some((r) => r.attemptId === c.attemptId));
      if (holder && holder.subjectId !== rec.id) return false;
    }
    return true;
  }

  function itemOf(st: SubjectState, trackId: string) {
    const p = st.tracks.find((x) => x.trackId === trackId);
    return { touched: st.subject.touched, dueWall: p?.dueWall ?? 0, subjectId: st.subject.id, stepId: p?.nextStepId ?? "" };
  }

  /** At a claim: no unclaimed item that could have gone on that account had a higher priority. */
  async function checkClaimPriority(attemptId: string): Promise<void> {
    const now = h.clock;
    const a = await h.store.engine.attempt(attemptId);
    if (!a) return;
    const mine = await h.store.engine.subject(a.subjectId, now);
    if (!mine) return;
    const channel = campaigns[subjects.get(a.subjectId)?.campaign ?? 0]!.definition.tracks.find((t) => t.id === a.trackId)?.channel;
    const ours = { ...itemOf(mine, a.trackId), stepId: a.stepId };
    for (const id of subjects.keys()) {
      if (id === a.subjectId) continue;
      const st = await h.store.engine.subject(id, now);
      if (!st) continue;
      for (const t of campaigns[subjects.get(id)!.campaign]!.definition.tracks) {
        if (t.channel !== channel || !eligible(st, t.id, a.accountId, now, null)) continue;
        const theirs = itemOf(st, t.id);
        if (higherPriority(theirs, ours)) {
          problem(`12: ${a.subjectId}/${a.stepId} was claimed on ${a.accountId} before ${id}/${theirs.stepId}, which had priority and could have gone there`);
        }
      }
    }
  }

  /** At a first handover call: no claimed attempt on that account that met every predicate but the slot and the pre-send check had a higher priority. */
  async function checkHandoverPriority(call: HandoverLogEntry): Promise<void> {
    const now = h.clock;
    const mine = await h.store.engine.subject(call.subjectId, now);
    const attempt = mine?.attempts.find((x) => x.id === call.attemptId);
    if (!mine || !attempt || attempt.calls > 1) return;
    const ours = { ...itemOf(mine, attempt.trackId), stepId: call.stepId };
    for (const other of await h.store.engine.openAttempts()) {
      if (other.state !== "claimed" || other.accountId !== call.sender || other.id === call.attemptId) continue;
      const st = await h.store.engine.subject(other.subjectId, now);
      if (!st || !eligible(st, other.trackId, other.accountId, now, other.id)) continue;
      const theirs = { ...itemOf(st, other.trackId), stepId: other.stepId };
      if (higherPriority(theirs, ours)) problem(`12: ${call.subjectId}/${call.stepId} was handed over on ${call.sender} before ${other.subjectId}/${other.stepId}, which had priority`);
    }
  }

  function mergeData(rec: Subject): Record<string, string> {
    const data: Record<string, string> = { company: rec.company.name, city: "" };
    if (rec.person) {
      const [first = "", ...rest] = rec.person.name.split(" ");
      Object.assign(data, { first_name: first, last_name: rest.join(" "), full_name: rec.person.name, title: "Owner" });
    }
    return data;
  }

  async function storedStatus(rec: Subject, id: string): Promise<OutreachStatus | undefined> {
    if (rec.person) {
      const found = (await h.request<LeadSearchResult>("GET", `/api/leads?q=${encodeURIComponent(rec.person.name)}`)).body.rows.find((r) => r.name === rec.person?.name);
      if (!found) return undefined;
      return (await h.request<PersonRecord>("GET", `/api/people/${found.id}`)).body.enrollments.find((e) => e.id === id)?.status;
    }
    const found = (await h.request<LeadSearchResult>("GET", `/api/leads?q=${encodeURIComponent(rec.company.name)}`)).body.rows.find((r) => r.kind === "company");
    if (!found) return undefined;
    return (await h.request<CompanyRecord>("GET", `/api/companies/${found.id}`)).body.enrollments.find((e) => e.id === id)?.status;
  }

}

/** The probe at every send call (invariants 2 and 12): the app's state at the moment of the call. */
function probe(h: EngineHarness, problem: (what: string) => void, channel: "email" | "sms", priority: (call: HandoverLogEntry) => Promise<void>) {
  return async (call: HandoverLogEntry): Promise<void> => {
    await priority(call);
    const s = await h.store.engine.subject(call.subjectId, h.clock);
    if (!s) return;
    if (s.subject.ended !== null) problem(`2: ${channel} ${call.subjectId}/${call.stepId} was called while the lead was ${s.subject.ended}`);
    if (!s.tracks.some((t) => t.nextStepId === call.stepId && t.finishedAt === null)) problem(`2: ${channel} ${call.subjectId}/${call.stepId} was called but is not its track's pending step`);
    if (s.results.some((r) => r.stepId === call.stepId)) problem(`2: ${channel} ${call.subjectId}/${call.stepId} was called after it had a result`);
  };
}
