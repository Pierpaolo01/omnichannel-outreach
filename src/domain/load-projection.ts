/**
 * The Before launch tab's projected daily load per sender inbox, and about how long until every
 * lead has started (spec "Before launch"; ADR 0003 section 10, 12c). A dry run, with no provider
 * and no writes, of the rules sending uses: a step is due a whole number of calendar days after
 * the previous send in the prospect's zone (`span`), it goes only while its window is open there
 * (`windowOpen`), follow-ups go before first emails and the oldest due first (`comparePriority`),
 * an inbox takes at most its daily capacity on its reset day and one send per pacing gap, and a
 * lead keeps the inbox its first email went from. A lead's first inbox is chosen like the claim
 * does, by most remaining capacity, then the lowest id.
 *
 * It is an estimate made at one instant: other campaigns' sends are counted only for today, what
 * they will send on later days is not, and every send is assumed to succeed.
 */
import { comparePriority, type ReadyItem } from "./sequence/dispatch.ts";
import { localDayNumber, resetDayOf, span, windowOpen, type WindowRule } from "./sequence/clock.ts";

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

export interface Projection {
  /** The most this campaign sends from each inbox on one of its reset days. */
  readonly busiestDay: ReadonlyMap<string, number>;
  /** Launch day is day 1. Null when some lead does not start within the horizon. */
  readonly daysUntilAllStart: number | null;
  readonly notStarted: number;
}

const TICK = 15 * 60_000;

interface LeadRun {
  readonly lead: ProjectionLead;
  sender: string | null;
  /** Index of the next step, or `waits.length` when done. */
  next: number;
  dueWall: number;
}

export function projectLoad(input: ProjectionInput): Projection {
  const { waits, window } = input;
  const accounts = input.accounts.filter((a) => a.available);
  const runs: LeadRun[] = input.leads.map((lead) => ({ lead, sender: lead.sender, next: 0, dueWall: input.start }));
  const busiest = new Map(input.accounts.map((a) => [a.id, 0]));
  const sentOn = new Map<string, number>();
  const slot = new Map(accounts.map((a) => [a.id, input.start]));
  const today = new Map(accounts.map((a) => [a.id, resetDayOf(input.start, a.resetZone)]));
  let lastFirst: number | null = null;
  const end = input.start + input.horizonDays * 86_400_000;

  const remaining = (a: ProjectionAccount, at: number) => {
    const day = resetDayOf(at, a.resetZone);
    const thisCampaign = sentOn.get(`${a.id}/${day}`) ?? 0;
    return a.capacity - thisCampaign - (day === today.get(a.id) ? a.usedToday : 0);
  };

  for (let t = input.start; t < end && waits.length > 0; t += TICK) {
    const open = new Map<string, boolean>();
    const isOpen = (zone: string) => {
      let v = open.get(zone);
      if (v === undefined) open.set(zone, (v = windowOpen(window, zone, t)));
      return v;
    };
    const ready: (ReadyItem & { run: LeadRun })[] = [];
    let pending = 0;
    for (const run of runs) {
      if (run.next >= waits.length) continue;
      pending++;
      if (run.dueWall <= t && isOpen(run.lead.zone)) {
        ready.push({ subjectId: run.lead.id, trackId: "t", stepId: String(run.next).padStart(4, "0"), touched: run.next > 0, dueWall: run.dueWall, run });
      }
    }
    if (pending === 0) break;
    ready.sort(comparePriority);
    for (const item of ready) {
      const candidates = accounts.filter((a) => (item.run.sender === null || a.id === item.run.sender) && (slot.get(a.id) ?? 0) < t + TICK && remaining(a, Math.max(t, slot.get(a.id) ?? 0)) > 0);
      const account = candidates.sort((a, b) => remaining(b, t) - remaining(a, t) || (a.id < b.id ? -1 : 1))[0];
      if (!account) continue;
      const at = Math.max(t, slot.get(account.id) ?? 0);
      slot.set(account.id, at + account.gapMs);
      const key = `${account.id}/${resetDayOf(at, account.resetZone)}`;
      const count = (sentOn.get(key) ?? 0) + 1;
      sentOn.set(key, count);
      busiest.set(account.id, Math.max(busiest.get(account.id) ?? 0, count));
      const run = item.run;
      if (run.next === 0) lastFirst = Math.max(lastFirst ?? at, at);
      run.sender = account.id;
      run.next++;
      if (run.next < waits.length) run.dueWall = at + span(at, waits[run.next] ?? 0, run.lead.zone);
    }
  }

  const notStarted = runs.filter((r) => r.next === 0).length;
  return {
    busiestDay: busiest,
    daysUntilAllStart: notStarted > 0 || lastFirst === null ? null : localDayNumber(lastFirst, input.zone) - localDayNumber(input.start, input.zone) + 1,
    notStarted,
  };
}
