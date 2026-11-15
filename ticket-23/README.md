# Ticket 23 evidence

The acceptance story (`e2e/acceptance.spec.ts`) on branch `ticket/23-acceptance-story`, recorded at `8d5f321`: one light-mode screenshot per step and a recording of the whole run. Fake email and SMS providers, fictitious data only; nothing reached a real provider.

Two screenshots show reported defects: `06-replied-ben.png` and `06-replied-ada.png` show the other campaign's row with a due time already past on a day its window excludes (defect 2), and `08-calls-paused.png` shows the paused campaign's call reopened with "already logged from another window" (defect 3). See `docs/acceptance/mvp-acceptance.md`.

Reproduce from a clean clone, with Node 22, pnpm and a free port:

    git clone https://github.com/Pierpaolo01/omnichannel-outreach.git && cd omnichannel-outreach
    git checkout ticket/23-acceptance-story
    pnpm install --frozen-lockfile
    pnpm exec playwright install chromium
    E2E_PORT=4399 pnpm exec playwright test e2e/acceptance.spec.ts e2e/acceptance-proofs.spec.ts e2e/acceptance-defects.spec.ts --no-deps

For these files, run `e2e/acceptance.spec.ts` alone with `EVIDENCE_DIR=<folder> RECORD_DEMO=1` added.
