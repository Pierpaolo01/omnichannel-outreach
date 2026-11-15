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

/**
 * The parts of the instants most recently asked for, by zone: the dispatcher asks the same instant
 * for many leads in a few zones (every window check in one pass). A pure function remembered, so
 * every answer is the one it would compute.
 */
const recentParts = new Map<string, LocalParts>();

function localParts(t: number, zone: string): LocalParts {
  const key = `${t}|${zone}`;
  const known = recentParts.get(key);
  if (known) return known;
  const computed = computeLocalParts(t, zone);
  if (recentParts.size >= 256) recentParts.clear();
  recentParts.set(key, computed);
  return computed;
}

function computeLocalParts(t: number, zone: string): LocalParts {
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

/** A test run's every wait and track delay (ADR 0003 "Ticket 21"): about a minute, whatever the canvas says. */
export const TEST_WAIT_MS = 60_000;

/**
 * The one wait rule (ADR 0003 3.3, "Ticket 21"): the span of a wait of `days` counted from wall instant `w`. For a lead,
 * `span`'s calendar days in its zone; for a test run, no wait stays none and any other is TEST_WAIT_MS.
 */
export function waitSpan(kind: "enrollment" | "test_run", w: number, days: number, zone: string): number {
  switch (kind) {
    case "enrollment":
      return span(w, days, zone);
    case "test_run":
      return days === 0 ? 0 : TEST_WAIT_MS;
    default:
      throw new Error(`a subject kind the wait rule does not know: ${String(kind satisfies never)}`);
  }
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

/** The zone's offset at `t` (local wall clock read as UTC, minus `t`), at the second `t` falls in. */
function offsetAt(t: number, zone: string): number {
  const second = t - (((t % 1000) + 1000) % 1000);
  return localParts(second, zone).asUtc - second;
}

/** Every instant in [from, to) at which the zone's offset changes: the first second of each new offset. */
function offsetChanges(zone: string, from: number, to: number): number[] {
  const out: number[] = [];
  const step = 6 * 3_600_000;
  for (let x = from; x < to; x += step) {
    const y = Math.min(x + step, to);
    const before = offsetAt(x, zone);
    if (before === offsetAt(y, zone)) continue;
    let lo = x;
    let hi = y;
    while (hi - lo > 1000) {
      const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
      if (offsetAt(mid, zone) === before) lo = mid;
      else hi = mid;
    }
    out.push(hi - (((hi % 1000) + 1000) % 1000));
  }
  return out;
}

/** Every instant at which local time in `zone` reads `minute` minutes into local day `day`: none in a gap, two in a repeated hour. */
function localOccurrences(day: number, minute: number, zone: string): number[] {
  const wall = day * DAY + minute * 60_000;
  const offsets = new Set([offsetAt(wall - 2 * DAY, zone), offsetAt(wall - DAY, zone), offsetAt(wall, zone), offsetAt(wall + DAY, zone), offsetAt(wall + 2 * DAY, zone)]);
  return [...offsets].map((o) => wall - o).filter((t) => {
    const p = localParts(t, zone);
    return p.day === day && p.minute === minute;
  });
}

/**
 * The first instant at or after `t` at which `windowOpen` holds, exactly, or null when the window does not open within
 * nine days (ADR 0003 "Reads that say when", council on 178de98, item 6). `windowOpen` can change from closed to open
 * only where local time crosses a rule's start, or where the zone's offset changes (a missing hour can jump into a
 * window, and a repeated hour can return to one): every such instant is a candidate, and the earliest at which the
 * window is open is the answer. So a start that does not exist that night opens at the first instant after the gap, and
 * a start that occurs twice opens at its first occurrence. The reads and the email and text claim guard use this; call
 * listing still uses `nextWindowOpen`, whose instants around a clock change are reported, not changed here.
 */
export function windowOpensAt(rules: readonly WindowRule[], zone: string, t: number): number | null {
  // Beyond any date a zone can name (8.64e15 ms), nothing opens.
  if (!Number.isFinite(t) || Math.abs(t) > 8.64e15 - 10 * DAY) return null;
  if (windowOpen(rules, zone, t)) return t;
  const today = localDayNumber(t, zone);
  const horizon = t + 9 * DAY;
  const candidates = offsetChanges(zone, t, horizon);
  for (let d = -1; d <= 8; d++) {
    const day = today + d;
    const weekday = (((day + 4) % 7) + 7) % 7;
    for (const r of rules) if (r.day === weekday) candidates.push(...localOccurrences(day, r.start * 60, zone));
  }
  let best: number | null = null;
  for (const c of candidates) if (c >= t && c < horizon && (best === null || c < best) && windowOpen(rules, zone, c)) best = c;
  return best;
}

/** The first instant after `t` outside the window, while it is open at `t`; null when it is closed at `t` (ticket 14b: when a ready call stops being ready). */
export function nextWindowClose(rules: readonly WindowRule[], zone: string, t: number): number | null {
  if (!windowOpen(rules, zone, t)) return null;
  const today = localDayNumber(t, zone);
  let best: number | null = null;
  for (let d = -1; d <= 8; d++) {
    const day = today + d;
    const weekday = (((day + 4) % 7) + 7) % 7;
    for (const r of rules) {
      if (r.day !== weekday) continue;
      const ends = r.start < r.end ? localInstant(day, r.end * 60, zone) : localInstant(day + 1, r.end * 60, zone);
      if (ends > t && !windowOpen(rules, zone, ends) && (best === null || ends < best)) best = ends;
    }
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
