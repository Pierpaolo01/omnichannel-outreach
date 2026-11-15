/**
 * The Test run tab's read (ticket 21; ADR 0003 "Ticket 21"): the campaign's test contacts, whether it has been tested
 * since the last edit, and the latest run as of the read's instant, from its stored facts through the engine's own
 * functions. Nothing here writes, and nothing beside the engine decides what a test does.
 */
import { isLive, maySend } from "../domain/sequence/attempt.ts";
import { liveSteps, type TrackDefinition } from "../domain/sequence/definition.ts";
import { progressOf } from "../domain/sequence/progress.ts";
import type { EndReason, SubjectState } from "../domain/sequence/state.ts";
import type { TestRunEnding, TestRunRead, TestRunTab, TestStepRow } from "../shared/api.ts";
import { stepNoun, trackLabel } from "../shared/track-label.ts";
import type { TestRunRecord } from "./engine/engine-store.ts";
import type { Rules } from "./engine/rules.ts";
import type { OutreachStore } from "./persistence/store.ts";

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

export async function testRunTab(store: OutreachStore, campaignId: string, now: number, rules: Pick<Rules, "asOfAction" | "evaluate">): Promise<TestRunTab | null> {
  const row = await store.engine.campaign(campaignId);
  const stored = await store.engine.testContacts(campaignId);
  if (!row || !stored) return null;
  const leads = await leadsOf(store, campaignId);
  const latest = (await store.engine.testRunsOf(campaignId))[0] ?? null;
  return {
    campaignId,
    definitionVersion: row.definitionVersion,
    contacts: { email: stored.contacts.email?.value ?? null, mobile: stored.contacts.mobile?.value ?? null, emailIsALead: stored.leadHas.email, mobileIsALead: stored.leadHas.mobile },
    noTestSinceEdit: await store.engine.noTestSinceEdit(campaignId),
    leads,
    run: latest ? await runRead(store, latest, leads, now, rules) : null,
    at: iso(now),
    zone: row.definition?.timezone ?? "UTC",
  };
}

async function runRead(store: OutreachStore, run: TestRunRecord, leads: TestRunTab["leads"], now: number, rules: Pick<Rules, "asOfAction" | "evaluate">): Promise<TestRunRead | null> {
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
    mayStillSend: s.work.filter(maySend).length,
    steps: stepsOf(s),
  };
}

/** Every live step of the main sequence, then of the win-back branch, in canvas order, with what its facts say. */
export function stepsOf(s: SubjectState): TestStepRow[] {
  const def = s.campaign.definition;
  // A removed track a run started keeps its rows; one it never started is not shown.
  const shown = (t: TrackDefinition) => !t.removed || progressOf(s, t.id)?.startedAt != null;
  const tracks = [...def.tracks.filter((t) => t.branch === "main" && shown(t)), ...def.tracks.filter((t) => t.branch === "win_back" && shown(t))];
  const rows: TestStepRow[] = [];
  for (const track of tracks) {
    const label = trackLabel(def, track);
    const steps = track.steps.filter((st) => !st.removed || s.results.some((r) => r.stepId === st.id));
    const p = progressOf(s, track.id);
    steps.forEach((step, i) => {
      const result = s.results.find((r) => r.stepId === step.id);
      const live = s.attempts.find((a) => a.stepId === step.id && isLive(a) && a.state !== "claimed");
      const task = s.callTasks.find((t) => t.stepId === step.id);
      const logged = task ? s.callAttempts.filter((c) => c.taskId === task.id && c.outcome !== "skip_for_now").at(-1) : undefined;
      const base = {
        trackId: track.id,
        stepId: step.id,
        channel: track.channel,
        branch: track.branch,
        name: track.channel === "call" ? (track.branch === "win_back" ? "Win-back call" : "Call") : `${stepNoun(label, track.channel)} ${liveSteps(track).indexOf(step) + 1 || i + 1}`,
        track: label.label,
        taskId: task?.id ?? null,
        outcome: logged?.outcome ?? null,
        reason: result?.reason ?? null,
      };
      if (result) {
        const state = track.channel === "call" && result.result === "sent" ? "logged" : result.result;
        rows.push({ ...base, state, at: iso(result.atWall) });
      } else if (task?.open) rows.push({ ...base, state: "on_your_list", at: iso(task.placedWall) });
      else if (live) rows.push({ ...base, state: "with_provider", at: live.handedWall === null ? null : iso(live.handedWall) });
      else if (s.subject.ended === null && p && p.finishedAt === null && p.nextStepId === step.id && p.dueWall !== null) rows.push({ ...base, state: "due", at: iso(p.dueWall) });
      else rows.push({ ...base, state: "not_reached", at: null });
    });
  }
  return rows;
}
