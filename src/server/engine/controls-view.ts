/**
 * What the controls of one lead will do, read and not computed (ADR 0003 "Ticket 17a"): each action is the
 * engine's own transition (`applyControl`) applied to a copy of the lead as of the read (`asOfAction`), storing
 * nothing, so a control the read allows is the one the action accepts at that instant, and a refusal carries the
 * same reason (P11).
 */
import { leadNow } from "../../domain/sequence/clock.ts";
import { campaignRefusal, currentStep, LEAD_CONTROLS, skipTarget, type LeadControl } from "../../domain/sequence/controls.ts";
import { isLive } from "../../domain/sequence/attempt.ts";
import { deriveStatus, runs } from "../../domain/sequence/progress.ts";
import type { SubjectState } from "../../domain/sequence/state.ts";
import type { CampaignControlView, ControlStepView, ControlView } from "../../shared/api.ts";
import type { Rules } from "./rules.ts";
import { trackLabel } from "../../shared/track-label.ts";

const iso = (t: number) => new Date(t).toISOString();

function stepView(state: SubjectState, step: NonNullable<ReturnType<typeof currentStep>>, now: number, due: boolean): ControlStepView {
  const live = step.track.steps.filter((s) => !s.removed);
  const lead = leadNow(state.subject.clock, now);
  return {
    trackId: step.track.id,
    // The track's name as everywhere else (ticket 17b): "Email track 2" when the campaign has several on its channel.
    track: trackLabel(state.campaign.definition, step.track),
    channel: step.track.channel,
    branch: step.track.branch,
    stepId: step.stepId,
    number: live.findIndex((s) => s.id === step.stepId) + 1,
    of: live.length,
    dueAt: due && step.dueAt !== null && runs(state) ? iso(now + Math.max(0, step.dueAt - lead)) : null,
  };
}

/** Work with a provider the change asks to withdraw: live past its claim, asked now and not before. */
function newlyWithdrawn(before: SubjectState, after: SubjectState): number {
  return after.attempts.filter((a) => isLive(a) && a.state !== "claimed" && a.withdrawRequested && !before.attempts.find((b) => b.id === a.id)?.withdrawRequested).length;
}

export function controlView(stored: SubjectState, action: LeadControl, now: number, rules: Rules): ControlView {
  const before = rules.previewAsOf(stored, now, rules.evaluate);
  const out = rules.applyControl(before, action, now);
  if (!out.ok) return { action, allowed: false, reason: out.reason };
  return effectOf(before, action, out.state, now);
}

/**
 * A control's effect, from the lead as of the action's instant (`before`) and as the transition leaves it (`after`): the
 * read previews it on a copy, and the action answers with it (verifier B4). What the worker does after the control (a
 * send due at once) is not part of it: the action's answer carries that as the read after the worker ran.
 */
export function effectOf(before: SubjectState, action: LeadControl, after: SubjectState, now: number): ControlView {
  // The step a skip skips: the first pending step not with a provider (council D2), as the transition chooses it.
  const skipped = action === "skip" ? skipTarget(before) : null;
  const next = currentStep(after);
  return {
    action,
    allowed: true,
    statusAfter: deriveStatus(after),
    skips: skipped ? stepView(before, skipped, now, false) : null,
    next: next ? stepView(after, next, now, true) : null,
    withProvider: newlyWithdrawn(before, after),
  };
}

/** Every control of the lead, in a fixed order. */
export function controlsView(stored: SubjectState, now: number, rules: Rules): ControlView[] {
  return LEAD_CONTROLS.map((action) => controlView(stored, action, now, rules));
}

/** The campaign's pause and resume, judged on its row exactly as `Engine.setCampaignPause` judges them. */
export function campaignControls(row: { readonly launchedAt: number | null; readonly pausedSince: number | null } | null): CampaignControlView[] {
  return (["pause", "resume"] as const).map((action) => {
    const reason = campaignRefusal(row, action === "pause");
    return reason === null ? { action, allowed: true } : { action, allowed: false, reason };
  });
}
