/**
 * How the editor arranges a campaign's tracks (ADR 0003, ticket 13b, "The arrangement rule"): four
 * pure operations, each returning the new definition or a refusal in plain words. Since ticket 14c
 * `add` adds phone tracks too: one call, with no copy. A refused
 * operation leaves the draft as it was. From a draft the validator accepts, no operation produces
 * one it refuses (ADR 0003 7.1): a cycle, a start after a missing track, a negative or fractional
 * delay. `arrangement.generated.test.ts` asserts the rule's invariants after every operation.
 */
import type { CampaignDefinition, StartRule, TrackDefinition } from "../../shared/api.ts";
import { newTrack, trackName } from "./model.ts";

export type ArrangeOperation =
  | { readonly kind: "add"; readonly channel: "email" | "sms" | "call" }
  | { readonly kind: "remove"; readonly trackId: string }
  | { readonly kind: "start"; readonly trackId: string; readonly start: StartRule }
  | { readonly kind: "delay"; readonly trackId: string; readonly days: number };

export type Arranged = { readonly ok: true; readonly definition: CampaignDefinition; readonly added?: TrackDefinition } | { readonly ok: false; readonly reason: string };

/** Deliberately broken versions of the rule, for the generated test's mutations only. */
export type ArrangeMutation = "no_cycle_check" | "remove_ignores_dependants" | "refusal_changes_draft" | "refuse_every_after" | "phone_track_with_a_follow_up";
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
      return def;
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
    const used = new Set(def.tracks.map((t) => t.id));
    let added = newTrack(op.channel);
    while (used.has(added.id)) added = newTrack(op.channel);
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
    return { ok: true, definition: naive(def, op) };
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
    if (!before || before.branch !== track.branch) return refuse("That track is no longer in the sequence.");
    if (!isWholeDays(start.delayDays)) return refuse("The delay is a whole number of days, 0 or more.");
    if (waitsOn(def, before, track.id) && !broken.has("no_cycle_check")) return refuse(`${capitalise(trackName(def, before))} starts after this one, so this one can’t start after it: each would wait for the other.`);
  }
  return { ok: true, definition: naive(def, op) };
}
