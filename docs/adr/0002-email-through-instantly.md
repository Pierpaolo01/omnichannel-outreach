# 0002. Email through Instantly: the app owns every clock

- **Date:** 2026-11-12
- **Status:** Proposed. Final once experiments X1–X6 pass. Each needs the user's designated test email address, which does not exist yet ([access handoff](https://github.com/Pierpaolo01/omnichannel-outreach/issues/28)).
- **Consumers:** tickets [12](https://github.com/Pierpaolo01/omnichannel-outreach/issues/12), [13](https://github.com/Pierpaolo01/omnichannel-outreach/issues/13), [17](https://github.com/Pierpaolo01/omnichannel-outreach/issues/17), [19](https://github.com/Pierpaolo01/omnichannel-outreach/issues/19), [20](https://github.com/Pierpaolo01/omnichannel-outreach/issues/20), [21](https://github.com/Pierpaolo01/omnichannel-outreach/issues/21).
- **Evidence:** [docs/research/instantly-email-delivery.md](../research/instantly-email-delivery.md) at `32517dd` (cited as "research §n" and "research En"). Claims this decision rests on were re-checked on 12 November 2026 against [`api_v2.json`](https://api.instantly.ai/openapi/api_v2.json) and the help centre; see "Re-checked sources" at the end.

## Context

The spec ([#10](https://github.com/Pierpaolo01/omnichannel-outreach/issues/10)) says the app pushes email tracks to Instantly and that Instantly enforces per-account limits. It also requires, for every lead and every campaign, behavior that Instantly's own multi-step sequences cannot provide:

1. No per-lead pause, resume or skip in API v2, and no resume from the next unsent step. Moving or re-adding a lead restarts it at step 1 (research §5).
2. Campaign pause does not freeze waits: "The wait time counts from when the previous step was sent" (research §5).
3. Adding a step to a running campaign reactivates leads that already finished (research §11).
4. No per-lead time zone. A schedule's time zone applies to the whole campaign (research §1).
5. Follow-ups go first only within one campaign. Across campaigns sharing an inbox, "the earliest scheduled campaign is prioritized" (research §4).
6. By default a reply marks the same person replied in every other campaign (research §7).
7. Instantly has sent and bounced, but no delivered state (research §8).

The workspace also holds 18 campaigns that predate this project, 3 of them active, sending from the same six inboxes at 30 emails per inbox per day (research, workspace snapshot).

Operation is local-only for now ([#28](https://github.com/Pierpaolo01/omnichannel-outreach/issues/28#issuecomment-6831178703)). "Keeps sending with the laptop off" is unverified by instruction until hosting is approved.

Two API facts limit the design space:

- `POST /api/v2/emails/reply` "can be used to send an email only as a reply to an existing email". It takes `reply_to_uuid`, `eaccount`, `subject` and `body`, and has no idempotency key.
- No endpoint sends a new, non-reply email outside a campaign. `POST /emails/test` sends a preview "without creating an email entity in Unibox", at 10 per minute, so replies to it are not tied to a lead.

So every email that opens a thread must go out through an Instantly campaign. A follow-up in the same thread can go out either as a campaign step or through the reply endpoint.

## Decision

**The application owns every clock. Instantly is the email transport.** This is option 3 in the comparison.

1. **One scheduler for all channels.** The app's sequence engine holds each lead's position, its waits, the prospect-local sending window, campaign and per-lead pause, skip, stop and resume, edits, and the per-account capacity queue. It decides when each email step is due. Email, SMS and call tasks share this scheduler. No Instantly campaign holds a multi-step sequence for an app campaign.
2. **Thread-opening steps go through dispatch campaigns.** The first step of an email track, and any step set to *new subject*, is sent by adding the lead to a **dispatch campaign**. A dispatch campaign is an app-owned Instantly campaign with:
   - one step with delay 0, subject `{{oo_subject}}` and body `{{oo_body}}`;
   - `email_list` holding exactly one sender account;
   - a schedule open every day 00:00–23:59, so the app's window decides and Instantly's does not;
   - `stop_on_reply: true`, `stop_on_auto_reply: true`, `stop_for_company: false`, `insert_unsubscribe_header: true`, `prioritize_new_leads: false`, `daily_max_leads: null`, `email_gap` and `random_wait_max` at their minimum, and open and link tracking off;
   - a `daily_limit` equal to the account's limit, so the account limit is the only Instantly cap.

   The app renders subject and body itself, merge fields and fallbacks included, and passes them as the lead's custom variables at the moment the step is due. The preview and the sent copy then come from the same renderer. Edits apply to every message not yet handed over.

   Instantly holds a person once per campaign, so the dispatch campaign key is (app campaign, email track, thread-opening step, sender account). Campaigns are created lazily, only for accounts in use, with a deterministic name prefixed `oo·` so a retry finds the one already created. Test runs use their own dispatch campaigns, keyed the same way with a `test` marker.
3. **Continue-thread follow-ups go through `POST /emails/reply`.** The app replies to the previous message in the lead's thread (`reply_to_uuid` = its Instantly `Email.id`) from the lead's sender account (`eaccount`). It sends `Re: <thread subject>` and the rendered body.
4. **One sender inbox per lead.** The app assigns the inbox when the lead first becomes due in the campaign and stores it. Every later email for that lead in that campaign uses it: the matching single-account dispatch campaign, or `eaccount` on replies. The app never reassigns. While that inbox is unhealthy, the lead's email work waits and the account shows in Needs attention.
5. **Capacity ledger.** For each sender account and Instantly reset day (UTC unless the user changed Instantly's "Timezone for Campaign Limit Reset"), the remaining capacity is the account `daily_limit`, minus campaign sends Instantly reports for that account today (`GET /accounts/analytics/daily`, which covers the user's pre-existing campaigns), minus the app's own reply sends today, unless X2 shows Instantly already counts them, minus work handed over but not yet sent. Within what remains, the app releases due work in this order: follow-ups, oldest due first, then first messages, oldest queued first, across every app campaign. The rest waits for the next day. The app spaces its own sends by at least the account's `sending_gap` and spreads them across the window.
6. **Handover sweep.** A lead that Instantly has not sent within a bounded time after its dispatch add (set from X1's measured latency), or whose window has closed, is removed from the dispatch campaign with `DELETE /leads/{id}` and goes back in the queue. Before re-queuing, the app checks `GET /emails` for a send that raced the delete. The same sweep removes handed-over leads when a lead or campaign is paused or stopped.
7. **Observation by polling.** The app has no public URL, so it polls (research §14):
   - `GET /emails` with `email_type=sent` and `received`, from a checkpoint with a few minutes' overlap, upserting by `Email.id`;
   - `POST /leads/list` for dispatch campaigns, for bounced (−1), unsubscribed (−2) and skipped (−3) status;
   - `GET /accounts` and `sending-status` for account and campaign health.

   A received email is attributed to a lead and campaign by `thread_id`, with the lead email and the dispatch campaign as cross-checks. Any received email in the thread, an unsubscribe, or an auto-reply stops that lead in that campaign only. Before every send the app checks the lead's thread for a new received email. Webhooks are added as a latency improvement once the app is hosted, and the sweep stays.
8. **Nothing sent twice, nothing skipped.** Before any provider call the app writes a send intent: lead, step, account, rendered-copy hash, and a deterministic key. Dispatch adds use the intent key as `idempotency_key` on `POST /leads/add`. A reply call has no idempotency key, so an intent left `sending` after a crash is resolved by looking up the thread's sent messages (`GET /emails?lead=…&eaccount=…` from the intent's time). A match is recorded as sent. A clear absence is re-sent. Any ambiguity goes to Needs attention and is never resent blindly. On restart, the order is: received emails, then sent emails, then unresolved intents, then lead statuses, then cross-channel effects. Only after that does the scheduler release overdue work, spread across windows and capacity, and record the interruption line for Today.
9. **Reporting.** Sent means an Instantly sent record exists (`ue_type` 1 from a dispatch campaign, or 3 from a reply). Failed means a bounce, a reply call rejected by Instantly, or a dispatch lead skipped (−3). Email never shows "delivered"; see escalation P2.
10. **Fallback.** If X2 shows that replies sent through the API do not thread for the recipient, or are not recorded so the app can see them, the app falls back to option 2: every step through a dispatch campaign. *Continue thread* then becomes a demonstrated provider limitation, reported with X2's evidence and not hidden.

Option 1 is rejected. It fails pause with frozen clocks and cross-campaign follow-up priority by documentation, with no write-path experiment that could rescue either. Pause, skip and resume would depend on two unverified workarounds (interest status and subsequences), and edits on a third (delete on finish). Its only advantage is email sending with the laptop off before hosting exists, and that sending would ignore stops from other channels and pauses made in the app.

## Option comparison

Options:

1. **Instantly owns the sequence.** One Instantly campaign per (app campaign, email track, prospect time zone), with native steps and waits. The app pushes copy, adds leads, polls, and works around the gaps with interest-status stops, subsequences and lead deletion.
2. **App owns every clock. Every step is a first email.** Each step is sent by adding the lead to a single-step dispatch campaign.
3. **App owns every clock. Hybrid transport** (chosen). Thread-opening steps go through single-step, single-account dispatch campaigns, and continue-thread follow-ups through `POST /emails/reply`.

Marks: **Met**. **Met after Xn / research En**: the named write-path experiment must confirm it. **Not met**: demonstrably not met, with the reason.

| Agreed behavior | 1. Instantly sequence | 2. App clocks, all dispatch | 3. App clocks, hybrid (chosen) |
| - | - | - | - |
| Per-lead pause and resume | Not met by the API. A workaround (stop by interest status, resume by subsequence) works only if research E6/E7 pass | Met. In-flight handovers removed by the sweep (X5) | Met. In-flight handovers removed by the sweep (X5) |
| Per-lead skip current step | Not met by the API. Only through a subsequence holding the remaining steps (research E7) | Met | Met |
| Resume a stopped or replied lead from the next unsent step | Not met: move and re-add restart at step 1. Possible only if research E6 or E7 passes | Met | Met |
| Campaign pause freezes every clock | **Not met**: waits count from the previous send, and there is no per-lead delay override | Met | Met |
| Resume without a burst | Met after research E5 (only gaps and limits spread sends) | Met: the app spreads sends | Met: the app spreads sends |
| Copy or wait edits apply to unsent messages | Met after research E8a (PATCH may need a pause, which then hits the frozen-clock gap) | Met | Met |
| Added step reaches leads in the track; finished leads never restart | **Not met** by default: an added step reactivates completed leads. Met only if research E8e (delete on finish) passes | Met | Met |
| Removed step skipped by leads not yet at it | Met only after research E8c/E8d (step index shift) | Met | Met |
| Prospect-local sending windows | Met only through per-time-zone campaign shards, after research E1/E10. Shards split capacity and inbox affinity | Met after X1 (handover latency fits the window) | Met after X1 (handover latency fits the window) |
| Per-account capacity across app campaigns | Met: Instantly's account limit | Met: dispatch sends are campaign sends | Met after X2: the ledger counts reply sends; X2 shows whether Instantly counts them too |
| Capacity including the pre-existing campaigns | Met: one shared Instantly limit | Met: one shared Instantly limit | Met if X2 shows replies count toward the account limit. Otherwise **not met** while pre-existing campaigns share the inboxes (P1) |
| Follow-ups first, oldest due first, across app campaigns | **Not met**: only within one Instantly campaign, and shards make it worse | Met (app queue) | Met (app queue) |
| Follow-ups first ahead of pre-existing campaigns' sends | **Not met** | **Not met**: the app cannot order the user's other campaigns (P1) | **Not met** for their first messages (P1). App follow-ups through replies are not queued behind them |
| One sender inbox per lead for the whole campaign | Met within one Instantly campaign. Across tracks, shards and win-back only through the UI "Sticky sending accounts" preference, first email only | Met after X1 (single-account campaigns) | Met after X1 and X2 |
| Continue thread vs new subject | Met within one track (empty subject continues) | **Not met** for continue thread: each dispatch first email opens a new thread (inferred, research §2) | Met after X2 (reply threads); new subject through dispatch |
| Any reply stops only that lead in that campaign | Met only after the UI sync toggle (S2) and research E4. The app must also stop the lead's other tracks and shards | Met in app state. Dispatch sends need S2 and X4 | Met in app state by thread attribution. Dispatch sends need S2 and X4 |
| Unsubscribe and remove-me stop the lead | Met (research E2) | Met (X3) | Met after X3. Whether reply sends carry the unsubscribe header is checked in X2 |
| Sent and failed on the timeline | Met | Met | Met after X2 (reply sends visible and bounces reported) |
| Delivered on the timeline | **Not met**: Instantly has no delivered state (P2) | **Not met** (P2) | **Not met** (P2) |
| Hard bounce marks the address bad and ends the track | Met after research E9 | Met after X8 | Met after X8 |
| Test run with waits of about a minute | Met after research E1 (email gap, 10–15 minute activation delay) | Met after X1 | Met. Follow-ups are sent by the app on its minute clock; the first message's latency comes from X1 |
| Email continues with the laptop off: **now, local-only** | Instantly keeps sending steps it already holds, but ignores stops from SMS and calls, pauses and per-lead controls made since, and starts no "after" tracks | Not met: nothing new is handed over while the app is off | Not met: nothing new is handed over while the app is off. Fails safe: nothing sends against a pause or a stop the app knows about (P3) |
| Email continues with the laptop off: **once hosted** | Met for email, with the gaps above unchanged | Met, with full cross-channel coordination | Met, with full cross-channel coordination |
| Restart reconciliation, nothing twice or skipped | Met after a reconciliation test: Instantly holds the record | Met after X6: lead-add idempotency key | Met after X6: write-ahead intents plus a sent-message lookup for reply calls |

## Consequences for each consuming ticket

- **#12 Email track.** Build these at named seams, test-first against a fake Instantly adapter, then prove them with X1–X4:
  - the scheduler and email step model;
  - a dispatch campaign manager: lazy create, template re-asserted when `timestamp_updated` changes, so direct Instantly edits are overwritten at the next push;
  - a reply sender;
  - the capacity ledger;
  - the poller with checkpoints;
  - send intents.

  "Pushes email tracks" is met by pushing each rendered message. Copy is still edited only in the app. The timeline shows sent and failed. "Delivered" depends on P2. "Automated email must work independently of the laptop" is reported **unverified** under the local-only boundary.
- **#13 SMS beside email.** SMS uses the same scheduler, windows, capacity ledger and priority rule. A reply on either channel stops the lead's other tracks as a change in app state, with no provider call. Together and after connections are scheduler edges. The laptop-off criterion stays unverified until hosting, as for email.
- **#17 Controls.** Pause, resume, skip, stop and resume-from-next-unsent are scheduler operations, plus a sweep of in-flight dispatch handovers. Frozen clocks mean the scheduler stores the remaining wait at pause and restores it at resume. The ticket's "verify real Instantly individual-lead pause" is answered by this ADR: Instantly has none (research §5, demonstrated from the API). The design does not depend on it. Provider proof comes from X5: a paused lead receives nothing, and the next step after resume arrives in the same thread from the same inbox.
- **#19 Running edits.** No Instantly sequence exists to patch, so no lead can be reactivated by an edit. Edits change the app's step model. Messages render at handover, so unsent messages pick up the change. Thread-opening and continue-thread choices and inbox affinity are app data and survive edits. A paused campaign takes edits the same way.
- **#20 Laptop off and recovery.** While local, nothing email or SMS is sent with the app off, apart from dispatch handovers already in Instantly's queue, which the sweep keeps short. Once hosting is approved the scheduler runs continuously, which this design needs in order to meet the criterion. Build the restart order from decision 8 and the interruption line from the scheduler's gap. Needs attention reads:
  - the ledger, for leads waiting on sending capacity;
  - `Account.status` and dispatch campaign status, for account problems;
  - unresolved intents, for anything ambiguous.
- **#21 Test run.** A test run uses the same scheduler with every wait overridden to about one minute, test dispatch campaigns and the real inboxes. Test sends go through the ledger like any other send. The first message arrives after X1's measured handover latency. Each later step arrives about a minute after the previous one. A reply from the test contact stops the test by thread attribution. Running again uses a fresh test dispatch key, so nothing has to be deleted to restart.

## Experiments before this decision is final

All need the user's designated test email address. Run them in `oo·test` dispatch campaigns with one lead, the test contact, from the real inboxes. Record payloads with addresses redacted. Nothing goes to a prospect.

- **X1 Dispatch send.** Create a dispatch campaign as specified, activate it, then add the test contact with rendered `oo_subject` and `oo_body` (HTML with line breaks, a link and non-ASCII text).
  - Measure activation to first send, and lead add to send in an already active campaign.
  - Confirm the single sender, the rendering of HTML variables, the `GET /emails` record (`ue_type` 1, `step`, `thread_id`) and the lead's status after its only step.
  - If HTML in variables fails, the app keeps one dispatch campaign per step and pushes the step copy as the template instead.
- **X2 In-thread reply.** Call `POST /emails/reply` on X1's message.
  - Confirm it lands in the same thread in the test contact's client, from the same inbox.
  - Confirm it appears in `GET /emails` (`ue_type`, `lead`, `campaign_id`, `thread_id`).
  - Check whether it raises `sent` in `GET /accounts/analytics/daily` and so counts toward the account limit.
  - Check whether it carries a List-Unsubscribe header.
  - Check its spacing against the account `sending_gap`.
  - Failing threading or visibility triggers the fallback in decision 10.
- **X3 Reply detection.** The test contact replies to a dispatch email, then to a reply-sent follow-up, then sends an out-of-office auto-reply, then uses the unsubscribe link.
  - Measure time from reply to visibility through polling.
  - Confirm `thread_id` attribution and that the pre-send check blocks the next step.
- **X4 Status sync across campaigns.** Put the test contact in two test app campaigns and reply in one.
  - Check whether Instantly marks or skips the person in the other dispatch campaign, and whether a new add to a third dispatch campaign still sends.
  - Repeat after S2.
- **X5 Pause, skip, resume and sweep.** Pause a lead during a wait and resume it. Skip a step. Stop a lead and resume it from the next unsent step.
  - Add a lead to a dispatch campaign and delete it before it sends; confirm nothing sends.
  - Delete a dispatch lead after its send; confirm the sent record and thread survive.
  - Pause the campaign for longer than the remaining wait; confirm the remaining wait is preserved after resume.
- **X6 Crash and restart.** Kill the app between a provider call and recording it, both for a dispatch add and for a reply.
  - Confirm that restart finds the send and sends nothing twice.
  - Confirm that an intent which never reached Instantly is sent once.
  - Check that `timestamp_created` stays usable as a polling checkpoint across the overlap.

Wanted but not blocking, because each needs more than the test address:

- **X7 Unhealthy inbox.** Needs consent to pause one inbox in the UI (S4). Confirm the dispatch campaign holds and the reply endpoint errors instead of rerouting.
- **X8 Bounce.** Needs an address the user owns that hard-bounces (S5). Record the bounce signal for a dispatch send and for a reply send, and whether hard and soft bounces can be told apart.
- **X9 End-to-end test run.** Run a three-step track (continue thread, new subject, continue thread) with one-minute waits. This is #21's demonstration.

## Escalation

### Product decisions for the human

- **P1. Should the three active pre-existing Instantly campaigns keep sending from the same six inboxes once app campaigns launch?** While they do:
  - the app cannot put its follow-ups ahead of their first messages;
  - if X2 shows API replies are not counted, an inbox can exceed its daily limit, because those campaigns may still spend the full Instantly limit after the app has sent.

  *Recommendation:* before the first real launch, the user finishes or pauses those campaigns, or removes the six inboxes from them, so app campaigns are the only senders. If the user keeps them, the app counts their sends against each inbox's capacity, and the gap above is reported as a known limitation.
- **P2. Is it acceptable that email messages show "sent" or "failed" and never "delivered"?** Instantly reports sent and bounced only, and the spec forbids inventing states. *Recommendation:* yes. Email shows sent and failed. Delivered appears only on channels whose provider reports it, such as SMS later.
- **P3. Until hosting is approved, may email stop while the laptop is off, rather than letting Instantly send on its own clocks?** Letting Instantly keep sending would break frozen pause, per-lead controls, follow-up priority and cross-channel stops. *Recommendation:* yes. Accept that "email keeps sending with the laptop off" stays unmet and is reported unverified until the hosting access and spending ceiling already pending in #28 arrive. The same design meets it once hosted.

### Setup steps only the human can do

- **S1. Designate a test email address** in #28. It blocks X1–X6, and the decision stays proposed until then.
- **S2. Turn on "Disable Global Lead Status Synchronization"** in Instantly → Settings → Preferences. It exists only in the UI. Effect on existing campaigns: a reply in any campaign, including the user's 18 pre-existing ones, stops marking the same person "Reply received" in their other campaigns. A webhook no longer fires again for each campaign the address is in. Without it, a reply can stop a person's dispatch sends in other app campaigns, against "other enrollments keep running".
- **S3. Decide the workspace "add unsubscribes to block list" setting (`add_unsub_to_block`).** The API returned no value on 12 November 2026, so its state is unknown. When on, an unsubscribe in any campaign blocks the address across the workspace. That would stop the person's other app enrollments too, and it applies to the pre-existing campaigns. The spec stops only that campaign, so off matches the spec. The factory will not change it without the user's instruction.
- **S4. Consent for X7:** briefly pausing one sender inbox in the UI while its campaigns, including any pre-existing ones, stop sending from it.
- **S5. A hard-bouncing address the user controls for X8**, or acceptance that bounce handling stays verified from documentation only.
- **S6. Report the "Timezone for Campaign Limit Reset" preference**, which exists only in the UI (default UTC). The capacity ledger must use the same day boundary. Changing it would move the daily reset for every existing campaign, so the recommendation is to leave it and tell the factory its value.

## Re-checked sources (12 November 2026)

- `api_v2.json` 2.0.0, 198 paths, downloaded on 12 November 2026:
  - `POST /api/v2/emails/reply`: reply-only, with the required fields above and no idempotency key.
  - No other endpoint sends a new email except `/emails/test`.
  - `Lead` has no time-zone field.
  - `Email.ue_type`: 1 sent from campaign, 2 received, 3 sent, 4 scheduled. `campaign_id` "can be null for manually sent emails".
  - `GET /accounts/analytics/daily` `sent`: "campaign emails … including emails for subsequences".
  - `Workspace.add_unsub_to_block` exists; no global-sync field exists.
- Help centre:
  - [Account and campaign limits](https://help.instantly.ai/en/articles/6248612-setting-account-and-campaign-limits): the account limit counts "campaign emails … across all campaigns", and the minimum wait applies across campaigns.
  - [Add steps to an active campaign](https://help.instantly.ai/en/articles/13924383-how-to-add-new-steps-to-an-active-campaign): waits count from the previous send, editing requires a pause, and completed leads are reactivated.
  - [Preferences](https://help.instantly.ai/en/articles/11864294-preferences-settings-overview): global status sync is ON by default, sticky sending accounts apply to the first email, and the limit resets in UTC by default.
  - [Multiple schedules](https://help.instantly.ai/en/articles/6573695-multiple-schedules): separate campaigns per time zone.
- Workspace, read-only `GET` on 12 November 2026: the workspace record returned no `add_unsub_to_block` value. Nothing was created, changed, paused, activated or sent.
