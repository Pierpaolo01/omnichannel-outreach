import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../src/domain/sequence/definition.ts";
import type { CallTask, SubjectState } from "../../src/domain/sequence/state.ts";
import type { Rules } from "../../src/server/engine/rules.ts";
import type { CallOutcomeApi, CallsView, CallTaskView, EnrollmentProgress, LeadSearchResult, OutreachStatus, PersonRecord, CompanyRecord } from "../../src/shared/api.ts";
import { EngineHarness, quickWait } from "./engine-harness.ts";
import { business, person, type ExportRows } from "./export-builder.ts";
import type { FakeAccount, HandoverLogEntry } from "./fake-email-port.ts";
import type { FakeNumber } from "./fake-sms-port.ts";
import { random } from "./generated-sequences.ts";
import { dueAfter, firstOpen, higherPriority, inWindow, local, startOfDay, zoneOf, type Hours } from "./sequence-model.ts";

/**
 * Generated sequences with phone tracks (ADR 0003 9.2; the ticket 14 row of 9.3), run through the
 * real HTTP app and SQLite store, against the fake email and SMS providers, on a clock the test
 * advances. There is no telephony provider: the generated user works the call list over HTTP and
 * logs outcomes, as the user does after dialling on their own phone.
 *
 * Generated: one or two campaigns sharing people, each a tree of one to four email, SMS and phone
 * tracks connected together or after another track (delay 0-2 days), with calling hours on business
 * days, every day, or evenings; people with and without email, a mobile or a direct line, at companies
 * with and without a main line, and a company lead; a user zone and a small daily call capacity, so
 * calls wait for room; outcomes chosen from the list (no answer, voicemail, gatekeeper, wrong number
 * on any kind of number, a mobile's ending its SMS track, interested, skip for now), outcomes attempted
 * on tasks that are not listed (closed, of an ended lead, outside the prospect's calling day) and on
 * numbers already marked bad, interested on one phone track while another of the lead's tasks is open,
 * the same action posted twice at once, posted again, and posted again after a restart, notes on the
 * person or the company, and email and SMS replies. Each run ends with a drain in which the user works
 * every call on the list.
 *
 * The record imports nothing from src/domain/sequence/. From the definitions, the people, the user's
 * own logged outcomes and the providers' logs it predicts: each track's start and finish, which
 * outcome the app must accept, where each listed task sits (ready now, later today), the numbers a
 * task offers, when the lead stops, and its status. Placement is checked against its own capacity
 * count, priority classes and calling days.
 *
 * Checked after every event: invariants 1, 2, 4, 6, 7, 8, 13, 16 (the ticket 14 part, with one call
 * record per action and every note where the user put it), 17, 19 and 20 of ADR 0003 section 8,
 * priority at placement (12, for calls), and 18 after the drain.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ZONES = ["Europe/London", "America/New_York", "Europe/Paris", "Asia/Kolkata", ""];
const ALL_DAY: Hours[] = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const OUTCOMES: readonly CallOutcomeApi[] = ["no_answer", "voicemail", "gatekeeper", "wrong_number", "interested", "skip_for_now"];

export interface CallRunOptions {
  readonly rules?: Partial<Rules>;
  readonly events?: number;
  readonly drain?: boolean;
  readonly maxWrites?: number;
  readonly deadline?: number;
}

export interface CallRunResult {
  readonly problems: string[];
  readonly stats: { calls: number; tasks: number; subjects: number; ticks: number; writes: number; features: readonly string[] };
}

interface WorldPerson {
  readonly key: string;
  readonly company: number;
  readonly name: string;
  readonly email: string | null;
  readonly mobile: string | null;
  readonly direct: string | null;
  readonly zone: string;
}

interface WorldCompany {
  readonly key: string;
  readonly name: string;
  readonly zone: string;
  readonly inbox: string | null;
  readonly line: string | null;
}

interface Subject {
  readonly id: string;
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

/** One outcome the generated user logged, and whether the record says the app had to accept it. */
interface LoggedOutcome {
  readonly at: number;
  readonly taskId: string;
  readonly subjectId: string;
  readonly trackId: string;
  readonly outcome: CallOutcomeApi;
  readonly numberKey: string | null;
  readonly accepted: boolean;
  readonly note: string;
  readonly noteScope: "person" | "company";
}

/** The invariants a problem names: the numbers before its first colon. */
export function callInvariantsOf(problem: string): string[] {
  return (problem.split(":")[0] ?? "").split("/").map((x) => x.trim());
}

const digits = (s: string) => s.replace(/\D/g, "");

export async function runCalls(seed: number, options: CallRunOptions = {}): Promise<CallRunResult> {
  try {
    return await runCallsUnguarded(seed, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The store's construction guards: a closed task never reopens, one task per call step.
    const id = /call task|one_task_per_call_step/.test(message) ? "16" : "throw";
    return { problems: [`${id}: the engine threw: ${message}`], stats: { calls: 0, tasks: 0, subjects: 0, ticks: 0, writes: 0, features: [] } };
  }
}

async function runCallsUnguarded(seed: number, options: CallRunOptions): Promise<CallRunResult> {
  const rand = random(seed);
  const pick = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(rand() * items.length)];
    if (item === undefined) throw new Error("empty pick");
    return item;
  };
  const chance = (p: number) => rand() < p;
  const problems: string[] = [];
  const problem = (what: string) => {
    if (problems.length < 25 && !problems.includes(what)) problems.push(what);
  };
  const features = new Set<string>();

  const start = Date.parse("2026-10-19T00:00:00Z") + Math.floor(rand() * 11 * DAY) + Math.floor(rand() * 24) * HOUR;
  const userZone = pick(["Europe/London", "America/New_York"]);
  const capacity = pick([1, 2, 3, 5]);
  features.add(`capacity:${capacity}`);

  const inboxes: FakeAccount[] = [{ id: "inbox-a", capacity: 40, gapMs: 2 * MINUTE, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }];
  const campaignCount = 1 + Math.floor(rand() * 2);
  // One SMS number per campaign, so no conversation is ever another campaign's (ticket 13 checks that).
  const numbers: FakeNumber[] = Array.from({ length: campaignCount }, (_, i) => ({ id: `+4477009000${i + 1}0`, capacity: 40, gapMs: 2 * MINUTE, k: 2, healthy: true, resetZone: "Europe/London" }));

  const companies: WorldCompany[] = [
    { key: "c1", name: "Harbour Lane Physio", zone: "Europe/London", inbox: null, line: "+442079460101" },
    { key: "c2", name: "Northgate Dental", zone: pick(ZONES), inbox: null, line: chance(0.6) ? "+442079460202" : null },
    // No decision maker: a company lead, on its shared inbox and main line.
    { key: "c3", name: "Elm Street Clinic", zone: pick(ZONES), inbox: chance(0.6) ? "hello@elm.example" : null, line: "+442079460303" },
  ];
  const firstNames = ["Pat", "Sam", "Nia", "Omar", "Grace"];
  const people: WorldPerson[] = firstNames.map((first, i) => {
    const all = i === 0;
    const company = i < 3 ? 0 : 1;
    return {
      key: `p${i + 1}`,
      company,
      name: `${first} ${["Oneil", "Lee", "Cole", "Reed", "Okafor"][i] ?? "Doe"}`,
      email: all || chance(0.6) ? `${first.toLowerCase()}@${company === 0 ? "harbour" : "northgate"}.example` : null,
      mobile: all || chance(0.4) ? `+4477009001${String(i).padStart(2, "0")}` : null,
      direct: all || chance(0.5) ? `+4420794604${String(i).padStart(2, "0")}` : null,
      zone: pick(ZONES),
    };
  });

  const h = new EngineHarness({ start, accounts: inboxes, modes: ["honest"], random: random(seed ^ 0xca11), engine: { waitFor: quickWait }, sms: { numbers, modes: ["honest"] }, ...(options.rules ? { rules: options.rules } : {}) });
  h.maxWrites = options.maxWrites ?? null;
  h.stopAt = options.deadline ?? null;
  const email = h.fake;
  const sms = h.sms;

  const callingHours = (): Hours[] => {
    const kind = rand();
    if (kind < 0.45) return [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
    if (kind < 0.7) return [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 8, end: 20 }));
    if (kind < 0.85) return [1, 2, 3, 4, 5].map((day) => ({ day, start: 17, end: 21 }));
    return ALL_DAY;
  };
  const sendingWindow = (): Hours[] => (chance(0.6) ? ALL_DAY : [1, 2, 3, 4, 5].map((day) => ({ day, start: 8, end: 18 })));
  const stepsOf = (channel: "email" | "sms" | "call", prefix: string): StepDefinition[] =>
    channel === "call"
      ? [{ id: `${prefix}c`, waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false }]
      : Array.from({ length: 1 + Math.floor(rand() * 2) }, (_, i) => ({
          id: `${prefix}s${i + 1}`,
          waitDays: i === 0 ? 0 : pick([1, 2]),
          subject: channel === "email" ? "Hello {{first_name|there}}" : "",
          body: channel === "email" ? "A note for {{company}}." : "A quick text, {{first_name|there}}.",
          threading: "new_subject",
          removed: false,
        }));
  const campaigns: Campaign[] = [];
  for (let ci = 0; ci < campaignCount; ci++) {
    const tracks: TrackDefinition[] = [];
    const n = 1 + Math.floor(rand() * 4);
    for (let ti = 0; ti < n; ti++) {
      const channel = ti === 0 ? "call" : pick(["email", "sms", "call", "call"] as const);
      const earlier = tracks[Math.floor(rand() * tracks.length)];
      const startRule: TrackDefinition["start"] = !earlier ? { kind: "entry" } : chance(0.35) ? earlier.start : { kind: "after", trackId: earlier.id, delayDays: pick([0, 0, 1, 2]) };
      const id = `c${ci}t${ti + 1}`;
      tracks.push({ id, channel, branch: "main", window: channel === "call" ? callingHours() : sendingWindow(), steps: stepsOf(channel, id), start: startRule, removed: false });
    }
    const definition: CampaignDefinition = { timezone: pick(["Europe/London", "America/New_York"]), callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: [numbers[ci]!.id], callScript: "Ask who handles bookings.", tracks };
    campaigns.push({ id: "", definition, companies: ci === 0 ? [0, 1, 2] : [0, 1], launchedAt: null });
  }
  for (const c of campaigns) {
    if (c.definition.tracks.filter((t) => t.channel === "call").length > 1) features.add("two-phone-tracks");
    if (c.definition.tracks.some((t) => t.start.kind === "after" && c.definition.tracks.find((x) => x.id === (t.start.kind === "after" ? t.start.trackId : ""))?.channel === "call")) features.add("after-a-call");
    if (c.definition.tracks.some((t) => t.channel !== "call" && t.start.kind === "entry")) features.add("parallel-with-a-call");
  }

  const rowsFor = (c: Campaign): ExportRows => ({
    businesses: c.companies.map((i) => {
      const co = companies[i]!;
      return business({ business_id: co.key, business_name: co.name, timezone: co.zone, phone_e164: co.line ?? "", general_emails: co.inbox ?? "" });
    }),
    people: people
      .filter((p) => c.companies.includes(p.company))
      .map((p) =>
        person({ person_id: p.key, business_id: companies[p.company]!.key, full_name: p.name, timezone: p.zone, email: p.email ?? "", direct_phone: p.direct ?? "", ...(p.mobile ? { dial_phone: p.mobile, dial_phone_type: "mobile" } : {}) }),
      ),
  });

  const settings = await h.request("PUT", "/api/call-settings", { dailyCapacity: capacity, userZone });
  if (settings.status !== 200) problem(`settings refused: ${JSON.stringify(settings.body)}`);

  const subjects = new Map<string, Subject>();
  for (const [ci, c] of campaigns.entries()) {
    const created = await h.createCampaign(`Campaign ${ci + 1}`, rowsFor(c), c.definition.timezone);
    c.id = created.campaign.id;
    await h.defineSequence(c.id, c.definition);
  }
  for (const [ci, c] of campaigns.entries()) {
    for (const row of (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}&limit=500`)).body.rows) {
      const e = row.enrollments.find((x) => x.campaign.id === c.id);
      if (!e) continue;
      const p = row.kind === "person" ? (people.find((x) => x.name === row.name) ?? null) : null;
      const company = p ? companies[p.company]! : companies.find((x) => x.name === row.name)!;
      subjects.set(e.id, { id: e.id, campaign: ci, person: p, company, enrolledAt: h.clock });
    }
  }
  // Every send call is checked against the app's state at that moment (invariant 2).
  const probe = (channel: string) => async (call: HandoverLogEntry) => {
    const s = await h.store.engine.subject(call.subjectId, h.clock);
    if (s && s.subject.ended !== null) problem(`2: ${channel} ${call.subjectId}/${call.stepId} was called while the lead was ${s.subject.ended}`);
  };
  email.onHandover = probe("email");
  sms.onHandover = probe("sms");

  await h.tick();
  for (const [ci, c] of campaigns.entries()) {
    if (ci > 0) await h.advanceTo(h.clock + Math.floor(rand() * 3) * HOUR);
    const launched = await h.launch(c.id);
    if (launched.status !== 200) {
      problem(`launch refused: ${JSON.stringify(launched.body)}`);
      return result();
    }
    c.launchedAt = h.clock;
  }

  // ------------------------------------------------------------------------------------------
  // The record, from the definitions, the people, the user's own outcomes and the providers' logs.

  const logged: LoggedOutcome[] = [];
  let actions = 0;
  const skips = new Map<string, number>();
  const checkedNotes = new Set<string>();
  /** Tasks seen on the list or in a view: the generated user's own knowledge of task ids. */
  const knownTasks = new Map<string, { subjectId: string; trackId: string }>();

  const def = (s: Subject) => campaigns[s.campaign]!.definition;
  const zoneFor = (s: Subject) => zoneOf(s.person?.zone ?? "", s.company.zone, def(s).timezone);
  const runStartOf = (s: Subject) => Math.max(s.enrolledAt, campaigns[s.campaign]!.launchedAt ?? Infinity);
  const addressOf = (s: Subject) => s.person?.email ?? (s.person ? null : s.company.inbox);
  const mobileOf = (s: Subject) => s.person?.mobile ?? null;
  /** The numbers the user may dial for the lead: own direct and mobile, then the company main line. */
  function phonesOf(s: Subject): { key: string; kind: "direct" | "mobile" | "main_line" }[] {
    const own = s.person ? [...(s.person.direct ? [{ key: s.person.direct, kind: "direct" as const }] : []), ...(s.person.mobile ? [{ key: s.person.mobile, kind: "mobile" as const }] : [])] : [];
    return [...own, ...(s.company.line ? [{ key: s.company.line, kind: "main_line" as const }] : [])];
  }
  /** When a number became bad: the first accepted wrong-number outcome on it, by anyone. */
  function badAt(key: string): number {
    return logged.find((o) => o.accepted && o.outcome === "wrong_number" && o.numberKey === key)?.at ?? Infinity;
  }
  const goodPhoneAt = (s: Subject, t: number) => phonesOf(s).some((p) => badAt(p.key) > t);
  /** The instant no number of the lead is good any more (-Infinity when it never had one). */
  const allPhonesBadAt = (s: Subject) => (phonesOf(s).length === 0 ? -Infinity : Math.max(...phonesOf(s).map((p) => badAt(p.key))));
  function reachesAt(s: Subject, channel: TrackDefinition["channel"], t: number): boolean {
    if (channel === "email") return addressOf(s) !== null;
    // A mobile marked bad on a call (a wrong number) is bad for texts too.
    if (channel === "sms") return mobileOf(s) !== null && badAt(mobileOf(s) ?? "") > t;
    return goodPhoneAt(s, t);
  }
  function knownAt(channel: "email" | "sms", d: { key: string; at: number; visibleAt: number }): number {
    const looked = (channel === "sms" ? sms.lookupLog : email.lookupLog).find((l) => l.key === d.key && l.answer === "sent" && l.at >= d.at)?.at ?? Infinity;
    return Math.min(d.visibleAt, looked);
  }
  const deliveries = (channel: "email" | "sms") => (channel === "sms" ? sms.deliveryLog : email.deliveryLog);
  const deliveryOf = (channel: "email" | "sms", subjectId: string, stepId: string) => deliveries(channel).find((d) => d.subjectId === subjectId && d.stepId === stepId);
  const firstCall = (channel: "email" | "sms", subjectId: string, stepId: string) => (channel === "sms" ? sms.handoverLog : email.handoverLog).find((c) => c.subjectId === subjectId && c.stepId === stepId);
  const interestedAt = (s: Subject) => logged.find((o) => o.accepted && o.subjectId === s.id && o.outcome === "interested")?.at ?? Infinity;
  /** The first reply the app observed: an email on its thread, or a text to the campaign's number from the lead's mobile after it texted them. */
  function replySeenAt(s: Subject): number {
    const mail = email.replyLog.filter((r) => r.subjectId === s.id).map((r) => r.at);
    const number = numbers[s.campaign]!.id;
    const firstText = sms.deliveryLog.find((d) => d.subjectId === s.id)?.at ?? Infinity;
    const texts = sms.replyLog.filter((r) => r.to === number && r.from === mobileOf(s) && r.at >= firstText).map((r) => r.at);
    return Math.min(Infinity, ...mail, ...texts);
  }
  /** The instant no channel of the campaign reaches the lead (2.1). */
  function noChannelAt(s: Subject): number {
    const channels = [...new Set(def(s).tracks.map((t) => t.channel))];
    const lostAt = (c: TrackDefinition["channel"]) => (c === "email" ? (addressOf(s) ? Infinity : -Infinity) : c === "sms" ? (mobileOf(s) ? badAt(mobileOf(s) ?? "") : -Infinity) : allPhonesBadAt(s));
    return Math.max(runStartOf(s), ...channels.map(lostAt));
  }
  /** When the lead stops running by the record: interested, its first reply, or no usable channel. */
  const endLimitOf = (s: Subject) => Math.min(interestedAt(s), replySeenAt(s), noChannelAt(s));

  function startOf(s: Subject, t: TrackDefinition): number | null {
    const runStart = runStartOf(s);
    if (!Number.isFinite(runStart)) return null;
    if (t.start.kind === "entry") return runStart;
    const rule = t.start;
    const before = def(s).tracks.find((x) => x.id === rule.trackId);
    const f = before ? finishFacts(s, before) : null;
    return f === null ? null : dueAfter(f.at, rule.delayDays, zoneFor(s));
  }
  function startSeenAt(s: Subject, t: TrackDefinition): number | null {
    const at = startOf(s, t);
    if (at === null || t.start.kind === "entry") return at;
    const rule = t.start;
    const before = def(s).tracks.find((x) => x.id === rule.trackId);
    const seen = before ? finishFacts(s, before)?.seen ?? null : null;
    return seen === null ? null : Math.max(at, seen);
  }
  /** The accepted outcome (not skip for now) that finished this phone track's call, if any. */
  const callDone = (s: Subject, t: TrackDefinition) => logged.find((o) => o.accepted && o.subjectId === s.id && o.trackId === t.id && o.outcome !== "skip_for_now");

  /**
   * A track's finish by the record, and when the app can know it. Email and SMS: skipped at the start
   * when there is no address or mobile, completed at the last send. A phone track: skipped at its start
   * with no good number; completed by the user's outcome on its call; skipped when its last good number
   * went bad (another call's wrong number) while it was open. A lead's stop first leaves it unfinished.
   */
  function finishFacts(s: Subject, t: TrackDefinition): { at: number; seen: number; reason: string } | null {
    const at = startOf(s, t);
    const end = endLimitOf(s);
    if (at === null || at >= end) return null;
    if (!reachesAt(s, t.channel, at)) return { at, seen: at, reason: "skipped_missing_channel" };
    if (t.channel === "call") {
      const done = callDone(s, t);
      const lost = allPhonesBadAt(s);
      if (done && done.at <= lost) return { at: done.at, seen: done.at, reason: "completed" };
      if (Number.isFinite(lost) && lost > at && lost < end) return { at: lost, seen: lost, reason: "skipped_missing_channel" };
      return null;
    }
    const sends = t.steps.map((st) => deliveryOf(t.channel as "email" | "sms", s.id, st.id));
    const last = sends.at(-1);
    // A mobile marked bad on a call while its SMS track is open fails the track then (the same rule as an invalid number).
    const bad = t.channel === "sms" ? badAt(mobileOf(s) ?? "") : Infinity;
    if (last && sends.every((d) => d !== undefined) && knownAt(t.channel, last) < bad) {
      const done = Math.max(last.at, firstCall(t.channel, s.id, t.steps.at(-1)!.id)?.at ?? 0);
      const seen = Math.max(done, knownAt(t.channel, last));
      // A send the app learned of at the instant the lead stopped was observed first: observation precedes every action in a tick.
      return seen <= end ? { at: done, seen, reason: "completed" } : null;
    }
    return Number.isFinite(bad) && bad <= end ? { at: bad, seen: bad, reason: "failed_bad_destination" } : null;
  }

  /** The user day of instant `t`, as wall instants. */
  function userDay(t: number): { start: number; end: number } {
    const day = local(t, userZone).day;
    return { start: startOfDay(day, userZone), end: startOfDay(day + 1, userZone) };
  }
  const windowOf = (s: Subject, trackId: string) => def(s).tracks.find((x) => x.id === trackId)?.window ?? [];
  /** Whether the prospect's calling hours open at some point of the user day of `t`. */
  function hoursOnUserDay(s: Subject, trackId: string, t: number): boolean {
    const { start: from, end } = userDay(t);
    return firstOpen(windowOf(s, trackId), zoneFor(s), from) < end;
  }
  /** Open now or later on the user day of `t`. */
  const hoursLeftToday = (s: Subject, trackId: string, t: number) => firstOpen(windowOf(s, trackId), zoneFor(s), t) < userDay(t).end;
  /** Running at `t`: launched, not stopped, and with work left before `t` (a call logged at `t` may finish it at `t`). */
  const runningAt = (s: Subject, t: number) => runStartOf(s) <= t && t < endLimitOf(s) && !sequenceDoneAt(s, t, true);
  /** Every track of the campaign finished, by the record, and known to the app by `t` (strictly before, with `strict`). */
  function sequenceDoneAt(s: Subject, t: number, strict = false): boolean {
    return def(s).tracks.every((tr) => {
      const f = finishFacts(s, tr);
      return f !== null && (strict ? f.seen < t : f.seen <= t);
    });
  }
  /** When every track had finished and the app knew it, or Infinity. */
  function sequenceDoneInstant(s: Subject): number {
    const seen = def(s).tracks.map((tr) => finishFacts(s, tr)?.seen ?? Infinity);
    return Math.max(...seen);
  }
  /** Whether the record lists the task (2.3): open, its lead running, and the prospect's calling hours open at some point today. */
  function listedByRecord(taskId: string, t: number): boolean {
    const k = knownTasks.get(taskId);
    const s = k ? subjects.get(k.subjectId) : undefined;
    const tr = s ? def(s).tracks.find((x) => x.id === k?.trackId) : undefined;
    if (!k || !s || !tr) return false;
    const f = finishFacts(s, tr);
    if (f !== null && f.at <= t) return false;
    return runningAt(s, t) && hoursOnUserDay(s, tr.id, t);
  }
  function touchedAt(s: Subject, t: number, strict: boolean): boolean {
    const before = (x: number) => (strict ? x < t : x <= t);
    const sent = (["email", "sms"] as const).some((ch) => deliveries(ch).some((d) => d.subjectId === s.id && before(knownAt(ch, d))));
    return sent || logged.some((o) => o.accepted && o.subjectId === s.id && o.outcome !== "skip_for_now" && before(o.at));
  }

  // ------------------------------------------------------------------------------------------
  // The generated user.

  async function queue(): Promise<CallsView> {
    const q = (await h.request<CallsView>("GET", "/api/calls")).body;
    for (const item of [...q.readyNow, ...q.laterToday]) knownTasks.set(item.taskId, { subjectId: item.enrollmentId, trackId: item.track.id });
    return q;
  }

  /** Logs one outcome on a task, as the user would after a call, and checks the app accepted exactly what the record says it must. */
  async function logOutcome(taskId: string, outcome: CallOutcomeApi, chooseNumber: (view: CallTaskView) => string | null): Promise<void> {
    const view = (await h.request<CallTaskView>("GET", `/api/call-tasks/${taskId}`)).body;
    knownTasks.set(taskId, { subjectId: view.enrollmentId, trackId: view.track.id });
    const s = subjects.get(view.enrollmentId);
    if (!s) return;
    const numberId = outcome === "skip_for_now" ? null : chooseNumber(view);
    const number = view.numbers.find((n) => n.detailId === numberId);
    const key = number ? (phonesOf(s).find((p) => digits(p.key) === digits(number.value))?.key ?? null) : null;
    const now = h.clock;
    const numberOk = outcome === "skip_for_now" || (key !== null && badAt(key) > now);
    const expected = listedByRecord(taskId, now) && numberOk;
    const note = chance(0.5) ? pick(["Rang out.", "Spoke to reception.", "Call back after lunch.", ""]) : "";
    const noteScope = chance(0.3) ? "company" : "person";
    const body = { requestId: `action-${++actions}`, outcome, numberId, note, noteScope };
    const post = () => h.request<{ error?: { message: string } }>("POST", `/api/call-tasks/${taskId}/outcome`, body);
    // The same action may reach the app twice: posted twice at once (a double click), or posted again after
    // its answer was lost, sometimes across a restart. It is one action: the record logs it once.
    const r = rand();
    const answers = r < 0.1 ? await Promise.all([post(), post()]) : [await post()];
    if (r >= 0.1 && r < 0.3) {
      if (r >= 0.25) {
        await h.restart();
        features.add("replayed-after-restart");
      }
      answers.push(await post());
    }
    if (answers.length > 1) features.add(r < 0.1 ? "posted-twice-at-once" : "replayed");
    const res = answers[0]!;
    const accepted = res.status === 200;
    if (accepted !== expected) problem(`16: ${outcome} on ${view.enrollmentId}/${view.track.id} at ${new Date(now).toISOString()} was ${accepted ? "accepted" : `refused (${res.body.error?.message ?? res.status})`}; the record says it must be ${expected ? "accepted" : "refused"}`);
    if (answers.some((a) => a.status !== res.status)) problem(`16: ${body.requestId} (${outcome}) was answered ${answers.map((a) => a.status).join(" and ")}; one action has one answer`);
    // The record follows its own prediction, so one wrong answer is reported once, not compounded.
    logged.push({ at: now, taskId, subjectId: view.enrollmentId, trackId: view.track.id, outcome, numberKey: key, accepted: expected, note: note.trim(), noteScope });
    if (expected && outcome === "wrong_number" && number?.kind === "mobile") features.add("wrong-mobile");
    if (expected && outcome === "skip_for_now") skips.set(taskId, now);
    if (expected) features.add(`outcome:${outcome}`);
    else features.add("outcome-refused");
  }

  /** Works the focused call with a generated outcome, on a number from the task. */
  async function workFocus(drain: boolean): Promise<boolean> {
    const q = await queue();
    const focus = q.focusTaskId;
    if (!focus) return false;
    // A wrong number on a mobile also marks it bad for texts, so an SMS track on it fails.
    const outcome: CallOutcomeApi = drain ? pick(["no_answer", "voicemail", "gatekeeper"]) : pick(["no_answer", "voicemail", "gatekeeper", "wrong_number", "interested", "skip_for_now", "skip_for_now"]);
    await logOutcome(focus, outcome, (view) => {
      const good = view.numbers.filter((n) => !n.bad);
      const choices = good;
      if (!drain && chance(0.25)) {
        const bad = view.numbers.find((n) => n.bad);
        if (bad) {
          features.add("bad-number-chosen");
          return bad.detailId;
        }
      }
      return choices.length > 0 ? pick(choices).detailId : (good[0]?.detailId ?? null);
    });
    return true;
  }

  async function checkAll(drained: boolean): Promise<void> {
    const now = h.clock;
    const states = new Map<string, SubjectState>();
    for (const id of subjects.keys()) {
      const st = await h.store.engine.subject(id, now);
      if (st) states.set(id, st);
    }
    const q = await queue();
    const allTasks: { s: Subject; task: CallTask }[] = [];
    for (const [id, st] of states) for (const task of st.callTasks) allTasks.push({ s: subjects.get(id)!, task });
    for (const { s, task } of allTasks) knownTasks.set(task.id, { subjectId: s.id, trackId: task.trackId });

    for (const [id, st] of states) {
      const s = subjects.get(id)!;
      const progress = (await h.request<EnrollmentProgress>("GET", `/api/enrollments/${id}`)).body;
      const end = endLimitOf(s);

      // 1 and 20. The status is the record's.
      // Any reply after an ending other than interested makes the lead replied (2.1, ruling 9).
      const doneAt = sequenceDoneInstant(s);
      const firstEnd = Math.min(end, doneAt);
      const expectedEnd: OutreachStatus | null =
        interestedAt(s) <= now && interestedAt(s) < replySeenAt(s) ? "interested_on_call"
        : replySeenAt(s) <= now ? "replied"
        : firstEnd > now ? null
        : noChannelAt(s) === firstEnd ? "finished_no_usable_channel"
        : "sequence_finished_no_response";
      const column = await storedStatus(s, id);
      if (column !== progress.status) problem(`1: ${id} stores ${String(column)} but derives ${progress.status}`);
      if (expectedEnd !== null && progress.status !== expectedEnd && !(expectedEnd === "sequence_finished_no_response" && progress.status === "finished_no_usable_channel")) problem(`20: ${id} is ${progress.status}; the record says ${expectedEnd}`);
      if (expectedEnd === null) {
        const open = st.callTasks.some((t) => t.open);
        const want: OutreachStatus = open ? "waiting_on_call" : touchedAt(s, now, false) ? "active" : "queued";
        if (st.subject.ended !== null) problem(`20: ${id} ended ${st.subject.ended} at ${new Date(st.subject.endedWall ?? 0).toISOString()}; the record has it running`);
        else if (progress.status !== want) problem(`1: ${id} is ${progress.status}; the record says ${want} (${open ? "an open call task" : touchedAt(s, now, false) ? "touched" : "never reached"})`);
      }

      // 7. Starts and finishes are the record's.
      for (const t of def(s).tracks) {
        const p = st.tracks.find((x) => x.trackId === t.id);
        const at = startOf(s, t);
        const seen = startSeenAt(s, t);
        const startWall = p?.startAt != null ? runStartOf(s) + p.startAt : null;
        if (startWall !== null && startWall !== at) {
          const rule = t.start.kind === "after" ? `${t.start.delayDays} day(s) after ${t.start.trackId}` : "entry";
          const before = t.start.kind === "after" ? def(s).tracks.find((x) => x.id === (t.start.kind === "after" ? t.start.trackId : "")) : undefined;
          const bf = before ? finishFacts(s, before) : null;
          problem(`7: ${id}/${t.id} starts at ${new Date(startWall).toISOString()}; the record says ${at === null ? "never" : new Date(at).toISOString()} (${rule}; the record's finish of it: ${bf ? `${bf.reason} at ${new Date(bf.at).toISOString()}` : "none"}; the lead stops at ${Number.isFinite(end) ? new Date(end).toISOString() : "never"})`);
        }
        if (at !== null && seen !== null && seen <= now && at < end && p?.startedAt == null) problem(`7: ${id}/${t.id} was due to start at ${new Date(at).toISOString()} but has not`);
        const f = finishFacts(s, t);
        if (p?.finishedWall != null) {
          const frozen = st.subject.endedWall !== null && p.finishedWall === st.subject.endedWall;
          const closedOnInterest = p.finishReason === "closed_on_interest" && p.finishedWall === interestedAt(s);
          if (!frozen && !closedOnInterest && (f === null || f.at !== p.finishedWall || f.reason !== p.finishReason)) {
            problem(`7: ${id}/${t.id} finished ${p.finishReason ?? ""} at ${new Date(p.finishedWall).toISOString()}; the record says ${f === null ? "it has not finished" : `${f.reason} at ${new Date(f.at).toISOString()}`} (starting ${at === null ? "never" : new Date(at).toISOString()}; numbers ${phonesOf(s).map((x) => `${x.kind} ${x.key} bad ${Number.isFinite(badAt(x.key)) ? new Date(badAt(x.key)).toISOString() : "never"}`).join(", ")})`);
          }
        } else if (f !== null && f.seen <= now && f.at < end) problem(`7: ${id}/${t.id} should have finished ${f.reason} at ${new Date(f.at).toISOString()} but has not`);
      }

      // 16. Call tasks: an open task's track is unfinished; an interested lead has none open; one task per step;
      // a task is never placed before its call is due, on a day its calling hours never open, or for a lead that is not running.
      for (const task of st.callTasks) {
        const p = st.tracks.find((x) => x.trackId === task.trackId);
        const t = def(s).tracks.find((x) => x.id === task.trackId)!;
        if (task.open && p?.finishedAt != null) problem(`16: ${id}/${task.trackId} finished ${p.finishReason ?? ""} but its call task is open`);
        if (task.open && st.subject.ended === "interested_on_call") problem(`16: ${id} was interested but its call task on ${task.trackId} is open`);
        const due = startOf(s, t);
        if (due === null || task.placedWall < due) problem(`16: ${id}/${task.trackId} was placed at ${new Date(task.placedWall).toISOString()} before its call was due (${due === null ? "never" : new Date(due).toISOString()})`);
        if (due !== null && task.dueWall !== due) problem(`8: ${id}/${task.trackId}'s call is due at ${new Date(task.dueWall).toISOString()}; the record says ${new Date(due).toISOString()}`);
        if (!hoursLeftToday(s, task.trackId, task.placedWall)) problem(`17: ${id}/${task.trackId} was placed at ${new Date(task.placedWall).toISOString()}, when its calling hours did not open again that user day`);
        if (!(runStartOf(s) <= task.placedWall && task.placedWall <= end && !sequenceDoneAt(s, task.placedWall, true))) problem(`2: ${id}/${task.trackId} was placed at ${new Date(task.placedWall).toISOString()} while the lead was not running (from ${new Date(runStartOf(s)).toISOString()} to ${Number.isFinite(endLimitOf(s)) ? new Date(endLimitOf(s)).toISOString() : "now"}${sequenceDoneAt(s, task.placedWall) ? ", sequence done" : ""})`);
      }
      if (new Set(st.callTasks.map((t) => t.stepId)).size !== st.callTasks.length) problem(`16: ${id} has two tasks for one call step`);

      // 18, during the run: a due call with room on today's list is placed (nothing waits for no reason).
      for (const t of def(s).tracks) {
        if (t.channel !== "call") continue;
        const seen = startSeenAt(s, t);
        const f = finishFacts(s, t);
        if (seen === null || seen > now || !runningAt(s, now) || (f !== null && f.at <= now) || st.callTasks.some((x) => x.trackId === t.id)) continue;
        if (!hoursLeftToday(s, t.id, now) || !goodPhoneAt(s, now)) continue;
        const day = dayCounts(allTasks, now);
        features.add(day.committed > 0 ? "waits-behind-committed" : "waits-for-room");
        if (day.placed < capacity - day.committed) problem(`17: ${id}/${t.id}'s call has been due since ${new Date(seen).toISOString()} and today's list has room (${day.placed} placed, ${day.committed} committed, capacity ${capacity}), but it is not placed`);
      }

      // 18, during the run: a due email or text goes within an hour of its window opening while the lead runs (a call never holds them).
      for (const t of def(s).tracks) {
        if (t.channel === "call") continue;
        const ch = t.channel;
        const at = startOf(s, t);
        if (at === null) continue;
        for (const [i, step] of t.steps.entries()) {
          const prev = i > 0 ? deliveryOf(ch, id, t.steps[i - 1]!.id) : undefined;
          if (i > 0 && !prev) break;
          const due = prev ? dueAfter(prev.at, step.waitDays, zoneFor(s)) : at;
          if (!reachesAt(s, ch, at)) break;
          const opens = firstOpen(t.window, zoneFor(s), due);
          const deadline = opens + HOUR;
          const seen = i === 0 ? startSeenAt(s, t) : due;
          if (seen === null || seen > opens || deadline > now || !runningAt(s, deadline) || !inWindow(t.window, zoneFor(s), deadline - 1) || !reachesAt(s, ch, deadline)) continue;
          if (!firstCall(ch, id, step.id) || firstCall(ch, id, step.id)!.at > deadline) problem(`18: ${id}/${step.id} was due at ${new Date(due).toISOString()} and its window open from ${new Date(opens).toISOString()}, but it was not handed over within an hour`);
        }
      }

      // 19. No text to a mobile after a call marked it bad.
      for (const c of sms.handoverLog.filter((x) => x.subjectId === id)) if (c.at > badAt(c.destination)) problem(`19: ${id}/${c.stepId} was texted to ${c.destination} at ${new Date(c.at).toISOString()}, after a call marked it bad at ${new Date(badAt(c.destination)).toISOString()}`);

      // 16. One action is one record: the app holds one call record per action the user logged, however often it was posted.
      const actionsLogged = logged.filter((o) => o.accepted && o.subjectId === id).length;
      if (st.callAttempts.length !== actionsLogged || new Set(st.callAttempts.map((a) => a.requestId)).size !== st.callAttempts.length) problem(`16: ${id} holds ${st.callAttempts.length} call records for ${actionsLogged} actions the user logged`);

      // 19 and 2. Calls are logged on the lead's own numbers or its company's main line; nothing is sent after it stops.
      for (const a of st.callAttempts) {
        if (a.numberDetailId === null) continue;
        // A recorded number id follows the merge pointer to the detail it stands for now (ADR 0001).
        const live = st.lead.resolved[a.numberDetailId]?.liveId ?? a.numberDetailId;
        const n = st.lead.phones.find((x) => x.id === live);
        if (!n || !phonesOf(s).some((p) => p.key === n.key)) problem(`19: ${id} logged a call on ${a.numberDetailId}, which is not one of its numbers`);
      }
      for (const ch of ["email", "sms"] as const) {
        for (const c of (ch === "sms" ? sms.handoverLog : email.handoverLog).filter((x) => x.subjectId === id)) if (c.at > end) problem(`2: ${id}/${c.stepId} was handed over at ${new Date(c.at).toISOString()}, after the lead stopped at ${new Date(end).toISOString()}`);
      }
      if (drained) checkDrained(s, st, progress);
    }

    // Notes: each is where the user put it, once. A person's notes are the person-scoped notes of their calls,
    // in every campaign; a company's are the company-scoped ones of its people's calls and every note of its company lead.
    for (const [taskId, k] of knownTasks) {
      const s = subjects.get(k.subjectId);
      if (!s || checkedNotes.has(s.id)) continue;
      checkedNotes.add(s.id);
      const view = (await h.request<CallTaskView>("GET", `/api/call-tasks/${taskId}`)).body;
      const ofSubject = (o: LoggedOutcome) => subjects.get(o.subjectId);
      const notes = logged.filter((o) => o.accepted && o.note !== "");
      const personNotes = s.person ? notes.filter((o) => ofSubject(o)?.person?.key === s.person?.key && o.noteScope === "person").map((o) => o.note) : [];
      const companyNotes = notes.filter((o) => ofSubject(o)?.company.key === s.company.key && (o.noteScope === "company" || ofSubject(o)?.person === null)).map((o) => o.note);
      const same = (a: string[], b: readonly { body: string }[]) => JSON.stringify([...a].sort()) === JSON.stringify(b.map((n) => n.body).sort());
      if (!same(personNotes, view.personNotes)) problem(`16: ${s.id}'s person notes are ${JSON.stringify(view.personNotes.map((n) => n.body))}; the user wrote ${JSON.stringify(personNotes)}`);
      if (!same(companyNotes, view.companyNotes)) problem(`16: ${s.company.name}'s company notes are ${JSON.stringify(view.companyNotes.map((n) => n.body))}; the user wrote ${JSON.stringify(companyNotes)}`);
    }
    checkedNotes.clear();

    // 17. Each user day's new tasks stay within the capacity left after committed tasks.
    const days = new Set(allTasks.map((x) => local(x.task.placedWall, userZone).day));
    for (const d of days) {
      const counts = dayCounts(allTasks, startOfDay(d, userZone));
      if (counts.placed > capacity - counts.committed) problem(`17: ${counts.placed} new calls were placed on ${new Date(d * DAY).toISOString().slice(0, 10)} with ${counts.committed} committed and a capacity of ${capacity}`);
    }

    // 12 for calls. At every placement, no call ready then with a higher priority was left unplaced.
    for (const { s, task } of allTasks) {
      const ours = { touched: touchedAt(s, task.placedWall, true), dueWall: task.dueWall, subjectId: s.id, stepId: task.stepId };
      for (const other of subjects.values()) {
        for (const t of def(other).tracks) {
          if (t.channel !== "call" || (other.id === s.id && t.id === task.trackId)) continue;
          const otherTask = allTasks.find((x) => x.s.id === other.id && x.task.trackId === t.id)?.task;
          if (otherTask && otherTask.placedWall <= task.placedWall) continue;
          const seen = startSeenAt(other, t);
          const f = finishFacts(other, t);
          if (seen === null || seen >= task.placedWall || !runningAt(other, task.placedWall) || (f !== null && f.at <= task.placedWall)) continue;
          if (!hoursLeftToday(other, t.id, task.placedWall) || !goodPhoneAt(other, task.placedWall)) continue;
          const theirs = { touched: touchedAt(other, task.placedWall, false), dueWall: startOf(other, t) ?? Infinity, subjectId: other.id, stepId: t.steps[0]!.id };
          const theirsStrict = { ...theirs, touched: touchedAt(other, task.placedWall, true) };
          if (higherPriority(theirs, { ...ours, touched: touchedAt(s, task.placedWall, false) }) && higherPriority(theirsStrict, ours)) {
            problem(`12: ${s.id}/${task.trackId} was placed at ${new Date(task.placedWall).toISOString()} before ${other.id}/${t.id}, which had priority and was ready`);
          }
        }
      }
    }

    // 13 and 16. The queue is the record's listing: ready now inside the prospect's calling hours, later today when they open later on the user's day.
    for (const { s, task } of allTasks) {
      const listed = task.open && listedByRecord(task.id, now);
      const ready = listed && inWindow(windowOf(s, task.trackId), zoneFor(s), now);
      const later = listed && !ready && hoursLeftToday(s, task.trackId, now);
      const inReady = q.readyNow.some((x) => x.taskId === task.id);
      const inLater = q.laterToday.some((x) => x.taskId === task.id);
      if (inReady && !inWindow(windowOf(s, task.trackId), zoneFor(s), now)) problem(`13: ${s.id}/${task.trackId} is ready now outside the prospect's calling hours (${zoneFor(s)})`);
      if (inReady !== ready || inLater !== later) problem(`16: ${s.id}/${task.trackId} is ${inReady ? "ready now" : inLater ? "later today" : "not on the list"}; the record says ${ready ? "ready now" : later ? "later today" : "not on the list"}`);
    }
    if (q.laterToday.length > 0) features.add("later-today");
    if ([...q.readyNow, ...q.laterToday].some((x) => x.reason === "rolled_over")) features.add("rolled-over");
    // Ready now: oldest due first; calls skipped for now today go last, in the order skipped.
    const today = userDay(now);
    const skippedToday = (id: string) => (skips.get(id) ?? -Infinity) >= today.start;
    const fresh = q.readyNow.filter((x) => !skippedToday(x.taskId));
    const skipped = q.readyNow.filter((x) => skippedToday(x.taskId));
    if (q.readyNow.findIndex((x) => skippedToday(x.taskId)) !== -1 && q.readyNow.slice(q.readyNow.findIndex((x) => skippedToday(x.taskId))).some((x) => !skippedToday(x.taskId))) problem("16: a call skipped for now is ahead of one not skipped");
    for (let i = 1; i < fresh.length; i++) if (Date.parse(fresh[i]!.dueAt) < Date.parse(fresh[i - 1]!.dueAt)) problem("16: ready now is not oldest due first");
    for (let i = 1; i < skipped.length; i++) if ((skips.get(skipped[i]!.taskId) ?? 0) < (skips.get(skipped[i - 1]!.taskId) ?? 0)) problem("16: calls skipped for now are not in the order skipped");
    if (q.focusTaskId !== (q.readyNow[0]?.taskId ?? null)) problem("16: the focused call is not the first ready now");
    // 4. Sent at most once.
    for (const ch of ["email", "sms"] as const) {
      const n = new Map<string, number>();
      for (const d of deliveries(ch)) n.set(`${d.subjectId}/${d.stepId}`, (n.get(`${d.subjectId}/${d.stepId}`) ?? 0) + 1);
      for (const [k, c] of n) if (c > 1) problem(`4: ${ch} ${k} was delivered ${c} times`);
    }
  }

  /** New tasks placed on the user day of `t`, and committed tasks: placed earlier and open at its start, for leads not stopped by then. */
  function dayCounts(all: readonly { s: Subject; task: CallTask }[], t: number): { placed: number; committed: number } {
    const { start: from, end } = userDay(t);
    const placed = all.filter((x) => x.task.placedWall >= from && x.task.placedWall < end).length;
    const committed = all.filter((x) => {
      if (x.task.placedWall >= from) return false;
      const tr = def(x.s).tracks.find((y) => y.id === x.task.trackId)!;
      const f = finishFacts(x.s, tr);
      const closed = f !== null && f.at < from;
      const interested = interestedAt(x.s) < from;
      return !closed && !interested && endLimitOf(x.s) >= from && !sequenceDoneAt(x.s, from - 1);
    }).length;
    return { placed, committed };
  }

  /** After the drain, with every call worked: each lead has ended (18), and each phone track's finish is the record's. */
  function checkDrained(s: Subject, st: SubjectState, progress: EnrollmentProgress): void {
    if (st.subject.ended === null) problem(`18: ${s.id} is ${progress.status} after the drain (${JSON.stringify(progress.tracks.map((t) => [t.trackId, t.finishReason]))})`);
    if (st.callTasks.some((t) => t.open) && st.subject.ended === null) problem(`18: ${s.id} still has an open call task after the drain`);
  }

  async function checkNumbers(): Promise<void> {
    const q = await queue();
    for (const item of [...q.readyNow, ...q.laterToday].slice(0, 3)) {
      const view = (await h.request<CallTaskView>("GET", `/api/call-tasks/${item.taskId}`)).body;
      const s = subjects.get(view.enrollmentId);
      if (!s) continue;
      const expected = phonesOf(s).map((p) => `${p.kind}:${digits(p.key)}:${badAt(p.key) <= h.clock}`);
      const got = view.numbers.map((n) => `${n.kind}:${digits(n.value)}:${n.bad}`);
      if (JSON.stringify(expected) !== JSON.stringify(got)) problem(`19: ${view.enrollmentId}'s call offers ${got.join(", ")}; the record says ${expected.join(", ")} (direct first, then mobile, then the main line)`);
    }
  }

  async function storedStatus(s: Subject, id: string): Promise<OutreachStatus | undefined> {
    if (s.person) {
      const found = (await h.request<LeadSearchResult>("GET", `/api/leads?q=${encodeURIComponent(s.person.name)}`)).body.rows.find((r) => r.name === s.person?.name);
      return found ? (await h.request<PersonRecord>("GET", `/api/people/${found.id}`)).body.enrollments.find((e) => e.id === id)?.status : undefined;
    }
    const found = (await h.request<LeadSearchResult>("GET", `/api/leads?q=${encodeURIComponent(s.company.name)}`)).body.rows.find((r) => r.kind === "company");
    return found ? (await h.request<CompanyRecord>("GET", `/api/companies/${found.id}`)).body.enrollments.find((e) => e.id === id)?.status : undefined;
  }

  // ------------------------------------------------------------------------------------------
  // Events.

  const eventCount = options.events ?? 24;
  for (let e = 0; e < eventCount && problems.length === 0 && !h.stopped; e++) {
    const r = rand();
    // A minute passes before each action, so no action shares an instant with the ticks before it.
    if (r >= 0.3) await h.advanceTo(h.clock + MINUTE);
    if (r < 0.3) {
      await h.advanceTo(h.clock + pick([20 * MINUTE, 2 * HOUR, 5 * HOUR, DAY, 2 * DAY]));
    } else if (r < 0.7) {
      // Work the list: every call the user starts is the focused one.
      if (await workFocus(false)) await checkNumbers();
      else await h.advanceTo(h.clock + pick([HOUR, 3 * HOUR]));
    } else if (r < 0.8) {
      // An outcome on a task the user is not shown now: closed, of an ended lead, or outside its calling day.
      const ids = [...knownTasks.keys()];
      if (ids.length > 0) {
        const outcome = pick(OUTCOMES);
        await logOutcome(pick(ids), outcome, (view) => view.numbers.find((n) => !n.bad)?.detailId ?? null);
      }
    } else if (r < 0.9) {
      const visible = email.deliveryLog.filter((d) => d.visibleAt <= h.clock);
      if (visible.length > 0 && chance(0.6)) {
        if (email.prospectReplies(pick(visible).destination, true, null)) features.add("email-reply");
      } else {
        const texted = sms.deliveryLog.filter((d) => d.at <= h.clock);
        if (texted.length > 0) {
          const d = pick(texted);
          if (sms.prospectTexts(d.destination, "Thanks, not now", d.sender)) features.add("sms-reply");
        }
      }
      await h.tick();
    } else {
      await h.advanceTo(h.clock + pick([MINUTE, HOUR, 6 * HOUR]));
    }
    await checkAll(false);
  }

  const stopped = () => h.stopped;
  if (problems.length === 0 && options.drain !== false && !stopped()) {
    // The drain: day by day, the user works every call on the list until no lead has work left.
    for (let step = 0; step < 400 && !stopped(); step++) {
      for (let i = 0; i < 30; i++) {
        await h.advanceTo(h.clock + MINUTE);
        if (!(await workFocus(true))) break;
      }
      const running = await h.store.engine.runningSubjectIds();
      if (running.length === 0) break;
      await h.advanceTo(h.clock + pick([2 * HOUR, 3 * HOUR, 5 * HOUR]));
    }
    if (!stopped()) await checkAll(true);
  }
  for (const id of subjects.keys()) {
    const st = await h.store.engine.subject(id, h.clock);
    if (st?.subject.ended) features.add(`ended:${st.subject.ended}`);
    for (const p of st?.tracks ?? []) if (p.finishReason === "closed_on_interest") features.add("closed-on-interest");
    for (const p of st?.tracks ?? []) if (p.finishReason === "failed_bad_destination") features.add("sms-failed-on-a-wrong-mobile");
    for (const p of st?.tracks ?? []) if (p.finishReason === "skipped_missing_channel" && def(subjects.get(id)!).tracks.find((t) => t.id === p.trackId)?.channel === "call") features.add("phone-skipped");
  }
  return result();

  function result(): CallRunResult {
    return { problems, stats: { calls: logged.filter((o) => o.accepted && o.outcome !== "skip_for_now").length, tasks: knownTasks.size, subjects: subjects.size, ticks: h.ticks, writes: h.writes, features: [...features] } };
  }
}
