import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ApiError } from "../../shared/api.ts";
import { browserStorage } from "../calls/storage.ts";
import { useBulkPending } from "../bulk/useBulk.tsx";
import { ControlRequests, NoControlAnswer, controlKey, controlRequestOf, shownResult, isControlKey, type CampaignExpectation, type ControlResult, type ControlTarget, type LeadExpectation, type PressEntry, type PressOutcome, type RecordControl, type SendAnswer } from "./requests.ts";

/** A 4xx whose code says the server refused the request is definite; anything else is no answer (as the call desk reads it). */
const DEFINITE = new Set(["control_refused", "not_found", "invalid_request"]);

async function sendControl(entry: PressEntry): Promise<SendAnswer> {
  const { path, body } = controlRequestOf(entry);
  let response: Response;
  try {
    response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new NoControlAnswer();
  }
  const json: unknown = await response.json().catch(() => null);
  if (response.ok) return { kind: "accepted", body: json };
  const error = (json as ApiError | null)?.error;
  if (error && DEFINITE.has(error.code) && typeof error.message === "string") return { kind: "refused", message: error.message };
  throw new NoControlAnswer();
}

export interface Controls {
  press(target: ControlTarget, action: RecordControl, expect: LeadExpectation | CampaignExpectation, trackId?: string): Promise<PressOutcome>;
  /** The press stored for a target, whichever tab made it. */
  pending(target: ControlTarget): PressEntry | null;
  /** Its last send from this page had no answer. */
  unconfirmed(target: ControlTarget): boolean;
  /** A bulk press from Leads, stored in this browser, names this lead (ticket 18): its controls wait for it. */
  bulkPending(target: ControlTarget): boolean;
  /** The last definite answer this page got for a target, until dismissed or the next press. */
  result(target: ControlTarget): ControlResult | null;
  dismiss(target: ControlTarget): void;
  retryNow(): void;
}

/**
 * The page's control requests (requests.ts) bound to the browser: localStorage through the call desk's adapter, a
 * request id from the browser at the press, and the page's read refreshed after every answer and every change another
 * tab makes. `targets` are the leads and campaigns the page shows.
 */
export function useControls(targets: readonly ControlTarget[], refresh: () => Promise<void> | void): Controls {
  const [, render] = useReducer((n: number) => n + 1, 0);
  const [results, setResults] = useState<ReadonlyMap<string, ControlResult>>(new Map());
  // A stored bulk press from Leads that names a lead here (verifier B1 on 4363270): its controls wait while it is on its
  // way, and the record reads again when the shell's manager gets its answer, wherever the user went (review bot on 969799e).
  const reread = useCallback(() => void refresh(), [refresh]);
  const bulkPending = useBulkPending(reread);
  const targetsRef = useRef(targets);
  /** The request ids this tab pressed: its answer lines are its own. */
  const ownRef = useRef(new Set<string>());
  useEffect(() => {
    targetsRef.current = targets;
  });
  const [requests] = useState(
    () =>
      new ControlRequests({
        local: browserStorage(() => window.localStorage),
        newId: () => crypto.randomUUID(),
        now: () => Date.now(),
        setTimer: (fire, ms) => {
          const t = setTimeout(fire, ms);
          return () => clearTimeout(t);
        },
        send: sendControl,
        // Each tab's line belongs to its own press (verifier R2 on 57d874f): another tab's answer re-reads the row but never
        // replaces this tab's own refusal or answer.
        onResult: (r) =>
          setResults((prev) => {
            const shown = shownResult(prev.get(controlKey(r.entry.target)) ?? null, r, ownRef.current);
            return shown === prev.get(controlKey(r.entry.target)) ? new Map(prev) : new Map(prev).set(controlKey(r.entry.target), shown ?? r);
          }),
        onChange: () => render(),
      }),
  );

  // Every answer this page gets is followed by a read of the page: what is shown comes from the server.
  useEffect(() => {
    if (results.size > 0) void refresh();
  }, [results, refresh]);

  const key = targets.map(controlKey).join("|");
  useEffect(() => {
    requests.watch(key === "" ? [] : targetsRef.current);
  }, [requests, key]);

  useEffect(() => {
    // Set up again after a cleanup (React does so in development): the requests run again (review bot on 07fab27, P2).
    requests.start();
    requests.watch(targetsRef.current);
    const onStorage = (e: StorageEvent) => {
      if (isControlKey(e.key)) requests.storageChanged(targetsRef.current);
    };
    const onOnline = () => requests.retryNow();
    window.addEventListener("storage", onStorage);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("online", onOnline);
      requests.stop();
    };
  }, [requests]);

  const press = useCallback(
    (target: ControlTarget, action: RecordControl, expect: LeadExpectation | CampaignExpectation, trackId?: string) => {
      setResults((prev) => {
        const next = new Map(prev);
        next.delete(controlKey(target));
        return next;
      });
      return requests.press(target, action, expect, trackId).then((out) => {
        if (out.ok) ownRef.current.add(out.entry.requestId);
        return out;
      });
    },
    [requests],
  );
  const dismiss = useCallback((target: ControlTarget) => {
    setResults((prev) => {
      const next = new Map(prev);
      next.delete(controlKey(target));
      return next;
    });
  }, []);

  return useMemo(
    () => ({
      press,
      pending: (t: ControlTarget) => requests.pendingFor(t),
      unconfirmed: (t: ControlTarget) => requests.unconfirmed(t),
      bulkPending: (t: ControlTarget) => t.kind === "lead" && bulkPending(t.id),
      result: (t: ControlTarget) => results.get(controlKey(t)) ?? null,
      dismiss,
      retryNow: () => requests.retryNow(),
    }),
    // `pending` and `unconfirmed` read storage at each render; a change re-renders the page.
    [press, dismiss, requests, results, bulkPending],
  );
}
