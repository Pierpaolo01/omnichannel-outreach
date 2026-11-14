import { useEffect, useState } from "react";
import type { NeedsAttention, TodayView } from "../../shared/api.ts";
import { getJson } from "../api.ts";
import { FRESH, Refresher, type Freshness } from "./refresher.ts";

export interface LiveToday {
  /** Today's calls and Needs attention, read together, as of the last successful read. */
  readonly data: { readonly today: TodayView; readonly attention: NeedsAttention } | null;
  /** The first read failed and there is nothing to show yet. */
  readonly error: string | null;
  readonly freshness: Freshness;
  readonly retry: () => void;
}

/**
 * Today's reads on the one freshness mechanism Calls uses too (refresher.ts; ADR 0003 4.4.1,
 * "Freshness"): read on opening, at the server's `nextChangeAt`, on showing the tab or focusing the
 * window, on coming back online and on another window's calls action (a storage event); a failed read
 * keeps what shows, is retried with backoff, and after two in a row the page says it may be out of date.
 */
export function useLiveToday(): LiveToday {
  const [state, setState] = useState<Omit<LiveToday, "retry">>({ data: null, error: null, freshness: FRESH });
  const [refresher] = useState(
    () =>
      new Refresher<TodayView & { readonly attention: NeedsAttention }>({
        read: async (expected) => {
          const [today, attention] = await Promise.all([
            getJson(`/api/today${expected ? `?expected=${encodeURIComponent(expected)}` : ""}`) as Promise<TodayView>,
            getJson("/api/needs-attention") as Promise<NeedsAttention>,
          ]);
          return { ...today, attention };
        },
        onRead: ({ attention, ...today }) => setState({ data: { today, attention }, error: null, freshness: { failures: 0, lastReadAt: today.asOf, stale: false } }),
        onFailure: (error, freshness) => setState((prev) => ({ ...prev, error: prev.data === null ? (error instanceof Error ? error.message : "The request failed.") : null, freshness })),
        setTimer: (fire, ms) => {
          const t = setTimeout(fire, ms);
          return () => clearTimeout(t);
        },
      }),
  );

  useEffect(() => {
    refresher.start();
    void refresher.now();
    const read = () => void refresher.now();
    const onVisible = () => {
      if (document.visibilityState === "visible") read();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key?.startsWith("outreach.calls.")) read();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", read);
    window.addEventListener("online", read);
    window.addEventListener("storage", onStorage);
    return () => {
      refresher.stop();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", read);
      window.removeEventListener("online", read);
      window.removeEventListener("storage", onStorage);
    };
  }, [refresher]);

  return { ...state, retry: () => void refresher.now() };
}
