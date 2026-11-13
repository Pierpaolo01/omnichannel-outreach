# Delivery workflow

Set by the coordinator on 12 November 2026 from the principal's build request. Revised on 13 November 2026 after the first ticket (issue 11, eleven review rounds) showed where the process let work drift. A coordinator session dispatches one fresh agent per role. If you are that agent, your brief names your role; do only that role.

## Branches and pull requests

- `integration/outreach-spec` is the integration branch. The whole spec lands there. `main` receives it through one pull request that the principal merges.
- Each ticket gets its own branch `ticket/<issue-number>-<slug>`, cut from the integration branch tip, and its own pull request whose base is `integration/outreach-spec`. Design records and research use `adr/<number>-<slug>` and `research/<slug>` the same way.
- Bring a branch up to date by merging the integration branch into it. History is append-only: no rebase, no force-push.
- Only the coordinator merges, and only into the integration branch.

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
- `pnpm check` passes locally. It runs typecheck, lint and all tests, and is the same command CI runs.
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
