import { describe, expect, test } from "vitest";
import { attempt, DAY, H, handed, MONDAY_9, subjectState, withAttempts, work } from "../../../test/support/sequence-state.ts";
import { leadNow } from "./clock.ts";
import { applyControl, campaignPaused, campaignResumed } from "./controls.ts";
import { deriveStatus, enterMain, evaluate, runs } from "./progress.ts";
import type { SubjectState } from "./state.ts";

/** The user's controls as pure transitions (ADR 0003 "Ticket 17a"). Data is fictitious. */

/** A lead in a launched email campaign (three steps: at once, after 2 days, after 3 more), at `now`. */
function launched(now = MONDAY_9): SubjectState {
  const base = subjectState();
  return evaluate(enterMain({ ...base, campaign: { ...base.campaign, launchedAt: now } }, now), now);
}
const ok = (r: ReturnType<typeof applyControl>): SubjectState => {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.state;
};
const reason = (r: ReturnType<typeof applyControl>): string => (r.ok ? "accepted" : r.reason);
/** Sends step s1 at `at`, as the provider would report it, and evaluates the next step. */
function sentFirst(s: SubjectState, at: number): SubjectState {
  return evaluate({ ...s, subject: { ...s.subject, touched: true }, results: [{ stepId: "s1", trackId: "t1", result: "sent", reason: null, at: leadNow(s.subject.clock, at), atWall: at, attemptId: null }], tracks: s.tracks.map((t) => ({ ...t, nextStepId: null })) }, at);
}

describe("pausing and resuming one lead", () => {
  test("a pause freezes the lead's clock and its status is paused; a resume continues every wait where it stood", () => {
    const s = sentFirst(launched(), MONDAY_9);
    const due = s.tracks[0]!.dueAt!;
    const paused = ok(applyControl(s, "pause", MONDAY_9 + H));
    expect(runs(paused)).toBe(false);
    expect(deriveStatus(paused)).toBe("paused");
    expect(paused.subject.clock.frozenSince).toBe(MONDAY_9 + H);
    // Five days later nothing has come due.
    const resumed = ok(applyControl(paused, "resume", MONDAY_9 + 6 * DAY));
    expect(runs(resumed)).toBe(true);
    expect(resumed.tracks[0]!.dueAt).toBe(due);
    // The wall instant the step is due at moved by exactly the time paused.
    const wallDue = MONDAY_9 + 6 * DAY + (due - leadNow(resumed.subject.clock, MONDAY_9 + 6 * DAY));
    expect(wallDue).toBe(s.tracks[0]!.dueWall! + 6 * DAY - H);
  });

  test("a pause withdraws a claim and asks the provider to withdraw work it holds", () => {
    const claimed = withAttempts(launched(), [attempt()]);
    expect(ok(applyControl(claimed, "pause", MONDAY_9 + H)).attempts[0]).toMatchObject({ state: "withdrawn", endedBy: "quiesce" });
    const withProvider = withAttempts(launched(), [handed()]);
    expect(ok(applyControl(withProvider, "pause", MONDAY_9 + H)).attempts[0]).toMatchObject({ state: "handed", withdrawRequested: true });
  });

  test("each is refused, with its reason, where it does not apply", () => {
    const base = subjectState();
    expect(reason(applyControl(base, "pause", MONDAY_9))).toMatch(/has not launched/);
    const paused = ok(applyControl(launched(), "pause", MONDAY_9 + H));
    expect(reason(applyControl(paused, "pause", MONDAY_9 + 2 * H))).toMatch(/already paused/);
    expect(reason(applyControl(launched(), "resume", MONDAY_9 + H))).toMatch(/not paused/);
    const stopped = ok(applyControl(launched(), "stop", MONDAY_9 + H));
    expect(reason(applyControl(stopped, "pause", MONDAY_9 + 2 * H))).toMatch(/has ended/);
    expect(reason(applyControl(stopped, "stop", MONDAY_9 + 2 * H))).toMatch(/has ended/);
  });

  test("nested holds: a lead paused inside a paused campaign runs only once both are released, in either order", () => {
    const s = launched();
    const both = ok(applyControl(campaignPaused(s, MONDAY_9 + H), "pause", MONDAY_9 + 2 * H));
    const leadFirst = ok(applyControl(both, "resume", MONDAY_9 + 3 * H));
    expect(runs(leadFirst)).toBe(false);
    expect(runs(campaignResumed(leadFirst, MONDAY_9 + 4 * H))).toBe(true);
    const campaignFirst = campaignResumed(both, MONDAY_9 + 3 * H);
    expect(runs(campaignFirst)).toBe(false);
    expect(deriveStatus(campaignFirst)).toBe("paused");
    const done = ok(applyControl(campaignFirst, "resume", MONDAY_9 + 4 * H));
    expect(runs(done)).toBe(true);
    // Frozen from the campaign's pause to the last release: three hours.
    expect(leadNow(done.subject.clock, MONDAY_9 + 4 * H)).toBe(leadNow(s.subject.clock, MONDAY_9 + H));
  });

  test("a campaign pause changes no status, and a lead enrolled while it is paused enters when it resumes", () => {
    const s = launched();
    expect(deriveStatus(campaignPaused(s, MONDAY_9 + H))).toBe(deriveStatus(s));
    const base = subjectState();
    const late = enterMain({ ...base, campaign: { ...base.campaign, launchedAt: MONDAY_9, pausedSince: MONDAY_9 } }, MONDAY_9 + H);
    expect(late.subject.branchEnteredAt).toBeNull();
    const resumed = campaignResumed(late, MONDAY_9 + 5 * H);
    expect(resumed.subject.branchEnteredAt).toBe(0);
    expect(resumed.tracks[0]).toMatchObject({ startedAt: 0, nextStepId: "s1" });
  });
});

describe("stop and restart", () => {
  test("stop ends the lead and keeps its progress; resume from the next unsent step continues there, never from step 1", () => {
    const s = sentFirst(launched(), MONDAY_9);
    const stopped = ok(applyControl(s, "stop", MONDAY_9 + H));
    expect(deriveStatus(stopped)).toBe("stopped_manually");
    expect(stopped.tracks).toEqual(s.tracks);
    const restarted = ok(applyControl(stopped, "resume_from_next_step", MONDAY_9 + 3 * DAY));
    expect(deriveStatus(restarted)).toBe("active");
    expect(restarted.results).toEqual(s.results);
    expect(restarted.tracks[0]).toMatchObject({ nextStepId: "s2", dueAt: s.tracks[0]!.dueAt });
  });

  test("a replied lead resumes too, and the reply that stopped it no longer shows", () => {
    const s = sentFirst(launched(), MONDAY_9);
    const replied: SubjectState = { ...s, subject: { ...s.subject, ended: "replied", endedAt: 0, endedWall: MONDAY_9 + H, stopReply: { channel: "email", atWall: MONDAY_9 + H } } };
    const restarted = ok(applyControl(replied, "resume_from_next_step", MONDAY_9 + 2 * H));
    expect(restarted.subject).toMatchObject({ ended: null, endedWall: null, stopReply: null });
  });

  test("only replied and stopped leads restart, and only when something is left to send", () => {
    expect(reason(applyControl(launched(), "resume_from_next_step", MONDAY_9))).toMatch(/replied or was stopped/);
    const s = launched();
    const interested: SubjectState = { ...s, subject: { ...s.subject, ended: "interested_on_call", endedWall: MONDAY_9 } };
    expect(reason(applyControl(interested, "resume_from_next_step", MONDAY_9 + H))).toMatch(/replied or was stopped/);
    const finished: SubjectState = { ...s, subject: { ...s.subject, ended: "stopped_manually", endedWall: MONDAY_9 }, tracks: s.tracks.map((t) => ({ ...t, finishedAt: 0, finishedWall: MONDAY_9, finishReason: "completed" as const })) };
    expect(reason(applyControl(finished, "resume_from_next_step", MONDAY_9 + H))).toMatch(/Nothing is left/);
  });
});

describe("skip step", () => {
  test("the pending step gets skipped by the user, is never claimed, and the next is due its wait from now", () => {
    const s = launched();
    const at = MONDAY_9 + 2 * H;
    const skipped = ok(applyControl(withAttempts(s, [attempt()]), "skip", at));
    expect(skipped.results).toEqual([expect.objectContaining({ stepId: "s1", result: "skipped", reason: "by_user", atWall: at })]);
    expect(skipped.attempts[0]).toMatchObject({ state: "withdrawn" });
    expect(skipped.tracks[0]).toMatchObject({ nextStepId: "s2", basisWall: at });
    expect(skipped.tracks[0]!.dueAt! - leadNow(skipped.subject.clock, at)).toBe(Date.parse("2026-11-04T00:00:00Z") - at);
  });

  test("a step whose provider work is uncertain cannot be skipped, even with no live attempt or with a new claim inheriting it (review bot on ca8baee, item 2)", () => {
    // A non-final "not sent" lookup withdrew the attempt; its work was called and has not settled.
    const withdrawn = attempt({ state: "withdrawn", endedBy: "lookup_not_sent", calls: 1, handedWall: MONDAY_9, handedAt: 0 });
    const uncertain = withAttempts(launched(), [withdrawn], [work({ calls: 1, firstHandedWall: MONDAY_9 })]);
    expect(reason(applyControl(uncertain, "skip", MONDAY_9 + H))).toMatch(/with the email provider/);
    const inheritor = withAttempts(launched(), [withdrawn, attempt({ id: "a-2", idempotencyKey: "a-1" })], [work({ calls: 1, firstHandedWall: MONDAY_9 })]);
    expect(reason(applyControl(inheritor, "skip", MONDAY_9 + H))).toMatch(/with the email provider/);
    // Settled without a send (a confirmed withdrawal), it can be skipped.
    const settled = withAttempts(launched(), [{ ...withdrawn, endedBy: "provider" }], [work({ calls: 1, firstHandedWall: MONDAY_9, settled: "withdrawn" })]);
    expect(reason(applyControl(settled, "skip", MONDAY_9 + H))).toBe("accepted");
  });

  test("a step already with the provider cannot be skipped; a lead with no pending step says why", () => {
    expect(reason(applyControl(withAttempts(launched(), [handed()]), "skip", MONDAY_9 + H))).toMatch(/with the email provider/);
    const s = launched();
    const between: SubjectState = { ...s, tracks: [{ ...s.tracks[0]!, finishedAt: 0, finishedWall: MONDAY_9, finishReason: "completed", nextStepId: null }] };
    expect(reason(applyControl(between, "skip", MONDAY_9 + H))).toMatch(/No step is waiting/);
  });
});
