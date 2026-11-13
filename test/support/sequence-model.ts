/**
 * The independent record for the generated sequence test (ADR 0003 9.2 step 3). It imports nothing
 * from src/domain/sequence/: it is written from the spec's words, with its own calendar
 * arithmetic, windows, merge fields and priority, and it reads send times from the fake
 * provider's delivery log rather than from the application.
 */

const DAY = 86_400_000;
const formats = new Map<string, Intl.DateTimeFormat>();

function fmt(zone: string): Intl.DateTimeFormat {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
    formats.set(zone, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Local calendar date (as a day count), weekday and minute of day of instant `t` in `zone`. */
export function local(t: number, zone: string): { day: number; weekday: number; minute: number } {
  const p: Record<string, string> = {};
  for (const part of fmt(zone).formatToParts(t)) p[part.type] = part.value;
  const day = Date.UTC(Number(p["year"]), Number(p["month"]) - 1, Number(p["day"])) / DAY;
  return { day, weekday: WEEKDAYS[p["weekday"] ?? "Sun"] ?? 0, minute: Number(p["hour"]) * 60 + Number(p["minute"]) };
}

export function validZone(zone: string): boolean {
  try {
    fmt(zone);
    return true;
  } catch {
    return false;
  }
}

/** The spec: the lead's zone, else the company's, else the campaign default. */
export function zoneOf(personZone: string, companyZone: string, campaignDefault: string): string {
  for (const z of [personZone, companyZone]) if (z && validZone(z)) return z;
  return campaignDefault;
}

/** The first instant whose local date is `day` or later. */
export function startOfDay(day: number, zone: string): number {
  let lo = day * DAY - 16 * 3_600_000;
  let hi = day * DAY + 16 * 3_600_000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (local(mid, zone).day >= day) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** "Waits are counted in days": due at the start of the prospect's local day `days` after `t`; 0 is due at once. */
export function dueAfter(t: number, days: number, zone: string): number {
  return days === 0 ? t : startOfDay(local(t, zone).day + days, zone);
}

export interface Hours {
  readonly day: number;
  readonly start: number;
  readonly end: number;
}

/** Inside a sending window; an end before the start runs past midnight. */
export function inWindow(hours: readonly Hours[], zone: string, t: number): boolean {
  const { weekday, minute } = local(t, zone);
  return hours.some((h) =>
    h.start < h.end
      ? weekday === h.day && minute >= h.start * 60 && minute < h.end * 60
      : (weekday === h.day && minute >= h.start * 60) || (weekday === (h.day + 1) % 7 && minute < h.end * 60),
  );
}

/** The earliest instant at or after `t` inside the window, scanning quarter hours. */
export function firstOpen(hours: readonly Hours[], zone: string, t: number): number {
  if (inWindow(hours, zone, t)) return t;
  const q = 15 * 60_000;
  for (let s = Math.ceil(t / q) * q; s < t + 9 * DAY; s += q) if (inWindow(hours, zone, s)) return s;
  return Infinity;
}

/** Merge fields as the user writes them: {{field}} or {{field|fallback}}. Null when a field without fallback is missing. */
export function renderCopy(text: string, data: Readonly<Record<string, string>>): string | null {
  let missing = false;
  const out = text.replace(/\{\{\s*([^}|]*?)\s*(?:\|([^}]*))?\}\}/g, (_m, field: string, fallback: string | undefined) => {
    const v = (data[field.trim()] ?? "").trim();
    if (v) return v;
    if (fallback !== undefined) return fallback;
    missing = true;
    return "";
  });
  return missing ? null : out;
}

/** "Follow-ups go before first messages to new leads, oldest due first", then a fixed tie-break. */
export function higherPriority(
  a: { touched: boolean; dueWall: number; subjectId: string; stepId: string },
  b: { touched: boolean; dueWall: number; subjectId: string; stepId: string },
): boolean {
  if (a.touched !== b.touched) return a.touched;
  if (a.dueWall !== b.dueWall) return a.dueWall < b.dueWall;
  if (a.subjectId !== b.subjectId) return a.subjectId < b.subjectId;
  return a.stepId < b.stepId;
}

/**
 * Lead time of wall instant `t` for a lead that ran from `runStart` and was frozen from
 * `frozenFrom` on (its ending), with a send inside the freeze counted at the freeze's start.
 */
export function leadTimeOf(t: number, runStart: number, frozenFrom: number | null): { at: number; wall: number } {
  const wall = frozenFrom !== null && t >= frozenFrom ? frozenFrom : t;
  return { at: wall - runStart, wall };
}
