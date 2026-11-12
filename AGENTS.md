# Omnichannel outreach

Internal product that coordinates business and decision-maker outreach around a central CRM. Product scoping finished on 12 November 2026. On that date the principal asked the software factory to build the agreed spec, so this repository is in delivery.

## Start here

1. Read [the spec](https://github.com/Pierpaolo01/omnichannel-outreach/issues/10). It is the implementation source of truth. Its tickets are the open issues that name it as parent; blocking uses native GitHub issue dependencies, described in [.agents/issue-tracker.md](.agents/issue-tracker.md).
2. Read [CONTEXT.md](CONTEXT.md) and use its vocabulary in code, UI copy, tests and commits.
3. Read [docs/agents/delivery-workflow.md](docs/agents/delivery-workflow.md) before branching, opening a PR or reporting work as done.
4. Read [the access and runtime handoff](https://github.com/Pierpaolo01/omnichannel-outreach/issues/28) before touching a provider, a credential or a test send.
5. For any UI work, read [docs/agents/ui.md](docs/agents/ui.md) first.
6. Technical decisions are dated records in [docs/adr/](docs/adr/). Read the ones that touch your ticket.

## Decision ownership

- The human decides desired outcomes, scope, user-visible behavior, autonomy and acceptance. Settled decisions in the spec are not reopened. A product question the spec leaves open goes to the coordinator, who asks the human. Never answer it for them.
- The software factory owns architecture, stack, integration mechanics, implementation, testing and operations. Record a technical decision that later tickets depend on as an ADR.
- A demonstrated provider limitation that prevents agreed behavior is reported with evidence. It is never silently worked around or weakened.
- Campaign copy, cadence, markets, languages, timezones and account capacities are configurable campaign inputs, not missing requirements.

## Boundaries

- No outreach to real prospects. Test sends and test calls go only to contacts the user has explicitly designated as their own, recorded in the access handoff. If none is designated for a channel, send nothing on it.
- No purchases, number provisioning, paid hosting, new account connections, collaborator invitations or public sharing.
- No secrets, browser profiles or raw prospect records in Git, issues, PRs, screenshots, recordings or logs. Fixtures and demo data are fictitious. Credentials live in `~/.config/omnichannel-outreach/runtime.env`; load them, never print them.
- Operation is local-only for now. SMS and calling must not be presented as working provider integrations until they are provisioned and verified. Report an acceptance condition that cannot yet be verified as unverified.
- The spec's out-of-scope list and optional-polish list stay out. Do not expand a ticket beyond its acceptance criteria.

## History

Scoping used the Wayfinder skill. [The map](https://github.com/Pierpaolo01/omnichannel-outreach/issues/1) links each resolution; where its summaries are stale, the spec wins. The approved daily-workspace prototype is on branch `prototype/daily-workspace` at `prototypes/daily-workspace/index.html` (commit `3515d86`). Social research is on branch `research/social-first-contact`.

Source: principal's 11 November 2026 scoping request and 12 November 2026 build request.
