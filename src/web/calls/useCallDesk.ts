import { useEffect, useState, useSyncExternalStore } from "react";
import type { CallOutcomeAnswer, CallsView, CallTaskView } from "../../shared/api.ts";
import { getJson } from "../api.ts";
import { CallDesk, NoAnswer, Refused, type DeskSnapshot, type KeyValue, type OutcomeBody } from "./callDesk.ts";

/** How long an outcome waits for its answer before it counts as no answer and is sent again. */
const ANSWER_TIMEOUT_MS = 20_000;

/** Queues for the lock `name` until granted, or null once `signal` aborts (the desk left). Without Web Locks, granted at once. */
function wait(name: string, signal: AbortSignal): Promise<(() => void) | null> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return Promise.resolve(() => undefined);
  return new Promise((resolve) => {
    locks
      .request(name, { signal }, () => new Promise<void>((release) => resolve(() => release())))
      .catch(() => resolve(null));
  });
}

/**
 * The browser's Web Locks: one exclusive lock per outbox entry across the user's tabs, asked for at
 * once and held until released; a closed tab's locks are released by the browser. Without Web Locks
 * every claim succeeds: two tabs may then both send an entry, which the request id keeps logged once.
 */
function claim(name: string): Promise<(() => void) | null> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return Promise.resolve(() => undefined);
  return new Promise((resolve) => {
    locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return undefined;
        }
        return new Promise<void>((release) => resolve(() => release()));
      })
      .catch(() => resolve(() => undefined));
  });
}

/** Browser storage that never throws: private windows and blocked storage fall back to memory. */
function storage(pick: () => Storage): KeyValue {
  const memory = new Map<string, string>();
  const s = (): Storage | null => {
    try {
      return pick();
    } catch {
      return null;
    }
  };
  return {
    get: (k) => {
      try {
        return s()?.getItem(k) ?? memory.get(k) ?? null;
      } catch {
        return memory.get(k) ?? null;
      }
    },
    set: (k, v) => {
      memory.set(k, v);
      try {
        s()?.setItem(k, v);
      } catch {
        // memory holds it
      }
    },
    remove: (k) => {
      memory.delete(k);
      try {
        s()?.removeItem(k);
      } catch {
        // memory only
      }
    },
    keys: () => {
      const keys = new Set(memory.keys());
      try {
        const st = s();
        for (let i = 0; st && i < st.length; i++) {
          const k = st.key(i);
          if (k !== null) keys.add(k);
        }
      } catch {
        // memory only
      }
      return [...keys];
    },
  };
}

async function post(taskId: string, body: OutcomeBody): Promise<CallOutcomeAnswer> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), ANSWER_TIMEOUT_MS);
  let response: Response;
  try {
    // keepalive: an outcome logged just before the page goes is still delivered.
    response = await fetch(`/api/call-tasks/${encodeURIComponent(taskId)}/outcome`, {
      method: "POST",
      keepalive: true,
      signal: abort.signal,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new NoAnswer();
  } finally {
    clearTimeout(timeout);
  }
  const json: unknown = await response.json().catch(() => null);
  if (response.ok && json !== null) return json as CallOutcomeAnswer;
  // A 4xx carries the server's code; the desk counts only a refusal code as definite (isRefusal), so 408
  // or 429 is sent again. Anything else may or may not have been logged.
  if (response.status >= 400 && response.status < 500) {
    const error = (json as { error?: { message?: unknown; code?: unknown } } | null)?.error;
    throw new Refused(response.status, typeof error?.message === "string" ? error.message : `The server answered ${response.status}.`, typeof error?.code === "string" ? error.code : null);
  }
  throw new NoAnswer();
}

const newId = (): string => (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

function browserDesk(): CallDesk {
  return new CallDesk({
    calls: async (focus) => (await getJson(`/api/calls${focus ? `?focus=${encodeURIComponent(focus)}` : ""}`)) as CallsView,
    task: async (id) => (await getJson(`/api/call-tasks/${encodeURIComponent(id)}`)) as CallTaskView,
    post,
    local: storage(() => window.localStorage),
    session: storage(() => window.sessionStorage),
    newId,
    setTimer: (fire, ms) => {
      const t = setTimeout(fire, ms);
      return () => clearTimeout(t);
    },
    claim,
    wait,
  });
}

/**
 * The Calls page's binding of CallDesk (callDesk.ts) to React and the browser: it opens the desk,
 * refreshes on showing the tab again and on another tab's outbox change (the desk itself refreshes at
 * the server's `nextChangeAt` and after every action), and sends what it holds again when the browser
 * comes back online. The generated test drives the same desk.
 * A remount (React's strict mode) disposes the desk and starts it again.
 */
export function useCallDesk(): { desk: CallDesk; snap: DeskSnapshot } {
  const [desk] = useState(browserDesk);
  const snap = useSyncExternalStore(desk.subscribe, desk.getSnapshot);
  useEffect(() => {
    void desk.start();
    const refresh = () => void desk.refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key?.startsWith("outreach.calls.outbox.")) refresh();
    };
    const online = () => desk.retryNow();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", onStorage);
    window.addEventListener("online", online);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("online", online);
      desk.dispose();
    };
  }, [desk]);
  return { desk, snap };
}
