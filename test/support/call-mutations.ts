import { callbackDay, REDIAL_OUTCOMES } from "../../src/domain/sequence/calls.ts";
import { evaluate, finishTrack, progressOf, runs, synced } from "../../src/domain/sequence/progress.ts";
import { leadNow, localDayNumber, span, wallOfLead } from "../../src/domain/sequence/clock.ts";
import type { CallTask, SubjectState } from "../../src/domain/sequence/state.ts";
import { DEFAULT_RULES, type Rules } from "../../src/server/engine/rules.ts";

/**
 * Deliberately broken engines for phone tracks and call tasks (ADR 0003 9.2 step 5, the ticket 14
 * and 15 rows of 9.3): the ADR's, and one for each further rule each ticket adds. Each replaces one
 * decision; the generated call runs (generated-calls.ts) must fail the invariant it names.
 */

const R = DEFAULT_RULES;
const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));

/** The subject with every phone track callable at any hour, so a call is placed whatever its calling hours. */
const anyHours = (s: SubjectState): SubjectState => ({
  ...s,
  campaign: { ...s.campaign, definition: { ...s.campaign.definition, tracks: s.campaign.definition.tracks.map((t) => (t.channel === "call" ? { ...t, window: ALL_DAY } : t)) } },
});
const withDefinitionOf = (original: SubjectState, out: SubjectState): SubjectState => ({ ...out, campaign: original.campaign });

/** Every task open before the change stays open after it, whatever finished its track. */
const keepTasksOpen = (before: SubjectState, after: SubjectState): SubjectState => ({
  ...after,
  callTasks: after.callTasks.map((t) => (before.callTasks.find((x) => x.id === t.id)?.open && !t.open ? { ...t, open: true, closedWall: null } : t)),
});

/** Every task's stored fields as they were before a change, so a broken rule's own edits to them do not reach the store's guards. */
const keepStored = (before: SubjectState, after: SubjectState): SubjectState => ({
  ...after,
  callTasks: after.callTasks.map((t) => {
    const b = before.callTasks.find((x) => x.id === t.id);
    return b ? { ...t, skipDeadline: b.skipDeadline, dueAt: b.dueAt } : t;
  }),
});
const mapTasks = (s: SubjectState, change: (t: CallTask) => CallTask): SubjectState => ({ ...s, callTasks: s.callTasks.map(change) });

const RULES: Record<string, Partial<Rules>> = {
  // ADR 0003 9.3, ticket 14.
  "outcome on an unlisted task": {
    isListed: (_s, task) => task.open,
  },
  "interested closes only its own task": {
    logCallOutcome: (s, taskId, input, now, ids, listed) => {
      const out = R.logCallOutcome(s, taskId, input, now, ids, listed);
      if (!out.ok || input.outcome !== "interested") return out;
      // Every other task the lead had open stays open, and its track unfinished.
      const others = s.callTasks.filter((t) => t.open && t.id !== taskId);
      return {
        ok: true,
        state: {
          ...out.state,
          callTasks: out.state.callTasks.map((t) => others.find((o) => o.id === t.id) ?? t),
          tracks: out.state.tracks.map((p) => (others.some((o) => o.trackId === p.trackId) ? (progressOf(s, p.trackId) ?? p) : p)),
        },
      };
    },
  },

  // One per further rule of ticket 14.
  "daily call capacity ignored": {
    placeCall: (s, item, now, id) => R.placeCall({ ...s, callDay: { ...s.callDay, capacity: Number.MAX_SAFE_INTEGER } }, item, now, id),
  },
  "committed calls not counted": {
    placeCall: (s, item, now, id) => R.placeCall({ ...s, callDay: { ...s.callDay, committed: 0 } }, item, now, id),
  },
  "a call placed on a day its calling hours have closed": {
    readyCalls: (s, now) => R.readyCalls(anyHours(s), now),
    placeCall: (s, item, now, id) => {
      const out = R.placeCall(anyHours(s), item, now, id);
      return out ? withDefinitionOf(s, out) : null;
    },
  },
  "an unworked call holds the parallel tracks": {
    readyItems: (s, now) => (s.callTasks.some((t) => t.open) ? [] : R.readyItems(s, now)),
  },
  "the tracks after a call start when it is placed": {
    placeCall: (s, item, now, id) => {
      const out = R.placeCall(s, item, now, id);
      return out ? finishTrack(out, item.trackId, "completed", leadNow(out.subject.clock, now), wallOfLead(out.subject.clock, now)) : null;
    },
  },
  "skip for now finishes the call": {
    logCallOutcome: (s, taskId, input, now, ids, listed) => R.logCallOutcome(s, taskId, input.outcome === "skip_for_now" ? { ...input, outcome: "no_answer", numberId: s.lead.phones.find((p) => !p.bad)?.id ?? null } : input, now, ids, listed),
  },
  "a wrong number leaves the number good": {
    logCallOutcome: (s, taskId, input, now, ids, listed) => R.logCallOutcome(s, taskId, input.outcome === "wrong_number" ? { ...input, outcome: "no_answer" } : input, now, ids, listed),
  },
  "an outcome on a bad number accepted": {
    logCallOutcome: (s, taskId, input, now, ids, listed) => {
      const out = R.logCallOutcome({ ...s, lead: { ...s.lead, phones: s.lead.phones.map((p) => ({ ...p, bad: false })) } }, taskId, input, now, ids, listed);
      return out.ok ? { ok: true, state: { ...out.state, lead: { ...out.state.lead, phones: out.state.lead.phones.map((p) => ({ ...p, bad: p.bad || (s.lead.phones.find((x) => x.id === p.id)?.bad ?? false) })) } } } : out;
    },
  },
  "calls placed newest due first": {
    callOrder: (a, b) => (a.touched !== b.touched || a.dueWall === b.dueWall ? R.callOrder(a, b) : b.dueWall - a.dueWall),
  },
  // Verifier B3 and B1 on a1399ce.
  "a replayed action is logged again": {
    logCallOutcome: (s, taskId, input, now, ids, listed) => R.logCallOutcome(s, taskId, { ...input, requestId: `${input.requestId}/${ids.attempt}` }, now, ids, listed),
  },
  "a person note kept on the company": {
    logCallOutcome: (s, taskId, input, now, ids, listed) => R.logCallOutcome(s, taskId, { ...input, noteScope: "company" }, now, ids, listed),
  },
  // Council on 7902093: the queue the read models show.
  "ready now newest due first": {
    readyNowOrder: (a, b) => (a.dueWall !== b.dueWall && a.skippedWall === null && b.skippedWall === null ? b.dueWall - a.dueWall : R.readyNowOrder(a, b)),
  },
  "the focus moves to the oldest ready call": {
    focusOf: (readyNow) => R.focusOf(readyNow, null),
  },

  // ADR 0003 9.3, ticket 15.
  "redial resets the deadline": {
    // The skip limit counted from the latest redial instead of the call's original due time.
    evaluate: (s, now, options) => {
      const limit = s.campaign.definition.callSkipLimitDays;
      const fromRedial = mapTasks(s, (t) => {
        const r = s.callAttempts.filter((a) => a.taskId === t.id && a.redial).at(-1);
        return r ? { ...t, skipDeadline: r.at + span(r.atWall, limit, s.callDay.userZone) } : t;
      });
      return keepStored(s, R.evaluate(fromRedial, now, options));
    },
  },
  "redial listed the same day": {
    logCallOutcome: (s, taskId, input, now, ids, listed) => {
      const out = R.logCallOutcome(s, taskId, input, now, ids, listed);
      return out.ok && input.redial && !out.replayed ? { ok: true, state: mapTasks(out.state, (t) => (t.id === taskId ? { ...t, listDay: s.callDay.day } : t)) } : out;
    },
  },
  "callback listed before its day": {
    isListed: (s, task) => (task.kind === "callback" ? task.open && s.subject.ended === null && !s.subject.leadPaused : R.isListed(s, task)),
  },
  "callback expires": {
    // A missed callback dropped after the skip limit, counted in days from its day: the call is skipped and outreach resumes.
    evaluate: (s, now, options) => {
      const cb = s.callTasks.find((t) => t.open && t.kind === "callback");
      if (!cb || s.subject.ended !== null || callbackDay(s, cb) + s.campaign.definition.callSkipLimitDays > localDayNumber(now, s.callDay.userZone)) return R.evaluate(s, now, options);
      const released = synced(mapTasks(s, (t) => (t.id === cb.id ? { ...t, kind: "call", callbackAt: null } : t)), now);
      return R.evaluate(finishTrack(released, cb.trackId, "skipped_unworked", leadNow(released.subject.clock, now), now), now, options);
    },
  },
  "a task never listed expires": {
    // The skip limit's days counted whether or not the prospect's calling hours open on them.
    evaluate: (s, now, options) => withDefinitionOf(s, R.evaluate(anyHours(s), now, options)),
  },
  "callback outcome refused when the callback is the only hold": {
    isListed: (s, task) => R.isListed(s, task) && (task.kind !== "callback" || runs(s)),
  },

  // One per further rule of ticket 15.
  "a callback does not hold the lead": {
    // The callback is kept as an ordinary call for its day: the lead's emails and texts carry on.
    logCallOutcome: (s, taskId, input, now, ids, listed) => {
      const out = R.logCallOutcome(s, taskId, input, now, ids, listed);
      if (!out.ok || out.replayed || input.outcome !== "callback_requested") return out;
      const unheld = mapTasks(out.state, (t) => (t.id === taskId ? { ...t, kind: "call", listDay: localDayNumber(input.callbackAt ?? now, s.callDay.userZone) } : t));
      return { ok: true, state: evaluate(synced(unheld, now), now) };
    },
  },
  "a callback does not freeze the clock": {
    logCallOutcome: (s, taskId, input, now, ids, listed) => {
      const out = R.logCallOutcome(s, taskId, input, now, ids, listed);
      if (!out.ok || out.replayed || input.outcome !== "callback_requested") return out;
      return { ok: true, state: { ...out.state, subject: { ...out.state.subject, clock: s.subject.clock }, freezes: s.freezes } };
    },
  },
  "a callback's outcome logged on the frozen clock": {
    // The call is recorded at the instant the clock froze, and only then does the hold end.
    logCallOutcome: (s, taskId, input, now, ids, listed) => {
      const task = s.callTasks.find((t) => t.id === taskId);
      if (!task || task.kind !== "callback" || input.outcome === "skip_for_now" || input.outcome === "callback_requested" || s.callAttempts.some((a) => a.requestId === input.requestId) || !(listed ?? R.isListed)(s, task)) return R.logCallOutcome(s, taskId, input, now, ids, listed);
      const out = R.logCallOutcome(mapTasks(s, (t) => (t.id === taskId ? { ...t, kind: "call", callbackAt: null } : t)), taskId, input, now, ids, () => true);
      return out.ok ? { ok: true, state: synced(out.state, now) } : out;
    },
  },
  "unworked calls never expire": {
    evaluate: (s, now, options) => keepStored(s, R.evaluate(mapTasks(s, (t) => ({ ...t, skipDeadline: Number.MAX_SAFE_INTEGER })), now, options)),
  },
  "carried calls not at the top": {
    readyNowOrder: (a, b) => R.readyNowOrder({ ...a, rank: a.rank === 1 ? 2 : a.rank }, { ...b, rank: b.rank === 1 ? 2 : b.rank }),
  },
  "overdue callbacks shown as callbacks": {
    callReason: (s, task, now) => (R.callReason(s, task, now) === "overdue" ? "callback" : R.callReason(s, task, now)),
  },
  "a redial after any outcome": {
    logCallOutcome: (s, taskId, input, now, ids, listed) =>
      input.redial && !REDIAL_OUTCOMES.includes(input.outcome) ? R.logCallOutcome(s, taskId, { ...input, redial: false }, now, ids, listed) : R.logCallOutcome(s, taskId, input, now, ids, listed),
  },
  // ADR 0003 9.2: "a track that finishes without closing its call task", whichever change finishes it.
  "a track that finishes without closing its call task": {
    evaluate: (s, now, options) => keepTasksOpen(s, R.evaluate(s, now, options)),
    logCallOutcome: (s, taskId, input, now, ids, listed) => {
      const out = R.logCallOutcome(s, taskId, input, now, ids, listed);
      return out.ok ? { ok: true, state: keepTasksOpen(s, out.state) } : out;
    },
  },
};

/** The invariant each mutation must break, and the seed offset known to show it (refreshed by the CI search). */
const EXPECTED: Record<string, { invariant: string; seed: number }> = {
  "outcome on an unlisted task": { invariant: "16", seed: 0 },
  "interested closes only its own task": { invariant: "16", seed: 35 },
  "daily call capacity ignored": { invariant: "17", seed: 0 },
  "committed calls not counted": { invariant: "17", seed: 1 },
  "a call placed on a day its calling hours have closed": { invariant: "17", seed: 1 },
  "an unworked call holds the parallel tracks": { invariant: "18", seed: 6 },
  "the tracks after a call start when it is placed": { invariant: "7", seed: 3 },
  "skip for now finishes the call": { invariant: "7", seed: 3 },
  "a wrong number leaves the number good": { invariant: "19", seed: 24 },
  "an outcome on a bad number accepted": { invariant: "16", seed: 49 },
  "calls placed newest due first": { invariant: "12", seed: 3 },
  "a replayed action is logged again": { invariant: "16", seed: 2 },
  "a person note kept on the company": { invariant: "16", seed: 0 },
  "a track that finishes without closing its call task": { invariant: "16", seed: 0 },
  "ready now newest due first": { invariant: "16", seed: 6 },
  "the focus moves to the oldest ready call": { invariant: "16", seed: 2 },
  "redial resets the deadline": { invariant: "16", seed: 16 },
  "redial listed the same day": { invariant: "16", seed: 0 },
  "callback listed before its day": { invariant: "16", seed: 0 },
  "callback expires": { invariant: "16", seed: 4 },
  "a task never listed expires": { invariant: "7", seed: 27 },
  "callback outcome refused when the callback is the only hold": { invariant: "16", seed: 0 },
  "a callback does not hold the lead": { invariant: "16", seed: 2 },
  "a callback does not freeze the clock": { invariant: "9", seed: 0 },
  "a callback's outcome logged on the frozen clock": { invariant: "7", seed: 0 },
  "unworked calls never expire": { invariant: "7", seed: 0 },
  "carried calls not at the top": { invariant: "16", seed: 14 },
  "overdue callbacks shown as callbacks": { invariant: "16", seed: 2 },
  "a redial after any outcome": { invariant: "16", seed: 0 },
};

export const CALL_MUTATIONS: Record<string, { readonly rules: Partial<Rules>; readonly invariant: string; readonly seed: number }> = Object.fromEntries(
  Object.entries(EXPECTED).map(([name, e]) => {
    const rules = RULES[name];
    if (!rules) throw new Error(`no mutation named ${name}`);
    return [name, { rules, ...e }];
  }),
);
