/**
 * The controls' requests (ticket 17b): pause, resume, skip, stop and the restarts of a lead, and a campaign's pause and
 * resume. The server binds a request id to its first answer and its body (ADR 0003 "Ticket 17a", "Requests are
 * idempotent"), so a request sent twice under one id applies once. What the page must prevent is two ids for one press,
 * or two presses in flight on one lead from two tabs. The rule:
 *
 * - **One press per lead or campaign at a time, across the user's tabs, by a lock.** A press takes the target's
 *   exclusive Web Lock if it is free (`ifAvailable`) and holds it until the press has a definite answer or the page
 *   goes; while it is held, a press on that target from any tab is refused here ("busy"). localStorage has no
 *   compare-and-set and another tab may see a write late (review bot on 07fab27, P1), so the lock, not the stored entry,
 *   decides who may create a request id.
 * - **A press is stored before its first send**, under the request id made at the press, in shared storage. A press
 *   storage will not take is not sent: one the page could not track could not be recovered after a reload.
 * - **Every send reads the stored press**: the same id and body on a retry, after a reload, from another tab. While its
 *   lock is held, only its holder sends it (1, 2, 4, 8 seconds, then every 8); another tab that sees it queues for the
 *   lock, and sends it, with its id, only if it is still stored once the holder is gone (the page closed or reloaded).
 * - **A definite answer removes it** (accepted, or refused with the server's reason). Nothing else is kept: what the
 *   page shows comes from the server's read, refreshed after each answer and on every storage event.
 */
import type { LeadControlApi } from "../../shared/api.ts";
import type { KeyValue } from "../calls/callDesk.ts";

export type ControlTarget = { readonly kind: "lead"; readonly id: string } | { readonly kind: "campaign"; readonly id: string };

export interface PressEntry {
  readonly v: 1;
  readonly requestId: string;
  readonly target: ControlTarget;
  readonly action: LeadControlApi;
  /** When it was pressed, on this device's clock. */
  readonly pressedAt: number;
}

/** A definite answer from the server. */
export type SendAnswer = { readonly kind: "accepted"; readonly body: unknown } | { readonly kind: "refused"; readonly message: string };

export type ControlResult = { readonly kind: "accepted"; readonly entry: PressEntry; readonly body: unknown } | { readonly kind: "refused"; readonly entry: PressEntry; readonly message: string };

export type PressOutcome = { readonly ok: true; readonly entry: PressEntry } | { readonly ok: false; readonly why: "busy" | "unstored" };

/** No definite answer: the request may or may not have reached the server. */
export class NoControlAnswer extends Error {
  constructor() {
    super("No answer from the server.");
  }
}

/** Backoff after a send with no answer, in milliseconds; the last repeats. */
export const CONTROL_RETRY_MS = [1_000, 2_000, 4_000, 8_000] as const;

/**
 * An exclusive lock shared by the user's tabs (the Web Locks API): runs `fn` holding `name` and resolves true, or, with
 * `ifAvailable`, resolves false at once without running it while another holder has it. A page that goes releases its locks.
 */
export type LockPort = (name: string, mode: "ifAvailable" | "wait", fn: () => Promise<void>) => Promise<boolean>;

export interface ControlRequestPorts {
  /** Shared by the user's tabs (localStorage), through the call desk's adapter: storage is the only truth. */
  readonly local: KeyValue;
  readonly lock: LockPort;
  newId(): string;
  now(): number;
  setTimer(fire: () => void, ms: number): () => void;
  /** One send. Resolves with a definite answer; throws `NoControlAnswer` (or anything) when there is none. */
  send(entry: PressEntry): Promise<SendAnswer>;
  /** A definite answer this page got. */
  onResult(result: ControlResult): void;
  /** What is stored or on its way changed: show it, and read again. */
  onChange(): void;
}

const PREFIX = "outreach.controls.";
export const controlKey = (target: ControlTarget): string => `${PREFIX}${target.kind}:${target.id}`;
export const isControlKey = (key: string | null): boolean => key?.startsWith(PREFIX) ?? false;

function parse(text: string | null): PressEntry | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && "v" in value && value.v === 1 && "requestId" in value && typeof value.requestId === "string" ? (value as PressEntry) : null;
  } catch {
    return null;
  }
}

export class ControlRequests {
  private readonly ports: ControlRequestPorts;
  /** Targets whose lock this page holds or waits for. */
  private readonly driving = new Set<string>();
  /** Per target: cuts its backoff wait short (try again now, stop). */
  private readonly wakers = new Map<string, () => void>();
  private readonly attempts = new Map<string, number>();
  /** Request ids whose last send here had no answer. */
  private readonly unanswered = new Set<string>();
  private stopped = false;

  constructor(ports: ControlRequestPorts) {
    this.ports = ports;
  }

  /** The press stored for a target, whichever tab made it. */
  pendingFor(target: ControlTarget): PressEntry | null {
    return parse(this.ports.local.get(controlKey(target)));
  }

  /** The stored press for this target had no answer at its last send from this page. */
  unconfirmed(target: ControlTarget): boolean {
    const entry = this.pendingFor(target);
    return entry !== null && this.unanswered.has(entry.requestId);
  }

  /** Stores a press under a new request id, then sends it until it has a definite answer, holding the target's lock. */
  press(target: ControlTarget, action: LeadControlApi): Promise<PressOutcome> {
    const key = controlKey(target);
    if (this.halted() || this.driving.has(key) || this.pendingFor(target)) return Promise.resolve({ ok: false, why: "busy" });
    this.driving.add(key);
    return new Promise<PressOutcome>((resolve) => {
      void this.ports
        .lock(key, "ifAvailable", async () => {
          // Under the lock: a press still stored is one whose page went unanswered; it is sent, never replaced.
          if (this.pendingFor(target)) {
            resolve({ ok: false, why: "busy" });
            return this.drive(target);
          }
          const entry: PressEntry = { v: 1, requestId: this.ports.newId(), target, action, pressedAt: this.ports.now() };
          if (!this.ports.local.set(key, JSON.stringify(entry))) {
            resolve({ ok: false, why: "unstored" });
            return;
          }
          resolve({ ok: true, entry });
          this.ports.onChange();
          return this.drive(target);
        })
        .then((ran) => {
          this.driving.delete(key);
          if (!ran) resolve({ ok: false, why: "busy" });
          this.ports.onChange();
        });
    });
  }

  /** The targets a page shows: a press stored for any of them is sent, with its id, once this page holds its lock. */
  watch(targets: readonly ControlTarget[]): void {
    for (const target of targets) {
      const key = controlKey(target);
      if (this.halted() || this.driving.has(key) || !this.pendingFor(target)) continue;
      this.driving.add(key);
      void this.ports.lock(key, "wait", () => this.drive(target)).then(() => {
        this.driving.delete(key);
        this.ports.onChange();
      });
    }
  }

  /** Another tab changed a press: show it, and take up what is stored for these targets. */
  storageChanged(targets: readonly ControlTarget[]): void {
    this.watch(targets);
    this.ports.onChange();
  }

  /** Try again now: every press waiting out its backoff here is sent at once, with its own id. */
  retryNow(): void {
    for (const wake of [...this.wakers.values()]) wake();
  }

  /** The page shows these controls again (React sets an effect up again after its cleanup in development; review bot on 07fab27, P2). */
  start(): void {
    this.stopped = false;
  }

  /** The page stops: every press it holds is let go with its lock, still stored, for the next page to send. */
  stop(): void {
    this.stopped = true;
    for (const wake of [...this.wakers.values()]) wake();
  }

  /** Read through a method: `stop` may run while a send is awaited. */
  private halted(): boolean {
    return this.stopped;
  }

  /** Holding the target's lock: sends the stored press until it has a definite answer, or the page stops. */
  private async drive(target: ControlTarget): Promise<void> {
    const key = controlKey(target);
    for (;;) {
      if (this.halted()) return;
      const entry = this.pendingFor(target);
      if (!entry) return;
      let answer: SendAnswer | null = null;
      try {
        answer = await this.ports.send(entry);
      } catch {
        answer = null;
      }
      if (this.halted()) return;
      if (answer === null) {
        this.unanswered.add(entry.requestId);
        const n = this.attempts.get(entry.requestId) ?? 0;
        this.attempts.set(entry.requestId, n + 1);
        this.ports.onChange();
        await this.wait(key, CONTROL_RETRY_MS[Math.min(n, CONTROL_RETRY_MS.length - 1)] ?? 8_000);
        continue;
      }
      this.unanswered.delete(entry.requestId);
      this.attempts.delete(entry.requestId);
      // Removed only if it is still this press: a newer press on the target is never removed by an older answer.
      if (this.pendingFor(target)?.requestId === entry.requestId) this.ports.local.remove(key);
      this.ports.onResult(answer.kind === "accepted" ? { kind: "accepted", entry, body: answer.body } : { kind: "refused", entry, message: answer.message });
      this.ports.onChange();
      return;
    }
  }

  private wait(key: string, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let cancel = (): void => undefined;
      const done = () => {
        cancel();
        this.wakers.delete(key);
        resolve();
      };
      cancel = this.ports.setTimer(done, ms);
      this.wakers.set(key, done);
    });
  }
}
