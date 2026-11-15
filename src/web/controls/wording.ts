/**
 * Every sentence ticket 17b's screens say about pausing, resuming, skipping, stopping and restarting, one function per
 * state (ADR 0003 "Ticket 17a", "Reads"). Each reads only a field of the server's read (an enrollment's read, a campaign's
 * read) or a control's answer, and says days and times in the zone passed in: none decides which control applies, which
 * step is next, when it is due or what a control did. History is said in the past tense; a present state only as the
 * read says it at its instant.
 */
import { STATUS_GROUPS, statusGroup, type StatusGroup } from "../../domain/outreach-status.ts";
import type { CampaignPauseRead, ControlStepView, ControlView, LeadControlApi, OutreachStatus, RecordLead, StepWaitApi, StepWhenView } from "../../shared/api.ts";
import { stepNoun } from "../../shared/track-label.ts";
import { callHoldSentence, dateIn, HOLD_REASON, HOURS_CLOSED_PHRASE, listedForPhrase } from "../calls/wording.ts";
import { dayLabel } from "../calls/callbackTime.ts";
import { STATUS_GROUP_LABEL } from "../status.tsx";

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

/**
 * Why a step has no time, as the read gives it (`StepWaitApi`), in one exhaustive switch. None promises a time: the engine
 * cannot know when what holds the step ends (ADR 0003 "Reads that say when"). Provisional wording, for the principal.
 */
export function stepWaitWords(why: StepWaitApi): string {
  switch (why) {
    case "campaign_not_launched":
      return "waiting for this campaign to launch";
    case "campaign_paused":
      return "on hold while this campaign is paused";
    case "lead_paused":
      return "on hold while they are paused";
    case "callback":
      return "on hold until you log the callback";
    case "ended":
      return "not going: their outreach in this campaign has ended";
    case "with_provider":
      return "already handed to the provider, which sends it";
    case "unresolved":
    case "render_failed":
    case "provider_skipped":
    case "no_thread":
    case "sms_conversation_taken":
      return `held: ${HOLD_REASON[why]}`;
    case "no_window":
      return "not going: its sending hours never open";
    case "no_transport":
      return "waiting: the email provider can’t send a follow-up in its thread yet";
    case "waiting_on_provider":
      return "waiting: sending is interrupted, and it goes once its provider answers again";
    case "reply_pending":
      return "waiting while a reply from them is matched to its thread";
    case "no_destination":
      return "not going: there is no good address to send it to";
    case "sender_busy":
      return "waiting for its sender to finish the sends it has under way";
    case "call_hours_closed":
      return HOURS_CLOSED_PHRASE;
    case "sender_unavailable":
      return "waiting for a sender account that can send";
    case "sending_capacity":
      return "waiting for sending capacity: every account it may use is full today";
    case "call_capacity":
      return "waiting for room on your call list, on a day with calling hours";
    case "on_call_list":
      return "on your call list";
    default: {
      const unhandled: never = why;
      throw new Error(`A reason a step waits with no words: ${String(unhandled)}`);
    }
  }
}

/**
 * When a step goes, from the read (`StepWhenView`): "due now" only when dispatch hands it over on its next round; a later
 * instant as the earliest it can go, never as a promise ("earliest Tue 10 Nov at 09:00", in the user's zone), since what the
 * engine cannot know yet (another lead going first, tomorrow's room) can move it later (verifier on 178de98, item 9); or
 * why it waits. Provisional wording, for the principal.
 */
export function stepWhenPhrase(when: StepWhenView, userZone: string): string {
  switch (when.kind) {
    case "now":
      return "due now";
    case "at":
      return `earliest ${whenIn(userZone, when.at)}`;
    case "waits":
      return stepWaitWords(when.why);
    // A call goes on the list on a day, never at a time of day (council on 178de98, item 3).
    case "call_day":
      return when.today ? "goes on your call list today" : `on your call list from ${dayLabel(when.day)} at the earliest`;
    case "listed_for":
      return listedForPhrase(when.day);
    default: {
      const unhandled: never = when;
      throw new Error(`A step time the page cannot say: ${String(unhandled)}`);
    }
  }
}

const due = (when: StepWhenView | null, userZone: string): string => (when ? `, ${stepWhenPhrase(when, userZone)}` : "");

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

/** When the read says that step goes (the engine's `stepWhen`): its track's pending step in the same read. */
function dueOf(lead: Pick<RecordLead, "tracks">, step: ControlStepView): StepWhenView | null {
  return lead.tracks.find((t) => t.trackId === step.trackId && t.nextStep?.stepId === step.stepId)?.nextStep?.when ?? step.when;
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
      if (campaignPaused) return callHoldSentence("call", "campaign_paused");
      return step ? `Next: ${stepPhrase(step)}.` : "Waiting on a call on your list.";
    case "callback_scheduled":
      return campaignPaused ? callHoldSentence("callback", "campaign_paused") : "Waiting on the callback they asked for.";
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

/**
 * Whether a row in this status says where it stands by its open call's line (`recordCallLine`, "Their call is on today's
 * list…"), when the record has one, instead of the next-step sentence beside it: one sentence per row, as the prototype
 * says it (council on 57d874f, item 4b). Every other status says it by `nextStepSentence`.
 */
export const CALL_LINE_IS_THE_SENTENCE = {
  queued: false,
  active: false,
  in_win_back: false,
  waiting_on_call: true,
  callback_scheduled: true,
  replied: false,
  interested_on_call: false,
  paused: false,
  declined_on_call: false,
  stopped_manually: false,
  sequence_finished_no_response: false,
  finished_no_usable_channel: false,
} as const satisfies Record<OutreachStatus, boolean>;

/**
 * What skipping a call step does, from the server's record of it (council on 57d874f, item 8): a callback is skipped; a call
 * already tried has its remaining attempts skipped; only an untried call is never made.
 */
function callSkipPreview(skips: ControlStepView): string {
  const on = skips.track.several ? `on ${lower(skips.track.label)}` : "on this phone track";
  if (skips.call?.callback) return `The callback is skipped: no further call is made ${on}.`;
  if ((skips.call?.attempts ?? 0) > 0) return `The call’s remaining attempts are skipped: no further call is made ${on}.`;
  return `${capital(stepPhrase(skips))} is skipped and never made.`;
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
      return next ? `Their outreach continues where it was: ${stepPhrase(next)}${due(next.when, userZone)}.` : "Their outreach continues where it was.";
    case "skip": {
      const skips = control.skips;
      const what = !skips ? "The current step is skipped and never sent." : skips.channel === "call" ? callSkipPreview(skips) : `${capital(stepPhrase(skips))} is skipped and never sent.`;
      return join(what, next ? `Next: ${stepPhrase(next)}${due(next.when, userZone)}.` : null);
    }
    case "stop":
      return join("Their outreach in this campaign stops: nothing more goes out and no call is listed. What was sent stays on record.", provider);
    case "resume_from_next_step":
      return join(next ? `They resume at the next unsent step: ${stepPhrase(next)}${due(next.when, userZone)}.` : "They resume at the next unsent step.", campaign.paused ? "It waits while this campaign is paused." : null, "Nothing already sent goes again.");
    case "move_to_win_back":
      return join(next ? `They move to this campaign’s win-back branch, starting with ${stepPhrase(next)}${due(next.when, userZone)}.` : "They move to this campaign’s win-back branch.", campaign.paused ? "It waits while this campaign is paused." : null, "Their remaining main-sequence steps are dropped.");
    default: {
      const unhandled: never = control.action;
      throw new Error(`A control with no preview: ${String(unhandled)}`);
    }
  }
}

/**
 * What a control did, from its answer's `effect` (the preview at that instant): history, in the past tense. It never says
 * what may still be sent: that is a present state, said only by the current read (`mayStillSendText` on the record's
 * `mayStillSend` and the banner), and gone when the read says zero (verifier B3 on 8a1732a).
 */
export function controlEffectText(effect: AllowedControl): string {
  // Only what changed (council on 57d874f, item 4a): the row's sentence, read again after the answer, says where they stand now.
  switch (effect.action) {
    case "pause":
      return "Paused.";
    case "resume":
      return "Resumed.";
    case "skip": {
      const skips = effect.skips;
      return !skips ? "Step skipped." : skips.channel === "call" ? (skips.call?.callback ? "Callback skipped." : (skips.call?.attempts ?? 0) > 0 ? "Remaining call attempts skipped." : "Call skipped.") : `${capital(stepPhrase(skips))} skipped.`;
    }
    case "stop":
      return "Stopped.";
    case "resume_from_next_step":
      return "Resumed from the next step.";
    case "move_to_win_back":
      return "Moved to the win-back branch.";
    default: {
      const unhandled: never = effect.action;
      throw new Error(`A control with no effect sentence: ${String(unhandled)}`);
    }
  }
}

/** The count of leads in each status group, as the spec groups them, summed from the read's count in each status. */
export function statusGroupCounts(counts: Readonly<Record<OutreachStatus, number>>): { group: StatusGroup; label: string; count: number }[] {
  return STATUS_GROUPS.map((group) => ({
    group,
    label: STATUS_GROUP_LABEL[group],
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
export const CAMPAIGN_DONE = { pause: "Paused. Its calls left your list and its waits froze.", resume: "Resumed. Each lead continued where it was." } as const;
