# Ticket 23 evidence

The acceptance story (`e2e/acceptance.spec.ts`) on branch `ticket/23-acceptance-story` recorded at `9dfe2c7` (the test code is unchanged at `5a2bb43`): one light-mode screenshot per step, and a recording of the whole run. Fake email and SMS providers, fictitious data only; nothing reached a real provider.

Reproduce from a clean checkout of that branch:

    pnpm install --frozen-lockfile
    pnpm exec playwright test e2e/acceptance.spec.ts e2e/acceptance-proofs.spec.ts --no-deps

For these files, add `EVIDENCE_DIR=<folder> RECORD_DEMO=1` to the second command and run `e2e/acceptance.spec.ts` alone.
