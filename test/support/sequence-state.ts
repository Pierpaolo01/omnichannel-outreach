import type { CampaignDefinition, StartRule, StepDefinition, TrackDefinition } from "../../src/domain/sequence/definition.ts";
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

const EVERY_HOUR = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));

/** A track of the given channel, open every hour unless a test narrows it. */
export function track(id: string, channel: "email" | "sms", steps: StepDefinition[], start: StartRule = { kind: "entry" }): TrackDefinition {
  return { id, channel, branch: "main", window: EVERY_HOUR, steps, start, removed: false };
}

/** A definition of several tracks, with the email inboxes and SMS numbers of `subjectState`. */
export function tracksDefinition(tracks: TrackDefinition[]): CampaignDefinition {
  return { ...definition(), smsPool: ["+447700900001", "+447700900002"], tracks };
}

/** The lead's own mobile, an SMS destination. */
export const MOBILE = { id: "d-mobile", channel: "phone" as const, ownEmail: false, mobile: true, key: "+447700900101", value: "+44 7700 900101", bad: false, order: 2 };

/** `subjectState` with several tracks and the lead's mobile beside its email (or instead of it). */
export function multiTrackState(tracks: TrackDefinition[], details: "both" | "email" | "mobile" = "both"): SubjectState {
  const base = subjectState();
  const email = base.lead.details[0]!;
  const chosen = details === "both" ? [email, MOBILE] : details === "email" ? [email] : [MOBILE];
  return subjectState({
    campaign: { ...base.campaign, definition: tracksDefinition(tracks) },
    lead: {
      ...base.lead,
      details: chosen,
      resolved: Object.fromEntries(chosen.map((d) => [d.id, { liveId: d.id, bad: false, owned: true }])),
    },
    accounts: { ...base.accounts, "+447700900001": account("+447700900001", { channel: "sms" }), "+447700900002": account("+447700900002", { channel: "sms" }) },
  });
}

export function account(id: string, fields: Partial<AccountState> = {}): AccountState {
  return { id, channel: "email", capacity: 30, gapMs: 120_000, k: 1, nextSlotAt: 0, healthy: true, problem: null, waitUntil: null, waitReason: null, backoffMs: 0, resetZone: "UTC", used: 0, inFlight: 0, ...fields };
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
      smsSender: null,
      stopReply: null,
    },
    campaign: { id: "camp-1", launchedAt: null, pausedSince: null, version: 0, definitionVersion: 1, definition: definition() },
    tracks: [],
    results: [],
    attempts: [],
    work: [],
    freezes: [{ fromWall: created, toWall: null }],
    replies: [],
    pendingReplies: [],
    smsBindings: [],
    lead: {
      zone: "Europe/London",
      details: [{ id: "d-email", channel: "email", ownEmail: true, mobile: false, key: "pat@harbour.example", value: "pat@harbour.example", bad: false, order: 1 }],
      resolved: { "d-email": { liveId: "d-email", bad: false, owned: true } },
      mergeData: { first_name: "Pat", company: "Harbour Lane Physio" },
      phones: [],
    },
    markBad: [],
    accounts: { "inbox-a": account("inbox-a"), "inbox-b": account("inbox-b") },
    callTasks: [],
    callAttempts: [],
    recordedNumbers: {},
    newNotes: [],
    callDay: { userZone: "Europe/London", day: Math.floor(MONDAY_9 / 86_400_000), capacity: 20, placedToday: 0, committed: 0 },
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
