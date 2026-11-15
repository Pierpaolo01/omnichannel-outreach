/**
 * What the worker records about itself in the store's `meta` (ADR 0003 "Ticket 20a"), and the reads built from it:
 * the heartbeat, the current interruption notice, the last tick's end and failure, and the lease that keeps one
 * worker per database. A value that cannot be parsed reads as absent: nothing is invented from it (the boundary).
 */
import { INTERRUPTION_GAP } from "../../domain/sequence/interruption.ts";
import type { ProviderEvidence } from "../../domain/sequence/providers.ts";
import type { EngineStore, WorkerLease } from "./engine-store.ts";

/** The last instant a tick completed with every port answering (or the instant sending resumed). */
export const HEARTBEAT_KEY = "engine_heartbeat";
/** The current interruption notice: `{ from, to, rescheduled }`; one line, replaced by the next. */
export const NOTICE_KEY = "engine_interruption";
/** The last instant a tick ended, whatever its ports answered. */
export const TICK_ENDED_KEY = "engine_tick_ended";
/** The last instant a tick threw. */
export const TICK_FAILED_KEY = "engine_tick_failed";
/**
 * Each provider's evidence (ticket 20a, council G): its last contact and how long that stands, and its last failed read
 * with its part (`ProviderEvidence` per channel, as JSON). The gate and the reads decide by it.
 */
export const PROVIDERS_KEY = "engine_providers";
/** The worker's lease: `WorkerLease` as JSON. */
export const LEASE_KEY = "worker_lease";

export interface InterruptionNotice {
  readonly from: number;
  readonly to: number;
  readonly rescheduled: number;
}

export type InterruptionCause = "ticks_failing" | "providers_unreachable" | "not_running";

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
  readonly part: "accounts" | "observation" | "call";
  readonly at: number;
}

const emptyEvidence: ProviderEvidence = { contactAt: null, freshForMs: 0, failedAt: null, failedPart: null };

/** The providers' evidence as the worker last saved it; a value that cannot be parsed is no evidence. */
export function parseEvidence(raw: string | null): Record<"email" | "sms", ProviderEvidence> {
  const one = (v: unknown): ProviderEvidence => {
    if (typeof v !== "object" || v === null) return emptyEvidence;
    const o = v as Record<string, unknown>;
    const n = (x: unknown) => (finite(x) ? x : null);
    const part = o["failedPart"] === "accounts" || o["failedPart"] === "observation" || o["failedPart"] === "call" ? o["failedPart"] : null;
    return { contactAt: n(o["contactAt"]), freshForMs: n(o["freshForMs"]) ?? 0, failedAt: n(o["failedAt"]), failedPart: part };
  };
  try {
    const v = raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
    return { email: one(v?.["email"]), sms: one(v?.["sms"]) };
  } catch {
    return { email: emptyEvidence, sms: emptyEvidence };
  }
}

export async function providerEvidence(store: Pick<EngineStore, "meta">): Promise<Record<"email" | "sms", ProviderEvidence>> {
  return parseEvidence(await store.meta(PROVIDERS_KEY));
}

export async function sendingInterrupted(
  store: Pick<EngineStore, "meta">,
  now: number,
): Promise<{ readonly since: number; readonly cause: InterruptionCause; readonly lastFailedRead: FailedRead | null; readonly lastRoundFailedAt: number | null } | null> {
  const heartbeat = parseInstant(await store.meta(HEARTBEAT_KEY));
  if (heartbeat === null || now - heartbeat <= INTERRUPTION_GAP) return null;
  const ended = parseInstant(await store.meta(TICK_ENDED_KEY)) ?? -Infinity;
  const failed = parseInstant(await store.meta(TICK_FAILED_KEY)) ?? -Infinity;
  // From evidence, not timing (council G): a tick that threw and none ended since; a provider read that failed since the
  // heartbeat; otherwise the worker has not been running (stopped, asleep, or a tick that never ends).
  const evidence = await providerEvidence(store);
  const failures = (["email", "sms"] as const).flatMap((channel) => {
    const e = evidence[channel];
    return e.failedAt !== null && e.failedPart !== null && e.failedAt > heartbeat ? [{ channel, part: e.failedPart, at: e.failedAt }] : [];
  });
  const cause: InterruptionCause = failed > heartbeat && failed >= ended ? "ticks_failing" : failures.length > 0 ? "providers_unreachable" : "not_running";
  // The provider read that failed last since the heartbeat, if any: which channel and which part.
  const lastFailedRead = failures.sort((a, b) => b.at - a.at)[0] ?? null;
  // The last round that threw since the heartbeat (ticket 20b, council on 7622b8b): rounds may have ended in between.
  return { since: heartbeat, cause, lastFailedRead, lastRoundFailedAt: failed > heartbeat ? failed : null };
}
