import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import type { ApiError, BulkAction } from "../../shared/api.ts";
import { browserStorage } from "../calls/storage.ts";
import { BulkRequests, NoBulkAnswer, bulkPendingFor, isBulkKey, shownBulkResult, type BulkLabel, type BulkPress, type BulkPressOutcome, type BulkResult, type BulkSendAnswer } from "./requests.ts";

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

interface BulkShell {
  readonly requests: BulkRequests;
  /** Bumped on every change to what is stored or on its way: every consumer renders again. */
  readonly version: number;
  /** The last definite answer, numbered, so a consumer acts only on answers that arrive while it is shown. */
  readonly answered: { readonly seq: number; readonly result: BulkResult } | null;
  /** Bumped when another tab stores or answers a bulk press. */
  readonly elsewhere: number;
  /** The bulk ids pressed in this tab: their answer lines are this tab's own. */
  readonly own: Set<string>;
}

const BulkContext = createContext<BulkShell | null>(null);

/**
 * The app's one bulk request manager (review bot on 969799e), in the shell, so a stored bulk press is never orphaned:
 * wherever the user is, it is sent once on first sight and then on its backoff until a definite answer removes it, as the
 * call desk's and the controls' outboxes are (ADR 0003 4.4.1, 17b). Leads presses through it; a record's controls wait
 * while a press names their lead and read again when its answer arrives.
 */
export function BulkProvider({ children }: { children: ReactNode }) {
  const [version, render] = useReducer((n: number) => n + 1, 0);
  const [answered, setAnswered] = useState<BulkShell["answered"]>(null);
  const [elsewhere, setElsewhere] = useState(0);
  const [own] = useState(() => new Set<string>());
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
        onResult: (result) => setAnswered((prev) => ({ seq: (prev?.seq ?? 0) + 1, result })),
        onChange: () => render(),
      }),
  );
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
  const value = useMemo(() => ({ requests, version, answered, elsewhere, own }), [requests, version, answered, elsewhere, own]);
  return <BulkContext.Provider value={value}>{children}</BulkContext.Provider>;
}

function useShell(): BulkShell {
  const shell = useContext(BulkContext);
  if (!shell) throw new Error("useBulk needs the BulkProvider in the app shell");
  return shell;
}

/**
 * Whether a stored bulk press names this enrollment, rendered again on every change to the bulk outbox, and `onAnswer`
 * called when a bulk answer, or another tab's change, arrives while the caller is shown (a record reads again then).
 */
export function useBulkPending(onAnswer: () => void): (enrollmentId: string) => boolean {
  const shell = useContext(BulkContext);
  const [since] = useState(() => ({ seq: shell?.answered?.seq ?? 0, elsewhere: shell?.elsewhere ?? 0 }));
  const seq = shell?.answered?.seq ?? 0;
  const elsewhere = shell?.elsewhere ?? 0;
  useEffect(() => {
    if (seq > since.seq || elsewhere > since.elsewhere) onAnswer();
  }, [seq, elsewhere, since, onAnswer]);
  const version = shell?.version ?? 0;
  return useCallback((enrollmentId: string) => version >= 0 && bulkPendingFor(local, enrollmentId), [version]);
}

const local = browserStorage(() => window.localStorage);

/** Leads' view of the shell's bulk manager: its presses, what is on its way, and this tab's answer line. */
export function useBulk(refresh: () => void): Bulk {
  const shell = useShell();
  const { requests, own } = shell;
  const [result, setResult] = useState<BulkResult | null>(null);
  // Answers and other tabs' changes that arrive while Leads is shown; one that arrived before it opened is not this page's line.
  const [since] = useState(() => ({ seq: shell.answered?.seq ?? 0, elsewhere: shell.elsewhere }));
  const answered = shell.answered;
  // Each answer that arrives while Leads is shown sets this tab's line once: an answer to a press recovered after a
  // reload, or sent here for another tab, still has its answer shown (review bot on 9daf7c0).
  const [lineSeq, setLineSeq] = useState(since.seq);
  if (answered !== null && answered.seq > lineSeq) {
    setLineSeq(answered.seq);
    setResult((current) => shownBulkResult(current, answered.result, own));
  }
  const answeredSeq = answered?.seq ?? 0;
  useEffect(() => {
    if (answeredSeq > since.seq) refresh();
  }, [answeredSeq, since, refresh]);
  useEffect(() => {
    if (shell.elsewhere > since.elsewhere) refresh();
  }, [shell.elsewhere, since, refresh]);

  const press = useCallback(
    (action: BulkAction, body: Readonly<Record<string, unknown>>, labels: Readonly<Record<string, BulkLabel>>, campaign: string | null) => {
      setResult(null);
      const out = requests.press(action, body, labels, campaign);
      if (out.ok) own.add(out.press.bulkId);
      return out;
    },
    [requests, own],
  );
  const dismiss = useCallback(() => setResult(null), []);
  const version = shell.version;
  return useMemo(
    () => ({ press, pending: () => (version >= 0 ? requests.pending() : null), unconfirmed: () => requests.unconfirmed(), result, dismiss, retryNow: () => requests.retryNow() }),
    [press, dismiss, requests, result, version],
  );
}
