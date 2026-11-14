import { appendFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { CALL_MUTATIONS } from "./call-mutations.ts";
import { callInvariantsOf, runCalls } from "./generated-calls.ts";
import { FULL_SEARCH, inShard, SEED } from "./sequence-chunks.ts";

/**
 * The generated call runs (ticket 14) in `pnpm check` and in the CI search (ADR 0003 9.2), as the
 * ticket 13 track runs are: `pnpm check` runs a fixed, rule-covering seed set and each mutation's
 * known killing seed; the search (`pnpm test:sequence-search`, the `sequence-search` workflow) runs
 * all 100 seeds, in shards, and a seed search per mutation that prints the seed killing each.
 */

/**
 * Offsets from SEED, chosen greedily from a sweep of all 100 seeds so that together they reach every
 * behaviour the runs report (`stats.features`). Which behaviours those are is `CALL_FEATURES`, and
 * `pnpm check` asserts that the fixed seeds' runs reach every one of them, so a change to the generator
 * cannot silently drop one. Refresh both when the generator changes (last swept on 14 November 2026, ticket
 * 16a after the verifier on 654907b: 102 behaviours, among them a decline on each path with main-sequence work
 * claimed or with the provider, late sends, and a redial off a callback after a gatekeeper, restored by a
 * targeted draw).
 */
export const CALL_FIXED_SEEDS: readonly number[] = [0, 6, 8, 9, 13, 16, 21, 37, 42, 43, 60, 61, 98];

/** Every behaviour the fixed seeds must reach between them. */
export const CALL_FEATURES: readonly string[] = [
  "a-company-zone-moved",
  "a-later-phone-track-skipped-as-declined",
  "a-person-zone-moved",
  "a-phone-track-released-by-the-decline-skipped",
  "a-redial-skipped-from-its-original-due-date",
  "a-send-beside-an-open-call",
  "a-send-in-win-back",
  "a-started-main-track-dropped",
  "a-win-back-branch",
  "acted-after-a-callback-time-before-the-tick",
  "acted-after-a-rollover-before-the-tick",
  "acted-just-before-a-due-instant",
  "activity-compared-beside-a-branch-never-entered",
  "activity-compared-in-win-back",
  "activity-in-win-back",
  "activity-of-a-dropped-track",
  "after-a-call",
  "an-expiry-released-a-track",
  "an-open-call-skipped-as-declined",
  "an-unstarted-main-track-dropped",
  "bad-number-chosen",
  "call-list-zone-moved",
  "callback-for-a-later-day",
  "callback-hold",
  "callback-later-today",
  "callback-worked:callback_requested",
  "callback-worked:gatekeeper",
  "callback-worked:gatekeeper+redial",
  "callback-worked:interested",
  "callback-worked:no_answer",
  "callback-worked:no_answer+redial",
  "callback-worked:not_interested",
  "callback-worked:skip_for_now",
  "callback-worked:voicemail",
  "callback-worked:voicemail+redial",
  "callback-worked:wrong_number",
  "capacity:1",
  "capacity:2",
  "capacity:3",
  "capacity:5",
  "closed-on-interest",
  "declined-path-overridden",
  "declined-path-with-another-outcome",
  "declined-with-a-main-claim-waiting",
  "declined-with-a-main-send-with-the-provider",
  "declined-with-another-call-open",
  "declined-with-no-path-set",
  "declined-with-work-in-flight:continue",
  "declined-with-work-in-flight:stop",
  "declined-with-work-in-flight:win_back",
  "declined:continue",
  "declined:stop",
  "declined:win_back",
  "email-reply",
  "ended:declined_on_call",
  "ended:finished_no_usable_channel",
  "ended:interested_on_call",
  "ended:replied",
  "ended:sequence_finished_no_response",
  "in-win-back",
  "late-sends",
  "later-today",
  "limit:1",
  "limit:2",
  "limit:3",
  "outcome-on-a-redial-for-tomorrow",
  "outcome-refused",
  "outcome:callback_requested",
  "outcome:gatekeeper",
  "outcome:gatekeeper+redial",
  "outcome:interested",
  "outcome:no_answer",
  "outcome:no_answer+redial",
  "outcome:not_interested",
  "outcome:skip_for_now",
  "outcome:voicemail",
  "outcome:voicemail+redial",
  "outcome:wrong_number",
  "overdue-callback-for-days",
  "parallel-with-a-call",
  "phone-skipped",
  "posted-twice-at-once",
  "ready-now-of-several-reasons",
  "reason:callback",
  "reason:due",
  "reason:overdue",
  "reason:redial",
  "reason:rolled_over",
  "redial-with-the-wrong-outcome",
  "replayed",
  "replayed-after-restart",
  "replied-in-win-back",
  "rolled-over",
  "skipped-call-last",
  "skipped-unworked",
  "sms-reply",
  "two-phone-tracks",
  "two-ready-calls",
  "waits-behind-committed",
  "waits-for-room",
  "win-back-refused-without-a-branch",
  "wrong-mobile",
];
const SEARCH_SEEDS = 100;
/** Seed offsets each mutation's search tries after its recorded seed. */
const MAX_SEEDS = 30;
/** Every mutation replay stops after this many engine writes; an unmutated sweep needs under 250. */
const RUN_WRITES = 10_000;

function report(line: string): void {
  console.info(line);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary) appendFileSync(summary, `- ${line}\n`);
}

/** The generated call runs from `from` to `to` (offsets from SEED): all of them under the full search, otherwise the fixed seeds in that range. */
export function callChunks(from: number, to: number): void {
  const offsets = FULL_SEARCH ? Array.from({ length: Math.min(to, SEARCH_SEEDS) - from }, (_, i) => from + i).filter(inShard) : CALL_FIXED_SEEDS.filter((o) => o >= from && o < to);
  describe(`generated call runs keep the engine's invariants (${FULL_SEARCH ? "full search" : "fixed seeds"}, ${SEED + from} to ${SEED + to - 1})`, () => {
    if (offsets.length === 0) test.skip("no seed of this run in this range", () => undefined);
    for (let i = 0; i < offsets.length; i += 10) {
      const chunk = offsets.slice(i, i + 10);
      test(`seeds ${chunk.map((o) => SEED + o).join(", ")}`, async () => {
        const failures: string[] = [];
        for (const offset of chunk) {
          const { problems, stats } = await runCalls(SEED + offset);
          for (const f of stats.features) reached.add(f);
          if (problems.length > 0) failures.push(`seed ${SEED + offset}: ${problems.join("; ")}`);
        }
        for (const failure of failures) console.error(failure);
        expect(failures).toEqual([]);
      }, 1_800_000);
    }
    if (!FULL_SEARCH && from === 0) {
      test("the fixed seeds reach every behaviour they were chosen for", () => {
        expect(CALL_FEATURES.filter((f) => !reached.has(f))).toEqual([]);
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
export function callOracle(): void {
  const names = Object.keys(CALL_MUTATIONS);
  for (const [index, name] of names.entries()) {
    const mutation = CALL_MUTATIONS[name]!;
    const run = inShard(index) ? test : test.skip;
    run(`the generated call runs fail invariant ${mutation.invariant} for an engine with "${name}"`, async () => {
      const breaks = (problems: readonly string[]) => problems.some((p) => callInvariantsOf(p).includes(mutation.invariant));
      if (!FULL_SEARCH) {
        const { problems } = await runCalls(SEED + mutation.seed, { rules: mutation.rules, maxWrites: RUN_WRITES });
        expect(problems.filter((p) => callInvariantsOf(p).includes(mutation.invariant)), `seed ${SEED + mutation.seed} no longer breaks invariant ${mutation.invariant}; run the sequence-search workflow and update its seed. Problems: ${problems.join("; ")}`).not.toEqual([]);
        return;
      }
      let caught: string | null = null;
      if (breaks((await runCalls(SEED + mutation.seed, { rules: mutation.rules, maxWrites: RUN_WRITES })).problems)) caught = `recorded seed offset ${mutation.seed}`;
      else report(`recorded seed offset ${mutation.seed} no longer breaks invariant ${mutation.invariant} for call mutation "${name}"`);
      for (let i = 0; i < MAX_SEEDS && caught === null; i++) {
        if (breaks((await runCalls(SEED + i, { rules: mutation.rules, maxWrites: RUN_WRITES })).problems)) caught = `seed offset ${i}`;
      }
      report(`killing seed: call mutation "${name}" (invariant ${mutation.invariant}): ${caught ?? `none in offsets 0-${MAX_SEEDS - 1}`}; recorded seed ${mutation.seed}`);
      expect(caught, `no seed broke invariant ${mutation.invariant} for "${name}"`).not.toBeNull();
    }, 1_800_000);
  }
}
