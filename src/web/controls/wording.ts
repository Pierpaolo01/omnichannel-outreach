/**
 * Every sentence ticket 17b's screens say about pausing, resuming, skipping, stopping and restarting, one function per
 * state (ADR 0003 "Ticket 17a", "Reads"). Each reads only a field of the server's read (an enrollment's read, a campaign's
 * read) or a control's answer, and says days and times in the zone passed in: none decides which control applies, which
 * step is next, when it is due or what a control did. History is said in the past tense; a present state only as the
 * read says it at its instant.
 */
import { markLabels, markRepliedWords } from "../campaign/reply-mark-wording.ts";
import { capitalANameOf, isMessageRequestChannel, isSocialChannel, MESSAGE_REQUEST_CHANNELS, SOCIAL_CHANNELS, type MessageRequestChannel } from "../../domain/social-channels.ts";
import type { TrackChannelApi, SendChannelApi } from "../../shared/api.ts";
import { STATUS_GROUPS, statusGroup, type StatusGroup } from "../../domain/outreach-status.ts";
import { clockTime } from "../time.ts";
import type { AttemptState } from "../../domain/sequence/state.ts";
import type { CampaignPauseRead, ControlStepView, ControlView, LeadControlApi, OutreachStatus, RecordLead, StepWaitApi, StepWhenView } from "../../shared/api.ts";
import { lowerLabel, stepTitle } from "../../shared/track-label.ts";
import { callHoldSentence, dateIn, holdReasonClause, HOURS_CLOSED_PHRASE, listedForPhrase } from "../calls/wording.ts";
import { dayLabel } from "../calls/callbackTime.ts";
import { STATUS_GROUP_LABEL } from "../status.tsx";
import type { RecordControl } from "./requests.ts";
import { INVITE_STAYS_OPEN } from "../campaign/linkedin-wording.ts";

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
  // Ticket 24b: the reply mark and a stuck withdrawal's two answers, pressed and stored like the controls; the mark per channel (ticket 25).
  ...markLabels((c) => markRepliedWords(c).label),
  invite_withdrawn: "It’s withdrawn",
  invite_kept: "It’s still there",
} as const satisfies Record<RecordControl, string>;

/** While a control is on its way: "Pausing…". */
export const CONTROL_PENDING = {
  pause: "Pausing",
  resume: "Resuming",
  skip: "Skipping the step",
  stop: "Stopping",
  resume_from_next_step: "Resuming from the next step",
  move_to_win_back: "Moving to win-back",
  ...markLabels((c) => markRepliedWords(c).pending),
  invite_withdrawn: "Marking the invite withdrawn",
  invite_kept: "Marking the invite still there",
} as const satisfies Record<RecordControl, string>;

/** The controls the read allows now, in the prototype's order. A refused control is not offered. */
export function offeredControls(lead: Pick<RecordLead, "controls">): AllowedControl[] {
  return LEAD_CONTROL_ORDER.flatMap((action) => lead.controls.filter((c): c is AllowedControl => c.action === action && c.allowed));
}

/** A refused control's reason, from the read, for a control the spec's user expects in this status. */
export function refusalOf(lead: Pick<RecordLead, "controls">, action: LeadControlApi): string | null {
  const control = lead.controls.find((c) => c.action === action);
  return control && !control.allowed ? control.reason : null;
}

const timeIn = (zone: string, iso: string): string => clockTime(zone, iso);

/** "Tue 3 Nov at 09:00", in the user's zone. */
export const whenIn = (userZone: string, iso: string): string => `${dateIn(userZone, iso)} at ${timeIn(userZone, iso)}`;

const lower = lowerLabel;
const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** A step a control names, inside a sentence: "email 2 of 3", "text 1 of 2 on SMS track 2", "win-back email 1 of 2", "the call". */
export function stepPhrase(step: Pick<ControlStepView, "channel" | "track" | "number" | "of"> & { readonly role?: "inmail" }): string {
  const on = step.track.several ? ` on ${lower(step.track.label)}` : "";
  switch (step.channel) {
    case "call":
      return `the call${on}`;
    case "email":
    case "sms":
      return `${lower(stepTitle(step.track, step.channel, step.number))} of ${step.of}${on}`;
    // A social step by its role (ticket 24b, ticket 25): "the first message", "the message request", "follow-up 2 on LinkedIn track 2".
    case "linkedin":
    default: {
      if (step.channel !== "linkedin" && !isSocialChannel(step.channel)) {
        const unhandled: never = step.channel;
        throw new Error(`A step on a channel with no name: ${String(unhandled)}`);
      }
      // The InMail fallback keeps its capitals: "the InMail" (ADR 0004 14.9).
      if (step.channel === "linkedin" && step.role === "inmail") return `${step.track.branch === "win_back" ? "the win-back InMail" : "the InMail"}${on}`;
      const title = lower(stepTitle(step.track, step.channel, step.number));
      return `${title.startsWith("follow-up") ? title : `the ${title}`}${on}`;
    }
  }
}

/**
 * Why a step has no time, as the read gives it (`StepWaitApi`), in one exhaustive switch. None promises a time: the engine
 * cannot know when what holds the step ends (ADR 0003 "Reads that say when"). Provisional wording, for the principal.
 */
// `channel` is required, never defaulted: a caller that forgot it would word a text's reason as an email's (the re-check of
// ff01571: the Test run tab named the email provider for an SMS transport hold).
export function stepWaitWords(why: StepWaitApi, channel: TrackChannelApi): string {
  switch (why) {
    case "campaign_not_launched":
      return "waiting for this campaign to launch";
    case "campaign_paused":
      return "on hold while this campaign is paused";
    case "lead_paused":
      return "on hold while they are paused";
    case "callback":
      return "on hold while their callback is open";
    case "ended":
      return "not going: their outreach in this campaign has ended";
    // Handed over and not yet reported (council on dee365d, item 11): never a promise that it will go.
    case "with_provider":
      return "handed to the provider; it isn’t known yet whether it went";
    case "unresolved":
    case "render_failed":
    case "provider_skipped":
    case "no_thread":
    case "sms_conversation_unsettled":
      return `held: ${holdReasonClause(why, [], channel)}`;
    case "no_window":
      return "not going: its sending hours never open";
    case "no_transport":
      // Per channel (council on cc9bf55, item 5): only email has such a step today, but the words must hold for a text.
      return channel === "sms" ? "waiting: the SMS provider can’t send this text yet" : "waiting: the email provider can’t send a follow-up in its thread yet";
    case "waiting_on_provider":
      // A reason promises nothing (council on cc9bf55, item 9): the read after the cause clears says when.
      return "waiting: sending is interrupted";
    case "reply_pending":
      return "waiting while a reply from them is matched to its thread";
    case "no_destination":
      return "not going: there is no good address to send it to";
    case "sender_slot":
      // Its claim's sender's pacing slot is not reached; a slot only moves later. No time is promised.
      return "waiting for its sender’s next sending slot";
    case "sender_rate_limited":
      return "waiting: the provider is limiting how fast its senders can send";
    case "sender_waiting":
      return "waiting for a sender that can take it";
    case "call_hours_closed":
      return HOURS_CLOSED_PHRASE;
    case "sender_unavailable":
      return "waiting for a sender account that can send";
    case "sending_capacity":
      return "waiting for sending capacity: every account it may use is full today";
    // Item 15: no session it may use has any allowance of the step's kind, so nothing resets it and no time is given.
    case "no_allowance":
      // In the step's own channel's name (ticket 25): never another channel's.
      return isMessageRequestChannel(channel)
        ? `waiting: no ${SOCIAL_CHANNELS[channel].name} session it may use has an allowance for messages`
        : isSocialChannel(channel)
          ? `waiting: no ${SOCIAL_CHANNELS[channel].name} session it may use has an allowance for this kind of step`
          : "waiting: no sender it may use has an allowance for this kind of step";
    case "call_capacity":
      return "waiting for room on your call list, on a day with calling hours";
    case "on_call_list":
      return "on your call list";
    case "awaiting_acceptance":
      return "waiting for them to accept the LinkedIn invite";
    case "invite_pending_elsewhere":
      return "on hold: an invite to them is already pending on LinkedIn that this application didn’t send";
    // ADR 0004 14.3: the InMail the wait's end chose, whose session can't send it now by its own report. No time.
    case "inmail_unavailable":
      return "waiting: your LinkedIn session can’t send an InMail now";
    default: {
      const unhandled: never = why;
      throw new Error(`A reason a step waits with no words: ${String(unhandled)}`);
    }
  }
}

/** Why a chosen InMail can't go now, as of its session's latest report (ADR 0004 14.5); none promises when it will. */
function inmailUnavailableWords(cause: NonNullable<Extract<StepWhenView, { kind: "waits" }>["inmail"]>, reportedAt: string | undefined, userZone: string): string {
  const asOf = reportedAt ? ` (as your session last reported on ${dateIn(userZone, reportedAt)})` : "";
  switch (cause) {
    case "no_plan":
      return `waiting: your LinkedIn session doesn’t report Premium or Sales Navigator${asOf}, so the InMail can’t go`;
    case "stale_report":
      return `waiting: your LinkedIn session hasn’t reported for over a day${reportedAt ? ` (its last report was on ${dateIn(userZone, reportedAt)})` : ""}, so no InMail goes on it`;
    case "no_holding":
      return `waiting for an InMail credit to be free on your LinkedIn session${asOf}: other leads’ InMails hold its credits`;
    case "unbacked":
      return `waiting: your LinkedIn session reports fewer InMail credits${asOf} than InMails chosen before this one`;
    default: {
      const unhandled: never = cause;
      throw new Error(`An InMail wait with no words: ${String(unhandled)}`);
    }
  }
}

/**
 * When a step goes, from the read (`StepWhenView`): ready, when its time has come and nothing of its own holds it, in line
 * for its sender and never "now" (other leads may go first); a later instant, given only while the step waits on time alone,
 * as the earliest it can go, never as a promise ("earliest Tue 10 Nov at 09:00", in the user's zone); or why it waits, with
 * no time. Provisional wording, for the principal.
 */
export function stepWhenPhrase(when: StepWhenView, userZone: string): string {
  switch (when.kind) {
    case "ready":
      return "ready to send, in line for its sender";
    case "at":
      return `earliest ${whenIn(userZone, when.at)}`;
    case "waits":
      // The day an acceptance wait ends is a fact of the read, said as when the wait ends, never as when a send goes (ADR 0004 9).
      if (when.why === "awaiting_acceptance" && when.until !== undefined) return `${stepWaitWords(when.why, when.channel)}; the wait ends ${dateIn(userZone, when.until)}`;
      if (when.why === "inmail_unavailable" && when.inmail !== undefined) return inmailUnavailableWords(when.inmail, when.reportedAt, userZone);
      return stepWaitWords(when.why, when.channel);
    // A call goes on the list on a day, never at a time of day (council on 178de98, item 3).
    case "call_day":
      // Due, with calling hours open and room on today's list: ready for the list, which the next round fills in order.
      if (when.now) return "ready to go on your call list";
      return when.today ? "on your call list later today at the earliest" : `on your call list from ${dayLabel(when.day)} at the earliest`;
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
 * What of this lead's outreach has left the app (verifier on f2824d4, item 10): three states on every channel, never two,
 * each from a stored fact. `nothing`: nothing handed to any provider, a claim never handed over included (the council on
 * 5a30b9f: a claim is not a handover). `unknown`: work the app handed over (`handedAt`, stored in the handover's own write)
 * that is not known to have gone or not: it may have reached them, so "nothing has gone out" would be untrue. `sent`:
 * something recorded sent. Each names the channel of the work it speaks of.
 */
export type OutgoingSoFar = { readonly state: "nothing" } | { readonly state: "unknown"; readonly channel: TrackChannelApi } | { readonly state: "sent"; readonly channel: TrackChannelApi };

export function outgoingSoFar(lead: Pick<RecordLead, "tracks">): OutgoingSoFar {
  let unknown: TrackChannelApi | null = null;
  for (const track of lead.tracks) {
    for (const step of track.steps) {
      for (const send of step.sends) {
        const state: AttemptState = send.state;
        const handed = send.handedAt !== null;
        switch (state) {
          case "sent":
            return { state: "sent", channel: track.channel };
          // A claim is said by whether it was handed over, not by its state's name: never handed, nothing went.
          case "claimed":
          case "handed":
          case "accepted":
            if (handed) unknown ??= track.channel;
            break;
          // Ended: refused or withdrawn and known so, nothing went; ended with its outcome untold, as handed if it was.
          case "rejected":
          case "withdrawn":
            if (handed && send.unresolved) unknown ??= track.channel;
            break;
          default: {
            const unhandled: never = state;
            throw new Error(`An attempt state with no meaning here: ${String(unhandled)}`);
          }
        }
      }
      if (step.result === "sent") return { state: "sent", channel: track.channel };
    }
  }
  return unknown === null ? { state: "nothing" } : { state: "unknown", channel: unknown };
}

/** What a handed-over piece of work is on each channel, as the sentence names it. */
const handedNoun = (): Readonly<Record<TrackChannelApi, string>> => ({
  email: "An email",
  sms: "A text",
  call: "A call",
  linkedin: "A LinkedIn invite or message",
  ...(Object.fromEntries(MESSAGE_REQUEST_CHANNELS.map((c) => [c, `${capitalANameOf(c)} message`])) as Record<MessageRequestChannel, string>),
});

export function soFarSentence(soFar: OutgoingSoFar): string {
  switch (soFar.state) {
    case "nothing":
      return "Nothing has gone out yet.";
    case "unknown":
      return `${handedNoun()[soFar.channel]} was handed over, and it isn’t known yet whether it went.`;
    case "sent":
      return `${handedNoun()[soFar.channel]} has gone out.`;
    default: {
      const unhandled: never = soFar;
      throw new Error(`A state with no sentence: ${JSON.stringify(unhandled)}`);
    }
  }
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
  // A held step is never said to be due: the row says why, in the wording Needs attention uses (ADR 0003 5.4).
  const held = step ? lead.tracks.find((t) => t.trackId === step.trackId && t.nextStep?.stepId === step.stepId && t.hold !== null) : undefined;
  const next = (): string => {
    if (!step) return refusalOf(lead, "skip") ?? "";
    if (campaignPaused) return join(`Next: ${stepPhrase(step)}.`, frozen);
    if (held?.hold) return `Next: ${stepPhrase(step)}, on hold because ${holdReasonClause(held.hold, held.holdOwners, step.channel)}.`;
    return `Next: ${stepPhrase(step)}${due(dueOf(lead, step), userZone)}.`;
  };
  const status: OutreachStatus = lead.status;
  switch (status) {
    case "queued":
      if (!lead.campaignState.launched) return "Nothing goes out until this campaign launches.";
      return join(soFarSentence(outgoingSoFar(lead)), next() || (campaignPaused ? frozen : ""));
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
      const words = REPLY_WORDS[lead.reply.channel];
      return `${words.how} on ${whenIn(userZone, lead.reply.at)}. ${words.answer}`;
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
export function controlPreviewText(control: AllowedControl, campaign: RecordLead["campaignState"], userZone: string, inviteOpen = false): string {
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
      // Q38's interim (ADR 0004 3.4): a stop never withdraws a LinkedIn invite already sent, so the confirmation says so.
      return join("Their outreach in this campaign stops: nothing more goes out and no call is listed. What was sent stays on record.", provider, inviteOpen ? INVITE_STAYS_OPEN.stop : null);
    case "resume_from_next_step":
      return join(next ? `They resume at the next unsent step: ${stepPhrase(next)}${due(next.when, userZone)}.` : "They resume at the next unsent step.", campaign.paused ? "It waits while this campaign is paused." : null, "Nothing already sent goes again.");
    case "move_to_win_back":
      return join(next ? `They move to this campaign’s win-back branch, starting with ${stepPhrase(next)}${due(next.when, userZone)}.` : "They move to this campaign’s win-back branch.", campaign.paused ? "It waits while this campaign is paused." : null, "Their remaining main-sequence steps are dropped.", inviteOpen ? INVITE_STAYS_OPEN.move_to_win_back : null);
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

/**
 * A reply's channel in words, one entry per channel (council on 194fc44, item 4): every sentence keyed on a reply's channel
 * reads it here, so a channel added later fails typecheck until it has its words. A LinkedIn reply is the user's own mark.
 */
// `activity`: what Activity says after "Automation stopped in this campaign." (council on b21af02, item 1).
export const REPLY_WORDS: Readonly<Record<SendChannelApi, { readonly how: string; readonly title: string; readonly answer: string; readonly activity: string }>> = {
  email: { how: "Replied by email", title: "Replied by email", answer: "Answer in Instantly.", activity: "Read and answer the reply in Instantly." },
  sms: { how: "Replied by text", title: "Replied by text", answer: "Answer on your phone.", activity: "Answer the reply on your phone." },
  linkedin: { how: "Marked replied on LinkedIn by you", title: "You marked them replied on LinkedIn", answer: "Carry on the conversation on LinkedIn.", activity: "Carry on the conversation on LinkedIn." },
  ...(Object.fromEntries(
    MESSAGE_REQUEST_CHANNELS.map((c) => {
      const name = SOCIAL_CHANNELS[c].name;
      return [c, { how: `Marked replied on ${name} by you`, title: `You marked them replied on ${name}`, answer: `Carry on the conversation on ${name}.`, activity: `Carry on the conversation on ${name}.` }];
    }),
  ) as { readonly [C in MessageRequestChannel]: { readonly how: string; readonly title: string; readonly answer: string; readonly activity: string } }),
};
