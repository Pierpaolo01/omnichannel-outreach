/**
 * Dispatch (ADR 0003 sections 4 and 5.5-5.6): which pending steps are ready, their priority,
 * the claim's step guard and account choice, the handover transaction's sixteen predicates, and
 * the same-key retry authorization. Pure: the store runs each check against current state inside
 * the transaction that writes its result.
 */
import { ENGINE_PARAMS, isLive, isUncertain } from "./attempt.ts";
import { leadNow, windowOpen } from "./clock.ts";
import { poolOf } from "./definition.ts";
import {
  candidatesFor,
  channelOf,
  claimRefusal,
  conversationUnsettled,
  lacksThread,
  pairFree,
  progressOf,
  renderStep,
  runs,
  senderOf,
  stepDef,
  threadOf,
  trackHold,
  windowOf,
  type HoldReason,
} from "./progress.ts";
import type { AccountState, Attempt, ProviderWork, SubjectState } from "./state.ts";

export interface ReadyItem {
  readonly subjectId: string;
  readonly trackId: string;
  readonly stepId: string;
  /** Follow-ups go before first messages to new leads (4.3). */
  readonly touched: boolean;
  readonly dueWall: number;
}

/** Priority (4.3): touched leads first, then oldest due as wall instants, then subject id, then step id. */
export function comparePriority(a: ReadyItem, b: ReadyItem): number {
  if (a.touched !== b.touched) return a.touched ? -1 : 1;
  if (a.dueWall !== b.dueWall) return a.dueWall - b.dueWall;
  if (a.subjectId !== b.subjectId) return a.subjectId < b.subjectId ? -1 : 1;
  return a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0;
}

// The claim's step guard and the SMS conversation candidates live beside evaluation, which skips a track on them
// (ADR 0003, question Q7 answered); they are re-exported here, where the claim reads them.
export { candidatesFor, claimRefusal, lacksThread, pairFree, renderStep, senderOf, threadOf, windowOf };

/** A held track's reason (5.4), including a pending step whose copy cannot render for this lead. */
export function heldReason(state: SubjectState, trackId: string, now: number): HoldReason | null {
  const hold = trackHold(state, trackId);
  if (hold) return hold;
  const progress = progressOf(state, trackId);
  if (!progress?.nextStepId || progress.finishedAt !== null || progress.dueAt === null) return null;
  if (progress.dueAt > leadNow(state.subject.clock, now)) return null;
  if (state.attempts.some((a) => a.stepId === progress.nextStepId && isLive(a))) return null;
  if (lacksThread(state, trackId, progress.nextStepId)) return "no_thread";
  if (!renderStep(state, trackId, progress.nextStepId)) return "render_failed";
  // A conversation taken on every number the track may use is not a hold: evaluation skips the track (4.5, Q7 answered).
  // One whose owner's first text is not known sent or not sent yet holds it, until that work settles (point 10).
  if (conversationUnsettled(state, trackId, now)) return "sms_conversation_unsettled";
  return null;
}

/** Pending steps that are due now (2.6 step 4), whatever their window. */
export function readyItems(state: SubjectState, now: number): ReadyItem[] {
  if (!runs(state)) return [];
  const lead = leadNow(state.subject.clock, now);
  return state.tracks.flatMap((p): ReadyItem[] => {
    if (p.startedAt === null || p.finishedAt !== null || p.nextStepId === null || p.dueAt === null || p.dueWall === null) return [];
    if (p.dueAt > lead) return [];
    // A call is never sent: the user dials it from their list (calls.ts places it there).
    if (channelOf(state, p.trackId) === "call") return [];
    const stepId = p.nextStepId;
    if (state.results.some((r) => r.stepId === stepId)) return [];
    if (state.attempts.some((a) => a.stepId === stepId && isLive(a))) return [];
    if (heldReason(state, p.trackId, now)) return [];
    return [{ subjectId: state.subject.id, trackId: p.trackId, stepId, touched: state.subject.touched, dueWall: p.dueWall }];
  });
}

export function accountAvailable(account: AccountState, now: number): boolean {
  return account.healthy && (account.waitUntil === null || now >= account.waitUntil);
}

/** Capacity and the in-flight bound (4.2 step 3). An attempt inheriting uncertain work already holds that work's reservation. */
export function accountHasRoom(account: AccountState, reservedAlready = false): boolean {
  // A claim carrying uncertain work already holds that work's place and reservation (`occupyingKeys` counts it once):
  // it needs neither a new place nor a new reservation (council B on 56d599c).
  return reservedAlready || (account.used < account.capacity && account.inFlight < account.k);
}

/**
 * The step's provider work a claim inherits the key of, whose reservation it carries on (ruling 3):
 * only work still unsettled and uncertain, that no live attempt carries. Inheritance asks the
 * work, so a key whose work has settled is never inherited (PR 37 review round 3).
 */
export function inheritedWork(state: SubjectState, stepId: string): ProviderWork | undefined {
  return state.work.find((w) => w.stepId === stepId && isUncertain(w) && !state.attempts.some((a) => a.idempotencyKey === w.key && isLive(a)));
}

/**
 * The account a claim uses (4.2 step 2): the subject's fixed sender, or the pool's account that
 * can send soonest, then the one with most remaining capacity, then the lowest id.
 */
export function chooseAccount(state: SubjectState, now: number, stepId: string | null = null): AccountState | null {
  const trackId = state.campaign.definition.tracks.find((t) => t.steps.some((st) => st.id === stepId))?.id ?? state.campaign.definition.tracks.find((t) => t.channel === "email")?.id ?? "";
  const channel = channelOf(state, trackId) ?? "email";
  const candidates = candidatesFor(state, trackId).map((id) => state.accounts[id]).filter((a) => a?.channel === channel);
  const inherited = stepId === null ? undefined : inheritedWork(state, stepId);
  return pickAccount(candidates, now, inherited?.accountId ?? null);
}

/**
 * Of the candidate accounts, the one a claim takes (4.2 step 2): available and with room, then
 * the one that can send soonest, then the one with most remaining capacity, then the lowest id.
 * `reservedOn` is the account whose reservation an inherited claim already holds. The Before
 * launch projection calls this too, so it chooses as the engine does (ADR 0003, 12c).
 */
export function pickAccount(candidates: readonly (AccountState | undefined)[], now: number, reservedOn: string | null = null): AccountState | null {
  return (
    candidates
      .filter((a): a is AccountState => a !== undefined && accountAvailable(a, now) && accountHasRoom(a, reservedOn === a.id))
      .sort((a, b) => Math.max(a.nextSlotAt, now) - Math.max(b.nextSlotAt, now) || b.capacity - b.used - (a.capacity - a.used) || (a.id < b.id ? -1 : 1))[0] ?? null
  );
}

/** Writes the claimed attempt and its reservation (4.2 step 4). The sender is not fixed here. */
export function claim(
  state: SubjectState,
  item: ReadyItem,
  account: AccountState,
  input: { readonly attemptId: string; readonly retryable: boolean; readonly notSentIsFinal: boolean; readonly now: number },
): SubjectState {
  const p = progressOf(state, item.trackId);
  if (!p?.destinationDetailId) throw new Error("claim without a destination");
  const destination = state.lead.details.find((d) => d.id === state.lead.resolved[p.destinationDetailId ?? ""]?.liveId);
  const sms = channelOf(state, item.trackId) === "sms";
  // Uncertain work on this account is carried on, with its key and reservation; otherwise new work.
  const found = inheritedWork(state, item.stepId);
  const inherited = found?.accountId === account.id ? found : undefined;
  const attempt: Attempt = {
    id: input.attemptId,
    subjectId: state.subject.id,
    trackId: item.trackId,
    stepId: item.stepId,
    accountId: account.id,
    destinationDetailId: p.destinationDetailId,
    // A text goes to the mobile's E.164 form; an email to the address as written.
    destination: (sms ? destination?.key : destination?.value) ?? "",
    state: "claimed",
    copy: null,
    threading: stepDef(state, item.trackId, item.stepId)?.threading ?? "new_subject",
    threadRef: null,
    retryable: input.retryable,
    notSentIsFinal: input.notSentIsFinal,
    idempotencyKey: inherited?.key ?? input.attemptId,
    calls: 0,
    claimedWall: input.now,
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
  };
  const work: ProviderWork = {
    key: attempt.id,
    subjectId: attempt.subjectId,
    trackId: attempt.trackId,
    stepId: attempt.stepId,
    accountId: account.id,
    destination: attempt.destination,
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
    withdrawWanted: false,
    withdrawLastWall: null,
    wentWall: null,
  };
  return {
    ...state,
    attempts: [...state.attempts, attempt],
    work: inherited ? state.work : [...state.work, work],
    accounts: { ...state.accounts, [account.id]: { ...account, used: account.used + (inherited ? 0 : 1), inFlight: account.inFlight + (inherited ? 0 : 1) } },
  };
}

/** Whether the email step continues the thread, and the provider reference it continues. */
export function threadFor(state: SubjectState, attempt: Attempt): string | null {
  return attempt.threading === "continue_thread" ? threadOf(state, attempt.trackId) : null;
}

/** Predicates 1-9 and 12-13 of 5.5, shared by the handover and the retry authorization. */
function currentStatePredicates(state: SubjectState, attempt: Attempt, account: AccountState, now: number): number[] {
  const failed: number[] = [];
  if (!runs(state)) failed.push(1);
  const p = progressOf(state, attempt.trackId);
  if (!p || p.startedAt === null || p.finishedAt !== null) failed.push(2);
  if (p?.nextStepId !== attempt.stepId) failed.push(3);
  if (state.results.some((r) => r.stepId === attempt.stepId)) failed.push(4);
  const step = stepDef(state, attempt.trackId, attempt.stepId);
  if (!step || step.removed) failed.push(5);
  if (p?.dueAt == null || p.dueAt > leadNow(state.subject.clock, now)) failed.push(6);
  if (state.attempts.some((a) => a.id !== attempt.id && a.stepId === attempt.stepId && isLive(a))) failed.push(7);
  if (!windowOpen(windowOf(state, attempt.trackId), state.lead.zone, now)) failed.push(8);
  if (!accountAvailable(account, now)) failed.push(9);
  const dest = state.lead.resolved[attempt.destinationDetailId];
  if (!dest || dest.bad || !dest.owned) failed.push(12);
  if (state.replies.some((r) => r.atWall >= attempt.claimedWall)) failed.push(13);
  if (replyPending(state, attempt.accountId, attempt.destination)) failed.push(18);
  return failed;
}

/** A reply from `destination` to `inbox` is waiting for its thread to be known (2.4): sends between them pause. */
export function replyPending(state: SubjectState, inbox: string, destination: string): boolean {
  const address = destination.toLowerCase();
  return state.pendingReplies.some((r) => r.inbox === inbox && r.address === address);
}

const presendFresh = (attempt: Attempt, now: number) =>
  attempt.presendCheckedWall !== null && attempt.presendCheckedWall >= now - ENGINE_PARAMS.PRESEND_MAX_AGE && !attempt.presendFoundReply;

/** The handover transaction's predicates on current state (5.5 step 4). Empty when every one holds. */
export function handoverFailures(state: SubjectState, attempt: Attempt, account: AccountState, now: number): number[] {
  if (attempt.state !== "claimed") return [15];
  const failed = currentStatePredicates(state, attempt, account, now);
  // 15. The attempt's reservation exists: its provider work is unsettled.
  if (state.work.find((w) => w.key === attempt.idempotencyKey)?.settled !== null) failed.push(15);
  const channel = channelOf(state, attempt.trackId) ?? "email";
  const fixed = senderOf(state, channel);
  if (account.channel !== channel || (fixed !== null ? fixed !== account.id : !poolOf(state.campaign.definition, channel).includes(account.id))) failed.push(10);
  // 11. For SMS, the pair is unbound, or bound to this subject.
  if (channel === "sms" && !pairFree(state, account.id, attempt.destination)) failed.push(11);
  if (!presendFresh(attempt, now)) failed.push(14);
  if (!renderStep(state, attempt.trackId, attempt.stepId)) failed.push(5);
  if (lacksThread(state, attempt.trackId, attempt.stepId)) failed.push(17);
  if (now < account.nextSlotAt) failed.push(16);
  return [...new Set(failed)].sort((a, b) => a - b);
}

/**
 * The handover write (5.5 step 4): renders the copy, takes the pacing slot, fixes the sender,
 * and records the call before it is made.
 */
export function handOver(state: SubjectState, attempt: Attempt, account: AccountState, now: number): SubjectState {
  const copy = renderStep(state, attempt.trackId, attempt.stepId);
  const handed: Attempt = {
    ...attempt,
    state: "handed",
    calls: 1,
    copy,
    threadRef: threadFor(state, attempt),
    handedAt: leadNow(state.subject.clock, now),
    handedWall: now,
    lastCallWall: now,
    awaitingAnswer: true,
  };
  // The work is called: by its first attempt, or by an inheritor, which carries it on and attends
  // it again, so it is no longer unresolved (no attempt is called once unresolved, invariant 5).
  // The sender is fixed here, and for SMS the conversation taken, in the same write (1.3, 4.5).
  const sms = channelOf(state, attempt.trackId) === "sms";
  const binds = sms && !state.smsBindings.some((b) => b.sender === account.id && b.recipient === attempt.destination);
  return {
    ...state,
    subject: sms ? { ...state.subject, smsSender: state.subject.smsSender ?? account.id } : { ...state.subject, emailSender: state.subject.emailSender ?? account.id },
    smsBindings: binds ? [...state.smsBindings, { sender: account.id, recipient: attempt.destination, owner: state.subject.id, ownerCampaignId: state.campaign.id, ownerCampaignName: null, ownerIsTest: state.subject.kind === "test_run", ownerEnded: false, ownerSent: false, ownerAnswered: false }] : state.smsBindings,
    attempts: state.attempts.map((a) => (a.id === attempt.id ? handed : a)),
    work: state.work.map((w) => (w.key === attempt.idempotencyKey ? { ...w, calls: w.calls + 1, firstHandedWall: w.firstHandedWall ?? now, unresolvedSince: null } : w)),
    accounts: { ...state.accounts, [account.id]: { ...account, nextSlotAt: now + account.gapMs } },
  };
}

/** The same-key retry authorization's conditions (5.6). Empty when the retry may be called now. */
export function retryFailures(state: SubjectState, attempt: Attempt, account: AccountState, now: number): string[] {
  const failed: string[] = [];
  if (attempt.state !== "handed") failed.push("not handed");
  if (!attempt.retryable) failed.push("not retryable");
  if (attempt.calls >= ENGINE_PARAMS.MAX_CALLS) failed.push("no calls left");
  if (attempt.withdrawRequested) failed.push("withdraw requested");
  const work = state.work.find((w) => w.key === attempt.idempotencyKey);
  if (!work || work.unresolvedSince !== null || work.settled !== null) failed.push("unresolved");
  failed.push(...currentStatePredicates(state, attempt, account, now).map((n) => `predicate ${n}`));
  if (!presendFresh(attempt, now)) failed.push("predicate 14");
  if (now < account.nextSlotAt) failed.push("slot");
  return failed;
}

/** The retry write: one more call with the identical key and stored payload, taking the slot. */
export function authorizeRetry(state: SubjectState, attempt: Attempt, account: AccountState, now: number): SubjectState {
  const retried: Attempt = { ...attempt, calls: attempt.calls + 1, lastCallWall: now, awaitingAnswer: true, retry: "none" };
  return {
    ...state,
    attempts: state.attempts.map((a) => (a.id === attempt.id ? retried : a)),
    work: state.work.map((w) => (w.key === attempt.idempotencyKey ? { ...w, calls: w.calls + 1 } : w)),
    accounts: { ...state.accounts, [account.id]: { ...account, nextSlotAt: now + account.gapMs } },
  };
}

/** Accounts whose in-flight places are all held by attempts older than SETTLING (5.4, ruling 3). */
export function stalledAccounts(
  accounts: readonly Pick<AccountState, "id" | "k">[],
  live: readonly Pick<Attempt, "accountId" | "claimedWall" | "lastCallWall" | "destination">[],
  now: number,
): { accountId: string; holding: string[] }[] {
  return accounts.flatMap((acc) => {
    const holding = live.filter((a) => a.accountId === acc.id);
    const old = holding.filter((a) => now - (a.lastCallWall ?? a.claimedWall) >= ENGINE_PARAMS.SETTLING);
    return holding.length >= acc.k && old.length >= acc.k ? [{ accountId: acc.id, holding: old.map((a) => a.destination) }] : [];
  });
}

/**
 * The default pacing gap (ADR 0003 4.1): the shortest daily window among the tracks the account
 * serves, divided by its daily capacity, and at least 60 seconds, so a full day's capacity fits
 * inside the window.
 */
export function defaultGap(windows: readonly (readonly { readonly start: number; readonly end: number }[])[], capacity: number): number {
  const hours = windows.flatMap((w) => w.map((r) => (r.start < r.end ? r.end - r.start : 24 - r.start + r.end)));
  if (hours.length === 0 || capacity <= 0) return 60_000;
  return Math.max(60_000, Math.floor((Math.min(...hours) * 3_600_000) / capacity));
}
