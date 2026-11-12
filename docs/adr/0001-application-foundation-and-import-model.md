# 0001: Application foundation and the import model

Date: 2026-11-12. Status: accepted. Ticket: [#11](https://github.com/Pierpaolo01/omnichannel-outreach/issues/11).

The first ticket lays the foundation later tickets build on. The coordinator set the stack; the implementer added the rest. Each decision says who made it.

## Stack (coordinator)

- TypeScript in strict mode on Node 22, managed with pnpm. `tsconfig.json` adds `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `erasableSyntaxOnly`.
- One locally run application. `pnpm dev` starts a single Node HTTP server on 127.0.0.1:4310 that serves the HTTP interface under `/api` and the React single-page app through Vite middleware. `pnpm start` serves the production build from `dist/`.
- SQLite persistence with versioned migrations, behind a module interface. Hosting is deferred: nothing here builds for it or blocks it.
- React, Tailwind CSS v4 and daisyUI 5, themed light and dark from the approved prototype's tokens and typeface.
- Vitest for domain and HTTP behavior, Playwright for browser behavior.
- `pnpm check` runs typecheck, lint, Vitest and Playwright. `.github/workflows/verify.yml` runs it on `pull_request`.

## Choices made by the implementer

- **Node runs TypeScript directly.** Node 22.18+ strips types, so the server, scripts and seed run with plain `node` and no build step. The cost is erasable syntax only (no enums or parameter properties) and `.ts` extensions in imports; `erasableSyntaxOnly` enforces it.
- **SQLite through the built-in `node:sqlite`.** It avoids a native module download. It is still marked experimental in Node 22. Scripts load `src/server/quiet-sqlite-warning.ts` with `node --import`, which drops only the SQLite experimental warning; every other warning still prints. If it changes incompatibly, `src/server/persistence/sqlite-store.ts` and `migrations.ts` are the files to change.
- **Known risk: Node 22's support window.** `engines` pins Node `>=22.18 <23`, and Node 22 leaves LTS at the end of April 2027. Moving to Node 24 is planned before then: re-run `pnpm check`, recheck `node:sqlite`'s API and stability, and widen `engines`.
- **Phone numbers with `libphonenumber-js`** (minimal metadata). Numbers key to E.164 from any written form, using the company's country for national forms, and display grouped for reading and dialing.
- **HTTP with Hono and `@hono/node-server`.** Tests call `app.request()` against a real in-memory SQLite store, so HTTP tests need no network. Request bodies are validated with zod at the edge.
- **Routing with wouter.** Search state on Leads lives in the URL.
- **Playwright 1.64.1**, the release that uses the Chromium build 1248 already in the local cache.
- **Tooling versions** are recent releases the implementer knows well (TypeScript 5.9, Vite 7, Vitest 3.2, ESLint 9) rather than the newest majors.
- **The typeface is self-hosted** from `@fontsource-variable/schibsted-grotesk`, so the local app loads no fonts from Google.

## Module seams

- `src/domain/` holds the rules as deep modules with no I/O. Time and identifiers are passed in.
  - `scraper-export.ts` parses and checks the paired CSV export (verified schema in #11).
  - `import-plan.ts` takes the CRM's directory and one export and returns the full plan: records to write, details to add, enrollments to create and the import summary. It is the seam the enrollment, matching and re-import rules are tested at.
  - `reach.ts` decides which channels a lead can use.
  - `outreach-status.ts` is the closed type of all twelve outreach statuses and their five groups from the spec. Later tickets extend behavior, not the set.
- `src/server/persistence/store.ts` is the persistence interface. Every method is asynchronous, so a hosted adapter (Postgres, D1, libSQL) can satisfy it later without changing callers. The spec needs email and SMS to keep running with the laptop off, so hosting will come within the MVP. An import is one call that loads the directory, runs the plan and applies it in one write transaction, optionally creating the campaign in the same transaction.
- `src/server/app.ts` is the HTTP interface. Tests at this seam cover re-import, multiple campaigns, search and records against real SQLite.
- `src/shared/api.ts` holds the response types the server and the web client share.

## Guardrails

- **Domain code never reads the clock.** An ESLint rule in `eslint.config.js` rejects `new Date()` with no arguments, `Date.now()`, `performance.now()`, `Math.random()`, `randomUUID()`, timers, `node:*` imports and imports from `server/` or `web/` inside `src/domain/`. Later tickets freeze and shorten clocks, so time has to be an input.
- **Prospect records stay out of the repository.** The database lives under `OUTREACH_DATA_DIR`, by default `~/.local/share/omnichannel-outreach` (`$XDG_DATA_HOME` respected). `src/server/config.ts` refuses a data directory inside the repository, and `.gitignore` ignores `*.sqlite*` as well.
- **Development data is separate, and a reset cannot reach real data.** `pnpm dev` and `pnpm seed:dev` use `OUTREACH_DEV_DATA_DIR`, by default `~/.local/share/omnichannel-outreach-dev`. They never read `OUTREACH_DATA_DIR`, and config refuses a development directory that resolves to the app's, whatever variables are set.
- **The local server only answers this machine.** `src/server/guard.ts` accepts only the hosts `localhost` and `127.0.0.1`, which stops DNS rebinding. Routes that change data must carry `application/json` and must not come from another site (`Sec-Fetch-Site`, `Origin`). That stops cross-site forms and no-cors fetches from creating campaigns or leads.
- Fixtures are fictitious. Domains use `.example`, and phone numbers come from the UK's drama ranges (`+44 20 7946 0xxx`, `+44 7700 900xxx`).

## Import model

These rules implement the spec's enrollment section and the principal's decisions recorded on #11. Product rules are cited; matching is a factory choice.

- **Who is enrolled.** Every decision maker with a usable channel is their own lead. A company with no named decision maker is a company lead. When none of a company's decision makers has a usable channel but the company has a shared inbox, the company is enrolled as a company lead through that inbox, and its decision makers stay on the record unenrolled (principal, 12 November 2026). A decision maker with no usable channel is never enrolled.
- **Usable channels.** A decision maker's email and SMS use only their own address and mobile. Calls may use their own numbers or the company main line. A company lead uses the shared inbox and main line. A main line is not treated as an SMS destination.
- **Personal versus company details.** A person's email that equals one of the company's shared inboxes is not stored as theirs. A personal phone field holding the company main line, in any written form, is the main line. When a later import lists as main line a number a person already holds, that detail moves to the company and keeps its id and bad mark. `dial_phone` is a mobile only when `dial_phone_type` says mobile or cell. A number listed both as direct and as mobile is a mobile, and a direct number a later import shows to be a mobile becomes one (the lead counts as updated). The real sample has no values in these fields, so the type mapping is an assumption to revisit when real values appear.
- **Phone identity.** One number has one key, its E.164 form, however it is written. National forms such as `020 7946 0101` read with the company's country, and `0044` prefixes are understood. So one number has one detail, one owner and one bad mark, and search finds it typed in international or national form. Numbers that cannot be read fall back to their digits.
- **Joining the two files (coordinator ruling, round 1).** A People row joins only to a business in the same export. There is no fallback to a company already in the CRM, and a blank `business_id` never matches. Such a row is not enrolled, with the reason that its company is not in the Businesses file.
- **Company matching (factory choice).** Scraper IDs are not proven stable across runs. A company matches on `place_id`; otherwise on `business_id`, or on its name with any main line it holds. Every main line is indexed. A key that more than one company holds is ambiguous and matches nothing, and two sides with different `place_id`s never match.
- **Person matching (coordinator ruling, round 1).** A person matches only people at their own company who existed before this import, and each existing person can be claimed by one row. So two rows of one export are never merged, and same-name colleagues stay separate. In order, a row matches the single unclaimed person who:
  1. has the row's own email;
  2. has the row's scraper `person_id` and the same name (a reused ID under a different name is not a match);
  3. has the same name and no conflicting email (both have personal emails and none is shared). This covers a re-import where the scraper ID changed.

  Names compare after removing accents, case, punctuation and titles such as Dr, Mrs, Prof and PhD, so "Dr. Grace Okafor" matches "Grace Okafor". When more than one person fits a rule, nobody is matched and a new person is created.
- **Re-import.** Existing enrollments are never touched, so no sequence restarts. New details are added alongside old ones. A detail counts as newer when its owner already had a detail on the same channel from an earlier import. Bad marks are never cleared. Non-contact fields such as a title take the newest non-empty value.
- **Summary.** Every row of the export lands in exactly one outcome. New means enrolled now. Already enrolled means no new contact details. Updated means already enrolled, and the import brought newer contact details. Not enrolled carries its reason: no usable channel, or a People row whose company is not in the Businesses file. That second case is a row, not a failed import.
- **Rejected files.** A file missing required columns, a file in the wrong slot, or a pair in which no person belongs to any business imports nothing. When it comes with a new campaign, the campaign is not created either. Extra columns are ignored.
- **No exclusions.** Only the target campaign's enrollments are consulted. Other campaigns never exclude anyone.
- **Context is kept.** Each company and person stores the full source row of its latest import, so the social URLs and scraper evidence that later tickets need are not lost.
- `email_status` from the scraper is stored in the source row but not interpreted.
