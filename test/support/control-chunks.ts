import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { CONTROL_MUTATIONS } from "./control-mutations.ts";
import { controlInvariantsOf, runControls } from "./generated-controls.ts";
import { FULL_SEARCH, inShard } from "./sequence-chunks.ts";

/**
 * The generated control runs (ticket 17a) in `pnpm check` and in the CI search (ADR 0003 9.2), as the call runs
 * are: `pnpm check` runs the fixed, behaviour-covering seeds and each mutation's known killing seed; the search
 * (`pnpm test:sequence-search`, the `sequence-search` workflow) runs all 100 seeds in shards and a seed search per
 * mutation that prints the seed killing each.
 */

export const CONTROL_SEED = 17_000;
/** Offsets from CONTROL_SEED, chosen greedily from a sweep of all 100 (14 November 2026, after the review bot and the verifier on ca8baee) to reach every behaviour below. */
export const CONTROL_FIXED_SEEDS: readonly number[] = [0, 8, 31, 33, 37, 45, 48, 61, 76, 86, 96];
const SEARCH_SEEDS = 100;
const MAX_SEEDS = 30;
const RUN_WRITES = 10_000;

/** Every behaviour the fixed seeds must reach between them. A name leaves it only into RETIRED_CONTROL_FEATURES, with its reason. */
export const CONTROL_FEATURES: readonly string[] = [
  "a-call-track",
  "a-control-just-after-a-due-instant",
  "a-control-sent-again",
  "a-email-track",
  "a-email-track-in-win-back",
  "a-hidden-reply",
  "a-hidden-reply-found-by-the-pre-send-check",
  "a-hidden-reply-observed",
  "a-new-reply-in-a-later-thread-after-a-restart",
  "a-new-reply-in-an-earlier-thread-after-a-restart",
  "a-new-reply-in-the-latest-thread-after-a-restart",
  "a-refused-request-sent-again-later",
  "a-reply-after-the-sequence-finished",
  "a-reply-to-a-stopped-lead",
  "a-reply-while-paused",
  "a-sms-track",
  "a-wait-moved-by-a-hold",
  "an-auto-reply",
  "campaign-paused",
  "campaign-resumed",
  "late-sends",
  "lookups-lag",
  "move_to_win_back-accepted",
  "move_to_win_back-inside-a-paused-campaign",
  "move_to_win_back-refused",
  "move_to_win_back-refused-with-uncertain-work",
  "move_to_win_back-with-a-call-listed",
  "pause-accepted",
  "pause-inside-a-paused-campaign",
  "pause-refused",
  "pause-with-a-call-listed",
  "pause-with-a-claim-open",
  "pause-with-uncertain-work",
  "pause-with-work-at-the-provider",
  "restarted-after-a-reply",
  "restarted-after-a-stop",
  "resume-accepted",
  "resume-inside-a-paused-campaign",
  "resume-refused",
  "resume-refused-with-uncertain-work",
  "resume-with-uncertain-work",
  "resume_from_next_step-accepted",
  "resume_from_next_step-inside-a-paused-campaign",
  "resume_from_next_step-refused",
  "resume_from_next_step-refused-with-uncertain-work",
  "resume_from_next_step-with-a-call-listed",
  "resume_from_next_step-with-uncertain-work",
  "resume_from_next_step-with-work-at-the-provider",
  "skip-accepted",
  "skip-after-a-pause-with-a-lookup-lagging",
  "skip-inside-a-paused-campaign",
  "skip-refused",
  "skip-refused-with-uncertain-work",
  "skip-refused-with-work-at-the-provider",
  "skip-with-a-call-listed",
  "skip-with-a-claim-open",
  "skip-with-uncertain-work",
  "skip-with-work-at-the-provider",
  "skipped-a-call-step",
  "skipped-a-email-step",
  "skipped-a-sms-step",
  "stop-accepted",
  "stop-inside-a-paused-campaign",
  "stop-refused",
  "stop-with-a-call-listed",
  "stop-with-a-claim-open",
  "stop-with-uncertain-work",
  "stop-with-work-at-the-provider",
  "withdrawals-answered-unknown-and-sent",
];

export const RETIRED_CONTROL_FEATURES: Readonly<Record<string, string>> = {
  "move_to_win_back-with-a-claim-open": "A name the generator can form that none of the 100 seeds reached in the sweep of 14 November 2026; not required of the fixed seeds.",
  "move_to_win_back-with-uncertain-work": "A name the generator can form that none of the 100 seeds reached in the sweep of 14 November 2026; not required of the fixed seeds.",
  "move_to_win_back-with-work-at-the-provider": "A name the generator can form that none of the 100 seeds reached in the sweep of 14 November 2026; not required of the fixed seeds.",
  "pause-refused-with-uncertain-work": "A name the generator can form that none of the 100 seeds reached in the sweep of 14 November 2026; not required of the fixed seeds.",
  "resume-with-a-call-listed": "A name the generator can form that none of the 100 seeds reached in the sweep of 14 November 2026; not required of the fixed seeds.",
  "resume-with-a-claim-open": "A name the generator can form that none of the 100 seeds reached in the sweep of 14 November 2026; not required of the fixed seeds.",
  "resume-with-work-at-the-provider": "A name the generator can form that none of the 100 seeds reached in the sweep of 14 November 2026; not required of the fixed seeds.",
  "resume_from_next_step-with-a-claim-open": "A name the generator can form that none of the 100 seeds reached in the sweep of 14 November 2026; not required of the fixed seeds.",
  "stop-refused-with-uncertain-work": "A name the generator can form that none of the 100 seeds reached in the sweep of 14 November 2026; not required of the fixed seeds.",
};

const known = (name: string) => CONTROL_FEATURES.includes(name) || name in RETIRED_CONTROL_FEATURES;
const reached = new Set<string>();

export function controlChunks(): void {
  const offsets = FULL_SEARCH ? Array.from({ length: SEARCH_SEEDS }, (_, i) => i).filter(inShard) : CONTROL_FIXED_SEEDS;
  describe(`generated control runs keep the invariants of ticket 17a (${FULL_SEARCH ? "full search" : "fixed seeds"})`, () => {
    if (offsets.length === 0) test.skip("no seed of this run in this shard", () => undefined);
    for (let i = 0; i < offsets.length; i += 10) {
      const chunk = offsets.slice(i, i + 10);
      test(`seeds ${chunk.map((o) => CONTROL_SEED + o).join(", ")}`, async () => {
        const failures: string[] = [];
        for (const offset of chunk) {
          const { problems, stats } = await runControls(CONTROL_SEED + offset);
          for (const f of stats.features) reached.add(f);
          if (problems.length > 0) failures.push(`seed ${CONTROL_SEED + offset}: ${problems.join("; ")}`);
          const unknown = stats.features.filter((f) => !known(f));
          if (unknown.length > 0) failures.push(`seed ${CONTROL_SEED + offset} reaches behaviours in neither list: ${unknown.join(", ")}`);
        }
        for (const failure of failures) console.error(failure);
        expect(failures).toEqual([]);
      }, 1_800_000);
    }
    if (!FULL_SEARCH) {
      test("the fixed seeds reach every behaviour they were chosen for", () => {
        expect(CONTROL_FEATURES.filter((f) => !reached.has(f))).toEqual([]);
      });
      test("every literal behaviour name in the generator is listed or retired", () => {
        const source = readFileSync(new URL("./generated-controls.ts", import.meta.url), "utf8");
        const literals = [...source.matchAll(/features\.add\("([^"]+)"\)/g)].map((m) => m[1] ?? "");
        expect(literals.filter((name) => !known(name))).toEqual([]);
      });
    }
  });
}

/** Each broken control must fail the invariant it names: on its known seed in `pnpm check`; in the search, on it or the first of MAX_SEEDS offsets. */
export function controlOracle(): void {
  for (const [index, [name, mutation]] of Object.entries(CONTROL_MUTATIONS).entries()) {
    const run = inShard(index) ? test : test.skip;
    run(`the generated control runs fail ${mutation.invariant} for an engine with "${name}"`, async () => {
      const breaks = (problems: readonly string[]) => problems.some((p) => controlInvariantsOf(p).includes(mutation.invariant));
      if (!FULL_SEARCH) {
        const { problems } = await runControls(CONTROL_SEED + mutation.seed, { ...mutation.options, rules: mutation.rules, maxWrites: RUN_WRITES });
        expect(breaks(problems), `seed ${CONTROL_SEED + mutation.seed} no longer breaks ${mutation.invariant}; run the sequence-search workflow and update its seed. Problems: ${problems.join("; ")}`).toBe(true);
        return;
      }
      let caught: number | null = breaks((await runControls(CONTROL_SEED + mutation.seed, { ...mutation.options, rules: mutation.rules, maxWrites: RUN_WRITES })).problems) ? mutation.seed : null;
      for (let o = 0; o < MAX_SEEDS && caught === null; o++) if (breaks((await runControls(CONTROL_SEED + o, { ...mutation.options, rules: mutation.rules, maxWrites: RUN_WRITES })).problems)) caught = o;
      console.info(`killing seed: control mutation "${name}" (${mutation.invariant}): ${caught ?? "none"}; recorded ${mutation.seed}`);
      expect(caught).not.toBeNull();
    }, 1_800_000);
  }
}
