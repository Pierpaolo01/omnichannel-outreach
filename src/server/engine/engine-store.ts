import type { StoredReplyId } from "../../domain/sequence/reply-identity.ts";
import type { LaunchCheck, SenderAccountView } from "../../domain/sequence/blockers.ts";
import type { MergeData } from "../../domain/sequence/copy.ts";
import type { CampaignDefinition } from "../../domain/sequence/definition.ts";
import { isTimeZone } from "../../domain/sequence/clock.ts";
import type { AccountState, Attempt, EndReason, ProviderWork, SmsBindingRecord, SubjectState, TrackProgress } from "../../domain/sequence/state.ts";
import type { RunTestFacts } from "../../domain/sequence/test-runs.ts";
import type { TestContacts } from "../../domain/test-contacts.ts";

/** One test run as stored (ADR 0003 "Ticket 21"): what it ran with and how it ended; its progress is a subject's. */
export interface TestRunRecord {
  readonly id: string;
  readonly campaignId: string;
  readonly renderAs: string;
  readonly contacts: TestContacts;
  readonly startedWall: number;
  readonly definitionVersion: number;
  readonly definitionEditedAt: string | null;
  /** Set when an edit stopped it (question Q27). */
  readonly stoppedBy: "edit" | null;
  readonly ended: EndReason | null;
  readonly endedWall: number | null;
}

/** A campaign's test contacts, and whether a lead's record now has either (the boundary). */
export interface StoredTestContacts {
  readonly contacts: TestContacts;
  readonly leadHas: { readonly email: boolean; readonly mobile: boolean; readonly linkedin?: boolean };
}

/** A sender account as the provider port reports it. */
/** The process that runs the worker on a database (ticket 20a): a random id, its process id, and when it last renewed. */
export interface WorkerLease {
  readonly id: string;
  readonly pid: number;
  readonly renewedWall: number;
}

/** One accepted control request, as `control_requests` keeps it: its target, the action, the effect it answered with (lead controls) and when. */
export interface AcceptedControl {
  readonly target: string;
  readonly action: string;
  /** The control's effect as answered, JSON (`effectOf`); null for a campaign's pause and resume. */
  readonly effect: string | null;
  readonly atWall: number;
}

/** A social sender account's allowances (ADR 0004 1.2): the user's numbers, no default. */
export interface SocialAllowances {
  readonly invitesPerDay: number;
  readonly messagesPerDay: number;
  readonly notesPerMonth: number;
}

export interface SenderAccountConfig {
  readonly id: string;
  readonly channel: "email" | "sms" | "linkedin";
  readonly label: string;
  /** Today's room: the sends it may still make on its current reset day, a whole number, 0 when there is none (`storableAccount`). */
  readonly capacity: number;
  /**
   * Its daily limit: the room it has on any other reset day (council on PR 63). Today's room can be less, when other
   * senders used some of it; the projection and the interruption count use this for every day but today.
   */
  readonly dailyLimit: number;
  /** The pacing gap; null for ADR 0003 4.1's default from the windows the account serves. */
  readonly gapMs: number | null;
  /** In-flight bound (ADR 0002's k). */
  readonly k: number;
  readonly healthy: boolean;
  /** Why the provider says it cannot send, when not healthy, in the provider's own words (such as Instantly's "sending_off"). */
  readonly problem?: string | null;
  readonly resetZone: string;
  /**
   * A LinkedIn session's InMail standing, as the session reported it with this listing (ADR 0004 13.5); null: a report the
   * store cannot hold (read as no plan). Absent: no report with this listing, so the last one stands.
   */
  readonly inmail?: { readonly plan: "premium" | "sales_navigator" | "none"; readonly credits: number } | null;
}

/**
 * A sender account as a port reported it, made storable (verifier, 15 November 2026; council on PR 63). Capacity (today's
 * room) and the daily limit are whole numbers of sends, 0 included: 0 is "no room" (an Instantly inbox other senders
 * used up, or with no daily limit), and the claim's capacity rule refuses it like any full account. Every field the store
 * needs is checked: a non-empty id and label, the port's own channel, a zone `Intl` knows, whole non-negative capacity
 * and daily limit, an in-flight bound of at least 1, and a gap that is null or a positive whole number of milliseconds.
 * A report that fails any of them holds that one account as `invalid_report`, with no room and storable defaults, so it
 * never fails the sync of the others. A report with no usable id names no account: it is left out (null).
 */
export function storableAccount<T extends SenderAccountConfig>(reported: T, channel: "email" | "sms" | "linkedin"): T | null {
  // A port's answer is read as data from outside: any field may be missing or of another type.
  const value: unknown = reported;
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  const text = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
  if (!text(r["id"])) return null;
  const whole = (v: unknown, min: number) => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
  const zone = text(r["resetZone"]) && isTimeZone(r["resetZone"]);
  const valid =
    text(r["label"]) &&
    r["channel"] === channel &&
    zone &&
    whole(r["capacity"], 0) &&
    whole(r["dailyLimit"], 0) &&
    whole(r["k"], 1) &&
    (r["gapMs"] === null || whole(r["gapMs"], 1));
  // A session's InMail report that is not a known plan and a whole number of credits is read as none (ADR 0004 13.5): an
  // InMail never goes on a report the engine cannot read.
  const inmail = r["inmail"];
  const report = inmail as { plan?: unknown; credits?: unknown } | null | undefined;
  const readable = inmail === undefined || inmail === null || (report !== null && typeof report === "object" && ["premium", "sales_navigator", "none"].includes(String(report.plan)) && whole(report.credits, 0));
  if (!readable) return storableAccount({ ...reported, inmail: null }, channel);
  if (valid) return reported;
  return {
    ...reported,
    label: text(r["label"]) ? reported.label : reported.id,
    channel,
    resetZone: zone ? reported.resetZone : "UTC",
    capacity: 0,
    dailyLimit: 0,
    k: 1,
    gapMs: null,
    healthy: false,
    problem: "invalid_report",
  };
}

export interface CampaignEngineRow {
  readonly id: string;
  readonly definition: CampaignDefinition | null;
  readonly definitionVersion: number;
  readonly definitionEditedAt: string | null;
  readonly launchedAt: number | null;
  /** The instant the campaign was paused, or null while it runs (ticket 17a). */
  readonly pausedSince: number | null;
  readonly version: number;
}

/**
 * A request id's first answer (ADR 0003 "Ticket 17a", P7; verifier B5): accepted, with the control's effect as JSON,
 * or refused, with its reason. The same id is answered with it again and changes nothing.
 */
export interface StoredRequest {
  readonly target: string;
  readonly action: string;
  /** The request's body as JSON (council I on 56d599c): the id is bound to it as well as to its answer. */
  readonly body: string;
  readonly answer: "accepted" | "refused";
  readonly reason: string | null;
  readonly effect: string | null;
}

/** How a request id stands against its stored first answer: new, a repeat of it, reused for another target or action, or sent again with another body. */
export type RequestStanding = "new" | "replay" | "reused" | "different";

/** What a control's transaction did: answered now, the first answer replayed, or refused as a reused id. */
export type ControlRecord =
  | { readonly kind: "answered" | "replayed"; readonly answer: "accepted" | "refused"; readonly reason: string | null; readonly effect: string | null }
  | { readonly kind: "reused" }
  | { readonly kind: "different" };

/** A control's decision on the state it read: what to write (null for nothing), and its answer. */
export interface ControlDecision<S> {
  readonly write: S | null;
  readonly answer: "accepted" | "refused";
  readonly reason: string | null;
  readonly effect: string | null;
}

/**
 * A reply event the provider reported, kept by its event id for good (ADR 0003 2.4): `pending`
 * while its thread is unknown (sends from the inbox to the address pause), `unmatched` once its
 * fallback matched nothing (kept by reference, without pausing), `resolved` once recorded on a lead.
 */
export interface ReplyEvent {
  /** The reply's stored id (the reply identity rule). */
  readonly eventId: StoredReplyId;
  readonly providerRef: string | null;
  readonly inbox: string;
  /** Bare and lowercase. */
  readonly address: string;
  readonly atWall: number;
  readonly receivedWall: number;
  readonly state: "pending" | "resolved" | "unmatched";
  /** Running time it has waited for its thread (a restart's downtime is not counted). */
  readonly waitedMs: number;
  readonly lastCountedWall: number;
}

/** The user's call settings (ADR 0003 3.4, 4.4): one daily call capacity, and the zone the call list's day is counted in. */
export interface CallSettings {
  readonly dailyCapacity: number;
  readonly userZone: string;
}

/** A note on a person, or a company note shown for everyone at the company. */
export interface StoredNote {
  readonly id: string;
  readonly owner: "person" | "company";
  readonly ownerId: string;
  readonly body: string;
  readonly atWall: number;
  readonly subjectId: string | null;
  readonly callAttemptId: string | null;
}

/** A logged call outcome with a note, as a colleague's "last call note" reads it. */
export interface CallNoteRecord {
  readonly subjectId: string;
  readonly outcome: string;
  readonly note: string;
  readonly atWall: number;
}


/** A hard bounce the provider reported for one piece of provider work, kept for good by its event id. */
export interface BounceEvent {
  readonly eventId: string;
  readonly subjectId: string;
  readonly workKey: string;
  readonly trackId: string;
  readonly stepId: string;
  readonly destination: string;
  /** The provider's bounce time, clamped to now. */
  readonly atWall: number;
  readonly receivedWall: number;
}

export type LaunchOutcome = { readonly ok: true; readonly stored: StoredDefinition } | { readonly ok: false; readonly check: LaunchCheck | null; readonly reason: "already_launched" | "blocked" | "no_definition" | "changed" };

/** The row as the saving transaction left it: what the answer is built from (PR 41 council, item 4). */
export interface StoredDefinition {
  readonly definition: CampaignDefinition;
  readonly definitionVersion: number;
  readonly definitionEditedAt: string | null;
  readonly launchedAt: number | null;
}

/**
 * `replaced`: this session's save was accepted before, then another page that had seen it saved over
 * it (ADR 0003 1.1.1): its retry is not a conflict of its own, and its page's change was saved.
 */
export type SaveResult =
  | { readonly outcome: "saved" | "unchanged" | "launched" | "superseded" | "replaced" | "conflict"; readonly stored: StoredDefinition }
  /** A running campaign's save refused by its boundary (ADR 0003 "Ticket 19"): nothing stored. */
  | { readonly outcome: "invalid"; readonly problems: readonly string[]; readonly stored: StoredDefinition }
  /** A running campaign's save refused by one of the three launch blockers (7.2): nothing stored. */
  | { readonly outcome: "blocked"; readonly check: LaunchCheck; readonly stored: StoredDefinition }
  /** A running save sent with the digest of a read that no longer matches it (review bot on 7afa03d): nothing stored. */
  | { readonly outcome: "impact_changed"; readonly elsewhere: boolean; readonly stored: StoredDefinition }
  | { readonly outcome: "missing" };

/**
 * How the store applies a save to a launched campaign (ADR 0003 "Ticket 19"), every step inside the save's transaction:
 * the boundary and the three blockers, each lead caught up under the old definition, then reconciled under the new one.
 */
export interface RunningSave {
  readonly problems: (definition: CampaignDefinition, previous: CampaignDefinition) => readonly string[];
  /** The three launch blockers over what the campaign's leads, as the edit will leave them (`leadsAfter`), can still run. */
  readonly check: (definition: CampaignDefinition, leadsAfter: readonly SubjectState[], leads: readonly MergeData[], accounts: readonly SenderAccountView[]) => LaunchCheck;
  readonly catchUp: (state: SubjectState) => SubjectState;
  readonly reconcile: (state: SubjectState, previous: CampaignDefinition, previousZone: string) => SubjectState;
  readonly now: number;
  /** The digest of the read the user applied from, if the client sent one, and how to compute it on the stored state. */
  readonly impact?: { readonly expected: string; readonly digest: (definition: CampaignDefinition, definitionVersion: number, pausedSince: number | null) => string };
}

/** What an accepted save does to the campaign's running test (question Q27's interim): stops it, in the save's transaction. */
export interface TestStop {
  readonly now: number;
  readonly stop: (state: SubjectState) => SubjectState;
}

/** Who wrote a save (ADR 0003 1.1.1): the editing session, its number in it, and the revision it last saw. */
export interface DefinitionSave {
  readonly session: string;
  readonly seq: number;
  readonly base: number;
}

/**
 * The sequence engine's persistence (ADR 0003 9.1). Every change to a subject goes through
 * `update`: the store loads the subject's state inside one write transaction, lets a pure
 * function decide, and writes back whatever changed, bumping the subject's version and storing
 * its derived status in the same transaction.
 */
export interface EngineStore {
  campaign(campaignId: string): Promise<CampaignEngineRow | null>;
  /**
   * Saves a definition before launch, by the rule of ADR 0003 1.1.1: decided and stored in one
   * transaction. Without `save` (API clients, tests) it is stored as before. A launched campaign's
   * save is applied by `running` (ticket 19); without it, a launched campaign's save is refused as `launched`.
   */
  saveDefinition(campaignId: string, definition: CampaignDefinition, editedAt: string, save?: DefinitionSave | null, running?: RunningSave, testStop?: TestStop): Promise<SaveResult>;

  // Test runs (ADR 0003 "Ticket 21").
  /** The campaign's test contacts and whether a lead's record has either now; null for no such campaign. */
  testContacts(campaignId: string): Promise<StoredTestContacts | null>;
  /** Stores the contacts in one transaction, refusing one a person's or company's live detail has. */
  saveTestContacts(campaignId: string, contacts: TestContacts): Promise<{ readonly ok: true } | { readonly ok: false; readonly field: "email" | "mobile" | "linkedin"; readonly message: string } | { readonly ok: false; readonly missing: true }>;
  /**
   * Run test in one transaction with its request id (17a's binding): the facts are read, `refusal` judges them, and an
   * accepted run is inserted and entered with `enter`. The effect names the run.
   */
  startTestRun(
    campaignId: string,
    now: number,
    request: { readonly id: string; readonly renderAs: string; readonly expectVersion: number; readonly runId: string },
    standing: (stored: StoredRequest | null, request: { readonly target: string; readonly action: string; readonly body: string }) => RequestStanding,
    refusal: (facts: RunTestFacts) => string | null,
    enter: (state: SubjectState) => SubjectState,
  ): Promise<ControlRecord>;
  /** The campaign's test runs, newest first. */
  testRunsOf(campaignId: string): Promise<TestRunRecord[]>;
  testRun(runId: string): Promise<TestRunRecord | null>;
  /** "No test since the last edit" (ADR 0003 "Ticket 21"): no run started on the campaign's current edit stamp. */
  noTestSinceEdit(campaignId: string): Promise<boolean>;
  /**
   * Every enrollment of the campaign as stored now, in one snapshot, with the zone each would have under `draft` (its
   * default zone may differ): what the editor's read of a running edit starts from (ADR 0003 "Ticket 19"). Stores nothing.
   */
  campaignLeadsUnder(campaignId: string, now: number, draft: CampaignDefinition): Promise<{ readonly state: SubjectState; readonly zoneUnderDraft: string }[]>;
  /** The merge data of every enrollment of the campaign that has not ended, and the sender accounts. */
  launchInputs(campaignId: string): Promise<{ leads: MergeData[]; accounts: SenderAccountView[] }>;
  /**
   * Launches in one transaction: re-checks the blockers, marks the campaign launched and enters
   * every enrollment through `enter`.
   */
  launch(
    campaignId: string,
    now: number,
    decide: (definition: CampaignDefinition, leads: MergeData[], accounts: SenderAccountView[]) => LaunchCheck,
    enter: (state: SubjectState) => SubjectState,
    /** The revision the user is looking at: launch is refused ("changed") if the stored one is another. */
    expectedDefinitionVersion?: number,
  ): Promise<LaunchOutcome>;

  subject(subjectId: string, now: number): Promise<SubjectState | null>;
  /**
   * One control on one lead (ticket 17a), in one transaction with its request id: a request id already
   * recorded for the same target and action is `replayed` and writes nothing; one recorded for another is
   * `reused`. Otherwise the lead is loaded, `decide` judges it, what it returns is written, and an accepted
   * control is recorded with its request id.
   */
  controlSubject(
    subjectId: string,
    now: number,
    /** `target`: what the id is bound to, the lead by default (a call task for an outcome). `body`: the request as JSON. */
    request: { readonly id: string; readonly action: string; readonly target?: string; readonly body: string },
    standing: (stored: StoredRequest | null, request: { readonly target: string; readonly action: string; readonly body: string }) => RequestStanding,
    decide: (state: SubjectState) => ControlDecision<SubjectState>,
  ): Promise<ControlRecord>;
  /**
   * Pauses (`pause: true`) or resumes a campaign in one transaction (ticket 17a): `refusal` judges the campaign
   * row; then every enrollment that has not ended is loaded as it stood and written as `perLead` returns it, the
   * campaign's `paused_since` is set or cleared with its version bumped, its hold interval opened or closed, and
   * the request recorded. Request ids as `controlSubject`.
   */
  setCampaignPause(
    campaignId: string,
    now: number,
    request: { readonly id: string; readonly pause: boolean; readonly expect?: { readonly pausedSince: number | null } },
    standing: (stored: StoredRequest | null, request: { readonly target: string; readonly action: string; readonly body: string }) => RequestStanding,
    refusal: (row: { readonly launchedAt: number | null; readonly pausedSince: number | null }) => string | null,
    perLead: (state: SubjectState) => SubjectState,
  ): Promise<ControlRecord>;
  /** Provider work of the campaign's leads that was handed over and has not settled: it may still be sent (ticket 17a). */
  uncertainWorkOf(campaignId: string): Promise<number>;
  /** The count of the campaign's leads in each outreach status (ticket 17a). */
  statusCounts(campaignId: string): Promise<Record<string, number>>;
  /**
   * The stored activity the campaign measures tally (ticket 22; ADR 0003 "Ticket 22"), every row read through the campaign's
   * enrollments, so a test run's rows (a subject with no enrollment) are never read, all in one read transaction: one
   * snapshot. `everyCampaign` exists only for the measures' scope mutation (M8); the application never passes it.
   */
  measureFacts(campaignId: string, options?: { readonly everyCampaign?: boolean }): Promise<MeasureFacts | null>;
  /**
   * The accepted control requests on these targets (enrollment and campaign ids), oldest first, as the engine recorded each in
   * the transaction that applied it (ticket 17a's `control_requests`): Activity says them (ticket 17b). Refusals and call outcomes are left out.
   */
  acceptedControls(targets: readonly string[]): Promise<AcceptedControl[]>;
  /** Loads, decides and writes in one transaction. A null decision writes nothing. */
  update(subjectId: string, now: number, decide: (state: SubjectState) => SubjectState | null): Promise<SubjectState | null>;
  /**
   * `update`, committed before it returns: a send's authorization uses it so that nothing
   * asynchronous runs between the commit and the provider call (ADR 0003 5.5 step 6).
   */
  updateNow(subjectId: string, now: number, decide: (state: SubjectState) => SubjectState | null): SubjectState | null;
  /** Enrollments of launched campaigns that have not ended. */
  /**
   * Leads of launched campaigns that have not ended: every read that lists leads iterates these, never test runs
   * (ADR 0003 "Ticket 21", rule 4; council on ffa202c, item 8).
   */
  runningLeadIds(): Promise<string[]>;
  runningLeadIdsAndTests(): Promise<string[]>;
  /** Test runs that have not ended: the worker runs them beside the leads; only the Test run tab shows them. */
  runningTestRunIds(): Promise<string[]>;
  /** For each running subject, a key that changes whenever its state, its campaign's, or the lead facts it reads change. */
  runningSubjectVersions(): Promise<Map<string, string>>;
  /** Every attempt that is not terminal. */
  openAttempts(): Promise<Attempt[]>;
  attempt(attemptId: string): Promise<Attempt | null>;
  /** Unsettled provider work a quiesce wants withdrawn (ticket 17a; council A). */
  workToWithdraw(): Promise<ProviderWork[]>;
  /** The release rule every write of a subject applies (council on b21af02, item 7); set by the engine. */
  releaseRule?: (state: SubjectState) => SubjectState;
  /** LinkedIn tracks whose invite an acceptance expiry wants withdrawn, with the invite's sent work (ADR 0004 3.3). */
  invitesToWithdraw(): Promise<{ readonly subjectId: string; readonly trackId: string; readonly workKey: string; readonly progress: TrackProgress }[]>;
  /** A social account's allowances, the user's settings (ADR 0004 1.2); null when none are set. */
  allowances(accountId: string): Promise<SocialAllowances | null>;
  /** Sets them: refused for an account that is not a social sender. */
  setAllowances(accountId: string, allowances: SocialAllowances, now: number): Promise<"set" | "not_social">;
  /** Unsettled provider work with a lookup scheduled. */
  openWork(): Promise<ProviderWork[]>;
  /**
   * What holds each account's capacity and in-flight places now, by subject, counted exactly as
   * `accounts` counts them: unsettled work not yet sent (a reservation) and live attempts. Read by
   * the Before launch projection for the subjects it does not simulate (ADR 0003, ticket 13b).
   */
  heldOnAccounts(): Promise<{ readonly accountId: string; readonly subjectId: string; readonly reservations: number; readonly live: number }[]>;
  work(key: string): Promise<ProviderWork | null>;
  workByProviderRef(providerRef: string): Promise<ProviderWork | null>;
  /** Provider work handed over to `address` (any case) from `inbox`: the candidates a reply outside a known thread may fall back to (2.4). */
  workReachedFrom(inbox: string, address: string): Promise<ProviderWork[]>;
  /** Unsettled provider work that is unresolved: it holds a reservation and is listed in Needs attention. */
  unresolvedWork(): Promise<ProviderWork[]>;
  /** Sends counted on the account's current reset day. */
  sentToday(accountId: string, now: number): Promise<number>;

  replyEvent(eventId: StoredReplyId): Promise<ReplyEvent | null>;
  /** Records a reply event once; a second record of the same event id changes nothing. */
  recordReplyEvent(reply: ReplyEvent): Promise<void>;
  updateReplyEvent(eventId: StoredReplyId, change: Partial<Pick<ReplyEvent, "state" | "waitedMs" | "lastCountedWall">>): Promise<void>;
  /** Reply events not yet resolved: pending and unmatched. */
  openReplyEvents(): Promise<ReplyEvent[]>;
  /** Reply events pending correlation. */
  pendingReplies(): Promise<ReplyEvent[]>;

  /** `now`: when the listing was read, the instant a LinkedIn session's InMail report is stored with (ADR 0004 13.5). */
  upsertAccounts(accounts: readonly SenderAccountConfig[], now?: number): Promise<void>;
  /** Marks unhealthy every account of `channel` its port no longer reports: it is disconnected. */
  disconnectUnlisted(channel: "email" | "sms" | "linkedin", listed: readonly string[]): Promise<void>;
  /** Every SMS conversation binding of a mobile (E.164), from any number, oldest first (ADR 0003 4.5). */
  smsBindingsOf(recipient: string): Promise<SmsBindingRecord[]>;
  /**
   * The conversations' versions, per destination (ADR 0004, "The conversations' version"): for each mobile or profile any
   * pair has ever touched, a counter the database moves by trigger, in the same write, whenever a fact that pair's ownership
   * or knownness is read from is written. A cache remembers the versions of its own destinations only.
   */
  conversationVersions(): Promise<ReadonlyMap<string, number>>;
  accounts(now: number): Promise<AccountState[]>;
  accountLabels(): Promise<Record<string, string>>;
  /** Moves the account's next pacing slot to at least `callStart` plus its gap. */
  pushSlot(accountId: string, callStart: number): Promise<void>;
  updateAccount(accountId: string, change: Partial<Pick<AccountState, "healthy" | "waitUntil" | "waitReason" | "backoffMs">>): Promise<void>;

  /** Records a bounce once; a second record of the same event id changes nothing. */
  recordBounce(bounce: BounceEvent): Promise<void>;
  /** A subject's recorded bounces, oldest first. */
  bouncesOf(subjectId: string): Promise<BounceEvent[]>;

  meta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  /** Writes several meta values in one transaction: the interruption notice and the heartbeat together (ADR 0003 "Ticket 20a"). */
  setMetas(values: Readonly<Record<string, string>>): Promise<void>;
  /**
   * Takes or renews the worker's lease on this database in one BEGIN IMMEDIATE transaction (ticket 20a): refused, with
   * the holder, when another owner holds it, renewed it within `staleMs` and `alive` says its process runs.
   */
  takeLease(owner: WorkerLease, now: number, staleMs: number, alive: (pid: number) => boolean): Promise<{ readonly ok: true } | { readonly ok: false; readonly holder: WorkerLease }>;
  /** Whether this owner holds the lease at `now` (synchronous: read inside the authorizing transaction and before each call). */
  holdsLease(ownerId: string, now: number, staleMs: number): boolean;
  /** Releases the lease if this owner holds it. */
  releaseLease(ownerId: string): Promise<void>;
  recordAnomaly(attemptId: string | null, what: string, atWall: number): Promise<void>;
  anomalies(): Promise<{ attemptId: string | null; what: string; atWall: number }[]>;
  /** Enrollments that ended for `reason`, most recently ended first (ticket 20a: Needs attention's no-usable-channel list). */
  endedSubjectIds(reason: import("../../domain/sequence/state.ts").EndReason): Promise<string[]>;
  /** Subject ids of a campaign, launched or not, oldest enrollment first. */
  subjectsOf(campaignId: string): Promise<string[]>;

  callSettings(): Promise<CallSettings>;
  /** The user's call list on the user day of `now`: capacity, tasks placed today and committed tasks (ADR 0003 4.4). */
  callDay(now: number): Promise<import("../../domain/sequence/state.ts").CallDay>;
  /** Who a subject is: its person (null for a company lead), company and campaign. */
  subjectParties(subjectId: string): Promise<{ readonly personId: string | null; readonly companyId: string; readonly campaignId: string } | null>;
  /**
   * Writes the call settings. With `catchUp`, every lead with an open call task is first brought up to `now`
   * under the old settings, in the same transaction (council on 228cd3b).
   */
  setCallSettings(settings: CallSettings, catchUp?: { readonly now: number; readonly asOf: (state: SubjectState) => SubjectState }): Promise<void>;
  /** Brings every lead with an open call task up to `now`, inside the caller's transaction. */
  catchUpWithin(now: number, asOf: (state: SubjectState) => SubjectState): void;
  /** The task a request id was logged on, whichever subject's it is, or null. */
  callRequestTask(requestId: string): Promise<string | null>;
  /** The subject a call task belongs to, or null for an unknown task. */
  callTaskSubject(taskId: string): Promise<string | null>;
  /** Subjects with an open call task, whatever their state: the call list is built from them. */
  subjectsWithOpenCallTasks(): Promise<string[]>;
  /**
   * The instants open callbacks of leads that have not ended change on the user's list (ticket 15): the
   * start of each callback's user day, when it is listed, and its time, when it is ready.
   */
  openCallbackInstants(): Promise<number[]>;
  /** Notes on a person or a company, newest first. */
  notesOf(owner: "person" | "company", ownerId: string): Promise<StoredNote[]>;
  /**
   * A note typed on a record (ticket 18), stored under its request id: the same id with the same owner and body is
   * `same` and stores nothing; with another owner or body it is `different` and stores nothing.
   */
  addNote(note: { readonly id: string; readonly owner: "person" | "company"; readonly ownerId: string; readonly body: string; readonly atWall: number }): Promise<"added" | "same" | "different">;
  /** The latest call made with a note on each of these subjects; a skip for now is not a call. */
  lastCallNotes(subjectIds: readonly string[]): Promise<CallNoteRecord[]>;
}

/**
 * What the campaign measures read (ticket 22): the facts Activity reads for the same entries. `enrollments` are the campaign's
 * leads (the lead groups); every other row is of the campaign's subjects of both kinds, enrollments and test runs, marked
 * `test` for a test run's (the principal's decision of 15 November 2026).
 */
export interface MeasureFacts {
  readonly launched: boolean;
  /** The campaign row's launch and pause, in the same snapshot, so a screen's pause and figures are of one instant. */
  readonly launchedAt: number | null;
  readonly pausedSince: number | null;
  /** The campaign's handed-over work that may still be sent (`uncertainWorkOf`), in the same snapshot. */
  readonly mayStillSend: number;
  readonly definition: CampaignDefinition;
  /** Each enrollment: its stored status, whether its outreach has ended, its stopping reply's channel, and its person. */
  readonly enrollments: readonly { readonly id: string; readonly status: string; readonly ended: string | null; readonly stopReplyChannel: string | null; readonly personId: string | null }[];
  /** Each reply stored for a subject, oldest first (by its provider time, then the order stored). */
  readonly replies: readonly { readonly subjectId: string; readonly test: boolean; readonly channel: string; readonly atWall: number }[];
  /**
   * Each attempt handed to a provider, with its state, its work's provider send time, and its channel: its sender account's,
   * a fact of the send that no edit of the definition changes (review bot on b8a8361). The same for failures and bounces.
   */
  readonly attempts: readonly { readonly subjectId: string; readonly test: boolean; readonly channel: string; readonly trackId: string; readonly stepId: string; readonly state: string; readonly sentWall: number | null; readonly action?: string | null }[];
  /** Each LinkedIn track an acceptance was recorded on, whenever it was observed (ADR 0004 section 8). */
  readonly acceptances?: readonly { readonly subjectId: string; readonly test: boolean; readonly trackId: string }[];
  /** Each step result `failed`. */
  readonly failures: readonly { readonly subjectId: string; readonly test: boolean; readonly channel: string; readonly trackId: string; readonly stepId: string }[];
  /** Each bounce event. */
  readonly bounces: readonly { readonly subjectId: string; readonly test: boolean; readonly channel: string; readonly trackId: string; readonly stepId: string }[];
  /** Each call outcome logged. */
  readonly calls: readonly { readonly subjectId: string; readonly test: boolean; readonly outcome: string }[];
  /** Each open callback task, with whether its subject's outreach has ended. */
  readonly openCallbacks: readonly { readonly subjectId: string; readonly test: boolean; readonly ended: string | null; readonly open: boolean; readonly kind: "call" | "callback" }[];
}

