/** The campaign editor's draft helpers (ticket 12c). Pure: no React, no requests. */
import { mergeUses, rewriteMergeUses, type MergeUse } from "../../domain/sequence/copy.ts";
import { ownSubject } from "../../domain/sequence/definition.ts";
import { trackLabel, trackPhrase } from "../../shared/track-label.ts";
import type { CampaignDefinition, LaunchBlocker, StepDefinition, TrackDefinition, WindowRule } from "../../shared/api.ts";

/** Days as the reference shows them, Monday first; the definition numbers Sunday 0. */
export const WEEK: readonly { day: number; letter: string; name: string }[] = [
  { day: 1, letter: "M", name: "Monday" },
  { day: 2, letter: "T", name: "Tuesday" },
  { day: 3, letter: "W", name: "Wednesday" },
  { day: 4, letter: "T", name: "Thursday" },
  { day: 5, letter: "F", name: "Friday" },
  { day: 6, letter: "S", name: "Saturday" },
  { day: 0, letter: "S", name: "Sunday" },
];

const newId = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

export function newStep(first: boolean): StepDefinition {
  return { id: newId("step"), waitDays: first ? 0 : 3, subject: "", body: "", threading: first ? "new_subject" : "continue_thread", removed: false };
}

/** A new email track: weekdays from 09:00 to 17:00 in the lead's time, and an empty first email. */
export function newEmailTrack(): TrackDefinition {
  return newTrack("email");
}

/** The skip limit every new phone track starts with (spec "Unfinished call tasks": default 2). */
export const DEFAULT_SKIP_LIMIT_DAYS = 2;

/**
 * A new track on `channel`, starting at launch, with weekdays from 09:00 to 17:00 in the lead's time
 * (for a phone track, its calling hours): an empty first message, or for a phone track its one call,
 * which has no copy, and the default skip limit (ADR 0003, ticket 14c).
 */
export function newTrack(channel: "email" | "sms" | "call"): TrackDefinition {
  return {
    id: newId("track"),
    channel,
    branch: "main",
    window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })),
    steps: [newStep(true)],
    start: { kind: "entry" },
    removed: false,
    ...(channel === "call" ? { callSkipLimitDays: DEFAULT_SKIP_LIMIT_DAYS } : {}),
  };
}

export const liveSteps = (track: TrackDefinition): StepDefinition[] => track.steps.filter((s) => !s.removed);

/** The campaign's one email track for now, if it has one. */
export const emailTrackOf = (def: CampaignDefinition): TrackDefinition | undefined =>
  def.tracks.find((t) => !t.removed && t.channel === "email" && t.branch === "main");

/** What one step of a track on this channel is called: Email 1, Text 1, Call 1. */
export const STEP_NOUN = { email: "Email", sms: "Text", call: "Call" } as const;

/**
 * A track's name in messages, from its own channel and never its position among all tracks: "the
 * email track" when it is the only live one on its channel, otherwise "email track 2" by its order
 * among that channel's live tracks (`trackLabel`, shared with the server's Activity).
 */
export function trackName(def: CampaignDefinition, track: TrackDefinition): string {
  return trackPhrase(def, track);
}

/** A track's title: "Email track", "SMS track 2". */
export const trackTitle = (def: CampaignDefinition, track: TrackDefinition): string => trackLabel(def, track).label;

export function trackSummary(track: TrackDefinition): string {
  if (track.channel === "call") return "One call";
  const steps = liveSteps(track);
  const days = steps.reduce((sum, s) => sum + (Number.isFinite(s.waitDays) ? s.waitDays : 0), 0);
  const n = steps.length;
  const [one, many] = track.channel === "sms" ? ["text", "texts"] : ["email", "emails"];
  return `${n} ${n === 1 ? one : many}${n > 1 ? ` over ${days} ${days === 1 ? "day" : "days"}` : ""}`;
}

/** "first_name" as the user reads it: "first name". */
export const fieldLabel = (field: string): string => field.replace(/_/g, " ");

/**
 * A step's merge-field uses, read by the domain's own parser (`mergeUses`) from the same copy the
 * domain renders and checks (`ownSubject` and the body), so the screen and launch blocker 2 agree
 * on every spelling: spaces, fallbacks, case, subject (PR 41 review). Nothing in the editor matches
 * a token by hand.
 */
export const usesOf = (step: StepDefinition): MergeUse[] => [...mergeUses(ownSubject(step)), ...mergeUses(step.body)];

/** The fields a step's copy uses, in order of first use. */
export const fieldsOf = (step: StepDefinition): string[] => [...new Set(usesOf(step).map((u) => u.field))];

/** The fallback this step gives `field` (the first one written), or "" when none. */
export function fallbackIn(step: StepDefinition, field: string): string {
  return usesOf(step).find((u) => u.field === field && u.fallback !== null)?.fallback ?? "";
}

/** The step where `field` is fixed: the first using it with no fallback, else the first using it at all. */
export function stepUsing(track: TrackDefinition, field: string): StepDefinition | undefined {
  const steps = liveSteps(track);
  return steps.find((s) => usesOf(s).some((u) => u.field === field && u.fallback === null)) ?? steps.find((s) => usesOf(s).some((u) => u.field === field));
}

/** Rewrites every use of `field` in `text` with the fallback, or without one when it is blank. */
export function withFallback(text: string, field: string, fallback: string): string {
  const clean = fallback.replace(/[{}|]/g, "");
  return rewriteMergeUses(text, (use) => (use.field === field ? (clean ? `{{${field}|${clean}}}` : `{{${field}}}`) : null));
}

/** The launch blockers that name this step: empty copy, or a field with no fallback it uses. */
export function stepBlockers(step: StepDefinition, blockers: readonly LaunchBlocker[]): LaunchBlocker[] {
  const uses = usesOf(step);
  return blockers.filter((b) =>
    b.kind === "empty_copy" ? b.stepId === step.id : b.kind === "missing_merge_field" ? uses.some((u) => u.field === b.field && u.fallback === null) : false,
  );
}

/** One hours range for every chosen day, as the reference edits it. */
export function windowHours(window: readonly WindowRule[]): { start: number; end: number } {
  const first = window[0];
  return first ? { start: first.start, end: first.end } : { start: 9, end: 17 };
}

export function setWindow(days: readonly number[], hours: { start: number; end: number }): WindowRule[] {
  return WEEK.filter((d) => days.includes(d.day)).map((d) => ({ day: d.day, start: hours.start, end: hours.end }));
}

export const hourLabel = (h: number): string => `${String(h).padStart(2, "0")}:00`;

/**
 * The track without one email. When the first email goes, the next becomes a first email: it has
 * no wait and starts its own thread, keeping its copy and any subject it had (PR 41 review).
 */
export function removeStep(track: TrackDefinition, stepId: string): TrackDefinition {
  const wasFirst = liveSteps(track)[0]?.id === stepId;
  const steps = track.steps.filter((s) => s.id !== stepId);
  const first = steps.find((s) => !s.removed);
  return {
    ...track,
    steps: wasFirst && first ? steps.map((s) => (s.id === first.id ? { ...s, waitDays: 0, threading: "new_subject" as const } : s)) : steps,
  };
}

/** The subject a continue-thread email at `index` replies to: the nearest earlier email that started a thread. */
export function threadSubjectOf(steps: readonly StepDefinition[], index: number): string {
  for (let i = index - 1; i >= 0; i--) {
    const s = steps[i];
    if (s && (i === 0 || s.threading === "new_subject")) return s.subject;
  }
  return "";
}

/** What a launched campaign does on its own, by the channels its tracks use. */
export function sendsOnItsOwn(def: CampaignDefinition): string {
  const channels = new Set(def.tracks.filter((t) => !t.removed).map((t) => t.channel));
  // A call is never made on its own: it goes on the user's list, and the user dials it (ticket 14c).
  const calls = channels.has("call") ? "Calls go on your list when they fall due, inside each lead’s calling hours." : "";
  const own =
    channels.has("email") && channels.has("sms") ? "Email and texts go out on their own, inside each lead’s sending window."
    : channels.has("sms") ? "Texts go out on their own, inside each lead’s sending window."
    : channels.has("email") ? "Email goes out on its own, inside each lead’s sending window."
    : "";
  return [own, calls].filter(Boolean).join(" ");
}
