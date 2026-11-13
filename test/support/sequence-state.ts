import type { CampaignDefinition, StepDefinition } from "../../src/domain/sequence/definition.ts";
import type { AccountState, Attempt, SubjectState } from "../../src/domain/sequence/state.ts";

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
    freezes: [{ fromWall: created, toWall: null }],
    replies: [],
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
    providerRef: null,
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
    lookupAnswer: null,
    queuedLookups: 0,
    nextLookupWall: null,
    unresolvedSince: null,
    endedBy: null,
    withdrawRequested: false,
    withdrawCalled: false,
    awaitingAnswer: false,
    retry: "none",
    rejectReason: null,
    sentWall: null,
    sentDay: null,
    userMarkedNotSent: false,
    holdsReservation: true,
    ...fields,
  };
}

export const handed = (fields: Partial<Attempt> = {}): Attempt =>
  attempt({ state: "handed", calls: 1, handedAt: 0, handedWall: MONDAY_9, lastCallWall: MONDAY_9, awaitingAnswer: true, copy: { subject: "Hello Pat", body: "A note." }, ...fields });
