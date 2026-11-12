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
  faint: "#949BAD"
  call: "#0B8A5F"
  call-hover: "#097550"
  call-soft: "#E2F4EC"
  band: "#151A2D"
  you: "#0B7A55"
  you-soft: "#E2F4EC"
  hand: "#2C55C9"
  hand-soft: "#E5ECFB"
  pause: "#9A5A00"
  pause-soft: "#FCEFD9"
  end: "#6B7285"
  end-soft: "#EDEFF3"
  crit: "#C0352B"
  crit-soft: "#FBE6E4"
  dark-paper: "#0F131E"
  dark-surface: "#161B28"
  dark-raised: "#1B2131"
  dark-line: "#262D3E"
  dark-ink: "#E8EBF3"
  dark-call: "#22B07D"
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

Restraint over expression: neutral paper and surfaces, one green for the main action and for calling, and the status colors. The dark in-call band on the call sheet is the one loud element.

Tokens live in `src/web/styles.css`. daisyUI themes `outreach-light` and `outreach-dark` carry the base, primary and semantic colors. CSS variables (`--o-*`, exposed as Tailwind colors such as `text-muted`, `bg-raised`, `bg-you-soft`) carry the prototype tokens daisyUI has no slot for. Dark mode follows `prefers-color-scheme`; `data-theme="outreach-light"` or `data-theme="outreach-dark"` on `<html>` forces either theme.

## Colors

- **Paper** (`base-200`) is the page background. **Surface** (`base-100`) is panels, tables and the rail. **Raised** is hover and group-header fill.
- **Call green** (`primary`) is for the main action on a page (New campaign, Create campaign and import, Start calling) and the calling controls. Nothing else uses it.
- **Status groups** use the same tokens everywhere a status appears: running is neutral with an inset line; waiting on you is green (`you`); handed to you is blue (`hand`); paused is amber (`pause`); ended is grey (`end`), with a hollow dot.
- **Critical** (`crit` on `crit-soft`) is for errors and refused files only.
- Never use raw Tailwind palette colors in UI. Every color comes from a theme token, so both themes stay readable.

## Typography

- One family: Schibsted Grotesk, self-hosted as a variable font.
- Page titles are 30px semibold (Today's greeting is 38px). Person and company headings are 34px, their local time 26px. Section headings are 19px. Today's lede is 18px, the Leads search field 17px, role lines and result ledes 16px. Body text is 15px, secondary text 13–14px in `muted`, and field labels 13px semibold in `muted`. These are the prototype's steps; keep to them.
- Do not turn on tabular figures across a whole block: in this face they widen commas, full stops and colons. Use `tabular-nums` only on bare numbers, such as tab counts.

## Layout

- The shell is a 220px left rail plus one working area, padded 32px top and 40px left. Content is capped at 1180px wide. Below 901px the rail becomes a top bar.
- The person and company-lead record is one column, at most 780px: header with local time, a contact row, Campaigns, then Others at the company.
- Forms sit in one column at most 680px wide; file rows at most 640px.
- Every page except Leads has the quick search at the top right.

## Elevation & Depth

Flat. Depth comes from tone (paper, surface, raised) and 1px lines, not shadows. daisyUI `--depth` is 0.

## Shapes

Radii: 5px for status badges, 9px for fields and buttons, 14px for panels and tables. Dashed borders mean "nothing here yet": the empty Campaigns state, the Not launched dot and the No sequence yet rule.

## Components

- **Status badge** (`StatusBadge`, `src/web/status.tsx`): the status name with a 7px dot, colored by group. Labels follow the spec's wording.
- **Lead table**: Person, Company and Campaigns columns. Each campaign enrollment shows its status badge and campaign name. Rows open the record; the name is a real link.
- **Contact row**: label above value. Bad details are struck through and labelled "marked wrong". Newer details are labelled "newer" in `you`. A missing main line reads "None in the scraper file".
- **Company record**: when Leads is filtered to a company, a panel above the table shows its main line, shared inbox and how many people on record are enrolled. There is no separate company page. A company lead keeps the single-column record from the daily-workspace prototype.
- **Campaign row**: name, a Not launched badge with a dashed dot, lead count, the last import's changes with See result, a No sequence yet rule, and Import again (or Import, before the first import).
- **File row** (guided import): icon, title, then the filename and the check result. Three states: empty (choose or drop), checked OK (green tick, Replace), refused (critical tint and message, Choose another file).
- **Import results**: underline tabs (All, New, Already enrolled, Updated, Not enrolled) with counts, then a table with Decision maker or company lead, Company, Result and What happened. In All, rows are grouped with raised group headers in the order Not enrolled, New, Updated, Already enrolled. The unchanged Already enrolled group collapses to one line with Show them.
- **Empty states** say what is missing and what makes it appear. Areas that later tickets deliver (the Today call list, the Calls queue) say honestly that nothing is due.
- **Loading** uses daisyUI skeletons shaped like the content. **Errors** use a critical-tinted alert that names the problem and offers Try again.

## Do's and Don'ts

- Do keep one primary green action per page.
- Do say why a lead is not enrolled wherever their name appears without a campaign.
- Do not add a company page, bulk-selection checkboxes or activity timelines until a ticket asks for them.
- Do not invent operational numbers (calls ready, capacity, progress percentages). The importing state shows an indeterminate bar because real progress isn't measured.
- Do not use glass, gradients, colored side borders or decorative shadows.
