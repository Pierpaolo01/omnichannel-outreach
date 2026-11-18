import { appendFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { messageRequestInvariantsOf, RUN_CHANNELS, runMessageRequests } from "./generated-message-requests.ts";
import { MESSAGE_REQUEST_CHANNELS } from "../../src/domain/social-channels.ts";
import { MESSAGE_REQUEST_MUTATIONS } from "./message-request-mutations.ts";
import { FULL_SEARCH, inShard } from "./sequence-chunks.ts";

/**
 * The generated runs of the message-request channels (ticket 25, ADR 0004 13.9; by channel, ticket 26, 14.7) in `pnpm
 * check` and in the CI search (ADR 0003 9.2): `pnpm check` runs the fixed, behaviour-covering seeds and each mutation's
 * recorded killing seed on each channel alone; the search (`pnpm test:sequence-search`, the `sequence-search` workflow, by
 * its shards) runs all 100 offsets and a seed search per mutation and channel, printing each one's killing seed. Counts,
 * never times: every mutation replay stops after RUN_WRITES engine writes.
 */
export const MESSAGE_REQUEST_SEED = 25000;
/**
 * Offsets from MESSAGE_REQUEST_SEED: a cover of every behaviour below, Instagram's and Facebook's each, over offsets 0 to 39,
 * all of which passed unmutated on 17 November 2026 once the runs were parameterised by channel (ticket 26; one worker,
 * 128 s for the forty, 34 s for these nine). Each seed draws its lanes (`channelsOf`): Instagram alone, Facebook alone, or
 * both in one campaign.
 */
export const MESSAGE_REQUEST_FIXED_SEEDS: readonly number[] = [1, 4, 5, 6, 14, 17, 26, 28, 31];
/**
 * Every behaviour the fixed seeds must reach (`stats.features`); a run that reports a name not listed here fails. A
 * behaviour of one lane is named with its channel (`facebook:a-reply-marked`), and each is listed for every channel.
 */
export const MESSAGE_REQUEST_FEATURES: readonly string[] = [
  "a-campaign-paused",
  "a-campaign-resumed",
  "a-company-lead",
  "a-crash-between-the-handover-and-its-answer",
  "a-lead-paused",
  "a-lead-resumed",
  "a-lead-stopped",
  "a-reply-marked-on-one-channel-of-a-lead-reached-on-both",
  "a-skip",
  "a-stopped-lead-restarted",
  "email-after-a-message-request-track",
  "email-beside-a-message-request-track",
  "facebook-alone",
  "facebook:a-lost-answer-found-by-lookup",
  "facebook:a-message-not-allowed",
  "facebook:a-pool-of-several-sessions",
  "facebook:a-rate-limit",
  "facebook:a-reply-mark-refused",
  "facebook:a-reply-marked",
  "facebook:a-running-edit:insert",
  "facebook:a-running-edit:remove",
  "facebook:a-running-edit:reorder",
  "facebook:a-session-added-to-a-pool",
  "facebook:a-session-removed-from-a-pool",
  "facebook:a-session-signed-out",
  "facebook:a-session-with-no-allowance",
  "facebook:a-started-track-removed-before-its-first-claim",
  "facebook:a-started-track-whose-account-a-reimport-replaced",
  "facebook:a-step-waiting-on-a-zero-allowance",
  "facebook:an-account-changed-by-a-reimport",
  "facebook:an-account-marked-bad",
  "facebook:one-account-reached-for-two-subjects",
  "facebook:sessions-of-both-kinds",
  "facebook:two-tracks-choosing-other-sessions",
  "instagram-alone",
  "instagram-and-facebook-in-one-campaign",
  "instagram:a-lost-answer-found-by-lookup",
  "instagram:a-message-not-allowed",
  "instagram:a-pool-of-several-sessions",
  "instagram:a-rate-limit",
  "instagram:a-reply-mark-refused",
  "instagram:a-reply-marked",
  "instagram:a-running-edit:insert",
  "instagram:a-running-edit:remove",
  "instagram:a-running-edit:reorder",
  "instagram:a-session-added-to-a-pool",
  "instagram:a-session-removed-from-a-pool",
  "instagram:a-session-signed-out",
  "instagram:a-session-with-no-allowance",
  "instagram:a-started-track-removed-before-its-first-claim",
  "instagram:a-started-track-whose-account-a-reimport-replaced",
  "instagram:a-step-waiting-on-a-zero-allowance",
  "instagram:an-account-changed-by-a-reimport",
  "instagram:an-account-marked-bad",
  "instagram:one-account-reached-for-two-subjects",
  "instagram:sessions-of-both-kinds",
  "instagram:two-tracks-choosing-other-sessions",
  "linkedin-beside-a-message-request-track",
  "one-lead-reached-on-both-channels",
  "sms-after-a-message-request-track",
  "sms-beside-a-message-request-track",
  "the-laptop-was-off",
  "two-campaigns",
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

/**
 * Each broken engine must fail the invariant it names on each message-request channel alone: in `pnpm check` on its
 * recorded seed for that channel; in the search, the first that does.
 */
export function messageRequestOracle(): void {
  test("the generated runs know every message-request channel the app has, and every mutation is replayed on each alone", () => {
    expect([...RUN_CHANNELS].sort()).toEqual([...MESSAGE_REQUEST_CHANNELS].sort());
    // A mutation recorded only with both channels is one only a joint campaign can show; every other runs on each alone.
    for (const [name, m] of Object.entries(MESSAGE_REQUEST_MUTATIONS)) if (m.seeds.together === undefined) expect(RUN_CHANNELS.filter((c) => m.seeds[c] === undefined), name).toEqual([]);
  });
  // Each mutation on each channel alone, and with both in one campaign where it records a seed for that.
  const cases = Object.entries(MESSAGE_REQUEST_MUTATIONS).flatMap(([name, mutation]) =>
    ([...RUN_CHANNELS, "together"] as const).flatMap((on) => {
      const seed = mutation.seeds[on];
      return seed === undefined ? [] : [{ name, mutation, on, seed, channels: on === "together" ? RUN_CHANNELS : [on] }];
    }),
  );
  for (const [index, { name, mutation, on, seed, channels }] of cases.entries()) {
    const channel = on === "together" ? "both channels together" : on;
    const run = inShard(index) ? test : test.skip;
    run(`the generated message-request runs fail ${mutation.invariant} on ${channel} for an engine with "${name}"`, async () => {
      const breaks = (problems: readonly string[]) => problems.some((p) => messageRequestInvariantsOf(p).includes(mutation.invariant));
      const replay = async (offset: number) => {
        const undo = mutation.patch?.();
        try {
          return (await runMessageRequests(MESSAGE_REQUEST_SEED + offset, { rules: mutation.rules, maxWrites: RUN_WRITES, maxTicks: RUN_TICKS, freshEvery: freshFor(mutation), channels })).problems;
        } finally {
          undo?.();
        }
      };
      if (!FULL_SEARCH) {
        const problems = await replay(seed);
        expect(breaks(problems), `seed ${MESSAGE_REQUEST_SEED + seed} on ${channel} no longer breaks ${mutation.invariant}; run the sequence-search workflow and update its seed. Problems: ${problems.join("; ")}`).toBe(true);
        return;
      }
      let caught: string | null = breaks(await replay(seed)) ? `recorded seed offset ${seed}` : null;
      for (let i = 0; i < MAX_SEEDS && caught === null; i++) if (breaks(await replay(i))) caught = `seed offset ${i}`;
      report(`killing seed: message-request mutation "${name}" (${mutation.invariant}) on ${channel}: ${caught ?? `none in offsets 0-${MAX_SEEDS - 1}`}; recorded seed ${seed}`);
      expect(caught, `no seed broke ${mutation.invariant} on ${channel} for "${name}"`).not.toBeNull();
    }, 1_800_000);
  }
}
