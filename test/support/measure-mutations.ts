import { STATUS_GROUPS, statusGroup, isOutreachStatus, type StatusGroup } from "../../src/domain/outreach-status.ts";
import { MEASURE_RULES, tally, type MeasureRules } from "../../src/server/measures.ts";
import type { MeasureInvariant } from "./generated-measures.ts";

/**
 * Deliberately broken measures (ADR 0003 "Ticket 22", the mutations): each replaces one measure's function; the generated
 * measure runs (generated-measures.ts) must fail the invariant it names, on its recorded seed in `pnpm check`.
 */
export const MEASURE_MUTATIONS: Readonly<Record<string, { invariant: MeasureInvariant; seed: number; rules: Partial<MeasureRules> }>> = {
  "a callback scheduled counted as handed to you": {
    invariant: "M1",
    seed: 49,
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
    seed: 13,
    rules: { sent: (facts, channel) => tally(facts.attempts.filter((a) => a.channel === channel), (a) => `${a.subjectId}/${a.stepId}/${a.state}`) },
  },
  // Council on 384630e (item 3): a track removed from a running campaign after it sent; its messages still count.
  "a removed track's messages no longer counted": {
    invariant: "M2",
    seed: 13,
    rules: { sent: (facts, channel) => MEASURE_RULES.sent({ ...facts, attempts: facts.attempts.filter((a) => facts.definition.tracks.some((t) => t.id === a.trackId && !t.removed)) }, channel) },
  },
  // Review bot on b8a8361: messages counted through the definition's tracks, as built before, so a test's messages on a track a
  // draft deleted outright are lost.
  "messages counted through the definition's tracks, so a deleted track's are lost": {
    invariant: "M2",
    seed: 13,
    rules: { sent: (facts, channel) => MEASURE_RULES.sent({ ...facts, attempts: facts.attempts.filter((a) => facts.definition.tracks.some((t) => t.id === a.trackId)) }, channel) },
  },
  "bounces not counted, only refusals": {
    invariant: "M3",
    seed: 13,
    rules: { failedOrBounced: (facts, channel) => MEASURE_RULES.failedOrBounced({ ...facts, bounces: [] }, channel) },
  },
  "a reply counted on every channel, not on the lead's first reply's": {
    invariant: "M4",
    seed: 13,
    rules: { replies: (facts) => ({ ...MEASURE_RULES.replies(facts, "email"), all: MEASURE_RULES.replies(facts, "email").all + MEASURE_RULES.replies(facts, "sms").all }) },
  },
  // Council on 384630e, item 2: the figure as first built, from the current status, which goes down when a replied lead is
  // resumed or moved to win-back.
  "replies counted from the current status, so they can go down": {
    invariant: "M4",
    seed: 13,
    rules: { replies: (facts, channel) => ({ all: facts.enrollments.filter((e) => e.status === "replied" && e.stopReplyChannel === channel).length, test: 0 }) },
  },
  // Council on 384630e (item 3): one person in two campaigns, whose reply in one is counted in the other too.
  "a person's reply counted in every campaign they are in": {
    invariant: "M4",
    seed: 13,
    rules: {
      facts: async (store, campaignId) => {
        const mine = await store.measureFacts(campaignId);
        const every = await store.measureFacts(campaignId, { everyCampaign: true });
        if (!mine || !every) return mine;
        const personOf = new Map(every.enrollments.map((e) => [e.id, e.personId]));
        const here = new Map(mine.enrollments.filter((e) => e.personId !== null).map((e) => [e.personId, e.id]));
        const elsewhere = every.replies.flatMap((r) => {
          const id = here.get(personOf.get(r.subjectId) ?? null);
          return id !== undefined && id !== r.subjectId ? [{ ...r, subjectId: id }] : [];
        });
        return { ...mine, replies: [...mine.replies, ...elsewhere].sort((x, y) => x.atWall - y.atWall) };
      },
    },
  },
  "skip for now counted as a call made": { invariant: "M5", seed: 13, rules: { callsMade: (facts) => ({ all: facts.calls.length, test: facts.calls.filter((c) => c.test).length }) } },
  "a gatekeeper counted as connected": {
    invariant: "M5",
    seed: 13,
    rules: { callsConnected: (facts) => ({ ...MEASURE_RULES.callsConnected(facts), all: MEASURE_RULES.callsConnected(facts).all + facts.calls.filter((c) => c.outcome === "gatekeeper").length }) },
  },
  "an ended lead's open callback counted as pending": { invariant: "M6", seed: 49, rules: { callbacksPending: (facts) => tally(facts.openCallbacks, (c) => c.subjectId) } },
  "the reply rate taken over every lead": {
    invariant: "M7",
    seed: 13,
    rules: { replyRate: (facts) => ({ ...MEASURE_RULES.replyRate(facts), denominator: facts.enrollments.length, percent: facts.enrollments.length === 0 ? null : Math.round((100 * MEASURE_RULES.replyRate(facts).numerator) / facts.enrollments.length) }) },
  },
  "the facts read for every campaign": { invariant: "M8", seed: 13, rules: { facts: (store, campaignId) => store.measureFacts(campaignId, { everyCampaign: true }) } },
  // The principal's decision of 15 November 2026: test runs are counted. This drops their sends.
  "test sends dropped": {
    invariant: "M8",
    seed: 13,
    rules: { facts: async (store, campaignId) => {
      const facts = await store.measureFacts(campaignId);
      return facts && { ...facts, attempts: facts.attempts.filter((a) => !a.test) };
    } },
  },
};
