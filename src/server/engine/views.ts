/** Read models for the HTTP interface, built from the engine's stored facts. */
import { isLive, markable } from "../../domain/sequence/attempt.ts";
import { callNumbers, isListed } from "../../domain/sequence/calls.ts";
import { displayPhone } from "../../domain/phone.ts";
import { leadNow } from "../../domain/sequence/clock.ts";
import { heldReason, stalledAccounts } from "../../domain/sequence/dispatch.ts";
import { deriveStatus, liveTracksFor } from "../../domain/sequence/progress.ts";
import type { AccountState, SubjectState } from "../../domain/sequence/state.ts";
import type { EnrollmentProgress, NeedsAttention, SenderAccountViewApi } from "../../shared/api.ts";
import type { EngineStore } from "./engine-store.ts";

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

export function progressView(s: SubjectState, now: number): EnrollmentProgress {
  // The reply that stopped the lead, as stored when it stopped. A later text or email is kept on the
  // record, but never moves the channel or date the status shows.
  const reply = s.subject.ended === "replied" ? s.subject.stopReply : null;
  const lead = leadNow(s.subject.clock, now);
  const running = s.subject.clock.frozenSince === null;
  return {
    id: s.subject.id,
    campaignId: s.campaign.id,
    status: deriveStatus(s),
    endedAt: iso(s.subject.endedWall),
    reply: reply ? { channel: reply.channel, at: new Date(reply.atWall).toISOString() } : null,
    sender: s.subject.emailSender,
    smsSender: s.subject.smsSender,
    zone: s.lead.zone,
    tracks: [...liveTracksFor(s), ...s.campaign.definition.tracks.filter((t) => t.removed && !liveTracksFor(s).includes(t))]
      .filter((t) => !t.removed || s.tracks.some((p) => p.trackId === t.id))
      .map((track) => {
        const p = s.tracks.find((x) => x.trackId === track.id);
        const numberOf = (stepId: string) => track.steps.filter((st) => !st.removed).findIndex((st) => st.id === stepId) + 1;
        const task = s.callTasks.find((t) => t.trackId === track.id);
        return {
          trackId: track.id,
          channel: track.channel,
          callTask: task ? { taskId: task.id, open: task.open, placedAt: new Date(task.placedWall).toISOString(), listed: isListed(s, task) } : null,
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
              calls: s.callAttempts
                .filter((c) => s.callTasks.some((t) => t.id === c.taskId && t.stepId === st.id))
                .map((c) => {
                  const n = callNumbers(s).find((x) => x.id === c.numberDetailId);
                  return { outcome: c.outcome, at: new Date(c.atWall).toISOString(), number: n ? { detailId: n.id, kind: n.kind, owner: n.owner, value: displayPhone(n.key), bad: n.bad } : null, note: c.note };
                }),
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
                  sentAt: a.state === "sent" ? iso(s.work.find((w) => w.key === a.idempotencyKey)?.sentWall ?? null) : null,
                  endedBy: a.endedBy,
                  rejectReason: a.rejectReason,
                  unresolved: s.work.some((w) => w.key === a.idempotencyKey && markable(w)),
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
    channel: a.channel,
    healthy: a.healthy,
    capacity: a.capacity,
    gapSeconds: Math.round(a.gapMs / 1000),
    usedToday: a.used,
    waiting: a.waitReason,
  };
}

export async function needsAttention(store: EngineStore, now: number): Promise<NeedsAttention> {
  const accounts = await store.accounts(now);
  const open = await store.openAttempts();
  // Unresolved provider work keeps its reservation; each inbox it holds is listed with how many of
  // its daily sends are held and the work holding them, so a slowed inbox is never silent and the
  // user can settle the work (PR 37 review rounds 2 and 3).
  const unresolved = await store.unresolvedWork();
  const heldCapacity = [];
  for (const acc of accounts) {
    const held = unresolved.filter((w) => w.accountId === acc.id);
    if (held.length === 0) continue;
    const work = [];
    for (const w of held) {
      const carrying = (await store.subject(w.subjectId, now))?.attempts.filter((a) => a.idempotencyKey === w.key) ?? [];
      work.push({
        attemptId: (carrying.find(isLive) ?? carrying.at(-1))?.id ?? w.key,
        enrollmentId: w.subjectId,
        stepId: w.stepId,
        destination: w.destination,
        unresolvedSince: new Date(w.unresolvedSince ?? 0).toISOString(),
        lookupAnswer: w.lookupAnswer,
        // While the provider reports the work queued, "not sent" is refused (5.3).
        canMarkNotSent: w.lookupAnswer !== "queued",
      });
    }
    heldCapacity.push({ accountId: acc.id, held: held.length, capacity: acc.capacity, sentToday: await store.sentToday(acc.id, now), work });
  }
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
    senderProblems: await senderProblems(store, accounts),
    heldCapacity,
    anomalies: (await store.anomalies()).map((x) => ({ what: x.what, at: new Date(x.atWall).toISOString() })),
  };
}

/** Sender accounts on any channel that cannot send, each once, with why: its provider's reason, or that its provider no longer lists it (ticket 13). */
async function senderProblems(store: EngineStore, accounts: readonly AccountState[]): Promise<NeedsAttention["senderProblems"][number][]> {
  const labels = await store.accountLabels();
  return accounts.filter((a) => !a.healthy).map((a) => ({ accountId: a.id, channel: a.channel, label: labels[a.id] ?? a.id, problem: a.problem ?? "unhealthy" }));
}
