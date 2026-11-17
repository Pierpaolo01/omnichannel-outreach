/**
 * Dispatch (ADR 0003 sections 4 and 5.5-5.6): which pending steps are ready, their priority,
 * the claim's step guard and account choice, the handover transaction's sixteen predicates, and
 * the same-key retry authorization. Pure: the store runs each check against current state inside
 * the transaction that writes its result.
 */
import { ENGINE_PARAMS, isLive, isUncertain } from "./attempt.ts";
import { leadNow, localDayNumber, windowOpen } from "./clock.ts";
import { allowanceOf, holdsConversations, linkedinStepKind, poolOf, socialActionOf, type SocialAction } from "./definition.ts";
import {
  rules as gateRules,
  invitePendingUntil,
  inviteClaimable,
  inviteSessions,
  inmailBacking,
  linkedinSessionOf,
  applyToAttempt,
  awaitingAcceptance,
  callbackHold,
  campaignLets,
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
  sendableFrom,
  stepDef,
  threadOf,
  trackHold,
  windowOf,
  type HoldReason,
} from "./progress.ts";
import { callPlacedFrom, callRoom, isListed, listedForDay, userDay } from "./calls.ts";
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
export { candidatesFor, claimRefusal, lacksThread, pairFree, renderStep, sendableFrom, senderOf, threadOf, windowOf };

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
  // An invite already pending on LinkedIn that this application did not send: held until a check finds it gone, checked
  // again each settling period while a claim could be made (Q42). The hold lasts between checks, as outside the window.
  if (invitePendingUntil(state, trackId) !== null) return "invite_pending_elsewhere";
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
    // An invite is claimed only once every session it may use has answered its connection check within a settling period,
    // and one of them is clear (council on b21af02, item 4; review bot on e261ffa).
    if (channelOf(state, p.trackId) === "linkedin" && actionOfStep(state, p.trackId, stepId) === "invite" && !inviteClaimable(state, p.trackId, now)) return [];
    return [{ subjectId: state.subject.id, trackId: p.trackId, stepId, touched: state.subject.touched, dueWall: p.dueWall }];
  });
}

/**
 * Why a pending step has no time a read may promise (ADR 0003 "Reads that say when"). Everything that is not about time or a
 * sender: a lead or campaign hold, an ending, work with a provider, a held track (5.4), no window, no transport for the step
 * on its port, sending interrupted on its provider, no good destination. Once its time has come, a reason only when this
 * subject's own state makes the handover impossible at the read's instant whatever the other leads do: a reply from its
 * destination waiting for its thread on every sender it may use (predicate 18); its claim's sender's pacing slot not reached
 * (`sender_slot`: a slot only moves later); every candidate sender unable to send whatever the others do (unavailable,
 * rate-limited, or full today by its sends alone), with the cause they share, else the general `sender_waiting`. A call:
 * today's list full, or already on the list, on a later day, or waiting for calling hours.
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
  | "sender_slot"
  | "sender_unavailable"
  | "sender_rate_limited"
  | "sending_capacity"
  | "sender_waiting"
  | "call_capacity"
  | "on_call_list"
  | "call_hours_closed"
  /** A LinkedIn message waiting for its invite to be accepted (ADR 0004 section 9); the read states the day the wait ends. */
  | "awaiting_acceptance"
  /**
   * An InMail the expiry chose whose session cannot send it now by its own report (ADR 0004 13.3, 13.5): it lost its plan or
   * its credits since. With no time; `inmail` names which (`inmailUnavailable`).
   */
  | "inmail_unavailable";

/**
 * When the track's pending step goes, as every read says it: ready (its time has come and nothing of its own holds it; it
 * is in line for its sender, with no instant promised); the earliest instant, when it waits on time alone; for a call, the
 * user day it goes on the list (`call_day`, at the instant it is placed), or the user day an open call is listed for
 * (`listed_for`); or why it waits.
 */
export type StepWhen =
  | { readonly kind: "ready" }
  | { readonly kind: "at"; readonly at: number }
  | { readonly kind: "call_day"; readonly at: number; readonly day: number }
  | { readonly kind: "listed_for"; readonly day: number }
  /** `channel` names the step's channel where the reason depends on it (no transport). */
  | { readonly kind: "waits"; readonly why: StepWait; readonly channel?: "email" | "sms" | "linkedin"; readonly until?: number; readonly inmail?: InmailWait; readonly reportedAt?: number | null };

/**
 * A held track's reason as the read gives it (5.4), one case per hold `heldReason` can return, so a hold a later change
 * adds fails typecheck here until it has its own reason, never falling through to a generic one.
 */
export function holdWait(hold: HoldReason): StepWait {
  switch (hold) {
    case "unresolved":
    case "render_failed":
    case "provider_skipped":
    case "no_thread":
    case "sms_conversation_unsettled":
    case "invite_pending_elsewhere":
      return hold;
    default: {
      const unhandled: never = hold;
      throw new Error(`A hold the read has no reason for: ${String(unhandled)}`);
    }
  }
}

/**
 * What a read knows of dispatch beyond the subject (ADR 0003 "Reads that say when"): whether the step's port has a
 * transport for it (`transportFor`, as the claim pass asks), and whether the dispatch gate holds its channels while sending
 * is interrupted (`waitingOn`, as the gate asks). Both default to what a subject alone shows: available, not held.
 */
export interface StepEnv {
  readonly transportAvailable?: (channel: "email" | "sms" | "linkedin", threading: "new_subject" | "continue_thread") => boolean;
  readonly waitingOnProvider?: (state: SubjectState, trackId: string) => boolean;
  /**
   * Whether the user's list has room for one more call on a later user day, from the calls the engine knows are carried into
   * it (`carriedInto`), with `self` (the subject being read: for a control's preview, its state after the control) in place
   * of its stored state (council on cc9bf55, item 8).
   */
  readonly callRoomOn?: (day: number, self: SubjectState) => boolean;
}

/**
 * The one read of when a track's pending step goes (ADR 0003 "Reads that say when"), from this subject's own state and
 * dispatch's own per-step checks at the read's instant; it loads no other lead and predicts nothing:
 * 1. anything that is not about time or a sender (a hold, a pause, an ending, no transport, an interruption): that reason;
 * 2. waiting on time alone (its wait has not ended, or its window is closed): the first instant at or after the wait's end
 *    at which the window is open (`sendableFrom`), as an earliest time, unless the engine knows no sender could take it
 *    (none connected, or every candidate's daily limit zero), or the lead has no good destination;
 * 3. its time has come: the step guard (`claimRefusal`), the account choice (`chooseAccount`) and, for its claim, the
 *    handover predicates (`handoverFailures`). A reason only when they make the handover impossible at this instant whatever
 *    the other leads do; otherwise **ready**, in line for its sender, with no instant promised.
 * A call: `callPlacedFrom` (`readyCalls`) and `callRoom`, then for an open task the listing rule (`isListed`).
 * Null when the track has no pending step with a due time.
 */
export function stepWhen(state: SubjectState, trackId: string, now: number, env: StepEnv = {}): StepWhen | null {
  const p = progressOf(state, trackId);
  const awaiting = p !== undefined && p.nextStepId !== null && awaitingAcceptance(state, trackId);
  if (!p || p.startedAt === null || p.finishedAt !== null || p.nextStepId === null || (p.dueAt === null && !awaiting)) return null;
  const waits = (why: StepWait): StepWhen => ({ kind: "waits", why });
  const { subject, campaign } = state;
  // Every hold first, with no time: a frozen clock has no end date (ADR 0003 "Reads that say when"; review bot on 194fc44).
  if (subject.ended !== null) return waits("ended");
  if (!campaignLets(state)) return waits(campaign.pausedSince !== null ? "campaign_paused" : "campaign_not_launched");
  if (subject.leadPaused) return waits("lead_paused");
  if (callbackHold(state)) return waits("callback");
  if (!runs(state)) return waits("ended");
  // Waiting for acceptance (ADR 0004 9): the day the wait ends is the engine's own deadline on the lead's running clock now.
  if (awaiting) return p.acceptBy != null ? { kind: "waits", why: "awaiting_acceptance", until: now + (p.acceptBy - leadNow(state.subject.clock, now)) } : waits("awaiting_acceptance");
  const stepId = p.nextStepId;
  const channel = channelOf(state, trackId);
  if (channel === "call") return callWhen(state, trackId, stepId, now, env);
  if (channel !== "email" && channel !== "sms" && channel !== "linkedin") return null;
  // 1. A held track first (5.4): work the provider has not confirmed holds the track with a live attempt too.
  const hold = trackHold(state, trackId);
  if (hold) return waits(holdWait(hold));
  const live = state.attempts.find((a) => a.stepId === stepId && isLive(a));
  if (live && live.state !== "claimed") return waits("with_provider");
  const threading = stepDef(state, trackId, stepId)?.threading ?? "new_subject";
  if (env.transportAvailable && !env.transportAvailable(channel, threading)) return { kind: "waits", why: "no_transport", channel };
  if (env.waitingOnProvider?.(state, trackId) === true) return waits("waiting_on_provider");
  // 2. Time alone: the wait's end and the window, nothing about senders but what the engine knows rules every one out.
  const opens = sendableFrom(state, trackId, now);
  if (opens === null) return waits("no_window");
  if (opens > now) return leadWait(state, trackId, stepId) ?? noSenderKnown(state, trackId, now) ?? { kind: "at", at: opens };
  // 3. Its time has come. Every hold keeps its own reason (review bot on cc9bf55), then the per-step checks.
  if (!live) {
    const held = heldReason(state, trackId, now);
    if (held) return waits(holdWait(held));
    return unclaimedWhen(state, trackId, stepId, now);
  }
  const account = state.accounts[live.accountId];
  const expired = now - live.claimedWall >= ENGINE_PARAMS.SETTLING;
  if (account && !expired) {
    const failed = handoverFailures(state, live, account, now).filter((f) => f !== 14);
    if (failed.length === 0) return { kind: "ready" };
    // The engine examines no claim on an account whose slot is not reached, and a slot only moves later.
    if (failed.includes(16)) return waits("sender_slot");
    // A reply awaiting its thread keeps the claim, as `tryHandover` does.
    if (failed.every((f) => f === 18)) return waits("reply_pending");
  }
  // At this instant the engine expires the claim, or withdraws it on its failed predicates, and claims the step again.
  const event = expired ? ({ kind: "claim_expired", now } as const) : ({ kind: "guard_failed" } as const);
  return unclaimedWhen(releasedBy(state, applyToAttempt(state, live.id, event, now).state), trackId, stepId, now);
}

/** An unclaimed step whose time has come: the claim's step guard, then the account choice, from this subject's state. */
function unclaimedWhen(state: SubjectState, trackId: string, stepId: string, now: number): StepWhen {
  const refusal = claimRefusal(state, { trackId, stepId }, now);
  if (refusal !== null) return { kind: "waits", why: refusalWait(refusal) };
  const inmail = inmailUnavailable(state, trackId, now);
  if (inmail !== null) return { kind: "waits", why: "inmail_unavailable", inmail: inmail.cause, reportedAt: inmail.reportedAt };
  const destination = destinationOf(state, trackId);
  const candidates = candidatesOf(state, trackId, now);
  // Predicate 18 on every sender it may use: whichever the claim takes, the handover waits.
  if (candidates.length > 0 && candidates.every((a) => replyPending(state, a.id, destination))) return { kind: "waits", why: "reply_pending" };
  if (chooseAccount(state, now, stepId)) return { kind: "ready" };
  const why = senderWait(state, trackId, stepId, now);
  return why === null ? { kind: "ready" } : { kind: "waits", why };
}

/**
 * The accounts the track's pending step may be claimed on, each as its kind of action sees it, as `chooseAccount` reads
 * them: the fixed sender or the pool, less the pairs another subject holds, and for an invite only the sessions whose
 * connection check answered clear (ADR 0004 6). Every read that explains a sender-side wait derives from this and from
 * nothing else (ticket 24b; review bot on a6c1700).
 */
export function eligibleSessions(state: SubjectState, trackId: string, now: number): AccountState[] {
  return candidatesOf(state, trackId, now);
}

/** The candidate accounts of the track's channel, as `chooseAccount` reads them. */
function candidatesOf(state: SubjectState, trackId: string, now: number): AccountState[] {
  const channel = channelOf(state, trackId);
  const action = actionOfPending(state, trackId);
  const p = progressOf(state, trackId);
  const inherited = p?.nextStepId ? (inheritedWork(state, p.nextStepId)?.accountId ?? null) : null;
  return sessionsFor(state, trackId, action, now, inherited)
    .map((id) => state.accounts[id])
    .filter((a): a is AccountState => a !== undefined && a.channel === channel)
    .map((a) => forAction(a, action));
}

/**
 * The accounts a step may be claimed on: its track's candidates, and for an invite only the sessions whose connection check
 * answered clear (review bot on e261ffa), with the account an inherited claim already holds.
 */
function sessionsFor(state: SubjectState, trackId: string, action: SocialAction | null, now: number, inherited: string | null): string[] {
  const ids = candidatesFor(state, trackId);
  // An InMail goes only from the track's own session while it is eligible by its own report (ADR 0004 13.5): the one
  // selection every read of why an InMail is not going derives from. An inherited claim already holds its credit.
  if (action === "inmail") return inmailBacking(state, trackId, now) === "backed" ? ids : [];
  if (action !== "invite") return ids;
  const clear = inviteSessions(state, trackId, ids, now);
  return inherited !== null && ids.includes(inherited) && !clear.includes(inherited) ? [...clear, inherited] : clear;
}

/**
 * Why the track's pending InMail cannot go now (ADR 0004 13.5), by the one backing function `sessionsFor` and the handover
 * read: no plan, a report too old, no credit held (a restart waiting for one to be free), or a credit held that the report no
 * longer backs. With the instant of the session's latest report, which every sentence of it says. Null when it may go, or
 * the pending step is not an InMail, or its work may already have gone (the handover is not asked again).
 */
export function inmailUnavailable(state: SubjectState, trackId: string, now: number): { readonly cause: InmailWait; readonly reportedAt: number | null } | null {
  if (actionOfPending(state, trackId) !== "inmail") return null;
  const p = progressOf(state, trackId);
  if (p?.nextStepId && inheritedWork(state, p.nextStepId)) return null;
  const backing = inmailBacking(state, trackId, now);
  if (backing === "backed") return null;
  const session = p?.inmailSession ?? linkedinSessionOf(state);
  return { cause: backing, reportedAt: session === null ? null : (state.accounts[session]?.inmail?.reportedWall ?? null) };
}

/** Why an InMail waits (13.5): the backing function's every answer but "backed". */
export type InmailWait = "no_plan" | "stale_report" | "no_holding" | "unbacked";

/** The social action of a track's pending step (ADR 0004 6), or null for email and SMS. */
function actionOfPending(state: SubjectState, trackId: string): SocialAction | null {
  const p = progressOf(state, trackId);
  return p?.nextStepId ? actionOfStep(state, trackId, p.nextStepId) : null;
}

/** The social action a step's handover asks for: the allowance it counts on (ADR 0004 2.1, 6). Null for email and SMS. */
export function actionOfStep(state: SubjectState, trackId: string, stepId: string): SocialAction | null {
  const track = state.campaign.definition.tracks.find((t) => t.id === trackId);
  return track ? socialActionOf(linkedinStepKind(track, stepId)) : null;
}

/**
 * A social account as one kind of action sees it (ADR 0004 6): its capacity, daily limit and use are that kind's allowance,
 * so `pickAccount`, `accountHasRoom` and the reads' sender causes judge the kind's room unchanged. Email and SMS accounts,
 * and a step with no action, are the account itself.
 */
export function forAction(account: AccountState, action: SocialAction | null): AccountState {
  if (action === null || !account.kinds) return account;
  const bucket = account.kinds[allowanceOf(action)];
  // Reservations are the account's, of every kind; a kind's own reserved count is not kept, so its sent part is its use
  // less its share of reservations, which `senderWait` reads only as "full by sends alone": never below zero.
  return { ...account, capacity: bucket.capacity, dailyLimit: bucket.capacity, used: bucket.used, reserved: Math.min(account.reserved, bucket.used) };
}

/** The address or mobile a step of the track goes to, as the claim writes it. */
function destinationOf(state: SubjectState, trackId: string): string {
  const p = progressOf(state, trackId);
  const d = state.lead.details.find((x) => x.id === state.lead.resolved[p?.destinationDetailId ?? ""]?.liveId);
  const channel = channelOf(state, trackId);
  return (channel === "sms" || channel === "linkedin" ? d?.key : d?.value) ?? "";
}

/** A claim's step guard on the lead alone: a destination that is not a good address, copy that does not render, no thread. */
function leadWait(state: SubjectState, trackId: string, stepId: string): { kind: "waits"; why: StepWait } | null {
  const p = progressOf(state, trackId);
  const dest = p?.destinationDetailId ? state.lead.resolved[p.destinationDetailId] : undefined;
  if (!dest || dest.bad || !dest.owned) return { kind: "waits", why: "no_destination" };
  if (!renderStep(state, trackId, stepId)) return { kind: "waits", why: "render_failed" };
  if (lacksThread(state, trackId, stepId)) return { kind: "waits", why: "no_thread" };
  return null;
}

/**
 * A LinkedIn step that every session it may use allows none of, of its kind of action (ADR 0004 4, item 6): the user's
 * allowance is zero or never set, so no reset brings room. The one test `stepWhen` and the reads share (ticket 24b, item 15).
 */
export function noAllowanceOnAnySession(state: SubjectState, trackId: string, now: number): boolean {
  if (channelOf(state, trackId) !== "linkedin") return false;
  const sessions = candidatesOf(state, trackId, now);
  return sessions.length > 0 && sessions.every((a) => a.dailyLimit <= 0);
}

/** What the engine knows at the read rules out every sender for the step: none connected, or every daily limit zero. */
function noSenderKnown(state: SubjectState, trackId: string, now: number): { kind: "waits"; why: StepWait; inmail?: InmailWait; reportedAt?: number | null } | null {
  const channel = channelOf(state, trackId) ?? "email";
  // A LinkedIn step: every session it may use allows none of its kind of action, the user's setting (ADR 0004 4, item 6).
  if (channel === "linkedin") {
    const inmail = inmailUnavailable(state, trackId, now);
    if (inmail !== null) return { kind: "waits", why: "inmail_unavailable", inmail: inmail.cause, reportedAt: inmail.reportedAt };
    return noAllowanceOnAnySession(state, trackId, now) ? { kind: "waits", why: "sending_capacity" } : null;
  }
  if (channel !== "email" && channel !== "sms") return null;
  const fixed = senderOf(state, channel);
  const ids = fixed !== null ? [fixed] : [...poolOf(state.campaign.definition, channel)];
  const connected = ids.map((id) => state.accounts[id]).filter((a): a is AccountState => a !== undefined && a.channel === channel && a.problem !== "not_listed");
  if (connected.length === 0) return { kind: "waits", why: "sender_unavailable" };
  if (connected.every((a) => a.dailyLimit <= 0)) return { kind: "waits", why: "sending_capacity" };
  return null;
}

/**
 * `after` with the reservations its withdrawals free (4.2): a claimed attempt withdrawn before any call settles its work,
 * and the store then releases that account's place and reservation. A read of a state a transition produces (a control's
 * preview, a claim the engine withdraws at the read's instant) sees each account as the store would report it then
 * (council on cc9bf55, item 8).
 */
export function releasedBy(before: SubjectState, after: SubjectState): SubjectState {
  let accounts = after.accounts;
  for (const w of after.work) {
    const was = before.work.find((x) => x.key === w.key);
    if (!was || was.settled !== null || w.settled === null || w.calls > 0) continue;
    const a = accounts[w.accountId];
    if (a) accounts = { ...accounts, [a.id]: { ...a, used: Math.max(0, a.used - 1), reserved: Math.max(0, a.reserved - 1), inFlight: Math.max(0, a.inFlight - 1) } };
  }
  return accounts === after.accounts ? after : { ...after, accounts };
}

/** Why the claim's step guard refused the step, as a read says it. */
function refusalWait(refusal: string): StepWait {
  if (refusal === "the destination is not a good address of the lead") return "no_destination";
  if (refusal === "the copy does not render for this lead") return "render_failed";
  if (refusal === "there is no thread to continue") return "no_thread";
  if (refusal === "the sending window is closed" || refusal === "the step is not due") return "no_window";
  return "sender_waiting";
}

/**
 * Why no candidate sender can take the step at `now` whatever the other leads do, or null when one might: each candidate is
 * unavailable (not healthy), held by a provider's wait (a rate limit, a quota), or full today by its sends alone (its open
 * reservations aside, which another lead's withdrawn claim can free). The cause they share, else the general sentence.
 */
export function senderWait(state: SubjectState, trackId: string, stepId: string, now: number): StepWait | null {
  const reserved = inheritedWork(state, stepId)?.accountId ?? null;
  const candidates = candidatesOf(state, trackId, now);
  if (candidates.length === 0) return "sender_unavailable";
  const causes: StepWait[] = [];
  for (const a of candidates) {
    if (!a.healthy) causes.push("sender_unavailable");
    else if (a.waitUntil !== null && now < a.waitUntil) causes.push(a.waitReason === "rate_limited" ? "sender_rate_limited" : "sender_unavailable");
    else if (reserved !== a.id && a.used - a.reserved >= a.capacity) causes.push("sending_capacity");
    else return null;
  }
  const kinds = new Set(causes);
  const [only] = kinds;
  return kinds.size === 1 && only !== undefined ? only : "sender_waiting";
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
  if (day > state.callDay.day && env.callRoomOn?.(day, state) === false) return { kind: "waits", why: "call_capacity" };
  return { kind: "call_day", at, day };
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
  const action = stepId === null ? null : actionOfStep(state, trackId, stepId);
  const inherited = stepId === null ? undefined : inheritedWork(state, stepId);
  const candidates = sessionsFor(state, trackId, action, now, inherited?.accountId ?? null)
    .map((id) => state.accounts[id])
    .filter((a) => a?.channel === channel)
    .map((a) => (a ? forAction(a, action) : a));
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
  const channel = channelOf(state, item.trackId);
  const sms = channel === "sms";
  const action = actionOfStep(state, item.trackId, item.stepId);
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
    // A text goes to the mobile's E.164 form, a LinkedIn step to the profile's key; an email to the address as written.
    destination: (sms || channel === "linkedin" ? destination?.key : destination?.value) ?? "",
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
    ...(action !== null ? { action } : {}),
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
    ...(action !== null ? { kind: allowanceOf(action), note: null } : {}),
    // An InMail spends a credit too (ADR 0004 13.5): known as one from its claim.
    ...(action === "inmail" ? { inmail: true } : {}),
  };
  // For a social action, the account as stored (a kind's view is only for choosing): its total use, and its kind's too.
  const base = action !== null ? (state.accounts[account.id] ?? account) : account;
  const added = inherited ? 0 : 1;
  const bucket = action !== null ? allowanceOf(action) : null;
  const kinds = base.kinds && bucket !== null ? { ...base.kinds, [bucket]: { ...base.kinds[bucket], used: base.kinds[bucket].used + added } } : base.kinds;
  return {
    ...state,
    attempts: [...state.attempts, attempt],
    work: inherited ? state.work : [...state.work, work],
    accounts: { ...state.accounts, [account.id]: { ...base, used: base.used + added, inFlight: base.inFlight + added, ...(kinds ? { kinds } : {}) } },
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
  // 11. For a channel of conversations (SMS, LinkedIn), the pair is unbound, or bound to this subject.
  if (holdsConversations(channel) && !pairFree(state, account.id, attempt.destination, channel)) failed.push(11);
  if (!presendFresh(attempt, now)) failed.push(14);
  if (!renderStep(state, attempt.trackId, attempt.stepId)) failed.push(5);
  if (lacksThread(state, attempt.trackId, attempt.stepId)) failed.push(17);
  // 19. A LinkedIn message only once the track is connected (ADR 0004 3.2), checked again in the write that authorizes it.
  const track = state.campaign.definition.tracks.find((t) => t.id === attempt.trackId);
  const progress = progressOf(state, attempt.trackId);
  if (track && progress && gateRules.connectionGate(track, attempt.stepId, progress)) failed.push(19);
  // 20. An InMail only while the credit it holds is backed by the session's latest report and plan, read in this transaction
  // (ADR 0004 13.5; council on 8b0c846, item 8): a report of zero or a plan lost after the claim stops it here.
  if (attempt.action === "inmail" && gateRules.handoverRechecksBacking && inmailBacking(state, attempt.trackId, now) !== "backed") failed.push(20);
  if (now < account.nextSlotAt) failed.push(16);
  return [...new Set(failed)].sort((a, b) => a - b);
}

/**
 * The handover write (5.5 step 4): renders the copy, takes the pacing slot, fixes the sender,
 * and records the call before it is made.
 */
export function handOver(state: SubjectState, attempt: Attempt, account: AccountState, now: number): SubjectState {
  const rendered = renderStep(state, attempt.trackId, attempt.stepId);
  const base = attempt.action !== undefined ? (state.accounts[account.id] ?? account) : account;
  // An invite's note goes while the sender's note allowance lasts, decided here once and stored (ADR 0004 section 4).
  const note = noteFor(state, attempt, base);
  const copy = rendered && note === "withheld" ? { ...rendered, body: "" } : rendered;
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
  const channel = channelOf(state, attempt.trackId);
  const sms = channel === "sms";
  const binds = holdsConversations(channel) && !state.smsBindings.some((b) => b.sender === account.id && b.recipient === attempt.destination);
  const subject =
    channel === "linkedin"
      ? { ...state.subject, linkedinSender: state.subject.linkedinSender ?? account.id }
      : sms
        ? { ...state.subject, smsSender: state.subject.smsSender ?? account.id }
        : { ...state.subject, emailSender: state.subject.emailSender ?? account.id };
  const notes = note === "with" && base.notes ? { notes: { ...base.notes, used: base.notes.used + 1 } } : {};
  return {
    ...state,
    subject,
    smsBindings: binds ? [...state.smsBindings, { sender: account.id, recipient: attempt.destination, owner: state.subject.id, ownerCampaignId: state.campaign.id, ownerCampaignName: null, ownerIsTest: state.subject.kind === "test_run", ownerEnded: false, ownerSent: false, ownerAnswered: false, channel: channel === "linkedin" ? "linkedin" : "sms" }] : state.smsBindings,
    attempts: state.attempts.map((a) => (a.id === attempt.id ? handed : a)),
    work: state.work.map((w) => (w.key === attempt.idempotencyKey ? { ...w, calls: w.calls + 1, firstHandedWall: w.firstHandedWall ?? now, unresolvedSince: null, ...(note !== null ? { note } : {}) } : w)),
    accounts: { ...state.accounts, [account.id]: { ...base, nextSlotAt: now + base.gapMs, ...notes } },
  };
}

/**
 * Whether an invite carries its note (ADR 0004 section 4): `with` when its rendered note is not empty and the sender's notes
 * used this month are below its note allowance; `withheld` when the note is not empty and the allowance is used; `none` for
 * an empty note. Null for any other step. Decided in the handover transaction, once: a retry or a lookup never re-decides it.
 */
export function noteFor(state: SubjectState, attempt: Attempt, account: AccountState): "with" | "withheld" | "none" | null {
  if (actionOfStep(state, attempt.trackId, attempt.stepId) !== "invite") return null;
  const decided = state.work.find((w) => w.key === attempt.idempotencyKey)?.note ?? null;
  if (decided !== null) return decided;
  const rendered = renderStep(state, attempt.trackId, attempt.stepId);
  if (!rendered || rendered.body.trim() === "") return "none";
  const notes = account.notes ?? { capacity: 0, used: 0 };
  return notes.used < notes.capacity ? "with" : "withheld";
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
