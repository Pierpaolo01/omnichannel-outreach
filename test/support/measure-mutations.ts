import { STATUS_GROUPS, statusGroup, isOutreachStatus, type StatusGroup } from "../../src/domain/outreach-status.ts";
import { MEASURE_RULES, rate, type MeasureRules } from "../../src/server/measures.ts";
import type { MeasureInvariant } from "./generated-measures.ts";

/**
 * Deliberately broken measures (ADR 0003 "Ticket 22", the mutations): each replaces one measure's function; the generated
 * measure runs (generated-measures.ts) must fail the invariant it names, on its recorded seed in `pnpm check`.
 */
export const MEASURE_MUTATIONS: Readonly<Record<string, { invariant: MeasureInvariant; seed: number; rules: Partial<MeasureRules> }>> = {
  "a callback scheduled counted as handed to you": {
    invariant: "M1",
    seed: 12,
    rules: {
      groups: (facts) => {
        const counts = Object.fromEntries(STATUS_GROUPS.map((g) => [g, 0])) as Record<StatusGroup, number>;
        for (const e of facts.enrollments) if (isOutreachStatus(e.status)) counts[e.status === "callback_scheduled" ? "handed_to_you" : statusGroup(e.status)] += 1;
        return counts;
      },
    },
  },
  "a message handed to the provider counted as sent before it is": {
    invariant: "M2",
    seed: 2,
    rules: { sent: (facts, channel) => facts.attempts.filter((a) => facts.definition.tracks.find((t) => t.id === a.trackId)?.channel === channel).length },
  },
  "bounces not counted, only refusals": {
    invariant: "M3",
    seed: 2,
    rules: { failedOrBounced: (facts, channel) => MEASURE_RULES.failedOrBounced({ ...facts, bounces: [] }, channel) },
  },
  "a reply counted on every channel, not on the lead's first reply's": {
    invariant: "M4",
    seed: 2,
    rules: { replies: (facts) => facts.enrollments.filter((e) => e.status === "replied" && e.stopReplyChannel !== null).length },
  },
  // Council on 384630e, item 2: the figure as first built, from the current status, which goes down when a replied lead is
  // resumed or moved to win-back.
  "replies counted from the current status, so they can go down": {
    invariant: "M4",
    seed: 4,
    rules: { replies: (facts, channel) => facts.enrollments.filter((e) => e.status === "replied" && e.stopReplyChannel === channel).length },
  },
  "skip for now counted as a call made": { invariant: "M5", seed: 2, rules: { callsMade: (facts) => facts.calls.length } },
  "a gatekeeper counted as connected": { invariant: "M5", seed: 4, rules: { callsConnected: (facts) => MEASURE_RULES.callsConnected(facts) + facts.calls.filter((c) => c.outcome === "gatekeeper").length } },
  "an ended lead's open callback counted as pending": { invariant: "M6", seed: 12, rules: { callbacksPending: (facts) => new Set(facts.openCallbacks.map((c) => c.subjectId)).size } },
  "the reply rate taken over every lead": {
    invariant: "M7",
    seed: 2,
    rules: { replyRate: (facts) => rate(MEASURE_RULES.replyRate(facts).numerator, facts.enrollments.length) },
  },
  "the facts read for every campaign": { invariant: "M8", seed: 2, rules: { facts: (store, campaignId) => store.measureFacts(campaignId, { everyCampaign: true }) } },
};
