/**
 * Leaving a page that holds work not yet sent (ticket 19; review bot and verifier on 7afa03d): a running campaign's
 * unapplied changes live only on its page, and navigating inside the app unmounts it without a `beforeunload`. While a
 * page sets a guard, the router's navigation (links, `navigate`) and the browser's Back and Forward ask first, with the
 * app's in-page confirmation; a path the guard allows (the same campaign's other tabs, which keep the page's editor) goes.
 *
 * Back and Forward cannot be cancelled once the browser has moved, so the guard puts the address back at once, before
 * the router reads it (a capture listener on `popstate` runs before the router's own), and asks; leaving then goes to
 * the address the user asked for.
 */
import { useSyncExternalStore } from "react";
import { navigate as browserNavigate, useBrowserLocation } from "wouter/use-browser-location";

export interface LeaveGuard {
  /** Whether a path keeps the guarded page (and its unsent work) on screen. */
  readonly allows: (path: string) => boolean;
  /** What the confirmation says. */
  readonly text: string;
}

let guard: LeaveGuard | null = null;
let pending: string | null = null;
const listeners = new Set<() => void>();
const here = () => `${location.pathname}${location.search}`;
let last = typeof location === "undefined" ? "/" : here();

const notify = () => {
  for (const l of listeners) l();
};

/** Sets or clears the guard; clearing it also drops a question it was asking. */
export function setLeaveGuard(next: LeaveGuard | null): void {
  guard = next;
  if (!next && pending !== null) {
    pending = null;
    notify();
  }
}

const pathOf = (to: string | URL) => {
  const url = new URL(to, location.href);
  return { path: url.pathname, full: `${url.pathname}${url.search}` };
};

/** The navigation the guard is asking about, or null. */
export function useLeaveQuestion(): { readonly to: string; readonly text: string } | null {
  const to = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pending,
  );
  return to !== null && guard ? { to, text: guard.text } : null;
}

/** The user chose to leave: the guard is set aside and the navigation goes. */
export function leaveAnyway(): void {
  const to = pending;
  pending = null;
  guard = null;
  notify();
  if (to !== null) {
    last = to;
    browserNavigate(to);
  }
}

/** The user chose to stay: nothing moves. */
export function stay(): void {
  pending = null;
  notify();
}

/** The router's location hook: the browser's, with every navigation asked first while a guard holds. */
export function useGuardedLocation(): ReturnType<typeof useBrowserLocation> {
  const [path] = useBrowserLocation();
  const guarded: typeof browserNavigate = (to, options) => {
    const target = pathOf(to);
    if (guard && !guard.allows(target.path)) {
      pending = target.full;
      notify();
      return;
    }
    last = target.full;
    browserNavigate(to, options);
  };
  return [path, guarded];
}

if (typeof window !== "undefined") {
  window.addEventListener(
    "popstate",
    () => {
      const now = here();
      if (guard && !guard.allows(location.pathname)) {
        history.pushState(history.state, "", last);
        pending = now;
        notify();
        return;
      }
      last = now;
    },
    { capture: true },
  );
}
