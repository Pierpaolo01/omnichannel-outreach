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

The second attachment point is the connection gate, `rules.connectionGate(track, stepId, progress)` in `progress.ts`: the one test of whether a step must wait for a connection, read by the due-time resolution (3.2) and by handover predicate 19. Today it holds every LinkedIn step after the invite until a connection is stored. Ticket 27 must make it let through the InMail step (which goes to a person who is not a connection) and nothing else: the first message and follow-ups stay gated, so a fallback never sends a connection message to a stranger (council on b21af02, item 9).

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
- **Which action spends which allowance, and when** (council on b21af02, item 4; the re-check of e261ffa, item 4). An invite spends one of the session's invites per day from its claim (a reservation), for good once its handover is sent or unsettled. Its note is decided at the handover, not the claim (section 4): from the handover it spends one of the session's notes per month, for good once the work is sent or unsettled. A refused or withdrawn-unsent invite gives back the invite, and the note if it had taken one. A first message or follow-up spends one message per day the same way. The connection check (`checkConnections`, run each settling period before any invite is claimed) and the pre-send check spend nothing and need no room: an existing connection is found and skipped as `already_connected` with the invite allowance at zero or used up, and its first message then waits only for the message allowance. A step whose kind of action every session it may use allows none of reads `sending_capacity`, never a time.
- **The connection check is per session** (review bot on e261ffa). A connection, an invite pending from elsewhere and "clear" are facts about one (session, profile) pair, so each session's answer is stored for that session (`connectionChecks`), each for a settling period. Before a sender is fixed, every healthy session of the pool is checked, in the pool's order. If any is already connected, that session becomes the sender and the first message follows: a connection is preferred to an invite from another session, so the invite is never claimed until every session has answered. With two connected sessions, the first in the pool's order is the one found first, and no later session is asked. Otherwise the invite goes from a session whose answer is clear, chosen by room as any step's sender is. The track holds as pending from elsewhere only when every healthy session it may use last answered pending. When some session is clear but has no invite room and another is pending, the track waits for capacity, because that is what holds it: the clear session can invite once it has room. Its read says `sending_capacity`. Once a sender is fixed, only that session is checked.

Priority: an invite to a new lead is a first contact; a message to a connected lead, or any step of a touched lead, is a follow-up. So messages go before invites when a session's slot is contested, then oldest due first, and what does not fit a reset day's allowance waits for the next, never dropped.

## 7. Replies

- **A new control, `mark_replied`, on a route of its own**: `POST /api/enrollments/:id/replies` with `{ requestId, channel: "linkedin" }`, through the store's `controlSubject` like every control, so its request id is bound to its first answer and body in the transaction that judges it, on the lead as of the action's instant (`asOfAction`). It is a control, not a provider event, because the user is the only source. It is not one of the reads' `LEAD_CONTROLS`, so no existing read, preview or generated control run changes; part b reads its refusal by the same function (`markRepliedRefusal`).
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

1. **L1 One invite per pair.** At most one invite is outstanding per (session, profile) across every campaign and test run, on the provider's delivery log: a second is delivered only after every earlier one was withdrawn and never accepted (question Q41). Each step is delivered at most once.
2. **L2 No message before a connection, any message.** No message step of a LinkedIn track, first or follow-up, after any skip, restart, resume or edit, is handed over (checked on the handover log, not only deliveries) before that track's connection: an acceptance the provider logged before it, or an `already_connected` answer to the pre-send check.
3. **L3 Nothing after a marked reply or a stop.** After the user's mark is accepted, or the lead is stopped, nothing more is handed over for that subject, on LinkedIn or by email.
4. **L4 A withdrawn invite is never followed by a message** on its track, and an invite whose acceptance wait ended is withdrawn: the provider's withdrawal log holds it within a settling period of the expiry while the session answers.
5. **L5 Allowances.** On the delivery log, per account and reset day, invites never exceed the invite allowance and messages never exceed the message allowance; per calendar month, invites with a note never exceed the note allowance.
6. **L6 Acceptance is not a reply.** No subject ends `replied` except by a reply mark the record made; acceptances change no status but by resolving a message's due time.
7. **L7 The note.** An invite carries its note exactly when its rendered note is not empty and the record's own count of the sender's notes that month was below the allowance at its handover.
8. **L8 The expiry is on time.** A track finishes `invite_not_accepted` exactly at the record's deadline: the invite's delivered send time plus the acceptance wait in calendar days in the prospect's zone, moved by every held interval; never while the record has an acceptance before it.
9. **L9 Already connected.** For a profile the session is connected to, no invite is handed over, and the first message is due at the pre-send check's instant plus its wait.
10. **L10 The other tracks carry on.** A LinkedIn track that finishes for any reason changes no other track's progress but by releasing what starts after it; a lead with another reachable channel is not ended by it.

ADR 0003's invariants 1 to 14 and 18 to 26 hold for LinkedIn steps too, and the runs assert them as the ticket 13 runs do for SMS: one status, nothing reaches the provider for a subject that does not run, at most one live and one sent attempt per step, sent at most once, attempts forward only, starts by rule, steps in order and on time, clocks freeze exactly, capacity per kind, in-flight and pacing, priority at the handover, windows, nothing dropped after the drain, good destinations only.

11. **L11 No pair ever moves.** Every action to a (session, profile) belongs to the first subject that acted there, until that subject's invite was withdrawn unaccepted with no message.
12. **L12 A reply is the owner's.** A reply is marked only on a subject something reached on LinkedIn; the skipping campaign's mark is refused.
13. **L13 Nothing pending for ever, on every channel.** After the drain, every pending step of a running lead has a due time, a hold with its reason, or a LinkedIn acceptance wait; and none has been due for days with nothing holding it (a lead left waiting on a taken pair). Every hold is one the record derives itself (an invite pending from elsewhere, work whose outcome the session never told or a crash left unresolved, another subject's unsettled first action on the pair), never the engine's word; and a step whose kind no session allows reads `sending_capacity`.
14. **L14 A removed connection keeps the profile** (Q37): a message refused because the connection is gone never marks the profile bad.
15. **L15 A release frees the pair** (Q41): a LinkedIn track is skipped as taken only while, on every session its campaign's pool had at that instant, another subject held the conversation by the record's rule (nothing went and nothing is unknown, or every invite withdrawn, by the session or by the user's hand and mark, never accepted and no message: released).
16. **L16 Each handover on its own channel, from the expected sender.** Every LinkedIn handover is on the LinkedIn track, to a profile the person has had, an invite from a session in its campaign's pool at that instant, a message from the session of its own conversation (the delivered invite's sender, or the check that found it connected); every text is on the SMS track, from the SMS number, to the person's mobile. In the SMS track runs, every started LinkedIn track beside SMS is handed its invite from the session by the drain.

17. **L17 A track is never held on one session's answer while another session of its pool could act** (review bot on e261ffa): held as pending from elsewhere only while every healthy session it may use has an invite pending there, and never left at its invite while one of them is already connected. Asserted on profiles no other subject shares, since another subject's pair takes a session out.

L1 also holds for an invite pending from elsewhere (Q42), per session: none is ever handed over from a session where one is pending. An invite counts as withdrawn when the session answered so, or when the user withdrew it by hand and marked it withdrawn (seed 24073); L11's release follows the same rule. L15 grounds a skip only while the owner's conversation is known: not while the owner's invite is being withdrawn (seed 24046). The record freezes a lead's clock over a stop later restarted, as over a pause (3.4; seed 24093), and judges a step's room only on the sessions whose pair no other subject holds (seed 24069). L8 is asserted at the expiry and at each edit of the wait, for every lead still waiting, with the record's own deadline (no edit, held or not, is exempt). L12 counts as reached only a delivery or a handover whose outcome was still untold at the mark: a refused handover or a connection the check found is not outreach.

### 10.2 The generated test

`test/support/generated-linkedin.ts` with `src/server/sequence-runs-linkedin.test.ts`, its own record (inside `generated-linkedin.ts`, with the calendar arithmetic of `test/support/sequence-model.ts`; it imports nothing from `src/domain/sequence/`) and its own mutations (`test/support/linkedin-mutations.ts`), on the real SQLite store, the real engine and the simulated LinkedIn provider beside the fake email and SMS ports.

- **Generated:** one or two campaigns sharing one or two LinkedIn sessions; a LinkedIn track (invite and one to three messages, acceptance wait 1 to 5 days, a note or none) and, in half the runs, an email or SMS track together or after it; people with and without a profile URL (a valid one, a company page, garbage); allowances (invites, messages, notes) from 0 to 4; real sending windows drawn as the control runs draw them (ADR 0003 "Reads that say when"), and zones London, New York and Sydney; pacing gaps of 5 and 30 minutes.
- **The provider, scripted per profile:** accepts after a delay (minutes to days), never accepts, already connected, refuses the profile (`invalid_destination`), refuses for a limit (`rate_limited`), loses an answer (the action done, the answer `unknown`, found by lookup), an acceptance reported late, a withdrawal answered `unknown` then `withdrawn`, a withdrawal that finds the invite accepted.
- **Events:** clock advances from minutes to days; lead pauses and resumes; campaign pauses and resumes; stops, and restarts of stopped leads from their next step; skips at every state (an invite not sent, a message waiting for acceptance, a follow-up); the user's reply mark (accepted and refused); the laptop off with a restart; a crash between a handover's commit and its call; a session signing out for hours; running edits (the acceptance wait changed; a message inserted, removed or two reordered); pool edits that add or remove a session; a re-import that gives a person another profile; a person of the first campaign imported into the second later, after the first's invite was withdrawn (the pair released) or while the first owns it; the user's mark of unresolved work on every channel, by what the provider did; a withdrawal the session keeps answering unknown, listed in Needs attention, withdrawn by the user's hand and marked withdrawn; and two campaigns sharing people on one session. The later events draw from a stream of their own.
- **Sessions, from the second stream** (review bot on e261ffa; the re-check of e261ffa, item 3): a third session in half the runs with two, in a pool of three; answers that differ by session (an invite pending from elsewhere, or a connection, on one session of the pool only); and, in a share of runs, a session whose own id is the SMS number's, kept apart as two accounts.
- **Allowances and scripts, from the second stream:** a session's invite or message allowance at zero; an invite already pending from elsewhere (Q42); a connection removed after acceptance (Q37); an SMS track beside the LinkedIn one, at entry or after it, with every person's mobile, so the person's mobile and profile are pairs of two channels.
- **Not drawn here, and where each is covered instead:** test runs (`linkedin.test.ts` "a test run", `linkedin-review.test.ts` items 1 and 13, and the test-run runs of ADR 0003); call tracks beside LinkedIn and a LinkedIn track in a win-back branch (the engine's call and branch rules take no LinkedIn branch; the re-check of `b21af02` ran both by hand; no example test pins them yet); a LinkedIn track after a text on the same person is also drawn in the SMS track runs (`generated-tracks.ts`, `linkedinBesideSms`, invariant L16 there): in 60% of runs, a campaign of its own people, number and session, in an engine of its own under the run's rules and mutation, because a campaign in the same engine moves state every campaign shares (the conversations' version the readiness caches key on) and so changed the modelled runs and two of their mutations' seeds. A LinkedIn track inside the SMS record's own campaigns is not drawn: a profile is a usable channel, which would change what that record predicts for every lead.
- **The record** finds an existing connection from the simulated provider's own check log, which names the subject that asked (a "connected" answer before any invite of its own went; the re-check of dd3969c, item 5), never from the engine's stored connection. It keeps its own copy of each definition, each lead's held intervals and the provider's logs, and predicts each invite's note, each deadline (its own calendar-day arithmetic in the prospect's zone from the delivered send time), each first message's earliest instant (the acceptance or the check, plus its wait, then the window), each track's finish and the status.
- **Seeds and the search.** `pnpm check` runs fixed seeds (`LINKEDIN_FIXED_SEEDS`) and each mutation's recorded killing seed; the full search runs all 100 offsets in the `sequence-search` workflow's shards.

### 10.3 Mutations, one per invariant

Each must be killed by a recorded seed in `pnpm check`, failing the invariant it names (seed offsets from 24000, found over offsets 0 to 29 on 16 November 2026 after the review of `e261ffa`):

| Mutation | Invariant | Seed |
| - | - | - |
| an invite waiting for acceptance is offered as ready and sent again | L1 | 0 |
| the first message's due time resolved at the invite's send, not the connection | L2 | 0 |
| a reply mark recorded without ending the lead | L3 | 4 |
| the acceptance expiry finishes the track without wanting the withdrawal | L4 | 0 |
| the invite allowance ignored (one bucket for every LinkedIn action) | L5 | 0 |
| an acceptance applied as a reply | L6 | 0 |
| the note allowance ignored (every invite carries its note) | L7 | 0 |
| the expiry finishes the track at the instant evaluated, not at its deadline (the laptop off across a deadline shows it) | L8 | 10 |
| `connected` ignored, by the connection check (taken as clear) and by the pre-send check | L9 | 1 |
| the expiry ends the lead instead of finishing the track | L10 | 0 |
| the connection gate covers only the first message | L2 | 24 |
| a LinkedIn pair owned by another subject is ignored (in evaluation, the connection check, the account choice and the handover, and the session's "pending" for the owner's own invite with it) | L11 | 10 |
| a reply marked where nothing reached the person | L12 | 0 |
| a taken LinkedIn pair is held, not skipped | L13 | 11 |
| a pending invitation from elsewhere is sent again | L1 | 0 |
| a removed connection marks the profile bad | L14 | 16 |
| a withheld release (the release rule leaves every pair taken) | L15 | 0 |
| an edited wait keeps the old deadline | L8 | 6 |
| a binding lookup ignores the channel (the LinkedIn session taken from any pair the subject owns) | L13 here (the invite waits for ever on the SMS number); L16 in the SMS track runs, seed 3 from their SEED | 11 |
| a check's result is stored for the track, not the session (and asked of the first healthy session only) | L17 | 2 |

The connection check pass is a layer the first mutations did not reach, so it is a `Rules` entry (`connectionCheckDue`, `connectionChecked`) and the L9 and L11 mutations swap it as well.

### 10.4 By construction

The connection, the deadline and the withdrawal state are stored once and only move forward (the store refuses a `connection` that changes once set, an `accept_by` that moves without its `accept_by_days` changing, and a withdrawal state that moves back). The deadline is stored with the wait it was resolved from (`accept_by_days`, migration 22): an edit re-resolves it only when the definition's wait differs from that stored wait, so a later write never moves an edited, already-passed deadline again (council on b21af02, item 8). Pair keys never coincide across channels (a session is not a number, a profile is not a mobile), so a per-channel filter on reads that match both sender and recipient is defence in depth; the reads that match on the owner alone are the ones a mutation can break, and L16 kills it. A pending message has no due time until a connection is stored, so no claim can see it due. The note choice is stored with the work at the handover and never recomputed.

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

- **Q41. A second campaign meeting a person another campaign already reached from the same session.** *Built:* as for SMS (ADR 0003, Q7 answered): the pair belongs to the first campaign known to have reached the person; the second skips its LinkedIn track for them, naming the owner; it waits while the first's invite is unknown; the pair is released if nothing went, **and also when the first campaign's invite was withdrawn and never accepted**, after which the second campaign may invite. While the first's invite is being withdrawn (its wait ended, the session not yet answered), its fate is unknown, so the second waits under the same hold and is never skipped (seed 24046): withdrawn, the pair is released and the second invites; accepted first or kept on LinkedIn by the user, the second is skipped then. LinkedIn may itself refuse a new invite soon after a withdrawal; a refusal would be the port's to report.
- **Q42. One person and several of the user's LinkedIn accounts.** The application treats a connection, an invite and a conversation as belonging to one of the user's accounts and one person (one pair), not to the person. That allows two things the principal has not seen:
  - **Two invites to one person.** The user has sent an invite to Pat by hand from account s1, and it is still pending. A campaign whose pool is s1 and s2 never invites Pat again from s1, but it does invite Pat from s2, if s2 is clear and has room. Pat then has two pending invites from two of the user's own accounts.
  - **Two threads with one person.** Pat is already connected to both s1 and s2. Campaign A has s1 in its pool and campaign B has s2, so each takes its own pair. Pat then receives messages from both campaigns, from two accounts, in two threads.

  *Built (per session):* each pair is its own conversation, as section 6 and L1 state. Options for the principal:
  - as built: per session;
  - one person reached from at most one of the user's accounts across the pool: the first pair taken holds the person for every account, so another account neither invites nor messages them, and a track would skip or hold as it does for a taken pair.

  **The check's cost**, also the principal's to weigh. A track waiting on a pending invite checks every session it may use once each settling period (15 minutes), while its window is open: up to 96 checks a day per session, for as long as it waits. With a real session, reading a person's profile that often is a risk to the account. The settling period is the interval, and the application sets no limit on how long a track may wait on a pending invite. Both the interval and such a limit are settings to decide. *Built:* the settling period, and no limit. Nothing here changes behaviour until the principal decides.

## 12. What is unverified, and why

Verified with the simulated provider only (no LinkedIn session is connected, no test profile is designated, and the repository's rules allow neither a new account connection nor an unsolicited send):

- that a browser-session driver can perform each port action, and how a real session answers each (accepted, refused, unknown), including whether any action is safely retryable or a not-sent answer final (2.2);
- that an acceptance, a withdrawal and the connection state can be read from a session, and with what lag (an acceptance the platform reports late, after the expiry was judged, is recorded and starts nothing: a stated limit of 3.3);
- the platform's own limits and restrictions on the user's accounts: the allowances are the user's numbers, and nothing shows they are below LinkedIn's limits for that account;
- the note allowance against a real free account;
- ticket 24's "Test using the user's test profile, manually accepting the invite": needs a connected session and a designated test profile (#28);
- "the laptop is off": the rules are the engine's interruption rules, verified on the fakes; whether a session survives a sleep and stays signed in is unverified.

Nothing presents LinkedIn as a working integration: the running app's port lists no session, so a LinkedIn track cannot launch (blocker 3), and the simulated sessions exist only in tests.

## The review of `194fc44` (council, review bot and verifier, 16 November 2026)

Fifteen items, each reproduced first as a failing test through HTTP (`src/server/engine/linkedin-review.test.ts`) unless it says otherwise.

1. **One conversation per (session, profile), owned by the first subject known to have reached it** (question Q41's interim). The SMS binding machinery is generalised to *a conversation between a sender account and a destination* (ADR 0003 4.5, "Question Q7 answered"): one predicate, `holdsConversations` (SMS and LinkedIn), gates every rule that was SMS's: the candidates (`candidatesFor`), handover predicate 11, the binding taken in the handover's own write, the skip for a taken pair (`skipTakenConversations`, its cause stored and naming the owner), the hold while the owner's first action is unknown (`sms_conversation_unsettled`), the release when nothing went (`bindingUnsent`), the endings (`conversationLost`), the caches' one key (`conversationsVersion`, `sameConversations`). The table and the API names keep `sms` in them; they mean both channels. For LinkedIn: the binding is also taken by the already-connected skip, in the same write; and **a withdrawn, never-accepted invite leaves no conversation**, so the pair is released and another campaign may invite. **"Already connected" now means a connection that existed before this application reached that person**: a pair this application reached is never claimed by another subject, so its pre-send check never sees that connection. The pre-send check gains **`pending`**: an invite already outstanding, which by the same rule only someone outside the application can have sent; it is never sent again. *Interim (question Q42):* the invite is held (`invite_pending_elsewhere`) and checked again each settling period; once the person accepts, the check answers `connected` and the invite is skipped as already connected. A reply marked on the skipping campaign's lead is refused (nothing reached them there, Q39).
2. **The generated runs do what 10.2 says:** the events listed there are generated; L11 to L13 and their mutations added; the record models campaign pauses, stops, edits of the wait and the user's marks. The no-change script prints its call lists (ten) and outcomes (three) apart; its digest is equal on `3be5674` and this branch.
3. **An edit of the acceptance wait** re-resolves the deadline of every lead still waiting, from the invite's send point (`realignAcceptance`, run by `alignPending`); a new deadline already passed is the edit's instant, so the track expires once at the next evaluation. The edit preview has the change kind `accept_wait`.
4. **Reads:** each LinkedIn track's read carries `linkedin`: the note as it went, the connection and when, the acceptance (also on a finished track: `acceptedAfterFinish`), the withdrawal's state, an invite still open, a pending invite seen elsewhere. A reply's channel is worded through one exhaustive mapping (`REPLY_WORDS`); the LinkedIn reply is "Marked replied on LinkedIn by you" in the next-step sentence and Activity.
5. **A withdrawal that keeps answering unknown** is listed after three answers (`inviteWithdrawalsUnknown` in Needs attention); the user marks it withdrawn or still there (`POST /api/enrollments/:id/invite-withdrawal`; `kept_by_user` stops the asking and keeps the pair). Any other LinkedIn action left unknown is unresolved work, listed with the rest and marked by the user (ADR 0003 5.3).
6. **An invite still open on an ended lead** is in the read (`inviteOpen`), so a stop's confirmation and the record can say so.
7. **The mark takes `expect`** (the status the read showed), checked in the transaction of its request id against the lead as the read showed it (`markPrecondition`, after the mark's own rule, as every control). It is refused when nothing reached the person: work known sent, or handed over and unsettled; a refused invite counts as nothing.
8. **The port contract** says an acceptance's time may be the time observed, an upper bound. The call-attempt detail triggers accept no profile id.
9. **The connection gate is the connection's:** no LinkedIn message, first or follow-up, has a due time or passes the handover (predicate 19) before a connection is stored. Skipping a message while waiting skips it and the next one keeps waiting; **skipping an invite not sent** leaves no invite and no connection, so the track finishes `skipped_by_user` and releases what waits on it. L13 asserts that nothing is left pending with nothing that can make it due.
10. **The connection's session is the sender:** the track's LinkedIn sender is the session of its own pair (`linkedinSessionOf`), one fact with the binding. A fixed sender that is full, signed out or removed from the pool keeps it: the track waits for it (ADR 0003 5.2: a fixed sender never changes).
11. **The acceptance read** gives every hold first, with no time; while waiting and running, the day the wait ends is the deadline on the lead's clock now.
12. **A person whose only channel is a member profile is enrolled** (`decisionMakerReach` with `usableProfile`, the one normaliser; a company page or a profile marked bad is not a channel). The import summary, the unenrolled reason and re-import read the same rule. A CSV with an empty `linkedin_url` column imports as before (the import generated runs on their fixed seeds).
13. **A test run's reply** is marked through `POST /api/test-runs/:id/replies`, the same transition, binding and confirmation; it ends only that test, and the measures count it as test.
14. **Step numbers** in reads count from 1 over the steps the track has now (`stepNumber`); a pending message an edit removed moves to the next live one.
15. **The description** marks each criterion verified on the simulated provider, left for part b, or unverified.

## The second pass on `b21af02` and its re-check (council, review bot and re-check, 16 November 2026)

Twelve items. Each real bug is reproduced through HTTP first (`linkedin-review.test.ts`, "the second pass on b21af02"), or in the wording tests for item 1.

1. **A conversation in its own channel's words.** Every sentence about a taken or unsettled conversation comes from one table over every track channel (`CONVERSATION_WORDS` in `sms-wording.ts`), and every caller passes the track's channel, required: no read and no caller falls back to SMS. The read's `waits` and the held tracks and dependent skips of Needs attention and Activity now carry their channel, required. A reply marked on LinkedIn says "Carry on the conversation on LinkedIn" in Activity. `conversation-wording.test.ts` runs each of the nine sentences the re-check reported on a LinkedIn read. *Follow-up, not done here:* the stored reason ids and API fields keep "sms" in their names (`skipped_conversation_taken` for both channels is fine; `sms_conversation_taken`, `sms_conversation_unsettled`, `smsBindings`, `sms_bindings` are not); renaming them is a migration and an API change for part b or later.
2. **Pending from elsewhere and a removed connection are drawn**, with L1's extension and L14, and a mutation each.
3. **Bindings carry their channel** (`sms_bindings.channel`, from the sender account's channel), and every function reading them reads one channel's (`pairsOn`): `pairFree`, `otherBinding` (the taken-pair test), `linkedinSessionOf`, the release (`releaseUnsentBindings`, over the subject's own pairs of either channel, each judged by its own work), the reply attribution (`smsReplyOwner`, over the store's `smsBindingsOf`, which returns SMS pairs only). A LinkedIn pair cannot affect an SMS track, nor an SMS pair a LinkedIn one. Tests: SMS then LinkedIn, LinkedIn then SMS, and one person in two campaigns, one owning the SMS conversation and the other the LinkedIn one, each skipping only its own channel's track, with a text reply attributed among SMS pairs only.
4. **An existing connection needs no invite allowance** (section 6): the connection check runs outside every allowance.
5. **The mark with nothing reached is refused**, for leads and test runs: it requires this subject's own work, sent or handed and unsettled; a connection the check found is not outreach.
6. **The runs draw what they claim**: 10.2 lists exactly what is drawn and what is not.
7. **Every write applies the release rule.** The store's one subject write (`write` in `sqlite-engine-store.ts`) applies `releaseRule`, which the engine sets to its own `rules.releaseUnsent`: the engine's updates, each lead control, the user's attempt marks, the reply marks, the invite-withdrawal mark, an edit's reconciliation, Run test and a campaign pause or resume, and (the re-check of e261ffa, item 5) the catch-up after a change of the call settings or the user's zone (`catchUpWithin`), every lead's entry at launch, and stopping a test run during an edit or an import. Each goes through that one writer, so the release rule applies on each. The user's "withdrawn" mark of a stuck withdrawal releases the pair in its own write; the runs draw it, then another campaign reaching that profile.
8. **The deadline is stored once, with its wait** (10.4).
9. **`connectionGate` is ticket 27's second attachment point** (3.5).
10. **Q42's pending invite, a release followed by another campaign inviting, and the pool edits** are drawn. A LinkedIn track in a win-back branch is not (10.2).
11. **The stuck-withdrawal entry in Needs attention** carries the lead, company and campaign every other entry carries.
12. **The record asserts each point itself**: at a release (L15), at each edit of the wait (L8), each hold (L13), and the sender and channel of every handover (L16); L12 no longer excuses a handover that was refused. "A withheld release" and "an edited wait keeps the old deadline" are now mutations killed by recorded seeds. The leftover probe file is gone.

What the new draws found in the engine, fixed here: an invite pending from elsewhere was not held between two checks outside its window (it is now held until a check finds it gone); and a LinkedIn step whose kind no session allowed read a time it could never keep (it reads `sending_capacity`). And in the record, fixed: a re-import that replaced a connected profile, a rate-limited invite retried from another session, and a request a crash failed after its write committed.

## The conversations' version (the re-checks of dd3969c, item 1, and of 8c85b2f, items 1 and 3)

Every cache that skips work while "nothing changed" keys on the conversations' version too: the worker's evaluation and readiness caches, and the projection's. Four times a cache outlived a change of conversations, because the version was a list of events someone remembered to include. It is now made by construction. The database moves the version itself, by trigger, in the same write, on every write to a fact a pair's ownership or knownness is read from, whatever wrote it.

**The inputs, written down once** (`CONVERSATION_INPUTS` in `sqlite-engine-store.ts`, with the columns the ownership query reads):
- the pair rows (`sms_bindings`, every column);
- the owner's provider work (`provider_work`: subject, account, destination, `settled`, `sent_wall`);
- the owner's track progress (`track_progress`: subject, `connection`, `destination_detail_id`, `invite_withdrawal`, `accepted_wall`);
- the owner's ending and identity (`enrollments` and `test_runs`: `ended`, campaign, person or test profile);
- replies (`reply_events`: state, number, mobile, time).

An insert or delete of a row moves the version; an update moves it only when it changes one of those columns. The ownership query (`CONVERSATION_PAIRS_QUERY`) reads exactly these, and otherwise only names and the lead's destinations (`CONVERSATION_LOOKUP_TABLES`). A test fails if any of these holds:
- the query reads a table that is neither an input nor a lookup;
- an input has no trigger;
- a listed column is not one the query reads;
- an update trigger watches other columns than its list.

**Per destination, not global** (the re-check of 8c85b2f, item 1). A single counter made every pair-owning subject's cached answer go stale on any one subject's write: at 2,000 leads with an SMS pair each, a tick after 20 progress writes read 3,998 subjects. The version is now one counter per mobile or profile (`conversation_versions`), and each write moves only the destinations it belongs to:
- a pair row moves its recipient;
- an owner's work, progress or ending moves the recipients of the pairs that subject owns (`sms_bindings_by_owner` is the index for it);
- a reply moves its address.

A cached evaluation remembers the versions of its own destinations only: its lead's mobiles and profiles, and where its attempts went (`conversationKeysOf`). Another subject's write moves it only through a pair on one of those destinations. The engine reads all versions once per pass, so each subject's check is in memory. The projection, which builds its own world, keeps one version for every pair.

**Tests and mutations.** The generated LinkedIn runs assert invariant 29 (a fresh engine on the same store at the same instant finds nothing to change or hand over) as the track runs do. Two mutations break it:
- "the conversations' version ignores every change": seed 11 in the LinkedIn runs;
- "a change to another subject's pair on the same destination does not invalidate a waiting subject" (a cache remembering only the destinations of pairs it owns): seed 11 in the LinkedIn runs, seed 50 in the track runs.

The re-check's acceptance-during-a-withdrawal scenario is a test through HTTP; it fails on `dd3969c`'s version.

**What the per-push set checks, and what only the search does.** A fresh engine per comparison doubles a run's engine work. With it after every tick, the per-push check outgrew CI's 40-minute job on `8c85b2f`. So:
- **`pnpm check`'s fixed LinkedIn seeds** compare after every 10th worker tick, and after every tick that moved a conversation's version (`freshEvery` 10, `FRESH_EVERY` in `linkedin-chunks.ts`).
- **The two mutations that break invariant 29** are replayed with a comparison after every tick, on their recorded seeds.
- **Other mutations' replays** make no comparison, since they target other invariants.
- **The full search** (CI's `sequence-search` shards) compares after every tick, on every seed.
- **The track runs** compare after every tick, as before.

## The review of `e261ffa` (review bot, search and re-check, 16 November 2026)

1. **The connection check per session** (review bot, blocking). Section 6 states the rule. Each session's answer is stored for that session (`connectionChecks`, migration 22), so nothing learned about one session's pair stops another eligible session from being considered while the track has no fixed sender. The simulated provider answers per session (`ProfileScript.sessions`). Tests through HTTP: the bot's two reproductions; a connected session preferred to inviting from a clear one, and two connected sessions; the pending hold only when every session is pending; and a clear session out of invite room beside a pending one, which waits for capacity. The runs draw pools of two and three sessions with answers that differ by session; invariant L17. Mutation: "a check's result is stored for the track, not the session", killed at seed 2. Answers that differ by session are drawn mostly on the pool's first session: the one a check kept for the track would ask, the case it gets wrong.
2. **One notice per channel** (review bot, follow-up). Held tracks in Needs attention are grouped by campaign, reason and channel, and the item's key carries the channel, so a LinkedIn hold and an SMS hold sharing `sms_conversation_unsettled` are two notices, each in its own words. Tested in both orders.
3. **A pair's channel is stored, and an account is its channel and its id** (re-check, blocking).
   - **Pairs:** migration 23 stores each pair's channel when it is taken (`sms_bindings.channel`, existing pairs `sms`), and a trigger refuses any change. Every query on pairs reads the stored channel; none reads the sender account's row.
   - **Accounts:** a sender account's channel never changes either, by trigger, and an upsert never writes it.
   - **Identity:** the app knows every LinkedIn session as `linkedin:` and the session's own id (`namespacedLinkedinPort` at the port boundary). The port keeps its own ids, and email addresses and E.164 numbers cannot take that prefix, so the same raw id on two channels is two accounts.
   - **Tests:** the re-check's reproduction through HTTP. An upgrade of a database as the integration tip left it, built in the test: the tip's schema (migrations 1 to 21, which this branch does not touch) and the rows the tip's own code wrote, as statements readable in a diff (`migration-23.test.ts`). It is opened beside a LinkedIn session with the number's id.
   - **Insert-time protection** (the re-check of dd3969c, item 3): an `INSERT OR REPLACE` on a pair's or an account's key that would change its channel is refused before the old row is removed. Tested.
   - **Runs:** the LinkedIn runs draw a session whose own id is the SMS number's, under L16.
4. **Section 6's allowance timing** now says the note is decided and counted from the handover, as section 4 and the code have it.
5. **Write paths:** the catch-up after a change of call settings or zone, entry at launch, and stopping a test run during an edit or an import are added to the list in item 7 of the second pass. Each goes through the one subject writer, so the release rule applies on each.

**The search's four failing seeds**, each reproduced on `e261ffa` before any change:

| Seed | Report | Which side was wrong | Change |
| - | - | - | - |
| 24046 | a lead skipped as taken though the record found the pair free | The engine followed the stated rule, and the record mis-ordered one instant. In the 05:00 round the owner's invite expired (withdrawal wanted), the second lead was evaluated in the same pass and skipped on a pair still owned, and the withdrawal answered "withdrawn" in the next pass. But the rule allowed a final skip against a conversation already ending. | The engine: an owner's invite being withdrawn is no known conversation, so the second lead waits under the unsettled hold and is never skipped (Q41). Two tests through HTTP, failing without it: withdrawn, the second invites; kept, the second is skipped then. The record's L15 and L13 follow. |
| 24069 | an invite due for weeks with nothing holding it | The record. The session li-a was blocked for four days by another subject's invite left unresolved by a crash, holding li-a's one in-flight place until the generated user marked it (ADR 0003's rule). From the 7th, li-a's pair was that subject's, and li-b's invite allowance was the user's zero, so the read's `sending_capacity` was true. The record counted li-a's room though its pair was another's. | The record judges room only on sessions whose pair no other subject holds. Not the review bot's state: no session's check answer is involved. |
| 24073 | an invite from li-a while another's was outstanding, to a pair it owned | The record. The owner's withdrawal was stuck; the user withdrew it by hand on LinkedIn and marked it withdrawn at 12:00, which releases the pair at once (item 7 of the second pass); the second campaign invited at 13:00. The record's L1 and L11 counted only the session's withdrawal answers, not the user's. | L1 and L11 count the user's hand withdrawal and mark, as the release rule does. The state is pinned by the example test of item 7. |
| 24093 | an expiry eight days after the record's deadline | The record. The lead was stopped for 64 hours and restarted from its next step, then paused twice (33 and 108 hours). A stop freezes the lead's clock as a pause does (3.4), and the engine's expiry is exactly the deadline moved by all three. The record froze only the pauses. | The record counts a stop later restarted as a held interval. |

**The local run of offsets 30 to 99** (unmutated, before the push) failed on four more, each found the same way:
- **24035 and 24071 (L15): the record.** The owner's invite had been accepted (in 24035 its message was then refused because the connection was removed), so the conversation was known and the skip was right. The record's new "being withdrawn" test missed the acceptance.
- **24094 (L13): the record.** One session was pending from elsewhere with invite room; the two clear sessions had the user's zero. By section 6's rule the track waits for capacity, and the read said so. The record counted the pending session's room, though no invite goes from it.
- **24062 (L13): the record as in 24094, and an engine read.** Outside the window the checks age unasked, and the read went back to judging room over every session, promising the next opening for an invite that can never go. A read now judges room on every session's latest answer (`inviteSessions`), while a claim still waits for fresh answers. A test through HTTP fails without the change.

The run was clean after these. They ran in the fixed seeds for one push, and since the re-check of `8c85b2f` they run in the search only, to keep `pnpm check` inside CI's job: three were the record's errors, and 24062's engine change has its own test through HTTP.

One more found locally while drawing restarts: offset 29, L3. The record held that nothing follows a marked reply, but a lead marked replied may be restarted from its next unsent step (ADR 0003, "for a lead that replied or was stopped"), and the engine did that. The record wrong; L3 now asks nothing after a mark only until a restart after it.

The four are in the fixed seeds (5, 8, 18, 29, 46, 69, 73, 93), each passing for the reason in the table.

## As built (part a, 16 November 2026)

- **Code.** `src/domain/linkedin-profile.ts` (the URL rule); `definition.ts` (`linkedin`, `acceptWaitDays`, `linkedinPool`, `linkedinStepKind`, the validator); `progress.ts` (the LinkedIn section: `awaitingAcceptance`, `acceptDeadline`, `connect`, `recordAcceptance`, `inviteExpired`, `inviteAlreadyConnected`, the withdrawal answer); `dispatch.ts` (`forAction`, the kind's view of an account; `noteFor`, decided in `handOver`; the `awaiting_acceptance` read); `controls.ts` (`markReplied`); the engine's LinkedIn port, event, pre-send and withdrawal passes; migration 22; `rulesWith` (`rules.ts`), so a swapped `inviteExpired` is the one every evaluation applies, in the engine and in the reads.
- **Routes.** `POST /api/enrollments/:id/replies`, `PUT /api/sender-accounts/:id/allowances`, `GET /api/linkedin-provider`, and the test profile (`linkedin`) on `PUT /api/campaigns/:id/test-contacts`.
- **Tests.** `src/domain/linkedin-profile.test.ts`; `src/server/engine/linkedin.test.ts` (invite with note, acceptance, follow-ups; already connected; the expiry with withdrawal and the track after it; a late acceptance; missing and unreachable profiles; allowances and the note; the reply mark; the running app's blocker 3); the generated runs `test/support/generated-linkedin.ts` with mutations in `test/support/linkedin-mutations.ts`, each killed by its recorded seed offset from 24000 (10.3's table). Fixed seeds 5, 8, 18, 29, 46, 69, 73 and 93 reach every behaviour the runs name (`LINKEDIN_FEATURES`); one more (`unresolved-marked-sent`) is pinned by an example test. The connection gate is one function (`connectionGate`), read by the due-time resolution and by handover predicate 19; the pre-send check's `pending` is a second layer (`outstandingInviteStops`), so the mutations of the first layer turn it off too.
- **L2 is checked on the handover log**, not only deliveries: the simulated platform refuses a message to a non-connection, so a broken engine's early message never lands, and the invariant is that the engine never asks.
- **Two holes the first runs found and the record now models:** the acceptance deadline was neither a wake of the worker nor a horizon of its evaluation cache, so an expiry waited for an unrelated tick (`settledEvaluation` and `nextWakeAt` now include it); and the record's held-time arithmetic had to walk the holds forward (`afterHolds`) rather than iterate.
- **Not built in part a:** the canvas, the record's screens and the measures panel (part b); a test run's tab line for awaiting acceptance (the read gives the reason; part b words it).

## As built (part b, 17 November 2026)

The screens for what part a built, on the simulated provider; no engine behaviour changed.

- **Reads added** (none changes a rule): `EnrollmentRead.linkedinReply` and `TestRunRead.linkedinReply`, the mark's own transition (`rules.markReplied`) on a copy of the subject as of the read (`linkedinReplyView`), so the read's refusal is the action's; `TestRunRead.status`, which the run's mark sends as its expectation; `TestRunTab.contacts.linkedin`, `linkedinIsALead` and `TestRunRead.linkedin`; `TestStepRow.until` with `awaiting_acceptance`; `BeforeLaunchView.coverage.linkedin` and `PreviewLead.linkedin` (`goodProfile`); `WithheldTrack.why` `not_modelled`.
- **Part a gaps found and fixed**, each with a test that failed first (`src/server/linkedin-screens.test.ts`, `src/web/campaign/linkedin-wording.test.ts`, `src/shared/track-label.test.ts`): Activity left LinkedIn tracks out entirely (and its missing-channel reason would have read "No mobile of their own"); Copy for a lead served LinkedIn steps as emails; `toTestRun` dropped the test profile, so the tab read it as none; a LinkedIn step waiting for capacity read "their due  waits" on Today; "LinkedIn track" was lower-cased to "linkedIn track" mid-sentence; a test run's marked reply was counted as a lead in the measures line.
- **Not fixed, reported:** the daily-load projection does not model LinkedIn. Its per-lead account key reads the email and SMS pools only, and it does not run the connection check, so it never hands an invite over and would report that leads never start. Until it does, a live LinkedIn track withholds the figure (`not_modelled`), said as such.
- **Step names** by role from the step's number (`LINKEDIN_STEP_KIND_AT`, `stepTitle` in `src/shared/track-label.ts`), held equal to `linkedinStepKind` at every position by a test.
- **The LinkedIn pool follows the connected sessions** in the editor's one pool sync, as the email and SMS pools do, written only once a session is connected or the definition holds a pool already.

## Consequences

- **ADR 0003.** `TrackChannel` and the account channel gain `linkedin`; `FinishReason` gains `invite_not_accepted`; `StepWait` gains `awaiting_acceptance`; a reply's channel gains `linkedin` (a mark only). Its section 11's "Social tracks" line is replaced by this ADR. Its question numbers continue here.
- **ADR 0001.** A LinkedIn profile is a contact fact of a person read from the import, not a `contact_details` row: it is never matched on, merged or searched. Its bad mark is kept by key.
- **Tickets 25 and 26** add their channel to the same unions, their destination rule (the decision maker's account, else the company's) to 5, and a message-only track to 3.1 (every step a `message`, the first a message request); they reuse 1, 2, 4's allowance mechanism without the note, 6, 7, 8 and 10 unchanged.
- **Ticket 27** attaches at `inviteExpired` (3.5).
