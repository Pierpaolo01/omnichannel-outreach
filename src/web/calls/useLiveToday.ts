import { useEffect, useRef, useState } from "react";
import type { NeedsAttention, TodayView } from "../../shared/api.ts";
import { getJson } from "../api.ts";

/** After the server's `nextChangeAt`, how long to wait for its own tick before reading again. */
const AFTER_CHANGE_MS = 1_500;

/** One read that keeps what it last showed while it reads again; an error shows only when there is nothing to show. */
export type Live<T> = { readonly data: T | null; readonly error: string | null };

/**
 * Today's reads (ADR 0003 4.4.1, "whatever the server decides by the clock is refreshed when it can
 * change"): the call counts and Up next, and Needs attention, read together on opening, at the
 * server's `nextChangeAt` (measured from its `asOf`), and when the page is shown again or the window
 * regains focus. Nothing is computed here; the server says what changed.
 */
export function useLiveToday(): { today: Live<TodayView>; attention: Live<NeedsAttention>; retry: () => void } {
  const [today, setToday] = useState<Live<TodayView>>({ data: null, error: null });
  const [attention, setAttention] = useState<Live<NeedsAttention>>({ data: null, error: null });
  const readNow = useRef<() => void>(() => undefined);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async (): Promise<void> => {
      const [t, a] = await Promise.allSettled([getJson("/api/today") as Promise<TodayView>, getJson("/api/needs-attention") as Promise<NeedsAttention>]);
      if (!alive) return;
      setToday((prev) => (t.status === "fulfilled" ? { data: t.value, error: null } : { data: prev.data, error: messageOf(t.reason) }));
      setAttention((prev) => (a.status === "fulfilled" ? { data: a.value, error: null } : { data: prev.data, error: messageOf(a.reason) }));
      if (timer) clearTimeout(timer);
      timer = null;
      if (t.status === "fulfilled" && t.value.nextChangeAt !== null) {
        const ms = Math.max(0, Date.parse(t.value.nextChangeAt) - Date.parse(t.value.asOf)) + AFTER_CHANGE_MS;
        timer = setTimeout(() => void read(), ms);
      }
    };
    readNow.current = () => void read();
    void read();
    const onVisible = () => {
      if (document.visibilityState === "visible") void read();
    };
    const onFocus = () => void read();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return { today, attention, retry: () => readNow.current() };
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : "The request failed.");
