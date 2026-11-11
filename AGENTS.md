# Omnichannel outreach planning

This is an internal product for coordinating business/decision-maker outreach with a central CRM. The current phase is product scoping through the Wayfinder skill. No product implementation is authorized by the planning request.

## Start here

1. Read README.md and CONTEXT.md.
2. Load the `wayfinder` skill and its required `grilling` and `domain-modeling` skills.
3. Read [.agents/issue-tracker.md](.agents/issue-tracker.md). GitHub Issues is the canonical tracker, with native sub-issues and issue dependencies when available.
4. Find the issue labelled `wayfinder:map` and read it before choosing a decision ticket. Read README.md for the initial inputs already settled by the user. Do not reopen those choices as unanswered questions.

## Decision ownership

- The human decides desired outcomes, scope, user-visible behavior, autonomy and acceptance. Ask concrete product questions and provide recommendations. Never resolve a human decision by answering for them.
- The AI software factory owns architecture, stack, integration mechanics, implementation, testing and operational engineering. Do not make the human choose frameworks, databases, APIs or worker designs. Raise a technical limitation only when it changes a product choice.
- Prior planning suggestions about technology, milestones and timing are proposals, not approved implementation constraints.
- Existing agreements are product inputs: internal-first, local-machine operation, central CRM, external scraper input, Instantly for email delivery, other named outreach channels, configurable markets/languages/timezones.
- The MVP covers email/SMS/phone, with CSV enrollment into campaigns and human takeover at a prospect reply. Calls are a daily manually worked list; the user speaks. Social channels follow. Detailed sequence, call-outcome, handoff and acceptance behavior remain decision tickets.

## Wayfinder discipline

- Plan before building. Tickets resolve decisions; they are not a premature implementation backlog.
- Refer to issues by linked titles, not bare numbers.
- Claim a decision issue by assignment before working it. Use native parent/child and blocking relationships.
- Resolve at most one non-research decision ticket per session, through its required human exchange.
- Keep detailed resolutions in issue comments and link them from the map's Decisions so far. Do not duplicate resolutions across documents.
- Keep product vocabulary in CONTEXT.md. It is a glossary, not a technical spec.

## Scope and privacy

- Repository setup, planning documents and issue operations are authorized. Runtime account connections, live outreach, purchases, collaborator invitations and public sharing are not part of this scoping request.
- No secrets, browser profiles, raw prospect records or unrelated vault/client material belong in Git or issues.
- Commit and push meaningful planning edits. Do not start implementation until the product-scoping handoff and an explicit build request.

Source: principal's November 11, 2026 request to use Wayfinder in a new private GitHub repository, with human product ownership and AI software-factory technical ownership.
