import { describe, expect, test } from "vitest";
import { MEASURE_MUTATIONS } from "./measure-mutations.ts";
import { measureInvariantsOf, runMeasures } from "./generated-measures.ts";
import { FULL_SEARCH, inShard } from "./sequence-chunks.ts";

/**
 * The generated measure runs (ticket 22) in `pnpm check` and in the CI search (ADR 0003 9.2), as the bulk runs are:
 * `pnpm check` runs the fixed, behaviour-covering seeds and each mutation's known killing seed; the search
 * (`pnpm test:sequence-search`, the `sequence-search` workflow) runs all 100 seeds in shards and a seed search per
 * mutation that prints the seed killing each.
 */

export const MEASURE_SEED = 22_000;
/**
 * Offsets from MEASURE_SEED, chosen from a sweep of the first 60 (15 November 2026; every one passed) to reach every
 * behaviour below between them; the mutations' killing seeds run beside them.
 */
export const MEASURE_FIXED_SEEDS: readonly number[] = [2, 18, 22, 25, 39];
const SEARCH_SEEDS = 100;
const MAX_SEEDS = 40;

/** Every behaviour the fixed seeds must reach between them. */
export const MEASURE_FEATURES: readonly string[] = [
  "a-callback-completed",
  "a-callback-of-a-stopped-lead",
  "a-callback-while-paused",
  "a-reply-after-interested",
  "a-reply-after-the-lead-ended",
  "a-reply-by-email",
  "a-reply-by-sms",
  "a-reply-in-the-other-campaign",
  "a-second-reply",
  "a-second-reply-on-the-other-channel",
  "call-callback-requested",
  "call-gatekeeper",
  "call-interested",
  "call-no-answer",
  "call-not-interested",
  "call-redial",
  "call-skip-for-now",
  "call-voicemail",
  "call-wrong-number",
  "campaign-pause",
  "campaign-resume",
  "checked-with-a-message-at-the-provider",
  "email-bounced",
  "email-refused",
  "email-sent",
  "lead-pause",
  "lead-resume",
  "lead-resume-from-next-step",
  "lead-stop",
  "providers-send-late",
  "resumed-after-a-reply",
  "sms-bounced",
  "sms-refused",
  "sms-sent",
];

const reached = new Set<string>();

export function measureChunks(): void {
  const offsets = FULL_SEARCH ? Array.from({ length: SEARCH_SEEDS }, (_, i) => i).filter(inShard) : MEASURE_FIXED_SEEDS;
  describe(`generated measure runs keep the invariants of ticket 22 (${FULL_SEARCH ? "full search" : "fixed seeds"})`, () => {
    if (offsets.length === 0) test.skip("no seed of this run in this shard", () => undefined);
    for (let i = 0; i < offsets.length; i += 10) {
      const chunk = offsets.slice(i, i + 10);
      test(`seeds ${chunk.map((o) => MEASURE_SEED + o).join(", ")}`, async () => {
        const failures: string[] = [];
        for (const offset of chunk) {
          const { problems, stats } = await runMeasures(MEASURE_SEED + offset);
          for (const f of stats.features) reached.add(f);
          if (problems.length > 0) failures.push(`seed ${MEASURE_SEED + offset}: ${problems.join("; ")}`);
        }
        for (const failure of failures) console.error(failure);
        expect(failures).toEqual([]);
      }, 1_800_000);
    }
    if (!FULL_SEARCH) {
      test("the fixed seeds reach every behaviour they were chosen for", () => {
        expect(MEASURE_FEATURES.filter((f) => !reached.has(f))).toEqual([]);
      });
    }
  });
}

export function measureOracle(): void {
  for (const [index, [name, mutation]] of Object.entries(MEASURE_MUTATIONS).entries()) {
    const run = inShard(index) ? test : test.skip;
    run(`the generated measure runs fail ${mutation.invariant} for an app with "${name}"`, async () => {
      const breaks = (problems: readonly string[]) => problems.some((p) => measureInvariantsOf(p).includes(mutation.invariant));
      if (!FULL_SEARCH) {
        const { problems } = await runMeasures(MEASURE_SEED + mutation.seed, { measureRules: mutation.rules });
        expect(breaks(problems), `seed ${MEASURE_SEED + mutation.seed} no longer breaks ${mutation.invariant}; run the sequence-search workflow and update its seed. Problems: ${problems.join("; ")}`).toBe(true);
        return;
      }
      let caught: number | null = breaks((await runMeasures(MEASURE_SEED + mutation.seed, { measureRules: mutation.rules })).problems) ? mutation.seed : null;
      for (let o = 0; o < MAX_SEEDS && caught === null; o++) if (breaks((await runMeasures(MEASURE_SEED + o, { measureRules: mutation.rules })).problems)) caught = o;
      console.info(`killing seed: measure mutation "${name}" (${mutation.invariant}): ${caught ?? "none"}; recorded ${mutation.seed}`);
      expect(caught).not.toBeNull();
    }, 1_800_000);
  }
}
