/**
 * The controls' requests (ticket 17b): pause, resume, skip, stop and the restarts of a lead, and a campaign's pause and
 * resume, on the call desk's rule (ADR 0003 4.4.1), with no lock:
 *
 * - **A press is stored before its first send**, in shared storage (`localStorage`), under the request id made at the
 *   press, with **what its confirmation showed** (`expect`: the lead's status and its preview's digest, or the
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
import { channelOfMark, type MarkRepliedControl } from "../campaign/reply-mark-wording.ts";
import type { LeadControlApi, OutreachStatus } from "../../shared/api.ts";
import type { KeyValue } from "../calls/callDesk.ts";

export type ControlTarget = { readonly kind: "lead"; readonly id: string } | { readonly kind: "campaign"; readonly id: string };

/** What a lead control's confirmation showed: the lead's status, and its preview's digest (the whole preview: verifier R1 on 57d874f). */
export interface LeadExpectation {
  readonly status: OutreachStatus;
  readonly preview: string;
}
/** What a campaign's pause or resume confirmation showed: the pause read. */
export interface CampaignExpectation {
  readonly pausedSince: string | null;
}

/**
 * What a record's control press can be: a lead control, the LinkedIn reply mark, or one of the two answers to a withdrawal
 * LinkedIn never confirmed (ticket 24b; ADR 0004 sections 3.3 and 7). Each is stored and sent on the same rule.
 */
export type RecordControl = LeadControlApi | MarkRepliedControl | "invite_withdrawn" | "invite_kept";

export interface PressEntry {
  readonly v: 2;
  readonly requestId: string;
  readonly target: ControlTarget;
  readonly action: RecordControl;
  /** For a withdrawal answer: the LinkedIn track it is about. */
  readonly trackId?: string;
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
    if (!(typeof value === "object" && value !== null && "v" in value && value.v === 2 && "requestId" in value && typeof value.requestId === "string")) return null;
    // A mark stored before ticket 25 named no channel: it could only be LinkedIn's (ADR 0004 13.8).
    const entry = value as PressEntry | (Omit<PressEntry, "action"> & { action: "mark_replied" });
    return entry.action === "mark_replied" ? { ...entry, action: "mark_replied:linkedin" } : (entry as PressEntry);
  } catch {
    return null;
  }
}

/** The route and body a stored press is sent with, every send the same (the server binds a request id to its first body). */
export function controlRequestOf(entry: PressEntry): { readonly path: string; readonly body: Record<string, unknown> } {
  const { target } = entry;
  const id = encodeURIComponent(target.id);
  if (target.kind === "campaign") return { path: `/api/campaigns/${id}/${entry.action}`, body: { requestId: entry.requestId, expect: entry.expect } };
  // The mark is confirmed on the status the read showed (ADR 0004 section 7: `expect` holds the status only), on its own channel.
  const markChannel = channelOfMark(entry.action);
  if (markChannel !== null) return { path: `/api/enrollments/${id}/replies`, body: { requestId: entry.requestId, channel: markChannel, expect: { status: (entry.expect as LeadExpectation).status } } };
  switch (entry.action) {
    case "invite_withdrawn":
    case "invite_kept":
      return { path: `/api/enrollments/${id}/invite-withdrawal`, body: { requestId: entry.requestId, trackId: entry.trackId ?? "", answer: entry.action === "invite_withdrawn" ? "withdrawn" : "kept" } };
    default:
      // Every send carries what the confirmation showed: the server applies the control only while it still holds (ticket 17b).
      return { path: `/api/enrollments/${id}/controls`, body: { requestId: entry.requestId, action: entry.action, expect: entry.expect } };
  }
}

export class ControlRequests {
  private readonly ports: ControlRequestPorts;
  /**
   * The generation this page's requests belong to (council on 57d874f, item 5). `stop` ends one and `start` begins the
   * next: a send records the generation it was made in, and one from an older generation neither counts as in flight nor
   * decides anything when it settles (its answer is dropped, nothing is rescheduled). One rule for every stop and start,
   * React's setup, cleanup and setup in development included (the replay review bot P2 on 07fab27 found first).
   */
  private generation = 0;
  /** Per request id: the generation of the send in flight from this page, and the timer of its next send. */
  private readonly inFlight = new Map<string, number>();
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
  press(target: ControlTarget, action: RecordControl, expect: LeadExpectation | CampaignExpectation, trackId?: string): Promise<PressOutcome> {
    // This page offers no control while it sees a press on its way for the target; another tab's press made at the same
    // moment is the server's to judge, by its precondition.
    if (this.halted() || this.pendingFor(target)) return Promise.resolve({ ok: false, why: "busy" });
    const entry: PressEntry = { v: 2, requestId: this.ports.newId(), target, action, expect, pressedAt: this.ports.now(), ...(trackId !== undefined ? { trackId } : {}) };
    if (!this.ports.local.set(keyOf(entry.requestId), JSON.stringify(entry))) return Promise.resolve({ ok: false, why: "unstored" });
    this.ports.onChange();
    void this.send(entry.requestId);
    return Promise.resolve({ ok: true, entry });
  }

  /** The targets a page shows: a stored press for any of them is sent once on first sight, then on its own backoff. */
  watch(targets: readonly ControlTarget[]): void {
    for (const e of this.stored()) {
      if (!targets.some((t) => sameTarget(t, e.target))) continue;
      if (this.inFlight.get(e.requestId) !== this.generation && !this.timers.has(e.requestId)) void this.send(e.requestId);
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

  /** The page stops: its generation ends, its timers end, its sends in flight are let go, and every press stays stored. */
  stop(): void {
    this.stopped = true;
    this.generation++;
    this.signalStop();
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
  }

  /** Read through a method: `stop` may run while a send is awaited. */
  private halted(): boolean {
    return this.stopped;
  }

  private async send(requestId: string): Promise<void> {
    const generation = this.generation;
    if (this.halted() || this.inFlight.get(requestId) === generation) return;
    // Sent only while it is still stored: an answer another page got removed it.
    const entry = parse(this.ports.local.get(keyOf(requestId)));
    if (!entry) return;
    this.inFlight.set(requestId, generation);
    let answer: SendAnswer | "stopped" | null = null;
    try {
      answer = await Promise.race([this.ports.send(entry), this.stopping]);
    } catch {
      answer = null;
    }
    if (this.inFlight.get(requestId) === generation) this.inFlight.delete(requestId);
    // A send of an ended generation decides nothing: the generation after it sends the press itself.
    if (answer === "stopped" || generation !== this.generation || this.halted()) return;
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

/**
 * Which answer a row shows after `incoming` arrives (verifier R2 on 57d874f): each tab's line belongs to its own press. An
 * answer to this tab's press (`own`, by request id) replaces what is shown; an answer to another tab's press shows only
 * when nothing of this tab's own is shown, and never replaces it. The row's read is refreshed either way.
 */
export function shownResult(current: ControlResult | null, incoming: ControlResult, own: ReadonlySet<string>): ControlResult | null {
  if (own.has(incoming.entry.requestId)) return incoming;
  if (current !== null && own.has(current.entry.requestId)) return current;
  return incoming;
}
