/**
 * The HTTP interface's response shapes, shared by the server and the web client.
 * Types only: nothing here runs.
 */
import type { Channel, PhoneKind } from "../domain/contact-details.ts";
import type { DetailNote, ImportSummary, LeadOutcome, NotEnrolledReason } from "../domain/import-plan.ts";
import type { FileCheck } from "../domain/scraper-export.ts";
import type { OutreachStatus, StatusGroup } from "../domain/outreach-status.ts";
import type { MessageRequestChannel, SocialChannel, SocialSenderKind } from "../domain/social-channels.ts";

export type { DetailNote, EvidenceKind, ImportSummary, LeadOutcome, NotEnrolledReason, SummaryEntry } from "../domain/import-plan.ts";
export type { ContactRoute } from "../domain/reach.ts";
export type { FileCheck } from "../domain/scraper-export.ts";
export type { OutreachStatus, StatusGroup } from "../domain/outreach-status.ts";
export type { MessageRequestChannel, SocialChannel, SocialSenderKind } from "../domain/social-channels.ts";

/** Every channel a track can be on (ADR 0004 13.2): a new social channel joins here, and every exhaustive mapping must take it. */
export type TrackChannelApi = "email" | "sms" | "call" | SocialChannel;
/** Every channel a sender account serves: a track's channel but calls. */
export type SendChannelApi = "email" | "sms" | SocialChannel;
/** Every channel whose sends are a conversation between one sender account and one destination (ADR 0004 13.6). */
export type ConversationChannelApi = "sms" | SocialChannel;

export interface Campaign {
  readonly id: string;
  readonly name: string;
  /** IANA time zone used when neither the lead nor its company has one. */
  readonly defaultTimezone: string | null;
  readonly createdAt: string;
}

/** Whether a campaign has launched, and the channels of its live main-sequence tracks, in order. */
export interface CampaignSequenceSummary {
  readonly launchedAt: string | null;
  readonly tracks: readonly (TrackChannelApi)[];
}

/** A campaign's pause as its read says it (ticket 17a): served on the campaign's page and, since ticket 17b, on each row of the list. */
export interface CampaignPauseRead {
  /** Whether the campaign is paused, and since when (ticket 17a). A campaign pause changes no lead's status. */
  readonly pause: { readonly paused: boolean; readonly pausedSince: string | null };
  /** The count of the campaign's leads in each outreach status, every status listed, zero included (ticket 17a). */
  readonly statusCounts: Readonly<Record<OutreachStatus, number>>;
  /** Pause and resume, each allowed now or refused with the reason the action would give (ticket 17a). */
  readonly controls: readonly CampaignControlView[];
  /** Messages of the campaign's leads already handed to a provider whose outcome is not final: each may still be sent, also while paused (as `EnrollmentRead.mayStillSend`). */
  readonly mayStillSend: number;
  /** The user's zone, in which the pause's date is said (ticket 17b). */
  readonly userZone: string;
}

export interface CampaignListItem extends Campaign, CampaignPauseRead {
  readonly leadCount: number;
  readonly sequence: CampaignSequenceSummary;
  readonly lastImport: {
    readonly id: string;
    readonly importedAt: string;
    readonly counts: Readonly<Record<LeadOutcome, number>>;
  } | null;
}

/** GET /api/campaigns/:id */
export interface CampaignDetail extends CampaignPauseRead {
  readonly campaign: Campaign;
  readonly imports: readonly ImportRecord[];
  readonly leadCount: number;
  readonly sequence: CampaignSequenceSummary;
  /**
   * Ticket 22: the campaign's measures, from the same store snapshot as `pause`, `statusCounts` and `mayStillSend`, so a
   * screen showing them together shows one instant (verifier B1 on 41028f2). `GET /api/campaigns/:id/measures` is the same.
   */
  readonly measures: CampaignMeasures;
  /** The instant of this read. */
  readonly asOf: string;
}

/**
 * One rate: its numerator and denominator, as the read counted them, and the whole percent, or null with nothing to divide by.
 * Both counts include the campaign's test runs; `fromTests` says how many of each are test runs (ticket 22, the principal's
 * decision of 15 November 2026).
 */
export interface MeasureRate {
  readonly numerator: number;
  readonly denominator: number;
  readonly percent: number | null;
  readonly fromTests: { readonly numerator: number; readonly denominator: number };
}

/**
 * Email or SMS: the messages the provider reported sent, those refused or bounced, and the leads (or test runs) that replied
 * on it (ticket 22). Each counts test runs too; `fromTests` is how many of each came from them.
 */
export interface MessageMeasures {
  readonly sent: number;
  readonly failedOrBounced: number;
  readonly replies: number;
  readonly fromTests: { readonly sent: number; readonly failedOrBounced: number; readonly replies: number };
}

/**
 * LinkedIn (ADR 0004 section 8): invites the session reported sent, invites accepted, messages sent, steps that failed,
 * and the leads (or test runs) the user marked replied on LinkedIn. Nothing here claims a message was delivered or read.
 */
export interface LinkedinMeasures {
  readonly invitesSent: number;
  readonly invitesAccepted: number;
  readonly messagesSent: number;
  readonly failed: number;
  readonly replies: number;
  readonly fromTests: { readonly invitesSent: number; readonly invitesAccepted: number; readonly messagesSent: number; readonly failed: number; readonly replies: number };
}

/**
 * A message-request channel (ADR 0004 13.8): messages the session reported sent, steps that failed, and the leads (or test
 * runs) the user marked replied there. Nothing here claims a message was delivered, accepted or read.
 */
export interface MessageRequestMeasures {
  readonly messagesSent: number;
  readonly failed: number;
  readonly replies: number;
  readonly fromTests: { readonly messagesSent: number; readonly failed: number; readonly replies: number };
}

/** The calls the user logged (ticket 22), test calls included; `fromTests` is how many of each came from test runs. */
export interface CallMeasures {
  readonly made: number;
  readonly connected: number;
  readonly interested: number;
  readonly declined: number;
  readonly callbacksPending: number;
  readonly fromTests: { readonly made: number; readonly connected: number; readonly interested: number; readonly declined: number; readonly callbacksPending: number };
}

/**
 * GET /api/campaigns/:id/measures (ticket 22; ADR 0003 "Ticket 22"): every figure a tally of the campaign's stored
 * activity, read in one snapshot. `channels` names the channels the campaign has tracks on, in the order shown.
 */
export interface CampaignMeasures {
  readonly launched: boolean;
  readonly leads: number;
  readonly groups: Readonly<Record<StatusGroup, number>>;
  readonly channels: readonly (TrackChannelApi)[];
  readonly email: MessageMeasures;
  readonly sms: MessageMeasures;
  readonly linkedin: LinkedinMeasures;
  /** Each message-request channel (ADR 0004 13.8), whether or not the campaign has a track on it; `channels` says which to show. */
  readonly messageRequests: { readonly [C in MessageRequestChannel]: MessageRequestMeasures };
  readonly calls: CallMeasures;
  readonly replyRate: MeasureRate;
  readonly connectRate: MeasureRate;
}

/** A campaign control as the campaign read offers it (ticket 17a). */
export type CampaignControlView = { readonly action: "pause" | "resume"; readonly allowed: true } | { readonly action: "pause" | "resume"; readonly allowed: false; readonly reason: string };

/** The controls on one lead in one campaign (ADR 0003 "Ticket 17a"). */
export type LeadControlApi = "pause" | "resume" | "skip" | "stop" | "resume_from_next_step" | "move_to_win_back";

/**
 * Why a pending step has no time a read may promise (ADR 0003 "Reads that say when"): the engine cannot know when what
 * holds it ends. The hold reasons are 5.4's (`HoldReasonApi`).
 */
export type StepWaitApi =
  | "campaign_not_launched"
  | "campaign_paused"
  | "lead_paused"
  | "callback"
  | "ended"
  | "with_provider"
  | HoldReasonApi
  | "no_window"
  | "no_transport"
  | "waiting_on_provider"
  | "reply_pending"
  | "no_destination"
  | "sender_slot"
  | "sender_unavailable"
  | "sender_rate_limited"
  | "sending_capacity"
  | "sender_waiting"
  | "call_capacity"
  | "on_call_list"
  | "call_hours_closed"
  /** A LinkedIn message waiting for its invite to be accepted (ADR 0004 section 9): `until` is the day the wait ends, a fact. */
  | "awaiting_acceptance"
  /** An invite to the profile already pending on LinkedIn that this application did not send (question Q42). */
  | "invite_pending_elsewhere"
  /**
   * A LinkedIn step no session it may use has any allowance for, of the step's kind (council on dee365d, item 15): the
   * engine's `sending_capacity` with every such session's allowance zero or unset, so nothing resets it. No time.
   */
  | "no_allowance";

/**
 * When a pending step goes, as the engine decides it at the read's instant (`stepWhen`): ready (its time has come and nothing
 * of its own holds it; no instant is promised); the earliest instant, when it waits on time alone (its wait's end, then its
 * window's opening); or why it waits, with no time.
 */
export type StepWhenView =
  /** Its time has come and nothing of its own holds it: in line for its sender, with no instant promised. */
  | { readonly kind: "ready" }
  | { readonly kind: "at"; readonly at: string }
  /** `channel` names the step's channel where the reason depends on it (no transport). */
  /** `channel`: the track's, so a reason is worded in its channel's words (council on b21af02, item 1). */
  | { readonly kind: "waits"; readonly why: StepWaitApi; readonly channel: TrackChannelApi; readonly until?: string }
  /**
   * A call not yet placed: the user's day (YYYY-MM-DD) it goes on the list, with no time of day; `today` when that is the
   * read's day; `now` when it is ready for the list (due, calling hours open today, room on today's list), with no instant promised.
   */
  | { readonly kind: "call_day"; readonly day: string; readonly today: boolean; readonly now: boolean }
  /** An open call listed from a later user day (YYYY-MM-DD), as the record's call line says it. */
  | { readonly kind: "listed_for"; readonly day: string };

/** A step a control names: the one it skips, or the next one the lead would send. */
export interface ControlStepView {
  readonly trackId: string;
  /** The track's name, as the editor and Activity name it (ticket 17b). */
  readonly track: TrackLabel;
  /**
   * A call step's record (council on 57d874f, item 8): the calls logged on it so far (skip for now is not a call), and
   * whether it is a callback the prospect asked for. Null for an email or a text.
   */
  readonly call: { readonly attempts: number; readonly callback: boolean } | null;
  readonly channel: TrackChannelApi;
  readonly branch: "main" | "win_back";
  readonly stepId: string;
  /** Its place among the track's steps, from 1, and how many there are. */
  readonly number: number;
  readonly of: number;
  /** When it goes once the action applies (`stepWhen` on the lead as the action leaves it); null for the step a skip skips. */
  readonly when: StepWhenView | null;
}

/**
 * One control as the lead's read offers it: refused with the reason the action itself would give, or allowed
 * with what it will do, decided by the engine's own transition applied to a copy of the lead as of the read,
 * storing nothing (ticket 17a). `withProvider` counts work already handed to a provider that the action asks to
 * withdraw, which may still be sent.
 */
export type ControlView =
  | { readonly action: LeadControlApi; readonly allowed: false; readonly reason: string }
  | {
      readonly action: LeadControlApi;
      readonly allowed: true;
      readonly statusAfter: OutreachStatus;
      readonly skips: ControlStepView | null;
      readonly next: ControlStepView | null;
      readonly withProvider: number;
      /**
       * What this preview names (the action, the status after, the step it skips, the next step and its branch), as one
       * string: a confirmation sends it back with the press, and the control applies only while it is unchanged (ticket 17b).
       */
      readonly digest: string;
    };

/** GET /api/enrollments/:id: the lead's progress and the controls allowed now (ticket 17a). */
export interface EnrollmentRead extends EnrollmentProgress {
  readonly controls: readonly ControlView[];
  /**
   * Messages already handed to a provider whose outcome is not final: each may still be sent, even while the lead is
   * paused or stopped, until the provider's answer is final (ticket 17a, the provider limitation in ADR 0003). The
   * withdrawal is asked again until then; a send is recorded once and starts nothing while the lead is held.
   */
  readonly mayStillSend: number;
  /**
   * Whether the user may mark this lead replied on each social channel the campaign has a track on (ADR 0004 7, 13.8), by
   * the engine's own rule (`markRepliedRefusal`), with its reason when refused; a channel with no track is absent.
   */
  readonly replyMarks: ReplyMarks;
}

/** The reply marks a read allows, by social channel: present only for a channel the campaign has a track on. */
export type ReplyMarks = { readonly [C in SocialChannel]?: ReplyMark };

/** A social reply mark as a read allows it: allowed, or refused with the engine's reason (ticket 24b; ADR 0004 13.8). */
export type ReplyMark =
  /** `work`: the work on that channel that lets the mark be made (review bot on c20c8f0), its kind and whether it is recorded sent. */
  | { readonly allowed: true; readonly work: { readonly kind: "invite" | "message"; readonly state: "sent" | "handed" } }
  | { readonly allowed: false; readonly reason: string };

/** One enrollment's read on a person's or company lead's record (ticket 17b), with its campaign's launch and pause as read at the same instant. */
export interface RecordLead extends EnrollmentRead {
  readonly campaignState: { readonly launched: boolean; readonly paused: boolean; readonly pausedSince: string | null };
}

/** GET /api/people/:id and GET /api/companies/:id add each enrollment's read, so the record's campaign rows show its controls and sentence (ticket 17b). */
export interface RecordControls {
  readonly leads: readonly RecordLead[];
  /** The user's zone, in which the record's days and times are said. */
  readonly userZone: string;
}

/** POST /api/enrollments/:id/controls: the control's own effect (its preview at that instant) and the read after the worker ran. */
export interface ControlAnswer {
  readonly effect: Extract<ControlView, { readonly allowed: true }>;
  readonly enrollment: EnrollmentRead | null;
  readonly replayed: boolean;
}

/**
 * A paused campaign whose calls are off Today's and Calls' lists while it is paused (ticket 17b): `calls`, the open call
 * tasks the engine's listing rule lists today with the pause lifted, judged on the same loaded leads as the list.
 */
export interface PausedCampaignCalls {
  readonly id: string;
  readonly name: string;
  readonly pausedSince: string;
  readonly calls: number;
}

/** A refused control (409 `control_refused`). */
export interface ControlRefusal {
  readonly error: { readonly code: "control_refused"; readonly message: string };
}

export interface ImportFileNames {
  readonly people: string | null;
  readonly businesses: string | null;
}

export interface ImportRecord {
  readonly id: string;
  readonly campaignId: string;
  readonly importedAt: string;
  readonly fileNames: ImportFileNames;
  readonly summary: ImportSummary;
}

/** POST /api/scraper-files/check: each chosen file on its own, then the pair together. */
export interface FileCheckResult {
  readonly businesses: FileCheck | null;
  readonly people: FileCheck | null;
  /** Why the two files don't belong together, when both are valid on their own. */
  readonly pair: string | null;
}

export interface EnrollmentView {
  readonly id: string;
  readonly campaign: { readonly id: string; readonly name: string };
  readonly status: OutreachStatus;
  readonly enrolledAt: string;
}

export interface ContactDetailView {
  readonly id: string;
  /** Person details belong to the decision maker; company details are the shared main line and inbox. */
  readonly owner: "person" | "company";
  readonly channel: Channel;
  readonly phoneKind: PhoneKind | null;
  readonly value: string;
  readonly bad: boolean;
  /** Added by a later import alongside an older detail on the same channel. */
  readonly newer: boolean;
}

/** Why someone on record has no enrollment. Null when they have one, or nothing stops one. */
export type UnenrolledReason = Extract<NotEnrolledReason, "no_usable_channel"> | null;

export interface CompanyRef {
  readonly id: string;
  readonly name: string;
  readonly city: string;
}

export type LeadRow =
  | {
      readonly kind: "person";
      readonly id: string;
      readonly name: string;
      readonly title: string;
      readonly company: CompanyRef;
      /** The company is a company lead, contacted through its own details. */
      readonly companyIsLead: boolean;
      readonly enrollments: readonly EnrollmentView[];
      readonly unenrolledReason: UnenrolledReason;
    }
  | {
      readonly kind: "company";
      readonly id: string;
      readonly name: string;
      readonly city: string;
      /** Named decision makers on record. */
      readonly peopleOnRecord: number;
      /** Of them, those enrolled or with a usable channel now. A later import can make one reachable. */
      readonly peopleReachable: number;
      readonly enrollments: readonly EnrollmentView[];
      readonly unenrolledReason: UnenrolledReason;
    };

export interface LeadSearchResult {
  readonly rows: readonly LeadRow[];
  /** Matching rows before the limit was applied, and how many of them are people or companies. */
  readonly total: number;
  readonly people: number;
  readonly companies: number;
  readonly limit: number;
}

export interface ColleagueView {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly enrollments: readonly EnrollmentView[];
  readonly unenrolledReason: UnenrolledReason;
}

/** The note of the last call logged with someone that had one (ticket 18), as the call desk's colleagues show it. */
export interface LastCallNote {
  readonly note: string;
  readonly outcome: CallOutcomeApi;
  readonly at: string;
}

/** GET /api/people/:id and GET /api/companies/:id (ticket 18): each colleague's (person on record's) last call note. */
export interface RecordColleagues {
  readonly colleagueNotes: readonly { readonly personId: string; readonly lastCallNote: LastCallNote | null }[];
}

/** POST /api/people/:id/notes and POST /api/companies/:id/notes. */
export interface NoteAnswer {
  readonly note: ActivityNote;
  readonly replayed: boolean;
}

export interface PersonRecord {
  readonly kind: "person";
  readonly id: string;
  readonly name: string;
  readonly title: string;
  /** The person's time zone, else the company's, else the first campaign default. */
  readonly timezone: string | null;
  readonly company: CompanyRef;
  /** The company itself is enrolled as a company lead, contacted through its own details. */
  readonly companyIsLead: boolean;
  readonly contactDetails: readonly ContactDetailView[];
  readonly enrollments: readonly EnrollmentView[];
  readonly unenrolledReason: UnenrolledReason;
  readonly colleagues: readonly ColleagueView[];
}

export interface CompanyRecord {
  readonly kind: "company";
  readonly id: string;
  readonly name: string;
  readonly city: string;
  readonly timezone: string | null;
  readonly contactDetails: readonly ContactDetailView[];
  /** Company-lead enrollments: outreach to the company through its own details. */
  readonly enrollments: readonly EnrollmentView[];
  readonly unenrolledReason: UnenrolledReason;
  /** Decision makers on record at the company, enrolled or not. */
  readonly people: readonly ColleagueView[];
}

export interface ApiError {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly problems?: readonly { file: string; message: string }[];
    /** On `impact_changed` (ticket 19): the stored sequence itself was changed elsewhere since the read. */
    readonly elsewhere?: boolean;
  };
}

/** A refused call outcome: the call's off-list facts as the server read them when it refused (ticket 14b). */
export interface CallOutcomeRefusal extends ApiError {
  readonly offList: CallOffListView | null;
}

// ---------------------------------------------------------------------------------------------
// The sequence engine (ADR 0003), ticket 12b: one email track, launch, and each lead's progress.

export type {
  CampaignDefinition,
  StepDefinition,
  TrackDefinition,
  StartRule,
  Threading,
} from "../domain/sequence/definition.ts";
export type { WindowRule } from "../domain/sequence/clock.ts";
export type { LaunchBlocker } from "../domain/sequence/blockers.ts";
export type { TrackLabel } from "./track-label.ts";
import type { TrackLabel } from "./track-label.ts";

/** A sender account the engine may send from, as the provider reports it. */
export interface SenderAccountViewApi {
  readonly id: string;
  readonly label: string;
  readonly channel: SendChannelApi;
  readonly healthy: boolean;
  readonly capacity: number;
  /** The pacing gap between two sends from this account, in seconds. */
  readonly gapSeconds: number;
  /** Sends counted today plus open reservations. */
  readonly usedToday: number;
  /** An account-level wait after a quota (402) or rate-limit (429) refusal. */
  readonly waiting: "quota" | "rate_limited" | null;
  /**
   * A LinkedIn session's room per kind of action (ADR 0004 6; council on dee365d, item 4): its invites and its messages a
   * day, each with what is used today. `capacity` and `usedToday` above add the two and are not said for a session.
   */
  readonly kinds?: SessionKinds;
  /** What a message-request session reports of itself (ADR 0004 13.5): personal or business. Absent on other channels. */
  readonly socialKind?: SocialSenderKind;
}

/** A LinkedIn session's daily allowances, each with its use today (sent on the reset day plus reservations). */
export interface SessionKinds {
  readonly invite: { readonly capacity: number; readonly usedToday: number };
  readonly message: { readonly capacity: number; readonly usedToday: number };
}

/**
 * POST /api/campaigns/:id/sequence/impact (ticket 19; ADR 0003 "Ticket 19"): what applying a draft would do to the
 * campaign's leads, read at `asOf` from the engine's own reconciliation of each lead, storing nothing.
 */
export interface EditImpactView {
  readonly asOf: string;
  /** The stored revision this read compared the draft with. */
  readonly definitionVersion: number;
  /** What this read was computed for (the body, the stored revision, the pause): Apply sends it as the save's `impact`. */
  readonly digest: string;
  /** The enrollments counted. */
  readonly leads: number;
  readonly changes: readonly EditImpactChange[];
  /** What the save would refuse: the running boundary and the three launch blockers. */
  readonly problems: readonly string[];
  readonly blockers: readonly import("../domain/sequence/blockers.ts").LaunchBlocker[];
}
export interface EditImpactChange {
  readonly kind: import("../domain/sequence/reconcile.ts").EditChangeKind;
  readonly trackId: string | null;
  readonly stepId: string | null;
  /** Leads the change applies to: the work is still ahead of them. */
  readonly reaches: number;
  /** Leads that had not reached a removed step or track, and will pass over it. */
  readonly skips: number;
  /** Leads whose affected step is with a provider now: it goes as it was handed. */
  readonly inFlight: number;
  /** Leads past it, finished with that track, in the other branch, or ended. */
  readonly untouched: number;
}

/** GET /api/campaigns/:id/sequence */
export interface SequenceView {
  readonly campaignId: string;
  readonly definition: import("../domain/sequence/definition.ts").CampaignDefinition;
  readonly definitionVersion: number;
  readonly editedAt: string | null;
  readonly launchedAt: string | null;
  /** Exactly three blockers; "nothing to launch" is separate (ADR 0003 7.2). */
  readonly launch: {
    readonly blockers: readonly import("../domain/sequence/blockers.ts").LaunchBlocker[];
    readonly nothingToLaunch: boolean;
    readonly canLaunch: boolean;
  };
  readonly accounts: readonly SenderAccountViewApi[];
}

export type FinishReasonApi = import("../domain/sequence/state.ts").FinishReason;
/**
 * A campaign whose lead or test owns the SMS conversation a track was skipped for (ADR 0003, question Q7 answered): an
 * SMS thread is one conversation between two numbers, so the campaign that texted first keeps it, and the reads name it.
 */
export interface ConversationOwnerView {
  readonly name: string;
  /** The conversation belongs to that campaign's test run, not to one of its leads. */
  readonly test: boolean;
  /**
   * A lead of the same campaign owns it (verifier on f2824d4, item 9): that lead's name ("" if the stored cause has none),
   * said instead of the campaign. Null when the owner is another campaign or a test run.
   */
  readonly lead: string | null;
}
/**
 * Why a track waits for the user (ADR 0003 5.4). A mobile whose conversation is taken on every number is not a hold: its
 * SMS track is skipped (`skipped_conversation_taken`, question Q7 answered). `sms_conversation_unsettled`: every number
 * is in another campaign's conversation whose first text is not known sent or not sent yet; it waits for that answer.
 */
export type HoldReasonApi = "unresolved" | "render_failed" | "provider_skipped" | "no_thread" | "sms_conversation_unsettled" | "invite_pending_elsewhere";

export interface SendView {
  readonly attemptId: string;
  /** claimed, handed, accepted, sent, rejected or withdrawn (ADR 0003 5.3). */
  readonly state: import("../domain/sequence/state.ts").AttemptState;
  readonly sender: string;
  readonly destination: string;
  /** The copy as handed over; null before the handover. */
  readonly copy: { readonly subject: string; readonly body: string } | null;
  readonly handedAt: string | null;
  /** The provider's send time. */
  readonly sentAt: string | null;
  readonly endedBy: string | null;
  readonly rejectReason: string | null;
  /** The app cannot tell whether it was sent; resolution controls arrive with ticket 20. */
  readonly unresolved: boolean;
}

export interface StepProgressView {
  readonly stepId: string;
  readonly number: number;
  readonly removed: boolean;
  readonly result: "sent" | "skipped" | "failed" | null;
  readonly reason: string | null;
  readonly at: string | null;
  readonly sends: readonly SendView[];
  /** A call step's logged outcomes, skip for now included (ticket 14); empty on email and SMS steps. */
  readonly calls: readonly CallRecordView[];
}

/** What the engine stores of a LinkedIn track, for the record's sentences (ADR 0004 section 9). Part b words it. */
export interface LinkedinTrackView {
  /**
   * The invite's work (council on dee365d, item 11): `sent` once the engine records it sent (by the session, a lookup or the
   * user's mark); `handed` while it is with the session and not known to have gone; null before the handover, or refused.
   */
  readonly invite: "sent" | "handed" | null;
  /** The note chosen at the handover: with it, without it because the note allowance was used, none written; null before it. Said as gone only with `invite` sent. */
  readonly note: "with" | "withheld" | "none" | null;
  /** How the track connected, and when (the acceptance or the pre-send check); null while not connected. */
  readonly connection: "accepted" | "already_connected" | null;
  readonly connectedAt: string | null;
  /** The platform's acceptance, recorded whenever observed. */
  readonly acceptedAt: string | null;
  /** An acceptance recorded after the track had finished: the person is now connected, and the user may write by hand. */
  readonly acceptedAfterFinish: boolean;
  /** The withdrawal after the acceptance wait: wanted, done, found accepted first, or kept by the user; null when none. */
  readonly withdrawal: "wanted" | "withdrawn" | "accepted_first" | "kept_by_user" | null;
  /** With `wanted`: the session has been asked at least once, and answered unknown (council on a6c1700, item 9). */
  readonly withdrawalAsked: boolean;
  /**
   * Why the track was skipped as a missing channel (council on a6c1700, item 10), from stored facts: no LinkedIn address in
   * the import; an address that is not a member profile; a company lead; the profile it started with replaced by a
   * re-import; the profile marked unreachable. Null for any other finish.
   */
  readonly skipCause: import("../domain/sequence/state.ts").LinkedinSkipCause | "unrecorded" | null;
  /** The session answered the withdrawal unknown too many times: listed in Needs attention for the user. */
  readonly withdrawalStuck: boolean;
  /** An invite this application sent is still open on LinkedIn (sent, not accepted, not withdrawn), whatever the lead's state. */
  readonly inviteOpen: boolean;
  /** An invite already pending on LinkedIn that this application did not send, first seen then (question Q42). */
  readonly pendingElsewhereSince: string | null;
}

/**
 * What the engine stores of a message-request track (ADR 0004 13.3, 13.4), for the record's sentences: whose account it
 * messages and which, the first message's work, the session, and a skip's recorded cause. Nothing about acceptance or
 * reading: the platform tells the sender nothing of either.
 */
export interface MessageRequestTrackView {
  /** Whose account the track started with: the decision maker's own or the company's; null before it started or when skipped. */
  readonly destination: "own" | "company" | null;
  /** That account's address as the import gave it; null when none. */
  readonly address: string | null;
  /** The first message's work: `sent` once recorded sent; `handed` while with the session and not known to have gone; null before. */
  readonly firstMessage: "sent" | "handed" | null;
  /** The session the track goes from, once fixed, by its account id, with its kind; null before its first handover. */
  readonly sender: { readonly id: string; readonly kind: SocialSenderKind | null } | null;
  /** Why the track was skipped as a missing channel, as recorded at the skip; null for any other finish. */
  readonly skipCause: import("../domain/sequence/state.ts").SocialSkipCause | "unrecorded" | null;
}

export interface TrackProgressView {
  readonly trackId: string;
  readonly channel: string;
  /** The main sequence, or the campaign's win-back branch (ticket 16). */
  readonly branch: "main" | "win_back";
  readonly started: boolean;
  readonly finishReason: FinishReasonApi | null;
  readonly finishedAt: string | null;
  /** For `skipped_conversation_taken` (reason `sms_conversation_taken`): who owns the conversation. Empty otherwise. */
  readonly conversationOwners: readonly ConversationOwnerView[];
  /** A LinkedIn track's own facts (ADR 0004 section 9; council on 194fc44, items 4 and 6); null on any other track. */
  readonly linkedin: LinkedinTrackView | null;
  /** A message-request track's own facts (ADR 0004 13.3, 13.4); null on any other track. */
  readonly messageRequest: MessageRequestTrackView | null;
  readonly hold: HoldReasonApi | null;
  /** For `sms_conversation_unsettled`: the campaigns whose first text the track waits on. Empty otherwise. */
  readonly holdOwners: readonly ConversationOwnerView[];
  /** The pending step and when it goes, as the engine decides it at the read (`stepWhen`). */
  readonly nextStep: { readonly stepId: string; readonly number: number; readonly when: StepWhenView } | null;
  /** A phone track's call task once placed on the user's list (ticket 14): open until its outcome or its track's finish. */
  readonly callTask: {
    readonly taskId: string;
    readonly open: boolean;
    readonly placedAt: string;
    readonly listed: boolean;
    /** A callback holds the lead's outreach in this campaign until its outcome (ticket 15). */
    readonly kind: "call" | "callback";
    /** For a callback: the date and time the prospect asked for. */
    readonly callbackAt: string | null;
    /** The user's date the call is listed for, YYYY-MM-DD: a redial moves it to the next day. */
    readonly listedFor: string;
    /** The call step's original due time, which the skip limit counts from. */
    readonly dueAt: string;
  } | null;
  readonly steps: readonly StepProgressView[];
}

/** GET /api/enrollments/:id */
export interface EnrollmentProgress {
  readonly id: string;
  readonly campaignId: string;
  readonly status: OutreachStatus;
  readonly endedAt: string | null;
  /** "replied, automation stopped" with channel and date only. */
  readonly reply: { readonly channel: SendChannelApi; readonly at: string } | null;
  /** The lead's email inbox, fixed at its first email. */
  readonly sender: string | null;
  /** The lead's SMS number, fixed at its first text (ticket 13). */
  readonly smsSender: string | null;
  readonly zone: string;
  /**
   * The main sequence's tracks, and the win-back branch's once the lead has entered it, each with its branch
   * (ticket 16). A branch the lead has not entered has no progress and is not listed (review bot on 654907b);
   * after a win-back entry the main tracks the lead had not finished show `dropped_for_win_back`.
   */
  readonly tracks: readonly TrackProgressView[];
  /** Where the lead runs: the main sequence, or the win-back branch since `winBackEnteredAt` (ticket 16). */
  readonly branch: "main" | "win_back";
  readonly winBackEnteredAt: string | null;
  /**
   * The lead declined on a call (ticket 16): when, on which phone track, and the declined path taken (the
   * track's, or the user's override for this lead). No call is made to the lead again in this campaign.
   */
  readonly declined: { readonly at: string; readonly trackId: string; readonly path: DeclinedPathApi } | null;
}

/**
 * Whose lead a Needs attention entry is about (ticket 20b): the person (null for a company lead), the company and the
 * campaign, so Today names them and links to the record. Names only; the state is the entry's own.
 */
export interface AttentionLead {
  readonly person: { readonly id: string; readonly name: string } | null;
  readonly company: { readonly id: string; readonly name: string };
  readonly campaign: { readonly id: string; readonly name: string };
}

/** GET /api/needs-attention (the 12b part: stalled inboxes, held tracks, account waits, provider anomalies). */
export interface NeedsAttention {
  /**
   * Callbacks whose time has passed with no outcome logged (ticket 15): each holds its lead's automated
   * outreach in that campaign until the user logs what happened. Oldest first.
   */
  readonly overdueCallbacks: readonly { readonly taskId: string; readonly enrollmentId: string; readonly campaignId: string; readonly callbackAt: string; readonly dueAt: string }[];
  readonly stalledInboxes: readonly { readonly accountId: string; readonly holding: readonly string[] }[];
  /**
   * Held tracks (5.4), each with whose lead it is (ticket 20b's names) and, for `sms_conversation_unsettled`, the
   * campaigns whose first text it waits on (`owners`; empty for every other reason).
   */
  /**
   * LinkedIn invite withdrawals the session has answered unknown too many times (ADR 0004 3.3; council on 194fc44, item 5):
   * the user checks LinkedIn and marks it withdrawn or still there (`POST /api/enrollments/:id/invite-withdrawal`). Any other
   * LinkedIn action left unknown is unresolved work, listed with the other unresolved work (ADR 0003 5.4).
   */
  readonly inviteWithdrawalsUnknown?: readonly (AttentionLead & { readonly enrollmentId: string; readonly trackId: string; readonly unknownAnswers: number })[];
  readonly heldTracks: readonly (AttentionLead & { readonly enrollmentId: string; readonly trackId: string; readonly channel: TrackChannelApi; readonly reason: HoldReasonApi; readonly owners: readonly ConversationOwnerView[] })[];
  readonly accountWaits: readonly { readonly accountId: string; readonly reason: "quota" | "rate_limited"; readonly until: string | null }[];
  /**
   * Sender accounts on any channel that cannot send, each listed once (ticket 13; spec "Needs
   * attention": sender account problems such as a disconnected SMS number). `problem` is the
   * provider's own reason (for Instantly an `InboxHoldReasonApi`, for SMS "disconnected"),
   * `not_listed` when the provider no longer lists the account, or `unhealthy` when no reason was
   * given. Their leads wait on them; nothing is dropped. (Replaces 12b's `unhealthyInboxes`.)
   */
  readonly senderProblems: readonly { readonly accountId: string; readonly channel: SendChannelApi; readonly label: string; readonly problem: string }[];
  /**
   * Inboxes some of whose daily sends are held by unresolved provider work (ADR 0003 4.2): how
   * many, and the work holding them, until the provider or the user settles it.
   */
  readonly heldCapacity: readonly {
    readonly accountId: string;
    /** The account's channel: a LinkedIn session's held work is said apart from a summed capacity (council on dee365d, item 4). */
    readonly channel: SendChannelApi;
    readonly held: number;
    readonly capacity: number;
    /** Sends already counted on the inbox's current reset day. */
    readonly sentToday: number;
    readonly work: readonly {
      readonly attemptId: string;
      readonly enrollmentId: string;
      readonly stepId: string;
      readonly destination: string;
      readonly unresolvedSince: string;
      /** The latest lookup answer: while it is `queued`, "not sent" is refused. */
      readonly lookupAnswer: "sent" | "queued" | "not-sent" | "unknown" | null;
      readonly canMarkNotSent: boolean;
    }[];
  }[];
  readonly anomalies: readonly { readonly what: string; readonly at: string }[];
  /**
   * Leads waiting for sending capacity (ticket 20a; spec "Needs attention"): each email or text that is due and could
   * be claimed now, but every account it may use is full for its reset day. It goes when the first of them resets.
   */
  readonly waitingForCapacity: readonly (AttentionLead & {
    readonly enrollmentId: string;
    readonly campaignId: string;
    readonly trackId: string;
    readonly stepId: string;
    readonly channel: SendChannelApi;
    readonly dueAt: string;
    readonly accountIds: readonly string[];
    readonly resetsAt: string;
    /** A LinkedIn step's kind of action, whose allowance it waits on (council on dee365d, item 15); null on email and SMS. */
    readonly action: "invite" | "message" | null;
    /** Every account it may use has no allowance of that kind (zero or never set): no reset brings room, so none is promised. */
    readonly noAllowance: boolean;
  })[];
  /**
   * Leads left with no usable channel, from any cause (ticket 20a; follow-up 42 item 50), most recently ended first, with
   * why each channel of their branch cannot reach them. They stay listed: the ending is final (question Q20).
   */
  readonly noUsableChannel: readonly (AttentionLead & {
    readonly enrollmentId: string;
    readonly campaignId: string;
    readonly endedAt: string;
    /** `conversation_taken`: its SMS track was skipped because `owners` hold the conversation (question Q7 answered); `owners` is empty for every other reason. */
    readonly channels: readonly { readonly channel: TrackChannelApi; readonly why: "missing" | "bad" | "declined" | "conversation_taken"; readonly owners: readonly ConversationOwnerView[] }[];
  })[];
  /**
   * While sending is interrupted, the providers the dispatch gate waits on (ticket 20a, council B): each not answering,
   * since its last contact, and how many due sends wait on it, decided by the gate's own function (`waitingOn`).
   */
  readonly waitingOnProvider: readonly { readonly channel: SendChannelApi; readonly since: string | null; readonly sends: number }[];
  /**
   * Sending interrupted now, as GET /api/today gives it, judged at this read's own instant (ticket 20b, council on
   * 7622b8b), so every Needs attention entry comes from one read.
   */
  readonly sendingInterrupted: SendingInterruptedView | null;
  /** Due steps waiting for a transport the provider cannot use yet, such as continue-thread follow-ups (follow-up 42 item 12). */
  readonly waitingOnTransport: readonly { readonly enrollmentId: string; readonly trackId: string; readonly stepId: string; readonly channel: SendChannelApi; readonly dueAt: string }[];
}

// ---------------------------------------------------------------------------------------------
// The campaign editor's Before launch tab and the person timeline (ticket 12c). Read models only.

/** A lead of the campaign the copy can be rendered for: an enrollment that has not ended. */
export interface PreviewLead {
  /** The enrollment id. */
  readonly id: string;
  readonly kind: "person" | "company";
  /** The person's or company lead's record id, for its page. */
  readonly recordId: string;
  readonly name: string;
  readonly title: string;
  readonly company: string;
  /** The address the email track would send to: the lead's own email, or a company lead's shared inbox. */
  readonly email: string | null;
  /** A good mobile of the decision maker's own; company leads are never texted. */
  readonly mobile: boolean;
  /** A good phone number to call: their own, or the company's main line. */
  readonly phone: boolean;
  /** A usable LinkedIn member profile of the decision maker's (ADR 0004 section 5); a company lead has none (Q35). */
  readonly linkedin: boolean;
  /**
   * Per message-request channel, whose account a track would message (ADR 0004 13.4): the decision maker's own, the
   * company's, or none usable.
   */
  readonly social: { readonly [C in MessageRequestChannel]: "own" | "company" | null };
  /** Merge fields the live copy uses that this lead has no value for. */
  readonly lacks: readonly string[];
}

/** GET /api/campaigns/:id/before-launch */
export interface BeforeLaunchView {
  readonly campaignId: string;
  readonly leads: readonly PreviewLead[];
  /** Spec "Before launch": how many leads have an email, a mobile, a phone number or a LinkedIn member profile (ticket 24b). */
  readonly coverage: {
    readonly leads: number;
    readonly email: number;
    readonly mobile: number;
    readonly phone: number;
    readonly linkedin: number;
    /**
     * Per message-request channel: leads with an account of their own, and leads that would use their company's (ADR 0004
     * 13.4); and of those company accounts, the ones two or more leads would share, with how many leads share them (Q46).
     */
    readonly social: { readonly [C in MessageRequestChannel]: { readonly own: number; readonly company: number; readonly shared: { readonly accounts: number; readonly leads: number } } };
  };
  /** Every merge field the live copy uses, with how many leads lack it and the fallbacks written for it. */
  readonly mergeFields: readonly {
    readonly field: string;
    readonly leadsMissing: number;
    /** Of them, company leads, which have no person's name or title. */
    readonly companyLeadsMissing: number;
    /** The distinct fallback texts written for this field; empty when some use has none. */
    readonly fallbacks: readonly string[];
    /** Some use of the field has no fallback. */
    readonly someUseWithoutFallback: boolean;
  }[];
  /** Null once the campaign has launched: the projection is a before-launch estimate. */
  readonly load: LoadProjectionView | null;
  /** Ticket 21: no test run started since the definition was last edited. A warning, never a blocker. */
  readonly noTestSinceEdit: boolean;
}

export interface LoadProjectionView {
  /**
   * This campaign's leads some live track can reach: they would start. Null when nothing is
   * projected (see `cannotProject` and `noSender`).
   */
  readonly leadsToStart: number | null;
  /**
   * Leads only a phone track can reach. Since ticket 14c they start when their first call goes on the
   * user's list, and are counted in `leadsToStart` and `daysUntilAllStart`.
   */
  readonly onlyCalled: number;
  /** Every sender account in a live track's pool, on either channel. */
  readonly accounts: readonly {
    readonly id: string;
    readonly label: string;
    readonly channel: SendChannelApi;
    readonly capacity: number;
    /** Sends already counted or reserved today on this account, across every campaign. */
    readonly usedToday: number;
    /** The most this campaign would send from it on one day. */
    readonly busiestDay: number;
    readonly gapSeconds: number;
    /** A LinkedIn session's room per kind (council on dee365d, item 4); its summed `capacity` is not said. */
    readonly kinds?: SessionKinds;
  }[];
  /**
   * Calendar days, counting launch day as day 1, until every lead some live track can reach has had
   * its first message on any channel or its first call placed on the user's list; null when nothing
   * is projected, or not all start within the projection's horizon.
   */
  readonly daysUntilAllStart: number | null;
  /** Some lead would not have started within the projection's horizon (said without a count: that run stopped at the horizon). */
  readonly someNotStartedWithinHorizon: boolean;
  readonly horizonDays: number;
  /**
   * Pool accounts that cannot send now with no known end: the provider reports them unable to send
   * (stale, sending off, not active, disconnected), or the lead quota is held. While any is listed
   * there is no projection, because none can be honest. A rate limit has an end, and the projection resumes there.
   */
  readonly cannotProject: readonly {
    readonly accountId: string;
    readonly label: string;
    readonly channel: SendChannelApi;
    /**
     * `unsettled_work`: work whose outcome only the provider or the user can settle holds some of its
     * sends (Needs attention lists it); `reply_being_matched`: a reply to it is being matched to its
     * lead, which may stop that lead (ADR 0003, ticket 13b).
     */
    readonly reason: "cannot_send" | "quota" | "unsettled_work" | "reply_being_matched";
  }[];
  /**
   * The tracks that withhold the figure, whenever one does (ADR 0003, ticket 13b): a track whose
   * channel has no connected sender (launch blocker 3). A track after a phone track is projected since
   * ticket 14c, under the stated assumption about calls. The screen words any "no figure because" from
   * these alone (`src/web/campaign/withheld.ts`). Null when none does.
   */
  readonly withheldBy: WithheldBy | null;
  /**
   * Why the projection stopped before its end, as the run says on itself, so no figure is shown
   * (ADR 0003, ticket 14c): `bound`, it reached its bound on work (`PROJECTION_MAX_STEPS`, calls into
   * the engine's rules) and the campaign is too large to estimate; `horizon`, something it would do lies
   * past its `horizonDays`. Null when it reached its end, or did not run (see `withheldBy` and `cannotProject`).
   */
  readonly stoppedEarly: "bound" | "horizon" | null;
  /**
   * The user's calls, when the campaign has a live phone track (ADR 0003, ticket 14c); null otherwise.
   * A call is a task on the user's list, not a send: the projection places due calls by the engine's
   * own rules within the daily call capacity, assuming the user works through each day's list, and
   * foresees no call outcome.
   */
  readonly calls: {
    /** The user's daily call capacity, across every campaign (GET /api/call-settings). */
    readonly capacity: number;
    /** Calls on today's list across every campaign: placed today, and carried from earlier days. */
    readonly onListToday: number;
    /** The most calls of this campaign placed on one day; null when nothing is projected. */
    readonly busiestDay: number | null;
  } | null;
  /**
   * Other campaigns, sharing these senders or the call list, whose calls the estimate also assumes are
   * worked on their day with no answer (ADR 0003, ticket 14c). The screen names them.
   */
  readonly callsNotCounted: readonly { readonly id: string; readonly name: string }[];
  /**
   * The estimate's run counted none of this campaign's win-back branch (ticket 16): its emails and texts go
   * only to leads who decline on a call, and the assumed user logs every call no answer (ticket 14c). False
   * when the campaign has no branch, or no figure is shown.
   * A competing lead already in win-back when the estimate is taken is counted: its branch runs by the
   * engine's own rules.
   */
  readonly winBackNotCounted: boolean;
}

/** Rendered copy, in pieces, so a fallback the lead gets can be shown as one. */
export interface CopySegment {
  readonly text: string;
  /** A literal, the lead's own value, a fallback for a field it lacks, or a missing field with no fallback. */
  readonly kind: "literal" | "value" | "fallback" | "missing";
  /** The merge field, for every kind but literal. */
  readonly field?: string;
}

/** GET /api/campaigns/:id/preview/:enrollmentId */
export interface CopyPreview {
  readonly lead: PreviewLead;
  readonly steps: readonly {
    readonly trackId: string;
    readonly stepId: string;
    readonly channel: SendChannelApi;
    /** Its number within its track: Email 2, Text 1. */
    readonly number: number;
    /** The day the projection sends it to this lead, counting launch day as day 1; null with `noDay` otherwise. */
    readonly day: number | null;
    /**
     * Why the message shows no day, when it shows none (review bot on 93bcc0c): every day shown is the
     * day the projection sends it, and nothing else. `skipped`: the lead skips its track. `no_estimate`:
     * no figure is projected (withheld, too large, or the campaign has launched). `beyond_horizon`: the
     * projection's horizon ends before it. `not_sent`: a merge field with no fallback the lead lacks
     * holds it. The rest of its track then shows no day either, for the same reason. `win_back`: a message
     * of the win-back branch (ticket 16b), listed in `winBack`, which goes only to a lead who declines on a
     * call; the estimate never enters the branch (`LoadProjectionView.winBackNotCounted`), so it has no day.
     */
    readonly noDay: "skipped" | "no_estimate" | "beyond_horizon" | "not_sent" | "win_back" | null;
    /** The phone track this message waits on, through its track's chain, if any. */
    readonly waitsOnCall: string | null;
    /** This lead lacks the track's channel (no email; no mobile of their own, or a company lead), so the track is skipped and the tracks after it start sooner. */
    readonly skipped: boolean;
    readonly threading: "new_subject" | "continue_thread";
    /** The subject the step writes; on a continue-thread step, the subject of the thread it continues. */
    readonly subject: readonly CopySegment[];
    readonly body: readonly CopySegment[];
    /** Merge fields this lead lacks that have no fallback: the copy cannot be sent to them. */
    readonly missing: readonly string[];
  }[];
  /**
   * The win-back branch's messages for this lead (ticket 16b), in track order, apart from `steps`: they go
   * only if the lead declines on a call and moves to the branch, so none has a day (`noDay` `win_back`, or
   * `skipped` for a track whose channel the lead lacks). Empty when the campaign has no live branch track.
   */
  readonly winBack: CopyPreview["steps"];
  /**
   * How a lead can enter the win-back branch (council on aaf82b7; `winBackEntry` in definition.ts): by a phone
   * track's declined path, only when win back is chosen for one lead as their declined call is logged, or never
   * (no live branch track, or no live phone track). The page words `winBack`'s messages from it.
   */
  readonly winBackEntry: import("../domain/sequence/definition.ts").WinBackEntry;
}

/** One line of a person's or company lead's timeline (GET /api/people/:id/activity). Newest first. */
export type ActivityEntry = { readonly campaign: { readonly id: string; readonly name: string }; readonly at: string } & (
  | ({ readonly channel: SendChannelApi; readonly track: TrackLabel } & (
      | {
          readonly kind: "sent";
          readonly stepNumber: number;
          readonly from: string;
          /** The address, or the mobile grouped for reading. */
          readonly to: string;
          /** A text's subject is empty. */
          readonly copy: { readonly subject: string; readonly body: string } | null;
        }
      | { readonly kind: "failed"; readonly stepNumber: number; readonly to: string; readonly reason: string }
      /**
       * `no_email`, `no_mobile`, `company_lead` (a company lead is never texted, ADR 0003 Q10), `block_list`,
       * `sms_conversation_taken` (with `owners`, question Q7 answered), or the step's reason.
       */
      | { readonly kind: "skipped"; readonly stepNumber: number | null; readonly reason: string; readonly owners?: readonly ConversationOwnerView[] }
      /** A hard bounce, or a number the carrier reported invalid after a text: the address or number is marked bad. */
      | { readonly kind: "bounced"; readonly stepNumber: number | null; readonly to: string }
      /** The track ended because its address or number is marked bad, with no bounce event of this campaign's. */
      | { readonly kind: "address_bad"; readonly to: string }
      /** The track started after `after`, which was skipped or failed for this lead (ticket 13b). */
      | { readonly kind: "released"; readonly after: TrackLabel; readonly because: "skipped" | "failed" | "unworked" }
    ))
  | { readonly kind: "replied"; readonly channel: SendChannelApi }
  /**
   * A control the user applied to this lead (ticket 17b), from the engine's record of accepted requests: pause, resume, skip,
   * stop, or a restart. `step` is the step a skip skipped, or the step a restart named as next then; null otherwise.
   */
  | {
      readonly kind: "control";
      readonly action: LeadControlApi;
      readonly step: { readonly channel: TrackChannelApi; readonly track: TrackLabel; readonly number: number; readonly call: ControlStepView["call"] } | null;
    }
  /** The lead's campaign was paused or resumed while they were enrolled (ticket 17b), from the same record. */
  | { readonly kind: "campaign_paused" }
  | { readonly kind: "campaign_resumed" }
  | { readonly kind: "ended"; readonly status: "sequence_finished_no_response" | "finished_no_usable_channel" }
  /**
   * A phone track's entries (ticket 14b): each call outcome the user logged, skip for now included,
   * with the number dialled (none on a skip) and its note; a skip for want of a good number
   * (`no_number`); and its start after a track that was skipped or failed.
   */
  | ({ readonly channel: "call"; readonly track: TrackLabel } & (
      | {
          readonly kind: "call";
          readonly outcome: CallOutcomeApi;
          readonly number: RecordedNumberView | null;
          readonly note: string;
          /** The user asked for a redial with it (ticket 15b). */
          readonly redial: boolean;
          /** With a callback requested: the date and time the prospect asked for. */
          readonly callbackAt: string | null;
          /** Logged on a callback: the date and time that callback was asked for. */
          readonly onCallback: string | null;
          /** The prospect's zone, in which a callback's time is said. */
          readonly zone: string;
          /** With a redial: the user's date the engine listed the call from (its next day whose calling hours open). */
          readonly redialListedFrom: string | null;
          /**
           * With a callback requested: that callback is pending now (the engine's `callbackPending`: no outcome other than
           * skip for now logged on it, and the lead's outreach not ended), as the campaign measures count it, a paused
           * lead's included. False after its outcome, a new time, a reply, a stop or an ending (ticket 22, verifier F2).
           */
          readonly callbackPending: boolean;
          /** With a pending callback: it is on the call list today or on a later day (the listing rule); not while paused. */
          readonly callbackListed: boolean;
          /** With not interested: the declined path taken, the track's or the user's override for the lead (ticket 16). */
          readonly declinedPath: DeclinedPathApi | null;
          /** With not interested: each track the decline left unfinished or finished, in its state at this read (ticket 16c). Empty otherwise. */
          readonly afterDecline: readonly DeclineTrackView[];
        }
      | { readonly kind: "skipped"; readonly stepNumber: null; readonly reason: "no_number" }
      /**
       * Skipped by the skip limit (ADR 0003 3.5, ticket 15b): not worked within `limitDays` of its original
       * due time `dueAt`. The entry's time is the rollover it was skipped at; the tracks after it start.
       */
      | {
          readonly kind: "skipped";
          readonly stepNumber: null;
          readonly reason: "unworked";
          /** The call's original due date, the user's calendar date the engine counted the limit from (YYYY-MM-DD). */
          readonly dueDate: string;
          readonly limitDays: number;
          /** Each track that starts after this phone track, as the engine's stored track state stands at the read. */
          readonly after: readonly ({ readonly track: TrackLabel } & DependentTrackState)[];
        }
      | { readonly kind: "released"; readonly after: TrackLabel; readonly because: "skipped" | "failed" | "unworked" }
      /**
       * A callback whose time has passed with no outcome logged (question Q12), shown at the time asked for
       * while it is still open: it stays on the call list, flagged overdue, until an outcome is logged.
       */
      | { readonly kind: "callback_overdue"; readonly callbackAt: string; readonly zone: string }
    ))
);

/**
 * A track's state at a read, as Activity says it of a track that starts after another (verifier on 2027f24): every state
 * the engine's stored progress can be in, mapped once on the server (`dependentStateOf`). `started` and still running;
 * `finished` (its steps done, or ended on a bad destination or an interested call); skipped (`skipped_declined`,
 * `skipped_unworked`, `skipped_no_channel`, or `skipped` by the user); `dropped_for_win_back`, never to start; `waiting`
 * out its delay, to start at `startsAt` if the lead keeps running; `held`, waiting while the lead's outreach is held, so
 * no day can be named; `stopped`, never to start, the lead's outreach having stopped or ended; `not_started`, no start
 * resolved yet.
 */
export type DependentTrackState =
  | { readonly state: "waiting"; readonly startsAt: string }
  /** Skipped because its mobile's SMS conversation belongs to `owners` (question Q7 answered). */
  | { readonly state: "skipped_conversation_taken"; readonly startsAt: null; readonly owners: readonly ConversationOwnerView[]; readonly channel: ConversationChannelApi }
  | {
      readonly state:
        | "started"
        | "finished"
        | "skipped_declined"
        | "skipped_unworked"
        | "skipped_no_channel"
        | "skipped"
        | "dropped_for_win_back"
        | "held"
        | "stopped"
        | "stopped_after_start"
        | "started_held"
        | "no_more_calls"
        | "not_started";
      readonly startsAt: null;
    };

/**
 * One track a decline leaves unfinished or finishes (ticket 16c), in its state at a read: every main track other than
 * the declined call's own that had not finished before the decline, then the win-back branch's tracks once the lead
 * entered it. The same selection and the same mapping (`dependentStateOf`) for the preview before Log and for Activity.
 */
export type DeclineTrackView = { readonly track: TrackLabel } & DependentTrackState;

/** What logging not interested on one path would do (ticket 16c): the engine's own outcome on a copy of the lead, stored nowhere. */
export interface DeclinePreviewView {
  readonly path: DeclinedPathApi;
  /** The lead's outreach status after it. */
  readonly status: OutreachStatus;
  readonly tracks: readonly DeclineTrackView[];
  /** No call is made to the lead again in this campaign once this is logged: the engine's `noMoreCalls` on the copy. */
  readonly noMoreCalls: boolean;
  /** Emails or texts already handed to a provider that the decline asks to withdraw: each may still go (ADR 0003 2.5). */
  readonly withProvider: number;
}

/**
 * A note on the record's timeline (ticket 18): the person's own notes and their company's notes, which show for everyone
 * at the company. A note written with a call outcome shows on that call's entry instead, on the record of the lead the
 * call was with; on a colleague's record its company note shows here.
 */
export interface ActivityNote {
  readonly id: string;
  readonly scope: "person" | "company";
  readonly body: string;
  readonly at: string;
}

export interface ActivityView {
  readonly entries: readonly ActivityEntry[];
  readonly notes: readonly ActivityNote[];
  /** The user's zone, in which Activity's times and days are said (council on 32454ea, C). */
  readonly userZone: string;
}

/**
 * GET /api/sms-provider (ticket 13). No SMS provider is provisioned or chosen (#28), so the running
 * app reports `none` with no numbers, and every SMS track is blocked by "no connected sender".
 * `test-simulator` appears only in the test harness and the scripted scenario: it is a fake, not
 * a provider integration.
 */
export interface SmsProviderStatus {
  readonly provider: "none" | "test-simulator";
  readonly message: string;
  readonly numbers: readonly { readonly id: string; readonly label: string; readonly healthy: boolean; readonly capacity: number; readonly usedToday: number }[];
}

/**
 * GET /api/linkedin-provider (ADR 0004 1.1): `none` in the running application, where no LinkedIn session is connected;
 * `test-simulator` only in tests, which drive a simulated session that is not a LinkedIn session.
 */
export interface LinkedinProviderStatus {
  readonly provider: "none" | "test-simulator";
  readonly message: string;
}

/**
 * GET /api/social-providers (ADR 0004 13.1): for each message-request channel, `none` in the running application, where no
 * session is connected; `test-simulator` only in tests, which drive a simulated session that is not a real one.
 */
export type SocialProvidersStatus = { readonly [C in MessageRequestChannel]: LinkedinProviderStatus };

/** Why a sender inbox of the email provider cannot send now. */
export type InboxHoldReasonApi = "sending_off" | "not_active" | "no_daily_limit" | "stale" | "invalid_report";

/** GET /api/email-provider (ticket 12c): the email provider, its sender inboxes, and why any cannot send. */
export interface EmailProviderStatus {
  readonly provider: "instantly" | "none";
  /** Real provider writes: "off" unless the runtime setting turns them on. */
  readonly sending: "on" | "off";
  /** Continue-thread follow-ups: unavailable until ADR 0002's experiment X2 picks a transport. */
  readonly followUps: "available" | "unavailable";
  /** "exhausted" after a 402 or an exhausted lead quota: every dispatch handover waits. */
  readonly quota: "available" | "exhausted";
  readonly lastPolledAt: string | null;
  /**
   * The last poll that failed, and the part of its round trip that failed (ticket 20a): `inboxes`, `emails` (the
   * observation that carries replies, bounces and sends), `lead_statuses` or `commit`. A partial answer is not contact
   * with the provider. Null when none has failed since the application started.
   */
  readonly lastPollFailure: { readonly at: string; readonly part: "inboxes" | "emails" | "lead_statuses" | "commit" } | null;
  readonly inboxes: readonly {
    readonly id: string;
    /** Instantly's account status: 1 Active, 2 Paused, 3 maintenance, -1 to -3 errors. */
    readonly status: number;
    readonly dailyLimit: number | null;
    /** The daily limit less what other campaigns sent from the inbox today. */
    readonly capacity: number;
    readonly healthy: boolean;
    readonly reason: InboxHoldReasonApi | null;
  }[];
  /** Leads whose next email is a continue-thread follow-up the provider cannot send yet: they wait, and nothing is sent. */
  readonly waitingFollowUps: readonly { readonly enrollmentId: string; readonly trackId: string; readonly stepId: string }[];
}

// ---------------------------------------------------------------------------------------------
// Calls (ticket 14, part a): phone tracks, the user's call list, and the outcomes the user logs.
// The user dials on their own phone; the application never dials and has no telephony provider.

/**
 * What the user logs on a call task. A callback requested carries `callbackAt`; no answer, voicemail and
 * gatekeeper may carry `redial` (ticket 15); not interested may carry `declinedPath`, the user's override of
 * the phone track's path for this lead (ticket 16).
 */
export type CallOutcomeApi = import("../domain/sequence/state.ts").CallOutcome;

/** A phone track's declined path (ticket 16): stop the lead, continue on the other channels, or win back. */
export type DeclinedPathApi = import("../domain/sequence/definition.ts").DeclinedPath;

/**
 * Why a call is on the list (ticket 15): `due` today; `rolled_over` from an earlier day, unworked; `redial`,
 * moved onto today by the user's redial; `callback`, before the time the prospect asked for; `overdue`, a
 * callback whose time has passed with no outcome logged.
 */
export type CallReasonApi = import("../domain/sequence/calls.ts").CallReason;

/** One logged call, as the task's touches and the lead's progress show it. */
export interface CallRecordView {
  readonly outcome: CallOutcomeApi;
  readonly at: string;
  readonly number: RecordedNumberView | null;
  readonly note: string;
  /** The user asked for a redial with it. */
  readonly redial: boolean;
  /** With a callback requested: the date and time the prospect asked for. */
  readonly callbackAt: string | null;
  /** With not interested: the declined path taken (ticket 16). */
  readonly declinedPath: DeclinedPathApi | null;
}

/** GET and PUT /api/call-settings: the user's daily call capacity and the zone the call list's day is counted in. */
export interface CallSettingsView {
  readonly dailyCapacity: number;
  readonly userZone: string;
}

/** A number the user may dial, labelled by kind: direct first, then mobile, then the company main line. */
export interface CallNumberView {
  readonly detailId: string;
  readonly kind: "direct" | "mobile" | "main_line";
  /** A main line is the company's: a call to it reaching a gatekeeper still counts as a call to the lead. */
  readonly owner: "person" | "company";
  readonly value: string;
  /** Marked bad (struck through); the user cannot log an outcome on it. */
  readonly bad: boolean;
}

/** One task on the call list. */
export interface CallQueueItem {
  readonly taskId: string;
  readonly enrollmentId: string;
  /** The decision maker; null for a company lead, called on the company's main line. */
  readonly person: { readonly id: string; readonly name: string; readonly title: string } | null;
  readonly company: { readonly id: string; readonly name: string };
  readonly campaign: { readonly id: string; readonly name: string };
  /** A test call (ticket 21): to the user's own test mobile, from a test run; it keeps no note. */
  readonly test: boolean;
  /** The phone track the call comes from, named as the canvas names it ("Phone track", "Phone track 2"). */
  readonly track: { readonly id: string; readonly label: string };
  /** The prospect's zone and their local time now, as HH:MM. */
  readonly zone: string;
  readonly localTime: string;
  readonly reason: CallReasonApi;
  /** A callback holds the lead's other outreach in this campaign until its outcome. */
  readonly kind: "call" | "callback";
  /** For a callback: the date and time the prospect asked for. */
  readonly callbackAt: string | null;
  /**
   * The call step's original due time. The skip limit counts from it, whatever rolled the call over or
   * redialed it.
   */
  readonly dueAt: string;
  readonly bucket: "ready_now" | "later_today";
  /** For later today: when the prospect's calling hours open, or a callback's time. */
  readonly opensAt: string | null;
  /** Left unworked today, this call is skipped at the end of the day (the skip limit) and the tracks after it start. */
  readonly skippedTonight: boolean;
  /**
   * Every number of the lead is missing or marked bad (ticket 15b): no outcome but skip for now can be
   * logged. On a callback this is question Q13's interim: it stays held and listed until a number is added,
   * the lead replies, or ticket 17's controls exist.
   */
  readonly noGoodNumber: boolean;
}

/**
 * The skip limit on an open call (ADR 0003 3.5, ticket 15b), as the engine counts it: from the call's
 * original due date, whatever rolled it over or redialed it.
 */
export interface SkipLimitView {
  /** The original due date, the user's date the limit counts from (YYYY-MM-DD). */
  readonly dueDate: string;
  readonly limitDays: number;
  /**
   * If the call is not worked and nothing holds the lead, the user's date at whose end it is skipped
   * (YYYY-MM-DD); null while a hold freezes the lead's clock.
   */
  readonly ifUnworked: string | null;
}

/**
 * One enrollment's open call, on the person and company-lead record (ticket 15b), as of the instant read:
 * the call or callback, whether it is on today's list and why, and the skip limit or the callback's time.
 */
export interface RecordCallView {
  readonly enrollmentId: string;
  readonly taskId: string;
  readonly track: { readonly id: string; readonly label: string };
  readonly kind: "call" | "callback";
  /** On today's list now. */
  readonly listed: boolean;
  /** Why it is on today's list; null when it is not. */
  readonly reason: CallReasonApi | null;
  /**
   * The first user date, from today, on which the engine's listing rule lists it (YYYY-MM-DD): a redial moves it
   * on, a callback is listed from its own day, a day without calling hours is passed over. For a call waiting on
   * the lead's callback, its own list date.
   */
  readonly listedFor: string;
  readonly callbackAt: string | null;
  /** The prospect's zone. */
  readonly zone: string;
  /** Null for a callback, which is never skipped. */
  readonly skipLimit: SkipLimitView | null;
  readonly noGoodNumber: boolean;
  /** A call held because the lead has an open callback on another phone track, with that callback's own listing; null otherwise. */
  readonly heldByCallback: CallbackListingView | null;
}

/** GET /api/people/:id and GET /api/companies/:id add each enrollment's open calls to the CRM record (ticket 15b). */
export interface RecordCalls {
  readonly calls: readonly RecordCallView[];
  /** The user's date as the server counts it, YYYY-MM-DD: the day the calls' list dates are read against. */
  readonly today: string;
  /**
   * Each enrollment's decline on a call (ticket 16c): the user's date it was logged on, as the engine counts the day
   * (YYYY-MM-DD), and the declined path taken. A record says it beside the enrollment's status.
   */
  readonly declines: readonly { readonly enrollmentId: string; readonly date: string; readonly path: DeclinedPathApi }[];
}

/** A track whose channel has no connected sender, so the load is not projected (Before launch). */
export interface WithheldTrack {
  readonly trackId: string;
  readonly channel: TrackChannelApi;
  /** As the canvas names it: "the SMS track", "email track 2". */
  readonly label: string;
  /**
   * `no_sender`: its channel has no connected sender, so its leads and every track after it would wait. `not_modelled`: a
   * LinkedIn track, which the estimate does not model yet (ticket 24b: it cannot foresee acceptances, and does not run the
   * connection check), so no figure is shown rather than a wrong one.
   */
  readonly why: "no_sender" | "not_modelled";
  /**
   * Another subject's track (council on dee365d, item 8; on a6c1700, items 3 to 5): a campaign, or a running test, competing
   * with this one, whose LinkedIn track is still to finish for some of its leads, which the estimate cannot simulate; with
   * why it competes. Absent for this campaign's own tracks.
   */
  readonly competing?: {
    readonly name: string;
    /** A running test run of campaign `name`; `own` when it is this campaign's own test. */
    readonly test: boolean;
    readonly own: boolean;
    /** It shares a sender inbox, an SMS number or a LinkedIn session with this campaign, the call list, or senders through another campaign. */
    readonly why: "inbox" | "number" | "session" | "calls" | "through_another";
  };
}

export interface WithheldBy {
  readonly tracks: readonly WithheldTrack[];
}

/** GET /api/today: the landing page's call part. Needs attention is GET /api/needs-attention. */
export interface TodayView {
  /** The user's date, YYYY-MM-DD in their zone. */
  readonly date: string;
  /** The server's instant for this answer. */
  readonly asOf: string;
  /**
   * A hint (ADR 0003 4.4.1, "Freshness"): an instant at which this answer is known to change by the
   * clock (calling hours opening or closing, the user's next day). A screen may refresh then, sooner
   * than its interval; nothing depends on it being complete.
   */
  readonly nextChangeAt: string | null;
  readonly userZone: string;
  readonly readyNow: number;
  readonly laterToday: number;
  /** Today's call capacity is used: calls due after this wait for the next day, and none is dropped (4.4). */
  readonly capacityReached: boolean;
  /** The next calls, in queue order: ready now first, then later today. */
  readonly upNext: readonly CallQueueItem[];
  /** Needs attention (ticket 15): every overdue callback on the list, oldest first, each holding its lead's outreach. */
  readonly overdueCallbacks: readonly CallQueueItem[];
  /** Calls on today's list carried from an earlier day: rolled over or redialed. */
  readonly carriedOver: number;
  /** Of those, the ones skipped tonight if left unworked (`skippedTonight`): on their last day (ticket 15b). */
  readonly carriedOverLastDay: number;
  /** Paused campaigns whose leads wait on a call: their calls are off the list while paused (ticket 17b). */
  readonly pausedCampaigns: readonly PausedCampaignCalls[];
  /**
   * The one-line notice of the latest sending interruption (ticket 20a): "sending was interrupted from `from` to `to`;
   * `rescheduled` sends rescheduled". Kept until a newer interruption replaces it (question Q18); null when none happened.
   */
  readonly interruption: InterruptionNoticeView | null;
  /** While sending is interrupted now: since when, and why. Due sends and calls may be waiting (follow-up 42 item 45). */
  readonly sendingInterrupted: SendingInterruptedView | null;
}

/** A sending interruption that has ended (ADR 0003 "Ticket 20a"). */
export interface InterruptionNoticeView {
  readonly from: string;
  readonly to: string;
  /** The sends the interruption made late: email and texts that could have gone during it and had not gone by its end. */
  readonly rescheduled: number;
}

/**
 * Sending interrupted now (ADR 0003 "Ticket 20a"): no tick has completed with every provider answering for more than five
 * minutes. `ticks_failing`: the worker's ticks throw; `providers_unreachable`: they run, but a provider does not answer;
 * `not_running`: no tick has ended since and no provider read failed: the worker is stopped, asleep or stalled.
 */
export interface SendingInterruptedView {
  readonly since: string;
  readonly cause: "ticks_failing" | "providers_unreachable" | "not_running";
  /** The provider read that failed last since then, and which part of the round: a partial answer is not contact. */
  readonly lastFailedRead: { readonly channel: SendChannelApi; readonly part: "accounts" | "observation" | "call"; readonly at: string } | null;
  /**
   * The last instant a sending round threw since `since` (ticket 20b), else null. Rounds may have ended in between, so
   * `ticks_failing` says the latest round failed, not that every round since `since` did.
   */
  readonly lastRoundFailedAt: string | null;
}

/** GET /api/calls: the focus queue. The focused task is the first ready now; the queue moves on only after an outcome. */
export interface CallsView {
  readonly date: string;
  /** The server's instant for this answer. */
  readonly asOf: string;
  /** As on TodayView: a hint of when the queue changes by the clock. */
  readonly nextChangeAt: string | null;
  readonly userZone: string;
  readonly dailyCapacity: number;
  /** The capacity the user has until they set one. */
  readonly defaultDailyCapacity: number;
  /** Today's call capacity is used: no new call is placed today (4.4: new placed today < capacity − committed). */
  readonly capacityReached: boolean;
  /** New tasks placed today, and tasks carried into today from earlier days, which count first. */
  readonly placedToday: number;
  readonly committed: number;
  /** Inside the prospect's calling hours: oldest due first; tasks skipped for now today go last, in the order skipped. */
  readonly readyNow: readonly CallQueueItem[];
  /** Callable later on the user's day: the calling hours open later today. Soonest first. */
  readonly laterToday: readonly CallQueueItem[];
  /**
   * The focused call. Send the call the screen is on as `?focus=`: it stays the focus while it is
   * listed, so the queue moves on only after an outcome. With none, the first call ready now.
   */
  readonly focusTaskId: string | null;
  /** As on TodayView: while sending is interrupted now, due calls may be waiting to be placed (follow-up 42 item 45). */
  readonly sendingInterrupted: SendingInterruptedView | null;
  /** As on TodayView: paused campaigns whose calls are off the list (ticket 17b). */
  readonly pausedCampaigns: readonly PausedCampaignCalls[];
}

/** POST /api/call-tasks/:id/outcome: the task after the outcome, and the call the focus queue moves on to. */
export interface CallOutcomeAnswer {
  readonly task: CallTaskView;
  readonly nextFocusTaskId: string | null;
}

/** One earlier touch on the lead in this campaign. Replies show channel and date only. */
export type TouchView =
  | { readonly kind: SendChannelApi; readonly at: string; readonly stepId: string; readonly copy: { readonly subject: string; readonly body: string } | null }
  | { readonly kind: "reply"; readonly channel: SendChannelApi; readonly at: string }
  | ({ readonly kind: "call" } & CallRecordView);

/**
 * The number a past call was logged on, as the detail it stands for now: what was dialled, kept through
 * re-imports that merge it, even into a colleague's detail. It says nothing about whether it may be
 * dialled now; the task's `numbers` say that.
 */
export interface RecordedNumberView {
  readonly detailId: string;
  readonly kind: "direct" | "mobile" | "main_line";
  /** The detail's owner now: a person (the lead or a colleague) or the company. */
  readonly owner: "person" | "company";
  readonly value: string;
}

export interface NoteView {
  readonly id: string;
  readonly body: string;
  readonly at: string;
}

/** Someone else at the company, enrolled or not, with their outreach statuses and their last call note. */
export interface CallColleagueView {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly statuses: readonly { readonly campaign: { readonly id: string; readonly name: string }; readonly status: OutreachStatus }[];
  readonly lastCallNote: { readonly note: string; readonly outcome: string; readonly at: string } | null;
}

/**
 * Why a call task is not on today's list (ADR 0003 4.4.1, and "why a call left the list"): the engine's own reason
 * (`offListReason`), the first that holds. `logged`: an outcome on this task is what took it off (it closed the call, or
 * moved it to a later day), never an earlier outcome that left it listed; `track_finished`: its phone track finished
 * otherwise; `lead_ended`: the lead's outreach ended in this campaign; `campaign_paused`, `campaign_not_launched`,
 * `lead_paused`: a hold; `callback_hold`: another of the lead's calls is a callback; `listed_later`: listed from a later
 * user day (`listedFrom`, YYYY-MM-DD); `no_hours_today`: the prospect's calling hours do not open on the user's day.
 * `status` is the lead's status now.
 */
export type CallOffListView =
  | { readonly reason: "logged"; readonly outcome: CallOutcomeApi; readonly at: string; readonly status: OutreachStatus }
  | { readonly reason: "track_finished"; readonly finish: FinishReasonApi | null; readonly status: OutreachStatus }
  | { readonly reason: "lead_ended"; readonly status: OutreachStatus }
  | { readonly reason: "campaign_paused"; readonly status: OutreachStatus }
  | { readonly reason: "campaign_not_launched"; readonly status: OutreachStatus }
  | { readonly reason: "lead_paused"; readonly status: OutreachStatus }
  | { readonly reason: "callback_hold"; readonly callback: CallbackListingView; readonly status: OutreachStatus }
  | { readonly reason: "listed_later"; readonly listedFrom: string; readonly status: OutreachStatus }
  | { readonly reason: "no_hours_today"; readonly status: OutreachStatus };

/** The lead's open callback, which holds its other calls: on today's list, or the user's day (YYYY-MM-DD) it is listed from. */
export interface CallbackListingView {
  readonly listed: boolean;
  readonly listedFor: string;
}

/** GET /api/call-tasks/:id: everything the call screen shows for one task. */
export interface CallTaskView {
  readonly task: CallQueueItem | null;
  readonly taskId: string;
  readonly enrollmentId: string;
  /** Open until its outcome is logged or its track finishes. */
  readonly open: boolean;
  /** On today's list now, so an outcome is accepted. */
  readonly listed: boolean;
  /** Why it is not on today's list; null while it is. */
  readonly offList: CallOffListView | null;
  readonly status: OutreachStatus;
  readonly person: { readonly id: string; readonly name: string; readonly title: string } | null;
  readonly company: { readonly id: string; readonly name: string };
  readonly campaign: { readonly id: string; readonly name: string };
  /** A test call (ticket 21): to the user's own test mobile, from a test run; it keeps no note. */
  readonly test: boolean;
  readonly track: { readonly id: string; readonly label: string };
  readonly zone: string;
  readonly localTime: string;
  readonly numbers: readonly CallNumberView[];
  /** The phone track's calling hours, in the prospect's local time (its window: days 0 = Sunday, whole hours). */
  readonly callingHours: readonly import("../domain/sequence/clock.ts").WindowRule[];
  /**
   * Whether the prospect is inside those calling hours at this read's instant, by the engine's own window
   * rule (re-check 7, R10), and, when not, the instant they open later on the user's day (null if not
   * today). A fact about the hours only: a callback is listed by the time asked for, whatever the hours.
   */
  readonly callingHoursNow: { readonly open: boolean; readonly opensLaterToday: string | null };
  /** The campaign's call script or talking points. */
  readonly script: string;
  /** Every earlier touch on this lead in this campaign, oldest first. Engagement (opens, clicks) is not tracked. */
  readonly touches: readonly TouchView[];
  readonly personNotes: readonly NoteView[];
  /** Shown for everyone at the company. */
  readonly companyNotes: readonly NoteView[];
  /** Every other decision maker at the company, including people not enrolled. */
  readonly colleagues: readonly CallColleagueView[];
  /** The outcomes the user can log now; empty when the task is not listed. */
  readonly outcomes: readonly CallOutcomeApi[];
  /** Of those, the ones the user may log with a redial (no answer, voicemail, gatekeeper). */
  readonly redialOutcomes: readonly CallOutcomeApi[];
  /** A callback holds the lead's other outreach in this campaign until its outcome (ticket 15). */
  readonly kind: "call" | "callback";
  readonly callbackAt: string | null;
  /** The call step's original due time, which the skip limit counts from. */
  readonly dueAt: string;
  /** The user's date the call is listed for, YYYY-MM-DD: a redial moves it to the next day. */
  readonly listedFor: string;
  /** The phone track's declined path, which the outcome screen preselects for not interested (ticket 16). */
  readonly declinedPath: DeclinedPathApi;
  /** The paths the user may choose for this lead: win back only while the campaign has a win-back branch. */
  readonly declinedPaths: readonly DeclinedPathApi[];
  /** Whether the phone track's definition sets a declined path; false: `declinedPath` is the engine's interim for an unset track (Q14). */
  readonly declinedPathSet: boolean;
  /**
   * What not interested logged now would do on each path in `declinedPaths`, in that order (ticket 16c): the engine's own
   * outcome applied to a copy of the lead as of this read, storing nothing. Null while the call is not listed or no number
   * can be logged on.
   */
  readonly declines: readonly DeclinePreviewView[] | null;
  /**
   * The request id of every outcome stored on this task, skips for now included: the server's word on
   * whether a press was logged, whoever received its answer (ADR 0003 4.4.1, "One reconciliation").
   */
  readonly storedRequestIds: readonly string[];
  /**
   * The outcomes stored on this task, each with its request id (ticket 15b): what the server holds for a
   * press, redial and callback time included, so the page says only what was stored.
   */
  readonly storedCalls: readonly (CallRecordView & { readonly requestId: string })[];
  /** The server's instant for this read. */
  readonly asOf: string;
  /** The skip limit on this call; null for a callback, which is never skipped. */
  readonly skipLimit: SkipLimitView | null;
  /**
   * What a redial logged now does (ticket 15b): the engine's own outcome applied to a copy of the call, storing
   * nothing, a callback's hold released first. The user's date the call is then listed for, and its skip limit
   * then (null if the call would no longer be open). Null when no redial is offered or no number can be logged on.
   */
  readonly redial: { readonly listedFor: string; readonly skipLimit: SkipLimitView | null } | null;
  /**
   * The first user date, from today, on which the engine's listing rule lists this call (YYYY-MM-DD), as the
   * record counts it; null when it lists it on none (the lead ended or is paused, the call waits on a callback).
   */
  readonly listedFrom: string | null;
}

// -------------------------------------------------------------------------------------------
// Ticket 18: bulk actions on Leads (ADR 0003 "Ticket 18"). A bulk control is the set of per-lead controls its
// confirmation showed; add to campaign uses the import's enrollment rule.

export type BulkAction = "add" | "pause" | "resume" | "stop";
export type BulkControlAction = Exclude<BulkAction, "add">;

/** A selected Leads row: a person, or a company lead. */
export interface BulkRowRef {
  readonly kind: "person" | "company";
  readonly id: string;
}
export interface BulkRowView extends BulkRowRef {
  readonly name: string;
}

/** One enrollment in a bulk control's scope, with the action's entry in its own read (the same as GET /api/enrollments/:id). */
export interface BulkPreviewItem {
  readonly row: BulkRowView;
  readonly enrollmentId: string;
  readonly campaign: { readonly id: string; readonly name: string };
  readonly status: OutreachStatus;
  readonly control: ControlView;
}

/** POST /api/bulk/preview for pause, resume or stop: the scope resolved as of `asOf`, and what the press would do. */
export interface BulkControlPreview {
  readonly asOf: string;
  readonly action: BulkControlAction;
  /** The campaign Leads was filtered to; null for every campaign each selected row is in. */
  readonly scope: { readonly id: string; readonly name: string } | null;
  readonly rows: number;
  readonly items: readonly BulkPreviewItem[];
  /** Selected rows with no enrollment in scope. */
  readonly outOfScope: readonly BulkRowView[];
  /** Tallies of `items`: how many the action applies to, how many it refuses, grouped by the refusal's reason. */
  readonly counts: { readonly applies: number; readonly refused: number; readonly reasons: readonly { readonly reason: string; readonly count: number }[] };
}

export type BulkAddOutcome = "enroll" | "already_enrolled" | "not_enrolled";
/**
 * Why the import's enrollment rule leaves a lead out (the page words each one, as the import results do): no usable
 * channel; a personal email, mobile or shared inbox another lead in the campaign holds; or a company whose decision
 * makers are on record and reachable (or that has no shared inbox), which is never a company lead.
 */
export type BulkNotEnrolled =
  | { readonly reason: "no_usable_channel" }
  | { readonly reason: "shares_contact"; readonly shared: { readonly detail: DetailNote; readonly lead: string; readonly companyName: string; readonly enrolled: boolean } }
  | { readonly reason: "decision_makers_on_record" };
export interface BulkAddRow {
  readonly row: BulkRowView;
  readonly outcome: BulkAddOutcome;
  /** Set exactly when the outcome is not_enrolled. */
  readonly notEnrolled: BulkNotEnrolled | null;
}

/** POST /api/bulk/preview for add: the import's enrollment rule on the directory as of `asOf`, writing nothing. */
export interface BulkAddPreview {
  readonly asOf: string;
  readonly action: "add";
  readonly campaign: { readonly id: string; readonly name: string };
  readonly rows: readonly BulkAddRow[];
  readonly counts: { readonly enroll: number; readonly alreadyEnrolled: number; readonly notEnrolled: number };
}

export type BulkPreview = BulkControlPreview | BulkAddPreview;

/** One per-lead answer of a bulk control: the engine's answer to the per-lead request `bulkId/enrollmentId`. */
export interface BulkControlResult {
  readonly enrollmentId: string;
  readonly outcome: "applied" | "refused";
  readonly reason: string | null;
  /** The answer is the per-lead request's first answer, given again. */
  readonly replayed: boolean;
}

/** POST /api/bulk for pause, resume or stop. */
export interface BulkControlAnswer {
  readonly bulkId: string;
  readonly action: BulkControlAction;
  readonly results: readonly BulkControlResult[];
  readonly counts: { readonly applied: number; readonly refused: number };
}

export interface BulkAddResult {
  readonly row: BulkRowView;
  readonly outcome: "enrolled" | "already_enrolled" | "not_enrolled";
  readonly notEnrolled: BulkNotEnrolled | null;
  readonly enrollmentId: string | null;
}

/** POST /api/bulk for add: stored with the bulk id in the transaction that enrolls, so a retry replays it. */
export interface BulkAddAnswer {
  readonly bulkId: string;
  readonly action: "add";
  readonly campaign: { readonly id: string; readonly name: string };
  readonly results: readonly BulkAddResult[];
  readonly counts: { readonly enrolled: number; readonly alreadyEnrolled: number; readonly notEnrolled: number };
  readonly replayed: boolean;
}

export type BulkAnswer = BulkControlAnswer | BulkAddAnswer;

// ---------------------------------------------------------------------------------------------
// Test runs (ticket 21; ADR 0003 "Ticket 21").

/** The campaign's Test run tab: its test contacts, whether it has been tested since the last edit, and the latest run. */
export interface TestRunTab {
  readonly campaignId: string;
  /** The revision on the page, which Run test names (`expect`). */
  readonly definitionVersion: number;
  readonly contacts: {
    readonly email: string | null;
    readonly mobile: string | null;
    /** A lead's record now has it: it cannot be used (question Q29). */
    readonly emailIsALead: boolean;
    readonly mobileIsALead: boolean;
    /** The user's own test LinkedIn profile (ADR 0004 section 8), and whether a person's record now has it. */
    readonly linkedin: string | null;
    readonly linkedinIsALead: boolean;
    /**
     * The user's own test account on each message-request channel (ADR 0004 13.8), and whether a person's or company's
     * record now has it; every channel is present, null when none is set.
     */
    readonly social: { readonly [C in MessageRequestChannel]: { readonly address: string | null; readonly isALead: boolean } };
  };
  readonly noTestSinceEdit: boolean;
  /** The leads a test may render its copy for, by name. */
  readonly leads: readonly { readonly id: string; readonly name: string; readonly kind: "person" | "company" }[];
  /** The latest run, read as of `at`; null before the first. */
  readonly run: TestRunRead | null;
  /** The read's instant. */
  readonly at: string;
  /** The zone the run's times are in: the campaign's (question Q2's interim). */
  readonly zone: string;
}

/** How a test run ended, in its own words (ADR 0003 "Ticket 21"). */
export type TestRunEnding = "your_reply" | "finished" | "no_contact_left" | "interested" | "declined" | "stopped" | "edited";

export interface TestRunRead {
  readonly id: string;
  readonly running: boolean;
  readonly ending: TestRunEnding | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** The lead its copy renders for. */
  readonly renderAs: { readonly id: string; readonly name: string };
  readonly email: string | null;
  readonly mobile: string | null;
  /** The test LinkedIn profile it sends to (ADR 0004 section 8). */
  readonly linkedin: string | null;
  /** The test account it sends to on each message-request channel (ADR 0004 13.8); null when none. */
  readonly social: { readonly [C in MessageRequestChannel]: string | null };
  /** Its messages still with a provider, which may still be sent after it ended. */
  readonly mayStillSend: number;
  readonly steps: readonly TestStepRow[];
  /** The channel of the reply that stopped the run, as stored when it stopped (ticket 25): a social one is the user's mark. */
  readonly stopReply: SendChannelApi | null;
  /** The run's outreach status at the read, which a reply mark's confirmation sends back as its expectation (ticket 24b). */
  readonly status: OutreachStatus;
  /** Each LinkedIn track's own facts for this run, as a lead's read gives them (council on dee365d, items 2 and 3). */
  readonly linkedinTracks: readonly { readonly trackId: string; readonly view: LinkedinTrackView }[];
  /** Whether the user may mark this test replied on LinkedIn now, by the engine's rule; null with no LinkedIn track (ticket 24b). */
  readonly replyMarks: ReplyMarks;
}

/** What happened to one step of the canvas in a test run, from its stored facts only. */
export type TestStepState =
  /** The provider reported it sent, at `at`. */
  | "sent"
  | "failed"
  | "skipped"
  /** Handed to the provider; no answer yet. */
  | "with_provider"
  /** Not sent yet: ready when `at` is the read's instant, else the earliest `at` (its window's next opening), or `at` is null and `waits` says why. */
  | "due"
  /** Held (ADR 0003 5.4): it waits on what `hold` names, not on its wait; never said to be due. */
  | "held"
  /** A call on your Calls list now, by the engine's listing rule. */
  | "on_your_list"
  /** A call of a running test that is not on today's list: `at` is the start of the first day it is listed, or null. */
  | "listed_later"
  /** A call whose outcome you logged. */
  | "logged"
  /** Not reached: earlier steps first, or the run ended before it. */
  | "not_reached";

export interface TestStepRow {
  readonly trackId: string;
  readonly stepId: string;
  readonly channel: TrackChannelApi;
  readonly branch: "main" | "win_back";
  /** "Email 2", "Text 1", "Call", "Win-back email 1". */
  readonly name: string;
  /** The track's name, when the campaign has several on that channel or branch. */
  readonly track: string;
  readonly state: TestStepState;
  readonly at: string | null;
  /** For a due step with no time the engine can promise: why it waits (`StepWaitApi`); null otherwise. */
  readonly waits: StepWaitApi | null;
  /** With `awaiting_acceptance`: the day the acceptance wait ends, a fact of the read (ADR 0004 section 9), never a send. */
  readonly until?: string;
  /** For a call: its task, and the outcome logged. */
  readonly taskId: string | null;
  readonly outcome: string | null;
  /**
   * Why a step was skipped or failed: the engine's word on its result (`missing_channel`, …), or, for a step its track
   * finished without reaching, why the track finished: `missing_channel`, `bad_destination`, `declined`, `skipped_by_you`,
   * `unworked`, `win_back`, `interested`, `sms_conversation_taken` (with `owners`) or `skipped`.
   */
  readonly reason: string | null;
  /** For `sms_conversation_taken`: whose conversation the test mobile is in (ADR 0003, question Q7 answered). */
  readonly owners?: readonly ConversationOwnerView[];
  /** For `held`: why, as Needs attention names a held track's reason; for `sms_conversation_unsettled`, whose text. */
  readonly hold?: HoldReasonApi;
  readonly holdOwners?: readonly ConversationOwnerView[];
}

/** A test contact refused: malformed (400), or a lead's (409), by field. */
export interface TestContactsRefusal {
  readonly error: { readonly code: "invalid_test_contact" | "test_contact_is_a_lead"; readonly message: string; readonly field: "email" | "mobile" | SocialChannel };
}
