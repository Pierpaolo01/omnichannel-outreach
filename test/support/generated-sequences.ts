import { ENGINE_PARAMS, isLive } from "../../src/domain/sequence/attempt.ts";
import type { CampaignDefinition, StepDefinition } from "../../src/domain/sequence/definition.ts";
import type { Attempt, ProviderWork, SubjectState } from "../../src/domain/sequence/state.ts";
import type { Rules } from "../../src/server/engine/rules.ts";
import type { CompanyRecord, EnrollmentProgress, LeadSearchResult, NeedsAttention, OutreachStatus, PersonRecord } from "../../src/shared/api.ts";
import { Crash, EngineHarness, TransientError, quickWait } from "./engine-harness.ts";
import { business, person, type ExportRows } from "./export-builder.ts";
import { FAKE_MODES, type FakeAccount, type FakeMode, type HandoverLogEntry } from "./fake-email-port.ts";
import { dueAfter, firstOpen, higherPriority, inWindow, leadTimeOf, local, renderCopy, zoneOf, type Hours } from "./sequence-model.ts";

/**
 * Generated sequences for the engine core (ADR 0003 9.2, ticket 12 row of 9.3), run through the
 * real HTTP app and SQLite store against the fake email provider, on a clock the test advances.
 *
 * Generated: one or two campaigns, each with one email track of 1-5 steps, waits, windows
 * (overnight ones too) and zones with daylight-saving changes in the period; leads with and
 * without email, in several zones, one person in both campaigns; 1-3 inboxes shared by the
 * campaigns with small capacities and k of 1 or 2; every fake mode; replies; bounces, invalid and
 * block-listed addresses and unexplained skips; addresses marked bad elsewhere; re-imports that
 * change titles, add newer addresses and enroll new leads after launch; sender trouble, quota and
 * rate-limit refusals; pre-send checks that cannot run; crashes at every outbox stage; late and
 * duplicated answers; the user marking unresolved attempts not sent; and user events injected
 * between evaluate and apply and between the claim and the handover. Each run ends with a drain.
 *
 * Checked after every event against the fake's own logs and the independent record in
 * sequence-model.ts: invariants 1-6, 8-13, 18-21, 24 and 26 of ADR 0003 section 8.
 */

export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ZONES = ["Europe/London", "America/New_York", "Europe/Paris", "Asia/Kolkata", "Australia/Sydney", ""];
const { SETTLING, MAX_CALLS, MAX_QUEUED_LOOKUPS } = ENGINE_PARAMS;

// ---------------------------------------------------------------------------------------------
// The world: fictitious companies and people, and what the record knows about them over time.

interface WorldPerson {
  readonly key: string;
  readonly company: number;
  readonly name: string;
  /** Title history: [number of send calls the provider had received when it changed, title]. */
  readonly titles: [number, string][];
  /** Address history: [time added, address]. */
  readonly emails: [number, string][];
  readonly phone: string | null;
  readonly zone: string;
  /** Imported from the start, or only by a later re-import. */
  readonly late: boolean;
}

interface WorldCompany {
  readonly key: string;
  readonly name: string;
  readonly city: string;
  readonly zone: string;
  readonly inbox: string | null;
  readonly line: string;
}

interface SubjectRecord {
  readonly id: string;
  readonly campaign: number;
  readonly person: WorldPerson | null;
  readonly company: WorldCompany;
  readonly enrolledAt: number;
}

interface CampaignRecord {
  id: string;
  readonly definition: CampaignDefinition;
  readonly companies: number[];
  launchedAt: number | null;
}

type Pick = <T>(items: readonly T[]) => T;

function steps(rand: () => number, pick: Pick): StepDefinition[] {
  const n = 1 + Math.floor(rand() * 5);
  const out: StepDefinition[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `s${i + 1}`,
      waitDays: i === 0 ? 0 : pick([0, 1, 1, 2, 2, 3, 4]),
      subject: i === 0 || rand() < 0.2 ? pick(["Hello {{first_name|there}}", "A question for {{company}}", "Quick note"]) : "",
      body: pick(["Hi {{first_name|there}}, a note for {{company}}.", "As {{title|the team}} at {{company}}, you may like this.", "Following up, {{first_name|there}}.", "A thought for you as {{title|the lead}}."]),
      threading: i === 0 ? "new_subject" : rand() < 0.2 ? "new_subject" : "continue_thread",
      removed: false,
    });
  }
  return out.map((s) => (s.threading === "new_subject" && !s.subject ? { ...s, subject: "Another thought" } : s));
}

function windowOf(rand: () => number, pick: Pick, after: readonly Hours[] | null = null): Hours[] {
  // Sometimes this campaign's window opens where the other's closes, on the same days (the
  // verification's capacity reproduction: windows 09-10 and 10-17 on one inbox).
  if (after && after.length > 0 && after[0]!.start < after[0]!.end && after[0]!.end < 23 && rand() < 0.3) {
    return after.map((w) => ({ day: w.day, start: w.end, end: Math.min(24, w.end + pick([1, 3, 7])) }));
  }
  const kind = rand();
  if (kind < 0.2) return [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
  if (kind < 0.3) {
    // A one-hour window: a retry or a recovered send often finds it closed.
    const start = pick([8, 9, 10, 15]);
    return [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start, end: start + 1 }));
  }
  const days = [0, 1, 2, 3, 4, 5, 6].filter(() => rand() < 0.6);
  const chosen = days.length > 0 ? days : [pick([1, 2, 3, 4, 5])];
  if (kind < 0.4) return chosen.map((day) => ({ day, start: 20, end: 3 })); // overnight
  const start = pick([6, 8, 9, 10, 13]);
  const end = Math.min(24, start + pick([3, 5, 8, 10]));
  return chosen.map((day) => ({ day, start, end }));
}

// ---------------------------------------------------------------------------------------------

export interface RunOptions {
  readonly rules?: Partial<Rules>;
  /** The unlimited-capacity variant: handovers follow the record's due instants up to the pacing gap. */
  readonly unlimited?: boolean;
  readonly events?: number;
  /** Run the drain phase (invariants 18 and 26 at the end). On by default. */
  readonly drain?: boolean;
  /** A wall-clock instant (Date.now) after which the run stops early, as the search's time budget. */
  readonly deadline?: number;
}

export interface RunResult {
  readonly problems: string[];
  readonly stats: { sends: number; calls: number; crashes: number; subjects: number; ticks: number; modes: readonly FakeMode[]; features: readonly string[] };
}

/** The invariants a problem names: the numbers before its first colon ("1/20: ..." names 1 and 20). */
export function invariantsOf(problem: string): string[] {
  return (problem.split(":")[0] ?? "").split("/").map((x) => x.trim());
}

/** The store's forward-only guards: they refuse a write that would move stored progress backwards. */
const FORWARD_ONLY = [/a step result is never (changed|deleted)/, /the freezes record is append-only/, /a closed freeze never reopens/, /UNIQUE constraint failed: freezes\.subject_id/];

export async function runSequence(seed: number, options: RunOptions = {}): Promise<RunResult> {
  try {
    return await runSequenceUnguarded(seed, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A write computed from state that has since moved on is refused by construction (invariant 24).
    const id = FORWARD_ONLY.some((r) => r.test(message)) ? "24" : "throw";
    return { problems: [`${id}: the engine threw: ${message}`], stats: { sends: 0, calls: 0, crashes: 0, subjects: 0, ticks: 0, modes: [], features: [] } };
  }
}

async function runSequenceUnguarded(seed: number, options: RunOptions): Promise<RunResult> {
  const rand = random(seed);
  const pick: Pick = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(rand() * items.length)];
    if (item === undefined) throw new Error("empty pick");
    return item;
  };
  const chance = (p: number) => rand() < p;
  const unlimited = options.unlimited ?? false;
  const problems: string[] = [];
  const problem = (what: string) => {
    if (problems.length < 25) problems.push(what);
  };

  // Start between 19 and 30 October 2026, so London and New York change clocks inside the run.
  const start = Date.parse("2026-10-19T00:00:00Z") + Math.floor(rand() * 11 * DAY) + Math.floor(rand() * 24) * HOUR;

  // A profile biases the configuration toward an event order a review finding needs; the run within
  // it is as random as any other (PR 37 review round 1).
  const profile = pick(["open", "open", "open", "lagging-capacity", "inherited-send", "slow-slot", "unknown-then-not-sent", "lookup-first"] as const);

  // Modes: one to three, drawn per call. The unlimited variant keeps to modes that do not hold work.
  const modes: FakeMode[] = unlimited
    ? [profile === "lookup-first" ? "lookup-before-event" : pick(["honest", "late-send", "duplicate-and-reorder", "lost-response", "same-key-replays"] as const)]
    : profile === "lagging-capacity" || profile === "inherited-send" ? ["lookup-lags", ...(chance(0.5) ? (["lookup-lags", "honest"] as const) : [])]
    : profile === "slow-slot" ? [pick(["5xx", "always-unknown", "silent-send"] as const), "always-unknown"]
    : profile === "unknown-then-not-sent" ? ["lookup-unknown-then-not-sent", "honest"]
    : profile === "lookup-first" ? ["lookup-before-event", ...(chance(0.5) ? (["honest"] as const) : [])]
    : [...new Set([pick(FAKE_MODES), pick(FAKE_MODES), ...(chance(0.5) ? [pick(FAKE_MODES)] : [])])];

  const single = profile === "lagging-capacity" || profile === "slow-slot" || profile === "unknown-then-not-sent";
  const inboxCount = unlimited ? 8 : single ? 1 : 1 + Math.floor(rand() * 3);
  const accounts: FakeAccount[] = Array.from({ length: inboxCount }, (_, i) => ({
    id: `inbox-${String.fromCharCode(97 + i)}`,
    capacity: unlimited ? 1000 : single ? 1 : pick([1, 2, 3, 5, 8]),
    // Null: the ADR's default gap from the windows the inbox serves (ruling 10).
    gapMs: unlimited ? MINUTE : profile === "slow-slot" ? null : pick([null, null, MINUTE, 2 * MINUTE, 5 * MINUTE, 20 * MINUTE]),
    k: unlimited ? 10 : single ? 1 : pick([1, 2]),
    healthy: true,
    quotaAvailable: true,
    resetZone: pick(["UTC", "UTC", "America/New_York"]),
  }));

  const companies: WorldCompany[] = [
    { key: "c1", name: "Harbour Lane Physio", city: "London", zone: "Europe/London", inbox: null, line: "+442079460101" },
    { key: "c2", name: "Northgate Dental", city: "Leeds", zone: pick(ZONES), inbox: null, line: "+442079460202" },
    { key: "c3", name: "Elm Street Clinic", city: "Bath", zone: pick(ZONES), inbox: "hello@elm.example", line: "+442079460303" },
  ];
  const firstNames = ["Pat", "Sam", "Nia", "Omar", "Grace", "Ravi", "Lena", "Daniel"];
  const people: WorldPerson[] = firstNames.map((first, i) => {
    const hasEmail = i === 0 || chance(0.8);
    return {
      key: `p${i + 1}`,
      company: i < 4 ? 0 : 1,
      name: `${first} ${["Oneil", "Lee", "Cole", "Reed", "Okafor", "Patel", "Ward", "Price"][i] ?? "Doe"}`,
      titles: [[0, pick(["Owner", "Clinic director", "Practice manager"])]],
      emails: hasEmail ? [[0, `${first.toLowerCase()}@${i < 4 ? "harbour" : "northgate"}.example`]] : [],
      phone: `+4477009001${String(i).padStart(2, "0")}`,
      zone: pick(ZONES),
      late: i >= 6,
    };
  });

  const h = new EngineHarness({ start, accounts, modes, random: random(seed ^ 0x5eed), engine: { waitFor: quickWait }, ...(options.rules ? { rules: options.rules } : {}) });
  // The search's time budget bounds every advance, the drain's included, so no run can postpone it.
  h.stopAt = options.deadline ?? null;
  const fake = h.fake;
  fake.withdrawAnswers = unlimited ? "honest" : profile === "lagging-capacity" ? "unknown-sends" : pick(["honest", "unknown-cancels", "unknown-sends"] as const);
  fake.overlapMs = pick([5, 15, 60]) * MINUTE;
  /** Each inbox's capacity over time, as the record knows it. */
  const capacityHistory = new Map(accounts.map((a) => [a.id, [[0, a.capacity]] as [number, number][]]));
  /** Clock advances injected between a send's authorization and its call, by attempt and call instant. */
  const injectedDelay = new Map<string, number>();
  /** Keys the user marked sent, and when. */
  const markedSent = new Map<string, number>();
  /** What this run exercised, for choosing a rule-covering fixed seed set (ruling 11). */
  const features = new Set<string>();
  /** Keys the user marked not sent, and when. */
  const markedNotSentKeys = new Map<string, number>();
  /** When a simulated crash happened: the restart does not count the reply wait lost to it. */
  const crashTimes: number[] = [];
  for (const p of people) {
    const address = p.emails[0]?.[1];
    if (!address) continue;
    const r = rand();
    if (r < 0.15) fake.bouncing.add(address);
    else if (r < 0.2 && !unlimited) fake.blocklisted.add(address);
    else if (r < 0.25 && !unlimited) fake.invalid.add(address);
    else if (r < 0.28 && !unlimited) fake.unexplainedSkip.add(address);
  }

  /** The title after `calls` send calls: changes are ordered by the call log, since several can share an instant. */
  const titleAt = (p: WorldPerson, calls: number) => [...p.titles].filter(([at]) => at <= calls).at(-1)?.[1] ?? "";
  const rowsFor = (campaign: CampaignRecord): ExportRows => ({
    businesses: campaign.companies.map((ci) => {
      const c = companies[ci]!;
      return business({ business_id: c.key, business_name: c.name, city: c.city, timezone: c.zone, phone_e164: c.line, general_emails: c.inbox ?? "" });
    }),
    people: people
      .filter((p) => campaign.companies.includes(p.company) && (!p.late || lateEnrolled.has(p.key)))
      .map((p) =>
        person({
          person_id: p.key,
          business_id: companies[p.company]!.key,
          full_name: p.name,
          title: titleAt(p, Infinity),
          timezone: p.zone,
          email: p.emails.at(-1)?.[1] ?? "",
          ...(p.emails.length === 0 && p.phone ? { dial_phone: p.phone, dial_phone_type: "mobile" } : {}),
        }),
      ),
  });
  const lateEnrolled = new Set<string>();

  const campaignCount = profile === "lagging-capacity" || chance(0.6) ? 2 : 1;
  const campaigns: CampaignRecord[] = [];
  for (let ci = 0; ci < campaignCount; ci++) {
    const definition: CampaignDefinition = {
      timezone: pick(["Europe/London", "America/New_York"]),
      callSkipLimitDays: 2,
      emailPool: accounts.filter((_, i) => ci === 0 || i > 0 || inboxCount === 1).map((a) => a.id),
      tracks: [
        {
          id: "t1",
          channel: "email",
          branch: "main",
          window:
            profile === "lagging-capacity"
              ? [0, 1, 2, 3, 4, 5, 6].map((day) => (ci === 0 ? { day, start: 9, end: 10 } : { day, start: 10, end: 17 }))
              : profile === "slow-slot" ? [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }))
              : profile === "inherited-send" ? [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: pick([9, 10]), end: pick([10, 11]) + 1 }))
              : windowOf(rand, pick, campaigns[0]?.definition.tracks[0]?.window ?? null),
          steps: steps(rand, pick),
          start: { kind: "entry" },
          removed: false,
        },
      ],
    };
    campaigns.push({ id: "", definition, companies: ci === 0 ? [0, 1, 2] : [1, 2], launchedAt: null });
  }

  // ------------------------------------------------------------------------------------------
  // Subjects as the record knows them.
  const subjects = new Map<string, SubjectRecord>();
  const discover = async () => {
    for (const [ci, c] of campaigns.entries()) {
      if (!c.id) continue;
      const found = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}&limit=500`)).body.rows;
      for (const row of found) {
        const e = row.enrollments.find((x) => x.campaign.id === c.id);
        if (!e || subjects.has(e.id)) continue;
        const p = row.kind === "person" ? (people.find((x) => x.name === row.name) ?? null) : null;
        const company = row.kind === "person" ? companies[p?.company ?? 0]! : companies.find((x) => x.name === row.name)!;
        subjects.set(e.id, { id: e.id, campaign: ci, person: p, company, enrolledAt: h.clock });
      }
    }
  };

  // Bad marks the record knows of, by address, and when the app learns them.
  const badElsewhere = new Map<string, number>();
  /** For each address marked bad elsewhere, the last attempt number claimed before the mark (ids are sequential). */
  const badElsewhereAfter = new Map<string, number>();
  /** And the number of send calls the provider had received at the mark. */
  const badElsewhereCalls = new Map<string, number>();
  const attemptNumber = (id: string) => Number(id.split("-").at(-1));
  const markedNotSent = new Set<string>();

  // ------------------------------------------------------------------------------------------
  // Crashes and injected user events.
  let armed: string | null = null;
  let transient: string | null = null;
  let inject = 0;
  /** A user or prospect event aimed at one lead, injected while the engine is between two steps. */
  const eventOn = async (subjectId: string | null, prefer: "any" | "title" = "any", concurrentWorker = true) => {
    const r = prefer === "title" ? (chance(0.6) ? 0.99 : rand()) : rand();
    const target = subjectId ? subjects.get(subjectId) : pick([...subjects.values()]);
    const lastSent = target ? fake.deliveryLog.filter((d) => d.subjectId === target.id && d.at <= h.clock).at(-1) : undefined;
    if (r < 0.4 && lastSent) fake.prospectReplies(lastSent.destination);
    else if (r < 0.6 && target) await markBad(target);
    else if (r < 0.75 && !unlimited) {
      const sender = target ? (await h.store.engine.subject(target.id, h.clock))?.subject.emailSender : null;
      const a = accounts.find((x) => x.id === sender) ?? pick(accounts);
      a.healthy = false;
      await h.store.engine.updateAccount(a.id, { healthy: false });
    } else await reimport(target?.person ?? null);
    // A concurrent worker applies it before the main engine's next step, or, between a claim and
    // its handover, the change lands as stored facts alone, which the handover must re-check.
    if (concurrentWorker) await h.otherWorker();
  };
  const subjectOfAttempt = async (attemptId: string) => (await h.store.engine.attempt(attemptId))?.subjectId ?? null;
  /** Injections a run may make from inside the engine, whatever event is running. */
  let hookBudget = 0; // set once every campaign has launched
  const armedNow = () => {
    if (inject > 0 && chance(0.5)) {
      inject--;
      return true;
    }
    if (hookBudget > 0 && chance(0.25)) {
      hookBudget--;
      return true;
    }
    return false;
  };
  const maybeInject = async (subjectId: string | null, concurrentWorker = true) => {
    if (armedNow()) await eventOn(subjectId, "any", concurrentWorker);
  };
  const hooks = {
    crashPoint: (point: string) => {
      if (armed === point) {
        armed = null;
        crashTimes.push(h.clock);
        throw new Crash(point);
      }
      if (transient === point) {
        transient = null;
        // An error the worker loop logs and carries on from, with the same engine (ruling 5).
        features.add("transient-error");
        throw new TransientError(point);
      }
    },
    // Between a send's authorization commit and its call: a clock advance, and a reply reaching the
    // provider. Synchronous, as nothing asynchronous may happen there (ruling 2).
    afterAuthorization: (attemptId: string) => {
      if (unlimited || hookBudget <= 0 || !chance(0.3)) return;
      hookBudget--;
      const delay = pick([0, 30_000, 2 * MINUTE, 7 * MINUTE]);
      h.clock += delay;
      injectedDelay.set(`${attemptId}@${h.clock}`, delay);
      fake.advance();
      const delivered = fake.deliveryLog.filter((d) => d.at <= h.clock);
      if (delivered.length > 0 && chance(0.5)) fake.prospectReplies(pick(delivered).destination, chance(0.7));
    },
    // Between evaluate and apply: a concurrent worker's write, or a change to the lead's facts alone,
    // such as a re-import giving them an address (review bot, rules.ts:62).
    beforeApplyEvaluation: (subjectId: string) => maybeInject(subjectId, chance(0.5)),
    beforeHandover: async (attemptId: string) => maybeInject(await subjectOfAttempt(attemptId), chance(0.5)),
    beforeRetry: async (attemptId: string) => {
      if (armedNow()) {
        await eventOn(await subjectOfAttempt(attemptId), "title");
      }
    },
  };
  h.hooks = hooks;

  /** The user resolves unresolved attempts the provider never sent as "not sent" (ADR 0002 P3). */
  /** The user resolves unresolved attempts (ADR 0002 P3): "sent" when the provider did send, otherwise "not sent". */
  async function userMarks() {
    // The unresolved work Needs attention lists, by the attempt it names.
    const listed = (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body.heldCapacity.flatMap((x) => x.work);
    for (const item of listed) {
      const w = (await h.store.engine.unresolvedWork()).find((x) => x.subjectId === item.enrollmentId && x.stepId === item.stepId);
      if (!w) continue;
      if (fake.deliveryLog.some((d) => d.key === w.key && d.at <= h.clock)) {
        if (await h.engine.markAttempt(item.attemptId, "sent")) markedSent.set(w.key, h.clock);
        continue;
      }
      const accepted = await h.engine.markAttempt(item.attemptId, "not_sent");
      if (accepted && w.lookupAnswer === "queued") problem(`26: "mark not sent" accepted while the provider reports ${w.key} queued`);
      if (accepted !== item.canMarkNotSent) problem(`26: Needs attention says "not sent" ${item.canMarkNotSent ? "is" : "is not"} allowed for ${w.key}, but it was ${accepted ? "accepted" : "refused"}`);
      if (accepted) {
        markedNotSent.add(`${w.subjectId}/${w.stepId}`);
        markedNotSentKeys.set(w.key, h.clock);
        // 27. The user's decision settles the work at once: it holds no reservation from then on.
        const after = await h.store.engine.work(w.key);
        if (after?.settled !== "user_not_sent") problem(`27: work ${w.key} the user marked not sent is ${after?.settled ?? "unsettled"}`);
      }
    }
  }

  async function markBad(s: SubjectRecord) {
    const address = s.person?.emails.at(-1)?.[1];
    if (!address) return;
    const record = await h.request<PersonRecord>("GET", `/api/people/${await personId(s.person)}`);
    const detail = record.body.contactDetails.find((d) => d.value === address);
    if (!detail || detail.bad) return;
    await h.store.markContactDetailBad(detail.id);
    if (!badElsewhere.has(address)) {
      badElsewhere.set(address, h.clock);
      badElsewhereCalls.set(address, fake.handoverLog.length);
      const all = await Promise.all([...subjects.keys()].map((id) => h.store.engine.subject(id, h.clock)));
      badElsewhereAfter.set(address, Math.max(0, ...all.flatMap((x) => x?.attempts ?? []).map((a) => attemptNumber(a.id))));
    }
  }
  const personIds = new Map<string, string>();
  async function personId(p: WorldPerson): Promise<string> {
    const known = personIds.get(p.key);
    if (known) return known;
    const found = (await h.request<LeadSearchResult>("GET", `/api/leads?q=${encodeURIComponent(p.name)}`)).body.rows.find((r) => r.name === p.name);
    if (!found) throw new Error(`no record for ${p.name}`);
    personIds.set(p.key, found.id);
    return found.id;
  }

  // ------------------------------------------------------------------------------------------
  // Re-imports: titles change, newer addresses arrive, late people are enrolled.
  let reimports = 0;
  async function reimport(retitle: WorldPerson | null = null) {
    const now = h.clock;
    if (retitle) retitle.titles.push([fake.handoverLog.length, `Partner ${fake.handoverLog.length}`]);
    for (const p of people) if (chance(0.3)) p.titles.push([fake.handoverLog.length, pick(["Owner", "Clinic director", "Practice manager", "Lead physio"])]);
    const withEmail = people.filter((p) => p.emails.length > 0 && !p.late);
    if (chance(0.3) && withEmail.length > 0) {
      const p = pick(withEmail);
      p.emails.push([now, `${p.key}.new${++reimports}@mail.example`]);
    }
    // A phone-only person gains an address.
    const phoneOnly = people.filter((p) => p.emails.length === 0);
    if (chance(0.3) && phoneOnly.length > 0) {
      const p = pick(phoneOnly);
      p.emails.push([now, `${p.key}.found${++reimports}@mail.example`]);
    }
    if (chance(0.4)) for (const p of people.filter((x) => x.late)) lateEnrolled.add(p.key);
    const before = await progressSnapshot();
    for (const c of campaigns) if (c.id) await h.reimport(c.id, rowsFor(c));
    await discover();
    // Invariant 21: a re-import changes no existing subject's progress, status, deadlines or clock.
    const after = await progressSnapshot();
    for (const [id, snap] of before) if (after.get(id) !== snap) problem(`21: re-import moved the progress of ${id}`);
  }
  async function progressSnapshot(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of subjects.keys()) {
      const s = await h.store.engine.subject(id, h.clock);
      if (s) out.set(id, JSON.stringify([s.subject, s.tracks, s.results, s.attempts, s.freezes]));
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------
  // Setup: campaigns, imports, definitions, launch.
  for (const [ci, c] of campaigns.entries()) {
    const created = await h.createCampaign(`Campaign ${ci + 1}`, rowsFor(c), c.definition.timezone);
    c.id = created.campaign.id;
    await h.defineSequence(c.id, c.definition);
  }
  await discover();
  const priorityProbe = probeAtCall(h, problem, eligibleForSlot);
  fake.onHandover = priorityProbe;

  for (const [ci, c] of campaigns.entries()) {
    const wait = Math.floor(rand() * 3) * HOUR;
    if (ci === 0) h.clock += wait;
    else await h.advanceTo(h.clock + wait);
    const launched = await h.launch(c.id);
    if (launched.status !== 200) {
      problem(`launch refused: ${JSON.stringify(launched.body)}`);
      return { problems, stats: { sends: 0, calls: 0, crashes: 0, subjects: subjects.size, ticks: h.ticks, modes, features: [] } };
    }
    c.launchedAt = h.clock;
  }

  hookBudget = unlimited ? 0 : 8;

  // ------------------------------------------------------------------------------------------
  // Events.
  const history = new Map<string, { states: string[]; withdrawRequested: boolean; handedOnce: boolean }>();
  const finishedSnapshots = new Map<string, string>();
  const pendingDeadlines = new Map<string, number>();
  const startedAt = new Map<string, number>();

  /** Time passes; at any instant the user may resolve an unresolved attempt (ADR 0002 P3). */
  const advance = (span: number) =>
    h.advanceTo(h.clock + span, async () => {
      if (unlimited) return;
      // The user acts on Needs attention now and then, more often while something unresolved is listed there.
      const listed = (await h.store.engine.unresolvedWork()).length > 0;
      if (chance(listed ? 0.4 : 0.05)) await userMarks();
      // A lost response's acceptance arrives late, perhaps while a retry waits for its slot.
      if (fake.staleAnswers.length > 0 && chance(0.2)) {
        const late = fake.staleAnswers.splice(Math.floor(rand() * fake.staleAnswers.length), 1)[0];
        if (late) {
          features.add("late-acceptance");
          await h.engine.receiveLateAnswer(late.attemptId, late.answer);
        }
      }
    });

  const eventCount = options.events ?? 22;
  for (let e = 0; e < eventCount; e++) {
    const r = rand();
    if (r < 0.45) {
      const span = pick([10_000, 45_000, 2 * MINUTE, 7 * MINUTE, 20 * MINUTE, 2 * HOUR, 7 * HOUR, DAY, 2 * DAY, 3 * DAY]);
      inject = !unlimited && chance(0.3) ? 1 : 0;
      await advance(span);
      inject = 0;
    } else if (r < 0.55) {
      const delivered = fake.deliveryLog.filter((d) => d.at <= h.clock);
      if (delivered.length > 0) fake.prospectReplies(pick(delivered).destination, chance(0.75));
      await h.tick();
    } else if (r < 0.62) {
      await reimport();
      await h.tick();
    } else if (r < 0.66 && !unlimited) {
      const s = pick([...subjects.values()]);
      await markBad(s);
      await h.tick();
    } else if (r < 0.74 && !unlimited && profile !== "lagging-capacity") {
      const a = pick(accounts);
      const what = rand();
      if (what < 0.4) a.healthy = !a.healthy;
      else if (what < 0.7) a.quotaAvailable = !a.quotaAvailable;
      else fake.rateLimitedUntil.set(a.id, h.clock + pick([30_000, 5 * MINUTE, HOUR]));
      await h.tick();
    } else if (r < 0.78 && !unlimited) {
      if (chance(0.5)) fake.presendUnavailable = !fake.presendUnavailable;
      else {
        fake.portHangs = !fake.portHangs;
        features.add("port-hangs");
      }
      await h.tick();
    } else if (r < 0.87 && !unlimited) {
      const point = pick(["after_claim", "after_presend", "after_handover_commit", "after_call", "after_retry_commit", "after_lookup", "after_observe_event"]);
      if (chance(0.7)) armed = point;
      else transient = point;
      await advance(pick([MINUTE, 20 * MINUTE, 3 * HOUR]));
    } else if (r < 0.9) {
      const stale = fake.staleAnswers.splice(0);
      for (const s of stale) await h.engine.receiveLateAnswer(s.attemptId, s.answer);
      await h.tick();
    } else if (r < 0.94 && !unlimited) {
      await userMarks();
      await advance(pick([HOUR, 6 * HOUR]));
    } else {
      inject = unlimited ? 0 : 2;
      await advance(pick([MINUTE, HOUR, DAY]));
      inject = 0;
    }
    await checkAll(false);
    if (problems.length > 0) break;
    if (h.stopped) return { problems, stats: { sends: fake.deliveryLog.length, calls: fake.handoverLog.length, crashes: h.crashes.length, subjects: subjects.size, ticks: h.ticks, modes, features: ["stopped-at-deadline"] } };
  }

  // Drain: every account restored, no new events, time passes.
  if (problems.length === 0 && options.drain !== false) {
    armed = null;
    inject = 0;
    hookBudget = 0;
    fake.presendUnavailable = false;
    fake.portHangs = false;
    transient = null;
    fake.rateLimitedUntil.clear();
    for (const a of accounts) {
      a.healthy = true;
      a.quotaAvailable = true;
    }
    // "Enough time" at the configured capacity, so a reservation that is never released shows as
    // a lead that never sends (review round 2, ruling 2): three weeks, then a week at a time while
    // a running lead still has pending, unheld work (a narrow window can space five steps a week
    // apart, and capacity 1 a backlog a day apart), up to ten weeks.
    await h.advanceTo(h.clock + 21 * DAY);
    for (let week = 0; week < 7; week++) {
      let waiting = false;
      const stalled = new Set((await h.request<NeedsAttention>("GET", "/api/needs-attention")).body.stalledInboxes.map((x) => x.accountId));
      for (const id of await h.store.engine.runningSubjectIds()) {
        // Work still pending, not held and not waiting on a stalled inbox: a deadline or a window still to come.
        const progress = (await h.request<EnrollmentProgress>("GET", `/api/enrollments/${id}`)).body;
        if (progress.sender !== null && stalled.has(progress.sender)) continue;
        if (progress.tracks.some((t) => t.finishReason === null && t.nextStep !== null && t.hold === null)) waiting = true;
      }
      if (!waiting) break;
      await h.advanceTo(h.clock + 7 * DAY);
    }
    // A run stopped by its budget reports what it found before, not an unfinished drain.
    if (!h.stopped) await checkAll(true);
  }

  const finalAttempts = (await Promise.all([...subjects.keys()].map((id) => h.store.engine.subject(id, h.clock)))).flatMap((x) => x?.attempts ?? []);
  for (const c of fake.handoverLog) features.add(`mode:${c.mode}`);
  for (const r of fake.refusals) features.add(`refused:${r.reason}`);
  for (const w of fake.withdrawLog) features.add(`withdraw:${w.answer}`);
  const finalWork = (await Promise.all([...subjects.keys()].map((id) => h.store.engine.subject(id, h.clock)))).flatMap((x) => x?.work ?? []);
  for (const w of finalWork) {
    if (w.unresolvedSince !== null) features.add("unresolved");
    if (w.settled) features.add(`settled:${w.settled}`);
  }
  for (const a of finalAttempts) {
    if (a.endedBy) features.add(`ended-by:${a.endedBy}`);
    if (a.endedBy === "observed" && fake.lookupLog.some((l) => l.key === a.idempotencyKey && l.answer === "not-sent")) features.add("sent-after-not-sent");
  }
  if (h.crashes.length > 0) features.add("crash");
  if (injectedDelay.size > 0) features.add("advance-between-authorization-and-call");
  if (markedSent.size > 0) features.add("marked-sent");
  if (markedNotSentKeys.size > 0) features.add("marked-not-sent");
  if (fake.replyLog.some((r) => !r.onThread)) features.add("reply-off-thread");
  if (fake.replyLog.some((r) => r.onThread)) features.add("reply-on-thread");
  if (accounts.some((a) => a.gapMs === null)) features.add("default-gap");
  if (accounts.some((a) => a.k > 1)) features.add("k2");
  if (campaigns.length > 1) features.add("two-campaigns");
  features.add(`profile:${profile}`);
  if (fake.deliveryLog.some((d) => fake.bouncing.has(d.destination))) features.add("bounce");
  return {
    problems,
    stats: { sends: fake.deliveryLog.length, calls: fake.handoverLog.length, crashes: h.crashes.length, subjects: subjects.size, ticks: h.ticks, modes, features: [...features] },
  };

  // ------------------------------------------------------------------------------------------
  // The checks.

  async function checkAll(drained: boolean): Promise<void> {
    const now = h.clock;
    const states = new Map<string, SubjectState>();
    for (const id of subjects.keys()) {
      const s = await h.store.engine.subject(id, now);
      if (s) states.set(id, s);
    }
    const allAttempts = [...states.values()].flatMap((s) => s.attempts);
    const allWork = [...states.values()].flatMap((s) => s.work);

    for (const [id, s] of states) {
      const rec = subjects.get(id)!;
      const campaign = campaigns[rec.campaign]!;
      const def = campaign.definition;
      const track = def.tracks[0]!;
      const zone = zoneOf(rec.person?.zone ?? "", rec.company.zone, def.timezone);
      const runStart = Math.max(rec.enrolledAt, campaign.launchedAt ?? Infinity);
      const progress = (await h.request<EnrollmentProgress>("GET", `/api/enrollments/${id}`)).body;

      // 1. One status: the stored column equals the derived status, and the record allows it.
      const column = await storedStatus(rec, id);
      if (column !== progress.status) problem(`1: ${id} stores ${column} but derives ${progress.status}`);
      const allowed = expectedStatuses(rec, s, now, runStart);
      if (!allowed.has(progress.status)) {
        problem(`1/20: ${id} is ${progress.status}; the record allows ${[...allowed].join(" or ")} at ${new Date(now).toISOString()}`);
      }

      // 9. Frozen exactly when not running; a pending deadline never moves.
      const running = campaign.launchedAt !== null && s.subject.ended === null;
      if ((s.subject.clock.frozenSince === null) !== running) problem(`9: ${id} clock frozen=${s.subject.clock.frozenSince !== null} while running=${running}`);
      for (const p of s.tracks) {
        if (p.nextStepId !== null && p.finishedAt === null && p.dueAt !== null) {
          const key = `${id}/${p.nextStepId}`;
          const first = pendingDeadlines.get(key);
          if (first === undefined) pendingDeadlines.set(key, p.dueAt);
          else if (first !== p.dueAt) problem(`9: the pending deadline of ${key} moved from ${first} to ${p.dueAt}`);
        }
        // 6. A finished track never restarts; started once.
        const startKey = `${id}/${p.trackId}`;
        if (p.startedAt !== null) {
          const was = startedAt.get(startKey);
          if (was === undefined) startedAt.set(startKey, p.startedAt);
          else if (was !== p.startedAt) problem(`6: ${startKey} started twice`);
        }
        if (p.finishedAt !== null) {
          const snap = JSON.stringify([p.finishReason, p.finishedAt, p.nextStepId, p.dueAt, p.basisAt]);
          const was = finishedSnapshots.get(startKey);
          if (was === undefined) finishedSnapshots.set(startKey, snap);
          else if (was !== snap) problem(`6: finished track ${startKey} changed: ${was} -> ${snap}`);
          for (const a of s.attempts) if (a.trackId === p.trackId && a.claimedWall > (p.finishedWall ?? Infinity) && a.claimedWall > now - 1) problem(`6: ${startKey} got a new attempt after finishing`);
        }
      }

      // Deadlines equal the record's: each sent step's time and the next step's due time.
      const steps = track.steps;
      for (const result of s.results) {
        if (result.result !== "sent") continue;
        const attempt = s.attempts.find((a) => a.id === result.attemptId);
        // The step's send, by the record: its first delivery from work the user did not mark not
        // sent (that override exempts the step from at-most-once only, ruling 9).
        const delivery = stepDelivery(id, result.stepId);
        if (!attempt || !delivery || markedSent.has(attempt.idempotencyKey)) continue;
        const firstEnding = recordFirstEnding(rec, runStart, now);
        if (!firstEnding.certain) continue;
        const sentAt = Math.max(delivery.at, attempt.handedWall ?? 0);
        const point = leadTimeOf(sentAt, runStart, firstEnding.at !== null && firstEnding.at <= sentAt ? firstEnding.at : null);
        if (result.at !== point.at || result.atWall !== point.wall) {
          problem(`9: ${id}/${result.stepId} sent at lead ${result.at}/${result.atWall}; the record says ${point.at}/${point.wall}`);
        }
        const i = steps.findIndex((x) => x.id === result.stepId);
        const next = steps[i + 1];
        const p = s.tracks.find((x) => x.trackId === track.id);
        if (next && p && p.nextStepId === next.id && !finishedBefore(p, result)) {
          const wall = dueAfter(point.wall, next.waitDays, zone);
          if (p.dueAt !== point.at + (wall - point.wall)) problem(`9: ${id}/${next.id} due at lead ${p.dueAt}; the record says ${point.at + (wall - point.wall)}`);
          if (running && p.dueWall !== wall) problem(`9: ${id}/${next.id} due ${new Date(p.dueWall ?? 0).toISOString()}; the record says ${new Date(wall).toISOString()}`);
        }
      }

      // 13 and 19: every claim inside the window, to an address good at the time.
      for (const a of s.attempts) {
        if (!inWindow(track.window, zone, a.claimedWall)) problem(`13: ${a.id} claimed outside its window at ${new Date(a.claimedWall).toISOString()} (${zone})`);
        const bad = badAtFor(a.destination);
        const markedAfterClaim =
          (badElsewhere.get(a.destination) === bad && attemptNumber(a.id) <= (badElsewhereAfter.get(a.destination) ?? Infinity)) ||
          fake.refusals.some((r) => r.reason === "invalid_destination" && (r.attemptId === a.id || (r.destination === a.destination && r.at === a.claimedWall)));
        if (bad !== null && bad <= a.claimedWall && !markedAfterClaim) problem(`19: ${a.id} claimed ${a.destination} at ${new Date(a.claimedWall).toISOString()} after it was marked bad at ${new Date(bad).toISOString()} (elsewhere ${String(badElsewhere.get(a.destination))}, bounce ${fake.bouncing.has(a.destination)}, invalid ${fake.invalid.has(a.destination)}; state ${a.state} ${a.endedBy ?? ""})`);
      }
      // 5.5 and 1.3: the sender is fixed by the first handover that commits, never by a claim.
      const firstHanded = [...s.attempts].filter((a) => a.handedWall !== null).sort((a, b) => attemptNumber(a.id) - attemptNumber(b.id))[0];
      const firstCall = fake.handoverLog.find((c) => c.subjectId === id);
      if (s.subject.emailSender !== (firstHanded?.accountId ?? null)) problem(`1.3: ${id} has sender ${s.subject.emailSender ?? "none"}; its first handover committed on ${firstHanded?.accountId ?? "none"}`);
      if (firstCall && firstCall.sender !== s.subject.emailSender) problem(`1.3: ${id} was first called from ${firstCall.sender} but its sender is ${s.subject.emailSender ?? "none"}`);
      // 26. Work becomes unresolved only on an unknown or unvouched not-sent, after MAX_QUEUED_LOOKUPS queued answers, or when no attempt carries it.
      for (const w of s.work) {
        if (w.unresolvedSince === null) continue;
        const answers = fake.lookupLog.filter((l) => l.key === w.key && l.at <= w.unresolvedSince!).map((l) => l.answer);
        let queued = 0;
        for (let i = answers.length - 1; i >= 0 && answers[i] === "queued"; i--) queued++;
        const unattended = !s.attempts.some((a) => a.idempotencyKey === w.key && isLive(a));
        if (answers.at(-1) === "queued" && queued < MAX_QUEUED_LOOKUPS && !unattended) problem(`26: work ${w.key} became unresolved after only ${queued} queued answers`);
      }
      // 20. Correct endings.
      if (s.subject.ended === "sequence_finished_no_response" && s.tracks.some((p) => p.finishedAt === null)) problem(`20: ${id} finished with a track still open`);
    }

    // 3. At most one live and one sent attempt per step.
    const perStep = new Map<string, Attempt[]>();
    for (const a of allAttempts) perStep.set(`${a.subjectId}/${a.stepId}`, [...(perStep.get(`${a.subjectId}/${a.stepId}`) ?? []), a]);
    for (const [key, list] of perStep) {
      if (list.filter(isLive).length > 1) problem(`3: ${key} has two live attempts`);
      if (list.filter((a) => a.state === "sent").length > 1) problem(`3: ${key} has two sent attempts`);
      // 5. After a lookup said not sent, later attempts reuse its key until the work settles, and
      // never after (PR 37 review round 3): the record's settlement is a confirmed withdrawal or the user's mark.
      for (const a of list) {
        const settledAt = recordSettledAt(a.idempotencyKey);
        if (a.claimedWall > settledAt) problem(`5: ${a.id} was claimed carrying work ${a.idempotencyKey}, which had settled`);
      }
      const notSent = list.find((a) => a.endedBy === "lookup_not_sent");
      if (notSent) {
        const settledAt = recordSettledAt(notSent.idempotencyKey);
        for (const later of list.filter((a) => a.claimedWall > notSent.claimedWall)) {
          const reused = later.idempotencyKey === notSent.idempotencyKey;
          if (!reused && later.claimedWall < settledAt) problem(`5: ${later.id} took a new key after a not-sent lookup, before the work settled`);
          if (reused && later.claimedWall > settledAt) problem(`5: ${later.id} inherited the key of work that had settled`);
        }
      }
    }

    // 4. Sent at most once, on the delivery log.
    const deliveredSteps = new Map<string, number>();
    for (const d of fake.deliveryLog) deliveredSteps.set(`${d.subjectId}/${d.stepId}`, (deliveredSteps.get(`${d.subjectId}/${d.stepId}`) ?? 0) + 1);
    for (const [key, n] of deliveredSteps) if (n > 1 && !markedNotSent.has(key)) problem(`4: ${key} was delivered ${n} times`);

    // 5. Attempts only move forward.
    for (const a of allAttempts) {
      const hist = history.get(a.id) ?? { states: [], withdrawRequested: false, handedOnce: false };
      const last = hist.states.at(-1);
      if (last && last !== a.state) {
        const terminal = ["sent", "rejected", "withdrawn"];
        const order = ["claimed", "handed", "accepted"];
        if (terminal.includes(last) && !(last === "withdrawn" && a.state === "sent")) problem(`5: ${a.id} left terminal ${last} for ${a.state}`);
        if (order.includes(last) && order.includes(a.state) && order.indexOf(a.state) < order.indexOf(last)) problem(`5: ${a.id} moved back from ${last} to ${a.state}`);
      }
      if (hist.withdrawRequested && !a.withdrawRequested) problem(`5: ${a.id} cleared withdraw_requested`);
      const handedOnce = hist.handedOnce || a.state === "handed" || a.state === "accepted" || a.calls > 0;
      if (a.state === "withdrawn" && handedOnce && !["provider", "lookup_not_sent", "user"].includes(a.endedBy ?? "")) problem(`5: ${a.id} was withdrawn by the app (${a.endedBy}) after it may have reached the provider`);
      history.set(a.id, { states: [...hist.states, a.state], withdrawRequested: hist.withdrawRequested || a.withdrawRequested, handedOnce });
    }
    checkCallLog(allAttempts, allWork);

    // 10, from the provider's own delivery log: no inbox sends more than its capacity on any reset
    // day. The user's "not sent" releases the work's reservation (review round 2, ruling 2), so a
    // send the provider makes after that mark is the user's override, as for at-most-once (ruling 9).
    const overridden = (d: { key: string; at: number }) => markedBefore(d.key, d.at);
    for (const acc of accounts) {
      const perDay = new Map<number, number>();
      for (const d of fake.deliveryLog) if (d.sender === acc.id && !overridden(d)) perDay.set(local(d.at, acc.resetZone).day, (perDay.get(local(d.at, acc.resetZone).day) ?? 0) + 1);
      for (const [day, n] of perDay) {
        const capacity = Math.max(...(capacityHistory.get(acc.id) ?? []).filter(([at]) => local(at, acc.resetZone).day <= day).map(([, c]) => c));
        if (n > capacity) {
          const sends = fake.deliveryLog.filter((d) => d.sender === acc.id && !overridden(d) && local(d.at, acc.resetZone).day === day);
          const detail = sends.map((d) => `${d.key}@${new Date(d.at).toISOString().slice(11, 16)}${markedNotSentKeys.has(d.key) ? ` marked not sent ${new Date(markedNotSentKeys.get(d.key)!).toISOString().slice(5, 16)}` : ""}`);
          problem(`10: ${acc.id} sent ${n} times on reset day ${new Date(day * DAY).toISOString().slice(0, 10)} against a capacity of ${capacity} (${detail.join(", ")})`);
        }
      }
    }
    checkInFlight();

    // 26. No attempt waits forever.
    for (const a of allAttempts) {
      if (a.state === "claimed" && now - a.claimedWall > SETTLING) problem(`26: ${a.id} has been claimed since ${new Date(a.claimedWall).toISOString()}`);
      const w = allWork.find((x) => x.key === a.idempotencyKey);
      if ((a.state === "handed" || a.state === "accepted") && w?.unresolvedSince === null && now - (a.lastCallWall ?? a.claimedWall) > SETTLING * (MAX_QUEUED_LOOKUPS + 2)) {
        const looked = fake.lookupLog.filter((l) => l.key === a.idempotencyKey).map((l) => `${new Date(l.at).toISOString().slice(5, 16)} ${l.answer}`);
        problem(`26: ${a.id} has been ${a.state} since ${new Date(a.lastCallWall ?? 0).toISOString()} without settling (work ${w.settled ?? "unsettled"}, next lookup ${w.nextLookupWall === null ? "none" : new Date(w.nextLookupWall).toISOString()}, retry ${a.retry}, withdraw requested ${a.withdrawRequested}, lookups: ${looked.slice(-4).join(", ") || "none"} of ${looked.length})`);
      }
    }
    const attention = (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body;

    // 11, counted from the stored attempts: claimed, handed and accepted work, inheritors included, never exceeds k.
    for (const acc of accounts) {
      const live = allAttempts.filter((a) => a.accountId === acc.id && ["claimed", "handed", "accepted"].includes(a.state));
      if (live.length > acc.k) problem(`11: ${acc.id} holds ${live.length} claimed, handed or accepted attempts against k = ${acc.k}`);
    }

    // 27. Every held reservation belongs to provider work that is live, or unresolved and listed in
    // Needs attention under its inbox (review round 2, ruling 2); work the provider or the user
    // settled, by the record, holds none (review round 3).
    const listedKeys = new Set(attention.heldCapacity.flatMap((x) => x.work.map((item) => allAttempts.find((a) => a.id === item.attemptId)?.idempotencyKey)));
    for (const w of allWork) {
      const settledAt = recordSettledAt(w.key);
      if (w.settled !== null) continue;
      if (settledAt <= now) problem(`27: work ${w.key} still holds a reservation of ${w.accountId} though the record settled it at ${new Date(settledAt).toISOString()}`);
      if (allAttempts.some((a) => a.idempotencyKey === w.key && isLive(a))) continue;
      if (w.sentWall !== null) problem(`27: work ${w.key} holds a reservation of ${w.accountId} though it was sent`);
      else if (!listedKeys.has(w.key)) problem(`27: work ${w.key} holds a reservation of ${w.accountId} but is neither live nor listed in Needs attention`);
      else if (!attention.heldCapacity.some((x) => x.accountId === w.accountId && x.work.some((item) => item.enrollmentId === w.subjectId && item.stepId === w.stepId))) problem(`27: work ${w.key}'s held reservation is listed under another inbox`);
    }
    for (const acc of await h.store.engine.accounts(now)) {
      const holding = allAttempts.filter((a) => isLive(a) && a.accountId === acc.id);
      const old = holding.filter((a) => now - (a.lastCallWall ?? a.claimedWall) >= SETTLING);
      if (holding.length >= acc.k && old.length >= acc.k && !attention.stalledInboxes.some((x) => x.accountId === acc.id)) problem(`26: ${acc.id} is stalled but not listed in Needs attention`);
    }

    if (unlimited) checkUnlimited();

    // 18. Nothing is dropped: after the drain every subject is ended, or its track is held with a
    // reason, or its due step waits on an inbox Needs attention lists as stalled (5.4: account
    // problems hold no track, so this is how such a wait is shown).
    if (drained) {
      const stalled = new Set(attention.stalledInboxes.map((x) => x.accountId));
      for (const [id, s] of states) {
        if (s.subject.ended !== null) continue;
        const progress = (await h.request<EnrollmentProgress>("GET", `/api/enrollments/${id}`)).body;
        // Invariant 18 as amended: a running lead may wait on an inbox Needs attention lists, only
        // while the attempts holding it have latest answers unknown or queued (ruling 9).
        const usable = s.subject.emailSender !== null ? [s.subject.emailSender] : s.campaign.definition.emailPool;
        const holdersUnsettled = (accountId: string) =>
          allAttempts
            .filter((a) => isLive(a) && a.accountId === accountId)
            // A not-sent the transport cannot vouch for is read as unknown (5.3).
            .every((a) => {
              const answer = allWork.find((w) => w.key === a.idempotencyKey)?.lookupAnswer;
              return answer === "unknown" || answer === "queued" || (answer === "not-sent" && !a.retryable && !a.notSentIsFinal);
            });
        // Or every inbox it may use has all its daily sends held by unresolved work Needs attention lists (ruling 2).
        const heldFull = new Set(attention.heldCapacity.filter((x) => x.held >= x.capacity).map((x) => x.accountId));
        const waitsOnStalled = usable.length > 0 && usable.every((a) => (stalled.has(a) && holdersUnsettled(a)) || heldFull.has(a));
        // A follow-up held for want of a thread is right only when the step before it was settled by
        // the user's "sent" mark, so the provider gave no reference (ruling 1).
        for (const t of progress.tracks) {
          if (t.hold !== "no_thread" || !t.nextStep) continue;
          const steps = campaigns[subjects.get(id)!.campaign]!.definition.tracks[0]!.steps;
          const before = steps[steps.findIndex((x) => x.id === t.nextStep?.stepId) - 1];
          const delivered = before ? stepDelivery(id, before.id) : undefined;
          if (delivered && !markedSent.has(delivered.key)) problem(`18: ${id}/${t.nextStep.stepId} is held for want of a thread, though ${before?.id ?? ""} was sent with reference ${delivered.providerRef}`);
        }
        if (!progress.tracks.some((t) => t.hold !== null) && !waitsOnStalled) problem(`18: ${id} is ${progress.status} after the drain with nothing held (${JSON.stringify(progress.tracks.map((t) => [t.finishReason, t.nextStep]))})`);
      }
    }
  }

  /**
   * The checker's own reading of "met every handover predicate except the slot and the pre-send
   * check" (invariant 12, ruling 9), from the stored facts and the record, not the engine's guard.
   */
  function eligibleForSlot(st: SubjectState, a: Attempt, now: number): boolean {
    const rec = subjects.get(st.subject.id);
    if (!rec || st.subject.ended !== null || st.subject.leadPaused || st.campaign.launchedAt === null) return false;
    const def = campaigns[rec.campaign]!.definition;
    const track = def.tracks[0]!;
    const p = st.tracks.find((t) => t.trackId === a.trackId);
    if (!p || p.startedAt === null || p.finishedAt !== null || p.nextStepId !== a.stepId || p.dueAt === null) return false;
    if (st.results.some((r) => r.stepId === a.stepId)) return false;
    if (st.attempts.some((o) => o.id !== a.id && o.stepId === a.stepId && !["sent", "rejected", "withdrawn"].includes(o.state))) return false;
    const lead = (st.subject.clock.frozenSince ?? now) - st.subject.clock.frozenTotal;
    if (p.dueAt > lead) return false;
    if (!inWindow(track.window, zoneOf(rec.person?.zone ?? "", rec.company.zone, def.timezone), now)) return false;
    const account = accounts.find((x) => x.id === a.accountId);
    if (!account?.healthy || !account.quotaAvailable || (fake.rateLimitedUntil.get(a.accountId) ?? 0) > now) return false;
    if (st.subject.emailSender !== null ? st.subject.emailSender !== a.accountId : !def.emailPool.includes(a.accountId)) return false;
    const bad = badAtFor(a.destination);
    if (bad !== null && bad <= now) return false;
    const replied = replyTimes(st.subject.id).must;
    if (replied !== null && replied <= now) return false;
    const step = track.steps.find((x) => x.id === a.stepId);
    if (!step) return false;
    const data = mergeData(rec, fake.handoverLog.length);
    if (renderCopy(step.subject, data) === null || renderCopy(step.body, data) === null) return false;
    if (step.threading === "continue_thread" && !st.attempts.some((o) => o.trackId === a.trackId && o.state === "sent" && st.work.some((w) => w.key === o.idempotencyKey && w.providerRef !== null))) return false;
    // A reply from the address to the inbox is held for correlation (the stored fact): sends between them pause.
    if (st.pendingReplies.some((r) => r.inbox === a.accountId && r.address === a.destination.toLowerCase())) return false;
    return true;
  }

  /**
   * The latest instant the app may first observe a fact the provider shows at `v`: a clock advance
   * injected between an authorization and its call, later in the same pass, delays the next
   * observation to its end, and such advances chain.
   */
  function observedBy(v: number): number {
    const advances = [...injectedDelay].map(([key, delay]) => {
      const end = Number(key.split("@")[1]);
      return [end - delay, end] as const;
    });
    let t = v;
    for (let changed = true; changed; ) {
      changed = false;
      for (const [start, end] of advances) {
        if (start >= v && start <= t && end > t) {
          t = end;
          changed = true;
        }
      }
    }
    return t;
  }

  /** The step's send, by the record: its first delivery from work the user did not mark not sent. */
  /**
   * The user marked this work not sent at or before `at`, and the work was handed over before the
   * mark: a delivery of it then is the user's override (ruling 9; review round 3, Opus).
   */
  function markedBefore(key: string, at: number): boolean {
    const mark = markedNotSentKeys.get(key);
    if (mark === undefined || mark > at) return false;
    return (fake.handoverLog.find((c) => c.key === key)?.at ?? Infinity) <= mark;
  }

  /** When the record knows the work settled without a send: a confirmed withdrawal, or the user's mark. */
  function recordSettledAt(key: string): number {
    const withdrawn = fake.withdrawLog.find((x) => x.key === key && x.answer === "withdrawn")?.at ?? Infinity;
    return Math.min(withdrawn, markedNotSentKeys.get(key) ?? Infinity, markedSent.get(key) ?? Infinity);
  }

  function stepDelivery(subjectId: string, stepId: string) {
    return fake.deliveryLog.find((d) => d.subjectId === subjectId && d.stepId === stepId && !markedBefore(d.key, d.at));
  }

  /** When the app could first know of a delivery: its event, a lookup that confirmed it, or the user's mark. */
  function knownAt(d: { key: string; at: number; visibleAt: number }): number {
    const looked = fake.lookupLog.find((l) => l.key === d.key && l.answer === "sent" && l.at >= d.at)?.at ?? Infinity;
    return Math.min(d.visibleAt, looked, markedSent.get(d.key) ?? Infinity);
  }

  /** The record's pacing gap (ADR 0003 4.1): configured, else the shortest window served over capacity, at least a minute. */
  function recordGap(accountId: string, at: number): number {
    const acc = accounts.find((a) => a.id === accountId);
    if (!acc) return 0;
    if (acc.gapMs !== null) return acc.gapMs;
    const capacity = (capacityHistory.get(accountId) ?? []).filter(([t]) => t <= at).at(-1)?.[1] ?? acc.capacity;
    const hours = campaigns
      .filter((c) => c.definition.emailPool.includes(accountId))
      .flatMap((c) => c.definition.tracks[0]!.window.map((w) => (w.start < w.end ? w.end - w.start : 24 - w.start + w.end)));
    return hours.length === 0 ? MINUTE : Math.max(MINUTE, Math.floor((Math.min(...hours) * HOUR) / capacity));
  }

  /**
   * 11, from the provider's logs: when a new piece of work reaches an inbox, the work it already
   * holds whose outcome the app has not been told (no visible send, confirming or not-sent lookup,
   * refusal, confirmed withdrawal or user mark) is fewer than k.
   */
  function checkInFlight(): void {
    const firstCallOf = new Map<string, HandoverLogEntry>();
    for (const c of fake.handoverLog) if (!firstCallOf.has(c.key)) firstCallOf.set(c.key, c);
    const settledAt = (key: string): number => {
      const delivered = fake.deliveryLog.filter((d) => d.key === key).map(knownAt);
      const looked = fake.lookupLog.filter((l) => l.key === key && (l.answer === "sent" || l.answer === "not-sent")).map((l) => l.at);
      const refused = fake.refusals.filter((r) => fake.handoverLog.some((c) => c.key === key && c.attemptId === r.attemptId)).map((r) => r.at);
      const withdrawn = fake.withdrawLog.filter((w) => w.key === key && w.answer === "withdrawn").map((w) => w.at);
      return Math.min(...delivered, ...looked, ...refused, ...withdrawn, markedSent.get(key) ?? Infinity, markedNotSentKeys.get(key) ?? Infinity);
    };
    for (const [key, c] of firstCallOf) {
      const k = accounts.find((a) => a.id === c.sender)?.k ?? 1;
      const holding = [...firstCallOf.values()].filter((o) => o.key !== key && o.sender === c.sender && o.at <= c.at && settledAt(o.key) > c.at);
      if (holding.length >= k) problem(`11: ${c.sender} took new work for ${c.subjectId}/${c.stepId} while holding ${holding.length} unsettled against k = ${k}`);
    }
  }

  /**
   * When the record says the lead replied (ADR 0003 2.4 as amended in review round 2). A reply on
   * a thread of its sends: at once when the app already knew that send's reference, else within
   * one settling period, when the reference attaches or the reply falls back by address. A reply
   * with no thread: at once, to every lead whose work from that inbox to that address was sent,
   * first called at or before it and not settled otherwise. `may` widens it to the app's own work
   * the fallback may match: handed at or before the reply, to that address, from that inbox.
   */
  function replyTimes(subjectId: string, attempts: readonly Attempt[] = []): { must: number | null; may: number | null } {
    const firstCall = (key: string) => fake.handoverLog.find((c) => c.key === key)?.at ?? Infinity;
    // The user's "not sent" settles capacity, not the facts: such work still matches (review round 3).
    const settledWithout = (key: string) =>
      fake.withdrawLog.some((w) => w.key === key && w.answer === "withdrawn") ||
      fake.refusals.some((r) => fake.handoverLog.some((c) => c.key === key && c.attemptId === r.attemptId));
    const must: number[] = [];
    const may: number[] = [];
    const fallbackMay = (r: { at: number; inbox: string; destination: string }) =>
      attempts.some((a) => a.subjectId === subjectId && a.accountId === r.inbox && a.destination === r.destination && a.calls > 0 && (a.handedWall ?? Infinity) <= r.at);
    for (const r of fake.replyLog) {
      if (r.onThread) {
        const d = fake.deliveryLog.find((x) => x.providerRef === r.threadRef);
        if (d && d.subjectId === subjectId) {
          const refKnown = Math.min(d.visibleAt, fake.lookupLog.find((l) => l.key === d.key && l.answer === "sent" && l.at >= d.at)?.at ?? Infinity);
          // Held until its reference attaches or one settling period of running time; a crash in
          // between restarts without counting the time it lost, so the record then only allows it.
          const bound = refKnown <= r.at ? r.at : observedBy(observedBy(r.at) + SETTLING);
          if (refKnown <= r.at || !crashTimes.some((t) => t >= r.at && t <= bound)) must.push(bound);
          may.push(r.at);
        } else if (fallbackMay(r)) may.push(r.at);
      } else {
        const sent = fake.deliveryLog.some((x) => x.subjectId === subjectId && x.sender === r.inbox && x.destination === r.destination && firstCall(x.key) <= r.at && !settledWithout(x.key));
        if (sent) must.push(r.at);
        if (sent || fallbackMay(r)) may.push(r.at);
      }
    }
    return { must: must.length > 0 ? Math.min(...must) : null, may: [...must, ...may].length > 0 ? Math.min(...must, ...may) : null };
  }

  function finishedBefore(p: { finishedAt: number | null }, result: { at: number }): boolean {
    return p.finishedAt !== null && p.finishedAt <= result.at;
  }

  /** When the app knew `address` was bad, by the record: a bounce it observed, an invalid refusal, or a mark elsewhere. */
  function badAtFor(address: string): number | null {
    const times: number[] = [];
    const elsewhere = badElsewhere.get(address);
    if (elsewhere !== undefined) times.push(elsewhere);
    if (fake.bouncing.has(address)) {
      const first = fake.deliveryLog.find((d) => d.destination === address);
      // The app knows once it observes the bounce, which an injected advance can delay.
      if (first) times.push(observedBy(first.at + 5 * MINUTE));
    }
    // An invalid address is known bad from the refusal of the call that tried it.
    const invalid = fake.refusals.find((r) => r.destination === address && r.reason === "invalid_destination");
    if (invalid) times.push(invalid.at);
    return times.length > 0 ? Math.min(...times) : null;
  }

  /**
   * When the record knows the lead first stopped running (its first ending, which opens its
   * freeze): a reply, a finishing cause, or the app learning of the last send. `certain` is false
   * when the last send could have been learned at any instant in a window before the other causes.
   */
  function recordFirstEnding(rec: SubjectRecord, runStart: number, now: number): { at: number | null; certain: boolean } {
    const id = rec.id;
    const own = (t: number) =>
      (rec.person ? rec.person.emails.filter(([at]) => at <= t).map(([, a]) => a) : rec.company.inbox ? [rec.company.inbox] : []).filter((a) => {
        const bad = badAtFor(a);
        return bad === null || bad > t;
      });
    // The newest good address when the track started; an address added at that very instant may
    // have come just after, so the provider's first call settles it when there is one.
    const destination = fake.handoverLog.find((c) => c.subjectId === id)?.destination ?? own(runStart).at(-1) ?? null;
    if (destination === null) return { at: runStart, certain: true };
    const replied = replyTimes(id).must;
    const replies = replied !== null && replied <= now ? [replied] : [];

    const calls = fake.handoverLog.filter((c) => c.subjectId === id && c.at <= now);
    const blocked = fake.refusals.find((r) => r.reason === "blocklisted" && calls.some((c) => c.attemptId === r.attemptId));
    const bad = badAtFor(destination);
    const allAddresses = [...new Set([...(rec.person?.emails.map(([, a]) => a) ?? []), ...(rec.company.inbox ? [rec.company.inbox] : [])])];
    const lost = own(now).length === 0 ? Math.max(...allAddresses.map((a) => badAtFor(a) ?? Infinity)) : Infinity;
    const known = Math.min(...replies, blocked?.at ?? Infinity, bad !== null && bad <= now ? bad : Infinity, lost <= now ? lost : Infinity);
    const steps = campaigns[rec.campaign]!.definition.tracks[0]!.steps;
    const deliveries = steps.map((st) => stepDelivery(id, st.id)).filter((d): d is NonNullable<typeof d> => d !== undefined && d.at <= now);
    if (steps.every((st) => deliveries.some((d) => d.stepId === st.id))) {
      const lastSent = Math.max(...deliveries.map((d) => d.at));
      const lastVisible = Math.max(...deliveries.map(knownAt));
      if (lastSent < known) return lastSent === lastVisible ? { at: lastSent, certain: true } : { at: null, certain: false };
    }
    if (known !== Infinity && observedBy(known) > known) return { at: null, certain: false };
    return { at: known === Infinity ? null : known, certain: true };
  }

  /** The statuses the record allows now (1, 20): replies first, then endings, then touched or not. */
  function expectedStatuses(rec: SubjectRecord, s: SubjectState, now: number, runStart: number): Set<OutreachStatus> {
    // An address added at the very instant of a decision may have come just before or just after it.
    // The track's start (its destination) and each later evaluation (its reach) may each fall on either side.
    const out = new Set<OutreachStatus>();
    for (const destinationAfter of [false, true]) for (const reachAfter of [false, true]) for (const x of statusesWith(rec, s, now, runStart, destinationAfter, reachAfter)) out.add(x);
    return out;
  }

  function statusesWith(rec: SubjectRecord, s: SubjectState, now: number, runStart: number, destinationAfter: boolean, addedJustAfter: boolean): Set<OutreachStatus> {
    if (runStart > now) return new Set(["queued"]);
    const id = rec.id;
    const reply = replyTimes(id, s.attempts);
    if (reply.must !== null && reply.must <= now) return new Set(["replied"]);
    const own = (t: number): string[] => {
      const all = rec.person ? rec.person.emails.filter(([at]) => (addedJustAfter ? at < t : at <= t)).map(([, a]) => a) : rec.company.inbox ? [rec.company.inbox] : [];
      return all.filter((a) => {
        const bad = badAtFor(a);
        return bad === null || bad > t;
      });
    };
    // The newest good address when the track started; an address added at that very instant may
    // have come just after, so the provider's first call settles it when there is one.
    // destinationAfter: the track started before every other change at that same instant.
    const atStart = (rec.person ? rec.person.emails.filter(([at]) => (destinationAfter ? at < runStart : at <= runStart)).map(([, a]) => a) : rec.company.inbox ? [rec.company.inbox] : []).filter((a) => {
      const bad = badAtFor(a);
      return bad === null || bad > runStart || (destinationAfter && bad === runStart);
    });
    const destination = fake.handoverLog.find((c) => c.subjectId === id)?.destination ?? atStart.at(-1) ?? null;
    if (destination === null) return new Set(["finished_no_usable_channel"]);
    const steps = campaigns[rec.campaign]!.definition.tracks[0]!.steps;
    const deliveries = steps.map((st) => stepDelivery(id, st.id)).filter((d): d is NonNullable<typeof d> => d !== undefined && d.at <= now);
    const calls = fake.handoverLog.filter((c) => c.subjectId === id && c.at <= now);
    // When the track finished, by each cause the record can see, and when every step was sent.
    const finishes: number[] = [];
    const blocked = fake.refusals.find((r) => r.reason === "blocklisted" && calls.some((c) => c.attemptId === r.attemptId));
    if (blocked) finishes.push(blocked.at);
    const bad = badAtFor(destination);
    if (bad !== null && bad <= now) finishes.push(bad);
    const sentSteps = new Set(deliveries.map((d) => d.stepId));
    const allSent = steps.every((st) => sentSteps.has(st.id));
    const lastVisible = Math.max(...deliveries.map(knownAt));
    const lastSent = Math.max(...deliveries.map((d) => d.at));
    const out = new Set<OutreachStatus>();
    if (reply.may !== null && reply.may <= now) out.add("replied");
    // Reach at instant t. An address marked bad at that same instant may have been marked just
    // before or just after the track finished, so either ending is allowed then.
    // The destination itself counts only when a mark elsewhere, not its own bounce or refusal, made it bad.
    const causedByDestination = fake.bouncing.has(destination) || fake.invalid.has(destination);
    const ownBefore = (t: number) => own(t - 1).filter((a) => (a !== destination || !causedByDestination) && (badAtFor(a) ?? Infinity) >= t);
    const endingsAt = (t: number): OutreachStatus[] => [
      ...(own(t).length > 0 || ownBefore(t).length > 0 ? (["sequence_finished_no_response"] as const) : []),
      ...(own(t).length === 0 ? (["finished_no_usable_channel"] as const) : []),
    ];
    // Losing every address ends the lead even with work left.
    const reachLost = [...new Set([...(rec.person?.emails.map(([, a]) => a) ?? []), ...(rec.company.inbox ? [rec.company.inbox] : [])])]
      .map((a) => badAtFor(a))
      .filter((t): t is number => t !== null && t <= now);
    const lostAll = own(now).length === 0 && reachLost.length > 0 ? Math.max(...reachLost) : null;
    // The app learns of the last send at some instant between the send (a lookup) and its sent
    // event becoming visible; a bounce, refusal or bad mark ends the track at a known instant.
    const cause = Math.min(...finishes, ...(lostAll !== null ? [lostAll] : []));
    const causeEndings: OutreachStatus[] = lostAll !== null && lostAll < Math.min(...finishes) ? ["finished_no_usable_channel"] : endingsAt(cause);
    let ended = false;
    if (allSent && lastSent <= now) {
      const latest = Math.min(lastVisible, cause, now);
      if (lastSent <= cause) {
        for (const e of [...endingsAt(lastSent), ...endingsAt(latest)]) out.add(e);
      }
      if (lastVisible <= now) ended = true;
    }
    if (cause <= now) {
      if (!(allSent && lastVisible < cause)) for (const e of causeEndings) out.add(e);
      ended = true;
    }
    if (!ended) {
      const touchedSure = deliveries.some((d) => knownAt(d) <= now);
      out.add(touchedSure ? "active" : "queued");
      if (deliveries.length > 0) out.add("active");
    }
    return out;
  }

  async function storedStatus(rec: SubjectRecord, id: string): Promise<OutreachStatus | undefined> {
    if (rec.person) {
      const record = (await h.request<PersonRecord>("GET", `/api/people/${await personId(rec.person)}`)).body;
      return record.enrollments.find((e) => e.id === id)?.status;
    }
    const found = (await h.request<LeadSearchResult>("GET", `/api/leads?q=${encodeURIComponent(rec.company.name)}`)).body.rows.find((r) => r.kind === "company");
    if (!found) return undefined;
    const record = (await h.request<CompanyRecord>("GET", `/api/companies/${found.id}`)).body;
    return record.enrollments.find((e) => e.id === id)?.status;
  }

  function checkCallLog(allAttempts: Attempt[], allWork: readonly ProviderWork[]): void {
    const byAttempt = new Map<string, HandoverLogEntry[]>();
    for (const c of fake.handoverLog) byAttempt.set(c.attemptId, [...(byAttempt.get(c.attemptId) ?? []), c]);
    for (const [attemptId, calls] of byAttempt) {
      if (calls.length > MAX_CALLS) problem(`5: ${attemptId} was called ${calls.length} times`);
      if (calls.some((c) => !c.retryable) && calls.length > 1) problem(`5: ${attemptId} on a transport with no key was called ${calls.length} times`);
      const first = calls[0]!;
      for (const c of calls.slice(1)) {
        if (c.key !== first.key || JSON.stringify(c.rendered) !== JSON.stringify(first.rendered)) problem(`5/8: a retry of ${attemptId} changed its key or payload`);
      }
      const unresolvedSince = allWork.find((w) => w.key === first.key)?.unresolvedSince ?? null;
      if (unresolvedSince !== null && calls.some((c) => c.at > unresolvedSince)) problem(`5: ${attemptId} was called after its work became unresolved`);
      const withdrawn = fake.withdrawLog.find((w) => w.key === first.key);
      if (withdrawn && calls.some((c) => c.at > withdrawn.at)) problem(`5: ${attemptId} was called after a withdrawal was requested`);
    }
    // 2 (predicate 9). No send call from an inbox the provider reported unhealthy at that moment.
    for (const c of fake.handoverLog) if (!c.healthy) problem(`2: ${c.subjectId}/${c.stepId} was called from ${c.sender} while it was unhealthy`);
    // 11. Pacing: two send calls from one account are never closer than its gap.
    const bySender = new Map<string, number[]>();
    for (const c of fake.handoverLog) bySender.set(c.sender, [...(bySender.get(c.sender) ?? []), c.at]);
    for (const [sender, times] of bySender) {
      for (let i = 1; i < times.length; i++) {
        const gap = recordGap(sender, times[i]!);
        if (times[i]! - times[i - 1]! < gap) problem(`11: ${sender} called ${times[i]! - times[i - 1]!} ms apart, under its gap of ${gap}`);
      }
    }
    // 8. Steps in order, on time, in the window, with the copy current at the handover.
    const firsts = new Map<string, HandoverLogEntry>();
    for (const c of fake.handoverLog) if (!firsts.has(`${c.subjectId}/${c.stepId}`)) firsts.set(`${c.subjectId}/${c.stepId}`, c);
    for (const rec of subjects.values()) {
      const def = campaigns[rec.campaign]!.definition;
      const track = def.tracks[0]!;
      const zone = zoneOf(rec.person?.zone ?? "", rec.company.zone, def.timezone);
      const runStart = Math.max(rec.enrolledAt, campaigns[rec.campaign]!.launchedAt ?? Infinity);
      let previous: number | null = null;
      track.steps.forEach((step, i) => {
        const c = firsts.get(`${rec.id}/${step.id}`);
        if (!c) {
          previous = -1;
          return;
        }
        if (previous === -1) problem(`8: ${rec.id}/${step.id} was handed over before an earlier step`);
        const prevStep = track.steps[i - 1];
        const prevDelivery = prevStep ? stepDelivery(rec.id, prevStep.id) : undefined;
        const due = i === 0 ? runStart : prevDelivery ? dueAfter(prevDelivery.at, step.waitDays, zone) : Infinity;
        if (c.at < due) problem(`8: ${rec.id}/${step.id} handed over at ${new Date(c.at).toISOString()}, ${Number.isFinite(due) ? `before it was due at ${new Date(due).toISOString()}` : "though the step before it was never sent"}`);
        // The window is checked at the authorization, before any clock advance injected before the call.
        const authorizedAt = c.at - (injectedDelay.get(`${c.attemptId}@${c.at}`) ?? 0);
        if (!inWindow(track.window, zone, authorizedAt)) problem(`8: ${rec.id}/${step.id} handed over outside its window`);
        const data = mergeData(rec, fake.handoverLog.indexOf(c));
        const expected = { subject: renderCopy(step.subject, data), body: renderCopy(step.body, data) };
        // A crash after the handover committed can eat the first call: the provider then first sees a
        // retry, which carries the copy rendered at that commit, an instant the record cannot see.
        const app = allAttempts.find((a) => a.id === c.attemptId);
        const unseenFirstCall = app !== undefined && app.calls > fake.handoverLog.filter((x) => x.attemptId === c.attemptId).length;
        if (!unseenFirstCall && (expected.subject !== c.rendered.subject || expected.body !== c.rendered.body)) problem(`8: ${rec.id}/${step.id} carried copy ${JSON.stringify(c.rendered)}; current copy was ${JSON.stringify(expected)}`);
        previous = c.at;
      });
      // 2 and 19. Nothing is called for an address after the app knew it was bad.
      for (const c of fake.handoverLog) {
        if (c.subjectId !== rec.id) continue;
        const bad = badAtFor(c.destination);
        const calledBeforeMark = badElsewhere.get(c.destination) === bad && fake.handoverLog.indexOf(c) < (badElsewhereCalls.get(c.destination) ?? Infinity);
        const refusedItself = fake.invalid.has(c.destination) && fake.refusals.some((r) => r.attemptId === c.attemptId);
        const authorizedAt = c.at - (injectedDelay.get(`${c.attemptId}@${c.at}`) ?? 0);
        if (bad !== null && bad <= authorizedAt && !calledBeforeMark && !refusedItself) problem(`2: ${rec.id}/${c.stepId} was called for ${c.destination} after it was marked bad`);
      }
      // 2. Nothing is authorized after the lead replied (a call authorized just before may still go out).
      const firstReply = replyTimes(rec.id).must ?? Infinity;
      for (const c of fake.handoverLog) {
        const authorizedAt = c.at - (injectedDelay.get(`${c.attemptId}@${c.at}`) ?? 0);
        if (c.subjectId === rec.id && authorizedAt > firstReply) problem(`2: ${rec.id}/${c.stepId} was called after the lead replied`);
      }
    }
  }

  function mergeData(rec: SubjectRecord, callIndex: number): Record<string, string> {
    const data: Record<string, string> = { company: rec.company.name, city: rec.company.city };
    if (rec.person) {
      const [first = "", ...rest] = rec.person.name.split(" ");
      Object.assign(data, { first_name: first, last_name: rest.join(" "), full_name: rec.person.name, title: titleAt(rec.person, callIndex) });
    }
    return data;
  }

  /** The unlimited variant: each first handover comes at the window's first instant after it was due and known, up to pacing. */
  function checkUnlimited(): void {
    const seen = new Set<string>();
    for (const c of fake.handoverLog) {
      const key = `${c.subjectId}/${c.stepId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const rec = subjects.get(c.subjectId);
      if (!rec) continue;
      const def = campaigns[rec.campaign]!.definition;
      const track = def.tracks[0]!;
      const zone = zoneOf(rec.person?.zone ?? "", rec.company.zone, def.timezone);
      const i = track.steps.findIndex((st) => st.id === c.stepId);
      const prev = i > 0 ? stepDelivery(c.subjectId, track.steps[i - 1]!.id) : undefined;
      const runStart = Math.max(rec.enrolledAt, campaigns[rec.campaign]!.launchedAt ?? Infinity);
      const due = i === 0 ? runStart : prev ? dueAfter(prev.at, track.steps[i]!.waitDays, zone) : Infinity;
      const known = i === 0 ? runStart : prev ? Math.max(due, knownAt(prev)) : Infinity;
      const opens = firstOpen(track.window, zone, known);
      if (c.at > opens + MINUTE * (subjects.size + 1)) problem(`8: unlimited variant: ${key} handed over at ${new Date(c.at).toISOString()}, the window opened after it was due at ${new Date(opens).toISOString()}`);
    }
  }
}

/** The probe at every send call (invariants 2 and 12): the app's state at the moment of the call. */
function probeAtCall(h: EngineHarness, problem: (what: string) => void, eligible: (s: SubjectState, a: Attempt, now: number) => boolean) {
  return async (call: HandoverLogEntry): Promise<void> => {
    const now = h.clock;
    const s = await h.store.engine.subject(call.subjectId, now);
    if (!s) return;
    if (s.subject.ended !== null || s.campaign.launchedAt === null) problem(`2: ${call.subjectId}/${call.stepId} was called while the lead was ${s.subject.ended ?? "not launched"}`);
    const p = s.tracks.find((t) => t.nextStepId === call.stepId && t.finishedAt === null);
    if (!p) problem(`2: ${call.subjectId}/${call.stepId} was called but is not its track's pending step`);
    if (s.results.some((r) => r.stepId === call.stepId)) problem(`2: ${call.subjectId}/${call.stepId} was called after it had a result`);
    // 2 (predicate 15). No call carries provider work that has already settled.
    const calledWork = s.work.find((w) => w.key === call.key);
    if (calledWork?.settled != null) problem(`2: ${call.subjectId}/${call.stepId} was called carrying work ${call.key}, which had settled as ${calledWork.settled}`);
    // 2 (predicate 18). Nothing goes from an inbox to an address while a reply between them awaits correlation.
    if (s.pendingReplies.some((r) => r.inbox === call.sender && r.address === call.destination.toLowerCase())) problem(`2: ${call.subjectId}/${call.stepId} was called from ${call.sender} while a reply from ${call.destination} awaited correlation`);
    const attempt = s.attempts.find((a) => a.id === call.attemptId);
    if (!attempt || attempt.calls > 1) return;
    // 12. No claimed attempt on this account that met every predicate but the slot had higher priority.
    const mine = { touched: s.subject.touched, dueWall: p?.dueWall ?? 0, subjectId: call.subjectId, stepId: call.stepId };
    for (const other of await h.store.engine.openAttempts()) {
      if (other.state !== "claimed" || other.accountId !== call.sender || other.id === call.attemptId) continue;
      const os = await h.store.engine.subject(other.subjectId, now);
      if (!os || !eligible(os, other, now)) continue;
      const theirs = { touched: os.subject.touched, dueWall: os.tracks.find((t) => t.trackId === other.trackId)?.dueWall ?? 0, subjectId: other.subjectId, stepId: other.stepId };
      if (higherPriority(theirs, mine)) problem(`12: ${call.subjectId}/${call.stepId} was handed over on ${call.sender} before ${other.subjectId}/${other.stepId}, which had priority`);
    }
  };
}
