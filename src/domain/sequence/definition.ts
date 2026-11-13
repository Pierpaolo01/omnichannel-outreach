/**
 * A campaign's definition (ADR 0003 1.1) and the definitions refused at the boundary (7.1).
 * Ticket 12b runs one email track in the main branch; any other shape is refused with a plain
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
  /** Email subject; used on a `new_subject` step. */
  readonly subject: string;
  readonly body: string;
  readonly threading: Threading;
  readonly removed: boolean;
}

export type StartRule = { readonly kind: "entry" } | { readonly kind: "after"; readonly trackId: string; readonly delayDays: number };

export interface TrackDefinition {
  readonly id: string;
  readonly channel: TrackChannel;
  readonly branch: Branch;
  readonly window: readonly WindowRule[];
  readonly steps: readonly StepDefinition[];
  readonly start: StartRule;
  readonly removed: boolean;
}

export interface CampaignDefinition {
  /** The campaign's default zone, used when neither the lead nor its company has one. */
  readonly timezone: string;
  /** The call skip limit in days (ADR 0003 3.5); stored for later tickets. */
  readonly callSkipLimitDays: number;
  /** Sender accounts email tracks may use. */
  readonly emailPool: readonly string[];
  readonly tracks: readonly TrackDefinition[];
}

export const ONE_EMAIL_TRACK_FOR_NOW = "One email track for now: SMS, phone and further tracks arrive with later tickets.";

/** An empty definition for a new campaign. */
export function emptyDefinition(timezone: string): CampaignDefinition {
  return { timezone, callSkipLimitDays: 2, emailPool: [], tracks: [] };
}

export const liveTracks = (def: CampaignDefinition, branch: Branch = "main"): TrackDefinition[] =>
  def.tracks.filter((t) => !t.removed && t.branch === branch);

export const liveSteps = (track: TrackDefinition): StepDefinition[] => track.steps.filter((s) => !s.removed);

const isWholeDays = (n: number) => Number.isInteger(n) && n >= 0;

/**
 * Plain messages for a definition that cannot be saved (ADR 0003 7.1). Empty when it can.
 * `previous` is the stored definition an edit replaces, if any.
 */
export function definitionProblems(def: CampaignDefinition, previous: CampaignDefinition | null = null): string[] {
  const problems: string[] = [];
  if (!isTimeZone(def.timezone)) problems.push(`The campaign's time zone "${def.timezone}" is not an IANA time zone such as Europe/London.`);
  if (!isWholeDays(def.callSkipLimitDays) || def.callSkipLimitDays === 0) problems.push("The call skip limit is a whole number of days, at least 1.");
  if (new Set(def.emailPool).size !== def.emailPool.length) problems.push("A sender account is listed twice.");

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
  if (live.length > 1 || live.some((t) => t.channel !== "email" || t.branch !== "main")) problems.push(ONE_EMAIL_TRACK_FOR_NOW);

  for (const track of live) {
    const name = `The ${track.channel} track`;
    if (track.start.kind !== "entry") problems.push(`${name} must start when the lead enters the sequence.`);
    if (track.window.length === 0) problems.push(`${name}'s sending window has no days.`);
    for (const w of track.window) {
      if (!Number.isInteger(w.day) || w.day < 0 || w.day > 6) problems.push(`${name}'s window names a day that does not exist.`);
      if (!Number.isInteger(w.start) || !Number.isInteger(w.end) || w.start < 0 || w.start > 23 || w.end < 0 || w.end > 24) problems.push(`${name}'s window hours are whole hours from 0 to 24.`);
      else if (w.start === w.end) problems.push(`${name}'s window starts and ends at the same hour.`);
    }
    const steps = liveSteps(track);
    steps.forEach((step, i) => {
      const label = `Step ${i + 1}`;
      if (i === 0 && step.waitDays !== 0) problems.push(`${label} is the first step, so it has no wait.`);
      if (!isWholeDays(step.waitDays)) problems.push(`${label}'s wait is a whole number of days.`);
      if (i === 0 && track.channel === "email" && step.threading === "continue_thread") problems.push(`${label} is the first email, so there is no thread to continue: give it a new subject.`);
    });
  }

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
