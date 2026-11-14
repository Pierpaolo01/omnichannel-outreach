import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiRequestError, getJson } from "../api.ts";
import { REFRESH_INTERVAL_MS, Refresher, type Freshness } from "../calls/refresher.ts";
import { isControlKey } from "./requests.ts";

export type LiveRead<T> =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string; readonly notFound: boolean }
  /** `reads`: how many reads have succeeded, so a part of the page read separately can follow this one. */
  | { readonly state: "ready"; readonly data: T; readonly freshness: Freshness; readonly reads: number };

/**
 * One server read a page shows and acts on, on the one reader Today and Calls use (`Refresher`; ADR 0003 4.4.1): reads
 * run one at a time, so an older answer never lands after a newer one. It reads on opening, every `REFRESH_INTERVAL_MS`
 * while visible, on focus, on coming back online, on another tab's control (a storage event), and whenever the page asks,
 * as after a control's answer. A failed read keeps what is shown; a first read that fails is an error.
 */
export function useLiveRead<T>(path: string): { read: LiveRead<T>; refresh: () => Promise<void> } {
  const [read, setRead] = useState<{ path: string; value: LiveRead<T> } | null>(null);
  const refresher = useMemo(() => {
    const r: Refresher<T> = new Refresher<T>({
      read: () => getJson(path) as Promise<T>,
      onRead: (data: T): void => setRead((prev) => ({ path, value: { state: "ready", data, freshness: r.freshness(), reads: (prev?.path === path && prev.value.state === "ready" ? prev.value.reads : 0) + 1 } })),
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
