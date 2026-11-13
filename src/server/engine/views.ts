/** Read models for the HTTP interface, built from the engine's stored facts. */
import { isLive } from "../../domain/sequence/attempt.ts";
import { leadNow } from "../../domain/sequence/clock.ts";
import { heldReason, stalledAccounts } from "../../domain/sequence/dispatch.ts";
import { deriveStatus, liveTracksFor } from "../../domain/sequence/progress.ts";
import type { AccountState, SubjectState } from "../../domain/sequence/state.ts";
import type { EnrollmentProgress, NeedsAttention, SenderAccountViewApi } from "../../shared/api.ts";
import type { EngineStore } from "./engine-store.ts";

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

export function progressView(s: SubjectState, now: number): EnrollmentProgress {
  const reply = s.subject.ended === "replied" ? s.replies.at(-1) : undefined;
  const lead = leadNow(s.subject.clock, now);
  const running = s.subject.clock.frozenSince === null;
  return {
    id: s.subject.id,
    campaignId: s.campaign.id,
    status: deriveStatus(s),
    endedAt: iso(s.subject.endedWall),
    reply: reply ? { channel: reply.channel, at: new Date(reply.atWall).toISOString() } : null,
    sender: s.subject.emailSender,
    zone: s.lead.zone,
    tracks: [...liveTracksFor(s), ...s.campaign.definition.tracks.filter((t) => t.removed && !liveTracksFor(s).includes(t))]
      .filter((t) => !t.removed || s.tracks.some((p) => p.trackId === t.id))
      .map((track) => {
        const p = s.tracks.find((x) => x.trackId === track.id);
        const numberOf = (stepId: string) => track.steps.filter((st) => !st.removed).findIndex((st) => st.id === stepId) + 1;
        return {
          trackId: track.id,
          channel: track.channel,
          started: p?.startedAt != null,
          finishReason: p?.finishReason ?? null,
          finishedAt: iso(p?.finishedWall ?? null),
          hold: heldReason(s, track.id, now),
          nextStep:
            p && p.finishedAt === null && p.nextStepId !== null && p.dueAt !== null
              ? { stepId: p.nextStepId, number: numberOf(p.nextStepId), dueAt: new Date(running ? now + (p.dueAt - lead) : (p.dueWall ?? now)).toISOString() }
              : null,
          steps: track.steps.map((st, i) => {
            const result = s.results.find((r) => r.stepId === st.id);
            return {
              stepId: st.id,
              number: i + 1,
              removed: st.removed,
              result: result?.result ?? null,
              reason: result?.reason ?? null,
              at: iso(result?.atWall ?? null),
              sends: s.attempts
                .filter((a) => a.stepId === st.id)
                .map((a) => ({
                  attemptId: a.id,
                  state: a.state,
                  sender: a.accountId,
                  destination: a.destination,
                  copy: a.copy,
                  handedAt: iso(a.handedWall),
                  sentAt: iso(a.sentWall),
                  endedBy: a.endedBy,
                  rejectReason: a.rejectReason,
                  unresolved: isLive(a) && a.unresolvedSince !== null,
                })),
            };
          }),
        };
      }),
  };
}

export function accountView(a: AccountState, label: string): SenderAccountViewApi {
  return {
    id: a.id,
    label,
    channel: "email",
    healthy: a.healthy,
    capacity: a.capacity,
    gapSeconds: Math.round(a.gapMs / 1000),
    usedToday: a.used,
    waiting: a.waitReason,
  };
}

export async function needsAttention(store: EngineStore, now: number): Promise<NeedsAttention> {
  const accounts = await store.accounts(now);
  const open = (await store.openAttempts()).filter((a) => isLive(a));
  const heldTracks: NeedsAttention["heldTracks"][number][] = [];
  for (const id of await store.runningSubjectIds()) {
    const s = await store.subject(id, now);
    if (!s) continue;
    for (const p of s.tracks) {
      const reason = heldReason(s, p.trackId, now);
      if (reason) heldTracks.push({ enrollmentId: id, trackId: p.trackId, reason });
    }
  }
  return {
    stalledInboxes: stalledAccounts(accounts, open, now),
    heldTracks,
    accountWaits: accounts.flatMap((a) =>
      a.waitReason !== null && (a.waitUntil === null || a.waitUntil > now)
        ? [{ accountId: a.id, reason: a.waitReason, until: a.waitReason === "quota" ? null : iso(a.waitUntil) }]
        : [],
    ),
    anomalies: (await store.anomalies()).map((x) => ({ what: x.what, at: new Date(x.atWall).toISOString() })),
  };
}
