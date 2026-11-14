/**
 * What the worker records about itself in the store's `meta` (ADR 0003 "Ticket 20a"), and the reads built from it:
 * the heartbeat, the current interruption notice, the last tick's end and failure, and the lease that keeps one
 * worker per database. A value that cannot be parsed reads as absent: nothing is invented from it (the boundary).
 */
import { INTERRUPTION_GAP } from "../../domain/sequence/interruption.ts";
import type { EngineStore, WorkerLease } from "./engine-store.ts";

/** The last instant a tick completed with every port answering (or the instant sending resumed). */
export const HEARTBEAT_KEY = "engine_heartbeat";
/** The current interruption notice: `{ from, to, rescheduled }`; one line, replaced by the next. */
export const NOTICE_KEY = "engine_interruption";
/** The last instant a tick ended, whatever its ports answered. */
export const TICK_ENDED_KEY = "engine_tick_ended";
/** The last instant a tick threw. */
export const TICK_FAILED_KEY = "engine_tick_failed";
/** The last read of a provider that failed: `{ channel, part, at }` (ticket 20a: a partial answer is not contact). */
export const FAILED_READ_KEY = "engine_failed_read";
/** The worker's lease: `WorkerLease` as JSON. */
export const LEASE_KEY = "worker_lease";

export interface InterruptionNotice {
  readonly from: number;
  readonly to: number;
  readonly rescheduled: number;
}

export type InterruptionCause = "ticks_failing" | "providers_unreachable" | "worker_stalled";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function parseInstant(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function parseNotice(raw: string | null): InterruptionNotice | null {
  try {
    const v = raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
    return v && finite(v["from"]) && finite(v["to"]) && finite(v["rescheduled"]) ? { from: v["from"], to: v["to"], rescheduled: v["rescheduled"] } : null;
  } catch {
    return null;
  }
}

export function parseLease(raw: string | null): WorkerLease | null {
  try {
    const v = raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
    return v && typeof v["id"] === "string" && finite(v["pid"]) && finite(v["renewedWall"]) ? { id: v["id"], pid: v["pid"], renewedWall: v["renewedWall"] } : null;
  } catch {
    return null;
  }
}

export async function interruptionNotice(store: Pick<EngineStore, "meta">): Promise<InterruptionNotice | null> {
  return parseNotice(await store.meta(NOTICE_KEY));
}

/**
 * Whether sending is interrupted now (follow-up 42 item 45): no heartbeat for more than INTERRUPTION_GAP while the
 * application serves this read, so due sends and calls may be waiting. Why, from what the worker recorded: the last tick
 * to end threw; the last tick ended but a provider did not answer; or no tick has ended since the heartbeat. A database
 * no worker has run on yet (no heartbeat) is not interrupted: nothing is due on it that a worker missed.
 */
export interface FailedRead {
  readonly channel: "email" | "sms";
  readonly part: "accounts" | "observation";
  readonly at: number;
}

export function parseFailedRead(raw: string | null): FailedRead | null {
  try {
    const v = raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
    return v && (v["channel"] === "email" || v["channel"] === "sms") && (v["part"] === "accounts" || v["part"] === "observation") && finite(v["at"]) ? { channel: v["channel"], part: v["part"], at: v["at"] } : null;
  } catch {
    return null;
  }
}

export async function sendingInterrupted(store: Pick<EngineStore, "meta">, now: number): Promise<{ readonly since: number; readonly cause: InterruptionCause; readonly lastFailedRead: FailedRead | null } | null> {
  const heartbeat = parseInstant(await store.meta(HEARTBEAT_KEY));
  if (heartbeat === null || now - heartbeat <= INTERRUPTION_GAP) return null;
  const ended = parseInstant(await store.meta(TICK_ENDED_KEY)) ?? -Infinity;
  const failed = parseInstant(await store.meta(TICK_FAILED_KEY)) ?? -Infinity;
  const cause: InterruptionCause = failed > heartbeat && failed >= ended ? "ticks_failing" : ended > heartbeat ? "providers_unreachable" : "worker_stalled";
  // The provider read that failed last since the heartbeat, if any: which channel and which part.
  const failedRead = parseFailedRead(await store.meta(FAILED_READ_KEY));
  return { since: heartbeat, cause, lastFailedRead: failedRead !== null && failedRead.at > heartbeat ? failedRead : null };
}
