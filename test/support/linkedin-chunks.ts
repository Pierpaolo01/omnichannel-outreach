import { appendFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { linkedinInvariantsOf, runLinkedin } from "./generated-linkedin.ts";
import { LINKEDIN_MUTATIONS } from "./linkedin-mutations.ts";
import { FULL_SEARCH, inShard } from "./sequence-chunks.ts";

/**
 * The generated LinkedIn runs (ticket 24, ADR 0004 10.2) in `pnpm check` and in the CI search (ADR 0003 9.2): `pnpm check`
 * runs the fixed, behaviour-covering seeds and each mutation's recorded killing seed; the search (`pnpm test:sequence-search`,
 * the `sequence-search` workflow, by its shards) runs all 100 offsets and a seed search per mutation, printing each one's
 * killing seed. Counts, never times: every mutation replay stops after RUN_WRITES engine writes.
 */
export const LINKEDIN_SEED = 24000;
/** Offsets from LINKEDIN_SEED: 12 and 18 reach every behaviour below (a greedy cover of the sweep of all 100 on 16 November 2026); 0, 1, 4 and 5 kill the mutations. */
export const LINKEDIN_FIXED_SEEDS: readonly number[] = [0, 1, 4, 5, 12, 18];
/** Every behaviour the fixed seeds must reach (`stats.features`); a run that reports a name not listed here fails. */
export const LINKEDIN_FEATURES: readonly string[] = [
  "a-lead-paused",
  "a-lead-resumed",
  "a-lost-answer-found-by-lookup",
  "a-message-after-acceptance",
  "a-message-to-an-existing-connection",
  "a-rate-limit",
  "a-reply-mark-refused",
  "a-reply-marked",
  "a-withdrawal-answered-unknown",
  "a-withdrawal-found-it-accepted",
  "already-connected",
  "an-expiry-while-the-laptop-was-off",
  "an-invite-expired",
  "an-invite-without-its-note",
  "connected-by-acceptance",
  "email-after-linkedin",
  "email-beside-linkedin",
  "released-after-an-expiry",
  "the-laptop-was-off",
];
const SEARCH_SEEDS = 100;
const MAX_SEEDS = 30;
/** Every mutation replay stops after this many engine writes or ticks: an unmutated run of the 100 needs under 300 of each. */
const RUN_WRITES = 3_000;
const RUN_TICKS = 2_000;

function report(line: string): void {
  console.info(line);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary) appendFileSync(summary, `- ${line}\n`);
}

const reached = new Set<string>();

export function linkedinChunks(): void {
  const offsets = FULL_SEARCH ? Array.from({ length: SEARCH_SEEDS }, (_, i) => i).filter(inShard) : [...LINKEDIN_FIXED_SEEDS];
  describe(`generated LinkedIn runs keep L1 to L10 (${FULL_SEARCH ? "full search" : "fixed seeds"})`, () => {
    if (offsets.length === 0) test.skip("no seed of this run in this shard", () => undefined);
    for (let i = 0; i < offsets.length; i += 10) {
      const chunk = offsets.slice(i, i + 10);
      test(`seeds ${chunk.map((o) => LINKEDIN_SEED + o).join(", ")}`, async () => {
        const failures: string[] = [];
        for (const offset of chunk) {
          const { problems, stats } = await runLinkedin(LINKEDIN_SEED + offset);
          for (const f of stats.features) {
            reached.add(f);
            if (!LINKEDIN_FEATURES.includes(f)) failures.push(`seed ${LINKEDIN_SEED + offset} reached "${f}", which is not in LINKEDIN_FEATURES`);
          }
          if (problems.length > 0) failures.push(`seed ${LINKEDIN_SEED + offset}: ${problems.join("; ")}`);
        }
        for (const failure of failures) console.error(failure);
        expect(failures).toEqual([]);
      }, 1_800_000);
    }
    if (!FULL_SEARCH) {
      test("the fixed seeds reach every LinkedIn behaviour", () => {
        expect(LINKEDIN_FEATURES.filter((f) => !reached.has(f))).toEqual([]);
      });
    }
  });
}

/** Each broken engine must fail the invariant it names: in `pnpm check` on its recorded seed; in the search, the first that does. */
export function linkedinOracle(): void {
  for (const [index, [name, mutation]] of Object.entries(LINKEDIN_MUTATIONS).entries()) {
    const run = inShard(index) ? test : test.skip;
    run(`the generated LinkedIn runs fail ${mutation.invariant} for an engine with "${name}"`, async () => {
      const breaks = (problems: readonly string[]) => problems.some((p) => linkedinInvariantsOf(p).includes(mutation.invariant));
      if (!FULL_SEARCH) {
        const { problems } = await runLinkedin(LINKEDIN_SEED + mutation.seed, { rules: mutation.rules, maxWrites: RUN_WRITES, maxTicks: RUN_TICKS });
        expect(breaks(problems), `seed ${LINKEDIN_SEED + mutation.seed} no longer breaks ${mutation.invariant}; run the sequence-search workflow and update its seed. Problems: ${problems.join("; ")}`).toBe(true);
        return;
      }
      let caught: string | null = breaks((await runLinkedin(LINKEDIN_SEED + mutation.seed, { rules: mutation.rules, maxWrites: RUN_WRITES, maxTicks: RUN_TICKS })).problems) ? `recorded seed offset ${mutation.seed}` : null;
      for (let i = 0; i < MAX_SEEDS && caught === null; i++) if (breaks((await runLinkedin(LINKEDIN_SEED + i, { rules: mutation.rules, maxWrites: RUN_WRITES, maxTicks: RUN_TICKS })).problems)) caught = `seed offset ${i}`;
      report(`killing seed: LinkedIn mutation "${name}" (${mutation.invariant}): ${caught ?? `none in offsets 0-${MAX_SEEDS - 1}`}; recorded seed ${mutation.seed}`);
      expect(caught, `no seed broke ${mutation.invariant} for "${name}"`).not.toBeNull();
    }, 1_800_000);
  }
}
