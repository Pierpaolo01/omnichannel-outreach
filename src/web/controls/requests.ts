/**
 * The controls' requests (ticket 17b): pause, resume, skip, stop and the restarts of a lead, and a campaign's pause and
 * resume, on the call desk's rule (ADR 0003 4.4.1), with no lock:
 *
 * - **A press is stored before its first send**, in shared storage (`localStorage`), under the request id made at the
 *   press, with **what its confirmation showed** (`expect`: the lead's status and the step its preview named, or the
 *   campaign's pause). A press storage will not take is not sent: one the page could not track could not be recovered.
 * - **Any page sends any stored press for the leads or campaigns it shows**: once when it first sees it, then only on that
 *   press's own backoff (1, 2, 4, 8 seconds, then every 8). Every send reads the stored press, so a retry, a reload or
 *   another tab sends the same id and body, and the server, which binds an id to its first answer, applies it once.
 *   Nothing waits behind a request that never answers.
 * - **Two presses confirmed on one read, from two tabs, are two requests**; the server applies one and refuses the other,
 *   because its precondition no longer holds (coordinator's ruling on the verifier's B1 at 8a1732a), and that refusal is
 *   shown in place like any other. A page offers no control on a target while it sees a press on its way for it.
 * - **A definite answer removes the press** (accepted, or refused with the server's reason). Nothing else is kept: what the
 *   page shows comes from the server's read, refreshed after each answer and on every storage event.
 */
import type { LeadControlApi, OutreachStatus } from "../../shared/api.ts";
import type { KeyValue } from "../calls/callDesk.ts";

export type ControlTarget = { readonly kind: "lead"; readonly id: string } | { readonly kind: "campaign"; readonly id: string };

/** What a lead control's confirmation showed: the lead's status, and the step a skip skips or a restart resumes at. */
export interface LeadExpectation {
  readonly status: OutreachStatus;
  readonly step: string | null;
}
/** What a campaign's pause or resume confirmation showed: the pause read. */
export interface CampaignExpectation {
  readonly pausedSince: string | null;
}

export interface PressEntry {
  readonly v: 2;
  readonly requestId: string;
  readonly target: ControlTarget;
  readonly action: LeadControlApi;
  readonly expect: LeadExpectation | CampaignExpectation;
  /** When it was pressed, on this device's clock: presses on one target are taken oldest first. */
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
export const isControlKey = (key: string | null): boolean => key?.startsWith(PREFIX) ?? false;
const keyOf = (requestId: string): string => `${PREFIX}${requestId}`;
/** A target's name, for the page's own maps. */
export const controlKey = (target: ControlTarget): string => `${target.kind}:${target.id}`;
const sameTarget = (a: ControlTarget, b: ControlTarget): boolean => a.kind === b.kind && a.id === b.id;

function parse(text: string | null): PressEntry | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && "v" in value && value.v === 2 && "requestId" in value && typeof value.requestId === "string" ? (value as PressEntry) : null;
  } catch {
    return null;
  }
}

export class ControlRequests {
  private readonly ports: ControlRequestPorts;
  /** Per request id: a send in flight from this page, and the timer of its next send. */
  private readonly inFlight = new Set<string>();
  private readonly timers = new Map<string, () => void>();
  private readonly attempts = new Map<string, number>();
  /** Request ids whose last send here had no answer. */
  private readonly unanswered = new Set<string>();
  private stopped = false;
  /** Settles when the page stops: a send still in flight is let go then, and its answer, if it comes, is dropped. */
  private stopping: Promise<"stopped">;
  private signalStop: () => void = () => undefined;

  constructor(ports: ControlRequestPorts) {
    this.ports = ports;
    this.stopping = this.stopSignal();
  }

  private stopSignal(): Promise<"stopped"> {
    return new Promise<"stopped">((resolve) => (this.signalStop = () => resolve("stopped")));
  }

  /** Every stored press, oldest first. */
  private stored(): PressEntry[] {
    return this.ports.local
      .keys()
      .filter(isControlKey)
      .flatMap((k) => {
        const e = parse(this.ports.local.get(k));
        return e ? [e] : [];
      })
      .sort((a, b) => a.pressedAt - b.pressedAt || a.requestId.localeCompare(b.requestId));
  }

  /** The oldest press stored for a target, whichever tab made it. */
  pendingFor(target: ControlTarget): PressEntry | null {
    return this.stored().find((e) => sameTarget(e.target, target)) ?? null;
  }

  /** A stored press for this target had no answer at its last send from this page. */
  unconfirmed(target: ControlTarget): boolean {
    return this.stored().some((e) => sameTarget(e.target, target) && this.unanswered.has(e.requestId));
  }

  /** Stores a press under a new request id, with what its confirmation showed, then sends it. */
  press(target: ControlTarget, action: LeadControlApi, expect: LeadExpectation | CampaignExpectation): Promise<PressOutcome> {
    // This page offers no control while it sees a press on its way for the target; another tab's press made at the same
    // moment is the server's to judge, by its precondition.
    if (this.halted() || this.pendingFor(target)) return Promise.resolve({ ok: false, why: "busy" });
    const entry: PressEntry = { v: 2, requestId: this.ports.newId(), target, action, expect, pressedAt: this.ports.now() };
    if (!this.ports.local.set(keyOf(entry.requestId), JSON.stringify(entry))) return Promise.resolve({ ok: false, why: "unstored" });
    this.ports.onChange();
    void this.send(entry.requestId);
    return Promise.resolve({ ok: true, entry });
  }

  /** The targets a page shows: a stored press for any of them is sent once on first sight, then on its own backoff. */
  watch(targets: readonly ControlTarget[]): void {
    for (const e of this.stored()) {
      if (!targets.some((t) => sameTarget(t, e.target))) continue;
      if (!this.inFlight.has(e.requestId) && !this.timers.has(e.requestId)) void this.send(e.requestId);
    }
  }

  /** Another tab changed a press: show it, and take up what is stored for these targets. */
  storageChanged(targets: readonly ControlTarget[]): void {
    this.watch(targets);
    this.ports.onChange();
  }

  /** Try again now: every press waiting out its backoff here is sent at once, with its own id. */
  retryNow(): void {
    for (const [id, cancel] of [...this.timers]) {
      cancel();
      this.timers.delete(id);
      void this.send(id);
    }
  }

  /** The page shows these controls again (React sets an effect up again after its cleanup in development). */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.stopping = this.stopSignal();
  }

  /** The page stops: its timers end, its sends in flight are let go, and every press stays stored for the next page. */
  stop(): void {
    this.stopped = true;
    this.signalStop();
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
  }

  /** Read through a method: `stop` may run while a send is awaited. */
  private halted(): boolean {
    return this.stopped;
  }

  private async send(requestId: string): Promise<void> {
    if (this.halted() || this.inFlight.has(requestId)) return;
    // Sent only while it is still stored: an answer another page got removed it.
    const entry = parse(this.ports.local.get(keyOf(requestId)));
    if (!entry) return;
    this.inFlight.add(requestId);
    let answer: SendAnswer | "stopped" | null = null;
    try {
      answer = await Promise.race([this.ports.send(entry), this.stopping]);
    } catch {
      answer = null;
    }
    this.inFlight.delete(requestId);
    if (answer === "stopped" || this.halted()) return;
    if (answer === null) {
      this.unanswered.add(requestId);
      const n = this.attempts.get(requestId) ?? 0;
      this.attempts.set(requestId, n + 1);
      this.timers.set(
        requestId,
        this.ports.setTimer(() => {
          this.timers.delete(requestId);
          void this.send(requestId);
        }, CONTROL_RETRY_MS[Math.min(n, CONTROL_RETRY_MS.length - 1)] ?? 8_000),
      );
      this.ports.onChange();
      return;
    }
    this.unanswered.delete(requestId);
    this.attempts.delete(requestId);
    this.ports.local.remove(keyOf(requestId));
    this.ports.onResult(answer.kind === "accepted" ? { kind: "accepted", entry, body: answer.body } : { kind: "refused", entry, message: answer.message });
    this.ports.onChange();
  }
}
