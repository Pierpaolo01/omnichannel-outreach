import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../src/domain/sequence/definition.ts";
import type { Rules } from "../../src/server/engine/rules.ts";
import type { CallsView, CampaignDetail, CallTaskView, ControlStepView, EnrollmentRead, InterruptionNoticeView, LeadSearchResult, LeadControlApi, OutreachStatus, TodayView } from "../../src/shared/api.ts";
import { Crash, EngineHarness, quickWait } from "./engine-harness.ts";
import type { CrashPoint } from "../../src/server/engine/engine.ts";
import { business, person } from "./export-builder.ts";
import type { FakeAccount } from "./fake-email-port.ts";
import type { FakeNumber } from "./fake-sms-port.ts";
import { random } from "./generated-sequences.ts";
import { CHANGED_SINCE_CONFIRMED, PREVIEW_CHANGED } from "../../src/domain/sequence/controls.ts";
import { dueAfter, firstOpen, inWindow, local, startOfDay, type Hours } from "./sequence-model.ts";

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
  /** For a mutation: the store counts an account's in-flight places by live attempts, as before council B on 56d599c. */
  readonly occupancyCountsAttempts?: boolean;
  /** For a mutation: every live attempt holds its place, whatever its work's answer, as on 612aa05 (review bot). */
  readonly occupancyKeepsSettled?: boolean;
  /** For a mutation (verifier R2-2 on 612aa05): every text confirmed withdrawn keeps its number's place for good. */
  readonly occupancyKeepsWithdrawnTexts?: boolean;
  /**
   * Ticket 20a's family (ADR 0003 "Ticket 20a", the generated test): the application stops (cleanly or by a crash at a
   * named point, sometimes crashing again while it recovers), the providers are cut off while it runs, and a provider's
   * answer is held while the clock moves on, from a stream of their own; one inbox of capacity 3 a day shared by both
   * campaigns; a world starting in the week of the 25 October 2026 clock change.
   */
  readonly interruptions?: boolean;
  /**
   * A fixed run of the family (verifier on 2f7cd20): emails the provider sends up to an hour late and keeps when asked to
   * withdraw them, a lead paused with its email at the provider (its withdrawal answered unknown), then the
   * application stopped for six minutes: after recovery the withdrawal must be asked again a settling period after the
   * last ask (check A).
   */
  readonly withdrawalAcrossARecovery?: boolean;
  /**
   * For a mutation (council on 57d874f, item 1): a confirmation left open sends the precondition of the read current when it
   * is confirmed, not of the read it opened on, as a confirmation that re-targets on a live read would.
   */
  readonly clickTimeExpectation?: boolean;
  /**
   * A fixed run (the reply identity rule, ADR 0003 "Ticket 17a"): a lead with a text track of two steps texts back after
   * the first, the app observes it, and the user resumes the lead from its next step. The text it was resumed after is
   * not news: its next text goes (P6), and the generic events run on from there.
   */
  readonly smsReplyRestart?: boolean;
  /**
   * A fixed run per channel (the reply identity rule, council on PR 62): a lead replies after its first message, the
   * reply's event hidden from observation for a drawn time longer than the next step's wait, so the pre-send check of the
   * next step finds it first and the lead ends replied; the user resumes the lead, then the delayed observation reports
   * the same reply. It is one reply ("once"), and the next message goes (P6).
   */
  readonly replyBeforeObservation?: "sms" | "email";
  /**
   * The windows family (ADR 0003 "Reads that say when"): sending windows other than all day, prospects in other zones than
   * the user's, an inbox that goes unhealthy for a while, and W3, the dispatcher's next round at each read's instant.
   */
  readonly windows?: boolean;
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

  const usual = Date.parse("2026-11-02T00:00:00Z") + Math.floor(rand() * 7) * DAY + Math.floor(rand() * 24) * HOUR;
  // Ticket 20a: interruptions come from a stream of their own, so a run without them is the run it was.
  const interrupting = options.interruptions === true;
  const r20 = random(seed ^ 0x20a);
  const start = interrupting ? Date.parse("2026-10-21T00:00:00Z") + Math.floor(r20() * 7) * DAY + Math.floor(r20() * 24) * HOUR : usual;
  const CAPACITY = interrupting ? 3 : 50;
  const lateSends = chance(0.5) || options.withdrawalAcrossARecovery === true;
  if (lateSends) features.add("late-sends");
  const keepsSending = lateSends && chance(0.4);
  if (keepsSending) features.add("withdrawals-answered-unknown-and-sent");
  // ADR 0003 "Reads that say when": the windows family (`windows: true`), from a stream of its own so every other draw stays as
  // it was. Not in the interruption family or the scripted runs, whose own checks assume all-day windows and one inbox.
  const rW = random(seed ^ 0x23f);
  const drawsWindows = options.windows === true && !interrupting && options.smsReplyRestart !== true && options.replyBeforeObservation === undefined && options.withdrawalAcrossARecovery !== true;
  // Pacing gaps long enough to cross a window's close, a pool of one to three inboxes, and one inbox that can run out of room.
  const gap = options.gapMs ?? (drawsWindows ? [5 * MINUTE, 30 * MINUTE, 2 * HOUR][Math.floor(rW() * 3)]! : 5 * MINUTE);
  const inboxIds = drawsWindows ? ["inbox-a", "inbox-b", "inbox-c"].slice(0, 1 + Math.floor(rW() * 3)) : ["inbox-a"];
  // With two or more inboxes, one is always small enough to run out on a busy day: a pool with one inbox full and another
  // briefly held is the case "a mixed pool gives the full sender's reason" breaks (council on cc9bf55, item 3).
  const smallInbox = drawsWindows && (inboxIds.length > 1 || rW() < 0.4) ? inboxIds[Math.floor(rW() * inboxIds.length)]! : null;
  const capacityOf = (sender: string) => (sender.startsWith("+") ? 50 : sender === smallInbox ? 2 : CAPACITY);
  const inboxes: FakeAccount[] = inboxIds.map((id) => ({ id, capacity: capacityOf(id), gapMs: gap, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }));
  // One SMS number per campaign, so no conversation is another campaign's (question Q7's hold is the track runs').
  const numbers: FakeNumber[] = [0, 1].map((i) => ({ id: `+44770090001${i}`, capacity: 50, gapMs: gap, k: 2, healthy: true, resetZone: ZONE }));
  // Review bot and verifier on ca8baee, from a stream of their own: providers whose lookups lag behind acceptance (work
  // withdrawn on a non-final "not sent" while still uncertain), and replies the pre-send check reads before observation.
  const r17 = random(seed ^ 0x17d);
  // Ticket 17b, from a stream of its own: a Skip confirmation left open on an earlier read, confirmed after its step changed.
  const r18 = random(seed ^ 0x181);
  const lookupLags = r17() < 0.4;
  if (lookupLags) features.add("lookups-lag");
  // Review bot on 612aa05, from a stream of its own: emails the provider sends but never reports (no event, lookups
  // unknown), so a pause meets a too-late answer whose send time stays unknown.
  const silentSends = random(seed ^ 0x17f)() < 0.3 && options.withdrawalAcrossARecovery !== true;
  if (silentSends) features.add("sends-never-reported");
  // Verifier R2-2 on 612aa05, from a stream of its own: texts the provider sends late, so a pause can withdraw one.
  const lateTexts = random(seed ^ 0x180)() < 0.5;
  if (lateTexts) features.add("texts-sent-late");
  const h = new EngineHarness({ start, accounts: inboxes, modes: [...(lookupLags ? ["lookup-lags" as const] : lateSends ? ["honest" as const, "late-send" as const] : ["honest" as const]), ...(silentSends ? ["silent-send" as const] : [])], random: random(seed ^ 0x17c), engine: { waitFor: quickWait }, sms: { numbers, modes: lateTexts ? ["honest", "late-send"] : ["honest"] }, ...(options.rules ? { rules: options.rules } : {}) });
  /**
   * The record's log of claims, as each is made (the engine's claim event: which step, which inbox, when), so the "ready"
   * checks know a claim's actual inbox and slot (the coordinator on 712884b).
   */
  const claimLog: { subjectId: string; stepId: string; sender: string; at: number; seq: number }[] = [];
  /**
   * The record's events that withdraw a lead's claims, in order (a numbered log, since a control and a claim can share an
   * instant: the route's round claims after its control, a round before an event claims before it): an accepted pause,
   * stop, restart or win-back of the lead, a skip of one step, a campaign's pause, a reply.
   */
  const withdrawals: { subjectId: string | null; campaign: number | null; stepId: string | null; seq: number }[] = [];
  let recordSeq = 0;
  const hooksBefore = h.hooks;
  h.hooks = {
    ...hooksBefore,
    afterClaim: async (id) => {
      const a = await h.store.engine.attempt(id);
      if (a) claimLog.push({ subjectId: a.subjectId, stepId: a.stepId, sender: a.accountId, at: h.clock, seq: ++recordSeq });
      await hooksBefore.afterClaim?.(id);
    },
  };
  h.maxWrites = options.maxWrites ?? null;
  if (silentSends) h.fake.silentRevealAfterMs = DAY;
  // A provider that keeps what it was asked to withdraw: in the runs whose lookups lag too, so a pause meets work withdrawn
  // on a non-final "not sent" while still uncertain (the reviewer's reproduction, review bot on ca8baee, item 2).
  if (keepsSending || lookupLags || options.withdrawalAcrossARecovery === true) h.fake.withdrawAnswers = "unknown-sends";
  if (options.presendFirstReply === true) h.fake.presendFirstReply = true;
  if (options.occupancyCountsAttempts === true) {
    // The mutation replaces the store's own count (`occupancy`) with live attempts only.
    const store = h.store.engine as unknown as { db: { prepare(sql: string): { get(...a: unknown[]): Record<string, unknown> | undefined } }; occupancy: (id: string) => number };
    store.occupancy = (id: string) => Number(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE account_id = ? AND state IN ('claimed', 'handed', 'accepted')").get(id)?.["n"] ?? 0);
  }
  if (options.occupancyKeepsWithdrawnTexts === true) {
    const store = h.store.engine as unknown as { db: { prepare(sql: string): { get(...a: unknown[]): Record<string, unknown> | undefined } }; occupancy: (id: string) => number };
    const own = store.occupancy.bind(store);
    store.occupancy = (id: string) => own(id) + (id.startsWith("+") ? Number(store.db.prepare("SELECT COUNT(*) AS n FROM provider_work WHERE account_id = ? AND settled = 'withdrawn'").get(id)?.["n"] ?? 0) : 0);
  }
  if (options.occupancyKeepsSettled === true) {
    // The mutation restores 612aa05's count: every live attempt's key, plus work that may still be sent.
    const store = h.store.engine as unknown as { db: { prepare(sql: string): { get(...a: unknown[]): Record<string, unknown> | undefined } }; occupancy: (id: string) => number };
    store.occupancy = (id: string) =>
      Number(store.db.prepare("SELECT COUNT(*) AS n FROM (SELECT idempotency_key AS k FROM attempts WHERE account_id = ? AND state IN ('claimed', 'handed', 'accepted') UNION SELECT key FROM provider_work WHERE account_id = ? AND settled IS NULL AND calls > 0 AND went_wall IS NULL)").get(id, id)?.["n"] ?? 0);
  }
  const email = h.fake;
  const sms = h.sms;
  // The windows family's sending windows, prospect zones and inbox outages (unhealthy, or rate-limited), drawn from `rW`.
  const WINDOW_DAYS = [[1, 2, 3, 4, 5], [2, 3, 4, 5, 6], [0, 1, 2, 3, 4, 5, 6], [1, 3, 5]];
  const WINDOW_HOURS = [[9, 17], [8, 12], [13, 18], [20, 24], [22, 2], [0, 24]];
  const drawWindow = (): Hours[] => {
    if (!drawsWindows || rW() < 0.4) return ALL_DAY;
    const days = WINDOW_DAYS[Math.floor(rW() * WINDOW_DAYS.length)]!;
    const [start, end] = WINDOW_HOURS[Math.floor(rW() * WINDOW_HOURS.length)]!;
    return days.map((day) => ({ day, start: start!, end: end! }));
  };
  const ZONES = ["Europe/London", "America/New_York", "Australia/Sydney"];
  const zoneOfPerson = new Map<string, string>();
  /** The inbox's outages the run caused, [from, to): unhealthy at the provider, or rate-limited until `to`. */
  const outages: { inbox: string; from: number; to: number; kind: "unhealthy" | "rate_limited" }[] = [];
  /**
   * Work handed to the inbox's provider that the record has no final answer for (no delivery, no confirmed withdrawal): an
   * outage then is the review bot's case on 178de98, a new claim inheriting that work's reservation while the inbox is down.
   */
  const unsettledAtTheProvider = () => email.handoverLog.some((c) => !email.deliveryLog.some((d) => d.key === c.key) && !email.withdrawLog.some((w) => w.key === c.key && w.answer === "withdrawn"));
  /** An outage of the inbox (unhealthy at the provider) is drawn at an event and ends at the first event after `until`. */
  const down: { outage: { until: number; index: number } | null } = { outage: null };
  const takeInboxDown = (now: number) => {
    const current = down.outage;
    const failing = current ? email.accountsById.get(outages[current.index]!.inbox) : undefined;
    if (current !== null && now >= current.until && failing) {
      failing.healthy = true;
      outages[current.index] = { ...outages[current.index]!, to: now };
      down.outage = null;
    } else if (current === null && drawsWindows && rW() < (unsettledAtTheProvider() ? 0.5 : 0.2)) {
      // A rate limit falls on an inbox other than the small one, when there is one (the mixed pool's case).
      const limitable = inboxIds.filter((x) => x !== smallInbox);
      const rateLimit = rW() >= 0.3 && limitable.length > 0;
      const choices = rateLimit ? limitable : inboxIds;
      const inbox = choices[Math.floor(rW() * choices.length)]!;
      const until = now + [HOUR, 5 * HOUR, DAY][Math.floor(rW() * 3)]!;
      if (!rateLimit) {
        // Unhealthy at the provider: the engine reads it at its next account sync.
        email.accountsById.get(inbox)!.healthy = false;
        outages.push({ inbox, from: now, to: Infinity, kind: "unhealthy" });
        down.outage = { until, index: outages.length - 1 };
      } else {
        // Rate-limited until `until`: the engine learns it when a send is refused, and waits until then.
        email.rateLimitedUntil.set(inbox, until);
        outages.push({ inbox, from: now, to: until, kind: "rate_limited" });
      }
    }
  };

  const steps = (prefix: string, count: number): StepDefinition[] =>
    Array.from({ length: count }, (_, i) => ({ id: `${prefix}s${i + 1}`, waitDays: i === 0 ? 0 : pick([1, 2]), subject: `Note ${i + 1}, {{first_name|there}}`, body: `Note ${i + 1} for {{company}}.`, threading: "new_subject", removed: false }));
  const campaignCount = chance(0.5) ? 2 : 1;
  const definitions: CampaignDefinition[] = [];
  for (let ci = 0; ci < campaignCount; ci++) {
    const tracks: TrackDefinition[] = [{ id: `k${ci}e1`, channel: "email", branch: "main", window: ALL_DAY, steps: steps(`k${ci}e1`, pick([2, 3])), start: { kind: "entry" }, removed: false }];
    // The scripted SMS reply run gives the first campaign a text track of two steps, so a resumed lead has a text left.
    // The draws stay as they were for every other run, so no recorded seed moves.
    const texts = chance(0.4);
    const textSteps = texts ? pick([1, 2]) : 2;
    const scriptedTexts = options.smsReplyRestart === true || options.replyBeforeObservation === "sms";
    if (texts || (scriptedTexts && ci === 0)) tracks.push({ id: `k${ci}x1`, channel: "sms", branch: "main", window: ALL_DAY, steps: steps(`k${ci}x1`, scriptedTexts ? 2 : textSteps).map((s) => ({ ...s, subject: "" })), start: { kind: "entry" }, removed: false });
    if (chance(0.5)) tracks.push({ id: `k${ci}p1`, channel: "call", branch: "main", window: ALL_DAY, steps: [{ id: `k${ci}p1c`, waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false }], start: { kind: "entry" }, removed: false, callSkipLimitDays: 30 });
    if (chance(0.5)) tracks.push({ id: `k${ci}e2`, channel: "email", branch: "main", window: ALL_DAY, steps: steps(`k${ci}e2`, pick([1, 2])), start: { kind: "after", trackId: `k${ci}e1`, delayDays: pick([0, 1]) }, removed: false });
    if (chance(0.5)) tracks.push({ id: `k${ci}w1`, channel: "email", branch: "win_back", window: ALL_DAY, steps: steps(`k${ci}w1`, pick([1, 2])), start: { kind: "entry" }, removed: false });
    // Drawn after the generator's own draws, from the windows' stream: a call track keeps its all-day hours.
    definitions.push({ timezone: ZONE, callSkipLimitDays: 30, emailPool: inboxIds, smsPool: [numbers[ci]!.id], callScript: "Ask who handles bookings.", tracks: tracks.map((t) => (t.channel === "call" ? t : { ...t, window: drawWindow() })) });
  }
  for (const d of definitions) {
    for (const t of d.tracks) features.add(`a-${t.channel}-track${t.branch === "win_back" ? "-in-win-back" : ""}`);
  }
  const people = [
    { key: "p1", name: "Pat Oneil", email: "pat@harbour.example", mobile: "+447700900101" },
    { key: "p2", name: "Nia Cole", email: "nia@harbour.example", mobile: chance(0.5) ? "+447700900102" : null },
    { key: "p3", name: "Sam Reed", email: "sam@harbour.example", mobile: null },
  ];
  for (const p of people) zoneOfPerson.set(p.key, drawsWindows && rW() < 0.5 ? ZONES[Math.floor(rW() * ZONES.length)]! : ZONE);
  const rows = {
    businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", timezone: ZONE, phone_e164: "+442079460101" })],
    people: people.map((p) => person({ person_id: p.key, business_id: "b1", full_name: p.name, timezone: zoneOfPerson.get(p.key) ?? ZONE, email: p.email, ...(p.mobile ? { dial_phone: p.mobile, dial_phone_type: "mobile" } : {}) })),
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
  /** The prospect's zone: waits count in its calendar days, and windows are its local hours (ADR 0003 3.3, 3.4). */
  const zoneOfSubject = (s: Subject) => zoneOfPerson.get(s.person.key) ?? ZONE;
  /** A lead's email sender, fixed at its first email handed over (1.3); null before, when any inbox of the pool may be chosen. */
  const emailSenderOf = (s: Subject): string | null => email.handoverLog.find((c) => c.subjectId === s.id)?.sender ?? null;
  /** The accounts a lead's email or text track may send from: its fixed inbox or the pool, or its campaign's own number. */
  const sendersOf = (s: Subject, t: TrackDefinition): string[] => {
    if (t.channel === "sms") return [numbers[s.campaign]!.id];
    const fixed = emailSenderOf(s);
    return fixed ? [fixed] : inboxIds;
  };

  /**
   * The outage the record has the sender in at `t`, as the engine can know it: unhealthy from its start; rate-limited only
   * once a send to it was refused as rate-limited (the engine then waits until the limit's end).
   */
  // Down as the engine knows it: unhealthy, which its next account sync reads exactly. A rate limit's end is the engine's own
  // reading of the provider's retry-after (its answer instant plus that, or its own backoff), which the record takes from the
  // store where an instant must be explained, and never treats as down: at that instant the engine tries, and is refused.
  const outageUntil = (sender: string, t: number) => outages.find((o) => o.inbox === sender && o.kind === "unhealthy" && o.from <= t && t < o.to) ?? null;
  /** The sender's sends known sent by `t` on its UTC reset day fill its daily room: full whatever the other leads do. */
  const knownSentOn = (sender: string, t: number) => {
    if (sender.startsWith("+")) return 0;
    const day = isoOf(t).slice(0, 10);
    return email.deliveryLog.filter((d) => d.sender === sender && isoOf(d.at).slice(0, 10) === day && Math.min(d.visibleAt, email.lookupLog.find((l) => l.key === d.key && l.answer === "sent" && l.at >= d.at)?.at ?? Infinity) <= t).length;
  };
  const fullBySendsAt = (sender: string, t: number) => knownSentOn(sender, t) >= capacityOf(sender);
  /**
   * The sender's pacing slot by the record before a round at `t`: its last send call made before the round (one made at `t`
   * by an earlier round included: `marks` are the providers' log lengths when the round began) plus the gap.
   */
  const slotBefore = (sender: string, t: number, marks: { email: number; sms: number }) => {
    const calls = [...email.handoverLog.slice(0, marks.email), ...sms.handoverLog.slice(0, marks.sms), ...[...h.swallowedHandovers, ...uncalledHandovers].filter((c) => c.at < t)].filter((c) => c.sender === sender && c.at <= t).map((c) => c.at);
    return calls.length > 0 ? Math.max(...calls) + gap : -Infinity;
  };
  /** Work handed over on an inbox and with no final answer by `t`, by the provider's logs: the places it holds (4.2). */
  const openOn = (sender: string, t: number, marks: { email: number; sms: number }) => {
    if (sender.startsWith("+")) return 0;
    const knownSent = (key: string) => email.deliveryLog.some((d) => d.key === key && Math.min(d.visibleAt, email.lookupLog.find((l) => l.key === key && l.answer === "sent" && l.at >= d.at)?.at ?? Infinity) <= t);
    return new Set(email.handoverLog.slice(0, marks.email).filter((c) => c.sender === sender && c.at <= t && !knownSent(c.key) && !email.refusals.some((x) => x.attemptId === c.attemptId) && !email.withdrawLog.some((w) => w.key === c.key && w.answer !== "unknown" && w.at <= t)).map((c) => c.key)).size;
  };
  /** ADR 0003 1.3 (ruling 6): a lead is touched only by a send observed sent, or a logged call outcome other than skip for now. */
  const touchedAt = (s: Subject, T: number) => (["email", "sms"] as const).some((ch) => deliveries(ch).some((d) => d.subjectId === s.id && d.visibleAt <= T)) || [...callsDone].some(([k, at]) => k.startsWith(`${s.id}/`) && at <= T);

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

  /**
   * Ticket 20a: while the record counts the sends an interruption rescheduled, it reads the providers' logs as they stood
   * when the application came back, before its first tick handed anything over (the engine counts before it claims).
   */
  /** Ticket 20a: the intervals in which the application could not act on the providers (stopped, cut off, asleep mid-request). */
  const downs: Interval[] = [];
  // Open at the start: the tick at an interruption's first instant ran before it began, and saw what was there then.
  const downAt = (t: number) => downs.some((d) => d.from < t && t < d.to) || (h.providersDownUntil !== null && t > (outageFrom ?? Infinity));
  /** The first instant at or after `t` at which the application could act. */
  const upFrom = (t: number) => {
    let at = t;
    for (const d of [...downs].sort((a, b) => a.from - b.from)) if (d.from < at && at < d.to) at = d.to;
    return h.providersDownUntil !== null && at > (outageFrom ?? Infinity) ? Infinity : at;
  };
  let outageFrom: number | null = null;
  let cut: { readonly email: { readonly h: number; readonly d: number }; readonly sms: { readonly h: number; readonly d: number }; readonly presend: number } | null = null;
  /**
   * Handovers a crash interrupted after their commit and before the call: the app cannot know the provider never got them,
   * so by the notice's definition (nothing of the step with a provider) the step is not counted. Each is an attempt id the
   * crash point named; the record reads only which lead and step it was for.
   */
  const committedUncalled: string[] = [];
  /** The same handovers, by provider work, kept for good: with the provider, as the app knows, until a final answer. */
  const uncalledHandovers: { channel: "email" | "sms"; key: string; subjectId: string; stepId: string; sender: string; at: number }[] = [];
  const deliveries = (ch: "email" | "sms") => {
    const log = ch === "sms" ? sms.deliveryLog : email.deliveryLog;
    return cut ? log.slice(0, cut[ch].d) : log;
  };
  const handovers = (ch: "email" | "sms") => {
    const log = ch === "sms" ? sms.handoverLog : email.handoverLog;
    return cut ? log.slice(0, cut[ch].h) : log;
  };
  const delivered = (ch: "email" | "sms", s: Subject, stepId: string) => deliveries(ch).find((d) => d.subjectId === s.id && d.stepId === stepId);

  /** How a step was resolved, by the record: delivered (at the point the clock stood at its send) or skipped by the user. */
  function resolution(s: Subject, t: TrackDefinition, stepId: string): { at: number; seen: number; kind: "sent" | "skipped" } | null {
    const skip = skips.find((x) => x.subjectId === s.id && x.stepId === stepId);
    if (skip) return { at: pointOf(s, skip.at), seen: skip.at, kind: "skipped" };
    if (t.channel === "call" || t.channel === "linkedin") return null;
    const d = delivered(t.channel, s, stepId);
    if (!d) return null;
    const call = handovers(t.channel).find((c) => c.key === d.key);
    // The app learns of a send from the provider's event or from a lookup that answers sent, whichever is first.
    // Either channel (verifier R2-2 on 612aa05: texts are withdrawn and looked up too).
    const port = t.channel === "sms" ? sms : email;
    const lookedAt = port.lookupLog.find((l) => l.key === d.key && l.answer === "sent" && l.at >= d.at)?.at ?? Infinity;
    // A lookup the first withdrawal's "too late" asks for runs in the worker's pass after the control that wanted the
    // withdrawal, at that instant: ordered after the control (council J).
    const firstAsk = port.withdrawLog.find((w) => w.key === d.key);
    const looked = firstAsk && firstAsk.answer === "too-late" && firstAsk.at === lookedAt ? lookedAt + 1 : lookedAt;
    // The app learns of it only once it can observe the provider again (ticket 20a: a stop or an outage).
    const seen = upFrom(Math.min(d.visibleAt, looked));
    return { at: pointOf(s, Math.max(d.at, call?.at ?? d.at)), seen, kind: "sent" };
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
    return afterHolds(s, f.at, dueAfter(f.at, rule.delayDays, zoneOfSubject(s)));
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
      // A step the provider sent stays the pending step until the app learns of the send. The checks run after the
      // worker's pass at `now`, so a send learned in that pass (ordered just after a control at `now`) is known to them.
      if (r !== null && r.seen <= now + 1) continue;
      if (i === 0) return { stepId: st.id, due: start, unheld: start, lead: leadOfWall(s, start) };
      const prev = resolution(s, t, t.steps[i - 1]!.id)!;
      const unheld = dueAfter(prev.at, st.waitDays, zoneOfSubject(s));
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
    if (ch === "call" || ch === "linkedin") return false;
    // Sent, but not known to the app yet, is still with the provider as far as the app can tell.
    const port = ch === "sms" ? sms : email;
    const known = (d: { key: string; at: number; visibleAt: number }) => upFrom(Math.min(d.visibleAt, port.lookupLog.find((l) => l.key === d.key && l.answer === "sent" && l.at >= d.at)?.at ?? Infinity)) <= h.clock;
    // A send call an outage swallowed is with the provider as far as the app can tell (ticket 20a), until a final answer.
    const swallowed = [...h.swallowedHandovers, ...uncalledHandovers].filter((c) => c.channel === ch && c.at <= h.clock);
    // A refusal settles the work only when it answers the key's only call: the provider never took it. After earlier calls of
    // that key whose outcome is unknown the work stays uncertain, so it may still be sent (ADR 0002, the attempt's rule).
    return [...handovers(ch), ...swallowed].some((c) => c.subjectId === s.id && c.stepId === stepId && !deliveries(ch).some((d) => d.key === c.key && known(d)) && !port.withdrawLog.some((w) => w.key === c.key && w.answer === "withdrawn") && !port.refusals.some((x) => "attemptId" in c && x.attemptId === c.attemptId && port.handoverLog.filter((y) => y.key === c.key).length <= 1));
  }
  /**
   * Ticket 20a, R7: the sends the interruption [x, y) rescheduled, by the record, at y (the clock), as the app knows them
   * then: each pending email or text of a lead not ended, nothing of it with the provider, which at some instant of the
   * interruption was due while the lead was neither held nor ended. (The windows are open all day in these runs.)
   */
  /**
   * Question Q21's interim, by the record: a sender could have taken a send during [x, y) if its pacing slot (its last
   * send call before y, answered or swallowed, plus the gap) came before y, and some reset day within [x, y) had fewer
   * sends than its capacity, counting deliveries the app knew of by y.
   */
  function roomDuring(sender: string, x: number, y: number): { from: number; to: number }[] {
    const ch = sender.startsWith("+") ? "sms" : "email";
    const calls = [...handovers(ch).filter((c) => c.sender === sender && c.at < y).map((c) => c.at), ...[...h.swallowedHandovers, ...uncalledHandovers].filter((c) => c.sender === sender && c.at < y).map((c) => c.at)];
    const slot = calls.length > 0 ? Math.max(...calls) + gap : -Infinity;
    const capacity = ch === "sms" ? 50 : CAPACITY;
    const zone = ch === "sms" ? ZONE : "UTC";
    const port = ch === "sms" ? sms : email;
    const known = (d: { key: string; at: number; visibleAt: number }) => upFrom(Math.min(d.visibleAt, port.lookupLog.find((l) => l.key === d.key && l.answer === "sent" && l.at >= d.at)?.at ?? Infinity)) <= y;
    const out: { from: number; to: number }[] = [];
    for (let t = x; t < y; ) {
      const day = local(t, zone).day;
      const next = startOfDay(day + 1, zone);
      const sent = deliveries(ch).filter((d) => d.sender === sender && local(d.at, zone).day === day && known(d)).length;
      const from = Math.max(t, slot);
      const to = Math.min(next, y);
      if (sent < capacity && from < to) out.push({ from, to });
      t = next;
    }
    return out;
  }

  function rescheduledByRecord(x: number, y: number, uncalled: ReadonlySet<string>): number {
    let n = 0;
    for (const s of subjects.values()) {
      if (endedAt(s, y)) continue;
      for (const t of tracksIn(s, branchOf(s, y))) {
        if (t.channel === "call" || !reaches(s, t)) continue;
        const p = pendingOf(s, t, y);
        if (!p || inFlight(t, s, p.stepId) || uncalled.has(`${s.id}/${p.stepId}`)) continue;
        const from = Math.max(x, p.due);
        const instants = [from, ...holdsOf(s).map((hold) => hold.to).filter((at) => at > from && at < y)];
        const sender = t.channel === "sms" ? numbers[s.campaign]!.id : "inbox-a";
        // One common instant: due, the lead neither held nor ended, and the sender with room and its slot (the windows are
        // open all day in these runs).
        const rooms = roomDuring(sender, x, y);
        const candidates = [...instants, ...rooms.map((r) => r.from)].filter((at) => at >= from && at < y);
        if (candidates.some((at) => !heldAt(s, at) && !endedAt(s, at) && rooms.some((r) => r.from <= at && at < r.to))) {
          n++;
          if (process.env["CONTROLS_DEBUG"]) console.info(`counted y=${isoOf(y)} cut=${JSON.stringify(cut)} logs=${email.handoverLog.length}/${sms.handoverLog.length} ${s.id}/${p.stepId} due ${isoOf(p.due)} handovers ${JSON.stringify(handovers(t.channel === "sms" ? "sms" : "email").filter((c) => c.subjectId === s.id && c.stepId === p.stepId).map((c) => [c.key, isoOf(c.at)]))} withdrawals ${JSON.stringify((t.channel === "sms" ? sms : email).withdrawLog.filter((w) => handovers(t.channel === "sms" ? "sms" : "email").some((c) => c.key === w.key && c.subjectId === s.id && c.stepId === p.stepId)).map((w) => [isoOf(w.at), w.answer]))}`);
        }
      }
    }
    return n;
  }

  /** The lead's current step (question Q3's interim): the pending step due first, ties by track id. */
  function currentStep(s: Subject, now: number): { track: TrackDefinition; stepId: string; lead: number } | null {
    const all = tracksIn(s, branchOf(s, now)).flatMap((t) => {
      const p = pendingOf(s, t, now);
      return p ? [{ track: t, stepId: p.stepId, lead: p.lead }] : [];
    });
    // In lead time, as the engine orders them: on the wall, two deadlines behind an open hold are both never.
    // Within a second is a tie: the record's own lead-time arithmetic rounds a late send's millisecond differently on two
    // tracks due at the same wall instant (the windows family, offset 38), where the engine's order falls to the track id.
    all.sort((a, b) => (Math.abs(a.lead - b.lead) >= 1000 ? a.lead - b.lead : 0) || (a.track.id < b.track.id ? -1 : 1));
    return all[0] ?? null;
  }
  /** The step a skip skips: the first pending step, in the same order, that is not with a provider (council D2 on 56d599c). */
  function skipTargetOf(s: Subject, now: number): { track: TrackDefinition; stepId: string; lead: number } | null {
    const all = tracksIn(s, branchOf(s, now)).flatMap((t) => {
      const p = pendingOf(s, t, now);
      return p ? [{ track: t, stepId: p.stepId, lead: p.lead }] : [];
    });
    // Within a second is a tie: the record's own lead-time arithmetic rounds a late send's millisecond differently on two
    // tracks due at the same wall instant (the windows family, offset 38), where the engine's order falls to the track id.
    all.sort((a, b) => (Math.abs(a.lead - b.lead) >= 1000 ? a.lead - b.lead : 0) || (a.track.id < b.track.id ? -1 : 1));
    return all.find((c) => !inFlight(c.track, s, c.stepId)) ?? null;
  }
  /** A track left that can run for the lead: unfinished, and its channel reaches the lead (council D1 on 56d599c). */
  const runnableLeft = (s: Subject, branch: "main" | "win_back", now: number) =>
    tracksIn(s, branch).some((t) => {
      const f = finishOf(s, t);
      return (f === null || f.seen > now) && reaches(s, t);
    });
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
      case "skip":
        return !ended && skipTargetOf(s, now) !== null;
      case "resume_from_next_step":
        return ending !== null && !finishedBy(s, now) && runnableLeft(s, branchOf(s, now), now);
      case "move_to_win_back":
        return ending !== null && branchOf(s, now) === "main" && tracksIn(s, "win_back").length > 0 && runnableLeft(s, "win_back", now);
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
    // once (council on PR 62): one provider reply is held once per lead, whichever of the pre-send check and the
    // observation found it first. A stored id names a provider's reply when it is that id, or either is the other with a
    // prefix (`sms:`, `reply:`): the record does not restate the app's one stored form, only that there is one.
    for (const s of subjects.values()) {
      const held = (await h.store.engine.subject(s.id, now))?.replies ?? [];
      const names = (stored: string, id: string) => stored === id || stored.endsWith(`:${id}`) || id.endsWith(`:${stored}`);
      const theirs = [...email.replyLog.filter((r) => r.subjectId === s.id).map((r) => r.id), ...(s.person.mobile ? sms.replyLog.filter((r) => r.from === s.person.mobile).map((r) => r.id) : [])];
      for (const id of theirs) {
        const copies = held.filter((r) => names(r.providerRef, id));
        if (copies.length > 1) problem(`once: ${s.id} holds the provider's reply ${id} ${copies.length} times (${copies.map((r) => r.providerRef).join(", ")})`);
      }
    }
    // P3: no burst. Two send calls from one sender are never closer than its gap (5 minutes), across every resume.
    for (const provider of [email, sms]) {
      const bySender = new Map<string, number[]>();
      for (const c of provider.handoverLog) bySender.set(c.sender, [...(bySender.get(c.sender) ?? []), c.at]);
      for (const [sender, ats] of bySender) {
        const sorted = [...ats].sort((a, b) => a - b);
        for (let i = 1; i < sorted.length; i++) if (sorted[i]! - sorted[i - 1]! < 5 * MINUTE) problem(`P3: ${sender} made two send calls ${Math.round((sorted[i]! - sorted[i - 1]!) / 1000)} s apart, at ${isoOf(sorted[i])}`);
      }
    }
    // R3 (ticket 20a): no inbox delivers more than its capacity on a reset day (UTC for inbox-a), across every recovery
    // and both campaigns.
    {
      const perDay = new Map<string, number>();
      for (const d of email.deliveryLog) perDay.set(isoOf(d.at).slice(0, 10), (perDay.get(isoOf(d.at).slice(0, 10)) ?? 0) + 1);
      for (const [day, n] of perDay) if (n > CAPACITY) problem(`R3: inbox-a delivered ${n} emails on ${day}, over its capacity of ${CAPACITY}`);
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
    // Council A on 56d599c: a withdrawal answered "unknown" is asked again one settling period on, while the work has no
    // final answer by the record (not known sent, not withdrawn), whether or not an attempt still carries it.
    const SETTLING = 15 * MINUTE;
    // Exact across interruptions (verifier on 2f7cd20): the last ask is the provider's or one an outage swallowed (the
    // engine asked; to it, an unknown answer), and the next is due one settling period later, moved only when that instant
    // falls while the application could not act: never forgiving time it could.
    const swallowedAsks = h.swallowedWithdrawals.filter((w) => w.channel === "email").map((w) => ({ key: w.key, at: w.at, answer: "unknown" as const }));
    for (const key of new Set(email.withdrawLog.map((w) => w.key))) {
      const asks = [...email.withdrawLog.filter((w) => w.key === key), ...swallowedAsks.filter((w) => w.key === key)].sort((a, b) => a.at - b.at);
      const last = asks.at(-1)!;
      const deadline = upFrom(last.at + SETTLING);
      if (last.answer !== "unknown" || now < deadline + MINUTE) continue;
      const d = email.deliveryLog.find((x) => x.key === key);
      const known = d ? Math.min(d.visibleAt, email.lookupLog.find((l) => l.key === key && l.answer === "sent" && l.at >= d.at)?.at ?? Infinity) : Infinity;
      if (known <= deadline) continue;
      const owner = email.handoverLog.find((c) => c.key === key)?.subjectId ?? "";
      const st = await h.store.engine.subject(owner, now);
      problem(`A: the withdrawal of ${key} answered unknown at ${isoOf(last.at)} and was not asked again by ${isoOf(deadline)}, though its work had no final answer${process.env["CONTROLS_DEBUG"] ? ` [work ${JSON.stringify(st?.work.find((w) => w.key === key))}; attempts ${JSON.stringify(st?.attempts.filter((a) => a.idempotencyKey === key).map((a) => [a.state, a.endedBy, a.withdrawRequested, a.withdrawCalled]))}; handovers ${JSON.stringify(email.handoverLog.filter((c) => c.key === key).map((c) => isoOf(c.at)))}; lookups ${JSON.stringify(email.lookupLog.filter((l) => l.key === key).map((l) => [isoOf(l.at), l.answer]))}; asks ${JSON.stringify(asks.map((w) => [isoOf(w.at), w.answer]))}]` : ""}`);
    }
    // Council B: each email handover finds fewer than the inbox's k = 2 other pieces of work handed over and unsettled, by
    // the provider's own logs (settled once the app knows it sent, or the provider confirmed a withdrawal).
    const firstCalls = email.handoverLog.filter((c, i, all) => all.findIndex((x) => x.key === c.key) === i);
    const settledAt = (key: string) => {
      const d = email.deliveryLog.find((x) => x.key === key);
      const sent = d ? Math.min(d.visibleAt, email.lookupLog.find((l) => l.key === key && l.answer === "sent" && l.at >= d.at)?.at ?? Infinity, email.withdrawLog.find((w) => w.key === key && w.answer === "too-late")?.at ?? Infinity) : Infinity;
      // A refusal settles the work only when it answers the key's only call (the attempt's rule): after earlier calls the
      // work stays uncertain.
      const calls = email.handoverLog.filter((c) => c.key === key);
      const refused = calls.length <= 1 ? (email.refusals.find((x) => calls.some((c) => c.attemptId === x.attemptId))?.at ?? Infinity) : Infinity;
      return Math.min(sent, refused, email.withdrawLog.find((w) => w.key === key && w.answer === "withdrawn")?.at ?? Infinity);
    };
    for (const c of firstCalls) {
      const held = firstCalls.filter((x) => x.sender === c.sender && x.key !== c.key && x.at < c.at && settledAt(x.key) > c.at);
      if (held.length >= 2) problem(`B: ${c.subjectId}/${c.stepId} was handed over at ${isoOf(c.at)} while the inbox already had ${held.length} pieces of work with the provider unsettled (${held.map((x) => x.key).join(", ")})`);
    }
    // 18's order (council C on 56d599c): at each first claim of a step that needs an in-flight place, no other step for the
    // same sender, ranked higher by ADR 4.3 (a touched lead first, then the older stored due time, then lead and step),
    // was due and claimable a minute before and still unclaimed: no lead released from a hold, and no overdue lead, is
    // passed over while others are served.
    {
      type Item = { s: Subject; t: TrackDefinition; stepId: string; sender: string | null; due: number; stored: number; known: number; claim: number; inherited: boolean };
      const items: Item[] = [];
      for (const s of subjects.values()) {
        const st = await h.store.engine.subject(s.id, now);
        for (const t of def(s).tracks) {
          if (t.channel === "call" || !reaches(s, t)) continue;
          const start = startOf(s, t);
          if (start === null) continue;
          for (const [i, step] of t.steps.entries()) {
            const prev = i > 0 ? resolution(s, t, t.steps[i - 1]!.id) : null;
            if (i > 0 && !prev) break;
            const stored = prev ? dueAfter(prev.at, step.waitDays, zoneOfSubject(s)) : start;
            const due = prev ? afterHolds(s, prev.at, stored) : start;
            const known = prev ? prev.seen : (t.start.kind === "after" ? (finishOf(s, def(s).tracks.find((x) => x.id === (t.start.kind === "after" ? t.start.trackId : ""))!)?.seen ?? Infinity) : start);
            const first = st?.attempts.filter((a) => a.stepId === step.id).sort((a, b) => a.claimedWall - b.claimedWall)[0];
            // The lead's fixed inbox, else the one its first claim took; null when it has neither (any inbox of the pool).
            items.push({ s, t, stepId: step.id, sender: t.channel === "sms" ? numbers[s.campaign]!.id : (emailSenderOf(s) ?? first?.accountId ?? null), due, stored, known, claim: first?.claimedWall ?? Infinity, inherited: first !== undefined && first.idempotencyKey !== first.id });
          }
        }
      }
      // ADR 0003 1.3 (ruling 6): a lead is touched only by a send observed sent, or a logged call outcome other than skip
      // for now; a user's Skip of a step, a call's included, touches nothing (the clause that counted one came in with
      // c189643 and was hidden by all-day windows until the windows family drew others).
      const touched = (s: Subject, T: number) => (["email", "sms"] as const).some((ch) => deliveries(ch).some((d) => d.subjectId === s.id && d.visibleAt <= T)) || [...callsDone].some(([k, at]) => k.startsWith(`${s.id}/`) && at <= T);
      /** Some inbox the item may use is up at T: its own, or, with none fixed yet, any of the pool. */
      const upAt = (y: Item, T: number) => (y.sender === null ? inboxIds : [y.sender]).some((x) => outageUntil(x, T) === null);
      // Claimable by the record's own model (ADR 0003 "Reads that say when"): inside its window in the prospect's zone, and its
      // sender not taken down, a minute before and at T, as well as due and neither held nor ended.
      const eligible = (y: Item, T: number) =>
        !downAt(T) && !downAt(T - MINUTE) &&
        inWindow(y.t.window, zoneOfSubject(y.s), T) && inWindow(y.t.window, zoneOfSubject(y.s), T - MINUTE) && upAt(y, T) && upAt(y, T - MINUTE) &&
        y.due <= T - MINUTE && y.known <= T - MINUTE && !holdsOf(y.s).some((x) => x.from <= T && x.to > T - MINUTE) && !endedAt(y.s, T) && branchOf(y.s, T) === y.t.branch &&
        !skips.some((x) => x.subjectId === y.s.id && x.stepId === y.stepId && x.at <= T) && !((finishOf(y.s, y.t)?.at ?? Infinity) <= T) && !hidden.some((r) => r.subjectId === y.s.id && r.at <= T);
      /** Whether `y` could have gone on `sender`: its own, or, with none fixed yet, any inbox of the pool. */
      const sameSender = (y: Item, sender: string | null) => sender !== null && (y.sender === sender || (y.sender === null && inboxIds.includes(sender)));
      const ranksAbove = (y: Item, x: Item, T: number) => {
        const ty = touched(y.s, T);
        const tx = touched(x.s, T);
        if (ty !== tx) return ty;
        if (y.stored !== x.stored) return y.stored < x.stored;
        return y.s.id !== x.s.id ? y.s.id < x.s.id : y.stepId < x.stepId;
      };
      for (const x of items) {
        if (!Number.isFinite(x.claim) || x.inherited) continue;
        for (const y of items) {
          if (y === x || !sameSender(y, x.sender) || y.claim <= x.claim || !eligible(y, x.claim) || !ranksAbove(y, x, x.claim)) continue;
          problem(`18: ${x.s.id}/${x.stepId} was claimed on ${x.sender} at ${isoOf(x.claim)} while ${y.s.id}/${y.stepId}, due ${isoOf(y.due)} and ranked higher, waited (claimed ${isoOf(y.claim)})${process.env["CONTROLS_DEBUG"] ? ` [y window ${JSON.stringify(y.t.window)} zone ${zoneOfSubject(y.s)}; x window ${JSON.stringify(x.t.window)} zone ${zoneOfSubject(x.s)}; outages ${JSON.stringify(outages.map((o) => [isoOf(o.from), isoOf(o.to)]))}; y holds ${JSON.stringify(holdsOf(y.s).map((o) => [isoOf(o.from), isoOf(o.to)]))}; y attempts ${JSON.stringify(email.handoverLog.filter((c) => c.subjectId === y.s.id).map((c) => [c.stepId, isoOf(c.at), c.mode]))}]` : ""}`);
        }
      }
      // F (review bot on 612aa05): a place is freed at every final answer. A piece of work holds its sender's place from
      // its first handover until the app has any final answer for it, by the providers' own logs: the send known (event or
      // lookup), a withdrawal answered withdrawn or too late, or a refusal. When a final answer leaves the sender with a free
      // place, and for the next 20 minutes (four pacing gaps) nothing is handed over on it, no step for it may be waiting
      // that was claimable throughout.
      const SLACK = 20 * MINUTE;
      /** inbox-a's day, by the providers' logs: sends delivered that UTC day by T, and work handed over and not final by T. */
      const nearlyFull = (sender: string, T: number) => {
        const day = isoOf(T).slice(0, 10);
        const sentThatDay = email.deliveryLog.filter((d) => d.sender === sender && d.at <= T && isoOf(d.at).slice(0, 10) === day).length;
        const open = firstCalls.filter((c) => c.sender === sender && c.at <= T && settledAt(c.key) > T).length;
        return sentThatDay + open >= capacityOf(sender) - 1;
      };
      for (const ch of ["email", "sms"] as const) {
        const port = ch === "email" ? email : sms;
        const firsts = handovers(ch).filter((c, i, all) => all.findIndex((x) => x.key === c.key) === i);
        const finalAt = (key: string, attemptIds: readonly string[]) => {
          const d = deliveries(ch).find((x) => x.key === key);
          const sent = d ? Math.min(d.visibleAt, port.lookupLog.find((l) => l.key === key && l.answer === "sent" && l.at >= d.at)?.at ?? Infinity) : Infinity;
          const withdrawn = port.withdrawLog.find((w) => w.key === key && w.answer !== "unknown")?.at ?? Infinity;
          const refused = port.refusals.find((r) => attemptIds.includes(r.attemptId))?.at ?? Infinity;
          return Math.min(sent, withdrawn, refused);
        };
        const spans = firsts.map((c) => ({ key: c.key, sender: c.sender, from: c.at, to: finalAt(c.key, handovers(ch).filter((x) => x.key === c.key).map((x) => x.attemptId)) }));
        for (const freed of spans) {
          const f = freed.to;
          if (!Number.isFinite(f) || f + SLACK > now) continue;
          const sender = freed.sender;
          const held = spans.filter((x) => x.sender === sender && x.from <= f && x.to > f).length;
          if (held >= 2) continue;
          if (firsts.some((c) => c.sender === sender && c.at > f && c.at <= f + SLACK)) continue;
          for (const y of items) {
            if (!sameSender(y, sender) || y.claim <= f + SLACK || y.inherited) continue;
            if (![f + MINUTE, f + SLACK / 2, f + SLACK].every((T) => eligible(y, T))) continue;
            // The freed sender itself must be up (with a pool, the item may be eligible on another inbox), and not under a rate
            // limit the engine waits out (its end as the engine reads it can fall a couple of minutes from the fake's).
            if ([f + MINUTE, f + SLACK / 2, f + SLACK].some((T) => outageUntil(sender, T) !== null)) continue;
            if (outages.some((o) => o.kind === "rate_limited" && o.inbox === sender && o.from < f + SLACK && o.to + 2 * MINUTE > f)) continue;
            // The sender's pacing slot must have come too: with the windows family's long gaps a freed place can wait for it.
            if ([f + MINUTE, f + SLACK / 2, f + SLACK].some((T) => [...email.handoverLog, ...sms.handoverLog].filter((c) => c.sender === sender && c.at <= T).reduce((m, c) => Math.max(m, c.at + gap), -Infinity) > T)) continue;
            // With a small daily capacity (ticket 20a's family), a sender at or near its day's capacity may rightly wait.
            if (!sender.startsWith("+") && [f + MINUTE, f + SLACK / 2, f + SLACK].some((T) => nearlyFull(sender, T))) continue;
            problem(`F: ${sender} had a free in-flight place from ${isoOf(f)} (a final answer for ${freed.key}) and handed nothing over for ${SLACK / MINUTE} minutes while ${y.s.id}/${y.stepId}, due ${isoOf(y.due)}, waited (claimed ${isoOf(y.claim)})`);
          }
        }
      }
      // F, one definition (verifier R2-1 on 612aa05): the place count and `mayStillSend` never disagree. When no lead's
      // read says a message may still be sent, every sender's in-flight places are held only by claims not yet handed over.
      let mayStill = 0;
      const inFlightOf = new Map<string, number>();
      const claimsOf = new Map<string, number>();
      for (const s of subjects.values()) {
        mayStill += (await h.request<EnrollmentRead>("GET", `/api/enrollments/${s.id}`)).body.mayStillSend;
        const st = await h.store.engine.subject(s.id, now);
        for (const [id, acc] of Object.entries(st?.accounts ?? {})) inFlightOf.set(id, acc.inFlight);
        for (const a of st?.attempts ?? []) if (a.state === "claimed") claimsOf.set(a.accountId, (claimsOf.get(a.accountId) ?? 0) + 1);
      }
      if (mayStill === 0) {
        for (const [id, n] of inFlightOf) if (n > (claimsOf.get(id) ?? 0)) problem(`F: no lead may still be sent anything at ${isoOf(now)}, yet ${id} holds ${n} in-flight places for ${claimsOf.get(id) ?? 0} claims`);
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
      if (want !== null && status !== want) problem(`status: ${s.id} is ${status} at ${isoOf(now)}; the record says ${want}${process.env["CONTROLS_DEBUG"] ? ` [finishes ${JSON.stringify(def(s).tracks.map((x) => [x.id, startOf(s, x), finishOf(s, x)]))}; winBack ${isoOf(winBack.get(s.id))}; endings ${JSON.stringify(endings.filter((e) => e.subjectId === s.id))}; holds ${JSON.stringify(holdsOf(s).map((x) => [isoOf(x.from), isoOf(x.to)]))}; engine ${JSON.stringify(st.tracks.map((p) => [p.trackId, p.startedAt, p.finishReason, isoOf(p.finishedWall)]))}; results ${JSON.stringify(st.results.map((r) => [r.stepId, r.result, isoOf(r.atWall)]))}; app replies ${JSON.stringify(st.replies)}; fake replies ${JSON.stringify(email.replyLog.filter((r) => r.subjectId === s.id))}; checks ${JSON.stringify(email.presendLog.filter((p) => p.answered !== null).map((p) => [isoOf(p.at), p.answered, p.threadRefs]))}; leadPaused ${String(st.subject.leadPaused)}]` : ""}`);
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
        // W1 (ADR 0003 "Reads that say when"): a read never states an instant at or before its own, and a held or ended
        // lead's step promises no time: the read gives the reason.
        const when = shown.when;
        if (when.kind === "at" && Date.parse(when.at) <= now) problem(`W1: ${s.id}/${pending.stepId} reads as due at ${when.at}, not after the read's instant ${isoOf(now)}`);
        if ((held || endedAt(s, now)) && when.kind !== "waits") problem(`W1: ${s.id}/${pending.stepId} is held or ended at ${isoOf(now)} but the read says ${JSON.stringify(when)}, a time it cannot promise`);
        if (held || endedAt(s, now)) continue;
        // W2, against the record's own model of wait ends and windows (ADR 0003 "Reads that say when"): an earliest instant
        // is exactly the record's first open-window instant at or after the wait's end; "ready" only when that instant is the
        // read's own and a sender the step may use is up and not full by its own sends. No sender-side instant is ever given.
        // A reason must be true of every sender it speaks for: "every account full" while the record has an inbox up and
        // not full by its sends is a read that hid another cause (council on cc9bf55, item 3).
        if (drawsWindows && when.kind === "waits" && when.why === "sending_capacity" && t.channel === "email") {
          const roomy = sendersOf(s, t).filter((x) => outageUntil(x, now) === null && !fullBySendsAt(x, now));
          if (roomy.length > 0) problem(`W2: ${s.id}/${pending.stepId} reads "sending_capacity" at ${isoOf(now)}, but the record has room on ${roomy.join(", ")}`);
        }
        if (!inFlight(t, s, pending.stepId)) {
          const zone = zoneOfSubject(s);
          const window: readonly Hours[] = t.window;
          const opening = Number.isFinite(pending.due) ? firstOpen(window, zone, Math.max(pending.due, now)) : Infinity;
          // The time-only reason, checked against its cause: "its sending hours never open" only when the record's never do.
          if (when.kind === "waits" && when.why === "no_window" && Number.isFinite(opening)) problem(`W2: ${s.id}/${pending.stepId} reads "no_window" at ${isoOf(now)}, but the record's window opens at ${isoOf(opening)}`);
          if (when.kind === "at" && Date.parse(when.at) !== opening) problem(`W2: ${s.id}/${pending.stepId} reads "earliest ${when.at}" at ${isoOf(now)}; the record's first open instant at or after its due instant ${isoOf(pending.due)} is ${isoOf(opening)}`);
          if (when.kind === "ready" && opening !== now) problem(`W2: ${s.id}/${pending.stepId} reads "ready" at ${isoOf(now)}; the record has it wait for ${isoOf(opening)} (due ${isoOf(pending.due)}, ${inWindow(window, zone, now) ? "inside" : "outside"} its window in ${zone})`);
          if (when.kind === "ready" && !sendersOf(s, t).some((x) => outageUntil(x, now) === null && !fullBySendsAt(x, now))) problem(`W2: ${s.id}/${pending.stepId} reads "ready" at ${isoOf(now)}, but the record has every sender it may use down or full by its sends (${sendersOf(s, t).join(", ")})`);
        }
        if (pending.due > pending.unheld) features.add("a-wait-moved-by-a-hold");
      }
      for (const ch of ["email", "sms"] as const) {
        for (const t of def(s).tracks.filter((x) => x.channel === ch)) {
          for (const [i, st2] of t.steps.entries()) {
            const first = handovers(ch).find((c) => c.subjectId === s.id && c.stepId === st2.id);
            if (!first) continue;
            const due = i === 0 ? startOf(s, t) : (() => {
              const prev = resolution(s, t, t.steps[i - 1]!.id);
              return prev ? afterHolds(s, prev.at, dueAfter(prev.at, st2.waitDays, zoneOfSubject(s))) : null;
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
  /**
   * What a confirmation shown on `read` sends with the control (ticket 17b): the lead's status, and the step the preview
   * named, the step a skip skips or a restart resumes at. A control is applied only while it still holds.
   */
  const expectOf = (read: EnrollmentRead, action: LeadControlApi): { status: string; preview: string } => {
    const c = read.controls.find((x) => x.action === action);
    return { status: read.status, preview: c?.allowed ? c.digest : "" };
  };
  /** Each lead's last read a control was judged on, for a confirmation left open on it (the stale-confirmation stream). */
  const lastReads = new Map<string, EnrollmentRead>();
  /** One control on one lead, checked against the record, the read before it, and its own repeat. */
  async function control(s: Subject, action: LeadControlApi, options: { readonly othersMayMove?: boolean; readonly preview?: boolean } = {}): Promise<void> {
    // What the app found while the clock moved (a hidden reply at a pre-send check) is in the record before any action.
    settleHidden();
    const now = h.clock;
    const expected = accepts(s, action, now);
    const read = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${s.id}`)).body;
    lastReads.set(s.id, read);
    const offered = read.controls.find((c) => c.action === action);
    if (!offered || offered.allowed !== expected) problem(`P11: ${s.id}'s read ${offered?.allowed ? "offers" : "refuses"} ${action} at ${isoOf(now)}; the record says it must be ${expected ? "accepted" : "refused"}${offered && !offered.allowed ? ` ("${offered.reason}")` : ""}${process.env["CONTROLS_DEBUG"] ? ` [holds ${JSON.stringify(holdsOf(s).map((x) => [isoOf(x.from), isoOf(x.to)]))}; pauses ${JSON.stringify([...leadPauses.filter((p) => p.subjectId === s.id), ...campaignPauses.filter((p) => p.campaign === s.campaign)].map((p) => [isoOf(p.from), isoOf(p.to)]))}; endings ${JSON.stringify(endings.filter((e) => e.subjectId === s.id).map((e) => [e.kind, isoOf(e.at), isoOf(e.restartedAt)]))}; downs ${JSON.stringify(downs.map((x) => [isoOf(x.from), isoOf(x.to)]))}; freezes ${JSON.stringify((await h.store.engine.subject(s.id, now))?.freezes.map((f) => [isoOf(f.fromWall), isoOf(f.toWall)]))}; current ${currentStep(s, now)?.stepId ?? "none"}; starts ${JSON.stringify(def(s).tracks.map((x) => [x.id, JSON.stringify(x.start), isoOf(startOf(s, x)), finishOf(s, x)]))}; lookups ${JSON.stringify(email.lookupLog.filter((l) => l.key === "att-122").map((l) => [isoOf(l.at), l.answer]))}; engineTracks ${JSON.stringify((await h.store.engine.subject(s.id, now))?.tracks.map((p) => [p.trackId, p.startAt, p.startedAt, p.finishReason, isoOf(p.finishedWall)]))}; clock ${JSON.stringify((await h.store.engine.subject(s.id, now))?.subject.clock)}; work ${JSON.stringify((await h.store.engine.subject(s.id, now))?.work.map((w) => [w.stepId, w.key, w.calls, w.settled, w.lookupAnswer]))}; attempts ${JSON.stringify((await h.store.engine.subject(s.id, now))?.attempts.map((a) => [a.stepId, a.idempotencyKey, a.state, a.endedBy]))}; handovers ${JSON.stringify(email.handoverLog.filter((c) => c.subjectId === s.id).map((c) => [c.stepId, c.key, isoOf(c.at), c.mode]))}; deliveries ${JSON.stringify(email.deliveryLog.filter((c) => c.subjectId === s.id).map((c) => [c.stepId, c.key, isoOf(c.at)]))}; withdrawals ${JSON.stringify(email.withdrawLog)}]` : ""}`);
    const current = action === "skip" ? (skipTargetOf(s, now) ?? currentStep(s, now)) : currentStep(s, now);
    if (action === "skip" && offered?.allowed && current && (offered.skips?.trackId !== current.track.id || offered.skips.stepId !== current.stepId)) problem(`P11: ${s.id}'s read would skip ${offered.skips?.stepId ?? "nothing"}; the record's current step is ${current.stepId}${process.env["CONTROLS_DEBUG"] ? ` [pending ${JSON.stringify(tracksIn(s, branchOf(s, now)).map((t) => [t.id, pendingOf(s, t, now)]).map(([id, p]) => [id, p && typeof p === "object" ? [p.stepId, isoOf(p.due), isoOf(p.unheld), p.lead] : null]))}; holds ${JSON.stringify(holdsOf(s).map((x) => [isoOf(x.from), isoOf(x.to)]))}; engine ${JSON.stringify((read.tracks).map((t) => [t.trackId, t.nextStep]))}]` : ""}`);
    if (action === "skip" && current && inFlight(current.track, s, current.stepId)) features.add("skip-refused-with-work-at-the-provider");
    const live = (await h.store.engine.subject(s.id, now))?.attempts.filter((a) => a.state === "claimed" || a.state === "handed" || a.state === "accepted") ?? [];
    const before = await others(s, null);
    const requestId = `c-${++requests}`;
    const uncertain = (await h.store.engine.subject(s.id, now))?.work.some((w) => w.settled === null && w.calls > 0) ?? false;
    const body = { requestId, action, expect: expectOf(read, action) };
    // The route runs the worker's round after the control: W4 counts handovers from before the request.
    const markBefore = { email: email.handoverLog.length, sms: sms.handoverLog.length };
    const claimsBefore = claimLog.length;
    // Numbered before the request: the route's round claims after the control, within it.
    const seqOfControl = ++recordSeq;
    const res = await h.request<{ error?: { message: string }; replayed?: boolean; effect?: unknown }>("POST", `/api/enrollments/${s.id}/controls`, body);
    const accepted = res.status === 200;
    // The answer's effect is the read's preview at that instant, field for field (verifier B4).
    // When a step goes is a present read (ADR 0003 "Reads that say when"), with what dispatch knows at the read; what a control
    // did is history, and says no time. P11 compares the two without it.
    const timeless = (x: unknown) => JSON.stringify(x, (key, value: unknown) => (key === "when" ? undefined : value));
    if (accepted && offered?.allowed && timeless(res.body.effect) !== timeless(offered)) problem(`P11: ${action} on ${s.id} at ${isoOf(now)} answered the effect ${JSON.stringify(res.body.effect)}; the read previewed ${JSON.stringify(offered)}`);
    // W4 (council on cc9bf55, items 7 and 8; the re-check of ff01571): the preview's time, read before the control, against
    // what the engine then does in its next round at the same instant (the route's own round): the fake providers' logs and the list.
    if (options.preview === true && accepted && offered?.allowed && offered.next) previewed.push({ s, action, stepId: offered.next.stepId, channel: offered.next.channel, when: offered.next.when, at: now, mark: markBefore, claims: claimsBefore });
    // C1 (the coordinator on 712884b): a control confirmed with the expectation of a read taken at the same instant, nothing in
    // between, is never refused as changed, between rounds as after one: the check sees the lead as the read did.
    if (offered?.allowed && !accepted && (res.body.error?.message === CHANGED_SINCE_CONFIRMED || res.body.error?.message === PREVIEW_CHANGED)) problem(`C1: ${action} on ${s.id} at ${isoOf(now)}, confirmed on the read of that instant with nothing in between, was refused as changed ("${res.body.error.message}")`);
    if (offered?.allowed && options.othersMayMove === true) features.add("c1-a-confirmation-between-rounds");
    if (!accepted && res.body.error) refused.push({ path: `/api/enrollments/${s.id}/controls`, body, message: res.body.error.message });
    if (uncertain) features.add(accepted ? `${action}-with-uncertain-work` : `${action}-refused-with-uncertain-work`);
    if (accepted !== expected) problem(`P11: ${action} on ${s.id} at ${isoOf(now)} was ${accepted ? "accepted" : `refused (${res.body.error?.message ?? res.status})`}; the record says it must be ${expected ? "accepted" : "refused"}`);
    if (offered && !offered.allowed && !accepted && offered.reason !== res.body.error?.message) problem(`P11: ${s.id}'s read refuses ${action} with "${offered.reason}"; the action says "${res.body.error?.message ?? ""}"`);
    // Acting before the worker's tick at a due instant, the tick the control runs may apply what fell due to other leads.
    if (options.othersMayMove !== true) await unchanged(before, `${action} on ${s.id}`);
    if (accepted && action !== "resume") withdrawals.push({ subjectId: s.id, campaign: null, stepId: action === "skip" ? (offered?.allowed ? (offered.skips?.stepId ?? null) : null) : null, seq: seqOfControl });
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
      const again = await h.request<{ replayed?: boolean }>("POST", `/api/enrollments/${s.id}/controls`, body);
      if (again.status !== res.status || (accepted && again.body.replayed !== true)) problem(`P7: ${requestId} (${action} on ${s.id}) was answered ${res.status} then ${again.status}${accepted ? `, replayed ${String(again.body.replayed)}` : ""}`);
      features.add("a-control-sent-again");
    }
  }
  let listedBefore = new Set<string>();
  /** Requests the app refused, to send again later with the same id (P7; verifier B5). */
  const refused: { path: string; body: { readonly requestId: string } & Record<string, unknown>; message: string }[] = [];
  /**
   * A Skip confirmation left open on an earlier read, confirmed after its step changed (verifier B1 on 8a1732a): another
   * tab skipped it, or it was sent or ended meanwhile. Sent with the precondition of the read it was shown on, it must be
   * refused, with no step skipped and no other lead changed (P13). Only sent when the record's current step differs from
   * the one that read named, so a run with none is the run it was.
   */
  async function staleSkip(): Promise<void> {
    settleHidden();
    const now = h.clock;
    const candidates = [...lastReads.entries()].flatMap(([id, read]) => {
      const s = subjects.get(id);
      const c = read.controls.find((x) => x.action === "skip");
      const named = c?.allowed ? c.skips : null;
      if (!s || !named) return [];
      const current = skipTargetOf(s, now) ?? currentStep(s, now);
      return current?.stepId !== named.stepId || endedAt(s, now) ? [{ s, read, named }] : [];
    });
    const chosen = candidates[Math.floor(r18() * candidates.length)];
    if (!chosen) return;
    const before = await others(null, null);
    const results = async () => JSON.stringify((await h.store.engine.subject(chosen.s.id, h.clock))?.results.map((r) => [r.stepId, r.result, r.reason]).sort());
    const was = await results();
    const current = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${chosen.s.id}`)).body;
    // The confirmation is a snapshot: it sends the read it opened on (unless the mutation re-targets it on the newest read).
    const shown = options.clickTimeExpectation === true ? current : chosen.read;
    const res = await h.request<{ error?: { message: string } }>("POST", `/api/enrollments/${chosen.s.id}/controls`, { requestId: `stale-${++requests}`, action: "skip", expect: expectOf(shown, "skip") });
    if (res.status !== 409) problem(`P13: a Skip confirmed on ${chosen.s.id}'s read naming ${chosen.named.stepId}, sent at ${isoOf(now)} after that step changed, was answered ${res.status}`);
    // One refusal order for the read and the action (judgeControl): where the current read refuses the skip, the stale
    // request gets the same reason, whatever its precondition says (the search on 54f3a73).
    const nowOffered = current.controls.find((c) => c.action === "skip");
    if (nowOffered && !nowOffered.allowed && res.body.error?.message !== nowOffered.reason) problem(`P11: ${chosen.s.id}'s read refuses skip with "${nowOffered.reason}"; a stale Skip sent then was refused with "${res.body.error?.message ?? ""}"`);
    if ((await results()) !== was) problem(`P13: a stale Skip on ${chosen.s.id} changed its step results (${was} to ${await results()})`);
    await unchanged(before, `a stale Skip on ${chosen.s.id}`);
    features.add("a-stale-skip-confirmation-refused");
  }

  /** A refused request sent again, after whatever changed since: the same refusal, and nothing changes. */
  async function retryRefused(): Promise<void> {
    settleHidden();
    const r = refused[Math.floor(r17() * refused.length)];
    if (!r) return;
    const before = await others(null, null);
    const again = await h.request<{ error?: { message: string } }>("POST", r.path, r.body);
    if (again.status !== 409 || again.body.error?.message !== r.message) problem(`P7: ${r.body.requestId} (${r.path}) was refused ("${r.message}"); sent again at ${isoOf(h.clock)} it was answered ${again.status}${again.body.error ? ` ("${again.body.error.message}")` : ""}`);
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
    if (outageUnderWay()) return;
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
        const byCheck = (cut ? email.presendLog.slice(0, cut.presend) : email.presendLog).find((p) => p.at >= r.at && p.answered === r.id)?.at ?? Infinity;
        return { r, byCheck, at: Math.min(byCheck, upFrom(r.visibleAt)) };
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
    withdrawals.push({ subjectId: s.id, campaign: null, stepId: null, seq: ++recordSeq });
    if (endingAt(s, at)?.kind === "replied") return;
    const stopped = endingAt(s, at);
    if (stopped) {
      stopped.restartedAt = at;
      endings.push({ subjectId: s.id, kind: "replied", at: stopped.at, restartedAt: Infinity });
      features.add("a-reply-to-a-stopped-lead");
    } else endings.push({ subjectId: s.id, kind: "replied", at, restartedAt: Infinity });
  }

  async function campaignControl(ci: number, action: "pause" | "resume", othersMayMove = false): Promise<void> {
    settleHidden();
    const now = h.clock;
    const paused = campaignPausedAt(ci, now);
    const expected = action === "pause" ? !paused : paused;
    const detail = (await h.request<CampaignDetail>("GET", `/api/campaigns/${campaignIds[ci]!}`)).body;
    const offered = detail.controls.find((c) => c.action === action);
    if (offered?.allowed !== expected) problem(`P11: campaign ${ci + 1}'s read ${offered?.allowed ? "offers" : "refuses"} ${action}; the record says ${expected ? "accept" : "refuse"}`);
    const before = await others(null, ci);
    const seqOfControl = ++recordSeq;
    const body = { requestId: `c-${++requests}`, expect: { pausedSince: detail.pause.pausedSince } };
    const res = await h.request<{ error?: { message: string } }>("POST", `/api/campaigns/${campaignIds[ci]!}/${action}`, body);
    if (res.status !== 200 && res.body.error) refused.push({ path: `/api/campaigns/${campaignIds[ci]!}/${action}`, body, message: res.body.error.message });
    if ((res.status === 200) !== expected) problem(`P11: ${action} of campaign ${ci + 1} at ${isoOf(now)} was ${res.status === 200 ? "accepted" : "refused"}; the record says ${expected ? "accept" : "refuse"}`);
    // Between rounds, the round the route runs may apply what fell due to other leads.
    if (!othersMayMove) await unchanged(before, `${action} of campaign ${ci + 1}`);
    if (expected && action === "pause") withdrawals.push({ subjectId: null, campaign: ci, stepId: null, seq: seqOfControl });
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
    // The windows family draws no reply hidden from observation: only the pre-send check would find it, which no read can
    // know (ADR 0003 "Reads that say when", a stated limit), so these runs avoid the state rather than waive it.
    const hide = r17() < 0.5;
    if (hide && !drawsWindows) {
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
    // In the thread of an email the app has observed (a reply in a thread it does not know yet is held for correlation,
    // ADR 0003 2.4, which these runs do not model).
    if (!email.prospectReplies(d.destination, true, null, { inThreadOf: d })) return;
    const s = subjects.get(email.replyLog.at(-1)?.subjectId ?? "");
    if (!s) return;
    if (outageUnderWay()) {
      // Ticket 20a: the providers are cut off, so the app finds the reply when it can observe them again.
      const r = email.replyLog.at(-1)!;
      hidden.push({ id: r.id, subjectId: s.id, thread: r.threadRef ?? "", at: h.clock, visibleAt: h.clock });
      features.add("a-reply-during-an-outage");
      return;
    }
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

  // ----------------------------------------------------------------------------------------------
  // Ticket 20a: interruptions, and the record's notice (R7).

  const GAP = 5 * MINUTE;
  /** The notice the app must show: the record's last interruption longer than the gap. */
  let expectedNotice: InterruptionNoticeView | null = null;
  /** The interruption under way, by the world the run made: from the last instant it could send to the instant it came back. */
  let pending: { x: number; y: number; what: string } | null = null;
  const takeCut = () => {
    cut = { email: { h: email.handoverLog.length, d: email.deliveryLog.length }, sms: { h: sms.handoverLog.length, d: sms.deliveryLog.length }, presend: email.presendLog.length };
  };
  /** At the tick the application came back: the record's count, against the notice the app shows. */
  async function resolvePending(): Promise<void> {
    if (!pending || !cut) return;
    const { x, y, what } = pending;
    downs.push({ from: x, to: y });
    outageFrom = null;
    settleHidden();
    for (const id of committedUncalled.splice(0)) {
      const a = await h.store.engine.attempt(id);
      if (a) uncalledHandovers.push({ channel: a.accountId.startsWith("+") ? "sms" : "email", key: a.idempotencyKey, subjectId: a.subjectId, stepId: a.stepId, sender: a.accountId, at: a.handedWall ?? x });
    }
    const uncalled = new Set<string>();
    if (y - x > GAP) {
      const rescheduled = rescheduledByRecord(x, y, uncalled);
      expectedNotice = { from: isoOf(x), to: isoOf(y), rescheduled };
      features.add(rescheduled > 0 ? "a-notice-with-sends-rescheduled" : "a-notice-with-none-rescheduled");
    } else features.add("a-gap-below-the-threshold");
    cut = null;
    pending = null;
    const shown = (await h.request<TodayView>("GET", "/api/today")).body.interruption;
    if (JSON.stringify(shown) !== JSON.stringify(expectedNotice)) {
      let detail = "";
      if (process.env["CONTROLS_DEBUG"]) {
        for (const s of subjects.values()) {
          const st = await h.store.engine.subject(s.id, h.clock);
          detail += ` [${s.id} ended ${String(endedAt(s, y))} holds ${JSON.stringify(holdsOf(s).map((x2) => [isoOf(x2.from), isoOf(x2.to)]))} record ${JSON.stringify(tracksIn(s, branchOf(s, y)).map((t) => [t.id, pendingOf(s, t, y)?.stepId, isoOf(pendingOf(s, t, y)?.due)]))} engine ${JSON.stringify(st?.tracks.map((p2) => [p2.trackId, p2.nextStepId, isoOf(p2.dueWall)]))} attempts ${JSON.stringify(st?.attempts.map((a2) => [a2.stepId, a2.state, isoOf(a2.claimedWall)]))} work ${JSON.stringify(st?.work.map((w) => [w.stepId, w.settled, w.calls]))} freezes ${JSON.stringify(st?.freezes)}]`;
        }
      }
      problem(`R7: after ${what} the notice is ${JSON.stringify(shown)}; the record says ${JSON.stringify(expectedNotice)}${detail}`);
    }
  }
  if (interrupting) {
    // Half the runs' providers answer from a cache while cut off, as the Instantly adapter does between polls (PR 56).
    h.cachedPolls = random(seed ^ 0x20b)() < 0.5;
    if (h.cachedPolls) features.add("providers-answering-from-a-cache");
    // A machine asleep in the middle of a tick: the interruption is the record's from the instant the answer was asked to
    // the instant it arrived, and the logs are cut there, before anything the resumed tick dispatches.
    h.onHeldAnswer = (asked, answered) => {
      // A sleep inside a recovery under way extends that interruption: one notice, from its start (verifier on 2f7cd20).
      pending = pending ? { ...pending, y: answered, what: `${pending.what}, its recovery asleep until ${isoOf(answered)}` } : { x: asked, y: answered, what: `an answer held from ${isoOf(asked)} to ${isoOf(answered)}` };
      takeCut();
    };
    h.onStop = (from, to) => {
      pending = { x: from, y: to, what: `a stop from ${isoOf(from)} to ${isoOf(to)}` };
      takeCut();
    };
    h.onResumed = resolvePending;
    h.beforeTick = () => {
      if (pending && !cut && h.clock >= pending.y) takeCut();
    };
    h.afterTick = async () => {
      if (pending && cut && !h.recovering) await resolvePending();
    };
  }
  const outageUnderWay = () => h.providersDownUntil !== null;
  /** No interruption under way, and the run still going: another may begin. (A function: the hooks change `pending`.) */
  const calm = () => !outageUnderWay() && pending === null && problems.length === 0 && !h.stopped;
  const LENGTHS: readonly (readonly [number, string])[] = [[2 * MINUTE, "minutes"], [20 * MINUTE, "minutes"], [5 * HOUR, "hours"], [DAY, "days"], [3 * DAY, "days"]];
  const CRASH_POINTS: readonly CrashPoint[] = ["after_claim", "after_presend", "after_handover_commit", "after_call", "after_retry_commit", "after_lookup", "after_observe_event"];
  const CLOCK_CHANGE = Date.parse("2026-10-25T01:00:00Z");
  /** What the interruption under way meets, for the coverage list. */
  async function noteWorld(prefix: string, from: number, to: number): Promise<void> {
    if ([...subjects.values()].some((s) => heldAt(s, from) && !endedAt(s, from))) features.add(`${prefix}-while-paused`);
    if (local(from, ZONE).day !== local(to, ZONE).day) features.add(`${prefix}-across-a-rollover`);
    if (from < CLOCK_CHANGE && to > CLOCK_CHANGE) features.add(`${prefix}-across-the-clock-change`);
    for (const s of subjects.values()) {
      const st = await h.store.engine.subject(s.id, from);
      if (st?.work.some((w) => w.settled === null && w.calls > 0)) features.add(`${prefix}-with-work-unsettled`);
    }
  }
  /** One interruption, of a kind and a length chosen from the run's own stream. */
  async function interrupt(): Promise<void> {
    settleHidden();
    // The world was up and sending at this instant: the heartbeat stands here.
    await h.tick();
    const [ms, label] = LENGTHS[Math.floor(r20() * LENGTHS.length)]!;
    const kind = r20();
    if (kind < 0.45) {
      await noteWorld("app-stopped", h.clock, h.clock + ms);
      features.add(`app-stopped-for-${label}`);
      if (r20() < 0.6) {
        // A crash at a named point, at the next instant something reaches it; sometimes a second one while recovering.
        const point = CRASH_POINTS[Math.floor(r20() * CRASH_POINTS.length)]!;
        const again = r20() < 0.35;
        let fired = 0;
        h.downAfterCrash = ms;
        h.hooks = {
          ...h.hooks,
          crashPoint: (at, attemptId) => {
            if (fired === 0 && at === point) {
              if (at === "after_handover_commit" && attemptId !== null) committedUncalled.push(attemptId);
              fired = 1;
              features.add(`app-stopped-mid-${point}`);
              throw new Crash(at);
            }
            if (fired === 1 && again && h.recovering) {
              fired = 2;
              features.add("a-crash-during-recovery");
              throw new Crash(at);
            }
          },
        };
        await h.advanceTo(h.clock + 6 * HOUR);
        h.hooks = { ...h.hooks, crashPoint: () => undefined };
        if (fired > 0) return;
        h.downAfterCrash = null;
      }
      await h.tick();
      // Sometimes the recovery's own first observation sleeps too (verifier on 2f7cd20, "long recovery"): the interruption
      // runs on to the end of that sleep, one notice.
      const sleepy = random(seed ^ 0x20c ^ Math.floor(h.clock / 60_000));
      if (sleepy() < 0.3) {
        h.heldAnswer = { kind: "observe", ms: Math.round((1 + sleepy() * 6) * HOUR) };
        features.add("a-recovery-tick-that-sleeps");
      }
      await h.stopFor(ms);
      h.heldAnswer = null;
      return;
    }
    if (kind < 0.7) {
      const from = h.clock;
      await noteWorld("providers-cut-off", from, from + ms);
      features.add(`providers-cut-off-for-${label}`);
      // Half the outages of runs whose providers report no freshness of their own fail only the reads that carry
      // replies, bounces and sends (PR 56 review bot): the account reads still answer.
      h.partialOutage = !h.cachedPolls && random(seed ^ 0x20d ^ Math.floor(from / 60_000))() < 0.5;
      if (h.partialOutage) features.add("providers-partly-cut-off");
      pending = { x: from, y: from + ms, what: `${h.partialOutage ? "a partial" : "an"} outage from ${isoOf(from)} to ${isoOf(from + ms)}` };
      outageFrom = from;
      h.cutProvidersOff(from + ms);
      return;
    }
    // A provider's answer held across the user's midnight (follow-up 42 item 39): asked minutes before it.
    const midnight = startOfDay(local(h.clock, ZONE).day + 1, ZONE);
    await h.advanceTo(midnight - Math.round((1 + r20() * 9) * MINUTE));
    if (h.stopped || outageUnderWay() || pending) return;
    await h.tick();
    const asked = h.clock;
    const held = r20() < 0.25 ? 3 * MINUTE + Math.round(r20() * 10 * MINUTE) : Math.round((1 + r20() * 6) * HOUR);
    h.stopMarkingAlive();
    h.heldAnswer = { kind: r20() < 0.6 ? "observe" : "lookup", ms: held };
    await h.tick();
    const answer = h.heldAnswers.find((x) => x.askedAt === asked);
    h.heldAnswer = null;
    if (!answer) {
      // No such request in that tick: nothing was held; the world runs on.
      await h.tick();
      return;
    }
    features.add(`a-${answer.kind}-answer-held-across-midnight`);
    if (answer.answeredAt - asked > GAP) features.add("a-sleep-in-the-middle-of-a-tick");
    await h.tick();
  }

  const eventCount = options.events ?? 22;
  await checkAll();
  if (options.smsReplyRestart === true) {
    // The scripted prelude: the first lead texted the first step of its text track texts back, is seen replied, and is
    // resumed from its next step while its second text is still to come.
    let texted: { s: Subject; mobile: string; sender: string } | undefined;
    for (let i = 0; i < 240 && !texted; i++) {
      await h.advanceTo(h.clock + MINUTE);
      for (const d of sms.deliveryLog) {
        const s = subjects.get(d.subjectId);
        if (!s?.person.mobile || !d.stepId.endsWith("s1") || d.visibleAt > h.clock || endedAt(s, h.clock) || heldAt(s, h.clock)) continue;
        texted = { s, mobile: s.person.mobile, sender: d.sender };
        break;
      }
    }
    if (texted && sms.prospectTexts(texted.mobile, "Not now, thanks", texted.sender)) {
      const textedAt = h.clock;
      await h.tick();
      replied(texted.s, h.clock);
      if (accepts(texted.s, "resume_from_next_step", h.clock)) {
        await control(texted.s, "resume_from_next_step");
        features.add("restarted-after-a-text-reply");
      }
      await h.advanceTo(h.clock + 3 * DAY);
      // P6: a restart continues at the next unsent step. Nothing else happened to the lead in these three days, and its
      // second text waits at most two, so it has gone: the text the lead was resumed after is not news.
      const next = def(texted.s).tracks.find((t) => t.channel === "sms")?.steps[1];
      if (next && !endedAt(texted.s, h.clock) && !heldAt(texted.s, h.clock) && !delivered("sms", texted.s, next.id)) problem(`P6: ${texted.s.id} was resumed after a text at ${isoOf(textedAt)} and its next text ${next.id} has not gone three days on${process.env["CONTROLS_DEBUG"] ? ` [app replies ${JSON.stringify((await h.store.engine.subject(texted.s.id, h.clock))?.replies)}; texts ${JSON.stringify(sms.replyLog)}]` : ""}`);
      await checkAll();
    }
  }
  if (options.replyBeforeObservation !== undefined) {
    // The scripted prelude: the first lead sent the first step of a track of this channel replies, hidden from
    // observation for longer than the next step's wait (at most two days), so the pre-send check finds it first.
    const channel = options.replyBeforeObservation;
    const port = channel === "sms" ? sms : email;
    const rHidden = random(seed ^ 0x62a);
    let first: { s: Subject; d: (typeof port.deliveryLog)[number] } | undefined;
    for (let i = 0; i < 240 && !first; i++) {
      await h.advanceTo(h.clock + MINUTE);
      for (const d of port.deliveryLog) {
        const s = subjects.get(d.subjectId);
        const t = s ? def(s).tracks.find((x) => x.steps[0]?.id === d.stepId && x.channel === channel) : undefined;
        if (!s || !t || t.steps.length < 2 || d.visibleAt > h.clock || endedAt(s, h.clock) || heldAt(s, h.clock)) continue;
        if (channel === "sms" && !s.person.mobile) continue;
        first = { s, d };
        break;
      }
    }
    const hiddenForMs = Math.round((2.5 + rHidden() * 2) * DAY);
    const sent = first && (channel === "sms" ? sms.prospectTexts(first.s.person.mobile ?? "", "Not now, thanks", first.d.sender, null, hiddenForMs) : email.prospectReplies(first.d.destination, true, null, { inThreadOf: first.d, hiddenForMs }));
    if (first && sent) {
      const s = first.s;
      const replyAt = h.clock;
      // The app finds it at the next step's pre-send check: the lead ends replied, at the instant the engine recorded.
      let endedWall: number | null = null;
      for (let i = 0; i < 3 * 24 * 6 && endedWall === null; i++) {
        await h.advanceTo(h.clock + 10 * MINUTE);
        const st = await h.store.engine.subject(s.id, h.clock);
        if (st?.subject.ended === "replied") endedWall = st.subject.endedWall;
      }
      if (endedWall !== null && endedWall < replyAt + hiddenForMs) {
        replied(s, endedWall);
        features.add(`a-${channel}-reply-found-by-the-pre-send-check-before-its-observation`);
        if (accepts(s, "resume_from_next_step", h.clock)) {
          await control(s, "resume_from_next_step");
          // Past the delayed observation, and three days on for the next step.
          await h.advanceTo(Math.max(h.clock, replyAt + hiddenForMs) + 3 * DAY);
          const t = def(s).tracks.find((x) => x.channel === channel && x.steps[0]?.id === first.d.stepId);
          const next = t?.steps[1];
          if (next && !endedAt(s, h.clock) && !heldAt(s, h.clock) && !delivered(channel, s, next.id)) problem(`P6: ${s.id} was resumed after a reply the pre-send check found at ${isoOf(endedWall)} and its next ${channel} step ${next.id} has not gone three days after the reply's late observation`);
        }
        await checkAll();
      }
    }
  }
  if (options.withdrawalAcrossARecovery === true) {
    // The scripted prelude: a lead whose email is at the provider is paused (its withdrawal answered unknown), the
    // application stops for six minutes, and runs on for an hour after its recovery.
    // An email at the provider and not seen sent: its withdrawal is answered unknown while the provider keeps it.
    const unseen = (s: Subject) => email.handoverLog.some((c) => c.subjectId === s.id && c.mode === "late-send" && !email.deliveryLog.some((d) => d.key === c.key));
    let atProvider: Subject | undefined;
    for (let i = 0; i < 120 && !atProvider; i++) {
      await h.advanceTo(h.clock + MINUTE);
      atProvider = [...subjects.values()].find((s) => unseen(s) && !endedAt(s, h.clock) && !heldAt(s, h.clock));
    }
    if (atProvider) {
      await control(atProvider, "pause");
      await h.advanceTo(h.clock + 2 * MINUTE);
      await h.tick();
      // Six minutes: longer than the gap, and over before the withdrawal's next ask falls due.
      await h.stopFor(6 * MINUTE);
      features.add("a-withdrawal-asked-across-a-recovery");
      await h.advanceTo(h.clock + HOUR);
      await checkAll();
    }
  }
  /**
   * W3 (ADR 0003 "Reads that say when"): the read and dispatch agree, checked by running the dispatcher's next round at
   * the read's own instant, nothing else changing. The round before the event's control has read every provider, so the
   * engine knows at the read all a round can learn but what only the handover itself asks: the pre-send check. A read of
   * "now" is handed over in that round, unless that check found a reply the record of the lead did not hold (the round
   * stores it). A read of a reason is not handed over in it. A read of an earliest instant is never handed over before it.
   */
  /**
   * The step's claim still open before a round at `T` by the record (`claims`: the log's length when the round began), or
   * null: none made, handed over since, expired (15 minutes, ADR 0003 5.3), or the lead acted on since (a pause, skip, stop,
   * restart, win-back or reply withdraws its claims). A claim whose slot is not reached is not examined, so its inbox's
   * health does not end it; at its slot, an inbox that is down withdraws it (the caller asks).
   */
  const liveClaim = (s: Subject, stepId: string, T: number, claims: number): { sender: string; at: number } | null => {
    const c = claimLog.slice(0, claims).filter((x) => x.subjectId === s.id && x.stepId === stepId && x.at <= T).at(-1);
    if (!c) return null;
    const handed = [...email.handoverLog, ...sms.handoverLog].some((x) => x.subjectId === s.id && x.stepId === stepId && x.at >= c.at && x.at <= T);
    const actedOn = withdrawals.some((w) => w.seq > c.seq && (w.subjectId === s.id || w.campaign === s.campaign) && (w.stepId === null || w.stepId === stepId));
    if (handed || actedOn || T - c.at >= 15 * MINUTE) return null;
    return c;
  };
  const promised = new Map<string, { s: Subject; stepId: string; ch: "email" | "sms"; at: number; readAt: number }>();
  /** The main event's control previews, checked in W3's round (W4). */
  const previewed: { s: Subject; action: string; stepId: string; channel: string; when: ControlStepView["when"]; at: number; mark: { email: number; sms: number }; claims: number }[] = [];
  /**
   * The clock moves to the engine's next wake with no round, as between a 15-second worker's rounds, so steps fall due unread
   * by dispatch: only when no provider activity falls before or at that instant, so the engine then knows all its next round
   * can learn but the pre-send check's answer.
   */
  async function betweenRounds(feature: string): Promise<boolean> {
    const wake = await h.engine.nextWakeAt();
    const activity = [h.provider.nextActivityAt(), h.smsProvider?.nextActivityAt() ?? null].filter((t): t is number => t !== null && t > h.clock);
    if (wake === null || wake <= h.clock || wake > h.clock + DAY || !activity.every((t) => t > wake)) return false;
    h.clock = wake;
    features.add(feature);
    return true;
  }
  /**
   * A place a step read as ready could have taken in a round at `T` that went to no step the record ranks ahead of it, or
   * null when there is none (ADR 0003 "Reads that say when", rule 3): on each sender the step may use that the record has up
   * and not full by its sends, the place is held back by pacing (the sender's last call before `T` plus the gap), held by
   * work with the provider at its in-flight bound, or taken in the round by a step the record ranks ahead (a step the round
   * handed over that was not pending before it, a same-key retry, ranks ahead: retries go first). From the record and the
   * fake providers' logs only.
   */
  function freePlace(s: Subject, t: TrackDefinition, stepId: string, T: number, round: readonly { sender: string; subjectId: string; stepId: string; at: number }[], ranks: ReadonlyMap<string, readonly [number, number, string, string]>, marks: { email: number; sms: number }, claim: { sender: string } | null): string | null {
    const mine = ranks.get(`${s.id}/${stepId}`);
    const ahead = (c: { subjectId: string; stepId: string }) => {
      const k = ranks.get(`${c.subjectId}/${c.stepId}`);
      if (!k || !mine) return true;
      for (let i = 0; i < 4; i++) if (k[i] !== mine[i]) return (k[i] ?? 0) < (mine[i] ?? 0);
      return false;
    };
    const usable = sendersOf(s, t).filter((x) => outageUntil(x, T) === null && !fullBySendsAt(x, T));
    const room = (x: string) => capacityOf(x) - knownSentOn(x, T) - openOn(x, T, marks);
    // Held: at its in-flight bound, or its day's room taken by known sends and work with the provider.
    const held = (x: string) => openOn(x, T, marks) >= 2 || room(x) <= 0;
    const taken = (x: string) => round.some((c) => c.sender === x && c.at === T && ahead(c));
    // A claimed step's place is its claim's inbox (its slot reached: the caller asks for the slot reason otherwise); a step
    // with no claim takes its account choice's (4.2: the soonest slot, then the most room left, then the lowest id), by
    // the record's own slots and room. That place must be held back by pacing, held, or taken by a step ranked ahead.
    const place = claim ? claim.sender : usable.filter((x) => !held(x)).sort((x, y) => Math.max(slotBefore(x, T, marks), T) - Math.max(slotBefore(y, T, marks), T) || room(y) - room(x) || (x < y ? -1 : 1))[0];
    if (place === undefined) return null;
    if (slotBefore(place, T, marks) > T || (!claim && held(place)) || taken(place)) return null;
    return place;
  }
  async function listedAfterOf(s: Subject): Promise<boolean> {
    return [...(await h.request<CallsView>("GET", "/api/calls")).body.readyNow].some((x) => x.enrollmentId === s.id);
  }
  async function checkReadsAgainstDispatch(): Promise<void> {
    // In half the rounds, the reads come between two rounds, as a 15-second worker leaves them: the clock moves to the
    // engine's next wake with no round, so steps fall due unread by dispatch. Only when no provider activity falls before
    // or at that instant: the engine then knows at the read all its next round can learn but the pre-send check's answer.
    if (rW() < 0.5) await betweenRounds("w3-reads-between-rounds");
    const now = h.clock;
    const reads: { s: Subject; t: TrackDefinition; stepId: string; when: NonNullable<EnrollmentRead["tracks"][number]["nextStep"]>["when"] }[] = [];
    for (const s of subjects.values()) {
      const read = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${s.id}`)).body;
      for (const t of def(s).tracks) {
        if (t.channel === "call") continue;
        const next = read.tracks.find((x) => x.trackId === t.id)?.nextStep;
        if (next) reads.push({ s, t, stepId: next.stepId, when: next.when });
      }
    }
    // The record's priority of each pending step before the round (4.3): touched first, then the stored due, then lead, step.
    const ranks = new Map<string, [number, number, string, string]>();
    for (const s of subjects.values()) {
      for (const t of def(s).tracks) {
        if (t.channel === "call") continue;
        const pending = pendingOf(s, t, now);
        if (pending) ranks.set(`${s.id}/${pending.stepId}`, [touchedAt(s, now) ? 0 : 1, pending.unheld, s.id, pending.stepId]);
      }
    }
    const marks = { email: email.handoverLog.length, sms: sms.handoverLog.length };
    const claims = claimLog.length;
    const previews = previewed.splice(0);
    await h.tick();
    for (const v of previews) {
      if (v.channel === "call") {
        if (v.when?.kind === "call_day" && v.when.now && !(await listedAfterOf(v.s))) problem(`W4: ${v.action} on ${v.s.id} at ${isoOf(v.at)} previewed its call "ready to go on your call list", but the next round did not list it`);
        continue;
      }
      const ch = v.channel === "sms" ? "sms" : "email";
      // From the control's own instant: its first round is the one the route runs after it.
      const round = (ch === "sms" ? sms : email).handoverLog.slice(v.mark[ch]).filter((c) => c.at === v.at);
      const handed = round.some((c) => c.subjectId === v.s.id && c.stepId === v.stepId);
      const t = def(v.s).tracks.find((x) => x.steps.some((st) => st.id === v.stepId));
      if (v.when?.kind === "ready") features.add("w4-a-preview-of-ready");
      if (v.when?.kind === "ready" && !handed && t) {
        const open = liveClaim(v.s, v.stepId, v.at, v.claims);
        const free = freePlace(v.s, t, v.stepId, v.at, round, ranks, v.mark, open && slotBefore(open.sender, v.at, v.mark) <= v.at && outageUntil(open.sender, v.at) !== null ? null : open);
        if (free !== null) problem(`W4: ${v.action} on ${v.s.id} at ${isoOf(v.at)} previewed ${v.stepId} "ready", but the next round handed it nothing and gave ${free}'s place to no step the record ranks ahead of it`);
      }
      if ((v.when?.kind === "at" || (v.when?.kind === "waits" && v.when.why !== "with_provider" && v.when.why !== "unresolved")) && handed) problem(`W4: ${v.action} on ${v.s.id} at ${isoOf(v.at)} previewed ${v.stepId} ${JSON.stringify(v.when)}, but the next round handed it over`);
      if (v.when?.kind === "at" && !handed) promised.set(`${v.s.id}/${v.stepId}`, { s: v.s, stepId: v.stepId, ch, at: Date.parse(v.when.at), readAt: v.at });
    }
    for (const r of reads) {
      const ch = r.t.channel === "sms" ? "sms" : "email";
      const round = (ch === "sms" ? sms : email).handoverLog.slice(marks[ch]);
      const mine = round.filter((c) => c.subjectId === r.s.id && c.stepId === r.stepId);
      switch (r.when.kind) {
        case "ready": {
          features.add("w3-a-read-of-ready");
          // A claim whose own slot is not reached cannot be handed over at this instant: the read owes the slot reason.
          const open = liveClaim(r.s, r.stepId, now, claims);
          // At its slot, a claim whose inbox is down is withdrawn at this instant and the step chooses again.
          const claim = open && slotBefore(open.sender, now, marks) <= now && outageUntil(open.sender, now) !== null ? null : open;
          if (claim && slotBefore(claim.sender, now, marks) > now) {
            problem(`W3: ${r.s.id}/${r.stepId} read "ready" at ${isoOf(now)}, but the record has its claim on ${claim.sender} (made ${isoOf(claim.at)}) waiting for its slot at ${isoOf(slotBefore(claim.sender, now, marks))}`);
            break;
          }
          if (claim) features.add("w3-a-ready-claim-at-its-slot");
          if (mine.length > 0) break;
          const free = freePlace(r.s, r.t, r.stepId, now, round, ranks, marks, claim);
          if (free !== null) problem(`W3: ${r.s.id}/${r.stepId} read "ready" at ${isoOf(now)}; the next round handed it nothing and gave ${free}'s place to no step the record ranks ahead of it${process.env["CONTROLS_DEBUG"] ? ` [round ${JSON.stringify(round.map((c) => [c.subjectId, c.stepId, c.sender]))}; claim ${JSON.stringify(claim)}; slot ${isoOf(slotBefore(free, now, marks))}; open ${openOn(free, now, marks)}]` : ""}`);
          break;
        }
        case "waits":
          // The slot reason exactly when the record has the step's claim waiting for a slot not reached.
          if (r.when.why === "sender_slot") {
            const claim = liveClaim(r.s, r.stepId, now, claims);
            if (!claim || slotBefore(claim.sender, now, marks) <= now) problem(`W3: ${r.s.id}/${r.stepId} read "sender_slot" at ${isoOf(now)}, but the record has ${claim ? `its claim on ${claim.sender} at its slot (${isoOf(slotBefore(claim.sender, now, marks))})` : "no claim open for it"}${process.env["CONTROLS_DEBUG"] ? ` [claims ${JSON.stringify(claimLog.filter((x) => x.subjectId === r.s.id).map((x) => [x.stepId, x.sender, isoOf(x.at)]))}; log ${claimLog.length}; claimsMark ${claims}; pauses ${JSON.stringify(leadPauses.filter((p) => p.subjectId === r.s.id).map((p) => [isoOf(p.from), isoOf(p.to)]))}; cpauses ${JSON.stringify(campaignPauses.filter((p) => p.campaign === r.s.campaign).map((p) => [isoOf(p.from), isoOf(p.to)]))}; skips ${JSON.stringify(skips.filter((x) => x.subjectId === r.s.id).map((x) => [x.stepId, isoOf(x.at)]))}; endings ${JSON.stringify(endings.filter((e) => e.subjectId === r.s.id).map((e) => [e.kind, isoOf(e.at), isoOf(e.restartedAt)]))}; winBack ${isoOf(winBack.get(r.s.id))}; engine ${JSON.stringify((await h.store.engine.subject(r.s.id, now))?.attempts.map((a) => [a.stepId, a.state, a.accountId, isoOf(a.claimedWall)]))}]` : ""}`);
          }
          if (r.when.why === "sender_slot" || r.when.why === "sender_waiting" || r.when.why === "sending_capacity" || r.when.why === "sender_rate_limited" || r.when.why === "sender_unavailable") features.add(`w3-a-read-of-${r.when.why}`);
          if (mine.length > 0 && r.when.why !== "with_provider" && r.when.why !== "unresolved") problem(`W3: ${r.s.id}/${r.stepId} read "${r.when.why}" at ${isoOf(now)}, but the next round handed it over`);
          break;
        case "at":
          if (mine.length > 0) problem(`W3: ${r.s.id}/${r.stepId} read "earliest ${r.when.at}" at ${isoOf(now)}, but the next round handed it over before then`);
          else promised.set(`${r.s.id}/${r.stepId}`, { s: r.s, stepId: r.stepId, ch, at: Date.parse(r.when.at), readAt: now });
          break;
        case "call_day":
        case "listed_for":
          break;
        default: {
          const unhandled: never = r.when;
          throw new Error(`a read the record does not know: ${String(unhandled)}`);
        }
      }
    }
    // Each earliest instant once it has passed: never handed over before it. Nothing is promised at it.
    for (const [key, p] of promised) {
      if (h.clock < p.at) continue;
      promised.delete(key);
      const first = (p.ch === "sms" ? sms : email).handoverLog.find((c) => c.subjectId === p.s.id && c.stepId === p.stepId && c.at > p.readAt);
      if (first && first.at < p.at) problem(`W3: ${p.s.id}/${p.stepId} read "earliest ${isoOf(p.at)}" at ${isoOf(p.readAt)}, but was handed over at ${isoOf(first.at)}, before it`);
    }
  }

  for (let e = 0; e < eventCount && problems.length === 0 && !h.stopped; e++) {
    takeInboxDown(h.clock);
    const r = rand();
    await h.advanceTo(h.clock + (r < 0.5 ? MINUTE : pick([10 * MINUTE, HOUR, 5 * HOUR, 12 * HOUR, DAY])));
    settleHidden();
    // From their own stream: a refused request sent again; a pause and a skip while a lookup lags; a reply, a restart
    // and a new reply hidden in another thread; a control just after a due instant, before the worker's tick.
    const extra = r17();
    if (extra < 0.1) await retryRefused();
    else if (extra < 0.25 && lookupLags) await pauseThenSkip();
    else if (extra < 0.4 && !drawsWindows) await replyRestartReply();
    else if (extra < 0.55 && !outageUnderWay()) await actAtADueInstant();
    // One user action per instant: the event's own action comes a minute after an extra one.
    if (extra < 0.55) await h.advanceTo(h.clock + MINUTE);
    // In the windows family, a round reads every provider before the event, so W3's reads know what a round can learn; in
    // half the events the control then comes between rounds, so its preview may name a step due unread (W4).
    let unread = false;
    if (drawsWindows) {
      await h.tick();
      if (rW() < 0.5) unread = await betweenRounds("w4-a-control-between-rounds");
    }
    listedBefore = new Set([...(await h.request<CallsView>("GET", "/api/calls")).body.readyNow].map((x) => x.enrollmentId));
    const kind = rand();
    if (kind < 0.6) {
      const s = pick([...subjects.values()]);
      // Mostly an action that applies to the lead as the record has it; sometimes any.
      const fitting = ACTIONS.filter((a) => accepts(s, a, h.clock));
      await control(s, fitting.length > 0 && chance(0.8) ? pick(fitting) : pick(ACTIONS), { preview: drawsWindows && !interrupting, othersMayMove: unread });
    } else if (kind < 0.75) {
      const ci = Math.floor(rand() * campaignIds.length);
      await campaignControl(ci, campaignPausedAt(ci, h.clock) ? "resume" : "pause", unread);
    } else if (kind < 0.9) await autoReply();
    // A stale skip is a second user action at the same instant: the main control's preview no longer describes what follows.
    if (r18() < 0.3) {
      previewed.length = 0;
      await staleSkip();
    }
    await checkAll();
    // In the windows family, after every event the engine applied (an auto-reply is the provider's, read by the next
    // round): the extra round runs at the read's own instant.
    if (drawsWindows && (kind < 0.75 || kind >= 0.9)) await checkReadsAgainstDispatch();
    if (interrupting && r20() < 0.4 && calm()) {
      await interrupt();
      await checkAll();
    }
  }

  // The drain: every pause resumed, then each day every listed call logged no answer, until every lead has ended.
  if (problems.length === 0 && !h.stopped) {
    // The inbox back up for good, so every lead can finish.
    const current = down.outage;
    if (current !== null) {
      const failing = email.accountsById.get(outages[current.index]!.inbox);
      if (failing) failing.healthy = true;
      outages[current.index] = { ...outages[current.index]!, to: h.clock };
      down.outage = null;
    }
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
