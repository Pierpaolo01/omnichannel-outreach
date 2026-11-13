import { describe, expect, test } from "vitest";
import { account, attempt, definition, H, handed, MONDAY_9, step, subjectState } from "../../../test/support/sequence-state.ts";
import {
  authorizeRetry,
  chooseAccount,
  claim,
  claimRefusal,
  comparePriority,
  handOver,
  handoverFailures,
  heldReason,
  readyItems,
  retryFailures,
  stalledAccounts,
  type ReadyItem,
} from "./dispatch.ts";
import { enterMain, evaluate } from "./progress.ts";
import { ENGINE_PARAMS } from "./attempt.ts";
import type { SubjectState } from "./state.ts";

function launched(state: SubjectState = subjectState(), at = MONDAY_9): SubjectState {
  return evaluate(enterMain({ ...state, campaign: { ...state.campaign, launchedAt: at } }, at), at);
}

const item = (fields: Partial<ReadyItem> = {}): ReadyItem => ({ subjectId: "lead-1", trackId: "t1", stepId: "s1", touched: false, dueWall: MONDAY_9, ...fields });

/** Launched, step 1 claimed on inbox-a, and a pre-send check just run. */
function claimed(now = MONDAY_9): SubjectState {
  const s = claim(launched(), item(), account("inbox-a"), { attemptId: "a-1", retryable: true, notSentIsFinal: false, now });
  return { ...s, attempts: s.attempts.map((a) => ({ ...a, presendCheckedWall: now })) };
}

describe("priority (ADR 0003 4.3)", () => {
  test("touched leads first, then oldest due, then subject id, then step id", () => {
    const items = [
      item({ subjectId: "b", dueWall: 1 }),
      item({ subjectId: "z", touched: true, dueWall: 9 }),
      item({ subjectId: "a", dueWall: 1 }),
      item({ subjectId: "c", dueWall: 0 }),
      item({ subjectId: "a", dueWall: 1, stepId: "s0" }),
    ];
    expect(items.sort(comparePriority).map((i) => `${i.subjectId}/${i.stepId}`)).toEqual(["z/s1", "c/s1", "a/s0", "a/s1", "b/s1"]);
  });
});

describe("ready items and the claim (ADR 0003 2.6, 4.2)", () => {
  test("a launched lead's first step is ready at once; nothing is ready before launch", () => {
    expect(readyItems(launched(), MONDAY_9)).toEqual([item()]);
    expect(readyItems(subjectState(), MONDAY_9)).toEqual([]);
  });

  test("the step guard refuses outside the window, and on a bad or missing destination", () => {
    const weekdays = definition();
    const narrowed = { ...weekdays, tracks: weekdays.tracks.map((t) => ({ ...t, window: [{ day: 1, start: 10, end: 17 }] })) };
    const s = launched(subjectState({ campaign: { ...subjectState().campaign, definition: narrowed } }));
    expect(claimRefusal(s, item(), MONDAY_9)).toBe("the sending window is closed");
    expect(claimRefusal(s, item(), MONDAY_9 + H)).toBeNull();
    const bad = { ...s, lead: { ...s.lead, resolved: { "d-email": { liveId: "d-email", bad: true, owned: true } } } };
    expect(claimRefusal(bad, item(), MONDAY_9 + H)).toBe("the destination is not a good address of the lead");
  });

  test("a merge field the lead lacks refuses the claim and holds the track as render_failed", () => {
    const def = definition([step("s1", { threading: "new_subject", body: "Hi {{title}}" })]);
    const s = launched(subjectState({ campaign: { ...subjectState().campaign, definition: def } }));
    expect(claimRefusal(s, item(), MONDAY_9)).toBe("the copy does not render for this lead");
    expect(heldReason(s, "t1", MONDAY_9)).toBe("render_failed");
    expect(readyItems(s, MONDAY_9)).toEqual([]);
  });

  test("a claim reserves capacity and an in-flight place, and does not fix the sender", () => {
    const s = claimed();
    expect(s.attempts[0]).toMatchObject({ state: "claimed", accountId: "inbox-a", idempotencyKey: "a-1", calls: 0 });
    expect(s.accounts["inbox-a"]).toMatchObject({ used: 1, inFlight: 1 });
    expect(s.subject.emailSender).toBeNull();
    expect(claimRefusal(s, item(), MONDAY_9)).toBe("the step already has a live attempt");
  });

  test("a step's attempts after a lookup said not sent inherit that attempt's key", () => {
    const s = launched();
    const withOld = { ...s, attempts: [attempt({ id: "a-0", idempotencyKey: "a-0", state: "withdrawn", endedBy: "lookup_not_sent" })] };
    expect(claim(withOld, item(), account("inbox-a"), { attemptId: "a-9", retryable: true, notSentIsFinal: false, now: MONDAY_9 }).attempts[1]?.idempotencyKey).toBe("a-0");
  });

  test("account choice: the fixed sender, else the one that can send soonest, then most room, then lowest id", () => {
    const s = launched();
    expect(chooseAccount(s, MONDAY_9)?.id).toBe("inbox-a");
    expect(chooseAccount({ ...s, accounts: { ...s.accounts, "inbox-a": account("inbox-a", { nextSlotAt: MONDAY_9 + 60_000 }) } }, MONDAY_9)?.id).toBe("inbox-b");
    expect(chooseAccount({ ...s, accounts: { ...s.accounts, "inbox-a": account("inbox-a", { used: 3 }) } }, MONDAY_9)?.id).toBe("inbox-b");
    expect(chooseAccount({ ...s, subject: { ...s.subject, emailSender: "inbox-b" }, accounts: { ...s.accounts, "inbox-b": account("inbox-b", { healthy: false }) } }, MONDAY_9)).toBeNull();
  });

  test("capacity and the in-flight bound: a full account takes no claim", () => {
    const s = launched();
    const full = { ...s, accounts: { "inbox-a": account("inbox-a", { used: 30 }), "inbox-b": account("inbox-b", { inFlight: 1 }) } };
    expect(chooseAccount(full, MONDAY_9)).toBeNull();
    const waiting = { ...s, accounts: { "inbox-a": account("inbox-a", { waitUntil: MONDAY_9 + 1 }), "inbox-b": account("inbox-b", { healthy: false }) } };
    expect(chooseAccount(waiting, MONDAY_9)).toBeNull();
  });
});

describe("the handover transaction (ADR 0003 5.5)", () => {
  test("every predicate holds: the copy is rendered, the slot taken and the sender fixed", () => {
    const s = claimed();
    const a = s.attempts[0]!;
    expect(handoverFailures(s, a, s.accounts["inbox-a"]!, MONDAY_9)).toEqual([]);
    const h = handOver(s, a, s.accounts["inbox-a"]!, MONDAY_9);
    expect(h.attempts[0]).toMatchObject({ state: "handed", calls: 1, copy: { subject: "Hello Pat", body: "A note for Harbour Lane Physio." }, handedWall: MONDAY_9, awaitingAnswer: true });
    expect(h.accounts["inbox-a"]?.nextSlotAt).toBe(MONDAY_9 + 120_000);
    expect(h.subject.emailSender).toBe("inbox-a");
  });

  test("a busy slot fails only predicate 16, so the attempt stays claimed", () => {
    const s = claimed();
    expect(handoverFailures(s, s.attempts[0]!, account("inbox-a", { nextSlotAt: MONDAY_9 + 1 }), MONDAY_9)).toEqual([16]);
  });

  test("a stale or missing pre-send check fails predicate 14, and so does a reply it found", () => {
    const s = claimed();
    const a = s.attempts[0]!;
    expect(handoverFailures(s, a, s.accounts["inbox-a"]!, MONDAY_9 + ENGINE_PARAMS.PRESEND_MAX_AGE + 1)).toContain(14);
    expect(handoverFailures(s, { ...a, presendFoundReply: true }, s.accounts["inbox-a"]!, MONDAY_9)).toContain(14);
  });

  test("a change between the claim and the handover fails its predicate", () => {
    const s = claimed();
    const a = s.attempts[0]!;
    const acc = s.accounts["inbox-a"]!;
    expect(handoverFailures({ ...s, subject: { ...s.subject, ended: "replied" } }, a, acc, MONDAY_9)).toContain(1);
    expect(handoverFailures({ ...s, lead: { ...s.lead, resolved: { "d-email": { liveId: "d-email", bad: true, owned: true } } } }, a, acc, MONDAY_9)).toContain(12);
    expect(handoverFailures(s, a, { ...acc, healthy: false }, MONDAY_9)).toContain(9);
    expect(handoverFailures({ ...s, subject: { ...s.subject, emailSender: "inbox-b" } }, a, acc, MONDAY_9)).toContain(10);
    expect(handoverFailures({ ...s, results: [{ stepId: "s1", trackId: "t1", result: "sent", reason: null, at: 0, atWall: MONDAY_9, attemptId: "x" }] }, a, acc, MONDAY_9)).toContain(4);
    expect(handoverFailures(s, a, acc, MONDAY_9 + 15 * H)).toEqual([14]);
  });
});

describe("the same-key retry authorization (ADR 0003 5.6)", () => {
  function inFlight(fields = {}): SubjectState {
    const s = launched();
    const a = handed({ presendCheckedWall: MONDAY_9 + 5 * 60_000, retry: "wanted", ...fields });
    return { ...s, subject: { ...s.subject, emailSender: "inbox-a" }, attempts: [a] };
  }
  const now = MONDAY_9 + 5 * 60_000;

  test("authorized: one more call, the slot taken, and the payload untouched", () => {
    const s = inFlight();
    expect(retryFailures(s, s.attempts[0]!, account("inbox-a"), now)).toEqual([]);
    const r = authorizeRetry(s, s.attempts[0]!, account("inbox-a"), now);
    expect(r.attempts[0]).toMatchObject({ calls: 2, lastCallWall: now, copy: s.attempts[0]!.copy, idempotencyKey: "a-1" });
    expect(r.accounts["inbox-a"]?.nextSlotAt).toBe(now + 120_000);
  });

  test("refused on a non-retryable transport, after a withdraw request, once unresolved, or with no calls left", () => {
    expect(retryFailures(inFlight({ retryable: false }), inFlight({ retryable: false }).attempts[0]!, account("inbox-a"), now)).toContain("not retryable");
    expect(retryFailures(inFlight(), handed({ withdrawRequested: true, presendCheckedWall: now }), account("inbox-a"), now)).toContain("withdraw requested");
    expect(retryFailures(inFlight(), handed({ unresolvedSince: now, presendCheckedWall: now }), account("inbox-a"), now)).toContain("unresolved");
    expect(retryFailures(inFlight(), handed({ calls: 3, presendCheckedWall: now }), account("inbox-a"), now)).toContain("no calls left");
  });

  test("refused without the slot or a fresh pre-send check, or when the lead stopped running", () => {
    const s = inFlight();
    expect(retryFailures(s, s.attempts[0]!, account("inbox-a", { nextSlotAt: now + 1 }), now)).toEqual(["slot"]);
    expect(retryFailures(s, s.attempts[0]!, account("inbox-a"), now + 2 * 60_000)).toEqual(["predicate 14"]);
    expect(retryFailures({ ...s, subject: { ...s.subject, ended: "replied" } }, s.attempts[0]!, account("inbox-a"), now)).toContain("predicate 1");
  });
});

describe("an inbox never stalls silently (ADR 0003 5.4)", () => {
  test("an account whose in-flight places are all held past SETTLING is listed with what holds it", () => {
    const live = [{ accountId: "inbox-a", claimedWall: MONDAY_9, lastCallWall: MONDAY_9, destination: "pat@harbour.example" }];
    expect(stalledAccounts([account("inbox-a")], live, MONDAY_9 + ENGINE_PARAMS.SETTLING - 1)).toEqual([]);
    expect(stalledAccounts([account("inbox-a")], live, MONDAY_9 + ENGINE_PARAMS.SETTLING)).toEqual([{ accountId: "inbox-a", holding: ["pat@harbour.example"] }]);
    expect(stalledAccounts([account("inbox-a", { k: 2 })], live, MONDAY_9 + ENGINE_PARAMS.SETTLING)).toEqual([]);
  });
});
