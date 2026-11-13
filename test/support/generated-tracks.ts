import type { CampaignDefinition, StepDefinition, TrackChannel, TrackDefinition } from "../../src/domain/sequence/definition.ts";
import type { SubjectState } from "../../src/domain/sequence/state.ts";
import type { Rules } from "../../src/server/engine/rules.ts";
import type { ActivityView, CompanyRecord, EnrollmentProgress, LeadSearchResult, NeedsAttention, OutreachStatus, PersonRecord } from "../../src/shared/api.ts";
import { trackLabel } from "../../src/shared/track-label.ts";
import { EngineHarness, quickWait } from "./engine-harness.ts";
import { business, person, type ExportRows } from "./export-builder.ts";
import type { FakeAccount, FakeMode, HandoverLogEntry } from "./fake-email-port.ts";
import type { FakeNumber, FakeSmsMode } from "./fake-sms-port.ts";
import { random } from "./generated-sequences.ts";
import { dueAfter, higherPriority, inWindow, local, renderCopy, zoneOf, type Hours } from "./sequence-model.ts";

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
 * Checked after every event: invariants 1-4, 6-8, 10, 11, 13, 14, 19 and 20 of ADR 0003 section 8,
 * and 18 after the drain.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
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
  readonly definition: CampaignDefinition;
  readonly companies: number[];
  launchedAt: number | null;
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

  const h = new EngineHarness({
    start,
    accounts: inboxes,
    modes: emailModes,
    random: random(seed ^ 0x5eed),
    engine: { waitFor: quickWait },
    sms: { numbers, modes: smsModes },
    ...(options.rules ? { rules: options.rules } : {}),
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
    campaigns.push({ id: "", definition, companies: ci === 0 ? [0, 1, 2] : ci === 1 ? [0, 1] : [1, 2], launchedAt: null });
  }
  for (const c of campaigns) {
    if (c.definition.tracks.some((t) => t.start.kind === "after")) features.add("after");
    if (c.definition.tracks.filter((t) => t.start.kind === "entry").length > 1) features.add("together");
    if (new Set(c.definition.tracks.map((t) => t.channel)).size > 1) features.add("both-channels");
  }
  if (campaigns.length > 1) features.add("several-campaigns");

  const rowsFor = (c: Campaign): ExportRows => ({
    businesses: c.companies.map((i) => {
      const co = companies[i]!;
      return business({ business_id: co.key, business_name: co.name, timezone: co.zone, phone_e164: co.line, general_emails: co.inbox ?? "" });
    }),
    people: people
      .filter((p) => c.companies.includes(p.company))
      .map((p) =>
        person({ person_id: p.key, business_id: companies[p.company]!.key, full_name: p.name, timezone: p.zone, email: p.email ?? "", ...(p.mobile ? { dial_phone: p.mobile, dial_phone_type: "mobile" } : {}) }),
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
  h.hooks = {
    beforeHandover: async (attemptId) => injectAround((await h.store.engine.attempt(attemptId))?.subjectId ?? null),
    afterClaim: (attemptId) => checkClaimPriority(attemptId),
  };

  for (const [ci, c] of campaigns.entries()) {
    const created = await h.createCampaign(`Campaign ${ci + 1}`, rowsFor(c), c.definition.timezone);
    c.id = created.campaign.id;
    await h.defineSequence(c.id, c.definition);
  }
  await discover();
  email.onHandover = probe(h, problem, "email", checkHandoverPriority);
  const smsProbe = probe(h, problem, "sms", checkHandoverPriority);
  sms.onHandover = async (call) => {
    await smsProbe(call);
    // An email reply from the same lead while its text is with the provider: it must stop the SMS track too.
    if (hookBudget <= 0 || !chance(0.3)) return;
    const address = email.deliveryLog.filter((d) => d.subjectId === call.subjectId).at(-1)?.destination;
    if (address && replyOnKnownThread(address)) {
      hookBudget--;
      features.add("email-reply-during-a-text");
    }
  };
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
  /** The conversation owner by the SMS provider's call log: the subject the number first texted that mobile for. */
  function ownerOf(sender: string, mobile: string) {
    return sms.handoverLog.find((c) => c.sender === sender && c.destination === mobile)?.subjectId ?? null;
  }
  /**
   * The replies that reached a subject, in the order the app observed them (the providers' reply
   * logs, in order): an SMS on a conversation it owned when the text was observed, or an email on its
   * thread, which the generator only answers once the app knows it. `seenAt`: when the app observed
   * it; `at`: its own time as the provider reported it.
   */
  function repliesOf(id: string): { channel: "email" | "sms"; seenAt: number; at: number }[] {
    return [
      ...sms.replyLog.filter((r) => ownerOf(r.to, r.from) === id && (sms.handoverLog.find((c) => c.sender === r.to && c.destination === r.from)?.at ?? Infinity) <= r.at).map((r) => ({ channel: "sms" as const, seenAt: r.at, at: Math.min(r.providerAt, r.at), order: sms.replyLog.indexOf(r) })),
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
    return Math.min(d.visibleAt, looked);
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
    return Math.min(stoppedAt(s.id), Math.max(...channels.map((c) => badAtOf(s, c))));
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
    if (bad <= start) return { at: start, seen: start };
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
  const finishedSnapshots = new Map<string, string>();
  const eventCount = options.events ?? 18;
  for (let e = 0; e < eventCount; e++) {
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
    for (const n of numbers) {
      n.healthy = true;
      n.listed = true;
    }
    await h.advanceTo(h.clock + 21 * DAY);
    for (let week = 0; week < 6; week++) {
      let waiting = false;
      for (const id of await h.store.engine.runningSubjectIds()) {
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
    const attention = (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body;
    if (attention.heldTracks.some((x) => x.reason === "sms_conversation_taken")) features.add("conversation-taken");

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
      if (s.subject.ended === "finished_no_usable_channel" && channels.some((c) => reachesAt(rec, c, s.subject.endedWall ?? now))) {
        problem(`20: ${id} ended with no usable channel at ${new Date(s.subject.endedWall ?? 0).toISOString()}, though the record has a good ${channels.filter((c) => reachesAt(rec, c, s.subject.endedWall ?? now)).join(" and ")} detail`);
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
        if (p.finishedAt === null) continue;
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

      // 14. A held conversation is held only when every number the track may use has texted that mobile for someone else.
      for (const t of progress.tracks) {
        if (t.hold !== "sms_conversation_taken") continue;
        const mobile = mobileOf(rec);
        const usable = s.subject.smsSender !== null ? [s.subject.smsSender] : (def.smsPool ?? []);
        const free = usable.filter((n) => mobile !== null && ownerOf(n, mobile) !== null && ownerOf(n, mobile) !== id ? false : true);
        if (free.length > 0) problem(`14: ${id}/${t.trackId} is held as taken, but ${free.join(", ")} never texted ${mobile ?? "its mobile"} for anyone else`);
      }

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
        .map((e) => (e.kind === "replied" ? `replied|${e.channel}` : e.kind === "ended" ? "ended" : `${e.kind}|${e.channel}|${e.track.label}|${"stepNumber" in e && e.stepNumber !== null ? e.stepNumber : "-"}`))
        .sort();

      const expected: string[] = [];
      const runStart = runStartOf(rec);
      const channels = [...new Set(def.tracks.map((t) => t.channel))];
      const atLaunch = runStart <= now && !channels.some((c) => reachesAt(rec, c, runStart - 1));
      const ownCall = (t: TrackDefinition) => callsOf(t.channel).filter((c) => c.subjectId === rec.id && t.steps.some((st) => st.id === c.stepId));
      const completed = (t: TrackDefinition) => {
        const sends = t.steps.map((st) => deliveryOf(t.channel, rec.id, st.id));
        const last = sends.at(-1);
        return last !== undefined && sends.every((d) => d !== undefined) && knownAt(t.channel, last) < badAtOf(rec, t.channel);
      };
      // The lead ends first when its last channel goes bad (2.1), so a start at that very instant is
      // not stored, unless the track's own call to the provider is what found it bad, or the lead's
      // reply came in that same instant after the call: the provider's log of calls (independent of the
      // engine's store) shows the track started then (search on 7401eb2, seeds 20261142 and 20261191).
      const called = (t: TrackDefinition) => ownCall(t).length > 0;
      const started = (t: TrackDefinition) => {
        const start = startOf(rec, t);
        return start !== null && start <= now && (start < endLimitOf(rec) || (start === endLimitOf(rec) && called(t))) ? start : null;
      };
      for (const t of def.tracks) {
        if (t.channel === "call") continue;
        const label = trackLabel(def, t).label;
        if (atLaunch) {
          expected.push(`skipped|${t.channel}|${label}|-`);
          continue;
        }
        const start = started(t);
        if (start === null) continue;
        const rule = t.start;
        const before = rule.kind === "after" ? def.tracks.find((x) => x.id === rule.trackId) : undefined;
        if (before) {
          const beforeStart = started(before);
          if (beforeStart !== null && (!reachesAt(rec, before.channel, beforeStart) || !completed(before))) expected.push(`released|${t.channel}|${label}|-`);
        }
        const owned = { failure: false };
        t.steps.forEach((st, i) => {
          const d = deliveryOf(t.channel, rec.id, st.id);
          if (d && knownAt(t.channel, d) <= now) expected.push(`sent|${t.channel}|${label}|${i + 1}`);
          const refused = ownCall(t).some((c) => c.stepId === st.id && sms.refusals.some((r) => r.attemptId === c.attemptId && r.reason === "invalid_destination"));
          if (t.channel === "sms" && refused) {
            expected.push(`failed|sms|${label}|${i + 1}`);
            owned.failure = true;
          }
          const bad = t.channel === "sms" ? sms.invalidAfterSend : email.bouncing;
          if (d && bad.has(d.destination)) {
            expected.push(`bounced|${t.channel}|${label}|${i + 1}`);
            owned.failure = true;
          }
        });
        // Skipped when its detail was missing or already bad at its start, unless its own first call
        // found it bad at that very instant (then it failed); ended on a bad detail with no failure or
        // bounce of its own: marked bad elsewhere.
        const own = owned.failure;
        // A track that starts at the very instant another track's call finds the detail bad: the
        // record does not model the order within that pass, so it is stored skipped (started after the
        // detail went bad) or failed (started first, then found bad), and both are what the engine may
        // store (check 20). Activity must say whichever it is (search on 7401eb2, seed 20261142).
        if (!own && badAtOf(rec, t.channel) === start && !called(t)) {
          const either = [`skipped|${t.channel}|${label}|-`, `address_bad|${t.channel}|${label}|-`];
          expected.push(either.find((x) => shown.includes(x)) ?? either[0]!);
          continue;
        }
        const skipped = !own && !reachesAt(rec, t.channel, start);
        if (skipped) expected.push(`skipped|${t.channel}|${label}|-`);
        if (!skipped && !own && !completed(t) && badAtOf(rec, t.channel) < Math.min(now + 1, endLimitOf(rec))) expected.push(`address_bad|${t.channel}|${label}|-`);
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
      const accounts = channel === "email" ? inboxes : numbers;
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
    // 14. One owner per conversation: every text from a number to a mobile is for one subject.
    const pairs = new Map<string, Set<string>>();
    for (const c of sms.handoverLog) pairs.set(`${c.sender}>${c.destination}`, (pairs.get(`${c.sender}>${c.destination}`) ?? new Set()).add(c.subjectId));
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
          const own = t.channel === "email" ? addressOf(rec) : mobileOf(rec);
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
    const n = numbers.find((x) => x.id === accountId);
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
    if (p.dueAt > (st.subject.clock.frozenSince ?? now) - st.subject.clock.frozenTotal) return false;
    if (!inWindow(t.window, zoneFor(rec), now)) return false;
    if (!accountUp(accountId)) return false;
    const fixed = t.channel === "sms" ? st.subject.smsSender : st.subject.emailSender;
    if (fixed !== null ? fixed !== accountId : !(t.channel === "sms" ? (def.smsPool ?? []) : def.emailPool).includes(accountId)) return false;
    if (badAtOf(rec, t.channel) <= now) return false;
    if (t.channel === "sms") {
      const owner = ownerOf(accountId, mobileOf(rec) ?? "");
      if (owner !== null && owner !== rec.id) return false;
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
