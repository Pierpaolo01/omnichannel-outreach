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
import { accountAvailable, accountHasRoom, senderOf, windowOf, type ReadyItem } from "../domain/sequence/dispatch.ts";
import { liveSteps, poolOf, type CampaignDefinition, type TrackChannel } from "../domain/sequence/definition.ts";
import { channelOf } from "../domain/sequence/progress.ts";
import type { AccountState, SmsBinding, SubjectState } from "../domain/sequence/state.ts";
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
  readonly rules?: Rules;
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
  /** This campaign's leads that some live track can reach: they have not ended at launch. */
  readonly leadsToStart: number;
  /** Launch day is day 1. Null when some lead does not start within the horizon, or none starts. */
  readonly daysUntilAllStart: number | null;
  readonly notStarted: number;
  /** Every projected send of this campaign, in order. */
  readonly sends: readonly ProjectedSend[];
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
  const bump = (m: Map<string, number>, k: string, by: number) => m.set(k, (m.get(k) ?? 0) + by);
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
    }
  };

  // SMS conversations, shared by every subject, by mobile.
  const bindings = new Map<string, SmsBinding[]>();
  const addBinding = (b: SmsBinding) => {
    const list = bindings.get(b.recipient) ?? [];
    if (!list.some((x) => x.sender === b.sender)) bindings.set(b.recipient, [...list, b]);
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
  const baseToday = new Map(accountIds.map((id) => [id, (records.get(id)?.used ?? 0) - sendsBefore(id) - (reserved.get(id) ?? 0)]));
  const slot = new Map(accountIds.map((id) => [id, records.get(id)?.nextSlotAt ?? 0]));

  /** The account as the store would report it at `t`. */
  const view = (id: string, t: number): AccountState | undefined => {
    const a = records.get(id);
    if (!a) return undefined;
    const day = resetDay(id, t);
    return { ...a, nextSlotAt: slot.get(id) ?? 0, used: (day === today.get(id) ? (baseToday.get(id) ?? 0) : 0) + (sentOn.get(`${id}/${day}`) ?? 0) + (reserved.get(id) ?? 0), inFlight: live.get(id) ?? 0 };
  };
  /** The subject as the store would load it at `t`: current accounts and conversations. */
  const load = (id: string, t: number): SubjectState => {
    const s = stateOf(id);
    const def = s.campaign.definition;
    const ids = new Set([...def.emailPool, ...poolOf(def, "sms"), ...s.attempts.map((a) => a.accountId), ...[s.subject.emailSender, s.subject.smsSender].filter((x): x is string => x !== null)]);
    const accounts: Record<string, AccountState> = {};
    for (const a of ids) {
      const v = view(a, t);
      if (v) accounts[a] = v;
    }
    const mobiles = new Set([...s.lead.details.filter((d) => d.channel === "phone").map((d) => d.key), ...s.attempts.map((a) => a.destination)]);
    const smsBindings = [...mobiles].flatMap((m) => bindings.get(m) ?? []);
    return { ...s, accounts, smsBindings };
  };

  const dirty = new Set<string>(states.keys());
  const wakes = new Wakes();
  /** Writes a subject's change, as the store does: the ledger, the slot it took, the conversation it bound. */
  const write = (id: string, loaded: SubjectState, next: SubjectState) => {
    if (next === loaded) return false;
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

  // Work already with a provider is taken as sent at the projection's instant.
  let observed: { id: string; key: string; at: number; ref: string }[] = [];
  for (const s of states.values()) for (const a of s.attempts) if (a.state === "handed" || a.state === "accepted") observed.push({ id: s.subject.id, key: a.idempotencyKey, at: now, ref: `held-${a.idempotencyKey}` });

  for (const s of launched) {
    const loaded = load(s.subject.id, now);
    write(s.subject.id, loaded, rules.evaluate(rules.enterMain(loaded, now), now));
  }

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

      // Claims (4.2), every ready item in priority order (4.3), as `claimAll`.
      const items = sortedItems();
      // The accounts that could take a claim now, kept current as claims are written.
      const isFree = (a: string) => {
        const v = view(a, t);
        return v !== undefined && accountAvailable(v, t) && accountHasRoom(v);
      };
      const free = new Set(accountIds.filter(isFree));
      for (const item of items) {
        if (free.size === 0) break;
        const s = stateOf(item.subjectId);
        if (!ready.get(item.subjectId)?.items.includes(item)) continue;
        // Skipped only where the engine's own checks would refuse it with no write: no account
        // could take it now, or its window is closed (`claimRefusal`).
        const channel = channelOf(s, item.trackId) ?? "email";
        const fixed = senderOf(s, channel);
        const candidates = fixed !== null ? [fixed] : poolOf(s.campaign.definition, channel);
        if (!candidates.some((a) => free.has(a) && records.get(a)?.channel === channel)) continue;
        if (!isOpen(windowOf(s, item.trackId), s.lead.zone, t)) continue;
        const loaded = load(item.subjectId, t);
        if (rules.claimRefusal(loaded, item, t) !== null) continue;
        const account = rules.chooseAccount(loaded, t, item.stepId);
        if (!account) continue;
        write(item.subjectId, loaded, rules.claim(loaded, item, account, { attemptId: `projected-${++attemptSeq}`, retryable: false, notSentIsFinal: false, now: t }));
        if (!isFree(account.id)) free.delete(account.id);
        changed = true;
      }
      // A subject's claim is written into `dirty`; its cached items are stale now.
      for (const id of dirty) dropReady(id);

      // Handovers (5.5), per account in id order, each account's claims by `handoverOrder`.
      for (const accountId of accountIds) {
        const skipped = new Set<string>();
        for (let i = 0; i < 100; i++) {
          const waiting = [...(claimed.get(accountId) ?? [])].filter(([attemptId]) => !skipped.has(attemptId));
          if (waiting.length === 0) break;
          if (t < (slot.get(accountId) ?? 0)) break;
          const order = waiting.flatMap(([attemptId, id]) => {
            const s = stateOf(id);
            const a = s.attempts.find((x) => x.id === attemptId);
            return a ? [{ attemptId, id, item: { subjectId: id, trackId: a.trackId, stepId: a.stepId, touched: s.subject.touched, dueWall: s.tracks.find((p) => p.trackId === a.trackId)?.dueWall ?? 0 } }] : [];
          });
          order.sort((x, y) => rules.handoverOrder(x.item, y.item));
          const next = order[0];
          if (!next) break;
          // The pre-send check: the fake providers find nothing, so it is fresh and clear.
          let loaded = load(next.id, t);
          write(next.id, loaded, { ...loaded, attempts: loaded.attempts.map((x) => (x.id === next.attemptId ? { ...x, presendCheckedWall: t, presendFoundReply: false } : x)) });
          loaded = load(next.id, t);
          const current = loaded.attempts.find((x) => x.id === next.attemptId);
          const account = current ? loaded.accounts[current.accountId] : undefined;
          if (!current || !account) {
            skipped.add(next.attemptId);
            continue;
          }
          const failed = rules.handoverFailures(loaded, current, account, t);
          if (failed.length === 0) {
            const handed = rules.handOver(loaded, current, account, t);
            write(next.id, loaded, handed);
            const reloaded = load(next.id, t);
            const ref = `projected-ref-${current.idempotencyKey}`;
            write(next.id, reloaded, rules.applyToAttempt(reloaded, current.id, { kind: "call_answer", answer: { kind: "accepted", providerRef: ref }, now: t }, t).state);
            observed.push({ id: next.id, key: current.idempotencyKey, at: t, ref });
            if (oursIds.has(next.id)) {
              const track = loaded.campaign.definition.tracks.find((x) => x.id === current.trackId);
              sends.push({ leadId: next.id, accountId, trackId: current.trackId, stepId: current.stepId, channel: track?.channel ?? "email", step: track ? liveSteps(track).findIndex((x) => x.id === current.stepId) : 0, at: t });
            }
            changed = true;
            continue;
          }
          if (failed.every((f) => f === 16 || f === 18) && failed.includes(18)) {
            skipped.add(next.attemptId);
            continue;
          }
          if (failed.every((f) => f === 16)) break;
          write(next.id, loaded, rules.applyToAttempt(loaded, current.id, { kind: "guard_failed" }, t).state);
          changed = true;
        }
      }
      for (const id of dirty) dropReady(id);
      if (!changed && observed.length === 0) break;
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
      if (a.healthy && a.waitUntil !== null && a.waitUntil < NO_END) candidates.push(a.waitUntil);
      const v = view(id, t);
      if (v && v.used >= v.capacity) candidates.push(startOfLocalDay(localDayNumber(t, a.resetZone) + 1, a.resetZone));
    }
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
  const entered = launched.map((s) => s.subject.id).filter((id) => {
    const s = stateOf(id);
    // A lead no live track can reach ends at launch, with the reason shown elsewhere.
    return !(s.subject.ended === "finished_no_usable_channel" && s.results.length === 0 && (s.subject.endedWall ?? now) <= now);
  });
  const first = new Map<string, number>();
  for (const s of sends) if (!first.has(s.leadId)) first.set(s.leadId, s.at);
  const notStarted = entered.filter((id) => !first.has(id)).length;
  const firsts = [...first.values()];
  return {
    busiestDay: busiest,
    leadsToStart: entered.length,
    daysUntilAllStart: notStarted > 0 || firsts.length === 0 ? null : localDayNumber(Math.max(...firsts), input.zone) - localDayNumber(now, input.zone) + 1,
    notStarted,
    sends,
  };
}
