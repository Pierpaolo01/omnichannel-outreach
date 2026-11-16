/** Read models for the HTTP interface, built from the engine's stored facts. */
import { isLive, markable } from "../../domain/sequence/attempt.ts";
import { carriedInto, isListed, listedForDay, reasonOf } from "../../domain/sequence/calls.ts";
import { callRecordView, dateOfDay } from "./call-views.ts";
import { accountAvailable, candidatesFor, claimRefusal, heldReason, inheritedWork, readyItems, stalledAccounts, stepWhen, type StepEnv } from "../../domain/sequence/dispatch.ts";
import { stepWhenView } from "./step-when-view.ts";
import { localDayNumber, startOfLocalDay } from "../../domain/sequence/clock.ts";
import { relevantChannels, waitingOn } from "../../domain/sequence/providers.ts";
import { providerEvidence, sendingInterrupted } from "./worker-state.ts";
import { channelOf, deriveStatus, liveTracksFor, unreachableWhy, wallAtLead } from "../../domain/sequence/progress.ts";
import type { AccountState, SubjectState } from "../../domain/sequence/state.ts";
import type { AttentionLead, EnrollmentProgress, NeedsAttention, SenderAccountViewApi } from "../../shared/api.ts";
import type { EngineStore } from "./engine-store.ts";
import { DEFAULT_RULES, type Rules } from "./rules.ts";

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

/**
 * What a read knows of dispatch beyond the subject (`StepEnv`): the port's transport for a step, as the claim pass asks the
 * engine, and, while sending is interrupted, whether the dispatch gate holds the step's channels (`waitingOn`, its own).
 */
/**
 * `reading`: the subjects whose steps this read (and its controls' previews) asks about. The other leads' open calls are
 * loaded only when one of them has a phone track, the only step a later day's call room can change (council on cc9bf55,
 * item 6). `known`: states the read has already loaded at `now`, reused so a record reads each of its enrollments once
 * (council on 4fd9ca4, item 6).
 */
export async function stepEnvOf(
  store: Pick<EngineStore, "meta" | "callSettings" | "subjectsWithOpenCallTasks" | "subject">,
  now: number,
  reading: readonly SubjectState[],
  transportAvailable?: StepEnv["transportAvailable"],
  known?: ReadonlyMap<string, SubjectState | null>,
  room = true,
): Promise<StepEnv> {
  const interrupted = await sendingInterrupted(store, now);
  const evidence = interrupted ? await providerEvidence(store) : null;
  const gate = evidence ? { waitingOnProvider: (s: SubjectState, trackId: string) => waitingOn(evidence, relevantChannels(s, trackId), now).length > 0 } : {};
  const transport = transportAvailable ? { transportAvailable } : {};
  if (!room || !reading.some((s) => s.campaign.definition.tracks.some((t) => t.channel === "call"))) return { ...transport, ...gate };
  // A later day's room, from every lead's calls the engine knows are carried into it (`carriedInto`), against the capacity,
  // with the subject asked about in place of its stored state (a preview's state after its control, item 8).
  const { dailyCapacity } = await store.callSettings();
  const withCalls: SubjectState[] = [];
  for (const id of await store.subjectsWithOpenCallTasks()) {
    const s = known?.has(id) ? (known.get(id) ?? null) : await store.subject(id, now);
    if (s) withCalls.push(s);
  }
  const others = new Map<string, number>();
  const callRoomOn = (day: number, self: SubjectState): boolean => {
    const key = `${day}|${self.subject.id}`;
    let n = others.get(key);
    if (n === undefined) {
      n = withCalls.reduce((sum, s) => sum + (s.subject.id === self.subject.id ? 0 : carriedInto(s, day)), 0);
      others.set(key, n);
    }
    return n + carriedInto(self, day) < dailyCapacity;
  };
  return { callRoomOn, ...transport, ...gate };
}

export function progressView(s: SubjectState, now: number, env: StepEnv = {}, when: typeof stepWhen = stepWhen): EnrollmentProgress {
  // The reply that stopped the lead, as stored when it stopped. A later text or email is kept on the
  // record, but never moves the channel or date the status shows.
  const reply = s.subject.ended === "replied" ? s.subject.stopReply : null;
  return {
    id: s.subject.id,
    campaignId: s.campaign.id,
    status: deriveStatus(s),
    endedAt: iso(s.subject.endedWall),
    reply: reply ? { channel: reply.channel, at: new Date(reply.atWall).toISOString() } : null,
    sender: s.subject.emailSender,
    smsSender: s.subject.smsSender,
    zone: s.lead.zone,
    branch: s.subject.branch,
    winBackEnteredAt: s.subject.branch === "win_back" && s.subject.branchEnteredAt !== null ? iso(wallAtLead(s.subject.clock, s.freezes, s.subject.branchEnteredAt, now)) : null,
    declined: declinedOf(s),
    // The main sequence's tracks, then, for a lead that entered it, the win-back branch's (ticket 16), then removed
    // tracks the lead had reached. A branch the lead has not entered has no progress and is in none of its reads
    // (review bot on 654907b); a lead in win-back keeps its main tracks, each as it finished (`dropped_for_win_back`).
    tracks: [...forBranch(s, "main"), ...(s.subject.branch === "win_back" ? forBranch(s, "win_back") : []), ...s.campaign.definition.tracks.filter((t) => t.removed && !liveTracksFor(s).includes(t))]
      .filter((t) => !t.removed || s.tracks.some((p) => p.trackId === t.id))
      .filter((t, i, all) => all.indexOf(t) === i)
      .map((track) => {
        const p = s.tracks.find((x) => x.trackId === track.id);
        const numberOf = (stepId: string) => track.steps.filter((st) => !st.removed).findIndex((st) => st.id === stepId) + 1;
        const task = s.callTasks.find((t) => t.trackId === track.id);
        return {
          trackId: track.id,
          channel: track.channel,
          branch: track.branch,
          callTask: task
            ? {
                taskId: task.id,
                open: task.open,
                placedAt: new Date(task.placedWall).toISOString(),
                listed: isListed(s, task),
                kind: task.kind,
                callbackAt: iso(task.callbackAt),
                listedFor: dateOfDay(listedForDay(s, task)),
                dueAt: new Date(task.dueWall).toISOString(),
              }
            : null,
          started: p?.startedAt != null,
          finishReason: p?.finishReason ?? null,
          finishedAt: iso(p?.finishedWall ?? null),
          hold: heldReason(s, track.id, now),
          // When it goes, by the engine's own decision functions at this instant (ADR 0003 "Reads that say when").
          nextStep: nextStepOf(s, track.id, numberOf, now, env, when),
          steps: track.steps.map((st, i) => {
            const result = s.results.find((r) => r.stepId === st.id);
            return {
              stepId: st.id,
              number: i + 1,
              removed: st.removed,
              result: result?.result ?? null,
              calls: s.callAttempts
                .filter((c) => s.callTasks.some((t) => t.id === c.taskId && t.stepId === st.id))
                .map((c) => callRecordView(s, c)),
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

/** A track's pending step and when it goes (`stepWhen`), or null when it has none. */
function nextStepOf(s: SubjectState, trackId: string, numberOf: (stepId: string) => number, now: number, env: StepEnv, read: typeof stepWhen): EnrollmentProgress["tracks"][number]["nextStep"] {
  const p = s.tracks.find((x) => x.trackId === trackId);
  const when = read(s, trackId, now, env);
  return p?.nextStepId && when ? { stepId: p.nextStepId, number: numberOf(p.nextStepId), when: stepWhenView(when, now, s.callDay.day) } : null;
}

/** A branch's tracks for the lead: not removed, or already started by it (5.1). */
const forBranch = (s: SubjectState, branch: "main" | "win_back") =>
  s.campaign.definition.tracks.filter((t) => t.branch === branch && (!t.removed || s.tracks.some((p) => p.trackId === t.id && p.startedAt !== null)));

/** The lead's declined call (ticket 16): its stored record, with the path it took. A lead declines at most once. */
export function declinedOf(s: SubjectState): EnrollmentProgress["declined"] {
  const record = s.callAttempts.find((c) => c.outcome === "not_interested" && c.declinedPath !== null);
  const trackId = record ? s.callTasks.find((t) => t.id === record.taskId)?.trackId : undefined;
  return record?.declinedPath && trackId ? { at: new Date(record.atWall).toISOString(), trackId, path: record.declinedPath } : null;
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

/**
 * Needs attention as the engine decides it: every list of the HTTP read, with each lead entry by its ids only. The
 * route adds whose lead each is (`needsAttentionView` in call-views.ts, ticket 20b); nothing else is added there.
 */
export type EngineNeedsAttention = Omit<NeedsAttention, "waitingForCapacity" | "noUsableChannel" | "sendingInterrupted"> & {
  readonly waitingForCapacity: readonly Omit<NeedsAttention["waitingForCapacity"][number], keyof AttentionLead>[];
  readonly noUsableChannel: readonly Omit<NeedsAttention["noUsableChannel"][number], keyof AttentionLead>[];
};

export async function needsAttention(
  store: EngineStore,
  now: number,
  rules: Pick<Rules, "asOfAction" | "evaluate"> = DEFAULT_RULES,
  transportAvailable: (channel: "email" | "sms", threading: "new_subject" | "continue_thread") => boolean = () => true,
): Promise<EngineNeedsAttention> {
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
      const holder = await store.subject(w.subjectId, now);
      // A test run's held work counts in the inbox's held sends (it holds them) but is no lead's work (rule 4).
      if (holder?.subject.kind === "test_run") continue;
      const carrying = holder?.attempts.filter((a) => a.idempotencyKey === w.key) ?? [];
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
  const waitingForCapacity: EngineNeedsAttention["waitingForCapacity"][number][] = [];
  const waitingOnTransport: NeedsAttention["waitingOnTransport"][number][] = [];
  // Ticket 20a (council B): while sending is interrupted, which providers the gate holds due sends on, by its own function.
  const interrupted = await sendingInterrupted(store, now);
  const evidence = interrupted ? await providerEvidence(store) : null;
  const providerWaits = new Map<"email" | "sms", number>();
  // Leads only (ADR 0003 "Ticket 21", rule 4): a running test's waits show on its Test run tab, never as a lead's.
  for (const id of await store.runningLeadIds()) {
    const stored = await store.subject(id, now);
    if (!stored) continue;
    for (const p of stored.tracks) {
      const reason = heldReason(stored, p.trackId, now);
      if (reason) heldTracks.push({ enrollmentId: id, trackId: p.trackId, reason });
    }
    // Ticket 20a: as of the read, each due step the claim's step guard accepts now that waits for a transport the
    // provider cannot use yet, or for an account full for its reset day (not for a pacing slot or an in-flight place).
    const s = rules.asOfAction(stored, now, rules.evaluate);
    for (const item of readyItems(s, now)) {
      if (claimRefusal(s, item, now) !== null) continue;
      const channel = channelOf(s, item.trackId);
      if (channel !== "email" && channel !== "sms") continue;
      const step = s.campaign.definition.tracks.find((t) => t.id === item.trackId)?.steps.find((x) => x.id === item.stepId);
      const base = { enrollmentId: id, trackId: item.trackId, stepId: item.stepId, channel, dueAt: new Date(item.dueWall).toISOString() };
      if (!transportAvailable(channel, step?.threading ?? "new_subject")) {
        waitingOnTransport.push(base);
        continue;
      }
      if (evidence) {
        const waits = waitingOn(evidence, relevantChannels(s, item.trackId), now);
        for (const c of waits) providerWaits.set(c, (providerWaits.get(c) ?? 0) + 1);
        if (waits.length > 0) continue;
      }
      // A claim carrying uncertain work already holds its reservation: it never waits for capacity.
      if (inheritedWork(s, item.stepId)) continue;
      const usable = candidatesFor(s, item.trackId)
        .map((x) => s.accounts[x])
        .filter((a): a is AccountState => a !== undefined && a.channel === channel && accountAvailable(a, now));
      if (usable.length === 0 || usable.some((a) => a.used < a.capacity)) continue;
      const resetsAt = Math.min(...usable.map((a) => startOfLocalDay(localDayNumber(now, a.resetZone) + 1, a.resetZone)));
      waitingForCapacity.push({ ...base, campaignId: s.campaign.id, accountIds: usable.map((a) => a.id).sort(), resetsAt: new Date(resetsAt).toISOString() });
    }
  }
  // Ticket 20a (follow-up 42 item 50): every lead that ended with no usable channel, from any cause, most recent first,
  // with why each channel of its branch cannot reach it. It stays listed: the ending is final (question Q20).
  const noUsableChannel: EngineNeedsAttention["noUsableChannel"][number][] = [];
  for (const id of await store.endedSubjectIds("finished_no_usable_channel")) {
    const s = await store.subject(id, now);
    if (!s) continue;
    const channels = [...new Set(liveTracksFor(s).map((t) => t.channel))].flatMap((channel) => {
      const why = unreachableWhy(s, channel);
      return why === null ? [] : [{ channel, why }];
    });
    noUsableChannel.push({ enrollmentId: id, campaignId: s.campaign.id, endedAt: new Date(s.subject.endedWall ?? now).toISOString(), channels });
  }
  // Overdue callbacks (ticket 15): listed callbacks whose time has passed (the queue's own two rules). Each
  // holds its lead's outreach in that campaign until the user logs its outcome; none expires.
  const overdueCallbacks: NeedsAttention["overdueCallbacks"][number][] = [];
  for (const id of await store.subjectsWithOpenCallTasks()) {
    // As of the instant read: a call the worker has not yet skipped at a rollover is not shown (council on 228cd3b).
    const stored = await store.subject(id, now);
    const s = stored ? rules.asOfAction(stored, now, rules.evaluate) : null;
    // Leads only: a test's callback shows on the Calls list and its Test run tab, never as a lead's (rule 4).
    if (!s || s.subject.kind === "test_run") continue;
    for (const t of s.callTasks) {
      if (isListed(s, t) && reasonOf(s, t, now) === "overdue") {
        overdueCallbacks.push({ taskId: t.id, enrollmentId: id, campaignId: s.campaign.id, callbackAt: new Date(t.callbackAt ?? now).toISOString(), dueAt: new Date(t.dueWall).toISOString() });
      }
    }
  }
  overdueCallbacks.sort((a, b) => Date.parse(a.callbackAt) - Date.parse(b.callbackAt) || (a.taskId < b.taskId ? -1 : 1));
  return {
    overdueCallbacks,
    stalledInboxes: stalledAccounts(accounts, open, now),
    heldTracks,
    accountWaits: accounts.flatMap((a) =>
      a.waitReason !== null && (a.waitUntil === null || a.waitUntil > now)
        ? [{ accountId: a.id, reason: a.waitReason, until: a.waitReason === "quota" ? null : iso(a.waitUntil) }]
        : [],
    ),
    senderProblems: await senderProblems(store, accounts),
    heldCapacity,
    waitingForCapacity,
    noUsableChannel,
    waitingOnTransport,
    waitingOnProvider: [...providerWaits].map(([channel, sends]) => ({ channel, since: iso(evidence?.[channel].contactAt ?? null), sends })),
    anomalies: (await store.anomalies()).map((x) => ({ what: x.what, at: new Date(x.atWall).toISOString() })),
  };
}

/** Sender accounts on any channel that cannot send, each once, with why: its provider's reason, or that its provider no longer lists it (ticket 13). */
async function senderProblems(store: EngineStore, accounts: readonly AccountState[]): Promise<NeedsAttention["senderProblems"][number][]> {
  const labels = await store.accountLabels();
  return accounts.filter((a) => !a.healthy).map((a) => ({ accountId: a.id, channel: a.channel, label: labels[a.id] ?? a.id, problem: a.problem ?? "unhealthy" }));
}
