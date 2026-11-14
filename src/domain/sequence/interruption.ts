/**
 * Interruptions (ADR 0003 "Ticket 20a"): what one is, what it does to a lead (nothing: it is not a
 * pause), and which sends it rescheduled, for the one-line notice. Pure: the engine passes the
 * heartbeat it stored and the instant sending resumed.
 */
import { isLive, isUncertain } from "./attempt.ts";
import { leadNow, nextWindowOpen, type Freeze } from "./clock.ts";
import { heldReason, windowOf } from "./dispatch.ts";
import { channelOf, wallAtLead } from "./progress.ts";
import type { SubjectState } from "./state.ts";

/** A gap between heartbeats longer than this is an interruption: twenty of the worker's 15-second ticks. */
export const INTERRUPTION_GAP = 5 * 60_000;

/** An interval in which the application could not send: from the last heartbeat to the tick that resumed sending. */
export interface Interruption {
  readonly from: number;
  readonly to: number;
}

/** The interruption ending at `now`, if the last heartbeat is more than INTERRUPTION_GAP before it; none before the first heartbeat. */
export function interruptionOf(lastHeartbeat: number | null, now: number): Interruption | null {
  if (lastHeartbeat === null || now - lastHeartbeat <= INTERRUPTION_GAP) return null;
  return { from: lastHeartbeat, to: now };
}

/**
 * What an interruption does to a lead: nothing. Lead time runs through it, every stored deadline
 * stays, every hold stands; recovery is the worker's ordinary passes. The seam exists so the
 * generated runs can prove they would see a recovery that froze, skipped or released.
 */
export const afterInterruption: (state: SubjectState, interruption: Interruption, now: number) => SubjectState = (state) => state;

/** The parts of `[from, to)` in which the lead ran: outside every frozen interval (an open one runs to `now`). */
function runningSpans(freezes: readonly Freeze[], from: number, to: number, now: number): { from: number; to: number }[] {
  const frozen = freezes.map((f) => ({ from: f.fromWall, to: f.toWall ?? now })).sort((a, b) => a.from - b.from);
  const spans: { from: number; to: number }[] = [];
  let cursor = from;
  for (const f of frozen) {
    if (f.to <= cursor) continue;
    if (f.from >= to) break;
    if (f.from > cursor) spans.push({ from: cursor, to: f.from });
    cursor = Math.max(cursor, f.to);
  }
  if (cursor < to) spans.push({ from: cursor, to });
  return spans;
}

/**
 * The sends the interruption `[from, to)` rescheduled for this lead (ADR 0003 "Ticket 20a"): each
 * pending email or SMS step with no result, nothing of it with a provider, on a track not held, of
 * a lead that has not ended, which at some instant of the interruption was due while the lead ran
 * and its window was open. Read at `now`, the instant sending resumed, after evaluation.
 */
export function rescheduledSteps(state: SubjectState, interruption: Interruption, now: number): { trackId: string; stepId: string }[] {
  if (state.subject.ended !== null) return [];
  const out: { trackId: string; stepId: string }[] = [];
  for (const p of state.tracks) {
    if (p.startedAt === null || p.finishedAt !== null || p.nextStepId === null || p.dueAt === null) continue;
    const channel = channelOf(state, p.trackId);
    if (channel !== "email" && channel !== "sms") continue;
    const stepId = p.nextStepId;
    if (state.results.some((r) => r.stepId === stepId)) continue;
    if (state.attempts.some((a) => a.stepId === stepId && isLive(a) && a.state !== "claimed")) continue;
    if (state.work.some((w) => w.stepId === stepId && isUncertain(w))) continue;
    if (heldReason(state, p.trackId, now) !== null) continue;
    // The wall instant lead time reached the due time while running (3.3); not yet reached, not due.
    if (leadNow(state.subject.clock, now) < p.dueAt) continue;
    const due = wallAtLead(state.subject.clock, state.freezes, p.dueAt, now);
    const window = windowOf(state, p.trackId);
    const sendable = runningSpans(state.freezes, Math.max(interruption.from, due), interruption.to, now).some((span) => {
      const opens = nextWindowOpen(window, state.lead.zone, span.from);
      return opens !== null && opens < span.to;
    });
    if (sendable) out.push({ trackId: p.trackId, stepId });
  }
  return out;
}
