# 0004. Social channel tracks: LinkedIn, then Instagram and Facebook

- **Date:** 2026-11-16.
- **Status:** Proposed. Written by the ticket 24 implementer before the code (delivery workflow, "Design first"). The council reviews it with part a's pull request. Section 13 (Instagram, and Facebook as its second instance) added by the ticket 25 implementer on 17 November 2026, before its code. Section 14 (Facebook) added by the ticket 26 implementer on 17 November 2026.
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
| no allowance reads as full for the day (ticket 24b: a step no eligible session has any allowance for, read `sending_capacity`) | L13 | 15 |

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

## 13. Message-request channels: Instagram (ticket 25), then Facebook (ticket 26)

Written by the ticket 25 implementer before the code, on 17 November 2026. Instagram is worked through here; Facebook is the same section with one line of difference in each table that has a "Facebook" column, and nothing else. Every rule of sections 1 to 10 that this section does not name holds unchanged; every rule of ADR 0003 holds as in section 1.

### 13.1 The rule in one paragraph

A **message-request channel** is a social channel whose track is messages only: a text-only first message, which reaches someone who does not follow the sender as a **message request**, then follow-ups after their waits. There is no invitation, no acceptance gate and no pre-send relation check. The track goes to the decision maker's own account from the CSV when there is a usable one, else to the company's. Its sender is a logged-in browser session of the user's, a personal profile or a business account, with one daily **message allowance** the user sets. A conversation between a session and an account is owned by the first subject known to have reached it, with its channel stored, by the machinery of section 6 and ADR 0003 Q7. Replies are marked by the user. Nothing here makes a real session act: the port is built and verified against a simulated provider, the running application registers a port that lists no session, and an Instagram track therefore always meets launch blocker 3.

### 13.2 One thing, two instances

The factory builds one shared piece, parameterised by channel through exhaustive mappings (a `never` default on each), so a new channel is a compile error until it has its entry:

| What | Shared piece | Instagram | Facebook (ticket 26) |
| - | - | - | - |
| The channel | `MessageRequestChannel` in `src/domain/social-channels.ts` | `"instagram"` | `"facebook"` |
| Its name in sentences | `SOCIAL_CHANNELS[channel].name` | Instagram | Facebook |
| The account normaliser | `SOCIAL_CHANNELS[channel].accountKey` | `instagramAccountKey` (13.4) | its own, by the same contract |
| The CSV columns | `SOCIAL_CHANNELS[channel].columns` | people `instagram` (Q43), businesses `instagram` | people `facebook`, businesses `facebook` |
| The account id prefix at the port boundary | `namespacedSocialPort(channel, port)` | `instagram:` | `facebook:` |
| The senders in the definition | each track's own `senders` (13.5), read by `trackPool(def, track)` | the Instagram track's choice | the Facebook track's choice, by the same field |
| The store's channel lists | migration 25's `addChannel(db, channel)` | migration 25 | its own migration, one call |

**No channel name outside the registry.** `src/shared/channel-names.test.ts` fails when a message-request channel's key or name appears in code outside `domain/social-channels.ts`, `domain/social-account.ts`, `server/persistence/migrations.ts` and `web/icons.tsx` (the review of f2824d4, item 3). Every other per-channel difference outside the domain and the engine comes from the registry, through exhaustive records or switches with a `never` default: the reply-action parser (`channelOfMark`), the request schemas (`app.ts`'s mark and test-contact bodies, the Test run tab's), the wording tables, the icons and the menus.

**What ticket 26 adds**, from a scratch proof on 17 November 2026: `"facebook"` added to `MessageRequestChannel` and `MESSAGE_REQUEST_CHANNELS` alone failed typecheck at exactly these places, and nothing compiled while reading as another channel. The server, the engine, the store, the reply-action parser and both request schemas compiled unchanged and took the new channel from the registry. The proof was discarded.
1. Its registry entries: `SOCIAL_CHANNELS.facebook` (name, account key, id prefix, address noun, example) and `MESSAGE_REQUEST_COLUMNS.facebook`.
2. Its account normaliser in `domain/social-account.ts`.
3. Its icon in `web/icons.tsx`, which every place that draws a channel's icon then takes (Activity, Before launch, the canvas, the inspector, the Test run tab, the record's controls, Calls and Campaigns).
4. A migration calling `addChannel(db, "facebook")` and adding its `message_request_channels` row.
5. Test fixtures that list every channel exactly (`providers.test.ts`, `linkedin-review.test.ts`, `measuresWording.test.ts`, `testRunWording.test.ts`, `e2e/screens.ts`'s Reach).
6. Its article, as the registry's `aName` ("a Facebook"): every sentence that puts an article before a channel's name reads it (`channel-article.test.ts`, the council on 5a30b9f, item 4).
7. The generated runs and the harness parameterised by channel: `generated-message-requests.ts` (prefixes, URLs, tracks, provider access, reply bodies) and `engine-harness.ts`'s simulated provider option, so the same record and mutations run on Facebook.

Everything else in this section is written once for every message-request channel: the step kinds, the validator, the destination rule, the allowances, the reads, the reply mark, the test contact, the measures, the simulated provider (`test/support/fake-social-port.ts`, scripted per account) and the generated runs' invariants (M1 to M10). The generated coverage itself is Instagram's: `test/support/generated-message-requests.ts` and the harness (`test/support/engine-harness.ts`'s `instagram` option) name Instagram in their account prefixes, URLs, tracks, provider access and reply bodies, so ticket 26 parameterises them (below). LinkedIn keeps its own files where it differs (the invite, the acceptance, the note, the connection check) and shares the rest: the conversation machinery, the allowance mechanism, the reply mark, the namespacing and the unconnected port.

### 13.3 The track

- **Definition.** `channel: "instagram"`, ADR 0003 1.1's fields and nothing else: no `acceptWaitDays`, no subject on any step. Its steps by position among its live steps (`messageRequestStepKind`, one function every reader calls): the first is the **message request**, the rest **follow-ups**, each with its wait from the message before. All of them are the action `message` (`socialActionOf`). The validator refuses a track with no live step, a subject on a step and `acceptWaitDays`; launch blocker 1 (empty copy) applies to every step, the first included. Text only: a step has a body and nothing else, so no media can be defined.
- **What the engine knows after the first message:** that the session sent it (observed, or found by a lookup), that it was refused, or nothing yet (handed over, its answer not known). It knows nothing about whether the request was accepted, seen, read or declined, and nothing is promised about it: the research says a recipient may have requests turned off, and the platform says nothing to the sender. Every read says "sent" and only that; no sentence says delivered, received, accepted or read.
- **Transitions:** those of any track (ADR 0003 2.4, 2.6). A follow-up's due time resolves from the send before it, as on any track; there is no gate. A message refused `invalid_destination` marks the account bad (13.4) and finishes the track `failed_bad_destination`. A message refused `not_allowed` (the platform does not let this session message this account: requests turned off, or a sender that cannot start a conversation there) finishes the track `failed_bad_destination` with the reason "not allowed", the account **not** marked bad (it is still theirs; Q44), and the lead's other tracks continue. `rate_limited` is an account-level wait (ADR 0003 2.4). A lost answer is settled by `lookup` (section 2.2): the session reads the thread.

### 13.4 The destination

- **Which columns.** The decision maker's own account from the people file's `instagram` column, **when the file has one**: the verified people schema (#11) has no Instagram column, so today no person has an own account and every track goes to the company's (Q43). The company's account from the businesses file's `instagram` column, which the verified schema has (eight of twelve rows in the sample). The import stores both as given (`people.instagram_url`, `companies.instagram_url`, migration 25); companies imported before it are filled from the stored source row.
- **The one normaliser**, `instagramAccountKey` (`src/domain/social-account.ts`): trimmed; `http` or `https`; host `instagram.com`, `www.instagram.com` or `m.instagram.com`; a path of exactly one segment, the username, with an optional trailing slash; query and fragment dropped; the username lower-cased, 1 to 30 characters of letters, digits, `.` and `_`, not starting or ending with `.`, and not a reserved first segment of the site (`p`, `reel`, `reels`, `stories`, `explore`, `accounts`, `direct`, `tv`, `about`, `developer`, `legal`, `web`). The key is `https://www.instagram.com/<username>`. Anything else (empty, a post, a reel, another host, a handle with no URL) is **not an account** and reads as missing. The decision says profile URLs only, so a bare `@handle` is not read.
- **Usable** means the normaliser gives a key and the key is not marked bad. **The destination rule:** for a decision-maker lead, their own usable account, else their company's usable account; for a company lead, the company's usable account. It is one function, `messageRequestDestination` (`destinationFor` for these channels), over the lead's details: the own account is the newer detail, the company's the older, and the newest one not bad wins.
- **Missing** means neither is usable: the track starts and finishes `skipped_missing_channel`, its cause recorded when it finishes (`skipCause`, ticket 24b): `no_profile` (no account in either file), `not_a_member_profile` (an address that is not an account), `marked_bad`, `replaced` or `removed_by_import`. The stored values are migration 24's, read per channel ("no Instagram account in the import"); the names are LinkedIn's and mean the same here (renaming them is a follow-up with the `sms_*` names).
- **An account marked bad.** A refusal `invalid_destination` marks the key bad (`social_destination_marks`, by channel and key; ADR 0001: never cleared) and finishes the track. A key marked bad is no destination for any later track: a lead whose own account is marked bad and whose company has a usable one goes to the company's.
- **A re-import that changes it.** The detail a track starts with is fixed at its start (ADR 0003 2.4). A re-import that gives the person or the company another address gives a new key and a new detail id; the old one is no longer theirs, and a track that has not finished is skipped as missing (`replaced`, or `removed_by_import` when the cell is now empty), as section 5 says for LinkedIn. A track not started yet starts with the new one.
- **In the engine** the account is a `LeadDetail` with channel `instagram`, id `instagram:p:<person id>:<key>` for an own account and `instagram:c:<company id>:<key>` for the company's (a person lead holds both, the company's at the lower order); a test run's is `test:<run>:instagram`. The destination triggers name these ids (migration 25).

### 13.5 The sender

- **The choice, per track** (the review of f2824d4, item 2). Each Instagram track lists the sessions it sends from (`TrackDefinition.senders`), ticked by the user in the inspector's Timing and sender, where every connected session is listed with its kind. Nothing is chosen by itself: a new track starts with none, and a session connected later is listed but never added. A track with none chosen meets **launch blocker 3** (no sender), said as "The Instagram track has no sender session chosen" and, on Before launch, with where to choose. A chosen session that disconnects stays chosen and is listed as unable to send; the track then meets blocker 3 by name if no chosen session can send. The choice is saved with the definition, so it survives a reload, and a stale tab's save is refused (ADR 0003 1.1.1) rather than clearing it. The validator, the launch check, dispatch and the reads all judge the track's own choice (`trackPool`, `trackPoolOf`). Each session is reported by the port with its **kind**, `personal` or `business` (a business or creator account, or a Facebook Page for ticket 26), stored on the account (`sender_accounts.social_kind`), returned by `accountView`'s `socialKind`, and shown wherever a session is named.
- **What the engine does with the kind: nothing.** The research documents that a personal account can start a conversation with someone who does not follow it (a request), that a recipient can turn requests off, and that the official API needs the person to message the business first; it does not document whether a business account messaging a person, or a personal account messaging a business account, is treated differently in the native interface. So the engine assumes nothing: a session of either kind may be chosen for any account, the platform's refusal is reported (`not_allowed`, 13.3), and the track then fails for that lead with the cause stored. Q45 asks the principal whether a kind should restrict the choice.
- **Fixed once, per track** (the review bot on 0922582). A lead's sender on a message-request track is the session stored at that track's own first handover (`socialSenders`, keyed by track id), chosen from that track's own choice, never reassigned (ADR 0003 5.2) and never read by another track: a second Instagram track of the same lead chooses from its own sessions, whatever the first chose. Email, SMS and LinkedIn keep one fixed sender per lead and channel, since their tracks share one campaign pool and none chooses its own (the validator refuses `senders` on them). The choice decides only where a track starts: a session unticked later keeps sending the leads it started on that track, exactly as LinkedIn's fixed session does, and starts no new one (M8; `instagram.test.ts`).
- **A removed track keeps its sessions.** A track a lead had started runs on for that lead after a running edit removes it (ADR 0003's running edits). The store loads every track's chosen sessions, a removed track's too, so one removed between its start and its first claim still sends (`removed-started-track.test.ts`, on every channel).

### 13.6 Ownership

The conversation between a session and an account is owned by the first subject known to have reached it, by the existing rule and machinery (section 6, ADR 0003 Q7): `holdsConversations` names the channel; the pair is taken in the handover's write with its channel stored (`sms_bindings.channel`); a second subject's track is skipped as `skipped_conversation_taken` naming the owner, held as `sms_conversation_unsettled` while the owner's first message is not known sent, and released when nothing went. Nothing reads conversations across channels (`pairsOn`), and every cache uses the per-destination versions: an Instagram key is a destination like a mobile or a profile.

- **Two campaigns, one account, one session.** The first campaign to reach the account owns it; the second campaign's track for that lead is skipped, naming the first, or held while the first's message is unknown.
- **A person's own account and their company's account** are two destinations: two pairs.
- **Two decision makers of one company with no own account** both go to the company's account: the first owns the pair, the second is skipped as taken on that session, or goes from another session of the pool if one is free (as Q42 for LinkedIn; Q46 asks whether a company's account should hear from only one of the user's sessions).
- **Two Instagram tracks of one lead** (the review bot on 0922582). A conversation is still one (session, account) pair. Two tracks of one lead to the same account, from the same chosen session, are one conversation, which the lead owns; from two different chosen sessions, they are two conversations with that account from two of the user's sessions, each owned by the lead. Q46 asks this for one lead as well as for colleagues.

### 13.7 Allowances, capacity, priority, windows, interruption

The engine's rules, unchanged (section 6, ADR 0003 sections 4 and "Ticket 20a"): capacity per session shared across campaigns, follow-ups before first contacts, oldest due first, nothing dropped, overflow to the next reset day; pacing at every send call; the window in the prospect's zone; a step that falls due while the application is off waits for the next sending window. A session has **one** allowance, **messages per day**, the user's number with no default, stored in `social_allowances` (its invite and note columns are zero for these channels and never read). A session whose allowance is zero or unset has no room: a step whose every eligible session (`eligibleSessions`) allows none reads `no_allowance`, never "full today" and never a time.

### 13.8 Replies, test runs, measures

- **The reply mark** is section 7's control with its channel: `POST /api/enrollments/:id/replies` and `POST /api/test-runs/:id/replies` take `channel` among the social channels, and the control's label and request (`CONTROL_LABEL.mark_replied`, `controlRequestOf`) carry it. It is allowed when something of this subject reached the person on **that** channel in this campaign (a message known sent, or handed over and not yet known), and refused otherwise ("Nothing has been sent to them on Instagram in this campaign"). Its effect is `applyReply` with that channel and `<channel>:<request id>`: the lead ends `replied`, in this campaign only. Activity says "You marked them replied on Instagram".
- **Test runs.** The campaign's test contacts gain the user's own test Instagram account (`campaigns.test_instagram`), read by the normaliser and refused when any person's or company's record holds the same key. A test run's Instagram track sends to it from the real sender session, with ADR 0003 3.6's minute waits. No acceptance is needed, so nothing waits on the user.
- **Measures** per channel: **messages sent** (message attempts sent), **failed** (failed results on the channel's steps), **replies marked** (leads whose first reply is on the channel), test share counted apart as before. Nothing claims delivery or reading.

### 13.9 Invariants (M1 to M10)

Asserted after every event by the message-request generated runs (`src/server/sequence-runs-message-requests.test.ts`), on the simulated provider's own logs where they say so, for each drawn channel:

1. **M1 Once.** Each step is delivered at most once; a lost answer is never followed by a second handover of the same step (a non-retryable transport).
2. **M2 The right account.** Every message goes to the destination the record derives at the track's start: the decision maker's own usable account, else the company's; never to a key marked bad before the handover; none for a lead with neither, whose track is skipped with the cause the record derives.
3. **M3 Nothing after a mark or a stop.** After the user's mark is accepted, or the lead is stopped, nothing more is handed over for that subject until a restart after it.
4. **M4 Allowances.** On the delivery log, per session and reset day, messages never exceed the session's allowance; a session at zero sends nothing, and a step whose every eligible session is at zero reads `no_allowance`.
5. **M5 No pair moves.** Every message to a (session, account) belongs to the first subject that reached it, until that subject's work there settled with nothing sent.
6. **M6 A reply is the reached subject's.** A mark is accepted only on a subject the record knows reached the person on that channel (delivered, or handed over and untold).
7. **M7 Nothing pending for ever.** After the drain, every pending step of a running lead has a due time or a hold the record derives itself, and none has been due for days with nothing holding it.
8. **M8 Its own channel, its own sender.** Every handover is on its own track's channel. A lead's first message goes from a session its track has chosen at that instant; every later one goes from that same session, whether or not the track still chooses it. A fixed sender is never reassigned (ADR 0003 1.3), exactly as LinkedIn's fixed session is: unticking a session stops it starting new leads, not finishing the ones it started. The oracle checks the same two things, and `instagram.test.ts` shows it through HTTP.
9. **M9 The other tracks carry on.** A message-request track that finishes for any reason changes no other track's progress but by releasing what starts after it; an SMS or LinkedIn track beside it runs as the record predicts on its own.
10. **M10 Priority at a contested slot.** When a session's slot is contested, a follow-up to a touched lead goes before a first message to a new one, then the oldest due.

ADR 0003's invariants 1 to 14 and 18 to 29 hold for these steps too; **29** (a fresh engine on the same store at the same instant finds nothing to change or hand over) is asserted after every tick in the search and every 10th tick in the fixed seeds, as for LinkedIn.

**The generated runs** (`test/support/generated-message-requests.ts`, own record, own mutations in `test/support/message-request-mutations.ts`; the record imports nothing from `src/domain/sequence/`): one or two campaigns sharing one to three Instagram sessions of both kinds; an Instagram track of one to three messages and, in half the runs, an SMS or a LinkedIn track beside it or after it; people with an own account, with only a company account, with garbage, with none, and company leads; two decision makers of one company sharing its account; allowances from 0 to 4; real windows and the three zones; the provider scripted per account (sends, refuses `invalid_destination`, refuses `not_allowed`, refuses for a limit, loses an answer); events: clock advances, lead and campaign pauses, stops and restarts, skips, the user's reply mark (accepted and refused), the laptop off, a crash between a handover's commit and its call, a session signing out, running edits (a message inserted, removed, reordered), pool edits, a re-import that changes an account, and the user's mark of unresolved work. **Mutations**, one per invariant, each killed by a recorded seed in `pnpm check`: a lost answer handed over again (M1); the company's account preferred to the person's own (M2); a started track retargeted by a re-import, where it must be skipped (M2); a mark recorded without ending the lead (M3); one bucket for every session (M4); a taken pair ignored (M5); a mark accepted with nothing reached (M6); a taken pair held, not skipped (M7); the pair's session not fixed (M8); a finished Instagram track ending the lead (M9); priority by due time alone (M10); and the conversations' version ignoring an Instagram pair (29).

### 13.10 Nothing changes for email, SMS, calls or LinkedIn

Every new branch is taken only for a message-request channel. The evidence is `scripts/no-social-digest.ts` extended with a LinkedIn track: one scripted world of email, SMS, phone and LinkedIn tracks with no Instagram track, run on the integration tip and on this branch, gives identical provider handover and delivery logs, call lists and outcomes; its digest is in the pull request.

### 13.11 Questions for the principal

Numbered on from Q42. Each says what is built meanwhile.

- **Q43. Where a decision maker's own Instagram account comes from.** The verified people file has no Instagram column, only the businesses file. *Built:* an `instagram` column of the people file is read when a file has one; otherwise every Instagram track goes to the company's account. The people file's `source_urls` (pages where the person was found) are not read as their account. Should the scraper add a person column, or should the company's account be the only Instagram destination?
- **Q44. A message the platform does not allow.** A recipient can turn requests off. *Built:* the platform's refusal (`not_allowed`) fails the track for that lead with the reason shown, the account not marked bad, the lead's other tracks continuing. The alternative is to try again from another session of the pool.
- **Q45. Which kind of sender may message which kind of account.** *Built:* any session of the pool, of either kind, for any account; the platform's refusal is reported (Q44). If the principal wants, a business session could be kept for company accounts and a personal one for people: one rule in the account choice.
- **Q46. One account, several of the user's sessions.** With no own accounts, every decision maker of a company goes to the company's account; and one lead with two Instagram tracks choosing different sessions is messaged by each track from its own. *Built:* one conversation per (session, account), so a second lead of the same company goes from another free session of the pool, or is skipped as taken; and each track of one lead sends from its own chosen session, so one person or account can hold two conversations with the user, one per session. Should an account hear from at most one of the user's sessions, for one lead as for colleagues, and then only once per campaign?
- **Q47. The daily allowance's default.** *Built:* none; an unset allowance is no room, read as "no allowance", until the user sets a number. No Instagram or Facebook limit is invented.

### 13.12 What is unverified, and why

As section 12 for LinkedIn: no Instagram session is connected and no test account is designated (#28), so everything is verified on the simulated provider only. Unverified: that a session can send each message and how it answers (sent, refused, unknown), and whether any action is safely retryable; whether a sent request is visible to the recipient; the platform's own limits on the user's accounts; which kinds of sender can message which accounts (Q45); the test run on the user's own account; and whether a session survives the laptop sleeping.

### 13.13 As built (ticket 25, 17 November 2026)

- **Code.** `src/domain/social-channels.ts` (the exhaustive registry: `MessageRequestChannel`, `SOCIAL_CHANNELS`, `MESSAGE_REQUEST_COLUMNS`, the account detail ids `instagram:p:` and `instagram:c:`); `src/domain/social-account.ts` (`instagramAccountKey`); `definition.ts` (`TrackDefinition.senders`, `trackPool`, `allPools`, `messageRequestStepKind`, `socialStepKind`, the validator's two message-request refusals); `progress.ts` (`goodAccount`, `destinationFor` as a switch, `messageSessionOf`, `withSocialSender`, `accountSkipCauseOf`, the `not_allowed` refusal); `controls.ts` (`replyMarkWork`, `markRepliedRefusal` and `markReplied` take the channel; `nothingSentOn`); `reach.ts` (a lead reaches Instagram through its own account or its company's, from the source rows the CRM already keeps).
- **Store.** Migration 25, the next number after the integration tip's 24, adds `message_request_channels`, `social_destination_marks`, `campaigns.test_social`, `sender_accounts.social_kind`, `social_senders` and `test_runs.social_contacts`, makes the destination triggers read `message_request_channels`, and widens every CHECK that lists the social channels through `addChannel` (`src/server/persistence/add-channel.ts`), which rebuilds each such table from its own stored text and makes its indexes, views and triggers again. The account cells are read from `people.source_row` and `companies.source_row`: no import change. `test/support/undo-migrations.ts` computes the undo of 25 from the schema migrations 1 to 24 make.
- **Engine and ports.** `UnconnectedSocialPort(channel)` and `namespacedSocialPort(channel, port)` serve LinkedIn and every message-request channel; `EngineDependencies.socialPorts`; every per-channel record of the engine is built by `perChannel` over `PROVIDER_CHANNELS`; `applySocialEvent` (a reply or an acceptance from a message-request session is an anomaly); the message-request pre-send check reads only whether the session can act. `GET /api/social-providers`.
- **Reads and routes.** `EnrollmentRead.replyMarks` and `TestRunRead.replyMarks` replace `linkedinReply` (one mark per social channel the campaign has a track on); `TrackProgressView.messageRequest`; `MessageRequestMeasures` under `CampaignMeasures.messageRequests`; `PreviewLead.social` and `coverage.social`; `TestRunTab.contacts.social`. The daily-load figure is withheld as not modelled for an Instagram track as for LinkedIn's (the projection reads no session's allowance). The reply route takes `channel` among the social channels.
- **Screens.** The record control is `mark_replied:<channel>`, so the channel travels with every press, label and request (`reply-mark-wording.ts`); a press stored before ticket 25 as `mark_replied` is read as LinkedIn's. Instagram's sentences on the record are `messageRequestTrackLines`, each from a stored fact.
- **Tests.** `src/domain/social-account.test.ts`; `src/server/engine/instagram.test.ts` (nineteen tests through HTTP); `src/server/engine/conversation-owner.test.ts`; `src/web/social-channel-wording.test.ts`; `src/shared/channel-names.test.ts`; `src/server/persistence/migration-25.test.ts`; `src/web/campaign/message-request-wording.test.ts`; `e2e/instagram.spec.ts` (the demonstration and the states). The generated runs `test/support/generated-message-requests.ts`, the mutations `test/support/message-request-mutations.ts` and the chunks `test/support/message-request-chunks.ts` run in `pnpm check` (fixed offsets 1, 17, 63, 79 and 91 from 25000, one bounded test case each, covering all 37 behaviours; offsets 0 to 99 all passed unmutated on 17 November 2026 after the review of f2824d4, on one worker) and in the `sequence-search` shards. Each mutation's recorded seed offset: M1 2, M2 0, M2 (retargeted) 20, M3 29, M4 1, M5 0, M6 1, M7 6, M8 0, M9 3, M10 3, 29 4.
- **What the first runs found, all in the record:** a refusal at the same millisecond as the call it refused counted as an earlier mark (marks are now ordered by the position of the refused call); M7 counted a lead ended for no usable channel and sessions whose pair another subject owns (the engine reads `no_allowance` on its eligible sessions only, as section 6 says); M9 skipped every ended lead, so it could not see a lead the broken engine ended.
- **No change elsewhere.** `scripts/no-instagram-digest.ts` (email, SMS, phone and LinkedIn tracks): digest `ba6e437d…` on the integration tip `5c43963` and on this branch; `scripts/no-social-digest.ts`: `eb4141e8…` on both.

#### The reviews of `f2824d4` (council and verifier, 17 November 2026)

1. **Migration number.** The empty placeholder 25 is gone; this branch's migration is 25, the next number at the tip it merges into. `docs/agents/delivery-workflow.md` now says a branch takes the next number at its merge tip and renumbers if another lands first, and that a number is never reserved by an empty migration. `migration-25.test.ts` migrates the tip's own database through this branch and then a later build with one more migration: each runs once, in order. A second test fails on any empty migration.
2. **The sender, per track.** See 13.5: each track's own `senders`, chosen in the inspector with each session's kind; nothing is added by itself; none chosen is blocker 3, said as such while a session is connected to choose. Tests through HTTP cover a save, a reload, a stale tab refused, a session connecting (listed, not added) and disconnecting (kept, unable to send). A keyboard browser test covers the inspector.
3. **The registry.** See 13.2: the rule test, and what ticket 26 adds.
4. **Shared company accounts.** Before launch says how many leads share how many company accounts, and that each can hear from up to as many of the track's sessions as are chosen, in the inspector's words. The counts come from the read (`coverage.social[c].shared`).
5. **Wording and speed.** Activity says "Instagram message N sent". Today's "Now …" line stays in the present: `unreachableWhy` computes it at the read, so it states what holds now, not what held at the ending, which is told in the past in the sentence before it. The Instagram engine tests take 3 s in total on one worker (each under 0.3 s); the earlier timeouts were the machine's load, so no timeout was raised.
6. **Each explanation in its own channel's name.** The remaining fallbacks come from the registry. `social-channel-wording.test.ts` checks every social channel against every reason, refusal, wait and ending: each sentence names its own channel and no other.
7. **The parser and the schemas** come from the registry (13.2).
8. **The destination is pinned.** The generated record fixes each track's destination at its modelled start (the launch: the Instagram track starts at entry), and every later message must go there. Half of the re-imports now reach a started track. The mutation "a started track retargeted by a re-import" is killed at offset 20; the earlier check, which accepted the rule's destination at any instant up to the handover, would have let it pass.
9. **The owner of a taken conversation** is said from the stored cause: a lead of the same campaign by name, else the campaign. Today read only SMS tracks' skips for every channel; it now reads each channel's own. On LinkedIn two leads of one campaign can share a profile; on SMS the import refuses two leads of one campaign sharing a mobile (`shares_contact`), so there only a test run can own it, and it is named as one.
10. **What has left the app** is one exhaustive function with three states on every channel (`outgoingSoFar`): nothing handed over; handed over and not yet known to have gone; recorded sent. "Nothing has gone out yet" is said only in the first.
11. **Machine speed.** Each generated family's fixed seeds are now one bounded test case per seed, with the coverage still asserted over all of them. Measured: on CI the nine LinkedIn seeds took 222 s and the four message-request seeds of then 14 s; locally, at a load average near 30, the nine LinkedIn seeds took 407 s, the slowest 188 s.
12. **M8 and the fixed sender.** See 13.5 and M8. Every browser spec's animation wait now settles cancelled animations instead of rejecting.

#### The review bot on `0922582` (17 November 2026)

- **A. The sender, per track.** Both handovers of a lead whose Instagram track A chose `s1` and track B, after it, chose only `s2` went from `s1`: the sender was fixed per lead and channel. It is now fixed per track (13.5): `socialSenders` holds the session of each track's own first handover, keyed by track id, and a track with none yet chooses from its own choice. Ownership is settled in 13.6 and Q46. Tests through HTTP: disjoint, overlapping and identical choices, and one track's session without allowance while the other's has room (`instagram.test.ts`). The generated runs give half the campaigns a second Instagram track choosing other sessions, and the record holds each track to its own choice (M8). The mutation "a track's sender taken from another track of the same channel" is killed at offset 0. LinkedIn has no per-track choice: its tracks share the campaign pool and the validator refuses `senders` on them, so its one session per lead stands.
- **B. A removed but started track.** A track removed by a running edit after a lead started it, but before its first claim, loaded no sender: the store loaded message-request sessions from the live tracks' choices only. It now loads every track's chosen sessions, a removed track's too, and a session's pacing reads the windows of the tracks that chose it. Nothing else the engine reads drops a removed track: `liveTracksFor` keeps one a lead started, its steps, window, start and acceptance wait stay in the stored definition, and the email, SMS and LinkedIn pools are the campaign's. Tests through HTTP on email, SMS, LinkedIn and Instagram (`removed-started-track.test.ts`); without the fix only Instagram's fails. The generated runs now remove a started track before a lead's first claim: email and SMS in `generated-tracks.ts`, LinkedIn in `generated-linkedin.ts`, Instagram in `generated-message-requests.ts`, each from a random stream of its own so earlier draws are unchanged. Each family has a mutation in which such a track finds no sender: tracks invariant 18 at offset 0, LinkedIn L13 at 0, message requests M7 at 4. The fixed seeds were checked again: the message-request family's are now 1, 4, 17, 63, 79 and 91 (all 39 behaviours; offsets 0 to 99 pass unmutated, and every mutation dies on its recorded seed, M5's now 3); the LinkedIn family's gain 10, which reaches the two behaviours the removal took from 8 and 93; the email and SMS family's are unchanged and reach both removals.
- **The record, made exact by the second track.** A crash holds only the pair it was for, until the user marks it not sent (M5). M7 judges a pending track against the destination fixed at its start. M10 counts as a first contact only a message to a lead nothing has reached yet: a second track's first message to a lead its first track reached is ranked as a touched lead's.

#### The council on `5a30b9f` (17 November 2026)

1. **A claim is not a handover.** What has left the app is read from the stored handover time (`handedAt`): a claim never handed over is "nothing", and work handed over and not yet reported is "not known yet". The other reads already rested on a handover fact (sent attempts, work with calls made, the first handover time). `claimed-not-handed.test.ts` covers every sending channel through HTTP, including a crash between a claim and its handover.
2. **Pacing.** A session's default gap comes from the tracks with leads running on it. On a message-request channel those are the live tracks that chose it; on LinkedIn, the live tracks of a campaign whose pool holds it. On either, it also includes any track a running lead fixed to the session has started and not finished, so a removed or unticked track counts only while its leads run. Email and SMS keep the campaign-pool rule (`session-pacing.test.ts`).
3. **Wording.** The inspector says what two tracks of one lead on two sessions do (13.6; Q46 is with the principal). Before launch gives the shared-account limit per track. Both "Blocks launch" sentences come from one exhaustive record over the domain's blocker kinds.
4. **The article** before a channel's name is the registry's `aName`. The generated coverage is Instagram's (13.2), and ticket 26 parameterises it.

## 14. Facebook, the second message-request channel (ticket 26)

Added by the ticket 26 implementer on 17 November 2026. Facebook is the second instance of section 13's message-request channel: an entry in the registry and what that entry needs, not a copy of Instagram's code. Everything in section 13 holds for Facebook as written, with "Instagram" read as the channel. This section says only what differs, what had to change outside the registry and why, and how the tests show it.

### 14.1 What is the same

By reference, unchanged: the track and its step kinds (13.3), the destination rule and the skip causes (13.4, apart from the normaliser), the per-track sender choice, its fixing at the track's first handover and the removed track that keeps its sessions (13.5), ownership of a conversation (13.6), allowances, capacity, priority, windows and interruption (13.7), the reply mark, test runs and measures (13.8), invariants M1 to M10 and 29 (13.9), and the unconnected port in the running application. No session of either channel is connected, so a Facebook track meets launch blocker 3 exactly as an Instagram track does, and `GET /api/social-providers` says "No Facebook session is connected, so Facebook tracks cannot launch."

### 14.2 The registry entry

| Fact | Where | Facebook |
| - | - | - |
| The channel | `MessageRequestChannel`, `MESSAGE_REQUEST_CHANNELS` | `"facebook"`, after Instagram |
| Its name, and with its article | `SOCIAL_CHANNELS.facebook.name`, `.aName` | Facebook, "a Facebook" |
| Its account normaliser | `.accountKey` | `facebookAccountKey` (14.3) |
| Its account id prefix | `.accountPrefix` | `facebook:` |
| What its address is called | `.addressNoun` | profile ("Your Facebook profile, for the messages"; the ticket says "the user's own Facebook profile") |
| A fictitious example address | `.exampleAddress` | `https://www.facebook.com/your.name` |
| Its CSV columns | `MESSAGE_REQUEST_COLUMNS.facebook` | people `facebook` (absent from the verified schema: Q43 applies), businesses `facebook` |
| Its sender kinds in words | `MESSAGE_REQUEST_SENDER_KINDS` (new) | personal: "a personal profile", "your personal profile"; business: "a Page", "your Page" |
| Its icon | `web/icons.tsx` | a person with a small message beside them, not the platform's mark |
| Its store row | migration 26 | `message_request_channels` row and one `addChannel(db, "facebook")` |

`MESSAGE_REQUEST_SENDER_KINDS` is the one fact that had to be added to the registry: section 13 hard-coded "a business account" and "your business session" in three places (the inspector's sender list, the record's first-message sentence and the inspector's limits). On Facebook a business sender is a Page, so those words are now the registry's, per channel, through an exhaustive record. The session kind stays `personal | business` in the store and the API (`sender_accounts.social_kind`); only its words differ.

### 14.3 The normaliser, and the address table

Rewritten after the council on `f3c9014` (item 1), before its code. The class of fault is **one account, several keys**. The review bot's period finding was one example; an address that carries an account's number was another. This section closes the class as far as the application can: every form it can read is in the table below with what it is read as. The two readings are each one registry fact per channel (`SOCIAL_CHANNELS[c].accountKey`, `MESSAGE_REQUEST_MAY_NAME[c]`).

**Two readings, two directions of error.**
- **`accountKey`, what a track messages.** It gives the one key of an account the application can open, or null, which reads as missing. Missing is its safe side: a lead is skipped rather than messaged at an address the app cannot read.
- **`mayName`, what the test-contact boundary reads.** It gives every key an imported cell may name. It is a superset of `accountKey`: it adds the forms the app never messages but that plainly carry an account's username or number. A user's test contact is refused when any person's or company's cell may name its key, both when it is saved and when a test run starts. Refusing a test contact is the safe side here, so where two forms could be one account and the app cannot know, this reading treats them as one.
- **Ownership and bad marks** read `accountKey` alone. They never merge accounts the app cannot show are one.

**Facebook** (`facebookAccountKey`, `facebookMayName`; `N` is an account's number, digits only, read without leading zeros):

| Form | `accountKey` (messaged; ownership; bad marks) | `mayName` (test-contact boundary) |
| - | - | - |
| `facebook.com/<username>` on any host of the hosts row, with or without a trailing slash, query or fragment | `facebook.com/<username>`, lower-cased, periods dropped (Facebook's documented rule: periods and capitals do not tell usernames apart) | the same |
| `facebook.com/N` | `facebook.com/profile.php?id=N` | the same |
| `facebook.com/profile.php?id=N` (other parameters dropped) | `facebook.com/profile.php?id=N` | the same |
| `facebook.com/<name>-N`: a Page with no username; a username has no hyphen, so the trailing digits (five or more) are its number | `facebook.com/profile.php?id=N` | the same |
| `facebook.com/<name>-<text>`, or a name ending in fewer than five digits after a hyphen: no username and no number | not an account | not an account |
| `facebook.com/pages/<name>/N`, `facebook.com/people/<name>/N` | not an account (Q48's interim) | `facebook.com/profile.php?id=N` |
| `facebook.com/<username or N>/<more>`, such as `/about` or `/posts/1` | not an account | the key of its first segment, by the rows above |
| a bare `@<username>` or `<username>` with no URL | not an account (profile URLs only) | `facebook.com/<username>` as above |
| **Hosts** that are only other names for facebook.com with the same path: `facebook.com`, `www.`, `m.`, `mbasic.`, `web.`, a locale such as `en-gb.` or `de-de.`, and `fb.com` | every row above reads the same on each: the same account (the safe side for the test-contact check too) | the same |
| `business.facebook.com` (the business tools, not a profile), `fb.me/<…>` and `m.me/<…>` (short links whose target the application cannot know), any other subdomain or host | not an account | not an account |
| `facebook.com/me` (whoever is signed in), the site's own sections (`groups`, `events`, `watch`, `marketplace`, `login`, `share`, `sharer`, `photos`, `help` and the rest in the code), a name ending `.php` | not an account | not an account |
| any other host, empty, not a URL | not an account | not an account |

**A username and a number are two keys.** A Page or profile with a username also has a number. Nothing in an address joins the two: `facebook.com/exampleharbour` and `facebook.com/profile.php?id=N` may be one account, and only a session opening them could tell. The application keys them apart everywhere. For ownership and bad marks this errs toward two accounts: the account may get a first message from the same session for two leads, which Q46 already raises. For the test-contact boundary it errs toward allowing a test contact that is a prospect's account under its other form, so the application says so where it matters (the council on `f3c9014`, item 1a). One sentence from the registry (`MESSAGE_REQUEST_TEST_CONTACT_LIMIT`) appears under the Facebook test contact field, and beside **Run test** while the sequence has a Facebook step. It says that the application compares addresses as written, cannot tell that a username and a number are one account, and that the user must give their own account. This joins Q48 below: the same limit applies to `/pages/` and `/people/` forms, which carry only the number.

**Instagram has no such pair.** Its addresses carry only the username: no public form names an account by its number, so every form the table reads keys to the username. No sentence is shown for Instagram (its registry entry is null).

**Instagram** (`instagramAccountKey` as 13.4, `instagramMayName`):

| Form | `accountKey` | `mayName` |
| - | - | - |
| `instagram.com/<username>` on `www.`, `m.` or no subdomain, any case, trailing slash, query, fragment | `instagram.com/<username>`, lower-cased (periods kept: on Instagram they are part of the name) | the same |
| `instagram.com/<username>/<more>`, such as `/reels` or `/tagged` | not an account | the key of its first segment |
| a bare `@<username>` | not an account (profile URLs only) | `instagram.com/<username>` |
| any host other than `instagram.com`, `www.` and `m.` (`instagr.am`, other subdomains) | not an account | not an account |
| the site's own sections (13.4), any other host, empty | not an account | not an account |

Measured against the real businesses export on 17 November 2026, by aggregate counts only: 12 rows; 7 one-segment `www.facebook.com/<name>`, 1 `profile.php?id=`, 1 a six-segment path holding `pages`, and 3 empty. `accountKey` reads 8 as accounts. The people file has no Facebook column.

### 14.4 The sender

The user chooses each Facebook track's sessions, each a personal profile or a Page, in the inspector, as on Instagram (13.5); each session is shown with its kind in Facebook's words. What each kind can message is the platform's, and the application assumes none of it. The research documents that a personal profile can message someone who is not a friend, into Message Requests, and that blocking can prevent delivery; that eligible Pages can send up to 10 new message requests a day to people and Pages, with availability gradual and eligibility conditions on sender and recipient; and that Messenger's business API needs a qualifying interaction first, which this app does not use. So, as on Instagram: any chosen session of either kind may be used for any account; the platform's refusal is reported (`not_allowed`, the account not marked bad, Q44); and no limit is set by the app (Q47, Q49).

### 14.5 The store

Migration 26, the next number after the integration tip's 25: one row in `message_request_channels` and `addChannel(db, "facebook")`, which widens the four CHECKs that list the social channels (`sender_accounts.channel`, `replies.channel`, the stopping reply's channel on enrollments and test runs) and `sms_bindings.channel`, rebuilding each from its own stored text with its indexes, views and triggers. The destination triggers and the bad marks read `message_request_channels`, so they take a Facebook account by that row. `migration-26.test.ts` upgrades a version-25 database holding Instagram rows. Should pull request 71 (InMail) land first, this migration takes the next number when the integration tip is merged.

### 14.6 Two channels in one campaign

A lead with an Instagram track and a Facebook track has two conversations: each track goes to that channel's account, from that channel's session, through that channel's pair, allowance and reply mark. Nothing is read across channels. The account ids carry the channel (`instagram:<session>`, `facebook:<session>`) even where the platform's session ids are the same, a pair stores its channel (`sms_bindings.channel`), and a reply mark is allowed only where something reached the person on its own channel. A mark on either channel ends the lead in the campaign, as any reply does (section 7), so both tracks stop. Shown through HTTP in `message-request-channels.test.ts` ("Instagram and Facebook in one campaign"): the same session id on both channels; an account taken on Instagram leaves the lead's Facebook track free; each channel's allowance is its own; a mark refused on the channel nothing reached and accepted on the other. In the browser by `e2e/message-requests.spec.ts`.

### 14.7 The tests, parameterised by channel

- **Through HTTP:** `src/server/engine/instagram.test.ts` is now `message-request-channels.test.ts`: every one of its 23 cases runs once per message-request channel, with each channel's sentences written out by hand in the test, then the three joint cases above. `removed-started-track.test.ts`, `claimed-not-handed.test.ts` and `session-pacing.test.ts` run on every message-request channel. `test/support/message-request-accounts.ts` gives each channel's fictitious account forms, written by hand, never through the production normaliser.
- **The harness:** `EngineHarness`'s `instagram` option and getter are now `social: { [channel]: { sessions } }` and `h.social(channel)`; the engine and app take every simulated provider the harness has.
- **The generated runs** (`test/support/generated-message-requests.ts`): each drawn channel is a **lane** with its own sessions, allowances, account cells, scripts, tracks, chosen senders and provider logs, and the record's own forms and reading of each channel's cells (`FORMS`, which imports nothing from `src/domain/`). A seed draws Instagram alone, Facebook alone, or both in one campaign, from a stream of its own (`channelsOf`); with both, the first lane draws from the main stream exactly as before and the second from streams of its own, so a seed drawn with one channel is ticket 25's world under that channel's names. The two lanes use the same session ids. Email, SMS and LinkedIn tracks are drawn beside or after the first lane's track as before. M1 to M10 are checked on every lane; M3 holds every lane after a mark or stop on any; M10 counts a lead reached on any channel as touched. A behaviour of one lane is named with its channel (`facebook:a-reply-marked`), and `RUN_CHANNELS` must equal `MESSAGE_REQUEST_CHANNELS` (a test fails otherwise).
- **Fixed seeds:** offsets 1, 4, 5, 6, 14, 17, 26, 28 and 31 from 25000, one bounded case each, cover all 65 behaviours, every lane behaviour on both channels and the joint ones ("instagram-and-facebook-in-one-campaign", "one-lead-reached-on-both-channels", "a-reply-marked-on-one-channel-of-a-lead-reached-on-both"). Offsets 0 to 39 all passed unmutated, locally, on one worker: 128 s for the forty, 34 s for the nine.
- **Mutations:** each of section 13's fourteen now runs on Instagram alone and on Facebook alone at its recorded seed; every recorded seed still kills on both (97 s for the 28 locally, one worker). One new mutation only a joint campaign can show: "a reply mark's reach read on any message-request channel" (M6), killed with both channels at offset 10. In the search, each mutation and channel searches its own killing seed.

### 14.8 Nothing changes for email, SMS, calls, LinkedIn or Instagram

`scripts/no-instagram-digest.ts` with `DIGEST_WITH_INSTAGRAM=1` adds an Instagram track to its campaign of email, SMS, phone and LinkedIn tracks, and runs unchanged on the integration tip and on this branch: digest `349028b6…` on both. Without the variable it is `ba6e437d…` on both, as ticket 25 recorded, and `scripts/no-social-digest.ts` is `eb4141e8…` on both.

### 14.9 Questions for the principal

Q43 to Q47 as they stand for Facebook:

- **Q43 applies.** The verified people file has no Facebook column either (checked on the real export, by counts). *Built:* a people-file `facebook` column is read when a file has one; otherwise every Facebook track goes to the company's account.
- **Q44 applies.** A personal recipient may restrict message requests or block the sender, and a Page's first-contact messages have eligibility conditions. *Built:* the refusal fails the track for that lead, the account not marked bad.
- **Q45 applies, more sharply.** On Facebook the research documents a Page-specific first-contact route with conditions. *Built:* any chosen session of either kind for any account; the platform's refusal is reported.
- **Q46 applies** unchanged: one conversation per (session, account), Facebook's Pages shared by colleagues as Instagram's accounts are.
- **Q47 applies:** no default allowance on Facebook either.

New:

- **Q48. Which Facebook addresses are a lead's account, and a username against its number.** *Built:* 14.3's table. A username and every form that carries the number are messaged. `/pages/<name>/<id>` and `/people/<name>/<id>` are not messaged, so such a company counts as having no Facebook account (one of twelve rows in the real export holds a `pages` path), though the test-contact check reads them by their number. A username and a number are two keys the application cannot join without a session opening them; the Test run tab says so. Should the `/pages/` and `/people/` forms be messaged by their number?
- **Q49. A Page's documented 10 new message requests a day.** *Built:* the user's own number per session, with no cap from the app, so a Page's allowance can be set above what Facebook may let it send; whatever Facebook then answers is reported as it answers (a refusal, or a limit that holds the session's messages), unverified until a session is connected. Should a Page session's allowance be capped at 10 new conversations a day, or left to the user?

### 14.9a The review bot on `c072ae8` (18 November 2026)

**Facebook username aliases.** The key kept a username's periods, so `exampleharbourphysio` imported for a prospect and `example.harbour.physio` given as a test contact were two keys. The test contact was saved and a test run messaged the prospect's account; a conversation's pair and a bad mark were split the same way. The key now drops the periods (14.3). That fixed the example, not the class: one account could still have several keys when its number was in the address, which the council on `f3c9014` found (14.9b). Regressions through HTTP (`message-request-channels.test.ts`, "Facebook usernames ignore periods"), each failing before the fix: the plain spelling imported refuses the dotted test contact, the dotted spelling imported refuses the plain one, and in each case no test run starts; a test contact saved before a prospect with its other spelling is imported is refused when the run starts. The normaliser's tests cover the aliases. The generated runs' own reading of a Facebook cell drops periods too. The fixed seeds and every mutation still pass and kill on both channels.

### 14.9b The council on `f3c9014` (18 November 2026)

**One Facebook account, several keys (blocking).** `facebook.com/N`, `profile.php?id=N` and a Page's `/<name>-N` were three keys for one account. So a test contact in one form of a prospect's account was saved and messaged by a test run, and one Page in two forms got two first messages from one session. The class is now closed as far as the application can close it, by 14.3's table:
- every form that carries the number is one id key;
- hosts that are only other names for facebook.com read the same;
- `fb.me`, `m.me`, `business.` and `facebook.com/me` are not read;
- a hyphenated name with no trailing number is not an account;
- the test-contact boundary reads a superset (`mayName`) whose safe side is refusal.

A username and its number stay two keys. The application says so on the Test run tab, under the Facebook field and beside **Run test**.

Tests:
- `social-account.test.ts` runs 14.3's table row by row for both channels and both readings.
- `message-request-channels.test.ts` ("one Facebook account under several spellings") covers, for every pair of spellings in both orders, a prospect against a test contact at save and at the start of a test run.
- The same file runs, for every pair, two leads whose companies give one account in two forms: one session sends one first message and the other lead is skipped as taken. Every number-form and host case fails on `f3c9014`'s normaliser.
- `e2e/message-requests.spec.ts` checks the sentence is shown on Facebook and absent on Instagram.
- `migration-26.test.ts` finds its migration by name, so renumbering after pull request 71 changes only the migration's own `version`.

The generated runs' record reads every Facebook form by its own hand-written rule, and keys a logged destination by that rule before comparing.

**Deferred by the principal on 18 November 2026, to the follow-up issue:**
- the generated runs' alias draws, on Facebook and Instagram, and their mutation;
- HTTP cases for a bad mark and a re-import across spellings;
- the sentence on a Page's limits (item 2);
- a second mutation that needs both channels (item 3).

### 14.10 What is unverified, and why

As 13.12, for Facebook: no Facebook session is connected and no test profile is designated (#28), so everything is verified on the simulated provider only. Unverified: that a session can send each message and how it answers; whether a sent request is visible to the recipient; the platform's limits on the user's profiles and Pages; which kinds of sender can message which accounts (Q45, Q49); whether the URL forms of Q48 identify the account a session can open; the test run on the user's own profile; and whether a session survives the laptop sleeping.

### 14.11 What had to change outside the registry, and why

- **Sender-kind words** (14.2): three screens named a business sender as an Instagram business account.
- **Test support, by channel** (14.7): the harness option, the generated runs and the HTTP tests named Instagram; ticket 25 left them for this ticket.
- **Browser tests:** `e2e/fake-instagram.ts` and `e2e/instagram.spec.ts` became `fake-message-requests.ts` and `message-requests.spec.ts`, run once per channel and once with both; the keyboard checks of the Add track menu count its items from the registry, not by Instagram's position; the win-back menu lists Facebook. The accessibility and layout scans gain each channel's screens and the joint record.
- **Migration tests** that expected the latest version to be 25 now read the number of migrations, so a later migration does not break them.
- **The digest script** (14.8) gains its Instagram form.

Nothing in the engine, the server, the store's code, the reply-action parser or the request schemas changed: they took Facebook from the registry, as the scratch proof of 13.2 found.

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

### The reviews of `dee365d` (council, review bot and verifier, 17 November 2026)

Fifteen items, each reproduced as a failing test first (`src/server/linkedin-screens-review.test.ts`, `src/web/campaign/linkedin-review.test.ts`, `e2e/linkedin-confirmations.spec.ts`, `e2e/linkedin.spec.ts`):

- **Reads that say done** are tied to the stored fact (items 2, 11, 14): `LinkedinTrackView.invite` (`sent`, `handed`); the note is said as gone only when sent; a handed-over step of any channel reads "handed to the provider; it isn't known yet whether it went"; the expiry is said by the withdrawal's state, on the record and the Test run tab through one function (`expiryLine`); an acceptance recorded after the track ended is said as recorded late, with the time LinkedIn gave as an upper bound ("by").
- **An open invite** is one domain test (`inviteOpenOn`, `anyInviteOpen` in `progress.ts`): only the acceptance expiry asks for a withdrawal, so every other ending leaves a sent invite open, and the record, the stop and win-back confirmations and a removing edit's preview say so. The stop and win-back preview digest carries it (`previewDigest`), so a confirmation shown with that sentence is refused once the invite is no longer open (items 6, 7).
- **A LinkedIn session's room** is read per kind wherever it is said (`SessionKinds` on the sequence read and the load's accounts; Needs attention's held work); Needs attention lists LinkedIn steps waiting for capacity by their kind (`forAction`), and one whose kind no session has any allowance for as `noAllowance`, read on the record as `no_allowance` (a view-level reading of the engine's `sending_capacity`, which the generated runs keep asserting) (items 4, 15).
- **The load figure** is withheld as `not_modelled` for any live LinkedIn track of this campaign, session or none, and for one of a campaign competing for its senders, named; said in `ink-2`, not as an error (items 1, 8, 9).
- **Confirmations** are snapshots of the read and the subject they opened on: a test run's close when the shown run changes (or a test is starting), and a mark or answer names its run in its route; the record's LinkedIn confirmations close when the read no longer offers them; each says why, and focus returns to the opening control or the closing line, with `useFocusRescue` for anything else (items 3, 10, 12). A test run's stuck withdrawal is answered on its tab (`POST /api/test-runs/:id/invite-withdrawal`).
- **Words per case**: the first message's changed wait counts from the connection (item 5); each failure reason has its own sentence, a removed connection never "profile not reachable" (item 13).

### The reviews of `a6c1700` and the search on it (17 November 2026)

- **One selection of sessions** (council item 2, review bot): dispatch's `eligibleSessions` (the fixed sender or the pool, less pairs another subject holds, and for an invite only the sessions whose check answered clear) is the one source for every sender-side explanation; `noAllowanceOnAnySession` is built on it and read by `stepWhen`, the record's read, the control previews, the Test run tab and Needs attention. The pool-wide approximation is gone. Through HTTP: the bot's two reproductions and the council's two-session case.
- **The search's L13 failures** (seeds 24011, 24013, 24015, 24037, 24045, 24053, 24054, 24055, 24071, 24094): the record still required `sending_capacity`. It now requires `no_allowance` exactly when no session it finds eligible by section 6 (fixed sender or pool, pairs taken out, an invite's sessions with an invite pending from elsewhere out) has an allowance of the step's kind, and refuses `no_allowance` where one does. Offset 15 joins the fixed seeds, with the mutation "no allowance reads as full for the day".
- **The load figure** (items 3 to 5): a competitor is named as an SMS owner is named, with why it competes (an inbox, a number, a session, the call list, or through another campaign), and only while some running subject of it has its LinkedIn track still to finish; this campaign's own running test says the figure returns when the test ends.
- **Done facts** (items 6 to 10): the invite work that counts is one helper (`invitingWork`: known sent, else the latest unsettled), read by the record, `inviteOpenOn` and so the digest; a withdrawal is said as asked only once the session answered (`withdrawalAsked`), and a stuck one once; a skip as a missing channel carries its stored cause (`skipCause`, from the import's own address, `LeadFacts.importedProfile`, a bad mark, or a profile replaced by a re-import); the inspector and the open-invite sentence say the app asks LinkedIn to withdraw, never that it is withdrawn.

### The review of `82cf16d` and its re-check (17 November 2026)

- **The test run's reply helper** is worded from the run's recorded facts through one function (`testReplyHelper`): a message recorded sent; else the invitation recorded sent (`LinkedinTrackView.invite`, the record's own field); else the invitation handed over and not yet known to have gone, said as that.
- **A skip's cause is recorded when the track finishes** (`finishTrack` sets `TrackProgress.skipCause` by `linkedinSkipCauseOf`; migration 24 adds `track_progress.skip_cause`, constrained to the causes the domain records). A read renders it as recorded: a later re-import, a later bad mark or a company lead gaining a decision maker leaves it unchanged, as the SMS skip's owners are kept. A skip stored before migration 24 has none and reads `unrecorded` ("there was no usable LinkedIn member profile for them at the time"). Tests: the reproduction through HTTP (a company page, then a valid member profile, then that profile marked bad); `migration-24.test.ts` on a database the integration tip `9ae8c38` wrote with its own code (`test/fixtures/upgrade/tip-9ae8c38-linkedin-skip.sql`).

## Consequences

- **ADR 0003.** `TrackChannel` and the account channel gain `linkedin`; `FinishReason` gains `invite_not_accepted`; `StepWait` gains `awaiting_acceptance`; a reply's channel gains `linkedin` (a mark only). Its section 11's "Social tracks" line is replaced by this ADR. Its question numbers continue here.
- **ADR 0001.** A LinkedIn profile is a contact fact of a person read from the import, not a `contact_details` row: it is never matched on, merged or searched. Its bad mark is kept by key.
- **Tickets 25 and 26** are section 13: one shared message-request channel, with Instagram worked through and Facebook one entry in each of 13.2's mappings.
- **Ticket 27** attaches at `inviteExpired` (3.5).
