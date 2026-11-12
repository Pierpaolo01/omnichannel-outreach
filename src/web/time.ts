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

export function clockIn(timeZone: string, at: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}

export function todayHeading(at: Date): string {
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" }).format(at);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  return `${day.replace(",", "")}, ${time}`;
}

export function greeting(at: Date): string {
  const hour = at.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}
