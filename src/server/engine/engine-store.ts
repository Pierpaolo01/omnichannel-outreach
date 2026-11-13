import type { LaunchCheck, SenderAccountView } from "../../domain/sequence/blockers.ts";
import type { MergeData } from "../../domain/sequence/copy.ts";
import type { CampaignDefinition } from "../../domain/sequence/definition.ts";
import type { AccountState, Attempt, ProviderWork, SmsBindingRecord, SubjectState } from "../../domain/sequence/state.ts";

/** A sender account as the provider port reports it. */
export interface SenderAccountConfig {
  readonly id: string;
  readonly channel: "email" | "sms";
  readonly label: string;
  /** Daily capacity on the account's reset day. */
  readonly capacity: number;
  /** The pacing gap; null for ADR 0003 4.1's default from the windows the account serves. */
  readonly gapMs: number | null;
  /** In-flight bound (ADR 0002's k). */
  readonly k: number;
  readonly healthy: boolean;
  /** Why the provider says it cannot send, when not healthy, in the provider's own words (such as Instantly's "sending_off"). */
  readonly problem?: string | null;
  readonly resetZone: string;
}

export interface CampaignEngineRow {
  readonly id: string;
  readonly definition: CampaignDefinition | null;
  readonly definitionVersion: number;
  readonly definitionEditedAt: string | null;
  readonly launchedAt: number | null;
  readonly version: number;
}

/**
 * A reply event the provider reported, kept by its event id for good (ADR 0003 2.4): `pending`
 * while its thread is unknown (sends from the inbox to the address pause), `unmatched` once its
 * fallback matched nothing (kept by reference, without pausing), `resolved` once recorded on a lead.
 */
export interface ReplyEvent {
  readonly eventId: string;
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

export type LaunchOutcome = { readonly ok: true } | { readonly ok: false; readonly check: LaunchCheck | null; readonly reason: "already_launched" | "blocked" | "no_definition" };

/**
 * The sequence engine's persistence (ADR 0003 9.1). Every change to a subject goes through
 * `update`: the store loads the subject's state inside one write transaction, lets a pure
 * function decide, and writes back whatever changed, bumping the subject's version and storing
 * its derived status in the same transaction.
 */
export interface EngineStore {
  campaign(campaignId: string): Promise<CampaignEngineRow | null>;
  /** Saves a definition before launch. Editing a launched campaign arrives with ticket 19. */
  saveDefinition(campaignId: string, definition: CampaignDefinition, editedAt: string): Promise<"saved" | "launched" | "missing">;
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
  ): Promise<LaunchOutcome>;

  subject(subjectId: string, now: number): Promise<SubjectState | null>;
  /** Loads, decides and writes in one transaction. A null decision writes nothing. */
  update(subjectId: string, now: number, decide: (state: SubjectState) => SubjectState | null): Promise<SubjectState | null>;
  /**
   * `update`, committed before it returns: a send's authorization uses it so that nothing
   * asynchronous runs between the commit and the provider call (ADR 0003 5.5 step 6).
   */
  updateNow(subjectId: string, now: number, decide: (state: SubjectState) => SubjectState | null): SubjectState | null;
  /** Enrollments of launched campaigns that have not ended. */
  runningSubjectIds(): Promise<string[]>;
  /** For each running subject, a key that changes whenever its state, its campaign's, or the lead facts it reads change. */
  runningSubjectVersions(): Promise<Map<string, string>>;
  /** Every attempt that is not terminal. */
  openAttempts(): Promise<Attempt[]>;
  attempt(attemptId: string): Promise<Attempt | null>;
  /** Unsettled provider work with a lookup scheduled. */
  openWork(): Promise<ProviderWork[]>;
  work(key: string): Promise<ProviderWork | null>;
  workByProviderRef(providerRef: string): Promise<ProviderWork | null>;
  /** Provider work handed over to `address` (any case) from `inbox`: the candidates a reply outside a known thread may fall back to (2.4). */
  workReachedFrom(inbox: string, address: string): Promise<ProviderWork[]>;
  /** Unsettled provider work that is unresolved: it holds a reservation and is listed in Needs attention. */
  unresolvedWork(): Promise<ProviderWork[]>;
  /** Sends counted on the account's current reset day. */
  sentToday(accountId: string, now: number): Promise<number>;

  replyEvent(eventId: string): Promise<ReplyEvent | null>;
  /** Records a reply event once; a second record of the same event id changes nothing. */
  recordReplyEvent(reply: ReplyEvent): Promise<void>;
  updateReplyEvent(eventId: string, change: Partial<Pick<ReplyEvent, "state" | "waitedMs" | "lastCountedWall">>): Promise<void>;
  /** Reply events not yet resolved: pending and unmatched. */
  openReplyEvents(): Promise<ReplyEvent[]>;
  /** Reply events pending correlation. */
  pendingReplies(): Promise<ReplyEvent[]>;

  upsertAccounts(accounts: readonly SenderAccountConfig[]): Promise<void>;
  /** Marks unhealthy every account of `channel` its port no longer reports: it is disconnected. */
  disconnectUnlisted(channel: "email" | "sms", listed: readonly string[]): Promise<void>;
  /** Every SMS conversation binding of a mobile (E.164), from any number, oldest first (ADR 0003 4.5). */
  smsBindingsOf(recipient: string): Promise<SmsBindingRecord[]>;
  accounts(now: number): Promise<AccountState[]>;
  accountLabels(): Promise<Record<string, string>>;
  /** Moves the account's next pacing slot to at least `callStart` plus its gap. */
  pushSlot(accountId: string, callStart: number): Promise<void>;
  updateAccount(accountId: string, change: Partial<Pick<AccountState, "healthy" | "waitUntil" | "waitReason" | "backoffMs">>): Promise<void>;

  meta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  recordAnomaly(attemptId: string | null, what: string, atWall: number): Promise<void>;
  anomalies(): Promise<{ attemptId: string | null; what: string; atWall: number }[]>;
  /** Subject ids of a campaign, launched or not, oldest enrollment first. */
  subjectsOf(campaignId: string): Promise<string[]>;
}
