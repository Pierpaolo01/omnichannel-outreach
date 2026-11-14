/**
 * Each entry kind reads one stored fact (council on 10121d3, item 8): `sent`, an attempt in state
 * `sent` and its work's `sent_wall`; `failed` and a step's `skipped`, a step result; a track's
 * `skipped`, its progress's finish reason `skipped_missing_channel` with no step result; `released`,
 * a started track whose start rule names a track that finished skipped or failed; `call`, a stored
 * call attempt (ticket 14b: every outcome the user logged, skip for now included, with the number
 * dialled and its note); `bounced`, a stored bounce event; `address_bad`, a finish on a bad destination with neither; `replied`, the stored
 * stopping reply; `ended`, the lead's stored ending. The one exception is said where it is built.
 *
 * The person and company-lead timeline's campaign activity (tickets 12c and 13b): built from each
 * enrollment's stored progress, the same facts GET /api/enrollments/:id reports. It shows only
 * what happened: emails and texts the provider reported sent, failures, skips and tracks released by them, a hard bounce, the reply
 * (channel and date only, never its content), and the lead's ending. A bounce is shown from the
 * bounce event the engine stored, not inferred from how the track ended: a bounce can arrive after
 * the track completed, and an address marked bad by another campaign is not a bounce here. A bounce
 * observed before migration 10 kept no event, so it shows only as the ending on a bad address. Email
 * has no delivered
 * state, because Instantly reports none (ADR 0002, "Delivered").
 */
import type { ActivityEntry, DependentTrackState, EnrollmentView } from "../shared/api.ts";
import { displayPhone } from "../domain/phone.ts";
import { goodNumbers, skipLimitOf, userDayOf } from "../domain/sequence/calls.ts";
import { localDayNumber } from "../domain/sequence/clock.ts";
import { goodEmail, goodMobile, runs, wallAtLead } from "../domain/sequence/progress.ts";
import type { SubjectState } from "../domain/sequence/state.ts";
import { trackLabel } from "../shared/track-label.ts";
import { callRecordView, dateOfDay, firstListedDay, type CallViewRules } from "./engine/call-views.ts";
import type { CallTask, FinishReason } from "../domain/sequence/state.ts";
import { progressView } from "./engine/views.ts";
import type { OutreachStore } from "./persistence/store.ts";

const SKIP_REASON: Readonly<Record<string, string>> = { "address on the provider's block list": "block_list" };

export async function activityOf(store: OutreachStore, enrollments: readonly EnrollmentView[], now: number, kind: "person" | "company", rules: CallViewRules): Promise<ActivityEntry[]> {
  const labels = await store.engine.accountLabels();
  const entries: ActivityEntry[] = [];
  for (const enrollment of enrollments) {
    const state = await store.engine.subject(enrollment.id, now);
    if (!state) continue;
    const progress = progressView(state, now);
    const campaign = enrollment.campaign;
    const def = state.campaign.definition;
    const companyLead = kind === "company";
    const bounces = await store.engine.bouncesOf(enrollment.id);
    const channelOfTrack = (trackId: string): "email" | "sms" | "call" => def.tracks.find((t) => t.id === trackId)?.channel ?? "email";
    const labelOf = (trackId: string) => trackLabel(def, def.tracks.find((t) => t.id === trackId) ?? { id: trackId, channel: channelOfTrack(trackId) });
    // A text goes to a mobile's E.164 form; it is shown grouped for reading.
    const shown = (channel: "email" | "sms", destination: string) => (channel === "sms" ? displayPhone(destination) : destination);
    for (const b of bounces) {
      const track = progress.tracks.find((t) => t.trackId === b.trackId);
      const step = track?.steps.find((st) => st.stepId === b.stepId);
      const channel = channelOfTrack(b.trackId) === "sms" ? "sms" : "email";
      entries.push({ campaign, at: new Date(b.atWall).toISOString(), kind: "bounced", channel, track: labelOf(b.trackId), stepNumber: step?.number ?? null, to: shown(channel, b.destination) });
    }
    // Ended for want of a usable channel before any track started: the only case Activity says more
    // than the stored outcomes (council on 10121d3, item 8).
    // At launch the lead is in the main sequence, so only its tracks can say so; a branch's never can.
    const endedAtLaunch = progress.status === "finished_no_usable_channel" && progress.branch === "main" && !progress.tracks.some((t) => t.started);
    for (const track of progress.tracks) {
      if (track.channel === "call") {
        callEntries(track, state, rules.asOfAction(state, now, rules.evaluate), progress, campaign, labelOf, endedAtLaunch, now, rules, entries);
        continue;
      }
      if (track.channel !== "email" && track.channel !== "sms") continue;
      const channel = track.channel;
      const label = labelOf(track.trackId);
      const missing = channel === "email" ? "no_email" : companyLead ? "company_lead" : "no_mobile";
      const hasChannel = channel === "email" ? goodEmail(state.lead.details) !== null : goodMobile(state.lead.details) !== null;
      let lastTo: string | null = null;
      for (const step of track.steps) {
        for (const send of step.sends) {
          if (send.state !== "sent" || send.sentAt === null) continue;
          lastTo = send.destination;
          entries.push({ campaign, at: send.sentAt, kind: "sent", channel, track: label, stepNumber: step.number, from: labels[send.sender] ?? send.sender, to: shown(channel, send.destination), copy: send.copy });
        }
        if (step.at === null) continue;
        if (step.result === "failed") {
          const to = step.sends.at(-1)?.destination ?? "";
          entries.push({ campaign, at: step.at, kind: "failed", channel, track: label, stepNumber: step.number, to: shown(channel, to), reason: step.reason ?? "failed" });
        } else if (step.result === "skipped") {
          entries.push({ campaign, at: step.at, kind: "skipped", channel, track: label, stepNumber: step.number, reason: SKIP_REASON[step.reason ?? ""] ?? step.reason ?? "skipped" });
        }
      }
      if (endedAtLaunch && progress.endedAt !== null && !hasChannel && track.branch === "main") {
        // The one entry not read from this track's own stored outcome: a lead with no usable channel
        // ends at launch, before any track starts, so no track stores a skip; each says why here.
        entries.push({ campaign, at: progress.endedAt, kind: "skipped", channel, track: label, stepNumber: null, reason: missing });
        continue;
      }
      const startedAt = startedWall(state, track.trackId, now);
      const rule = def.tracks.find((t) => t.id === track.trackId)?.start;
      if (startedAt !== null && rule?.kind === "after") {
        // A track that started because the one before it was skipped or failed says so (spec "a
        // skipped or failed track counts as finished").
        const before = progress.tracks.find((t) => t.trackId === rule.trackId);
        const because = releasedBecause(before?.finishReason ?? null);
        if (because) entries.push({ campaign, at: new Date(startedAt).toISOString(), kind: "released", channel, track: label, after: labelOf(rule.trackId), because });
      }
      if (track.finishedAt === null) continue;
      if (track.finishReason === "skipped_missing_channel" && track.steps.every((st) => st.result === null)) {
        entries.push({ campaign, at: track.finishedAt, kind: "skipped", channel, track: label, stepNumber: null, reason: missing });
      } else if (track.finishReason === "failed_bad_destination" && !track.steps.some((st) => st.result === "failed") && !bounces.some((b) => b.trackId === track.trackId)) {
        // The track ended on a bad address with no bounce event of this campaign's: another campaign's
        // bounce marked it, or this campaign's bounce was observed before migration 10, which kept no
        // event (ADR 0003, bounce events). The entry says only what the stored ending says.
        entries.push({ campaign, at: track.finishedAt, kind: "address_bad", channel, track: label, to: shown(channel, lastTo ?? "") });
      }
    }
    if (progress.reply) entries.push({ campaign, at: progress.reply.at, kind: "replied", channel: progress.reply.channel });
    else if (progress.endedAt !== null && (progress.status === "sequence_finished_no_response" || progress.status === "finished_no_usable_channel")) {
      entries.push({ campaign, at: progress.endedAt, kind: "ended", status: progress.status });
    }
  }
  // Newest first; at the same instant, the later-recorded entry first.
  return entries.map((e, i) => ({ e, i })).sort((a, b) => b.e.at.localeCompare(a.e.at) || b.i - a.i).map(({ e }) => e);
}

/**
 * Why a track that started after another says so: the one before it was skipped (for want of a channel,
 * or by the user), skipped unworked by the call skip limit (ticket 15b), or failed on a bad destination.
 */
function releasedBecause(finish: string | null): "skipped" | "failed" | "unworked" | null {
  if (finish === "skipped_missing_channel" || finish === "skipped") return "skipped";
  if (finish === "skipped_unworked") return "unworked";
  return finish === "failed_bad_destination" ? "failed" : null;
}

/**
 * A finished track's state as Activity says it (verifier on 2027f24): every finish reason the engine stores, in one
 * exhaustive switch, so a reason a later ticket adds fails typecheck until it has a state here.
 */
export function finishedStateOf(reason: FinishReason): Exclude<DependentTrackState["state"], "waiting"> {
  switch (reason) {
    case "completed":
    case "failed_bad_destination":
    case "closed_on_interest":
      return "finished";
    case "skipped_declined":
      return "skipped_declined";
    case "skipped_unworked":
      return "skipped_unworked";
    case "skipped_missing_channel":
      return "skipped_no_channel";
    case "skipped":
    case "skipped_by_user":
      return "skipped";
    case "dropped_for_win_back":
      return "dropped_for_win_back";
    default: {
      const unhandled: never = reason;
      throw new Error(`A finish reason Activity has no state for: ${String(unhandled)}`);
    }
  }
}

/**
 * The state of a track that starts after another, from the engine's stored progress at the read (`live`), never from
 * how the track before it ended: a finished track by its stored finish; a started one is started; one not started
 * will not start once the lead has ended; with its start resolved it waits out its delay, or waits while the lead is
 * held (council on 32454ea, D; verifier on 2027f24).
 */
export function dependentStateOf(live: SubjectState, p: SubjectState["tracks"][number] | undefined, now: number): DependentTrackState {
  if (p?.finishReason) return { state: finishedStateOf(p.finishReason), startsAt: null };
  if (p && p.startedAt !== null) return { state: "started", startsAt: null };
  if (live.subject.ended !== null) return { state: "stopped", startsAt: null };
  if (!p || p.startAt === null) return { state: "not_started", startsAt: null };
  if (!runs(live)) return { state: "held", startsAt: null };
  return { state: "waiting", startsAt: new Date(wallAtLead(live.subject.clock, live.freezes, p.startAt, now)).toISOString() };
}

/** The wall instant a track started, or null if it has not. */
function startedWall(state: SubjectState, trackId: string, now: number): number | null {
  const p = state.tracks.find((t) => t.trackId === trackId);
  if (!p || p.startedAt === null) return null;
  return wallAtLead(state.subject.clock, state.freezes, p.startedAt, now);
}

/**
 * A phone track's entries (ticket 14b), each from a stored fact, as every other kind: each call
 * attempt the user logged (`calls` on its step, skip for now included); a skip for want of a good
 * number, from its finish reason `skipped_missing_channel` (or, for a lead ended at launch, the same
 * exception the other channels have); and its release after a track that was skipped or failed.
 */
/**
 * The day a redial logged at `atWall` was listed from: the engine's redial rule moves the call to the user's next day,
 * and the listing rule (`isListed`) lists it from the first day on or after that whose calling hours open. Judged on a
 * copy holding only that call, as it stood after the redial, so later events (a reply, another outcome) do not move it.
 */
function redialListedFrom(live: SubjectState, task: CallTask, atWall: number, rules: CallViewRules): string | null {
  const listDay = userDayOf(atWall, live.callDay.userZone) + 1;
  const redialed: CallTask = { ...task, open: true, kind: "call", callbackAt: null, listDay };
  const copy: SubjectState = { ...live, subject: { ...live.subject, ended: null, leadPaused: false }, campaign: { ...live.campaign, pausedSince: null }, callTasks: [redialed] };
  for (let d = listDay; d < listDay + 60; d++) if (rules.isListed({ ...copy, callDay: { ...copy.callDay, day: d } }, redialed)) return dateOfDay(d);
  return null;
}

/**
 * Activity is history, and every present-tense fact in it comes from the lead's state as of the read (`live`, the
 * record's own), by the same listing rule (council on 32454ea, C; verifier re-check, H): whether a callback is still
 * open and holding outreach, whether one is overdue, and what the tracks after an unworked skip have done.
 */
function callEntries(
  track: ReturnType<typeof progressView>["tracks"][number],
  state: SubjectState,
  live: SubjectState,
  progress: ReturnType<typeof progressView>,
  campaign: ActivityEntry["campaign"],
  labelOf: (trackId: string) => ReturnType<typeof trackLabel>,
  endedAtLaunch: boolean,
  now: number,
  rules: CallViewRules,
  entries: ActivityEntry[],
): void {
  const def = state.campaign.definition;
  const label = labelOf(track.trackId);
  // Each call the user logged, from the stored attempts, with its redial and callback time; one logged on a
  // callback names the time that callback was asked for (ticket 15b).
  const tasks = state.callTasks.filter((t) => t.trackId === track.trackId);
  for (const task of tasks) {
    let askedFor: string | null = null;
    const liveTask = live.callTasks.find((t) => t.id === task.id);
    // The callback asked for that is open now, listed today or later by the listing rule: the one the record shows.
    const openCallback = liveTask?.open && liveTask.kind === "callback" && liveTask.callbackAt !== null && firstListedDay(live, liveTask, rules) !== null ? new Date(liveTask.callbackAt).toISOString() : null;
    for (const c of state.callAttempts.filter((a) => a.taskId === task.id)) {
      const record = callRecordView(state, c);
      entries.push({
        campaign,
        at: record.at,
        kind: "call",
        channel: "call",
        track: label,
        outcome: record.outcome,
        number: record.number,
        note: record.note,
        redial: record.redial,
        callbackAt: record.callbackAt,
        onCallback: askedFor,
        zone: state.lead.zone,
        redialListedFrom: record.redial ? redialListedFrom(live, liveTask ?? task, c.atWall, rules) : null,
        callbackOpen: record.callbackAt !== null && record.callbackAt === openCallback,
        declinedPath: record.declinedPath,
      });
      if (c.outcome !== "skip_for_now") askedFor = c.outcome === "callback_requested" ? record.callbackAt : null;
    }
    // A callback still listed after the time asked for is overdue (Q12): shown at that time until its outcome. The
    // listing rule decides, so a lead that replied or was stopped (its task kept for a restart) shows none.
    if (liveTask?.kind === "callback" && liveTask.callbackAt !== null && liveTask.callbackAt <= now && rules.isListed(live, liveTask)) {
      const at = new Date(liveTask.callbackAt).toISOString();
      entries.push({ campaign, at, kind: "callback_overdue", channel: "call", track: label, callbackAt: at, zone: state.lead.zone });
    }
  }
  if (endedAtLaunch && progress.endedAt !== null && goodNumbers(state).length === 0) {
    entries.push({ campaign, at: progress.endedAt, kind: "skipped", channel: "call", track: label, stepNumber: null, reason: "no_number" });
    return;
  }
  const startedAt = startedWall(state, track.trackId, now);
  const rule = def.tracks.find((t) => t.id === track.trackId)?.start;
  if (startedAt !== null && rule?.kind === "after") {
    const before = progress.tracks.find((t) => t.trackId === rule.trackId);
    const because = releasedBecause(before?.finishReason ?? null);
    if (because) entries.push({ campaign, at: new Date(startedAt).toISOString(), kind: "released", channel: "call", track: label, after: labelOf(rule.trackId), because });
  }
  if (track.finishedAt !== null && track.finishReason === "skipped_missing_channel") entries.push({ campaign, at: track.finishedAt, kind: "skipped", channel: "call", track: label, stepNumber: null, reason: "no_number" });
  const unworked = tasks.at(-1);
  if (track.finishedAt !== null && track.finishReason === "skipped_unworked" && unworked) {
    // Each track after it, as its stored progress stands now: never a start that has not happened (verifier on eac9f6c, F2).
    const after = def.tracks
      .filter((t) => !t.removed && t.start.kind === "after" && t.start.trackId === track.trackId)
      .map((t) => ({ track: labelOf(t.id), ...dependentStateOf(live, live.tracks.find((x) => x.trackId === t.id), now) }));
    entries.push({ campaign, at: track.finishedAt, kind: "skipped", channel: "call", track: label, stepNumber: null, reason: "unworked", dueDate: dateOfDay(localDayNumber(unworked.dueWall, live.callDay.userZone)), limitDays: skipLimitOf(def, track.trackId), after });
  }
}
