# 0003. The sequence engine

- **Date:** 2026-11-13. Revised the same day after review round 1 (two reviewers, coordinator rulings 1–14).
- **Status:** Proposed. The council reviews it before ticket [12](https://github.com/Pierpaolo01/omnichannel-outreach/issues/12) starts.
- **Consumers:** tickets [12](https://github.com/Pierpaolo01/omnichannel-outreach/issues/12) to [23](https://github.com/Pierpaolo01/omnichannel-outreach/issues/23).
- **Builds on:** [ADR 0001](0001-application-foundation-and-import-model.md) (domain code never reads the clock; the closed outreach-status type; the store interface) and [ADR 0002](0002-email-through-instantly.md) (the application owns every clock; Instantly only carries email). This ADR is the "application owns every clock" half. The Instantly adapter, its experiments and its questions P1–P4 stay in ADR 0002.
- **Product source:** [the spec](https://github.com/Pierpaolo01/omnichannel-outreach/issues/10), cited by section. Everything else is a factory decision and says so.

## The rule in one paragraph

A campaign has one **definition** of tracks, steps and start rules, with stable ids and removal markers, so nothing ever loses its place. Each lead's **progress** is a set of stored facts and resolved deadlines, all in the lead's own **lead time**, a clock that advances only while nothing holds the lead. Every deadline (a step's due time, a track's delayed start, the call skip limit) is resolved once, when it is created or deliberately edited, and stored. A pause of length D therefore moves every one of them by exactly D, and nothing is recomputed afterwards. One pure function decides what happens next from the facts and the definition. Its result is applied only if the lead has not changed since it was computed. The only way to reach a provider is a **claim**: one transaction that re-checks the lead, reserves the account's capacity and its next pacing slot, and creates the step's single live attempt. An attempt only moves forward, and once the provider may have been called it is never withdrawn or repeated without a provider signal or the user's decision.

## Context

The spec's rules interact ("Define coordinated email, SMS and phone sequences", "Define the daily call list", "Define reply handoff"):

- a reply stops every track;
- a callback pauses the lead;
- an unworked call holds only the tracks after it;
- a pause freezes waits and the call skip limit;
- edits must not replay finished work;
- capacity is shared across campaigns.

Ten tickets build this behaviour in slices. The import ticket (#11) showed the cost of coding a deep rule before its invariants were written. Per `docs/agents/delivery-workflow.md` "Design first", this ADR states:

- the rule;
- its invariants;
- the input refused at the boundary;
- the guarantees held by construction;
- the generated-sequence test.

Round 1 of review found six ways the first draft could double-send, burst, call after a decline or lose a callback. Each fix is a change to a contract below, not a patch to a case. "Changes from round 1" at the end maps findings to sections.

## 1. The model

### 1.1 Campaign definition

The campaign holds **one current definition**, plus `definition_version`, a counter bumped by every published edit. There is no revision history. Attempts store the copy they rendered, and no invariant needs older definitions; the generated test keeps its own copy of each definition it published. `definition_edited_at` serves ticket 21's "no test since the last edit" warning.

The definition holds:

- **Campaign inputs:**
  - the default time zone, which is required and defaults to the user's zone when the campaign is created;
  - the call skip limit in days, default 2 (spec "Unfinished call tasks");
  - the email and SMS sender pools.
- **Tracks.** Each track has:
  - a stable `track_id`, never reused;
  - a `channel`: `email`, `sms` or `call`;
  - a `branch`: `main` or `win_back`;
  - a **window**: days of the week, each with a start and end hour in the prospect's local time. An end before the start runs past midnight. For a call track, the window is its calling hours;
  - an ordered list of steps;
  - one **start rule**;
  - a `removed` marker;
  - for a call track, its **declined path**: `stop`, `continue` or `win_back`.
- **Steps.** Each step has:
  - a stable `step_id`;
  - a wait in whole days before it (none on a track's first step);
  - its copy (none on a call step; the campaign's call script shows on the task);
  - for an email step, its threading mode: `new_subject`, or `continue_thread`, the default after the first step;
  - a `removed` marker.
- **Start rules.** Exactly one per track:
  - `entry`: the lead enters the branch. For `main` that is launch, or enrollment after launch. For `win_back` it is entering win-back;
  - `after(track_id, delay_days)`.

  The canvas draws connections, and a compiler turns them into start rules. "Together" from X to Y gives Y the same rule as X. "After" from X to Y with delay d gives Y `after(X, d)`.

A campaign has one win-back branch (CONTEXT.md). It is empty unless drawn, and every phone track whose declined path is `win_back` enters it.

### 1.2 Who progresses: subjects

Two kinds of **subject** run through the engine with identical rules:

- an **enrollment**: a lead in a campaign;
- a **test run**: ruling 10, section 3.6.

Every progress table below is keyed by `subject`. Wherever this ADR says "lead", a test run behaves the same, except where section 3.6 says otherwise.

### 1.3 Stored progress

**Subject fields** (on `enrollments`, and on `test_runs`):

| Field | Meaning |
| - | - |
| `status` | Enrollments only: the outreach status, a stored column, always equal to `deriveStatus(...)` (2.1), written in the same transaction as every change, indexed for search and measures. |
| `version` | Bumped by every write to this subject's progress, holds or clock. Every transition is applied with `WHERE version = <the version it was computed from>` (ruling 4, section 2.5). |
| `ended`, `ended_at` | Null while outreach can run; otherwise the end reason (2.1). |
| `lead_paused` | The user paused this lead. A boolean, independent of the campaign pause and the callback hold (2.3). |
| `branch`, `branch_entered_at` | `main` or `win_back`, and the lead time it was entered. |
| `no_more_calls` | Set by any declined call. Never cleared. |
| `touched` | Set once the lead has actually been reached: an attempt observed `sent`, or a call outcome logged other than "skip for now" (ruling 6). Never cleared. |
| `frozen_since`, `frozen_total` | The lead clock (3.2). |
| `email_sender`, `sms_sender` | The sender account, fixed at the subject's first claim on that channel and never reassigned (spec "Email and Instantly": "A lead keeps one sender inbox for the whole campaign"; the same for SMS is a factory choice). |

The **campaign** row adds `launched_at`, `paused_since` (null unless the campaign is paused), `version` (bumped by pause, resume and edits) and `definition_version`.

**Track progress** `track_progress(subject, track_id)` exists from the moment a track's start is resolved. It holds:

| Field | Meaning |
| - | - |
| `start_at` | The resolved start, in lead time. Set when the start rule is satisfied, or re-resolved by an edit (5.2). |
| `started_at` | Set when lead time reaches `start_at` and the track actually starts. Set once. |
| `destination_detail_id` | The good email or mobile chosen at start, for email and SMS tracks: the newest good one. |
| `next_step_id`, `basis_at`, `basis_wall`, `due_at`, `due_zone` | The pending step: which step is next; the lead time and wall time its wait counts from; its resolved due time (lead time); and the zone it was resolved in (3.3). Null while the next step is in flight or held, and after the track finishes. |
| `finished_at`, `finish_reason` | Set once, and the track stays finished. The reasons are `completed`, `skipped_missing_channel`, `skipped_declined`, `skipped_by_user`, `skipped_unworked` (the call skip limit), `failed_bad_destination` and `dropped_for_win_back`. |

**Step results** `step_results(subject, step_id)`, unique on that pair. A step's resolution is a fact: `sent`, `skipped` (with a reason) or `failed`, plus `at` in lead time. It is never deleted or changed. A step with no result and no live attempt is not done.

**Attempts** `attempts(id, subject, step_id, ...)`. Each holds:

- the `account_id`;
- the destination detail id;
- the rendered copy;
- the provider reference;
- `retryable`: whether its transport accepts a repeat call with the same idempotency key;
- `state`, a forward-only chain (section 5.3);
- the `withdraw_requested` flag.

The attempt id is its idempotency key. Two partial unique indexes allow, per `(subject, step_id)`, at most one attempt that is not terminal, and at most one attempt in state `sent`.

**Call tasks** `call_tasks(subject, step_id)`, unique, one per call step. Each holds:

- `due_at` (lead time): the call step's original due time;
- `skip_deadline` (lead time);
- `list_day`: the user-local day the task is listed for now;
- `listed_once`;
- `kind`: `call` or `callback`;
- `callback_at` (wall time);
- `open`.

**Call attempts** `call_attempts(task_id, outcome, number_detail_id, note, at)` record each logged outcome. A redial or a callback changes the same task; a step never gets a second task.

**Replies** `replies(subject, channel, at, provider_ref)`, unique on `provider_ref`, hold the channel and date only (spec "What the user sees and does").

**Capacity reservations** `capacity_ledger(account_id, reset_day, attempt_id)` follow ADR 0002 "Sender inbox and capacity", for SMS accounts too. Each sender account also stores `next_slot_at` (4.3).

**SMS bindings** `sms_bindings(sender_number, recipient_key)` name the subject that currently owns that conversation (4.5).

### 1.4 What is derived, not stored

These follow from the stored facts, so nothing keeps them in step:

- whether a step is in flight;
- whether a track is held (5.4);
- whether copy can be rendered for a lead;
- which tasks are listed today;
- the callback hold, which is the open callback task;
- the lead's next-step sentence;
- every measure.

## 2. The state machine for one lead in one campaign

### 2.1 Status and endings

The status is a total function of the stored state. Rules are checked in order and the first match wins:

| # | Condition | Status |
| - | - | - |
| 1 | `ended` set | the end reason |
| 2 | `lead_paused` | `paused` |
| 3 | an open callback task exists (the callback hold) | `callback_scheduled` |
| 4 | `branch = win_back` | `in_win_back` |
| 5 | an open call task exists (placed, whatever today's listing) | `waiting_on_call` |
| 6 | not `touched` | `queued` |
| 7 | otherwise | `active` |

These are exactly the twelve statuses of `src/domain/outreach-status.ts`. A **campaign pause changes no status**. The spec's paused banner shows "the count of leads in each status", which only makes sense if leads keep theirs. Rule 5 depends on the task existing, not on it being listed, so neither a campaign pause nor a redial to tomorrow flips the status. Rule 2 comes before rule 3: a paused lead's callback is not listed, so "paused" is what the user can act on.

**End reasons and how they happen:**

- **User or prospect events:** `replied` (a reply), `interested_on_call`, `declined_on_call` (the stop path) and `stopped_manually`. Each applies when its event is applied.
- **Exhaustion endings** (ruling 6): `finished_no_usable_channel` and `sequence_finished_no_response`. They are checked **first** in every evaluation, before any track is started, skipped or finished, and after every fact that can remove work or reach (a bounce, a bad mark, a decline, a skip, an edit):
  - **Reachable channels.** `reachable` is the set of channels in the lead's current branch that can reach the lead now (`reach.ts`, minus bad details). A decline does not remove the call channel here: it skips the remaining call tracks as `skipped_declined`. So a lead that declined with the continue path and has nothing else left finishes with no response, not as unreachable.
  - **Work left.** The lead has work left if any track that is live for the lead (5.2) is unfinished or not yet started.
  - **The rule.** When `reachable` is empty, the lead ends `finished_no_usable_channel`, whether or not work is left: nothing it has left can reach it, and anything left would only be skipped. Otherwise, when no work is left, it ends `sequence_finished_no_response`.
  - **Consequences.** A phone-only lead in an email-only campaign ends with no usable channel at launch, before its email track is marked skipped. A lead whose only email bounced on the last step ends with no usable channel. A lead that received every email but had no mobile for the final SMS track still has email reachable, so it ends with no response.
- **Precedence.** An event ending (reply, interested, declined, stop) applies whenever it occurs. An exhaustion ending is only evaluated for a lead that is not ended. A reply to a lead already ended for any reason other than `replied` or `interested_on_call` changes its status to `replied` (ruling 9): "any reply" ends outreach with a handover, and "no response" would be false.

**Restart** (spec "Restarting a lead": "for a lead that replied or was stopped") applies to `replied` and `stopped_manually` (ruling 8). Whether `interested_on_call` and `declined_on_call` may also be restarted is question Q6; until it is answered they cannot be. Restarting from step 1 is impossible: no transition deletes a step result or a finished track.

### 2.2 Clocks and holds

A subject **runs** when all of these hold:

```
runs(s) = campaign launched (or s is a running test run, 3.6)
        ∧ campaign.paused_since = null (enrollments only)
        ∧ s.ended = null
        ∧ ¬s.lead_paused
        ∧ ¬(s has an open callback task)
```

Every transaction that changes any input of `runs` ends with `syncClock` (3.2).

### 2.3 The three holds

The three holds are independent booleans (ruling 5). Each changes only on the events listed for it; every other event leaves it alone.

| Hold | Set by | Cleared by | Lists |
| - | - | - | - |
| Campaign pause (`campaign.paused_since`) | Pause campaign | Resume campaign | While set, none of the campaign's call tasks are listed and nothing is claimed. |
| Lead pause (`lead_paused`) | Pause lead (allowed during a callback) | Resume lead; a restart (resume from the next unsent step, move to win-back) | While set, none of the lead's tasks are listed, the callback included. |
| Callback hold (the open callback task) | The "callback requested" outcome | A final outcome logged on the callback task; skip step on it; its track finishing for any reason (a decline elsewhere, win-back entry, the step being removed by an edit) | While held, only the callback task of that lead is listed. "Skip for now" keeps the hold. |

The callback hold *is* the open callback task, so "hold ⇔ one open callback task" holds by construction. There is a single rule for every way a track can end: **a track that finishes closes its open call task in the same transaction**, and with it any callback hold. A stop or a reply closes nothing: the lead is ended, so nothing of it is listed, and a restart finds its tasks where they were.

### 2.4 Events and transitions

Abbreviations:

| | |
| - | - |
| R | running (`runs` true) |
| H | held by at least one hold, not ended |
| E-r | `replied` or `stopped_manually` (restartable) |
| E-x | the other endings |
| D | the campaign is not launched |

"Refused" means a plain error and no change. The UI never offers it, because the allowed-controls function and the transition function read one table. "Impossible" means no well-formed history produces the pair; the engine fails the transaction as a bug.

**Lifecycle**

| Event | Allowed in | Effect | Refused / impossible |
| - | - | - | - |
| Launch | D | The campaign is launched, every enrollment syncs its clock, and `main` is entered at lead time 0. | Every other state: impossible, a campaign launches once. |
| Enroll after launch (re-import) | (new) | A new enrollment, which runs unless the campaign is paused. Existing enrollments are untouched (spec "Re-importing"). | — |
| Evaluation (time passes) | R | 2.6. | H, E, D: lead time is frozen, so nothing can come due. A callback's wall-clock appointment still moves on the list from "later today" to "ready" or "overdue"; that is presentation. |

**Sending.** Attempt-level effects are in the attempt table, 5.3.

| Event | Allowed in | Effect | Refused / impossible |
| - | - | - | - |
| Claim | R, with the campaign running | 4.2. | Anything else: the claim's guard refuses it. |
| Attempt reaches `sent` | any but D | A `sent` step result at the current lead time; `touched` set; the next step resolved (2.6). | D: impossible. Outside R it is only an attempt claimed while running and resolved later (ADR 0002's bounded handover); invariant 2 checks exactly that. |
| Attempt reaches `rejected` | any but D | The reservation is released. Then by reason: a block-listed address skips the track; an invalid address or number marks the detail bad and fails the track; a temporary refusal leaves the step pending, and it is claimed again later with a new attempt; Instantly's unexplained skip holds the track (5.4). | D: impossible. |
| Bounce or invalid number reported after a send | any but D | The detail is marked bad (ADR 0001: bad marks are never cleared) and the track finishes `failed_bad_destination`. | D: impossible. |
| Reply detected or marked | R, H, and every ending except `replied` and `interested_on_call` | `ended = replied`, with channel and date. The lead **quiesces** (2.5). No other subject changes (spec "What stops"; for SMS, 4.5). | `replied` or `interested_on_call`: recorded on the timeline only. D: impossible, there is no thread. |

**Calls.** An outcome can be logged only on a task listed at that moment (2.3). The transaction re-checks the listing.

| Event | Allowed in | Effect |
| - | - | - |
| No answer, voicemail, gatekeeper with note; no redial | R | Task closed, track `completed`, `touched` set. |
| …with redial | R | The task stays open with `list_day` set to the user's next day. `due_at` and `skip_deadline` are unchanged ("still counts from the original due date"). `touched` set. |
| Wrong or dead number | R | The number is marked bad and `touched` set. Until Q4 is answered, the task closes and the track finishes `completed` (spec: "any other outcome… finishes the phone track"). Later phone tracks with no good number left are skipped as missing. |
| Callback requested (date and time) | R | `kind = callback`, `callback_at` set: the callback hold. The lead quiesces. `touched` set. |
| Interested | R | `ended = interested_on_call`; the lead quiesces. |
| Not interested (stop, continue or win-back, preselected from the track, overridable) | R | `no_more_calls` is set. Every open call task of the lead closes and its track finishes: this one `completed`, others `skipped_declined`. That releases any callback hold. Then by path: **stop** gives `ended = declined_on_call`, and the lead quiesces. **Continue** leaves the lead running. **Win-back** enters win-back (below). |
| Any of the above on a callback task | R (callback task listed) | As in the matching row. A redial converts it back to `kind = call` for the next day, keeping its original `due_at` and `skip_deadline`, which have not advanced while frozen. A new callback time keeps the hold. |
| Skip for now | R | The task moves to the end of today's queue. Nothing else changes: it is not a call made, and on a callback task the hold stays. |

Each call outcome above is refused unless the task is listed: H, E and D, a paused campaign, or a stale screen.

**Entering win-back** (the not-interested win-back path, or "move to win-back"):

- every unfinished main track finishes `dropped_for_win_back`, closing its call tasks, so the callback hold goes;
- live attempts of those tracks quiesce;
- `branch = win_back` at the current lead time.

**Rollover** is derived: an open task with `list_day` before today shows at the top as rolled over. **Skip-limit expiry** is part of evaluation (3.5).

**User controls** (spec "Controls" and "Restarting a lead")

| Event | Allowed in | Effect | Refused |
| - | - | - | - |
| Pause lead | R, H (callback, campaign pause), D | `lead_paused = true`; the lead quiesces. | Already lead-paused; ended. |
| Resume lead | lead-paused, not ended | `lead_paused = false`. Other holds stay. | Otherwise. |
| Pause campaign | launched, not paused | Paused; every enrollment syncs its clock in one transaction, and enrollments quiesce. No status changes. | D, already paused. |
| Resume campaign | paused | Running; clocks sync. | Otherwise. |
| Skip step | R, H, not ended | The step the person page names (Q3; until answered, the open step with the earliest due time) gets result `skipped (by_user)`. Its successor resolves from now. On a call step the task closes and the track finishes `skipped_by_user`, releasing any callback hold. | The step has a live attempt past `claimed` (it may already be with the provider); ended; D. |
| Stop | R, H, D | `ended = stopped_manually`; the lead quiesces. Progress, open tasks and resolved deadlines are kept for a restart. | Already ended. |
| Resume from the next unsent step | E-r | `ended = null`, `lead_paused = false`. The clock syncs, and every remaining wait continues as it stood at the end. An open callback task resumes the hold. Pacing spreads restarted work. | E-x (Q6), not ended. |
| Move to win-back | E-r, `branch = main`, the campaign has a win-back branch | Enter win-back (above), then `ended = null`, `lead_paused = false`. | Already in win-back; no win-back branch; others. |

**Definition and environment**

| Event | Allowed in | Effect |
| - | - | - |
| Edit published | any | Reconciliation in one transaction (5.2). Every subject of the campaign gets a version bump. Refused if the definition fails 7.1, or a launched campaign's definition has a launch blocker. |
| Contact detail marked bad elsewhere | any | Nothing is stored here. The next claim refuses that destination, the track finishes `failed_bad_destination`, and the endings are checked. |
| Account unhealthy, disconnected or out of quota | any | Nothing is stored on leads. Claims for that account wait, and Needs attention lists it. |
| Restart after an interruption | — | Section 6. |

### 2.5 Quiescing, and stale results

**Quiesce** is the one effect applied whenever a subject stops running, or a track is dropped (GPT finding 3). The triggers are:

- a reply;
- stop;
- interested;
- declined-stop;
- a callback request;
- lead pause;
- campaign pause;
- entering win-back, for the dropped tracks only.

Each live attempt in scope is handled by its state:

- **`claimed`:** becomes `withdrawn` locally. The provider was never called.
- **`handed` or `accepted`:** gets `withdraw_requested`, and the worker calls `port.withdraw`. Section 5.3 says how it resolves.

**Stale results** (ruling 4). `evaluate` and every user action compute a change from a snapshot. The store applies it only if the subject's `version` and the campaign's `version` (and `definition_version`) are unchanged. Otherwise nothing is written, and the subject is re-evaluated on fresh state. This makes these impossible:

- a skip-limit expiry computed before a callback was logged closing the callback task;
- a "sequence finished" computed before a reply overwriting `replied`.

The claim follows the same rule (4.2).

### 2.6 What evaluation does for a running subject

The pure function `evaluate(snapshot, definition, nowWall)` returns one batch of changes, in this order:

1. **Endings first** (2.1).
2. **Track starts.**
   - For each live, unstarted track whose rule is satisfied and that has no `start_at` yet: resolve `start_at` (3.3) and store it. For `entry`, that is `branch_entered_at`. For `after(P, d)`, it is P's `finished_at` plus d calendar days.
   - For each track whose `start_at` has passed: start it. If its channel cannot reach the lead (missing, bad, or a call after a decline), it starts and finishes `skipped_missing_channel` (or `skipped_declined`) at that same lead time, so its dependents count their delay from then (spec "A skipped or failed track counts as finished").
3. **Next steps.** For each started, unfinished track with no pending step and no live attempt: take the first live step after the last resolved one (5.2). If there is one, resolve its due time from the latest result (3.3). If there is none, the track finishes `completed` (or `skipped` if every step was skipped) at the latest result's lead time.
4. **Ready items.** Pending steps whose `due_at` has passed. Email and SMS go to the dispatcher (4.2). A call step is placed on the call list (4.4).
5. **Skip-limit expiry** at a day rollover (3.5).
6. **Endings again**, if anything above finished a track.

The function reads no clock and no store. The server runs it on a tick and after every event.

## 3. Time

### 3.1 One injected clock

The server holds one `Clock` (`now()`, in milliseconds). Domain code takes `now` as an argument (ADR 0001's lint rule). Tests use a manual clock and advance it themselves.

### 3.2 Lead time

```
leadNow(s, now)  = (s.frozen_since ?? now) − s.frozen_total
wallOfLead(s, now) = s.frozen_since ?? now       -- the wall instant at which lead time stood at leadNow
```

`syncClock(s, now)` ends every transaction that changes `runs(s)`. If `s` now runs and `frozen_since` is set, it adds `now − frozen_since` to `frozen_total` and clears `frozen_since`. If `s` does not run and `frozen_since` is null, it sets `frozen_since = now`. A new subject starts frozen, with `frozen_since = frozen_total = created_at`, so its lead time is 0 until it first runs.

What freezes is every hold (2.3), and an ended lead: "resume from the next unsent step… like resuming a campaign", so a restarted lead keeps its remaining waits. What does not freeze:

- a sending interruption, since the app being off is not a pause (section 6);
- an unworked call, which holds only its own track and the tracks after it (spec "Phone tracks").

The one wall-clock time a lead carries is `callback_at`. A callback is an appointment with the prospect: pauses never move it, and after a resume a callback whose time has passed shows as overdue.

### 3.3 Resolving a deadline once (ruling 2)

A wait or delay of N days counts in **calendar days in the prospect's zone**: the item becomes due at the start of the prospect's local day N days after its basis. N = 0 means due at once. Calendar days keep "two days later" on the same weekday instead of drifting a little later at every step. That is a factory reading of "waits are counted in days".

At the moment a deadline is created, with basis lead time `b`, basis wall time `w = wallOfLead(s, now)` and zone `z`:

```
span(w, N, z) = startOfLocalDay(localDate(w, z) + N days, z) − w      -- ≥ 0, DST-aware via the zone library
deadline      = b + span(w, N, z)                                       -- stored, in lead time
```

- **A step's due time:** `b` is the latest step result's lead time, or the track's start for its first step. `w` and `z` are stored alongside as `basis_wall` and `due_zone`, so the deadline can be re-resolved later by a deliberate edit.
- **A track's delayed start:** `b` is the predecessor's `finished_at`, at the wall time it finished.
- **The call skip limit** (3.5).

After that, nothing recomputes the stored deadline. A pause of length D leaves `leadNow` constant for D, so the wall instant at which `leadNow` reaches the deadline moves by exactly D. That holds for any pause, including one that ends at 01:00 after a 23:00 start, or one that crosses a daylight-saving change.

Re-resolution, from the stored basis and the new input, happens only on a deliberate edit: the wait, the delay, the skip limit, or the campaign's default zone (5.2). It does not happen when a re-import changes a person's or company's zone, because a re-import never moves progress (invariant 21). Windows always use the current zone at claim time.

### 3.4 Windows and zones

- **The prospect's zone:** the person's zone, else the company's, else the campaign default (spec "Pace, capacity and timing"). An invalid IANA name falls through to the next.
- **Claims:** a step is claimed only while its track's window is open in that zone. "A step due outside its window waits for the next window."
- **Call tracks:** the window is the calling hours, in the prospect's zone.
- **The call list's day** is the user's day, in the user's zone. That is a setting, defaulting to the machine's zone.

### 3.5 The call skip limit

Spec "Unfinished call tasks": "After a configurable number of days (default 2) an unworked call task is marked skipped". Ticket 15: "Retain the original due date for the skip-limit clock" (ruling 8).

- **The deadline.** When the call step's task is created: `skip_deadline = due_at + span(w, limit, user zone)`, where `w` is the wall instant at which the step came due. That is the start of the user's day `limit` days after the original due date, in lead time, so pauses freeze it.
- **Expiry.** A task expires only at a user-day rollover, and only if all of these hold: the lead runs; `leadNow ≥ skip_deadline`; the task is not a callback; and it was listed on the day that is ending and not worked. A task that call capacity kept off the list is never expired, so nothing is dropped for lack of capacity (spec "nothing is dropped"). It gets the whole of its first listed day.
- **On expiry:** the task closes, the track finishes `skipped_unworked`, and the tracks after it start after their delay.
- **What counts.** The limit counts calendar days. Whether it should count only days the call could be worked is question Q5.

### 3.6 Test runs (ruling 10)

A **test run** is its own record: `test_runs(id, campaign_id, render_as_enrollment_id, test_contacts, state, started_at, ended_at, ...)` plus the subject fields of 1.3. It never touches an enrollment, so it never appears on a real person's timeline. It is excluded from lead search, statuses and measures, and it cannot collide with ADR 0001's one-lead-per-campaign index.

- **Lifecycle.** `running` → `ended` (`replied`, `finished`, `stopped_by_user`). One test run per campaign at a time: Run test is refused while one is running, and the user stops it explicitly (ruling 9).
- **Before launch.** It runs whether or not the campaign is launched or paused ("before launch or after an edit", "at any time"). For a test run, `runs` ignores the campaign's launch and pause state.
- **Recipients.** The user's designated test email and mobile, as recipients only. The copy renders with the data of `render_as_enrollment_id`, a lead the user picks in the preview, named on the test run.
- **What it shares** with real leads: the definition, the engine, the ports, the real sender accounts, the capacity ledger and the pacing slots ("test sends count like any other send, with no special handling", ruling 8).
- **What differs.** Every wait and track delay resolves to 60 seconds instead of N calendar days. Whether test runs ignore sending windows is question Q2. Until it is answered, windows apply in the campaign's default zone.
- **Calls and replies.** Test call tasks go on the user's list labelled "Test"; their outcomes follow the canvas paths, win-back included, and they count against call capacity. A reply from a test contact ends the test run as `replied`. The skip limit stays in days.

## 4. Capacity, priority and pacing

### 4.1 Per account

Each email and SMS sender account has:

- a daily capacity, a positive integer, counted on its reset day: Instantly's reset zone for email (ADR 0002 S5), the user's zone for SMS;
- a pacing gap: by default its nominal sending day (8 hours unless set) divided by its capacity;
- `k`, a bound on attempts handed to the provider but not yet resolved, which is ADR 0002's in-flight bound, from 1 for email;
- `next_slot_at`.

There is no spacing between touches to the same person from different campaigns in the MVP (ruling 9).

### 4.2 The claim

One transaction:

1. Re-read the subject and campaign. Require `runs(s)`, the versions the decision was computed from, the track's window open in the prospect's zone, the account healthy, and the destination good and owned by the lead (ADR 0001's ownership rules). Copy must render: a merge field with no fallback that this lead lacks refuses the claim, which holds the track as `render_failed` (5.4) until an edit adds the fallback or the lead gains the field.
2. Choose the account: the subject's fixed sender, or, on its first claim for the channel, the pool account that can send soonest, then the one with most remaining capacity, then the lowest id. For SMS, also the binding rule (4.5).
3. Require all three of these:
   - **capacity:** `sends counted + open reservations (+ other senders, ADR 0002) < capacity`;
   - **in-flight bound:** `attempts on this account in claimed, handed or accepted < k`;
   - **pacing:** `now ≥ next_slot_at`.
4. Write the attempt (`claimed`, `retryable` from the transport), the capacity reservation, `next_slot_at = now + gap`, and the subject's version bump. Commit.

Because capacity, the in-flight bound and the pacing slot are reserved together, one tick cannot claim a burst, whether after a resume, a restart or a launch (ruling 3). A claim that is withdrawn before the provider is called keeps its slot, which errs on the side of slower.

### 4.3 Priority

Among the items an account could take at a slot: the items bound to it, and the unbound first-claim items whose pool includes it.

1. **Touched leads first**, then untouched ones ("follow-ups go before first messages to new leads"). A second track's first step is a follow-up, because the lead is not new.
2. **Oldest due first,** comparing due times as wall instants.
3. **Then subject id, then step id**, so the order is total and predictable.

Items that do not fit today wait for the next reset day and are never dropped. An untouched lead stays `queued` while it waits ("new leads show as queued until there is capacity"), and Needs attention counts "waiting for sending capacity".

### 4.4 Calls

The user has one daily call capacity, a positive integer.

- **Committed tasks** count first: open tasks already placed (rolled over, redialed to today, callbacks due today). They are always listed, whatever the capacity.
- **New tasks** are placed, by the same priority classes, while `new placed today < capacity − committed`. Placement creates the task with `due_at` set to the step's original due time and the skip deadline from 3.5.
- **The queue.** "Ready now" means inside the prospect's calling hours, ordered oldest due first. "Later today" means the calling hours open later today, or a callback is due later today (spec "Working through today's list", ticket 14).

### 4.5 SMS conversations

An SMS conversation is one thread between a sender number and a recipient mobile, whatever campaign sent into it. A reply carries only that pair, so it cannot name a campaign by itself (both reviewers). The engine stores which subject owns each pair:

- `sms_bindings(sender_number, recipient_key)`, unique, names the **owning subject**. A subject's first SMS claim to a mobile takes the binding if no other subject owns it.
- A reply on the pair is attributed to the owning subject only, so invariant 13 holds by construction.
- **Release.** When the owner ends, the binding stays with it, so a reply after the end still reaches it (ruling 9), until another subject takes the pair at its own first claim. Only then does the ownership move.
- **A running owner.** While the owner has not ended, no other subject may claim the pair. The claim tries another number in the pool. If none is free, the other subject's SMS track waits, shown in Needs attention as "this mobile is in another campaign's SMS conversation". What happens if it never frees up is question Q7.

## 5. Running edits and the provider boundary

### 5.1 Live tracks and steps

- **A track** is live for a lead if it is not removed, or the lead has started it. A track that is removed after a lead started it keeps running for that lead ("rearranging tracks applies only to leads who haven't started the affected tracks").
- **A step** is live if it is not removed.
- **The lead's next step** in a track is the first live step, in the current order, that comes after the lead's last resolved step and has no result. "An added step reaches leads still in that track": it reaches them if it is placed after where they are. A step placed (or moved) before the lead's last resolved step is behind them. Sending it would be out of order, so it is not sent. That narrows the spec's wording, and it is question Q8.

### 5.2 Reconciling an edit (ruling 7)

Publishing an edit runs one transaction over every subject of the campaign. Afterwards, for every started, unfinished track with no live attempt beyond `claimed` and no hold:

- `next_step_id` is the next step of 5.1;
- `due_at` is resolved (3.3) from the stored `basis_at`, `basis_wall` and that step's current wait.

The stored step and the rule always agree (invariant 22).

| Edit | Reconciliation |
| - | - |
| Insert a step | If it lands between the last resolved step and the pending one, it becomes the pending step, and its due time is resolved from the same basis with its own wait. If it lands later, nothing changes now. If it lands behind the lead, see Q8. |
| Remove a step | If it is pending (no attempt, or only `claimed`, which is withdrawn), the next live step becomes pending from the same basis. If none is left, the track finishes `completed` at the current lead time. If it is in flight or `unresolved`, it resolves normally, because it may have reached the provider. Then the next step follows. |
| Reorder steps | The pending step is recomputed by 5.1. Steps moved behind the lead are not sent (Q8). |
| Change a wait | If the step is pending, its due time is re-resolved from its basis. |
| Change copy | Nothing stored: the copy renders at claim. Attempts already handed over keep their copy (ADR 0002). |
| Add a missing fallback | Nothing stored: the render check runs at claim, so tracks held `render_failed` claim again. |
| Add a track or change connections | Unstarted tracks: any stored `start_at` is discarded, and the start rule is re-applied by the next evaluation, resolving from the predecessor's stored `finished_at`. Started tracks: unchanged. |
| Remove a track | Started: unchanged. Unstarted: its `start_at` is discarded. 7.1 refuses a definition whose live rules name a removed track, so its dependents must be reconnected in the same edit. |
| Change a track's window | Nothing stored: windows apply at claim. |
| Change the declined path | Nothing stored: it is read when an outcome is logged, and preselected on the screen. |
| Change the skip limit | The `skip_deadline` of every open task is re-resolved from its `due_at`. |
| Change the campaign's default zone | Pending due times and stored `start_at`s of subjects using the default zone are re-resolved from their basis. |
| Remove a sender account from a pool | Subjects already fixed to it keep it ("one sender inbox for the whole campaign"). New subjects choose from the new pool. If the removed account is disconnected, its subjects' work waits in Needs attention. |
| Change capacity, gap or `k` | Nothing stored: they apply at the next claim. |

### 5.3 Ports and the attempt contract (ruling 1)

Each sending channel has one port:

```
interface SendPort {
  readonly retryable: boolean            // a repeat call with the same key cannot send twice
  handover(a: { attemptId, sender, destination, rendered, threadRef? }):
    Promise<{ kind: "accepted", providerRef } | { kind: "rejected", reason, final: true } | { kind: "unknown" }>
  withdraw(a): Promise<"withdrawn" | "too-late" | "unknown">     // "withdrawn" only on a positive provider signal
  observe(since): Promise<ProviderEvent[]>   // sent, delivered, failed, bounced, reply, unsubscribed, rejected
  lookup(attemptId): Promise<"sent" | "not-sent" | "unknown">
}
```

**Email** is ADR 0002's Instantly adapter. The `/leads/add` opener is `retryable: true`, with the attempt id as its idempotency key. The reply and forward follow-up transports have no key, so they are `retryable: false`. `withdraw` returns `unknown` until ADR 0002's X5 adopts a signal.

**SMS:** no provider is provisioned (#28).

- The running app registers an `UnprovisionedSmsPort` with no sender accounts. An SMS track therefore always meets launch blocker 3, which is honest by construction.
- Tests and ticket 13's demonstration use a simulator port, whose accounts read "Simulated SMS (not a provider)" on every screen. It is registered only against the development data directory (ADR 0001).

**Calls** have no port (ruling 9). The user dials on their own phone, and a call counts as made only when the user logs an outcome. That refuses, by construction, to "pretend a call happened when it did not". A phone track needs no connected sender account.

**The attempt state chain** runs `claimed` → `handed` → `accepted` → terminal (`sent`, `rejected`, `withdrawn`). `withdraw_requested` is a flag that only goes from false to true. Every event below only moves forward. A repeated event, or one that would move backwards, is ignored and logged. Results may arrive late, twice or out of order.

| Event \ state | `claimed` | `handed` | `accepted` | terminal |
| - | - | - | - | - |
| Worker begins the call (5.5) | → `handed`, written and committed **before** the call | ignore | ignore | ignore |
| Pre-call re-check fails | → `withdrawn` (the provider was never called) | not possible: the re-check runs only on `claimed` | — | — |
| Handover returns `accepted` | impossible | → `accepted`, with its reference | ignore (duplicate) | ignore |
| Handover returns `rejected` (final) | impossible | → `rejected` | → `rejected` only on a provider signal that it will not send (Instantly skipped the lead, P4) | ignore |
| Handover returns `unknown`, times out, or the response is lost | impossible | stays `handed` | stays `accepted` | ignore |
| Sent observed | impossible: no reference to match | → `sent` | → `sent` | `sent`: ignore. `rejected` or `withdrawn`: recorded as a provider anomaly in Needs attention, never as a second send of the step |
| Quiesce | → `withdrawn` | set `withdraw_requested`, call `withdraw` | set `withdraw_requested`, call `withdraw` | ignore |
| `withdraw` returns `withdrawn` (positive signal) | — | → `withdrawn` | → `withdrawn` | ignore |
| `withdraw` returns `too-late` or `unknown` | — | unchanged, still waiting for observation | unchanged | ignore |
| Retry after no result | — | only if `retryable` and the subject runs: call again with the **same** key | — | — |
| Settling period passes without a result | — | **unresolved** (5.4) if not `retryable`, or the subject does not run | same | — |
| User: "mark sent" or "mark not sent" (ADR 0002 P3) | — | unresolved only: → `sent` or `withdrawn` | unresolved only: same | ignore |

The step's state is derived from its attempts: sent if one is `sent`; in flight if one is not terminal; otherwise pending. **Withdrawn without a provider signal happens only from `claimed`.** An attempt that may have reached the provider is never withdrawn by the app, never repeated without its key, and never repeated while its subject is not running.

### 5.4 Held tracks

A track is **held** when the engine cannot proceed without guessing or without the user. This is derived, not stored. A held track stops only itself and the tracks after it; other tracks and the lead's status are unchanged. Each hold shows in Needs attention with its reason:

- **`unresolved`:** an attempt in `handed` or `accepted` past the settling period that may not be retried (5.3). The user resolves it.
- **`render_failed`:** the claim cannot render the copy (4.2).
- **`provider_skipped`:** Instantly skipped the lead for no reason the API exposes (ADR 0002 P4): an attempt `rejected` with that reason, until the user skips the step or resumes it.

Account-level problems (disconnected, stale inbox, quota exhausted) hold no track. Claims for that account wait, and Needs attention lists the account.

### 5.5 The worker

The outbox runs in this order:

1. **Claim** (4.2) and commit.
2. **Re-check** in a fresh read: the subject still runs, the window is open, the account is healthy, and, for email, ADR 0002's pre-send reply check passes. If any fails while the attempt is still `claimed`, it becomes `withdrawn`, the reservation is released, and the step stays pending.
3. **Mark `handed`** and commit.
4. **Call** the provider, outside any transaction.
5. **Apply the result** through the table in 5.3.
6. **Apply observations** (sent, bounce, reply) through the same table. Each is matched by provider reference or thread (ADR 0002 "Recovery") and is idempotent by provider id.

## 6. Restart and the interruption notice

On start, before the first evaluation:

1. **Observe.** Apply provider events since the last checkpoint, with ADR 0002's overlap.
2. **Settle open attempts:**
   - `claimed`: run the re-check from 5.5 step 2, then continue the outbox;
   - `handed` or `accepted` and `retryable`, with a running subject: call again with the same key;
   - otherwise: `lookup`. A "sent" or "not-sent" answer resolves the attempt; "unknown" leaves it waiting for observation, then unresolved.
3. **Evaluate,** which releases overdue work through pacing, the in-flight bound and capacity.
4. **The interruption notice** (ruling 13).
   - **Detect.** An interruption happened if the last tick before stopping (`engine_heartbeat`, written each tick) is older than twice the tick interval.
   - **Count.** The recovery pass counts the sends it actually reschedules: email and SMS items that were due before restart, belonged to running subjects, and are claimed after restart.
   - **Write.** When that work has drained, or at the end of the day, the line "sending was interrupted from X to Y; N sends rescheduled" is written. Only the latest notice is kept (spec: "no history or audit log beyond that").

Nothing is sent twice: a step has at most one live attempt; a retry reuses its key and only on a retryable transport; and anything that cannot be settled is held. Nothing is skipped: a pending step stays pending until it is claimed, skipped by a rule or the user, or held with a reason. Both promises stay unverified against the real provider until ADR 0002's X5 and X6 pass. X5 must also show that an Instantly idempotency key is still honoured after an outage of days. Laptop-independent sending is unverified while operation is local-only (#28).

## 7. Input refused at the boundary

### 7.1 Definitions that cannot be saved

The canvas cannot produce these, and the server refuses them with a plain message. None is a launch condition; such a definition never exists.

- A cycle in start rules, after "together" is resolved.
- A start rule that names a missing or removed track, or a track in the other branch.
- A track with more than one start rule. That includes a track connected "after" two tracks (Q1).
- A call track with more than one step (spec: a phone track is "one call with no follow-ups").
- A call track in the win-back branch (spec: "no cold call").
- A declined path of `win_back` when the win-back branch has no live track.
- A wait on a first step. A negative or fractional wait or delay.
- A `continue_thread` step as the first email step: there is no thread to continue.
- A window with no days, or with equal start and end.
- A zone that is not an IANA name.
- A capacity, gap or `k` that is not a positive number.
- An edit that changes a track's channel or moves a step to another track. Remove it and add a new one, so that ids keep one meaning.

### 7.2 Exactly three launch blockers

These block launch, and they block publishing an edit to a launched campaign ("retain the same three blockers", ticket 19). Everything else is a warning, including "no test run since the last edit" (ticket 21).

1. **Empty copy.** A live email or SMS step in either branch has an empty body, or an empty subject on a `new_subject` step. **A campaign with no live main-branch track has no copy at all, and is reported here** as "the campaign has no message to send" (ruling 8). Call steps have no copy; an empty call script is a warning.
2. **A merge field with no fallback that some lead lacks.** Checked against every enrollment of the campaign that has not ended. For a lead enrolled later, the claim makes the same check (4.2).
3. **A track whose channel has no connected sender account.**
   - An email track needs at least one healthy inbox in its pool.
   - An SMS track needs at least one connected SMS sender, so SMS is blocked until a provider exists.
   - A phone track needs none, because the user dials.

## 8. Invariants

The generated test asserts every one of these after every event.

1. **One status.** Every enrollment has exactly one outreach status, and the stored column equals `deriveStatus` of the stored state.
2. **Nothing reaches a provider for a subject that does not run.**
   - No attempt is claimed, and no attempt moves from `claimed` to `handed`, unless `runs(s)` held in that same transaction. Retries obey the same rule.
   - **Checked against the fake providers' delivery logs:** every delivery happened at a moment when its subject ran, or comes from an attempt handed over while it ran, bounded by `k` per account.
3. **At most one live attempt and one `sent` attempt per step**, by unique index.
4. **Sent at most once, checked against the fake providers' delivery logs.** Each `(subject, step)` is delivered at most once, across resumes, win-back, edits, crashes, lost responses and quiesces. This is not checked against the application's own records.
5. **Attempts only move forward.** No attempt leaves a terminal state. `withdraw_requested` never clears. `withdrawn` without a provider signal happens only from `claimed`. No attempt with `retryable = false` is called twice.
6. **A finished track never restarts.** Once `finished_at` is set, there are no new results, attempts or tasks for it, and `started_at` is written once.
7. **Starts follow their rule.** A track starts at its stored `start_at`, which was resolved from the rule in force when it was resolved. For `after(P, d)` that is d calendar days after P's `finished_at` (3.3). Tracks with the same rule and the same resolution start at the same lead time.
8. **Steps go in order and on time.** Steps are resolved in the order of 5.1. No claim happens before its stored `due_at`.
9. **Clocks freeze exactly.**
   - `frozen_since` is set exactly when `runs(s)` is false, and `leadNow` is then constant.
   - Stored deadlines change only through their creation and the edits in 5.2.
   - The wall instant at which a lead reaches any deadline moves by exactly the total frozen time.
10. **Capacity.** For every account and reset day, counted sends plus open reservations never exceed capacity.
11. **In-flight bound and pacing.** An account never has more than `k` attempts in `claimed`, `handed` or `accepted`. Two claims on one account are never closer together than its gap. This holds for test runs too.
12. **Priority.** When a slot is claimed, no item eligible for that account at that moment had a higher priority (4.3).
13. **Windows.** Every claim happens inside its track's window in the prospect's zone. Every task listed as "ready now" is inside calling hours.
14. **Campaign-local replies.** A reply changes only the subject that owns the thread or the SMS binding. Other campaigns, colleagues and company leads are unchanged. Each SMS binding has exactly one owner.
15. **No call after a decline.** After any declined outcome, the enrollment has no open call task, and none is ever created again. Win-back never has a call task.
16. **Call tasks.** These hold:
    - an open task's track is unfinished;
    - a subject has at most one open callback task, and while it is open the subject does not run;
    - every call attempt was logged on a task listed at that moment;
    - a callback task is never expired by the skip limit;
    - redials and rollovers never change `due_at` or `skip_deadline`;
    - "skip for now" never adds to calls made;
    - a task that was never listed is never expired.
17. **Call capacity.** New tasks listed per user day never exceed capacity minus committed tasks, and committed tasks are never removed for lack of room.
18. **Nothing is dropped.** After enough time and capacity, every subject is ended, holds, or has each unfinished track held with a reason or waiting on an open call task.
19. **Good destinations only.** A claim names a detail that is good at the time of the claim and belongs to the lead under ADR 0001's ownership rules.
20. **Correct endings.**
    - `sequence_finished_no_response` only when no live track is unfinished or unstarted, a channel is still reachable, and no reply or interested call was recorded since the lead last started or restarted.
    - `finished_no_usable_channel` only when no channel of the branch reaches the lead.
21. **Re-import never moves progress.** An import changes no existing subject's progress, status, deadlines or clock.
22. **The pending step agrees with the rule.** For every started, unfinished, unheld track with no live attempt beyond `claimed`, `next_step_id` is the step 5.1 names under the current definition.
23. **Allowed controls match transitions.** Every control offered for a status is accepted, and every control not offered is refused.
24. **Stale changes are never applied.** A change computed from a version that is no longer current writes nothing.
25. **Tests stay out of lead counts.** Test runs appear in no lead search, status count or measure. Their sends do count in the ledger and in pacing.

## 9. Test strategy

### 9.1 Seams

- **`src/domain/sequence/`, pure:**
  - `definition.ts`: types, the canvas compiler and the 7.1 validator;
  - `blockers.ts`;
  - `clock.ts`: lead time, `syncClock`, `span`, windows;
  - `attempt.ts`: the 5.3 table;
  - `progress.ts`: `evaluate`, the transitions, `deriveStatus`, the allowed controls;
  - `reconcile.ts`: 5.2;
  - `dispatch.ts`: eligibility, priority and the claim's checks;
  - `describe.ts`: the next-step sentence.
- **`src/server/engine/`:** the tick, the claim and result transactions with version guards, the outbox worker, the ports, restart.

Example tests cover every transition row and every row of the attempt table. The generated test covers the interleavings that examples miss.

### 9.2 The generated-sequence test

It runs from `src/server/sequence-runs.test.ts`, with the generator and record in `test/support/generated-sequences.ts`. It goes through the real SQLite store and a fake provider per channel, and each fake keeps a **delivery log** of what it would actually have sent. It follows the pattern of `src/server/import-sequences.test.ts`.

1. **Generate definitions.** One to three campaigns that share sender accounts. Each is a tree of tracks with random channels, steps, waits, delays, windows (including overnight ones) and declined paths, all within 7.1; refused definitions get their own example tests. Leads with varied reach and zones, including zones with daylight-saving changes in the test period.
2. **Generate events** (ruling 14), interleaving:
   - clock advances from seconds to weeks, including partial-day pauses across both daylight-saving changes;
   - **nested holds**: a campaign pause inside a lead pause inside a callback, released in every order;
   - **edits while held**, and edits during in-flight attempts;
   - provider results that are lost, late, **duplicated or out of order** (sent before accepted, accepted after withdraw);
   - **crashes on a non-retryable transport** between `handed` and the result;
   - **a user action between evaluate and apply**;
   - replies during in-flight attempts and after endings;
   - one person in two campaigns sharing one SMS number;
   - call outcomes chosen from what is listed;
   - user controls, including ones that should be refused;
   - re-imports and test runs.
3. **Keep an independent record.** A reference model in the test support directory imports nothing from `src/domain/sequence/`. It is written from the spec's words, keeping wall time and an explicit list of frozen intervals per subject. From those it predicts each step's **due instant** (using its own calendar-day arithmetic over active time), its **window**, which tracks start and finish, and each lead's status. Capacity, pacing and priority are checked as invariants on the dispatch log, which follows ADR 0001's split.
4. **Assert after every event:** invariants 1–25. Each subject's due instants, step order, finished tracks, open tasks and status must equal the record's. In an unlimited-capacity variant of each seed, the earliest instant inside the window at or after each predicted due instant must equal the claim instant, up to the pacing gap.
5. **Prove the test bites.** `src/server/sequence-runs-oracle.test.ts` swaps in deliberately broken engines, and the generated runs must fail on each:
   - withdrawing a `handed` attempt;
   - retrying a non-retryable transport;
   - recomputing due times from the current `frozen_total`;
   - a claim that ignores the slot or `k`;
   - applying stale versions;
   - a track that finishes without closing its call task;
   - an SMS reply going to the newest binding;
   - an ending check placed after the track starts;
   - counting "touched" at claim time.

A failure the generator finds is shrunk into a named example test. Each run uses 100 seeds, ten to a chunk.

### 9.3 What the generator must produce by the end of each ticket

| Ticket | Generator adds | Invariants first asserted | Mutations added |
| - | - | - | - |
| 12 | One email track of 1–5 steps; waits and windows; leads with and without email, in zones with daylight-saving changes; 1–3 inboxes across 1–2 campaigns; every provider result order; quiesce on reply; crashes at every outbox stage, on both a retryable and a non-retryable transport; user events between evaluate and apply; re-imports; launch | 1–5, 8–13, 18–21, 24 | withdraw `handed`, retry non-retryable, stale apply, burst, capacity off by one, priority, window, touched at claim |
| 13 | Trees of email and SMS tracks; missing and failing channels; cross-channel replies; one person in two campaigns on one SMS number | 6, 7, 14 | SMS reply to the newest campaign, ending check too late |
| 14 | Call tracks, call capacity, outcomes without redial or callback | 16 (partial), 17 | outcome on an unlisted task |
| 15 | Redial, rollover, skip limit, callbacks including overdue, nested holds with callbacks | 9 with callbacks, 16 | redial resets the deadline, callback expires, a task never listed expires |
| 16 | Declined paths with overrides, win-back branches; works without 15's events | 15 | open task survives a decline |
| 17 | Lead and campaign pause, skip, stop, restart, move to win-back, nested holds in every order | 2, 9 and 23 in full | due recomputed from the current total |
| 18 | Bulk sequences across campaigns | 23 across campaigns | — |
| 19 | Every edit kind of 5.2, at random points, including while held | 22, plus 6 and 8 under edits | edit leaves a stale pending step |
| 20 | Outages of random length; unresolved attempts and their resolution | the notice count equals the record's | count due-in-gap instead of rescheduled |
| 21 | Test runs before and after launch, interleaved with leads | 25 | test exempt from pacing |
| 22 | — | measures equal the record's own counts | skip-for-now counted as a call |
| 23 | Everything, at 300 seeds | all | all |

## 10. Slicing

Each ticket implements its part completely. A later ticket's area shows an honest not-yet state, never a fake one. Ticket 12 lands as **three pull requests, in order** (ruling 12).

| Ticket | Implements | Leaves as an explicit not-yet state |
| - | - | - |
| 12a Detail redirect | Merging a contact detail keeps the merged row, pointing at its target (#32 item 3; ADR 0001 "Constraints"), before any attempt references a detail id. | — |
| 12b Engine core | Definition and validator, limited to one email track in `main`. Lead time, `syncClock` and deadline resolution. Track progress, step results and attempts with the full 5.3 table, the version guard, the claim with capacity, slot and `k`. The outbox worker with **withdrawal and quiesce**, the reply stop, endings. Statuses queued, active, replied, sequence finished no response and finished no usable channel. Blockers for email. Restart settlement. All against a fake email port. | A second track is refused with "one email track for now". Unresolved attempts are held and shown, but their resolution controls arrive in #20. |
| 12c Instantly and UI | The ADR 0002 adapter behind the port, the editor, preview, launch, and the timeline. | Real provider proof is gated by ADR 0002's experiments. Laptop-off is unverified. |
| 13 SMS beside email | Multiple tracks with together and after; release on skip and failure; the SMS port (unprovisioned and simulator) and bindings; the cross-channel reply stop; account problems in Needs attention. | In the real app, SMS is blocked by blocker 3 until a provider exists. |
| 14 Phone track | Call tracks, placement and capacity, ready now and later today, outcomes without redial, callback or not interested; `waiting_on_call`, `interested_on_call`; the rule that a finishing track closes its task. | "Not interested" is not offered. Unworked tasks stay listed with no skip limit. That is still truthful: they hold only their dependents. |
| 15 Redial, callback, rollover | `skip_deadline` and its expiry rule, rollover, redial, the callback hold, overdue callbacks. | Campaign pause (#17). |
| 16 Declined paths | The win-back branch, declined paths with overrides, `no_more_calls`, closing tasks on a decline, entering win-back, `in_win_back`, `declined_on_call`. It depends only on #14: tasks closing on a decline releases a callback hold whenever #15 is present, with no code of #15's needed. | Moving a stopped or replied lead to win-back (#17). |
| 17 Pause, resume, restart | Lead and campaign holds, skip, stop, restart, move to win-back, the paused banner, **`describe.ts` and the allowed controls** (ruling 12). | — |
| 18 People and bulk | Bulk actions as loops of single transitions with per-lead results, reusing #17's controls and sentences. | — |
| 19 Running edits | Publishing edits to a launched campaign and the 5.2 reconciliation; the Instantly re-push. | — |
| 20 Recovery and attention | The heartbeat, the notice, `lookup`, unresolved resolution (P3), the full Needs attention list. | Laptop-off proof stays unverified while local-only. |
| 21 Test runs | The `test_runs` lifecycle, 60-second deadlines, test contacts, test call tasks, the "no test since last edit" warning. | No test contact is designated yet (#28), so real receipt is unverified. |
| 22 Measures | Read from facts. Per channel: sent, failed or bounced, and replies. Calls made, meaning logged outcomes other than skip for now. Connected: interested, not interested and callback requested. Interested, declined, callbacks pending. Reply rate is leads replied on a channel over leads sent at least one message on it; connect rate is connected over made. | — |
| 23 Acceptance story | The generator at full capability, and the nine-step story. | Whatever the provider gates and #28 leave unverified. |

## 11. Not decided here

- **The Instantly mechanics**, the experiments and P1–P4. ADR 0002 owns them.
- **The SMS provider.** Twilio is not provisioned (#28). The port keeps the engine independent of it.
- **Hosting.** The engine is a library plus a tick in the server process. "Keeps sending with the laptop off" stays unverified until hosting arrives.
- **The canvas library and the editor's look** (`docs/agents/ui.md`).
- **Social tracks.** A social port would plug in like SMS, and "the step waits while the laptop is off" becomes an account-health wait.
- **The import questions in #32.** They change who is enrolled, not how an enrollment runs.
- **Tuning values:** the tick interval, the default gap's 8-hour day, `k` beyond ADR 0002's X1, and the settling period. These are parameters with tests, not product behaviour.

## Questions for the human

Settled by the spec or by the coordinator's rulings, so no longer asked:

- phone tracks dial on the user's own phone;
- a reply after an ending sets "replied";
- no spacing between touches from different campaigns;
- one test run per campaign at a time, with an explicit stop.

Each question below changes one rule, and each lists what is built until it is answered.

- **Q1. A track connected "after" two tracks.** *Recommendation:* not in the MVP. One incoming connection per track; every example in the spec is a chain. If wanted, it would mean "after both have finished". *Built:* refused (7.1).
- **Q2. Test runs and sending windows.** Should a test send each step about a minute after the last, whatever the time of day? *Recommendation:* yes. The test contact is not a prospect, and a test started at 19:00 would otherwise wait until morning. *Built:* windows apply in the campaign's default zone.
- **Q3. "Skip this step" with parallel tracks.** Which step is skipped when email and SMS are both mid-track? *Recommendation:* the one the person page's sentence names, which is the next step due. *Built:* that.
- **Q4. A wrong number when another good number remains.** The spec says both "any other outcome… finishes the phone track" and "phone steps are skipped when no good number remains". *Recommendation:* keep the task open so the user can dial the other number. *Built:* the track finishes.
- **Q5. Which days the call skip limit counts.** With the default of 2, a call due on Friday with Monday–Friday calling hours expires over the weekend. *Recommendation:* count only days on which the prospect's calling hours open. *Built:* calendar days, which is the spec's literal text.
- **Q6. Restarting a lead that was interested or declined on a call.** The spec offers restart "for a lead that replied or was stopped". *Recommendation:* allow both, since both are "automation stopped" and the user is in charge. A declined lead is still never called again. *Built:* not allowed.
- **Q7. One person texted from the same number by two campaigns.** An SMS thread is one conversation, so "a reply stops only that campaign" can only mean the campaign that owns the conversation. *Recommendation:* the campaign that texted first owns the conversation. If no other sender number is free, the second campaign's SMS track is skipped, with the reason "already in an SMS conversation from this number in campaign X", as with a missing channel, so the lead is not stalled. *Built:* the track waits and is listed in Needs attention (4.5). Waiting drops nothing, but it can hold the tracks after it indefinitely.
- **Q8. An added step, or a step moved, behind a lead's position.** "An added step reaches leads still in that track". For a lead past that point, sending it would be out of order. *Recommendation:* such a step is not sent to that lead; it is sent to every lead in the track who has not yet passed its position. *Built:* that.

## Changes from round 1

| Finding | Resolved in |
| - | - |
| Opus 1, GPT 1, GPT 4: an uncertain handover withdrawn or retried; non-monotone results | The 5.3 table, `retryable`, `claimed` vs `handed`; invariants 4–5, checked on the delivery log. |
| Opus 2, GPT 3: burst; no in-flight bound; withdrawal on every stop | 4.2 slot, `k` and capacity in one transaction; quiesce (2.5); invariant 11. |
| Opus 3, GPT 2: calendar rounding against frozen clocks | 3.3, deadlines resolved once; invariant 9. |
| Opus 4, GPT 8: SMS reply attribution | 4.5 bindings; invariant 14; Q7. |
| Opus 5: stale evaluation results | 2.5 version guard; invariant 24. |
| Opus 6, GPT 5, GPT 6: call tasks and callback holds after declines, win-back and outcomes | 2.3 one closing rule; the callback hold is the open callback task; invariants 15–16. |
| GPT 7, Opus 11: edits and pending steps | 5.1–5.2 reconciliation for every edit kind; invariant 22; Q8. |
| GPT 9, Opus 12: test runs | 3.6 separate `test_runs` lifecycle, ordinary capacity and pacing; Q2. |
| GPT 10: ending precedence | 2.1, endings checked first. |
| GPT 11: touched at claim | `touched` set only on an actual send or logged call. |
| GPT 12, Opus 13: test plan | 9.2–9.3. |
| GPT 13, Opus 12: slicing | 10: 12a–c, controls in 17, 16 independent of 15. |
| GPT 14, Opus 8–9: questions and product calls | Fourth gate removed (7.2); questions revised. |
| GPT 15: interruption count and calls made | 6 counts actual reschedules; skip for now is not a call (invariant 16). |
| Opus 10: status of a paused campaign's calls | 2.1 rule 5 depends on the task existing. |
| Opus 14, GPT 16: simplify | Revision history, `in_flight` and step states, hosted locking and the 365-day and overnight limits removed. |

**Not adopted as proposed:** Opus 7 (drop the wrong-number question). The reviewers read the spec in opposite ways, so it stays a question (Q4). The built default follows the spec's explicit "any other outcome… finishes the phone track".

## Consequences

- **ADR 0001.** The merge that deletes a contact-detail row becomes a redirect in 12a. Enrollments gain the fields in 1.3. `status` stays the one stored status column.
- **ADR 0002.** Its attempt states are refined here: `adding` splits into `claimed` and `handed`, `added` becomes `accepted`, `withdraw-requested` becomes a flag, and `unresolved` is a derived hold. A stop does not abandon a pending step, so a resume finds it. Its frozen clocks for ticket 17 are met by lead time and stored deadlines. X5 adds the check that an idempotency key is still honoured after a long outage.
- **Every later ticket** reads this ADR before touching the engine, and changes it before changing a rule.
