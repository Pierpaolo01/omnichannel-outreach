/**
 * The controls' requests (ticket 17b): pause, resume, skip, stop and the restarts of a lead, and a campaign's pause and
 * resume. The server binds a request id to its first answer and its body (ADR 0003 "Ticket 17a", "Requests are
 * idempotent"), so the page keeps the call desk's rule (4.4.1) and almost nothing else:
 *
 * - A press makes its request id once, and is stored in shared storage (`localStorage`) before its first send. A press
 *   storage will not take is not sent: a request the page could not track could be neither retried nor reconciled after a
 *   reload, and the user would believe it on its way.
 * - Every send of a press, a retry, a send after a reload or another tab's, reads the stored press: the same id and body,
 *   so the server applies it once. Any page showing the lead or campaign sends a press it sees, once on first sight and then
 *   only on that press's own backoff (1, 2, 4, 8 seconds, then every 8).
 * - One press per lead or campaign is on its way at a time, across the user's tabs: a press while another is stored for
 *   the same target is refused here ("busy"). A definite answer (accepted, or refused with the server's reason) removes it.
 * - Nothing else is kept: what the page shows comes from the server's read, refreshed after each answer and on every
 *   storage event, and from the answer this page got.
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

/** No definite answer: the request may or may not have reached the server. */
export class NoControlAnswer extends Error {
  constructor() {
    super("No answer from the server.");
  }
}

/** Backoff after a send with no answer, in milliseconds; the last repeats. */
export const CONTROL_RETRY_MS = [1_000, 2_000, 4_000, 8_000] as const;

export interface ControlRequestPorts {
  /** Shared by the user's tabs (localStorage), through the call desk's adapter: storage is the only truth. */
  readonly local: KeyValue;
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
  /** Per request id: a send in flight, and the timer of its next send. */
  private readonly inFlight = new Set<string>();
  private readonly timers = new Map<string, () => void>();
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

  /** Stores a press under a new request id, then sends it. Refused while a press is stored for the target, or when storage will not take it. */
  press(target: ControlTarget, action: LeadControlApi): { ok: true; entry: PressEntry } | { ok: false; why: "busy" | "unstored" } {
    if (this.pendingFor(target)) return { ok: false, why: "busy" };
    const entry: PressEntry = { v: 1, requestId: this.ports.newId(), target, action, pressedAt: this.ports.now() };
    if (!this.ports.local.set(controlKey(target), JSON.stringify(entry))) return { ok: false, why: "unstored" };
    this.ports.onChange();
    void this.send(entry);
    return { ok: true, entry };
  }

  /** The targets a page shows: a stored press for any of them that is not on its way from here is sent now. */
  watch(targets: readonly ControlTarget[]): void {
    for (const target of targets) {
      const entry = this.pendingFor(target);
      if (entry && !this.inFlight.has(entry.requestId) && !this.timers.has(entry.requestId)) void this.send(entry);
    }
  }

  /** Another tab changed a press: show it, and send what is stored for these targets on its first sight. */
  storageChanged(targets: readonly ControlTarget[]): void {
    this.watch(targets);
    this.ports.onChange();
  }

  /** Try again now: every press waiting on its timer is sent at once, with its own id. */
  retryNow(): void {
    for (const [id, cancel] of [...this.timers]) {
      cancel();
      this.timers.delete(id);
      const entry = this.storedById(id);
      if (entry) void this.send(entry);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
  }

  /** Read through a method: `stop` may run while a send is awaited. */
  private halted(): boolean {
    return this.stopped;
  }

  private storedById(requestId: string): PressEntry | null {
    for (const key of this.ports.local.keys()) {
      if (!isControlKey(key)) continue;
      const entry = parse(this.ports.local.get(key));
      if (entry?.requestId === requestId) return entry;
    }
    return null;
  }

  private async send(entry: PressEntry): Promise<void> {
    if (this.stopped || this.inFlight.has(entry.requestId)) return;
    // Sent only while it is still the stored press: an answer another tab got removed it.
    if (this.pendingFor(entry.target)?.requestId !== entry.requestId) return;
    this.inFlight.add(entry.requestId);
    let answer: SendAnswer | null = null;
    try {
      answer = await this.ports.send(entry);
    } catch {
      answer = null;
    }
    this.inFlight.delete(entry.requestId);
    if (this.halted()) return;
    if (answer === null) {
      this.unanswered.add(entry.requestId);
      const n = this.attempts.get(entry.requestId) ?? 0;
      this.attempts.set(entry.requestId, n + 1);
      const ms = CONTROL_RETRY_MS[Math.min(n, CONTROL_RETRY_MS.length - 1)] ?? 8_000;
      this.timers.set(
        entry.requestId,
        this.ports.setTimer(() => {
          this.timers.delete(entry.requestId);
          void this.send(entry);
        }, ms),
      );
      this.ports.onChange();
      return;
    }
    this.unanswered.delete(entry.requestId);
    this.attempts.delete(entry.requestId);
    // Removed only if it is still this press: a newer press on the target is never removed by an older answer.
    if (this.pendingFor(entry.target)?.requestId === entry.requestId) this.ports.local.remove(controlKey(entry.target));
    this.ports.onResult(answer.kind === "accepted" ? { kind: "accepted", entry, body: answer.body } : { kind: "refused", entry, message: answer.message });
    this.ports.onChange();
  }
}
