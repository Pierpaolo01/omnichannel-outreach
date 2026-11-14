/**
 * How the editor arranges a campaign's tracks (ADR 0003, ticket 13b, "The arrangement rule"): pure
 * operations, each returning the new definition or a refusal in plain words. Since ticket 14c
 * `add` adds phone tracks too: one call, with no copy. Since ticket 16b `add` adds email and SMS
 * tracks to the win-back branch, and `declined` sets a phone track's declined path; what the
 * definition refuses about the branch (a phone track in it, win back with no live branch track, a
 * connection across branches) is refused here in the definition's own sentence. A refused
 * operation leaves the draft as it was. From a draft the validator accepts, no operation produces
 * one it refuses (ADR 0003 7.1): a cycle, a start after a missing track, a negative or fractional
 * delay. `arrangement.generated.test.ts` asserts the rule's invariants after every operation.
 */
import { definitionIssues, definitionProblems, issueKey, type Branch, type DeclinedPath } from "../../domain/sequence/definition.ts";
import type { CampaignDefinition, StartRule, TrackDefinition } from "../../shared/api.ts";
import { newTrack, trackName } from "./model.ts";

export type ArrangeOperation =
  /** A new track, in the main sequence unless `branch` names the win-back branch. */
  | { readonly kind: "add"; readonly channel: "email" | "sms" | "call"; readonly branch?: Branch }
  /** A phone track's declined path (ticket 16b): what a declined call on it does. */
  | { readonly kind: "declined"; readonly trackId: string; readonly path: DeclinedPath }
  | { readonly kind: "remove"; readonly trackId: string }
  | { readonly kind: "start"; readonly trackId: string; readonly start: StartRule }
  | { readonly kind: "delay"; readonly trackId: string; readonly days: number };

export type Arranged = { readonly ok: true; readonly definition: CampaignDefinition; readonly added?: TrackDefinition } | { readonly ok: false; readonly reason: string };

/** Deliberately broken versions of the rule, for the generated test's mutations only. */
export type ArrangeMutation =
  | "no_cycle_check"
  | "remove_ignores_dependants"
  | "refusal_changes_draft"
  | "refuse_every_after"
  | "phone_track_with_a_follow_up"
  | "phone_track_in_the_branch"
  | "win_back_without_a_branch"
  | "remove_ignores_win_back"
  | "after_across_branches"
  | "problems_compared_by_sentence";
const NONE: ReadonlySet<ArrangeMutation> = new Set();

const refuse = (reason: string): Arranged => ({ ok: false, reason });
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isWholeDays = (n: number) => Number.isInteger(n) && n >= 0;

/** Whether `track` waits, through its chain of `after` starts, on the track with id `on`. */
function waitsOn(def: CampaignDefinition, track: TrackDefinition, on: string): boolean {
  const seen = new Set<string>();
  let t: TrackDefinition | undefined = track;
  while (t && t.start.kind === "after" && !seen.has(t.id)) {
    seen.add(t.id);
    const before: string = t.start.trackId;
    if (before === on) return true;
    t = def.tracks.find((x) => x.id === before);
  }
  return false;
}

const live = (def: CampaignDefinition) => def.tracks.filter((t) => !t.removed);

/**
 * What the definition would newly refuse in `next` (ADR 0003 7.1), in its own sentence, or null. The
 * branch's refusals are the definition's: the editor says what the server would. A problem is new by its
 * identity (`issueKey`: its kind and the track and step it is about), never by its sentence: removing or
 * adding a track renames its siblings, so a problem a sibling already had would read as new (council on
 * aaf82b7). The mutation `problems_compared_by_sentence` compares sentences instead.
 */
function newProblem(def: CampaignDefinition, next: CampaignDefinition, broken: ReadonlySet<ArrangeMutation>): string | null {
  if (broken.has("problems_compared_by_sentence")) {
    const sentences = new Set(definitionProblems(def));
    return definitionProblems(next).find((p) => !sentences.has(p)) ?? null;
  }
  const before = new Set(definitionIssues(def).map(issueKey));
  return definitionIssues(next).find((issue) => !before.has(issueKey(issue)))?.text ?? null;
}

export function arrange(def: CampaignDefinition, op: ArrangeOperation, broken: ReadonlySet<ArrangeMutation> = NONE): Arranged {
  const out = decide(def, op, broken);
  // Mutation only: a refusal that still applies the operation.
  if (!out.ok && broken.has("refusal_changes_draft")) return { ok: false, reason: out.reason, ...{ definition: naive(def, op) } };
  return out;
}

/** The operation applied with no check at all: what the rule refuses would come out of this. */
export function naive(def: CampaignDefinition, op: ArrangeOperation): CampaignDefinition {
  const change = (trackId: string, f: (t: TrackDefinition) => TrackDefinition) => ({ ...def, tracks: def.tracks.map((t) => (t.id === trackId ? f(t) : t)) });
  switch (op.kind) {
    case "add":
      return { ...def, tracks: [...def.tracks, newTrack(op.channel, op.branch)] };
    case "declined":
      return change(op.trackId, (t) => ({ ...t, declinedPath: op.path }));
    case "remove":
      return { ...def, tracks: def.tracks.filter((t) => t.id !== op.trackId) };
    case "start":
      return change(op.trackId, (t) => ({ ...t, start: op.start }));
    case "delay":
      return change(op.trackId, (t) => (t.start.kind === "after" ? { ...t, start: { ...t.start, delayDays: op.days } } : t));
  }
}

function decide(def: CampaignDefinition, op: ArrangeOperation, broken: ReadonlySet<ArrangeMutation>): Arranged {
  if (op.kind === "add") {
    // The win-back branch holds no phone track (spec "no cold call"): the editor never offers one.
    if (op.branch === "win_back" && op.channel === "call" && !broken.has("phone_track_in_the_branch")) return refuse(newProblem(def, naive(def, op), broken) ?? "The win-back branch cannot hold a phone track.");
    const used = new Set(def.tracks.map((t) => t.id));
    let added = newTrack(op.channel, op.branch);
    while (used.has(added.id)) added = newTrack(op.channel, op.branch);
    // Mutation only: a phone track added with a follow-up, which a phone track never has.
    const call = added.steps[0];
    if (op.channel === "call" && call && broken.has("phone_track_with_a_follow_up")) added = { ...added, steps: [...added.steps, { ...call, id: `${added.id}-again`, waitDays: 1 }] };
    return { ok: true, definition: { ...def, tracks: [...def.tracks, added] }, added };
  }
  const track = live(def).find((t) => t.id === op.trackId);
  if (!track) return refuse("That track is no longer in the sequence.");

  if (op.kind === "remove") {
    const dependant = live(def).find((t) => t.start.kind === "after" && t.start.trackId === track.id);
    if (dependant && !broken.has("remove_ignores_dependants")) return refuse(`${capitalise(trackName(def, dependant))} starts after this one. Change how it starts first.`);
    // The branch's last live track, while a phone track's declined path is win back (ticket 16b).
    const next = naive(def, op);
    const problem = track.branch === "win_back" && !broken.has("remove_ignores_win_back") ? newProblem(def, next, broken) : null;
    if (problem) return refuse(problem);
    return { ok: true, definition: next };
  }

  if (op.kind === "declined") {
    const next = naive(def, op);
    if (track.channel !== "call") return refuse(newProblem(def, next, broken) ?? "Only a phone track has a declined path.");
    // Win back only once the branch has a live track: the definition's `winBackAvailable`, said in its own sentence.
    if (op.path === "win_back" && !broken.has("win_back_without_a_branch")) {
      const problem = newProblem(def, next, broken);
      if (problem) return refuse(problem);
    }
    return { ok: true, definition: next };
  }

  if (op.kind === "delay") {
    if (track.start.kind !== "after") return refuse("This track starts at launch, so it has no delay.");
    if (!isWholeDays(op.days)) return refuse("The delay is a whole number of days, 0 or more.");
    return { ok: true, definition: naive(def, op) };
  }

  const start = op.start;
  if (start.kind === "after") {
    if (broken.has("refuse_every_after")) return refuse("A track can’t start after another.");
    if (start.trackId === track.id) return refuse("A track can’t start after itself.");
    const before = live(def).find((t) => t.id === start.trackId);
    if (!before) return refuse("That track is no longer in the sequence.");
    // The declined path is the only branch point: no connection crosses between the branch and the main sequence.
    if (before.branch !== track.branch && !broken.has("after_across_branches")) return refuse(newProblem(def, naive(def, op), broken) ?? "That track is in the other branch.");
    if (!isWholeDays(start.delayDays)) return refuse("The delay is a whole number of days, 0 or more.");
    if (waitsOn(def, before, track.id) && !broken.has("no_cycle_check")) return refuse(`${capitalise(trackName(def, before))} starts after this one, so this one can’t start after it: each would wait for the other.`);
  }
  return { ok: true, definition: naive(def, op) };
}
