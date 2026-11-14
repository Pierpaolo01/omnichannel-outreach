import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ApiError, BulkAction } from "../../shared/api.ts";
import { browserStorage } from "../calls/storage.ts";
import { BulkRequests, NoBulkAnswer, isBulkKey, type BulkLabel, type BulkPress, type BulkPressOutcome, type BulkResult, type BulkSendAnswer } from "./requests.ts";

/** A 4xx whose code says the server refused the bulk is definite; anything else is no answer. */
const DEFINITE = new Set(["bulk_refused", "not_found", "invalid_request"]);

async function sendBulk(press: BulkPress): Promise<BulkSendAnswer> {
  let response: Response;
  try {
    response = await fetch("/api/bulk", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ bulkId: press.bulkId, ...press.body }) });
  } catch {
    throw new NoBulkAnswer();
  }
  const json: unknown = await response.json().catch(() => null);
  if (response.ok) return { kind: "answered", body: json };
  const error = (json as ApiError | null)?.error;
  if (error && DEFINITE.has(error.code) && typeof error.message === "string") return { kind: "refused", message: error.message };
  throw new NoBulkAnswer();
}

export interface Bulk {
  press(action: BulkAction, body: Readonly<Record<string, unknown>>, labels: Readonly<Record<string, BulkLabel>>, campaign: string | null): BulkPressOutcome;
  /** The bulk press stored on this device, whichever tab made it. */
  pending(): BulkPress | null;
  unconfirmed(): boolean;
  /** The last definite answer this page got, until dismissed or the next press. */
  result: BulkResult | null;
  dismiss(): void;
  retryNow(): void;
}

/**
 * The page's bulk presses (requests.ts) bound to the browser: localStorage through the call desk's adapter, a bulk id from
 * the browser at the press, and Leads read again after every answer and every change another tab makes.
 */
export function useBulk(refresh: () => void): Bulk {
  const [, render] = useReducer((n: number) => n + 1, 0);
  const [result, setResult] = useState<BulkResult | null>(null);
  /** The bulk ids this tab pressed: its answer line is its own; another tab's answer only re-reads the rows. */
  const own = useRef(new Set<string>());
  /** Every definite answer this page gets, mine or another tab's press's: each is followed by a read of the rows. */
  const [answered, setAnswered] = useState<BulkResult | null>(null);
  /** Another tab's bulk press was stored or answered: the rows are read again. */
  const [elsewhere, setElsewhere] = useState(0);
  const [requests] = useState(
    () =>
      new BulkRequests({
        local: browserStorage(() => window.localStorage),
        newId: () => crypto.randomUUID(),
        now: () => Date.now(),
        setTimer: (fire, ms) => {
          const t = setTimeout(fire, ms);
          return () => clearTimeout(t);
        },
        send: sendBulk,
        onResult: (r) => setAnswered(r),
        onChange: () => render(),
      }),
  );

  useEffect(() => {
    if (answered === null) return;
    if (own.current.has(answered.press.bulkId)) setResult(answered);
    refresh();
  }, [answered, refresh]);

  useEffect(() => {
    if (elsewhere > 0) refresh();
  }, [elsewhere, refresh]);

  useEffect(() => {
    requests.start();
    requests.watch();
    const onStorage = (e: StorageEvent) => {
      if (!isBulkKey(e.key)) return;
      requests.storageChanged();
      setElsewhere((n) => n + 1);
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
    (action: BulkAction, body: Readonly<Record<string, unknown>>, labels: Readonly<Record<string, BulkLabel>>, campaign: string | null) => {
      setResult(null);
      const out = requests.press(action, body, labels, campaign);
      if (out.ok) own.current.add(out.press.bulkId);
      return out;
    },
    [requests],
  );
  const dismiss = useCallback(() => setResult(null), []);
  return useMemo(
    () => ({ press, pending: () => requests.pending(), unconfirmed: () => requests.unconfirmed(), result, dismiss, retryNow: () => requests.retryNow() }),
    [press, dismiss, requests, result],
  );
}
