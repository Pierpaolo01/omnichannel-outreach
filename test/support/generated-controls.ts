import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../src/domain/sequence/definition.ts";
import type { Rules } from "../../src/server/engine/rules.ts";
import type { CallsView, CampaignDetail, CallTaskView, EnrollmentRead, LeadSearchResult, LeadControlApi, OutreachStatus } from "../../src/shared/api.ts";
import { EngineHarness, quickWait } from "./engine-harness.ts";
import { business, person } from "./export-builder.ts";
import type { FakeAccount } from "./fake-email-port.ts";
import type { FakeNumber } from "./fake-sms-port.ts";
import { random } from "./generated-sequences.ts";
import { dueAfter, local, startOfDay } from "./sequence-model.ts";

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
  /** The pre-send defect of ca8baee, for a mutation: the fake email provider answers with the first thread's reply. */
  readonly presendFirstReply?: boolean;
  /** For a mutation: the senders' pacing gap the engine is given, while the record keeps expecting 5 minutes (P3). */
  readonly gapMs?: number;
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
  const gap = options.gapMs ?? 5 * MINUTE;
  const inboxes: FakeAccount[] = [{ id: "inbox-a", capacity: 50, gapMs: gap, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }];
  // One SMS number per campaign, so no conversation is another campaign's (question Q7's hold is the track runs').
  const numbers: FakeNumber[] = [0, 1].map((i) => ({ id: `+44770090001${i}`, capacity: 50, gapMs: gap, k: 2, healthy: true, resetZone: ZONE }));
  // Review bot and verifier on ca8baee, from a stream of their own: providers whose lookups lag behind acceptance (work
  // withdrawn on a non-final "not sent" while still uncertain), and replies the pre-send check reads before observation.
  const r17 = random(seed ^ 0x17d);
  const lookupLags = r17() < 0.4;
  if (lookupLags) features.add("lookups-lag");
  const h = new EngineHarness({ start, accounts: inboxes, modes: lookupLags ? ["lookup-lags"] : lateSends ? ["honest", "late-send"] : ["honest"], random: random(seed ^ 0x17c), engine: { waitFor: quickWait }, sms: { numbers, modes: ["honest"] }, ...(options.rules ? { rules: options.rules } : {}) });
  h.maxWrites = options.maxWrites ?? null;
  // A provider that keeps what it was asked to withdraw: in the runs whose lookups lag too, so a pause meets work withdrawn
  // on a non-final "not sent" while still uncertain (the reviewer's reproduction, review bot on ca8baee, item 2).
  if (keepsSending || lookupLags) h.fake.withdrawAnswers = "unknown-sends";
  if (options.presendFirstReply === true) h.fake.presendFirstReply = true;
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
      // Overlapping holds merge; ones that only touch stay apart: a release and a new hold at one instant leave a running
      // moment, in which the worker's tick after the release may send (two actions at one instant).
      if (last && x.from < last.to) last.to = Math.max(last.to, x.to);
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
    // A start that falls due, or that the app first learns of (a predecessor's late send), while the lead is held happens
    // when it is released: nothing is evaluated while held.
    const rule = t.start;
    const before = rule.kind === "after" ? def(s).tracks.find((x) => x.id === rule.trackId) : undefined;
    const known = Math.max(start, before ? (finishOf(s, before)?.seen ?? start) : start);
    const hold = holdsOf(s).find((x) => x.from <= now && now < x.to);
    if (hold && known >= hold.from) return null;
    for (const [i, st] of t.steps.entries()) {
      const r = resolution(s, t, st.id);
      // A step the provider sent stays the pending step until the app learns of the send.
      if (r !== null && r.seen <= now) continue;
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
    // Learned while held: it ends when the hold is released. A hold that begins at that very instant came after it
    // (the worker's tick runs before the action at an instant).
    return holdsOf(s).find((x) => x.from < at && at < x.to)?.to ?? at;
  }
  const endedAt = (s: Subject, t: number) => endingAt(s, t) !== null || finishedAt(s) <= t;
  /** Whether a step is with a provider: handed over, not delivered, and not withdrawn on the provider's word. */
  function inFlight(t: TrackDefinition, s: Subject, stepId: string): boolean {
    const ch = t.channel;
    if (ch === "call") return false;
    // Sent, but not known to the app yet, is still with the provider as far as the app can tell.
    const known = (d: { key: string; at: number; visibleAt: number }) => Math.min(d.visibleAt, ch === "email" ? (email.lookupLog.find((l) => l.key === d.key && l.answer === "sent" && l.at >= d.at)?.at ?? Infinity) : Infinity) <= h.clock;
    return handovers(ch).some((c) => c.subjectId === s.id && c.stepId === stepId && !deliveries(ch).some((d) => d.key === c.key && known(d)) && !(ch === "email" && email.withdrawLog.some((w) => w.key === c.key && w.answer === "withdrawn")));
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
    settleHidden();
    const now = h.clock;
    // P3: no burst. Two send calls from one sender are never closer than its gap (5 minutes), across every resume.
    for (const provider of [email, sms]) {
      const bySender = new Map<string, number[]>();
      for (const c of provider.handoverLog) bySender.set(c.sender, [...(bySender.get(c.sender) ?? []), c.at]);
      for (const [sender, ats] of bySender) {
        const sorted = [...ats].sort((a, b) => a - b);
        for (let i = 1; i < sorted.length; i++) if (sorted[i]! - sorted[i - 1]! < 5 * MINUTE) problem(`P3: ${sender} made two send calls ${Math.round((sorted[i]! - sorted[i - 1]!) / 1000)} s apart, at ${isoOf(sorted[i])}`);
      }
    }
    // P1 after a reply: no email is handed over to a lead after a pre-send check that could read a reply its record did
    // not hold, until the user restarts it (review bot on ca8baee, item 1).
    for (const [index, r] of email.replyLog.entries()) {
      for (const c of email.handoverLog.filter((x) => x.subjectId === r.subjectId && x.at > r.at)) {
        const restarted = endings.some((e) => e.subjectId === r.subjectId && e.restartedAt >= r.at && e.restartedAt <= c.at);
        // A check after the reply existed (by the provider's own order of events), not one earlier at the same instant.
        const sawIt = email.presendLog.some((p) => p.repliesSeen > index && p.at <= c.at && p.threadRefs.includes(r.threadRef ?? ""));
        if (!restarted && sawIt) problem(`P1: ${r.subjectId}/${c.stepId} was handed over at ${isoOf(c.at)}, after a reply at ${isoOf(r.at)} that a pre-send check could read and before any restart${process.env["CONTROLS_DEBUG"] ? ` [reply ${JSON.stringify(r)}; checks ${JSON.stringify(email.presendLog.filter((p) => p.at >= r.at - HOUR && p.at <= c.at + MINUTE).map((p) => [isoOf(p.at), p.threadRefs, p.answered, p.repliesSeen]))}; endings ${JSON.stringify(endings.filter((e) => e.subjectId === r.subjectId).map((e) => [e.kind, isoOf(e.at), isoOf(e.restartedAt)]))}; app replies ${JSON.stringify((await h.store.engine.subject(r.subjectId, now))?.replies)}; handover ${JSON.stringify([c.key, c.destination, isoOf(c.at)])}; index ${index}]` : ""}`);
      }
    }
    // P12: the day's committed calls, by the record: carried calls open at the day's start, of leads not held then.
    const dayStart = startOfDay(local(now, ZONE).day, ZONE);
    let committed = 0;
    for (const s of subjects.values()) {
      const st = await h.store.engine.subject(s.id, now);
      for (const task of st?.callTasks ?? []) {
        if (task.placedWall >= dayStart) continue;
        const tr = def(s).tracks.find((t) => t.id === task.trackId)!;
        const f = finishOf(s, tr);
        if (f !== null && f.at <= dayStart) continue;
        if (holdsOf(s).some((x) => x.from <= dayStart && dayStart < x.to) || finishedAt(s) <= dayStart) continue;
        committed++;
      }
    }
    const engineDay = await h.store.engine.callDay(now);
    if (engineDay.committed !== committed) problem(`P12: ${engineDay.committed} calls are committed on ${isoOf(dayStart)}'s day; the record counts ${committed}`);
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
          if (heldStrictly(s, c.at)) problem(`P1: ${s.id}/${c.stepId} was handed over at ${isoOf(c.at)} while the lead was held or ended (${JSON.stringify(holdsOf(s).map((x) => [isoOf(x.from), isoOf(x.to)]))})${process.env["CONTROLS_DEBUG"] ? ` [lead pauses ${JSON.stringify(leadPauses.filter((p) => p.subjectId === s.id).map((p) => [isoOf(p.from), isoOf(p.to)]))}; campaign pauses ${JSON.stringify(campaignPauses.filter((p) => p.campaign === s.campaign).map((p) => [isoOf(p.from), isoOf(p.to)]))}; endings ${JSON.stringify(endings.filter((e) => e.subjectId === s.id).map((e) => [e.kind, isoOf(e.at), isoOf(e.restartedAt)]))}; hidden ${JSON.stringify(hidden.filter((x) => x.subjectId === s.id))}]` : ""}`);
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
      if (want === null && !["queued", "active", "waiting_on_call"].includes(status)) problem(`status: ${s.id} is ${status} at ${isoOf(now)}; the record says it runs in the main sequence${process.env["CONTROLS_DEBUG"] ? ` [finishes ${JSON.stringify(def(s).tracks.map((x) => [x.id, isoOf(startOf(s, x)), finishOf(s, x)]).map(([id, a, f]) => [id, a, f && typeof f === "object" ? [isoOf(f.at), isoOf(f.seen), f.reason] : null]))}; winBack ${isoOf(winBack.get(s.id))}; endings ${JSON.stringify(endings.filter((e) => e.subjectId === s.id).map((e) => [e.kind, isoOf(e.at), isoOf(e.restartedAt)]))}; holds ${JSON.stringify(holdsOf(s).map((x) => [isoOf(x.from), isoOf(x.to)]))}; engine ${JSON.stringify(st.tracks.map((p) => [p.trackId, p.finishReason, isoOf(p.finishedWall)]))}; ended ${isoOf(st.subject.endedWall)}; deliveries ${JSON.stringify([...email.deliveryLog, ...sms.deliveryLog].filter((d) => d.subjectId === s.id).map((d) => [d.stepId, isoOf(d.at), isoOf(d.visibleAt)]))}]` : ""}`);
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
        if (want > now && Date.parse(shown.dueAt) !== want) problem(`P2: ${s.id}/${pending.stepId} is due ${shown.dueAt} at ${isoOf(now)}; the record says ${isoOf(want)} (${held ? "held: the wall it was resolved to" : "moved by every hold since its basis"}; holds ${JSON.stringify(holdsOf(s).map((x) => [isoOf(x.from), isoOf(x.to)]))})${process.env["CONTROLS_DEBUG"] ? ` [unheld ${isoOf(pending.unheld)}; prev ${JSON.stringify(t.steps.map((x) => resolution(s, t, x.id)).map((r) => (r ? [isoOf(r.at), isoOf(r.seen), r.kind] : null)))}; deliveries ${JSON.stringify(deliveries(t.channel === "sms" ? "sms" : "email").filter((d) => d.subjectId === s.id && t.steps.some((x) => x.id === d.stepId)).map((d) => [d.stepId, isoOf(d.at), isoOf(d.visibleAt)]))}; engine ${JSON.stringify(st.tracks.find((p) => p.trackId === t.id))}; results ${JSON.stringify(st.results.filter((r) => r.trackId === t.id).map((r) => [r.stepId, r.at, isoOf(r.atWall)]))}; freezes ${JSON.stringify(st.freezes.map((f) => [isoOf(f.fromWall), isoOf(f.toWall)]))}]` : ""}`);
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
  async function control(s: Subject, action: LeadControlApi, options: { readonly othersMayMove?: boolean } = {}): Promise<void> {
    // What the app found while the clock moved (a hidden reply at a pre-send check) is in the record before any action.
    settleHidden();
    const now = h.clock;
    const expected = accepts(s, action, now);
    const read = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${s.id}`)).body;
    const offered = read.controls.find((c) => c.action === action);
    if (!offered || offered.allowed !== expected) problem(`P11: ${s.id}'s read ${offered?.allowed ? "offers" : "refuses"} ${action} at ${isoOf(now)}; the record says it must be ${expected ? "accepted" : "refused"}${offered && !offered.allowed ? ` ("${offered.reason}")` : ""}${process.env["CONTROLS_DEBUG"] ? ` [current ${currentStep(s, now)?.stepId ?? "none"}; starts ${JSON.stringify(def(s).tracks.map((x) => [x.id, JSON.stringify(x.start), isoOf(startOf(s, x)), finishOf(s, x)]))}; lookups ${JSON.stringify(email.lookupLog.filter((l) => l.key === "att-122").map((l) => [isoOf(l.at), l.answer]))}; engineTracks ${JSON.stringify((await h.store.engine.subject(s.id, now))?.tracks.map((p) => [p.trackId, p.startAt, p.startedAt, p.finishReason, isoOf(p.finishedWall)]))}; clock ${JSON.stringify((await h.store.engine.subject(s.id, now))?.subject.clock)}; work ${JSON.stringify((await h.store.engine.subject(s.id, now))?.work.map((w) => [w.stepId, w.key, w.calls, w.settled, w.lookupAnswer]))}; attempts ${JSON.stringify((await h.store.engine.subject(s.id, now))?.attempts.map((a) => [a.stepId, a.idempotencyKey, a.state, a.endedBy]))}; handovers ${JSON.stringify(email.handoverLog.filter((c) => c.subjectId === s.id).map((c) => [c.stepId, c.key, isoOf(c.at), c.mode]))}; deliveries ${JSON.stringify(email.deliveryLog.filter((c) => c.subjectId === s.id).map((c) => [c.stepId, c.key, isoOf(c.at)]))}; withdrawals ${JSON.stringify(email.withdrawLog)}]` : ""}`);
    const current = currentStep(s, now);
    if (action === "skip" && offered?.allowed && current && (offered.skips?.trackId !== current.track.id || offered.skips.stepId !== current.stepId)) problem(`P11: ${s.id}'s read would skip ${offered.skips?.stepId ?? "nothing"}; the record's current step is ${current.stepId}${process.env["CONTROLS_DEBUG"] ? ` [pending ${JSON.stringify(tracksIn(s, branchOf(s, now)).map((t) => [t.id, pendingOf(s, t, now)]).map(([id, p]) => [id, p && typeof p === "object" ? [p.stepId, isoOf(p.due), isoOf(p.unheld)] : null]))}; holds ${JSON.stringify(holdsOf(s).map((x) => [isoOf(x.from), isoOf(x.to)]))}; engine ${JSON.stringify((read.tracks).map((t) => [t.trackId, t.nextStep]))}]` : ""}`);
    if (action === "skip" && current && inFlight(current.track, s, current.stepId)) features.add("skip-refused-with-work-at-the-provider");
    const live = (await h.store.engine.subject(s.id, now))?.attempts.filter((a) => a.state === "claimed" || a.state === "handed" || a.state === "accepted") ?? [];
    const before = await others(s, null);
    const requestId = `c-${++requests}`;
    const uncertain = (await h.store.engine.subject(s.id, now))?.work.some((w) => w.settled === null && w.calls > 0) ?? false;
    const res = await h.request<{ error?: { message: string }; replayed?: boolean; effect?: unknown }>("POST", `/api/enrollments/${s.id}/controls`, { requestId, action });
    const accepted = res.status === 200;
    // The answer's effect is the read's preview at that instant, field for field (verifier B4).
    if (accepted && offered?.allowed && JSON.stringify(res.body.effect) !== JSON.stringify(offered)) problem(`P11: ${action} on ${s.id} at ${isoOf(now)} answered the effect ${JSON.stringify(res.body.effect)}; the read previewed ${JSON.stringify(offered)}`);
    if (!accepted && res.body.error) refused.push({ path: `/api/enrollments/${s.id}/controls`, body: { requestId, action }, message: res.body.error.message });
    if (uncertain) features.add(accepted ? `${action}-with-uncertain-work` : `${action}-refused-with-uncertain-work`);
    if (accepted !== expected) problem(`P11: ${action} on ${s.id} at ${isoOf(now)} was ${accepted ? "accepted" : `refused (${res.body.error?.message ?? res.status})`}; the record says it must be ${expected ? "accepted" : "refused"}`);
    if (offered && !offered.allowed && !accepted && offered.reason !== res.body.error?.message) problem(`P11: ${s.id}'s read refuses ${action} with "${offered.reason}"; the action says "${res.body.error?.message ?? ""}"`);
    // Acting before the worker's tick at a due instant, the tick the control runs may apply what fell due to other leads.
    if (options.othersMayMove !== true) await unchanged(before, `${action} on ${s.id}`);
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
  /** Requests the app refused, to send again later with the same id (P7; verifier B5). */
  const refused: { path: string; body: Record<string, string>; message: string }[] = [];
  /** A refused request sent again, after whatever changed since: the same refusal, and nothing changes. */
  async function retryRefused(): Promise<void> {
    settleHidden();
    const r = refused[Math.floor(r17() * refused.length)];
    if (!r) return;
    const before = await others(null, null);
    const again = await h.request<{ error?: { message: string } }>("POST", r.path, r.body);
    if (again.status !== 409 || again.body.error?.message !== r.message) problem(`P7: ${r.body["requestId"] ?? ""} (${r.path}) was refused ("${r.message}"); sent again at ${isoOf(h.clock)} it was answered ${again.status}${again.body.error ? ` ("${again.body.error.message}")` : ""}`);
    await unchanged(before, `a refused request sent again`);
    features.add("a-refused-request-sent-again-later");
  }

  /**
   * The reviewer's sequence (review bot on ca8baee, item 2): a lead whose email is with a provider whose lookup lags is
   * paused, the first lookup answers a non-final "not sent" (the attempt is withdrawn, the work stays uncertain), then the
   * user asks to skip that step. The record refuses it while the work may still be sent.
   */
  async function pauseThenSkip(): Promise<void> {
    for (const s of subjects.values()) {
      const st = await h.store.engine.subject(s.id, h.clock);
      // The step the skip will name has its email with the provider.
      const current = currentStep(s, h.clock);
      if (!st || endedAt(s, h.clock) || !current || !st.attempts.some((a) => a.stepId === current.stepId && (a.state === "handed" || a.state === "accepted"))) continue;
      if (!leadPausedAt(s, h.clock)) await control(s, "pause");
      await h.advanceTo(h.clock + 16 * MINUTE);
      settleHidden();
      if (process.env["CONTROLS_DEBUG"]) {
        const after = await h.store.engine.subject(s.id, h.clock);
        console.info(`pauseThenSkip ${s.id} ${current.stepId}: ${JSON.stringify(after?.attempts.filter((a) => a.stepId === current.stepId).map((a) => [a.state, a.endedBy, a.calls]))} ${JSON.stringify(after?.work.filter((w) => w.stepId === current.stepId).map((w) => [w.settled, w.calls, w.lookupAnswer]))}`);
      }
      await control(s, "skip");
      features.add("skip-after-a-pause-with-a-lookup-lagging");
      return;
    }
  }

  /**
   * The reviewer's restart (review bot on ca8baee, item 1): a lead with two emails sent in two threads replies in one, is
   * resumed from its next step, then replies again in the other, hidden from observation, so only a pre-send check that
   * reads every thread for a reply the record does not hold stops its next email. Either thread first.
   */
  async function replyRestartReply(): Promise<void> {
    settleHidden();
    for (const s of subjects.values()) {
      const sent = email.deliveryLog.filter((d) => d.subjectId === s.id && d.visibleAt <= h.clock);
      if (sent.length < 2 || endedAt(s, h.clock) || heldAt(s, h.clock)) continue;
      const [a, b] = r17() < 0.5 ? [sent[0]!, sent[1]!] : [sent[1]!, sent[0]!];
      if (!email.prospectReplies(a.destination, true, null, { inThreadOf: a })) return;
      await h.tick();
      replied(s, h.clock);
      if (!accepts(s, "resume_from_next_step", h.clock)) return;
      await control(s, "resume_from_next_step");
      await h.advanceTo(h.clock + MINUTE);
      if (!email.prospectReplies(b.destination, true, null, { inThreadOf: b, hiddenForMs: 12 * HOUR })) return;
      const r = email.replyLog.at(-1)!;
      hidden.push({ id: r.id, subjectId: s.id, thread: r.threadRef ?? "", at: h.clock, visibleAt: h.clock + 12 * HOUR });
      features.add(a === sent[0] ? "a-new-reply-in-a-later-thread-after-a-restart" : "a-new-reply-in-an-earlier-thread-after-a-restart");
      return;
    }
  }

  /**
   * A control at an instant just after something fell due for its lead (a step or a track start), before the worker's
   * tick: the read's preview and the action both apply what fell due first, so they agree (verifier B4).
   */
  async function actAtADueInstant(): Promise<void> {
    const now = h.clock;
    let best: { s: Subject; at: number } | null = null;
    for (const s of subjects.values()) {
      if (endedAt(s, now) || heldAt(s, now)) continue;
      for (const t of tracksIn(s, branchOf(s, now))) {
        const start = startOf(s, t);
        const p = pendingOf(s, t, now);
        for (const at of [start, p?.due ?? null]) if (at !== null && at > now + MINUTE && at < now + 3 * DAY && (!best || at < best.at)) best = { s, at };
      }
    }
    if (!best) return;
    await h.advanceTo(best.at - MINUTE);
    if (endedAt(best.s, h.clock) || heldAt(best.s, h.clock)) return;
    h.clock = best.at + 1000;
    settleHidden();
    const fitting = ACTIONS.filter((x) => accepts(best.s, x, h.clock));
    if (fitting.length === 0) return;
    await control(best.s, pick(fitting), { othersMayMove: true });
    features.add("a-control-just-after-a-due-instant");
    await h.tick();
  }

  /** Replies the observation has not seen yet: each ends its lead when the pre-send check or the observation finds it. */
  const hidden: { id: string; subjectId: string; thread: string; at: number; visibleAt: number }[] = [];
  /** Applies to the record every hidden reply the app has found by now: at the pre-send check that answered it, or when observed. */
  function settleHidden(): void {
    // In the order the app found them: a later one finds the lead already replied.
    const found = hidden
      .map((r) => {
        const byCheck = email.presendLog.find((p) => p.at >= r.at && p.answered === r.id)?.at ?? Infinity;
        return { r, byCheck, at: Math.min(byCheck, r.visibleAt) };
      })
      .filter((x) => x.at <= h.clock)
      .sort((a, b) => a.at - b.at);
    for (const { r, byCheck, at } of found) {
      hidden.splice(hidden.indexOf(r), 1);
      const s = subjects.get(r.subjectId);
      if (!s) continue;
      replied(s, at);
      features.add(byCheck < r.visibleAt ? "a-hidden-reply-found-by-the-pre-send-check" : "a-hidden-reply-observed");
    }
  }
  /** The record's reply: ends a running, held, stopped or finished lead as replied at `at` (2.1); a replied one stays. */
  function replied(s: Subject, at: number): void {
    if (endingAt(s, at)?.kind === "replied") return;
    const stopped = endingAt(s, at);
    if (stopped) {
      stopped.restartedAt = at;
      endings.push({ subjectId: s.id, kind: "replied", at: stopped.at, restartedAt: Infinity });
      features.add("a-reply-to-a-stopped-lead");
    } else endings.push({ subjectId: s.id, kind: "replied", at, restartedAt: Infinity });
  }

  async function campaignControl(ci: number, action: "pause" | "resume"): Promise<void> {
    settleHidden();
    const now = h.clock;
    const paused = campaignPausedAt(ci, now);
    const expected = action === "pause" ? !paused : paused;
    const offered = (await h.request<CampaignDetail>("GET", `/api/campaigns/${campaignIds[ci]!}`)).body.controls.find((c) => c.action === action);
    if (offered?.allowed !== expected) problem(`P11: campaign ${ci + 1}'s read ${offered?.allowed ? "offers" : "refuses"} ${action}; the record says ${expected ? "accept" : "refuse"}`);
    const before = await others(null, ci);
    const body = { requestId: `c-${++requests}` };
    const res = await h.request<{ error?: { message: string } }>("POST", `/api/campaigns/${campaignIds[ci]!}/${action}`, body);
    if (res.status !== 200 && res.body.error) refused.push({ path: `/api/campaigns/${campaignIds[ci]!}/${action}`, body, message: res.body.error.message });
    if ((res.status === 200) !== expected) problem(`P11: ${action} of campaign ${ci + 1} at ${isoOf(now)} was ${res.status === 200 ? "accepted" : "refused"}; the record says ${expected ? "accept" : "refuse"}`);
    await unchanged(before, `${action} of campaign ${ci + 1}`);
    if (!expected) return;
    if (action === "pause") campaignPauses.push({ campaign: ci, from: now, to: Infinity });
    else for (const p of campaignPauses) if (p.campaign === ci && p.to === Infinity) p.to = now;
    features.add(`campaign-${action}d`);
  }

  /**
   * The lead auto-replies: to its latest email, seen at once; or, from a stream of its own, in the thread of any email
   * it was sent, before or after a restart, hidden from observation for some hours, so the pre-send check must find it
   * among every thread (review bot on ca8baee, item 1).
   */
  async function autoReply(): Promise<void> {
    settleHidden();
    const sent = email.deliveryLog.filter((d) => d.visibleAt <= h.clock);
    if (sent.length === 0) return;
    const d = pick(sent);
    if (r17() < 0.5) {
      const s = subjects.get(d.subjectId);
      if (!s) return;
      const hiddenForMs = Math.round((1 + r17() * 5) * HOUR);
      if (!email.prospectReplies(d.destination, true, null, { inThreadOf: d, hiddenForMs })) return;
      const r = email.replyLog.at(-1)!;
      hidden.push({ id: r.id, subjectId: s.id, thread: r.threadRef ?? "", at: h.clock, visibleAt: h.clock + hiddenForMs });
      const latest = email.deliveryLog.filter((x) => x.subjectId === s.id).at(-1);
      features.add(endings.some((e) => e.subjectId === s.id && e.kind === "replied" && Number.isFinite(e.restartedAt)) ? (latest?.key === d.key ? "a-new-reply-in-the-latest-thread-after-a-restart" : "a-new-reply-in-an-earlier-thread-after-a-restart") : "a-hidden-reply");
      return;
    }
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
      replied(s, h.clock);
      features.add(leadPausedAt(s, h.clock) ? "a-reply-while-paused" : "an-auto-reply");
    }
  }

  const ACTIONS: readonly LeadControlApi[] = ["pause", "resume", "skip", "skip", "stop", "resume_from_next_step", "move_to_win_back"];
  const eventCount = options.events ?? 22;
  await checkAll();
  for (let e = 0; e < eventCount && problems.length === 0 && !h.stopped; e++) {
    const r = rand();
    await h.advanceTo(h.clock + (r < 0.5 ? MINUTE : pick([10 * MINUTE, HOUR, 5 * HOUR, 12 * HOUR, DAY])));
    settleHidden();
    // From their own stream: a refused request sent again; a pause and a skip while a lookup lags; a reply, a restart
    // and a new reply hidden in another thread; a control just after a due instant, before the worker's tick.
    const extra = r17();
    if (extra < 0.1) await retryRefused();
    else if (extra < 0.25 && lookupLags) await pauseThenSkip();
    else if (extra < 0.4) await replyRestartReply();
    else if (extra < 0.55) await actAtADueInstant();
    // One user action per instant: the event's own action comes a minute after an extra one.
    if (extra < 0.55) await h.advanceTo(h.clock + MINUTE);
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
