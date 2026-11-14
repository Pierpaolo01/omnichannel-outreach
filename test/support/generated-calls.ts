import type { CampaignDefinition, DeclinedPath, StepDefinition, TrackDefinition } from "../../src/domain/sequence/definition.ts";
import type { CallTask, SubjectState } from "../../src/domain/sequence/state.ts";
import type { Rules } from "../../src/server/engine/rules.ts";
import { trackLabel } from "../../src/shared/track-label.ts";
import type { ActivityView, CallOutcomeApi, CallReasonApi, CallsView, CallTaskView, EnrollmentProgress, LeadSearchResult, NeedsAttention, OutreachStatus, PersonRecord, CompanyRecord, TodayView } from "../../src/shared/api.ts";
import { EngineHarness, quickWait } from "./engine-harness.ts";
import { business, person, type ExportRows } from "./export-builder.ts";
import type { FakeAccount, HandoverLogEntry } from "./fake-email-port.ts";
import type { FakeNumber } from "./fake-sms-port.ts";
import { random } from "./generated-sequences.ts";
import { dueAfter, firstOpen, higherPriority, inWindow, local, startOfDay, zoneOf, type Hours } from "./sequence-model.ts";

/**
 * Generated sequences with phone tracks (ADR 0003 9.2; the ticket 14 and 15 rows of 9.3), run through the
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
 * person or the company, and email and SMS replies. Ticket 15 adds: redials after no answer, voicemail
 * and gatekeeper (and a redial asked for with an outcome it does not follow), outcomes attempted on a
 * call redialed to tomorrow, callbacks later today, tomorrow and in a few days, worked on time, missed
 * for days (overdue) or skipped for now, a new callback time on a callback, redials off a callback, and
 * days left to pass so unworked calls reach the skip limit, on weeks with and without calling hours.
 * Each run ends with a drain in which the user works every call on the list.
 *
 * The record imports nothing from src/domain/sequence/. From the definitions, the people, the user's
 * own logged outcomes and the providers' logs it predicts: each track's start and finish, which
 * outcome the app must accept, where each listed task sits (ready now, later today), why, and in which
 * order, the numbers a task offers, when the lead stops, and its status. Ticket 15: each callback holds
 * its lead from the request to the next outcome on it that is not skip for now or a new callback time,
 * and every deadline after a hold's start moves by exactly the held time (its own frozen-interval list);
 * a task's kind and list day follow the user's callbacks and redials; and an unworked call is skipped at
 * the first rollover by which it was listed that day (on or after its list day, on a day its calling
 * hours open), the lead ran, and the skip deadline counted from the original due date had passed.
 * Placement instants are the app's, read from its tasks; each is checked against the record's own
 * capacity count, priority classes and calling days. Within one instant the engine's pass comes before
 * the user's action (the harness ticks to an instant before the user acts), and an engine event at a
 * hold's first or last instant is outside it: the tick before the request, and the one after the release.
 *
 * Checked after every event: invariants 1, 2 (nothing handed over or placed while a callback holds the
 * lead), 4, 6, 7, 8 (no email or text before its due time, moved by the holds), 9 (the clock frozen
 * exactly while held), 13, 16 (with callbacks, redials and the skip limit, one call record per action and
 * every note where the user put it), 17, 19 and 20 of ADR 0003 section 8, priority at placement (12, for
 * calls), Today's and Needs attention's overdue callbacks, and 18 after the drain.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ZONES = ["Europe/London", "America/New_York", "Europe/Paris", "Asia/Kolkata", ""];
const ALL_DAY: Hours[] = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const OUTCOMES: readonly CallOutcomeApi[] = ["no_answer", "voicemail", "gatekeeper", "wrong_number", "interested", "callback_requested", "skip_for_now"];
/** The outcomes a redial may follow (spec "Call outcomes and their effect on the lead"). */
const REDIAL: readonly CallOutcomeApi[] = ["no_answer", "voicemail", "gatekeeper"];

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
  readonly redial: boolean;
  readonly callbackAt: number | null;
  /** Not interested (ticket 16): the declined path the record says it takes, the user's override or the track's (stop when unset); else null. */
  readonly declinedPath: DeclinedPath | null;
  /** The path the user sent with the outcome, if any. */
  readonly override: DeclinedPath | null;
}

/** The invariants a problem names: the numbers before its first colon. */
export function callInvariantsOf(problem: string): string[] {
  return (problem.split(":")[0] ?? "").split("/").map((x) => x.trim());
}

const digits = (s: string) => s.replace(/\D/g, "");
/** An instant for a problem's message; a deadline behind a hold that has not ended is "never". */
const isoOf = (t: number | null | undefined) => (t === null || t === undefined || !Number.isFinite(t) ? "never" : new Date(t).toISOString());

export async function runCalls(seed: number, options: CallRunOptions = {}): Promise<CallRunResult> {
  try {
    return await runCallsUnguarded(seed, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (process.env["CALLS_DEBUG"]) console.error(error);
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
  /**
   * Ticket 16's draws (declined paths, win-back branches, declines) come from their own stream, so the ticket
   * 14 and 15 draws, and the seeds recorded for their mutations, are the same wherever no decline happens.
   */
  const declineRand = random(seed ^ 0x16a);
  const dpick = <T>(items: readonly T[]): T => items[Math.floor(declineRand() * items.length)] ?? items[0]!;
  const problems: string[] = [];
  const problem = (what: string) => {
    if (problems.length < 25 && !problems.includes(what)) problems.push(what);
  };
  const features = new Set<string>();

  const start = Date.parse("2026-10-19T00:00:00Z") + Math.floor(rand() * 11 * DAY) + Math.floor(rand() * 24) * HOUR;
  const firstUserZone = pick(["Europe/London", "America/New_York"]);
  /**
   * The call list's zone over time (council on 228cd3b): the settings may move it once in a run. A change at
   * `at` holds from `at` on; a rollover at exactly `at` was judged under the zone before it (the route catches
   * up first), which `strict` asks for.
   */
  const userZones: { at: number; zone: string }[] = [{ at: -Infinity, zone: firstUserZone }];
  const uz = (t: number, strict = false) => userZones.filter((z) => (strict ? z.at < t : z.at <= t)).at(-1)?.zone ?? firstUserZone;
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
    // The skip limit varies (1, 2 or 3 days), so Q5's interim and the case it distinguishes are both reached.
    const limit = pick([1, 2, 2, 3]);
    features.add(`limit:${limit}`);
    // Ticket 16: often a win-back branch of one or two email and SMS tracks, together or after (delay 0-2), with
    // its own copy and windows; each phone track's declined path, sometimes unset (stop, question Q14).
    const branch: TrackDefinition[] = [];
    if (declineRand() < 0.6) {
      const count = 1 + Math.floor(declineRand() * 2);
      for (let wi = 0; wi < count; wi++) {
        const channel = dpick(["email", "email", "sms"] as const);
        const earlier = branch[Math.floor(declineRand() * branch.length)];
        const startRule: TrackDefinition["start"] = !earlier ? { kind: "entry" } : declineRand() < 0.35 ? earlier.start : { kind: "after", trackId: earlier.id, delayDays: dpick([0, 1, 2]) };
        const id = `c${ci}w${wi + 1}`;
        const steps: StepDefinition[] = Array.from({ length: 1 + Math.floor(declineRand() * 2) }, (_, i) => ({
          id: `${id}s${i + 1}`,
          waitDays: i === 0 ? 0 : dpick([1, 2]),
          subject: channel === "email" ? "Another thought, {{first_name|there}}" : "",
          body: channel === "email" ? "Still here if {{company}} needs us." : "One last text, {{first_name|there}}.",
          threading: "new_subject",
          removed: false,
        }));
        branch.push({ id, channel, branch: "win_back", window: declineRand() < 0.6 ? ALL_DAY : [1, 2, 3, 4, 5].map((day) => ({ day, start: 8, end: 18 })), steps, start: startRule, removed: false });
      }
    }
    const paths: readonly (DeclinedPath | undefined)[] = [undefined, "stop", "continue", "continue", ...(branch.length > 0 ? (["win_back", "win_back", "win_back"] as const) : [])];
    const withPaths = tracks.map((t): TrackDefinition => {
      const path = t.channel === "call" ? dpick(paths) : undefined;
      return path ? { ...t, declinedPath: path } : t;
    });
    const definition: CampaignDefinition = { timezone: pick(["Europe/London", "America/New_York"]), callSkipLimitDays: limit, emailPool: ["inbox-a"], smsPool: [numbers[ci]!.id], callScript: "Ask who handles bookings.", tracks: [...withPaths, ...branch] };
    campaigns.push({ id: "", definition, companies: ci === 0 ? [0, 1, 2] : [0, 1], launchedAt: null });
  }
  for (const c of campaigns) {
    if (c.definition.tracks.filter((t) => t.channel === "call").length > 1) features.add("two-phone-tracks");
    if (c.definition.tracks.some((t) => t.start.kind === "after" && c.definition.tracks.find((x) => x.id === (t.start.kind === "after" ? t.start.trackId : ""))?.channel === "call")) features.add("after-a-call");
    if (c.definition.tracks.some((t) => t.branch === "main" && t.channel !== "call" && t.start.kind === "entry")) features.add("parallel-with-a-call");
    if (c.definition.tracks.some((t) => t.branch === "win_back")) features.add("a-win-back-branch");
  }

  /** Each person's and company's zone over time: a re-import may move one (council on 228cd3b). */
  const zoneChanges = new Map<string, { at: number; zone: string }[]>();
  const zoneOfKey = (key: string, initial: string, t: number, strict = false) => (zoneChanges.get(key) ?? []).filter((z) => (strict ? z.at < t : z.at <= t)).at(-1)?.zone ?? initial;
  const rowsFor = (c: Campaign): ExportRows => ({
    businesses: c.companies.map((i) => {
      const co = companies[i]!;
      return business({ business_id: co.key, business_name: co.name, timezone: zoneOfKey(co.key, co.zone, Infinity), phone_e164: co.line ?? "", general_emails: co.inbox ?? "" });
    }),
    people: people
      .filter((p) => c.companies.includes(p.company))
      .map((p) =>
        person({ person_id: p.key, business_id: companies[p.company]!.key, full_name: p.name, timezone: zoneOfKey(p.key, p.zone, Infinity), email: p.email ?? "", direct_phone: p.direct ?? "", ...(p.mobile ? { dial_phone: p.mobile, dial_phone_type: "mobile" } : {}) }),
      ),
  });

  const settings = await h.request("PUT", "/api/call-settings", { dailyCapacity: capacity, userZone: firstUserZone });
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
  /** Bumped whenever `logged` changes, so what the record remembers is keyed by what it was computed from. */
  let recordVersion = 0;
  let actions = 0;
  const skips = new Map<string, number>();
  const checkedNotes = new Set<string>();
  /** Tasks seen on the list or in a view: the generated user's own knowledge of task ids. */
  const knownTasks = new Map<string, { subjectId: string; trackId: string }>();
  /** When each phone track's task was placed (`subject/track`), read from the app's tasks; checked by 2, 12, 16 and 17. */
  const placedAt = new Map<string, number>();
  const notePlacement = (subjectId: string, task: CallTask) => placedAt.set(`${subjectId}/${task.trackId}`, task.placedWall);

  const def = (s: Subject) => campaigns[s.campaign]!.definition;
  /** The prospect's zone at `t` (the person's, else the company's, else the campaign's); `strict`: before any change at `t`. */
  const zoneFor = (s: Subject, t: number = h.clock, strict = false) =>
    zoneOf(s.person ? zoneOfKey(s.person.key, s.person.zone, t, strict) : "", zoneOfKey(s.company.key, s.company.zone, t, strict), def(s).timezone);
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
  /**
   * The instant no channel of the lead's branch reaches it (2.1): the main sequence's channels, a phone track's
   * included after a decline (ADR 0003 2.1), until the lead enters win-back; the branch's channels from then.
   */
  function noChannelAt(s: Subject): number {
    const lostAt = (c: TrackDefinition["channel"]) => (c === "email" ? (addressOf(s) ? Infinity : -Infinity) : c === "sms" ? (mobileOf(s) ? badAt(mobileOf(s) ?? "") : -Infinity) : allPhonesBadAt(s));
    const of = (branch: "main" | "win_back") => [...new Set(def(s).tracks.filter((t) => t.branch === branch).map((t) => t.channel))];
    const mainLost = Math.max(runStartOf(s), ...of("main").map(lostAt));
    const w = winBackAt(s);
    if (!Number.isFinite(w) || mainLost < w) return mainLost;
    return Math.max(w, ...of("win_back").map(lostAt));
  }

  // Ticket 16. The lead's decline, from the user's own accepted outcomes: a lead declines at most once.
  const declineOf = (s: Subject) => {
    const o = logged.find((x) => x.accepted && x.subjectId === s.id && x.outcome === "not_interested");
    return o ? { at: o.at, trackId: o.trackId, path: o.declinedPath ?? "stop" } : null;
  };
  /** When the lead entered the win-back branch, or Infinity. */
  const winBackAt = (s: Subject) => {
    const d = declineOf(s);
    return d?.path === "win_back" ? d.at : Infinity;
  };
  /** When the lead stopped declined on call (the stop path), or Infinity. */
  const declinedStopAt = (s: Subject) => {
    const d = declineOf(s);
    return d?.path === "stop" ? d.at : Infinity;
  };
  /** The tracks the lead runs through: the main sequence, and the win-back branch once it took that path. */
  const tracksOf = (s: Subject) => def(s).tracks.filter((t) => t.branch === "main" || Number.isFinite(winBackAt(s)));
  /**
   * When the lead stops running by the record: interested, its first reply, or no usable channel. A lead
   * held by a callback is not evaluated, so one that loses its last channel then does not end then; and,
   * with no good number, its callback cannot be worked either: it stays held.
   */
  const endLimitOf = (s: Subject) => {
    const lost = noChannelAt(s);
    return Math.min(interestedAt(s), replySeenAt(s), declinedStopAt(s), heldStrictly(s, lost) ? Infinity : lost);
  };

  // Ticket 15. Callback holds, the lead's frozen intervals (3.2), from the user's own accepted outcomes.
  /** The accepted outcomes on a lead's phone track, in the order the user logged them. */
  const acceptedOn = (s: Subject, trackId: string) => logged.filter((o) => o.accepted && o.subjectId === s.id && o.trackId === trackId);
  /** A redial or a new callback time leaves the call open; skip for now is no call. Anything else is its outcome. */
  const isFinal = (o: LoggedOutcome) => o.outcome !== "skip_for_now" && o.outcome !== "callback_requested" && !o.redial;
  /**
   * The lead's callback holds: from an accepted callback request while not held, until the next accepted
   * outcome on that call that is neither skip for now nor a new callback time (a redial ends it too).
   */
  function holdsOf(s: Subject): { from: number; to: number }[] {
    const out: { from: number; to: number }[] = [];
    const open = new Map<string, number>();
    for (const o of logged) {
      if (!o.accepted || o.subjectId !== s.id || o.outcome === "skip_for_now") continue;
      const from = open.get(o.trackId);
      if (o.outcome === "callback_requested") {
        if (from === undefined) open.set(o.trackId, o.at);
        continue;
      }
      if (from !== undefined) {
        out.push({ from, to: o.at });
        open.delete(o.trackId);
      }
    }
    for (const from of open.values()) out.push({ from, to: Infinity });
    return out.sort((a, b) => a.from - b.from);
  }
  /** Held at `t` as the screens and the user see it, after the user's action at `t`. */
  const heldAt = (s: Subject, t: number) => holdsOf(s).some((x) => x.from <= t && t < x.to);
  /** Held at `t` for an engine event: the pass before the request at `from` runs first, and the one after the release at `to` runs after. */
  const heldStrictly = (s: Subject, t: number) => holdsOf(s).some((x) => x.from < t && t < x.to);
  /** Whether a hold overlaps [a, b]. */
  const heldWithin = (s: Subject, a: number, b: number) => holdsOf(s).some((x) => x.from <= b && x.to >= a);
  /**
   * The wall instant a deadline resolved at running instant `basis` is reached, `target` being where it
   * falls with no hold: later by the length of every hold that starts at or after the basis and before
   * it is reached. A deadline at the instant a hold starts is reached first (the engine's pass comes first).
   */
  function afterHolds(s: Subject, basis: number, target: number): number {
    let at = target;
    for (const x of holdsOf(s)) if (x.from >= basis && x.from < at) at += x.to - x.from;
    return at;
  }
  /**
   * A track's start in lead time by the record: 0 for the entry, else the earlier track's finish in lead
   * time plus the calendar days of its delay from that finish's wall instant (3.3). Exact even when the wall
   * instant lies after a hold that has not ended.
   */
  function startLeadOf(s: Subject, t: TrackDefinition): number | null {
    if (!Number.isFinite(runStartOf(s))) return null;
    if (t.branch === "win_back" && !Number.isFinite(winBackAt(s))) return null;
    if (t.start.kind === "entry") return t.branch === "win_back" ? leadOfWall(s, winBackAt(s)) : 0;
    const rule = t.start;
    const before = def(s).tracks.find((x) => x.id === rule.trackId);
    const f = before ? finishFacts(s, before) : null;
    return f === null ? null : leadOfWall(s, f.at) + (dueAfter(f.at, rule.delayDays, zoneFor(s, f.at)) - f.at);
  }
  /** Lead time at wall instant `w`: the time the lead has run since it started, less every hold before `w` (3.2). */
  function leadOfWall(s: Subject, w: number): number {
    let held = 0;
    for (const x of holdsOf(s)) if (x.from < w) held += Math.min(w, x.to) - x.from;
    return w - runStartOf(s) - held;
  }
  /** The phone track's task at `t`, by the user's accepted outcomes on it at or before `t` (strictly before, with `strict`). */
  function taskStateAt(s: Subject, trackId: string, t: number, strict = false): { kind: "call" | "callback"; callbackAt: number | null; listDay: number; redialedTo: number | null } {
    const placed = placedAt.get(`${s.id}/${trackId}`);
    const st = { kind: "call" as "call" | "callback", callbackAt: null as number | null, listDay: placed === undefined ? -Infinity : local(placed, uz(placed)).day, redialedTo: null as number | null };
    for (const o of acceptedOn(s, trackId)) {
      if (strict ? o.at >= t : o.at > t) break;
      if (o.outcome === "callback_requested") {
        st.kind = "callback";
        st.callbackAt = o.callbackAt;
      } else if (o.redial) {
        st.kind = "call";
        st.callbackAt = null;
        st.listDay = local(o.at, uz(o.at)).day + 1;
        st.redialedTo = st.listDay;
      } else if (o.outcome !== "skip_for_now") {
        // Its outcome: the call is done (a callback's outcome releases the hold first, so it closes as a call).
        st.kind = "call";
        st.callbackAt = null;
      }
    }
    return st;
  }
  /**
   * The skip limit by the record (3.5): the first user-day rollover e, after the call was placed, at which
   * the call was not a callback, the lead ran, the ending day was on or after its list day and opened its
   * calling hours, and the deadline (the user's day `limit` days after the original due date, moved by the
   * holds) had passed. Only rollovers up to now. Null when none.
   */
  const expiryMemo = new Map<string, number | null>();
  function expiryOf(s: Subject, t: TrackDefinition): number | null {
    const key = `${s.id}/${t.id}/${h.clock}/${recordVersion}/${placedAt.get(`${s.id}/${t.id}`) ?? ""}`;
    if (expiryMemo.has(key)) return expiryMemo.get(key) ?? null;
    const found = expiryWalk(s, t);
    if (expiryMemo.size > 50_000) expiryMemo.clear();
    expiryMemo.set(key, found);
    return found;
  }
  /**
   * The rollovers are each zone's day starts, the zone in force for them: those at or before a change of the
   * call list's zone are the old zone's (the route judged them first), those after it the new zone's. Each is
   * judged with the prospect's zone in force just before it, and never again (the app stores how far it judged).
   */
  function expiryWalk(s: Subject, t: TrackDefinition): number | null {
    const placed = placedAt.get(`${s.id}/${t.id}`);
    const due = placed === undefined ? null : startOf(s, t);
    if (placed === undefined || due === null || !Number.isFinite(due)) return null;
    // Resolved when the call was placed, in the user's zone then.
    const placedZone = uz(placed);
    const deadline = afterHolds(s, due, startOfDay(local(due, placedZone).day + def(s).callSkipLimitDays, placedZone));
    if (deadline > h.clock) return null;
    const end = endLimitOf(s);
    const segments = userZones.map((z, i) => ({ from: z.at, to: userZones[i + 1]?.at ?? Infinity, zone: z.zone }));
    for (const seg of segments) {
      const lo = Math.max(seg.from, placed);
      if (lo >= seg.to) continue;
      for (let k = Math.max(local(lo, seg.zone).day + 1, local(deadline, seg.zone).day); ; k++) {
        const e = startOfDay(k, seg.zone);
        if (e <= lo) continue;
        if (e > seg.to || e > h.clock) break;
        if (e >= end) return null;
        if (e < deadline || heldStrictly(s, e)) continue;
        const st = taskStateAt(s, t.id, e, true);
        const d = k - 1;
        if (st.kind === "callback" || d < st.listDay || !hoursOn(s, t.id, d, seg.zone, zoneFor(s, e, true))) continue;
        return e;
      }
    }
    return null;
  }

  function startOf(s: Subject, t: TrackDefinition): number | null {
    const runStart = runStartOf(s);
    if (!Number.isFinite(runStart)) return null;
    // The win-back branch starts when the lead declines with that path, and never otherwise.
    if (t.branch === "win_back" && !Number.isFinite(winBackAt(s))) return null;
    if (t.start.kind === "entry") return t.branch === "win_back" ? winBackAt(s) : runStart;
    const rule = t.start;
    const before = def(s).tracks.find((x) => x.id === rule.trackId);
    const f = before ? finishFacts(s, before) : null;
    return f === null ? null : afterHolds(s, f.at, dueAfter(f.at, rule.delayDays, zoneFor(s, f.at)));
  }
  function startSeenAt(s: Subject, t: TrackDefinition): number | null {
    const at = startOf(s, t);
    if (at === null || t.start.kind === "entry") return at;
    const rule = t.start;
    const before = def(s).tracks.find((x) => x.id === rule.trackId);
    const seen = before ? finishFacts(s, before)?.seen ?? null : null;
    return seen === null ? null : Math.max(at, seen);
  }
  /** The accepted outcome that finished this phone track's call, if any: not skip for now, a redial or a callback time. */
  const callDone = (s: Subject, t: TrackDefinition) => acceptedOn(s, t.id).find(isFinal);

  /**
   * A track's finish by the record, and when the app can know it. Email and SMS: skipped at the start
   * when there is no address or mobile, completed at the last send. A phone track: skipped at its start
   * with no good number; completed by the user's outcome on its call; skipped when its last good number
   * went bad (another call's wrong number) while it was open. A lead's stop first leaves it unfinished.
   */
  function finishFacts(s: Subject, t: TrackDefinition): { at: number; seen: number; reason: string } | null {
    const natural = naturalFinish(s, t);
    const d = declineOf(s);
    if (!d || t.branch === "win_back" || t.id === d.trackId) return natural;
    // A track finished before the decline, as the app knew it then (an observation precedes an action), keeps its finish.
    if (natural !== null && natural.seen <= d.at) return natural;
    // Started by the decline: due at or before it, and not released by the declined call itself (its finish is the decline).
    const at = startOf(s, t);
    const rule = t.start;
    const releasedByDecline = rule.kind === "after" && at === d.at && (() => {
      const before = def(s).tracks.find((x) => x.id === rule.trackId);
      const f = before ? finishFacts(s, before) : null;
      return f !== null && f.at === d.at && (before?.id === d.trackId || f.reason === "skipped_declined" || f.reason === "dropped_for_win_back");
    })();
    const started = at !== null && at <= d.at && !releasedByDecline;
    // Every other phone track it has started is skipped as declined at once, its task closed; a later one at its start.
    if (t.channel === "call" && started) return { at: d.at, seen: d.at, reason: "skipped_declined" };
    if (d.path === "win_back") return { at: d.at, seen: d.at, reason: "dropped_for_win_back" };
    if (d.path === "stop") return null;
    if (t.channel === "call") return at === null || at >= endLimitOf(s) ? null : { at, seen: at, reason: "skipped_declined" };
    return natural;
  }

  /** A track's finish with no decline. */
  function naturalFinish(s: Subject, t: TrackDefinition): { at: number; seen: number; reason: string } | null {
    const at = startOf(s, t);
    const end = endLimitOf(s);
    if (at === null || at >= end) return null;
    if (!reachesAt(s, t.channel, at)) return { at, seen: at, reason: "skipped_missing_channel" };
    if (t.channel === "call") {
      // Whichever comes first: its outcome, its last good number going bad while the lead runs (a lead held
      // by a callback is not evaluated), or the skip limit (whose rollover comes before an action at that instant).
      const done = callDone(s, t);
      const lost = allPhonesBadAt(s);
      const expired = expiryOf(s, t);
      const lostAt = Number.isFinite(lost) && lost > at && lost < end && !heldStrictly(s, lost) ? lost : Infinity;
      const doneAt = done && done.at <= lost ? done.at : Infinity;
      const first = Math.min(doneAt, lostAt, expired ?? Infinity);
      if (!Number.isFinite(first)) return null;
      if (expired !== null && expired === first && expired <= doneAt) return { at: expired, seen: expired, reason: "skipped_unworked" };
      return first === doneAt ? { at: doneAt, seen: doneAt, reason: "completed" } : { at: lostAt, seen: lostAt, reason: "skipped_missing_channel" };
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

  /** The user day of instant `t`, as wall instants, in the call list's zone at `t`. */
  function userDay(t: number): { start: number; end: number } {
    const zone = uz(t);
    const day = local(t, zone).day;
    return { start: startOfDay(day, zone), end: startOfDay(day + 1, zone) };
  }
  const windowOf = (s: Subject, trackId: string) => def(s).tracks.find((x) => x.id === trackId)?.window ?? [];
  const hoursMemo = new Map<string, boolean>();
  /** Whether the prospect's calling hours, in `prospectZone`, open at some point of user day `d` reckoned in `dayZone`. */
  function hoursOn(s: Subject, trackId: string, d: number, dayZone: string, prospectZone: string): boolean {
    const from = startOfDay(d, dayZone);
    const key = `${s.campaign}/${trackId}/${prospectZone}/${dayZone}/${d}`;
    let open = hoursMemo.get(key);
    if (open === undefined) {
      open = firstOpen(windowOf(s, trackId), prospectZone, from) < startOfDay(d + 1, dayZone);
      hoursMemo.set(key, open);
    }
    return open;
  }
  /** Whether the prospect's calling hours open at some point of the user day of `t`, with the zones at `t`. */
  const hoursOnUserDay = (s: Subject, trackId: string, t: number) => hoursOn(s, trackId, local(t, uz(t)).day, uz(t), zoneFor(s, t));
  /** Open now or later on the user day of `t`. */
  const hoursLeftToday = (s: Subject, trackId: string, t: number) => firstOpen(windowOf(s, trackId), zoneFor(s, t), t) < userDay(t).end;
  /**
   * Running at `t`: launched, not stopped, with work left before `t` (a call logged at `t` may finish it at
   * `t`), and not held by a callback. At the instant of a user action the engine passes twice, before the
   * action (the harness's tick) and after it (the tick the action runs), so `held` says how a hold that
   * starts or ends at `t` is read: `engine` for an event that may come before the action (outside the hold
   * at its first and last instant), `after` for what holds once every action at `t` is done, `around` for an
   * event on either side of it (held if a hold starts or ends at `t`).
   */
  const runningAt = (s: Subject, t: number, held: "engine" | "after" | "around" = "engine") =>
    runStartOf(s) <= t && t < endLimitOf(s) && !sequenceDoneAt(s, t, true) && !(held === "engine" ? heldStrictly(s, t) : held === "after" ? heldAt(s, t) : holdsOf(s).some((x) => x.from <= t && t <= x.to));
  /** Every track of the campaign finished, by the record, and known to the app by `t` (strictly before, with `strict`). */
  function sequenceDoneAt(s: Subject, t: number, strict = false): boolean {
    return tracksOf(s).every((tr) => {
      const f = finishFacts(s, tr);
      return f !== null && (strict ? f.seen < t : f.seen <= t);
    });
  }
  /** When every track had finished and the app knew it, or Infinity. */
  function sequenceDoneInstant(s: Subject): number {
    const seen = tracksOf(s).map((tr) => finishFacts(s, tr)?.seen ?? Infinity);
    return Math.max(...seen);
  }
  /**
   * Whether the record lists the task (2.3): open and its lead not stopped; a callback from its own user
   * day, at any hour; a call while no callback holds the lead, from its list day (a redial moves it to the
   * next day), on a day the prospect's calling hours open.
   */
  function listedByRecord(taskId: string, t: number): boolean {
    const k = knownTasks.get(taskId);
    const s = k ? subjects.get(k.subjectId) : undefined;
    const tr = s ? def(s).tracks.find((x) => x.id === k?.trackId) : undefined;
    if (!k || !s || !tr) return false;
    const f = finishFacts(s, tr);
    if (f !== null && f.at <= t) return false;
    if (!(runStartOf(s) <= t && t < endLimitOf(s) && !sequenceDoneAt(s, t, true))) return false;
    const st = taskStateAt(s, tr.id, t);
    const today = local(t, uz(t)).day;
    if (st.kind === "callback") return local(st.callbackAt ?? Infinity, uz(t)).day <= today;
    return !heldAt(s, t) && st.listDay <= today && hoursOnUserDay(s, tr.id, t);
  }
  /** Why a listed task is on the list by the record: a callback before its time, then overdue; rolled over from an earlier list day; a redial on its day; due. */
  function reasonByRecord(s: Subject, trackId: string, t: number): CallReasonApi {
    const st = taskStateAt(s, trackId, t);
    if (st.kind === "callback") return t < (st.callbackAt ?? Infinity) ? "callback" : "overdue";
    const zone = uz(t);
    const today = local(t, zone).day;
    // A redial is a redial until its first listed day has passed (one logged Friday for Saturday is a redial on Monday).
    const redialed = st.redialedTo !== null && st.redialedTo === st.listDay;
    let listedSince = false;
    for (let d = st.listDay; d < today && !listedSince; d++) listedSince = hoursOn(s, trackId, d, zone, zoneFor(s, t));
    if (st.listDay < today && (!redialed || listedSince)) return "rolled_over";
    return redialed ? "redial" : "due";
  }
  function touchedAt(s: Subject, t: number, strict: boolean): boolean {
    const before = (x: number) => (strict ? x < t : x <= t);
    const sent = (["email", "sms"] as const).some((ch) => deliveries(ch).some((d) => d.subjectId === s.id && before(knownAt(ch, d))));
    return sent || logged.some((o) => o.accepted && o.subjectId === s.id && o.outcome !== "skip_for_now" && before(o.at));
  }

  // ------------------------------------------------------------------------------------------
  // The generated user.

  /** The call the user's screen is on: named on every read of the queue, so it keeps the focus while it is listed. */
  let focus: string | null = null;
  async function queue(): Promise<CallsView> {
    // Read as of its own instant, even between a due instant and the worker's tick (council on 228cd3b, item 2).
    const q = (await h.request<CallsView>("GET", `/api/calls${focus ? `?focus=${focus}` : ""}`)).body;
    const held = focus;
    focus = q.focusTaskId;
    // The focus moves only when the call the user is on leaves the list (an outcome, or its lead stopping).
    const expected = held !== null && knownTasks.has(held) && listedByRecord(held, h.clock) ? held : ((await recordReadyNow())[0] ?? null);
    if (q.focusTaskId !== expected) problem(`16: the focus is ${q.focusTaskId ?? "none"} at ${new Date(h.clock).toISOString()}; the user was on ${held ?? "nothing"}, and the record says ${expected ?? "none"}`);
    for (const item of [...q.readyNow, ...q.laterToday]) knownTasks.set(item.taskId, { subjectId: item.enrollmentId, trackId: item.track.id });
    return q;
  }

  /** Logs one outcome on a task, as the user would after a call, and checks the app accepted exactly what the record says it must. */
  /** The engine clears a call's skip for now when a redial or a callback moves it; a skip for now puts it last today. */
  function applySkip(o: LoggedOutcome): void {
    if (o.outcome === "skip_for_now") skips.set(o.taskId, o.at);
    else if (o.redial || o.outcome === "callback_requested") skips.delete(o.taskId);
  }
  const redialedLast = (s: Subject, trackId: string) => acceptedOn(s, trackId).at(-1)?.redial === true;
  /** The user's date of `t`, YYYY-MM-DD. */
  const dateIn = (t: number) => new Date(local(t, uz(t)).day * DAY).toISOString().slice(0, 10);

  async function logOutcome(taskId: string, outcome: CallOutcomeApi, chooseNumber: (view: CallTaskView) => string | null, extra: { redial?: boolean; callbackAt?: number | null; declinedPath?: DeclinedPath | null } = {}): Promise<void> {
    const view = (await h.request<CallTaskView>("GET", `/api/call-tasks/${taskId}`)).body;
    knownTasks.set(taskId, { subjectId: view.enrollmentId, trackId: view.track.id });
    const s = subjects.get(view.enrollmentId);
    if (!s) return;
    // The task preselects its phone track's declined path, stop when the canvas set none (Q14), and offers win back only with a branch.
    const trackDef = def(s).tracks.find((t) => t.id === view.track.id);
    const configured: DeclinedPath = trackDef?.declinedPath ?? "stop";
    const hasBranch = def(s).tracks.some((t) => t.branch === "win_back" && !t.removed);
    if (view.declinedPath !== configured || view.declinedPaths.join() !== (hasBranch ? "stop,continue,win_back" : "stop,continue")) {
      problem(`16: ${view.enrollmentId}/${view.track.id}'s call offers the declined path ${view.declinedPath} of ${view.declinedPaths.join(", ")}; the definition says ${configured}${hasBranch ? ", with a win-back branch" : ", with no win-back branch"}`);
    }
    const numberId = outcome === "skip_for_now" ? null : chooseNumber(view);
    const number = view.numbers.find((n) => n.detailId === numberId);
    const key = number ? (phonesOf(s).find((p) => digits(p.key) === digits(number.value))?.key ?? null) : null;
    const now = h.clock;
    // The app's placements so far (each checked against the record's capacity, priority and calling days), so an
    // action judged as of its instant knows a call placed while no check ran, as in a stretch before a due instant.
    for (const sid of subjects.keys()) for (const t of (await h.store.engine.subject(sid, now))?.callTasks ?? []) notePlacement(sid, t);
    const numberOk = outcome === "skip_for_now" || (key !== null && badAt(key) > now);
    const redial = extra.redial === true;
    const callbackAt = extra.callbackAt ?? null;
    const override = extra.declinedPath ?? null;
    const path: DeclinedPath | null = outcome === "not_interested" ? (override ?? configured) : null;
    // A redial follows only no answer, voicemail or gatekeeper; a callback needs a time still to come; a declined
    // path goes only with not interested, and win back needs the campaign's win-back branch.
    const shapeOk = (!redial || REDIAL.includes(outcome)) && (outcome === "callback_requested" ? callbackAt !== null && callbackAt > now : callbackAt === null) && (override === null || outcome === "not_interested") && (path !== "win_back" || hasBranch);
    const expected = listedByRecord(taskId, now) && numberOk && shapeOk;
    const note = chance(0.5) ? pick(["Rang out.", "Spoke to reception.", "Call back after lunch.", ""]) : "";
    const noteScope = chance(0.3) ? "company" : "person";
    const body = { requestId: `action-${++actions}`, outcome, numberId, note, noteScope, ...(redial ? { redial: true } : {}), ...(callbackAt !== null ? { callbackAt: new Date(callbackAt).toISOString() } : {}), ...(override !== null ? { declinedPath: override } : {}) };
    const entry: LoggedOutcome = { at: now, taskId, subjectId: view.enrollmentId, trackId: view.track.id, outcome, numberKey: key, accepted: expected, note: note.trim(), noteScope, redial, callbackAt, declinedPath: path, override };
    const post = () => h.request<{ error?: { message: string }; nextFocusTaskId?: string | null }>("POST", `/api/call-tasks/${taskId}/outcome`, body);
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
    if (accepted !== expected) problem(`16: ${outcome} on ${view.enrollmentId}/${view.track.id} at ${new Date(now).toISOString()} was ${accepted ? "accepted" : `refused (${res.body.error?.message ?? res.status})`}; the record says it must be ${expected ? "accepted" : "refused"}${process.env["CALLS_DEBUG"] ? ` [placed ${isoOf(placedAt.get(`${s.id}/${view.track.id}`))}; due ${isoOf(startOf(s, def(s).tracks.find((t) => t.id === view.track.id)!))}; expiry ${isoOf(expiryOf(s, def(s).tracks.find((t) => t.id === view.track.id)!))}; state ${JSON.stringify(taskStateAt(s, view.track.id, now, true))}; holds ${JSON.stringify(holdsOf(s))}; outcomes ${JSON.stringify(acceptedOn(s, view.track.id).map((o) => [isoOf(o.at), o.outcome, o.redial]))}]` : ""}`);
    if (accepted && expected && answers.length === 1) {
      // The answer names the next focus: the first call ready now, by the record, once this outcome is logged.
      const skippedBefore = skips.get(taskId);
      logged.push(entry);
      recordVersion++;
      applySkip(entry);
      const next = (await recordReadyNow())[0] ?? null;
      logged.pop();
      recordVersion++;
      if (skippedBefore === undefined) skips.delete(taskId);
      else skips.set(taskId, skippedBefore);
      if (res.body.nextFocusTaskId !== next) problem(`16: after ${outcome} on ${view.enrollmentId}/${view.track.id} the answer moves the focus to ${res.body.nextFocusTaskId ?? "none"}; the record says ${next ?? "none"}`);
      focus = res.body.nextFocusTaskId ?? null;
    }
    if (answers.some((a) => a.status !== res.status)) problem(`16: ${body.requestId} (${outcome}) was answered ${answers.map((a) => a.status).join(" and ")}; one action has one answer`);
    // The record follows its own prediction, so one wrong answer is reported once, not compounded.
    logged.push(entry);
    recordVersion++;
    if (expected) applySkip(entry);
    if (expected && outcome === "wrong_number" && number?.kind === "mobile") features.add("wrong-mobile");
    if (expected) features.add(`outcome:${outcome}${redial ? "+redial" : ""}`);
    else features.add("outcome-refused");
    if (!expected && redial && !REDIAL.includes(outcome)) features.add("redial-with-the-wrong-outcome");
    if (!expected && view.task === null && view.open && view.listedFor > dateIn(now) && redialedLast(s, view.track.id)) features.add("outcome-on-a-redial-for-tomorrow");
    if (expected && outcome === "callback_requested") features.add(local(callbackAt ?? now, uz(now)).day > local(now, uz(now)).day ? "callback-for-a-later-day" : "callback-later-today");
    if (expected && taskStateAt(s, view.track.id, now - 1).kind === "callback") features.add(`callback-worked:${outcome}${redial ? "+redial" : ""}`);
    if (expected && path !== null) {
      features.add(`declined:${path}`);
      if (override !== null && override !== configured) features.add("declined-path-overridden");
      if (trackDef?.declinedPath === undefined && override === null) features.add("declined-with-no-path-set");
      if (knownTasksOf(s).some((id) => id !== taskId && listedOrWaiting(id, now - 1))) features.add("declined-with-another-call-open");
    }
    if (!expected && override !== null && outcome !== "not_interested") features.add("declined-path-with-another-outcome");
    if (!expected && path === "win_back" && !hasBranch && listedByRecord(taskId, now)) features.add("win-back-refused-without-a-branch");
  }
  /** The tasks the user has seen of a lead. */
  const knownTasksOf = (s: Subject) => [...knownTasks].filter(([, k]) => k.subjectId === s.id).map(([id]) => id);
  /** An open task by the record: its track has not finished (listed now, or waiting for a later day). */
  const listedOrWaiting = (taskId: string, t: number) => {
    const k = knownTasks.get(taskId);
    const s = k ? subjects.get(k.subjectId) : undefined;
    const tr = s ? def(s).tracks.find((x) => x.id === k?.trackId) : undefined;
    const f = s && tr ? finishFacts(s, tr) : null;
    return s !== undefined && tr !== undefined && (f === null || f.at > t) && t < endLimitOf(s);
  };

  /** Works the focused call with a generated outcome, on a number from the task. */
  async function workFocus(drain: boolean): Promise<boolean> {
    const q = await queue();
    const focus = q.focusTaskId;
    if (!focus) return false;
    // A wrong number on a mobile also marks it bad for texts, so an SMS track on it fails.
    const drawn: CallOutcomeApi = drain ? pick(["no_answer", "voicemail", "gatekeeper"]) : pick(["no_answer", "voicemail", "gatekeeper", "wrong_number", "interested", "callback_requested", "callback_requested", "skip_for_now", "skip_for_now"]);
    // Ticket 16: sometimes the prospect declines; the user keeps the preselected path or overrides it for this lead.
    const declining = !drain && declineRand() < 0.14;
    const outcome: CallOutcomeApi = declining ? "not_interested" : drawn;
    // In the drain the user works every call through. A callback whose lead has no good number left cannot be
    // logged (Q13): the user skips it for now, once a day, and works the calls behind it.
    if (drain && !(await workable(focus))) {
      const today = local(h.clock, uz(h.clock)).day;
      if (stuckSkipped.get(focus) === today) return false;
      stuckSkipped.set(focus, today);
      await logOutcome(focus, "skip_for_now", () => null);
      features.add("drain-skipped-a-callback-it-cannot-log");
      return true;
    }
    const extra = drain ? {} : { redial: REDIAL.includes(outcome) && chance(0.4), callbackAt: outcome === "callback_requested" ? callbackTime() : null, declinedPath: declining && declineRand() < 0.35 ? dpick(["stop", "continue", "win_back"] as const) : null };
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
      // A wrong number is often the shared main line: a colleague can lose their last good number that way,
      // even while a callback holds them (Q13).
      const mainLine = good.find((n) => n.kind === "main_line");
      if (outcome === "wrong_number" && mainLine && staleRand() < 0.6) return mainLine.detailId;
      return choices.length > 0 ? pick(choices).detailId : (good[0]?.detailId ?? null);
    }, extra);
    return true;
  }

  /** Logs a wrong number on a shared main line that is the only good number of a lead a callback holds. True if it did. */
  async function strandACallback(): Promise<boolean> {
    const now = h.clock;
    for (const held of subjects.values()) {
      if (!heldAt(held, now) || held.company.line === null || badAt(held.company.line) <= now) continue;
      if (phonesOf(held).some((p) => p.key !== held.company.line && badAt(p.key) > now)) continue;
      for (const [taskId, k] of knownTasks) {
        const colleague = subjects.get(k.subjectId);
        if (!colleague || colleague.id === held.id || colleague.company.key !== held.company.key || !listedByRecord(taskId, now)) continue;
        await logOutcome(taskId, "wrong_number", (view) => view.numbers.find((n) => n.kind === "main_line" && !n.bad)?.detailId ?? null);
        features.add("a-held-lead-lost-its-last-number");
        return true;
      }
    }
    return false;
  }
  /** Callbacks with no good number the drain skipped for now, and the user day it did. */
  const stuckSkipped = new Map<string, number>();
  /** A time the prospect asks to be called back: later today, tomorrow, or in a few days, in the user's day. */
  function callbackTime(): number {
    const now = h.clock;
    const zone = uz(now);
    const today = local(now, zone).day;
    const kind = rand();
    if (kind < 0.35) return now + pick([30 * MINUTE, HOUR, 3 * HOUR]);
    if (kind < 0.75) return startOfDay(today + 1, zone) + pick([10, 15, 19]) * HOUR;
    return startOfDay(today + pick([2, 3]), zone) + pick([9, 14]) * HOUR;
  }
  /** Whether the task offers a good number to log a call on. */
  const workable = async (taskId: string) => (await h.request<CallTaskView>("GET", `/api/call-tasks/${taskId}`)).body.numbers.some((n) => !n.bad);

  async function checkAll(drained: boolean): Promise<void> {
    const now = h.clock;
    const states = new Map<string, SubjectState>();
    for (const id of subjects.keys()) {
      const st = await h.store.engine.subject(id, now);
      if (st) states.set(id, st);
    }
    for (const [id, st] of states) for (const task of st.callTasks) notePlacement(id, task);
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
        : declinedStopAt(s) <= now ? "declined_on_call"
        : firstEnd > now ? null
        : noChannelAt(s) === firstEnd ? "finished_no_usable_channel"
        : "sequence_finished_no_response";
      const column = await storedStatus(s, id);
      if (column !== progress.status) problem(`1: ${id} stores ${String(column)} but derives ${progress.status}`);
      if (expectedEnd !== null && progress.status !== expectedEnd && !(expectedEnd === "sequence_finished_no_response" && progress.status === "finished_no_usable_channel")) problem(`20: ${id} is ${progress.status}; the record says ${expectedEnd}`);
      // 9. The lead's clock stands still exactly while it does not run: held by a callback, or ended (3.2).
      const held = heldAt(s, now);
      if ((st.subject.clock.frozenSince !== null) !== (held || st.subject.ended !== null)) problem(`9: ${id}'s clock is ${st.subject.clock.frozenSince === null ? "running" : "frozen"} at ${new Date(now).toISOString()}; the record says the lead is ${held ? "held by a callback" : st.subject.ended !== null ? "ended" : "running"}`);
      if (held) features.add("callback-hold");
      // 20 and 15 (ticket 16). The lead's branch and its decline, with the path taken, are the record's.
      const d = declineOf(s);
      const declined = d !== null && d.at <= now ? d : null;
      const wantBranch = winBackAt(s) <= now ? "win_back" : "main";
      if (progress.branch !== wantBranch) problem(`20: ${id} runs in the ${progress.branch} branch; the record says ${wantBranch}`);
      if ((progress.declined?.path ?? null) !== (declined?.path ?? null) || (declined !== null && (progress.declined?.trackId !== declined.trackId || progress.declined.at !== new Date(declined.at).toISOString()))) {
        problem(`20: ${id}'s decline is ${JSON.stringify(progress.declined)}; the record says ${declined ? `${declined.path} on ${declined.trackId} at ${new Date(declined.at).toISOString()}` : "none"}`);
      }
      if (wantBranch === "win_back" && expectedEnd === null) features.add("in-win-back");
      if (expectedEnd === null) {
        const open = st.callTasks.some((t) => t.open);
        const want: OutreachStatus = held ? "callback_scheduled" : winBackAt(s) <= now ? "in_win_back" : open ? "waiting_on_call" : touchedAt(s, now, false) ? "active" : "queued";
        if (st.subject.ended !== null) problem(`20: ${id} ended ${st.subject.ended} at ${new Date(st.subject.endedWall ?? 0).toISOString()}; the record has it running`);
        else if (progress.status !== want) problem(`1: ${id} is ${progress.status}; the record says ${want} (${open ? "an open call task" : touchedAt(s, now, false) ? "touched" : "never reached"})`);
      }

      // 7. Starts and finishes are the record's.
      for (const t of def(s).tracks) {
        const p = st.tracks.find((x) => x.trackId === t.id);
        const at = startOf(s, t);
        const seen = startSeenAt(s, t);
        // The engine's start is in lead time, which stood still while a callback held the lead: compared in lead time.
        const startWall = p?.startAt != null ? afterHolds(s, runStartOf(s), runStartOf(s) + p.startAt) : null;
        const startLead = startLeadOf(s, t);
        if (p?.startAt != null && (startLead === null || p.startAt !== startLead)) {
          const rule = t.start.kind === "after" ? `${t.start.delayDays} day(s) after ${t.start.trackId}` : "entry";
          const before = t.start.kind === "after" ? def(s).tracks.find((x) => x.id === (t.start.kind === "after" ? t.start.trackId : "")) : undefined;
          const bf = before ? finishFacts(s, before) : null;
          problem(`7: ${id}/${t.id} starts at ${isoOf(startWall)}; the record says ${isoOf(at)} (${rule}; the record's finish of it: ${bf ? `${bf.reason} at ${isoOf(bf.at)}` : "none"}; the lead stops at ${Number.isFinite(end) ? new Date(end).toISOString() : "never"})`);
        }
        const f = finishFacts(s, t);
        const dropped = f?.reason === "dropped_for_win_back" && at !== null && f.at <= at;
        if (at !== null && seen !== null && seen <= now && at < end && p?.startedAt == null && !dropped) problem(`7: ${id}/${t.id} was due to start at ${new Date(at).toISOString()} but has not`);
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
        if (task.open && task.kind === "callback" && !heldAt(s, now) && st.subject.ended === null) problem(`16: ${id}/${task.trackId} is an open callback, but the record has no callback holding the lead`);
        if (!hoursLeftToday(s, task.trackId, task.placedWall)) problem(`17: ${id}/${task.trackId} was placed at ${new Date(task.placedWall).toISOString()}, when its calling hours did not open again that user day`);
        if (heldStrictly(s, task.placedWall)) problem(`2: ${id}/${task.trackId} was placed at ${new Date(task.placedWall).toISOString()}, while a callback held the lead`);
        if (!(runStartOf(s) <= task.placedWall && task.placedWall <= end && !sequenceDoneAt(s, task.placedWall, true))) problem(`2: ${id}/${task.trackId} was placed at ${new Date(task.placedWall).toISOString()} while the lead was not running (from ${new Date(runStartOf(s)).toISOString()} to ${Number.isFinite(endLimitOf(s)) ? new Date(endLimitOf(s)).toISOString() : "now"}${sequenceDoneAt(s, task.placedWall) ? ", sequence done" : ""})`);
      }
      if (new Set(st.callTasks.map((t) => t.stepId)).size !== st.callTasks.length) problem(`16: ${id} has two tasks for one call step`);
      // 15. No call after a decline: none open from then on, none placed after it, and none in win-back.
      for (const task of st.callTasks) {
        if (declined !== null && task.open) problem(`15: ${id}/${task.trackId}'s call task is open after the lead declined at ${new Date(declined.at).toISOString()}`);
        if (d !== null && task.placedWall > d.at) problem(`15: ${id}/${task.trackId} was placed at ${new Date(task.placedWall).toISOString()}, after the lead declined at ${new Date(d.at).toISOString()}`);
        if (def(s).tracks.find((t) => t.id === task.trackId)?.branch === "win_back") problem(`15: ${id} has a call task in win-back`);
      }
      // 6. Nothing of a main track dropped for win-back is handed over after the lead entered the branch.
      for (const ch of ["email", "sms"] as const) {
        for (const c of (ch === "sms" ? sms.handoverLog : email.handoverLog).filter((x) => x.subjectId === id && x.at > winBackAt(s))) {
          const tr = def(s).tracks.find((t) => t.steps.some((x) => x.id === c.stepId));
          if (tr?.branch === "main") problem(`6: ${id}/${c.stepId} of the main sequence was handed over at ${new Date(c.at).toISOString()}, after the lead entered win-back at ${new Date(winBackAt(s)).toISOString()}`);
          else features.add("a-send-in-win-back");
        }
      }

      // 18, during the run: a due call with room on today's list is placed (nothing waits for no reason).
      for (const t of def(s).tracks) {
        if (t.channel !== "call") continue;
        const seen = startSeenAt(s, t);
        const f = finishFacts(s, t);
        if (seen === null || seen > now || !runningAt(s, now, "after") || (f !== null && f.at <= now) || st.callTasks.some((x) => x.trackId === t.id)) continue;
        if (!hoursLeftToday(s, t.id, now) || !goodPhoneAt(s, now)) continue;
        const day = dayCounts(allTasks, now);
        features.add(day.committed > 0 ? "waits-behind-committed" : "waits-for-room");
        if (day.placed < capacity - day.committed) problem(`17: ${id}/${t.id}'s call has been due since ${new Date(seen).toISOString()} and today's list has room (${day.placed} placed, ${day.committed} committed, capacity ${capacity}), but it is not placed${process.env["CALLS_DEBUG"] ? ` [now ${isoOf(now)}; zones ${JSON.stringify(userZones)}; engine day ${JSON.stringify(await h.store.engine.callDay(now))}; tasks ${JSON.stringify(allTasks.map((x) => [x.s.id, x.task.trackId, isoOf(x.task.placedWall), x.task.open, x.task.kind]))}; track ${JSON.stringify(st.tracks.find((p) => p.trackId === t.id))}; clock ${JSON.stringify(st.subject.clock)}]` : ""}`);
      }

      // 18, during the run: a due email or text goes within an hour of its window opening while the lead runs (a call never holds them).
      for (const t of def(s).tracks) {
        if (t.channel === "call") continue;
        const ch = t.channel;
        const at = startOf(s, t);
        // Not before a hold that has not ended yet: nothing of it can be due.
        if (at === null || !Number.isFinite(at)) continue;
        for (const [i, step] of t.steps.entries()) {
          const prev = i > 0 ? deliveryOf(ch, id, t.steps[i - 1]!.id) : undefined;
          if (i > 0 && !prev) break;
          // A wait counts in lead time: every callback hold after its basis moves it by the time held (3.2, 3.3).
          // Resolved at the basis, in the prospect's zone then.
          const unheld = prev ? dueAfter(prev.at, step.waitDays, zoneFor(s, prev.at)) : at;
          const due = prev ? afterHolds(s, prev.at, unheld) : at;
          if (!reachesAt(s, ch, at) || !Number.isFinite(due)) break;
          // A main track dropped for win-back sends nothing due after the lead entered the branch.
          const ended = finishFacts(s, t);
          if (ended?.reason === "dropped_for_win_back" && due >= ended.at) break;
          // 8 and 9. Never handed over before its due time, the holds included.
          const handed = firstCall(ch, id, step.id);
          if (handed && handed.at < due) problem(`9: ${id}/${step.id} was handed over at ${new Date(handed.at).toISOString()}, before its due time ${new Date(due).toISOString()} (${new Date(unheld).toISOString()} moved by the lead's callback holds)`);
          if (handed && due > unheld) features.add("a-send-moved-by-a-callback");
          const opens = firstOpen(t.window, zoneFor(s, due), due);
          const deadline = opens + HOUR;
          const seen = i === 0 ? startSeenAt(s, t) : due;
          // Not across a move of the prospect's zone: the window is read in the zone of the moment of each claim.
          const moved = [s.person?.key, s.company.key].some((key) => (zoneChanges.get(key ?? "") ?? []).some((z) => z.at >= (prev?.at ?? at) && z.at <= deadline));
          if (moved || seen === null || seen > opens || deadline > now || !runningAt(s, deadline) || heldWithin(s, opens, deadline) || !inWindow(t.window, zoneFor(s, deadline), deadline - 1) || !reachesAt(s, ch, deadline)) continue;
          if (!handed || handed.at > deadline) problem(`18: ${id}/${step.id} was due at ${new Date(due).toISOString()} and its window open from ${new Date(opens).toISOString()}, but it was not handed over within an hour`);
          if (handed && st.callTasks.some((x) => x.open && x.placedWall <= handed.at)) features.add("a-send-beside-an-open-call");
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
        // The number a call was logged on, as the detail it stands for now through every merge (ADR 0001).
        const n = st.recordedNumbers[a.numberDetailId];
        if (!n || !phonesOf(s).some((p) => p.key === n.key)) problem(`19: ${id} logged a call on ${a.numberDetailId}, which is not one of its numbers`);
      }
      for (const ch of ["email", "sms"] as const) {
        for (const c of (ch === "sms" ? sms.handoverLog : email.handoverLog).filter((x) => x.subjectId === id)) {
          if (c.at > end) problem(`2: ${id}/${c.stepId} was handed over at ${new Date(c.at).toISOString()}, after the lead stopped at ${new Date(end).toISOString()}`);
          // A callback pauses the lead's automated outreach in this campaign until its outcome is logged.
          if (heldStrictly(s, c.at)) problem(`2: ${id}/${c.stepId} was handed over at ${new Date(c.at).toISOString()}, while a callback held the lead (${holdsOf(s).map((x) => `${new Date(x.from).toISOString()} to ${Number.isFinite(x.to) ? new Date(x.to).toISOString() : "now"}`).join(", ")})`);
        }
      }
      if (drained) {
        checkDrained(s, st, progress);
        await checkActivity(s, progress);
      }
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
    // A day the call list's zone changed in has two reckonings of its bounds; only days reckoned in one zone are checked.
    const days = new Set(allTasks.map((x) => `${uz(x.task.placedWall)}|${local(x.task.placedWall, uz(x.task.placedWall)).day}`));
    for (const key of days) {
      const [zone = firstUserZone, dayText = "0"] = key.split("|");
      const d = Number(dayText);
      if (userZones.some((z) => z.at >= startOfDay(d, zone) - DAY && z.at < startOfDay(d + 1, zone) + DAY)) continue;
      const counts = dayCounts(allTasks, startOfDay(d, zone));
      if (counts.placed > capacity - counts.committed) problem(`17: ${counts.placed} new calls were placed on ${new Date(d * DAY).toISOString().slice(0, 10)} with ${counts.committed} committed and a capacity of ${capacity}${process.env["CALLS_DEBUG"] ? ` engine day ${JSON.stringify(await h.store.engine.callDay(startOfDay(d, zone)))}` : ""}`);
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
          if (seen === null || seen >= task.placedWall || !runningAt(other, task.placedWall, "around") || (f !== null && f.at <= task.placedWall)) continue;
          if (!hoursLeftToday(other, t.id, task.placedWall) || !goodPhoneAt(other, task.placedWall)) continue;
          const theirs = { touched: touchedAt(other, task.placedWall, false), dueWall: startOf(other, t) ?? Infinity, subjectId: other.id, stepId: t.steps[0]!.id };
          const theirsStrict = { ...theirs, touched: touchedAt(other, task.placedWall, true) };
          if (higherPriority(theirs, { ...ours, touched: touchedAt(s, task.placedWall, false) }) && higherPriority(theirsStrict, ours)) {
            problem(`12: ${s.id}/${task.trackId} was placed at ${new Date(task.placedWall).toISOString()} before ${other.id}/${t.id}, which had priority and was ready (theirs due ${isoOf(theirs.dueWall)} touched ${theirs.touched}${process.env["CALLS_DEBUG"] ? `; their outcomes ${JSON.stringify(logged.filter((o) => o.subjectId === other.id).map((o) => [isoOf(o.at), o.trackId, o.outcome, o.accepted, o.redial]))}; their task ${JSON.stringify(otherTask ?? null)}; holds ${JSON.stringify(holdsOf(other))}` : ""})`);
          }
        }
      }
    }

    // 13 and 16. The queue is the record's listing: a call ready now inside the prospect's calling hours and later
    // today when they open later on the user's day; a callback later today until its time, ready from then, at any hour.
    const recordOverdue: string[] = [];
    for (const { s, task } of allTasks) {
      const listed = task.open && listedByRecord(task.id, now);
      const st = taskStateAt(s, task.trackId, now);
      const isCallback = st.kind === "callback";
      const ready = listed && (isCallback ? now >= (st.callbackAt ?? Infinity) : inWindow(windowOf(s, task.trackId), zoneFor(s, now), now));
      const later = listed && !ready && (isCallback || hoursLeftToday(s, task.trackId, now));
      const item = [...q.readyNow, ...q.laterToday].find((x) => x.taskId === task.id);
      const inReady = q.readyNow.some((x) => x.taskId === task.id);
      const inLater = q.laterToday.some((x) => x.taskId === task.id);
      if (inReady && !isCallback && !inWindow(windowOf(s, task.trackId), zoneFor(s, now), now)) problem(`13: ${s.id}/${task.trackId} is ready now outside the prospect's calling hours (${zoneFor(s, now)})`);
      if (inReady !== ready || inLater !== later) problem(`16: ${s.id}/${task.trackId} is ${inReady ? "ready now" : inLater ? "later today" : "not on the list"}; the record says ${ready ? "ready now" : later ? "later today" : "not on the list"}${isCallback ? ` (a callback at ${new Date(st.callbackAt ?? 0).toISOString()})` : ""}`);
      if (item) {
        const reason = reasonByRecord(s, task.trackId, now);
        if (item.reason !== reason) problem(`16: ${s.id}/${task.trackId} is on the list as ${item.reason}; the record says ${reason}`);
        const due = startOf(s, def(s).tracks.find((x) => x.id === task.trackId)!);
        if (due !== null && Number.isFinite(due) && item.dueAt !== new Date(due).toISOString()) problem(`16: ${s.id}/${task.trackId} shows due ${item.dueAt}; its original due time by the record is ${new Date(due).toISOString()}`);
        features.add(`reason:${reason}`);
        if (reason === "overdue") recordOverdue.push(task.id);
        if (reason === "overdue" && local(st.callbackAt ?? now, uz(now)).day < local(now, uz(now)).day) features.add("overdue-callback-for-days");
      }
    }
    // Today's Needs attention lists every overdue callback, and so does GET /api/needs-attention.
    const todayView = (await h.request<TodayView>("GET", "/api/today")).body;
    const attention = (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body;
    const sorted = (ids: readonly string[]) => [...ids].sort().join();
    if (sorted(todayView.overdueCallbacks.map((x) => x.taskId)) !== sorted(recordOverdue)) problem(`16: Today lists overdue callbacks ${todayView.overdueCallbacks.map((x) => x.taskId).join(", ") || "none"}; the record says ${recordOverdue.join(", ") || "none"}`);
    if (sorted(attention.overdueCallbacks.map((x) => x.taskId)) !== sorted(recordOverdue)) problem(`16: Needs attention lists overdue callbacks ${attention.overdueCallbacks.map((x) => x.taskId).join(", ") || "none"}; the record says ${recordOverdue.join(", ") || "none"}`);
    if (q.laterToday.length > 0) features.add("later-today");
    if ([...q.readyNow, ...q.laterToday].some((x) => x.reason === "rolled_over")) features.add("rolled-over");
    // Ready now: callbacks, then calls carried from an earlier day, then today's, each oldest first; calls skipped for now today go last, in the order skipped.
    const today = userDay(now);
    // The record's own order, from its own due times, compared whole, so a reordering of any two calls shows.
    const order = await recordReadyNow();
    const shown = q.readyNow.map((x) => x.taskId);
    if (shown.length === order.length && shown.join() !== order.join()) problem(`16: ready now is ${shown.join(", ")}; the record orders it ${order.join(", ")} (callbacks, then carried calls, then today's, oldest first; calls skipped for now today last)`);
    if (order.length > 1 && new Set(q.readyNow.map((x) => x.reason)).size > 1) features.add("ready-now-of-several-reasons");
    if (order.length > 1) features.add("two-ready-calls");
    if (shown.some((id) => (skips.get(id) ?? -Infinity) >= today.start)) features.add("skipped-call-last");
    // 4. Sent at most once.
    for (const ch of ["email", "sms"] as const) {
      const n = new Map<string, number>();
      for (const d of deliveries(ch)) n.set(`${d.subjectId}/${d.stepId}`, (n.get(`${d.subjectId}/${d.stepId}`) ?? 0) + 1);
      for (const [k, c] of n) if (c > 1) problem(`4: ${ch} ${k} was delivered ${c} times`);
    }
  }

  /**
   * New tasks placed on the user day of `t`, and committed tasks: placed earlier, open at its start (one
   * closed at that very instant, such as a call skipped at that rollover, was not carried into it), for
   * leads not stopped by then, on a day they can be listed: a call on a day its calling hours open, a
   * callback from its own day. A task counts as it stood at the day's start (a callback if the user's last
   * outcome on it before then asked for one), so the count is the same all day. Not counted: a call of a lead
   * a callback held at the day's start, and any call of a lead with no good number left (Q13), as of `t` (for
   * a past day, its last instant, when the most numbers had gone bad: the app's count only falls by that).
   */
  function dayCounts(all: readonly { s: Subject; task: CallTask }[], t: number): { placed: number; committed: number } {
    const { start: from, end } = userDay(t);
    const placed = all.filter((x) => x.task.placedWall >= from && x.task.placedWall < end).length;
    const committed = all.filter((x) => {
      if (x.task.placedWall >= from) return false;
      const tr = def(x.s).tracks.find((y) => y.id === x.task.trackId)!;
      const f = finishFacts(x.s, tr);
      const closed = f !== null && f.at <= from;
      const interested = interestedAt(x.s) < from;
      if (closed || interested || endLimitOf(x.s) < from || sequenceDoneAt(x.s, from - 1)) return false;
      const st = taskStateAt(x.s, x.task.trackId, from, true);
      const heldByAnother = all.some((y) => y.s.id === x.s.id && y.task.id !== x.task.id && y.task.placedWall < from && taskStateAt(y.s, y.task.trackId, from, true).kind === "callback" && !((finishFacts(y.s, def(y.s).tracks.find((z) => z.id === y.task.trackId)!)?.at ?? Infinity) <= from));
      if (heldByAnother || !goodPhoneAt(x.s, Math.min(end - 1, h.clock))) return false;
      // The day is the one of `t`, reckoned in the zones of `t`, as the app reckons it when asked.
      const zone = uz(t);
      const day = local(t, zone).day;
      return st.kind === "callback" ? local(st.callbackAt ?? Infinity, zone).day <= day : hoursOn(x.s, x.task.trackId, day, zone, zoneFor(x.s, t));
    }).length;
    return { placed, committed };
  }

  /** After the drain, with every call worked: each lead has ended (18), and each phone track's finish is the record's. */
  function checkDrained(s: Subject, st: SubjectState, progress: EnrollmentProgress): void {
    // The one wait the drain accepts: a callback whose lead has no good number left, which only the user
    // can end (ticket 17's skip step); it is listed, overdue, and never dropped silently.
    if (stuck(s)) {
      features.add("callback-with-no-good-number");
      return;
    }
    if (st.subject.ended === null) problem(`18: ${s.id} is ${progress.status} after the drain (${JSON.stringify(progress.tracks.map((t) => [t.trackId, t.finishReason]))})`);
    if (st.callTasks.some((t) => t.open) && st.subject.ended === null) problem(`18: ${s.id} still has an open call task after the drain`);
  }
  /**
   * Activity against the record, after the drain (ticket 16; the rule of ticket 13's track runs): the timeline
   * lists exactly what the record derives from its own starts and finishes, the providers' logs and the replies.
   * Email and SMS tracks of the main sequence, and of the win-back branch once the lead entered it; a branch the
   * lead never entered says nothing, and neither does a main track dropped for win-back (review bot on 654907b).
   * Entries are compared as kind, channel, track label and message number; "ended" against the stored ending.
   */
  async function checkActivity(s: Subject, progress: EnrollmentProgress): Promise<void> {
    const now = h.clock;
    const recordId = await recordOf(s);
    if (recordId === null) return;
    const campaignId = campaigns[s.campaign]!.id;
    const shown = (await h.request<ActivityView>("GET", `/api/${s.person ? "people" : "companies"}/${recordId}/activity`)).body.entries
      .filter((e) => e.campaign.id === campaignId)
      .map((e) => (e.kind === "replied" ? `replied|${e.channel}` : e.kind === "ended" ? "ended" : e.kind === "call" ? `call|${e.track.label}|${e.outcome}|${e.declinedPath ?? "-"}` : `${e.kind}|${e.channel}|${e.track.label}|${"stepNumber" in e && e.stepNumber !== null ? e.stepNumber : "-"}`))
      .sort();
    const expected: string[] = [];
    // Every outcome the user logged on the lead, skip for now included, a decline with the path it took (ticket 14b, 16).
    for (const o of logged) if (o.accepted && o.subjectId === s.id) expected.push(`call|${trackLabel(def(s), { id: o.trackId, channel: "call" }).label}|${o.outcome}|${o.declinedPath ?? "-"}`);
    const end = endLimitOf(s);
    const atLaunch = noChannelAt(s) === runStartOf(s) && runStartOf(s) <= now;
    for (const t of tracksOf(s)) {
      const ch = t.channel;
      const label = trackLabel(def(s), t).label;
      if (atLaunch) {
        // The one entry not read from a stored outcome: no usable channel at launch, said for each main track.
        if (t.branch === "main") expected.push(`skipped|${ch}|${label}|-`);
        continue;
      }
      if (ch !== "call") {
        t.steps.forEach((st, i) => {
          const d = deliveryOf(ch, s.id, st.id);
          if (d && knownAt(ch, d) <= now) expected.push(`sent|${ch}|${label}|${i + 1}`);
        });
      }
      const f = finishFacts(s, t);
      const start = startOf(s, t);
      const started = start !== null && start <= now && start < end && !(f?.reason === "dropped_for_win_back" && f.at <= start);
      if (!started) continue;
      const rule = t.start;
      const before = rule.kind === "after" ? def(s).tracks.find((x) => x.id === rule.trackId) : undefined;
      const released = before ? finishFacts(s, before)?.reason : undefined;
      if (released === "skipped_missing_channel" || released === "failed_bad_destination") expected.push(`released|${ch}|${label}|-`);
      if (f?.reason === "skipped_missing_channel") expected.push(`skipped|${ch}|${label}|-`);
      if (f?.reason === "failed_bad_destination") expected.push(`address_bad|${ch}|${label}|-`);
      if (t.branch === "win_back") features.add("activity-in-win-back");
      if (f?.reason === "dropped_for_win_back") features.add("activity-of-a-dropped-track");
    }
    if (progress.status === "replied") {
      // The first reply stopped it; replies on both channels at one instant reach the app in an order the record does not model.
      const mail = Math.min(Infinity, ...email.replyLog.filter((r) => r.subjectId === s.id).map((r) => r.at));
      const firstText = sms.deliveryLog.find((d) => d.subjectId === s.id)?.at ?? Infinity;
      const text = Math.min(Infinity, ...sms.replyLog.filter((r) => r.to === numbers[s.campaign]!.id && r.from === mobileOf(s) && r.at >= firstText).map((r) => r.at));
      expected.push(mail === text ? (shown.find((x) => x.startsWith("replied|")) ?? "replied|email") : `replied|${mail < text ? "email" : "sms"}`);
    } else if (progress.status === "sequence_finished_no_response" || progress.status === "finished_no_usable_channel") expected.push("ended");
    expected.sort();
    if (def(s).tracks.some((t) => t.branch === "win_back")) features.add(Number.isFinite(winBackAt(s)) ? "activity-compared-in-win-back" : "activity-compared-beside-a-branch-never-entered");
    if (JSON.stringify(shown) !== JSON.stringify(expected)) problem(`activity: ${s.id} shows ${JSON.stringify(shown)}; the record has ${JSON.stringify(expected)}`);
  }
  /** The person's record, or the company lead's. */
  async function recordOf(s: Subject): Promise<string | null> {
    const name = s.person ? s.person.name : s.company.name;
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?q=${encodeURIComponent(name)}`)).body.rows;
    return rows.find((r) => (s.person ? r.name === name && r.kind === "person" : r.kind === "company"))?.id ?? null;
  }

  /** Held by a callback that cannot be logged: the lead has no good number left. */
  const stuck = (s: Subject) => heldAt(s, h.clock) && !goodPhoneAt(s, h.clock) && h.clock < endLimitOf(s);

  /**
   * Ready now by the record: open tasks of running leads inside the prospect's calling hours, the ones not
   * skipped for now today oldest due first by the record's own due time, then by lead and step, and the
   * ones skipped today after them in the order skipped.
   */
  async function recordReadyNow(): Promise<string[]> {
    const now = h.clock;
    const today = userDay(now);
    const ready: { id: string; skippedAt: number | null; rank: number; due: number; subjectId: string; stepId: string }[] = [];
    for (const id of subjects.keys()) {
      const st = await h.store.engine.subject(id, now);
      const s = subjects.get(id)!;
      for (const task of st?.callTasks ?? []) {
        knownTasks.set(task.id, { subjectId: id, trackId: task.trackId });
        notePlacement(id, task);
        if (!listedByRecord(task.id, now)) continue;
        const state = taskStateAt(s, task.trackId, now);
        if (state.kind === "callback" ? now < (state.callbackAt ?? Infinity) : !inWindow(windowOf(s, task.trackId), zoneFor(s, now), now)) continue;
        const tr = def(s).tracks.find((t) => t.id === task.trackId)!;
        const skippedAt = skips.get(task.id) ?? null;
        const reason = reasonByRecord(s, task.trackId, now);
        // Callbacks first, by the time asked for; then calls carried from an earlier day; then today's.
        const rank = reason === "callback" || reason === "overdue" ? 0 : reason === "due" ? 2 : 1;
        ready.push({ id: task.id, skippedAt: skippedAt !== null && skippedAt >= today.start ? skippedAt : null, rank, due: state.kind === "callback" ? (state.callbackAt ?? Infinity) : (startOf(s, tr) ?? Infinity), subjectId: id, stepId: task.stepId });
      }
    }
    ready.sort((a, b) =>
      (a.skippedAt === null) !== (b.skippedAt === null) ? (a.skippedAt === null ? -1 : 1)
      : a.skippedAt !== null && b.skippedAt !== null && a.skippedAt !== b.skippedAt ? a.skippedAt - b.skippedAt
      : a.rank !== b.rank ? a.rank - b.rank
      : a.due !== b.due ? a.due - b.due
      : a.subjectId !== b.subjectId ? (a.subjectId < b.subjectId ? -1 : 1)
      : a.stepId < b.stepId ? -1 : 1,
    );
    return ready.map((x) => x.id);
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

  /**
   * Moves the clock to around an instant at which something falls due on the list: the user's next day (the
   * rollover every skip-limit expiry happens at) or a callback's time, on either side of it. The worker ticks
   * up to two seconds before it and not again, so the user's next action reaches the app between that instant
   * and the worker's next tick; the record judges it as of its own instant, as for any action.
   */
  async function aroundADueInstant(): Promise<boolean> {
    const now = h.clock;
    const instants = [startOfDay(local(now, uz(now)).day + 1, uz(now)), ...logged.filter((o) => o.accepted && o.callbackAt !== null && o.callbackAt > now + 5_000).map((o) => o.callbackAt ?? 0)];
    const target = instants[Math.floor(staleRand() * instants.length)] ?? now;
    const side = [-1_000, 0, 1_000, 30_000][Math.floor(staleRand() * 4)] ?? 0;
    if (target + side <= now + 2_000) return false;
    await h.advanceTo(target - 2_000);
    h.clock = Math.max(h.clock, target + side);
    features.add(side < 0 ? "acted-just-before-a-due-instant" : target === instants[0] ? "acted-after-a-rollover-before-the-tick" : "acted-after-a-callback-time-before-the-tick");
    return true;
  }
  const staleRand = random(seed ^ 0x15a);
  const staleItem = <T>(items: readonly T[]): T => items[Math.floor(staleRand() * items.length)] ?? items[0]!;

  /**
   * An input the engine's timing reads moves (council on 228cd3b): the call list's zone (the settings), or one
   * person's or company's zone (a re-import). Done at the instant reached by `aroundADueInstant`, before the
   * worker's tick: the route applies what fell due under the old zone first, and the record judges each
   * rollover with the zones in force just before it.
   */
  async function moveAZone(): Promise<void> {
    const now = h.clock;
    if (staleRand() < 0.4 && userZones.length < 3) {
      const zone = staleItem(["Europe/London", "America/New_York", "Asia/Kolkata"].filter((z) => z !== uz(now)));
      const res = await h.request("PUT", "/api/call-settings", { dailyCapacity: capacity, userZone: zone });
      if (res.status !== 200) problem(`settings refused: ${JSON.stringify(res.body)}`);
      userZones.push({ at: now, zone });
      features.add("call-list-zone-moved");
      return;
    }
    const entity = staleItem([...people.map((p) => ({ key: p.key, initial: p.zone, company: p.company })), ...companies.map((c, i) => ({ key: c.key, initial: c.zone, company: i }))]);
    const zone = staleItem(ZONES.filter((z) => z !== "" && z !== zoneOfKey(entity.key, entity.initial, now)));
    zoneChanges.set(entity.key, [...(zoneChanges.get(entity.key) ?? []), { at: now, zone }]);
    const campaign = campaigns.find((c) => c.companies.includes(entity.company));
    if (campaign) await h.reimport(campaign.id, rowsFor(campaign));
    features.add(entity.key.startsWith("p") ? "a-person-zone-moved" : "a-company-zone-moved");
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
      // Work the list: every call the user starts is the focused one. Sometimes the user acts between a due
      // instant and the worker's tick (review bot on eda5fa0); the worker's tick then follows.
      // Sometimes, when a lead held by a callback has only the company main line left, a colleague's call on that
      // line is a wrong number: the callback is then one no call can be logged on (Q13).
      if (staleRand() < 0.5 && (await strandACallback())) {
        await checkAll(false);
        continue;
      }
      const stale = staleRand() < 0.3 && (await aroundADueInstant());
      if (stale && staleRand() < 0.35) await moveAZone();
      const worked = await workFocus(false);
      if (stale) {
        await h.tick();
      } else if (worked) await checkNumbers();
      else await h.advanceTo(h.clock + pick([HOUR, 3 * HOUR]));
    } else if (r < 0.8) {
      // An outcome on a task the user is not shown now: closed, of an ended lead, or outside its calling day.
      const ids = [...knownTasks.keys()];
      if (ids.length > 0) {
        // Often a call redialed to tomorrow (refused today), sometimes a redial with an outcome it does not follow.
        const redialed = ids.filter((id) => {
          const k = knownTasks.get(id);
          const s = k ? subjects.get(k.subjectId) : undefined;
          return s !== undefined && k !== undefined && redialedLast(s, k.trackId);
        });
        const outcome = pick(OUTCOMES);
        const extra = { redial: chance(0.25), callbackAt: outcome === "callback_requested" ? callbackTime() : null };
        const target = redialed.length > 0 && chance(0.5) ? pick(redialed) : pick(ids);
        // Ticket 16: sometimes a declined path with an outcome it does not go with, or not interested on any known task.
        if (declineRand() < 0.2) await logOutcome(target, dpick(["no_answer", "not_interested", "not_interested"] as const), (view) => view.numbers.find((n) => !n.bad)?.detailId ?? null, { declinedPath: dpick(["stop", "continue", "win_back"] as const) });
        else await logOutcome(target, outcome, (view) => view.numbers.find((n) => !n.bad)?.detailId ?? null, extra);
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
  const failed = () => problems.length > 0;
  if (problems.length === 0 && options.drain !== false && !stopped()) {
    // The drain: day by day, the user works every call on the list until no lead has work left.
    // A problem found ends the drain, as it ends the events: the run reports it. (Asked through a call: the
    // enclosing check narrows `problems.length` to 0, and `problem` adds to it from inside the loop.)
    for (let step = 0; step < 400 && !stopped() && !failed(); step++) {
      for (let i = 0; i < 30 && !failed(); i++) {
        await h.advanceTo(h.clock + MINUTE);
        if (!(await workFocus(true))) break;
      }
      // Done when no lead has work left, but for a callback no number can be logged on (checked below).
      const running = await h.store.engine.runningSubjectIds();
      if (running.every((id) => stuck(subjects.get(id)!))) break;
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
    const sj = subjects.get(id)!;
    // Ticket 16's behaviours.
    for (const p of st?.tracks ?? []) {
      if (p.finishReason === "skipped_declined") {
        const later = p.startedAt !== null && p.finishedAt === p.startedAt && (st?.callTasks.every((t) => t.trackId !== p.trackId) ?? true);
        // A phone track that started after the decline instant, on a later tick, is the one a lifted bar would call.
        features.add(!later ? "an-open-call-skipped-as-declined" : (p.finishedWall ?? 0) > (declineOf(sj)?.at ?? Infinity) ? "a-later-phone-track-skipped-as-declined" : "a-phone-track-released-by-the-decline-skipped");
      }
      if (p.finishReason === "dropped_for_win_back") features.add(p.startedAt === null ? "an-unstarted-main-track-dropped" : "a-started-main-track-dropped");
    }
    if (st?.subject.ended === "replied" && st.subject.branch === "win_back") features.add("replied-in-win-back");
    for (const p of st?.tracks ?? []) {
      if (p.finishReason !== "skipped_unworked") continue;
      features.add("skipped-unworked");
      if (acceptedOn(sj, p.trackId).some((o) => o.redial)) features.add("a-redial-skipped-from-its-original-due-date");
      if (def(sj).tracks.some((t) => t.start.kind === "after" && t.start.trackId === p.trackId && st?.tracks.find((x) => x.trackId === t.id)?.startedAt != null)) features.add("an-expiry-released-a-track");
    }
  }
  return result();

  function result(): CallRunResult {
    return { problems, stats: { calls: logged.filter((o) => o.accepted && o.outcome !== "skip_for_now").length, tasks: knownTasks.size, subjects: subjects.size, ticks: h.ticks, writes: h.writes, features: [...features] } };
  }
}
