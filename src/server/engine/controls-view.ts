/**
 * What the controls of one lead will do, read and not computed (ADR 0003 "Ticket 17a"): each action is the
 * engine's own transition (`applyControl`) applied to a copy of the lead as of the read (`asOfAction`), storing
 * nothing, so a control the read allows is the one the action accepts at that instant, and a refusal carries the
 * same reason (P11).
 */
import { stepNumber } from "../../domain/sequence/definition.ts";
import { releasedBy, stepWhen, type StepEnv } from "../../domain/sequence/dispatch.ts";
import { channelOfTrack, stepWhenView } from "./step-when-view.ts";
import { currentStep, judgeCampaignControl, previewDigest, LEAD_CONTROLS, skipTarget, type LeadControl } from "../../domain/sequence/controls.ts";
import { isLive } from "../../domain/sequence/attempt.ts";
import { deriveStatus } from "../../domain/sequence/progress.ts";
import type { SubjectState } from "../../domain/sequence/state.ts";
import type { CampaignControlView, ControlStepView, ControlView, LinkedinReplyMark } from "../../shared/api.ts";
import { DEFAULT_RULES, type Rules } from "./rules.ts";
import { trackLabel } from "../../shared/track-label.ts";

function stepView(state: SubjectState, step: NonNullable<ReturnType<typeof currentStep>>, now: number, due: boolean, env: StepEnv = {}, read: typeof stepWhen = stepWhen): ControlStepView {
  const live = step.track.steps.filter((s) => !s.removed);
  return {
    trackId: step.track.id,
    // The track's name as everywhere else (ticket 17b): "Email track 2" when the campaign has several on its channel.
    track: trackLabel(state.campaign.definition, step.track),
    channel: step.track.channel,
    call: step.track.channel === "call" ? callRecordOf(state, step.stepId) : null,
    branch: step.track.branch,
    stepId: step.stepId,
    number: stepNumber(step.track, step.stepId),
    of: live.length,
    // When the step goes once the action applies: the engine's `stepWhen` on the lead as the action leaves it.
    when: due ? whenOf(state, step.track.id, now, env, read) : null,
  };
}

function whenOf(state: SubjectState, trackId: string, now: number, env: StepEnv, read: typeof stepWhen): ControlStepView["when"] {
  const when = read(state, trackId, now, env);
  return when ? stepWhenView(when, now, state.callDay.day, channelOfTrack(state, trackId)) : null;
}

/** A call step's record: its calls logged so far (skip for now is no call), and whether its open task is a callback. */
function callRecordOf(state: SubjectState, stepId: string): { attempts: number; callback: boolean } {
  const tasks = state.callTasks.filter((t) => t.stepId === stepId);
  const attempts = state.callAttempts.filter((a) => a.outcome !== "skip_for_now" && tasks.some((t) => t.id === a.taskId)).length;
  return { attempts, callback: tasks.some((t) => t.open && t.kind === "callback") };
}

/** Work with a provider the change asks to withdraw: live past its claim, asked now and not before. */
function newlyWithdrawn(before: SubjectState, after: SubjectState): number {
  return after.attempts.filter((a) => isLive(a) && a.state !== "claimed" && a.withdrawRequested && !before.attempts.find((b) => b.id === a.id)?.withdrawRequested).length;
}

export function controlView(stored: SubjectState, action: LeadControl, now: number, rules: Rules, env: StepEnv = {}): ControlView {
  const before = rules.previewAsOf(stored, now, rules.evaluate);
  // The action's own refusal order (`judgeControl`), with no expectation: a request confirmed on this read is judged the same.
  const out = rules.judgeControl(stored, before, action, now, null, rules);
  if (!out.ok) return { action, allowed: false, reason: out.reason };
  return effectOf(before, action, out.state, now, env, rules.previewStepWhen);
}

/**
 * A control's effect, from the lead as of the action's instant (`before`) and as the transition leaves it (`after`): the
 * read previews it on a copy, and the action answers with it (verifier B4). What the worker does after the control (a
 * send due at once) is not part of it: the action's answer carries that as the read after the worker ran.
 */
export function effectOf(before: SubjectState, action: LeadControl, after: SubjectState, now: number, env: StepEnv = {}, read: typeof stepWhen = stepWhen): ControlView {
  // The step a skip skips: the first pending step not with a provider (council D2), as the transition chooses it.
  const skipped = action === "skip" ? skipTarget(before) : null;
  const next = currentStep(after);
  return {
    action,
    allowed: true,
    statusAfter: deriveStatus(after),
    skips: skipped ? stepView(before, skipped, now, false) : null,
    // A preview reads the state the control would produce (council on cc9bf55, item 8): its withdrawals' reservations freed,
    // and the call room counted with this lead as it would be (the environment takes the state it is asked about).
    next: next ? stepView(releasedBy(before, after), next, now, true, env, read) : null,
    withProvider: newlyWithdrawn(before, after),
    // What the preview names, which a confirmation sends back as its precondition (verifier R1 on 57d874f).
    digest: previewDigest(before, action, after),
  };
}

/** Every control of the lead, in a fixed order. */
export function controlsView(stored: SubjectState, now: number, rules: Rules, env: StepEnv = {}): ControlView[] {
  return LEAD_CONTROLS.map((action) => controlView(stored, action, now, rules, env));
}

/**
 * Whether the user may mark the subject replied on LinkedIn now (ADR 0004 section 7; ticket 24b): the mark's own transition
 * (`rules.markReplied`) on a copy of the subject as of the read, exactly as `Engine.markReplied` judges it before its
 * confirmation, storing nothing, so the read's refusal is the action's. Null when the campaign has no LinkedIn track.
 */
export function linkedinReplyView(stored: SubjectState, now: number, rules: Pick<Rules, "markReplied" | "asOfAction" | "evaluate"> = DEFAULT_RULES): LinkedinReplyMark | null {
  if (!stored.campaign.definition.tracks.some((t) => t.channel === "linkedin")) return null;
  const marked = rules.markReplied(rules.asOfAction(stored, now, rules.evaluate), "read", now);
  return marked.ok ? { allowed: true } : { allowed: false, reason: marked.reason };
}

/** The campaign's pause and resume, judged on its row exactly as `Engine.setCampaignPause` judges them. */
export function campaignControls(row: { readonly launchedAt: number | null; readonly pausedSince: number | null } | null): CampaignControlView[] {
  return (["pause", "resume"] as const).map((action) => {
    // The action's order (`judgeCampaignControl`), with no expectation: a request confirmed on this read is judged the same.
    const reason = judgeCampaignControl(row, action === "pause", null, DEFAULT_RULES);
    return reason === null ? { action, allowed: true } : { action, allowed: false, reason };
  });
}
