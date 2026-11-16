import { currentStep, previewDigest } from "../../src/domain/sequence/controls.ts";
import { leadNow } from "../../src/domain/sequence/clock.ts";
import { candidatesFor } from "../../src/domain/sequence/dispatch.ts";
import { channelOf, progressOf } from "../../src/domain/sequence/progress.ts";
import { storedReplyId, type StoredReplyId } from "../../src/domain/sequence/reply-identity.ts";
import type { SubjectState } from "../../src/domain/sequence/state.ts";
import { DEFAULT_RULES, type Rules } from "../../src/server/engine/rules.ts";
import type { ControlRunOptions } from "./generated-controls.ts";

/**
 * Deliberately broken controls (ADR 0003 9.2 step 5, "Ticket 17a"): each replaces one transition; the generated
 * control runs (generated-controls.ts) must fail the invariant it names, on its recorded seed in `pnpm check`.
 * P7 (request ids), P10 (one lead per transaction), P11 (the read and the action share `applyControl`) and P12
 * (the committed-call count) are held in the store and the routes, not in a rule a mutation can swap: example
 * tests guard them (`src/server/engine/controls.test.ts`).
 */

const R = DEFAULT_RULES;
const frozenAsBefore = (before: SubjectState, after: SubjectState): SubjectState => ({ ...after, subject: { ...after.subject, clock: before.subject.clock }, freezes: before.freezes });

const RULES: Record<string, Partial<Rules>> = {
  "a lead pause holds nothing": {
    applyControl: (s, action, now) => (action === "pause" && s.subject.ended === null && !s.subject.leadPaused && s.campaign.launchedAt !== null ? { ok: true, state: s } : R.applyControl(s, action, now)),
  },
  "skip skips two steps": {
    applyControl: (s, action, now) => {
      const out = R.applyControl(s, action, now);
      if (!out.ok || action !== "skip") return out;
      const again = R.applyControl(out.state, "skip", now);
      return again.ok ? again : out;
    },
  },
  "a skipped step is sent all the same": {
    applyControl: (s, action, now) => {
      const out = R.applyControl(s, action, now);
      if (!out.ok || action !== "skip") return out;
      // The skip records nothing: the step stays pending, and is claimed and sent.
      const step = currentStep(s);
      return step && step.track.channel !== "call" ? { ok: true, state: s } : out;
    },
  },
  "stop leaves the clock running": {
    applyControl: (s, action, now) => {
      const out = R.applyControl(s, action, now);
      return out.ok && action === "stop" ? { ok: true, state: frozenAsBefore(s, out.state) } : out;
    },
  },
  "a restart keeps the ending's clock frozen": {
    applyControl: (s, action, now) => {
      const out = R.applyControl(s, action, now);
      return out.ok && action === "resume_from_next_step" ? { ok: true, state: frozenAsBefore(s, out.state) } : out;
    },
  },
  "move to win-back keeps the main sequence": {
    applyControl: (s, action, now) => (action === "move_to_win_back" && s.subject.branch === "main" && (s.subject.ended === "replied" || s.subject.ended === "stopped_manually") && s.campaign.definition.tracks.some((t) => t.branch === "win_back") ? R.applyControl(s, "resume_from_next_step", now) : R.applyControl(s, action, now)),
  },
  "resuming a lead releases its campaign's pause": {
    applyControl: (s, action, now) => (action === "resume" ? R.applyControl({ ...s, campaign: { ...s.campaign, pausedSince: null } }, action, now) : R.applyControl(s, action, now)),
  },
  // After the review bot and the verifier on ca8baee: one per rule they found broken.
  "skip ignores provider work withdrawn on a non-final not-sent": {
    applyControl: (s, action, now) => {
      if (action !== "skip") return R.applyControl(s, action, now);
      // Judged as if called work no live attempt carries had settled: the rule before the fix.
      const carried = (key: string) => s.attempts.some((a) => a.idempotencyKey === key && a.state !== "withdrawn" && a.state !== "sent" && a.state !== "rejected");
      const out = R.applyControl({ ...s, work: s.work.map((w) => (w.settled === null && w.calls > 0 && !carried(w.key) ? { ...w, settled: "not_sent" as const } : w)) }, action, now);
      return out.ok ? { ok: true, state: { ...out.state, work: out.state.work.map((w) => s.work.find((x) => x.key === w.key && x.settled === null && w.settled === "not_sent") ?? w) } } : out;
    },
  },
  "a control's preview skips what fell due": {
    previewAsOf: (s) => s,
  },
  "a refused request runs when sent again": {
    requestStanding: (stored, request) => (stored === null || stored.answer === "refused" ? "new" : R.requestStanding(stored, request)),
  },
  // Pacing is held twice by construction (the slot taken in the handover transaction, and moved after the call), so no
  // one rule removes it: this runs the engine with a one-second gap while the record expects five minutes (options below).
  "the pacing gap ignored": {},
  // P8 (council D3 on 56d599c): a send the provider made while the lead was held counts from its wall instant, not from
  // where the lead's clock stood, so its successor is due early.
  "a late send after a pause resolves its successor on the wall clock": {
    sendPoint: (clock, freezes, providerTime, handedWall, now) => {
      const real = R.sendPoint(clock, freezes, providerTime, handedWall, now);
      const t = Math.min(Math.max(providerTime, handedWall), now);
      return { at: real.at - (t - real.atWall), atWall: t };
    },
  },
  // Council C on 56d599c: the order 18's free hour stood for.
  "the order breaks after a hold is released": {
    readyItems: (s, now) => {
      const released = s.freezes.some((f) => f.toWall !== null && f.toWall > f.fromWall && now - f.toWall < 2 * 3_600_000);
      // A lead released from a hold within two hours ranks after everything else due: its items wait behind newer ones.
      return R.readyItems(s, now).map((item) => (released ? { ...item, dueWall: now + 30 * 24 * 3_600_000, touched: false } : item));
    },
  },
  "an overdue lead passed over while others are served": {
    claimOrder: (a, b) => (a.touched === b.touched && a.dueWall !== b.dueWall ? b.dueWall - a.dueWall : R.claimOrder(a, b)),
  },
  // Council on 56d599c, items A and B.
  "a withdrawal's retries stop when its attempt retires": {
    withdrawalDue: (w, now, carried) => carried === true && R.withdrawalDue(w, now, carried),
  },
  // The in-flight count is the store's (options below): it counts live attempts, as before the fix.
  "the in-flight bound counts live attempts": {},
  "a finally-settled place stays occupied": {},
  "a withdrawn text keeps its place": {},
  // Ticket 17b (coordinator's ruling on the verifier's B1 at 8a1732a): a control applies on whatever the lead is now,
  // not on what its confirmation showed, so a Skip confirmed on one step skips another.
  "a control applied after its precondition changed": {
    controlPrecondition: () => null,
  },
  // The search on 54f3a73: the precondition judged before the action's own rule, so a request on an ended lead is refused
  // with another reason than its read gives (P11).
  "the precondition checked before the lead's state": {
    judgeControl: (stored, before, action, now, expected, rules) => {
      const out = rules.applyControl(before, action, now);
      const changed = rules.controlPrecondition(stored, before, action, out.ok ? out.state : null, expected);
      return changed !== null ? { ok: false, reason: changed } : out;
    },
  },
  // Verifier R1 on 57d874f: the precondition as it was before it became the whole preview, the status alone.
  "the precondition checks only the status": {
    controlPrecondition: (stored, before, action, after, expected) => R.controlPrecondition(stored, before, action, after, expected === null ? null : { ...expected, preview: after ? previewDigest(before, action, after) : expected.preview }),
  },
  // Council on 57d874f, item 1: the client re-targets an open confirmation on the newest read (the run option below).
  "a confirmation sends the click-time expectation": {},
  // The reply identity rule (ticket 22's runs, seed 22058): the pre-send check asks the SMS port by the stored `sms:<id>`,
  // which the port never names a text by, so the text a lead was resumed after looks new and stops it again.
  "the pre-send check compares a stored text's id with the provider's": {
    portReplyId: (_channel, storedId) => storedId,
  },
  "a reply the record holds clears the pre-send check": {
    presendAnswer: (answer, channel, known) => (answer.kind === "reply" && known.includes(storedReplyId(channel, answer.providerRef)) ? { kind: "clear" as const } : R.presendAnswer(answer, channel, known)),
  },
  // Council on PR 62: a pre-send answer recorded under the port's bare id, not `storedReplyId` (the cast stands for the
  // write site that skipped it, which the brand otherwise refuses). For a text, the provider's id without `sms:`.
  "a pre-send text answer stored under the provider's id": {
    presendAnswer: (answer, channel, known) => (channel === "sms" && answer.kind === "reply" ? { ...answer, providerRef: answer.providerRef as StoredReplyId } : R.presendAnswer(answer, channel, known)),
  },
  // For an email, the provider's message id without `reply:`, as the adapter answered before ticket 17a (cb31184).
  "a pre-send email answer stored under the provider's message id": {
    presendAnswer: (answer, channel, known) => (channel === "email" && answer.kind === "reply" ? { ...answer, providerRef: answer.providerRef.replace(/^reply:/, "") as StoredReplyId } : R.presendAnswer(answer, channel, known)),
  },
  // ADR 0003 1.3 (ruling 6) broken in the engine: a user's Skip touches the lead, so its follow-ups rank before first
  // messages to leads nothing was ever sent to (invariant 18's order).
  "a skipped step counts as touching the lead": {
    applyControl: (s, action, now) => {
      const out = R.applyControl(s, action, now);
      return out.ok && action === "skip" ? { ok: true, state: { ...out.state, subject: { ...out.state.subject, touched: true } } } : out;
    },
  },
  // ADR 0003 "Reads that say when", the redesign after ff01571: a pool whose candidates wait for different causes reads the
  // full inbox's reason, which is not true of every candidate it speaks for.
  "a mixed pool reads the full sender's reason": {
    stepWhen: (s, trackId, now, env) => {
      const when = R.stepWhen(s, trackId, now, env);
      if (when?.kind !== "waits" || when.why !== "sender_waiting") return when;
      const pool = candidatesFor(s, trackId).map((id) => s.accounts[id]).filter((a) => a !== undefined);
      return pool.some((a) => a.used >= a.capacity) ? { kind: "waits", why: "sending_capacity" } : when;
    },
  },

  // Rule 3 broken (the coordinator on 712884b): a claim whose own slot is not reached reads "ready", though the engine
  // cannot hand it over at that instant.
  "a claimed step whose slot is not reached reads ready": {
    stepWhen: (s, trackId, now, env) => {
      const when = R.stepWhen(s, trackId, now, env);
      return when?.kind === "waits" && when.why === "sender_slot" ? { kind: "ready" } : when;
    },
  },
  // ADR 0003 "Reads that say when", rule 3 (the coordinator on ab6fe8e): a held step's reason replaced by "ready".
  "a held step reads ready": {
    stepWhen: (s, trackId, now, env) => {
      const when = R.stepWhen(s, trackId, now, env);
      const held = ["campaign_paused", "lead_paused", "callback", "unresolved", "render_failed", "provider_skipped", "no_thread", "sms_conversation_unsettled"];
      return when?.kind === "waits" && held.includes(when.why) ? { kind: "ready" } : when;
    },
  },
  // Rule 2 broken: a step waiting for its window reads ready.
  "a step outside its window reads ready": {
    stepWhen: (s, trackId, now, env) => {
      const when = R.stepWhen(s, trackId, now, env);
      return when?.kind === "at" ? { kind: "ready" } : when;
    },
  },
  // Rule 3 broken: every sender full by its sends, and the read says ready.
  "a step whose every sender is full reads ready": {
    stepWhen: (s, trackId, now, env) => {
      const when = R.stepWhen(s, trackId, now, env);
      return when?.kind === "waits" && when.why === "sending_capacity" ? { kind: "ready" } : when;
    },
  },
  // Rule 3 broken: a ready step is given an instant (a minute on), which no read may promise.
  "a ready step is given a time": {
    stepWhen: (s, trackId, now, env) => {
      const when = R.stepWhen(s, trackId, now, env);
      return when?.kind === "ready" ? { kind: "at", at: now + 60_000 } : when;
    },
  },
  // Council on cc9bf55, item 7: the controls' preview of the next step gives the wait's end, while the read gives the truth.
  "a preview's time is the wait's end": {
    previewStepWhen: (s, trackId, now, env) => {
      const when = R.stepWhen(s, trackId, now, env);
      const p = progressOf(s, trackId);
      const channel = channelOf(s, trackId);
      if (when?.kind !== "at" || !p || p.dueAt === null || (channel !== "email" && channel !== "sms")) return when;
      return { kind: "at", at: now + Math.max(0, p.dueAt - leadNow(s.subject.clock, now)) };
    },
  },
  // Ticket 23's defect 2 restored in the read alone: an email or text waiting on time reads its wait's end (now, once it has
  // passed), not the first instant its window is open after it.
  "an earliest instant ignores the window": {
    stepWhen: (s, trackId, now, env) => {
      const when = R.stepWhen(s, trackId, now, env);
      const p = progressOf(s, trackId);
      const channel = channelOf(s, trackId);
      if (when?.kind !== "at" || !p || p.dueAt === null || (channel !== "email" && channel !== "sms")) return when;
      return { kind: "at", at: now + Math.max(0, p.dueAt - leadNow(s.subject.clock, now)) };
    },
  },
};

/** The invariant each mutation must break, and the seed offset known to show it (refreshed by the CI search). */
const EXPECTED: Record<string, { invariant: string; seed: number; options?: Partial<ControlRunOptions> }> = {
  "a lead pause holds nothing": { invariant: "P9", seed: 1 },
  "skip skips two steps": { invariant: "P11", seed: 0 },
  "a skipped step is sent all the same": { invariant: "P4", seed: 18 },
  "stop leaves the clock running": { invariant: "P9", seed: 0 },
  // "a restart rewinds to the track's first step" (P6, seen as P2, under which it was recorded) is retired since ticket 19: `alignPending`, which every evaluation and
  // settlement runs, re-derives a pending step that names a step already resolved, so no rule swap of `applyControl` can
  // rewind a lead. `reconcile.test.ts` "a pending step pointed back at a sent step is brought forward again" guards it.
  "a restart keeps the ending's clock frozen": { invariant: "P9", seed: 0 },
  "move to win-back keeps the main sequence": { invariant: "status", seed: 0 },
  "resuming a lead releases its campaign's pause": { invariant: "P9", seed: 4 },
  "skip ignores provider work withdrawn on a non-final not-sent": { invariant: "P11", seed: 1 },
  "a control's preview skips what fell due": { invariant: "P11", seed: 20 },
  "a refused request runs when sent again": { invariant: "P7", seed: 2 },
  "the pacing gap ignored": { invariant: "P3", seed: 0, options: { gapMs: 1000 } },
  // Re-chosen in ticket 17b (seed 12 before): the stale-confirmation stream's refused requests move the runs' interleaving.
  "a late send after a pause resolves its successor on the wall clock": { invariant: "P2", seed: 20 },
  "the order breaks after a hold is released": { invariant: "18", seed: 33 },
  "an overdue lead passed over while others are served": { invariant: "18", seed: 13 },
  "a withdrawal's retries stop when its attempt retires": { invariant: "A", seed: 1 },
  "the in-flight bound counts live attempts": { invariant: "B", seed: 2, options: { occupancyCountsAttempts: true } },
  // Review bot on 612aa05: a live attempt whose work has a final answer (too late, send time unknown) keeps its place.
  "a finally-settled place stays occupied": { invariant: "F", seed: 0, options: { occupancyKeepsSettled: true } },
  // Verifier R2-2 on 612aa05: each text confirmed withdrawn keeps its number's place for good.
  "a withdrawn text keeps its place": { invariant: "F", seed: 35, options: { occupancyKeepsWithdrawnTexts: true } },
  // With the provider answering the first thread's reply, as the adapter did on ca8baee: the defect restored.
  "a reply the record holds clears the pre-send check": { invariant: "P1", seed: 24, options: { presendFirstReply: true } },
  "a control applied after its precondition changed": { invariant: "P13", seed: 0 },
  // The scripted SMS reply run: the lead resumed after its text is ended again at its next text's check.
  "the pre-send check compares a stored text's id with the provider's": { invariant: "P6", seed: 0, options: { smsReplyRestart: true } },
  // The scripted runs of a reply the pre-send check finds before its observation: the late observation is a second reply.
  "a pre-send text answer stored under the provider's id": { invariant: "once", seed: 0, options: { replyBeforeObservation: "sms" } },
  "a pre-send email answer stored under the provider's message id": { invariant: "once", seed: 0, options: { replyBeforeObservation: "email" } },
  // Seed 17 since the precondition became the whole preview (verifier R1 on 57d874f): the stale-confirmation stream sends a
  // Skip to a lead that ended since its read, and the read's reason must be the action's (seed 85 found the order first).
  "the precondition checked before the lead's state": { invariant: "P11", seed: 17 },
  "the precondition checks only the status": { invariant: "P13", seed: 0 },
  "a confirmation sends the click-time expectation": { invariant: "P13", seed: 0, options: { clickTimeExpectation: true } },
  // ADR 0003 "Reads that say when": the windows family, in which the record models windows, zones and outages (W1 to W3).
  "a skipped step counts as touching the lead": { invariant: "18", seed: 9 },
  "a mixed pool reads the full sender's reason": { invariant: "W2", seed: 110, options: { windows: true } },
  "a claimed step whose slot is not reached reads ready": { invariant: "W3", seed: 1, options: { windows: true } },
  "a held step reads ready": { invariant: "W1", seed: 1, options: { windows: true } },
  "a step outside its window reads ready": { invariant: "W2", seed: 0, options: { windows: true } },
  "a step whose every sender is full reads ready": { invariant: "W2", seed: 21, options: { windows: true } },
  "a ready step is given a time": { invariant: "W2", seed: 1, options: { windows: true } },
  "an earliest instant ignores the window": { invariant: "W2", seed: 0, options: { windows: true } },
  "a preview's time is the wait's end": { invariant: "W4", seed: 0, options: { windows: true } },
};

export const CONTROL_MUTATIONS: Record<string, { readonly rules: Partial<Rules>; readonly invariant: string; readonly seed: number; readonly options?: Partial<ControlRunOptions> }> = Object.fromEntries(
  Object.entries(EXPECTED).map(([name, e]) => {
    const rules = RULES[name];
    if (!rules) throw new Error(`no mutation named ${name}`);
    return [name, { rules, ...e }];
  }),
);
