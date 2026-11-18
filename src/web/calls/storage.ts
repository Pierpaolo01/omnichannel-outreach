import type { KeyValue } from "./callDesk.ts";

/**
 * Browser storage as the call desk uses it (ADR 0003 4.4.1, "two sources only"). Storage is the only
 * truth: nothing is cached here, so a key another tab removed reads as absent, and every change is a
 * change to one key. A write the browser refuses (quota, blocked storage) is reported as `false`,
 * never held in memory in its place; a read that throws reads as absent.
 */
export function browserStorage(pick: () => Storage): KeyValue {
  const store = (): Storage | null => {
    try {
      return pick();
    } catch {
      return null;
    }
  };
  return {
    get: (k) => {
      try {
        return store()?.getItem(k) ?? null;
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        const s = store();
        if (!s) return false;
        s.setItem(k, v);
        return true;
      } catch {
        return false;
      }
    },
    remove: (k) => {
      try {
        store()?.removeItem(k);
      } catch {
        // Nothing to remove from storage that cannot be read.
      }
    },
    keys: () => {
      try {
        const s = store();
        const out: string[] = [];
        for (let i = 0; s && i < s.length; i++) {
          const k = s.key(i);
          if (k !== null) out.push(k);
        }
        return out;
      } catch {
        return [];
      }
    },
  };
}
