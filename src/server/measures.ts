import { isOutreachStatus, STATUS_GROUPS, statusGroup, type OutreachStatus, type StatusGroup } from "../domain/outreach-status.ts";
import type { TrackChannel } from "../domain/sequence/definition.ts";
import { CALL_OUTCOMES, callbackPending } from "../domain/sequence/calls.ts";
import type { CallOutcome } from "../domain/sequence/state.ts";
import type { CampaignMeasures, MeasureRate } from "../shared/api.ts";
import type { EngineStore, MeasureFacts } from "./engine/engine-store.ts";

/**
 * The campaign measures (ticket 22; ADR 0003 "Ticket 22"). Every figure is a tally of the facts `measureFacts` read in one
 * snapshot through the campaign's enrollments, by one function per measure below. Nothing is estimated, projected or
 * compared with a target. Each mapping is exhaustive: a channel, call outcome or status a later ticket adds fails
 * typecheck until it is placed. `MeasureRules` is the seam the generated measure runs' mutations replace, one part each.
 */

type MessageChannel = "email" | "sms";

/**
 * A message's channel: the stored channel of the sender account that sent it (`sender_accounts.channel`, which the schema
 * checks is email or SMS), never the definition's tracks: a draft may delete a track outright after a test sent on it, and a
 * measure counts what was recorded (review bot on b8a8361). Exhaustive over the stored values.
 */
function messageChannel(stored: string): MessageChannel | null {
  switch (stored) {
    case "email":
    case "sms":
      return stored;
    default:
      return null;
  }
}
const on = (row: { readonly channel: string }, wanted: MessageChannel) => messageChannel(row.channel) === wanted;

/** What one logged call outcome counts as (exhaustive over `CallOutcome`). Skip for now is not a call made. */
export function callCounts(outcome: CallOutcome): { readonly made: boolean; readonly connected: boolean; readonly interested: boolean; readonly declined: boolean } {
  switch (outcome) {
    case "skip_for_now":
      return { made: false, connected: false, interested: false, declined: false };
    case "no_answer":
    case "voicemail":
    case "gatekeeper":
    case "wrong_number":
      return { made: true, connected: false, interested: false, declined: false };
    case "callback_requested":
      return { made: true, connected: true, interested: false, declined: false };
    case "interested":
      return { made: true, connected: true, interested: true, declined: false };
    case "not_interested":
      return { made: true, connected: true, interested: false, declined: true };
    default: {
      const never: never = outcome;
      return never;
    }
  }
}

const outcomeOf = (value: string): CallOutcome | null => CALL_OUTCOMES.find((o) => o === value) ?? null;
const statusOf = (value: string): OutreachStatus | null => (isOutreachStatus(value) ? value : null);
const channelOfReply = (value: string | null): MessageChannel | null => (value === "email" || value === "sms" ? value : null);

/**
 * A figure and its test share, from one pass over the same rows (the principal's decision of 15 November 2026: test runs
 * counted, marked as test): `all` counts leads' and test runs' rows, `test` the test runs' among them.
 */
export interface Tally {
  readonly all: number;
  readonly test: number;
}
/** Tallies the distinct keys of `rows`, each marked test or not: the one counting every measure uses. */
export function tally<T extends { readonly test: boolean }>(rows: readonly T[], key: (row: T) => string): Tally {
  const all = new Map<string, boolean>();
  for (const r of rows) if (!all.has(key(r))) all.set(key(r), r.test);
  return { all: all.size, test: [...all.values()].filter(Boolean).length };
}
const each = (rows: readonly { readonly test: boolean }[]): Tally => ({ all: rows.length, test: rows.filter((r) => r.test).length });

const tallyCalls = (facts: MeasureFacts, part: keyof ReturnType<typeof callCounts>): Tally =>
  each(
    facts.calls.filter((c) => {
      const outcome = outcomeOf(c.outcome);
      return outcome !== null && callCounts(outcome)[part];
    }),
  );

/**
 * The subjects (leads, and test runs) that ever replied in the campaign, each once, by the channel of its first stored reply
 * (council on 384630e, item 2): a figure that never goes down when a replied lead is resumed or moved to win-back. Every
 * reply is stored on its subject whatever its status (`applyReply`), so a lead ended interested that later replied counts too.
 */
function firstReplies(facts: MeasureFacts): Map<string, { channel: MessageChannel; test: boolean }> {
  const first = new Map<string, { channel: MessageChannel; test: boolean }>();
  for (const r of facts.replies) {
    const channel = channelOfReply(r.channel);
    if (channel !== null && !first.has(r.subjectId)) first.set(r.subjectId, { channel, test: r.test });
  }
  return first;
}
const repliedSubjects = (facts: MeasureFacts, channel: MessageChannel | null) =>
  [...firstReplies(facts)].filter(([, r]) => channel === null || r.channel === channel).map(([subjectId, r]) => ({ subjectId, test: r.test }));

/** The messages the provider reported sent: an attempt in state `sent`, with its provider send time (Activity's "sent"). */
const sentAttempts = (facts: MeasureFacts) => facts.attempts.filter((a) => a.state === "sent" && a.sentWall !== null);

const percentOf = (numerator: number, denominator: number) => (denominator === 0 ? null : Math.round((100 * numerator) / denominator));
/** A rate of two tallies: both counts include test runs, and `fromTests` says how many of each are theirs. */
export const rate = (numerator: Tally, denominator: Tally): MeasureRate => ({
  numerator: numerator.all,
  denominator: denominator.all,
  percent: percentOf(numerator.all, denominator.all),
  fromTests: { numerator: numerator.test, denominator: denominator.test },
});

export interface MeasureRules {
  /** The facts, for the campaign: the store's one snapshot. */
  facts(store: EngineStore, campaignId: string): Promise<MeasureFacts | null>;
  /** Leads in each status group, by the one grouping function (ticket 18). Leads only: a test run is not a lead. */
  groups(facts: MeasureFacts): Record<StatusGroup, number>;
  sent(facts: MeasureFacts, channel: MessageChannel): Tally;
  failedOrBounced(facts: MeasureFacts, channel: MessageChannel): Tally;
  replies(facts: MeasureFacts, channel: MessageChannel): Tally;
  callsMade(facts: MeasureFacts): Tally;
  callsConnected(facts: MeasureFacts): Tally;
  callsInterested(facts: MeasureFacts): Tally;
  callsDeclined(facts: MeasureFacts): Tally;
  callbacksPending(facts: MeasureFacts): Tally;
  replyRate(facts: MeasureFacts): MeasureRate;
  /** Calls connected out of calls made, per call. */
  connectRate(connected: Tally, made: Tally): MeasureRate;
}

export const MEASURE_RULES: MeasureRules = {
  facts: (store, campaignId) => store.measureFacts(campaignId),

  groups(facts) {
    const counts = Object.fromEntries(STATUS_GROUPS.map((g) => [g, 0])) as Record<StatusGroup, number>;
    for (const e of facts.enrollments) {
      const status = statusOf(e.status);
      if (status !== null) counts[statusGroup(status)] += 1;
    }
    return counts;
  },

  sent: (facts, channel) => each(sentAttempts(facts).filter((a) => on(a, channel))),

  /** Refused (a `failed` step result) or bounced after it was sent (a bounce event): each message once. */
  failedOrBounced: (facts, channel) =>
    tally(
      [...facts.failures, ...facts.bounces].filter((m) => on(m, channel)),
      (m) => `${m.subjectId}\u0000${m.stepId}`,
    ),

  replies: (facts, channel) => each(repliedSubjects(facts, channel)),

  callsMade: (facts) => tallyCalls(facts, "made"),
  callsConnected: (facts) => tallyCalls(facts, "connected"),
  callsInterested: (facts) => tallyCalls(facts, "interested"),
  callsDeclined: (facts) => tallyCalls(facts, "declined"),

  /** Callbacks pending, by the engine's own `callbackPending`: open callback tasks of subjects whose outreach has not ended. */
  callbacksPending: (facts) =>
    tally(
      facts.openCallbacks.filter((c) => callbackPending(c, c.ended)),
      (c) => c.subjectId,
    ),

  /** The subjects that replied, out of the subjects reached by email or SMS (a message sent, or a reply). */
  replyRate(facts) {
    const replied = repliedSubjects(facts, null);
    const reached = [...replied, ...sentAttempts(facts).filter((a) => messageChannel(a.channel) !== null)];
    return rate(each(replied), tally(reached, (r) => r.subjectId));
  },

  connectRate: (connected, made) => rate(connected, made),
};

/**
 * The channels the screen names, in its order: those the campaign has tracks on (removed ones included), and any channel with
 * recorded activity, so a figure whose track a draft deleted is still shown (review bot on b8a8361).
 */
function channelsOf(facts: MeasureFacts): CampaignMeasures["channels"] {
  const order: readonly TrackChannel[] = ["email", "sms", "call"];
  const recorded = new Set<TrackChannel>([...facts.attempts, ...facts.failures, ...facts.bounces, ...facts.replies].flatMap((r) => messageChannel(r.channel) ?? []));
  if (facts.calls.length > 0) recorded.add("call");
  return order.filter((c) => recorded.has(c) || facts.definition.tracks.some((t) => t.channel === c));
}

/** Every measure from one snapshot of facts: each figure, and how many of it came from test runs, from the same function. */
export function measuresOf(facts: MeasureFacts, overrides: Partial<MeasureRules> = {}): CampaignMeasures {
  const rules: MeasureRules = { ...MEASURE_RULES, ...overrides };
  const messages = (channel: MessageChannel) => {
    const sent = rules.sent(facts, channel);
    const failedOrBounced = rules.failedOrBounced(facts, channel);
    const replies = rules.replies(facts, channel);
    return { sent: sent.all, failedOrBounced: failedOrBounced.all, replies: replies.all, fromTests: { sent: sent.test, failedOrBounced: failedOrBounced.test, replies: replies.test } };
  };
  const made = rules.callsMade(facts);
  const connected = rules.callsConnected(facts);
  const interested = rules.callsInterested(facts);
  const declined = rules.callsDeclined(facts);
  const pending = rules.callbacksPending(facts);
  return {
    launched: facts.launched,
    leads: facts.enrollments.length,
    groups: rules.groups(facts),
    channels: channelsOf(facts),
    email: messages("email"),
    sms: messages("sms"),
    calls: {
      made: made.all,
      connected: connected.all,
      interested: interested.all,
      declined: declined.all,
      callbacksPending: pending.all,
      fromTests: { made: made.test, connected: connected.test, interested: interested.test, declined: declined.test, callbacksPending: pending.test },
    },
    replyRate: rules.replyRate(facts),
    connectRate: rules.connectRate(connected, made),
  };
}

/** The read: the store's one snapshot of facts, then every measure from it. Null for a campaign that does not exist. */
export async function campaignMeasures(store: EngineStore, campaignId: string, overrides: Partial<MeasureRules> = {}): Promise<CampaignMeasures | null> {
  const facts = await (overrides.facts ?? MEASURE_RULES.facts)(store, campaignId);
  return facts ? measuresOf(facts, overrides) : null;
}
