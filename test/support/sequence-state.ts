import type { CampaignDefinition, StepDefinition } from "../../src/domain/sequence/definition.ts";
import type { AccountState, Attempt, ProviderWork, SubjectState } from "../../src/domain/sequence/state.ts";

/** Builders for example tests of the pure sequence modules. Data is fictitious. */

export const H = 3_600_000;
export const DAY = 24 * H;
/** Monday 2 November 2026, 09:00 London (GMT). */
export const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");

export const step = (id: string, fields: Partial<StepDefinition> = {}): StepDefinition => ({
  id,
  waitDays: 0,
  subject: "Hello {{first_name|there}}",
  body: "A note for {{company}}.",
  threading: "continue_thread",
  removed: false,
  ...fields,
});

export function definition(steps: StepDefinition[] = [step("s1", { threading: "new_subject" }), step("s2", { waitDays: 2 }), step("s3", { waitDays: 3 })]): CampaignDefinition {
  return {
    timezone: "Europe/London",
    callSkipLimitDays: 2,
    emailPool: ["inbox-a", "inbox-b"],
    tracks: [
      {
        id: "t1",
        channel: "email",
        branch: "main",
        // Every day, all day, unless a test narrows it.
        window: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 })),
        steps,
        start: { kind: "entry" },
        removed: false,
      },
    ],
  };
}

export function account(id: string, fields: Partial<AccountState> = {}): AccountState {
  return { id, channel: "email", capacity: 30, gapMs: 120_000, k: 1, nextSlotAt: 0, healthy: true, waitUntil: null, waitReason: null, backoffMs: 0, resetZone: "UTC", used: 0, inFlight: 0, ...fields };
}

/** An enrolled lead with one good email, enrolled before launch at Monday 08:00. */
export function subjectState(fields: Partial<SubjectState> = {}): SubjectState {
  const created = MONDAY_9 - H;
  return {
    subject: {
      id: "lead-1",
      campaignId: "camp-1",
      version: 0,
      status: "queued",
      ended: null,
      endedAt: null,
      endedWall: null,
      leadPaused: false,
      branch: "main",
      branchEnteredAt: null,
      touched: false,
      noMoreCalls: false,
      clock: { frozenSince: created, frozenTotal: created },
      emailSender: null,
    },
    campaign: { id: "camp-1", launchedAt: null, pausedSince: null, version: 0, definitionVersion: 1, definition: definition() },
    tracks: [],
    results: [],
    attempts: [],
    work: [],
    freezes: [{ fromWall: created, toWall: null }],
    replies: [],
    pendingReplies: [],
    lead: {
      zone: "Europe/London",
      details: [{ id: "d-email", channel: "email", ownEmail: true, value: "pat@harbour.example", bad: false, order: 1 }],
      resolved: { "d-email": { liveId: "d-email", bad: false, owned: true } },
      mergeData: { first_name: "Pat", company: "Harbour Lane Physio" },
    },
    markBad: [],
    accounts: { "inbox-a": account("inbox-a"), "inbox-b": account("inbox-b") },
    ...fields,
  };
}

export function attempt(fields: Partial<Attempt> = {}): Attempt {
  return {
    id: "a-1",
    subjectId: "lead-1",
    trackId: "t1",
    stepId: "s1",
    accountId: "inbox-a",
    destinationDetailId: "d-email",
    destination: "pat@harbour.example",
    state: "claimed",
    copy: null,
    threading: "new_subject",
    threadRef: null,
    retryable: true,
    notSentIsFinal: false,
    idempotencyKey: "a-1",
    calls: 0,
    claimedWall: MONDAY_9,
    handedAt: null,
    handedWall: null,
    lastCallWall: null,
    presendCheckedWall: null,
    presendFoundReply: false,
    endedBy: null,
    withdrawRequested: false,
    withdrawCalled: false,
    awaitingAnswer: false,
    retry: "none",
    rejectReason: null,
    ...fields,
  };
}

/** The provider work of a claimed attempt, not yet called. */
export function work(fields: Partial<ProviderWork> = {}): ProviderWork {
  return {
    key: "a-1",
    subjectId: "lead-1",
    trackId: "t1",
    stepId: "s1",
    accountId: "inbox-a",
    destination: "pat@harbour.example",
    calls: 0,
    firstHandedWall: null,
    providerRef: null,
    settled: null,
    sentWall: null,
    sentDay: null,
    nextLookupWall: null,
    lookupAnswer: null,
    queuedLookups: 0,
    unresolvedSince: null,
    ...fields,
  };
}

/** The work of a handed attempt: called once at Monday 09:00. */
export const calledWork = (fields: Partial<ProviderWork> = {}): ProviderWork => work({ calls: 1, firstHandedWall: MONDAY_9, ...fields });

/** A subject state with these attempts and their work (one default work per key not given). */
export function withAttempts(state: SubjectState, attempts: readonly Attempt[], works: readonly ProviderWork[] = []): SubjectState {
  const keys = [...new Set(attempts.map((a) => a.idempotencyKey))];
  const all = keys.map((key) => {
    const given = works.find((w) => w.key === key);
    if (given) return given;
    const first = attempts.find((a) => a.idempotencyKey === key)!;
    const called = attempts.filter((a) => a.idempotencyKey === key).reduce((n, a) => n + a.calls, 0);
    return work({ key, subjectId: first.subjectId, trackId: first.trackId, stepId: first.stepId, accountId: first.accountId, destination: first.destination, calls: called, firstHandedWall: called > 0 ? (first.handedWall ?? MONDAY_9) : null });
  });
  return { ...state, attempts, work: [...all, ...works.filter((w) => !keys.includes(w.key))] };
}

export const handed = (fields: Partial<Attempt> = {}): Attempt =>
  attempt({ state: "handed", calls: 1, handedAt: 0, handedWall: MONDAY_9, lastCallWall: MONDAY_9, awaitingAnswer: true, copy: { subject: "Hello Pat", body: "A note." }, ...fields });
