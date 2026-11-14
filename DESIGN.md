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
  band-ok: "#7BE0B5"
  band-warn: "#FFCE85"
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
  call-name:
    fontFamily: "Schibsted Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "44px"
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: "-0.03em"
  call-name-narrow:
    fontFamily: "Schibsted Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "32px"
    fontWeight: 600
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
- Page titles are 30px semibold (Today's greeting is 38px). The name on the call band is 44px, 32px below 901px, its local time 34px, and the primary number 26px, as in the daily-workspace prototype. Person and company headings are 34px, their local time 26px. Section headings are 19px. Today's lede is 18px, the Leads search field 17px, role lines and result ledes 16px. Body text is 15px, secondary text 13–14px in `muted`, and field labels 13px semibold in `muted`. These are the prototype's steps; keep to them.
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
- **Canvas**: a raised panel with a dotted grid, the "together or after" legend, Add track, the dark Launch pill and one track node per track (channel, name, summary such as "2 emails over 2 days" or "2 texts over 2 days", one bar per message, outlined in `crit` while it has no copy, and "N to fix"). Since ticket 13b it draws every track as a tree: the tracks that start at launch hang from the Launch pill, labelled "together" when there are several, and each track that starts after another hangs from that one with the pill "after · N days". Tracks that hang from the same point are joined by a line at the top. Side by side, a track's node is 230px and each track hanging from a point has 12px either side, so a track takes the wider of its node and its row of children, plus 24px, and every level of a chain adds 24px; the canvas needs the sum over the tracks at launch, plus 16px (two tracks together need 524px; a chain of four, 342px). When the canvas is narrower than that (beside the inspector at a 1024px window, or on a phone), it draws the same tree as an outline: each track is indented about 24px under the track it starts after (the tracks that start at launch under the Launch pill), tracks that start at the same point share one indent, and each node narrows with the space left, down to 176px. Indenting stops at the deepest level whose nodes are still 176px wide (three levels beside the inspector at 1024px): a track deeper than that sits at its parent's indent, under it, and its label names the parent ("after email track 2 · 1 day"), so a chain of any length fits its panel and still says what each track starts after. Each indented level has a 1.5px `line-strong` connector running down from the parent beside its children, and every track keeps its "together" or "after" label above it. The canvas then scrolls vertically inside its panel, with the Launch pill pinned at its top. Nothing scrolls sideways. `e2e/layout.spec.ts` compares, at every width, the track each node is drawn under with the stored definition (below its parent; side by side in one row hanging under it, or indented under it sharing an indent with its siblings) and checks Launch stays in view when the canvas is scrolled to its end, that no node, label or connector crosses the canvas panel's edge, and that no node's content overflows it; chains of four and of twelve tracks (deeper than any width indents) are among its screens, with the inspector open and closed. Tracks are named by channel and order ("Email track 2", "SMS track"), never by position (`src/shared/track-label.ts`). **Add track** opens a short menu (Email track, SMS track, Phone track; ticket 14c); Escape closes it and returns focus to Add track. The empty canvas offers the same three. A new track starts at launch and opens in the inspector with focus on its first message, or for a phone track on its call script. A phone track shows as a Phone node, "One call", with one bar, and its declined path in `hand` as the reference's card says it ("If declined: win back"; "If declined: stop, not chosen yet" in `muted` while none is chosen); other tracks may start after it, and a second call attempt is a second phone track the user places. The node is a toggle button (`aria-pressed`) that opens the inspector beside the canvas from a 1020px viewport, below it on narrower screens. Side by side, both panels fill the view below the tabs, at least 470px tall as in variant A, and the inspector's body scrolls on its own, so the canvas stays in view. Closing the inspector returns focus to the node (`e2e/focus.spec.ts` checks every such transition listed in `e2e/screens.ts`). The open track and message are in the address (`?track=…&step=…`).
- **Win-back branch on the canvas** (ticket 16b, variant A's labelled box; **provisional** where the reference does not settle it: the box's place below the main sequence, its root label "when they enter win-back", its own Add and its empty state). Shown once the campaign has a phone track, or while the branch holds tracks. A box with a 1.5px dashed `hand` border at half strength on `hand-soft`, 48px below the main sequence; side by side, exactly as wide as the canvas budgeted for it (its tree, at least 320px) or the main sequence when wider, its name, Add and empty text wrapping inside so it never widens the canvas (`contain: inline-size`); as wide as the canvas when stacked: "Win-back branch" in `hand` with "· for leads who decline on a call" in `ink-2`, its own **Add win-back track** menu (Email track and SMS track only: the branch holds no phone track), and its tracks drawn as the main sequence's are, hanging from the point a lead enters the branch ("when they enter win-back", or "together"), side by side or as an outline by the same rule. Empty, it says "No tracks yet. A lead who declines on a call can move here, to email and SMS tracks of its own, with no more calls. Add one to offer win back on a phone track." with Email track and SMS track buttons. Each phone track whose path is win back has a 1.5px dashed `hand` edge (dash 5 4) with an arrow onto the box's top and an "if declined" pill left of the line: side by side the edge runs down the 12px each track's column keeps on its right, which no node uses; stacked it runs down a 20px gutter kept on the canvas's right. The legend adds "declined path" with a dashed swatch. Edges are measured before paint, as the canvas's width is. A branch track opens in the same inspector as any track of its channel; its Starts offers "When the lead enters win-back" or after a track of the branch, never the main sequence's. Removing a branch track moves focus to the branch's Add.
- **Inspector**: the track's title and summary chip, a save status ("Saving…", "Saved") and a close button. Emails are collapsible blocks with a dashed rule between them carrying "Wait N days after Email N−1". An open email has the Continue thread / New subject choice (pill radios, continue thread by default after the first email), the subject field, or the thread's "Re: …" subject in a dashed box, the copy field, Merge field, and the fields the email uses: each field's chip, its fallback field and how many leads lack it, in `crit` when a lead lacks it and there is no fallback. An SMS track's texts (ticket 13b) are the same blocks with no subject and no threading, a shorter message field and its character count before merge fields are filled in. Timing and sender: **Starts** (a select, "At launch" or "After" another track, and for after "finishes, plus N days", as in variant A's inspector; a change that would make tracks wait for each other is refused in `crit` under the control, which keeps focus, and nothing changes), Sends from (the connected inboxes, or the connected SMS numbers with each one's texts a day; "No connected sender inbox" or "No connected SMS number" in `crit` with the provider's reason), what limits texts (own mobiles only, so company leads skip; no subject; another campaign's conversation with a mobile), Sending window (day toggles Monday first, from and to hours) and Time zone (the lead's own, otherwise the campaign default, a select). Last, a secondary **Remove** button for the track; removing a track another starts after is refused in plain words beside it ("Email track 2 starts after this one. Change how it starts first."). Every change saves a moment after it is made, through one ordered save path (`src/web/campaign/saveQueue.ts`) that leaving the page and launch use too; leaving the page sends a change still waiting. Arranging tracks goes through `src/web/campaign/arrangement.ts` (ADR 0003, ticket 13b). Removing Email 1 makes the next email a first email, with no wait and its own subject. A continue-thread email shows "Re:" and the subject of the nearest earlier email that started a thread. A running campaign's inspector is read-only and says why; its messages still open.
- **Phone track inspector** (ticket 14c, variant A's phone inspector): the same frame, save status and notices as any track. A raised note says what a phone track is (one call, placed on your list when it falls due; you dial it and log what happened; a second planned attempt is another phone track) and that redials and callbacks arrive with a later release. **Call script**: a plain field for the campaign's one script, with a line saying every call task from the campaign shows it, as written, whichever phone track it comes from; it offers no merge fields, because the call task shows the script as written (the reference draws a merge chip in it; ticket 14c's pull request lists this among the decisions for the principal). **Skip it if unworked for N days**: the track's own skip limit, 2 by default, with a line saying skipping arrives with a later release and a call stays on the list until it is logged; a limit below 1 is said in the notices and nothing is saved until it is fixed. **If they decline on the call** (ticket 16b, the reference's radio group): three bordered options, Stop, Continue and Win back, each with the reference's line; the chosen one in `hand` on `hand-soft` (its secondary text in `ink-2`, since `muted` falls short of AA on that fill). None is checked while the track has no path chosen (question Q14 is the principal's), and a line above says what a declined call does meanwhile, as the engine reads it ("No path is chosen yet, so a declined call stops the lead in this campaign."). Win back is disabled while the branch has no live track, with the validator's own clause under it ("The campaign has no win-back branch: add a track to the win-back branch, or choose stop or continue."); once chosen it lists the branch's tracks as `hand` chips with their message counts, and **Edit branch** opens the first. A line under the group says no path calls the lead again, and that logging a decline on the Calls page, with a path for one lead, arrives with a later release. Choosing is the arrangement rule's `declined` operation, saved like every field. **Timing**: Starts, Calls ("Your list on Today and Calls, when each call falls due"; you dial every call; a phone track needs no sender), Calling hours (the sending window's day toggles and hours, labelled Calling days, Calling starts at, Calling ends at) and Time zone. Then Remove. A track that starts after a phone track says under its Starts control that it waits for the call's outcome: its delay counts from when the call is logged, or the phone track was skipped for the lead. A running campaign's phone inspector is read-only, as any track's.
- **Merge fields in copy** are written as `{{first_name}}` or `{{first_name|there}}` in a plain text field; the fallback field under the email rewrites every use in that email. The reference draws them as chips inside the copy; that is not built (see the pull request).
- **Campaign Leads tab**: every enrollment in the campaign, from lead search, with its outreach status badge, as on the reference's running Leads tab; before launch it also shows the fields each lead uses a fallback for. Channels show for leads that have not ended.
- **Before launch**: the launch bar (ready, blocked on `crit-soft`, nothing to launch, launched, and "Your latest change isn’t saved, so launch waits" on `crit-soft` with Try again, while the draft differs from what the server accepted), then two columns from 1240px: Blocks launch (each blocker named by its track, with the action that opens the message or track it names, on either channel), Warnings in `pause` with "don't block" (leads with no email, leads with no mobile of their own, senders that cannot send), Channel coverage, Missing merge fields, and Daily load per sender, email inboxes then SMS numbers, each with its channel icon (busiest day for this campaign, used today across campaigns, the pacing gap, and how many days until every lead has started on any channel; no figure, with the reason, while a track has no connected sender or a sender cannot send with no known end, or when the run stops early: the campaign is too large to estimate within the projection's bound, or runs past the estimate's 120 days), and, with a phone track, a last row **Your calls** (ticket 14c, the reference's row): the daily call capacity across campaigns, the busiest day of new calls this campaign puts on the list, and the calls on today's list of the capacity; a lead counts as started when its first call goes on the list, and the line under the table states the one assumption about calls in plain words: every call on the list is logged at the end of its day, after its calling hours, and gets no answer, and an earlier log can bring the messages after it forward, so its phone track finishes, the tracks after it start, and that lead's later messages and calls go first; another outcome changes it, as a reply would. A track after a phone track is projected under that assumption, and its messages in Copy for a lead carry "Day N, after the phone track's call". Before launch, Copy for a lead dates every message by the day the same projection sends it, so the preview and the figure never disagree. Warnings add leads with no phone number and an empty call script, and a sender the win-back branch uses that cannot send; beside them, sticky, Copy for a lead: a lead select with previous and next, "Lead N of M", the lead's role and how each channel reaches them, and every message of every track in the order it can go, headed "Email 1 · Email track 2" or "Text 1 · SMS track" with "Day N" counted from launch, a text in a bubble, a track the lead skips said so, a fallback underlined in dotted `hand` and a field with no fallback marked in `crit`. Below them (ticket 16b), "If they decline: the win-back branch" with a line saying these go only if the lead declines on a call, which the estimate never assumes, so none has a day; each branch message is headed with its track ("Email 1 · Win-back email track") and "Only if they decline".
- **Timeline** (Activity, on person and company-lead records): the daily-workspace prototype's timeline, newest first: a 32px round icon, the title with "in Campaign" (and the track's name first when its campaign has several on that channel), the time on the right, and a body line. Sent emails and texts expand with Show message to the copy that went, with its sender and address or number. Bounces, bad numbers and failures use `crit`, replies `hand` ("Replied by email", "Replied by text", channel and date only). A skipped track says why ("No mobile of their own."), and a track that started because the one before it was skipped or failed says so ("It starts after the SMS track, which ended on a bad number."). There is no delivered state for email, because Instantly reports none. A campaign filter appears when the timeline spans more than one campaign. Calls (ticket 14b) show each logged outcome with a green call icon: "Call: no answer" and the like, or "Call skipped for now", with the number dialled and the call's note; a phone track skipped for want of a good number, or started after a track that was skipped, says so as the other tracks do. The note box arrives with the ticket that adds notes.
- **Today** (ticket 14b): the user's date as the server counts it, the greeting, a lede with the ready-now and later-today counts (and "Today’s call capacity is used." when it is), and Start calling, the page's one green action, while a call is ready. Up next lists ready calls with company, reason (Due today, Rolled over from an earlier day, in `pause`) and the prospect's local time with the place their zone names; later-today calls follow in one sentence with when their calling hours start in the user's time. Needs attention is a list of bordered rows (dot, title, sentence, Open campaigns) for everything `GET /api/needs-attention` reports, each sender account once with its own reason; "Nothing needs you." otherwise.
- **Call focus queue** (ticket 14b): the queue beside the call sheet, 250px (290px from 1280px). Ready now and Later today, each with its count, then the rule sentence and the daily call capacity ("the default until you set one" at the factory default). The focused call is marked with the prototype's inset green bar and `aria-current`. Queue rows are not buttons: the focus moves only on an outcome (spec), so they are a list.
- **Call sheet**: the dark band (`band`) with the campaign and phone track, the name linking to the record, role at company, and on the right the prospect's local time, "Their time, inside calling hours" in `band-ok` or the opening time in `band-warn`, and the track's calling hours. The numbers are a radio group, "Number you dial": direct, then mobile, then the company's main line; the first good one starts chosen, a bad one is struck through in `band-muted` and cannot be chosen. The line under them says the user dials on their own phone and the app never places a call: there is no Call button. Below, two columns from 1280px (one below): people at the company with statuses and last call notes, company notes, the call script (open); and the compact timeline of earlier touches and notes with a link to the full record. The log bar is sticky at the bottom from 901px, in normal flow below: notes, "Save it as a company note instead", the outcome pills (pressed state in ink) in the prototype's order, Not interested as a dashed, disabled pill with the sentence that it arrives later (ticket 16), a box of what the chosen outcome does where the spec states it, and Log and open next call. While an outcome is pending the Log button stays focusable and reads "Logging…" (`aria-disabled`); every other outcome control is locked by the desk's one `locked` value.
- **Call notices**: a status line above the sheet says what the server did with this tab's last outcome, once the server's read of the call holds it (`you-soft`); that it is being logged, being logged from another window, being checked with the server, or not confirmed yet and being sent again (`pause-soft`, with Try again now). A call that left the list keeps showing, locked, with a `crit-soft` alert saying why from the server's facts ("already logged from another window or device" when the outcome was not this tab's), this tab's note when the server does not hold it, and Open the next call. Every refused outcome, whichever tab logged it and whichever call the page is on, is kept under "Outcomes not logged" with its reason, "The note typed with it", and Dismiss (`crit-soft`) until that Dismiss is pressed (moving on keeps it), oldest press first: the first shows and the rest wait behind "N more outcomes not logged", so the call stays on screen. When this tab's storage refuses to keep the draft, a `pause` line under the note says it is not kept on this device if the user leaves the page.
- **Redial and callback** (ticket 15b, from the prototype's outcome box). With no answer, left voicemail or didn't reach them, the box has the prototype's check, **Call again tomorrow**, and under it what the server's read says a redial does: the day the call moves to, that the phone track stays open, and the day its skip limit, still counted from the original due date, skips it if unworked; unchecked, that the call is done. **Callback requested** shows the prototype's **Day** select (the prospect's days from their today: "Today, Mon 9 Nov", "Tomorrow, …", then four weeks of dates) and **Their time** (a native time field), with the zone named beside them ("In London time (Europe/London)"); under them one live line says the time back in their time and the user's, and whether it is inside their calling hours, outside them, or on a day they never open (accepted in each case), or, in `crit`, that the time has passed or does not exist; a muted line says the hold the callback places. Any other outcome on a callback says it ends the hold; skip for now says what skipping does. A callback whose lead has no good number left says so in `band-warn` under the numbers (Q13, from the server's `noGoodNumber`), and every outcome but skip for now is disabled with the existing disabled style, described by that sentence. Before Log, the hold is said as what logging will do ("Logging this holds…"); it is said as held only once the server's read shows the callback. A time inside the hour the clocks repeat is said with its occurrence ("01:30 their time, after the clocks go back"); a day restored from an earlier session is said as a date. Log stays disabled until a callback has a time still to come.
- **Reasons on Today and Calls** (ticket 15b): "Due today", "Rolled over, due Mon 9 Nov", "Redial, due Mon 9 Nov" (in `pause`), each with ", last day before it’s skipped" when the server says the call is skipped tonight; "Callback they asked for at 15:30 their time" (with the user's time when it differs); "Callback overdue since today at 11:00 their time" in `crit`, with "; no good number left, only skip for now can be logged" (Q13). Q13's state is said by one function (`noGoodNumberText`): that short form in the queue and Up next, and one full sentence on the call sheet, Needs attention and the record, so the four cannot disagree. Needs attention starts with overdue callbacks, as in the prototype (one row naming whose, or a count), with **Open Calls** in place of the prototype's Call now, since the app never dials. Then, **provisionally** (14 November 2026, coordinator, after the review bot on `eac9f6c`; the prototype does not show it), one `pause` row for calls carried over from earlier days, from Today's counts: "4 calls carried over from earlier days", "Rolled over or redialed, each is on your list with its own original due date.", and how many are on their last day before being skipped when any are; Open Calls. No row when none; no per-call rows, since Up next lists each with its reason. The other rows keep Open campaigns. Times in the user's zone are said with the user's zone the server reads, never the prospect's: "15:30 their time, 10:30 your time".
- **Open calls on the record** (ticket 15b): under each campaign row's status, one sentence per open call from the record's read, only for calls the engine's listing rule lists today or on a later day (a lead that replied or was stopped keeps its tasks for a restart but shows none): on today's list (rolled over, a redial), on the list for a later day, waiting for calling hours, waiting on the lead's callback, or a callback with its time in their time, held, and overdue in `crit` with Q13's sentence. An overdue callback's first sentence alone is in `crit`, and Q13 adds only what it adds. Activity is history: it adds the redial with the day the engine listed it from, the callback asked for (with the hold only while the server says that callback is open) and the callback answered to each call's line, with every day and time in the user's zone as the server serves it, "Callback overdue" (`crit`) while one is open past its time, and "Phone track skipped, not called" with its due date and, for each track after it, what the server reports at the read, one sentence per track state: started, finished, skipped (and why), dropped for win-back, waiting out its delay with the day it starts, waiting until the lead's hold ends, not started because outreach stopped, or not started; the track after it says it started because of the skip only once it has.
- **Out of date** (ticket 14b, review round 2): Today and Calls read again every 20 seconds while visible. When Today's, the queue's or the call's reads fail twice in a row, a `pause-soft` notice says the page may be out of date, names the time it last loaded, says it keeps trying, and offers Try again. What it showed stays. A first load that fails is the usual error alert.
- **A disabled chosen number** (pending, or marked wrong) keeps its radio checked with a 2px ring (`band-ok` while being logged, `band-warn` when marked wrong) and the words "your choice", so the number being logged is visible in both themes.
- **Keyboard focus is never left on the page body** on Calls and Today (`src/web/focusRescue.ts`). A transition with a destination of its own places focus there first. Anything else that removes, replaces or disables the focused control hands focus to the best control left, in this order: Open the next call, a retry or the next kept refusal's Dismiss, the chosen number, another good number, then Back to Today or Start calling. `e2e/focus-rescue.spec.ts` finds every enabled button on those pages, in each state, activates it from the keyboard and fails if focus lands on the body.
- **Empty states** say what is missing and what makes it appear. With no call to make, Calls says "Nothing to call right now" (or "List done" after the last outcome) and why: calls open later today with the time, today's capacity is used, or no launched campaign has reached a call step.
- **Loading** uses daisyUI skeletons shaped like the content, in a `role="status"` container with an accessible name. **Errors** use a critical-tinted alert that names the problem and offers Try again. A secondary request that fails, such as the campaign options behind the Leads filter, gets its own alert and retry, and the control that depends on it is disabled.

## Do's and Don'ts

- Do keep one primary green action per page.
- Do say why a lead is not enrolled wherever their name appears without a campaign.
- Do not add a company page or bulk-selection checkboxes until a ticket asks for them.
- Do not invent operational numbers (calls ready, capacity, progress percentages). The importing state shows an indeterminate bar because real progress isn't measured.
- Do not use glass, gradients, colored side borders or decorative shadows.
