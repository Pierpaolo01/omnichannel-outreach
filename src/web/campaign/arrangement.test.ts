import { describe, expect, test } from "vitest";
import { definitionProblems, type CampaignDefinition, type TrackDefinition } from "../../domain/sequence/definition.ts";
import { arrange } from "./arrangement.ts";

const week = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
const track = (id: string, channel: "email" | "sms", start: TrackDefinition["start"] = { kind: "entry" }, branch: TrackDefinition["branch"] = "main"): TrackDefinition => ({
  id,
  channel,
  branch,
  window: week,
  steps: [{ id: `${id}-s1`, waitDays: 0, subject: channel === "email" ? "Hi" : "", body: "Hello.", threading: "new_subject", removed: false }],
  start,
  removed: false,
});
const def = (...tracks: TrackDefinition[]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: [], smsPool: [], tracks });

describe("arranging tracks in the editor (ADR 0003, ticket 13b)", () => {
  test("adding an SMS track gives it a new id, one empty text and a start at launch", () => {
    const out = arrange(def(track("e", "email")), { kind: "add", channel: "sms" });
    if (!out.ok) throw new Error(out.reason);
    const added = out.definition.tracks[1]!;
    expect(added).toMatchObject({ channel: "sms", branch: "main", start: { kind: "entry" }, removed: false });
    expect(added.id).not.toBe("e");
    expect(added.steps).toHaveLength(1);
    expect(added.steps[0]).toMatchObject({ waitDays: 0, body: "" });
    expect(definitionProblems(out.definition)).toEqual([]);
  });

  test("adding a phone track gives it one call with no copy, weekday calling hours from 09:00 to 17:00, a skip limit of 2 days and a start at launch (ticket 14c)", () => {
    const out = arrange(def(track("e", "email")), { kind: "add", channel: "call" });
    if (!out.ok) throw new Error(out.reason);
    expect(out.added).toBe(out.definition.tracks[1]);
    expect(out.added).toMatchObject({
      channel: "call",
      branch: "main",
      start: { kind: "entry" },
      removed: false,
      callSkipLimitDays: 2,
      window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })),
      steps: [{ waitDays: 0, subject: "", body: "", removed: false }],
    });
    expect(definitionProblems(out.definition)).toEqual([]);
    // A second call attempt is a second phone track the user places, after the first.
    const second = arrange(out.definition, { kind: "add", channel: "call" });
    if (!second.ok || !second.added) throw new Error("not added");
    const placed = arrange(second.definition, { kind: "start", trackId: second.added.id, start: { kind: "after", trackId: out.added!.id, delayDays: 2 } });
    expect(placed.ok && definitionProblems(placed.definition)).toEqual([]);
    // Other tracks start after a phone track, and it cannot be removed while one does.
    const emailAfter = arrange(out.definition, { kind: "start", trackId: "e", start: { kind: "after", trackId: out.added!.id, delayDays: 1 } });
    if (!emailAfter.ok) throw new Error(emailAfter.reason);
    expect(arrange(emailAfter.definition, { kind: "remove", trackId: out.added!.id })).toEqual({ ok: false, reason: "The email track starts after this one. Change how it starts first." });
  });

  test("a track can start after another with a delay, and the delay can change", () => {
    const started = arrange(def(track("e", "email"), track("m", "sms")), { kind: "start", trackId: "m", start: { kind: "after", trackId: "e", delayDays: 2 } });
    if (!started.ok) throw new Error(started.reason);
    expect(started.definition.tracks[1]!.start).toEqual({ kind: "after", trackId: "e", delayDays: 2 });
    const delayed = arrange(started.definition, { kind: "delay", trackId: "m", days: 0 });
    if (!delayed.ok) throw new Error(delayed.reason);
    expect(delayed.definition.tracks[1]!.start).toEqual({ kind: "after", trackId: "e", delayDays: 0 });
  });

  test("a cycle is refused in plain words, and the draft is unchanged", () => {
    const before = def(track("e", "email"), track("m", "sms", { kind: "after", trackId: "e", delayDays: 1 }));
    const out = arrange(before, { kind: "start", trackId: "e", start: { kind: "after", trackId: "m", delayDays: 0 } });
    expect(out).toEqual({ ok: false, reason: "The SMS track starts after this one, so this one can’t start after it: each would wait for the other." });
    expect(arrange(before, { kind: "start", trackId: "e", start: { kind: "after", trackId: "e", delayDays: 0 } })).toMatchObject({ ok: false, reason: "A track can’t start after itself." });
  });

  test("removing a track another starts after is refused; removing it once that track starts elsewhere works", () => {
    const before = def(track("e", "email"), track("m", "sms", { kind: "after", trackId: "e", delayDays: 1 }));
    expect(arrange(before, { kind: "remove", trackId: "e" })).toEqual({ ok: false, reason: "The SMS track starts after this one. Change how it starts first." });
    const moved = arrange(before, { kind: "start", trackId: "m", start: { kind: "entry" } });
    if (!moved.ok) throw new Error(moved.reason);
    const removed = arrange(moved.definition, { kind: "remove", trackId: "e" });
    if (!removed.ok) throw new Error(removed.reason);
    expect(removed.definition.tracks.map((t) => t.id)).toEqual(["m"]);
  });

  test("a delay that is not a whole number of days, 0 or more, is refused", () => {
    const before = def(track("e", "email"), track("m", "sms", { kind: "after", trackId: "e", delayDays: 1 }));
    for (const days of [-1, 1.5, Number.NaN]) expect(arrange(before, { kind: "delay", trackId: "m", days })).toMatchObject({ ok: false });
    expect(arrange(before, { kind: "delay", trackId: "e", days: 1 })).toEqual({ ok: false, reason: "This track starts at launch, so it has no delay." });
  });

  test("two tracks on one channel are named by their own channel and order, never by position among all tracks", () => {
    const before = def(track("m1", "sms"), track("e", "email"), track("m2", "sms", { kind: "after", trackId: "e", delayDays: 0 }));
    expect(arrange(before, { kind: "remove", trackId: "e" })).toEqual({ ok: false, reason: "SMS track 2 starts after this one. Change how it starts first." });
  });
});

describe("the win-back branch and the declined path in the editor (ADR 0003, ticket 16b)", () => {
  const call = (id: string, declinedPath?: TrackDefinition["declinedPath"]): TrackDefinition => ({
    id,
    channel: "call",
    branch: "main",
    window: week,
    steps: [{ id: `${id}-s1`, waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false }],
    start: { kind: "entry" },
    removed: false,
    callSkipLimitDays: 2,
    ...(declinedPath ? { declinedPath } : {}),
  });
  const noBranch = "The phone track's declined path is win back, but the win-back branch has no tracks: add a track to it, or choose stop or continue.";

  test("adding an email or SMS track to the win-back branch puts it there, starting when the lead enters the branch", () => {
    for (const channel of ["email", "sms"] as const) {
      const out = arrange(def(track("e", "email"), call("p")), { kind: "add", channel, branch: "win_back" });
      if (!out.ok) throw new Error(out.reason);
      expect(out.added).toMatchObject({ channel, branch: "win_back", start: { kind: "entry" }, removed: false });
      expect(out.added?.callSkipLimitDays).toBeUndefined();
      expect(definitionProblems(out.definition)).toEqual([]);
    }
  });

  test("a phone track is never added to the win-back branch: the definition's own sentence says why", () => {
    const before = def(track("e", "email"), call("p"));
    expect(arrange(before, { kind: "add", channel: "call", branch: "win_back" })).toEqual({
      ok: false,
      reason: "The win-back branch cannot hold a phone track: a lead who declined is never called again in this campaign. Remove the phone track from the win-back branch.",
    });
  });

  test("a phone track's declined path is set to stop or continue, and to win back only once the branch has a live track", () => {
    const before = def(track("e", "email"), call("p"));
    for (const path of ["stop", "continue"] as const) {
      const out = arrange(before, { kind: "declined", trackId: "p", path });
      if (!out.ok) throw new Error(out.reason);
      expect(out.definition.tracks[1]).toEqual({ ...call("p"), declinedPath: path });
    }
    expect(arrange(before, { kind: "declined", trackId: "p", path: "win_back" })).toEqual({ ok: false, reason: noBranch });
    const branch = arrange(before, { kind: "add", channel: "email", branch: "win_back" });
    if (!branch.ok) throw new Error(branch.reason);
    const out = arrange(branch.definition, { kind: "declined", trackId: "p", path: "win_back" });
    if (!out.ok) throw new Error(out.reason);
    expect(out.definition.tracks.find((t) => t.id === "p")?.declinedPath).toBe("win_back");
    expect(definitionProblems(out.definition)).toEqual([]);
  });

  test("only a phone track has a declined path", () => {
    expect(arrange(def(track("e", "email")), { kind: "declined", trackId: "e", path: "stop" })).toEqual({ ok: false, reason: "Only a phone track has a declined path: the email track has one." });
  });

  test("the branch's last live track cannot be removed while a phone track's declined path is win back; it can once the path is another", () => {
    const before = def(track("e", "email"), call("p", "win_back"), track("w", "email", { kind: "entry" }, "win_back"));
    expect(arrange(before, { kind: "remove", trackId: "w" })).toEqual({ ok: false, reason: noBranch });
    const stopped = arrange(before, { kind: "declined", trackId: "p", path: "stop" });
    if (!stopped.ok) throw new Error(stopped.reason);
    expect(arrange(stopped.definition, { kind: "remove", trackId: "w" })).toMatchObject({ ok: true });
    // With another live branch track, one of them goes.
    const two = def(track("e", "email"), call("p", "win_back"), track("w", "email", { kind: "entry" }, "win_back"), track("w2", "sms", { kind: "entry" }, "win_back"));
    expect(arrange(two, { kind: "remove", trackId: "w" })).toMatchObject({ ok: true });
  });

  test("tracks of the branch connect inside it, and no connection crosses between the branch and the main sequence", () => {
    const before = def(track("e", "email"), call("p", "win_back"), track("w", "email", { kind: "entry" }, "win_back"), track("w2", "sms", { kind: "entry" }, "win_back"));
    const inside = arrange(before, { kind: "start", trackId: "w2", start: { kind: "after", trackId: "w", delayDays: 2 } });
    if (!inside.ok) throw new Error(inside.reason);
    expect(definitionProblems(inside.definition)).toEqual([]);
    expect(arrange(before, { kind: "start", trackId: "w", start: { kind: "after", trackId: "e", delayDays: 0 } })).toEqual({
      ok: false,
      reason: "The win-back email track starts after a track of the main sequence: connect it inside the win-back branch, which starts when a lead declines.",
    });
    expect(arrange(before, { kind: "start", trackId: "e", start: { kind: "after", trackId: "w", delayDays: 0 } })).toEqual({
      ok: false,
      reason: "The email track starts after a track of the win-back branch: connect it inside the main sequence.",
    });
  });

  test("a removal is refused only for a problem it causes, never one a remaining track already had under another name (council on aaf82b7)", () => {
    const noDays = { ...track("w2", "email", { kind: "entry" }, "win_back"), window: [] };
    const before = def(track("e", "email"), call("p"), track("w1", "email", { kind: "entry" }, "win_back"), noDays);
    // The second track's empty window is a problem the draft already has; removing the first only renames it.
    const out = arrange(before, { kind: "remove", trackId: "w1" });
    expect(out).toMatchObject({ ok: true });
    if (out.ok) expect(out.definition.tracks.map((t) => t.id)).toEqual(["e", "p", "w2"]);
  });
});
