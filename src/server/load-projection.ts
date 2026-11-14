/**
 * The Before launch tab's projected load (spec "Before launch"; ADR 0003, ticket 13b, "The
 * projection with every track"): the engine's own decisions run forward with no provider and no
 * writes.
 *
 * Every simulated subject is the engine's own `SubjectState`, and it changes only through the
 * engine's own rules object (`DEFAULT_RULES`): this campaign's leads enter as launch enters them,
 * and every instant runs the engine's passes in the engine's order until nothing changes: observe
 * the previous pass's sends, expire old claims, evaluate, claim in priority order, hand over per
 * account. Track starts, delays after a finished track, skipped and released tracks, touched
 * leads first across channels, windows, capacity across campaigns, pacing, fixed senders and the
 * SMS conversation rule are therefore the engine's, not a second implementation.
 *
 * What it supplies itself is what the store supplies to the engine: each account's count on its
 * reset day, open reservations, in-flight attempts and pacing slot (from the engine's own
 * `AccountState` records, then the simulation's own work), and the SMS bindings every subject
 * shares. And the provider: each handover is accepted and sent at once, and observed in the next
 * pass, as the fake providers do. `before-launch-projection.test.ts` compares it with the engine's
 * actual sends for generated multi-track, two-channel, multi-campaign cases.
 */
import { isLive } from "../domain/sequence/attempt.ts";
import { ENGINE_PARAMS } from "../domain/sequence/attempt.ts";
import { leadNow, localDayNumber, nextWindowOpen, resetDayOf, startOfLocalDay, windowOpen, type WindowRule } from "../domain/sequence/clock.ts";
import { windowOf, type ReadyItem } from "../domain/sequence/dispatch.ts";
import { callableOnDay, callWindow, goodNumbers } from "../domain/sequence/calls.ts";
import { liveSteps, liveTracks, poolOf, type CampaignDefinition, type TrackChannel } from "../domain/sequence/definition.ts";
import { channelReaches } from "../domain/sequence/progress.ts";
import type { AccountState, Attempt, CallDay, SmsBinding, SubjectState } from "../domain/sequence/state.ts";
import { DEFAULT_RULES, type Rules } from "./engine/rules.ts";

/** The engine's quota wait with no known end (engine-store). */
const NO_END = Number.MAX_SAFE_INTEGER;

export interface ProjectionInput {
  readonly now: number;
  /** This campaign's leads that have not ended, as the store holds them before launch. */
  readonly ours: readonly SubjectState[];
  /** The definition launch would start them on. */
  readonly definition: CampaignDefinition;
  /** Running subjects of other campaigns that compete for the same accounts. */
  readonly others: readonly SubjectState[];
  /** The engine's own records of every account any simulated subject may use. */
  readonly accounts: readonly AccountState[];
  /** The zone launch days are counted in: the campaign's default zone. */
  readonly zone: string;
  readonly horizonDays: number;
  /**
   * The user's call list at the projection's instant, as the store reports it (`EngineStore.callDay`),
   * when this campaign has a live phone track: due calls are then placed by the engine's own rules
   * (ADR 0003, ticket 14c). Absent, no call is placed.
   */
  readonly callDay?: CallDay;
  readonly rules?: Rules;
}

/** One call the projection places on the user's list. */
export interface ProjectedCall {
  readonly leadId: string;
  readonly trackId: string;
  readonly stepId: string;
  /** The user-local day number it is placed on, in the user's zone. */
  readonly day: number;
  readonly at: number;
}

export interface ProjectedSend {
  readonly leadId: string;
  readonly accountId: string;
  readonly trackId: string;
  readonly stepId: string;
  readonly channel: TrackChannel;
  /** Index of the step among its track's live steps. */
  readonly step: number;
  readonly at: number;
}

export interface Projection {
  /** The most this campaign sends from each account on one of its reset days. */
  readonly busiestDay: ReadonlyMap<string, number>;
  /**
   * This campaign's leads a live track can reach: they start with an email or a text, or, when calls
   * are placed (`callDay`), with their first call on the user's list.
   */
  readonly leadsToStart: number;
  /** Leads only a phone track can reach. Without `callDay` they are left out of `leadsToStart`, to the user's calls. */
  readonly onlyCalled: number;
  /** Launch day is day 1. Null when some lead does not start within the horizon, or none starts. */
  readonly daysUntilAllStart: number | null;
  readonly notStarted: number;
  /** Every projected send of this campaign, in order. */
  readonly sends: readonly ProjectedSend[];
  /** Every call of this campaign placed on the user's list, in order (only with `callDay`). */
  readonly calls: readonly ProjectedCall[];
  /** The most calls of this campaign placed on one user day. */
  readonly busiestCallDay: number;
}

/** A tiny min-heap of (instant, subject) wake-ups; stale entries only cost an extra look. */
class Wakes {
  private readonly at: number[] = [];
  private readonly ids: string[] = [];
  private swap(i: number, j: number): void {
    [this.at[i], this.at[j]] = [this.at[j] ?? 0, this.at[i] ?? 0];
    [this.ids[i], this.ids[j]] = [this.ids[j] ?? "", this.ids[i] ?? ""];
  }
  private time(i: number): number {
    return this.at[i] ?? Infinity;
  }
  push(at: number, id: string): void {
    if (!Number.isFinite(at)) return;
    this.at.push(at);
    this.ids.push(id);
    for (let i = this.at.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (this.time(p) <= this.time(i)) break;
      this.swap(p, i);
      i = p;
    }
  }
  peek(): number {
    return this.time(0);
  }
  pop(): string | undefined {
    if (this.at.length === 0) return undefined;
    const id = this.ids[0];
    this.swap(0, this.at.length - 1);
    this.at.pop();
    this.ids.pop();
    for (let i = 0; ; ) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < this.at.length && this.time(l) < this.time(m)) m = l;
      if (r < this.at.length && this.time(r) < this.time(m)) m = r;
      if (m === i) break;
      this.swap(m, i);
      i = m;
    }
    return id;
  }
}

export function projectLoad(input: ProjectionInput): Projection {
  const rules = input.rules ?? DEFAULT_RULES;
  const now = input.now;
  const end = now + input.horizonDays * 86_400_000;
  const records = new Map(input.accounts.map((a) => [a.id, a]));
  const accountIds = [...records.keys()].sort();
  // The reset day repeats for every lead at one instant: the engine's function, remembered.
  let dayAt = Number.NaN;
  const dayMemo = new Map<string, string>();
  const resetDay = (accountId: string, t: number) => {
    if (t !== dayAt) {
      dayAt = t;
      dayMemo.clear();
    }
    let d = dayMemo.get(accountId);
    if (d === undefined) dayMemo.set(accountId, (d = resetDayOf(t, records.get(accountId)?.resetZone ?? "UTC")));
    return d;
  };

  // ---- Subjects, and their contribution to the shared ledger, as the store counts it.
  const states = new Map<string, SubjectState>();
  const stateOf = (id: string): SubjectState => {
    const s = states.get(id);
    if (!s) throw new Error(`projection: no subject ${id}`);
    return s;
  };
  const oursIds = new Set(input.ours.map((s) => s.subject.id));
  const reserved = new Map<string, number>();
  const sentOn = new Map<string, number>();
  const live = new Map<string, number>();
  /** Claimed attempts per account: the handover's candidates. */
  const claimed = new Map<string, Map<string, string>>();
  const retrying = new Map<string, Map<string, string>>();
  const bump = <K,>(m: Map<K, number>, k: K, by: number) => m.set(k, (m.get(k) ?? 0) + by);
  const contribute = (s: SubjectState, sign: 1 | -1) => {
    for (const w of s.work) {
      if (w.settled === null && w.sentWall === null) bump(reserved, w.accountId, sign);
      if (w.sentDay !== null) bump(sentOn, `${w.accountId}/${w.sentDay}`, sign);
    }
    for (const a of s.attempts) {
      if (!isLive(a)) continue;
      bump(live, a.accountId, sign);
      if (a.state === "claimed") {
        const m = claimed.get(a.accountId) ?? new Map<string, string>();
        if (sign > 0) m.set(a.id, s.subject.id);
        else m.delete(a.id);
        claimed.set(a.accountId, m);
      }
      // A same-key retry waiting for its slot (5.6), which `handOverAll` takes before claims.
      if (a.state === "handed" && (a.retry === "wanted" || a.retry === "wanted_after_not_sent")) {
        const m = retrying.get(a.accountId) ?? new Map<string, string>();
        if (sign > 0) m.set(a.id, s.subject.id);
        else m.delete(a.id);
        retrying.set(a.accountId, m);
      }
    }
  };

  // SMS conversations, shared by every subject, by mobile.
  const bindings = new Map<string, SmsBinding[]>();
  let bindingsVersion = 0;
  const addBinding = (b: SmsBinding) => {
    const list = bindings.get(b.recipient) ?? [];
    if (list.some((x) => x.sender === b.sender)) return;
    bindings.set(b.recipient, [...list, b]);
    bindingsVersion++;
  };

  // ---- Prepare: this campaign's leads enter as launch enters them; everyone else as stored.
  const launched = input.ours.map((s) => ({ ...s, campaign: { ...s.campaign, launchedAt: now, definition: input.definition } }));
  for (const s of [...input.others, ...launched]) for (const b of s.smsBindings) addBinding(b);
  const today = new Map(accountIds.map((id) => [id, resetDay(id, now)]));
  const sendsBefore = (id: string) => sentOn.get(`${id}/${today.get(id)}`) ?? 0;
  for (const s of [...input.others, ...launched]) {
    states.set(s.subject.id, s);
    contribute(s, 1);
  }
  // The record counts every subject's sends today and open reservations; the simulation keeps
  // its own subjects' count, so theirs are taken out of the starting count once.
  // Every subject holding work on these accounts is simulated (before-launch.ts), so what the record
  // counts beyond the simulation's own work is sends made today by subjects that hold nothing now.
  const baseToday = new Map(accountIds.map((id) => [id, (records.get(id)?.used ?? 0) - sendsBefore(id) - (reserved.get(id) ?? 0)]));
  const slot = new Map(accountIds.map((id) => [id, records.get(id)?.nextSlotAt ?? 0]));

  // ---- The user's call list (ADR 0003, ticket 14c), as the store supplies it to the engine: on the
  // projection's own user day, the stored counts across every campaign plus the simulation's
  // placements; on a later day, the simulation's placements, and the store's own count of committed
  // tasks (placed before the day, open at its start, for a lead that had not ended, callable that day)
  // over the simulated subjects, which include every subject holding an open call task. The user is
  // assumed to work every call on the list on its day, logging no answer (`workTheList` below), so
  // what is carried is what the engine would carry.
  const callSettings = input.callDay;
  const day0 = callSettings ? localDayNumber(now, callSettings.userZone) : 0;
  const placedOn = new Map<number, number>();
  const committedMemo = { day: Number.NaN, written: -1, value: 0 };
  const committedOn = (day: number, zone: string): number => {
    if (committedMemo.day === day && committedMemo.written === written) return committedMemo.value;
    const start = startOfLocalDay(day, zone);
    const end = startOfLocalDay(day + 1, zone);
    let n = 0;
    for (const s of states.values()) {
      if (s.subject.endedWall !== null && s.subject.endedWall < start) continue;
      for (const task of s.callTasks) {
        if (task.placedWall >= start || (!task.open && (task.closedWall ?? Number.NEGATIVE_INFINITY) < start)) continue;
        if (callableOnDay(callWindow(s, task.trackId), s.lead.zone, start, end)) n++;
      }
    }
    Object.assign(committedMemo, { day, written, value: n });
    return n;
  };
  const callDayAt = (t: number): CallDay | null => {
    if (!callSettings) return null;
    const day = localDayNumber(t, callSettings.userZone);
    return {
      userZone: callSettings.userZone,
      day,
      capacity: callSettings.capacity,
      placedToday: (day === day0 ? callSettings.placedToday : 0) + (placedOn.get(day) ?? 0),
      committed: day === day0 ? callSettings.committed : committedOn(day, callSettings.userZone),
    };
  };
  /** The last second of the user day `t` falls in: the instant the assumed user works the day's list. */
  const lastSecondOf = (t: number): number => (callSettings ? startOfLocalDay(localDayNumber(t, callSettings.userZone) + 1, callSettings.userZone) - 1000 : Infinity);
  const nextUserDay = (t: number): number => (callSettings ? startOfLocalDay(localDayNumber(t, callSettings.userZone) + 1, callSettings.userZone) : Infinity);

  /** The account as the store would report it at `t`. */
  const view = (id: string, t: number): AccountState | undefined => {
    const a = records.get(id);
    if (!a) return undefined;
    const day = resetDay(id, t);
    return {
      ...a,
      nextSlotAt: slot.get(id) ?? 0,
      used: (day === today.get(id) ? (baseToday.get(id) ?? 0) : 0) + (sentOn.get(`${id}/${day}`) ?? 0) + (reserved.get(id) ?? 0),
      inFlight: live.get(id) ?? 0,
    };
  };
  /** Bumped by every write: a loaded subject is reused until anything it could read has changed. */
  let written = 0;
  const loadCache = new Map<string, { written: number; t: number; state: SubjectState }>();
  /** The subject as the store would load it at `t`: current accounts and conversations. */
  const load = (id: string, t: number): SubjectState => {
    const known = loadCache.get(id);
    if (known && known.written === written && known.t === t) return known.state;
    const state = loadNow(id, t);
    loadCache.set(id, { written, t, state });
    return state;
  };
  // Most leads read the same accounts (their campaign's pools): one accounts object per set of ids,
  // instant and write; and each lead's conversations until a binding is added.
  const accountsCache = new Map<string, { written: number; t: number; accounts: Record<string, AccountState> }>();
  const idsCache = new WeakMap<SubjectState, string>();
  const bindingsCache = new WeakMap<SubjectState, { version: number; list: SmsBinding[] }>();
  const loadNow = (id: string, t: number): SubjectState => {
    const s = stateOf(id);
    let key = idsCache.get(s);
    if (key === undefined) {
      const def = s.campaign.definition;
      key = [...new Set([...def.emailPool, ...poolOf(def, "sms"), ...s.attempts.map((a) => a.accountId), ...[s.subject.emailSender, s.subject.smsSender].filter((x): x is string => x !== null)])].sort().join("\n");
      idsCache.set(s, key);
    }
    let accounts = accountsCache.get(key);
    if (!accounts || accounts.written !== written || accounts.t !== t) {
      const map: Record<string, AccountState> = {};
      for (const a of key === "" ? [] : key.split("\n")) {
        const v = view(a, t);
        if (v) map[a] = v;
      }
      accounts = { written, t, accounts: map };
      accountsCache.set(key, accounts);
    }
    let smsBindings = bindingsCache.get(s);
    if (!smsBindings || smsBindings.version !== bindingsVersion) {
      const mobiles = new Set([...s.lead.details.filter((d) => d.channel === "phone").map((d) => d.key), ...s.attempts.map((a) => a.destination)]);
      smsBindings = { version: bindingsVersion, list: [...mobiles].flatMap((m) => bindings.get(m) ?? []) };
      bindingsCache.set(s, smsBindings);
    }
    const callDay = callDayAt(t);
    return { ...s, accounts: accounts.accounts, smsBindings: smsBindings.list, ...(callDay ? { callDay } : {}) };
  };

  const dirty = new Set<string>(states.keys());
  const wakes = new Wakes();
  /** Writes a subject's change, as the store does: the ledger, the slot it took, the conversation it bound. */
  const write = (id: string, loaded: SubjectState, next: SubjectState) => {
    if (next === loaded) return false;
    written++;
    const before = stateOf(id);
    contribute(before, -1);
    const stored = { ...next };
    states.set(id, stored);
    contribute(stored, 1);
    for (const [aid, acc] of Object.entries(next.accounts)) if (acc.nextSlotAt !== loaded.accounts[aid]?.nextSlotAt) slot.set(aid, acc.nextSlotAt);
    for (const b of next.smsBindings) addBinding(b);
    dirty.add(id);
    return true;
  };

  // The provider (ADR 0003, ticket 13b): every call the projection makes is accepted and sent at
  // once. Work already in the provider's hands at the projection's instant: an accepted attempt is
  // sent then, and a call still waiting for its answer is answered accepted and sent then. A call
  // answered unknown keeps its state: a same-key retry waiting for its slot is made by the engine's
  // retry rules below (and is accepted and sent), and uncertain work no attempt carries stays
  // reserved until a claim carries it on (`inheritedWork`). Nothing else settles it: lookups are not
  // foreseen.
  let observed: { id: string; key: string; at: number; ref: string }[] = [];
  const answered: { id: string; attemptId: string; key: string }[] = [];
  for (const s of states.values()) {
    for (const a of s.attempts) {
      if (a.state === "accepted") observed.push({ id: s.subject.id, key: a.idempotencyKey, at: now, ref: `held-${a.idempotencyKey}` });
      else if (a.state === "handed" && a.awaitingAnswer) answered.push({ id: s.subject.id, attemptId: a.id, key: a.idempotencyKey });
    }
  }
  for (const x of answered) {
    const loaded = load(x.id, now);
    write(x.id, loaded, rules.applyToAttempt(loaded, x.attemptId, { kind: "call_answer", answer: { kind: "accepted", providerRef: `held-${x.key}` }, now }, now).state);
    observed.push({ id: x.id, key: x.key, at: now, ref: `held-${x.key}` });
  }

  for (const s of launched) {
    const loaded = load(s.subject.id, now);
    write(s.subject.id, loaded, rules.evaluate(rules.enterMain(loaded, now), now));
  }

  const callers = new Set<string>();
  if (callSettings) for (const [id, s] of states) if (liveTracks(s.campaign.definition, "main").some((t) => t.channel === "call")) callers.add(id);
  /**
   * The assumed user (ADR 0003, ticket 14c): in the last second of each user day, every call on the
   * list is worked and logged as no answer on the lead's first good number, by the engine's own
   * `logCallOutcome`. That finishes the phone track (the tracks after it start after their delay),
   * touches the lead (its later messages and calls go first) and continues the lead, as the engine
   * does with that outcome.
   */
  let workedAt = Number.NaN;
  let workSeq = 0;
  const workTheList = (t: number): boolean => {
    let any = false;
    for (const [id, s] of [...states]) {
      for (const task of s.callTasks) {
        if (!task.open) continue;
        const loaded = load(id, t);
        if (!rules.isListed(loaded, task)) continue;
        const number = goodNumbers(loaded)[0];
        if (!number) continue;
        const n = ++workSeq;
        const out = rules.logCallOutcome(loaded, task.id, { requestId: `projected-work-${n}`, outcome: "no_answer", numberId: number.id, note: "", noteScope: "person" }, t, { attempt: `projected-attempt-${n}`, note: `projected-note-${n}` }, rules.isListed);
        if (out.ok && !out.replayed) any = write(id, loaded, out.state) || any;
      }
    }
    return any;
  };
  const calls: ProjectedCall[] = [];
  let callSeq = 0;
  /** A caller with no call ready, unchanged since, on the same user day, before its next due call. */
  const callChecked = new Map<string, { state: SubjectState; day: number; until: number }>();

  const sends: ProjectedSend[] = [];
  let attemptSeq = 0;
  const evalUntil = new Map<string, { state: SubjectState; until: number }>();
  const ready = new Map<string, { state: SubjectState; items: ReadyItem[]; until: number; windows: { w: readonly WindowRule[]; zone: string }[] }>();
  // Every ready item in claim order, kept sorted as entries come and go, so a pass with thousands
  // of leads waiting for capacity does not sort them all again.
  let sorted: ReadyItem[] = [];
  const gone = new Set<string>();
  const added: ReadyItem[] = [];
  const dropReady = (id: string) => {
    if (ready.delete(id)) gone.add(id);
  };
  const sortedItems = (): ReadyItem[] => {
    if (gone.size === 0 && added.length === 0) return sorted;
    const kept = gone.size === 0 ? sorted : sorted.filter((i) => !gone.has(i.subjectId) || ready.get(i.subjectId)?.items.includes(i));
    const fresh = added.filter((i) => ready.get(i.subjectId)?.items.includes(i)).sort(rules.claimOrder);
    const merged: ReadyItem[] = [];
    let a = 0;
    let b = 0;
    for (;;) {
      const x = kept[a];
      const y = fresh[b];
      if (x === undefined && y === undefined) break;
      if (y === undefined || (x !== undefined && rules.claimOrder(x, y) <= 0)) {
        merged.push(x as ReadyItem);
        a++;
      } else {
        merged.push(y);
        b++;
      }
    }
    gone.clear();
    added.length = 0;
    sorted = merged;
    return sorted;
  };
  const oursDone = () => [...oursIds].every((id) => states.get(id)?.subject.ended !== null);

  // Window answers repeat for many leads at one instant: the engine's function, remembered.
  let memoAt = Number.NaN;
  const openMemo = new Map<string, boolean>();
  const nextOpenMemo = new Map<string, number | null>();
  const windowIds = new Map<readonly WindowRule[], number>();
  const windowKey = (w: readonly WindowRule[], zone: string) => {
    let id = windowIds.get(w);
    if (id === undefined) windowIds.set(w, (id = windowIds.size));
    return `${id}|${zone}`;
  };
  const atInstant = (t: number) => {
    if (t !== memoAt) {
      memoAt = t;
      openMemo.clear();
      nextOpenMemo.clear();
    }
  };
  const isOpen = (w: readonly WindowRule[], zone: string, t: number) => {
    atInstant(t);
    const k = windowKey(w, zone);
    let v = openMemo.get(k);
    if (v === undefined) openMemo.set(k, (v = windowOpen(w, zone, t)));
    return v;
  };
  const opensNext = (w: readonly WindowRule[], zone: string, t: number) => {
    atInstant(t);
    const k = windowKey(w, zone);
    if (!nextOpenMemo.has(k)) nextOpenMemo.set(k, nextWindowOpen(w, zone, t));
    return nextOpenMemo.get(k) ?? null;
  };

  /** The provider's answer to an authorized call: accepted, and sent at once (observed in the next pass). */
  const called = (id: string, attempt: Attempt, accountId: string, t: number) => {
    const reloaded = load(id, t);
    const ref = `projected-ref-${attempt.idempotencyKey}`;
    write(id, reloaded, rules.applyToAttempt(reloaded, attempt.id, { kind: "call_answer", answer: { kind: "accepted", providerRef: ref }, now: t }, t).state);
    observed.push({ id, key: attempt.idempotencyKey, at: t, ref });
    if (oursIds.has(id)) {
      const track = reloaded.campaign.definition.tracks.find((x) => x.id === attempt.trackId);
      sends.push({ leadId: id, accountId, trackId: attempt.trackId, stepId: attempt.stepId, channel: track?.channel ?? "email", step: track ? liveSteps(track).findIndex((x) => x.id === attempt.stepId) : 0, at: t });
    }
  };
  /** The pre-send check: the fake providers find nothing, so it is recorded fresh and clear. */
  const presend = (id: string, attemptId: string, t: number) => {
    const loaded = load(id, t);
    const a = loaded.attempts.find((x) => x.id === attemptId);
    if (a && !(a.presendCheckedWall !== null && a.presendCheckedWall >= t - ENGINE_PARAMS.PRESEND_MAX_AGE && !a.presendFoundReply)) {
      write(id, loaded, { ...loaded, attempts: loaded.attempts.map((x) => (x.id === attemptId ? { ...x, presendCheckedWall: t, presendFoundReply: false } : x)) });
    }
  };
  /** `Engine.tryHandover`, on the engine's own predicates and writes. */
  const handOverNow = (id: string, attemptId: string, accountId: string): "handed" | "withdrawn" | "waiting" | "skip" => {
    presend(id, attemptId, t);
    const loaded = load(id, t);
    const current = loaded.attempts.find((x) => x.id === attemptId);
    const account = current ? loaded.accounts[current.accountId] : undefined;
    if (!current || current.state !== "claimed" || !account) return "withdrawn";
    const failed = rules.handoverFailures(loaded, current, account, t);
    if (failed.length === 0) {
      const handed = rules.handOver(loaded, current, account, t);
      write(id, loaded, handed);
      called(id, handed.attempts.find((x) => x.id === attemptId) ?? current, accountId, t);
      return "handed";
    }
    if (failed.every((f) => f === 16 || f === 18) && failed.includes(18)) return "skip";
    if (failed.every((f) => f === 16)) return "waiting";
    write(id, loaded, rules.applyToAttempt(loaded, current.id, { kind: "guard_failed" }, t).state);
    return "withdrawn";
  };
  /** `Engine.tryRetry`, on the engine's own retry authorization. */
  const retryNow = (id: string, attemptId: string, accountId: string): "handed" | "withdrawn" | "waiting" | "skip" => {
    const snapshot = load(id, t);
    const a = snapshot.attempts.find((x) => x.id === attemptId);
    const acc = a ? snapshot.accounts[a.accountId] : undefined;
    if (a && acc) {
      const pending = rules.retryFailures(snapshot, a, acc, t).filter((f) => f !== "predicate 14");
      if (pending.length > 0 && pending.every((f) => f === "slot")) return "waiting";
    }
    presend(id, attemptId, t);
    const loaded = load(id, t);
    const current = loaded.attempts.find((x) => x.id === attemptId);
    const account = current ? loaded.accounts[current.accountId] : undefined;
    if (!current || !account || (current.retry !== "wanted" && current.retry !== "wanted_after_not_sent")) return "withdrawn";
    const failed = rules.retryFailures(loaded, current, account, t);
    if (failed.includes("predicate 18")) return "skip";
    if (failed.length === 0) {
      const next = rules.authorizeRetry(loaded, current, account, t);
      write(id, loaded, next);
      called(id, next.attempts.find((x) => x.id === attemptId) ?? current, accountId, t);
      return "handed";
    }
    if (failed.every((f) => f === "slot")) return "waiting";
    write(id, loaded, rules.applyToAttempt(loaded, current.id, { kind: "retry_refused", now: t }, t).state);
    return "withdrawn";
  };

  let t = now;
  for (let guard = 0; guard < 2_000_000 && t <= end; guard++) {
    if (oursIds.size === 0 || oursDone()) break;
    // Subjects whose time-driven change (a start, a due step) has come.
    while (wakes.peek() <= t) {
      const id = wakes.pop();
      if (id !== undefined) dirty.add(id);
    }

    for (let pass = 0; pass < 10_000; pass++) {
      let changed = false;

      // Observe: the previous pass's sends, at their send instant (the provider's send time).
      const seen = observed;
      observed = [];
      for (const o of seen) {
        const loaded = load(o.id, t);
        const next = rules.applyToWork(loaded, o.key, { kind: "sent_observed", providerTime: o.at, providerRef: o.ref }, t, { resetDay, point: rules.sendPoint }).state;
        changed = write(o.id, loaded, next) || changed;
      }

      // Claims older than the settling time expire.
      for (const accountId of accountIds) {
        for (const [attemptId, id] of [...(claimed.get(accountId) ?? [])]) {
          const a = states.get(id)?.attempts.find((x) => x.id === attemptId);
          if (!a || t - a.claimedWall < ENGINE_PARAMS.SETTLING) continue;
          const loaded = load(id, t);
          changed = write(id, loaded, rules.applyToAttempt(loaded, attemptId, { kind: "claim_expired", now: t }, t).state) || changed;
        }
      }

      // Evaluate every subject that changed or whose next start has come.
      const evaluatedAgain = new Set<string>();
      for (const id of [...dirty]) {
        const s = stateOf(id);
        const known = evalUntil.get(id);
        if (known?.state === s && t < known.until) continue;
        const loaded = load(id, t);
        const next = rules.evaluate(loaded, t);
        if (next === loaded) {
          const lead = leadNow(s.subject.clock, t);
          const starts = s.tracks.filter((p) => p.startedAt === null && p.startAt !== null).map((p) => t + ((p.startAt ?? 0) - lead)).filter((x) => x > t);
          const until = Math.min(Infinity, ...starts);
          evalUntil.set(id, { state: s, until });
          wakes.push(until, id);
          continue;
        }
        write(id, loaded, next);
        // Evaluated again in the next pass, which records its next start if nothing more changes.
        evaluatedAgain.add(id);
        changed = true;
      }

      // Ready items, cached per subject until it changes or its next step falls due.
      for (const id of dirty) {
        const s = stateOf(id);
        const known = ready.get(id);
        if (known?.state === s && t < known.until) continue;
        const items = rules.readyItems(load(id, t), t);
        const lead = leadNow(s.subject.clock, t);
        // Its next due step, or its next track start (as `Engine.nextWakeAt`).
        const dues = [
          ...s.tracks.filter((p) => p.finishedAt === null && p.dueAt !== null).map((p) => t + ((p.dueAt ?? 0) - lead)),
          ...s.tracks.filter((p) => p.startedAt === null && p.startAt !== null).map((p) => t + ((p.startAt ?? 0) - lead)),
        ].filter((x) => x > t);
        const until = Math.min(Infinity, ...dues);
        if (ready.has(id)) gone.add(id);
        ready.set(id, { state: s, items, until, windows: items.map((i) => ({ w: windowOf(s, i.trackId), zone: s.lead.zone })) });
        added.push(...items);
        wakes.push(until, id);
      }
      dirty.clear();
      for (const id of evaluatedAgain) dirty.add(id);

      // Calls (4.4), exactly as `Engine.placeCallsAll`: every caller's ready calls, in `callOrder`,
      // each placed by `placeCall` on the subject as the store would load it now, with the day's room.
      if (callSettings) {
        const day = localDayNumber(t, callSettings.userZone);
        const items: ReadyItem[] = [];
        for (const id of callers) {
          const st = stateOf(id);
          const known = callChecked.get(id);
          if (known?.state === st && known.day === day && t < known.until) continue;
          const found = rules.readyCalls(load(id, t), t);
          items.push(...found);
          if (found.length === 0) {
            // Nothing to place until a call falls due, or the next user day (its hours may open then).
            const lead = leadNow(st.subject.clock, t);
            const dues = st.tracks.filter((p) => p.finishedAt === null && p.dueAt !== null && p.dueAt > lead).map((p) => t + ((p.dueAt ?? 0) - lead));
            const until = Math.min(nextUserDay(t), ...dues);
            callChecked.set(id, { state: st, day, until });
            if (st.tracks.some((p) => p.finishedAt === null && p.nextStepId !== null && !st.callTasks.some((x) => x.stepId === p.nextStepId) && st.campaign.definition.tracks.find((x) => x.id === p.trackId)?.channel === "call")) wakes.push(until, id);
          }
        }
        items.sort(rules.callOrder);
        for (const item of items) {
          const loaded = load(item.subjectId, t);
          const next = rules.placeCall(loaded, item, t, `projected-call-${++callSeq}`);
          if (!next) {
            // No room today: it waits for the next user day, and is never dropped.
            wakes.push(nextUserDay(t), item.subjectId);
            continue;
          }
          write(item.subjectId, loaded, next);
          bump(placedOn, day, 1);
          if (oursIds.has(item.subjectId)) calls.push({ leadId: item.subjectId, trackId: item.trackId, stepId: item.stepId, day, at: t });
          changed = true;
        }
      }

      // Claims (4.2): every ready item in claim order (4.3), exactly as `Engine.claimAll` does it.
      // Each item goes to the engine's own step guard, account choice and claim, on the subject as
      // the store would load it now (current accounts, conversations and its own earlier claim this
      // pass); nothing is decided here before those calls.
      for (const item of sortedItems()) {
        if (!ready.get(item.subjectId)?.items.includes(item)) continue;
        const loaded = load(item.subjectId, t);
        // Both are the engine's pure checks, and a claim needs both, so their order changes no
        // answer; the account choice goes first because it is the cheaper one (no zone or copy work).
        const account = rules.chooseAccount(loaded, t, item.stepId);
        if (!account) continue;
        if (rules.claimRefusal(loaded, item, t) !== null) continue;
        write(item.subjectId, loaded, rules.claim(loaded, item, account, { attemptId: `projected-${++attemptSeq}`, retryable: false, notSentIsFinal: false, now: t }));
        changed = true;
      }
      // A subject's claim is written into `dirty`; its cached items are stale now.
      for (const id of dirty) dropReady(id);

      // Handovers and retries (5.5, 5.6), exactly as `Engine.handOverAll`: per account in id order,
      // same-key retries first, then claims by `handoverOrder`; a claim waits for the slot, a retry's
      // own authorization decides whether it waits.
      for (const accountId of accountIds) {
        const skipped = new Set<string>();
        for (let i = 0; i < 100; i++) {
          const waiting = [
            ...[...(retrying.get(accountId) ?? [])].map(([attemptId, id]) => ({ attemptId, id, retry: true })),
            ...[...(claimed.get(accountId) ?? [])].map(([attemptId, id]) => ({ attemptId, id, retry: false })),
          ].filter((w) => !skipped.has(w.attemptId));
          const order = waiting.flatMap((w) => {
            const s = stateOf(w.id);
            const a = s.attempts.find((x) => x.id === w.attemptId);
            return a ? [{ ...w, item: { subjectId: w.id, trackId: a.trackId, stepId: a.stepId, touched: s.subject.touched, dueWall: s.tracks.find((p) => p.trackId === a.trackId)?.dueWall ?? 0 } }] : [];
          });
          order.sort((x, y) => (x.retry !== y.retry ? (x.retry ? -1 : 1) : rules.handoverOrder(x.item, y.item)));
          const next = order[0];
          if (!next) break;
          if (!next.retry && t < (slot.get(accountId) ?? 0)) break;
          const outcome = next.retry ? retryNow(next.id, next.attemptId, accountId) : handOverNow(next.id, next.attemptId, accountId);
          if (outcome === "skip") skipped.add(next.attemptId);
          else changed = true;
          if (outcome === "waiting") break;
        }
      }
      for (const id of dirty) dropReady(id);
      if (!changed && observed.length === 0) break;
    }

    // The day's list is worked in its last second, after this instant's passes (as the engine's user
    // logs between ticks); the passes then run again at the same instant.
    if (callSettings && t === lastSecondOf(t) && workedAt !== t) {
      workedAt = t;
      if (workTheList(t)) continue;
    }

    // The next instant anything can change, as `Engine.nextWakeAt`.
    const candidates: number[] = [wakes.peek()];
    // Waiting items whose window is closed wake at its next opening: once per window and zone.
    const windows = new Map<readonly WindowRule[], Set<string>>();
    for (const r of ready.values()) {
      for (const x of r.windows) {
        let zones = windows.get(x.w);
        if (!zones) windows.set(x.w, (zones = new Set()));
        zones.add(x.zone);
      }
    }
    for (const [w, zones] of windows) {
      for (const zone of zones) {
        if (isOpen(w, zone, t)) continue;
        const opens = opensNext(w, zone, t);
        if (opens !== null) candidates.push(opens);
      }
    }
    for (const id of accountIds) {
      const a = records.get(id);
      if (!a) continue;
      if ((claimed.get(id)?.size ?? 0) > 0) {
        candidates.push(slot.get(id) ?? 0);
        for (const [attemptId, sid] of claimed.get(id) ?? []) {
          const at = states.get(sid)?.attempts.find((x) => x.id === attemptId)?.claimedWall;
          if (at !== undefined) candidates.push(at + ENGINE_PARAMS.SETTLING);
        }
      }
      if ((retrying.get(id)?.size ?? 0) > 0) candidates.push(slot.get(id) ?? 0);
      if (a.waitUntil !== null && a.waitUntil < NO_END) candidates.push(a.waitUntil);
      // Capacity frees at every account's next reset day.
      candidates.push(startOfLocalDay(localDayNumber(t, a.resetZone) + 1, a.resetZone));
    }
    // An open call is worked in the last second of its day.
    if (callSettings && [...states.values()].some((x) => x.callTasks.some((task) => task.open))) candidates.push(t < lastSecondOf(t) ? lastSecondOf(t) : lastSecondOf(t + 2000));
    const next = Math.min(...candidates.filter((c) => c > t));
    if (!Number.isFinite(next)) break;
    t = next;
  }

  // ---- What the screen shows.
  const busiest = new Map<string, number>();
  const perDay = new Map<string, number>();
  for (const s of sends) bump(perDay, `${s.accountId}/${resetDay(s.accountId, s.at)}`, 1);
  for (const [key, n] of perDay) {
    const id = key.slice(0, key.lastIndexOf("/"));
    busiest.set(id, Math.max(busiest.get(id) ?? 0, n));
  }
  // A lead no live track can reach ends at launch, with the reason shown elsewhere. A lead starts at
  // its first email or text, or, when calls are placed, when its first call goes on the user's list
  // (ticket 14c); without calls placed, a lead only a phone track can reach is left to the user's calls.
  const liveMain = liveTracks(input.definition, "main");
  const sendTracks = liveMain.filter((t) => t.channel !== "call");
  const counted = callSettings ? liveMain : sendTracks;
  const reachable = launched.map((s) => s.subject.id).filter((id) => {
    const s = stateOf(id);
    return !(s.subject.ended === "finished_no_usable_channel" && s.results.length === 0 && (s.subject.endedWall ?? now) <= now);
  });
  const bySend = reachable.filter((id) => sendTracks.some((t) => channelReaches(stateOf(id), t.channel)));
  const entered = reachable.filter((id) => counted.some((t) => channelReaches(stateOf(id), t.channel)));
  const first = new Map<string, number>();
  for (const s of sends) if (!first.has(s.leadId)) first.set(s.leadId, s.at);
  for (const c of calls) if ((first.get(c.leadId) ?? Infinity) > c.at) first.set(c.leadId, c.at);
  const notStarted = entered.filter((id) => !first.has(id)).length;
  const firsts = [...first.values()];
  const perCallDay = new Map<number, number>();
  for (const c of calls) bump(perCallDay, c.day, 1);
  return {
    busiestDay: busiest,
    leadsToStart: entered.length,
    onlyCalled: reachable.length - bySend.length,
    daysUntilAllStart: notStarted > 0 || firsts.length === 0 ? null : localDayNumber(Math.max(...firsts), input.zone) - localDayNumber(now, input.zone) + 1,
    notStarted,
    sends,
    calls,
    busiestCallDay: Math.max(0, ...perCallDay.values()),
  };
}
