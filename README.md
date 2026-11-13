# omnichannel-outreach
Internal omnichannel outreach and CRM. Product scoping with Wayfinder; AI software factory delivery.

## Current phase

Delivery. Product scoping with Wayfinder finished on 12 November 2026, and the principal asked the software factory to build [the agreed spec](https://github.com/Pierpaolo01/omnichannel-outreach/issues/10) the same day. Work lands on the `integration/outreach-spec` branch through one pull request per ticket; see [docs/agents/delivery-workflow.md](docs/agents/delivery-workflow.md). The human decides product outcomes and acceptance. The AI software factory decides technical design and implementation.

[Wayfinder: define the email, SMS and phone outreach product](https://github.com/Pierpaolo01/omnichannel-outreach/issues/1) remains the index of the scoping decisions.

## Running it

Node 22.18 or later and pnpm 10.

```sh
pnpm install
pnpm seed:dev --reset   # fictitious fixtures into the development database
pnpm dev                # http://127.0.0.1:4310
pnpm check              # typecheck, lint, unit, HTTP and browser tests
```

`pnpm dev` keeps its data in `~/.local/share/omnichannel-outreach-dev` (`OUTREACH_DEV_DATA_DIR`). `pnpm build && pnpm start` runs the production build against `~/.local/share/omnichannel-outreach`. Set `OUTREACH_DATA_DIR` to use another directory outside the repository. The foundation and import model are recorded in [docs/adr/0001](docs/adr/0001-application-foundation-and-import-model.md).

## Starting context

The product is an internal outreach workspace running on the user's machine. An existing scraper supplies companies and decision makers. The CRM centralizes the records, campaign activity, conversations and sales progress. Instantly handles email delivery using six reported warmed inboxes. The broader requested channels also include phone/SMS, LinkedIn, Instagram and Facebook. Country, language, timezone and campaign settings should be configurable.

## Confirmed starting decisions

The user settled these inputs in the initial live product discussion on November 11, 2026, before the map was charted:

- Import the existing automation's CSV lead exports into a campaign.
- A campaign contains the outreach strategies, sequence and copy across its channels. AI-generated campaign creation is not an agreed requirement.
- The MVP covers email, SMS and phone calls. Social channels follow it.
- Automated outreach stops when a prospect replies. The user takes over the conversation and arranges the appointment.
- Phone outreach is a daily list that the user works through manually, speaking to prospects himself. Twilio is the proposed dialing provider; an AI voice caller is outside the MVP.
- LinkedIn InMail is a tentative route to investigate for the later social phase, not a selected strategy.

Earlier email/LinkedIn-first suggestions and technical architecture proposals are superseded or left for the software factory to evaluate. New product decisions live in the Wayfinder issue resolutions rather than being copied into this document.

## Planning entry points

- [Agent instructions](AGENTS.md)
- [Product glossary](CONTEXT.md)
- [GitHub tracker operations](.agents/issue-tracker.md)
- [Wayfinder product map](https://github.com/Pierpaolo01/omnichannel-outreach/issues/1)
- [GitHub Issues](https://github.com/Pierpaolo01/omnichannel-outreach/issues)

Source: the user's November 11, 2026 project-scoping conversation. No unrelated personal or client material is copied into this repository.
