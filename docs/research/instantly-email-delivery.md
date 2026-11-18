# Email delivery through Instantly

Research for [MVP: launch an email track through Instantly and stop on reply](https://github.com/Pierpaolo01/omnichannel-outreach/issues/12). Tickets [13](https://github.com/Pierpaolo01/omnichannel-outreach/issues/13), [17](https://github.com/Pierpaolo01/omnichannel-outreach/issues/17), [19](https://github.com/Pierpaolo01/omnichannel-outreach/issues/19), [20](https://github.com/Pierpaolo01/omnichannel-outreach/issues/20) and [21](https://github.com/Pierpaolo01/omnichannel-outreach/issues/21) rely on the same facts. Checked **12 November 2026** against [the spec](https://github.com/Pierpaolo01/omnichannel-outreach/issues/10), Instantly's API v2 reference and help centre, and read-only calls to the user's workspace.

## How to read this note

Each finding carries one of three marks:

- **Documented**: stated in a first-party Instantly source, linked inline.
- **Observed**: seen in a read-only API call to the workspace on 12 November 2026. Aggregates only.
- **Unverified**: needs a write, a send or a test contact. The experiments at the end cover these.

Primary sources:

- The machine-readable OpenAPI document, [`api_v2.json`](https://api.instantly.ai/openapi/api_v2.json), version 2.0.0 with 198 paths. The API reference pages at `developer.instantly.ai/api-reference/...` are rendered from it. Field names and enum meanings below come from it unless another link is given.
- [Webhook events guide](https://developer.instantly.ai/guides/webhook-events), [rate limit](https://developer.instantly.ai/getting-started/rate-limit), [authorization](https://developer.instantly.ai/getting-started/authorization).
- Help centre articles at `help.instantly.ai`, linked where used.

Method: the read-only calls used GET, plus `POST /api/v2/leads/list`, which is a read endpoint that takes POST. Every request had an explicit User-Agent. Nothing was created, changed, paused, activated, sent or tested. The workspace has no webhooks, so webhook delivery was not seen.

## Workspace snapshot (observed)

- 6 sender accounts, all Google, all status Active, warm-up active, and each with a daily campaign limit of 30.
- 18 existing campaigns that predate this project: 11 drafts, 3 active, 4 completed. The active campaigns already use the same sender accounts. **Their sends count against each account's daily limit**, so capacity projections must include campaigns the app did not create.
- Every existing campaign uses one schedule, Monday to Friday 09:00–17:00, in a single named time zone.
- 0 webhooks and 0 webhook events.
- 3 API keys, all with scope `all:all`. The app's key is one of them.

## Summary

| Agreed behavior | How Instantly supports it | Confidence |
| - | - | - |
| Email track with steps, waits in days | A campaign's `sequences[0].steps[]`, each with `delay` + `delay_unit` (`minutes`/`hours`/`days`) | Documented |
| Sending window by weekday and hours | `campaign_schedule.schedules[]`: `days` 0–6, `timing.from/to`, `timezone` | Documented; day numbering observed |
| Prospect's local time per lead | No lead time-zone field in API v2. Status codes hint at a UI-only lead time-zone mode. Fallback: one Instantly campaign per time zone | Unverified; likely limitation |
| Continue thread or new subject | Empty follow-up subject continues the thread; a different subject starts a new one | Documented |
| One sender inbox per lead for the campaign | Default within one Instantly campaign. Breaks if the account leaves the campaign. Across several Instantly campaigns, only a workspace preference that applies to the first email | Documented; cross-campaign unverified |
| Per-account limit across campaigns | Account `daily_limit` is shared by all campaigns | Documented, observed |
| Follow-ups first, oldest due first, across campaigns | Follow-ups first within a campaign by default. Across campaigns the earliest-scheduled campaign wins | Documented; cross-campaign part is a likely limitation |
| Pause/resume a campaign with frozen clocks, no burst | Pause and activate exist. Waits count from the previous send, so clocks keep running. Spreading comes only from gaps and limits | Documented pause; frozen clocks likely not met |
| Pause/resume/skip-step for one lead | No API endpoint. Stopping is possible through the interest status | Documented gap |
| Resume a stopped lead from the next unsent step | No API. Moving or re-adding a lead restarts it at step 1 | Documented gap |
| Know each step sent to each lead | `email_sent` webhook (step, lead); `GET /emails` (`step` = `seq_step_variant`); lead `status_summary.lastStep` | Documented, observed |
| Know the email track finished | Lead `status` 3 Completed, `campaign_completed` event, `FILTER_VAL_COMPLETED_NO_REPLY` | Documented; timing unverified |
| Any reply, auto-reply or unsubscribe stops the lead | `stop_on_reply`, `stop_on_auto_reply`, unsubscribe link/header. Replied leads become Completed | Documented, observed |
| Other campaigns and colleagues keep running | Needs `stop_for_company=false` **and** the UI-only workspace toggle "Disable Global Lead Status Synchronization" switched on | Documented; the toggle is outside the API |
| Sent, delivered, failed | Sent and bounced exist. No delivered event | Documented; "delivered" is not available |
| Hard bounce marks the address bad and ends the track | Lead status −1 Bounced stops follow-ups; block list available | Documented, observed; hard vs soft unverified |
| Disconnected sender account in Needs attention | Account `status` < 0, `account_error` event, campaign status −1, sending-status `disconnected` | Documented, observed |
| Test run with ~1-minute waits | `delay_unit: minutes`, minimum 0 | Documented; send gaps unverified |
| Edit a running campaign without restarting finished leads | Help centre says pause first, and adding a step **reactivates completed leads** | Documented conflict |
| Rate limits, scopes, idempotency | 100 req/s and 6,000 req/min per workspace, `/emails` 20/min; scoped keys; `idempotency_key` on bulk lead add only | Documented |
| Runs while the laptop is off | Instantly keeps sending campaigns it holds; the app catches up by polling | Documented; reconciliation unverified |
| No public URL | Webhooks need a reachable URL; polling works and is cheap at this scale | Documented |

## 1. Pushing an email track

**Objects (documented, [Create campaign](https://developer.instantly.ai/api-reference/campaign/create-campaign), [Patch campaign](https://developer.instantly.ai/api-reference/campaign/patch-campaign)).** An Instantly *campaign* holds one email channel track. Only `name` and `campaign_schedule` are required on create.

- `sequences`: an array where "only the first element is used". `sequences[0].steps[]` is the ordered list of steps. Each step has:
  - `type: "email"`, the only type.
  - `delay` (0–527040) and `delay_unit` (`minutes`, `hours`, `days`; default `days`). The description reads "The delay value before sending the NEXT email" and "The total delay cannot exceed 366 days".
  - `variants[]` with `subject`, `body` (HTML, `<br/>` for line breaks) and `v_disabled`. A track with no A/B copy sends one variant.
- `campaign_schedule`: `start_date`/`end_date` (YYYY-MM-DD, in the campaign's time zone) and `schedules[]`. Each schedule has `name`, `timing.from`/`timing.to` (`HH:MM`), `days` (keys `"0"`–`"6"`, booleans) and `timezone` (an enumerated list of IANA names).
- `email_list`: the sender accounts. `daily_limit`: the campaign's daily cap. `email_gap` and `random_wait_max`: minutes between sends.
- Leads are added separately with `POST /api/v2/leads/add`, up to 1,000 per call ([docs](https://developer.instantly.ai/api-reference/lead/add-leads-in-bulk-to-a-campaign-or-list)). Merge fields go in `custom_variables`; standard fields are `first_name`, `company_name` and similar.

**Waits sit on the earlier step (documented; mapping unverified).** In the app, the wait comes *before* a follow-up. In Instantly, `steps[i].delay` is the wait *after* step i. The push must shift each wait one step earlier: `steps[i].delay = appWait[i+1]`. The last step's delay has no documented meaning. The existing campaigns carry a non-zero delay on their last step (observed), which is the UI default. Whether it delays completion is unverified, and it matters for §6.

**Weekday numbering (observed).** All 18 existing campaigns use keys `1`–`5` true and `0`, `6` false. With the UI's Monday-to-Friday default, that means **0 = Sunday**. The OpenAPI example (`0`–`4` true) would suggest otherwise. Confirm with one test campaign before relying on it.

**Time zone per lead versus per campaign.** The spec wants the window in the prospect's local time, from the lead or company location, then the campaign default.

- The API v2 campaign schema has a time zone only **per schedule**. The lead schema has no time-zone field (documented).
- The help centre says "All schedule layers are applied to the campaign simultaneously. If your leads are in different time zones, we recommend separating them into different CSV files and creating separate campaigns" ([Multiple sending schedules](https://help.instantly.ai/en/articles/6573695-multiple-schedules)).
- Some sources suggest a lead time-zone mode exists outside the API. The [setup guide](https://help.instantly.ai/en/articles/6386134-how-to-create-a-campaign-complete-setup-guide) gives "During office hours in the lead's timezone" as an example. The sending-status endpoint can return `waiting_for_lead_timezone_window`, `invalid_lead_timezone_configuration` ("Unsupported fallback timezone") and `next_open_at` ("Next lead timezone sending window opening time"). None of the 18 existing campaigns has extra schedule fields that would show how to enable it (observed). **Unverified**: whether API v2 accepts an undocumented field for it.
- **Design consequence.** Plan for one Instantly campaign per (app campaign, email track, prospect time zone). The app resolves each lead's time zone and puts the lead in the matching Instantly campaign. This has costs. Instantly's per-campaign `daily_limit` splits across shards. The sender-inbox guarantee (§3) has to hold across shards. The time-zone list is a fixed enum, so each IANA zone has to map to an equivalent listed zone with the same offset and DST rules.

## 2. Continue thread versus new subject (documented)

From [Keep email sequences in the same thread](https://help.instantly.ai/en/articles/7914807-email-threading):

- "Leave the subject line of your follow-up steps empty to automatically carry over the subject line from the previous step, or manually enter the same subject line." That keeps the thread.
- "If the subject line differs from the previous step, the follow-up will be sent as a separate email in a new thread."
- Both conditions apply: the same subject *and* the same sending account.

Mapping: *continue thread* → push `subject: ""` for that step's variant. *New subject* → push the step's own subject. Step 1 must have a subject. A track that starts in another Instantly campaign (a second email track, a win-back track, or another time-zone shard) starts a new thread anyway (unverified, inferred from the rule above).

## 3. One sender inbox per lead

- **Documented** in the same threading article: "Instantly sends all follow-ups from the same sending account by default. If you remove that account from the campaign's 'Accounts to use' section, leads will receive follow-ups from another active account, which creates a new thread." So the app must never remove an account from a running campaign's `email_list`. Treat that as a launch-time decision.
- **Across Instantly campaigns** (time-zone shards, several email tracks in one app campaign, the win-back branch), there is no API to pin a lead to an account. The only lever is the UI-only preference "Sticky sending accounts for leads": "the first email to a lead is sent from the same account that previously contacted them in this workspace (provided that account is in the campaign), even after re-uploading, copying, or moving leads" ([Preferences](https://help.instantly.ai/en/articles/11864294-preferences-settings-overview)). It is workspace-wide and so also affects campaigns the app does not own. It cannot be read or set through API v2 (the `Workspace` schema has no such field).
- **Observed**: `lead.status_summary.lastStep.from` and `email.eaccount` record which account sent. The app can store the inbox per lead and detect a change.
- **Unverified**: what happens to a lead's follow-ups while its account is disconnected or paused. They may wait, or move to another account.

## 4. Daily limits and follow-up priority

- **Per account across campaigns (documented)**: "Account limit … The maximum number of campaign emails each individual email account can send per day across all campaigns" ([Account and campaign limits](https://help.instantly.ai/en/articles/6248612-setting-account-and-campaign-limits)). The field is `Account.daily_limit`. The per-campaign `daily_limit` is a second, independent cap. Warm-up emails count against neither. `Account.sending_gap` sets the minimum minutes between sends from one account across campaigns (default 1). `enable_slow_ramp` starts at 2 a day and adds 2 a day. All six accounts use 30 a day with slow ramp unset (observed).
- **Limit reset**: "The daily campaign limit resets based on UTC … by default", configurable in Preferences (UI only).
- **Follow-ups first within a campaign (documented)**: "By default, Instantly prioritizes follow-ups over new leads. The system sends all scheduled follow-ups first … before sending Step 1 to new leads" ([Prioritize new leads](https://help.instantly.ai/en/articles/6759494-how-to-prioritize-new-leads-over-follow-ups)). Keep `prioritize_new_leads` false or null. The toggle is plan-gated anyway, and the default matches the spec. Leave `daily_max_leads` null: if it exceeds the campaign limit, "the campaign will only send Step 1".
- **Across campaigns (documented, likely limitation)**: "If campaigns have different schedules, the earliest scheduled campaign is prioritized, and later campaigns may not send if the account has already hit its limit" ([Campaign not sending](https://help.instantly.ai/en/articles/5975337-campaign-not-sending-complete-troubleshooting-guide)). Instantly has no documented rule that puts campaign B's follow-ups ahead of campaign A's first messages on a shared account. Time-zone shards make this worse, because each shard is a separate campaign. Oldest-due-first across campaigns is undocumented.
- **Overflow (documented)**: nothing is dropped. Leads not sent today wait. `sending-status` reports `account_daily_limit_met`, `daily_limit_met`, `follow_ups_waiting.count` and `new_lead_limit` (observed on the active campaigns). That data can drive "leads waiting for sending capacity" and "queued".
- **Cross-campaign throttles to disable or account for**: `limit_emails_per_company_override` and the workspace "Limit emails per company" setting skip leads on the same domain ([Company send limits](https://help.instantly.ai/en/articles/12578026-company-send-limits)). Skipped leads show status −3.

## 5. Pausing, resuming, skipping and restarting

**Whole campaign (documented).** `POST /campaigns/{id}/pause` and `POST /campaigns/{id}/activate` ("Activate(start), or resume a campaign"). "After pausing, resuming, or updating a campaign, there's typically a 10–15 minute delay before sending resumes" ([Campaign not sending](https://help.instantly.ai/en/articles/5975337-campaign-not-sending-complete-troubleshooting-guide)).

**Frozen clocks: likely not met.** "The wait time counts from when the previous step was sent" ([Add steps to an active campaign](https://help.instantly.ai/en/articles/13924383-how-to-add-new-steps-to-an-active-campaign)). Nothing documents a pause offset. After a three-day pause, a lead with two days left is overdue and becomes due at once on resume. Instantly then spreads sends only through `email_gap`, account `sending_gap`, daily limits and the window, so there is no instant burst. But each lead's remaining wait is consumed, not frozen. **Unverified** until tested (experiment E5). There is no per-lead delay override, so the app cannot correct this through the API.

**One lead: no API.** API v2 has no endpoint to pause, resume or skip a step for a single lead. `PATCH /leads/{id}` cannot set `status`. Lead status 2 "Paused" exists in the enum, and the UI sets it through AI out-of-office "Pause Until" ([OOO resume](https://help.instantly.ai/en/articles/9713093-ai-smart-pause-resume-for-out-of-office-replies)), but the API does not expose it. Available levers:

- **Stop**: "Any status other than the default 'Lead' status stops the campaign sequence" ([Stop sending to specific leads](https://help.instantly.ai/en/articles/7913412-how-to-stop-a-campaign-for-a-specific-lead)). Through the API that is `POST /leads/update-interest-status` with `campaign_id`. Its description warns that "campaign leads may be completed, opportunities updated or created, and matching automations and CRM-status subsequences triggered." The global status sync in §7 can carry this to other campaigns.
- **Resume after a stop**: setting `interest_value: null` returns the lead to "Lead". Whether a Completed lead then continues from its next unsent step is **unverified** (E6).
- **Move or re-add**: "Lead starts from Step 1 in the new campaign", and delete then re-upload "restarts from Step 1 (as if brand new)" ([Follow-ups after reply](https://help.instantly.ai/en/articles/13886841-why-follow-ups-are-still-being-sent-to-leads-who-replied)). The spec forbids restarting from step 1, so this cannot implement resume.
- **Subsequences**: `POST /leads/subsequence/move` puts a lead into a subsequence with its own steps, `pre_delay` and schedule ([docs](https://developer.instantly.ai/api-reference/lead/move-a-lead-to-a-subsequence)). One possible model is "resume from step k" as a subsequence holding steps k…n. That carries open questions: whether the main sequence stops for the lead, whether the sender inbox and thread carry over, and that subsequences "can still reach leads who have replied". All **unverified** (E7).

**Conclusion.** Per-lead pause, resume and skip-step, plus resume-from-next-unsent-step, have no documented Instantly mechanism. This is the limitation the spec asked the factory to investigate. Unless E6 or E7 succeed, the coordinator should treat it as a demonstrated provider limitation. One alternative architecture: Instantly sends step 1 and the app sends follow-ups itself through `POST /emails/reply` ([docs](https://developer.instantly.ai/api-reference/email/reply-to-an-email)), which replies in-thread from a chosen account. That gives the app full control of per-lead clocks. It costs Instantly's sending schedule, follow-up priority and, without hosting, laptop-independent follow-ups. It is also unverified whether those replies count toward account daily limits.

## 6. Learning that a step was sent and that the track finished

- **Per step sent**:
  - The `email_sent` webhook carries `campaign_id`, `lead_email`, `email_account`, `step` and `variant` (1-based, "starting at 1"), `email_id` and the rendered `email_subject`/`email_html` ([webhook guide](https://developer.instantly.ai/guides/webhook-events)). That last part covers "expandable sent copy".
  - Polling: `GET /emails?campaign_id=…&email_type=sent&min_timestamp_created=…`. Each item has `ue_type` 1 ("Sent from campaign"), `lead_id`, `eaccount`, `thread_id`, `timestamp_email` and `step` in the form `"<sequence>_<step>_<variant>"`, **zero-based**. Observed values: `0_0_0`, `0_1_0`, `0_2_0`, `0_3_0`. The two numbering schemes differ, so the adapter must normalise them.
  - The lead's `status_summary.lastStep {from, stepID, timestamp_executed}` is also available (observed, sparse).
  - Analytics: `GET /campaigns/analytics/steps` returns per-step `sent` and `replies_automatic` (observed).
- **Track finished**:
  - The lead's `status` becomes 3 Completed. That happens both after the last step and after a reply (observed: all 11 replied leads have status 3), so finished-without-reply has to be told apart.
  - `POST /leads/list` with `filter: FILTER_VAL_COMPLETED_NO_REPLY` does that. So do `email_reply_count == 0` and a missing `timestamp_last_reply`.
  - The `campaign_completed` webhook is documented only as "A campaign completed". Subsequence triggers do define a per-lead activity 91, "Campaign Completed Without Reply". Whether the webhook fires per lead, and **when** (at the last send or after the last step's delay), is **unverified** (E3).
- **For "after + delay" tracks**, compute the start time in the app from the last step's provider `timestamp_email`, not from Instantly's completion moment.
- **Latency**: webhook delivery latency is undocumented. Polling latency equals the poll interval. Instantly's send loop and reply checks run on its own undocumented cadence. Sending-status reports `consecutive_loops_with_issue`, which shows the send loop exists but not how often it runs.

## 7. Reply detection and stopping

- **Settings to push on every app-owned campaign (documented)**: `stop_on_reply: true`, `stop_on_auto_reply: true` (the spec counts auto-replies as replies, so do not use Smart Pause), `stop_for_company: false` (true stops the whole domain and marks colleagues Completed, [Campaign settings](https://help.instantly.ai/en/articles/6222396-campaign-settings)), and `insert_unsubscribe_header: true`.
- **Cross-campaign status sync: conflicts with the spec by default (documented).** In Preferences, while "Disable Global Lead Status Synchronization" is OFF (the default), "If a lead replies in Campaign A, the same lead in Campaign B will also be marked as 'Reply received'". That breaks "the person's enrollments in other campaigns … keep running". Turning it ON also "Prevents webhooks from triggering multiple times for the same email address across different campaigns". It is a UI-only workspace setting (absent from the API `Workspace` schema). **The user must switch it on**, and it also changes their existing campaigns. That is a product decision for the coordinator to raise.
- **Detection signals**:
  - Webhook `reply_received` with `reply_subject`/`reply_text`. The app should store only channel and date. Webhook `lead_unsubscribed`.
  - The webhook guide also lists `auto_reply_received`, but the live `GET /webhooks/event-types` list for this workspace does not include it (observed). The `Webhook.event_type` enum does not either.
  - Polling: lead `timestamp_last_reply`, `email_reply_count`, `email_replied_step`; `filter: FILTER_VAL_REPLIED`; lead status −2 Unsubscribed; `GET /emails?email_type=received`, which gives `ue_type` 2 with `campaign_id` and `step` (observed).
  - `Email.is_auto_reply` was null on all 14 received emails sampled (observed), so do not depend on it. The app does not classify replies anyway.
- **Known blind spots (documented in [Follow-ups after reply](https://help.instantly.ai/en/articles/13886841-why-follow-ups-are-still-being-sent-to-leads-who-replied))**: replies from a different address, forwarded replies, a reply-to address not connected to the workspace, and replies arriving while the sending account is paused or disconnected ("Our system can't check for replies"). The unsubscribe link only works for leads in a campaign, not in preview test emails ([Unsubscribe link](https://help.instantly.ai/en/articles/6191077-how-to-add-unsubscribe-link)).
- **Race (unverified)**: the time between a reply landing and Instantly stopping the next scheduled step is undocumented (E2).

## 8. Delivery states and bounces

| Spec state | Instantly signal | Notes |
| - | - | - |
| sent | `email_sent` event, `Email.ue_type` 1 | Means accepted by the sender's mail server. No inbox placement, which is out of scope anyway |
| delivered | none | Instantly has no delivered event or field. Showing "delivered" would mean inventing it |
| failed | `email_bounced` event; lead `status` −1 Bounced | Observed: 7 bounced leads in the workspace |
| skipped before sending | lead `status` −3 Skipped (BounceShield risky address, block list, company limit) | Map to "missing or failed channel, track skipped" ([BounceShield](https://help.instantly.ai/en/articles/8486604-bounceshield-skipped-leads)) |

- "When a lead bounces, Instantly automatically stops all follow-up emails" ([Managing bounced leads](https://help.instantly.ai/en/articles/7911994-managing-bounced-leads)). The app marks the address bad and finishes the email track.
- Whether `email_bounced` fires for soft bounces too, and whether the payload tells hard from soft, is **unverified**. The account status −2 "Soft Bounce Error" is an account-level condition, not a per-message one.
- A workspace block list exists (`POST /block-lists-entries`), and `add_unsub_to_block` is a workspace field. Blocking an address affects every campaign. Whether a bad address should block other enrollments is a product question, not a provider fact.
- The campaign status −2 "Bounce Protect" auto-pauses a campaign above a bounce threshold (default 5% after 200 emails, [Preferences](https://help.instantly.ai/en/articles/11864294-preferences-settings-overview)). It belongs in Needs attention.

## 9. Disconnected or unhealthy sender accounts (documented, observed)

- `Account.status`: 1 Active, 2 Paused, 3 maintenance, −1 Connection Error, −2 Soft Bounce Error, −3 Sending Error. Also `status_message` and `autofix_failed`. Warm-up health is in `warmup_status`: −1 Banned, −2 Spam Folder Unknown, −3 Permanent Suspension.
- The `account_error` webhook.
- Campaign status −1 "Accounts Unhealthy" and −99 "Account Suspended". `not_sending_status` 4 means all accounts hit the limit.
- `GET /campaigns/{id}/sending-status` → `accounts_summary {total_connected, available, unavailable.disconnected, daily_limit_hit, slow_ramp_limit_hit}` (observed).
- `POST /accounts/test/vitals` needs only read scope but runs a live check, so it was not called. `POST /accounts/{email}/mark-fixed` is a write. The help centre's account-disconnect email notification "is currently disabled and undergoing maintenance" ([Preferences](https://help.instantly.ai/en/articles/11864294-preferences-settings-overview)), so the app's own Needs attention view is the only alert.

## 10. Test run

- **Smallest wait (documented)**: `delay_unit: "minutes"` with `delay` ≥ 0. A one-minute wait is expressible, as is zero.
- **Other throttles that stretch a one-minute wait (documented; effect unverified)**:
  - The campaign `email_gap` (UI default 9 minutes) and `random_wait_max` (default 5).
  - The account `sending_gap` (default 1 minute, shared with every campaign using that account).
  - The 10–15 minute start delay after activation.
  - The schedule window, so use a 24/7 schedule for the test.
  - The account daily limit, shared with live campaigns.
- **Shape**: a separate Instantly test campaign, cloned from the track's copy with waits converted to minutes. Use `email_gap` and `random_wait_max` 0 or null, the same `email_list` (the real senders), and one lead, the designated test contact. `POST /campaigns/{id}/duplicate` exists, but a fresh push is simpler and keeps the app as the only copy source.
  - Do not use `skip_if_in_workspace`: the test contact may already exist from an earlier test run.
  - A reply from the test contact stops its lead through `stop_on_reply`. That is the observable proof.
  - Re-running a test run means deleting and re-adding the test lead, which restarts at step 1. That is what a test run wants.
- `POST /emails/test` sends a one-off preview "without creating an email entity in Unibox" and is limited to 10 per minute. It cannot prove reply stopping.
- **Blocked**: no test contact is designated yet ([access handoff](https://github.com/Pierpaolo01/omnichannel-outreach/issues/28)).

## 11. Editing a running campaign

- **Documented**: "You must pause your campaign before you can make changes to the campaign email." Then "Leads who haven't replied will automatically receive the new step … previously completed leads will be reactivated" ([Add steps to an active campaign](https://help.instantly.ai/en/articles/13924383-how-to-add-new-steps-to-an-active-campaign)).
- The spec says "Leads who finished a track are never restarted by an added step." A naive `PATCH sequences` would break that.
- **Possible mitigation (unverified, E8)**: when the app records a lead's email track as finished, remove that lead from the Instantly campaign with `DELETE /leads/{id}`. Then a later added step cannot reactivate it. Check first that deleting keeps the sent history the app already copied, and that Unibox threads survive.
- **Changing copy or a wait for unsent messages**: `PATCH /campaigns/{id}` replaces `sequences`. Because waits count from the previous send, a changed delay should apply to every lead still waiting (documented by implication, **unverified** E8). Whether the API needs the campaign paused first, as the UI does, is unverified. Pausing for the edit also triggers the frozen-clock issue in §5.
- **Removing a step**: Instantly tracks position by step index (`0_k_0`). Removing step k may shift leads waiting on later steps. **Unverified**, and risky (E8). A safer push may keep the step and mark its variants `v_disabled`, but whether a step with every variant disabled is skipped is also unverified.
- **Copy edits made in Instantly** are overwritten by the next full `PATCH sequences`. `timestamp_updated` on the campaign shows that someone changed it.

## 12. Rate limits, scopes, idempotency, removing and moving leads

- **Rate limits (documented, [Rate limit](https://developer.instantly.ai/getting-started/rate-limit))**: 100 requests per second and 6,000 per minute, "shared between API v2 and API v1, and it applies to the entire Workspace, even if it's using multiple API keys". Exceeding either returns 429. Endpoint exceptions: `GET /emails` 20 per minute, `POST /emails/test` 10 per minute. Responses carry no rate-limit headers (observed), so back off on 429 alone.
- **Auth**: `Authorization: Bearer <key>` ([docs](https://developer.instantly.ai/getting-started/authorization)). A request without a User-Agent gets 403 (handoff, re-confirmed). A request that fails for lack of a paid plan returns 402.
- **Scopes (documented per endpoint)**:
  - `campaigns:read/create/update/delete`, `leads:read/create/update/delete`, `emails:read`, `accounts:read`, `webhooks:*`, `webhook_events:read`.
  - Also `subsequences:*` if used, `background-jobs:read` for `leads/move`, and `block_list_entries:create` if used.
  - The current key is `all:all` (observed). A narrower key is possible but not needed for local work.
- **Idempotency (documented)**:
  - `POST /leads/add` takes `idempotency_key`: "a retry with the same key and the same leads … does not insert the leads again". The key is permanent, so use a new one per batch.
  - Campaign create has no idempotency key. Persist the intent first, then search by a deterministic `name` on retry.
  - PATCH calls are naturally idempotent. Use `timestamp_updated` to detect conflicts.
  - Do **not** use `skip_if_in_campaign`. It means "exists in ANY campaign in your workspace" and would wrongly skip a person enrolled elsewhere.
- **Remove a lead**: `DELETE /leads/{id}`, or bulk `DELETE /leads` with `campaign_id` and `ids`. Deletion is permanent.
- **Move a lead**: `POST /leads/move` runs as a background job, and the lead "starts from Step 1 in the new campaign" ([Moving leads](https://help.instantly.ai/en/articles/6750176-moving-leads-between-campaigns)). That makes it unsuitable for resume.
- **Find a person's Instantly campaigns**: `GET /campaigns/search-by-contact`.

## 13. While the local app is off

- **Instantly keeps running (documented by design)**: an active campaign keeps sending every step it holds, inside its window, and stops leads on reply or bounce with no app involvement.
- **What does not happen while the app is off**:
  - Email tracks connected "after" another track are not pushed.
  - Waiting leads are not added.
  - Per-lead stops from other channels (an interested call, an SMS reply) are not applied, so Instantly may send an email the spec would have stopped.
  - A reply on email is not mirrored to SMS or call tracks until the app restarts.
- **Reconciling on restart, nothing sent twice or skipped**:
  1. Treat Instantly as the record of email sends. Never re-send an email step from the app.
  2. Page `GET /emails?campaign_id=…&email_type=sent&min_timestamp_created=<checkpoint>&sort_order=asc` for each app-owned campaign. Upsert by `Email.id`, keyed to (lead, step). Then do the same with `email_type=received` for replies.
  3. Page `POST /leads/list` for each app-owned campaign. Update the email-track state from `status`, `timestamp_last_reply`, `last_step_*` and bounced or unsubscribed status.
  4. Only then apply cross-channel effects: stop SMS and calls for repliers, then start the "after" tracks whose delay has elapsed, spreading them across the window.
  5. Advance the checkpoint to the newest `timestamp_created` seen, with an overlap of a few minutes. Upserts make the overlap safe.
- **Unverified**: whether `timestamp_created` on sent emails is monotonic enough for a checkpoint. The field is "when the email was added to our database" and may differ from `timestamp_email`.

## 14. No public URL: webhooks versus polling

- Webhooks need a `target_hook_url` that Instantly can reach. A local app has none. A tunnel would add a public endpoint and possibly a new account connection, which this stage does not permit. **Polling is the default for local operation.**
- Webhook failures are visible. A webhook is set to `status` −1 "disabled due to delivery failures" and can be resumed. `GET /webhook-events` lists attempts with `success`, `retry_count`, `will_retry` and the full `payload`. The retry schedule and retention are undocumented. Do not use a failing webhook as an event log.
- **Polling cost at this scale**:
  - Sent and received emails: one page of up to 100 per request. Under the 20-per-minute cap that is up to about 2,000 emails per minute, far above six accounts at 30 a day (180 sends a day).
  - Lead state: `POST /leads/list` at 100 per page. A 2,000-lead campaign takes 20 requests per sweep.
  - Account and campaign health: one `GET /accounts` and one `sending-status` per campaign.
  - A 2–5 minute cycle uses well under 1% of the workspace limit, which the user's existing campaigns also share.
- **Later**, once hosting is approved, subscribe webhooks for `email_sent`, `reply_received`, `email_bounced`, `lead_unsubscribed`, `campaign_completed` and `account_error`, filtered by `campaign` where useful. Keep the restart sweep, because webhook delivery is not guaranteed.

## Limitations against the agreed behavior

Demonstrated from documentation:

1. **No per-lead pause, resume or skip-step in API v2**, and no resume from the next unsent step. Move and re-add restart at step 1, and the interest-status stop completes the lead.
2. **Campaign pause does not freeze waits.** Waits count from the previous send, so resume consumes paused time.
3. **Adding a step to a running campaign reactivates completed leads**, and the UI requires pausing to edit.
4. **No "delivered" state.** Instantly reports sent and bounced only.
5. **By default a reply marks the same lead replied in every other campaign** unless the UI-only "Disable Global Lead Status Synchronization" toggle is on. The toggle is workspace-wide and outside the API.

Likely, pending experiments:

6. **No per-lead time zone in API v2.** Per-time-zone campaign shards are the fallback, which fragments capacity and the sender-inbox guarantee.
7. **Follow-ups-first and oldest-due-first hold only within a campaign.** Across campaigns sharing an account, "the earliest scheduled campaign is prioritized".
8. **One sender inbox per lead across several Instantly campaigns** (shards, multiple email tracks, win-back) depends on a workspace-wide UI preference that covers the first email only.
9. **Laptop-off coordination**: other channels' stops and "after" tracks do not reach Instantly until the app runs. Email itself keeps sending.
10. **Reply detection blind spots**: replies from other addresses, and replies landing while an account is disconnected. The stop latency is undocumented.

## Write-path experiments once a test email address is designated

Run each in a dedicated test campaign with one lead, the designated test contact, using the real senders. Use a 24/7 schedule and waits of 1–2 minutes unless a step says otherwise. Record payloads with addresses redacted.

- **E1 Push and send**: create a campaign with 3 steps (continue thread, new subject, continue thread) and waits in minutes. Activate. Confirm the delay-on-earlier-step mapping, weekday key numbering (one 1-day window test), threading and subject behavior, the single sender inbox, the `GET /emails` `step` values and the lead `status_summary`. Measure time from activation to first send, and the real gap between steps against `email_gap` and `sending_gap`.
- **E2 Reply stop**: reply from the test contact after step 1. Measure detection delay, the lead's `status`, `timestamp_last_reply` and `email_reply_count`, and that step 2 never sends. Repeat with an auto-reply (out-of-office) and with the unsubscribe link and header.
- **E3 Completion**: let a 2-step track finish with no reply, with a non-zero last-step delay. Record when status 3 appears relative to the last send, and the `FILTER_VAL_COMPLETED_NO_REPLY` result.
- **E4 Global status sync**: put the test contact in two test campaigns, reply in one, and see whether the other is stopped. Repeat after the user switches the toggle on.
- **E5 Campaign pause**: pause between steps with a 10-minute wait for 20 minutes, then resume. Check whether the step sends at once (clock not frozen) or 10 minutes later. Repeat with several test leads to see the spread.
- **E6 Interest-status stop and un-stop**: set the interest status, confirm the next step does not send, reset it to `null`, and check whether the lead continues from its next unsent step.
- **E7 Subsequence as resume**: move a lead into a subsequence holding the remaining steps. Check that the main sequence stops for it, which sender is used, threading, and its behavior after a reply.
- **E8 Running edits**: with leads at different steps and one Completed, (a) change copy and a wait, (b) add a step, (c) remove a middle step, (d) disable all variants of a step, and (e) delete a Completed lead before adding a step. Record who receives what, and whether a PATCH to an active campaign is accepted without pausing.
- **E9 Bounce**: needs an address that hard-bounces and is owned by the user or reserved for testing. Record the `email_bounced` payload and the lead status, and check for any hard or soft distinction. Do not use a prospect address.
- **E10 Lead time-zone mode**: in the UI, check whether a lead-time-zone schedule exists and what it adds to `GET /campaigns/{id}`. If it shows up as a field, test whether API v2 accepts it on create.
- **E11 Disconnected account**: needs the user's consent to pause one account through the UI. Observe the campaign and sending-status signals and whether its leads switch sender.
