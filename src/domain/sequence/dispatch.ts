/**
 * Dispatch (ADR 0003 sections 4 and 5.5-5.6): which pending steps are ready, their priority,
 * the claim's step guard and account choice, the handover transaction's sixteen predicates, and
 * the same-key retry authorization. Pure: the store runs each check against current state inside
 * the transaction that writes its result.
 */
import { ENGINE_PARAMS, isLive, isUncertain } from "./attempt.ts";
import { leadNow, localDayNumber, windowOpen, windowOpensAt } from "./clock.ts";
import { render } from "./copy.ts";
import { ownSubject, poolOf, type TrackChannel } from "./definition.ts";
import { applyToAttempt, callbackHold, campaignLets, channelOf, progressOf, runs, trackHold, type HoldReason } from "./progress.ts";
import { callPlacedFrom, callRoom, isListed, listedForDay, userDay } from "./calls.ts";
import type { AccountState, Attempt, ProviderWork, RenderedCopy, SubjectState } from "./state.ts";

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

const stepDef = (state: SubjectState, trackId: string, stepId: string) =>
  state.campaign.definition.tracks.find((t) => t.id === trackId)?.steps.find((s) => s.id === stepId);

/** The copy for one step and lead, rendered from the current definition. A text has no subject. */
export function renderStep(state: SubjectState, trackId: string, stepId: string): RenderedCopy | null {
  const step = stepDef(state, trackId, stepId);
  if (!step) return null;
  // A text has no subject; an email renders only a subject it starts (a continuing one has none).
  const subject = render(channelOf(state, trackId) === "sms" ? "" : ownSubject(step), state.lead.mergeData);
  const body = render(step.body, state.lead.mergeData);
  return subject.ok && body.ok ? { subject: subject.text, body: body.text } : null;
}

/** The thread a continue-thread step continues: the provider reference of the track's latest send. */
export function threadOf(state: SubjectState, trackId: string): string | null {
  const sent = state.work
    .filter((w) => w.trackId === trackId && (w.settled === "sent" || w.settled === "user_sent") && state.attempts.some((a) => a.idempotencyKey === w.key && a.state === "sent"))
    .sort((a, b) => (a.sentWall ?? 0) - (b.sentWall ?? 0));
  return sent.at(-1)?.providerRef ?? null;
}

/** A continue-thread email with no thread to continue is held, not sent (ruling 1). A text has no thread. */
export function lacksThread(state: SubjectState, trackId: string, stepId: string): boolean {
  return channelOf(state, trackId) === "email" && stepDef(state, trackId, stepId)?.threading === "continue_thread" && threadOf(state, trackId) === null;
}

/** The subject's fixed sender on a channel (1.3). */
export function senderOf(state: SubjectState, channel: TrackChannel): string | null {
  return channel === "sms" ? state.subject.smsSender : channel === "email" ? state.subject.emailSender : null;
}

/**
 * Whether `sender` may text `recipient` for this subject (4.5): the pair has no unreleased owner,
 * or this subject owns it. An enrollment's binding is never transferred.
 */
export function pairFree(state: SubjectState, sender: string, recipient: string): boolean {
  return state.smsBindings.every((b) => b.sender !== sender || b.recipient !== recipient || b.owner === state.subject.id);
}

/** The mobile an SMS track texts: its destination's key (E.164). */
function recipientOf(state: SubjectState, trackId: string): string | null {
  const id = progressOf(state, trackId)?.destinationDetailId;
  const live = id ? state.lead.resolved[id]?.liveId : undefined;
  return state.lead.details.find((d) => d.id === live)?.key ?? null;
}

/**
 * The accounts a claim for a step on this track may choose from: the fixed sender, else the pool;
 * for SMS, only numbers whose conversation with the mobile is free or this subject's (4.5).
 */
export function candidatesFor(state: SubjectState, trackId: string): string[] {
  const channel = channelOf(state, trackId) ?? "email";
  const fixed = senderOf(state, channel);
  const ids = fixed !== null ? [fixed] : [...poolOf(state.campaign.definition, channel)];
  if (channel !== "sms") return ids;
  const recipient = recipientOf(state, trackId);
  return recipient === null ? ids : ids.filter((id) => pairFree(state, id, recipient));
}

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
  // Every number this SMS track may use is in another subject's conversation with the mobile (4.5, Q7).
  if (channelOf(state, trackId) === "sms" && candidatesFor(state, trackId).length === 0) return "sms_conversation_taken";
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
    // A track whose conversation is taken stays ready: a number may join the pool, and the claim decides.
    const held = heldReason(state, p.trackId, now);
    if (held && held !== "sms_conversation_taken") return [];
    return [{ subjectId: state.subject.id, trackId: p.trackId, stepId, touched: state.subject.touched, dueWall: p.dueWall }];
  });
}

/** The wall instant the pending step became due: its stored due wall moved by every freeze since. */
export function windowOf(state: SubjectState, trackId: string) {
  return state.campaign.definition.tracks.find((t) => t.id === trackId)?.window ?? [];
}

/**
 * The first instant at or after `now` at which the claim's time conditions hold for the track's pending email or text,
 * the lead running (ADR 0003 "Reads that say when"): its wait has ended in lead time, and its track's window is open in
 * the prospect's zone. The claim's step guard refuses "the sending window is closed" exactly when it is not `now`. Null
 * when there is no pending step with a due time, or the window never opens.
 */
export function sendableFrom(state: SubjectState, trackId: string, now: number, from: number = now): number | null {
  const p = progressOf(state, trackId);
  if (!p || p.dueAt === null) return null;
  const dueWall = now + Math.max(0, p.dueAt - leadNow(state.subject.clock, now));
  return windowOpensAt(windowOf(state, trackId), state.lead.zone, Math.max(dueWall, from));
}

/**
 * Why a pending step has no time a read may promise: the engine cannot know when what holds it ends. A lead or campaign
 * hold, an ending, work with a provider, a held track (5.4), no window, no transport for the step on its port, sending
 * interrupted on its provider, a reply from its destination waiting for its thread (predicate 18), no sender account that
 * can send, every sender at its in-flight bound, every sender full before its reset, today's call list full, or a call
 * already on the list, on a later day, or waiting for calling hours (its task's read says which).
 */
export type StepWait =
  | "campaign_not_launched"
  | "campaign_paused"
  | "lead_paused"
  | "callback"
  | "ended"
  | "with_provider"
  | HoldReason
  | "no_window"
  | "no_transport"
  | "waiting_on_provider"
  | "reply_pending"
  | "no_destination"
  | "sender_unavailable"
  | "sender_busy"
  | "sending_capacity"
  | "call_capacity"
  | "on_call_list"
  | "call_hours_closed";

/**
 * When the track's pending step goes, as every read says it: the engine's instant (at or after `now`); for a call, the
 * user day it goes on the list (`call_day`, at the instant it is placed), or the user day an open call is listed for
 * (`listed_for`); or why it waits.
 */
export type StepWhen =
  | { readonly kind: "at"; readonly at: number }
  | { readonly kind: "call_day"; readonly at: number; readonly day: number }
  | { readonly kind: "listed_for"; readonly day: number }
  | { readonly kind: "waits"; readonly why: StepWait };

/**
 * What a read knows of dispatch beyond the subject (ADR 0003 "Reads that say when"): whether the step's port has a
 * transport for it (`transportFor`, as the claim pass asks), and whether the dispatch gate holds its channels while sending
 * is interrupted (`waitingOn`, as the gate asks). Both default to what a subject alone shows: available, not held.
 */
export interface StepEnv {
  readonly transportAvailable?: (channel: "email" | "sms", threading: "new_subject" | "continue_thread") => boolean;
  readonly waitingOnProvider?: (state: SubjectState, trackId: string) => boolean;
  /** Whether the user's list has room for one more call on a later user day, from the calls the engine knows are carried into it (`carriedInto`). */
  readonly callRoomOn?: (day: number) => boolean;
}

/**
 * Each account as the store reports it at `t` (ADR 0003 4.1, "An account with no room"): on its current reset day as it is
 * now; on a later reset day, its daily limit for room and only its open reservations used, since nothing is sent on that
 * day yet. The store's account read (`used = sent on the reset day + reserved`, `capacity` today's room today and the daily
 * limit on any other day) and the Before launch projection's `view` follow the same rule.
 */
export function accountsAt(state: SubjectState, now: number, t: number): SubjectState {
  const accounts: Record<string, AccountState> = {};
  for (const [id, a] of Object.entries(state.accounts)) {
    accounts[id] = localDayNumber(t, a.resetZone) === localDayNumber(now, a.resetZone) ? a : { ...a, capacity: a.dailyLimit, used: a.reserved };
  }
  return { ...state, accounts };
}

const LOOK_AHEAD = 24;

/**
 * The one read of when a track's pending step goes (ADR 0003 "Reads that say when"), reached by asking dispatch's own
 * functions at the instant it would promise, never by restating them:
 * - an email or text: from the first instant the claim's step guard (`claimRefusal`, through `sendableFrom`) accepts it, the
 *   dispatcher's own account choice there (`chooseAccount`, which carries an inherited reservation and still requires an
 *   available sender), the pacing slot of the account it chooses and predicate 18 (`replyPending`), then the port's
 *   transport and the dispatch gate (`env`); a claimed attempt by the handover's own predicates (`handoverFailures`), and,
 *   when those withdraw it, as the step after the engine's own withdrawal (`applyToAttempt`, `guard_failed`);
 * - a call: `callPlacedFrom` (`readyCalls`) and `callRoom`, then for an open task the listing rule (`isListed`).
 * Null when the track has no pending step with a due time.
 */
export function stepWhen(state: SubjectState, trackId: string, now: number, env: StepEnv = {}): StepWhen | null {
  const p = progressOf(state, trackId);
  if (!p || p.startedAt === null || p.finishedAt !== null || p.nextStepId === null || p.dueAt === null) return null;
  const waits = (why: StepWait): StepWhen => ({ kind: "waits", why });
  const { subject, campaign } = state;
  if (subject.ended !== null) return waits("ended");
  if (!campaignLets(state)) return waits(campaign.pausedSince !== null ? "campaign_paused" : "campaign_not_launched");
  if (subject.leadPaused) return waits("lead_paused");
  if (callbackHold(state)) return waits("callback");
  if (!runs(state)) return waits("ended");
  const stepId = p.nextStepId;
  const channel = channelOf(state, trackId);
  if (channel === "call") return callWhen(state, trackId, stepId, now, env);
  if (channel !== "email" && channel !== "sms") return null;
  // A held track first (5.4): work the provider has not confirmed holds the track with a live attempt too.
  const hold = trackHold(state, trackId);
  if (hold) return waits(hold);
  const live = state.attempts.find((a) => a.stepId === stepId && isLive(a));
  if (live && live.state !== "claimed") return waits("with_provider");
  const threading = stepDef(state, trackId, stepId)?.threading ?? "new_subject";
  if (env.transportAvailable && !env.transportAvailable(channel, threading)) return waits("no_transport");
  if (env.waitingOnProvider?.(state, trackId) === true) return waits("waiting_on_provider");
  if (live) {
    // Claimed: the handover's own predicates (the pre-send check, 14, is the engine's to make at the call).
    const account = state.accounts[live.accountId];
    const failed = account ? handoverFailures(state, live, account, now).filter((f) => f !== 14) : [9];
    if (failed.length === 0) return { kind: "at", at: now };
    if (failed.includes(18)) return waits("reply_pending");
    if (failed.every((f) => f === 16) && account) return { kind: "at", at: account.nextSlotAt };
    // Any other failure withdraws it (`guard_failed`), freeing a reservation that was never called; the step is then the
    // dispatcher's to claim again, which the rest of this read asks.
    const after = applyToAttempt(state, live.id, { kind: "guard_failed" }, now).state;
    const freed = after.work.find((w) => w.key === live.idempotencyKey)?.settled != null;
    const acc = after.accounts[live.accountId];
    const released = freed && acc ? { ...after, accounts: { ...after.accounts, [acc.id]: { ...acc, used: Math.max(0, acc.used - 1), reserved: Math.max(0, acc.reserved - 1), inFlight: Math.max(0, acc.inFlight - 1) } } } : after;
    return freshWhen(released, trackId, stepId, now);
  }
  const held = heldReason(state, trackId, now);
  if (held && held !== "sms_conversation_taken") return waits(held);
  return freshWhen(state, trackId, stepId, now);
}

/** An email or text with no live attempt: the first instant the claim's guard, the dispatcher's account choice and the handover's slot all accept it. */
function freshWhen(state: SubjectState, trackId: string, stepId: string, now: number): StepWhen {
  const waits = (why: StepWait): StepWhen => ({ kind: "waits", why });
  let t = sendableFrom(state, trackId, now);
  const item: ReadyItem = { subjectId: state.subject.id, trackId, stepId, touched: state.subject.touched, dueWall: now };
  for (let i = 0; i < LOOK_AHEAD && t !== null; i++) {
    const at = accountsAt(state, now, t);
    const refusal = claimRefusal(at, item, t);
    if (refusal === "the destination is not a good address of the lead") return waits("no_destination");
    if (refusal === "the copy does not render for this lead") return waits("render_failed");
    if (refusal === "there is no thread to continue") return waits("no_thread");
    if (refusal !== null) return waits("no_window");
    const account = chooseAccount(at, t, stepId);
    if (account) {
      if (replyPending(at, account.id, destinationOf(at, trackId))) return waits("reply_pending");
      if (account.nextSlotAt <= t) return { kind: "at", at: t };
      t = sendableFrom(state, trackId, now, account.nextSlotAt);
      continue;
    }
    // Why the dispatcher chose none, from the same candidates `chooseAccount` reads.
    const channel = channelOf(at, trackId);
    const candidates = candidatesFor(at, trackId).map((id) => at.accounts[id]).filter((a): a is AccountState => a !== undefined && a.channel === channel);
    const available = candidates.filter((a) => accountAvailable(a, t ?? now));
    if (available.length === 0) {
      // A known end only: a quota wait has none (the engine marks it with no real instant), so it is a reason, as Needs
      // attention says it ("until" null for a quota).
      const until = candidates.filter((a) => a.healthy && a.waitReason !== "quota" && a.waitUntil !== null && a.waitUntil > (t ?? now)).map((a) => a.waitUntil ?? 0);
      if (until.length === 0) return waits("sender_unavailable");
      t = sendableFrom(state, trackId, now, Math.min(...until));
      continue;
    }
    if (available.some((a) => a.used < a.capacity)) return waits("sender_busy");
    return waits("sending_capacity");
  }
  return waits("no_window");
}

/** The address or mobile a step of the track goes to, as the claim writes it. */
function destinationOf(state: SubjectState, trackId: string): string {
  const p = progressOf(state, trackId);
  const d = state.lead.details.find((x) => x.id === state.lead.resolved[p?.destinationDetailId ?? ""]?.liveId);
  return (channelOf(state, trackId) === "sms" ? d?.key : d?.value) ?? "";
}

/** A call step: the user day it goes on the list (`readyCalls`, `callRoom`), or, once placed, where its task is (`isListed`). */
function callWhen(state: SubjectState, trackId: string, stepId: string, now: number, env: StepEnv): StepWhen {
  const task = state.callTasks.find((t) => t.stepId === stepId && t.open);
  if (task) {
    if (isListed(state, task)) return { kind: "waits", why: "on_call_list" };
    const day = listedForDay(state, task);
    return day > state.callDay.day ? { kind: "listed_for", day } : { kind: "waits", why: "call_hours_closed" };
  }
  if (state.callTasks.some((t) => t.stepId === stepId)) return { kind: "waits", why: "ended" };
  const at = callPlacedFrom(state, trackId, now);
  if (at === null) return { kind: "waits", why: "no_window" };
  // Placed today only while today's list has room (4.4); a later day's room is not known yet.
  if (at < userDay(state).end && !callRoom(state)) return { kind: "waits", why: "call_capacity" };
  const day = localDayNumber(at, state.callDay.userZone);
  // A later day already filled by calls the engine knows are carried into it: no room it can name a day for.
  if (day > state.callDay.day && env.callRoomOn?.(day) === false) return { kind: "waits", why: "call_capacity" };
  return { kind: "call_day", at, day };
}

/** The claim's step guard (4.2 step 1). Null when it holds; otherwise why not. */
export function claimRefusal(state: SubjectState, item: ReadyItem, now: number): string | null {
  if (!runs(state)) return "the lead is not running";
  const p = progressOf(state, item.trackId);
  if (!p || p.startedAt === null || p.finishedAt !== null) return "the track is not running";
  if (p.nextStepId !== item.stepId) return "the step is not the track's pending step";
  const step = stepDef(state, item.trackId, item.stepId);
  if (!step || step.removed) return "the step was removed";
  if (state.results.some((r) => r.stepId === item.stepId)) return "the step already has a result";
  if (state.attempts.some((a) => a.stepId === item.stepId && isLive(a))) return "the step already has a live attempt";
  if (p.dueAt === null || p.dueAt > leadNow(state.subject.clock, now)) return "the step is not due";
  // The step's time conditions hold exactly at the instant the reads give (`sendableFrom`, ADR 0003 "Reads that say when").
  if (sendableFrom(state, item.trackId, now) !== now) return "the sending window is closed";
  const dest = p.destinationDetailId ? state.lead.resolved[p.destinationDetailId] : undefined;
  if (!dest || dest.bad || !dest.owned) return "the destination is not a good address of the lead";
  if (!renderStep(state, item.trackId, item.stepId)) return "the copy does not render for this lead";
  if (lacksThread(state, item.trackId, item.stepId)) return "there is no thread to continue";
  return null;
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
    smsBindings: binds ? [...state.smsBindings, { sender: account.id, recipient: attempt.destination, owner: state.subject.id, ownerCampaignId: state.campaign.id, ownerEnded: false }] : state.smsBindings,
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
