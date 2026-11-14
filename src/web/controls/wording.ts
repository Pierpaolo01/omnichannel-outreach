/**
 * Every sentence ticket 17b's screens say about pausing, resuming, skipping, stopping and restarting, one function per
 * state (ADR 0003 "Ticket 17a", "Reads"). Each reads only a field of the server's read (an enrollment's read, a campaign's
 * read) or a control's answer, and says days and times in the zone passed in: none decides which control applies, which
 * step is next, when it is due or what a control did. History is said in the past tense; a present state only as the
 * read says it at its instant.
 */
import { STATUS_GROUPS, statusGroup, type StatusGroup } from "../../domain/outreach-status.ts";
import type { CampaignPauseRead, ControlStepView, ControlView, LeadControlApi, OutreachStatus, RecordLead } from "../../shared/api.ts";
import { stepNoun } from "../../shared/track-label.ts";
import { dateIn } from "../calls/wording.ts";

export type AllowedControl = Extract<ControlView, { readonly allowed: true }>;

/** The order the person page offers the controls in, as the approved prototype lays them out. */
export const LEAD_CONTROL_ORDER = ["pause", "resume", "skip", "stop", "resume_from_next_step", "move_to_win_back"] as const satisfies readonly LeadControlApi[];

/** Each control's button, as the prototype and the spec word it. */
export const CONTROL_LABEL = {
  pause: "Pause",
  resume: "Resume",
  skip: "Skip this step",
  stop: "Stop",
  resume_from_next_step: "Resume from the next step",
  move_to_win_back: "Move to win-back",
} as const satisfies Record<LeadControlApi, string>;

/** While a control is on its way: "Pausing…". */
export const CONTROL_PENDING = {
  pause: "Pausing",
  resume: "Resuming",
  skip: "Skipping the step",
  stop: "Stopping",
  resume_from_next_step: "Resuming from the next step",
  move_to_win_back: "Moving to win-back",
} as const satisfies Record<LeadControlApi, string>;

/** The controls the read allows now, in the prototype's order. A refused control is not offered. */
export function offeredControls(lead: Pick<RecordLead, "controls">): AllowedControl[] {
  return LEAD_CONTROL_ORDER.flatMap((action) => lead.controls.filter((c): c is AllowedControl => c.action === action && c.allowed));
}

/** A refused control's reason, from the read, for a control the spec's user expects in this status. */
export function refusalOf(lead: Pick<RecordLead, "controls">, action: LeadControlApi): string | null {
  const control = lead.controls.find((c) => c.action === action);
  return control && !control.allowed ? control.reason : null;
}

const timeIn = (zone: string, iso: string): string => new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

/** "Tue 3 Nov at 09:00", in the user's zone. */
export const whenIn = (userZone: string, iso: string): string => `${dateIn(userZone, iso)} at ${timeIn(userZone, iso)}`;

const lower = (label: string): string => (label.startsWith("SMS") ? label : label.charAt(0).toLowerCase() + label.slice(1));
const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** A step a control names, inside a sentence: "email 2 of 3", "text 1 of 2 on SMS track 2", "win-back email 1 of 2", "the call". */
export function stepPhrase(step: Pick<ControlStepView, "channel" | "track" | "number" | "of">): string {
  const on = step.track.several ? ` on ${lower(step.track.label)}` : "";
  switch (step.channel) {
    case "call":
      return `the call${on}`;
    case "email":
    case "sms":
      return `${lower(stepNoun(step.track, step.channel))} ${step.number} of ${step.of}${on}`;
    default: {
      const unhandled: never = step.channel;
      throw new Error(`A step on a channel with no name: ${String(unhandled)}`);
    }
  }
}

const due = (iso: string | null, userZone: string): string => (iso ? `, due ${whenIn(userZone, iso)}` : "");

/** Work already handed to a provider that may still be sent (ticket 17a's provider limitation, question Q17): said only when the read counts any. */
export function mayStillSendText(count: number): string | null {
  if (count <= 0) return null;
  return `${count === 1 ? "One message" : `${count} messages`} already handed to a provider may still be sent.`;
}

const join = (...parts: (string | null)[]): string => parts.filter((p): p is string => p !== null && p !== "").join(" ");

/** The step the person page names as the lead's current one (ADR 0003 Q3's interim): the step skip would skip, else the step a pause holds. */
function currentStepOf(lead: Pick<RecordLead, "controls">): ControlStepView | null {
  for (const c of lead.controls) if (c.action === "skip" && c.allowed && c.skips) return c.skips;
  for (const c of lead.controls) if (c.action === "pause" && c.allowed && c.next) return c.next;
  return null;
}

/** When the read says that step is due, if the lead keeps running: its track's pending step in the same read. */
function dueOf(lead: Pick<RecordLead, "tracks">, step: ControlStepView): string | null {
  return lead.tracks.find((t) => t.trackId === step.trackId && t.nextStep?.stepId === step.stepId)?.nextStep?.dueAt ?? step.dueAt;
}

/**
 * The plain sentence under a campaign row's status (spec "Person page", 2): where the lead stands and what comes next,
 * from the record's read of the enrollment. Every status has one; the record, and anything else that says a lead's
 * status in a sentence, uses this one function.
 */
export function nextStepSentence(lead: RecordLead, userZone: string): string {
  const step = currentStepOf(lead);
  const campaignPaused = lead.campaignState.paused;
  const frozen = "Waiting times are frozen while this campaign is paused.";
  const next = (): string => {
    if (!step) return refusalOf(lead, "skip") ?? "";
    if (campaignPaused) return join(`Next: ${stepPhrase(step)}.`, frozen);
    return `Next: ${stepPhrase(step)}${due(dueOf(lead, step), userZone)}.`;
  };
  const status: OutreachStatus = lead.status;
  switch (status) {
    case "queued":
      if (!lead.campaignState.launched) return "Nothing goes out until this campaign launches.";
      return join("Nothing has gone out yet.", next() || (campaignPaused ? frozen : ""));
    case "active":
    case "in_win_back":
      return next() || (campaignPaused ? frozen : status === "in_win_back" ? "In this campaign’s win-back branch." : "Their outreach is running.");
    case "waiting_on_call":
      if (campaignPaused) return "The call is on hold while this campaign is paused.";
      return step ? `Next: ${stepPhrase(step)}.` : "Waiting on a call on your list.";
    case "callback_scheduled":
      return campaignPaused ? "The callback is on hold while this campaign is paused." : "Waiting on the callback they asked for.";
    case "paused": {
      const resume = lead.controls.find((c): c is AllowedControl => c.action === "resume" && c.allowed);
      const held = resume?.next ?? null;
      return held ? `Paused before ${stepPhrase(held)}. Waiting times are frozen.` : "Paused. Waiting times are frozen.";
    }
    case "replied": {
      if (!lead.reply) return "They replied. Over to you.";
      const how = lead.reply.channel === "email" ? "Replied by email" : "Replied by text";
      return `${how} on ${whenIn(userZone, lead.reply.at)}. ${lead.reply.channel === "email" ? "Answer in Instantly." : "Answer on your phone."}`;
    }
    case "interested_on_call":
      return "Interested on the call. Over to you.";
    case "declined_on_call":
      return "Nothing more goes out to them in this campaign.";
    case "stopped_manually":
      return lead.endedAt ? `You stopped their outreach in this campaign on ${whenIn(userZone, lead.endedAt)}.` : "You stopped their outreach in this campaign.";
    case "sequence_finished_no_response":
      return "Their sequence finished with no reply.";
    case "finished_no_usable_channel":
      return "Nothing is left to reach them on in this campaign.";
    default: {
      const unhandled: never = status;
      throw new Error(`A status with no sentence: ${String(unhandled)}`);
    }
  }
}

/** What a control will do, before the user confirms: the read's preview, the engine's transition on a copy of the lead. */
export function controlPreviewText(control: AllowedControl, campaign: RecordLead["campaignState"], userZone: string): string {
  const provider = mayStillSendText(control.withProvider);
  const next = control.next;
  switch (control.action) {
    case "pause":
      return join("Nothing more goes out to them in this campaign and every wait freezes until you resume them.", next ? `${capital(stepPhrase(next))} waits.` : null, provider);
    case "resume":
      if (campaign.paused) return join("Their own pause ends.", next ? `${capital(stepPhrase(next))} still waits while this campaign is paused.` : "Their outreach stays held while this campaign is paused.");
      if (control.statusAfter === "callback_scheduled") return "Their own pause ends. Their callback still holds their outreach until you log how it went.";
      return next ? `Their outreach continues where it was: ${stepPhrase(next)}${due(next.dueAt, userZone)}.` : "Their outreach continues where it was.";
    case "skip": {
      const skips = control.skips;
      const what = !skips ? "The current step is skipped and never sent." : skips.channel === "call" ? `${capital(stepPhrase(skips))} is skipped and never made.` : `${capital(stepPhrase(skips))} is skipped and never sent.`;
      return join(what, next ? `Next: ${stepPhrase(next)}${due(next.dueAt, userZone)}.` : null);
    }
    case "stop":
      return join("Their outreach in this campaign stops: nothing more goes out and no call is listed. What was sent stays on record.", provider);
    case "resume_from_next_step":
      return join(next ? `They resume at the next unsent step: ${stepPhrase(next)}${due(next.dueAt, userZone)}.` : "They resume at the next unsent step.", campaign.paused ? "It waits while this campaign is paused." : null, "Nothing already sent goes again.");
    case "move_to_win_back":
      return join(next ? `They move to this campaign’s win-back branch, starting with ${stepPhrase(next)}${due(next.dueAt, userZone)}.` : "They move to this campaign’s win-back branch.", campaign.paused ? "It waits while this campaign is paused." : null, "Their remaining main-sequence steps are dropped.");
    default: {
      const unhandled: never = control.action;
      throw new Error(`A control with no preview: ${String(unhandled)}`);
    }
  }
}

/** What a control did, from its answer's `effect` (the preview at that instant): history, in the past tense. */
export function controlEffectText(effect: AllowedControl, userZone: string): string {
  const provider = mayStillSendText(effect.withProvider);
  const next = effect.next;
  const thenNext = next && next.dueAt ? `Next: ${stepPhrase(next)}${due(next.dueAt, userZone)}.` : null;
  switch (effect.action) {
    case "pause":
      return join(next ? `Paused. ${capital(stepPhrase(next))} waits until you resume them.` : "Paused.", provider);
    case "resume":
      return join("Resumed.", thenNext);
    case "skip": {
      const skips = effect.skips;
      return join(!skips ? "Step skipped." : skips.channel === "call" ? "Call skipped." : `${capital(stepPhrase(skips))} skipped.`, next ? `Next: ${stepPhrase(next)}${due(next.dueAt, userZone)}.` : null);
    }
    case "stop":
      return join("Stopped.", provider);
    case "resume_from_next_step":
      return next ? `Resumed from the next step: ${stepPhrase(next)}${due(next.dueAt, userZone)}.` : "Resumed from the next step.";
    case "move_to_win_back":
      return join("Moved to the win-back branch.", next ? `Next: ${stepPhrase(next)}${due(next.dueAt, userZone)}.` : null);
    default: {
      const unhandled: never = effect.action;
      throw new Error(`A control with no effect sentence: ${String(unhandled)}`);
    }
  }
}

const GROUP_LABEL = {
  running: "Running",
  waiting_on_you: "Waiting on you",
  handed_to_you: "Handed to you",
  paused: "Paused",
  ended: "Ended",
} as const satisfies Record<StatusGroup, string>;

/** The count of leads in each status group, as the spec groups them, summed from the read's count in each status. */
export function statusGroupCounts(counts: Readonly<Record<OutreachStatus, number>>): { group: StatusGroup; label: string; count: number }[] {
  return STATUS_GROUPS.map((group) => ({
    group,
    label: GROUP_LABEL[group],
    count: (Object.entries(counts) as [OutreachStatus, number][]).filter(([status]) => statusGroup(status) === group).reduce((sum, [, n]) => sum + n, 0),
  }));
}

/** The Paused banner's title, with the date the read says the campaign was paused, and what may still go. */
export function pausedBannerText(read: CampaignPauseRead, userZone: string): { title: string; provider: string | null } {
  return { title: read.pause.pausedSince ? `Paused since ${whenIn(userZone, read.pause.pausedSince)}` : "Paused", provider: mayStillSendText(read.mayStillSend) };
}

/** A campaign's pause or resume, in its in-page confirmation (the prototype's words). */
export function campaignConfirmText(action: "pause" | "resume", name: string, read: CampaignPauseRead): string {
  switch (action) {
    case "pause":
      return join(`Pause ${name}? Messages stop, its calls leave your list, and every waiting time freezes.`, mayStillSendText(read.mayStillSend));
    case "resume":
      return `Resume ${name}? Each lead continues where it was, spread across the sending window.`;
    default: {
      const unhandled: never = action;
      throw new Error(`A campaign control with no confirmation: ${String(unhandled)}`);
    }
  }
}

/** What a campaign's pause or resume did. */
export const CAMPAIGN_DONE = { pause: "Paused. Its calls are off your list and every wait is frozen until you resume it.", resume: "Resumed. Each lead continues where it was." } as const;
