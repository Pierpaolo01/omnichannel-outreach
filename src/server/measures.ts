import { isOutreachStatus, STATUS_GROUPS, statusGroup, type OutreachStatus, type StatusGroup } from "../domain/outreach-status.ts";
import type { CampaignDefinition, TrackChannel } from "../domain/sequence/definition.ts";
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

/** Where a track's work counts: its channel, from the definition, which keeps a removed track's channel (1.1). */
function channelOfTrack(definition: CampaignDefinition, trackId: string): TrackChannel | null {
  return definition.tracks.find((t) => t.id === trackId)?.channel ?? null;
}

/** Whether a track's channel carries messages of `channel` (exhaustive over the track channels). */
function carries(channel: TrackChannel | null, wanted: MessageChannel): boolean {
  switch (channel) {
    case "email":
    case "sms":
      return channel === wanted;
    case "call":
    case null:
      return false;
    default: {
      const never: never = channel;
      return never;
    }
  }
}

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

const tallyCalls = (facts: MeasureFacts, part: keyof ReturnType<typeof callCounts>) =>
  facts.calls.filter((c) => {
    const outcome = outcomeOf(c.outcome);
    return outcome !== null && callCounts(outcome)[part];
  }).length;

/**
 * The leads that ever replied in the campaign, each once, by the channel of its first stored reply (council on 384630e,
 * item 2): a figure that never goes down when a replied lead is resumed or moved to win-back. Every reply is stored on
 * the lead whatever its status (`applyReply`), so a lead ended interested that later replied counts too.
 */
function firstReplies(facts: MeasureFacts): Map<string, MessageChannel> {
  const first = new Map<string, MessageChannel>();
  for (const r of facts.replies) {
    const channel = channelOfReply(r.channel);
    if (channel !== null && !first.has(r.subjectId)) first.set(r.subjectId, channel);
  }
  return first;
}
const repliedLeads = (facts: MeasureFacts, channel: MessageChannel | null) => [...firstReplies(facts)].filter(([, c]) => channel === null || c === channel).map(([id]) => ({ id }));

/** The messages the provider reported sent: an attempt in state `sent`, with its provider send time (Activity's "sent"). */
const sentAttempts = (facts: MeasureFacts) => facts.attempts.filter((a) => a.state === "sent" && a.sentWall !== null);

export const rate = (numerator: number, denominator: number): MeasureRate => ({ numerator, denominator, percent: denominator === 0 ? null : Math.round((100 * numerator) / denominator) });

export interface MeasureRules {
  /** The facts, for the campaign: the store's one snapshot. */
  facts(store: EngineStore, campaignId: string): Promise<MeasureFacts | null>;
  /** Leads in each status group, by the one grouping function (ticket 18). */
  groups(facts: MeasureFacts): Record<StatusGroup, number>;
  sent(facts: MeasureFacts, channel: MessageChannel): number;
  failedOrBounced(facts: MeasureFacts, channel: MessageChannel): number;
  replies(facts: MeasureFacts, channel: MessageChannel): number;
  callsMade(facts: MeasureFacts): number;
  callsConnected(facts: MeasureFacts): number;
  callsInterested(facts: MeasureFacts): number;
  callsDeclined(facts: MeasureFacts): number;
  callbacksPending(facts: MeasureFacts): number;
  replyRate(facts: MeasureFacts): MeasureRate;
  /** Calls connected out of calls made, per call. */
  connectRate(connected: number, made: number): MeasureRate;
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

  sent: (facts, channel) => sentAttempts(facts).filter((a) => carries(channelOfTrack(facts.definition, a.trackId), channel)).length,

  /** Refused (a `failed` step result) or bounced after it was sent (a bounce event): each message once. */
  failedOrBounced(facts, channel) {
    const messages = new Set<string>();
    for (const m of [...facts.failures, ...facts.bounces]) if (carries(channelOfTrack(facts.definition, m.trackId), channel)) messages.add(`${m.subjectId}\u0000${m.stepId}`);
    return messages.size;
  },

  replies: (facts, channel) => repliedLeads(facts, channel).length,

  callsMade: (facts) => tallyCalls(facts, "made"),
  callsConnected: (facts) => tallyCalls(facts, "connected"),
  callsInterested: (facts) => tallyCalls(facts, "interested"),
  callsDeclined: (facts) => tallyCalls(facts, "declined"),

  /** Callbacks pending, by the engine's own `callbackPending`: open callback tasks of leads whose outreach has not ended. */
  callbacksPending(facts) {
    const ended = new Map(facts.enrollments.map((e) => [e.id, e.ended]));
    return new Set(facts.openCallbacks.filter((c) => ended.has(c.subjectId) && callbackPending(c, ended.get(c.subjectId) ?? null)).map((c) => c.subjectId)).size;
  },

  /** The leads that replied, out of the leads reached by email or SMS (a message sent, or a reply). */
  replyRate(facts) {
    const replied = new Set(repliedLeads(facts, null).map((e) => e.id));
    const reached = new Set(replied);
    for (const a of sentAttempts(facts)) {
      const channel = channelOfTrack(facts.definition, a.trackId);
      if (carries(channel, "email") || carries(channel, "sms")) reached.add(a.subjectId);
    }
    return rate(replied.size, reached.size);
  },

  connectRate: (connected, made) => rate(connected, made),
};

/** The channels the campaign has tracks on, removed ones included (their activity stays), in the order the screen names them. */
function channelsOf(definition: CampaignDefinition): CampaignMeasures["channels"] {
  const order: readonly TrackChannel[] = ["email", "sms", "call"];
  return order.filter((c) => definition.tracks.some((t) => t.channel === c));
}

/** Every measure from one snapshot of facts. */
export function measuresOf(facts: MeasureFacts, overrides: Partial<MeasureRules> = {}): CampaignMeasures {
  const rules: MeasureRules = { ...MEASURE_RULES, ...overrides };
  const messages = (channel: MessageChannel) => ({ sent: rules.sent(facts, channel), failedOrBounced: rules.failedOrBounced(facts, channel), replies: rules.replies(facts, channel) });
  const made = rules.callsMade(facts);
  const connected = rules.callsConnected(facts);
  return {
    launched: facts.launched,
    leads: facts.enrollments.length,
    groups: rules.groups(facts),
    channels: channelsOf(facts.definition),
    email: messages("email"),
    sms: messages("sms"),
    calls: { made, connected, interested: rules.callsInterested(facts), declined: rules.callsDeclined(facts), callbacksPending: rules.callbacksPending(facts) },
    replyRate: rules.replyRate(facts),
    connectRate: rules.connectRate(connected, made),
  };
}

/** The read: the store's one snapshot of facts, then every measure from it. Null for a campaign that does not exist. */
export async function campaignMeasures(store: EngineStore, campaignId: string, overrides: Partial<MeasureRules> = {}): Promise<CampaignMeasures | null> {
  const facts = await (overrides.facts ?? MEASURE_RULES.facts)(store, campaignId);
  return facts ? measuresOf(facts, overrides) : null;
}
