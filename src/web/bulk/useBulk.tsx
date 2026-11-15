import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import type { ApiError, BulkAction, BulkAddRow } from "../../shared/api.ts";
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
  press(action: BulkAction, body: Readonly<Record<string, unknown>>, labels: Readonly<Record<string, BulkLabel>>, campaign: string | null, notSent?: readonly BulkAddRow[]): BulkPressOutcome;
  /** Whether this tab pressed it: only this tab's own presses take focus (council item 6 on 3555a3e). */
  own(press: BulkPress): boolean;
  /** The bulk press stored on this device, whichever tab made it. */
  pending(): BulkPress | null;
  unconfirmed(): boolean;
  /**
   * Every bulk outcome this page has shown and not dismissed, newest first (review bot on 3555a3e): each answered bulk the
   * outbox holds as not yet seen, wherever its answer arrived, is shown here once and then leaves storage.
   */
  results: readonly BulkResult[];
  dismiss(bulkId: string): void;
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
  const [requests] = useState(
    () =>
      new BulkRequests({
        local: browserStorage(() => window.localStorage),
        tab: tabId(),
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
  const value = useMemo(() => ({ requests, version, answered, elsewhere }), [requests, version, answered, elsewhere]);
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
  const requests = shell?.requests ?? null;
  return useCallback((enrollmentId: string) => version >= 0 && (requests?.pendingFor(enrollmentId) ?? false), [version, requests]);
}

/** This tab's id, kept in `sessionStorage`, so a reload and moving between pages keep it; a new one when storage is blocked. */
function tabId(): string {
  const session = browserStorage(() => window.sessionStorage);
  const known = session.get("outreach.tab");
  if (known) return known;
  const id = crypto.randomUUID();
  session.set("outreach.tab", id);
  return id;
}

/** Leads' view of the shell's bulk manager: its presses, what is on its way, and every bulk outcome not yet seen. */
export function useBulk(refresh: () => void): Bulk {
  const shell = useShell();
  const { requests } = shell;
  const version = shell.version;
  // Every answered bulk the outbox holds as not yet seen joins what this page shows, newest first, whichever tab got its
  // answer and wherever the user was then; once shown it is marked seen (review bot on 3555a3e).
  const [shown, setShown] = useState<readonly BulkResult[]>([]);
  const fresh = version >= 0 ? requests.unseen().filter((r) => !shown.some((s) => s.press.bulkId === r.press.bulkId)) : [];
  if (fresh.length > 0) setShown((prev) => [...fresh.filter((r) => !prev.some((s) => s.press.bulkId === r.press.bulkId)), ...prev]);
  // The tab that pressed a bulk marks its outcome seen once shown; another tab shows it and leaves it stored, so the
  // tab that pressed it still sees it (the user may be there), until a Dismiss anywhere.
  useEffect(() => {
    for (const r of shown) if (requests.own(r.press)) requests.markSeen(r.press.bulkId);
  }, [shown, requests]);
  // The rows are read again for every answer and every change another tab makes while Leads is shown.
  const [since] = useState(() => ({ seq: shell.answered?.seq ?? 0, elsewhere: shell.elsewhere }));
  const answeredSeq = shell.answered?.seq ?? 0;
  useEffect(() => {
    if (answeredSeq > since.seq) refresh();
  }, [answeredSeq, since, refresh]);
  useEffect(() => {
    if (shell.elsewhere > since.elsewhere) refresh();
  }, [shell.elsewhere, since, refresh]);

  const press = useCallback(
    (action: BulkAction, body: Readonly<Record<string, unknown>>, labels: Readonly<Record<string, BulkLabel>>, campaign: string | null, notSent: readonly BulkAddRow[] = []) =>
      requests.press(action, body, labels, campaign, notSent),
    [requests],
  );
  const dismiss = useCallback(
    (bulkId: string) => {
      requests.markSeen(bulkId);
      setShown((prev) => prev.filter((r) => r.press.bulkId !== bulkId));
    },
    [requests],
  );
  return useMemo(
    () => ({ press, own: (p: BulkPress) => requests.own(p), pending: () => (version >= 0 ? requests.pending() : null), unconfirmed: () => requests.unconfirmed(), results: shown, dismiss, retryNow: () => requests.retryNow() }),
    [press, dismiss, requests, shown, version],
  );
}
