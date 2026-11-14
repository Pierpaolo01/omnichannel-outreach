import { appendFileSync, readFileSync } from "node:fs";
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
 * 16a merged with ticket 14c's per-track skip limits: 109 behaviours, among them each pair of a declined path and
 * the state of main-sequence work at the decline that any seed reaches (win back with work the provider holds
 * among them), late sends, each phone track's own limit, and a redial off a callback after a gatekeeper,
 * restored by a targeted draw; seed 87 added after the council on f5fdeee for stop with a claim waiting).
 * A behaviour leaves this list only into RETIRED_FEATURES, with its reason.
 */
export const CALL_FIXED_SEEDS: readonly number[] = [0, 4, 6, 8, 9, 16, 20, 21, 42, 50, 60, 78, 82, 87, 98];

/**
 * The pause runs (ticket 17a, `pauses: true`): the generated user also pauses and resumes campaigns and leads. Chosen
 * greedily from a sweep of offsets 0 to 39 (14 November 2026) to reach every pause behaviour between them; the full
 * search runs every seed in this family too. Recorded: 56 (seed 20261169, failed in the search on ca8baee: the record's
 * check 18 assumed an inbox free for the hour after a resume, while late sends held both its in-flight places).
 */
export const CALL_PAUSE_SEEDS: readonly number[] = [0, 2, 7, 13, 14, 20, 26, 56];

/** Every behaviour the fixed seeds must reach between them. */
export const CALL_FEATURES: readonly string[] = [
  // Ticket 17a, reached by the pause runs.
  "a-callback-held-inside-a-pause",
  "a-lead-paused-inside-a-paused-campaign",
  "a-pause-request-sent-again",
  "campaign-pause-refused",
  "campaign-paused",
  "campaign-paused-during-a-wait",
  "campaign-paused-inside-a-callback",
  "campaign-paused-with-a-call-pending",
  "campaign-paused-with-a-claim-open",
  "campaign-paused-with-a-redial-pending",
  "campaign-paused-with-work-at-the-provider",
  "campaign-resume-refused",
  "campaign-resumed",
  "lead-pause-refused",
  "lead-pause-refused-ended",
  "lead-paused",
  "lead-paused-during-a-wait",
  "lead-paused-inside-a-callback",
  "lead-paused-with-a-call-pending",
  "lead-paused-with-a-claim-open",
  "lead-paused-with-a-redial-pending",
  "lead-paused-with-work-at-the-provider",
  "lead-resume-refused",
  "lead-resumed",
  "paused-or-resumed-around-a-due-instant",
  "a-company-zone-moved",
  "a-held-lead-lost-its-last-number",
  "a-later-phone-track-skipped-as-declined",
  "a-person-zone-moved",
  "a-phone-track-released-by-the-decline-skipped",
  "a-redial-skipped-from-its-original-due-date",
  "a-send-beside-an-open-call",
  "a-send-in-win-back",
  "a-send-moved-by-a-callback",
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
  "callback-with-no-good-number",
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
  "declined-with-another-call-open",
  "declined-with-no-path-set",
  "declined-with-work-in-flight:continue:claim-waiting",
  "declined-with-work-in-flight:stop:claim-waiting",
  "declined-with-work-in-flight:stop:with-the-provider",
  "declined-with-work-in-flight:win_back:claim-waiting",
  "declined-with-work-in-flight:win_back:with-the-provider",
  "declined:continue",
  "declined:stop",
  "declined:win_back",
  "drain-skipped-a-callback-it-cannot-log",
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
  "limit:a-track's-own",
  "limit:a-track's-own-not-the-campaign's",
  "limit:the-campaign's",
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

const chunksOf = (offsets: readonly number[]): number[][] => Array.from({ length: Math.ceil(offsets.length / 10) }, (_, i) => offsets.slice(i * 10, i * 10 + 10));

function report(line: string): void {
  console.info(line);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary) appendFileSync(summary, `- ${line}\n`);
}

/** The generated call runs from `from` to `to` (offsets from SEED): all of them under the full search, otherwise the fixed seeds in that range. */
export function callChunks(from: number, to: number): void {
  const all = Array.from({ length: Math.max(0, Math.min(to, SEARCH_SEEDS) - from) }, (_, i) => from + i).filter(inShard);
  const offsets = FULL_SEARCH ? all : CALL_FIXED_SEEDS.filter((o) => o >= from && o < to);
  const pauseOffsets = FULL_SEARCH ? all : CALL_PAUSE_SEEDS.filter((o) => o >= from && o < to);
  describe(`generated call runs keep the engine's invariants (${FULL_SEARCH ? "full search" : "fixed seeds"}, ${SEED + from} to ${SEED + to - 1})`, () => {
    if (offsets.length === 0 && pauseOffsets.length === 0) test.skip("no seed of this run in this range", () => undefined);
    const chunks = [...chunksOf(offsets).map((c) => ({ c, pauses: false })), ...chunksOf(pauseOffsets).map((c) => ({ c, pauses: true }))];
    for (const { c: chunk, pauses } of chunks) {
      test(`${pauses ? "pause runs, " : ""}seeds ${chunk.map((o) => SEED + o).join(", ")}`, async () => {
        const failures: string[] = [];
        for (const offset of chunk) {
          const { problems, stats } = await runCalls(SEED + offset, { pauses });
          for (const f of stats.features) reached.add(f);
          if (problems.length > 0) failures.push(`seed ${SEED + offset}: ${problems.join("; ")}`);
          // A behaviour neither listed nor retired, in the fixed seeds or in any seed of the search: list it or retire it with a reason.
          const unknown = stats.features.filter((f) => !isKnownFeature(f));
          if (unknown.length > 0) failures.push(`seed ${SEED + offset} reaches behaviours in neither CALL_FEATURES nor RETIRED_FEATURES: ${unknown.join(", ")}`);
        }
        for (const failure of failures) console.error(failure);
        expect(failures).toEqual([]);
      }, 1_800_000);
    }
    if (!FULL_SEARCH && from === 0) {
      test("the fixed seeds reach every behaviour they were chosen for", () => {
        expect(CALL_FEATURES.filter((f) => !reached.has(f))).toEqual([]);
      });
      test("every behaviour the generator can name is listed, or retired with its reason (council on f5fdeee, item 3)", () => {
        expect(unlistedFeatureNames(readFileSync(new URL("./generated-calls.ts", import.meta.url), "utf8"))).toEqual([]);
        expect(Object.entries(RETIRED_FEATURES).filter(([name, reason]) => CALL_FEATURES.includes(name) || reason.trim().length < 20)).toEqual([]);
      });
    }
  });
}

/**
 * Behaviours the generator no longer names, or that no seed reaches, each with why it is not required of the
 * fixed seeds (council on f5fdeee, item 3). A name leaves `CALL_FEATURES` only by moving here: a test reads the
 * generator's source and fails on a name in neither list, and every run fails on a reached name in neither.
 */
export const RETIRED_FEATURES: Readonly<Record<string, string>> = {
  "declined-with-a-main-claim-waiting": "Replaced by one behaviour per declined path, declined-with-work-in-flight:<path>:claim-waiting (council on f5fdeee, item 2).",
  "declined-with-a-main-send-with-the-provider": "Replaced by one behaviour per declined path, declined-with-work-in-flight:<path>:with-the-provider (council on f5fdeee, item 2).",
  "declined-with-work-in-flight:continue": "Replaced by the pairs of the path and the state of the work, declined-with-work-in-flight:continue:<state> (council on f5fdeee, item 2).",
  "declined-with-work-in-flight:stop": "Replaced by the pairs of the path and the state of the work, declined-with-work-in-flight:stop:<state> (council on f5fdeee, item 2).",
  "declined-with-work-in-flight:win_back": "Replaced by the pairs of the path and the state of the work, declined-with-work-in-flight:win_back:<state> (council on f5fdeee, item 2).",
  "sms-failed-on-a-wrong-mobile": "Reached by none of the 100 seeds since it was added (ticket 14a): the path is reached as wrong-mobile, after which the record fails the SMS track and checks no text goes to that mobile (invariant 19).",
};

const isKnownFeature = (name: string) => CALL_FEATURES.includes(name) || name in RETIRED_FEATURES;

/**
 * The behaviour names in the generator's source (every `features.add(...)`) that are neither listed nor retired:
 * a literal name must be one of them; a template's fixed start must begin one of them. A literal passed to a call
 * or compared (`startsWith("p")`, `=== "callback"`) is not a name.
 */
export function unlistedFeatureNames(source: string): string[] {
  const known = [...CALL_FEATURES, ...Object.keys(RETIRED_FEATURES)];
  const out: string[] = [];
  for (let at = source.indexOf("features.add("); at >= 0; at = source.indexOf("features.add(", at + 1)) {
    let i = at + "features.add(".length;
    let depth = 1;
    let previous = "";
    while (i < source.length && depth > 0) {
      const c = source[i] ?? "";
      if (c === "`") {
        const end = source.indexOf("`", i + 1);
        const text = source.slice(i + 1, end);
        const prefix = text.split("${")[0] ?? "";
        if (prefix === "" || !known.some((k) => k.startsWith(prefix))) out.push(`\`${text}\``);
        i = end + 1;
        continue;
      }
      if (c === '"') {
        const end = source.indexOf('"', i + 1);
        const text = source.slice(i + 1, end);
        const operand = /(\(|===|!==)\s*$/.test(previous);
        if (!operand && text !== "" && !known.includes(text)) out.push(text);
        previous += source.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      if (c === "(") depth++;
      if (c === ")") depth--;
      previous += c;
      i++;
    }
  }
  return [...new Set(out)];
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
        const { problems } = await runCalls(SEED + mutation.seed, { rules: mutation.rules, maxWrites: RUN_WRITES, pauses: mutation.pauses === true });
        expect(problems.filter((p) => callInvariantsOf(p).includes(mutation.invariant)), `seed ${SEED + mutation.seed} no longer breaks invariant ${mutation.invariant}; run the sequence-search workflow and update its seed. Problems: ${problems.join("; ")}`).not.toEqual([]);
        return;
      }
      let caught: string | null = null;
      if (breaks((await runCalls(SEED + mutation.seed, { rules: mutation.rules, maxWrites: RUN_WRITES, pauses: mutation.pauses === true })).problems)) caught = `recorded seed offset ${mutation.seed}`;
      else report(`recorded seed offset ${mutation.seed} no longer breaks invariant ${mutation.invariant} for call mutation "${name}"`);
      for (let i = 0; i < MAX_SEEDS && caught === null; i++) {
        if (breaks((await runCalls(SEED + i, { rules: mutation.rules, maxWrites: RUN_WRITES, pauses: mutation.pauses === true })).problems)) caught = `seed offset ${i}`;
      }
      report(`killing seed: call mutation "${name}" (invariant ${mutation.invariant}): ${caught ?? `none in offsets 0-${MAX_SEEDS - 1}`}; recorded seed ${mutation.seed}`);
      expect(caught, `no seed broke invariant ${mutation.invariant} for "${name}"`).not.toBeNull();
    }, 1_800_000);
  }
}
