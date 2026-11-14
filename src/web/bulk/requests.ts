/**
 * Bulk presses on Leads (ticket 18; ADR 0003 "Ticket 18"), on the controls' request rule (17b, ADR 0003 4.4.1):
 *
 * - **A press is stored before its first send**, in shared storage (`localStorage`), under its bulk id, with the body its
 *   confirmation built: the confirmation's allowed items, each with the precondition its read showed, or, for add, the
 *   selected rows. A press storage will not take is not sent.
 * - **Any Leads page sends any stored bulk press**: once when it first sees it, then on that press's own backoff (1, 2, 4,
 *   8 seconds, then every 8). Every send reads the stored body, so a retry, a reload or another tab sends the same bulk id
 *   and items, and the server answers each per-lead request id with its first answer: nothing is applied twice.
 * - **A definite answer removes the press** (the per-lead answers, or a refusal of the whole bulk). The page shows it and
 *   reads the rows again.
 * - **One bulk at a time on this device**: while a press is stored, no other is made, so two bulks never race each other
 *   from one browser. Two browsers are the server's to judge, lead by lead.
 */
import type { BulkAction } from "../../shared/api.ts";
import type { KeyValue } from "../calls/callDesk.ts";

/** What the confirmation showed of each item, so any tab can word the answer: whose enrollment, in which campaign. */
export interface BulkLabel {
  readonly name: string;
  readonly campaign: string;
}

export interface BulkPress {
  readonly v: 1;
  readonly bulkId: string;
  readonly action: BulkAction;
  /** The request body, without the bulk id: fixed at the press. */
  readonly body: Readonly<Record<string, unknown>>;
  /** By enrollment id (a control) or row key `kind:id` (add). */
  readonly labels: Readonly<Record<string, BulkLabel>>;
  /** The campaign the confirmation named (the scope, or the one added to); null for every campaign. */
  readonly campaign: string | null;
  readonly pressedAt: number;
}

export type BulkSendAnswer = { readonly kind: "answered"; readonly body: unknown } | { readonly kind: "refused"; readonly message: string };
export type BulkResult = { readonly kind: "answered"; readonly press: BulkPress; readonly body: unknown } | { readonly kind: "refused"; readonly press: BulkPress; readonly message: string };
export type BulkPressOutcome = { readonly ok: true; readonly press: BulkPress } | { readonly ok: false; readonly why: "busy" | "unstored" };

export class NoBulkAnswer extends Error {
  constructor() {
    super("No answer from the server.");
  }
}

/** Backoff after a send with no answer, in milliseconds; the last repeats. */
export const BULK_RETRY_MS = [1_000, 2_000, 4_000, 8_000] as const;

export interface BulkRequestPorts {
  readonly local: KeyValue;
  newId(): string;
  now(): number;
  setTimer(fire: () => void, ms: number): () => void;
  /** One send. Resolves with a definite answer; throws when there is none. */
  send(press: BulkPress): Promise<BulkSendAnswer>;
  onResult(result: BulkResult): void;
  onChange(): void;
}

const PREFIX = "outreach.bulk.";
export const isBulkKey = (key: string | null): boolean => key?.startsWith(PREFIX) ?? false;
const keyOf = (bulkId: string) => `${PREFIX}${bulkId}`;

function parse(text: string | null): BulkPress | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && "v" in value && value.v === 1 && "bulkId" in value && typeof value.bulkId === "string" ? (value as BulkPress) : null;
  } catch {
    return null;
  }
}

export class BulkRequests {
  private readonly ports: BulkRequestPorts;
  /** As the controls' requests (17b): a stop ends a generation, and a send of an ended one decides nothing. */
  private generation = 0;
  private readonly inFlight = new Map<string, number>();
  private readonly timers = new Map<string, () => void>();
  private readonly attempts = new Map<string, number>();
  private readonly unanswered = new Set<string>();
  private stopped = false;
  private stopping: Promise<"stopped">;
  private signalStop: () => void = () => undefined;

  constructor(ports: BulkRequestPorts) {
    this.ports = ports;
    this.stopping = this.stopSignal();
  }

  private stopSignal(): Promise<"stopped"> {
    return new Promise<"stopped">((resolve) => (this.signalStop = () => resolve("stopped")));
  }

  /** Every stored bulk press, oldest first. */
  stored(): BulkPress[] {
    return this.ports.local
      .keys()
      .filter(isBulkKey)
      .flatMap((k) => {
        const p = parse(this.ports.local.get(k));
        return p ? [p] : [];
      })
      .sort((a, b) => a.pressedAt - b.pressedAt || a.bulkId.localeCompare(b.bulkId));
  }

  /** The oldest stored press, whichever tab made it. */
  pending(): BulkPress | null {
    return this.stored()[0] ?? null;
  }

  /** The stored press had no answer at its last send from this page. */
  unconfirmed(): boolean {
    return this.stored().some((p) => this.unanswered.has(p.bulkId));
  }

  /** Stores a press under a new bulk id, then sends it. */
  press(action: BulkAction, body: Readonly<Record<string, unknown>>, labels: BulkPress["labels"], campaign: string | null): BulkPressOutcome {
    if (this.stopped || this.pending()) return { ok: false, why: "busy" };
    const press: BulkPress = { v: 1, bulkId: this.ports.newId(), action, body, labels, campaign, pressedAt: this.ports.now() };
    if (!this.ports.local.set(keyOf(press.bulkId), JSON.stringify(press))) return { ok: false, why: "unstored" };
    this.ports.onChange();
    void this.send(press.bulkId);
    return { ok: true, press };
  }

  /** Every stored press is sent once on first sight, then on its own backoff. */
  watch(): void {
    for (const p of this.stored()) if (this.inFlight.get(p.bulkId) !== this.generation && !this.timers.has(p.bulkId)) void this.send(p.bulkId);
  }

  storageChanged(): void {
    this.watch();
    this.ports.onChange();
  }

  retryNow(): void {
    for (const [id, cancel] of [...this.timers]) {
      cancel();
      this.timers.delete(id);
      void this.send(id);
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.stopping = this.stopSignal();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.signalStop();
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
  }

  private halted(): boolean {
    return this.stopped;
  }

  private async send(bulkId: string): Promise<void> {
    const generation = this.generation;
    if (this.halted() || this.inFlight.get(bulkId) === generation) return;
    const press = parse(this.ports.local.get(keyOf(bulkId)));
    if (!press) return;
    this.inFlight.set(bulkId, generation);
    let answer: BulkSendAnswer | "stopped" | null = null;
    try {
      answer = await Promise.race([this.ports.send(press), this.stopping]);
    } catch {
      answer = null;
    }
    if (this.inFlight.get(bulkId) === generation) this.inFlight.delete(bulkId);
    if (answer === "stopped" || generation !== this.generation || this.halted()) return;
    if (answer === null) {
      this.unanswered.add(bulkId);
      const n = this.attempts.get(bulkId) ?? 0;
      this.attempts.set(bulkId, n + 1);
      this.timers.set(
        bulkId,
        this.ports.setTimer(() => {
          this.timers.delete(bulkId);
          void this.send(bulkId);
        }, BULK_RETRY_MS[Math.min(n, BULK_RETRY_MS.length - 1)] ?? 8_000),
      );
      this.ports.onChange();
      return;
    }
    this.unanswered.delete(bulkId);
    this.attempts.delete(bulkId);
    this.ports.local.remove(keyOf(bulkId));
    this.ports.onResult(answer.kind === "answered" ? { kind: "answered", press, body: answer.body } : { kind: "refused", press, message: answer.message });
    this.ports.onChange();
  }
}
