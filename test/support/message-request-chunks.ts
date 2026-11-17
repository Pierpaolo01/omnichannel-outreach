import { appendFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { messageRequestInvariantsOf, runMessageRequests } from "./generated-message-requests.ts";
import { MESSAGE_REQUEST_MUTATIONS } from "./message-request-mutations.ts";
import { FULL_SEARCH, inShard } from "./sequence-chunks.ts";

/**
 * The generated runs of the message-request channels (ticket 25, ADR 0004 13.9) in `pnpm check` and in the CI search (ADR
 * 0003 9.2): `pnpm check` runs the fixed, behaviour-covering seeds and each mutation's recorded killing seed; the search
 * (`pnpm test:sequence-search`, the `sequence-search` workflow, by its shards) runs all 100 offsets and a seed search per
 * mutation, printing each one's killing seed. Counts, never times: every mutation replay stops after RUN_WRITES engine writes.
 */
export const MESSAGE_REQUEST_SEED = 25000;
/**
 * Offsets from MESSAGE_REQUEST_SEED: a cover of every behaviour below over offsets 0 to 99, all of which passed unmutated
 * on 17 November 2026 after the second Instagram track and the removal of a started one (the review bot on 0922582; one
 * worker). 1, 17, 63, 79 and 91 were the cover before; 4 adds what the changed runs took from them.
 */
export const MESSAGE_REQUEST_FIXED_SEEDS: readonly number[] = [1, 4, 17, 63, 79, 91];
/** Every behaviour the fixed seeds must reach (`stats.features`); a run that reports a name not listed here fails. */
export const MESSAGE_REQUEST_FEATURES: readonly string[] = [
  "a-campaign-paused",
  "a-campaign-resumed",
  "a-company-lead",
  "a-crash-between-the-handover-and-its-answer",
  "a-lead-paused",
  "a-lead-resumed",
  "a-lead-stopped",
  "a-lost-answer-found-by-lookup",
  "a-message-not-allowed",
  "a-pool-of-several-sessions",
  "a-rate-limit",
  "a-reply-mark-refused",
  "a-reply-marked",
  "a-running-edit:insert",
  "a-running-edit:remove",
  "a-running-edit:reorder",
  "a-session-added-to-a-pool",
  "a-session-removed-from-a-pool",
  "a-session-signed-out",
  "a-session-with-no-allowance",
  "a-skip",
  "a-step-waiting-on-a-zero-allowance",
  "a-started-instagram-track-removed-before-its-first-claim",
  "a-started-track-whose-account-a-reimport-replaced",
  "a-stopped-lead-restarted",
  "an-account-changed-by-a-reimport",
  "an-account-marked-bad",
  "email-after-instagram",
  "email-beside-instagram",
  "linkedin-beside-instagram",
  "one-account-reached-for-two-subjects",
  "sessions-of-both-kinds",
  "sms-after-instagram",
  "sms-beside-instagram",
  "the-laptop-was-off",
  "two-campaigns",
  "two-instagram-tracks-choosing-other-sessions",
  "two-leads-of-one-company",
  "unresolved-marked",
];
const FRESH_EVERY = 10;
const freshFor = (mutation: { readonly invariant: string }): number => (mutation.invariant === "29" ? 1 : 0);
const SEARCH_SEEDS = 100;
/**
 * Each seed's own bound: the whole 30 minutes one case of all the fixed seeds had (verifier on f2824d4, item 11). Measured
 * on 17 November 2026: on CI's unit shard the LinkedIn family's nine seeds took 222 s together and the message-request
 * family's four 14 s; locally, on one worker at a load average near 30, the nine took 407 s, the slowest (24029) 188 s. A
 * machine five times slower than that stays inside it seed by seed, where nine seeds in one case did not.
 */
const SEED_LIMIT_MS = 1_800_000;
const MAX_SEEDS = 30;
const RUN_WRITES = 3_000;
const RUN_TICKS = 2_000;

function report(line: string): void {
  console.info(line);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary) appendFileSync(summary, `- ${line}\n`);
}

const reached = new Set<string>();

export function messageRequestChunks(): void {
  const offsets = FULL_SEARCH ? Array.from({ length: SEARCH_SEEDS }, (_, i) => i).filter(inShard) : [...MESSAGE_REQUEST_FIXED_SEEDS];
  describe(`generated message-request runs keep M1 to M10 and 29 (${FULL_SEARCH ? "full search" : "fixed seeds"})`, () => {
    if (offsets.length === 0) test.skip("no seed of this run in this shard", () => undefined);
    // One case per seed, each with its own bound (verifier on f2824d4, item 11): a slow machine can fail one seed's case,
    // never starve the others of the time a shared case had left. The coverage below is still asserted over all of them.
    for (const offset of offsets) {
      test(`seed ${MESSAGE_REQUEST_SEED + offset}`, async () => {
        const failures: string[] = [];
        const { problems, stats } = await runMessageRequests(MESSAGE_REQUEST_SEED + offset, { freshEvery: FULL_SEARCH ? 1 : FRESH_EVERY });
        for (const f of stats.features) {
          reached.add(f);
          if (!MESSAGE_REQUEST_FEATURES.includes(f)) failures.push(`seed ${MESSAGE_REQUEST_SEED + offset} reached "${f}", which is not in MESSAGE_REQUEST_FEATURES`);
        }
        if (problems.length > 0) failures.push(`seed ${MESSAGE_REQUEST_SEED + offset}: ${problems.join("; ")}`);
        for (const failure of failures) console.error(failure);
        expect(failures).toEqual([]);
      }, SEED_LIMIT_MS);
    }
    if (!FULL_SEARCH) {
      test("the fixed seeds reach every message-request behaviour", () => {
        expect(MESSAGE_REQUEST_FEATURES.filter((f) => !reached.has(f))).toEqual([]);
      });
    }
  });
}

/** Each broken engine must fail the invariant it names: in `pnpm check` on its recorded seed; in the search, the first that does. */
export function messageRequestOracle(): void {
  for (const [index, [name, mutation]] of Object.entries(MESSAGE_REQUEST_MUTATIONS).entries()) {
    const run = inShard(index) ? test : test.skip;
    run(`the generated message-request runs fail ${mutation.invariant} for an engine with "${name}"`, async () => {
      const breaks = (problems: readonly string[]) => problems.some((p) => messageRequestInvariantsOf(p).includes(mutation.invariant));
      const replay = async (offset: number) => {
        const undo = mutation.patch?.();
        try {
          return (await runMessageRequests(MESSAGE_REQUEST_SEED + offset, { rules: mutation.rules, maxWrites: RUN_WRITES, maxTicks: RUN_TICKS, freshEvery: freshFor(mutation) })).problems;
        } finally {
          undo?.();
        }
      };
      if (!FULL_SEARCH) {
        const problems = await replay(mutation.seed);
        expect(breaks(problems), `seed ${MESSAGE_REQUEST_SEED + mutation.seed} no longer breaks ${mutation.invariant}; run the sequence-search workflow and update its seed. Problems: ${problems.join("; ")}`).toBe(true);
        return;
      }
      let caught: string | null = breaks(await replay(mutation.seed)) ? `recorded seed offset ${mutation.seed}` : null;
      for (let i = 0; i < MAX_SEEDS && caught === null; i++) if (breaks(await replay(i))) caught = `seed offset ${i}`;
      report(`killing seed: message-request mutation "${name}" (${mutation.invariant}): ${caught ?? `none in offsets 0-${MAX_SEEDS - 1}`}; recorded seed ${mutation.seed}`);
      expect(caught, `no seed broke ${mutation.invariant} for "${name}"`).not.toBeNull();
    }, 1_800_000);
  }
}
