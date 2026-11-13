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
import { comparePriority, type ReadyItem } from "./sequence/dispatch.ts";
import { localDayNumber, nextWindowOpen, resetDayOf, span, startOfLocalDay, windowOpen, type WindowRule } from "./sequence/clock.ts";

export interface ProjectionLead {
  readonly id: string;
  readonly zone: string;
  /** The inbox the lead is already bound to, if any. */
  readonly sender: string | null;
}

export interface ProjectionAccount {
  readonly id: string;
  readonly capacity: number;
  /** Counted or reserved on today's reset day, across every campaign. */
  readonly usedToday: number;
  readonly gapMs: number;
  /** The account's next pacing slot. */
  readonly nextSlotAt: number;
  readonly resetZone: string;
  /** Healthy and not waiting on a quota or rate limit. */
  readonly available: boolean;
}

export interface ProjectionInput {
  readonly start: number;
  readonly window: readonly WindowRule[];
  /** The wait in days before each live step; the first is 0. */
  readonly waits: readonly number[];
  /** Leads the track would send to: those with a good email. */
  readonly leads: readonly ProjectionLead[];
  readonly accounts: readonly ProjectionAccount[];
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
  const { waits, window } = input;
  const accounts = input.accounts.filter((a) => a.available).sort((a, b) => (a.id < b.id ? -1 : 1));
  const runs: LeadRun[] = input.leads.map((lead) => ({ lead, sender: lead.sender, next: 0, dueWall: input.start, claimed: false }));
  const sentOn = new Map<string, number>();
  const slot = new Map(accounts.map((a) => [a.id, a.nextSlotAt]));
  const claims = new Map<string, Claim>();
  const today = new Map(accounts.map((a) => [a.id, resetDayOf(input.start, a.resetZone)]));
  const sends: ProjectedSend[] = [];
  const end = input.start + input.horizonDays * 86_400_000;

  // Sends counted on the reset day, plus an open claim's reservation (4.2 step 3).
  const used = (a: ProjectionAccount, at: number) => {
    const day = resetDayOf(at, a.resetZone);
    return (sentOn.get(`${a.id}/${day}`) ?? 0) + (day === today.get(a.id) ? a.usedToday : 0) + (claims.has(a.id) ? 1 : 0);
  };
  const slotOf = (a: ProjectionAccount) => slot.get(a.id) ?? 0;

  let t = input.start;
  for (let guard = 0; guard < 1_000_000 && t <= end && waits.length > 0; guard++) {
    if (runs.every((r) => r.next >= waits.length)) break;
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
      const ready = runs
        .filter((r) => !r.claimed && r.next < waits.length && r.dueWall <= t && windowOpen(window, r.lead.zone, t))
        .map((run): ReadyItem & { run: LeadRun } => ({ subjectId: run.lead.id, trackId: "t", stepId: String(run.next).padStart(4, "0"), touched: run.next > 0 || run.sender !== null, dueWall: run.dueWall, run }))
        .sort(comparePriority);
      for (const item of ready) {
        // `chooseAccount`: the fixed sender, or the pool's account that can send soonest, then
        // the one with most remaining capacity, then the lowest id.
        const account = accounts
          .filter((a) => (item.run.sender === null || a.id === item.run.sender) && !claims.has(a.id) && used(a, t) < a.capacity)
          .sort((a, b) => Math.max(slotOf(a), t) - Math.max(slotOf(b), t) || b.capacity - used(b, t) - (a.capacity - used(a, t)) || (a.id < b.id ? -1 : 1))[0];
        if (!account) continue;
        claims.set(account.id, { run: item.run, at: t });
        item.run.claimed = true;
        changed = true;
      }
      // The handover (5.5) at the account's slot, re-checking the window at that instant.
      for (const account of accounts) {
        const c = claims.get(account.id);
        if (!c || slotOf(account) > t) continue;
        claims.delete(account.id);
        c.run.claimed = false;
        changed = true;
        if (!windowOpen(window, c.run.lead.zone, t)) continue;
        slot.set(account.id, t + account.gapMs);
        const key = `${account.id}/${resetDayOf(t, account.resetZone)}`;
        sentOn.set(key, (sentOn.get(key) ?? 0) + 1);
        const run = c.run;
        sends.push({ leadId: run.lead.id, accountId: account.id, step: run.next, at: t });
        run.sender = account.id;
        run.next++;
        if (run.next < waits.length) run.dueWall = t + span(t, waits[run.next] ?? 0, run.lead.zone);
      }
      if (!changed) break;
    }

    // The next instant anything can change: a due time, a window opening, a claim's slot or its
    // expiry, or a full inbox's capacity reset.
    const candidates: number[] = [];
    for (const r of runs) {
      if (r.next >= waits.length || r.claimed) continue;
      if (r.dueWall > t) candidates.push(r.dueWall);
      else if (!windowOpen(window, r.lead.zone, t)) {
        const opens = nextWindowOpen(window, r.lead.zone, t);
        if (opens !== null) candidates.push(opens);
      }
    }
    for (const a of accounts) {
      const c = claims.get(a.id);
      if (c) candidates.push(slotOf(a), c.at + ENGINE_PARAMS.SETTLING);
      if (used(a, t) >= a.capacity) candidates.push(startOfLocalDay(localDayNumber(t, a.resetZone) + 1, a.resetZone));
    }
    const next = Math.min(...candidates.filter((c) => c > t));
    if (!Number.isFinite(next)) break;
    t = next;
  }

  const busiest = new Map(input.accounts.map((a) => [a.id, 0]));
  for (const [key, count] of sentOn) {
    const id = key.slice(0, key.lastIndexOf("/"));
    busiest.set(id, Math.max(busiest.get(id) ?? 0, count));
  }
  const firsts = sends.filter((x) => x.step === 0).map((x) => x.at);
  const notStarted = runs.filter((r) => r.next === 0).length;
  return {
    busiestDay: busiest,
    daysUntilAllStart: notStarted > 0 || firsts.length === 0 ? null : localDayNumber(Math.max(...firsts), input.zone) - localDayNumber(input.start, input.zone) + 1,
    notStarted,
    sends,
  };
}
