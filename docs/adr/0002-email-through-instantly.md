# 0002. Email through Instantly: the app owns every clock

- **Date:** 2026-11-12. Revised the same day after two independent reviews of `e8df7ff`.
- **Status:** Proposed. The direction is accepted: app-owned clocks, and Instantly-run sequences rejected. The transport and recovery mechanics stay unverified until the gating experiments X1–X8 pass. Every experiment needs the user's designated test email address, which does not exist yet ([access handoff](https://github.com/Pierpaolo01/omnichannel-outreach/issues/28)).
- **Consumers:** tickets [12](https://github.com/Pierpaolo01/omnichannel-outreach/issues/12), [13](https://github.com/Pierpaolo01/omnichannel-outreach/issues/13), [17](https://github.com/Pierpaolo01/omnichannel-outreach/issues/17), [19](https://github.com/Pierpaolo01/omnichannel-outreach/issues/19), [20](https://github.com/Pierpaolo01/omnichannel-outreach/issues/20), [21](https://github.com/Pierpaolo01/omnichannel-outreach/issues/21).
- **Evidence:** [docs/research/instantly-email-delivery.md](../research/instantly-email-delivery.md) at `32517dd` (cited as "research §n" and "research En"). Instantly facts the decision rests on were re-checked against [`api_v2.json`](https://api.instantly.ai/openapi/api_v2.json) and the help centre; see "Re-checked sources".

## Context

The spec ([#10](https://github.com/Pierpaolo01/omnichannel-outreach/issues/10)) requires per-lead pause, resume and skip; resume from the next unsent step; campaign pause with frozen clocks and no burst; edits that apply to unsent messages without restarting finished leads; prospect-local sending windows; per-account capacity with follow-ups first across campaigns; one sender inbox per lead; continue thread or new subject; and any reply stopping only that lead in that campaign. Instantly's multi-step sequences fall short here, with differing certainty:

| Gap | Certainty |
| - | - |
| No API to pause, resume or skip one lead, and no resume from the next unsent step. Move and re-add restart at step 1 (research §5) | Documented absence |
| No per-lead time zone. A schedule's time zone covers the whole campaign (research §1) | Documented absence |
| Adding a step reactivates completed leads, and the UI requires a pause before editing (research §11) | Documented |
| No delivered state, only sent and bounced (research §8) | Documented absence |
| A reply marks the same person replied in every other campaign while global status sync is on, which is the default (research §7) | Documented |
| Campaign pause does not freeze waits. "The wait time counts from when the previous step was sent", and nothing documents a pause offset | Likely, by implication. Research E5 would confirm |
| Follow-ups first only within one campaign. Across campaigns, "the earliest scheduled campaign is prioritized" (troubleshooting article) | Likely |

The workspace also holds 18 campaigns that predate this project, 3 of them active. They send from the same six inboxes, at 30 a day each.

Two API facts limit the transport:

- `POST /api/v2/emails/reply` sends "only as a reply to an existing email" (`reply_to_uuid`). Its recipients are "the default recipient (the sender of the email being replied to)" plus optional `additional_recipients`. It has no idempotency key. Its documented responses are 200, 401, 402, 404 and 429.
- No endpoint sends a new email outside a campaign. The only other sending endpoint, `POST /emails/test`, sends a preview "without creating an email entity in Unibox", at 10 per minute.

So a thread-opening email must go out through an Instantly campaign. A same-thread follow-up through the reply endpoint is unproven. When the referenced email is our own sent message, its default recipient is our inbox.

Already settled by #28, not reopened here:

- Operation is local-only.
- "Email and SMS keep sending with the laptop off" still stands, but is deferred from verification until hosting is approved.
- Work already handed to Instantly may continue while the app is off.
- Interruption recovery must still send nothing twice and skip nothing.

## Decision

### 1. The app owns every clock

The app's sequence engine holds each lead's position and waits, the prospect-local window, campaign and per-lead pause, skip, stop and resume, edits, inbox affinity and the capacity queue for every channel. No Instantly campaign holds a multi-step sequence for an app campaign. Email, SMS and call tasks share this scheduler.

Logical work and provider work are separate records:

- A **step send** is one logical step for one lead in one campaign. It finishes exactly once: sent, failed, skipped (with a reason), or withdrawn by a pause, stop, skip or edit.
- An **attempt** is one provider call made for a step send. A step send has at most one attempt that is not yet settled. Every attempt and outcome is recorded durably before and after the call.

### 2. Thread-opening steps go through dispatch campaigns

The first step of an email track, and any step set to *new subject*, is sent by adding the lead to a **dispatch campaign**. That is an app-owned Instantly campaign with:

- one step with delay 0, subject `{{oo_subject}}` and body `{{oo_body}}`. The app renders both, including merge fields and fallbacks, and passes them as lead custom variables. HTML in variables is unverified (X1). If it fails, each dispatch campaign carries its step's copy as the template instead;
- `email_list` holding exactly one sender account;
- a schedule open every day 00:00–23:59, so that the app, not Instantly, applies the window;
- `stop_on_reply: true`, `stop_on_auto_reply: true`, `stop_for_company: false`, `insert_unsubscribe_header: true`, `prioritize_new_leads: false`, `daily_max_leads: null`, `email_gap` and `random_wait_max` at their minimum, and open and link tracking off;
- `limit_emails_per_company_override: { mode: "disabled" }`, so the workspace's company limit cannot skip a colleague's healthy track;
- `daily_limit` equal to the account's limit;
- `is_evergreen`, tested in X1 (see below).

A one-step campaign may move to Completed (campaign status 3) once its only lead finishes, and then stop sending to leads added later. X1 tests that case and `is_evergreen`. Until X1 passes, the app checks a dispatch campaign's status before every handover. It never hands over to a campaign that is not Active.

**Keying.** Instantly holds a person once per campaign. Two keyings are possible:

- **Per thread opener** (default until X5): one dispatch campaign per (app campaign, email track, thread-opening step, sender account). The lead stays in the campaign after its send, so Instantly keeps attributing replies to it.
- **Per sender account** (preferred if X5 passes): six dispatch campaigns in total. The app deletes each lead once its send is observed, so the same person can be added again for the next opener. This is adopted only if X5 shows that deleting a sent lead keeps the thread, keeps `GET /emails` records, and still attributes later replies by `thread_id`, not only in the Others folder.

Campaign names are deterministic and prefixed `oo·`, so a retried create finds the existing campaign. Test runs use separate `oo·test` campaigns.

**Attempt lifecycle.** States: `planned → adding → added | rejected → sent | withdrawing → withdrawn | sent-after-withdraw | unresolved`.

- The attempt key is `<step-send id>:<attempt number>`. It is the `idempotency_key` on `POST /leads/add`.
- A retry of the same attempt after a lost response reuses the key and the identical one-lead array. Instantly then "reports the leads it already created in `created_leads`".
- Keys are permanent. After a delete, re-adding with the same key inserts nothing yet still reports success, so a new attempt always takes a new number.
- A new attempt is created only after the previous one has settled as `rejected` or `withdrawn`. It is never created while the previous one is `adding`, `withdrawing` or `unresolved`.
- **Every add result is reconciled.** `status: "success"` does not mean a lead was created. The response reports `leads_uploaded`, `created_leads`, `in_blocklist`, `duplicated_leads`, `invalid_email_count` and `skipped_count`. The app reads these as follows:

  | Add result | What the app does |
  | - | - |
  | Lead created | `added` |
  | `in_blocklist` | `rejected`, reason "address on the Instantly block list" (P6) |
  | `invalid_email_count` | `rejected`. The address is marked bad and the track ends as failed |
  | `duplicated_leads` | Resolved by looking up the existing lead in that campaign. It is never treated as sent |
  | Anything else | Needs attention |

X5 tests add, delete and re-add under both the same-key and the new-key strategy.

**Bounded handover.** Deleting a lead is not cancelling a send, so once a lead is handed over, the app no longer controls it.

- The app hands over only when the step is due, capacity is reserved, and the prospect's window stays open for longer than the measured handover latency plus a margin. X1 measures the latency as a high percentile of time from add to send in an active campaign.
- If a pause, stop, skip or edit arrives during the handover interval, the app tries to withdraw: `DELETE /leads/{id}`, then it watches `GET /emails` for a settling period. If a send appears, the attempt is `sent-after-withdraw`. The app records the copy that actually went out, taken from the sent email body, and applies the control to every step after it.
- For an edit, the app may instead patch the lead's `oo_subject` and `oo_body`. Whether Instantly uses the patched values when the patch races the send is unverified (X5).
- **Until X1 and X5 pass, windows, stop, pause and "edits apply to every message not yet sent" are unverified for the handover interval.** Outside that interval nothing is with Instantly, so they hold by construction.

### 3. Continue-thread follow-ups: transport unverified, gated by X2

The candidate transport is `POST /emails/reply` on the previous message in the lead's thread, from the lead's inbox. It is **not adopted** until X2 shows all of the following for both the plain call and the `additional_recipients: [lead]` variant:

- To is the lead only. The variant must not also address our own inbox.
- From is the lead's inbox.
- In-Reply-To and References link the follow-up to the previous message, and it threads in the recipient's client.
- Whether the sender inbox receives a copy.
- Two consecutive follow-ups with no inbound reply, each replying to our own previous message, still go only to the lead.

If no variant passes, continue thread is not met through Instantly. That is escalated as P7. The app does not silently switch to new-thread follow-ups.

**Reply-call failures.**

- 401, 402 and 404 are permanent. Nothing is retried, and the attempt goes to Needs attention.
- 429 is retryable with backoff. The rate-limit guide says requests over the limit "will fail with the 429 status code".
- A 200 response, a timeout, a 5xx or a lost connection leaves the attempt `adding` until a sent record is observed.
- **An attempt that is never observed is not retried automatically.** `GET /emails` has no documented visibility deadline, so absence cannot be proven, and a call that timed out may complete later. After a settling period the attempt becomes `unresolved` and goes to the user (P5).

### 4. One sender inbox per lead

The app assigns the inbox when the lead's first email step comes due, stores it, and never reassigns it. Every email for that lead in that campaign goes through that inbox's dispatch campaign, or through `eaccount` once X2 passes. While the inbox is unhealthy or its reply observations are stale (section 6), that lead's email work waits, and the inbox shows in Needs attention.

### 5. Capacity is a durable reservation ledger

Analytics is a report, not enforcement. The ledger works per (sender account, Instantly reset day):

- **Reserve.** Before a handover or a reply call, the app writes a reservation for the attempt.
- **Replace.** When the attempt's sent record is observed, the reservation becomes an observed send. A rejected or withdrawn attempt releases its reservation. A `sent-after-withdraw` or `unresolved` attempt keeps it.
- **Count other senders.** Sends by campaigns the app does not own come from `GET /accounts/analytics/daily` `sent` ("campaign emails … including … subsequences"), minus the app's own observed dispatch sends, so nothing is counted twice. Whether `sent` includes reply-endpoint sends is checked in X2. Whether its `date` uses the same day boundary as the limit reset (UTC unless the user changed "Timezone for Campaign Limit Reset") is checked in X8.
- **Order.** Remaining capacity is the account limit minus observed and reserved sends. Within it the app releases follow-ups, oldest due first, then first messages, oldest queued first, across every app campaign. The rest waits for the next day.
- **Instantly's limit stays the hard cap for dispatch sends.** If pre-existing campaigns use the limit first, a handed-over first message waits in Instantly and is withdrawn when its window margin runs out.
- **Unverified (X8):** whether a reply-endpoint send is refused at an exhausted account limit, and how reply sends interact with campaign sends on the same inbox.

### 6. Reply detection

- **Polling.** The app has no public URL, so it polls (research §14). All `GET /emails` calls use `mode=emode_all`, so replies Instantly filed under Others are included, plus `preview_only=false` and `sort_order=asc`. They page with `starting_after` from a checkpoint with a few minutes' overlap, upserting by `Email.id`. The calls, per sender inbox (`eaccount`):
  - `email_type=received` for replies and bounce messages;
  - `email_type=sent` for dispatch sends;
  - `email_type=manual` as well, until X2 shows which type reply-endpoint sends carry.
- **Pre-send check.** Before every send, the app runs `search=thread:<thread_id>` with `email_type=received` on the lead's thread. That endpoint allows 20 requests a minute, which bounds the poll cycle and the rate of pre-send checks. The app budgets for it.
- **Lead statuses.** `POST /leads/list` per dispatch campaign reports lead status: −1 bounced, −2 unsubscribed, −3 skipped.
- **Attribution.** A received email is attributed by `thread_id`, with lead email and campaign as cross-checks. Any attributed reply, auto-reply or unsubscribe stops that lead in that campaign only.
- **Delayed bounces.** On either transport, a bounce marks the address bad and ends the track if it is still running. If the track has already ended, the bounce only marks the address bad. What signal a bounce of a reply-endpoint send produces is unverified (X9).
- **Detection gaps:**
  - Auto-replies appear in Unibox only when the workspace preference "Save auto-replies" is on (P3).
  - Replies from a different address go to Others, and only while "Save non-Instantly emails in Unibox" is on (P3). They are attributable only if they keep the thread. Otherwise they go undetected, which is a documented provider limitation.
  - Instantly "can't check for replies if the sending accounts are paused or disconnected".
- **Stale inboxes.** The app therefore holds every send from an inbox that is not Active, or whose last successful received-poll is older than the freshness bound. The hold lasts until the inbox has been Active through a full poll cycle. Whether replies that arrived during a disconnection are picked up after reconnecting is required evidence (X7).

### 7. Recovery: nothing twice, nothing skipped, stated honestly

On restart, the app processes in this order:

1. received emails;
2. sent emails;
3. open attempts;
4. lead statuses;
5. cross-channel effects;
6. then the scheduler releases overdue work, spread across windows and capacity, and records Today's interruption line.

Dispatch attempts are made safe by the attempt key and add-result reconciliation. Reply attempts cannot be proven absent, so:

- **Nothing twice** holds for automatic behavior: the app never retries an unobserved reply attempt.
- **Nothing skipped** then depends on the user resolving unresolved attempts (P5). Until they do, that lead's email track holds at that step.
- **Matching.** A sent record is matched to an attempt by thread, inbox, a timestamp after the attempt, and not already being claimed by an earlier attempt. Matching by copy hash alone fails when consecutive steps have identical copy. X6 tests whether a per-attempt marker survives in the `GET /emails` body. If it does, matching uses the marker. If it does not, X6's identical-copy case decides whether the remaining ambiguity also goes to P5.

### 8. Reporting

- **Sent:** an observed Instantly sent record.
- **Failed:** a bounce, an invalid address, or a permanent reply-call error.
- **Explained skips** are shown with their reason. A skip is explained when the add result or the lead record gives one, such as the block list or an invalid address.
- **Unexplained skips** (lead status −3 with no reason the API exposes) go to Needs attention, not Failed. They do not end the track until the user decides.
- Email never shows "delivered" (P2).

### Why not option 1

Option 1 has no API for per-lead pause, skip or resume. It could reach them only through two unverified workarounds: an interest-status stop, and subsequences for resume. Edits would need a third: deleting leads when they finish. Its frozen pause clocks and cross-campaign priority are likely not met. Its one advantage is that Instantly keeps sending steps it holds while the laptop is off. Those sends would ignore pauses, per-lead controls and other-channel stops made in the app.

## Option comparison

1. **Instantly owns the sequence:** one Instantly campaign per (app campaign, email track, prospect time zone), with native steps and waits, plus API workarounds.
2. **App clocks, all dispatch:** every step, follow-ups included, is a thread-opening email through a dispatch campaign.
3. **App clocks, hybrid** (chosen): thread openers go through dispatch campaigns. Continue-thread follow-ups go through the reply endpoint once X2 passes.

Marks:

- **By design:** no provider behavior involved.
- **Unverified (Xn):** depends on a provider behavior that the named experiment must confirm.
- **Likely not met:** the sources point that way, but no experiment has confirmed it.
- **Not met:** demonstrated from documentation.

| Agreed behavior | 1. Instantly sequence | 2. App clocks, all dispatch | 3. App clocks, hybrid (chosen) |
| - | - | - | - |
| Per-lead pause, resume, skip | Not met by the API. Only through workarounds, unverified (research E6, E7) | By design outside the handover interval. Interval unverified (X1, X5) | Same as 2 |
| Resume from the next unsent step | Not met (restart at step 1). Workarounds unverified (research E6, E7) | By design | By design |
| Campaign pause freezes clocks | Likely not met (research E5) | By design. Handover interval unverified (X5) | Same as 2 |
| Resume without a burst | Unverified (research E5) | By design | By design |
| Edits apply to unsent messages | Unverified (research E8a). An edit needs a pause | By design outside the handover interval. Interval unverified (X5) | Same as 2 |
| Added step never restarts finished leads | Not met by default. Unverified workaround (research E8e) | By design | By design |
| Removed step skipped by leads not yet at it | Unverified (research E8c, E8d) | By design | By design |
| Prospect-local windows | Only through per-time-zone shards, unverified (research E1, E10) | Unverified: handover latency must fit (X1) | Same as 2 |
| Per-account capacity across app campaigns | Instantly's limit | Unverified (X1, X8) | Unverified (X2, X8) |
| Capacity, including pre-existing campaigns | Instantly's limit | Instantly's limit | Unverified (X8). If replies are uncounted, not met while pre-existing campaigns share the inboxes (P1) |
| Follow-ups first across app campaigns | Likely not met | By design (app queue). Unverified that Instantly does not reorder handovers (X8) | By design for reply follow-ups. Unverified for dispatch (X8) |
| Follow-ups ahead of pre-existing campaigns | Likely not met | Not met: the app cannot order those campaigns (P1) | Not met for the dispatch steps that open new threads (P1) |
| One sender inbox per lead | Within one Instantly campaign. Across shards and tracks only through the UI sticky preference | Unverified (X1) | Unverified (X1, X2) |
| Continue thread vs new subject | Within one track (documented) | Continue thread not met: each dispatch email opens a new thread (research §2, inferred) | Continue thread unverified (X2), and P7 if it fails. New subject through dispatch |
| Any reply stops only that lead in that campaign | Unverified. Depends on P4 and research E4 | App state by design. Detection unverified (X3, X4, X7), with documented gaps (section 6) | Same as 2 |
| Sent and failed | Documented | Unverified (X1, X9) | Unverified (X1, X2, X9) |
| Delivered | Not met (P2) | Not met (P2) | Not met (P2) |
| Test run with waits of about a minute | Unverified (research E1) | Unverified (X1 latency) | Unverified (X1, X2) |
| Laptop off, now (local) | Instantly keeps sending steps it holds, ignoring the app's later controls | Only handed-over work continues | Only handed-over work continues |
| Laptop off, once hosted | Email continues, with the gaps above | By design | By design |
| Restart: nothing twice, nothing skipped | Unverified | Unverified (X5, X6) | Unverified (X6). Reply attempts that cannot be resolved go to the user (P5) |

## Consequences for each consuming ticket

- **#12 Email track.** Build test-first, at these seams, against a fake Instantly adapter:
  - step sends and attempts;
  - the dispatch-campaign manager, which re-asserts the template when `timestamp_updated` changes, so direct Instantly edits are overwritten;
  - add-result reconciliation;
  - the capacity ledger;
  - the poller with the filters above;
  - the stale-inbox hold.

  The reply transport goes behind an interface and is enabled only after X2. Until then the ticket can ship first messages and new-subject steps, and reports continue thread as unverified. Provider proof is X1–X4. "Works independently of the laptop" is reported unverified (#28).
- **#13 SMS beside email.** Same scheduler, windows, ledger and priority rule. A reply on either channel stops the lead's other tracks in app state. The laptop-off criterion stays unverified until hosting.
- **#17 Controls.** Controls are scheduler operations, plus withdrawal of in-flight dispatch attempts. A frozen clock stores the remaining wait at pause and restores it at resume. "Verify real Instantly individual-lead pause": Instantly has none (a documented absence), and the design does not depend on it. The handover interval stays unverified until X5.
- **#19 Running edits.** No Instantly sequence exists to patch, so no finished lead can be reactivated. Messages render at handover. Edits during the handover interval follow section 2 and stay unverified until X5.
- **#20 Laptop off and recovery.**
  - Implement the restart order and attempt states from section 7.
  - Needs attention gains two items: unresolved send attempts and unexplained skips (P5, P6).
  - The stale-inbox hold feeds sender-account problems.
  - While local, each shutdown is an interruption (P8).
- **#21 Test run.**
  - Same scheduler, with waits overridden to about a minute, `oo·test` dispatch campaigns and the real inboxes.
  - Test sends reserve capacity like any other send.
  - The first message arrives after the handover latency measured in X1.
  - Continue-thread steps in a test run depend on X2.
  - Running again uses new step-send ids and therefore new attempt keys.

## Experiments

Run them in `oo·test` campaigns with one lead, the test contact, from the real inboxes. Redact addresses in recorded payloads. Nothing goes to a prospect.

**Gating** (all need S1):

- **X1 Dispatch send.**
  - Create and activate a dispatch campaign. Add the test contact with HTML `oo_subject` and `oo_body`.
  - Measure activation to first send, and the distribution of time from add to send in an already Active campaign. This sets the handover margin.
  - Confirm the single sender, the variable rendering, and the `GET /emails` record (`ue_type`, `step`, `thread_id`).
  - **Completion case:** let the only lead finish, read the campaign status, add a second address, and check whether it sends. Repeat with `is_evergreen: true`.
- **X2 Reply transport gate.** Test the plain call and the `additional_recipients: [lead]` variant, each with two consecutive follow-ups and no inbound reply. Record:
  - the To, Cc and From headers received;
  - In-Reply-To and References, and threading in the test contact's client;
  - whether the sender inbox gets a copy;
  - which `email_type` the sends carry, and their `ue_type`, `campaign_id` and `thread_id`;
  - whether `GET /accounts/analytics/daily` `sent` increases;
  - whether a List-Unsubscribe header is present.
- **X3 Reply detection.** The test contact replies to a dispatch email, then to a follow-up, then sends an out-of-office reply (with "Save auto-replies" off, then on), then uses the unsubscribe link. Then the test contact replies from a second address of theirs, if one is designated.
  - Measure time from reply to visibility.
  - Confirm `thread_id` attribution, the `mode=emode_all` coverage of Others, and that the pre-send check blocks the next step.
- **X4 Status sync across campaigns.** Put the test contact in two test app campaigns and reply in one. Check the other dispatch campaign, and a new add to a third. Repeat after P4, if P4 is approved.
- **X5 Attempts, withdrawal and keying.**
  - Add, then delete before the send, then re-add with the same key, then with a new key. Record each response and whether a lead exists and sends.
  - Patch `oo_body` on a handed-over lead and check which copy is sent.
  - Delete a lead after its send, then reply in its thread. Check that the thread, the `GET /emails` records and reply attribution survive. This decides per-account keying.
  - Pause a lead and the campaign during a wait, and check that resuming preserves the remaining wait.
- **X6 Crash and recovery.**
  - Kill the app between the call and recording it, for a dispatch add and for a reply call.
  - Simulate a lost response on a call that succeeded, and a delayed completion: the call times out on our side, and its sent record appears only after the first lookup.
  - Send two consecutive steps with identical copy.
  - Check whether a per-attempt marker in the body survives into `GET /emails`.
  - Confirm that nothing is sent twice, and that unresolved attempts surface instead of retrying.
  - Check that `timestamp_created` works as a checkpoint across the overlap.
- **X7 Unhealthy inbox** (needs S2). Pause one inbox in the UI.
  - Observe account status, dispatch campaign status and sending status, and the reply endpoint's response.
  - Reply to that inbox while it is paused, reconnect it, and check whether the reply is detected and whether the stale-inbox hold released correctly.
- **X8 Capacity** (needs S4).
  - On one inbox with a temporarily lowered limit, send campaign sends and reply sends together.
  - Call the reply endpoint at the exhausted limit and record whether it is refused.
  - Check that analytics `date` matches the limit-reset day boundary.

**Wanted, not gating:**

- **X9 Bounce** (needs S3). Record the bounce signal for a dispatch send and for a reply send. Record its delay, and whether hard and soft bounces can be told apart.
- **X10 End-to-end test run.** A three-step track (continue thread, new subject, continue thread) with one-minute waits. This is #21's demonstration.

## Escalation

### Product decisions for the human

- **P1.** Should the 3 active pre-existing campaigns keep sending from the six inboxes once app campaigns launch? While they do, app first messages cannot be put ahead of their sends. If X8 shows replies are uncounted, an inbox can also exceed its limit. *Recommendation:* finish or pause them, or move them off these inboxes, before the first real launch.
- **P2.** Is it acceptable that email shows only "sent" or "failed", never "delivered", because Instantly reports no delivered state? *Recommendation:* yes.
- **P3.** May the factory turn on the "Save auto-replies" and "Save non-Instantly emails in Unibox" preferences? They are UI-only and workspace-wide. Without them, auto-replies and replies from other addresses are not seen, so "any reply stops" is not met for those replies. With them on, the user's Unibox for all 18 existing campaigns fills with those emails, and existing campaigns may start stopping leads on auto-replies they currently miss (X3 will show). *Recommendation:* yes for both, after X3 confirms the effect.
- **P4.** May global lead status sync be turned off (the UI toggle "Disable Global Lead Status Synchronization")? Off matches "other enrollments keep running". It also stops a reply in any of the user's 18 existing campaigns from marking the person replied in their other campaigns, which removes a safety net those campaigns rely on today. *Recommendation:* decide after X4. Turn sync off only if X4 shows it stops dispatch sends in other app campaigns.
- **P5.** When the app cannot tell whether a follow-up was sent, may it hold that lead's email track and show the item in Needs attention, where the user can mark it sent, send it, or skip it? This adds an item type to #20's list. *Recommendation:* yes. It is the only way to keep "nothing twice" without guessing.
- **P6.** Instantly refuses any address on the workspace block list, while the spec says no import exclusions. Should a block-listed address skip the email track with the reason shown, without marking the address bad? Should unexplained Instantly skips wait in Needs attention instead of failing? *Recommendation:* yes to both.
- **P7** (only if X2 fails). If Instantly cannot send an in-thread follow-up to the prospect, should "continue thread" steps go out as new emails, or should the user be told that continue thread is unavailable on email? *Recommendation:* make it visible in the editor as unavailable and let the user choose new subject. Never send new-thread mail labelled as continuing the thread.
- **P8.** While operation is local, each laptop shutdown is an interruption. Should Today show "sending was interrupted from X to Y; N sends rescheduled" after every shutdown? *Recommendation:* yes, it is accurate. #28 already settles that the laptop-off requirement is deferred until hosting, so it is not asked again.
- **P9.** Should unsubscribes from any campaign go on the workspace block list (`add_unsub_to_block`)? The API returned no value on 12 November 2026. On would stop the person's other app enrollments and change the user's existing campaigns. *Recommendation:* off, to match "only that campaign".

### Setup steps only the human can do

- **S1.** Designate a test email address in #28, and a second address of theirs if they want the different-address case in X3. This blocks every experiment.
- **S2.** Consent to pause one sender inbox in the UI for X7. Any pre-existing campaigns using that inbox stop sending from it while it is paused.
- **S3.** A hard-bouncing address the user controls, for X9. Otherwise bounce handling stays documentation-only.
- **S4.** Consent to lower one inbox's daily campaign limit for part of a day, for X8. Pre-existing campaigns on that inbox send less that day.
- **S5.** Report the "Timezone for Campaign Limit Reset" preference value. It is UI-only, with a default of UTC. Changing it would move the reset day for every existing campaign.
- **S6.** Apply whichever of P3, P4 and P9 are approved. P3 and P4 exist only in the UI.

## Re-checked sources (12 November 2026)

- `api_v2.json` 2.0.0, 198 paths:
  - **`POST /emails/reply`:** reply-only. `additional_recipients` is "in addition to the default recipient (the sender of the email being replied to)". There is no idempotency key. Responses are 200, 401, 402, 404 and 429.
  - **`POST /leads/add`:** "checks against blocklists and existing leads". `idempotency_key` says: "A key is permanent: use a new one for every batch", and a retry "reports the leads it already created". The response carries `status`, `leads_uploaded`, `created_leads`, `in_blocklist`, `duplicated_leads`, `skipped_count` and `invalid_email_count`.
  - **`GET /emails`:** `email_type` is `received`, `sent` or `manual`. `mode` is `emode_focused`, `emode_others` or `emode_all`. It also takes `search=thread:<id>` and `lead`.
  - **Statuses:** `Campaign.status` 3 means Completed. `Campaign.is_evergreen` has no documented semantics. `Campaign.limit_emails_per_company_override.mode` takes `custom` or `disabled`. `Lead.status` −3 means Skipped. `Lead` has no time-zone field.
  - **`GET /accounts/analytics/daily`:** `sent` counts campaign emails, and the time zone of `date` is undocumented.
- Help centre and developer guides:
  - [Rate limit](https://developer.instantly.ai/getting-started/rate-limit): requests over the limit "will fail with the 429 status code".
  - [Account and campaign limits](https://help.instantly.ai/en/articles/6248612-setting-account-and-campaign-limits): the account limit counts campaign emails.
  - [Add steps to an active campaign](https://help.instantly.ai/en/articles/13924383-how-to-add-new-steps-to-an-active-campaign): waits count from the previous send, editing requires a pause, and completed leads are reactivated.
  - [Preferences](https://help.instantly.ai/en/articles/11864294-preferences-settings-overview): global status sync is ON by default, sticky accounts apply to the first email, and the limit resets in UTC by default.
  - [Follow-ups after reply](https://help.instantly.ai/en/articles/13886841-why-follow-ups-are-still-being-sent-to-leads-who-replied): the "Save auto-replies" preference is needed, replies from a different address land in Others under "Save non-Instantly emails in Unibox", and "can't check for replies if the sending accounts are paused or disconnected".
  - [Multiple schedules](https://help.instantly.ai/en/articles/6573695-multiple-schedules): use separate campaigns per time zone.
- Workspace, read-only `GET` on 12 November 2026: the record returned no `add_unsub_to_block` value. Nothing was created, changed, paused, activated or sent.
