import { useEffect, useState, useSyncExternalStore } from "react";
import type { CallOutcomeAnswer, CallsView, CallTaskView } from "../../shared/api.ts";
import { getJson } from "../api.ts";
import { CallDesk, NoAnswer, Refused, type DeskSnapshot, type KeyValue, type OutcomeBody } from "./callDesk.ts";

/** How long an outcome waits for its answer before it counts as no answer and is sent again. */
const ANSWER_TIMEOUT_MS = 20_000;
/** A tab learns of work done elsewhere at least this often. */
const REFRESH_MS = 60_000;

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
  // A 4xx is the server's definite refusal; anything else may or may not have been logged.
  if (response.status >= 400 && response.status < 500) {
    const message = (json as { error?: { message?: unknown } } | null)?.error?.message;
    throw new Refused(response.status, typeof message === "string" ? message : `The server answered ${response.status}.`);
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
  });
}

/**
 * The Calls page's binding of CallDesk (callDesk.ts) to React and the browser: it opens the desk,
 * refreshes on showing the tab again, on another tab's outbox change and every minute, and sends a
 * pending outcome again when the browser comes back online. The generated test drives the same desk.
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
    const timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("storage", onStorage);
    window.addEventListener("online", online);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("online", online);
      desk.dispose();
    };
  }, [desk]);
  return { desk, snap };
}
