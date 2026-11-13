import { ENGINE_PARAMS, isLive } from "../../src/domain/sequence/attempt.ts";
import type { CampaignDefinition, StepDefinition } from "../../src/domain/sequence/definition.ts";
import { handoverFailures } from "../../src/domain/sequence/dispatch.ts";
import type { Attempt, SubjectState } from "../../src/domain/sequence/state.ts";
import type { Rules } from "../../src/server/engine/rules.ts";
import type { CompanyRecord, EnrollmentProgress, LeadSearchResult, NeedsAttention, OutreachStatus, PersonRecord } from "../../src/shared/api.ts";
import { Crash, EngineHarness } from "./engine-harness.ts";
import { business, person, type ExportRows } from "./export-builder.ts";
import { FAKE_MODES, type FakeAccount, type FakeMode, type HandoverLogEntry } from "./fake-email-port.ts";
import { dueAfter, firstOpen, higherPriority, inWindow, leadTimeOf, renderCopy, zoneOf, type Hours } from "./sequence-model.ts";

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
      body: pick(["Hi {{first_name|there}}, a note for {{company}}.", "As {{title|the team}} at {{company}}, you may like this.", "Following up, {{first_name|there}}."]),
      threading: i === 0 ? "new_subject" : rand() < 0.2 ? "new_subject" : "continue_thread",
      removed: false,
    });
  }
  return out.map((s) => (s.threading === "new_subject" && !s.subject ? { ...s, subject: "Another thought" } : s));
}

function windowOf(rand: () => number, pick: Pick): Hours[] {
  const kind = rand();
  if (kind < 0.25) return [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
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
}

export interface RunResult {
  readonly problems: string[];
  readonly stats: { sends: number; calls: number; crashes: number; subjects: number; ticks: number; modes: readonly FakeMode[] };
}

export async function runSequence(seed: number, options: RunOptions = {}): Promise<RunResult> {
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

  // Modes: one to three, drawn per call. The unlimited variant keeps to modes that do not hold work.
  const modes: FakeMode[] = unlimited
    ? [pick(["honest", "late-send", "duplicate-and-reorder", "lost-response", "same-key-replays"] as const)]
    : [...new Set([pick(FAKE_MODES), pick(FAKE_MODES), ...(chance(0.5) ? [pick(FAKE_MODES)] : [])])];

  const inboxCount = unlimited ? 8 : 1 + Math.floor(rand() * 3);
  const accounts: FakeAccount[] = Array.from({ length: inboxCount }, (_, i) => ({
    id: `inbox-${String.fromCharCode(97 + i)}`,
    capacity: unlimited ? 1000 : pick([1, 2, 3, 5, 8]),
    gapMs: unlimited ? MINUTE : pick([1, 2, 5, 20]) * MINUTE,
    k: unlimited ? 10 : pick([1, 2]),
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

  const h = new EngineHarness({ start, accounts, modes, random: random(seed ^ 0x5eed), ...(options.rules ? { rules: options.rules } : {}) });
  const fake = h.fake;
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
  const rowsFor = (campaign: CampaignRecord, t: number): ExportRows => ({
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

  const campaignCount = chance(0.6) ? 2 : 1;
  const campaigns: CampaignRecord[] = [];
  for (let ci = 0; ci < campaignCount; ci++) {
    const definition: CampaignDefinition = {
      timezone: pick(["Europe/London", "America/New_York"]),
      callSkipLimitDays: 2,
      emailPool: accounts.filter((_, i) => ci === 0 || i > 0 || inboxCount === 1).map((a) => a.id),
      tracks: [{ id: "t1", channel: "email", branch: "main", window: windowOf(rand, pick), steps: steps(rand, pick), start: { kind: "entry" }, removed: false }],
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
  const markedNotSent = new Set<string>();

  // ------------------------------------------------------------------------------------------
  // Crashes and injected user events.
  let armed: string | null = null;
  let inject = 0;
  const userEvent = async () => {
    const r = rand();
    const known = [...subjects.values()].filter((s) => s.person?.emails.length);
    if (r < 0.35 && known.length > 0) {
      const s = pick(known);
      const address = s.person?.emails.at(-1)?.[1];
      if (address) fake.prospectReplies(address);
    } else if (r < 0.55 && known.length > 0) {
      await markBad(pick(known));
    } else if (r < 0.75 && !unlimited) {
      const a = pick(accounts);
      a.healthy = false;
      await h.store.engine.updateAccount(a.id, { healthy: false });
    } else {
      await reimport();
    }
  };
  const hooks = {
    crashPoint: (point: string) => {
      if (armed === point) {
        armed = null;
        throw new Crash(point);
      }
    },
    beforeApplyEvaluation: async () => {
      if (inject > 0 && chance(0.3)) {
        inject--;
        await userEvent();
      }
    },
    beforeHandover: async () => {
      if (inject > 0 && chance(0.3)) {
        inject--;
        await userEvent();
      }
    },
  };
  h.hooks = hooks;

  async function markBad(s: SubjectRecord) {
    const address = s.person?.emails.at(-1)?.[1];
    if (!address || !s.person) return;
    const record = await h.request<PersonRecord>("GET", `/api/people/${await personId(s.person)}`);
    const detail = record.body.contactDetails.find((d) => d.value === address);
    if (!detail || detail.bad) return;
    await h.store.markContactDetailBad(detail.id);
    if (!badElsewhere.has(address)) badElsewhere.set(address, h.clock);
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
  async function reimport() {
    const now = h.clock;
    for (const p of people) if (chance(0.3)) p.titles.push([fake.handoverLog.length, pick(["Owner", "Clinic director", "Practice manager", "Lead physio"])]);
    const withEmail = people.filter((p) => p.emails.length > 0 && !p.late);
    if (chance(0.3) && withEmail.length > 0) {
      const p = pick(withEmail);
      p.emails.push([now, `${p.key}.new${++reimports}@mail.example`]);
    }
    if (chance(0.4)) for (const p of people.filter((x) => x.late)) lateEnrolled.add(p.key);
    const before = await progressSnapshot();
    for (const c of campaigns) if (c.id) await h.reimport(c.id, rowsFor(c, now));
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
    const created = await h.createCampaign(`Campaign ${ci + 1}`, rowsFor(c, 0), c.definition.timezone);
    c.id = created.campaign.id;
    await h.defineSequence(c.id, c.definition);
  }
  await discover();
  const priorityProbe = probeAtCall(h, subjects, campaigns, problem);
  fake.onHandover = priorityProbe;

  for (const [ci, c] of campaigns.entries()) {
    const wait = Math.floor(rand() * 3) * HOUR;
    if (ci === 0) h.clock += wait;
    else await h.advanceTo(h.clock + wait);
    const launched = await h.launch(c.id);
    if (launched.status !== 200) {
      problem(`launch refused: ${JSON.stringify(launched.body)}`);
      return { problems, stats: { sends: 0, calls: 0, crashes: 0, subjects: subjects.size, ticks: h.ticks, modes } };
    }
    c.launchedAt = h.clock;
  }
  if ((globalThis as { DEBUG?: boolean }).DEBUG) console.info("launched", campaigns.map((c) => new Date(c.launchedAt ?? 0).toISOString()), [...subjects.values()].map((x) => `${x.id} c${x.campaign} ${new Date(x.enrolledAt).toISOString()}`), fake.handoverLog.map((c) => `${c.subjectId}/${c.stepId} ${c.sender} ${new Date(c.at).toISOString()}`), JSON.stringify(campaigns.map((c) => c.definition.tracks[0]!.window)));

  // ------------------------------------------------------------------------------------------
  // Events.
  const history = new Map<string, { states: string[]; withdrawRequested: boolean; handedOnce: boolean }>();
  const finishedSnapshots = new Map<string, string>();
  const pendingDeadlines = new Map<string, number>();
  const startedAt = new Map<string, number>();
  const badSeen = new Map<string, number>();

  const eventCount = options.events ?? 22;
  for (let e = 0; e < eventCount; e++) {
    const r = rand();
    if (r < 0.45) {
      const span = pick([10_000, 45_000, 2 * MINUTE, 7 * MINUTE, 20 * MINUTE, 2 * HOUR, 7 * HOUR, DAY, 2 * DAY, 3 * DAY]);
      await h.advanceTo(h.clock + span);
    } else if (r < 0.55) {
      const delivered = fake.deliveryLog.filter((d) => d.at <= h.clock);
      if (delivered.length > 0) fake.prospectReplies(pick(delivered).destination);
      await h.tick();
    } else if (r < 0.62) {
      await reimport();
      await h.tick();
    } else if (r < 0.66 && !unlimited) {
      const s = pick([...subjects.values()]);
      await markBad(s);
      await h.tick();
    } else if (r < 0.74 && !unlimited) {
      const a = pick(accounts);
      const what = rand();
      if (what < 0.4) a.healthy = !a.healthy;
      else if (what < 0.7) a.quotaAvailable = !a.quotaAvailable;
      else fake.rateLimitedUntil.set(a.id, h.clock + pick([30_000, 5 * MINUTE, HOUR]));
      await h.tick();
    } else if (r < 0.78 && !unlimited) {
      fake.presendUnavailable = !fake.presendUnavailable;
      await h.tick();
    } else if (r < 0.87 && !unlimited) {
      armed = pick(["after_claim", "after_presend", "after_handover_commit", "after_call", "after_retry_commit", "after_lookup", "after_observe_event"]);
      await h.advanceTo(h.clock + pick([MINUTE, 20 * MINUTE, 3 * HOUR]));
    } else if (r < 0.9) {
      const stale = fake.staleAnswers.splice(0);
      for (const s of stale) await h.engine.receiveLateAnswer(s.attemptId, s.answer);
      await h.tick();
    } else if (r < 0.94 && !unlimited) {
      // The user resolves an unresolved attempt the provider never sent as "not sent" (ADR 0002 P3).
      for (const a of await h.store.engine.openAttempts()) {
        if (!isLive(a) || a.unresolvedSince === null) continue;
        const delivered = fake.deliveryLog.some((d) => d.key === a.idempotencyKey);
        if (delivered) continue;
        const accepted = await h.engine.markAttempt(a.id, "not_sent");
        if (accepted && a.lookupAnswer === "queued") problem(`26: "mark not sent" accepted while the provider reports ${a.id} queued`);
        if (accepted) markedNotSent.add(`${a.subjectId}/${a.stepId}`);
      }
      await h.tick();
    } else {
      inject = unlimited ? 0 : 2;
      await h.advanceTo(h.clock + pick([MINUTE, HOUR, DAY]));
      inject = 0;
    }
    await checkAll(false);
    if (problems.length > 0) break;
  }

  // Drain: every account restored, no new events, time passes.
  if (problems.length === 0 && options.drain !== false) {
    armed = null;
    inject = 0;
    fake.presendUnavailable = false;
    fake.rateLimitedUntil.clear();
    // "With enough time and capacity": every inbox gets room for the whole backlog.
    for (const a of accounts) {
      a.healthy = true;
      a.quotaAvailable = true;
      a.capacity = Math.max(a.capacity, 100);
    }
    await h.advanceTo(h.clock + 21 * DAY);
    await checkAll(true);
  }

  return {
    problems,
    stats: { sends: fake.deliveryLog.length, calls: fake.handoverLog.length, crashes: h.crashes.length, subjects: subjects.size, ticks: h.ticks, modes },
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
      if (!allowed.has(progress.status)) problem(`1/20: ${id} is ${progress.status}; the record allows ${[...allowed].join(" or ")} at ${new Date(now).toISOString()}`);

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
        const delivery = fake.deliveryLog.find((d) => d.subjectId === id && d.stepId === result.stepId);
        if (!attempt || !delivery || attempt.userMarkedNotSent) continue;
        const endedWall = s.subject.endedWall;
        const point = leadTimeOf(Math.max(delivery.at, attempt.handedWall ?? 0), runStart, endedWall !== null && endedWall <= delivery.at ? endedWall : null);
        if (result.at !== point.at || result.atWall !== point.wall) problem(`9: ${id}/${result.stepId} sent at lead ${result.at}/${result.atWall}; the record says ${point.at}/${point.wall}`);
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
        const bad = badAtFor(a.destination, a.subjectId);
        if (bad !== null && bad <= a.claimedWall) problem(`19: ${a.id} claimed ${a.destination} at ${new Date(a.claimedWall).toISOString()} after it was marked bad at ${new Date(bad).toISOString()} (elsewhere ${String(badElsewhere.get(a.destination))}, bounce ${fake.bouncing.has(a.destination)}, invalid ${fake.invalid.has(a.destination)}; state ${a.state} ${a.endedBy ?? ""})`);
      }
      // 5.5 and 1.3: the sender is fixed by the first handover that commits, never by a claim.
      const firstCall = fake.handoverLog.find((c) => c.subjectId === id);
      if (s.subject.emailSender !== (firstCall?.sender ?? null)) problem(`1.3: ${id} has sender ${s.subject.emailSender ?? "none"}; its first handover was on ${firstCall?.sender ?? "none"}`);
      // 26. An attempt becomes unresolved only on an unknown or unvouched not-sent, or after MAX_QUEUED_LOOKUPS queued answers.
      for (const a of s.attempts) {
        if (a.unresolvedSince === null) continue;
        const answers = fake.lookupLog.filter((l) => l.key === a.idempotencyKey && l.at <= a.unresolvedSince!).map((l) => l.answer);
        let queued = 0;
        for (let i = answers.length - 1; i >= 0 && answers[i] === "queued"; i--) queued++;
        if (answers.at(-1) === "queued" && queued < MAX_QUEUED_LOOKUPS) problem(`26: ${a.id} became unresolved after only ${queued} queued answers`);
      }
      // 20. Correct endings.
      if (s.subject.ended === "sequence_finished_no_response" && s.tracks.some((p) => p.finishedAt === null)) problem(`20: ${id} finished with a track still open`);
      void progress;
    }

    // 3. At most one live and one sent attempt per step.
    const perStep = new Map<string, Attempt[]>();
    for (const a of allAttempts) perStep.set(`${a.subjectId}/${a.stepId}`, [...(perStep.get(`${a.subjectId}/${a.stepId}`) ?? []), a]);
    for (const [key, list] of perStep) {
      if (list.filter(isLive).length > 1) problem(`3: ${key} has two live attempts`);
      if (list.filter((a) => a.state === "sent").length > 1) problem(`3: ${key} has two sent attempts`);
      // 5. After a lookup said not sent, later attempts reuse its key.
      const notSent = list.find((a) => a.endedBy === "lookup_not_sent");
      if (notSent) for (const later of list.filter((a) => a.claimedWall > notSent.claimedWall)) if (later.idempotencyKey !== notSent.idempotencyKey) problem(`5: ${later.id} took a new key after a not-sent lookup`);
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
    checkCallLog(allAttempts);

    // 10 and 11. Capacity, the in-flight bound.
    for (const acc of await h.store.engine.accounts(now)) {
      if (acc.used > acc.capacity) problem(`10: ${acc.id} has ${acc.used} sends and reservations against a capacity of ${acc.capacity}`);
      if (acc.inFlight > acc.k) problem(`11: ${acc.id} has ${acc.inFlight} attempts in flight against k = ${acc.k}`);
    }

    // 26. No attempt waits forever.
    for (const a of allAttempts) {
      if (a.state === "claimed" && now - a.claimedWall > SETTLING) problem(`26: ${a.id} has been claimed since ${new Date(a.claimedWall).toISOString()}`);
      if ((a.state === "handed" || a.state === "accepted") && a.unresolvedSince === null && now - (a.lastCallWall ?? a.claimedWall) > SETTLING * (MAX_QUEUED_LOOKUPS + 2)) {
        problem(`26: ${a.id} has been ${a.state} since ${new Date(a.lastCallWall ?? 0).toISOString()} without settling`);
      }
    }
    const attention = (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body;
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
        const usable = s.subject.emailSender !== null ? [s.subject.emailSender] : s.campaign.definition.emailPool;
        const waitsOnStalled = usable.length > 0 && usable.every((a) => stalled.has(a));
        if (!progress.tracks.some((t) => t.hold !== null) && !waitsOnStalled) problem(`18: ${id} is ${progress.status} after the drain with nothing held (${JSON.stringify(progress.tracks.map((t) => [t.finishReason, t.nextStep]))})`);
      }
    }
  }

  function finishedBefore(p: { finishedAt: number | null }, result: { at: number }): boolean {
    return p.finishedAt !== null && p.finishedAt <= result.at;
  }

  /** When the app knew `address` was bad, by the record: a bounce it observed, an invalid refusal, or a mark elsewhere. */
  function badAtFor(address: string, _subjectId: string): number | null {
    const times: number[] = [];
    const elsewhere = badElsewhere.get(address);
    if (elsewhere !== undefined) times.push(elsewhere);
    if (fake.bouncing.has(address)) {
      const first = fake.deliveryLog.find((d) => d.destination === address);
      if (first) times.push(first.at + 5 * MINUTE);
    }
    // An invalid address is known bad once the call refused for it is answered, just after it.
    const invalid = fake.refusals.find((r) => r.destination === address && r.reason === "invalid_destination");
    if (invalid) times.push(invalid.at + 1);
    return times.length > 0 ? Math.min(...times) : null;
  }

  /** The statuses the record allows now (1, 20): replies first, then endings, then touched or not. */
  function expectedStatuses(rec: SubjectRecord, s: SubjectState, now: number, runStart: number): Set<OutreachStatus> {
    if (runStart > now) return new Set(["queued"]);
    const id = rec.id;
    const replied = fake.replyLog.some((r) => r.at <= now && fake.deliveryLog.some((d) => d.providerRef === r.threadRef && d.subjectId === id));
    if (replied) return new Set(["replied"]);
    const own = (t: number): string[] => {
      const all = rec.person ? rec.person.emails.filter(([at]) => at <= t).map(([, a]) => a) : rec.company.inbox ? [rec.company.inbox] : [];
      return all.filter((a) => {
        const bad = badAtFor(a, id);
        return bad === null || bad > t;
      });
    };
    const destination = own(runStart).at(-1) ?? null;
    if (destination === null) return new Set(["finished_no_usable_channel"]);
    const steps = campaigns[rec.campaign]!.definition.tracks[0]!.steps;
    const deliveries = fake.deliveryLog.filter((d) => d.subjectId === id && d.at <= now);
    const calls = fake.handoverLog.filter((c) => c.subjectId === id && c.at <= now);
    // When the track finished, by each cause the record can see, and when every step was sent.
    const finishes: number[] = [];
    const blocked = fake.refusals.find((r) => r.reason === "blocklisted" && calls.some((c) => c.attemptId === r.attemptId));
    if (blocked) finishes.push(blocked.at);
    const bad = badAtFor(destination, id);
    if (bad !== null && bad <= now) finishes.push(bad);
    const sentSteps = new Set(deliveries.map((d) => d.stepId));
    const allSent = steps.every((st) => sentSteps.has(st.id));
    const lastVisible = Math.max(...steps.map((st) => Math.min(...deliveries.filter((d) => d.stepId === st.id).map((d) => d.visibleAt))));
    const lastSent = Math.max(...steps.map((st) => Math.min(...deliveries.filter((d) => d.stepId === st.id).map((d) => d.at))));
    const out = new Set<OutreachStatus>();
    const endingAt = (t: number): OutreachStatus => (own(t).length > 0 ? "sequence_finished_no_response" : "finished_no_usable_channel");
    // Losing every address ends the lead even with work left.
    const reachLost = [...new Set([...(rec.person?.emails.map(([, a]) => a) ?? []), ...(rec.company.inbox ? [rec.company.inbox] : [])])]
      .map((a) => badAtFor(a, id))
      .filter((t): t is number => t !== null && t <= now);
    const lostAll = own(now).length === 0 && reachLost.length > 0 ? Math.max(...reachLost) : null;
    const certain = Math.min(...finishes, ...(allSent && lastVisible <= now ? [lastVisible] : []), ...(lostAll !== null ? [lostAll] : []));
    if (certain <= now) out.add(lostAll !== null && lostAll <= certain ? "finished_no_usable_channel" : endingAt(certain));
    else {
      const touchedSure = deliveries.some((d) => d.visibleAt <= now);
      out.add(touchedSure ? "active" : "queued");
      if (deliveries.length > 0) out.add("active");
      if (allSent && lastSent <= now) out.add(endingAt(now));
    }
    void s;
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

  function checkCallLog(allAttempts: Attempt[]): void {
    const byAttempt = new Map<string, HandoverLogEntry[]>();
    for (const c of fake.handoverLog) byAttempt.set(c.attemptId, [...(byAttempt.get(c.attemptId) ?? []), c]);
    for (const [attemptId, calls] of byAttempt) {
      if (calls.length > MAX_CALLS) problem(`5: ${attemptId} was called ${calls.length} times`);
      if (calls.some((c) => !c.retryable) && calls.length > 1) problem(`5: ${attemptId} on a transport with no key was called ${calls.length} times`);
      const first = calls[0]!;
      for (const c of calls.slice(1)) {
        if (c.key !== first.key || JSON.stringify(c.rendered) !== JSON.stringify(first.rendered)) problem(`5/8: a retry of ${attemptId} changed its key or payload`);
      }
      const a = allAttempts.find((x) => x.id === attemptId);
      if (a?.unresolvedSince != null && calls.some((c) => c.at > (a.unresolvedSince ?? Infinity))) problem(`5: ${attemptId} was called after it became unresolved`);
      const withdrawn = fake.withdrawLog.find((w) => w.key === first.key);
      if (withdrawn && calls.some((c) => c.at > withdrawn.at)) problem(`5: ${attemptId} was called after a withdrawal was requested`);
    }
    // 11. Pacing: two send calls from one account are never closer than its gap.
    const bySender = new Map<string, number[]>();
    for (const c of fake.handoverLog) bySender.set(c.sender, [...(bySender.get(c.sender) ?? []), c.at]);
    for (const [sender, times] of bySender) {
      const gap = accounts.find((a) => a.id === sender)?.gapMs ?? 0;
      for (let i = 1; i < times.length; i++) if (times[i]! - times[i - 1]! < gap) problem(`11: ${sender} called ${times[i]! - times[i - 1]!} ms apart, under its gap of ${gap}`);
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
        const prevDelivery = prevStep ? fake.deliveryLog.find((d) => d.subjectId === rec.id && d.stepId === prevStep.id) : undefined;
        const due = i === 0 ? runStart : prevDelivery ? dueAfter(prevDelivery.at, step.waitDays, zone) : Infinity;
        if (c.at < due && !markedNotSent.has(`${rec.id}/${prevStep?.id ?? ""}`)) problem(`8: ${rec.id}/${step.id} handed over at ${new Date(c.at).toISOString()}, before it was due at ${new Date(due).toISOString()}`);
        if (!inWindow(track.window, zone, c.at)) problem(`8: ${rec.id}/${step.id} handed over outside its window`);
        const data = mergeData(rec, fake.handoverLog.indexOf(c));
        const expected = { subject: renderCopy(step.subject, data), body: renderCopy(step.body, data) };
        if (expected.subject !== c.rendered.subject || expected.body !== c.rendered.body) problem(`8: ${rec.id}/${step.id} carried copy ${JSON.stringify(c.rendered)}; current copy was ${JSON.stringify(expected)}`);
        previous = c.at;
      });
      // 2. Nothing is called after the lead replied.
      const replyAt = fake.replyLog.filter((r) => fake.deliveryLog.some((d) => d.providerRef === r.threadRef && d.subjectId === rec.id)).map((r) => r.at);
      const firstReply = replyAt.length > 0 ? Math.min(...replyAt) : Infinity;
      for (const c of fake.handoverLog) if (c.subjectId === rec.id && c.at > firstReply) problem(`2: ${rec.id}/${c.stepId} was called after the lead replied`);
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
      const prev = i > 0 ? fake.deliveryLog.find((d) => d.subjectId === c.subjectId && d.stepId === track.steps[i - 1]!.id) : undefined;
      const runStart = Math.max(rec.enrolledAt, campaigns[rec.campaign]!.launchedAt ?? Infinity);
      const due = i === 0 ? runStart : prev ? dueAfter(prev.at, track.steps[i]!.waitDays, zone) : Infinity;
      const known = i === 0 ? runStart : prev ? Math.max(due, prev.visibleAt) : Infinity;
      const opens = firstOpen(track.window, zone, known);
      if (c.at > opens + MINUTE * (subjects.size + 1)) problem(`unlimited: ${key} handed over at ${new Date(c.at).toISOString()}, the window opened after it was due at ${new Date(opens).toISOString()}`);
    }
  }
}

/** The probe at every send call (invariants 2 and 12): the app's state at the moment of the call. */
function probeAtCall(h: EngineHarness, subjects: Map<string, SubjectRecord>, campaigns: CampaignRecord[], problem: (what: string) => void) {
  return async (call: HandoverLogEntry): Promise<void> => {
    const now = h.clock;
    const s = await h.store.engine.subject(call.subjectId, now);
    if (!s) return;
    if (s.subject.ended !== null || s.campaign.launchedAt === null) problem(`2: ${call.subjectId}/${call.stepId} was called while the lead was ${s.subject.ended ?? "not launched"}`);
    const p = s.tracks.find((t) => t.nextStepId === call.stepId && t.finishedAt === null);
    if (!p) problem(`2: ${call.subjectId}/${call.stepId} was called but is not its track's pending step`);
    if (s.results.some((r) => r.stepId === call.stepId)) problem(`2: ${call.subjectId}/${call.stepId} was called after it had a result`);
    const attempt = s.attempts.find((a) => a.id === call.attemptId);
    if (!attempt || attempt.calls > 1) return;
    // 12. No claimed attempt on this account that met every predicate but the slot had higher priority.
    const mine = { touched: s.subject.touched, dueWall: p?.dueWall ?? 0, subjectId: call.subjectId, stepId: call.stepId };
    for (const other of await h.store.engine.openAttempts()) {
      if (other.state !== "claimed" || other.accountId !== call.sender || other.id === call.attemptId) continue;
      const os = await h.store.engine.subject(other.subjectId, now);
      const acc = os?.accounts[other.accountId];
      if (!os || !acc) continue;
      const failed = handoverFailures(os, other, acc, now).filter((n) => n !== 14 && n !== 16);
      if (failed.length > 0) continue;
      const theirs = { touched: os.subject.touched, dueWall: os.tracks.find((t) => t.trackId === other.trackId)?.dueWall ?? 0, subjectId: other.subjectId, stepId: other.stepId };
      if (higherPriority(theirs, mine)) problem(`12: ${call.subjectId}/${call.stepId} was handed over on ${call.sender} before ${other.subjectId}/${other.stepId}, which had priority`);
    }
    void subjects;
    void campaigns;
  };
}
