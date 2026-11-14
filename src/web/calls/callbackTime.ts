/**
 * The callback time the user enters (ticket 15b): the day and time the prospect asked for, in the
 * prospect's own zone, as the one instant the engine takes (`callbackAt`, ADR 0003 7.1.1). This module
 * converts what was typed and says what can be said before Log; it decides nothing the server decides.
 * The engine refuses a time not after its own instant: the page compares with the read's instant, its
 * best knowledge of the server's, and shows the server's refusal when the two disagree. Calling hours
 * are read with the engine's own window function (`clock.ts`); a callback is accepted inside or outside
 * them, and on a day they never open (2.3: the prospect chose the time).
 */
import { localDayNumber, nextWindowOpen, startOfLocalDay, windowOpen, type WindowRule } from "../../domain/sequence/clock.ts";

/** How many of the prospect's days the Day select offers, from their today. */
export const CALLBACK_DAYS = 28;

const DAY_MS = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{2}):(\d{2})$/;

/** The local wall clock in `zone` at `t`, read as if it were UTC (minute precision). */
function wallAsUtc(t: number, zone: string): number {
  const parts: Record<string, number> = {};
  const format = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (const p of format.formatToParts(t)) if (p.type !== "literal") parts[p.type] = Number(p.value);
  return Date.UTC(parts["year"] ?? 1970, (parts["month"] ?? 1) - 1, parts["day"] ?? 1, parts["hour"] ?? 0, parts["minute"] ?? 0);
}

/**
 * The instant at which the wall clock in `zone` reads `day` (YYYY-MM-DD) at `time` (HH:MM); the earlier of
 * two when the clocks go back; null when the clocks skip that time, or the input is not a day and a time.
 */
export function zonedInstant(day: string, time: string, zone: string): number | null {
  const d = DATE.exec(day);
  const m = TIME.exec(time);
  if (!d || !m) return null;
  const target = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(m[1]), Number(m[2]));
  if (Number.isNaN(target) || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  // Every offset in use near the target: the instant is the target less one of them, if that instant reads the target there.
  const offsets = new Set([-DAY_MS, 0, DAY_MS].map((shift) => wallAsUtc(target + shift, zone) - (target + shift)));
  const found = [...offsets].map((offset) => target - offset).filter((t) => wallAsUtc(t, zone) === target);
  return found.length === 0 ? null : Math.min(...found);
}

/** "Thu 5 Nov" for a YYYY-MM-DD date. */
export const dayLabel = (date: string): string => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${date}T12:00:00Z`)).replace(",", "");

/** The prospect's days from their today, as of the server's read: "Today, Tue 3 Nov", "Tomorrow, Wed 4 Nov", "Thu 5 Nov". */
export function callbackDays(asOf: string, zone: string, count: number = CALLBACK_DAYS): { value: string; label: string }[] {
  const today = localDayNumber(Date.parse(asOf), zone);
  return Array.from({ length: count }, (_, i) => {
    const value = new Date((today + i) * DAY_MS).toISOString().slice(0, 10);
    return { value, label: i === 0 ? `Today, ${dayLabel(value)}` : i === 1 ? `Tomorrow, ${dayLabel(value)}` : dayLabel(value) };
  });
}

export type CallbackProblem = "missing" | "no_such_time" | "past";

/** The instant entered, or why there is none the server would accept. */
export function callbackChoice(draft: { readonly callbackDay: string | null; readonly callbackTime: string }, view: { readonly zone: string; readonly asOf: string }): { at: number; problem: null } | { at: null; problem: CallbackProblem } {
  if (draft.callbackDay === null || draft.callbackTime === "") return { at: null, problem: "missing" };
  const at = zonedInstant(draft.callbackDay, draft.callbackTime, view.zone);
  if (at === null) return { at: null, problem: "no_such_time" };
  if (at <= Date.parse(view.asOf)) return { at: null, problem: "past" };
  return { at, problem: null };
}

/** Whether the time asked for is inside the prospect's calling hours, outside them, or on a day they never open. Accepted in every case. */
export function callbackAdvice(at: number, view: { readonly zone: string; readonly callingHours: readonly WindowRule[] }): "inside" | "outside" | "closed_day" {
  if (windowOpen(view.callingHours, view.zone, at)) return "inside";
  const day = localDayNumber(at, view.zone);
  const opens = nextWindowOpen(view.callingHours, view.zone, startOfLocalDay(day, view.zone));
  return opens !== null && opens < startOfLocalDay(day + 1, view.zone) ? "outside" : "closed_day";
}

/** The ISO 8601 form with the prospect's offset that the server takes: "2026-11-05T14:30:00+00:00". */
export function isoWithOffset(at: number, zone: string): string {
  const offsetMin = Math.round((wallAsUtc(at, zone) - Math.floor(at / 60_000) * 60_000) / 60_000);
  const wall = new Date(at + offsetMin * 60_000).toISOString().slice(0, 19);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  return `${wall}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}
