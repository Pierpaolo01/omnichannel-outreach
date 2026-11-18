import { useEffect, useState } from "react";

/** The current time, refreshed every 30 seconds. UI only: domain code never reads the clock. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const wallFormats = new Map<string, Intl.DateTimeFormat>();
const wallIn = (zone: string | undefined, t: number): string => {
  const key = zone ?? "";
  let f = wallFormats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { ...(zone ? { timeZone: zone } : {}), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    wallFormats.set(key, f);
  }
  return f.format(t);
};

/**
 * The one way the app prints a time of day: "09:00" in `zone` (the browser's own when none is given), or, when that local
 * time occurs twice on that date in that zone (the hour a clock change repeats), with the zone's abbreviation that tells
 * the two apart, "01:00 GMT" (verifier on cc9bf55, item 11). Every screen that says a time goes through it.
 */
/**
 * The bare local "HH:MM" `clockTime` builds on, with nothing to tell a repeated hour's occurrences apart: only for a
 * sentence that names the occurrence in its own words (a callback's "after the clocks go back").
 */
export function localClock(zone: string | undefined, at: Date | number | string): string {
  const t = typeof at === "string" ? Date.parse(at) : typeof at === "number" ? at : at.getTime();
  return new Intl.DateTimeFormat("en-GB", { ...(zone ? { timeZone: zone } : {}), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t);
}

export function clockTime(zone: string | undefined, at: Date | number | string): string {
  const t = typeof at === "string" ? Date.parse(at) : typeof at === "number" ? at : at.getTime();
  const clock = localClock(zone, t);
  const wall = wallIn(zone, t);
  // A clock change repeats an hour (or half an hour): the same local date and time half an hour or an hour away.
  const repeated = [30, 60].some((m) => wallIn(zone, t - m * 60_000) === wall || wallIn(zone, t + m * 60_000) === wall);
  if (!repeated) return clock;
  const name = new Intl.DateTimeFormat("en-GB", { ...(zone ? { timeZone: zone } : {}), timeZoneName: "short" }).formatToParts(t).find((p) => p.type === "timeZoneName")?.value ?? "";
  return name ? `${clock} ${name}` : clock;
}

export function clockIn(timeZone: string, at: Date): string {
  return clockTime(timeZone, at);
}

export function todayHeading(at: Date): string {
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" }).format(at);
  const time = clockTime(undefined, at);
  return `${day.replace(",", "")}, ${time}`;
}

export function greeting(at: Date): string {
  const hour = at.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}
