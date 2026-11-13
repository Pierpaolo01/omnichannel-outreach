/**
 * Time for the sequence engine (ADR 0003 section 3): lead time, `syncClock`, deadlines resolved
 * once in calendar days of the prospect's zone, sending windows, and the exact mapping of a
 * provider's past send time onto the lead's clock. Every function takes the time as input.
 * Instants are milliseconds since the epoch.
 */

const DAY = 86_400_000;

/** The stored clock of one subject (ADR 0003 1.3). */
export interface LeadClock {
  /** Set while the subject does not run: the wall instant lead time stopped at. */
  readonly frozenSince: number | null;
  /** Wall time subtracted from now to give lead time; includes every closed freeze. */
  readonly frozenTotal: number;
}

/** One frozen interval of a subject; `toWall` is null while it is still frozen. */
export interface Freeze {
  readonly fromWall: number;
  readonly toWall: number | null;
}

export function leadNow(clock: LeadClock, now: number): number {
  return (clock.frozenSince ?? now) - clock.frozenTotal;
}

/** The wall instant at which lead time stood at `leadNow`. */
export function wallOfLead(clock: LeadClock, now: number): number {
  return clock.frozenSince ?? now;
}

/**
 * Ends every transaction that changes whether the subject runs. A subject that runs is never
 * frozen, and one that does not run always is; the freezes record opens and closes with it.
 */
export function syncClock(
  clock: LeadClock,
  freezes: readonly Freeze[],
  runs: boolean,
  now: number,
): { clock: LeadClock; freezes: Freeze[] } {
  if (runs && clock.frozenSince !== null) {
    return {
      clock: { frozenSince: null, frozenTotal: clock.frozenTotal + (now - clock.frozenSince) },
      freezes: freezes.map((f) => (f.toWall === null ? { ...f, toWall: now } : f)),
    };
  }
  if (!runs && clock.frozenSince === null) {
    return { clock: { frozenSince: now, frozenTotal: clock.frozenTotal }, freezes: [...freezes, { fromWall: now, toWall: null }] };
  }
  return { clock, freezes: [...freezes] };
}

/**
 * Where a provider's send at `providerTime` sits on the lead's clock (ADR 0003 3.3): the time is
 * clamped to between the handover and now, then mapped exactly through the recorded freezes.
 * `atWall` is the wall instant at which lead time last stood at `at` while running.
 */
export function sendPoint(
  clock: LeadClock,
  freezes: readonly Freeze[],
  providerTime: number,
  handedWall: number,
  now: number,
): { at: number; atWall: number } {
  const t = Math.min(Math.max(providerTime, handedWall), now);
  let overlap = 0;
  let atWall = t;
  for (const f of freezes) {
    const to = f.toWall ?? now;
    overlap += Math.max(0, Math.min(to, now) - Math.max(f.fromWall, t));
    // An open freeze holds every instant from its start on.
    if (f.fromWall <= t && (f.toWall === null || t < f.toWall)) atWall = f.fromWall;
  }
  return { at: leadNow(clock, now) - (now - t) + overlap, atWall };
}

// ---------------------------------------------------------------------------------------------
// Zones and calendar days.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(zone, f);
  }
  return f;
}

export function isTimeZone(value: string): boolean {
  try {
    formatter(value);
    return true;
  } catch {
    return false;
  }
}

/** The person's zone, else the company's, else the campaign default; invalid names fall through. */
export function prospectZone(candidates: readonly (string | null)[], campaignDefault: string): string {
  return candidates.find((z): z is string => z !== null && isTimeZone(z)) ?? campaignDefault;
}

interface LocalParts {
  /** Days since 1970-01-01 of the local calendar date. */
  readonly day: number;
  /** Minutes since local midnight. */
  readonly minute: number;
  /** 0 = Sunday. */
  readonly weekday: number;
  /** Local wall clock read as if it were UTC, in milliseconds (seconds precision). */
  readonly asUtc: number;
}

function localParts(t: number, zone: string): LocalParts {
  const parts: Record<string, number> = {};
  for (const p of formatter(zone).formatToParts(t)) if (p.type !== "literal") parts[p.type] = Number(p.value);
  const asUtc = Date.UTC(parts["year"] ?? 1970, (parts["month"] ?? 1) - 1, parts["day"] ?? 1, parts["hour"] ?? 0, parts["minute"] ?? 0, parts["second"] ?? 0);
  const day = Math.floor(asUtc / DAY);
  return { day, minute: Math.floor((asUtc - day * DAY) / 60_000), weekday: (((day + 4) % 7) + 7) % 7, asUtc };
}

export function localDayNumber(t: number, zone: string): number {
  return localParts(t, zone).day;
}

/** The wall instant at which local time in `zone` reads `minute` minutes into local day `day`, or the first instant after a gap. */
function localInstant(day: number, minute: number, zone: string): number {
  const target = day * DAY + minute * 60_000;
  let t = target;
  for (let i = 0; i < 3; i++) {
    const offset = localParts(t, zone).asUtc - (t - (((t % 1000) + 1000) % 1000));
    t = target - offset;
  }
  return t;
}

/** The first instant of local day `day` in `zone`. */
export function startOfLocalDay(day: number, zone: string): number {
  const guess = localInstant(day, 0, zone);
  const isStart = (t: number) => localDayNumber(t, zone) >= day && localDayNumber(t - 1, zone) < day;
  if (isStart(guess)) return guess;
  // A day whose midnight does not exist: search for the first instant of it.
  let lo = day * DAY - 30 * 3_600_000;
  let hi = day * DAY + 30 * 3_600_000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localDayNumber(mid, zone) >= day) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * The span of a wait of `days` calendar days counted from wall instant `w` in `zone`: due at the
 * start of the local day `days` after the basis; 0 is due at once (ADR 0003 3.3).
 */
export function span(w: number, days: number, zone: string): number {
  if (days === 0) return 0;
  return startOfLocalDay(localDayNumber(w, zone) + days, zone) - w;
}

// ---------------------------------------------------------------------------------------------
// Sending windows.

/** One day's sending hours, in the prospect's local time. An end before the start runs past midnight. */
export interface WindowRule {
  /** 0 = Sunday ... 6 = Saturday. */
  readonly day: number;
  /** Whole hours, 0-23. */
  readonly start: number;
  /** Whole hours, 0-24. */
  readonly end: number;
}

export function windowOpen(rules: readonly WindowRule[], zone: string, t: number): boolean {
  const { weekday, minute } = localParts(t, zone);
  return rules.some((r) => {
    if (r.start < r.end) return r.day === weekday && minute >= r.start * 60 && minute < r.end * 60;
    return (r.day === weekday && minute >= r.start * 60) || ((r.day + 1) % 7 === weekday && minute < r.end * 60);
  });
}

/** The earliest instant at or after `t` inside the window, or null if the window never opens. */
export function nextWindowOpen(rules: readonly WindowRule[], zone: string, t: number): number | null {
  if (windowOpen(rules, zone, t)) return t;
  const today = localDayNumber(t, zone);
  let best: number | null = null;
  for (let d = 0; d <= 8; d++) {
    const day = today + d;
    const weekday = (((day + 4) % 7) + 7) % 7;
    for (const r of rules) {
      if (r.day !== weekday) continue;
      const opens = localInstant(day, r.start * 60, zone);
      if (opens > t && windowOpen(rules, zone, opens) && (best === null || opens < best)) best = opens;
    }
    if (best !== null) return best;
  }
  return best;
}

/** The calendar date, as YYYY-MM-DD, of instant `t` in `zone`: an account's capacity reset day. */
/**
 * Running time between two observations of a wait: the one definition, in the codebase, of time the
 * application was running and observing (ADR 0003 2.4; ADR 0002 as built, rule 4). A wait advances by
 * the gap since it was last counted, never by more than `maxGapMs`. A longer gap is a suspension, a
 * stall, a slow observation or a forward clock jump, not observation, and a backward jump counts nothing.
 */
export function runningCredit(lastCountedWall: number, now: number, maxGapMs: number): number {
  return Math.min(Math.max(0, now - lastCountedWall), maxGapMs);
}

export function resetDayOf(t: number, zone: string): string {
  return new Date(localDayNumber(t, zone) * DAY).toISOString().slice(0, 10);
}
