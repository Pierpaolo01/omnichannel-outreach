/**
 * A campaign's definition (ADR 0003 1.1) and the definitions refused at the boundary (7.1).
 * Ticket 13 runs email and SMS tracks in the main branch, connected together or after a delay;
 * ticket 14 adds phone tracks, each exactly one call; ticket 16 adds each phone track's declined path
 * and the campaign's win-back branch: email and SMS tracks, arranged like the main sequence, that a
 * lead enters when it declines on a call, with no call.
 */
import { isTimeZone, type WindowRule } from "./clock.ts";

export type TrackChannel = "email" | "sms" | "call";
export type Branch = "main" | "win_back";
export type Threading = "new_subject" | "continue_thread";

export interface StepDefinition {
  readonly id: string;
  /** Whole calendar days before this step; none on a track's first step. */
  readonly waitDays: number;
  /** Email subject; used on a `new_subject` step. An SMS step has none. */
  readonly subject: string;
  readonly body: string;
  /** Email only: an SMS has no thread, so an SMS step's threading is not read. */
  readonly threading: Threading;
  readonly removed: boolean;
}

export type StartRule = { readonly kind: "entry" } | { readonly kind: "after"; readonly trackId: string; readonly delayDays: number };

/** What a declined call does (ADR 0003 1.1, 2.4): set on the canvas, preselected on the outcome, overridable per lead. */
export type DeclinedPath = "stop" | "continue" | "win_back";

export interface TrackDefinition {
  readonly id: string;
  readonly channel: TrackChannel;
  readonly branch: Branch;
  /** The sending window; for a phone track, its calling hours. */
  readonly window: readonly WindowRule[];
  readonly steps: readonly StepDefinition[];
  readonly start: StartRule;
  readonly removed: boolean;
  /** A phone track's declined path, when the canvas has set one; `declinedPathOf` reads it. */
  readonly declinedPath?: DeclinedPath;
  /**
   * A phone track's call skip limit in days (ADR 0003 3.5; ticket 14c: set on each phone track). A
   * phone track saved before ticket 14c has none of its own and reads the campaign's (`skipLimitOf` in calls.ts, the one reading of the limit).
   */
  readonly callSkipLimitDays?: number;
}

export interface CampaignDefinition {
  /** The campaign's default zone, used when neither the lead nor its company has one. */
  readonly timezone: string;
  /** The call skip limit in days (ADR 0003 3.5), for a phone track that holds none of its own (`skipLimitOf` in calls.ts). */
  readonly callSkipLimitDays: number;
  /** Sender accounts email tracks may use. */
  readonly emailPool: readonly string[];
  /** Sender numbers SMS tracks may use. Absent in definitions saved before ticket 13: none. */
  readonly smsPool?: readonly string[];
  /** The campaign's call script or talking points, shown on every call task (ADR 0003 1.1). Absent before ticket 14: none. */
  readonly callScript?: string;
  readonly tracks: readonly TrackDefinition[];
}

/**
 * A phone track's declined path: the one the canvas set, else stop (question Q14's interim: a definition
 * saved before ticket 16, or a phone track the canvas has not set a path on, stops the lead).
 */
export const declinedPathOf = (track: Pick<TrackDefinition, "declinedPath"> | undefined): DeclinedPath => track?.declinedPath ?? "stop";

/**
 * What to do when a phone track's declined path is win back and the branch has no live track: the
 * clause the validator's refusal ends with (7.1), which the editor also shows beside win back while it
 * cannot be chosen (ticket 16b), so both say the same.
 */
export const NO_WIN_BACK_BRANCH = "the campaign has no win-back branch: add a track to the win-back branch, or choose stop or continue.";

/** Whether a lead can enter the campaign's win-back branch: it has a live track. */
export const winBackAvailable = (def: CampaignDefinition): boolean => def.tracks.some((t) => !t.removed && t.branch === "win_back");

/** An empty definition for a new campaign. */
export function emptyDefinition(timezone: string): CampaignDefinition {
  return { timezone, callSkipLimitDays: 2, emailPool: [], smsPool: [], tracks: [] };
}

/** The sender accounts a track on `channel` may use. */
export function poolOf(def: CampaignDefinition, channel: TrackChannel): readonly string[] {
  return channel === "email" ? def.emailPool : channel === "sms" ? (def.smsPool ?? []) : [];
}

export const liveTracks = (def: CampaignDefinition, branch: Branch = "main"): TrackDefinition[] =>
  def.tracks.filter((t) => !t.removed && t.branch === branch);

export const liveSteps = (track: TrackDefinition): StepDefinition[] => track.steps.filter((s) => !s.removed);

/**
 * The subject a step writes: its own on a new-subject email; none on a continue-thread email,
 * which goes inside the thread it continues. A subject stored on a continue-thread step (the
 * editor hides it after a switch) is never rendered, sent or checked (PR 41 council, item 3).
 */
export const ownSubject = (step: StepDefinition): string => (step.threading === "new_subject" ? step.subject : "");

const isWholeDays = (n: number) => Number.isInteger(n) && n >= 0;


/**
 * One reason a definition cannot be saved (ADR 0003 7.1), with a stable identity: its `kind` and the track
 * and step it is about, by id. Its sentence names the track as it is called now, which changes when a
 * sibling is added or removed, so whether two problems are the same one is decided by identity, never
 * by their sentences (council on aaf82b7).
 */
export interface DefinitionIssue {
  readonly kind: string;
  readonly trackId?: string;
  readonly stepId?: string;
  readonly text: string;
}

/** A problem's identity: the same problem before and after an edit, however its track is named. */
export const issueKey = (issue: DefinitionIssue): string => `${issue.kind} ${issue.trackId ?? ""} ${issue.stepId ?? ""}`;

/** The reasons a definition cannot be saved (ADR 0003 7.1), each with its identity. Empty when it can. */
export function definitionIssues(def: CampaignDefinition, previous: CampaignDefinition | null = null): DefinitionIssue[] {
  const problems: DefinitionIssue[] = [];
  const add = (kind: string, text: string, about: { readonly trackId?: string; readonly stepId?: string } = {}) => problems.push({ kind, text, ...about });
  if (!isTimeZone(def.timezone)) add("timezone", `The campaign's time zone "${def.timezone}" is not an IANA time zone such as Europe/London.`);
  if (!isWholeDays(def.callSkipLimitDays) || def.callSkipLimitDays === 0) add("campaign_skip_limit", "The call skip limit is a whole number of days, at least 1.");
  const smsPool = def.smsPool ?? [];
  if (new Set(def.emailPool).size !== def.emailPool.length || new Set(smsPool).size !== smsPool.length) add("sender_twice", "A sender account is listed twice.");

  const trackIds = new Set<string>();
  const stepIds = new Set<string>();
  for (const track of def.tracks) {
    if (trackIds.has(track.id)) add("track_id_twice", `Two tracks share the id ${track.id}.`, { trackId: track.id });
    trackIds.add(track.id);
    for (const step of track.steps) {
      if (stepIds.has(step.id)) add("step_id_twice", `Two steps share the id ${step.id}.`, { trackId: track.id, stepId: step.id });
      stepIds.add(step.id);
    }
  }

  const live = def.tracks.filter((t) => !t.removed);
  // Tracks are named within their branch: "the email track", "Win-back email track 2".
  const label = (track: TrackDefinition) => {
    const same = live.filter((t) => t.channel === track.channel && t.branch === track.branch);
    const channel = track.channel === "sms" ? "SMS" : track.channel === "call" ? "phone" : track.channel;
    const named = track.branch === "win_back" ? `win-back ${channel}` : channel;
    return same.length === 1 ? `the ${named} track` : `${named[0]?.toUpperCase() ?? ""}${named.slice(1)} track ${same.indexOf(track) + 1}`;
  };
  const capital = (text: string) => `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
  const byId = new Map(live.map((t) => [t.id, t]));

  // The win-back branch (ticket 16): no call in it (spec "no cold call"), and a phone track enters it only
  // when it has a live track. The declined path is the only branch point, so no connection crosses branches.
  if (live.some((t) => t.branch === "win_back" && t.channel === "call")) {
    add("phone_in_win_back", "The win-back branch cannot hold a phone track: a lead who declined is never called again in this campaign. Remove the phone track from the win-back branch.");
  }
  for (const track of live) {
    if (track.declinedPath !== undefined && track.channel !== "call") add("declined_path_not_phone", `Only a phone track has a declined path: ${label(track)} has one.`, { trackId: track.id });
    if (track.channel === "call" && track.branch === "main" && track.declinedPath === "win_back" && !winBackAvailable(def)) {
      add("win_back_without_branch", `${capital(label(track))}'s declined path is win back, but ${NO_WIN_BACK_BRANCH}`, { trackId: track.id });
    }
  }

  for (const track of live) {
    const name = capital(label(track));
    if (track.start.kind === "after") {
      const before = byId.get(track.start.trackId);
      if (!before) add("after_missing", `${name} starts after a track that is not in the sequence.`, { trackId: track.id });
      else if (before.branch !== track.branch) {
        add(
          "after_other_branch",
          track.branch === "win_back"
            ? `${name} starts after a track of the main sequence: connect it inside the win-back branch, which starts when a lead declines.`
            : `${name} starts after a track of the win-back branch: connect it inside the main sequence.`,
          { trackId: track.id },
        );
      }
      if (!isWholeDays(track.start.delayDays)) add("delay_not_whole", `The delay before ${label(track)} is a whole number of days.`, { trackId: track.id });
    }
    if (track.window.length === 0) add("window_empty", `${name}'s ${track.channel === "call" ? "calling hours have" : "sending window has"} no days.`, { trackId: track.id });
    for (const w of track.window) {
      if (!Number.isInteger(w.day) || w.day < 0 || w.day > 6) add("window_day", `${name}'s window names a day that does not exist.`, { trackId: track.id });
      if (!Number.isInteger(w.start) || !Number.isInteger(w.end) || w.start < 0 || w.start > 23 || w.end < 0 || w.end > 24) add("window_hours", `${name}'s window hours are whole hours from 0 to 24.`, { trackId: track.id });
      else if (w.start === w.end) add("window_same_hour", `${name}'s window starts and ends at the same hour.`, { trackId: track.id });
    }
    if (track.callSkipLimitDays !== undefined) {
      if (track.channel !== "call") add("skip_limit_not_phone", "Only a phone track has a call skip limit.", { trackId: track.id });
      else if (!isWholeDays(track.callSkipLimitDays) || track.callSkipLimitDays === 0) add("track_skip_limit", `${name}'s call skip limit is a whole number of days, at least 1.`, { trackId: track.id });
    }
    const steps = liveSteps(track);
    // A phone track is one call with no follow-ups (spec "Phone tracks"); the call has no copy.
    if (track.channel === "call" && steps.length !== 1) add("call_steps", `${name} is one call with no follow-ups: give it exactly one step.`, { trackId: track.id });
    // A call has no copy: the campaign's call script shows on every call task (verifier F2 on a1399ce).
    if (track.channel === "call" && steps.some((st) => st.subject.trim() !== "" || st.body.trim() !== "")) add("call_copy", `${capital(label(track))}'s call has no copy of its own: write talking points in the campaign's call script.`, { trackId: track.id });
    steps.forEach((step, i) => {
      const stepLabel = `Step ${i + 1}`;
      if (i === 0 && step.waitDays !== 0) add("first_step_wait", `${stepLabel} is the first step, so it has no wait.`, { trackId: track.id, stepId: step.id });
      if (!isWholeDays(step.waitDays)) add("wait_not_whole", `${stepLabel}'s wait is a whole number of days.`, { trackId: track.id, stepId: step.id });
      if (i === 0 && track.channel === "email" && step.threading === "continue_thread") add("first_email_continues", `${stepLabel} is the first email, so there is no thread to continue: give it a new subject.`, { trackId: track.id, stepId: step.id });
    });
  }

  // A cycle in start rules: following "after" from any track must reach a track that starts at entry.
  const inCircle = live.some((track) => {
    const seen = new Set<string>();
    for (let t: TrackDefinition | undefined = track; t && t.start.kind === "after"; t = byId.get(t.start.trackId)) {
      if (seen.has(t.id)) return true;
      seen.add(t.id);
    }
    return false;
  });
  if (inCircle) add("circle", "The tracks' connections go in a circle, so none of them could start.");

  if (previous) {
    const before = new Map(previous.tracks.map((t) => [t.id, t]));
    const stepTrack = new Map(previous.tracks.flatMap((t) => t.steps.map((s) => [s.id, t.id] as const)));
    for (const track of def.tracks) {
      const old = before.get(track.id);
      if (old && old.channel !== track.channel) add("channel_changed", "A track cannot change channel: remove it and add a new one.", { trackId: track.id });
      for (const step of track.steps) {
        const was = stepTrack.get(step.id);
        if (was !== undefined && was !== track.id) add("step_moved", "A step cannot move to another track: remove it and add a new one.", { trackId: track.id, stepId: step.id });
      }
    }
  }
  return problems;
}

/**
 * Plain messages for a definition that cannot be saved (ADR 0003 7.1). Empty when it can.
 * `previous` is the stored definition an edit replaces, if any. The sentences of `definitionIssues`.
 */
export function definitionProblems(def: CampaignDefinition, previous: CampaignDefinition | null = null): string[] {
  return definitionIssues(def, previous).map((issue) => issue.text);
}
