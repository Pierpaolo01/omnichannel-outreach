/**
 * Leaving a page that holds work not yet sent (ticket 19; review bot and verifier on 7afa03d): a running campaign's
 * unapplied changes live only on its page, and navigating inside the app unmounts it without a `beforeunload`. While a
 * page sets a guard, the router's navigation (links, `navigate`) and the browser's Back and Forward ask first, with the
 * app's in-page confirmation; a path the guard allows (the same campaign's other tabs, which keep the page's editor) goes.
 *
 * Back and Forward cannot be cancelled once the browser has moved, and the history must stay as it was (review bot on
 * 93bed86). So every entry this document makes carries its position, the guard's capture listener stops the router from
 * seeing a move it blocks, and moves back by the same distance with `history.go`; nothing is pushed, so the entries ahead
 * are kept. Leaving then moves by that distance again, and the router follows. Cancelling, or Escape, gives keyboard
 * focus back to the element the navigation started from, or the page's main heading.
 */
import { useSyncExternalStore } from "react";
import { navigate as browserNavigate, useBrowserLocation } from "wouter/use-browser-location";

export interface LeaveGuard {
  /** Whether a path keeps the guarded page (and its unsent work) on screen. */
  readonly allows: (path: string) => boolean;
  /** What the confirmation says. */
  readonly text: string;
}

type Pending = { readonly to: string; readonly kind: "link"; readonly options?: Parameters<typeof browserNavigate>[1] } | { readonly to: string; readonly kind: "history"; readonly delta: number };

const KEY = "outreachEntry";
let guard: LeaveGuard | null = null;
let pending: Pending | null = null;
/** Where focus was when the navigation the guard asks about started. */
let origin: Element | null = null;
/** This entry's position among the document's entries. */
let position = 0;
/** A move back the guard made itself, which the router must not see either. */
let restoring = false;
const listeners = new Set<() => void>();

const notify = () => {
  for (const l of listeners) l();
};
const entryOf = (state: unknown): number | null => {
  const n = (state as Record<string, unknown> | null)?.[KEY];
  return typeof n === "number" ? n : null;
};

/** Sets or clears the guard; clearing it also drops a question it was asking. */
export function setLeaveGuard(next: LeaveGuard | null): void {
  guard = next;
  if (!next && pending !== null) {
    pending = null;
    notify();
  }
}

/** The navigation the guard is asking about, or null. */
export function useLeaveQuestion(): { readonly to: string; readonly text: string } | null {
  const asked = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pending,
  );
  return asked !== null && guard ? { to: asked.to, text: guard.text } : null;
}

const ask = (next: Pending) => {
  origin = typeof document === "undefined" ? null : document.activeElement;
  pending = next;
  notify();
};

/** The user chose to leave: the guard is set aside and the navigation goes. */
export function leaveAnyway(): void {
  const asked = pending;
  pending = null;
  guard = null;
  notify();
  if (asked === null) return;
  if (asked.kind === "history") history.go(asked.delta);
  else guardedNavigate(asked.to, asked.options);
}

/** The user chose to stay: nothing moves, and focus goes back where the navigation started. */
export function stay(): void {
  pending = null;
  notify();
  const back = origin;
  origin = null;
  queueMicrotask(() => {
    const target = back instanceof HTMLElement && back.isConnected ? back : document.querySelector<HTMLElement>("main h1");
    if (target && !target.hasAttribute("tabindex") && target.tagName === "H1") target.setAttribute("tabindex", "-1");
    target?.focus();
  });
}

function guardedNavigate(to: string | URL, options?: Parameters<typeof browserNavigate>[1]): void {
  const url = new URL(to, location.href);
  if (guard && !guard.allows(url.pathname)) {
    ask({ to: `${url.pathname}${url.search}`, kind: "link", ...(options ? { options } : {}) });
    return;
  }
  // Each entry carries its position, so a blocked Back or Forward can be undone by the same distance.
  const at = options?.replace === true ? position : position + 1;
  position = at;
  browserNavigate(to, { ...options, state: { ...((options?.state as Record<string, unknown> | undefined) ?? {}), [KEY]: at } });
}

/** The router's location hook: the browser's, with every navigation asked first while a guard holds. */
export function useGuardedLocation(): ReturnType<typeof useBrowserLocation> {
  const [path] = useBrowserLocation();
  return [path, guardedNavigate];
}

if (typeof window !== "undefined") {
  // The entry the document opened on is position 0, keeping whatever state it had.
  const opened = entryOf(history.state);
  if (opened === null) history.replaceState({ ...((history.state as Record<string, unknown> | null) ?? {}), [KEY]: 0 }, "");
  else position = opened;
  let last = `${location.pathname}${location.search}${location.hash}`;
  window.addEventListener(
    "popstate",
    (event) => {
      const at = entryOf(event.state);
      if (restoring) {
        // The guard's own move back to where the user was: the router never saw the move away, so it sees nothing now.
        restoring = false;
        event.stopImmediatePropagation();
        if (at !== null) position = at;
        return;
      }
      // Every traversal the router would follow is guarded, whatever its entry (review bot on 5b2f3c6): one a native
      // fragment link made has no state of the router's.
      if (guard && !guard.allows(location.pathname)) {
        event.stopImmediatePropagation();
        const to = `${location.pathname}${location.search}`;
        if (at !== null) {
          // Undo the move by the same distance, keeping every entry, and ask.
          const delta = at - position;
          restoring = true;
          history.go(-delta);
          ask({ to, kind: "history", delta });
        } else {
          // An entry with no position (made outside this document's navigation): the address is put back, so the page
          // and its unsent work stay, though the entries ahead cannot be kept; leaving then goes where the user asked.
          position += 1;
          history.pushState({ [KEY]: position }, "", last);
          ask({ to, kind: "link" });
        }
        return;
      }
      if (at !== null) position = at;
      else {
        // A new entry a native fragment link made (Skip to content): it takes the next position, so a later Back
        // through it is measured like any other.
        position += 1;
        history.replaceState({ ...((history.state as Record<string, unknown> | null) ?? {}), [KEY]: position }, "");
      }
      last = `${location.pathname}${location.search}${location.hash}`;
    },
    { capture: true },
  );
  // The router follows `hashchange` too: while a move is being undone or asked about, it must not see it either.
  window.addEventListener(
    "hashchange",
    (event) => {
      if (restoring || pending !== null) event.stopImmediatePropagation();
      else last = `${location.pathname}${location.search}${location.hash}`;
    },
    { capture: true },
  );
  // Router navigation moves `last` too.
  for (const kind of ["pushState", "replaceState"]) window.addEventListener(kind, () => (last = `${location.pathname}${location.search}${location.hash}`));
}
