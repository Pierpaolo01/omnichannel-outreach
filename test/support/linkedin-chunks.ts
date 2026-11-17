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
/**
 * Offsets from LINKEDIN_SEED: the four the search failed on at e261ffa (46, 69, 73, 93; ADR 0004, "The review of e261ffa"),
 * then a greedy cover of every behaviour below over offsets 0 to 29 (16 November 2026). The four the local run of offsets 30
 * to 99 failed on before e261ffa's next push (35, 62, 71, 94) run in the search only, to keep `pnpm check` inside CI's job:
 * three were the record's errors, and 62's engine change has its own test through HTTP.
 */
// 15 (ticket 24b, the search on a6c1700): a step no session it may use has any allowance for, read as no allowance; the
// seed of the mutation "no allowance reads as full for the day".
export const LINKEDIN_FIXED_SEEDS: readonly number[] = [5, 8, 15, 18, 29, 46, 69, 73, 93];
/** Every behaviour the fixed seeds must reach (`stats.features`); a run that reports a name not listed here fails. */
export const LINKEDIN_FEATURES: readonly string[] = [
  "a-campaign-paused",
  "a-campaign-resumed",
  "a-crash-between-the-handover-and-its-answer",
  "a-deadline-checked-at-an-edit",
  "a-lead-paused",
  "a-lead-resumed",
  "a-lead-stopped",
  "a-lost-answer-found-by-lookup",
  "a-message-after-acceptance",
  "a-message-to-an-existing-connection",
  "a-pair-released-then-invited-by-another",
  "a-person-enrolled-after-a-release",
  "a-person-enrolled-later",
  "a-person-in-two-campaigns",
  "a-profile-changed-by-a-reimport",
  "a-rate-limit",
  "a-removed-connection",
  "a-reply-mark-refused",
  "a-reply-marked",
  "a-running-edit:insert",
  "a-running-edit:remove",
  "a-running-edit:reorder",
  "a-running-edit:wait",
  "a-second-invite-after-a-withdrawal",
  "a-session-added-to-a-pool",
  "a-session-id-that-is-a-number",
  "a-session-removed-from-a-pool",
  "a-session-signed-out",
  "a-skip",
  "a-skip-of-a-taken-pair",
  "a-skip-of-the-invite",
  "a-skip-while-waiting-for-acceptance",
  "a-step-waiting-on-a-zero-allowance",
  "a-stopped-lead-restarted",
  "a-stuck-withdrawal-marked-by-the-user",
  "a-third-session",
  "a-withdrawal-answered-unknown",
  "a-withdrawal-found-it-accepted",
  "already-connected",
  "an-answer-of-one-session",
  "an-edit-of-the-wait-while-waiting",
  "an-expiry-while-the-laptop-was-off",
  "an-invite-decided-over-several-sessions",
  "an-invite-expired",
  "an-invite-pending-elsewhere",
  "an-invite-without-its-note",
  "connected-by-acceptance",
  "email-after-linkedin",
  "email-beside-linkedin",
  "released-after-an-expiry",
  "sms-after-linkedin",
  "sms-beside-linkedin",
  "the-laptop-was-off",
  "unresolved-marked-not-sent",
];
/** Behaviours the runs can name that the fixed seeds do not reach, each pinned by an example test instead (`linkedin-review.test.ts`). */
export const LINKEDIN_OTHER_FEATURES: readonly string[] = ["unresolved-marked-sent"];
/**
 * Invariant 29's fresh-engine comparison in `pnpm check` (a fresh engine per check doubles a run's engine work, and the
 * per-push set must fit CI's check job): after every FRESH_EVERY-th worker tick and after every tick that moved a
 * conversation's version, in the fixed seeds; after every tick in the full search, and in the replays of the mutations that
 * break 29 (their recorded seeds); not in the replays of mutations that break another invariant.
 */
const FRESH_EVERY = 10;
const freshFor = (mutation: { readonly invariant: string }): number => (mutation.invariant === "29" ? 1 : 0);
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
  describe(`generated LinkedIn runs keep L1 to L17 (${FULL_SEARCH ? "full search" : "fixed seeds"})`, () => {
    if (offsets.length === 0) test.skip("no seed of this run in this shard", () => undefined);
    for (let i = 0; i < offsets.length; i += 10) {
      const chunk = offsets.slice(i, i + 10);
      test(`seeds ${chunk.map((o) => LINKEDIN_SEED + o).join(", ")}`, async () => {
        const failures: string[] = [];
        for (const offset of chunk) {
          const { problems, stats } = await runLinkedin(LINKEDIN_SEED + offset, { freshEvery: FULL_SEARCH ? 1 : FRESH_EVERY });
          for (const f of stats.features) {
            reached.add(f);
            if (!LINKEDIN_FEATURES.includes(f) && !LINKEDIN_OTHER_FEATURES.includes(f)) failures.push(`seed ${LINKEDIN_SEED + offset} reached "${f}", which is not in LINKEDIN_FEATURES`);
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
        const undo = mutation.patch?.();
        const { problems } = await runLinkedin(LINKEDIN_SEED + mutation.seed, { rules: mutation.rules, maxWrites: RUN_WRITES, maxTicks: RUN_TICKS, freshEvery: freshFor(mutation) }).finally(() => undo?.());
        expect(breaks(problems), `seed ${LINKEDIN_SEED + mutation.seed} no longer breaks ${mutation.invariant}; run the sequence-search workflow and update its seed. Problems: ${problems.join("; ")}`).toBe(true);
        return;
      }
      const undo = mutation.patch?.();
      let caught: string | null = breaks((await runLinkedin(LINKEDIN_SEED + mutation.seed, { rules: mutation.rules, maxWrites: RUN_WRITES, maxTicks: RUN_TICKS, freshEvery: freshFor(mutation) })).problems) ? `recorded seed offset ${mutation.seed}` : null;
      for (let i = 0; i < MAX_SEEDS && caught === null; i++) if (breaks((await runLinkedin(LINKEDIN_SEED + i, { rules: mutation.rules, maxWrites: RUN_WRITES, maxTicks: RUN_TICKS, freshEvery: freshFor(mutation) })).problems)) caught = `seed offset ${i}`;
      undo?.();
      report(`killing seed: LinkedIn mutation "${name}" (${mutation.invariant}): ${caught ?? `none in offsets 0-${MAX_SEEDS - 1}`}; recorded seed ${mutation.seed}`);
      expect(caught, `no seed broke ${mutation.invariant} for "${name}"`).not.toBeNull();
    }, 1_800_000);
  }
}
