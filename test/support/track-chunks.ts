import { appendFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { runTracks, trackInvariantsOf } from "./generated-tracks.ts";
import { FULL_SEARCH, inShard, SEED } from "./sequence-chunks.ts";
import { TRACK_MUTATIONS } from "./track-mutations.ts";

/**
 * The generated track runs (ticket 13) in `pnpm check` and in the CI search (ADR 0003 9.2).
 * `pnpm check` runs a fixed, rule-covering seed set and each mutation's known killing seed; the
 * search (`pnpm test:sequence-search`, the `sequence-search` workflow) runs all 100 seeds, in
 * shards, and a seed search per mutation that prints the seed killing each.
 */

/**
 * Offsets from SEED. Chosen greedily from a sweep of all 100 seeds so that together they reach
 * every behaviour the runs report (`stats.features`): every profile, both connection kinds, both
 * channels, several campaigns, a conversation taken and one held by an ended owner, invalid and
 * numbers invalid at the call or after a send, bounces, releases after a skip and after a failure, replies on both
 * channels, reported late, between a claim and its handover and during a text, a second worker's handovers, claims
 * withdrawn by the guard and by age, and all three endings. Refresh it when the generator changes.
 */
// 11, 12, 29 and 78 (seeds 20261124, 20261125, 20261142, 20261191): regressions for the Activity
// check's record at the instant a lead ends or a number goes bad (the search on 7401eb2).
// 43 and 57 (question Q7 answered): a number joins a campaign's pool after a skip there, and a skip a claim delayed; 43 also
// a skip on a fixed sender after a mobile changed, 57 a number leaving a pool. 5 (after the reviews of bebdc06): a lead
// held under the interim engine, skipped at the upgrade. 2, 3 and 12: a number refusing a text for an account reason.
// 76 and 84 (the search on faac357): a skip the app could only decide once it learnt late that the track had started, and
// a waiting claim tried at the instant its slot freed, ahead of a lower-priority handover there. 50 and 85 (the reviews
// of faac357): a first text refused hours after its acceptance while another campaign's lead waits on it, and one never
// answered, which the user marks not sent. 14 and 16: the mobile answers a first text the app does not yet know went,
// while another campaign's lead on it waits.
export const TRACK_FIXED_SEEDS: readonly number[] = [2, 3, 4, 5, 11, 12, 14, 16, 29, 43, 50, 57, 61, 76, 78, 84, 85];
const SEARCH_SEEDS = 100;
/** Seed offsets each mutation's search tries after its recorded seed. */
const MAX_SEEDS = 30;
/** Every mutation replay stops after this many engine writes; an unmutated sweep needs under 3,000. */
const RUN_WRITES = 10_000;

function report(line: string): void {
  console.info(line);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary) appendFileSync(summary, `- ${line}\n`);
}

/** The generated track runs from `from` to `to` (offsets from SEED): all of them under the full search, otherwise the fixed seeds in that range. */
export function trackChunks(from: number, to: number): void {
  const offsets = FULL_SEARCH ? Array.from({ length: Math.min(to, SEARCH_SEEDS) - from }, (_, i) => from + i).filter(inShard) : TRACK_FIXED_SEEDS.filter((o) => o >= from && o < to);
  describe(`generated track runs keep the engine's invariants (${FULL_SEARCH ? "full search" : "fixed seeds"}, ${SEED + from} to ${SEED + to - 1})`, () => {
    if (offsets.length === 0) test.skip("no seed of this run in this range", () => undefined);
    for (let i = 0; i < offsets.length; i += 10) {
      const chunk = offsets.slice(i, i + 10);
      test(`seeds ${chunk.map((o) => SEED + o).join(", ")}`, async () => {
        const failures: string[] = [];
        for (const offset of chunk) {
          const { problems, stats } = await runTracks(SEED + offset);
          for (const f of stats.features) reached.add(f);
          if (problems.length > 0) failures.push(`seed ${SEED + offset}: ${problems.join("; ")}`);
        }
        for (const failure of failures) console.error(failure);
        expect(failures).toEqual([]);
      }, 1_800_000);
    }
    if (!FULL_SEARCH && from === 0) {
      // Ticket 16 (review bot on 654907b): Activity and progress are compared for campaigns with a win-back branch
      // that no lead here enters, including a lead with no usable channel at launch, whose skips Activity states.
      test("the fixed seeds reach a never-entered branch beside a running lead and beside a lead with no channel at launch", () => {
        expect(["a-lead-beside-a-branch-never-entered", "no-channel-at-launch-beside-a-branch"].filter((f) => !reached.has(f))).toEqual([]);
      });
      // The review bot on 0922582: an email track and an SMS track every lead had started, removed before a lead's first claim.
      test("the fixed seeds remove a started email track and a started SMS track before a lead's first claim", () => {
        expect(["a-started-email-track-removed-before-its-first-claim", "a-started-sms-track-removed-before-its-first-claim"].filter((f) => !reached.has(f))).toEqual([]);
      });
      // Review bot on b21af02: a LinkedIn track started after its text, in the campaign beside SMS.
      test("the fixed seeds start a LinkedIn track after a text on the same person", () => {
        expect(reached.has("linkedin-after-its-text")).toBe(true);
      });
      // Question Q7 answered: a track skipped for a taken conversation, one whose skip a waiting claim delayed, the track
      // after one released by it, and a number joining that campaign's pool after the skip.
      test("the fixed seeds skip SMS tracks for taken conversations, after a claim's wait too, release the tracks after them, and add a number after a skip", () => {
        expect(
          [
            "conversation-taken",
            "conversation-taken-skip-after-a-claim",
            "conversation-taken-held-under-the-interim",
            "conversation-taken-on-a-fixed-sender",
            "released-after:skipped_conversation_taken",
            "a-number-joined-after-a-skip-in-its-campaign",
            "a-number-left-a-pool",
            "a-mobile-changed",
            "a-number-refuses-a-text",
            "a-first-text-refused-after-acceptance",
            "a-first-text-never-answered",
            "held-on-an-unsettled-conversation",
            "a-reply-before-its-text-was-known-sent",
          ].filter((f) => !reached.has(f)),
        ).toEqual([]);
      });
    }
  });
}

/** The behaviours the runs of this process reached. */
const reached = new Set<string>();

/**
 * Each broken engine must fail the invariant it names: in `pnpm check` on its known seed; in the
 * search on its known seed or the first of MAX_SEEDS offsets, which is printed.
 */
export function trackOracle(): void {
  const names = Object.keys(TRACK_MUTATIONS);
  for (const [index, name] of names.entries()) {
    const mutation = TRACK_MUTATIONS[name]!;
    const run = inShard(index) ? test : test.skip;
    run(`the generated track runs fail invariant ${mutation.invariant} for an engine with "${name}"`, async () => {
      const breaks = (problems: readonly string[]) => problems.some((p) => trackInvariantsOf(p).includes(mutation.invariant));
      const undo = mutation.patch?.();
      try {
        await replay(name, mutation, breaks);
      } finally {
        undo?.();
      }
    }, 1_800_000);
  }
}

/** One mutation's replay: in `pnpm check` its recorded seed; in the search that seed, then the first of MAX_SEEDS offsets. */
async function replay(name: string, mutation: (typeof TRACK_MUTATIONS)[string], breaks: (problems: readonly string[]) => boolean): Promise<void> {
  if (!FULL_SEARCH) {
    const { problems } = await runTracks(SEED + mutation.seed, { rules: mutation.rules, maxWrites: RUN_WRITES });
    expect(problems.filter((p) => trackInvariantsOf(p).includes(mutation.invariant)), `seed ${SEED + mutation.seed} no longer breaks invariant ${mutation.invariant}; run the sequence-search workflow and update its seed. Problems: ${problems.join("; ")}`).not.toEqual([]);
    return;
  }
  let caught: string | null = null;
  if (breaks((await runTracks(SEED + mutation.seed, { rules: mutation.rules, maxWrites: RUN_WRITES })).problems)) caught = `recorded seed offset ${mutation.seed}`;
  else report(`recorded seed offset ${mutation.seed} no longer breaks invariant ${mutation.invariant} for track mutation "${name}"`);
  for (let i = 0; i < MAX_SEEDS && caught === null; i++) {
    if (breaks((await runTracks(SEED + i, { rules: mutation.rules, maxWrites: RUN_WRITES })).problems)) caught = `seed offset ${i}`;
  }
  report(`killing seed: track mutation "${name}" (invariant ${mutation.invariant}): ${caught ?? `none in offsets 0-${MAX_SEEDS - 1}`}; recorded seed ${mutation.seed}`);
  expect(caught, `no seed broke invariant ${mutation.invariant} for "${name}"`).not.toBeNull();
}
