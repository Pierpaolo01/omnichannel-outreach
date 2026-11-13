/** The campaign editor's draft helpers (ticket 12c). Pure: no React, no requests. */
import { mergeUses } from "../../domain/sequence/copy.ts";
import { ownSubject } from "../../domain/sequence/definition.ts";
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
  return {
    id: newId("track"),
    channel: "email",
    branch: "main",
    window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })),
    steps: [newStep(true)],
    start: { kind: "entry" },
    removed: false,
  };
}

export const liveSteps = (track: TrackDefinition): StepDefinition[] => track.steps.filter((s) => !s.removed);

/** The campaign's one email track for now, if it has one. */
export const emailTrackOf = (def: CampaignDefinition): TrackDefinition | undefined =>
  def.tracks.find((t) => !t.removed && t.channel === "email" && t.branch === "main");

const CHANNEL_WORD = { email: "email", sms: "SMS", call: "phone" } as const;
/** What one step of a track on this channel is called: Email 1, Text 1, Call 1. */
export const STEP_NOUN = { email: "Email", sms: "Text", call: "Call" } as const;

/**
 * A track's name in messages, from its own channel and never its position among all tracks: "the
 * email track" when it is the only live one on its channel, otherwise "email track 2" by its order
 * among that channel's live tracks.
 */
export function trackName(def: CampaignDefinition, track: TrackDefinition): string {
  const same = def.tracks.filter((t) => !t.removed && t.channel === track.channel);
  const word = CHANNEL_WORD[track.channel];
  return same.length <= 1 ? `the ${word} track` : `${word} track ${same.findIndex((t) => t.id === track.id) + 1}`;
}

export function trackSummary(track: TrackDefinition): string {
  const steps = liveSteps(track);
  const days = steps.reduce((sum, s) => sum + s.waitDays, 0);
  const n = steps.length;
  return `${n} ${n === 1 ? "email" : "emails"}${n > 1 ? ` over ${days} ${days === 1 ? "day" : "days"}` : ""}`;
}

/** "first_name" as the user reads it: "first name". */
export const fieldLabel = (field: string): string => field.replace(/_/g, " ");

/** The fields a step's copy uses, in order of first use. */
export const fieldsOf = (step: StepDefinition): string[] => [...new Set([...mergeUses(ownSubject(step)), ...mergeUses(step.body)].map((u) => u.field))];

/** The fallback this step gives `field` (the first one written), or "" when none. */
export function fallbackIn(step: StepDefinition, field: string): string {
  return [...mergeUses(ownSubject(step)), ...mergeUses(step.body)].find((u) => u.field === field && u.fallback !== null)?.fallback ?? "";
}

/** Rewrites every use of `field` in `text` with the fallback, or without one when it is blank. */
export function withFallback(text: string, field: string, fallback: string): string {
  const clean = fallback.replace(/[{}|]/g, "");
  return text.replace(/\{\{\s*([^}|]*?)\s*(?:\|([^}]*))?\}\}/g, (all, name: string) => (name.trim() === field ? (clean ? `{{${field}|${clean}}}` : `{{${field}}}`) : all));
}

/** The launch blockers that name this step: empty copy, or a field with no fallback it uses. */
export function stepBlockers(step: StepDefinition, blockers: readonly LaunchBlocker[]): LaunchBlocker[] {
  const uses = [...mergeUses(ownSubject(step)), ...mergeUses(step.body)];
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
