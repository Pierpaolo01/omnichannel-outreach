/**
 * The Test run tab's read (ticket 21; ADR 0003 "Ticket 21"): the campaign's test contacts, whether it has been tested
 * since the last edit, and the latest run as of the read's instant, from its stored facts through the engine's own
 * functions. Nothing here writes, and nothing beside the engine decides what a test does.
 */
import { stepWhen, type StepEnv } from "../domain/sequence/dispatch.ts";
import { readWait } from "./engine/step-when-view.ts";
import { isLive, maySend } from "../domain/sequence/attempt.ts";
import { stepNumber, type TrackDefinition } from "../domain/sequence/definition.ts";
import { deriveStatus, progressOf, unsettledOwnersOf } from "../domain/sequence/progress.ts";
import { heldReason } from "../domain/sequence/dispatch.ts";
import type { EndReason, FinishReason, SubjectState } from "../domain/sequence/state.ts";
import type { TestRunEnding, TestRunRead, TestRunTab, TestStepRow } from "../shared/api.ts";
import { stepTitle, trackLabel } from "../shared/track-label.ts";
import type { TestRunRecord } from "./engine/engine-store.ts";
import { replyMarksView } from "./engine/controls-view.ts";
import { messageRequestRecord } from "../domain/social-channels.ts";
import type { Rules } from "./engine/rules.ts";

/** The rules the tab reads with: the call views' and the reply mark's (ticket 24b). */
export type TestTabRules = CallViewRules & Pick<Rules, "markReplied">;
import type { OutreachStore } from "./persistence/store.ts";
import { firstListedDay, type CallViewRules } from "./engine/call-views.ts";
import { conversationOwnersView, linkedinTrackView } from "./engine/views.ts";
import { startOfLocalDay } from "../domain/sequence/clock.ts";

const iso = (t: number) => new Date(t).toISOString();

/** A test run's ending in its own words: the engine's ending, and whether an edit stopped it (question Q27). */
export function endingOf(ended: EndReason, stoppedBy: TestRunRecord["stoppedBy"]): TestRunEnding {
  switch (ended) {
    case "replied":
      return "your_reply";
    case "sequence_finished_no_response":
      return "finished";
    case "finished_no_usable_channel":
      return "no_contact_left";
    case "interested_on_call":
      return "interested";
    case "declined_on_call":
      return "declined";
    case "stopped_manually":
      return stoppedBy === "edit" ? "edited" : "stopped";
    default:
      throw new Error(`an ending a test run does not know: ${String(ended satisfies never)}`);
  }
}

/** The campaign's leads a test may render as, by name: every enrollment, ended or not (its data is all a test reads). */
async function leadsOf(store: OutreachStore, campaignId: string): Promise<TestRunTab["leads"]> {
  const { rows } = await store.searchLeads({ text: "", campaignId, companyId: null, status: null, limit: Number.MAX_SAFE_INTEGER });
  return rows.flatMap((row) => {
    const e = row.enrollments.find((x) => x.campaign.id === campaignId);
    return e ? [{ id: e.id, name: row.name, kind: row.kind }] : [];
  });
}

export async function testRunTab(store: OutreachStore, campaignId: string, now: number, rules: TestTabRules, env: StepEnv = {}): Promise<TestRunTab | null> {
  const row = await store.engine.campaign(campaignId);
  const stored = await store.engine.testContacts(campaignId);
  if (!row || !stored) return null;
  const leads = await leadsOf(store, campaignId);
  const latest = (await store.engine.testRunsOf(campaignId))[0] ?? null;
  return {
    campaignId,
    definitionVersion: row.definitionVersion,
    contacts: {
      email: stored.contacts.email?.value ?? null,
      mobile: stored.contacts.mobile?.value ?? null,
      emailIsALead: stored.leadHas.email,
      mobileIsALead: stored.leadHas.mobile,
      linkedin: stored.contacts.linkedin?.value ?? null,
      linkedinIsALead: stored.leadHas.linkedin === true,
      social: messageRequestRecord((ch) => ({ address: stored.contacts[ch]?.value ?? null, isALead: stored.leadHas[ch] === true })),
    },
    noTestSinceEdit: await store.engine.noTestSinceEdit(campaignId),
    leads,
    run: latest ? await runRead(store, latest, leads, now, rules, env) : null,
    at: iso(now),
    zone: row.definition?.timezone ?? "UTC",
  };
}

async function runRead(store: OutreachStore, run: TestRunRecord, leads: TestRunTab["leads"], now: number, rules: TestTabRules, env: StepEnv): Promise<TestRunRead | null> {
  const stored = await store.engine.subject(run.id, now);
  if (!stored) return null;
  // As of the read's instant: what fell due since the worker's last tick is applied (nothing is written).
  const s = rules.asOfAction(stored, now, rules.evaluate);
  return {
    id: run.id,
    running: s.subject.ended === null,
    ending: s.subject.ended === null ? null : endingOf(s.subject.ended, run.stoppedBy),
    startedAt: iso(run.startedWall),
    endedAt: s.subject.endedWall === null ? null : iso(s.subject.endedWall),
    renderAs: { id: run.renderAs, name: leads.find((l) => l.id === run.renderAs)?.name ?? "" },
    email: run.contacts.email?.value ?? null,
    mobile: run.contacts.mobile?.value ?? null,
    linkedin: run.contacts.linkedin?.value ?? null,
    social: messageRequestRecord((ch) => run.contacts[ch]?.value ?? null),
    status: deriveStatus(s),
    stopReply: s.subject.stopReply?.channel ?? null,
    linkedinTracks: s.tracks.filter((t) => s.campaign.definition.tracks.find((d) => d.id === t.trackId)?.channel === "linkedin").map((t) => ({ trackId: t.trackId, view: linkedinTrackView(s, t.trackId) })),
    mayStillSend: s.work.filter(maySend).length,
    steps: stepsOf(s, rules, now, env),
    // The mark's own rule on the stored run (it reads the run as of the action itself), as a lead's read says it (ticket 24b).
    replyMarks: replyMarksView(stored, now, rules),
  };
}

/** Every live step of the main sequence, then of the win-back branch, in canvas order, with what its facts say. */
export function stepsOf(s: SubjectState, rules: CallViewRules, now: number, env: StepEnv = {}): TestStepRow[] {
  const def = s.campaign.definition;
  // A removed track a run started keeps its rows; one it never started is not shown.
  const shown = (t: TrackDefinition) => !t.removed || progressOf(s, t.id)?.startedAt != null;
  const tracks = [...def.tracks.filter((t) => t.branch === "main" && shown(t)), ...def.tracks.filter((t) => t.branch === "win_back" && shown(t))];
  const rows: TestStepRow[] = [];
  // Held (5.4) first, every hold (unresolved and sms_conversation_unsettled included), ahead of the provider's progress, for
  // email and SMS: never said to be due (council on faac357, item 4; the verifier on cc9bf55, item 10).
  const held = (trackId: string) => heldReason(s, trackId, now);
  // Any other reason the read gives (but "with the provider") also comes before the provider's progress.
  const waitsHere = (track: TrackDefinition, stepId: string): Pick<TestStepRow, "waits" | "until"> | null => {
    const p = progressOf(s, track.id);
    if (track.channel === "call" || s.subject.ended !== null || !p || p.finishedAt !== null || p.nextStepId !== stepId) return null;
    const when = (rules.stepWhen ?? stepWhen)(s, track.id, now, env);
    if (when?.kind !== "waits" || when.why === "with_provider") return null;
    // The day an acceptance wait ends is the read's fact (ADR 0004 section 9): said as when the wait ends, never a send.
    return { waits: readWait(when.why, s, track.id, now), ...(when.why === "awaiting_acceptance" && when.until !== undefined ? { until: iso(when.until) } : {}) };
  };
  for (const track of tracks) {
    const label = trackLabel(def, track);
    const steps = track.steps.filter((st) => !st.removed || s.results.some((r) => r.stepId === st.id));
    const p = progressOf(s, track.id);
    steps.forEach((step) => {
      const result = s.results.find((r) => r.stepId === step.id);
      const live = s.attempts.find((a) => a.stepId === step.id && isLive(a) && a.state !== "claimed");
      const task = s.callTasks.find((t) => t.stepId === step.id);
      const logged = task ? s.callAttempts.filter((c) => c.taskId === task.id && c.outcome !== "skip_for_now").at(-1) : undefined;
      const base = {
        trackId: track.id,
        stepId: step.id,
        channel: track.channel,
        branch: track.branch,
        name: track.channel === "call" ? (track.branch === "win_back" ? "Win-back call" : "Call") : stepTitle(label, track.channel, stepNumber(track, step.id), step.role),
        track: label.label,
        taskId: task?.id ?? null,
        outcome: logged?.outcome ?? null,
        reason: result?.reason ?? null,
        waits: null,
      };
      if (result) {
        const state = track.channel === "call" && result.result === "sent" ? "logged" : result.result;
        rows.push({ ...base, state, at: iso(result.atWall) });
      } else if (task?.open && rules.isListed(s, task)) rows.push({ ...base, state: "on_your_list", at: iso(task.placedWall) });
      else if (task?.open && s.subject.ended === null) {
        // Open but not on today's list (a redial, a callback for a later day, a held test): when the listing rule lists it.
        // An ended test keeps its open task (2.3) and is never listed: it falls through to "not reached".
        const day = firstListedDay(s, task, rules);
        rows.push({ ...base, state: "listed_later", at: day === null ? null : iso(startOfLocalDay(day, s.callDay.userZone)) });
      }
      else if (s.subject.ended === null && p && p.finishedAt === null && p.nextStepId === step.id && held(track.id) !== null) {
        const hold = held(track.id);
        rows.push(hold === null ? { ...base, state: "due", at: iso(p.dueWall ?? 0) } : { ...base, state: "held", at: null, hold, holdOwners: unsettledOwnersOf(s, track.id, now).map((o) => ({ name: o.name, test: o.test, lead: o.lead })) });
      } else if (waitsHere(track, step.id)) rows.push({ ...base, state: "due", at: null, ...waitsHere(track, step.id) });
      else if (live) rows.push({ ...base, state: "with_provider", at: live.handedWall === null ? null : iso(live.handedWall) });
      // A step of a track that finished without reaching it: skipped, with why its track finished (council on ffa202c, item 13).
      else if (p?.finishReason) {
        const skipped = { ...base, state: "skipped" as const, at: p.finishedWall === null ? null : iso(p.finishedWall), reason: trackEndedBecause(p.finishReason) };
        // A test mobile in another campaign's SMS conversation names its owner (question Q7 answered).
        rows.push(p.finishReason === "skipped_conversation_taken" ? { ...skipped, owners: conversationOwnersView(s, track.id) } : skipped);
      } else if (s.subject.ended === null && p && p.finishedAt === null && p.nextStepId === step.id && p.dueWall !== null) {
        // When it goes, by the engine's own decision functions at the read (ADR 0003 "Reads that say when"): ready, its
        // window's next opening once the cut wait has ended, or why it waits, with no time.
        const when = (rules.stepWhen ?? stepWhen)(s, track.id, now, env);
        switch (when?.kind) {
          case "waits":
            // The day an acceptance wait ends is the read's fact (ADR 0004 section 9): said as when the wait ends, never a send.
            rows.push({ ...base, state: "due", at: null, waits: readWait(when.why, s, track.id, now), ...(when.why === "awaiting_acceptance" && when.until !== undefined ? { until: iso(when.until) } : {}) });
            break;
          case "ready":
            rows.push({ ...base, state: "due", at: iso(now) });
            break;
          case "at":
            rows.push({ ...base, state: "due", at: iso(Math.max(when.at, now)) });
            break;
          // A call goes on the list on a user day, with no time of day (council on 178de98, item 3): today's is due now,
          // a later day's is listed from that day, as the tab says of an open call listed later.
          case "call_day":
            rows.push(when.day <= s.callDay.day ? { ...base, state: "due", at: iso(now) } : { ...base, state: "listed_later", at: iso(startOfLocalDay(when.day, s.callDay.userZone)) });
            break;
          case "listed_for":
            rows.push({ ...base, state: "listed_later", at: iso(startOfLocalDay(when.day, s.callDay.userZone)) });
            break;
          case undefined:
            rows.push({ ...base, state: "due", at: iso(now) });
            break;
          default: {
            const unhandled: never = when;
            throw new Error(`A step time the Test run tab cannot say: ${String(unhandled)}`);
          }
        }
      }
      else rows.push({ ...base, state: "not_reached", at: null });
    });
  }
  return rows;
}

/** Why a track finished without reaching a step, in the read's own words (`TestStepRow.reason`). */
function trackEndedBecause(reason: FinishReason): string {
  switch (reason) {
    case "skipped_missing_channel":
      return "missing_channel";
    case "skipped_conversation_taken":
      return "sms_conversation_taken";
    case "failed_bad_destination":
      return "bad_destination";
    case "skipped_declined":
      return "declined";
    case "skipped_by_user":
      return "skipped_by_you";
    case "skipped_unworked":
      return "unworked";
    case "dropped_for_win_back":
      return "win_back";
    case "invite_not_accepted":
      return "invite_not_accepted";
    case "closed_on_interest":
      return "interested";
    case "completed":
    case "skipped":
      return "skipped";
    default:
      throw new Error(`a finish reason the read does not know: ${String(reason satisfies never)}`);
  }
}
