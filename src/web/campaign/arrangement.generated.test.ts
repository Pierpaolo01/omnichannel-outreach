import { describe, expect, test } from "vitest";
import { definitionProblems, type CampaignDefinition, type TrackDefinition } from "../../domain/sequence/definition.ts";
import { arrange, naive, type ArrangeMutation, type ArrangeOperation } from "./arrangement.ts";

/**
 * The arrangement rule's generated test (ADR 0003, ticket 13b): generated valid definitions, phone
 * tracks among them (a track like any other: others may start after one, and the editor adds them
 * since ticket 14c), then
 * generated sequences of every operation the editor offers, including ones the rule must refuse.
 * After each operation it asserts the rule's five invariants. Each named mutation of the rule must
 * make it fail. Since ticket 16b the drafts often have a win-back branch of email and SMS tracks,
 * arranged inside it, and phone tracks with a declined path (win back only with a live branch track);
 * the operations add tracks to the branch (a phone track among them, which must be refused), set
 * declined paths (win back with no branch among them), connect tracks across branches and remove the
 * branch's last track.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const pick = <T,>(r: () => number, items: readonly T[]): T => items[Math.floor(r() * items.length)]!;
const week = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));

function track(id: string, channel: "email" | "sms" | "call", start: TrackDefinition["start"], removed = false, branch: TrackDefinition["branch"] = "main"): TrackDefinition {
  // A phone track (defined over HTTP since ticket 14a) is one call with no copy.
  const step = channel === "call" ? { subject: "", body: "" } : { subject: "Hi", body: "Hello." };
  return { id, channel, branch, window: week, steps: [{ id: `${id}-s1`, waitDays: 0, ...step, threading: "new_subject", removed: false }], start, removed };
}
const PATHS = ["stop", "continue", "win_back"] as const;

/** One to five tracks, each at launch or after an earlier live one (so no cycle), and some removed ones. */
function generateDefinition(r: () => number): CampaignDefinition {
  const tracks: TrackDefinition[] = [];
  const n = 1 + Math.floor(r() * 5);
  for (let i = 0; i < n; i++) {
    const earlier = tracks.filter((t) => !t.removed);
    const start: TrackDefinition["start"] = earlier.length > 0 && r() < 0.6 ? { kind: "after", trackId: pick(r, earlier).id, delayDays: Math.floor(r() * 4) } : { kind: "entry" };
    tracks.push(track(`t${i}`, pick(r, ["email", "sms", "call"] as const), start));
  }
  if (r() < 0.4) tracks.push(track("gone", "email", { kind: "entry" }, true));
  // The win-back branch (ticket 16b): none, or one to three email and SMS tracks arranged inside it.
  const branch = r() < 0.6 ? 1 + Math.floor(r() * 3) : 0;
  for (let i = 0; i < branch; i++) {
    const earlier = tracks.filter((t) => !t.removed && t.branch === "win_back");
    const start: TrackDefinition["start"] = earlier.length > 0 && r() < 0.5 ? { kind: "after", trackId: pick(r, earlier).id, delayDays: Math.floor(r() * 3) } : { kind: "entry" };
    tracks.push(track(`w${i}`, pick(r, ["email", "sms"] as const), start, false, "win_back"));
  }
  // Each phone track's declined path, sometimes unset (question Q14), win back only with a branch.
  const paths = branch > 0 ? PATHS : (["stop", "continue"] as const);
  const withPaths = tracks.map((t) => (t.channel === "call" && r() < 0.7 ? { ...t, declinedPath: pick(r, paths) } : t));
  return { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: [], smsPool: [], tracks: withPaths };
}

/** An operation the editor offers for this draft: on live tracks only, with good and bad values. */
function generateOperation(r: () => number, def: CampaignDefinition): ArrangeOperation {
  const live = def.tracks.filter((t) => !t.removed);
  const after = live.filter((t) => t.start.kind === "after");
  const calls = live.filter((t) => t.channel === "call");
  const branch = live.filter((t) => t.branch === "win_back");
  const kinds = live.length === 0 ? ["add"] : ["add", "add_win_back", "remove", "start", "start", "start", ...(after.length > 0 ? ["delay"] : []), ...(calls.length > 0 ? ["declined", "declined"] : []), ...(branch.length > 0 ? ["remove_win_back"] : [])];
  const kind = pick(r, kinds);
  if (kind === "add_win_back") return { kind: "add", channel: pick(r, ["email", "sms", "email", "sms", "call"] as const), branch: "win_back" };
  if (kind === "add" || live.length === 0) return { kind: "add", channel: pick(r, ["email", "sms", "call"] as const) };
  if (kind === "declined") return { kind: "declined", trackId: pick(r, r() < 0.9 ? calls : live).id, path: pick(r, PATHS) };
  if (kind === "remove_win_back") return { kind: "remove", trackId: pick(r, branch).id };
  if (kind === "remove") return { kind: "remove", trackId: pick(r, live).id };
  if (kind === "delay") return { kind: "delay", trackId: pick(r, after).id, days: pick(r, [0, 1, 2, 3, -1, 1.5, Number.NaN]) };
  const subject = pick(r, live);
  return r() < 0.25 ? { kind: "start", trackId: subject.id, start: { kind: "entry" } } : { kind: "start", trackId: subject.id, start: { kind: "after", trackId: pick(r, live).id, delayDays: pick(r, [0, 1, 2, 3, -2, 0.5]) } };
}

function runSeed(seed: number, broken?: ReadonlySet<ArrangeMutation>): void {
  const r = rng(seed);
  let def = generateDefinition(r);
  expect(definitionProblems(def)).toEqual([]);
  const everId = new Set(def.tracks.map((t) => t.id));
  for (let i = 0; i < 25; i++) {
    const op = generateOperation(r, def);
    const out = arrange(def, op, broken);
    if (!out.ok) {
      // 2. A refusal leaves the draft identical and says why.
      expect(out.reason.length).toBeGreaterThan(0);
      expect((out as { definition?: CampaignDefinition }).definition ?? def).toBe(def);
      // 3. Nothing is refused that the validator would accept.
      expect(definitionProblems(naive(def, op))).not.toEqual([]);
      continue;
    }
    const next = out.definition;
    // 1. The result is a draft the validator accepts.
    expect(definitionProblems(next)).toEqual([]);
    // 4. Only what the operation names changes.
    const others = (d: CampaignDefinition, except: string | null) => d.tracks.filter((t) => t.id !== except);
    if (op.kind === "add") {
      expect(others(next, out.added?.id ?? null)).toEqual(def.tracks);
      // 5. An added track's id has never been used.
      expect(everId.has(out.added?.id ?? "")).toBe(false);
      everId.add(out.added?.id ?? "");
    } else {
      expect(others(next, op.trackId)).toEqual(others(def, op.trackId));
      if (op.kind === "remove") expect(next.tracks.some((t) => t.id === op.trackId)).toBe(false);
    }
    def = next;
  }
}

describe("the arrangement rule, generated (ADR 0003, ticket 13b)", () => {
  const SEEDS = Number(process.env["ARRANGEMENT_SEEDS"] ?? 200);
  test(`${SEEDS} generated drafts and operation sequences keep every invariant`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) runSeed(seed);
  });

  const mutations: ArrangeMutation[] = [
    "no_cycle_check",
    "remove_ignores_dependants",
    "refusal_changes_draft",
    "refuse_every_after",
    "phone_track_with_a_follow_up",
    "phone_track_in_the_branch",
    "win_back_without_a_branch",
    "remove_ignores_win_back",
    "after_across_branches",
  ];
  for (const mutation of mutations) {
    test(`the mutation "${mutation}" fails it`, () => {
      let failed = 0;
      for (let seed = 1; seed <= 200; seed++) {
        try {
          runSeed(seed, new Set([mutation]));
        } catch {
          failed++;
        }
      }
      expect(failed).toBeGreaterThan(0);
    });
  }
});
