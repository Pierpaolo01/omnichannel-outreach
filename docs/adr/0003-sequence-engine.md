# 0003. The sequence engine

- **Date:** 2026-11-13.
- **Status:** Proposed. The council reviews it before ticket [12](https://github.com/Pierpaolo01/omnichannel-outreach/issues/12) starts.
- **Consumers:** tickets [12](https://github.com/Pierpaolo01/omnichannel-outreach/issues/12) to [23](https://github.com/Pierpaolo01/omnichannel-outreach/issues/23).
- **Builds on:** [ADR 0001](0001-application-foundation-and-import-model.md) (domain code never reads the clock; the closed outreach-status type; the store interface) and [ADR 0002](0002-email-through-instantly.md) (the application owns every clock; Instantly only carries email). This ADR is that "application owns every clock" half. The Instantly adapter, its experiments and its questions P1–P4 stay in ADR 0002.
- **Product source:** [the spec](https://github.com/Pierpaolo01/omnichannel-outreach/issues/10). Quoted product rules are cited by section. Everything else is a factory decision and says so.

## The rule in one paragraph

A campaign has a **definition**: immutable, numbered revisions of tracks, steps and start rules, whose ids never change or get reused. Each enrollment has a **progress record**: what has happened to that lead, stored as facts in the lead's own **lead time**, which advances only while the lead is running. Everything still to come, such as which track starts next, when the next step is due and whether the lead has finished, is **derived** from those facts and the current revision by one pure function. Effects on the outside world (a send, a call task on the list) happen only through a **claim**: a single write that re-checks the lead is running, reserves capacity, and creates the one attempt the step is allowed to have. Because a stopped, paused or replied lead's lead time does not move, nothing of theirs can come due, and because a claim is the only way to send, nothing of theirs can be sent.

## Context

The spec's sequence rules ("Define coordinated email, SMS and phone sequences", "Define the daily call list", "Define reply handoff") interact: a reply stops every track; a callback pauses the lead; an unworked call holds only the tracks after it; pause freezes waits and the call skip limit; edits must not replay finished work; capacity is shared across campaigns. Ten tickets build this one behaviour in slices. The import ticket (#11) showed what happens when a deep rule is coded before its invariants are written down: eleven review rounds. This ADR states the rule, its invariants, the input refused at the boundary, the guarantees held by construction, and the generated-sequence test, before any code.

## 1. The model

### 1.1 Campaign definition

A **revision** is an immutable JSON document stored in `campaign_revisions(campaign_id, rev, definition, created_at)`. `campaigns.current_rev` points at the one in force. Publishing an edit writes a new revision. Old revisions are kept, so every fact can name the revision it happened under.

A revision holds:

- **Campaign inputs.** Default time zone (required; defaults to the user's own zone when the campaign is created), call skip limit in days (default 2, spec "Unfinished call tasks"), the email sender pool, the SMS sender pool, and the phone tracks' calling hours (each phone track's window).
- **Tracks.** Each has a stable `track_id`, a `channel` (`email`, `sms` or `call`), a `branch` (`main` or `win_back`), a **window** (days of the week and `[start, end)` hours in the prospect's local time), an ordered list of steps, a **start rule**, and `removed` (a tombstone, see 1.3). A call track also has its **declined path**: `stop`, `continue` or `win_back`.
- **Steps.** Each has a stable `step_id`, a wait in whole days before it (none on the first step), its copy, and `removed`. An email step also has its threading mode: `new_subject` or `continue_thread` (the default on every step after the first). A call step has no copy. The campaign's call script is shown on the task.
- **Start rules.** Exactly one per track: `entry` (the lead enters the branch: launch or enrollment for `main`, entering win-back for `win_back`), or `after(track_id, delay_days)`. The canvas draws connections; a compiler turns them into start rules. A "together" connection from X to Y gives Y the same start rule as X. An "after" connection from X to Y with delay d gives Y `after(X, d)`.

There is one win-back branch per campaign (CONTEXT.md: "an alternative set of channel tracks within a campaign"). It is empty unless the user draws one. Every phone track whose declined path is `win_back` enters that same branch.

### 1.2 Per-lead progress

Progress is stored. Each fact is written once and never rewritten, except where noted.

**Enrollment** (the existing `enrollments` row, extended):

| Field | Meaning |
| - | - |
| `status` | The outreach status: a stored column, always equal to `deriveStatus(...)` (section 2.1). It is written in the same transaction as every change below and indexed for search and measures. |
| `ended` | Null while the lead's outreach can still run; otherwise the end reason, one of the six ended or handed-over statuses, plus `ended_at`. |
| `hold` | `none`, `lead_pause` or `callback`. Only one at a time (section 2.3). |
| `branch` | `main` or `win_back`, and `branch_entered_at` (lead time). |
| `no_more_calls` | Set by any declined call. Never cleared. |
| `frozen_since`, `frozen_total` | The lead clock (section 3). |
| `email_sender`, `sms_sender` | The sender account, fixed at the lead's first claim on that channel and never reassigned (spec "Email and Instantly": "A lead keeps one sender inbox for the whole campaign"; the same affinity for SMS is a factory choice). |
| `is_test`, `test_contact` | A test enrollment (section 3.6). |

**Track progress** `track_progress(enrollment_id, track_id)`: `started_at`, `started_rev`, `destination_detail_id` (the email address or mobile chosen at start: the newest good one), then `finished_at` and `finish_reason`: `completed`, `skipped_missing_channel`, `skipped_declined` (a call track after a decline), `skipped_by_user`, `skipped_unworked` (the call skip limit), `failed_bad_destination`, `dropped_for_win_back`. A track with no row has not started. A track with `finished_at` set is finished and stays finished.

**Step send** `step_sends(enrollment_id, step_id)`, unique on that pair: the one logical send of one step to one lead. It holds `basis_at` (lead time the step's wait counts from), `state` and `resolved_at`. States: `scheduled`, `in_flight` (it has a live attempt), `sent`, `skipped` (with a reason), `failed`, `held` (with a reason). It is created when the step becomes the track's current step. It is never deleted.

**Attempt** `attempts(id, step_send_id, ...)`: one handover to a provider, with ADR 0002's states (`adding`, `added`, `rejected`, `sent`, `withdraw-requested`, `withdrawn`, `unresolved`). A partial unique index allows at most one attempt per step send outside `rejected` and `withdrawn`. The attempt stores the rendered copy, the revision it was rendered from, the sender account, the destination detail id and the provider reference. The attempt id is the idempotency key.

**Call task** `call_tasks(step_send_id)`, unique: the one task for one call step. It holds `first_listed_day` (the user's local date it first went on the list), `skip_deadline` (lead time), `list_day` (the day it is listed for now), `kind` (`call` or `callback`), `callback_at` (wall time, set for a callback) and `open`. A **call attempt** `call_attempts(task_id, outcome, number_detail_id, note, at)` records each logged outcome. A redial or a callback changes the same task; it never creates a second one.

**Reply** `replies(enrollment_id, channel, at, provider_ref)`, unique on `provider_ref`: channel and date only, never content (spec "What the user sees and does").

**Capacity reservation** `capacity_ledger(account_id, reset_day, attempt_id)`, as ADR 0002 "Sender inbox and capacity" defines, for SMS accounts too. Call placements are counted per user day in `call_tasks`.

### 1.3 How progress follows a running edit

The engine always evaluates progress against the **current** revision. Ids are stable, and nothing is ever deleted from a revision: removing a track or step sets its `removed` tombstone, so every stored fact still finds its place. The spec's rules ("Editing a running campaign") then follow from one distinction.

- **A track a lead has started** keeps running for that lead, even if it is later removed ("rearranging tracks applies only to leads who haven't started the affected tracks"). Its step list is the current revision's:
  - Copy is rendered at claim time from the current revision, so a copy change reaches every message not yet handed over.
  - A step's due time is derived from its `basis_at` and the current wait, so a wait change applies to every step not yet sent.
  - The lead's next step is the first step that is not removed and comes after its last resolved step in the current order. So an added step reaches a lead only if it is placed after where the lead is. A step added before the lead's position is behind them and is not sent; sending it would be out of order. This reads "an added step reaches leads still in that track" together with "a removed step is skipped by leads who haven't reached it".
  - When an edit removes a step whose step send is `scheduled`, the edit's transaction closes it as `skipped` (`removed`). The next step's wait counts from the same `basis_at`. A step send `in_flight` has been reached and resolves normally.
- **A track a lead has not started** has no stored state, so its start is derived entirely from the current revision: added tracks, removed tracks, new connections and changed delays all apply.
- **A finished track never restarts.** Nothing in the edit path reads `finished_at` except to keep the track finished.

## 2. The state machine for one lead in one campaign

### 2.1 State and status

The lead's state is the product of:

- the campaign: `draft` (not launched), `launched`, and orthogonally `paused`;
- the enrollment's `ended`, `hold`, `branch` and `no_more_calls`;
- its track progress, step sends, attempts and call tasks.

The outreach status is a total function of that state. It is checked in this order, and the first match wins:

| # | Condition | Status |
| - | - | - |
| 1 | `ended` set | the end reason: `replied`, `interested_on_call`, `declined_on_call`, `stopped_manually`, `sequence_finished_no_response`, `finished_no_usable_channel` |
| 2 | `hold = callback` | `callback_scheduled` |
| 3 | `hold = lead_pause` | `paused` |
| 4 | `branch = win_back` | `in_win_back` |
| 5 | an open call task is listed | `waiting_on_call` |
| 6 | the lead has never been touched (no attempt ever claimed, no call task ever listed) | `queued` |
| 7 | otherwise | `active` |

These are exactly the twelve statuses of `src/domain/outreach-status.ts`; the set does not grow. Because there is one column and one total function, "each lead has exactly one status" holds by construction. The generated test still checks that the column equals the function after every event.

**A campaign pause is not a lead status.** The spec's paused banner shows "the count of leads in each status" while the campaign is paused, which only means something if each lead keeps its own status. A paused campaign freezes every lead's clock (section 3), lists none of its call tasks and claims nothing. Its leads keep their statuses, and the banner and person page say the campaign is paused. `paused` is the status of a lead the user paused.

**Restartable ends.** `replied`, `interested_on_call`, `declined_on_call` and `stopped_manually` can be restarted (resume from the next unsent step, or move to win-back). The spec offers this "for a lead that replied or was stopped"; an interested call stops all automated outreach and a declined call with the stop path "stops in this campaign", so both count as stopped. `sequence_finished_no_response` and `finished_no_usable_channel` cannot: one has nothing left to send, the other cannot be reached. Restarting from step 1 is never possible: no transition deletes or reopens a resolved step send.

**When a lead ends on its own.** After every transition the engine checks two things, in order:

1. **No usable channel.** The lead has work left in its branch (a track not finished), but none of the channels its branch uses can reach it now. This counts bad marks and `no_more_calls`, using `reach.ts`. The lead ends as `finished_no_usable_channel`, with the reason ("email bounced; no other channel"). A phone-only lead in an email-only campaign ends this way at launch. A lead that still has a channel some *finished* track used does not end this way: its remaining tracks are skipped as missing and the lead finishes normally. So a lead who received every email but has no mobile for the last SMS track ends as `sequence_finished_no_response`, not in Needs attention.
2. **Sequence finished.** Every track of the branch that is live for the lead (section 1.3) has finished, and no track is waiting to start. The lead ends as `sequence_finished_no_response`.

### 2.2 Events and transitions

R is a running lead (queued, active, in win-back or waiting on call: `ended` null, `hold` none). P is `paused`, CB is `callback_scheduled`, H is handed over (replied, interested on call), S is the other restartable ends (declined on call, stopped manually), F is the final ends, and D is a lead in a campaign not yet launched.

"Refused" means the API returns a plain error and changes nothing. The UI never offers a refused control: the allowed-controls function and the transition function share one table. "Impossible" means no well-formed history can produce the pair; the engine treats it as a bug and fails the transaction.

**Lifecycle**

| Event | Allowed in | Effect | Refused or impossible |
| - | - | - | - |
| Launch | D | The campaign becomes launched. Each enrollment's clock starts (section 3), and the main branch is entered at lead time 0. | Every other state: impossible. A campaign launches once; later enrollments enter launched. |
| Enroll (import into a launched campaign) | (new) | A new enrollment in R, frozen if the campaign is paused. Existing enrollments are not touched (spec "Re-importing"). | — |
| Time passes (evaluation) | R | The derived actions in 2.4. | D, P, CB, H, S, F: nothing can come due because their lead time is frozen. A callback's wall-clock appointment still moves from "later today" to "ready" or "overdue" on the list; that is presentation, not a transition. |

**Sending**

| Event | Allowed in | Effect | Refused or impossible |
| - | - | - | - |
| Claim a send | R, campaign running | In one transaction: re-read the lead and campaign, check the window, capacity, pacing, account health and destination (section 4); create the attempt (`adding`); reserve capacity; step send becomes `in_flight`. | Any other state, or a paused campaign: the claim's guard refuses it. That is the guarantee, not a convention. |
| Provider accepted / rejected / no answer | all but D | Recorded on the attempt. A rejection releases the reservation, then: a block-listed address skips the track; an invalid address or number marks the detail bad and fails the track; a temporary refusal returns the step send to `scheduled`. No answer leaves the attempt `adding` until reconciled (section 5). | D: impossible (no attempts). |
| Sent observed | all but D | Attempt and step send become `sent`; the reservation becomes a counted send. The next step's `basis_at` is the lead time now (frozen leads: their frozen lead time). On the last step, the track finishes `completed`. | D: impossible. In P, CB, H, S or F this can only be an attempt claimed while the lead was running and resolved later: ADR 0002's bounded handover. The test checks exactly that. |
| Bounce / invalid number reported | all but D | Marks the detail bad (ADR 0001: bad marks are never cleared), and the track finishes `failed_bad_destination` (spec "Missing and failed channels"). | D: impossible. |
| Reply detected, or marked by the user (social, later) | R, P, CB, S, F | `ended = replied`, with channel and date. In-flight attempts get a withdrawal request (ADR 0002). Nothing else changes, and no other enrollment is touched (spec "What stops"). | H: recorded on the timeline only; the first handover stands. D: impossible, since there is no thread to reply to. A reply after F turns "sequence finished, no response" into `replied` (question Q4). |
| Unresolved attempt resolved by the user | any | "Mark sent": the step send is `sent`. "Mark not sent": the attempt is `withdrawn` and the step send is `scheduled` again (ADR 0002 P3). | — |

**Calls.** A call outcome can be logged only on a listed task. A task is listed only while the lead is R or CB and the campaign is running.

| Event | Allowed in | Effect | Refused or impossible |
| - | - | - | - |
| No answer, voicemail, gatekeeper (with note), no redial | R | Task closed. The phone track finishes `completed`, and tracks after it start after their delay. | P, H, S, F, D, or a paused campaign: refused. The task is not listed. |
| …the same with redial | R | Task stays open with `list_day` set to the user's next day. `skip_deadline` is unchanged: "the unfinished-task limit still counts from the original due date". | As above. |
| Wrong or dead number | R | That number is marked bad. If no good number is left for calls, the track finishes `failed_bad_destination`, and later phone steps are skipped as missing channels. If another good number remains, the task stays open on today's list (question Q2). | As above. |
| Callback requested (date and time) | R | Task `kind = callback`, `callback_at` = the requested wall time. `hold = callback`: the lead's clock freezes and the status is `callback_scheduled`. | As above. |
| Interested | R | `ended = interested_on_call`. | As above. |
| Not interested, path stop | R | `ended = declined_on_call`. `no_more_calls` is set. | As above. |
| Not interested, path continue | R | Track finishes `completed`. `no_more_calls` is set; other open call tasks of the lead are closed and their tracks finish `skipped_declined`. Tracks after this one start as usual. | As above. |
| Not interested, path win-back | R | `no_more_calls` is set. Every unfinished main-branch track finishes `dropped_for_win_back`. Its scheduled step sends become `skipped` (`dropped`) and its in-flight attempts get a withdrawal request. `branch = win_back` at the current lead time. | As above, and refused when the campaign has no win-back branch (section 7 makes that unreachable). |
| Any outcome on a callback task | CB | `hold = none` first, then the matching row above. A redial makes it an ordinary task for the next day; a new callback time keeps it CB. | — |
| Skip for now | R, CB | The task moves to the end of today's queue. The lead does not change. | Same as other outcomes. |
| Rollover | — | Derived, not an event: an open task with `list_day` before today shows at the top as rolled over. | — |
| Skip limit reached | R | Raised by evaluation when lead time passes `skip_deadline`: task closed, track finishes `skipped_unworked`, shown as "skipped: not worked in N days". Tracks after it start after their delay. | CB: impossible, since the clock is frozen and callback tasks have no deadline. P, H, S, F, D: impossible, since lead time is frozen. |

**User controls** (spec "Controls" and "Restarting a lead")

| Event | Allowed in | Effect | Refused or impossible |
| - | - | - | - |
| Pause lead | R, D | `hold = lead_pause`; the clock freezes; listed call tasks leave the list; in-flight attempts get a withdrawal request. | P: refused (already paused). CB: refused, because automation is already paused until the callback's outcome. H, S, F: refused (ended). |
| Resume lead | P | `hold = none`; the clock resumes with every wait's remainder intact. Pacing prevents a burst (section 4). | Every other state: refused. |
| Pause campaign | launched | The campaign is paused; every enrollment's clock freezes in one transaction. No status changes. Its call tasks leave the list. | D: refused (not launched). |
| Resume campaign | launched and paused | The campaign runs again; clocks restart for enrollments with no end and no hold. | — |
| Skip step | R, P, CB | The lead's **next step**, the open step with the earliest due time (question Q6), becomes `skipped` (`by_user`). The following step's wait counts from now. On a call step, the task closes and the track finishes `skipped_by_user`. Skipping a callback task also clears `hold`. | Refused when that step is `in_flight`: it has already been handed over. H, S, F, D: refused. |
| Stop | R, P, CB, D | `ended = stopped_manually`. Progress is kept, so a later resume knows the next unsent step. In-flight attempts get a withdrawal request. | H, S, F: refused (already ended). |
| Resume from the next unsent step | H, S | `ended = null`; `lead_pause` is cleared; the clock resumes with every remaining wait as it was at the end. An open callback task makes the lead CB again. A `scheduled` step is due when its remaining wait runs out, and pacing spreads the restarted work. | F: refused, nothing is left. R, P, CB, D: refused (not ended). |
| Move to win-back | H, S, with `branch = main` and a win-back branch in the campaign | As "not interested, path win-back", then `ended = null`. | Already in win-back, or no win-back branch: refused. F, R, P, CB, D: refused. |

**Definition and environment**

| Event | Allowed in | Effect | Refused or impossible |
| - | - | - | - |
| Edit published | any | The current revision changes. Scheduled step sends of removed steps are closed (1.3); everything else is derived. | Refused if the revision fails section 7, or has a launch blocker while the campaign is launched. |
| Contact detail marked bad elsewhere (another campaign, a call outcome) | any | Nothing is stored here. The next evaluation sees the detail unusable: a claim refuses it, the track fails or is skipped, and the end checks run. | — |
| Sender account unhealthy, disconnected, or out of quota | any | Nothing is stored on the lead. Claims for that account wait, and Today's Needs attention shows them. | — |
| Restart after an interruption | — | Reconciliation (section 5), then normal evaluation. | — |

### 2.3 Impossible pairs, and why

- **Two holds at once.** A callback is requested only on a listed task, and a paused lead has none; pause is refused during a callback. So `hold` is a single field, not a set.
- **A call outcome on a paused, ended or campaign-paused lead.** The task is not listed, so the logging request finds no listed task and is refused as stale. This covers an outcome screen left open while someone paused the campaign.
- **Any call event in the win-back branch.** Win-back tracks cannot be call tracks (section 7).
- **A second call after any declined outcome.** `no_more_calls` is checked when a task is placed, and the decline closes every other open task in the same transaction.
- **A claim for a lead that is not R, or in a paused campaign.** The claim's guard re-reads both inside its own transaction.
- **Two live attempts for one step send.** Prevented by the unique index.
- **A call task for a step that already has one.** Prevented by the unique index; redials and callbacks change the existing task.
- **Something coming due while frozen.** Lead time does not move (section 3), and every due time is in lead time.

### 2.4 What evaluation does for a running lead

The pure function `evaluate(progress, revision, reach, leadNow, wallNow)` returns the transitions to apply now:

1. **Start tracks** whose start rule holds: `entry`, or `after(P, d)` with P finished at least d days ago (section 3.3). If the track's channel cannot reach the lead (missing, bad, or a call track after a decline), it starts and finishes `skipped_missing_channel` (or `skipped_declined`) at the same lead time, so tracks after it start after their own delay (spec "A skipped or failed track counts as finished").
2. **Open the next step** of every started, unfinished track whose current step send has resolved: create its step send with `basis_at` set to the resolution's lead time.
3. **Ready items:** step sends whose due time has passed. Email and SMS items go to the dispatcher (section 4). A call item is placed on the call list when there is call capacity and its calling window opens today.
4. **Skip-limit expiry** for open call tasks past `skip_deadline`.
5. **End checks** (2.1).

The function reads no clock and no store. The server calls it on a fixed tick, about every 15 seconds, and after every event. Each transition it returns is applied in its own transaction through the store.

## 3. Time

### 3.1 One injected clock

The server holds one `Clock` (`now(): number`, milliseconds). Domain code receives `now` as an argument (ADR 0001's lint rule). Tests use a manual clock and advance it themselves.

### 3.2 Lead time, and why freezing holds by construction

Every enrollment has two fields: `frozen_since` (a wall time, or null) and `frozen_total` (milliseconds).

```
leadNow(e, now) = (e.frozen_since ?? now) − e.frozen_total
runs(e)         = campaign launched ∧ ¬campaign paused ∧ e.ended = null ∧ e.hold = none
```

**Every progress fact and every deadline is stored in lead time:** `basis_at`, `started_at`, `finished_at`, `branch_entered_at` and `skip_deadline`. While a lead does not run, `frozen_since` is set, so `leadNow` is a constant and no comparison against it can change. Waits, track delays and the call skip limit therefore freeze together, whatever kind of timer a later ticket adds, without a list of timers to convert.

One function, `syncClock(e, now)`, ends every transaction that changes `runs(e)`:

- If the lead runs again: add `now − frozen_since` to `frozen_total`, and clear `frozen_since`.
- If it stops running: set `frozen_since = now`.

A campaign pause or resume calls it for every enrollment of the campaign in one transaction. A new enrollment starts frozen with `frozen_since = frozen_total = enrolled_at`, so its lead time starts at 0 and stays there until launch.

What freezes:

- **A paused campaign and a paused lead.** Spec "Controls".
- **A callback.** "Automation stays paused until the callback's outcome is logged".
- **An ended lead.** "Resume from the next unsent step… like resuming a campaign", so a stopped lead's remaining waits are kept for a resume.

What does not freeze:

- **A sending interruption.** The app being off is not a pause. Missed work comes due and is spread by pacing (section 4).
- **An unworked call.** It holds only its own track and the tracks after it (spec "Phone tracks").

The only wall-clock time a lead carries is `callback_at`. A callback is an appointment with the prospect, so a pause never moves it; after a campaign resume, a callback whose time has passed shows as overdue.

### 3.3 Waits and delays in days

A wait or delay of N days counts in **calendar days in the prospect's time zone**. The item is due at the start of the prospect's local day N days after its basis, then waits for its window. N = 0 means due at once. Basis + 24 h × N would drift a little later each step and spill past the window's end; calendar days keep "two days later" meaning the same weekday every time. This is a factory reading of "waits are counted in days".

The arithmetic: take the basis's wall time, `basis_at + frozen_total`, and find its local date. Add N days, take local midnight, and convert back by subtracting `frozen_total`. The conversion uses the current `frozen_total`, so a pause of length D moves every pending due time D later, which is exactly what freezing means.

### 3.4 Windows and time zones

- **The prospect's zone** is the person's zone, else the company's, else the campaign default (spec "Pace, capacity and timing"). An invalid IANA name falls through to the next one. The campaign default cannot be empty (section 7).
- **A step can be claimed** only while its track's window is open in that zone. "A step due outside its window waits for the next window." Daylight-saving changes are handled by the zone library; the domain uses explicit-argument dates only.
- **Calling hours** are the phone track's window, in the prospect's zone. The **call list's day** is the user's day, in the user's zone (a setting that defaults to the machine's zone).

### 3.5 Resuming without a burst

Nothing special happens at resume. Lead time picks up where it stopped, so leads whose steps were not due at the pause are still not due. Work that was due but unsent at the pause, or that a resume releases, goes through the dispatcher's per-account pacing (section 4). That pacing applies at all times, so a resume, a restart after an interruption and a launch all spread their sends the same way.

### 3.6 Test runs

A test run is an enrollment with `is_test` and a `test_contact` (the user's own email or mobile, chosen in the editor), not a lead. It runs through the same engine, ports, sender accounts and capacity ledger ("test sends count like any other send"). Its copy is rendered for a lead the user picks in the preview. It differs in exactly three ways:

1. **Shorter timing.** Every wait and track delay is 60 seconds of lead time instead of N days.
2. **No sending windows.** The test contact is not a prospect, and "each wait cut to about a minute" would mean nothing if a test started at 19:00 waited until morning (question Q5).
3. **Kept out of lead counts.** It is excluded from lead search, outreach-status counts and campaign measures, but its sends count against capacity.

Test call tasks go on the user's list labelled as tests, and their outcomes follow the canvas paths, including win-back. A reply from the test contact ends the test as `replied`. Starting a new test stops the campaign's previous test enrollment. The call skip limit stays in days for tests: the user works a test call while watching, and a limit of a minute would expire it first.

## 4. Capacity, priority and pacing

**Capacity per sender account, across campaigns.** Each email and SMS sender account has a daily capacity, a positive integer, counted on the account's reset day: Instantly's reset zone for email (ADR 0002, S5), and the user's zone for SMS. A claim succeeds only if `sends counted + open reservations (+ other senders, ADR 0002) < capacity` for the current reset day. The check and the reservation happen in the same transaction, so two claims cannot both take the last unit. SQLite has a single writer; a hosted adapter must lock the account's ledger row.

**Priority, within one account:**

1. **Leads already touched** in their campaign go first: any step of an enrollment that has had an attempt claimed or a call listed. Then the **first touch of untouched leads** (status `queued`). This is "follow-ups go before first messages to new leads". The first step of a second track counts as a follow-up, because the lead is not new.
2. **Oldest due first** within each class, comparing due times as wall instants.
3. **Then enrollment id, then step id**, so the order is total and the test can predict it.

Items that do not fit today wait for the next reset day and are never dropped. A lead whose first touch is waiting stays `queued`, and Today's Needs attention counts "waiting for sending capacity".

**Pacing.** Each account has a minimum gap between lead handovers. The default is the account's nominal sending day (8 hours unless set) divided by its daily capacity, kept between 60 seconds and 30 minutes. A claim is refused until the gap since the account's last handover has passed. That one rule makes "no burst" structural for resume, recovery and launch (spec "Controls" and "Runs without the laptop"). Test sends still occupy the slot, but they do not wait for the gap: a test is one recipient, and making it wait would break "about a minute".

**Sender choice.** At a lead's first claim on a channel, the engine picks the pool account that has capacity left and can send soonest. Ties go to the most remaining capacity, then the account id. The choice is stored and never changed. If that account is unhealthy or out of capacity, the lead's work on that channel waits; it never moves to another account.

**Calls.** The user has one daily call capacity, a positive integer. Tasks already committed (rolled over, redialed to today, callbacks due today) count against it first. New tasks are placed, highest priority first by the same two classes, only while `new placed today < capacity − committed`. `first_listed_day` and `skip_deadline` are set when the task is placed, not when the step came due: the limit counts days the call was on the list.

- `skip_deadline` = the start of `first_listed_day` in the user's zone, converted to lead time, plus N days.
- "Ready now" means inside the prospect's calling hours. "Later today" means the calling hours open later today, or a callback is due later today. Ready tasks are ordered "oldest due first" (spec "Working through today's list").

## 5. The provider boundary

### 5.1 Ports

Each channel that sends has one port. The engine depends only on the port.

```
interface SendPort {
  handover(a: { attemptId, sender, destination, rendered, threadRef? }):
    Promise<{ kind: "accepted", providerRef } | { kind: "rejected", reason, permanent: boolean } | { kind: "unknown" }>
  observe(since): Promise<ProviderEvent[]>   // sent, delivered, failed, bounced, reply, unsubscribed
  lookup(attemptId): Promise<"sent" | "not-sent" | "unknown">   // reconciliation
}
```

- **Email:** the Instantly adapter of ADR 0002. `attemptId` is the `/leads/add` idempotency key. Continue-thread steps use the X2 transport once it passes.
- **SMS:** no provider is provisioned (#28). The running app registers an `UnprovisionedSmsPort` with no sender accounts. So an SMS track always hits launch blocker 3, "no connected sender account": honest by construction, with no flag to forget. Tests and the ticket 13 demonstration use a simulator port whose accounts are named "Simulated SMS (not a provider)" on every screen. It is registered only against the development data directory (ADR 0001), so it cannot run against real data.
- **Calls:** there is no port, and the engine never places a call. A call task is work for the user. A call counts as made only when the user logs an outcome, which is "pretend a call happened when it did not" (spec "Problem Statement") refused by construction. Phone tracks need no connected sender account, because the user dials from their own phone (question Q1). A dialer added later would only help the user dial; the outcome would still be the user's entry.

### 5.2 What the engine records before and after a provider call

This is an outbox:

1. **Claim transaction** (section 2.2): the attempt is `adding` and capacity is reserved. Commit.
2. **Immediately before the call,** the worker re-reads the lead, the campaign, the window and the account's health in a fresh read, and for email runs ADR 0002's pre-send reply check. If anything fails, the attempt becomes `withdrawn` without calling the provider, the reservation is released and the step send returns to `scheduled`.
3. **The provider call,** outside any transaction.
4. **Result transaction:**
   - `accepted`: the attempt is `added`, with its provider reference.
   - `rejected`: as in 2.2.
   - `unknown`, a timeout or a lost response: the attempt stays `adding`.
5. **Observation** (polling or webhooks) applies sent, delivered, failed, bounced and reply events as transitions. Each is matched to an attempt by provider reference or thread (ADR 0002 "Recovery"), and is idempotent by provider id.

The same worker handles every `adding` attempt, whether new or left over from before a restart. There is no separate retry path.

### 5.3 Held sends

A step send is `held` when the engine cannot proceed without guessing or without the user. Held work stops only that track (and so the tracks after it). The other tracks and the lead's status are unchanged, and each hold appears in Needs attention with its reason:

- **`unresolved`:** an attempt the provider can neither confirm nor deny (ADR 0002). Never retried automatically; the user resolves it (P3).
- **`render_failed`:** a lead enrolled after launch lacks a merge field that has no fallback. The copy is never sent with a gap.
- **`provider_skipped`:** Instantly skipped the lead for no reason the API exposes (ADR 0002 P4).

Account-level holds (disconnected, stale inbox, quota exhausted) are not stored on leads. Claims for the account wait, and Needs attention shows the account.

### 5.4 Restart and reconciliation

On start, before the first evaluation:

1. Apply observed provider events since the last checkpoint, with ADR 0002's overlap.
2. For each attempt still `adding`:
   - if the provider has a durable idempotency key (Instantly `/leads/add`), hand it over again with the **same** attempt id;
   - otherwise call `lookup`: "sent" and "not-sent" resolve it; "unknown" after a settling period makes it `unresolved`.
3. Then evaluate, which releases overdue work through pacing and capacity.
4. Write the interruption notice. The gap is between the last tick before the stop (`engine_heartbeat`, written each tick) and now. N is the number of step sends whose due time fell inside that gap. Only the latest notice is kept (spec: "no history or audit log beyond that").

Nothing is sent twice, because a step send has one live attempt, a retry reuses its key, and an attempt the engine cannot settle is held instead of repeated. Nothing is skipped, because a due item stays scheduled until it is claimed, skipped by a rule or the user, or held with a reason. Both promises remain unverified against the real provider until ADR 0002's X5 and X6 pass. Laptop-independent sending is unverified while operation is local-only (#28).

## 6. Invariants

The generated-sequence test asserts all of these after every event, against the real store.

1. **One status.** Every enrollment has exactly one outreach status, and the stored column equals `deriveStatus` of its stored state.
2. **No claim unless running.** No attempt is created, and no call task is listed, while the enrollment has `ended` set, has a hold, or its campaign is paused or not launched. The one exception is the lead's own callback task, which stays listed while `hold = callback` and the campaign runs. (Nothing is sent after a recorded reply or stop, or during a pause, except what was claimed before and left in flight, bounded by ADR 0002's `k`.)
3. **At most one live attempt, at most one send.** A step send has at most one attempt outside `rejected` and `withdrawn`, at most one `sent` attempt, and none after it is `sent`.
4. **A step is sent at most once** per enrollment, across resumes, win-back, edits, test runs and restarts. (Test runs are separate enrollments.)
5. **A finished track never restarts.** Once `finished_at` is set, no new step send or call task is created for that track and enrollment, and `started_at` is written once.
6. **"After" ordering.** A track whose start rule at its `started_rev` is `after(P, d)` starts at a lead time at least d calendar days (3.3) after P's `finished_at`. Tracks connected "together" and started under the same rule start at the same lead time.
7. **Step order.** Within a track, step sends are created in the current revision's order, each only after the previous one resolved. Each is claimed no earlier than its due time.
8. **Frozen clocks.** While `runs(e)` is false, `frozen_since` is set and `leadNow(e)` is constant. `frozen_since` is null exactly when `runs(e)` is true. Pausing and resuming after wall duration D moves every pending due time and skip deadline of that lead D later, and moves nothing else.
9. **Capacity.** For every sender account and reset day, counted sends plus open reservations never exceed capacity. For every user day, tasks listed never exceed call capacity, except tasks committed earlier (rollover, redial, callback), which are never removed for lack of room.
10. **Priority.** When an item is claimed for an account, no item for that account that was eligible at the same moment had higher priority (4).
11. **No burst.** Two lead handovers from one account are never closer together than its gap.
12. **Windows.** Every lead handover happens inside its track's window in the prospect's zone; every call task is listed as "ready now" only inside calling hours.
13. **Campaign-local reply.** A reply changes only the enrollment whose thread or number it came in on. Other campaigns, colleagues and company leads are unchanged.
14. **No call after a decline.** After any declined outcome, no call task is created for that enrollment, and win-back never contains a call task.
15. **Outcomes need a listed task.** Every call attempt belongs to a task that was listed when it was logged. An open callback task implies `hold = callback`. A callback task is never closed by the skip limit.
16. **Redial keeps the original deadline.** Redials and rollovers never change `skip_deadline`.
17. **Nothing dropped.** At the end of every generated run, after enough time has passed with enough capacity, every enrollment is ended, frozen, or has every unfinished track held with a reason or waiting on a listed call task.
18. **No restart from step 1.** No event deletes a step send, or moves one from `sent`, `skipped` or `failed` back to `scheduled`.
19. **Good destinations only.** A claim names a destination detail that is good (not bad) and belongs to the lead under ADR 0001's ownership rules at claim time. A decision maker's email and SMS use only their own details.
20. **Correct endings.** `sequence_finished_no_response` only when every live track of the branch has finished and no reply or interested call was recorded. `finished_no_usable_channel` only under 2.1's rule.
21. **Tests stay out of lead counts.** Test enrollments never appear in lead search, status counts or measures. Their sends do count in the capacity ledger.
22. **Re-import never moves progress.** An import changes no existing enrollment's progress, status or clock.
23. **Allowed controls match transitions.** Every control the person page offers for a status is accepted by the transition function, and every control it does not offer is refused.

## 7. Input refused at the boundary

### 7.1 Definitions that cannot be saved

The canvas cannot produce these, and the server refuses them with a plain message. They are not launch blockers; such a definition never exists.

- A cycle in start rules, with "together" resolved.
- A start rule naming a missing or removed track, or a track in the other branch.
- A track with more than one start rule, which includes a track connected "after" two tracks (question Q3).
- A call track with more than one step (spec "Phone tracks": "one call with no follow-ups").
- A call track in the win-back branch (spec "Declined calls and the win-back branch": "no cold call").
- A declined path of `win_back` when the campaign's win-back branch has no live track.
- A wait on a first step; a wait or delay that is not a whole number of days from 0 up to 365.
- A `continue_thread` first email step: it has no thread to continue.
- A window with no days, or hours where end ≤ start. Overnight windows are not offered in the MVP.
- A campaign default zone, or a lead or company zone given as a setting, that is not an IANA name.
- A sender or call capacity that is not a positive integer. Pausing is the way to stop sending.
- An edit that changes a track's channel or a step's track. Remove it and add a new one instead, so ids keep one meaning.
- A main branch with no track at launch. There is nothing to launch; this is not a warning turned into a gate.

### 7.2 The three launch blockers

Exactly three conditions block launch, and they also block publishing an edit to a launched campaign ("retain the same three blockers", ticket 19). Every other condition is a warning, including "no test run since the last edit" (ticket 21).

1. **Empty copy.** A live email or SMS step in either branch has an empty body, or an empty subject on a `new_subject` email step. Call steps have no copy; an empty call script is a warning.
2. **A merge field with no fallback that some lead lacks.** Each merge field in a live step's copy that has no fallback is checked against every enrollment in the campaign that has not ended. For a lead enrolled after launch, the same check runs at claim time and holds the step as `render_failed` (5.3).
3. **A track whose channel has no connected sender account.** An email track needs at least one healthy inbox in the pool; an SMS track needs at least one connected SMS sender (so SMS is blocked until a provider exists); a phone track needs none (question Q1).

## 8. Test strategy

### 8.1 Seams

- **`src/domain/sequence/`**, pure: `definition.ts` (types, canvas compiler, validator of 7.1), `blockers.ts` (7.2), `clock.ts` (lead time, `syncClock`, calendar days, windows), `progress.ts` (state, events, `transition`, `evaluate`, `deriveStatus`, allowed controls), `dispatch.ts` (eligibility, priority, capacity, pacing, sender choice), `describe.ts` (the person page's next-step sentence).
- **`src/server/engine/`**: the tick loop, the claim and result transactions, the outbox worker, the ports and reconciliation. The store gains sequence methods that apply one transition in one transaction and return its effects.

Example-based tests at both seams cover each transition table row. The generated test covers what examples miss.

### 8.2 The generated-sequence test

It lives in `src/server/sequence-runs.test.ts`, with its generator and record in `test/support/generated-sequences.ts`, and runs through the real SQLite store and a fake port for each channel. It follows the pattern of `src/server/import-sequences.test.ts`. A run is seeded and does this:

1. **Generate.** One to three campaigns sharing sender accounts. Their definitions are trees of tracks with random channels, steps, waits, delays, windows, zones and declined paths, all within 7.1 (refused definitions get their own example tests). Leads have varied reach and zones.
2. **Generate events.** An event sequence, interleaving:
   - clock advances, from minutes to weeks;
   - provider outcomes: accepted, rejected for each reason, lost responses, late sent observations, bounces;
   - replies at random times, including while an attempt is in flight and after a lead has ended;
   - call outcomes picked from what is listed;
   - user controls, including ones that should be refused;
   - edits, re-imports, and crash-restarts at every step boundary: the in-memory engine is dropped and rebuilt from the store between the claim and the provider call, and between the call and the result.
3. **Keep an independent record.** A reference model in the test support directory, written from the spec's wording, that imports nothing from `src/domain/sequence/`. It keeps each lead's history in wall time, with an explicit list of paused intervals (not lead time). From those it computes "active days elapsed", which tracks have started and finished, which steps have been sent, which are due, and what the lead's status is. Capacity, windows and pacing are not predicted; they are checked as invariants 9–12 on the dispatch log. This is ADR 0001's split: the record predicts what it can decide independently, and invariants check the rest.
4. **After every event,** assert invariants 1–23, and compare the app's per-lead state (status, sent steps in order, finished tracks, open call tasks) with the record. An unlimited-capacity variant of each seed also compares the exact day each step was claimed.
5. **Mutation proof.** `src/server/sequence-runs-oracle.test.ts` swaps in deliberately broken engines and requires the generated runs to fail. Each ticket adds the ones it can now detect:
   - a claim that skips the reply guard;
   - `syncClock` that forgets `frozen_total`;
   - a redial that resets `skip_deadline`;
   - an edit that restarts finished tracks;
   - a capacity check off by one;
   - priority ignoring follow-ups.

Each failure the generator finds is shrunk into a named example test. The seed count starts at 100, ten per chunk, like the import test.

### 8.3 What the generator must produce by the end of each ticket

| Ticket | Generator adds | Invariants first asserted | Mutations added |
| - | - | - | - |
| 12 | One email track, 1–5 steps, waits 0–7 days, windows and zones; leads with and without email; 1–3 inboxes shared by 1–2 campaigns; accept, block-list, invalid, lost response, late send, bounce; replies; re-imports into a launched campaign; crash-restart | 1–4, 7, 9–13, 17–20, 22 | reply guard, capacity off by one, window ignored, priority, burst |
| 13 | Trees of email and SMS tracks with together and after; missing and failing channels; cross-channel replies | 5, 6 | after starts early, skipped track not releasing |
| 14 | Call tracks; call capacity; outcomes no answer, voicemail, gatekeeper, wrong number, interested | 15 (listed task) | outcome on an unlisted task |
| 15 | Redial, rollover days, skip limit, callbacks at random times including overdue | 8 (callback holds), 15, 16 | redial resets deadline, callback expires |
| 16 | Declined paths with per-lead overrides; win-back branches | 14 | call after decline |
| 17 | Pause and resume of leads and campaigns, skip, stop, resume next unsent, move to win-back | 2 and 8 in full, 23 | `syncClock` forgets, resume restarts a step |
| 18 | Bulk sequences of the above across campaigns | 23 across campaigns | — |
| 19 | Edits at random points: copy, waits, added and removed steps, added, removed and reconnected tracks | 5 and 18 under edits | edit restarts a finished track |
| 20 | Outages of random length; unresolved attempts and their resolution | interruption count equals the record's | retry with a new key |
| 21 | Test enrollments interleaved with leads | 21 | test counted as a lead |
| 22 | — | measures equal the record's own count | — |
| 23 | All of the above at 300 seeds | all | all |

## 9. Slicing

Each ticket implements its part of this model completely. Anything a later ticket delivers shows an honest not-yet state, never a fake.

| Ticket | Implements | Leaves as an explicit not-yet state |
| - | - | - |
| 12 Email track | The revision store and validator, limited to one email track in `main`. Lead time and `syncClock` (draft to launch). Track progress, step sends, attempts, the outbox worker, the Instantly port behind ADR 0002's fake. Ledger, priority, pacing, windows, zones, sender affinity. Statuses queued, active, replied, sequence finished no response, finished no usable channel. Bounce and block-list handling, the three blockers for email, `render_failed`, reconciliation by idempotency key. **First:** change contact-detail merging to keep a redirect (#32 item 3, ADR 0001 "Constraints"), because attempts reference detail ids. | A second track: refused by the validator with "one email track for now". Unresolved attempts are held and shown on the person page without resolution controls (those arrive in #20). Real provider proof is gated by ADR 0002's experiments; laptop-off is unverified. |
| 13 SMS beside email | Multiple tracks and start rules, together and after; skipped and failed release; the SMS port (unprovisioned and simulator); cross-channel reply stop; account problems in Needs attention. | SMS in the real app is blocked at launch by blocker 3 until a provider exists. |
| 14 Phone track | Call tracks, call capacity, placement, ready now and later today, outcomes except redial, callback and not interested; `waiting_on_call`, `interested_on_call`. | "Not interested" is not offered. Unworked tasks stay listed with no skip limit, which is still truthful because they hold only their dependents. |
| 15 Redial, callback, rollover | `skip_deadline`, rollover display, redial, callback hold (the first non-launch freeze), overdue callbacks. | Campaign pause (#17). |
| 16 Declined paths | The win-back branch in the definition, declined paths with overrides, `no_more_calls`, `in_win_back`, `declined_on_call`. | Move to win-back from replied or stopped (#17). |
| 17 Pause, resume, restart | Lead and campaign pause and resume, skip step, stop, resume next unsent, move to win-back, withdrawal requests, the paused banner. | — |
| 18 People and bulk | Bulk actions as loops of single transitions with per-lead results; `describe.ts` sentences and allowed controls. No new transitions. | — |
| 19 Running edits | Publishing revisions to a launched campaign, tombstones, edit rules (1.3), the Instantly re-push. | — |
| 20 Recovery and attention | Heartbeat, the interruption notice, `lookup` reconciliation, unresolved resolution (P3), the full Needs attention list. | Laptop-off proof stays unverified while local-only. |
| 21 Test runs | Test enrollments, 60-second timing, test contacts, window bypass, test call tasks, the "no test since last edit" warning. | No test contact is designated yet (#28), so real receipt is unverified. |
| 22 Measures | Measures read from facts: sent, failed and replies per channel from step sends and replies; calls made, connected (interested, not interested, callback requested), interested, declined and callbacks pending from call attempts and tasks; reply rate is leads replied on a channel over leads sent at least one message on it; connect rate is connected over made. | — |
| 23 Acceptance story | No engine work: the generator at full capability and the nine-step story. | Whatever the provider gates and #28 still leave unverified. |

## 10. Not decided here

- **The Instantly mechanics:** dispatch campaigns, the follow-up transport, polling and the experiments. These belong to ADR 0002, and its questions P1–P4 remain open there.
- **The SMS provider and the dialer.** Twilio is not provisioned (#28). The ports keep the engine independent of the choice.
- **Where the engine runs when hosted.** The engine is a library plus a tick loop in the server process. Hosting is deferred (#28), and "keeps sending with the laptop off" stays unverified until then.
- **The canvas library and the editor's look** (`docs/agents/ui.md`).
- **Social tracks.** The channel set is closed for the MVP. A social port later plugs in like SMS; the spec's "the step waits" while the laptop is off becomes an account-health hold.
- **The import questions in #32** (company lead versus newly reachable decision maker, equal claims). They change who is enrolled, not how an enrollment runs.
- **Tuning values:** the 15-second tick, the default gap's 8-hour day, and the settling period. These are implementation parameters with tests, not product behaviour.

## Questions for the human

Each changes one transition or one validator rule, so the answer lands in a small change.

- **Q1. Phone tracks without a telephony provider.** May phone tracks run with the user dialing from their own phone, the app showing the numbers and recording only the outcome the user logs? A phone track would then need no connected sender account. *Recommendation:* yes. The spec has the user initiate every call, and Twilio is "proposed, not mandated". Otherwise no call work can be accepted until Twilio exists.
- **Q2. Wrong number when another good number remains.** Does the call task stay open so the user can try the other number (direct, mobile or main line), or does the phone track end? *Recommendation:* stay open. The spec says phone steps are skipped "when no good number remains".
- **Q3. A track connected "after" two tracks.** May the canvas draw it? *Recommendation:* not in the MVP. Each track has one incoming connection, and every example in the spec is a chain. If wanted, it would mean "after both have finished".
- **Q4. A reply after the lead has ended.** If a lead marked "sequence finished, no response", "stopped manually" or "declined on call" replies later, does its status become "replied, automation stopped"? *Recommendation:* yes. "No response" would then be false, and the user should see the handover.
- **Q5. Test runs and sending windows.** Does a test run ignore the sending windows and send each step about a minute after the last, whatever the time of day? *Recommendation:* yes. Waits are already cut short, and the test contact is not a prospect.
- **Q6. "Skip this step" with parallel tracks.** When email and SMS are both mid-track, which step does the person page's skip act on? *Recommendation:* the one its sentence names, which is the next step due. The user skips exactly what they read.

## Consequences

- **ADR 0001:** the merge that deletes a contact-detail row must become a redirect before ticket 12 writes the first attempt. Enrollments gain the fields in 1.2, and `status` stays the one stored status column.
- **ADR 0002:** its step sends and attempts are the ones defined here. One refinement: a stop does not abandon a scheduled step send. It stays scheduled, frozen with the lead, so "resume from the next unsent step" finds it. Only win-back entry drops one. Its "frozen clocks store the remaining wait" for ticket 17 is met by lead time instead, which freezes every timer at once.
- **Every later ticket** reads this ADR before touching the engine, and changes it before changing a rule.
