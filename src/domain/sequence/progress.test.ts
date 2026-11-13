import { describe, expect, test } from "vitest";
import { attempt, calledWork, DAY, definition, H, handed, MONDAY_9, step, subjectState, withAttempts } from "../../../test/support/sequence-state.ts";
import { leadNow } from "./clock.ts";
import { applyBadDestination, applyReply, applyToAttempt, applyToWork, deriveStatus, enterMain, evaluate, runs } from "./progress.ts";
import type { ProviderWork, SubjectState } from "./state.ts";

/** Launched at Monday 09:00 and evaluated then. */
function launched(state: SubjectState = subjectState(), at = MONDAY_9): SubjectState {
  return evaluate(enterMain({ ...state, campaign: { ...state.campaign, launchedAt: at } }, at), at);
}

const opts = { resetDay: () => "2026-11-02" };

describe("status is a total function of the stored state (ADR 0003 2.1)", () => {
  test("a lead not yet touched is queued; once sent to, active", () => {
    const s = launched();
    expect(deriveStatus(s)).toBe("queued");
    expect(deriveStatus({ ...s, subject: { ...s.subject, touched: true } })).toBe("active");
  });

  test("an ending wins over everything, and a lead pause over the branch", () => {
    const s = launched();
    expect(deriveStatus({ ...s, subject: { ...s.subject, ended: "replied", leadPaused: true, touched: true } })).toBe("replied");
    expect(deriveStatus({ ...s, subject: { ...s.subject, leadPaused: true, branch: "win_back" } })).toBe("paused");
  });
});

describe("launch and the first step (ADR 0003 2.4, 2.6)", () => {
  test("before launch the lead does not run and its lead time stays 0", () => {
    const s = evaluate(subjectState(), MONDAY_9);
    expect(runs(s)).toBe(false);
    expect(s.tracks).toEqual([]);
    expect(leadNow(s.subject.clock, MONDAY_9 + 5 * H)).toBe(0);
  });

  test("launch enters main at lead time 0, starts the email track and makes its first step due at once", () => {
    const s = launched();
    expect(s.subject).toMatchObject({ branch: "main", branchEnteredAt: 0, clock: { frozenSince: null } });
    expect(s.freezes).toEqual([{ fromWall: MONDAY_9 - H, toWall: MONDAY_9 }]);
    expect(s.tracks).toEqual([
      expect.objectContaining({ trackId: "t1", startedAt: 0, destinationDetailId: "d-email", nextStepId: "s1", basisAt: 0, basisWall: MONDAY_9, dueAt: 0, dueWall: MONDAY_9 }),
    ]);
  });

  test("a lead with no email ends with no usable channel at launch, before its track is started", () => {
    const s = launched(subjectState({ lead: { ...subjectState().lead, details: [{ id: "d-phone", channel: "phone", ownEmail: false, value: "+447700900101", bad: false, order: 1 }], resolved: {} } }));
    expect(s.subject.ended).toBe("finished_no_usable_channel");
    expect(s.tracks).toEqual([]);
    expect(s.subject.clock.frozenSince).toBe(MONDAY_9);
  });

  test("the newest good email is the track's destination", () => {
    const base = subjectState();
    const details = [...base.lead.details, { id: "d-new", channel: "email" as const, ownEmail: true, value: "p.oneil@mail.example", bad: false, order: 2 }];
    const s = launched({ ...base, lead: { ...base.lead, details, resolved: { ...base.lead.resolved, "d-new": { liveId: "d-new", bad: false, owned: true } } } });
    expect(s.tracks[0]?.destinationDetailId).toBe("d-new");
  });
});

describe("sending (ADR 0003 2.4)", () => {
  function sentFirst(providerTime = MONDAY_9 + 10 * 60_000, now = MONDAY_9 + 20 * 60_000): SubjectState {
    const s = launched();
    const withAttempt = withAttempts(s, [handed({ state: "accepted" })], [calledWork({ providerRef: "p-1" })]);
    return applyToWork(withAttempt, "a-1", { kind: "sent_observed", providerTime, providerRef: "p-1" }, now, opts).state;
  }

  test("a send records the step, touches the lead and resolves the next step from the provider's send time", () => {
    const s = sentFirst();
    expect(s.results).toEqual([expect.objectContaining({ stepId: "s1", result: "sent", at: 10 * 60_000, atWall: MONDAY_9 + 10 * 60_000 })]);
    expect(s.subject.touched).toBe(true);
    expect(deriveStatus(s)).toBe("active");
    // Two calendar days after Monday in London: Wednesday 00:00.
    expect(s.tracks[0]).toMatchObject({ nextStepId: "s2", basisAt: 10 * 60_000, dueWall: Date.parse("2026-11-04T00:00:00Z"), dueAt: Date.parse("2026-11-04T00:00:00Z") - MONDAY_9 });
  });

  test("the next step is resolved from the send time, not from when the app observed it", () => {
    const late = sentFirst(MONDAY_9 + 10 * 60_000, MONDAY_9 + 2 * DAY);
    expect(late.tracks[0]?.dueWall).toBe(Date.parse("2026-11-04T00:00:00Z"));
  });

  test("the last step sent completes the track and the lead finishes with no response", () => {
    const one = launched(subjectState({ campaign: { ...subjectState().campaign, definition: definition([step("s1", { threading: "new_subject" })]) } }));
    const s = applyToWork(withAttempts(one, [handed({ state: "accepted" })]), "a-1", { kind: "sent_observed", providerTime: MONDAY_9 + 1000, providerRef: "p" }, MONDAY_9 + 2000, opts).state;
    expect(s.tracks[0]).toMatchObject({ finishReason: "completed" });
    expect(s.subject.ended).toBe("sequence_finished_no_response");
  });

  test("a reply ends the lead as replied and quiesces its live attempts", () => {
    const s = launched();
    const live = withAttempts(s, [handed({ state: "accepted" })]);
    const replied = applyReply(live, { channel: "email", atWall: MONDAY_9 + H, providerRef: "r-1" }, MONDAY_9 + H);
    expect(replied.subject.ended).toBe("replied");
    expect(replied.attempts[0]).toMatchObject({ state: "accepted", withdrawRequested: true });
    expect(replied.subject.clock.frozenSince).toBe(MONDAY_9 + H);
    expect(deriveStatus(replied)).toBe("replied");
  });

  test("a reply after another ending makes the lead replied; a second reply only records it", () => {
    const finished = { ...launched(), subject: { ...launched().subject, ended: "sequence_finished_no_response" as const } };
    const replied = applyReply(finished, { channel: "email", atWall: MONDAY_9 + H, providerRef: "r-1" }, MONDAY_9 + H);
    expect(replied.subject.ended).toBe("replied");
    const again = applyReply(replied, { channel: "email", atWall: MONDAY_9 + 2 * H, providerRef: "r-2" }, MONDAY_9 + 2 * H);
    expect(again.subject).toEqual(replied.subject);
    expect(again.replies).toHaveLength(2);
  });

  test("a bounce while the next step is handed marks the address bad, fails the track, quiesces the next attempt and ends the lead", () => {
    const sent = sentFirst();
    const withNext = withAttempts(sent, [...sent.attempts, handed({ id: "a-2", idempotencyKey: "a-2", stepId: "s2", state: "accepted" })], sent.work);
    const bounced = applyBadDestination(withNext, withNext.attempts[0]!, MONDAY_9 + 3 * DAY);
    expect(bounced.markBad).toEqual(["d-email"]);
    expect(bounced.tracks[0]?.finishReason).toBe("failed_bad_destination");
    expect(bounced.attempts[1]).toMatchObject({ state: "accepted", withdrawRequested: true });
    expect(bounced.subject.ended).toBe("finished_no_usable_channel");
  });

  test("a bounce with another good email left finishes the lead with no response", () => {
    const base = subjectState();
    const two = {
      ...base,
      lead: {
        ...base.lead,
        details: [...base.lead.details, { id: "d-old", channel: "email" as const, ownEmail: true, value: "old@harbour.example", bad: false, order: 0 }],
        resolved: { ...base.lead.resolved, "d-old": { liveId: "d-old", bad: false, owned: true } },
      },
    };
    const s = launched(two);
    const bounced = applyBadDestination(withAttempts(s, [handed({ state: "sent" })], [calledWork({ settled: "sent" })]), handed(), MONDAY_9 + H);
    expect(bounced.tracks[0]?.finishReason).toBe("failed_bad_destination");
    expect(bounced.subject.ended).toBe("sequence_finished_no_response");
  });

  test("a late send on a track that already finished is recorded, but changes neither its finish nor its successor", () => {
    const s = launched();
    const finished = {
      ...s,
      tracks: s.tracks.map((t) => ({ ...t, finishedAt: 0, finishedWall: MONDAY_9, finishReason: "failed_bad_destination" as const })),
    };
    const after = applyToWork(withAttempts(finished, [handed({ state: "accepted", withdrawRequested: true })]), "a-1", { kind: "sent_observed", providerTime: MONDAY_9 + 1000, providerRef: "p" }, MONDAY_9 + 2000, opts).state;
    expect(after.results.map((r) => r.stepId)).toEqual(["s1"]);
    expect(after.tracks[0]).toMatchObject({ finishReason: "failed_bad_destination", nextStepId: "s1", dueAt: 0 });
  });

  test("an invalid address refused at the handover marks it bad and fails the track", () => {
    const s = launched();
    const live = withAttempts(s, [handed()]);
    const after = applyToAttempt(live, "a-1", { kind: "call_answer", answer: { kind: "rejected", reason: "invalid_destination" }, now: MONDAY_9 + 1000 }, MONDAY_9 + 1000).state;
    expect(after.markBad).toEqual(["d-email"]);
    expect(after.tracks[0]?.finishReason).toBe("failed_bad_destination");
    expect(after.subject.ended).toBe("finished_no_usable_channel");
  });

  test("a block-listed address skips the track without marking it bad", () => {
    const s = launched();
    const after = applyToAttempt(withAttempts(s, [handed()]), "a-1", { kind: "call_answer", answer: { kind: "rejected", reason: "blocklisted" }, now: MONDAY_9 + 1000 }, MONDAY_9 + 1000).state;
    expect(after.markBad).toEqual([]);
    expect(after.tracks[0]?.finishReason).toBe("skipped_missing_channel");
    expect(after.subject.ended).toBe("sequence_finished_no_response");
  });

  test("a rate limit leaves the step pending with its deadline unchanged", () => {
    const s = launched();
    const after = applyToAttempt(withAttempts(s, [handed()]), "a-1", { kind: "call_answer", answer: { kind: "rejected", reason: "rate_limited" }, now: MONDAY_9 + 1000 }, MONDAY_9 + 1000).state;
    expect(after.tracks).toEqual(s.tracks);
    expect(after.subject.ended).toBeNull();
  });

  test("an address marked bad elsewhere ends a lead with no other address at the next evaluation, withdrawing its claim", () => {
    const s = launched();
    const marked = { ...s, lead: { ...s.lead, details: s.lead.details.map((d) => ({ ...d, bad: true })), resolved: { "d-email": { liveId: "d-email", bad: true, owned: true } } } };
    const after = evaluate(withAttempts(marked, [attempt()]), MONDAY_9 + H);
    expect(after.attempts[0]?.state).toBe("withdrawn");
    expect(after.subject.ended).toBe("finished_no_usable_channel");
  });
});

describe("a provider send belongs to the provider work that produced it (ruling 4; found by generated seed 20261117)", () => {
  /** The original attempt withdrawn after a not-sent it could not trust; an inheritor carrying its work. */
  function inherited(inheritor: "accepted" | "claimed" = "accepted", fields: Partial<ProviderWork> = {}): SubjectState {
    return withAttempts(
      launched(),
      [
        handed({ id: "a-1", state: "withdrawn", endedBy: "lookup_not_sent", handedWall: MONDAY_9 }),
        inheritor === "claimed" ? attempt({ id: "a-2", idempotencyKey: "a-1", claimedWall: MONDAY_9 + H }) : handed({ id: "a-2", idempotencyKey: "a-1", state: "accepted", handedWall: MONDAY_9 + 2 * H }),
      ],
      [calledWork({ providerRef: "p-1", calls: inheritor === "claimed" ? 1 : 2, nextLookupWall: MONDAY_9 + 2 * H, unresolvedSince: inheritor === "claimed" ? MONDAY_9 + H : null, ...fields })],
    );
  }

  test("a send settles the work and records the step on its first attempt handed over, with that attempt's handover time; the inheritor is settled by the same statement", () => {
    const after = applyToWork(inherited(), "a-1", { kind: "sent_observed", providerTime: MONDAY_9 + 1000, providerRef: "p-1" }, MONDAY_9 + 3 * H, opts).state;
    expect(after.attempts.map((a) => [a.id, a.state, a.endedBy])).toEqual([["a-1", "sent", "observed"], ["a-2", "withdrawn", "provider"]]);
    // The original's handover (09:00) bounds the send time, not the inheritor's (11:00).
    expect(after.results).toEqual([expect.objectContaining({ stepId: "s1", attemptId: "a-1", atWall: MONDAY_9 + 1000 })]);
    expect(after.work[0]).toMatchObject({ settled: "sent", sentWall: MONDAY_9 + 1000, nextLookupWall: null });
  });

  test("a claimed inheritor is withdrawn when the original work's send arrives", () => {
    const after = applyToWork(inherited("claimed"), "a-1", { kind: "sent_observed", providerTime: MONDAY_9 + 1000, providerRef: "p-1" }, MONDAY_9 + 2 * H, opts).state;
    expect(after.attempts.map((a) => [a.id, a.state, a.endedBy])).toEqual([["a-1", "sent", "observed"], ["a-2", "withdrawn", "provider"]]);
  });

  test("a later sent fact for the same work changes nothing but a missing reference: a step never gets a second sent attempt", () => {
    const once = applyToWork(inherited("accepted", { providerRef: null }), "a-1", { kind: "lookup_answer", answer: { kind: "sent", sentAt: MONDAY_9 + 1000, providerRef: "p-1" }, now: MONDAY_9 + 3 * H }, MONDAY_9 + 3 * H, opts).state;
    expect(once.work[0]?.providerRef).toBe("p-1");
    const again = applyToWork(once, "a-1", { kind: "sent_observed", providerTime: MONDAY_9 + 1000, providerRef: "p-1" }, MONDAY_9 + 4 * H, opts).state;
    expect(again.attempts).toEqual(once.attempts);
    expect(again.attempts.filter((a) => a.state === "sent")).toHaveLength(1);
  });

  test("the user's \"mark sent\" on work already sent is ignored (found by the extended generator, seed 20261124)", () => {
    const once = applyToWork(inherited(), "a-1", { kind: "sent_observed", providerTime: MONDAY_9 + 1000, providerRef: "p-1" }, MONDAY_9 + 3 * H, opts).state;
    const marked = applyToWork(once, "a-1", { kind: "mark_sent", now: MONDAY_9 + 4 * H }, MONDAY_9 + 4 * H, opts);
    expect(marked.state).toEqual(once);
  });
});

describe("provider work is one record: settlement, release, the user's mark and inheritance read and write it once (PR 37 review rounds 2 and 3)", () => {
  const unresolvedWithInheritor = () => inheritedUnresolved();
  function inheritedUnresolved(): SubjectState {
    return withAttempts(
      launched(),
      [handed({ id: "a-1", state: "withdrawn", endedBy: "lookup_not_sent", handedWall: MONDAY_9 }), handed({ id: "a-2", idempotencyKey: "a-1", state: "accepted", handedWall: MONDAY_9 + 2 * H })],
      [calledWork({ providerRef: "p-1", calls: 2, nextLookupWall: MONDAY_9 + 3 * H, unresolvedSince: MONDAY_9 + 2 * H + 1, lookupAnswer: "unknown" })],
    );
  }

  test("a confirmed withdrawal through the inheritor settles the work: nothing of it holds a reservation or is looked up", () => {
    const s = inheritedUnresolved();
    const requested = { ...s, attempts: s.attempts.map((a) => (a.id === "a-2" ? { ...a, withdrawRequested: true } : a)) };
    const after = applyToAttempt(requested, "a-2", { kind: "withdraw_answer", answer: "withdrawn", now: MONDAY_9 + 3 * H }, MONDAY_9 + 3 * H).state;
    expect(after.work[0]).toMatchObject({ settled: "withdrawn", nextLookupWall: null });
  });

  test("the user's \"not sent\" settles the work and ends every attempt still carrying it (GPT round 3 finding 2), whichever attempt it was given by", () => {
    for (const by of ["a-1", "a-2"]) {
      const s = unresolvedWithInheritor();
      const key = s.attempts.find((a) => a.id === by)!.idempotencyKey;
      const after = applyToWork(s, key, { kind: "mark_not_sent", now: MONDAY_9 + 3 * H }, MONDAY_9 + 3 * H, opts).state;
      expect(after.work[0]).toMatchObject({ settled: "user_not_sent", nextLookupWall: null });
      expect(after.attempts.map((a) => [a.id, a.state, a.endedBy])).toEqual([["a-1", "withdrawn", "lookup_not_sent"], ["a-2", "withdrawn", "user"]]);
    }
  });

  test("\"not sent\" is refused while the provider reports the work queued, and for work not unresolved", () => {
    const queued = unresolvedWithInheritor();
    const q = { ...queued, work: [{ ...queued.work[0]!, lookupAnswer: "queued" as const }] };
    expect(applyToWork(q, "a-1", { kind: "mark_not_sent", now: MONDAY_9 + 3 * H }, MONDAY_9 + 3 * H, opts).state).toEqual(q);
    const live = withAttempts(launched(), [handed()]);
    expect(applyToWork(live, "a-1", { kind: "mark_not_sent", now: MONDAY_9 + 3 * H }, MONDAY_9 + 3 * H, opts).state).toEqual(live);
  });

  test("\"mark sent\" settles the work as sent, on its first attempt handed over", () => {
    const after = applyToWork(unresolvedWithInheritor(), "a-1", { kind: "mark_sent", now: MONDAY_9 + 3 * H }, MONDAY_9 + 3 * H, opts).state;
    expect(after.work[0]).toMatchObject({ settled: "user_sent", sentWall: MONDAY_9 + 3 * H });
    expect(after.attempts.map((a) => [a.id, a.state, a.endedBy])).toEqual([["a-1", "sent", "user"], ["a-2", "withdrawn", "user"]]);
  });

  test("a send the provider makes after the work settled otherwise is an anomaly, counted on its send day, never a second send of the step", () => {
    const s = unresolvedWithInheritor();
    const marked = applyToWork(s, "a-1", { kind: "mark_not_sent", now: MONDAY_9 + 3 * H }, MONDAY_9 + 3 * H, opts).state;
    const late = applyToWork(marked, "a-1", { kind: "sent_observed", providerTime: MONDAY_9 + 4 * H, providerRef: "p-1" }, MONDAY_9 + 5 * H, opts);
    expect(late.effects.map((e) => e.kind)).toEqual(["anomaly"]);
    expect(late.state.work[0]).toMatchObject({ settled: "user_not_sent", sentWall: MONDAY_9 + 4 * H, sentDay: "2026-11-02" });
    expect(late.state.results).toEqual(marked.results);
  });

  test("uncertain work no live attempt carries is unresolved, so it is listed", () => {
    const s = withAttempts(launched(), [handed({ state: "accepted" })], [calledWork({ nextLookupWall: MONDAY_9 + H })]);
    const after = applyToWork(s, "a-1", { kind: "lookup_answer", answer: { kind: "not-sent" }, now: MONDAY_9 + H }, MONDAY_9 + H, opts).state;
    expect(after.attempts[0]).toMatchObject({ state: "withdrawn", endedBy: "lookup_not_sent" });
    expect(after.work[0]).toMatchObject({ settled: null, unresolvedSince: MONDAY_9 + H });
  });
});
