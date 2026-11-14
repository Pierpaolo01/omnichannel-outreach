# Delivery workflow

Set by the coordinator on 12 November 2026 from the principal's build request. Revised on 13 November 2026 after the first ticket (issue 11, eleven review rounds) showed where the process let work drift. A coordinator session dispatches one fresh agent per role. If you are that agent, your brief names your role; do only that role.

## Branches and pull requests

- `integration/outreach-spec` is the integration branch. The whole spec lands there. `main` receives it through one pull request that the principal merges.
- Each ticket gets its own branch `ticket/<issue-number>-<slug>`, cut from the integration branch tip, and its own pull request whose base is `integration/outreach-spec`. Design records and research use `adr/<number>-<slug>` and `research/<slug>` the same way.
- Bring a branch up to date by merging the integration branch into it. History is append-only: no rebase, no force-push.
- Only the coordinator merges, and only into the integration branch.

## Machine limits

Added on 13 November 2026, after pull request 37. The workstation is shared and small.

- Run at most two test processes at once.
- Never run the full sequence search locally. It runs in CI, through the `sequence-search` label on the pull request.
- A check that runs on every push must not depend on wall-clock speed. Bound it by a count, as the mutation oracle bounds each run by engine writes.
- When several agents work in parallel worktrees, each runs the browser suite on its own port through `E2E_PORT`, for example `E2E_PORT=4321 pnpm test:e2e`. The port also gives it its own throwaway database.
- The disk is small. Install with `pnpm install --frozen-lockfile` only, and download nothing extra.

## Roles

A slice passes through separate contexts. No agent grades its own work.

1. **Designer**, when the ticket adds a deep rule. See "Design first".
2. **Implementer.** Builds the ticket test-first, opens the pull request, publishes evidence.
3. **Verifier.** A different model. Runs the checks itself, exercises the running application against each acceptance criterion and reports pass, fail or unverified per criterion with evidence. Changes no product code.
4. **Council.** Independent read-only reviewers score the candidate diff. For UI they compare screenshots of the build with the approved prototypes.
5. **Coordinator.** Rules on findings, dispatches fixes, merges the pull request and updates the ticket.

## Design first

A **deep rule** decides identity, timing, sending or state across many events: matching imported rows, the sequence engine, capacity, recovery. Before any code for one, an ADR states:

- the rule, in words a reviewer can check against the code;
- its **invariants**, as a list a test can assert;
- the **boundary**: which input is refused outright instead of resolved;
- which guarantee holds **by construction** (stored, not recomputed each time);
- the generated-sequence test that will enforce the invariants.

The council reviews the ADR before implementation starts. `docs/adr/0001-application-foundation-and-import-model.md` and `src/server/import-sequences.test.ts` are the worked example.

## Implementer definition of done

- Every acceptance criterion in the ticket is met, or reported as not met with the reason. An area a later ticket delivers shows an honest not-yet state.
- Behavior was built test-first with the `tdd` skill at the seams the ADRs name. Each bug found later gets a regression test that failed before the fix.
- A deep rule has a generated-sequence test from its first commit: generated inputs and event orders, an independent record of what should happen, the invariants asserted after every step, and a mutation that proves the test fails when the rule is broken.
- `pnpm check` passes locally. It runs typecheck, lint and all tests, and is the same command CI runs. For a deep rule's generated-sequence test it runs a fixed, rule-covering seed set and each mutation's known killing seed.
- Before a merge of a deep rule, its full search passes once too, in CI: for the sequence engine, add the `sequence-search` label to the pull request, or trigger the workflow by hand once it is on the default branch (all 100 seeds and a seed search per mutation, in eight shards, each printing every mutation's killing seed; ADR 0003 9.2), and link the run in the pull request. Never run the full search locally: it exhausts a workstation.
- **The save rule (ADR 0003 1.1.1) has a full search too** (added 14 November 2026, after five of 1,000 seeds were found failing on the integration branch). Its generated test runs three sets in `pnpm check`: 200 fixed seeds (7000 to 7199), every recorded seed (one that once failed, or the only one known to kill a mutation of the rule), and a window of 100 seeds that moves with each commit, derived from the commit, printed in the output, and rerun with `SAVE_QUEUE_WINDOW_FROM` (about 12 seconds in all). The full search runs 2,000 seeds in the same `sequence-search` workflow, a share in each of its eight shards (`pnpm test:save-search`). Add the label for a change to the save rule too: `src/web/campaign/saveQueue.ts`, `editorStore.ts`, or the definition's save in the store and its route. What the three give: the fixed seeds and the recorded seeds catch, on every push, any change that breaks what they already reach; the window tries 100 new seeds on each commit, so over many pushes the rule meets seeds no fixed set reaches, though any one push may well miss a defect that shows once in a few hundred runs; only the full search, before a merge, runs enough for that. The five were missed because `pnpm check` ran a fixed 60 seeds and no search ran the save test at all. Every rule with a generated test must be in a full search. All three counts are counts, never times.
- The integration branch tip is merged into the ticket branch.
- The pull request description links the ticket, lists what was verified and how, and lists anything unverified.
- Evidence is published as a pull request comment: for UI, screenshots of every changed screen in light and dark theme plus each loading, empty, error and success state the slice has, and a short recording of the ticket's demonstration; for non-UI, the command output. Evidence uses fictitious data only.
- Every server, browser and background job you started is stopped.
- Report as soon as the branch is pushed: branch, head commit, pull request URL, criteria status, what remains unverified. The coordinator confirms the CI run and the review bot's result on the final head.
- The review bot (Pullfrog) reviews each push. Verify each of its findings against the code, fix a real one with a regression test that fails first, and reply on its thread with what you did; answer an invalid one with the evidence.

## What blocks a merge

One bar, for implementers, verifiers and reviewers alike. A finding **blocks** when well-formed input can reach it and it causes one of:

- wrong outreach, or outreach after a reply, a stop or during a pause;
- lost or corrupted records;
- a security or privacy hole;
- a failed acceptance criterion, a failing check, or an unanswered review-bot finding on the final head;
- a foundation that a later ticket would have to tear up.

Everything else is a **follow-up**. Well-formed input means what the real sources produce: for the scraper export, unique non-blank IDs within each file. A database that only an unmerged head could have created is not a merge concern.

Fix a class of defect, not its examples: when a second finding of the same kind appears, change the rule, the boundary or the test so the kind cannot recur, and say so in the ADR.

## Verifier and reviewer output

- Mark each finding blocking or follow-up under the bar above, with the evidence and a concrete fix.
- Say what you ran and what you only read.
- Save the report to the path the brief gives, and reply with a summary. The coordinator puts the council table in the pull request description.
- Remove any checkout or dependency copy you made, and stop what you started.

## Closing tickets

A ticket is complete when the coordinator has merged its pull request after verification and council review, and recorded on the issue: the merge commit, the verification result, the council scores, what is unverified and where the follow-ups are tracked. Follow-ups from one ticket go into one issue. Issues close when the integration pull request merges to `main`.

## Standing checks

`pnpm check` and the CI workflow are the guardrail. When an agent makes a mistake that a deterministic check could have caught, add the check: a lint rule, a test, a scan over every screen. The accessibility and layout scans in `e2e/` and the typed mock responses came from exactly that.

**Migration numbers** (added 13 November 2026, after pull request 43). Schema migrations are numbered exactly 1 to N with no gap; `src/server/persistence/migrations.test.ts` fails on any branch that skips or repeats a number, and `migrate` refuses a database whose recorded versions are not a prefix of the list. A migration applied above a gap would leave the gap unfilled for good on every database that passed it. So a branch takes the next number at merge time: if another branch merged a migration first, renumber yours when merging the integration branch tip.
