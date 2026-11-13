/**
 * The Before launch tab's projected daily load per sender inbox, and about how long until every
 * lead has started (spec "Before launch"; ADR 0003 section 10, 12c). A dry run, with no provider
 * and no writes, of the rules sending uses, evaluated at each exact instant a send could happen:
 *
 * - a step is due a whole number of calendar days after the previous send, in the prospect's zone
 *   (`span`, 3.3);
 * - it is sent only at an instant its window is open in that zone (`windowOpen`, the claim's step
 *   guard and the handover's predicate 8), so work the window closes on waits for its next
 *   opening (`nextWindowOpen`);
 * - follow-ups go before first emails, oldest due first (`comparePriority`, 4.3);
 * - an inbox sends at most its daily capacity on its reset day (`resetDayOf`, 4.1), counting what
 *   other campaigns used today, and at most one send per pacing gap: a send at instant t moves its
 *   slot to t + gap (4.2);
 * - a lead keeps the inbox its first email went from; a first inbox is the one that can send
 *   soonest, then with most remaining capacity, then the lowest id (`chooseAccount`).
 *
 * At each instant it runs the engine's passes until nothing changes: claims older than the
 * settling time expire, ready steps are claimed (one claim per inbox at a time, k = 1, which binds
 * a step to the inbox that can send it soonest), and each claim is handed over when its inbox's
 * slot comes, if the window is still open then. Time moves from one instant to the next at which
 * something can change: a slot, a claim's expiry, a due time, a window opening or a capacity reset. src/server/before-launch-projection.test.ts compares it with
 * the engine's actual sends over the fake provider for generated cases.
 *
 * It is an estimate made at one instant: what other campaigns send after today is not counted,
 * and every send is assumed to succeed at once.
 */
import { ENGINE_PARAMS } from "./sequence/attempt.ts";
import { accountAvailable, accountHasRoom, comparePriority, pickAccount, type ReadyItem } from "./sequence/dispatch.ts";
import type { AccountState } from "./sequence/state.ts";
import { localDayNumber, nextWindowOpen, resetDayOf, span, startOfLocalDay, windowOpen, type WindowRule } from "./sequence/clock.ts";

export interface ProjectionLead {
  readonly id: string;
  readonly zone: string;
  /** The inbox the lead is already bound to, if any. */
  readonly sender: string | null;
}

/**
 * The inboxes are the engine's own account records (`AccountState`, as `EngineStore.accounts`
 * returns them), unchanged: health, waits (a rate limit's end, or a quota hold with none),
 * capacity, today's count with reservations, the in-flight bound, the pacing gap and slot, and the
 * reset zone. Every decision about one is the engine's function on a record carrying the
 * simulation's count, slot and claim: `accountAvailable`, `accountHasRoom`, `pickAccount`.
 */
export type ProjectionAccount = AccountState;

/**
 * Waiting work of another running campaign on the same inboxes (PR 41 re-check, B10): capacity is
 * per inbox across every campaign, so this competes with the campaign being projected under the
 * same rules. Its sends are simulated but not counted in this campaign's figures.
 */
export interface OtherLead extends ProjectionLead {
  readonly window: readonly WindowRule[];
  /** The wait in days before each live step of its email track; the first is 0. */
  readonly waits: readonly number[];
  /** Index of its pending step. */
  readonly next: number;
  /** The wall instant the pending step is due. */
  readonly dueWall: number;
  /** The subject's stored `touched` (4.3): sent to already, so its steps are follow-ups. A fixed sender alone is not touched. */
  readonly touched: boolean;
  /** Its campaign's email pool. */
  readonly pool: readonly string[];
  /** A claim it already holds on an inbox, waiting for that inbox's slot. */
  readonly claim: { readonly accountId: string; readonly at: number } | null;
}

export interface ProjectionInput {
  readonly start: number;
  readonly window: readonly WindowRule[];
  /** The wait in days before each live step; the first is 0. */
  readonly waits: readonly number[];
  /** Leads the track would send to: those with a good email. */
  readonly leads: readonly ProjectionLead[];
  /** The campaign's email pool. */
  readonly pool: readonly string[];
  /** Every inbox in this pool and in the pools of `others`. */
  readonly accounts: readonly AccountState[];
  /** Waiting work of the other running campaigns that share an inbox with this one. */
  readonly others?: readonly OtherLead[];
  /** The zone days are counted in for "days until all start": the campaign's default zone. */
  readonly zone: string;
  readonly horizonDays: number;
}

export interface ProjectedSend {
  readonly leadId: string;
  readonly accountId: string;
  /** Index of the live step. */
  readonly step: number;
  readonly at: number;
}

export interface Projection {
  /** The most this campaign sends from each inbox on one of its reset days. */
  readonly busiestDay: ReadonlyMap<string, number>;
  /** Launch day is day 1. Null when some lead does not start within the horizon. */
  readonly daysUntilAllStart: number | null;
  readonly notStarted: number;
  /** Every projected send, in order. */
  readonly sends: readonly ProjectedSend[];
}

interface LeadRun {
  readonly lead: ProjectionLead;
  /** Of the campaign being projected, rather than another's waiting work. */
  readonly ours: boolean;
  readonly window: readonly WindowRule[];
  readonly waits: readonly number[];
  readonly pool: readonly string[];
  readonly touched: boolean;
  sender: string | null;
  /** Index of the next step, or `waits.length` when done. */
  next: number;
  dueWall: number;
  claimed: boolean;
}

interface Claim {
  readonly run: LeadRun;
  readonly at: number;
}

export function projectLoad(input: ProjectionInput): Projection {
  const accounts = [...input.accounts].sort((a, b) => (a.id < b.id ? -1 : 1));
  const runs: LeadRun[] = [
    ...input.leads.map((lead): LeadRun => ({ lead, ours: true, window: input.window, waits: input.waits, pool: input.pool, touched: false, sender: lead.sender, next: 0, dueWall: input.start, claimed: false })),
    ...(input.others ?? []).map((o): LeadRun => ({ lead: o, ours: false, window: o.window, waits: o.waits, pool: o.pool, touched: o.touched, sender: o.sender, next: o.next, dueWall: o.dueWall, claimed: o.claim !== null })),
  ];
  const ours = runs.filter((r) => r.ours);
  const sentOn = new Map<string, number>();
  const oursOn = new Map<string, number>();
  const slot = new Map(accounts.map((a) => [a.id, a.nextSlotAt]));
  const claims = new Map<string, Claim>();
  for (const o of input.others ?? []) {
    const run = runs.find((r) => !r.ours && r.lead.id === o.id);
    if (o.claim && run) claims.set(o.claim.accountId, { run, at: o.claim.at });
  }
  const today = new Map(accounts.map((a) => [a.id, resetDayOf(input.start, a.resetZone)]));
  // The record's count includes the reservations of claims already held; the simulation holds
  // those claims itself, so they are taken out of the starting count once.
  const heldClaims = (id: string) => (input.others ?? []).filter((o) => o.claim?.accountId === id).length;
  const startUsed = new Map(accounts.map((a) => [a.id, a.used - heldClaims(a.id)]));
  const sends: ProjectedSend[] = [];
  const end = input.start + input.horizonDays * 86_400_000;

  // The calendar and window answers repeat for every lead at an instant: computed once per
  // instant, window and zone (they are the engine's own functions, only remembered).
  const windowIds = new Map<readonly WindowRule[], number>();
  const windowKey = (w: readonly WindowRule[], zone: string) => {
    let id = windowIds.get(w);
    if (id === undefined) windowIds.set(w, (id = windowIds.size));
    return `${id}|${zone}`;
  };
  let memoAt = Number.NaN;
  const openMemo = new Map<string, boolean>();
  const nextOpenMemo = new Map<string, number | null>();
  const dayMemo = new Map<string, string>();
  const atInstant = (at: number) => {
    if (at !== memoAt) {
      memoAt = at;
      openMemo.clear();
      nextOpenMemo.clear();
      dayMemo.clear();
    }
  };
  const isOpen = (w: readonly WindowRule[], zone: string, at: number) => {
    atInstant(at);
    const key = windowKey(w, zone);
    let v = openMemo.get(key);
    if (v === undefined) openMemo.set(key, (v = windowOpen(w, zone, at)));
    return v;
  };
  const opensNext = (w: readonly WindowRule[], zone: string, at: number) => {
    atInstant(at);
    const key = windowKey(w, zone);
    if (!nextOpenMemo.has(key)) nextOpenMemo.set(key, nextWindowOpen(w, zone, at));
    return nextOpenMemo.get(key) ?? null;
  };
  const resetDay = (a: ProjectionAccount, at: number) => {
    atInstant(at);
    let d = dayMemo.get(a.id);
    if (d === undefined) dayMemo.set(a.id, (d = resetDayOf(at, a.resetZone)));
    return d;
  };

  // Sends counted on the reset day, plus an open claim's reservation (4.2 step 3).
  const used = (a: ProjectionAccount, at: number) => {
    const day = resetDay(a, at);
    return (sentOn.get(`${a.id}/${day}`) ?? 0) + (day === today.get(a.id) ? (startUsed.get(a.id) ?? 0) : 0) + (claims.has(a.id) ? 1 : 0);
  };
  const slotOf = (a: ProjectionAccount) => slot.get(a.id) ?? 0;
  /**
   * The account as the engine would see it at `at`: its record, with the simulation's count, slot
   * and claim. A claim is the one attempt in flight (k = 1); work already handed over before the
   * projection is taken as settled at once.
   */
  const asEngineSees = (a: ProjectionAccount, at: number): AccountState => ({ ...a, used: used(a, at), nextSlotAt: slotOf(a), inFlight: claims.has(a.id) ? 1 : 0 });

  let t = input.start;
  // The leads with work left; a finished one is dropped so later scans skip it.
  let active = runs.filter((r) => r.next < r.waits.length);
  for (let guard = 0; guard < 1_000_000 && t <= end && input.waits.length > 0; guard++) {
    active = active.filter((r) => r.next < r.waits.length);
    if (ours.every((r) => r.next >= r.waits.length)) break;
    // The engine's passes at one instant, repeated until nothing changes (2.5): claims expire,
    // ready steps are claimed, and claims whose slot has come are handed over.
    for (let pass = 0; pass < 10_000; pass++) {
      let changed = false;
      for (const [id, c] of claims) {
        if (t - c.at >= ENGINE_PARAMS.SETTLING) {
          claims.delete(id);
          c.run.claimed = false;
          changed = true;
        }
      }
      // The claim (4.2): due, window open, in priority order; at most one claim per inbox (k = 1).
      // Only as many leads as there are free inboxes can claim, so each claim takes the
      // highest-priority ready lead that some free inbox can serve: the order of a full sort.
      for (;;) {
        // The engine's own tests: available now, and room (capacity and the in-flight bound).
        const free = accounts.map((a) => asEngineSees(a, t)).filter((a) => accountAvailable(a, t) && accountHasRoom(a));
        if (free.length === 0) break;
        let best: (ReadyItem & { run: LeadRun }) | null = null;
        for (const run of active) {
          if (run.claimed || run.next >= run.waits.length || run.dueWall > t) continue;
          if (run.sender !== null ? !free.some((a) => a.id === run.sender) : !free.some((a) => run.pool.includes(a.id))) continue;
          if (!isOpen(run.window, run.lead.zone, t)) continue;
          const item = { subjectId: run.lead.id, trackId: "t", stepId: String(run.next).padStart(4, "0"), touched: run.touched || run.next > 0, dueWall: run.dueWall, run };
          if (best === null || comparePriority(item, best) < 0) best = item;
        }
        if (best === null) break;
        const run = best.run;
        // `chooseAccount`: the fixed sender, or the pool's account that can send soonest, then
        // the one with most remaining capacity, then the lowest id.
        const account = pickAccount(free.filter((a) => (run.sender === null ? run.pool.includes(a.id) : a.id === run.sender)), t);
        if (!account) break;
        claims.set(account.id, { run, at: t });
        run.claimed = true;
        changed = true;
      }
      // The handover (5.5) at the account's slot, re-checking the window at that instant.
      for (const account of accounts) {
        const c = claims.get(account.id);
        // The handover waits for the slot, and for the account to be available (predicate 9).
        if (!c || slotOf(account) > t || !accountAvailable(asEngineSees(account, t), t)) continue;
        claims.delete(account.id);
        c.run.claimed = false;
        changed = true;
        if (!isOpen(c.run.window, c.run.lead.zone, t)) continue;
        slot.set(account.id, t + account.gapMs);
        const key = `${account.id}/${resetDay(account, t)}`;
        sentOn.set(key, (sentOn.get(key) ?? 0) + 1);
        const run = c.run;
        if (run.ours) oursOn.set(key, (oursOn.get(key) ?? 0) + 1);
        sends.push({ leadId: run.lead.id, accountId: account.id, step: run.next, at: t });
        run.sender = account.id;
        run.next++;
        if (run.next < run.waits.length) run.dueWall = t + span(t, run.waits[run.next] ?? 0, run.lead.zone);
      }
      if (!changed) break;
    }

    // The next instant anything can change: a due time, a window opening, a claim's slot or its
    // expiry, an inbox's wait ending, or a full inbox's capacity reset.
    const candidates: number[] = [];
    for (const r of active) {
      if (r.next >= r.waits.length || r.claimed) continue;
      if (r.dueWall > t) candidates.push(r.dueWall);
      else if (!isOpen(r.window, r.lead.zone, t)) {
        const opens = opensNext(r.window, r.lead.zone, t);
        if (opens !== null) candidates.push(opens);
      }
    }
    for (const a of accounts) {
      const c = claims.get(a.id);
      if (c) candidates.push(slotOf(a), c.at + ENGINE_PARAMS.SETTLING);
      // A wait with an end (a rate limit); a quota hold has none and never ends here.
      if (a.healthy && a.waitUntil !== null && a.waitUntil > t && Number.isSafeInteger(a.waitUntil) && a.waitUntil < Number.MAX_SAFE_INTEGER) candidates.push(a.waitUntil);
      if (used(a, t) >= a.capacity) candidates.push(startOfLocalDay(localDayNumber(t, a.resetZone) + 1, a.resetZone));
    }
    const next = Math.min(...candidates.filter((c) => c > t));
    if (!Number.isFinite(next)) break;
    t = next;
  }

  const busiest = new Map(input.pool.map((id) => [id, 0]));
  for (const [key, count] of oursOn) {
    const id = key.slice(0, key.lastIndexOf("/"));
    busiest.set(id, Math.max(busiest.get(id) ?? 0, count));
  }
  const oursIds = new Set(ours.map((r) => r.lead.id));
  const firsts = sends.filter((x) => x.step === 0 && oursIds.has(x.leadId)).map((x) => x.at);
  const notStarted = ours.filter((r) => r.next === 0).length;
  return {
    busiestDay: busiest,
    daysUntilAllStart: notStarted > 0 || firsts.length === 0 ? null : localDayNumber(Math.max(...firsts), input.zone) - localDayNumber(input.start, input.zone) + 1,
    notStarted,
    sends,
  };
}
