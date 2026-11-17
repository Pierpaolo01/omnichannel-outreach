/**
 * A campaign's definition (ADR 0003 1.1) and the definitions refused at the boundary (7.1).
 * Ticket 13 runs email and SMS tracks in the main branch, connected together or after a delay;
 * ticket 14 adds phone tracks, each exactly one call; ticket 16 adds each phone track's declined path
 * and the campaign's win-back branch: email and SMS tracks, arranged like the main sequence, that a
 * lead enters when it declines on a call, with no call.
 */
import { isTimeZone, type WindowRule } from "./clock.ts";
import { isMessageRequestChannel, MESSAGE_REQUEST_CHANNELS, SOCIAL_CHANNEL_LIST, SOCIAL_CHANNELS, type MessageRequestChannel, type SocialChannel } from "../social-channels.ts";

export type TrackChannel = "email" | "sms" | "call" | SocialChannel;
/**
 * The channels whose sends are a conversation between one sender account and one destination (ADR 0003 4.5 as generalised
 * by ADR 0004, question Q41): an SMS number and a mobile, a LinkedIn session and a profile. A reply there cannot say which
 * campaign it answers, so the pair belongs to the first subject known to have reached it. The one test of it.
 */
export type ConversationChannel = "sms" | SocialChannel;
export const holdsConversations = (channel: TrackChannel | undefined): channel is ConversationChannel => channel === "sms" || channel === "linkedin" || isMessageRequestChannel(channel);
/** Every channel of conversations, for tests that every one has its words. */
export const CONVERSATION_CHANNELS: readonly ConversationChannel[] = ["sms", ...SOCIAL_CHANNEL_LIST];

/** The channels a sender account serves (a phone track needs none): email, SMS and the social channels (ADR 0004). */
export type SendChannel = Exclude<TrackChannel, "call">;
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
  /**
   * A LinkedIn track's acceptance wait (ADR 0004 3.1): whole days, at least 1, after the invite is sent for it to be
   * accepted. Required on a LinkedIn track and on no other.
   */
  readonly acceptWaitDays?: number;
  /**
   * A message-request track's sender sessions, chosen by the user for this track (ADR 0004 13.5: "the user chooses each
   * track's sender account"): the sessions it may send from, each a personal profile or a business account. Absent or
   * empty: none chosen, which launch blocker 3 names. On a message-request track only.
   */
  readonly senders?: readonly string[];
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
  /** LinkedIn sender sessions LinkedIn tracks may use (ADR 0004 1.1). Absent before ticket 24: none. */
  readonly linkedinPool?: readonly string[];
  readonly tracks: readonly TrackDefinition[];
}

/**
 * A phone track's declined path: the one the canvas set, else stop (question Q14's interim: a definition
 * saved before ticket 16, or a phone track the canvas has not set a path on, stops the lead).
 */
export const declinedPathOf = (track: Pick<TrackDefinition, "declinedPath"> | undefined): DeclinedPath => track?.declinedPath ?? "stop";

/**
 * The one way the product says the win-back branch cannot be entered (council on aaf82b7; ticket 16c): it has no
 * live track. The validator's refusal (7.1), the editor beside win back, the outcome's refusal (`logCallOutcome`)
 * and the Calls page's reason all say it with these words.
 */
export const WIN_BACK_HAS_NO_TRACKS = "the win-back branch has no tracks";
/**
 * What to do when a phone track's declined path is win back and the branch has no live track: the clause the
 * validator's refusal ends with (7.1), which the editor also shows beside win back while it cannot be chosen.
 */
export const NO_WIN_BACK_BRANCH = `${WIN_BACK_HAS_NO_TRACKS}: add a track to it, or choose stop or continue.`;

/** Whether a lead can enter the campaign's win-back branch: it has a live track. */
export const winBackAvailable = (def: CampaignDefinition): boolean => def.tracks.some((t) => !t.removed && t.branch === "win_back");

/**
 * How a lead can enter the campaign's win-back branch (council on aaf82b7), from the definition alone:
 * - `declined_path`: some live phone track of the main sequence has win back as its declined path
 *   (`declinedPathOf`), so a declined call there moves the lead in;
 * - `chosen_for_a_lead`: the branch has a live track and the main sequence a live phone track, but no
 *   path is win back, so a lead enters it only when win back is chosen for them as their declined call is
 *   logged (the outcome's per-lead path, ticket 16a: offered whenever `winBackAvailable`);
 * - `never`: the branch has no live track, or the main sequence has no live phone track to decline on.
 * The copy preview says it, and the estimate's `winBackNotCounted` reads it, so the two cannot disagree.
 */
export type WinBackEntry = "declined_path" | "chosen_for_a_lead" | "never";
export function winBackEntry(def: CampaignDefinition): WinBackEntry {
  const calls = liveTracks(def, "main").filter((t) => t.channel === "call");
  if (!winBackAvailable(def) || calls.length === 0) return "never";
  return calls.some((t) => declinedPathOf(t) === "win_back") ? "declined_path" : "chosen_for_a_lead";
}

/** An empty definition for a new campaign. */
export function emptyDefinition(timezone: string): CampaignDefinition {
  return { timezone, callSkipLimitDays: 2, emailPool: [], smsPool: [], tracks: [] };
}

/** The definition's field that holds each sending channel's pool (ADR 0004 13.2): one entry per channel. */
/**
 * The definition's field that holds each campaign-wide pool (ADR 0004 13.2). A message-request channel has none: each of its
 * tracks holds the senders the user chose for it (`senders`), so a new message-request channel adds no field here.
 */
export const POOL_FIELD = { email: "emailPool", sms: "smsPool", linkedin: "linkedinPool" } as const satisfies { readonly [C in Exclude<SendChannel, MessageRequestChannel>]: keyof CampaignDefinition };

/**
 * The sender accounts tracks on `channel` may use: the campaign's pool, or for a message-request channel every session any
 * of its live tracks on that channel chose (for loading accounts and judging what competes). A track's own senders are
 * `trackPool`'s: dispatch, the validator and the launch check read that.
 */
export function poolOf(def: CampaignDefinition, channel: TrackChannel): readonly string[] {
  if (channel === "call") return [];
  if (isMessageRequestChannel(channel)) return [...new Set(def.tracks.filter((t) => !t.removed && t.channel === channel).flatMap((t) => t.senders ?? []))];
  return def[POOL_FIELD[channel]] ?? [];
}

/** The sender accounts this track may use (ADR 0004 13.5): its own chosen senders on a message-request channel, else its channel's pool. */
export function trackPool(def: CampaignDefinition, track: Pick<TrackDefinition, "channel" | "senders">): readonly string[] {
  return isMessageRequestChannel(track.channel) ? (track.senders ?? []) : poolOf(def, track.channel);
}

/** Every pool of the definition, campaign-wide and per track: the one list a validator or a comparison of pools walks. */
export const allPools = (def: CampaignDefinition): readonly (readonly string[])[] => [
  ...(Object.keys(POOL_FIELD) as (keyof typeof POOL_FIELD)[]).map((c) => poolOf(def, c)),
  ...def.tracks.map((t) => t.senders ?? []),
];

/**
 * A LinkedIn step's kind, by its position among the track's live steps (ADR 0004 3.1): the first is the connection invite
 * (its body is the note), the second the first message, sent once connected, and the rest follow-up messages. Null for a
 * step of another channel or one not live. Every reader asks this one function.
 */
export type LinkedinStepKind = "invite" | "first_message" | "follow_up";
export function linkedinStepKind(track: Pick<TrackDefinition, "channel" | "steps">, stepId: string): LinkedinStepKind | null {
  if (track.channel !== "linkedin") return null;
  const index = track.steps.filter((s) => !s.removed).findIndex((s) => s.id === stepId);
  return index < 0 ? null : index === 0 ? "invite" : index === 1 ? "first_message" : "follow_up";
}

/**
 * A message-request step's kind, by its position among the track's live steps (ADR 0004 13.3): the first is the message
 * request, the rest follow-ups. Null for a step of another channel or one not live. Every reader asks this one function.
 */
export type MessageRequestStepKind = "message_request" | "follow_up";
export function messageRequestStepKind(track: Pick<TrackDefinition, "channel" | "steps">, stepId: string): MessageRequestStepKind | null {
  if (!isMessageRequestChannel(track.channel)) return null;
  const index = track.steps.filter((s) => !s.removed).findIndex((s) => s.id === stepId);
  return index < 0 ? null : index === 0 ? "message_request" : "follow_up";
}

/** A social step's kind on any social channel: LinkedIn's or a message-request channel's. Null for email, SMS and calls. */
export type SocialStepKind = LinkedinStepKind | MessageRequestStepKind;
export function socialStepKind(track: Pick<TrackDefinition, "channel" | "steps">, stepId: string): SocialStepKind | null {
  return linkedinStepKind(track, stepId) ?? messageRequestStepKind(track, stepId);
}

/** The kind of action a step's handover asks of a social port, and the allowance it counts on (ADR 0004 2.1, 6, 13.7). */
export type SocialAction = "invite" | "message";
export const socialActionOf = (kind: SocialStepKind | null): SocialAction | null => (kind === null ? null : kind === "invite" ? "invite" : "message");

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
export function definitionIssues(def: CampaignDefinition, previous: CampaignDefinition | null = null, options: { readonly launched?: boolean } = {}): DefinitionIssue[] {
  const problems: DefinitionIssue[] = [];
  const add = (kind: string, text: string, about: { readonly trackId?: string; readonly stepId?: string } = {}) => problems.push({ kind, text, ...about });
  if (!isTimeZone(def.timezone)) add("timezone", `The campaign's time zone "${def.timezone}" is not an IANA time zone such as Europe/London.`);
  if (!isWholeDays(def.callSkipLimitDays) || def.callSkipLimitDays === 0) add("campaign_skip_limit", "The call skip limit is a whole number of days, at least 1.");
  if (allPools(def).some((pool) => new Set(pool).size !== pool.length)) add("sender_twice", "A sender account is listed twice.");

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
    const channel = track.channel === "sms" ? "SMS" : track.channel === "call" ? "phone" : track.channel === "email" ? "email" : SOCIAL_CHANNELS[track.channel].name;
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
    // A LinkedIn track (ADR 0004 3.1): an invite, then at least a first message, with an acceptance wait of whole days.
    if (track.channel === "linkedin") {
      const wait = track.acceptWaitDays;
      if (wait === undefined || !isWholeDays(wait) || wait === 0) add("accept_wait", `${name}'s wait for the invite to be accepted is a whole number of days, at least 1.`, { trackId: track.id });
      if (liveSteps(track).length < 2) add("linkedin_steps", `${name} needs a connection invite and at least one message after it.`, { trackId: track.id });
      if (liveSteps(track).some((st) => st.subject.trim() !== "")) add("linkedin_subject", `${name}'s invite and messages have no subject.`, { trackId: track.id });
    } else if (track.acceptWaitDays !== undefined) add("accept_wait_not_linkedin", "Only a LinkedIn track waits for an invite to be accepted.", { trackId: track.id });
    // A message-request track (ADR 0004 13.3): messages only, the first a message request, none with a subject.
    if (!isMessageRequestChannel(track.channel) && track.senders !== undefined) add("senders_not_message_request", `Only ${MESSAGE_REQUEST_CHANNELS.map((c) => `${SOCIAL_CHANNELS[c].name} tracks`).join(" and ")} choose their own sender sessions.`, { trackId: track.id });
    if (isMessageRequestChannel(track.channel)) {
      if (liveSteps(track).length < 1) add("message_request_steps", `${name} needs at least one message.`, { trackId: track.id });
      if (liveSteps(track).some((st) => st.subject.trim() !== "")) add("message_request_subject", `${name}'s messages have no subject.`, { trackId: track.id });
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
      // Issue 42 item 49: the branch is part of a track's meaning, as its channel is (ADR 0003 "Ticket 19").
      if (old && old.branch !== track.branch) add("branch_changed", "A track cannot move between the main sequence and the win-back branch: remove it and add a new one.", { trackId: track.id });
      for (const step of track.steps) {
        const was = stepTrack.get(step.id);
        if (was !== undefined && was !== track.id) add("step_moved", "A step cannot move to another track: remove it and add a new one.", { trackId: track.id, stepId: step.id });
      }
      // A LinkedIn step's kind is its position (ADR 0004 3.1): on a running campaign the invite stays the invite.
      if (old && track.channel === "linkedin" && options.launched === true) {
        const oldInvite = old.steps.find((st) => linkedinStepKind(old, st.id) === "invite");
        const newInvite = track.steps.find((st) => linkedinStepKind(track, st.id) === "invite");
        if (oldInvite && newInvite && oldInvite.id !== newInvite.id) add("linkedin_invite_moved", "A running LinkedIn track's connection invite stays its first step: add a new track to change it.", { trackId: track.id });
      }
    }
    // A running campaign's leads hold results and progress by these ids (ADR 0003 "Ticket 19"): a track or a step is
    // marked removed, never deleted, and what is removed never comes back.
    if (options.launched === true) {
      const tracksNow = new Map(def.tracks.map((t) => [t.id, t]));
      const stepsNow = new Map(def.tracks.flatMap((t) => t.steps.map((st) => [st.id, st] as const)));
      for (const old of previous.tracks) {
        if (!tracksNow.has(old.id)) add("track_deleted", "A track leads may have started cannot be deleted on a running campaign: it is marked removed instead.", { trackId: old.id });
      }
      for (const old of previous.tracks) {
        if (!tracksNow.has(old.id)) continue;
        for (const st of old.steps) if (!stepsNow.has(st.id)) add("step_deleted", "A step leads may have reached cannot be deleted on a running campaign: it is marked removed instead.", { trackId: old.id, stepId: st.id });
      }
      for (const old of previous.tracks) {
        const now = tracksNow.get(old.id);
        if (old.removed && now && !now.removed) add("restored", "A removed track cannot come back on a running campaign: add a new one.", { trackId: old.id });
        for (const st of old.steps) {
          const stNow = stepsNow.get(st.id);
          if (st.removed && stNow && !stNow.removed) add("restored", "A removed step cannot come back on a running campaign: add a new one.", { trackId: old.id, stepId: st.id });
        }
      }
    }
  }
  return problems;
}

/**
 * Plain messages for a definition that cannot be saved (ADR 0003 7.1). Empty when it can.
 * `previous` is the stored definition an edit replaces, if any. The sentences of `definitionIssues`.
 */
export function definitionProblems(def: CampaignDefinition, previous: CampaignDefinition | null = null, options: { readonly launched?: boolean } = {}): string[] {
  return definitionIssues(def, previous, options).map((issue) => issue.text);
}

/**
 * A step's number in reads (verifier on 194fc44, item 14): its place, from 1, among the steps the track has now. A step an
 * edit removed counts as the place it would hold: after the live steps before it in the track's order, never 0.
 */
export function stepNumber(track: Pick<TrackDefinition, "steps">, stepId: string): number {
  const at = track.steps.findIndex((s) => s.id === stepId);
  return track.steps.slice(0, Math.max(0, at)).filter((s) => !s.removed).length + 1;
}
