# 0004. Social channel tracks: LinkedIn, then Instagram and Facebook

- **Date:** 2026-11-16.
- **Status:** Proposed. Written by the ticket 24 implementer before the code (delivery workflow, "Design first"). The council reviews it with part a's pull request.
- **Consumers:** tickets [24](https://github.com/Pierpaolo01/omnichannel-outreach/issues/24) (LinkedIn, this design worked in full), [25](https://github.com/Pierpaolo01/omnichannel-outreach/issues/25) (Instagram), [26](https://github.com/Pierpaolo01/omnichannel-outreach/issues/26) (Facebook) and [27](https://github.com/Pierpaolo01/omnichannel-outreach/issues/27) (the InMail fallback, which attaches at one point named in 4.4).
- **Builds on:** [ADR 0003](0003-sequence-engine.md), every rule of which a social track keeps unless this ADR says otherwise: one definition, lead time and stored deadlines, the claim and the handover transaction with its predicates, the attempt table (5.3), capacity counted per provider work, pacing at every send call, priority (4.3), quiesce, holds, the reads that say when, test runs as subjects, and the generated-run discipline. [ADR 0002](0002-email-through-instantly.md) is the model for how a provider limitation is recorded.
- **Product source:** [the social decision](https://github.com/Pierpaolo01/omnichannel-outreach/issues/9#issuecomment-6823218555), quoted in each ticket. The [research](https://github.com/Pierpaolo01/omnichannel-outreach/blob/789af21/docs/research/social-first-contact.md) states the platforms' documented behaviour. Everything else is a factory decision and says so.

## The rule in one paragraph

A social channel is one more channel of the engine, and a social track is one more channel track: started by its start rule, stepping through its live steps in order, each step claimed, handed over, settled and timed by ADR 0003's rules, with capacity per sender account shared across campaigns, follow-ups before first contacts and nothing dropped. What is new is small and stated once. A **social sender account** is a logged-in browser session on this machine, reported by the channel's port like an inbox, with **allowances** the user sets per kind of action. A LinkedIn track's first step is a **connection invite**, whose note goes while the sender's note allowance lasts. Its second step, the first message, waits for a **connection**: the invite accepted, or the sender already connected, which the pre-send check finds and which skips the invite. An invite not accepted within the track's **acceptance wait** is withdrawn and the track finishes, releasing what waits on it. Acceptance is a fact about the track, never a reply. Replies are marked by the user. Nothing here makes a real LinkedIn session act: the port is built and verified against a simulated provider, and a browser-session driver can be attached behind it later without changing the engine.

## Context

The social decision makes LinkedIn, Instagram and Facebook channel tracks like email and SMS, driven through the user's logged-in browser sessions, each sender below its platform's limits, with capacity shared across campaigns, follow-ups first and overflow to the next day. No LinkedIn session is connected and no test profile is designated (#28). The repository's rules forbid new account connections and test sends to anyone the user has not designated. So this ticket builds the application's side: the definition, the engine's rules, the store, the import of profile URLs, the reads, the manual reply mark, test runs and measures, against a simulated provider that the tests script. Section 11 lists what stays unverified until a session is connected.

## 1. The channel and its sender account

### 1.1 What a social sender account is

| | Email inbox | SMS number | Social sender account |
| - | - | - | - |
| What it is | An Instantly inbox | A provider number | A logged-in browser session for one profile, on this machine |
| Who reports it | Instantly's account list | The SMS provider | The channel's port, which lists the sessions it can drive |
| "Connected" | healthy at Instantly | listed and healthy | the session is signed in and the port can drive it |
| Room per day | the provider's daily limit | the provider's limit | the user's **allowances**, one per kind of action (1.2) |
| Reset day | Instantly's zone | the user's zone | the user's zone |

The engine knows, for each social account: whether it is connected (`healthy`, with the port's reason when not: `signed_out`, `not_listed`), its allowances, what it has done on its current reset day per kind (counted from provider work, 6), its note use this month (4), its pacing slot and its in-flight bound. It knows nothing else of the platform: no quota of LinkedIn's own, no restriction state beyond what the port reports as a refusal.

The running application registers `UnconnectedLinkedInPort`, which lists no session. A LinkedIn track therefore always meets launch blocker 3 (ADR 0003 7.2) in the running app, honest by construction, exactly as SMS. Tests use `test/support/fake-linkedin-port.ts`, whose sessions are labelled "Simulated LinkedIn (not a session)" wherever a sender is named; the running application never registers it. `GET /api/linkedin-provider` reports `none`.

### 1.2 Allowances are the user's settings

Each social account has, per kind of action, a daily allowance the user gives: for LinkedIn, **invites per day** and **messages per day**, and the **note allowance** (4). They are stored by the application (`social_allowances`, migration 22), keyed by the account, set through `PUT /api/sender-accounts/:id/allowances`, and kept across the port's account syncs, which never overwrite them. **There is no default**: an account whose allowances the user has not set has room for nothing (0), its due work waits for capacity and Needs attention says so (ADR 0003 "An account with no room"). No number in the code claims to be a platform limit.

### 1.3 The laptop is off

Operation is local-only. A browser session can act only while the application runs on this machine, so a social step that falls due while it is not running waits. When the application runs again, the step is handed over by the existing rules: the claim's window check (it goes inside its track's sending window, in the prospect's zone), the pacing slot taken at every send call, the in-flight bound and the reset day's allowance. So nothing goes late in a burst: what fell due during the stop is spread one gap apart inside the window, follow-ups first, and what does not fit a reset day waits for the next (ADR 0003 "Ticket 20a": recovery is the existing passes and nothing else). An interruption freezes no clock; an acceptance wait that ended while the application was off is judged where it ended (4.3). The lead's other tracks carry on, at the provider for email, unless the sequence places them after the social track.

## 2. The port

### 2.1 One contract, with platform actions where platforms differ

A social port is ADR 0003's `SendPort` with channel `linkedin` (later `instagram`, `facebook`), so the engine reaches it through the same claim, handover, retry authorization, lookup, withdraw and observe as email and SMS. The three platforms agree on two actions and differ on the rest:

| Action | Port method | LinkedIn | Instagram, Facebook (25, 26) |
| - | - | - | - |
| Send a message to a profile | `handover` with `action: "message"` | a DM to a first-degree connection | a DM, which arrives as a message request until accepted |
| Observe what was sent or failed | `observe`, `lookup` | yes | yes |
| Check the relation to the profile | `presendCheck` | already connected or not | not used (a request needs none) |
| Send a connection invite, with a note or without | `handover` with `action: "invite"` and `note` | yes | none |
| Observe that an invite was accepted | `observe` event `accepted` | yes | none (a request's acceptance is not observed: research) |
| Withdraw an invite | `withdrawInvite` | yes | none |

A `HandoverRequest` for a social step carries `action` and, for an invite, the note or none (`note: null`). Instagram and Facebook add no method: their steps are all `message`, and their tickets add only the destination rule (the decision maker's account, else the company's) and the sender kind (personal profile or business account/Page), as data on the account.

### 2.2 Idempotency and lost answers

Every handover carries the attempt's idempotency key (ADR 0003 5.3); the port records it with the action so a lookup can answer for it. A browser session has no server-side idempotency: whether a repeat click sends twice depends on the platform's state and the driver. So the simulated provider's transports, for invite and message alike, are `retryable: false` and `notSentIsFinal: false`, as SMS's are; a real driver states its own, and only an experiment against a connected session can show either is safe (11). With that:

| Answer | Invite | Message |
| - | - | - |
| `accepted` | the session clicked Send; the invite is sent when observed | the message is in the thread when observed |
| `rejected` `invalid_destination` | the profile does not exist or cannot be reached: the profile is marked bad, the track fails (`failed_bad_destination`) | the same |
| `rejected` `rate_limited` | the platform refused for a limit: an account-level wait (ADR 0003 2.4), the step stays pending | the same |
| `rejected` `not_connected` | — | the connection is gone (removed by the prospect): the track fails `failed_bad_destination` without marking the profile bad (question Q37) |
| `unknown`, a timeout, a crash before the answer | settled by `lookup` one `SETTLING` later: the session reads the profile (a pending or accepted invite is `sent`, none is `not-sent`, which is not final, so the work stays uncertain and holds its reservation; the step is held `unresolved` until the user marks it) | the session reads the thread (the message there is `sent`) |

So a lost answer never sends twice: on a non-retryable transport no call is repeated (ADR 0003 invariant 5), and uncertain work is held for the user, never repeated under a new key.

### 2.3 What the port can observe and what it cannot

It observes: an action's send, a refusal, an invite's acceptance (with the platform's time), an invite's withdrawal, and the connection state at the pre-send check. It cannot observe a **reply**: there is no reply detection (the decision: "The app doesn't detect social replies"). A social port's `observe` never reports `reply`, `presendCheck` never answers `reply`, and the engine ignores a `reply` event from a social port as a provider anomaly. It also does not observe that a message was read or delivered to a person: "sent" means the session sent it, and every read says only that.

## 3. The LinkedIn track as steps the engine runs

### 3.1 Definition

A LinkedIn track (`channel: "linkedin"`) has ADR 0003 1.1's fields plus:

- **`acceptWaitDays`**: whole days, at least 1, required. The wait after the invite is sent for it to be accepted.

Its steps, by position among its live steps (`linkedinStepKind`, one function every reader calls):

1. the **invite**. Its body is the note; an empty body is an invite without a note. It has no subject and no wait;
2. the **first message**, sent once connected. Its wait counts from the connection;
3. **follow-up messages**, each with its wait from the message before, as on any track.

The validator (ADR 0003 7.1) refuses a LinkedIn track with fewer than two live steps (an invite alone sends nothing the prospect can answer after accepting: "Once the invite is accepted, a first DM"), without `acceptWaitDays` or with one that is not a whole number at least 1, a subject on any step, `acceptWaitDays` on a track of another channel, and a LinkedIn track in the win-back branch only when the branch's own rules refuse it (none do: a LinkedIn track may be in either branch). Launch blocker 1 (empty copy) applies to the message steps; the invite's empty note is allowed, since a plain invite is a choice. A step cannot move between positions with a different kind while leads hold results for it: reordering a running track's invite is refused (`linkedin_invite_moved`), by the same rule as ADR 0003 "Ticket 19"'s refusal to move a step to another track.

### 3.2 Progress

`track_progress` gains, for a LinkedIn track (migration 22):

| Field | Meaning |
| - | - |
| `connection` | null until connected; then `accepted` or `already_connected`. Set once. |
| `connected_at`, `connected_wall` | the connection's point on the lead's clock, from the platform's acceptance time mapped through `freezes` (ADR 0003 3.3's `sendPoint`, clamped between the invite's handover and now), or the pre-send check's instant |
| `accept_by`, `accept_by_wall`, `accept_by_zone` | the acceptance deadline, in lead time: the invite's send point plus `waitSpan(acceptWaitDays)` (ADR 0003 3.3), resolved once when the invite's send is recorded, re-resolved only by an edit of `acceptWaitDays` (5.2) |
| `invite_withdrawal` | null, `wanted`, `withdrawn` or `accepted_first` (the platform said the invite had been accepted) |
| `invite_withdrawal_last_wall` | when the port last answered the withdrawal `unknown` |

The pending step after a sent invite is the first message, with **no due time** (`due_at` null) until connected: it is *awaiting acceptance*. `readyItems` already passes over a pending step without a due time, so nothing claims it. A connection resolves its due time from the connection point with its own wait, in the same write that records the connection, whether or not the lead runs (as a send's successor is, ADR 0003 2.4).

### 3.3 Transitions

| Event | Effect |
| - | - |
| The track starts | As any track (2.6): with no usable profile (5) it starts and finishes `skipped_missing_channel`, releasing what waits on it. Otherwise the invite is pending, due at the start. |
| The invite's claim reaches its slot; the pre-send check answers `connected` | The sender is already connected to the profile. In the handover transaction (no provider call): the claim is withdrawn (`ended_by = guard`; its reservation released), the invite gets the result `skipped`, reason `already_connected`, at the check's instant, `connection = already_connected` at that point, and the first message is resolved from it with its own wait. Nothing is counted as an invite sent. |
| The pre-send check answers `not_connected` | The handover goes on as ADR 0003 5.5 says. |
| The invite is sent (observed, by lookup, or the user's "mark sent") | The `sent` result, the lead touched (ADR 0003 1.3: it was reached), and `accept_by` resolved from the send point. The first message waits for acceptance. |
| Acceptance observed, at platform time `t` | If the track is unfinished, awaiting acceptance, and `leadAt(t) < accept_by`: `connection = accepted` at that point, and the first message resolved from it. Otherwise it is recorded as a fact (the measure counts it) and changes nothing: a finished track never restarts (ADR 0003 invariant 6). An acceptance reported for work not yet recorded as sent first records the invite's send at `t` (it was sent if it was accepted), then the acceptance. |
| Lead time reaches `accept_by` with no connection | The **acceptance expiry**, in evaluation (2.6), before the next steps: with the fallback off (always, until ticket 27), `invite_withdrawal = wanted` and the track finishes `invite_not_accepted` at `accept_by` (lead time and the wall instant it stood at), so what waits on it starts after its delay from then. The lead's other tracks carry on; the endings are checked after it (ADR 0003 2.1). |
| The worker's withdrawal pass | For each track with `invite_withdrawal = wanted`, not asked within `SETTLING`, the port's `withdrawInvite` with the invite's work: `withdrawn` sets `withdrawn`; `already_accepted` sets `accepted_first` and records the acceptance as a fact; `unknown` is asked again a settling period later. Asked while the lead is held or ended too: withdrawing sends nothing to the prospect. |
| A message is sent | As any step: its successor resolves from the send. |
| A message refused `not_connected` | The track finishes `failed_bad_destination`, the profile not marked bad (Q37). |

An **acceptance is not a reply**: it sets no `touched` (the invite already did), ends nothing, stops nothing, appears in no reply count, and starts only the first message of its own track.

### 3.4 Holds, pauses and stops

ADR 0003's holds apply unchanged. A pause or a stop freezes lead time, so it freezes `accept_by` with every other deadline (a pause of D moves the expiry by D). An acceptance observed while the lead is held is recorded and resolves the first message's due time, which waits until the lead runs. A stop or a reply quiesces the track's claims and asks the provider to withdraw work not yet sent (ADR 0003 2.5); an invite already sent stays sent and pending on LinkedIn, and is not withdrawn by a stop (question Q38). Skip on an invite awaiting acceptance skips the first message (the pending step) and is refused with the existing reason while the invite's own work is with the provider.

### 3.5 Where the InMail fallback attaches (ticket 27)

The acceptance expiry is one rule, `inviteExpired(state, track, now)` in `progress.ts`, swappable as a `Rules` entry. Today it withdraws and finishes. Ticket 27 adds the track's `inmailFallback` switch and an InMail step kind: with the fallback on and an eligible sender, the same rule leaves the track running with the InMail as the pending step, due at once (its kind decided by position, after the invite), and the first message and follow-ups after it, so they follow the InMail as the decision says. The withdrawal of the invite is then ticket 27's to state. Nothing in 3.1 to 3.4 changes.

## 4. The note allowance

- **Whose:** the user's setting on each LinkedIn sender account, `notesPerMonth`, a whole number, no default (0: every invite goes without its note). The research: free accounts have a limited number of personalised notes; Premium removes the limit. The user knows which their account is.
- **Over what period:** the calendar month in the user's zone, the account's reset zone (question Q34).
- **Where it is decided:** in the handover transaction, as the pacing slot is: the invite carries its note when its rendered note is not empty and the account's notes used this month are below its allowance. Notes used are the account's invite work handed over with a note this month whose work was sent or is still unsettled (a note refused or withdrawn unsent gave nothing away). The choice is stored on the work (`provider_work.with_note`) and the attempt's rendered copy holds the note or none, so a retry or a lookup never re-decides it.
- **What a read says:** an invite that went without its note says so and why, from the stored choice: "Sent without its note: the note allowance of this sender for November was used." An invite whose note is empty says "Sent without a note." A note never moves an invite: without room for a note the invite still goes, plain.

## 5. The profile URL

- **Only from the imported CSV.** The decision maker's `linkedin_url` column of the people file, which the import already stores (`people.linkedin_url`). A company lead has none: the businesses file's `linkedin_company` is a company page, which cannot receive a connection invite, so a company lead's LinkedIn track is skipped as a missing channel (question Q35). No search, no enrichment.
- **Normalised and validated** by one function, `linkedinProfileKey` (`src/domain/linkedin-profile.ts`): trimmed; `http` or `https`; host `linkedin.com` or a subdomain of it (`www.`, a country code); path `/in/<slug>` with an optional trailing slash; query and fragment dropped; the slug percent-decoded and lower-cased. The key is `https://www.linkedin.com/in/<slug>`. Anything else (empty, a company page, `/pub/`, Sales Navigator, a search, another host, a slug with a slash) is **not a member profile** and reads as missing.
- **Missing** means the lead has no usable profile: its LinkedIn track starts and finishes `skipped_missing_channel`, with the reason shown, like any missing channel, and the endings count LinkedIn as not reaching it (ADR 0003 2.1).
- **A bad or unreachable profile** is the existing rule for a bad destination: a refusal `invalid_destination` marks the profile bad (`linkedin_profile_marks`, by key; ADR 0001: bad marks are never cleared) and finishes the track `failed_bad_destination`. A later import that gives the person another URL gives a new key, which is good. The detail the track was started with is fixed at its start; a re-import that changes the person's URL makes the old one no longer theirs, and the track is skipped as missing (ADR 0003 2.4's "Destination no longer the lead's").
- **In the engine** the profile is a `LeadDetail` with channel `linkedin`, id `linkedin:<person id>:<key>`, built by the store's load from `people.linkedin_url`; a test run's is `test:<run>:linkedin`. Migration 22 lets the destination columns name these ids (the triggers of migration 18).

## 6. Capacity and priority

The engine's rules, per kind of action. Reused unchanged: the claim (`claimAll`, `claim`), `chooseAccount` and `pickAccount`, `accountAvailable`, the handover predicates (`handoverFailures`), pacing at every send call (`handOver`, `authorizeRetry`), the in-flight bound by key (`occupyingKeys`), `comparePriority` (touched first, oldest due, then ids), the account-level waits, the reset day (`resetDayOf`), the drain of overflow to later days, the fixed sender (`linkedin_sender`, fixed at the first handover, never reassigned) and the projection's `pickAccount`. New:

- **`AccountState.kinds`**, for a social account: per kind (`invite`, `message`), the allowance and what is used today (sent on the reset day plus reservations), counted from `provider_work.kind`, which the claim writes. `accountHasRoom(account, reserved, kind)` checks the kind's bucket as well as the in-flight bound; email and SMS pass no kind and are unchanged.
- **One pacing gap per account** across kinds: one session does one thing at a time. Its default is ADR 0003 4.1's, from the shortest window it serves and the sum of its daily allowances.
- **Withdrawals** take no allowance and no pacing slot, as ADR 0003's withdrawals do not (question Q36).

Priority: an invite to a new lead is a first contact; a message to a connected lead, or any step of a touched lead, is a follow-up. So messages go before invites when a session's slot is contested, then oldest due first, and what does not fit a reset day's allowance waits for the next, never dropped.

## 7. Replies

- **A new control, `mark_replied`**, on `POST /api/enrollments/:id/controls` with `{ requestId, action: "mark_replied", channel: "linkedin" }`, judged by ADR 0003 "Ticket 17a"'s one order (`judgeControl`), with its request id bound to its first answer and its precondition (`expect`). It is a control, not a provider event, because the user is the only source.
- **Allowed** when the lead's campaign is launched, the lead has not ended `replied` or `interested_on_call` (ADR 0003 2.4's reply row: a reply to a lead ended otherwise sets replied), and the lead has LinkedIn work handed over in this campaign (an invite or a message: nothing else could be answered there; question Q39). Refused otherwise with a plain reason.
- **Effect** is `applyReply` with channel `linkedin` and the stored id `linkedin:<request id>`: `ended = replied`, the stopping reply's channel and instant (the mark's), the lead quiesces in this campaign only. The status is the normal handoff status, "Replied", with its channel.
- **Activity** says it from the reply record: "You marked them replied on LinkedIn", at the mark's instant, never as a detected reply.
- **The accepted risk.** A follow-up the engine sent before the user marked the reply is the risk the decision accepts ("A follow-up that goes out before the user marks the reply is an accepted risk"). It is not a defect, and nothing is built to prevent it.

## 8. Test runs and measures

**Test runs.** The campaign's test contacts gain the user's own **test LinkedIn profile** (`campaigns.test_linkedin`, set with the others through `PUT /api/campaigns/:id/test-contacts`), validated by `linkedinProfileKey` and refused when any person's record holds the same key (ADR 0003 "Ticket 21"'s boundary). A test run's LinkedIn track sends its invite to that profile from the real sender session, and the user accepts it by hand there. **The acceptance wait is not cut short** for a test run (question Q40): 60 seconds would withdraw the invite before a person could accept it. While it waits, the Test run tab says "Waiting for you to accept the invite on your test profile", with the day the wait ends as a fact. Once accepted, the messages follow with ADR 0003 3.6's minute waits. Stop test ends it as before.

**Measures** (ADR 0003 "Ticket 22", per channel, test share counted by the same function): for LinkedIn, **invites sent** (invite attempts sent), **invites accepted** (tracks whose connection is `accepted`, or an acceptance recorded on a finished track), **messages sent** (message attempts sent), **failed** (failed results on LinkedIn steps), **replies marked** (leads whose first reply is on LinkedIn). Nothing claims delivery or reading.

## 9. Reads

Every hold and every wait goes through ADR 0003's one exhaustive mapping (`stepWhen`, `holdWait`). The LinkedIn additions:

- a message **awaiting acceptance** reads `{ kind: "waits", why: "awaiting_acceptance", until: <accept_by's wall instant> }`: a reason with the day the wait ends stated as a fact ("waiting for them to accept the invite; the wait ends Tue 24 Nov"), never as a promise of a send;
- an invite or a message waiting on time alone reads its earliest instant; ready when nothing of its own holds it; otherwise the reason with no time, as for email;
- a finished track reads its finish: `invite_not_accepted` ("The invite was not accepted within 14 days, so it was withdrawn") and the withdrawal's state;
- an invite read as sent says whether its note went (4).

`dependentStateOf`, `finishedStateOf` and every web wording switch take the new finish reason and wait, by their `never` checks.

## 10. Invariants and the generated test

### 10.1 Invariants (L1 to L10)

Asserted after every event by the LinkedIn generated runs, on the simulated provider's own logs where they say so:

1. **L1 One invite.** At most one invite is delivered per subject and profile, on the provider's delivery log, across retries, lost answers, crashes, restarts, edits and controls.
2. **L2 No message before a connection.** Every message the provider delivered for a subject's track came after that track's connection: an acceptance the provider logged before it, or an `already_connected` answer to the pre-send check.
3. **L3 Nothing after a marked reply.** After the user's mark is accepted, nothing more is handed over for that subject in that campaign except work already handed over before the mark.
4. **L4 A withdrawn invite is never followed by a message** on its track, and an invite whose acceptance wait ended is withdrawn: the provider's withdrawal log holds it within a settling period of the expiry while the session answers.
5. **L5 Allowances.** On the delivery log, per account and reset day, invites never exceed the invite allowance and messages never exceed the message allowance; per calendar month, invites with a note never exceed the note allowance.
6. **L6 Acceptance is not a reply.** No subject ends `replied` except by a reply mark the record made; acceptances change no status but by resolving a message's due time.
7. **L7 The note.** An invite carries its note exactly when its rendered note is not empty and the record's own count of the sender's notes that month was below the allowance at its handover.
8. **L8 The expiry is on time.** A track finishes `invite_not_accepted` exactly at the record's deadline: the invite's delivered send time plus the acceptance wait in calendar days in the prospect's zone, moved by every held interval; never while the record has an acceptance before it.
9. **L9 Already connected.** For a profile the session is connected to, no invite is handed over, and the first message is due at the pre-send check's instant plus its wait.
10. **L10 The other tracks carry on.** A LinkedIn track that finishes for any reason changes no other track's progress but by releasing what starts after it; a lead with another reachable channel is not ended by it.

ADR 0003's invariants 1 to 14 and 18 to 26 hold for LinkedIn steps too, and the runs assert them as the ticket 13 runs do for SMS: one status, nothing reaches the provider for a subject that does not run, at most one live and one sent attempt per step, sent at most once, attempts forward only, starts by rule, steps in order and on time, clocks freeze exactly, capacity per kind, in-flight and pacing, priority at the handover, windows, nothing dropped after the drain, good destinations only.

### 10.2 The generated test

`test/support/generated-linkedin.ts` with `src/server/sequence-runs-linkedin.test.ts`, its own record (`test/support/linkedin-model.ts`, which imports nothing from `src/domain/sequence/`) and its own mutations (`test/support/linkedin-mutations.ts`), on the real SQLite store, the real engine and the simulated LinkedIn provider beside the fake email and SMS ports.

- **Generated:** one or two campaigns sharing one or two LinkedIn sessions; a LinkedIn track (invite and one to three messages, acceptance wait 1 to 5 days, a note or none) and, in half the runs, an email or SMS track together or after it; people with and without a profile URL (a valid one, a company page, garbage); allowances (invites, messages, notes) from 0 to 4; real sending windows drawn as the control runs draw them (ADR 0003 "Reads that say when"), and zones London, New York and Sydney; pacing gaps of 5 and 30 minutes.
- **The provider, scripted per profile:** accepts after a delay (minutes to days), never accepts, already connected, refuses the profile (`invalid_destination`), refuses for a limit (`rate_limited`), loses an answer (the action done, the answer `unknown`, found by lookup), an acceptance reported late, a withdrawal answered `unknown` then `withdrawn`, a withdrawal that finds the invite accepted.
- **Events:** clock advances from seconds to days; lead and campaign pauses and resumes; stop and restart; the user's reply mark (accepted and refused); a crash between the handover commit and its answer; a session signing out for a while.
- **The record** keeps its own copy of each definition, each lead's held intervals and the provider's logs, and predicts each invite's note, each deadline (its own calendar-day arithmetic in the prospect's zone from the delivered send time), each first message's earliest instant (the acceptance or the check, plus its wait, then the window), each track's finish and the status.
- **Seeds and the search.** `pnpm check` runs fixed seeds (`LINKEDIN_FIXED_SEEDS`) and each mutation's recorded killing seed; the full search runs all 100 offsets in the `sequence-search` workflow's shards.

### 10.3 Mutations, one per invariant

Each must be killed by a recorded seed in `pnpm check`, failing the invariant it names:

| Mutation | Invariant |
| - | - |
| an invite claimed again after its work settled sent (the invite is not recognised as a resolved step) | L1 |
| the first message's due time resolved at the invite's send, not the connection | L2 |
| a reply mark recorded without ending the lead | L3 |
| the acceptance expiry finishes the track without wanting the withdrawal | L4 |
| the invite allowance ignored (every LinkedIn step counted as a message) | L5 |
| an acceptance applied as a reply | L6 |
| the note allowance ignored (every invite carries its note) | L7 |
| the deadline counted from the invite's handover, not its send | L8 |
| the pre-send check's `connected` ignored | L9 |
| the expiry ends the lead instead of finishing the track | L10 |

### 10.4 By construction

The connection, the deadline and the withdrawal state are stored once and only move forward (the store refuses a `connection` that changes once set, an `accept_by` that moves but by an edit's re-resolution, and a withdrawal state that moves back). A pending message has no due time until a connection is stored, so no claim can see it due. The note choice is stored with the work at the handover and never recomputed.

### 10.5 Nothing changes for email, SMS or calls

No rule of ADR 0003 is changed for a track that is not social: every new branch in the engine is taken only for a `linkedin` track or account. The evidence: one scripted campaign of email, SMS and phone tracks with no LinkedIn track (`scripts/no-social-digest.ts`), run on the integration tip and on this branch, gives identical provider handover and delivery logs and call lists (its digest is in the pull request).

## 11. Questions for the principal

Numbered on from ADR 0003's (Q33 was the last). Each names what is built meanwhile.

- **Q34. The note allowance's period.** LinkedIn documents a limited number of notes for free accounts without saying here over what period the user's allowance runs. *Built:* the calendar month in the user's zone. A rolling 30 days or a weekly count would be one change in one function (`notePeriodOf`).
- **Q35. A company lead on LinkedIn.** The businesses file's `linkedin_company` is a company page, and a page cannot receive a connection invite. *Recommendation and built:* a company lead's LinkedIn track is skipped as a missing channel, with the reason shown, as SMS does for a company lead (ADR 0003 Q10).
- **Q36. Withdrawals and the allowances.** Does withdrawing an unaccepted invite count against an allowance? *Built:* no; it takes no allowance and no pacing slot, as the engine's other withdrawals do. If wanted, a third daily allowance would hold them.
- **Q37. A message refused because the connection is gone.** The prospect removed the connection after accepting. *Built:* the track finishes `failed_bad_destination`, the profile not marked bad (it is still their profile), and the lead's other tracks continue. The alternative would be a new invite, which the decision does not describe.
- **Q38. An invite already sent when the user stops the lead.** *Built:* it stays sent and pending on LinkedIn; only an expiry withdraws an invite. Withdrawing on a stop too is one rule.
- **Q39. Marking a social reply when nothing was sent there.** *Built:* refused ("Nothing has been sent to them on LinkedIn in this campaign"), since no reply can answer nothing.
- **Q40. The acceptance wait in a test run.** ADR 0003 3.6 cuts every wait to a minute in a test. *Built:* the acceptance wait is not cut short, so the user has the track's whole wait to accept the test invite; the messages after it use the minute waits. A fixed test wait (an hour, say) would be one change in `waitSpan`'s caller.

## 12. What is unverified, and why

Verified with the simulated provider only (no LinkedIn session is connected, no test profile is designated, and the repository's rules allow neither a new account connection nor an unsolicited send):

- that a browser-session driver can perform each port action, and how a real session answers each (accepted, refused, unknown), including whether any action is safely retryable or a not-sent answer final (2.2);
- that an acceptance, a withdrawal and the connection state can be read from a session, and with what lag (an acceptance the platform reports late, after the expiry was judged, is recorded and starts nothing: a stated limit of 3.3);
- the platform's own limits and restrictions on the user's accounts: the allowances are the user's numbers, and nothing shows they are below LinkedIn's limits for that account;
- the note allowance against a real free account;
- ticket 24's "Test using the user's test profile, manually accepting the invite": needs a connected session and a designated test profile (#28);
- "the laptop is off": the rules are the engine's interruption rules, verified on the fakes; whether a session survives a sleep and stays signed in is unverified.

Nothing presents LinkedIn as a working integration: the running app's port lists no session, so a LinkedIn track cannot launch (blocker 3), and the simulated sessions exist only in tests.

## Consequences

- **ADR 0003.** `TrackChannel` and the account channel gain `linkedin`; `FinishReason` gains `invite_not_accepted`; `StepWait` gains `awaiting_acceptance`; a reply's channel gains `linkedin` (a mark only). Its section 11's "Social tracks" line is replaced by this ADR. Its question numbers continue here.
- **ADR 0001.** A LinkedIn profile is a contact fact of a person read from the import, not a `contact_details` row: it is never matched on, merged or searched. Its bad mark is kept by key.
- **Tickets 25 and 26** add their channel to the same unions, their destination rule (the decision maker's account, else the company's) to 5, and a message-only track to 3.1 (every step a `message`, the first a message request); they reuse 1, 2, 4's allowance mechanism without the note, 6, 7, 8 and 10 unchanged.
- **Ticket 27** attaches at `inviteExpired` (3.5).
