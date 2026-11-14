/**
 * A campaign's definition (ADR 0003 1.1) and the definitions refused at the boundary (7.1).
 * Ticket 13 runs email and SMS tracks in the main branch, connected together or after a delay;
 * ticket 14 adds phone tracks, each exactly one call. The win-back branch is refused with a plain
 * message until the ticket that builds it (ADR 0003 section 10).
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

/** What a declined call does (ADR 0003 1.1): set on the canvas, applied by ticket 16. */
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
  /** A phone track's declined path, when the canvas has set one. Read from ticket 16 on; nothing reads it yet. */
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

export const WIN_BACK_LATER = "The win-back branch arrives with a later release.";

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
 * Plain messages for a definition that cannot be saved (ADR 0003 7.1). Empty when it can.
 * `previous` is the stored definition an edit replaces, if any.
 */
export function definitionProblems(def: CampaignDefinition, previous: CampaignDefinition | null = null): string[] {
  const problems: string[] = [];
  if (!isTimeZone(def.timezone)) problems.push(`The campaign's time zone "${def.timezone}" is not an IANA time zone such as Europe/London.`);
  if (!isWholeDays(def.callSkipLimitDays) || def.callSkipLimitDays === 0) problems.push("The call skip limit is a whole number of days, at least 1.");
  const smsPool = def.smsPool ?? [];
  if (new Set(def.emailPool).size !== def.emailPool.length || new Set(smsPool).size !== smsPool.length) problems.push("A sender account is listed twice.");

  const trackIds = new Set<string>();
  const stepIds = new Set<string>();
  for (const track of def.tracks) {
    if (trackIds.has(track.id)) problems.push(`Two tracks share the id ${track.id}.`);
    trackIds.add(track.id);
    for (const step of track.steps) {
      if (stepIds.has(step.id)) problems.push(`Two steps share the id ${step.id}.`);
      stepIds.add(step.id);
    }
  }

  const live = def.tracks.filter((t) => !t.removed);
  if (live.some((t) => t.branch !== "main" || t.declinedPath === "win_back")) problems.push(WIN_BACK_LATER);
  if (problems.length > 0 && live.some((t) => t.branch !== "main")) return problems;

  const label = (track: TrackDefinition) => {
    const same = live.filter((t) => t.channel === track.channel);
    const channel = track.channel === "sms" ? "SMS" : track.channel === "call" ? "phone" : track.channel;
    return same.length === 1 ? `the ${channel} track` : `${channel[0]?.toUpperCase() ?? ""}${channel.slice(1)} track ${same.indexOf(track) + 1}`;
  };
  const capital = (text: string) => `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
  const byId = new Map(live.map((t) => [t.id, t]));

  for (const track of live) {
    const name = capital(label(track));
    if (track.start.kind === "after") {
      const before = byId.get(track.start.trackId);
      if (!before || before.branch !== track.branch) problems.push(`${name} starts after a track that is not in the sequence.`);
      if (!isWholeDays(track.start.delayDays)) problems.push(`The delay before ${label(track)} is a whole number of days.`);
    }
    if (track.window.length === 0) problems.push(`${name}'s ${track.channel === "call" ? "calling hours have" : "sending window has"} no days.`);
    for (const w of track.window) {
      if (!Number.isInteger(w.day) || w.day < 0 || w.day > 6) problems.push(`${name}'s window names a day that does not exist.`);
      if (!Number.isInteger(w.start) || !Number.isInteger(w.end) || w.start < 0 || w.start > 23 || w.end < 0 || w.end > 24) problems.push(`${name}'s window hours are whole hours from 0 to 24.`);
      else if (w.start === w.end) problems.push(`${name}'s window starts and ends at the same hour.`);
    }
    if (track.callSkipLimitDays !== undefined) {
      if (track.channel !== "call") problems.push("Only a phone track has a call skip limit.");
      else if (!isWholeDays(track.callSkipLimitDays) || track.callSkipLimitDays === 0) problems.push(`${name}'s call skip limit is a whole number of days, at least 1.`);
    }
    const steps = liveSteps(track);
    // A phone track is one call with no follow-ups (spec "Phone tracks"); the call has no copy.
    if (track.channel === "call" && steps.length !== 1) problems.push(`${name} is one call with no follow-ups: give it exactly one step.`);
    // A call has no copy: the campaign's call script shows on every call task (verifier F2 on a1399ce).
    if (track.channel === "call" && steps.some((st) => st.subject.trim() !== "" || st.body.trim() !== "")) problems.push(`${capital(label(track))}'s call has no copy of its own: write talking points in the campaign's call script.`);
    steps.forEach((step, i) => {
      const stepLabel = `Step ${i + 1}`;
      if (i === 0 && step.waitDays !== 0) problems.push(`${stepLabel} is the first step, so it has no wait.`);
      if (!isWholeDays(step.waitDays)) problems.push(`${stepLabel}'s wait is a whole number of days.`);
      if (i === 0 && track.channel === "email" && step.threading === "continue_thread") problems.push(`${stepLabel} is the first email, so there is no thread to continue: give it a new subject.`);
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
  if (inCircle) problems.push("The tracks' connections go in a circle, so none of them could start.");

  if (previous) {
    const before = new Map(previous.tracks.map((t) => [t.id, t]));
    const stepTrack = new Map(previous.tracks.flatMap((t) => t.steps.map((s) => [s.id, t.id] as const)));
    for (const track of def.tracks) {
      const old = before.get(track.id);
      if (old && old.channel !== track.channel) problems.push("A track cannot change channel: remove it and add a new one.");
      for (const step of track.steps) {
        const was = stepTrack.get(step.id);
        if (was !== undefined && was !== track.id) problems.push("A step cannot move to another track: remove it and add a new one.");
      }
    }
  }
  return problems;
}
