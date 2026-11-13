# Product

<!-- impeccable:product-schema 1 -->

Written on 12 November 2026 from the spec ([#10](https://github.com/Pierpaolo01/omnichannel-outreach/issues/10)), [CONTEXT.md](CONTEXT.md), the approved prototypes and the principal's decisions on [#11](https://github.com/Pierpaolo01/omnichannel-outreach/issues/11). Nobody was interviewed. Everything below comes from those sources; open points are marked as open.

## Platform

web

## Users

One outreach user, the principal. They run campaigns at companies and their decision makers, work a daily list of calls they place themselves, and take over every conversation once a prospect replies. They use the app on a laptop, at their desk.

## Product Purpose

An internal workspace that coordinates outreach across email, SMS and manually placed phone calls, with a central CRM of companies, people, contact details and campaign activity. It imports scraper CSV exports into campaigns, runs each lead's sequence, puts calls on the daily list, and stops automation when a prospect replies. Success means the user always knows whom to call, what happened, and which campaign work is running, waiting on them, or has ended.

## Positioning

It coordinates channels around one lead's sequence and hands the conversation to the user at the first reply. It does not manage replies, sales stages or appointments. The product's outreach job ends at the reply.

## Operating Context

- Leads come from an existing scraper's paired People and Businesses CSV exports.
- Instantly delivers email. SMS and calling are planned through a telephony provider that isn't provisioned yet.
- The user dials every call; nothing dials automatically. Replies are answered where they arrived: Instantly's inbox for email, the phone for SMS.
- For now the app runs locally only. Hosting is deferred.

## Capabilities and Constraints

- Vocabulary follows [CONTEXT.md](CONTEXT.md): company, decision maker, lead, company lead, campaign, channel track, sequence, call task, call outcome, outreach status.
- Each lead has exactly one outreach status per campaign. There are twelve statuses in five groups: running, waiting on you, handed to you, paused, ended.
- Four areas: Today, Calls, Leads, Campaigns. Laptop first; responsive layouts come later.
- Out of scope: sales stages, appointments, pipelines, do-not-contact, a reply inbox, reply content or classification, AI voice calls, and automatic stopping of colleagues or other campaigns.
- Open: the call script's content, the campaign settings beyond the name, and the canvas library. These belong to later tickets.

## Evidence on Hand

- The approved daily-workspace prototype: branch `prototype/daily-workspace`, `prototypes/daily-workspace/index.html` (commit `3515d86`).
- The approved guided-import prototype: branch `prototype/campaigns-import`, `prototypes/campaigns-import/index.html` (commit `2e57d3e`).
- Fictitious scraper fixtures in `test/fixtures/scraper/`.
- Real exports are private and stay outside Git. No testimonials, metrics or customer claims exist, and none may be invented.

## Product Principles

1. Never pretend work happened. Today, Calls and campaign status show only what the system actually did.
2. Automation stops at the reply. The user takes over, and the app records nothing past the handoff.
3. Every lead is reachable or says why not. Missing channels skip their steps, and unreachable decision makers stay on the company record so their names are there for calls.
4. Re-importing is safe: nobody is enrolled twice, no sequence restarts, and no detail is erased.
5. The interface is simple. The approved screens are settled; new screens go to the principal as variants.

## Accessibility & Inclusion

Keyboard access, visible focus, labelled controls and sufficient contrast in light and dark themes are part of done ([docs/agents/ui.md](docs/agents/ui.md)).
