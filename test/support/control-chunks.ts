import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { CONTROL_MUTATIONS } from "./control-mutations.ts";
import { controlInvariantsOf, runControls } from "./generated-controls.ts";
import { isInterruptionFeature } from "./interruption-chunks.ts";
import { FULL_SEARCH, inShard } from "./sequence-chunks.ts";

/**
 * The generated control runs (ticket 17a) in `pnpm check` and in the CI search (ADR 0003 9.2), as the call runs
 * are: `pnpm check` runs the fixed, behaviour-covering seeds and each mutation's known killing seed; the search
 * (`pnpm test:sequence-search`, the `sequence-search` workflow) runs all 100 seeds in shards and a seed search per
 * mutation that prints the seed killing each.
 */

export const CONTROL_SEED = 17_000;
/**
 * Offsets from CONTROL_SEED, chosen greedily from a sweep of all 100 (14 November 2026, after the review bot and the
 * verifier on 612aa05, with sends never reported and texts sent late) to reach every behaviour below; 35 added, a run in
 * which a text is withdrawn and a second lead then needs its number's place (verifier R2-2).
 */
// 85 and 93 (ticket 17b, the search on 54f3a73): an ended lead's skip, sent with its read's precondition, refused with
// the precondition's reason instead of the read's; one refusal order for the read and the action (judgeControl) since.
export const CONTROL_FIXED_SEEDS: readonly number[] = [17, 19, 33, 35, 48, 64, 72, 85, 86, 91, 93, 99];
/** The scripted reply runs' seed offset (`smsReplyRestart`, `replyBeforeObservation`): the reply identity rule. */
export const SMS_REPLY_SEED = 0;
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
  // Ticket 17b: a Skip confirmed on an earlier read, after its step changed, is refused (P13).
  "a-stale-skip-confirmation-refused",
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
  "pause-refused-with-uncertain-work",
  "pause-with-a-call-listed",
  "pause-with-a-claim-open",
  "pause-with-uncertain-work",
  "pause-with-work-at-the-provider",
  "restarted-after-a-reply",
  "restarted-after-a-stop",
  // Reached by the scripted SMS reply run, not by the fixed seeds (the reply identity rule, ADR 0003 "Ticket 17a").
  "restarted-after-a-text-reply",
  // Reached by the scripted runs of a reply found by the pre-send check before its observation (council on PR 62).
  "a-sms-reply-found-by-the-pre-send-check-before-its-observation",
  "a-email-reply-found-by-the-pre-send-check-before-its-observation",
  "resume-accepted",
  "resume-inside-a-paused-campaign",
  "resume-refused",
  "resume-refused-with-uncertain-work",
  "resume-with-uncertain-work",
  "resume-with-work-at-the-provider",
  "resume_from_next_step-accepted",
  "resume_from_next_step-inside-a-paused-campaign",
  "resume_from_next_step-refused",
  "resume_from_next_step-refused-with-uncertain-work",
  "resume_from_next_step-with-a-call-listed",
  "resume_from_next_step-with-uncertain-work",
  "resume_from_next_step-with-work-at-the-provider",
  "sends-never-reported",
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
  "stop-refused-with-uncertain-work",
  "stop-with-a-call-listed",
  "stop-with-a-claim-open",
  "stop-with-uncertain-work",
  "stop-with-work-at-the-provider",
  "texts-sent-late",
  "withdrawals-answered-unknown-and-sent",
];

export const RETIRED_CONTROL_FEATURES: Readonly<Record<string, string>> = {
  "move_to_win_back-with-a-claim-open": "A name the generator can form that none of the 100 seeds reached in the sweep of 14 November 2026; not required of the fixed seeds.",
  "move_to_win_back-with-uncertain-work": "A name the generator can form that none of the 100 seeds reached in the sweep of 14 November 2026; not required of the fixed seeds.",
  "move_to_win_back-with-work-at-the-provider": "A name the generator can form that none of the 100 seeds reached in the sweep of 14 November 2026; not required of the fixed seeds.",
  "resume-with-a-call-listed": "A name the generator can form that none of the 100 seeds reached in the sweep of 14 November 2026; not required of the fixed seeds.",
  "resume-with-a-claim-open": "A name the generator can form that none of the 100 seeds reached in the sweep of 14 November 2026; not required of the fixed seeds.",
  "resume_from_next_step-with-a-claim-open": "A name the generator can form that none of the 100 seeds reached in the sweep of 14 November 2026; not required of the fixed seeds.",
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
    test(`the scripted run: a lead resumed after a text it sent gets its next text (seed ${CONTROL_SEED + SMS_REPLY_SEED})`, async () => {
      const { problems, stats } = await runControls(CONTROL_SEED + SMS_REPLY_SEED, { smsReplyRestart: true });
      for (const f of stats.features) reached.add(f);
      expect(problems).toEqual([]);
      expect(stats.features).toContain("restarted-after-a-text-reply");
    }, 600_000);
    for (const channel of ["sms", "email"] as const) {
      test(`the scripted run: a ${channel} reply the pre-send check finds before its observation is held once, and the resumed lead's next step goes (seed ${CONTROL_SEED + SMS_REPLY_SEED})`, async () => {
        const { problems, stats } = await runControls(CONTROL_SEED + SMS_REPLY_SEED, { replyBeforeObservation: channel });
        for (const f of stats.features) reached.add(f);
        expect(problems).toEqual([]);
        expect(stats.features).toContain(`a-${channel}-reply-found-by-the-pre-send-check-before-its-observation`);
      }, 600_000);
    }
    if (!FULL_SEARCH) {
      test("the fixed seeds reach every behaviour they were chosen for", () => {
        expect(CONTROL_FEATURES.filter((f) => !reached.has(f))).toEqual([]);
      });
      test("every literal behaviour name in the generator is listed or retired", () => {
        const source = readFileSync(new URL("./generated-controls.ts", import.meta.url), "utf8");
        // The interruption family's names are checked against its own lists (interruption-chunks.ts).
        const literals = [...source.matchAll(/features\.add\("([^"]+)"\)/g)].map((m) => m[1] ?? "").filter((name) => !isInterruptionFeature(name));
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
