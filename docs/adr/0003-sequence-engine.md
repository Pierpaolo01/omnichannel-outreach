# 0003. The sequence engine

- **Date:** 2026-11-13. Revised the same day after review rounds 1, 2 and 3 (two reviewers each; coordinator rulings 1–14, 1–10 and items 1–7).
- **Status:** Proposed. The council reviews it before ticket [12](https://github.com/Pierpaolo01/omnichannel-outreach/issues/12) starts.
- **Consumers:** tickets [12](https://github.com/Pierpaolo01/omnichannel-outreach/issues/12) to [23](https://github.com/Pierpaolo01/omnichannel-outreach/issues/23).
- **Builds on:** [ADR 0001](0001-application-foundation-and-import-model.md) (domain code never reads the clock; the closed outreach-status type; the store interface) and [ADR 0002](0002-email-through-instantly.md) (the application owns every clock; Instantly only carries email). This ADR is the "application owns every clock" half. The Instantly adapter, its experiments and its questions P1–P4 stay in ADR 0002.
- **Product source:** [the spec](https://github.com/Pierpaolo01/omnichannel-outreach/issues/10), cited by section. Everything else is a factory decision and says so.

## The rule in one paragraph

A campaign has one **definition** of tracks, steps and start rules, with stable ids and removal markers, so nothing ever loses its place. Each lead's **progress** is a set of stored facts and resolved deadlines, all in the lead's own **lead time**, a clock that advances only while nothing holds the lead. Every deadline (a step's due time, a track's delayed start, the call skip limit) is resolved once, when it is created or deliberately edited, and stored. A pause of length D therefore moves every one of them by exactly D, and nothing is recomputed afterwards. One pure function decides what happens next from the facts and the definition. Its result is applied only if the lead has not changed since it was computed. The only way to reach a provider is a **claim** followed by a **handover**. The claim is one transaction that reserves the account's capacity and an in-flight place, and creates the step's single live attempt. The handover is a second conditional transaction that re-checks everything against current state, renders the copy and takes the account's next pacing slot; the provider is called only if it commits. An attempt only moves forward and leaves every waiting state in bounded time. Once the provider may have been called, the attempt is never withdrawn or repeated without a provider signal or the user's decision.

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
| `email_sender`, `sms_sender` | The sender account, fixed when the subject's first attempt on that channel is **handed over** (5.5), and never reassigned (spec "Email and Instantly": "A lead keeps one sender inbox for the whole campaign"; the same for SMS is a factory choice). A claim that is withdrawn before its handover fixes nothing. |

The **campaign** row adds `launched_at`, `paused_since` (null unless the campaign is paused), `version` (bumped by pause, resume and edits) and `definition_version`.

**Track progress** `track_progress(subject, track_id)` exists from the moment a track's start is resolved. It holds:

| Field | Meaning |
| - | - |
| `start_at`, `start_basis_at`, `start_basis_wall`, `start_zone` | The resolved start, in lead time, and what it was resolved from: the predecessor's finish, in lead time and wall time, and the zone. Set when the start rule is satisfied, or re-resolved by an edit (5.2). |
| `started_at` | Set when lead time reaches `start_at` and the track actually starts. Set once. |
| `destination_detail_id` | The good email or mobile chosen at start, for email and SMS tracks: the newest good one. |
| `next_step_id`, `basis_at`, `basis_wall`, `due_at`, `due_wall`, `due_zone` | The **pending step** (ruling 5): which step is next; the lead time and wall time its wait counts from; its resolved due time in lead time; the wall instant it was resolved to; and the zone. These fields belong to the pending step, not to any attempt. They stay unchanged while the step is claimed, in flight or held, so a withdrawal leaves the same deadline in place. They change only when the step gets a result (the next step is then resolved) or when an edit reconciles it (5.2). |
| `finished_at`, `finished_wall`, `finish_reason` | Set once, and the track stays finished. The reasons are `completed`, `skipped` (every step skipped), `skipped_missing_channel`, `skipped_declined`, `skipped_by_user`, `skipped_unworked` (the call skip limit), `failed_bad_destination`, `dropped_for_win_back` and `closed_on_interest`. |

**Step results** `step_results(subject, step_id)`, unique on that pair. A step's resolution is a fact: `sent`, `skipped` (with a reason) or `failed`, plus `at` (lead time) and `at_wall`. It is never deleted or changed. A step with no result and no live attempt is not done. A result for an attempt that was live when its track finished is still recorded. It changes neither the finish reason nor any successor work (ruling 7).

**Attempts** `attempts(id, subject, step_id, ...)`. Each holds:

- the `account_id` reserved at the claim;
- the destination detail id;
- the copy, rendered in the first handover transaction (5.5) and never changed afterwards;
- the provider reference;
- `retryable`: whether its transport accepts a repeat call with the same idempotency key;
- `idempotency_key`: the attempt id, except where 5.3 makes a later attempt inherit an earlier one's key;
- `calls`: the number of send calls made with this attempt, never more than `MAX_CALLS` (5.6);
- `claimed_wall`, `handed_at`, `handed_wall`, `last_call_wall`;
- `presend_checked_wall`;
- `lookup_state`: the latest `lookup` answer, and the number of `queued` answers so far;
- `unresolved_since`: set once the attempt is unresolved (5.3); a stored fact, not derived;
- `ended_by`: how a terminal state was reached;
- `state`, a forward-only chain (section 5.3);
- the `withdraw_requested` flag.

Two partial unique indexes allow, per `(subject, step_id)`, at most one attempt that is not terminal, and at most one attempt in state `sent`.

**Freezes** `freezes(subject, from_wall, to_wall)` is an append-only record of the subject's frozen intervals. `syncClock` opens an interval when the subject stops running and closes it when the subject runs again, so `to_wall` is null while it is frozen. Intervals that ended before the `handed_wall` of the subject's oldest unsettled attempt may be pruned. It exists to map a provider's past send time exactly onto the lead's clock (3.3).

**Call tasks** `call_tasks(subject, step_id)`, unique, one per call step. Each holds:

- `due_at` (lead time), `due_wall` and `due_zone`: the call step's original due time, with the wall instant and zone it was resolved from;
- `skip_deadline` (lead time), resolved from `due_wall` (3.5);
- `list_day`: the user-local day the task is listed for now;
- `listed_once`;
- `kind`: `call` or `callback`;
- `callback_at` (wall time);
- `open`.

**Call attempts** `call_attempts(task_id, outcome, number_detail_id, note, at)` record each logged outcome. A redial or a callback changes the same task; a step never gets a second task.

**Replies** `replies(subject, channel, at, provider_ref)`, unique on `provider_ref`, hold the channel and date only (spec "What the user sees and does").

**Capacity reservations** `capacity_ledger(account_id, reset_day, attempt_id)` follow ADR 0002 "Sender inbox and capacity", for SMS accounts too. Each sender account also stores `next_slot_at`, taken at handover (4.2, 5.5).

**SMS bindings** `sms_bindings(sender_number, recipient_key, owner_subject, created_at, released_at)` name the subject that owns that conversation (4.5). An enrollment's binding is never released or transferred. A test run's binding is released when the test run ends. A partial unique index allows one unreleased binding per pair. Rows are never deleted, so the table is its own history.

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

The callback hold *is* the open callback task, so "hold ⇔ one open callback task" holds by construction. There is a single rule for every way a track can end: **a track that finishes closes its open call task and quiesces its live attempts in the same transaction** (2.5), and closing the task releases any callback hold. A stop or a reply closes nothing: the lead is ended, so nothing of it is listed, and a restart finds its tasks where they were.

**The listing rule** (ruling 6). An open task is **listed** at a moment when all of these hold:

- the subject has not ended;
- it is not lead-paused;
- its campaign is not paused (enrollments only);
- the prospect's calling hours open at some point on the current user day;
- either the subject has no callback hold, or this task is the callback task;
- **the task is due on the current user day** (date eligibility):
  - for `kind = call`, `list_day` is today or earlier, so a redial moved to tomorrow is not listed today and no outcome is accepted on it today;
  - for `kind = callback`, the user-local date of `callback_at` is today or earlier. A callback is not listed before its day. On its day it is "later today" until `callback_at` and "ready" from then. **An overdue callback stays listed every day**, flagged overdue, until an outcome is logged, and the calling-hours condition does not apply to it, because the prospect chose the time.

When a callback is the subject's only hold, its callback task is therefore listed on its day even though `runs` is false. A task **was listed on a user day** if it was listed at any moment of that day. Days on which the prospect's calling hours never open do not count as listed days (3.5).

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
| Attempt reaches `sent` | any but D | A `sent` step result. Its time is **when the provider sent it** (ruling 4), mapped exactly onto the lead's clock by 3.3's `leadAt`. That gives `at = leadAt(t)` and `at_wall = wallOfPoint(t)`. `touched` is set. **In the same result transaction, whether or not the subject runs**, the track's next step is resolved from that basis, or the track finishes if no live step is left (2.6 step 3). On a track already finished, the result is recorded and nothing else changes (ruling 7). | D: impossible. Outside R it is only an attempt handed over while running and resolved later (ADR 0002's bounded handover); invariant 2 checks exactly that. |
| Attempt reaches `rejected` | any but D | The reservation and in-flight place are released. Then by reason: a block-listed address skips the track; an invalid address or number marks the detail bad and fails the track; a refusal for payment required (402) or rate limit (429) puts the **account** into an account-level wait (5.4): until the quota is confirmed for 402, and for the provider's retry-after period, or an exponential backoff starting at one minute, for 429. No claim is made on that account until then, and the step stays pending with its deadline unchanged. Instantly's unexplained skip holds the track (5.4). On a finished track, only the detail mark applies. | D: impossible. |
| Bounce or invalid number reported after a send | any but D | The detail is marked bad (ADR 0001: bad marks are never cleared). If the track is unfinished, it finishes `failed_bad_destination`, which quiesces its live attempt to the same address. On a finished track the finish reason stays. | D: impossible. |
| Reply detected or marked | R, H, and every ending except `replied` and `interested_on_call` | `ended = replied`, with channel and date. The lead **quiesces** (2.5). No other subject changes (spec "What stops"; for SMS, 4.5). | `replied` or `interested_on_call`: recorded on the timeline only. D: impossible, there is no thread. |

**Calls.** Every outcome has one eligibility rule: **the task is listed at that moment** (2.3). The transaction re-checks the listing against current state. On an ordinary task that means the lead is R. On a callback task it means the callback is the lead's only hold. Everything else is refused: ended, lead-paused, a paused campaign, any other task while a callback is open, a day without calling hours, or a stale screen.

| Event | Effect |
| - | - |
| No answer, voicemail, gatekeeper with note; no redial | Task closed, track `completed`, `touched` set. |
| …with redial | The task stays open with `list_day` set to the user's next day. `due_at` and `skip_deadline` are unchanged ("still counts from the original due date"). `touched` set. |
| Wrong or dead number | The number is marked bad and `touched` set. Until Q4 is answered, the task closes and the track finishes `completed` (spec: "any other outcome… finishes the phone track"). Later phone tracks with no good number left are skipped as missing. |
| Callback requested (date and time) | `kind = callback`, `callback_at` set: the callback hold. The lead quiesces. `touched` set. |
| Interested | The task closes and its track finishes `completed`. **Every other open call task of the lead closes too**, and its track finishes `closed_on_interest`. `ended = interested_on_call`; the lead quiesces. `touched` set. |
| Not interested (stop, continue or win-back, preselected from the track, overridable) | `no_more_calls` is set. Every open call task of the lead closes and its track finishes: this one `completed`, others `skipped_declined`. That releases any callback hold. Then by path: **stop** gives `ended = declined_on_call`, and the lead quiesces. **Continue** leaves the lead running. **Win-back** enters win-back (below). `touched` set. |
| Any of the above on a callback task | As in the matching row, after which the callback hold is gone (the task is closed or no longer a callback). A redial converts it back to `kind = call` for the next day, keeping its original `due_at` and `skip_deadline`, which have not advanced while frozen. A new callback time keeps the hold. |
| Skip for now | The task moves to the end of today's queue. Nothing else changes: it is not a call made, and on a callback task the hold stays. |

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
| Skip step | R, H, not ended | The step the person page names (Q3; until answered, the open step with the earliest due time, ties broken by track id) gets result `skipped (by_user)`. Its `claimed` attempt, if any, becomes `withdrawn` in the same transaction (ruling 1). Its successor resolves from now. On a call step the task closes and the track finishes `skipped_by_user`, releasing any callback hold. | The step has a live attempt past `claimed` (it may already be with the provider); ended; D. |
| Stop | R, H, D | `ended = stopped_manually`; the lead quiesces. Progress, open tasks and resolved deadlines are kept for a restart. | Already ended. |
| Resume from the next unsent step | E-r | `ended = null`, `lead_paused = false`. The clock syncs, and every remaining wait continues as it stood at the end. An open callback task resumes the hold. Pacing spreads restarted work. | E-x (Q6), not ended. |
| Move to win-back | E-r, `branch = main`, the win-back branch has a live track | Enter win-back (above), then `ended = null`, `lead_paused = false`. | Already in win-back; no live win-back track; others. |

**Definition and environment**

| Event | Allowed in | Effect |
| - | - | - |
| Edit published | any | Reconciliation in one transaction (5.2). Every subject of the campaign gets a version bump. Refused if the definition fails 7.1, or a launched campaign's definition has a launch blocker. |
| Contact detail marked bad elsewhere | any | Nothing is stored here. The next claim refuses that destination, the track finishes `failed_bad_destination`, and the endings are checked. |
| Account unhealthy, disconnected or out of quota | any | Nothing is stored on leads. Claims for that account wait, and Needs attention lists it. |
| Restart after an interruption | — | Section 6. |

### 2.5 Quiescing, and stale results

**Quiesce** is the one effect applied whenever a subject stops running, or a track finishes for any reason. The triggers are:

- every change that makes `runs` false: a reply, stop, interested, declined-stop, a callback request, lead pause, campaign pause, and the exhaustion endings;
- every track finish, for that track's attempts: `failed_bad_destination`, a skip, a decline closing other tracks, entering win-back.

Each live attempt in scope is handled by its state:

- **`claimed`:** becomes `withdrawn` locally. The provider was never called.
- **`handed` or `accepted`:** gets `withdraw_requested`, and the worker calls `port.withdraw`. Section 5.3 says how it resolves.

**Changing pending work withdraws the claim** (ruling 1). A `claimed` attempt becomes `withdrawn` in the same transaction as any change to its track's pending step or that step's content. These changes are a skip, an insert, a removal, a reorder, and a copy or wait edit on the step. A subject's sender is fixed at its first handover (1.3) and never changes afterwards, so there is no sender-change case. They apply to running and held tracks alike. A later claim creates a new attempt, which renders the current copy at its handover. An attempt past `claimed` is not withdrawn by an edit: it may already be with the provider, so it resolves under 5.3 with the copy it was handed.

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
span(w, 0, z) = 0                                                        -- due at once
span(w, N, z) = startOfLocalDay(localDate(w, z) + N days, z) − w      -- N ≥ 1; > 0; DST-aware via the zone library
deadline      = b + span(w, N, z)                                       -- stored, in lead time; deadline_wall = w + span
```

**A provider's send time** `t_p` is mapped exactly, from the `freezes` record (1.3):

```
t            = clamp(t_p, handed_wall, now)                  -- provider clock skew cannot move the basis before the handover or into the future
overlap(t)   = total length of freezes ∩ [t, now]            -- an open interval counts up to now
leadAt(t)    = leadNow − (now − t) + overlap(t)              -- lead time at wall instant t
wallOfPoint(t) = t, unless t lies inside a frozen interval [f, g); then f
```

`wallOfPoint` returns the wall instant at which the lead's clock last stood at `leadAt(t)` while running. So `basis_at` and `basis_wall` always describe the same point, and the calendar arithmetic below starts from the right local date. `freezes` intervals before the oldest unsettled attempt's `handed_wall` are never needed, because `t ≥ handed_wall`.

*Trace* (UTC; a two-day wait; lead time L at Monday 09:00; the next step's due wall instant is what matters):

- **Pause between the handover and the send.** Handover Monday 09:00; pause Monday 10:00 to Tuesday 10:00; the provider sends Tuesday 11:00; the app observes it Thursday 11:00.
  - `leadAt` = L + 2 h, and `wallOfPoint` = Tuesday 11:00.
  - The span to Thursday 00:00 is 37 h, so the step is due at L + 39 h. That is Thursday 00:00 on the wall, already due when the send is observed.
  - The round-2 fallback gave L + 26 h, so the step would have been due Friday 00:00.
- **The same pause after the send.** Handover Monday 09:00; the provider sends Monday 11:00; pause Monday 12:00 to Tuesday 12:00; observed Thursday 11:00.
  - `leadAt` = L + 2 h, and `wallOfPoint` = Monday 11:00.
  - The span to Wednesday 00:00 is 37 h, so the step is due at L + 39 h. The 24-hour pause moves that to Thursday 00:00 on the wall.
  - The stored totals at observation are identical in both orderings. Only the `freezes` record tells them apart. Both orderings are generated cases (9.2).

Every editable timer stores its basis `b` and `w` and its zone `z` beside the deadline (ruling 5), so a deliberate edit can re-resolve it without reconstructing any pause history:

- **A step's due time:** `b` and `w` are the latest step result's `at` and `at_wall`, which for a send is the provider's send time (2.4, ruling 4), or the track's start for its first step. They are stored as `basis_at`, `basis_wall`, `due_wall` and `due_zone`.
- **A track's delayed start:** `b` and `w` are the predecessor's `finished_at` and `finished_wall`, stored as `start_basis_at`, `start_basis_wall` and `start_zone`.
- **The call skip limit:** from the call task's `due_at`, `due_wall` and the user's zone (3.5).

After that, nothing recomputes the stored deadline. A pause of length D leaves `leadNow` constant for D, so the wall instant at which `leadNow` reaches the deadline moves by exactly D. That holds for any pause, including one that ends at 01:00 after a 23:00 start, or one that crosses a daylight-saving change.

Re-resolution, from the stored basis and the new input, happens only on a deliberate edit: the wait, the delay, the skip limit, or the campaign's default zone (5.2). It does not happen when a re-import changes a person's or company's zone, because a re-import never moves progress (invariant 21). Windows always use the current zone at claim time.

### 3.4 Windows and zones

- **The prospect's zone:** the person's zone, else the company's, else the campaign default (spec "Pace, capacity and timing"). An invalid IANA name falls through to the next.
- **Claims:** a step is claimed only while its track's window is open in that zone. "A step due outside its window waits for the next window."
- **Call tracks:** the window is the calling hours, in the prospect's zone.
- **The call list's day** is the user's day, in the user's zone. That is a setting, defaulting to the machine's zone.

### 3.5 The call skip limit

Spec "Unfinished call tasks": "After a configurable number of days (default 2) an unworked call task is marked skipped". Ticket 15: "Retain the original due date for the skip-limit clock" (ruling 8).

- **The deadline.** When the call step's task is created: `skip_deadline = due_at + span(due_wall, limit, user zone)`. `due_wall` is the wall instant the step's due time was resolved to, stored on the task. That is the start of the user's day `limit` days after the original due date, in lead time, so pauses freeze it. An edit of the limit re-resolves it from the same stored `due_at` and `due_wall`.
- **Expiry.** A task expires only at a user-day rollover, and only if all of these hold: the lead runs; `leadNow ≥ skip_deadline`; the task is not a callback; and it **was listed on the day that is ending** (2.3) and not worked. A task that call capacity kept off the list is never expired, so nothing is dropped for lack of capacity (spec "nothing is dropped"). It gets the whole of its first listed day.
- **Days without calling hours.** A day on which the prospect's calling hours never open is not a listed day, so no task expires at its end. With the default of 2 and Monday–Friday hours, a call due Friday is listed Friday, not Saturday or Sunday, and expires at the end of Monday, unworked. A call due Thursday expires at the end of Friday.
- **On expiry:** the task closes, the track finishes `skipped_unworked`, and the tracks after it start after their delay.
- **What counts.** The deadline counts calendar days from the original due date (the spec's text), and expiry needs a listed day. Whether the limit should count only workable days is question Q5. The two readings differ across non-working days: with a limit of 3, a call due Friday expires at the end of Monday under the interim rule, but at the end of Tuesday when only workable days count.

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
- a pacing gap: by default, the length of the shortest daily window among the tracks it serves, divided by its capacity, and at least 60 seconds. This way a full day's capacity fits inside the window. The preview shows the gap;
- `k`, a bound on attempts handed to the provider but not yet resolved, which is ADR 0002's in-flight bound, from 1 for email;
- `next_slot_at`.

There is no spacing between touches to the same person from different campaigns in the MVP (ruling 9).

### 4.2 The claim

One transaction:

1. Re-read the subject and campaign, and require the **step guard**: `runs(s)`; the versions the decision was computed from; the step is the track's pending step, live, with no result and no live attempt, and `due_at ≤ leadNow`; the track's window is open in the prospect's zone; the account is healthy; the destination is good and owned by the lead (ADR 0001's ownership rules); and the copy renders. A merge field with no fallback that this lead lacks refuses the claim and holds the track as `render_failed` (5.4), until an edit adds the fallback or the lead gains the field.
2. Choose the account: the subject's fixed sender if it has one. Otherwise pick a candidate from the pool: the account that can send soonest, then the one with most remaining capacity, then the lowest id; for SMS, only accounts whose pair with this mobile is free (4.5). The candidate becomes the subject's sender, and an SMS pair its binding, only when this attempt's handover commits (5.5).
3. Require both of these:
   - **capacity:** `sends counted + open reservations (+ other senders, ADR 0002) < capacity`;
   - **in-flight bound:** `attempts on this account in claimed, handed or accepted < k`. Unresolved attempts are still `handed` or `accepted`, so they count.
4. Write the attempt (`claimed`, `retryable` from the transport), the capacity reservation and the subject's version bump. Commit.

**Pacing is taken at every send call, not at the claim.** Both the handover transaction (5.5) and the retry authorization (5.6) require `now ≥ next_slot_at` and set `next_slot_at = now + gap` in the same write that authorizes the call. That covers first handovers, same-key retries and anything recovered after a crash, so a claim that waited an hour cannot be handed over a second before the next one. Capacity and the in-flight bound at the claim stop a tick from piling up claims, and the slot at each call spaces what the provider actually receives. Invariant 11 is asserted on the fake provider's call log.

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

- `sms_bindings(sender_number, recipient_key)` names the **owning subject**. A subject takes the binding in the transaction that commits its first SMS handover to that mobile, if no unreleased binding exists for the pair. If a concurrent handover took it first, the handover fails its predicates and the claim is withdrawn.
- **An enrollment's binding is never transferred** (ruling 8). Once an enrollment owns a pair, it keeps it for good, including after it ends, so a late reply always reaches the campaign that texted. The table is its own history.
- **A test run owns its pair only while it runs.** Ending the test run sets `released_at`, so a second test run with the same contacts can take the pair and complete. A test run whose pair is owned by an enrollment is held as `sms_conversation_taken`, like any other subject.
- **Attribution.** A reply on a pair goes to its unreleased owner, which invariant 14 relies on. If the pair has no unreleased owner, the reply is recorded on the most recent released owner, which is always a test run, and changes nothing because that test run has ended. A reply that the user sent to an earlier test after a later one started goes to the running test run. That ambiguity exists only between the user's own test runs.
- **Another subject** that needs the same mobile uses another sender number in its pool that has room, and keeps that number as its fixed SMS sender. If there is none, its SMS track is held with the reason `sms_conversation_taken`, "this mobile is in campaign X's SMS conversation from this number" (5.4). The held track drops nothing and is listed in Needs attention. It stays held until a free number joins the pool, or the user skips the step or stops the lead. Whether it should instead be skipped like a missing channel is question Q7; this is the interim.

## 5. Running edits and the provider boundary

### 5.1 Live tracks and steps

- **A track** is live for a lead if it is not removed, or the lead has started it. A track that is removed after a lead started it keeps running for that lead ("rearranging tracks applies only to leads who haven't started the affected tracks").
- **A step** is live if it is not removed.
- **The lead's next step** in a track is the first live step, in the current order, that comes after the lead's last resolved step and has no result. "An added step reaches leads still in that track": it reaches them if it is placed after where they are. A step placed (or moved) before the lead's last resolved step is behind them. Sending it would be out of order, so it is not sent. That narrows the spec's wording, and it is question Q8.

### 5.2 Reconciling an edit (ruling 7)

Publishing an edit runs one transaction over every subject of the campaign. In it, every started, unfinished track with no live attempt beyond `claimed` is reconciled, **held or not**:

- if the edit changes its pending step or that step's content, its `claimed` attempt is withdrawn (2.5);
- `next_step_id` becomes the next step of 5.1;
- `due_at` and `due_wall` are re-resolved (3.3) from the stored `basis_at`, `basis_wall` and that step's current wait;
- a hold on a step the edit removed ends with that step.

The stored step and the rule always agree (invariant 22). The claim's step guard (4.2) and the handover guard (5.5) check the same thing again against current state, so a track that an edit skipped cannot send a removed or stale step.

| Edit | Reconciliation |
| - | - |
| Insert a step | If it lands between the last resolved step and the pending one, it becomes the pending step, and its due time is resolved from the same basis with its own wait. If it lands later, nothing changes now. If it lands behind the lead, see Q8. |
| Remove a step | If it is pending (no attempt, or only `claimed`, which is withdrawn), the next live step becomes pending from the same basis. If none is left, the track finishes `completed` at the current lead time. If it is in flight or `unresolved`, it resolves normally, because it may have reached the provider. Then the next step follows. |
| Reorder steps | The pending step is recomputed by 5.1. Steps moved behind the lead are not sent (Q8). |
| Change a wait | If the step is pending, its due time is re-resolved from its basis. |
| Change copy | A `claimed` attempt on that step is withdrawn. The copy renders at handover, so the next attempt carries the new copy. Attempts already handed over keep their copy (ADR 0002). |
| Add a missing fallback | Nothing stored: the render check runs at claim and handover, so tracks held `render_failed` claim again. |
| Add a track or change connections | Unstarted tracks: any stored `start_at` is discarded, and the start rule is re-applied by the next evaluation, resolving from the predecessor's stored `finished_at`. Started tracks: unchanged. |
| Remove a track | Started: unchanged. Unstarted: its `start_at` is discarded. 7.1 refuses a definition whose live rules name a removed track, so its dependents must be reconnected in the same edit. |
| Change a track's window | Nothing stored: windows apply at claim. |
| Change the declined path | Nothing stored: it is read when an outcome is logged, and preselected on the screen. |
| Change the skip limit | The `skip_deadline` of every open task is re-resolved from its `due_at`. |
| Change the campaign's default zone | For subjects using the default zone: pending due times are re-resolved from their basis, and `start_at` is re-resolved only for tracks that have not started. A started track's `start_at` is history and stays. |
| Remove a sender account from a pool | Subjects already fixed to it keep it ("one sender inbox for the whole campaign"). New subjects choose from the new pool. If the removed account is disconnected, its subjects' work waits in Needs attention. A fixed sender never changes. |
| Change capacity, gap or `k` | Nothing stored: they apply at the next claim. |

### 5.3 Ports and the attempt contract (ruling 1)

Each sending channel has one port:

```
interface SendPort {
  readonly retryable: boolean            // a repeat call with the same key cannot send twice
  readonly notSentIsFinal: boolean       // lookup's "not-sent" is a documented final statement for this transport
  handover(a: { idempotencyKey, sender, destination, rendered, threadRef? }):
    Promise<{ kind: "accepted", providerRef } | { kind: "rejected", reason, final: true } | { kind: "unknown" }>
    // "rejected" only for a documented refusal before processing (validation, block list, 402, 429);
    // a 5xx, a timeout or anything undocumented is "unknown"
  withdraw(a): Promise<"withdrawn" | "too-late" | "unknown">     // "withdrawn" only on a positive provider signal
  observe(since): Promise<ProviderEvent[]>   // sent (with the provider's send time), delivered, failed, bounced, reply, unsubscribed, rejected
  lookup(a): Promise<{ kind: "sent", sentAt } | { kind: "queued" } | { kind: "not-sent" } | { kind: "unknown" }>
    // queued: the provider holds the work and has not sent it yet
}
```

**Email** is ADR 0002's Instantly adapter. The `/leads/add` opener is `retryable: true`. The reply and forward follow-up transports have no key, so they are `retryable: false`. `withdraw` returns `unknown`, and `notSentIsFinal` is false, until ADR 0002's X5 shows otherwise. A `not-sent` that is not final is treated as `unknown`.

**SMS:** no provider is provisioned (#28).

- The running app registers an `UnprovisionedSmsPort` with no sender accounts. An SMS track therefore always meets launch blocker 3, which is honest by construction.
- Tests and ticket 13's demonstration use a simulator port, whose accounts read "Simulated SMS (not a provider)" on every screen. It is registered only against the development data directory (ADR 0001).

**Calls** have no port (ruling 9). The user dials on their own phone, and a call counts as made only when the user logs an outcome. That refuses, by construction, to "pretend a call happened when it did not". A phone track needs no connected sender account.

**The attempt state chain** runs `claimed` → `handed` → `accepted` → terminal (`sent`, `rejected`, `withdrawn`). `withdraw_requested` is a flag that only goes from false to true, and `unresolved_since` is set once and never cleared. Every event below only moves forward. A repeated event, or one that would move backwards, is ignored and logged. Results may arrive late, twice or out of order. "Settle" in the table means: one `SETTLING` after the attempt's `last_call_wall`, call `lookup`.

| Event \ state | `claimed` | `handed` | `accepted` | terminal |
| - | - | - | - | - |
| Handover transaction commits (5.5) | → `handed`, `calls = 1`; copy, `handed_at`, `handed_wall`, `last_call_wall` and the pacing slot written and committed **before** the call | ignore | ignore | ignore |
| Handover predicates fail (5.5) | → `withdrawn`, `ended_by = guard`. The provider was never called | not possible: the guard runs only on `claimed` | — | — |
| Claim older than `SETTLING` (5.5 step 5) | → `withdrawn`, `ended_by = claim_expired` | — | — | — |
| Call returns `accepted` | impossible | → `accepted`, with its reference | ignore (duplicate) | ignore |
| Call returns `rejected` (final) | impossible | → `rejected` | → `rejected` only on a provider signal that it will not send (Instantly skipped the lead, P4) | ignore |
| Call returns `unknown`, times out after `CALL_TIMEOUT`, or the worker crashed before recording the answer | impossible | try the **retry authorization** (5.6); if it is refused, stay `handed` and settle | stays `accepted`; settle | ignore |
| Sent observed (with send time) | impossible: no reference to match | → `sent` | → `sent` | `sent`: ignore. `withdrawn` with `ended_by = lookup_not_sent`: → `sent`, the one terminal state an observation may leave, because the provider's earlier "not sent" was not a confirmed withdrawal. Other terminal states: recorded as a provider anomaly in Needs attention, never as a second send of the step |
| Quiesce | → `withdrawn`, `ended_by = quiesce` | set `withdraw_requested`, call `withdraw` | set `withdraw_requested`, call `withdraw` | ignore |
| `withdraw` returns `withdrawn` (positive signal) | — | → `withdrawn`, `ended_by = provider` | → `withdrawn`, `ended_by = provider` | ignore |
| `withdraw` returns `too-late` or `unknown` | — | unchanged; settle | unchanged; settle | ignore |
| `lookup` returns `sent` | — | → `sent` at `sentAt` | → `sent` at `sentAt` | as "Sent observed" |
| `lookup` returns `queued` | — | → `accepted`; look up again after each `SETTLING`; after `MAX_QUEUED_LOOKUPS` consecutive `queued` answers set `unresolved_since`, and keep looking up | same | — |
| `lookup` returns `not-sent`, `retryable` | — | try the **retry authorization** (5.6) with the same key. If it is refused: → `withdrawn`, `ended_by = lookup_not_sent`; the step's next attempt **inherits this `idempotency_key`**, so no later attempt for the step uses a new key | same | — |
| `lookup` returns `not-sent`, not `retryable`, `notSentIsFinal` | — | → `withdrawn`, `ended_by = provider` | same | — |
| `lookup` returns `unknown`, or a `not-sent` that is not final | — | set `unresolved_since` (5.4); look up again after each `SETTLING` | same | — |
| User: "mark sent" | — | unresolved only: → `sent` (`ended_by = user`) | same | ignore |
| User: "mark not sent" | — | unresolved only, and **refused while the latest `lookup` answer is `queued`**: → `withdrawn` (`ended_by = user`) | same | ignore |

**Every attempt leaves a waiting state in bounded time** (rulings 3–4):

- **`claimed`:** handed over, or withdrawn by its predicates, or withdrawn after `SETTLING`.
- **`handed` and `accepted`:** terminal, or `unresolved_since` set, within `SETTLING × (MAX_QUEUED_LOOKUPS + 1)` after their last call, plus the latency of those lookups. The number of calls is at most `MAX_CALLS`.
- **Unresolved attempts** keep being looked up each `SETTLING`, so a later `sent` or `not-sent` still settles them.
- **After `withdraw_requested`** the attempt is never called again.
- **A new attempt** for the step is possible only once the step's attempt is terminal and not `sent`.

The step's state is derived from its attempts: sent if one is `sent`; in flight if one is not terminal; otherwise pending. **Withdrawn without a provider statement happens only from `claimed`.** An attempt that may have reached the provider is never withdrawn by the app on its own, never repeated without its key, never repeated after a withdrawal request or once unresolved, never called more than `MAX_CALLS` times, and never repeated while its subject is not running.

**The user's override is the one exception.** "Mark not sent" on an unresolved attempt is the user's explicit decision under ADR 0002 P3, and it is refused while the provider reports the work queued. If the provider did send it, the step can then be delivered twice. The at-most-once invariants (4, 5) therefore exclude steps whose earlier attempt the user marked not sent, and the screen warns about this before the user confirms.

### 5.4 Held tracks

A track is **held** when the engine cannot proceed without guessing or without the user. This is derived, not stored. A held track stops only itself and the tracks after it; other tracks and the lead's status are unchanged. Each hold shows in Needs attention with its reason:

- **`unresolved`:** an attempt with `unresolved_since` set (5.3). The user resolves it, or a later lookup or observation settles it.
- **`render_failed`:** the claim cannot render the copy (4.2).
- **`provider_skipped`:** Instantly skipped the lead for no reason the API exposes (ADR 0002 P4): an attempt `rejected` with that reason, until the user skips the step or resumes it.
- **`sms_conversation_taken`:** the mobile's SMS conversation from every free number belongs to another subject (4.5).

Account-level problems (disconnected, stale inbox, quota exhausted) hold no track. Claims for that account wait, and Needs attention lists the account.

**An inbox never stalls silently** (ruling 3). An account whose in-flight places (`k`) are all taken by attempts older than the settling period is listed in Needs attention with the attempts holding it, for example "inbox X is waiting on an unresolved send to Y". The user's mark frees the place.

### 5.5 The worker

The outbox runs in this order:

1. **Claim** (4.2) and commit.
2. **Wait for the slot.** Each account hands over its `claimed` attempts **in 4.3 priority order**: when `next_slot_at` passes, the highest-priority claimed attempt on that account goes next.
3. **Pre-send network check**, once the slot is free: for email, ADR 0002's pre-send reply check. Its time is stored as `presend_checked_wall`. A reply it finds is applied as a reply event, which quiesces the claim. Its result is valid for `PRESEND_MAX_AGE` (5.6); a handover that misses that age runs the check again.
4. **Handover transaction** (ruling 1). It is one write, `UPDATE attempts SET state = 'handed', calls = 1 … WHERE id = :a AND state = 'claimed'`, committed only if every one of these **predicates on current state** holds. None of them compares versions: the claim bumped the subject's version itself, and the attempt is excluded from its own conditions.
   1. The subject is not ended, not lead-paused, and has no open callback task. For an enrollment, its campaign is launched and not paused; for a test run, it is running.
   2. The track has started and has not finished.
   3. Its `next_step_id` is the attempt's step.
   4. The step has no `step_results` row.
   5. The step is not removed in the current definition.
   6. `due_at ≤ leadNow`.
   7. No other non-terminal attempt exists for this step (`id ≠ :a`).
   8. The track's window is open now, in the prospect's zone.
   9. The account is healthy and not in an account-level wait.
   10. The account is the subject's fixed sender, or, when none is fixed, is in the track's pool.
   11. For SMS, the pair is unbound, or bound to this subject.
   12. The destination is good and still belongs to the lead.
   13. No reply has been recorded for the subject since `claimed_wall`.
   14. `presend_checked_wall ≥ now − PRESEND_MAX_AGE`, and the check found no reply.
   15. The attempt's capacity reservation exists.
   16. `now ≥ next_slot_at` on the account.

   In the same write:
   - the copy is rendered from the current definition and stored on the attempt;
   - `handed_at` and `handed_wall` are set;
   - `next_slot_at = now + gap`;
   - if not yet fixed, the subject's sender is fixed to this account and, for SMS, the binding is inserted.

   The provider is called only if this row changed. If a predicate other than 16 fails, the attempt becomes `withdrawn` (`ended_by = guard`), and its reservation and in-flight place are released; the step stays pending with its deadline unchanged. If only predicate 16 fails, the attempt stays `claimed`.
5. **The claim's age limit.** A `claimed` attempt not handed over within `SETTLING` of `claimed_wall` becomes `withdrawn` (`ended_by = claim_expired`), releasing its reservation and in-flight place. A later evaluation claims the step again. So a pre-send check that cannot run, or a slot that never frees, does not hold the place for ever.
6. **Call** the provider, outside any transaction, with `idempotency_key` and the stored copy.
7. **Apply the result** through the table in 5.3.
8. **Apply observations** (sent, bounce, reply) through the same table. Each is matched by provider reference or thread (ADR 0002 "Recovery") and is idempotent by provider id.

Because the handover re-checks the step, no change can slip in between the claim and the call (skip, edit, reply, pause, sender trouble). The window left for a change to race the provider is the call itself, which is ADR 0002's bounded handover.

### 5.6 Same-key retries, and the engine's parameters

**A same-key retry is its own atomic authorization** (ruling 1). It is one write, committed only if all its conditions hold:

```
UPDATE attempts SET calls = calls + 1, last_call_wall = :now
 WHERE id = :a AND state = 'handed' AND retryable = 1
   AND calls = :c AND calls < MAX_CALLS
   AND withdraw_requested = 0 AND unresolved_since IS NULL
```

It is committed only together with:

- the current-state predicates 1–9, 12 and 13 of 5.5, excluding its own attempt;
- a fresh pre-send check (predicate 14);
- the pacing slot (predicate 16), setting `next_slot_at = now + gap` in the same write.

Predicates 10 and 11 were settled by the first handover.

The call then resends the **identical `idempotency_key` and the identical stored payload**. The copy is not re-rendered: the copy-is-current check applies only to a first handover.

If the slot is busy, the retry waits for it. If any other condition fails, there is no retry, and the attempt settles through `lookup` (5.3). Recovery after a crash reaches the provider again only through this authorization (section 6), so a retry is paced, guarded and counted like a first handover.

**Parameters**, one value each, used everywhere in this ADR:

| Name | Default | Meaning |
| - | - | - |
| `MAX_CALLS` | 3 | Send calls per attempt in total: the handover plus at most two same-key retries. |
| `SETTLING` | 15 minutes, until ADR 0002's X1 measures the handover latency; then that latency plus a margin | The wait after a call before `lookup`; the maximum age of a `claimed` attempt; the interval between repeated lookups. |
| `MAX_QUEUED_LOOKUPS` | 12 | Consecutive `queued` answers before an attempt is unresolved. |
| `PRESEND_MAX_AGE` | 60 seconds | How old a pre-send check may be at the handover or retry it authorizes. |
| `CALL_TIMEOUT` | 30 seconds | How long a send call may take before it counts as `unknown`. |

## 6. Restart and the interruption notice

On start, before the first evaluation:

1. **Observe.** Apply provider events since the last checkpoint, with ADR 0002's overlap.
2. **Settle open attempts** through the 5.3 table, with no separate path:
   - `claimed`: 5.5 steps 2–5, in priority order: the slot, a fresh pre-send check, the handover transaction, the age limit;
   - `handed` with no recorded answer: the crash row of the 5.3 table, that is, the retry authorization of 5.6 (paced and guarded), else settle;
   - `accepted`, or `handed` once refused a retry: no call; `lookup` once `SETTLING` has passed since `last_call_wall`.
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

1. **Empty copy.** A live email or SMS step in either branch has an empty body, or an empty subject on a `new_subject` step. Call steps have no copy; an empty call script is a warning.
2. **A merge field with no fallback that some lead lacks.** Checked against every enrollment of the campaign that has not ended. For a lead enrolled later, the claim makes the same check (4.2).
3. **A track whose channel has no connected sender account.**
   - An email track needs at least one healthy inbox in its pool.
   - An SMS track needs at least one connected SMS sender, so SMS is blocked until a provider exists.
   - A phone track needs none, because the user dials.

**Nothing to launch (interim; question Q9).** A campaign whose main sequence has no live track has nothing to launch. The Launch button is replaced by "Add a track to launch", and the server refuses a launch request with that message. This is not one of the three blockers, and it is not reported as empty copy. A call-only campaign has tracks, so it launches. Whether the human accepts this as a precondition, given that the spec lists exactly three blockers, is question Q9.

## 8. Invariants

The generated test asserts every one of these after every event.

1. **One status.** Every enrollment has exactly one outreach status, and the stored column equals `deriveStatus` of the stored state.
2. **Nothing reaches a provider for a subject that does not run.**
   - No attempt is claimed unless 4.2's guard held. No attempt moves from `claimed` to `handed` unless 5.5's predicates held. No retry is called unless 5.6's authorization committed. Each check runs in the same transaction, against current state.
   - **Checked against the fake providers' call logs** (handovers and retries alike): every call happened at a moment when its subject ran and the step was its track's pending step with no result. Every delivery comes from such a handover, and at most `k` per account were outstanding when the subject stopped.
3. **At most one live attempt and one `sent` attempt per step**, by unique index.
4. **Sent at most once, checked against the fake providers' delivery logs.** Each `(subject, step)` is delivered at most once, across resumes, win-back, edits, crashes, lost responses, retries and quiesces. This is not checked against the application's own records. The one exclusion is a step whose earlier attempt the user marked "not sent" (5.3).
5. **Attempts only move forward.** No attempt leaves a terminal state, and `withdraw_requested` never clears.
   - Without a provider statement or the user's mark, `withdrawn` happens only from `claimed`.
   - The one terminal state that an observation may leave is `withdrawn` with `ended_by = lookup_not_sent`, and only for `sent`.
   - No attempt with `retryable = false` is called twice.
   - No attempt is called after `withdraw_requested` or `unresolved_since`, or more than `MAX_CALLS` times in total.
   - Every call of one attempt carries the same `idempotency_key` and payload, and a step's attempts after a `lookup_not_sent` reuse that key.
6. **A finished track never restarts.** Once `finished_at` is set, the track gets no new attempt and no new task, and `started_at` is written once. A result can still be added for an attempt that was live at the finish, but it changes neither the finish reason nor any successor (ruling 7).
7. **Starts follow their rule.** A track starts at its stored `start_at`, which was resolved from the rule in force when it was resolved. For `after(P, d)` that is d calendar days after P's `finished_wall` (3.3). Tracks with the same rule and the same resolution start at the same lead time.
8. **Steps go in order and on time, at handover.** Steps are resolved in the order of 5.1. **On the fake providers' handover logs**, no step is handed over before its `due_at` (as the reference model predicts it), out of order, after a result, or after it was removed or skipped. A **first** handover carries the copy current at that handover. A retry carries exactly the payload of its attempt's first handover.
9. **Clocks freeze exactly.**
   - `frozen_since` is set exactly when `runs(s)` is false, and `leadNow` is then constant.
   - Stored deadlines change only through their creation and the edits in 5.2. A withdrawal, a rejection or a temporary refusal leaves the pending deadline unchanged.
   - The wall instant at which a lead reaches any deadline moves by exactly the total frozen time.
   - A next step's basis is its predecessor's provider send time, clamped to between the handover and now and mapped exactly through the `freezes` record (3.3), not the time the app observed it. `basis_at` and `basis_wall` describe the same point.
10. **Capacity.** For every account and reset day, counted sends plus open reservations never exceed capacity.
11. **In-flight bound and pacing.** An account never has more than `k` attempts in `claimed`, `handed` or `accepted`. **On the fake providers' call logs**, two send calls from one account (first handovers and same-key retries alike) are never closer together than its gap. That includes anything recovered after a crash, and test runs.
12. **Priority, at the handover.** When an attempt is handed over on an account, no other `claimed` attempt on that account that met every predicate except the slot had a higher priority (4.3). When a claim is made, no unclaimed item eligible for that account had a higher priority.
13. **Windows.** Every claim happens inside its track's window in the prospect's zone. Every task listed as "ready now" is inside calling hours.
14. **Campaign-local replies.** A reply changes only the subject that owns the thread or the SMS binding. Other campaigns, colleagues and company leads are unchanged. Each pair has at most one unreleased binding. It belongs to the subject whose first SMS handover to that mobile committed first. An enrollment's binding never changes or is released. A test run's binding is released when the test run ends.
15. **No call after a decline.** After any declined outcome, the enrollment has no open call task, and none is ever created again. Win-back never has a call task.
16. **Call tasks.** These hold:
    - an open task's track is unfinished, and a lead that ended `interested_on_call` has no open call task at all;
    - no outcome is accepted on a call task before its `list_day`, or on a callback task before the user-local day of `callback_at`, and an overdue callback is listed every day until its outcome;
    - a subject has at most one open callback task, and while it is open the subject does not run;
    - every call attempt was logged on a task listed at that moment under 2.3, and every outcome logged on a listed callback task is accepted;
    - a callback task is never expired by the skip limit;
    - redials and rollovers never change `due_at` or `skip_deadline`;
    - "skip for now" never adds to calls made;
    - a task that was never listed is never expired.
17. **Call capacity.** New tasks listed per user day never exceed capacity minus committed tasks, and committed tasks are never removed for lack of room.
18. **Nothing is dropped.** After a drain phase at the end of each run, with enough time and capacity and no new events, every subject is ended, holds, or has each unfinished track held with a reason (5.4) or waiting on an open call task.
19. **Good destinations only.** A claim names a detail that is good at the time of the claim and belongs to the lead under ADR 0001's ownership rules.
20. **Correct endings.**
    - `sequence_finished_no_response` only when no live track is unfinished or unstarted, a channel is still reachable, and no reply or interested call was recorded since the lead last started or restarted.
    - `finished_no_usable_channel` only when no channel of the branch reaches the lead.
21. **Re-import never moves progress.** An import changes no existing subject's progress, status, deadlines or clock.
22. **The pending step agrees with the rule.** For every started, unfinished track with no live attempt beyond `claimed`, held or not, `next_step_id` is the step 5.1 names under the current definition, and a `claimed` attempt names that step.
23. **Allowed controls match transitions.** Every control offered for a status is accepted, and every control not offered is refused.
24. **Stale changes are never applied.** A change computed from a version that is no longer current writes nothing.
25. **Tests stay out of lead counts.** Test runs appear in no lead search, status count or measure. Their sends do count in the ledger and in pacing.
26. **No attempt waits forever.**
    - Every `claimed` attempt is handed over or withdrawn within `SETTLING` of `claimed_wall`.
    - Every `handed` or `accepted` attempt is terminal, or has `unresolved_since` set, within `SETTLING × (MAX_QUEUED_LOOKUPS + 1)` after its last call, plus lookup latency.
    - Every account whose in-flight places are all held past `SETTLING` is listed in Needs attention.
    - "Mark not sent" is never accepted while the latest lookup says `queued`.

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

It runs from `src/server/sequence-runs.test.ts`, with the generator and record in `test/support/generated-sequences.ts`. It goes through the real SQLite store and a fake provider per channel. It follows the pattern of `src/server/import-sequences.test.ts`.

Each fake keeps a **handover log** (every call it received, with its time) and a **delivery log** (what it actually sent, with its send time). Each fake can be set to one of these **modes**:

- `honest`;
- `lost-response`: the work is accepted but the answer never arrives;
- `late-send`: it sends after a delay, so the send time comes before the app observes it;
- `duplicate-and-reorder`: results arrive twice and out of order;
- `withdraw-unknown`: a withdrawal works, but the fake answers `unknown`;
- `same-key-replays`: a repeat call with the same key returns the old result and sends nothing new;
- `always-unknown`: every call and `lookup` answers `unknown`;
- `non-retryable`: no key, and a repeat call sends again;
- `5xx`: answers that must be read as `unknown`;
- `late-send-beyond-settling`: the provider holds the work longer than `SETTLING` before sending, and `lookup` answers `queued` meanwhile;
- `lookup-lags`: `lookup` answers `not-sent` for a while after the provider has accepted the work.

1. **Generate definitions.** One to three campaigns that share sender accounts. Each is a tree of tracks with random channels, steps, waits, delays, windows (including overnight ones) and declined paths, all within 7.1; refused definitions get their own example tests. Leads with varied reach and zones, including zones with daylight-saving changes in the test period.
2. **Generate events** (ruling 14), interleaving:
   - clock advances from seconds to weeks, including partial-day pauses across both daylight-saving changes;
   - **nested holds**: a campaign pause inside a lead pause inside a callback, released in every order;
   - **edits while held**, and edits during in-flight attempts;
   - provider results that are lost, late, **duplicated or out of order** (sent before accepted, accepted after withdraw);
   - **crashes on a non-retryable transport** between `handed` and the result;
   - **a user action between evaluate and apply**, and **between the claim commit and the handover commit** (skip, every edit kind, reply, pause, sender trouble);
   - claims left `claimed` across a crash, then recovered beside fresh claims on the same account;
   - a bounce on one step while the next step is `handed`, and win-back entry while a main step is `handed`, followed by late sends and late bounces;
   - callbacks logged while they are the only hold, and under each other hold;
   - an SMS pair whose owner ends, followed by a second campaign needing it and a late reply to the first;
   - replies during in-flight attempts and after endings;
   - one person in two campaigns sharing one SMS number;
   - two consecutive test runs with the same contacts and one SMS number, and a late reply to the first;
   - retries: a crash between the handover commit and the call on a retryable transport, recovered beside fresh claims on the same account with `k = 2`; retries racing a quiesce;
   - a slot that stays busy, and a pre-send check that cannot run, past `SETTLING`;
   - the Monday-to-Thursday trace of 3.3 in both orderings, and pauses that start before and end after a provider send;
   - a redial today followed by an outcome attempt the same day; callbacks set for a later day; overdue callbacks over several days;
   - interested on one call track while a second call track's task is open;
   - call outcomes chosen from what is listed;
   - user controls, including ones that should be refused;
   - re-imports and test runs.
3. **Keep an independent record.** A reference model in the test support directory imports nothing from `src/domain/sequence/`. It is written from the spec's words, keeping wall time and an explicit list of frozen intervals per subject. It reads the fakes' delivery logs for send times. From those it predicts:
   - each step's **due instant**, with its own calendar-day arithmetic counted from the delivered send time mapped through its own frozen-interval list (the same semantics as 3.3's `leadAt` and `wallOfPoint`, implemented separately);
   - its **window**;
   - which tracks start and finish;
   - which call outcomes must be accepted, from its own record of open callbacks and holds rather than the production guard;
   - which campaign owns each SMS reply, from its own record of first texts;
   - each lead's status.

   Capacity, pacing and priority are checked as invariants on the handover log, which follows ADR 0001's split.
4. **Assert after every event:** invariants 1–26. Each subject's due instants, step order, finished tracks, open tasks and status must equal the record's. In an unlimited-capacity variant of each seed, the earliest instant inside the window at or after each predicted due instant must equal the handover instant, up to the pacing gap. Each run ends with a drain phase (time passes, no new events) before invariants 18 and 26.
5. **Prove the test bites.** `src/server/sequence-runs-oracle.test.ts` swaps in deliberately broken engines, and the generated runs must fail on each:
   - withdrawing a `handed` attempt;
   - retrying a non-retryable transport;
   - recomputing due times from the current `frozen_total`;
   - a claim that ignores the slot or `k`;
   - applying stale versions;
   - a track that finishes without closing its call task;
   - an SMS reply going to the newest binding;
   - an ending check placed after the track starts;
   - counting "touched" at claim time;
   - a handover without the step re-check;
   - pacing taken at the claim instead of the handover;
   - an `accepted` attempt that never settles;
   - a same-key retry after `withdraw_requested`;
   - a withdrawal that clears the pending deadline;
   - a next-step basis taken from the observation time;
   - a late send on a finished track resolving a successor;
   - "interested" leaving its task open;
   - callback outcomes refused while the callback is the only hold;
   - an SMS binding transferred after its owner ends;
   - reconciliation skipping held tracks;
   - a same-key retry without a pacing slot, or without the predicates;
   - a retry that re-renders the copy;
   - `not-sent` creating an attempt with a new key;
   - "mark not sent" accepted while queued;
   - `queued` treated as unresolved at once;
   - a claim with no age limit;
   - the round-2 clamp fallback in place of `leadAt`;
   - claims handed over out of priority order;
   - the sender or the binding fixed at the claim;
   - a redial listed on the same day;
   - interested closing only its own task;
   - a test-run binding never released.

A failure the generator finds is shrunk into a named example test. Each run uses 100 seeds, ten to a chunk.

### 9.3 What the generator must produce by the end of each ticket

| Ticket | Generator adds | Invariants first asserted | Mutations added |
| - | - | - | - |
| 12 | One email track of 1–5 steps; waits and windows; leads with and without email, in zones with daylight-saving changes; 1–3 inboxes across 1–2 campaigns; every fake mode; quiesce on reply; crashes at every outbox stage, on both a retryable and a non-retryable transport; user events between evaluate and apply and between claim and handover; recovered claims and recovered retries beside fresh ones with `k = 2`; slots and pre-send checks blocked past `SETTLING`; late sends after the lead ended on a reply (the `freezes` mapping with an open interval); a bounce while the next step is `handed`; re-imports; launch; a drain phase | 1–6, 8–13, 18–21, 24, 26 | withdraw `handed`, retry non-retryable, retry after withdraw, retry without slot or predicates, retry re-renders, new key after `not-sent`, mark-not-sent while queued, queued unresolved at once, claim without age limit, `accepted` never settles, stale apply, handover without re-check, handover out of priority order, pacing at claim, sender fixed at claim, withdrawal clears deadline, basis from observation, clamp fallback, late send resolves successor, capacity off by one, window, touched at claim |
| 13 | Trees of email and SMS tracks; missing and failing channels; cross-channel replies; one person in two campaigns on one SMS number, including after the first ends; two concurrent first handovers racing for one pair | 7, 14 | SMS reply to the newest campaign, binding transferred after an end, binding fixed at claim, ending check too late |
| 14 | Call tracks, call capacity, outcomes without redial or callback; interested with a second call track's task open | 16 (partial), 17 | outcome on an unlisted task, interested closes only its own task |
| 15 | Redial, rollover, skip limit on weeks with and without calling hours, callbacks including overdue and for later days, callback outcomes as the only hold and under other holds, an outcome attempted on a same-day redial | 9 with callbacks, 16 | redial resets the deadline, redial listed the same day, callback listed before its day, callback expires, a task never listed expires, callback outcome refused when the callback is the only hold |
| 16 | Declined paths with overrides, win-back branches with a main step `handed` at entry; works without 15's events | 15 | open task survives a decline |
| 17 | Lead and campaign pause, skip, stop, restart, move to win-back, nested holds in every order; the Monday-to-Thursday trace in both orderings; pauses that begin and end around provider sends | 2, 9 and 23 in full | due recomputed from the current total, clamp fallback with a thaw |
| 18 | Bulk sequences across campaigns | 23 across campaigns | — |
| 19 | Every edit kind of 5.2, at random points, including while held and between claim and handover | 22, plus 6 and 8 under edits | edit leaves a stale pending step, edit leaves a stale claim, reconciliation skips held tracks |
| 20 | Outages of random length; unresolved attempts and their resolution | the notice count equals the record's | count due-in-gap instead of rescheduled |
| 21 | Test runs before and after launch, interleaved with leads; two consecutive test runs on one SMS pair, and a late reply to the first | 14 for test runs, 25 | test exempt from pacing, test-run binding never released |
| 22 | — | measures equal the record's own counts | skip-for-now counted as a call |
| 23 | Everything, at 300 seeds | all | all |

## 10. Slicing

Each ticket implements its part completely. A later ticket's area shows an honest not-yet state, never a fake one. Ticket 12 lands as **three pull requests, in order** (ruling 12).

| Ticket | Implements | Leaves as an explicit not-yet state |
| - | - | - |
| 12a Detail redirect | Merging a contact detail keeps the merged row, pointing at its target (#32 item 3; ADR 0001 "Constraints"), before any attempt references a detail id. | — |
| 12b Engine core | Definition and validator, limited to one email track in `main`. Lead time, `syncClock` and deadline resolution. Track progress with the pending step's stored deadline and basis, step results and attempts with the full 5.3 table and settling, the version guard, the claim with capacity and `k`, the **handover transaction** with the full re-check, rendering and the pacing slot. The outbox worker with **withdrawal and quiesce**, the reply stop, late facts on finished tracks, endings, the stalled-inbox listing. Statuses queued, active, replied, sequence finished no response and finished no usable channel. Blockers for email. Restart settlement. All against a fake email port. | A second track is refused with "one email track for now". Unresolved attempts are held and shown, but their resolution controls arrive in #20. |
| 12c Instantly and UI | The ADR 0002 adapter behind the port, the editor, preview, launch, and the timeline. The preview's **projected daily load per sender account and time until all leads start** is a dry run of `dispatch.ts`: the claim and handover rules with an unlimited clock over the enrolled leads, with no provider and no writes. So the preview cannot disagree with sending, and it shows each account's gap. | Real provider proof is gated by ADR 0002's experiments. Laptop-off is unverified. |
| 13 SMS beside email | Multiple tracks with together and after; release on skip and failure; the SMS port (unprovisioned and simulator) and bindings; the cross-channel reply stop; account problems in Needs attention. | In the real app, SMS is blocked by blocker 3 until a provider exists. |
| 14 Phone track | Call tracks, placement and capacity, ready now and later today, outcomes without redial, callback or not interested; `waiting_on_call`, `interested_on_call`; the rule that a finishing track closes its task. | "Not interested" is not offered. Unworked tasks stay listed with no skip limit. That is still truthful: they hold only their dependents. |
| 15 Redial, callback, rollover | `skip_deadline` and its expiry rule, rollover, redial, the callback hold, overdue callbacks. | Campaign pause (#17). |
| 16 Declined paths | The win-back branch, declined paths with overrides, `no_more_calls`, closing tasks on a decline, entering win-back, `in_win_back`, `declined_on_call`. It depends only on #14: tasks closing on a decline releases a callback hold whenever #15 is present, with no code of #15's needed. | Moving a stopped or replied lead to win-back (#17). |
| 17 Pause, resume, restart | Lead and campaign holds, skip, stop, restart, move to win-back, the paused banner, **`describe.ts` and the allowed controls** (ruling 12). | — |
| 18 People and bulk | Bulk actions as loops of single transitions with per-lead results, reusing #17's controls and sentences. | — |
| 19 Running edits | Publishing edits to a launched campaign and the 5.2 reconciliation; the Instantly re-push. | — |
| 20 Recovery and attention | The heartbeat, the notice, `lookup`, unresolved resolution (P3), the full Needs attention list. | Laptop-off proof stays unverified while local-only. |
| 21 Test runs | The `test_runs` lifecycle, 60-second deadlines, test contacts, test call tasks, the "no test since last edit" warning. | No test contact is designated yet (#28), so real receipt is unverified. |
| 22 Measures | Read from facts. Per channel: sent, failed or bounced, and replies. Calls made, meaning logged outcomes other than skip for now. Connected: interested, not interested and callback requested. Interested, declined, and callbacks pending, meaning open callback tasks of subjects that have not ended. Reply rate is leads replied on a channel over leads sent at least one message on it; connect rate is connected over made. | — |
| 23 Acceptance story | The generator at full capability, and the nine-step story. | Whatever the provider gates and #28 leave unverified. |

## 11. Not decided here

- **The Instantly mechanics**, the experiments and P1–P4. ADR 0002 owns them.
- **The SMS provider.** Twilio is not provisioned (#28). The port keeps the engine independent of it.
- **Hosting.** The engine is a library plus a tick in the server process. "Keeps sending with the laptop off" stays unverified until hosting arrives.
- **The canvas library and the editor's look** (`docs/agents/ui.md`).
- **Social tracks.** A social port would plug in like SMS, and "the step waits while the laptop is off" becomes an account-health wait.
- **The import questions in #32.** They change who is enrolled, not how an enrollment runs.
- **Tuning values:** the tick interval, and `k` beyond ADR 0002's X1. The defaults of the engine's other parameters are in 5.6. These are parameters with tests, not product behaviour.

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
- **Q5. Which days the call skip limit counts.** *Recommendation:* count only days on which the prospect's calling hours open. *Built:* the deadline counts calendar days from the original due date (the spec's text), and a task expires only at the end of a day on which it was listed (3.5). With the default of 2 and Monday–Friday hours, a Friday call therefore expires at the end of Monday, the same as counting workable days. With a limit of 3 it also expires at the end of Monday, where counting workable days gives the end of Tuesday.
- **Q6. Restarting a lead that was interested or declined on a call.** The spec offers restart "for a lead that replied or was stopped". Note what already follows from the spec: a declined lead who later replies by email or SMS becomes `replied` ("any reply"). Restart is then allowed, for email and SMS only, because `no_more_calls` still bars every call. *Recommendation:* allow restart from both statuses directly, with the same bar on calls after a decline. *Built:* not allowed directly. Only the reply route above.
- **Q7. One person texted from the same number by two campaigns.** An SMS thread is one conversation between two numbers, so a reply cannot say which campaign it answers. "A reply stops only that campaign" can only mean the campaign that owns the conversation. *Recommendation:* the campaign that texted first owns it for good. A second campaign uses another sender number if one has room; otherwise its SMS track is skipped like a missing channel, with the reason shown, so the lead's later tracks are not stalled. *Built (ruling 8):* the pair is never transferred. The second campaign uses another number with room, or its SMS track is held as `sms_conversation_taken` and listed in Needs attention. Holding drops nothing, but the tracks after it wait until the user acts or a free number joins the pool.
- **Q8. An added step, or a step moved, behind a lead's position.** "An added step reaches leads still in that track". For a lead past that point, sending it would be out of order. *Recommendation:* such a step is not sent to that lead; it is sent to every lead in the track who has not yet passed its position. *Built:* that.
- **Q9. A campaign with no track in the main sequence.** The spec lists exactly three launch blockers, and none of them covers a campaign with nothing in it. *Recommendation:* treat it as "nothing to launch": the Launch button reads "Add a track to launch". It is not a fourth blocker, because no outreach can follow. *Built:* that (7.2).

**Still open in ADR 0002** and unchanged here: P1 (the pre-existing Instantly campaigns on the same inboxes), P2 (continue thread if no transport passes X2), P3 (how the user resolves an unresolved send, used by 5.3–5.4), P4 (Instantly's unexplained skips, used by 5.4), and the consents C1–C4.

## Changes from round 1

| Finding | Resolved in |
| - | - |
| Opus 1, GPT 1, GPT 4: an uncertain handover withdrawn or retried; non-monotone results | The 5.3 table, `retryable`, `claimed` vs `handed`; invariants 4–5, checked on the delivery log. |
| Opus 2, GPT 3: burst; no in-flight bound; withdrawal on every stop | 4.2 `k` and capacity in one transaction (the pacing slot moved to the handover in round 2); quiesce (2.5); invariant 11. |
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

## Changes from round 2

Each fix names the invariant that states it, the fake mode or generated case that exercises it (9.2), and the mutation that proves the test catches a regression.

| Finding | Fix | Invariant | Fake mode / generated case | Mutation |
| - | - | - | - | - |
| Opus 2, GPT 3: claim not re-checked at handover; edits and skips leave stale claims | 5.5 handover transaction; 2.5 content changes withdraw the claim; 5.2 | 2, 8, 22 | user events and every edit kind between claim and handover | handover without the step re-check; edit leaves a stale claim |
| GPT 1: recovery burst | 4.2 pacing slot taken at handover | 11, on the handover log | recovered claims beside fresh claims | pacing at claim |
| Opus 1: an attempt never settles; a withdrawn one is retried | 5.3 settling on every transport, no retry after a withdrawal request, cap of 3; 5.4 stalled inbox listed | 5, 26 | `withdraw-unknown`, `same-key-replays`, `always-unknown`; drain phase | `accepted` never settles; retry after withdraw |
| Opus 3: basis from the observation time | 2.4 send time mapped to lead time | 9 | `late-send` | basis from observation |
| GPT 2, Opus 5: deadlines lost on withdrawal; editable timers without a wall basis | 1.3 pending step fields independent of attempts; basis, wall time and zone stored for every timer; 3.3, 3.5 | 9 | withdrawals, then edits of wait, delay, zone and skip limit | withdrawal clears deadline |
| GPT 4: callback outcomes impossible | 2.3 listing rule; 2.4 single eligibility rule | 16 | callback outcomes as the only hold and under other holds, predicted by the record | callback outcome refused as the only hold |
| GPT 6, Opus 6: late facts on finished tracks; bad address leaves an attempt live | 1.3, 2.4, 2.5: late results recorded without changing the finish or successors; every track finish quiesces | 6 | bounce while the next step is `handed`; win-back entry while `handed`; `late-send` | late send resolves successor |
| Opus 4: "interested" leaves its task open | 2.4 Interested row; callbacks pending counts only subjects that have not ended (10) | 16 | interested on a callback task | interested leaves its task open |
| GPT 5: SMS binding transferred after an end | 4.5 never transferred; held `sms_conversation_taken`; Q7 | 14 | owner ends, then a second campaign and a late reply | binding transferred after an end |
| GPT 7: empty-main condition reported as empty copy | 7.2: "nothing to launch" kept as the interim; Q9 | — | example test | — |
| Opus 7: reconciliation skipped held tracks | 5.2 reconciles held tracks too | 22 | edits while held | reconciliation skips held tracks |
| Opus 8: no reason for the SMS wait | 5.4 `sms_conversation_taken` | 18 | two campaigns on one number | — |
| Opus 9: "listed" undefined on days without calling hours | 2.3 listing rule; 3.5 | 16 | skip limit across weeks with and without calling hours | a task never listed expires |
| Opus 10: a declined lead's later reply | Q6 states what follows | 15 | reply after a decline, then restart | open task survives a decline |
| Opus 11: projection, gap, `skipped`, win-back with no live track, meaning of rejected | 10 (12c dry run of `dispatch.ts`); 4.1 gap from windows; 1.3; 2.4; 5.3 port | 12 | `5xx` | — |
| GPT 8: N = 0, recovery retry, "mark not sent", ADR 0002 questions | 3.3; 6 uses the 5.3 table; 5.3 and invariant 4 exclusion; questions | 4, 5 | `lost-response` with a user mark | retry after withdraw |

**No finding rejected.** Every scenario in both reports reproduces from the text at `2bec5ee`.

## Changes from round 3

The coordinator's items 1–7. Both reports reproduce from `c3990ba`, and no finding was rejected.

| Item | Fix | Invariant | Fake mode / generated case | Mutation |
| - | - | - | - | - |
| 1 Retries | 5.6 retry authorization: a conditional write, the 5.5 predicates excluding its own attempt, a fresh slot, an identical key and payload; recovery goes only through it; `MAX_CALLS` = 3 everywhere | 2, 5, 8, 11 (every send call) | crash between handover and call, recovered beside fresh claims with `k = 2`; retries racing a quiesce | retry without slot or predicates; retry re-renders |
| 2 Historical send times | 1.3 `freezes` record; 3.3 `leadAt`, `wallOfPoint`, and the clamp of `t_p` to between the handover and now; the reference model keeps its own interval list | 9 | the Monday-to-Thursday trace in both orderings; late sends after a reply ended the lead | clamp fallback |
| 3 Lookup | 5.3 `sent` (with time), `queued`, `not-sent`, `unknown`; `queued` re-looked-up up to `MAX_QUEUED_LOOKUPS`; `not-sent` retries with the same key and passes the key on; "mark not sent" refused while queued | 4, 5, 26 | `late-send-beyond-settling`, `lookup-lags` | new key after `not-sent`; mark-not-sent while queued; queued unresolved at once |
| 4 Claimed is bounded | 5.5 steps 2–5: the pre-send check after the slot, `PRESEND_MAX_AGE`, the claim's age limit; section 6 recovery goes through the same steps | 26 | slot busy, and pre-send check unavailable, past `SETTLING` | claim without age limit |
| 5 Handover predicates | 5.5 step 4's sixteen predicates, with no version comparison and excluding its own attempt; handover in priority order | 2, 12 (at handover) | user events between claim and handover; several claims waiting for one slot | handover out of priority order |
| 6 Result transaction; 402 | 2.4: the next step resolved in the result transaction whether or not the subject runs; 402 and 429 go to the account-level wait | 8, 18 | sends observed while held; `5xx` and quota refusals | — |
| 7a Listing dates | 2.3 date eligibility; overdue callbacks stay listed | 16 | same-day redial outcome; callbacks on later days; overdue callbacks | redial listed the same day; callback listed early |
| 7b Interested | 2.4: closes every open call task (`closed_on_interest`) | 16 | interested with a second call track open | interested closes only its own task |
| 7c Sender and binding | Fixed at the handover commit (1.3, 4.2, 4.5, 5.5); the sender-change case deleted (2.5, 5.2) | 14 | concurrent first handovers racing for one pair | sender or binding fixed at claim |
| 7d Zone edit | 5.2: `start_at` re-resolved only for tracks that have not started | 7 | zone edits around track starts | — |
| 7e Test-run SMS | 4.5: a test run's binding released at its end; late replies recorded on the last released owner | 14 | two consecutive test runs on one pair; a late reply to the first | test-run binding never released |

## Consequences

- **ADR 0001.** The merge that deletes a contact-detail row becomes a redirect in 12a. Enrollments gain the fields in 1.3. `status` stays the one stored status column.
- **ADR 0002.** Its attempt states are refined here: `adding` splits into `claimed` and `handed`, `added` becomes `accepted`, `withdraw-requested` becomes a flag, and `unresolved` is a derived hold that every attempt reaches in bounded time unless a provider settles it. Its pre-send check runs before the handover transaction, and its pacing is taken there and at every same-key retry. Its `lookup` gains the answers `queued` and a `sent` that carries the provider's send time. X5 must also establish whether a `not-sent` lookup is final for each transport (`notSentIsFinal`), and what a same-key re-add returns after a lagging add. A stop does not abandon a pending step, so a resume finds it. Its frozen clocks for ticket 17 are met by lead time and stored deadlines. X5 adds the check that an idempotency key is still honoured after a long outage.
- **Every later ticket** reads this ADR before touching the engine, and changes it before changing a rule.
