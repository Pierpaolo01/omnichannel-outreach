# Delivery workflow

Set by the coordinator on 12 November 2026 from the principal's build request. A coordinator session dispatches one fresh agent per role. If you are that agent, your brief names your role; do only that role.

## Branches and pull requests

- `integration/outreach-spec` is the integration branch. The whole spec lands there. `main` receives it through one pull request that the principal merges.
- Each ticket gets its own branch `ticket/<issue-number>-<slug>`, cut from the integration branch tip, and its own pull request whose base is `integration/outreach-spec`.
- Bring a branch up to date by merging the integration branch into it. Do not rebase or force-push.
- Never commit to `main` or directly to the integration branch. The coordinator merges ticket pull requests.

## Roles

A slice passes through four separate contexts. No agent grades its own work.

1. **Implementer.** Builds the ticket test-first, opens the pull request, publishes evidence.
2. **Verifier.** A different model. Runs the checks itself, exercises the running application against each acceptance criterion and reports pass, fail or unverified per criterion with evidence. Changes no product code.
3. **Council.** Three independent read-only reviewers score the candidate diff. For UI they compare screenshots of the build with the approved prototype.
4. **Coordinator.** Decides which findings are real, dispatches fixes, merges the pull request and updates the ticket.

## Implementer definition of done

- Every acceptance criterion in the ticket is met, or reported as not met with the reason. Nothing is faked as complete.
- Behavior was built test-first at the seams the ADRs name. Each bug found later gets a regression test that failed before the fix.
- `pnpm check` passes locally. It runs typecheck, lint and all tests, and is the same command CI runs.
- The integration branch tip is merged into the ticket branch.
- The pull request description links the ticket, lists what was verified and how, and lists anything unverified.
- Evidence is published as a pull request comment: for UI, screenshots of every changed screen in light and dark theme plus each loading, empty, error and success state the slice has, and a short recording of the ticket's demonstration; for non-UI, the command output. Evidence uses fictitious data only.
- The final report to the coordinator is short: branch, head commit, pull request URL, criteria status, and what remains unverified.

## Closing tickets

A ticket is not complete because an agent returned. The coordinator records progress on the issue after verification and council review, with the merge commit. Issues close when the integration pull request merges to `main`.

## Standing checks

`pnpm check` and the CI workflow are the guardrail. When an agent makes a mistake that a deterministic check could have caught, add the check rather than a written rule.
