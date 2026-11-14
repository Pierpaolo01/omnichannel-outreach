import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../src/domain/sequence/definition.ts";
import type { Rules } from "../../src/server/engine/rules.ts";
import type { CallsView, CampaignDetail, CallTaskView, EnrollmentRead, LeadSearchResult, LeadControlApi, OutreachStatus } from "../../src/shared/api.ts";
import { EngineHarness, quickWait } from "./engine-harness.ts";
import { business, person } from "./export-builder.ts";
import type { FakeAccount } from "./fake-email-port.ts";
import type { FakeNumber } from "./fake-sms-port.ts";
import { random } from "./generated-sequences.ts";
import { dueAfter } from "./sequence-model.ts";

/**
 * Generated control runs (ADR 0003 "Ticket 17a"): the user skips, stops, restarts and moves leads to win-back, and
 * pauses and resumes leads and campaigns, at random instants, through the real HTTP app and SQLite store against
 * the fake email and SMS providers, on a clock the test advances. Pauses with calls, redials, callbacks and the
 * skip limit are the call runs' (`generated-calls.ts`, `pauses: true`); these runs are about the controls'
 * transitions and the timing around them.
 *
 * Generated: one or two campaigns of the same three people, each with an email track of two or three steps, an SMS
 * track beside it in some, a phone track beside it in some, an email track after the first in some, and a win-back
 * email track in half; providers that send at once, or up to an hour late, and in some runs keep sending what they
 * were asked to withdraw. The user acts at random instants (during a wait, with a claim open, with work at the
 * provider, with a call listed), sends each action's id again now and then, reads every lead's offered controls
 * first, and the leads auto-reply. A drain resumes every pause, works the calls and lets every lead finish.
 *
 * The record imports nothing from src/domain/sequence/. From the user's own accepted controls, the replies it
 * triggered and the providers' logs it keeps each lead's held intervals (its pauses, its campaign's, and each ending
 * later undone by a restart), merged, and predicts each email and text's due instant (from the delivered send or the
 * skip, at the point its clock stood, moved by every held interval after it), each track's start and finish, the
 * lead's current step, which control the app must accept, and the status. Checked after every event: P1 (nothing
 * handed over, and no call listed, for a held or ended lead), P2 (the pending step's due instant exactly), P4 (a
 * skipped step is never sent), P5, P6 (each step delivered at most once, results never removed), P7 (a request id
 * sent again gets the same answer), P9 (the clock frozen exactly while held or ended), P10 (other leads unchanged by
 * a control), P11 (each read's offered controls are the record's, and a refusal's reason the action's), and the
 * status; after the drain, every lead ended.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ZONE = "Europe/London";
const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));

export interface ControlRunOptions {
  readonly rules?: Partial<Rules>;
  readonly events?: number;
  readonly maxWrites?: number;
}

export interface ControlRunResult {
  readonly problems: string[];
  readonly stats: { readonly features: readonly string[]; readonly writes: number };
}

/** The invariants a problem names: the labels before its first colon. */
export const controlInvariantsOf = (problem: string): string[] => (problem.split(":")[0] ?? "").split("/").map((x) => x.trim());

const isoOf = (t: number | null | undefined) => (t === null || t === undefined || !Number.isFinite(t) ? "never" : new Date(t).toISOString());

interface Subject {
  readonly id: string;
  readonly campaign: number;
  readonly person: { readonly key: string; readonly name: string; readonly email: string; readonly mobile: string | null };
}
type Interval = { from: number; to: number };

export async function runControls(seed: number, options: ControlRunOptions = {}): Promise<ControlRunResult> {
  try {
    return await runUnguarded(seed, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (process.env["CONTROLS_DEBUG"]) console.error(error);
    return { problems: [`throw: the engine threw: ${message}`], stats: { features: [], writes: 0 } };
  }
}

async function runUnguarded(seed: number, options: ControlRunOptions): Promise<ControlRunResult> {
  const rand = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] ?? items[0]!;
  const chance = (p: number) => rand() < p;
  const problems: string[] = [];
  const problem = (what: string) => {
    if (problems.length < 20 && !problems.includes(what)) problems.push(what);
  };
  const features = new Set<string>();

  const start = Date.parse("2026-11-02T00:00:00Z") + Math.floor(rand() * 7) * DAY + Math.floor(rand() * 24) * HOUR;
  const lateSends = chance(0.5);
  if (lateSends) features.add("late-sends");
  const keepsSending = lateSends && chance(0.4);
  if (keepsSending) features.add("withdrawals-answered-unknown-and-sent");
  const inboxes: FakeAccount[] = [{ id: "inbox-a", capacity: 50, gapMs: 5 * MINUTE, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }];
  // One SMS number per campaign, so no conversation is another campaign's (question Q7's hold is the track runs').
  const numbers: FakeNumber[] = [0, 1].map((i) => ({ id: `+44770090001${i}`, capacity: 50, gapMs: 5 * MINUTE, k: 2, healthy: true, resetZone: ZONE }));
  const h = new EngineHarness({ start, accounts: inboxes, modes: lateSends ? ["honest", "late-send"] : ["honest"], random: random(seed ^ 0x17c), engine: { waitFor: quickWait }, sms: { numbers, modes: ["honest"] }, ...(options.rules ? { rules: options.rules } : {}) });
  h.maxWrites = options.maxWrites ?? null;
  if (keepsSending) h.fake.withdrawAnswers = "unknown-sends";
  const email = h.fake;
  const sms = h.sms;

  const steps = (prefix: string, count: number): StepDefinition[] =>
    Array.from({ length: count }, (_, i) => ({ id: `${prefix}s${i + 1}`, waitDays: i === 0 ? 0 : pick([1, 2]), subject: `Note ${i + 1}, {{first_name|there}}`, body: `Note ${i + 1} for {{company}}.`, threading: "new_subject", removed: false }));
  const campaignCount = chance(0.5) ? 2 : 1;
  const definitions: CampaignDefinition[] = [];
  for (let ci = 0; ci < campaignCount; ci++) {
    const tracks: TrackDefinition[] = [{ id: `k${ci}e1`, channel: "email", branch: "main", window: ALL_DAY, steps: steps(`k${ci}e1`, pick([2, 3])), start: { kind: "entry" }, removed: false }];
    if (chance(0.4)) tracks.push({ id: `k${ci}x1`, channel: "sms", branch: "main", window: ALL_DAY, steps: steps(`k${ci}x1`, pick([1, 2])).map((s) => ({ ...s, subject: "" })), start: { kind: "entry" }, removed: false });
    if (chance(0.5)) tracks.push({ id: `k${ci}p1`, channel: "call", branch: "main", window: ALL_DAY, steps: [{ id: `k${ci}p1c`, waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false }], start: { kind: "entry" }, removed: false, callSkipLimitDays: 30 });
    if (chance(0.5)) tracks.push({ id: `k${ci}e2`, channel: "email", branch: "main", window: ALL_DAY, steps: steps(`k${ci}e2`, pick([1, 2])), start: { kind: "after", trackId: `k${ci}e1`, delayDays: pick([0, 1]) }, removed: false });
    if (chance(0.5)) tracks.push({ id: `k${ci}w1`, channel: "email", branch: "win_back", window: ALL_DAY, steps: steps(`k${ci}w1`, pick([1, 2])), start: { kind: "entry" }, removed: false });
    definitions.push({ timezone: ZONE, callSkipLimitDays: 30, emailPool: ["inbox-a"], smsPool: [numbers[ci]!.id], callScript: "Ask who handles bookings.", tracks });
  }
  for (const d of definitions) {
    for (const t of d.tracks) features.add(`a-${t.channel}-track${t.branch === "win_back" ? "-in-win-back" : ""}`);
  }
  const people = [
    { key: "p1", name: "Pat Oneil", email: "pat@harbour.example", mobile: "+447700900101" },
    { key: "p2", name: "Nia Cole", email: "nia@harbour.example", mobile: chance(0.5) ? "+447700900102" : null },
    { key: "p3", name: "Sam Reed", email: "sam@harbour.example", mobile: null },
  ];
  const rows = {
    businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", timezone: ZONE, phone_e164: "+442079460101" })],
    people: people.map((p) => person({ person_id: p.key, business_id: "b1", full_name: p.name, timezone: ZONE, email: p.email, ...(p.mobile ? { dial_phone: p.mobile, dial_phone_type: "mobile" } : {}) })),
  };
  await h.tick();
  if ((await h.request("PUT", "/api/call-settings", { dailyCapacity: 50, userZone: ZONE })).status !== 200) problem("setup: call settings refused");
  const campaignIds: string[] = [];
  const launchedAt: number[] = [];
  const subjects = new Map<string, Subject>();
  for (const [ci, d] of definitions.entries()) {
    const { campaign } = await h.createCampaign(`Campaign ${ci + 1}`, rows, ZONE);
    await h.defineSequence(campaign.id, d);
    campaignIds.push(campaign.id);
  }
  for (const [ci, id] of campaignIds.entries()) {
    if ((await h.launch(id)).status !== 200) {
      problem(`setup: launch of campaign ${ci + 1} refused`);
      return { problems, stats: { features: [...features], writes: h.writes } };
    }
    launchedAt.push(h.clock);
    for (const row of (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${id}&limit=50`)).body.rows) {
      const e = row.enrollments.find((x) => x.campaign.id === id);
      const p = people.find((x) => x.name === row.name);
      if (e && p) subjects.set(e.id, { id: e.id, campaign: ci, person: p });
    }
    if (ci === 0 && campaignCount > 1) await h.advanceTo(h.clock + pick([0, HOUR, 3 * HOUR]));
  }
  const def = (s: Subject) => definitions[s.campaign]!;

  // ----------------------------------------------------------------------------------------------
  // The record.

  /** The user's accepted controls and their instants. */
  const leadPauses: { subjectId: string; from: number; to: number }[] = [];
  const campaignPauses: { campaign: number; from: number; to: number }[] = [];
  /** Each ending of a lead (a stop, or a reply the app observed): its instant, and the restart that undid it, if any. */
  const endings: { subjectId: string; kind: "stopped_manually" | "replied"; at: number; restartedAt: number }[] = [];
  const skips: { subjectId: string; trackId: string; stepId: string; at: number }[] = [];
  const winBack = new Map<string, number>();
  /** Calls the drain logged, by lead and phone track: the instant. */
  const callsDone = new Map<string, number>();

  function holdsOf(s: Subject): Interval[] {
    const all: Interval[] = [
      ...leadPauses.filter((p) => p.subjectId === s.id),
      ...campaignPauses.filter((p) => p.campaign === s.campaign),
      ...endings.filter((e) => e.subjectId === s.id).map((e) => ({ from: e.at, to: e.restartedAt })),
    ].sort((a, b) => a.from - b.from);
    const out: Interval[] = [];
    for (const x of all) {
      const last = out.at(-1);
      if (last && x.from <= last.to) last.to = Math.max(last.to, x.to);
      else out.push({ ...x });
    }
    return out;
  }
  /** Where the lead's clock stood at wall instant `t`: the start of the held interval `t` lies in, else `t` (3.3). */
  const pointOf = (s: Subject, t: number) => holdsOf(s).find((x) => x.from <= t && t < x.to)?.from ?? t;
  /** A deadline resolved at running point `basis` and falling at `target` with no hold, moved by every hold from the basis on. */
  function afterHolds(s: Subject, basis: number, target: number): number {
    let at = target;
    for (const x of holdsOf(s)) if (x.from >= basis && x.from < at) at += x.to - x.from;
    return at;
  }
  const heldAt = (s: Subject, t: number) => holdsOf(s).some((x) => x.from <= t && t < x.to);
  const heldStrictly = (s: Subject, t: number) => holdsOf(s).some((x) => x.from < t && t < x.to);
  const leadPausedAt = (s: Subject, t: number) => leadPauses.some((p) => p.subjectId === s.id && p.from <= t && t < p.to);
  const campaignPausedAt = (ci: number, t: number) => campaignPauses.some((p) => p.campaign === ci && p.from <= t && t < p.to);
  /** The ending holding the lead at `t`, not yet undone. */
  const endingAt = (s: Subject, t: number) => endings.find((e) => e.subjectId === s.id && e.at <= t && t < e.restartedAt) ?? null;
  const branchOf = (s: Subject, t: number) => ((winBack.get(s.id) ?? Infinity) <= t ? "win_back" : "main");
  const tracksIn = (s: Subject, branch: "main" | "win_back") => def(s).tracks.filter((t) => t.branch === branch);

  const deliveries = (ch: "email" | "sms") => (ch === "sms" ? sms.deliveryLog : email.deliveryLog);
  const handovers = (ch: "email" | "sms") => (ch === "sms" ? sms.handoverLog : email.handoverLog);
  const delivered = (ch: "email" | "sms", s: Subject, stepId: string) => deliveries(ch).find((d) => d.subjectId === s.id && d.stepId === stepId);

  /** How a step was resolved, by the record: delivered (at the point the clock stood at its send) or skipped by the user. */
  function resolution(s: Subject, t: TrackDefinition, stepId: string): { at: number; seen: number; kind: "sent" | "skipped" } | null {
    const skip = skips.find((x) => x.subjectId === s.id && x.stepId === stepId);
    if (skip) return { at: pointOf(s, skip.at), seen: skip.at, kind: "skipped" };
    if (t.channel === "call") return null;
    const d = delivered(t.channel, s, stepId);
    if (!d) return null;
    const call = handovers(t.channel).find((c) => c.key === d.key);
    // The app learns of a send from the provider's event or from a lookup that answers sent, whichever is first.
    const looked = t.channel === "email" ? (email.lookupLog.find((l) => l.key === d.key && l.answer === "sent" && l.at >= d.at)?.at ?? Infinity) : Infinity;
    return { at: pointOf(s, Math.max(d.at, call?.at ?? d.at)), seen: Math.min(d.visibleAt, looked), kind: "sent" };
  }
  /** A track's start (wall), or null while its rule is not met. */
  function startOf(s: Subject, t: TrackDefinition): number | null {
    if (t.branch === "win_back") {
      const w = winBack.get(s.id);
      return w === undefined ? null : pointOf(s, w);
    }
    if (t.start.kind === "entry") return launchedAt[s.campaign]!;
    const rule = t.start;
    const before = def(s).tracks.find((x) => x.id === rule.trackId)!;
    const f = finishOf(s, before);
    // Resolved when the app learns the predecessor finished (a late send is observed later), from its stored finish.
    if (f === null || f.reason === "dropped_for_win_back" || f.seen > h.clock) return null;
    return afterHolds(s, f.at, dueAfter(f.at, rule.delayDays, ZONE));
  }
  const reaches = (s: Subject, t: TrackDefinition) => (t.channel === "sms" ? s.person.mobile !== null : true);
  /** A track's finish by the record: at its last step's resolution, at its start when it cannot reach the lead, at a skip of its call. */
  function finishOf(s: Subject, t: TrackDefinition): { at: number; seen: number; reason: string } | null {
    const w = winBack.get(s.id);
    const start = startOf(s, t);
    const dropAt = w !== undefined && t.branch === "main" ? pointOf(s, w) : Infinity;
    const natural = ((): { at: number; seen: number; reason: string } | null => {
      if (start === null) return null;
      if (!reaches(s, t)) return { at: start, seen: start, reason: "skipped_missing_channel" };
      if (t.channel === "call") {
        const skip = skips.find((x) => x.subjectId === s.id && x.trackId === t.id);
        if (skip) return { at: pointOf(s, skip.at), seen: skip.at, reason: "skipped_by_user" };
        const done = callsDone.get(`${s.id}/${t.id}`);
        return done === undefined ? null : { at: done, seen: done, reason: "completed" };
      }
      const res = t.steps.map((st) => resolution(s, t, st.id));
      if (res.some((r) => r === null)) return null;
      const last = res.at(-1)!;
      return { at: last.at, seen: Math.max(...res.map((r) => r!.seen)), reason: res.every((r) => r!.kind === "skipped") ? "skipped" : "completed" };
    })();
    if (natural !== null && natural.seen <= dropAt) return natural;
    if (Number.isFinite(dropAt)) return { at: dropAt, seen: w ?? dropAt, reason: "dropped_for_win_back" };
    return natural;
  }
  /** The pending step of a started, unfinished track, with its due instant and the stored wall it was resolved to. */
  /** Lead time at wall instant `w`: the time run since launch, less every hold before `w` (3.2). */
  function leadOfWall(s: Subject, w: number): number {
    let held = 0;
    for (const x of holdsOf(s)) if (x.from < w) held += Math.min(w, x.to) - x.from;
    return w - launchedAt[s.campaign]! - held;
  }
  function pendingOf(s: Subject, t: TrackDefinition, now: number): { stepId: string; due: number; unheld: number; lead: number } | null {
    const start = startOf(s, t);
    const f = finishOf(s, t);
    if (start === null || start > now || (f !== null && f.seen <= now)) return null;
    // A start that falls due while the lead is held happens when it is released: nothing is evaluated while held.
    const hold = holdsOf(s).find((x) => x.from <= now && now < x.to);
    if (hold && start >= hold.from) return null;
    for (const [i, st] of t.steps.entries()) {
      const r = resolution(s, t, st.id);
      if (r !== null && r.seen <= now) continue;
      if (r !== null) return null;
      if (i === 0) return { stepId: st.id, due: start, unheld: start, lead: leadOfWall(s, start) };
      const prev = resolution(s, t, t.steps[i - 1]!.id)!;
      const unheld = dueAfter(prev.at, st.waitDays, ZONE);
      return { stepId: st.id, due: afterHolds(s, prev.at, unheld), unheld, lead: leadOfWall(s, prev.at) + (unheld - prev.at) };
    }
    return null;
  }
  /** Every track of the lead's branch finished, as the app knows it by `t`. */
  function finishedBy(s: Subject, t: number): boolean {
    return tracksIn(s, branchOf(s, t)).every((tr) => {
      const f = finishOf(s, tr);
      return f !== null && f.seen <= t;
    });
  }
  /** The instant the lead ended with nothing left (sequence finished), or Infinity: the last finish of its branch, while it ran. */
  function finishedAt(s: Subject): number {
    const branch = winBack.has(s.id) ? "win_back" : "main";
    const seen = tracksIn(s, branch).map((tr) => finishOf(s, tr)?.seen ?? Infinity);
    const at = Math.max(...seen);
    if (!Number.isFinite(at)) return Infinity;
    // Learned while held: it ends when the hold is released.
    return holdsOf(s).find((x) => x.from <= at && at < x.to)?.to ?? at;
  }
  const endedAt = (s: Subject, t: number) => endingAt(s, t) !== null || finishedAt(s) <= t;
  /** Whether a step is with a provider: handed over, not delivered, and not withdrawn on the provider's word. */
  function inFlight(t: TrackDefinition, s: Subject, stepId: string): boolean {
    const ch = t.channel;
    if (ch === "call") return false;
    return handovers(ch).some((c) => c.subjectId === s.id && c.stepId === stepId && !deliveries(ch).some((d) => d.key === c.key) && !(ch === "email" && email.withdrawLog.some((w) => w.key === c.key && w.answer === "withdrawn")));
  }
  /** The lead's current step (question Q3's interim): the pending step due first, ties by track id. */
  function currentStep(s: Subject, now: number): { track: TrackDefinition; stepId: string; lead: number } | null {
    const all = tracksIn(s, branchOf(s, now)).flatMap((t) => {
      const p = pendingOf(s, t, now);
      return p ? [{ track: t, stepId: p.stepId, lead: p.lead }] : [];
    });
    // In lead time, as the engine orders them: on the wall, two deadlines behind an open hold are both never.
    all.sort((a, b) => a.lead - b.lead || (a.track.id < b.track.id ? -1 : 1));
    return all[0] ?? null;
  }
  /** Whether the record says the app must accept `action` on the lead at `now`. */
  function accepts(s: Subject, action: LeadControlApi, now: number): boolean {
    const ending = endingAt(s, now);
    const ended = endedAt(s, now);
    switch (action) {
      case "pause":
        return !ended && !leadPausedAt(s, now);
      case "resume":
        return !ended && leadPausedAt(s, now);
      case "stop":
        return !ended;
      case "skip": {
        if (ended) return false;
        const c = currentStep(s, now);
        return c !== null && !inFlight(c.track, s, c.stepId);
      }
      case "resume_from_next_step":
        return ending !== null && !finishedBy(s, now);
      case "move_to_win_back":
        return ending !== null && branchOf(s, now) === "main" && tracksIn(s, "win_back").length > 0;
      default:
        return false;
    }
  }

  // ----------------------------------------------------------------------------------------------
  // The checks.

  const seenResults = new Map<string, Set<string>>();
  async function checkAll(): Promise<void> {
    const now = h.clock;
    const q = (await h.request<CallsView>("GET", "/api/calls")).body;
    const listed = new Set([...q.readyNow, ...q.laterToday].map((x) => x.enrollmentId));
    for (const s of subjects.values()) {
      const st = await h.store.engine.subject(s.id, now);
      const read = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${s.id}`)).body;
      if (!st) continue;
      const ending = endingAt(s, now);
      const held = heldAt(s, now);
      // P1, P5: nothing of a held or ended lead is listed; nothing is handed over while it is held or ended.
      if ((held || endedAt(s, now)) && listed.has(s.id)) problem(`P1: ${s.id}'s call is listed at ${isoOf(now)} while it is ${ending ? ending.kind : "held"}`);
      for (const ch of ["email", "sms"] as const) {
        for (const c of handovers(ch).filter((x) => x.subjectId === s.id)) {
          if (heldStrictly(s, c.at)) problem(`P1: ${s.id}/${c.stepId} was handed over at ${isoOf(c.at)} while the lead was held or ended (${JSON.stringify(holdsOf(s).map((x) => [isoOf(x.from), isoOf(x.to)]))})`);
          // P4: a skipped step is never handed over after its skip, and never delivered.
          const skip = skips.find((x) => x.subjectId === s.id && x.stepId === c.stepId);
          if (skip && c.at >= skip.at) problem(`P4: ${s.id}/${c.stepId} was handed over at ${isoOf(c.at)}, after the user skipped it at ${isoOf(skip.at)}`);
        }
        // P6: each step delivered at most once.
        const counts = new Map<string, number>();
        for (const d of deliveries(ch).filter((x) => x.subjectId === s.id)) counts.set(d.stepId, (counts.get(d.stepId) ?? 0) + 1);
        for (const [stepId, n] of counts) if (n > 1) problem(`P6: ${s.id}/${stepId} was delivered ${n} times`);
        for (const sk of skips.filter((x) => x.subjectId === s.id)) if (counts.has(sk.stepId)) problem(`P4: ${s.id}/${sk.stepId} was skipped at ${isoOf(sk.at)} but delivered`);
      }
      // P6: a result is never removed.
      const results = seenResults.get(s.id) ?? new Set<string>();
      for (const r of results) if (!st.results.some((x) => `${x.stepId}:${x.result}` === r)) problem(`P6: ${s.id}'s result ${r} was removed`);
      for (const r of st.results) results.add(`${r.stepId}:${r.result}`);
      seenResults.set(s.id, results);
      // P9: the clock stands still exactly while the lead is held or ended.
      const frozen = st.subject.clock.frozenSince !== null;
      if (frozen !== (held || endedAt(s, now))) problem(`P9: ${s.id}'s clock is ${frozen ? "frozen" : "running"} at ${isoOf(now)}; the record says it is ${held ? "held" : endedAt(s, now) ? "ended" : "running"}`);
      // The status.
      const status = read.status;
      const want: OutreachStatus | null =
        ending ? ending.kind
        : finishedAt(s) <= now ? "sequence_finished_no_response"
        : leadPausedAt(s, now) ? "paused"
        : branchOf(s, now) === "win_back" ? "in_win_back"
        : null;
      if (want !== null && status !== want) problem(`status: ${s.id} is ${status} at ${isoOf(now)}; the record says ${want}${process.env["CONTROLS_DEBUG"] ? ` [finishes ${JSON.stringify(def(s).tracks.map((x) => [x.id, startOf(s, x), finishOf(s, x)]))}; winBack ${isoOf(winBack.get(s.id))}; endings ${JSON.stringify(endings.filter((e) => e.subjectId === s.id))}; holds ${JSON.stringify(holdsOf(s).map((x) => [isoOf(x.from), isoOf(x.to)]))}; engine ${JSON.stringify(st.tracks.map((p) => [p.trackId, p.startedAt, p.finishReason, isoOf(p.finishedWall)]))}; results ${JSON.stringify(st.results.map((r) => [r.stepId, r.result, isoOf(r.atWall)]))}]` : ""}`);
      if (want === null && !["queued", "active", "waiting_on_call"].includes(status)) problem(`status: ${s.id} is ${status} at ${isoOf(now)}; the record says it runs in the main sequence`);
      // P2: every pending email or text is due where the record says: moved by every hold since its basis while
      // the lead runs; the wall it was resolved to while it is held. No step is handed over before it is due.
      for (const t of tracksIn(s, branchOf(s, now))) {
        if (t.channel === "call") continue;
        const pending = pendingOf(s, t, now);
        const shown = read.tracks.find((x) => x.trackId === t.id)?.nextStep ?? null;
        if (!pending || inFlight(t, s, pending.stepId)) continue;
        // A track due to start while the lead is held starts when it is released (nothing is evaluated while held).
        if (shown === null && (held || endedAt(s, now))) continue;
        if (shown === null || shown.stepId !== pending.stepId) {
          if (!endedAt(s, now)) problem(`P2: ${s.id}/${t.id}'s pending step is ${shown?.stepId ?? "none"} at ${isoOf(now)}; the record says ${pending.stepId}${process.env["CONTROLS_DEBUG"] ? ` [start ${isoOf(startOf(s, t))}; before ${JSON.stringify(def(s).tracks.map((x) => [x.id, finishOf(s, x)]))}; skips ${JSON.stringify(skips.filter((x) => x.subjectId === s.id))}; holds ${JSON.stringify(holdsOf(s).map((x) => [isoOf(x.from), isoOf(x.to)]))}; engine ${JSON.stringify(st.tracks.map((p) => [p.trackId, p.nextStepId, p.finishReason]))}; attempts ${JSON.stringify(st.attempts.map((a) => [a.stepId, a.state, isoOf(a.handedWall)]))}]` : ""}`);
          continue;
        }
        const want = held || endedAt(s, now) ? pending.unheld : pending.due;
        // A step already due shows when lead time reached its deadline on today's clock: compared only while still to come.
        if (want > now && Date.parse(shown.dueAt) !== want) problem(`P2: ${s.id}/${pending.stepId} is due ${shown.dueAt} at ${isoOf(now)}; the record says ${isoOf(want)} (${held ? "held: the wall it was resolved to" : "moved by every hold since its basis"}; holds ${JSON.stringify(holdsOf(s).map((x) => [isoOf(x.from), isoOf(x.to)]))})`);
        if (pending.due > pending.unheld && !held) features.add("a-wait-moved-by-a-hold");
      }
      for (const ch of ["email", "sms"] as const) {
        for (const t of def(s).tracks.filter((x) => x.channel === ch)) {
          for (const [i, st2] of t.steps.entries()) {
            const first = handovers(ch).find((c) => c.subjectId === s.id && c.stepId === st2.id);
            if (!first) continue;
            const due = i === 0 ? startOf(s, t) : (() => {
              const prev = resolution(s, t, t.steps[i - 1]!.id);
              return prev ? afterHolds(s, prev.at, dueAfter(prev.at, st2.waitDays, ZONE)) : null;
            })();
            if (due !== null && first.at < due) problem(`P2: ${s.id}/${st2.id} was handed over at ${isoOf(first.at)}, before its due instant ${isoOf(due)}`);
          }
        }
      }
    }
  }

  /**
   * What a control could change of another lead: its ending, pause, branch and clock. Its sends may move at the same
   * instant (a withdrawn claim frees the inbox's place), which is shared capacity, not the control.
   */
  const factsOf = (st: Awaited<ReturnType<typeof h.store.engine.subject>>) =>
    JSON.stringify(st ? { ended: st.subject.ended, paused: st.subject.leadPaused, branch: st.subject.branch, clock: st.subject.clock, freezes: st.freezes, campaignPaused: st.campaign.pausedSince } : null);
  /** The other leads as stored, to check a control changed none of them (P10). */
  async function others(except: Subject | null, campaign: number | null): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const s of subjects.values()) {
      if (s === except || (campaign !== null && s.campaign === campaign)) continue;
      const st = await h.store.engine.subject(s.id, h.clock);
      out.set(s.id, factsOf(st));
    }
    return out;
  }
  async function unchanged(before: Map<string, string>, what: string): Promise<void> {
    for (const [id, was] of before) {
      const st = await h.store.engine.subject(id, h.clock);
      const now = factsOf(st);
      if (now !== was) problem(`P10: ${what} changed ${id}, another lead (${was} to ${now})`);
    }
  }

  // ----------------------------------------------------------------------------------------------
  // The generated user.

  let requests = 0;
  /** One control on one lead, checked against the record, the read before it, and its own repeat. */
  async function control(s: Subject, action: LeadControlApi): Promise<void> {
    const now = h.clock;
    const expected = accepts(s, action, now);
    const read = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${s.id}`)).body;
    const offered = read.controls.find((c) => c.action === action);
    if (!offered || offered.allowed !== expected) problem(`P11: ${s.id}'s read ${offered?.allowed ? "offers" : "refuses"} ${action} at ${isoOf(now)}; the record says it must be ${expected ? "accepted" : "refused"}${offered && !offered.allowed ? ` ("${offered.reason}")` : ""}`);
    const current = currentStep(s, now);
    if (action === "skip" && offered?.allowed && current && (offered.skips?.trackId !== current.track.id || offered.skips.stepId !== current.stepId)) problem(`P11: ${s.id}'s read would skip ${offered.skips?.stepId ?? "nothing"}; the record's current step is ${current.stepId}${process.env["CONTROLS_DEBUG"] ? ` [pending ${JSON.stringify(tracksIn(s, branchOf(s, now)).map((t) => [t.id, pendingOf(s, t, now)]).map(([id, p]) => [id, p && typeof p === "object" ? [p.stepId, isoOf(p.due), isoOf(p.unheld)] : null]))}; holds ${JSON.stringify(holdsOf(s).map((x) => [isoOf(x.from), isoOf(x.to)]))}; engine ${JSON.stringify((read.tracks).map((t) => [t.trackId, t.nextStep]))}]` : ""}`);
    if (action === "skip" && current && inFlight(current.track, s, current.stepId)) features.add("skip-refused-with-work-at-the-provider");
    const live = (await h.store.engine.subject(s.id, now))?.attempts.filter((a) => a.state === "claimed" || a.state === "handed" || a.state === "accepted") ?? [];
    const before = await others(s, null);
    const requestId = `c-${++requests}`;
    const res = await h.request<{ error?: { message: string }; replayed?: boolean }>("POST", `/api/enrollments/${s.id}/controls`, { requestId, action });
    const accepted = res.status === 200;
    if (accepted !== expected) problem(`P11: ${action} on ${s.id} at ${isoOf(now)} was ${accepted ? "accepted" : `refused (${res.body.error?.message ?? res.status})`}; the record says it must be ${expected ? "accepted" : "refused"}`);
    if (offered && !offered.allowed && !accepted && offered.reason !== res.body.error?.message) problem(`P11: ${s.id}'s read refuses ${action} with "${offered.reason}"; the action says "${res.body.error?.message ?? ""}"`);
    await unchanged(before, `${action} on ${s.id}`);
    if (expected) {
      const ending = endingAt(s, now);
      switch (action) {
        case "pause":
          leadPauses.push({ subjectId: s.id, from: now, to: Infinity });
          break;
        case "resume":
          for (const p of leadPauses) if (p.subjectId === s.id && p.to === Infinity) p.to = now;
          break;
        case "stop":
          endings.push({ subjectId: s.id, kind: "stopped_manually", at: now, restartedAt: Infinity });
          break;
        case "skip":
          if (current) skips.push({ subjectId: s.id, trackId: current.track.id, stepId: current.stepId, at: now });
          features.add(`skipped-a-${current?.track.channel ?? "?"}-step`);
          break;
        case "resume_from_next_step":
        case "move_to_win_back":
          if (ending) {
            ending.restartedAt = now;
            features.add(`restarted-after-${ending.kind === "replied" ? "a-reply" : "a-stop"}`);
          }
          // A restart clears the lead's own pause (2.4).
          for (const p of leadPauses) if (p.subjectId === s.id && p.to === Infinity) p.to = now;
          if (action === "move_to_win_back") winBack.set(s.id, now);
          break;
        default:
          break;
      }
      features.add(`${action}-accepted`);
      if (live.some((a) => a.state === "claimed")) features.add(`${action}-with-a-claim-open`);
      if (live.some((a) => a.state !== "claimed")) features.add(`${action}-with-work-at-the-provider`);
      if (campaignPausedAt(s.campaign, now)) features.add(`${action}-inside-a-paused-campaign`);
      if (listedBefore.has(s.id)) features.add(`${action}-with-a-call-listed`);
    } else features.add(`${action}-refused`);
    if (rand() < 0.25) {
      const again = await h.request<{ replayed?: boolean }>("POST", `/api/enrollments/${s.id}/controls`, { requestId, action });
      if (again.status !== res.status || (accepted && again.body.replayed !== true)) problem(`P7: ${requestId} (${action} on ${s.id}) was answered ${res.status} then ${again.status}${accepted ? `, replayed ${String(again.body.replayed)}` : ""}`);
      features.add("a-control-sent-again");
    }
  }
  let listedBefore = new Set<string>();

  async function campaignControl(ci: number, action: "pause" | "resume"): Promise<void> {
    const now = h.clock;
    const paused = campaignPausedAt(ci, now);
    const expected = action === "pause" ? !paused : paused;
    const offered = (await h.request<CampaignDetail>("GET", `/api/campaigns/${campaignIds[ci]!}`)).body.controls.find((c) => c.action === action);
    if (offered?.allowed !== expected) problem(`P11: campaign ${ci + 1}'s read ${offered?.allowed ? "offers" : "refuses"} ${action}; the record says ${expected ? "accept" : "refuse"}`);
    const before = await others(null, ci);
    const res = await h.request("POST", `/api/campaigns/${campaignIds[ci]!}/${action}`, { requestId: `c-${++requests}` });
    if ((res.status === 200) !== expected) problem(`P11: ${action} of campaign ${ci + 1} at ${isoOf(now)} was ${res.status === 200 ? "accepted" : "refused"}; the record says ${expected ? "accept" : "refuse"}`);
    await unchanged(before, `${action} of campaign ${ci + 1}`);
    if (!expected) return;
    if (action === "pause") campaignPauses.push({ campaign: ci, from: now, to: Infinity });
    else for (const p of campaignPauses) if (p.campaign === ci && p.to === Infinity) p.to = now;
    features.add(`campaign-${action}d`);
  }

  /** The lead auto-replies to its latest email: the app ends it as replied when it observes the reply, at once here. */
  async function autoReply(): Promise<void> {
    const sent = email.deliveryLog.filter((d) => d.visibleAt <= h.clock);
    if (sent.length === 0) return;
    const d = pick(sent);
    if (!email.prospectReplies(d.destination, true, null)) return;
    // The reply is on the thread of the person's latest email, whichever campaign sent it.
    const s = subjects.get(email.replyLog.at(-1)?.subjectId ?? "");
    if (!s) return;
    const wasEnded = endedAt(s, h.clock);
    // Any reply makes the lead replied unless it already is (2.1): a running, held, stopped or finished lead alike.
    const wasRunningOrHeld = endingAt(s, h.clock)?.kind !== "replied";
    if (wasEnded && endingAt(s, h.clock) === null) features.add("a-reply-after-the-sequence-finished");
    await h.tick();
    // A reply ends a lead that has not ended, and turns a stopped one into replied (2.1); a replied one stays.
    if (wasRunningOrHeld) {
      const stopped = endingAt(s, h.clock);
      if (stopped) {
        stopped.restartedAt = h.clock;
        endings.push({ subjectId: s.id, kind: "replied", at: stopped.at, restartedAt: Infinity });
        features.add("a-reply-to-a-stopped-lead");
      } else endings.push({ subjectId: s.id, kind: "replied", at: h.clock, restartedAt: Infinity });
      features.add(leadPausedAt(s, h.clock) ? "a-reply-while-paused" : "an-auto-reply");
    }
  }

  const ACTIONS: readonly LeadControlApi[] = ["pause", "resume", "skip", "skip", "stop", "resume_from_next_step", "move_to_win_back"];
  const eventCount = options.events ?? 22;
  await checkAll();
  for (let e = 0; e < eventCount && problems.length === 0 && !h.stopped; e++) {
    const r = rand();
    await h.advanceTo(h.clock + (r < 0.5 ? MINUTE : pick([10 * MINUTE, HOUR, 5 * HOUR, 12 * HOUR, DAY])));
    listedBefore = new Set([...(await h.request<CallsView>("GET", "/api/calls")).body.readyNow].map((x) => x.enrollmentId));
    const kind = rand();
    if (kind < 0.6) {
      const s = pick([...subjects.values()]);
      // Mostly an action that applies to the lead as the record has it; sometimes any.
      const fitting = ACTIONS.filter((a) => accepts(s, a, h.clock));
      await control(s, fitting.length > 0 && chance(0.8) ? pick(fitting) : pick(ACTIONS));
    } else if (kind < 0.75) {
      const ci = Math.floor(rand() * campaignIds.length);
      await campaignControl(ci, campaignPausedAt(ci, h.clock) ? "resume" : "pause");
    } else if (kind < 0.9) await autoReply();
    await checkAll();
  }

  // The drain: every pause resumed, then each day every listed call logged no answer, until every lead has ended.
  if (problems.length === 0 && !h.stopped) {
    await h.advanceTo(h.clock + MINUTE);
    for (let ci = 0; ci < campaignIds.length; ci++) if (campaignPausedAt(ci, h.clock)) await campaignControl(ci, "resume");
    for (const s of subjects.values()) if (leadPausedAt(s, h.clock) && !endedAt(s, h.clock)) await control(s, "resume");
    // Asked through a call: the enclosing check narrows both, and the loop changes them.
    const going = () => problems.length === 0 && !h.stopped;
    for (let day = 0; day < 40 && going(); day++) {
      await h.advanceTo(h.clock + 12 * HOUR);
      for (const item of (await h.request<CallsView>("GET", "/api/calls")).body.readyNow) {
        const view = (await h.request<CallTaskView>("GET", `/api/call-tasks/${item.taskId}`)).body;
        const number = view.numbers.find((n) => !n.bad)?.detailId;
        const res = await h.request("POST", `/api/call-tasks/${item.taskId}/outcome`, { requestId: `drain-${++requests}`, outcome: "no_answer", numberId: number, note: "" });
        if (res.status === 200) callsDone.set(`${item.enrollmentId}/${item.track.id}`, h.clock);
      }
      await checkAll();
      if ([...subjects.values()].every((s) => endedAt(s, h.clock))) break;
    }
    for (const s of subjects.values()) {
      const st = await h.store.engine.subject(s.id, h.clock);
      if (st?.subject.ended === null) problem(`drain: ${s.id} has not ended after the drain${process.env["CONTROLS_DEBUG"] ? ` [clock ${JSON.stringify(st.subject.clock)} paused ${st.subject.leadPaused} branch ${st.subject.branch}; tracks ${JSON.stringify(st.tracks.map((p) => [p.trackId, p.startAt, p.startedAt, p.nextStepId, p.dueAt, p.finishReason]))}; attempts ${JSON.stringify(st.attempts.map((a) => [a.stepId, a.state, a.endedBy, a.withdrawRequested]))}; work ${JSON.stringify(st.work.map((w) => [w.stepId, w.settled, w.unresolvedSince, w.lookupAnswer]))}; results ${JSON.stringify(st.results.map((r) => [r.stepId, r.result]))}; lead ${leadOfNow(st)}]` : ""}`);
    }
  }
  function leadOfNow(st: NonNullable<Awaited<ReturnType<typeof h.store.engine.subject>>>): number {
    return (st.subject.clock.frozenSince ?? h.clock) - st.subject.clock.frozenTotal;
  }
  return { problems, stats: { features: [...features], writes: h.writes } };
}
