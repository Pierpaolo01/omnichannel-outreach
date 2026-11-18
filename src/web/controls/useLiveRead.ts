import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiRequestError, getJson } from "../api.ts";
import { REFRESH_INTERVAL_MS, Refresher, type Freshness } from "../calls/refresher.ts";
import { isControlKey } from "./requests.ts";

export type LiveRead<T> =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string; readonly notFound: boolean }
  /** `reads`: how many reads have succeeded, so a part of the page read separately can follow this one. */
  | { readonly state: "ready"; readonly data: T; readonly freshness: Freshness; readonly reads: number; readonly issued: number };

/**
 * One server read a page shows and acts on, on the one reader Today and Calls use (`Refresher`; ADR 0003 4.4.1): reads
 * run one at a time, so an older answer never lands after a newer one. It reads on opening, every `REFRESH_INTERVAL_MS`
 * while visible, on focus, on coming back online, on another tab's control (a storage event), and whenever the page asks,
 * as after a control's answer. A failed read keeps what is shown; a first read that fails is an error.
 */
/**
 * `issue`, when given, numbers each read as it is sent (`issued` on the ready state), from a counter the page also numbers
 * its own answers with, so the page can tell a read sent after an answer from one sent before it (ticket 21).
 */
export function useLiveRead<T>(path: string, issue?: () => number): { read: LiveRead<T>; refresh: () => Promise<void> } {
  const [read, setRead] = useState<{ path: string; value: LiveRead<T> } | null>(null);
  const refresher = useMemo(() => {
    type Issued = { data: T; issued: number; asOf?: string; nextChangeAt?: string | null };
    const r: Refresher<Issued> = new Refresher<Issued>({
      read: () => {
        const issued = issue?.() ?? 0;
        // The server's own instant and hint stay on the wrapper the reader sees (ticket 22: without them a page whose reads
        // keep failing could not say when what it shows was read, and the reader lost the server's `nextChangeAt`).
        return (getJson(path) as Promise<T>).then((data) => {
          const timed = data as { asOf?: unknown; nextChangeAt?: unknown };
          return {
            data,
            issued,
            ...(typeof timed.asOf === "string" ? { asOf: timed.asOf } : {}),
            ...(typeof timed.nextChangeAt === "string" || timed.nextChangeAt === null ? { nextChangeAt: timed.nextChangeAt } : {}),
          };
        });
      },
      onRead: ({ data, issued }): void => setRead((prev) => ({ path, value: { state: "ready", data, issued, freshness: r.freshness(), reads: (prev?.path === path && prev.value.state === "ready" ? prev.value.reads : 0) + 1 } })),
      onFailure: (error, freshness) =>
        setRead((prev) =>
          prev?.path === path && prev.value.state === "ready"
            ? { path, value: { ...prev.value, freshness } }
            : { path, value: { state: "error", message: error instanceof Error ? error.message : "The request failed.", notFound: error instanceof ApiRequestError && error.status === 404 } },
        ),
      setTimer: (fire, ms) => {
        const t = setTimeout(fire, ms);
        return () => clearTimeout(t);
      },
      interval: REFRESH_INTERVAL_MS,
    });
    return r;
    // `issue` is read when a read is sent; a page passes a stable function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    refresher.start();
    void refresher.now();
    const now = () => void refresher.now();
    const onVisible = () => refresher.setVisible(document.visibilityState === "visible");
    const onStorage = (e: StorageEvent) => {
      if (isControlKey(e.key)) now();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", now);
    window.addEventListener("online", now);
    window.addEventListener("storage", onStorage);
    return () => {
      refresher.stop();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", now);
      window.removeEventListener("online", now);
      window.removeEventListener("storage", onStorage);
    };
  }, [refresher]);

  const refresh = useCallback(() => refresher.now(), [refresher]);
  return { read: read?.path === path ? read.value : { state: "loading" }, refresh };
}
