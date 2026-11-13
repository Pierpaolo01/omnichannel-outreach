import { describe, expect, test } from "vitest";
import { definitionProblems, type CampaignDefinition, type TrackDefinition } from "../../domain/sequence/definition.ts";
import { arrange } from "./arrangement.ts";

const week = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
const track = (id: string, channel: "email" | "sms", start: TrackDefinition["start"] = { kind: "entry" }): TrackDefinition => ({
  id,
  channel,
  branch: "main",
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
