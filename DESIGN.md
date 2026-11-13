---
name: Outreach
description: Operate-mode workspace for daily calls, leads and campaigns.
colors:
  paper: "#F3F5F8"
  surface: "#FFFFFF"
  raised: "#F8F9FB"
  line: "#E1E5EC"
  line-strong: "#C9CFDA"
  ink: "#151A2D"
  ink-2: "#3A4157"
  muted: "#636B80"
  faint: "#636B80"
  call: "#0B875D"
  call-hover: "#097450"
  call-soft: "#E2F4EC"
  band: "#151A2D"
  you: "#0B7A55"
  you-soft: "#E2F4EC"
  hand: "#2C55C9"
  hand-soft: "#E5ECFB"
  pause: "#9A5A00"
  pause-soft: "#FCEFD9"
  end: "#666C7E"
  end-soft: "#EDEFF3"
  crit: "#C0352B"
  crit-soft: "#FBE6E4"
  dark-paper: "#0F131E"
  dark-surface: "#161B28"
  dark-raised: "#1B2131"
  dark-line: "#262D3E"
  dark-ink: "#E8EBF3"
  dark-call: "#22B07D"
  dark-faint: "#8E94A9"
typography:
  display:
    fontFamily: "Schibsted Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "38px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Schibsted Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Schibsted Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: "Schibsted Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  record:
    fontFamily: "Schibsted Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "34px"
    fontWeight: 600
  clock:
    fontFamily: "Schibsted Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 500
  lede:
    fontFamily: "Schibsted Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 400
  search:
    fontFamily: "Schibsted Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 400
  role:
    fontFamily: "Schibsted Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
  body-small:
    fontFamily: "Schibsted Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
  nav-narrow:
    fontFamily: "Schibsted Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
  label:
    fontFamily: "Schibsted Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
rounded:
  sm: "5px"
  md: "9px"
  lg: "14px"
spacing:
  gutter: "40px"
  section: "40px"
  row: "14px"
components:
  button-primary:
    backgroundColor: "{colors.call}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
  button-primary-hover:
    backgroundColor: "{colors.call-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
  status-running:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.sm}"
  status-waiting-on-you:
    backgroundColor: "{colors.you-soft}"
    textColor: "{colors.you}"
    rounded: "{rounded.sm}"
  status-handed-to-you:
    backgroundColor: "{colors.hand-soft}"
    textColor: "{colors.hand}"
    rounded: "{rounded.sm}"
  status-paused:
    backgroundColor: "{colors.pause-soft}"
    textColor: "{colors.pause}"
    rounded: "{rounded.sm}"
  status-ended:
    backgroundColor: "{colors.end-soft}"
    textColor: "{colors.end}"
    rounded: "{rounded.sm}"
---

# Design System: Outreach

## Overview

This is an Operate-mode tool. One user works through calls, finds leads and imports campaigns at a laptop. The visual language comes from two approved prototypes, used as layout and interaction references with invented data:

- **Daily workspace**, approved for #6: `prototype/daily-workspace`, `prototypes/daily-workspace/index.html`, commit `3515d86`. It settles the shell and four-area navigation, Today, the call focus queue, lead search, the single-column person page, confirmations, the color tokens, the type and the spacing.
- **Guided import**, variant B, chosen by the principal on **12 November 2026** (#11): `prototype/campaigns-import`, `prototypes/campaigns-import/index.html`, commit `2e57d3e`. It settles the Campaigns list, the New campaign form, Import again, the importing state, the import results page, and the company record as Leads filtered to one company.

- **Campaign editor**, variant A, "Tabs and inspector", **provisional**: `prototype/campaign-editor`, `prototypes/campaign-editor/index.html` and `shots/a-*.png`, commit `f9c0f52`. On **12 November 2026** the coordinator recommended variant A to the principal and said work would start on A unless told otherwise; the principal has not chosen otherwise. It settles the campaign page's tabs (Sequence, Before launch, Test run, Leads, Imports), the canvas with the selected track's inspector beside it, the step editor, and the Before launch tab: launch bar, blockers, warnings, channel coverage, missing merge fields, daily load and copy for a lead. If the principal chooses B or C, these screens are rebuilt on that variant.

Restraint over expression: neutral paper and surfaces, one green for the main action and for calling, and the status colors. The dark in-call band on the call sheet is the one loud element.

Tokens live in `src/web/styles.css`. daisyUI themes `outreach-light` and `outreach-dark` carry the base, primary and semantic colors. CSS variables (`--o-*`, exposed as Tailwind colors such as `text-muted`, `bg-raised`, `bg-you-soft`) carry the prototype tokens daisyUI has no slot for. Dark mode follows `prefers-color-scheme`; `data-theme="outreach-light"` or `data-theme="outreach-dark"` on `<html>` forces either theme.

## Colors

- **Paper** (`base-200`) is the page background. **Surface** (`base-100`) is panels, tables and the rail. **Raised** is hover and group-header fill.
- **Call green** (`primary`) is for the main action on a page (New campaign, Create campaign and import, Start calling) and the calling controls. Nothing else uses it.
- **Status groups** use the same tokens everywhere a status appears: running is neutral with an inset line; waiting on you is green (`you`); handed to you is blue (`hand`); paused is amber (`pause`); ended is grey (`end`), with a hollow dot.
- **Critical** (`crit` on `crit-soft`) is for errors and refused files only.
- Never use raw Tailwind palette colors in UI. Every color comes from a theme token, so both themes stay readable.
- **Contrast adjustments, 12 November 2026.** The prototypes' colors were kept wherever WCAG AA allows. Four tokens moved to the nearest value that passes 4.5:1 for normal text on every surface they appear on: light `faint` `#949BAD` → `#646D83` (was 2.8:1 on white), dark `faint` `#6D7590` → `#8E94A9` (was 3.5:1 on raised), light `call`/`primary` `#0B8A5F` → `#0B875D` with hover `#097550` → `#097450` (white label was 4.36:1), and light `end` `#6B7285` → `#666C7E` (ended badge was 4.17:1). In the light theme `faint` is now an alias of `muted` (review round 1). AA leaves no lighter text tier on these surfaces, so one color has one name. Dark keeps its separate, lighter value, which passes. Decorative lines use `line-strong`.
- Placeholders use `muted` at full opacity in both themes. daisyUI's default is base-content at 50%, about 3.3:1 in light.
- `e2e/accessibility.spec.ts` runs an axe WCAG 2.1 AA scan, colour contrast included, over every route and state in `e2e/screens.ts`, in both themes. It also measures what axe skips: text axe cannot resolve (select chevrons, tab counts), every visible placeholder, and text faded by opacity, which fails outright. Add every new screen and state there, including pending and error states. A fixture screen renders every outreach status, a bad number and a newer email. Screens that need a connected inbox, a launch or sent email (the running app has no email provider yet) open on the app over the fake email provider, `e2e/fake-provider.ts`, which the test worker serves on its own port with the built client and a clock the tests advance. Browser tests fake responses only through `respond()` in `e2e/mocks.ts`, which is typed against `src/shared/api.ts`; ESLint forbids `route.fulfill` anywhere else, so a stale mock fails typecheck.

## Typography

- One family: Schibsted Grotesk, self-hosted as a variable font.
- Page titles are 30px semibold (Today's greeting is 38px). Person and company headings are 34px, their local time 26px. Section headings are 19px. Today's lede is 18px, the Leads search field 17px, role lines and result ledes 16px. Body text is 15px, secondary text 13–14px in `muted`, and field labels 13px semibold in `muted`. These are the prototype's steps; keep to them.
- Do not turn on tabular figures across a whole block: in this face they widen commas, full stops and colons. Use `tabular-nums` only on bare numbers, such as tab counts.

## Layout

- The shell is a 220px left rail plus one working area, padded 32px top and 40px left. Content is capped at 1180px wide. Below 901px the rail becomes a top bar.
- The person and company-lead record is one column, at most 780px: header with local time, a contact row, Campaigns, then Others at the company.
- Forms sit in one column at most 680px wide; file rows at most 640px.
- The quick search sits at the top right of the Campaigns list only, as in the guided-import prototype. The daily-workspace prototype defines it but shows it nowhere. Forms, results and records start with their back link.
- Nothing scrolls sideways or clips at any width. Below 561px the four areas share the top bar, each with its icon above a 12px label. Below 721px the import results table stacks each row into a block: name and result on the first line, then the company, then what happened. `e2e/layout.spec.ts` checks every screen in `e2e/screens.ts` at 1440, 1024, 768 and 390px.

## Elevation & Depth

Flat. Depth comes from tone (paper, surface, raised) and 1px lines, not shadows. daisyUI `--depth` is 0.

## Shapes

Field and button size follows the prototype: `--size-field` is 0.21875rem, so buttons, inputs and selects are 35px tall and small buttons 28px (the prototype's are 33px and 28px).

daisyUI's button noise layer is switched off (`.btn { background-image: none }`). The themes set `--noise: 0` anyway, and a plain background lets the contrast scan measure buttons.

Radii: 5px for status badges, 9px for fields and buttons, 14px for panels and tables. Dashed borders mean "nothing here yet": the empty Campaigns state, the Not launched dot and the No sequence yet rule.

## Components

- **Status badge** (`StatusBadge`, `src/web/status.tsx`): the status name with a 7px dot, colored by group. Labels follow the spec's wording.
- **Lead table**: Person, Company and Campaigns columns at 27%, 27% and the rest, with cells at the 15px body size, as in the approved table. Each campaign enrollment shows its status badge and campaign name. Rows open the record; the name is a real link. The counter says "7 people and 3 companies", because company leads are rows too. A company row's Company cell says "Company lead", or shows a dash (read out as "Not a company lead") for a company that is not one. Its role line says "No named decision maker", "Its decision makers can’t be reached directly", or, once a later import makes one reachable, how many can now be reached. While a search refreshes, the previous rows stay at full contrast, and a small spinner with "Updating results." sits beside the counter. Never fade content to show loading.
- **Enrollment list** (`EnrollmentList`): each status badge sits beside its campaign's name. Used on Leads rows and for colleagues on records, so a person in two campaigns never shows two unlabelled badges. Colleague rows follow the prototype: name with role beneath on the left, statuses on the right.
- **Long user content** (campaign names up to the 100-character limit) wraps anywhere in headings and campaign labels, so nothing scrolls sideways. The New campaign field counts characters from 80 onwards.
- **Contact row**: label above value, in the prototype's order: the person's emails, direct and mobile numbers, then the main line, then the shared inbox. Phone numbers are grouped for reading and dialing ("+44 20 7946 0101"). Bad details are struck through and labelled "marked wrong". Newer details are labelled "newer", in the same neutral label color. A missing main line reads "None in the scraper file".
- **Company record**: when Leads is filtered to a company, a panel above the table shows its main line, shared inbox and how many people on record are enrolled. There is no separate company page. A company lead keeps the single-column record from the daily-workspace prototype.
- **Campaign row**: name, a Not launched badge with a dashed dot, lead count, the last import's changes with See result, a No sequence yet rule, and Import again (or Import, before the first import).
- **File row** (guided import): icon, title, then the filename and the check result. Three states: empty (choose or drop), checked OK (green tick, Replace), refused (critical tint and message, Choose another file). When the server refuses a pair, the Businesses row takes the refusal, as in the approved invalid state. It loses its green tick, and Import stays disabled until a file is replaced. A check that returns after a newer selection is ignored.
- **Import results**: underline tabs on a full-width rule, 30px below the summary line, (All, New, Already enrolled, Updated, Not enrolled) with counts. Each tab is padded 10px 14px 12px with a 2px ink underline that sits on the 1px rule, as in the approved ledger. Then comes a table with Decision maker or company lead, Company, Result and What happened. In All, rows are grouped with raised group headers in the order Not enrolled, New, Updated, Already enrolled. The unchanged Already enrolled group collapses to one line with Show them.
- **Not-enrolled reasons** use the import results' wording everywhere: "no personal email or mobile, and no usable company main line" for a person, "no usable main line or shared inbox" for a company. "Usable" covers a main line marked wrong. When the person's company is a company lead, Leads and the record add "The company is contacted through its shared inbox instead." A row that could not be matched safely says why and that nothing was changed ("Matches more than one person on record at …, and nothing in the row tells them apart. Nothing was changed."). A number a colleague already holds is named on the row that listed it ("Direct line … is already Yara Glen’s, so it wasn’t added.").
- **Campaign page** (ticket 12c, variant A): back link, the name with a Not launched or Running badge, a line with the lead count and last import, and Launch… at the top right, which opens Before launch. Underline tabs as in the import results, as links, so each tab has its own address: Sequence `/campaigns/:id`, then `/before-launch`, `/test-run`, `/leads` and `/imports`. Before launch shows its blocker count ("2 to fix", in `crit`) or "Ready". On Before launch the header has no Launch… button, because the launch bar holds the page's one green action.
- **Canvas**: a raised panel with a dotted grid, the dark Launch pill, the connector label and one track node per track (channel, name, summary such as "2 emails over 2 days", one bar per email, outlined in `crit` while it has no copy, and "N to fix"). The node is a toggle button (`aria-pressed`) that opens the inspector beside the canvas from a 1020px viewport, below it on narrower screens. Side by side, both panels fill the view below the tabs, at least 470px tall as in variant A, and the inspector's body scrolls on its own, so the canvas stays in view. Closing the inspector returns focus to the node; adding the first track moves focus to Email 1's subject (`e2e/focus.spec.ts` checks every such transition listed in `e2e/screens.ts`). The open track and email are in the address (`?track=…&step=…`). Add track, SMS track and Phone track are disabled with the sentence that says they arrive with later releases.
- **Inspector**: the track's title and summary chip, a save status ("Saving…", "Saved") and a close button. Emails are collapsible blocks with a dashed rule between them carrying "Wait N days after Email N−1". An open email has the Continue thread / New subject choice (pill radios, continue thread by default after the first email), the subject field, or the thread's "Re: …" subject in a dashed box, the copy field, Merge field, and the fields the email uses: each field's chip, its fallback field and how many leads lack it, in `crit` when a lead lacks it and there is no fallback. Timing and sender: Starts, Sends from (the connected inboxes, or "No connected sender inbox" in `crit`), Sending window (day toggles Monday first, from and to hours) and Time zone (the lead's own, otherwise the campaign default, a select). Every change saves a moment after it is made, through one ordered save path (`src/web/campaign/saveQueue.ts`) that leaving the page and launch use too; leaving the page sends a change still waiting. Removing Email 1 makes the next email a first email, with no wait and its own subject. A continue-thread email shows "Re:" and the subject of the nearest earlier email that started a thread. A running campaign's inspector is read-only and says why; its emails still open.
- **Merge fields in copy** are written as `{{first_name}}` or `{{first_name|there}}` in a plain text field; the fallback field under the email rewrites every use in that email. The reference draws them as chips inside the copy; that is not built (see the pull request).
- **Campaign Leads tab**: every enrollment in the campaign, from lead search, with its outreach status badge, as on the reference's running Leads tab; before launch it also shows the fields each lead uses a fallback for. Channels show for leads that have not ended.
- **Before launch**: the launch bar (ready, blocked on `crit-soft`, nothing to launch, launched, and "Your latest change isn’t saved, so launch waits" on `crit-soft` with Try again, while the draft differs from what the server accepted), then two columns from 1240px: Blocks launch (each blocker with the action that opens the email or track it names), Warnings in `pause` with "don't block", Channel coverage, Missing merge fields, and Daily load per sender inbox (busiest day for this campaign, used today across campaigns, the pacing gap, and how many days until every lead with an email has started); beside them, sticky, Copy for a lead: a lead select with previous and next, "Lead N of M", the lead's role and address, and each email rendered for them, with a fallback underlined in dotted `hand` and a field with no fallback marked in `crit`.
- **Timeline** (Activity, on person and company-lead records): the daily-workspace prototype's timeline, newest first: a 32px round icon, the title with "in Campaign", the time on the right, and a body line. Sent emails expand with Show message to the copy that went, with its sender and address. Bounces and failures use `crit`, replies `hand`. There is no delivered state for email, because Instantly reports none. A campaign filter appears when the timeline spans more than one campaign. The note box arrives with the ticket that adds notes.
- **Empty states** say what is missing and what makes it appear. Areas that later tickets deliver (the Today call list, the Calls queue) say honestly that nothing is due.
- **Loading** uses daisyUI skeletons shaped like the content, in a `role="status"` container with an accessible name. **Errors** use a critical-tinted alert that names the problem and offers Try again. A secondary request that fails, such as the campaign options behind the Leads filter, gets its own alert and retry, and the control that depends on it is disabled.

## Do's and Don'ts

- Do keep one primary green action per page.
- Do say why a lead is not enrolled wherever their name appears without a campaign.
- Do not add a company page or bulk-selection checkboxes until a ticket asks for them.
- Do not invent operational numbers (calls ready, capacity, progress percentages). The importing state shows an indeterminate bar because real progress isn't measured.
- Do not use glass, gradients, colored side borders or decorative shadows.
