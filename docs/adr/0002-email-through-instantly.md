# 0002. Email through Instantly: the app owns every clock

- **Date:** 2026-11-12. Revised twice the same day after independent reviews.
- **Status:** Proposed. Build the app-owned scheduler and the email port now. The Instantly adapter is finished after the gating experiments (X1–X9) pass. All of them need test addresses the user owns, and none are designated yet ([#28](https://github.com/Pierpaolo01/omnichannel-outreach/issues/28)).
- **Consumers:** tickets [12](https://github.com/Pierpaolo01/omnichannel-outreach/issues/12), [13](https://github.com/Pierpaolo01/omnichannel-outreach/issues/13), [17](https://github.com/Pierpaolo01/omnichannel-outreach/issues/17), [19](https://github.com/Pierpaolo01/omnichannel-outreach/issues/19), [20](https://github.com/Pierpaolo01/omnichannel-outreach/issues/20), [21](https://github.com/Pierpaolo01/omnichannel-outreach/issues/21).
- **Evidence:** [docs/research/instantly-email-delivery.md](../research/instantly-email-delivery.md) at `32517dd` (cited as "research §n"), re-checked against [`api_v2.json`](https://api.instantly.ai/openapi/api_v2.json) and the help centre. See "Sources".

## Context

The spec ([#10](https://github.com/Pierpaolo01/omnichannel-outreach/issues/10)) requires behavior that Instantly's multi-step sequences do not provide:

| Gap in Instantly sequences | Certainty |
| - | - |
| No API to pause, resume or skip one lead. Move and re-add restart at step 1 (research §5) | Documented absence |
| No per-lead time zone (research §1) | Documented absence |
| Adding a step reactivates completed leads, and editing needs a pause (research §11) | Documented |
| A reply marks the person replied in all campaigns while global status sync is on, which is the default (research §7) | Documented |
| Campaign pause does not freeze waits: "The wait time counts from when the previous step was sent" | Likely, by implication |
| Follow-ups go first only within one campaign; across campaigns "the earliest scheduled campaign is prioritized" | Likely |

The workspace also holds 18 campaigns that predate the app, 3 of them active, on the same six inboxes at 30 sends a day each.

The provider gives the app four ways to send:

- **A campaign step.** This is the only documented way to open a new thread to a lead with the campaign's unsubscribe header, limits, and bounce and lead status.
- **`POST /emails/reply`.** It sends "only as a reply to an existing email". It has no idempotency key, and documents the responses 200, 401, 402, 404 and 429. Its default recipient is "the sender of the email being replied to", which for our own sent message is our own inbox. `additional_recipients` adds recipients to that default.
- **`POST /emails/forward`.** It also needs an existing email, but takes an explicit `to_address_email_list`, a subject and a body, and by default leaves out the original body.
  - As a follow-up transport it might avoid the reply endpoint's recipient problem. Whether it sets threading headers, and whether Instantly ties the result to the lead's thread, is undocumented, so X2 tests it.
  - As an opener it would bypass the campaign's unsubscribe header, limits and lead status. It is not used for openers.
- **`POST /emails/test`.** It sends a preview "without creating an email entity in Unibox", at 10 a minute. It is not usable.

Settled in #28 and not reopened here:

- Operation is local-only.
- "Email keeps sending with the laptop off" stands, but its verification is deferred until hosting.
- Work already handed to Instantly may continue while the app is off.
- Recovery must still send nothing twice and skip nothing.

## Decision

### Ownership

The application's scheduler owns every clock for every channel:

- waits;
- the prospect-local sending window;
- campaign and per-lead pause, skip, stop and resume;
- edits;
- the lead's sender inbox;
- capacity and priority.

Instantly carries email and nothing more. No Instantly campaign holds a multi-step sequence for an app campaign.

### Step sends and attempts

- A **step send** is one logical step for one lead in one campaign. It stays pending until a real send, an explicit skip, an applicable failure, or final abandonment (the lead stops or the track ends). Pause and edit never finish it.
- An **attempt** is one provider call for a step send. Its states are `adding`, `added`, `rejected`, `sent`, `withdraw-requested`, `withdrawn` and `unresolved`. A step send has at most one attempt in any state other than `rejected` or `withdrawn`.
- An attempt becomes `withdrawn` only on a positive provider signal that its send did not happen and cannot happen. No such signal is known. X5 probes two candidates: the lead's status, and `GET /emails?scheduled_only=true` (`ue_type` 4, "Scheduled"). A candidate is adopted only if X5 shows it exists and is never followed by a send. Until then, a withdraw request that is not confirmed by a send leaves the attempt `unresolved`.
- **Unresolved attempts are never retried automatically.** They hold the lead's email track and go to the user (P3).
- **The full promise of nothing sent twice and nothing skipped therefore stays unverified until X5 proves a withdrawal signal.** Until then the app keeps "nothing twice" by refusing to guess, and "nothing skipped" depends on the user resolving held attempts.

### Openers: dispatch campaigns

The first step of an email track, and any step set to *new subject*, goes out by adding the lead to a **dispatch campaign**. There is one dispatch campaign per (app campaign, email track, opening step, sender account). It is created when first needed, and its deterministic name is prefixed `oo·`, so a retried create finds it. Test runs use separate `oo·test` campaigns. The lead stays in the campaign after its send, so Instantly keeps attributing its replies, unsubscribes and bounces.

Each dispatch campaign is created with these settings:

- one step with delay 0, subject `{{oo_subject}}` and body `{{oo_body}}`, both rendered by the app. HTML in variables is checked in X1. If it fails, the step's copy goes into the template instead;
- `email_list` holding the one sender inbox;
- a schedule open every day 00:00–23:59. The app applies the window;
- `stop_on_reply` and `stop_on_auto_reply` true, `stop_for_company` false, `insert_unsubscribe_header` true, and open and link tracking off;
- `prioritize_new_leads` false, `daily_limit` equal to the account limit, and `daily_max_leads` equal to it as well. What `null` means there is undocumented;
- `allow_risky_contacts` false, `disable_bounce_protect` false, `match_lead_esp` false and `provider_routing_rules` empty. These keep Instantly's bounce protection and leave the pinned inbox unconstrained;
- `limit_emails_per_company_override: { mode: "disabled" }`, so the workspace company limit cannot skip a colleague's track. Whether "disabled" turns that limit off is unverified (X1).

Every `POST /leads/add` result is reconciled. `status: "success"` can mean nothing was created.

- The add uses `idempotency_key = <attempt id>`. A retry after a lost response reuses the key and the identical one-lead array; Instantly documents that such a retry "reports the leads it already created". What a re-add with the same key does after the lead was deleted is unverified (X5). The design never relies on it: a new attempt always gets a new key.
- **Lead created:** the attempt is `added`.
- **`in_blocklist`:** the attempt is `rejected`. The email track is skipped with the reason "address on the Instantly block list", and the address is not marked bad. A blocked address is a missing channel, under the spec's "a missing or failed channel skips its track".
- **`invalid_email_count`:** the address is marked bad, and the track ends as failed.
- **`duplicated_leads`:** the app looks up the existing lead. It is never assumed to be sent.
- **Quota exhausted:** the response carries `remaining_in_plan`, the monthly lead quota. A 402, or an exhausted quota, holds every dispatch handover workspace-wide and shows in Needs attention. Whether a delete followed by a re-add counts against the quota again is recorded in X5.
- **Lead status −3 (Skipped):** explained by `verification_status` (−2 Risky, −3 Catch All, −1 Invalid). An explained skip skips the track with its reason. An unexplained skip goes to Needs attention (P4).

### Bounded handover

**The app paces handovers itself.** Each inbox has at most `k` attempts in flight (handed over but not yet observed sent), counting reply calls too. `k` starts at 1. X1 decides whether 2 is needed to reach the daily capacity inside the windows.

The app hands over only when all of these hold:

- the step is due;
- capacity is reserved;
- the inbox is healthy;
- the window stays open for longer than X1's measured handover latency plus a margin.

So by design, at most `k` messages per inbox are ever outside the app's control.

Instantly documents no maximum queue time and no maximum delay before a send becomes visible. Within those `k` messages, the sending window, a pause, a stop and an edit are therefore **a reported limitation, not a guarantee**, even after the experiments:

- a message already handed over keeps its copy;
- a pause or stop requests withdrawal, and the attempt resolves as described above.

### Follow-ups: transport gated by X2

Continue-thread steps are sent from the lead's inbox as a reply in the lead's thread. The transport is chosen by X2 from three candidates:

- the reply endpoint;
- the reply endpoint with `additional_recipients: [lead]`;
- the forward endpoint with an explicit `to_address_email_list: [lead]` and no original body.

A candidate passes only if two consecutive follow-ups with no inbound reply each arrive:

- addressed to the lead alone;
- from the pinned inbox;
- with In-Reply-To and References pointing at the previous message, so they thread in the recipient's client;
- visible in `GET /emails` in the lead's thread.

If none passes, continue thread is not available on email. P2 decides what the editor does then.

Reply and forward calls fail in three ways:

- **401 and 404:** permanent. The attempt is rejected and goes to Needs attention.
- **402:** a workspace hold, as on dispatch.
- **429:** retried with backoff. The rate-limit guide says over-limit requests "will fail with the 429 status code".

Any other outcome, a timeout or a lost response stays `adding` until a sent record is observed, and becomes `unresolved` after a settling period.

### Sender inbox and capacity

- **Sender inbox.** The inbox is fixed for the lead when its first email step comes due, and never reassigned. An unhealthy or stale inbox (see Polling) holds that lead's email work and shows in Needs attention.
- **The capacity ledger** works per (inbox, Instantly reset day), with UTC as the reset zone unless S5 reports a different one.
  - **Reservation.** Before every handover or reply call the app writes a reservation. An observed send replaces it. A rejected or withdrawn attempt releases it. An unresolved attempt keeps it. A reservation still open at reset counts against the new day until it resolves.
  - **Remaining.** `remaining = account daily_limit − app sends observed today − open reservations − other senders`.
  - **Other senders** applies only if P1 keeps pre-existing campaigns on the inboxes. It equals `max(0, analytics sent today − app sends included in analytics)`. The analytics figure comes from `GET /accounts/analytics/daily`, read as a running maximum through the day so analytics lag never lowers it. "App sends included" means dispatch sends, plus reply sends if X2 shows analytics counts them. If P1 moves those campaigns off the inboxes, `other senders` is 0, and analytics is only a cross-check.
  - **Order.** Within `remaining`, follow-ups go first, oldest due first, then first messages, oldest queued first, across all app campaigns. The rest waits for the next day. With `k` = 1, Instantly cannot reorder the app's own work.

### Polling and reply detection

The app has no public URL, so it polls.

- **Polling call.** One paged call covers every inbox: `GET /emails?eaccount=<all six>&mode=emode_all&min_timestamp_created=<checkpoint − overlap>&sort_order=asc&preview_only=false`. It has no type filter, and results are classified by `ue_type`. Results are upserted by `Email.id`.
- **Lead records.** `POST /leads/list` per dispatch campaign supplies lead status and `verification_status`.
- **Pre-send check.** Before every send, `GET /emails?lead=<address>&eaccount=<inbox>&mode=emode_all&min_timestamp_created=<first send in this campaign>`, filtered to every thread the app recorded for that lead in that campaign.
- **Request budget.** `GET /emails` allows 20 calls a minute in total. The poll cycle and the pre-send checks share that budget.
- **What counts as a reply.** A received message in one of the lead's recorded threads that comes from the lead's own address. It stops that lead in that campaign only. An unsubscribe (lead status −2) stops it the same way.
- **Bounce notices.** A delivery notice comes from a mail system, not the lead, so it is never read as a reply. How Instantly records a bounce for each transport is established in X9.
- **Known detection gaps (reported limitations).**
  - Replies from another address, or outside the thread, are not detected.
  - Instantly "can't check for replies if the sending accounts are paused or disconnected".
  - Auto-replies and replies that are not from leads appear only under the Unibox preferences in C2.
- **Stale inboxes.** Sends from an inbox are held while it is not Active, or while its last successful poll is older than the freshness bound.

### Recovery

On restart the app processes:

1. received emails;
2. sent emails;
3. open attempts;
4. lead statuses;
5. cross-channel effects;
6. then the scheduler releases overdue work, spread across windows and capacity, and Today shows the interruption notice the spec requires.

A sent record is matched to an attempt by thread, inbox, a time after the attempt, and not being claimed by an earlier attempt. Two consecutive steps whose identical copy cannot be told apart go to the user as unresolved (P3).

### Reporting

- **Sent:** an observed Instantly sent record.
- **Failed:** a bounce, an invalid address, or a permanent call error.
- **Skipped:** shown with its reason.
- **Delivered:** never shown for email, because Instantly reports no delivered state. This is a reported provider limitation.

### Why option 1 is rejected

- Per-lead pause, skip and resume do not exist in Instantly sequences. They are reachable only through unverified workarounds: interest-status stops and subsequences.
- Editing needs deletion on finish, also unverified.
- Frozen pause clocks and cross-campaign priority are likely not met.
- Its one advantage, sending while the laptop is off, would ignore the app's pauses, per-lead controls and other-channel stops.

## Option comparison

1. **Instantly sequence:** one Instantly campaign per (app campaign, email track, prospect time zone), with native steps and waits.
2. **App clocks, every step a dispatch opener:** follow-ups are new threads.
3. **App clocks, hybrid** (chosen): openers go through dispatch campaigns, follow-ups through the X2 transport.

Marks:

- **By design:** no provider behavior involved.
- **Unverified (Xn):** the named experiment must confirm it.
- **Limitation:** holds except for the bounded handover interval or a documented gap.
- **Likely not met:** the sources point that way, but no experiment has confirmed it.
- **Not met:** demonstrated from documentation.

| Agreed behavior | 1 | 2 | 3 (chosen) |
| - | - | - | - |
| Per-lead pause, resume, skip | Not met (workarounds unverified) | By design. Limitation for the `k` in flight | By design. Limitation for the `k` in flight |
| Resume from the next unsent step | Not met | By design | By design |
| Campaign pause freezes clocks, no burst | Likely not met | By design. Limitation for the `k` in flight | By design. Limitation for the `k` in flight |
| Edits apply to unsent messages; finished leads never restart | Not met by default | By design. Limitation for the `k` in flight | By design. Limitation for the `k` in flight |
| Prospect-local windows | Per-time-zone shards only | Limitation for the `k` in flight (X1) | Limitation for the `k` in flight (X1) |
| Per-account capacity | Instantly limit | Unverified (X8) | Unverified (X2, X8) |
| Follow-ups first across app campaigns | Likely not met | By design | By design |
| Follow-ups ahead of pre-existing campaigns | Likely not met | Not met unless P1 moves them | Not met for openers unless P1 moves them |
| One sender inbox per lead | Within one Instantly campaign | Unverified (X1) | Unverified (X1, X2) |
| Continue thread | Within one track | Not met | Unverified (X2). P2 if it fails |
| Any reply stops only that lead in that campaign | Unverified, depends on C1 | Unverified (X3, X4). Documented gaps | Unverified (X3, X4). Documented gaps |
| Sent and failed | Documented | Unverified (X1, X9) | Unverified (X1, X2, X9) |
| Delivered | Not met | Not met | Not met |
| Test run with waits of about a minute | Unverified | Unverified (X1) | Unverified (X1, X2) |
| Laptop off, local / hosted | Continues, ignoring app controls / continues | Handed-over work only / by design | Handed-over work only / by design |
| Nothing twice, nothing skipped | Unverified | Unverified (X5, X6) | Unverified (X5, X6). Unresolved attempts go to the user |

## Consequences for each consuming ticket

- **#12.** Build test-first against a fake Instantly adapter:
  - the scheduler, step sends and attempts;
  - the dispatch manager. It re-asserts the template when `timestamp_updated` changes, so direct Instantly edits are overwritten;
  - add-result reconciliation;
  - the ledger;
  - the poller;
  - the stale-inbox hold.

  The follow-up transport sits behind an interface and is enabled after X2. "Works without the laptop" is reported unverified (#28).
- **#13.** SMS uses the same scheduler, windows, ledger and priority. A reply on either channel stops the other tracks in app state.
- **#17.** The controls are scheduler operations. Frozen clocks store the remaining wait at pause and restore it at resume. This is tested locally; no provider is involved. Instantly has no per-lead pause, and the design does not need one. Control over the `k` messages in flight is a reported limitation.
- **#19.** No Instantly sequence exists to patch. Messages render at handover. A message already handed over keeps its copy.
- **#20.**
  - Build the recovery order and the attempt states.
  - Needs attention gains three items: unresolved attempts (P3), unexplained skips (P4) and the workspace quota hold.
  - The interruption notice follows the spec.
- **#21.** A test run uses the same scheduler, with waits cut to about a minute, `oo·test` campaigns and the real inboxes. Test sends reserve capacity like any other send.

## Experiments

Every experiment runs in `oo·test` campaigns from the real inboxes, sends only to addresses the user owns, and records payloads with the addresses redacted. Each case runs in a fresh test campaign, so an earlier stop cannot mask a later one.

All of X1–X9 gate the adapter. X9 gates it only once S3 supplies a hard-bouncing address. Without one, bounce handling is explicitly unverified.

| | Needs | What it does | Pass criteria, or what it records |
| - | - | - | - |
| X1 Dispatch | S1 (3–5 addresses) | Send to every address through `k` in flight per inbox. Use two same-domain addresses for the company-limit override. Let the only lead finish, then add another. Repeat with `is_evergreen: true` | Each add creates one lead, which sends once from the pinned inbox within the margin. HTML variables render. A finished campaign still sends to a lead added later, with `is_evergreen` or without it, or the app reactivates it. Records handover latency, `remaining_in_plan`, `verification_status` and `daily_max_leads` behavior. The override result is conclusive only if the workspace company limit is on |
| X2 Follow-up transport | S1 | Three candidates, each sending two consecutive follow-ups with no inbound reply | The pass criteria in "Follow-ups: transport gated by X2". Also records whether the sender inbox gets a copy, the unsubscribe header, `ue_type`, and whether analytics counts the send |
| X3 Reply detection | S1 | Separate cases: a human reply to an opener, a reply to a follow-up, an auto-reply, the unsubscribe link | Each stops only its campaign within the freshness bound, and the pre-send check blocks the next step |
| X4 Status sync | S1 | The same address in two test campaigns; reply in one | Records whether the other campaign's lead is marked or skipped. This decides whether C1 is asked |
| X5 Withdrawal and keys | S1 (3–5 addresses) | Add, delete and re-add with the same key and with a new key, recording each response and `remaining_in_plan`. Over repeated trials, delete handed-over leads and probe the lead status and `scheduled_only` | A candidate signal that is never followed by a send is adopted. Otherwise the `unresolved` policy stands, and the no-duplicate, no-skip promise stays unverified |
| X6 Recovery | S1 | Kill the app between a call and its recording, on dispatch and on follow-up. Lost response. Delayed completion. Two steps with identical copy | Nothing is sent twice. Ambiguous attempts surface as unresolved. The checkpoint overlap holds |
| X7 Paused inbox | S1, S2 | Pause one inbox in the UI, reply to it, resume it | Sends hold. Records the follow-up endpoint's response, and whether the reply is detected after resume. A real disconnection is not induced and stays documentation-only |
| X8 Capacity | S1, S4 | Lower one inbox's limit. Send dispatch and follow-up sends together, then a follow-up at the exhausted limit | Records whether the follow-up is refused, whether analytics `date` matches the reset day, and analytics lag |
| X9 Bounce | S3 | Dispatch and follow-up sends to the bouncing address, with "Save undelivered emails" off, then on (C3) | Each bounce marks the address bad and ends the track, and none is read as a reply. Records the signal and its delay |

Wanted, not gating: **X10**, the end-to-end test run that #21 demonstrates.

## Escalation

### Product questions

- **P1.** Should the 3 active pre-existing campaigns keep sending from the six inboxes once app campaigns launch? While they do, app openers cannot go ahead of their sends. If X8 shows follow-ups go uncounted by Instantly, an inbox can also exceed its limit. *Recommendation:* finish or pause them, or move them to other inboxes, before the first real launch.
- **P2.** Continue thread is the spec's default, but Instantly may have no transport that sends a same-thread follow-up to the prospect (X2). If none passes, should the email editor show continue thread as unavailable so the user writes new-subject steps, or send those steps as separate emails under the previous subject? *Recommendation:* show it as unavailable. Never send a separate email styled as part of the thread.
- **P3.** When the app cannot tell whether an email was sent, may it hold that lead's email track and show it in Needs attention, with two choices: "mark sent", or "mark not sent and reschedule normally", with the copy warning that it may arrive twice? *Recommendation:* yes. It is the only way to avoid guessing.
- **P4.** Should a lead that Instantly skipped for no reason the API exposes wait in Needs attention instead of having its email track end? *Recommendation:* yes.

### Consent to change workspace settings

Each affects the user's existing campaigns, and each is asked only after the experiment that shows its effect.

- **C1.** Turn global lead status sync off (UI toggle "Disable Global Lead Status Synchronization"), asked after X4. It matches "other enrollments keep running". It also stops a reply in any existing campaign from marking the person replied in their other campaigns, which removes a safety net those campaigns have today.
- **C2.** Reply preferences, asked after X3:
  - keep "Show auto-replies in Unibox" on. It is on by default, so this confirms the current value;
  - turn "Save non-Instantly emails in Unibox" on.

  Both change what the Unibox shows for every campaign. Auto-replies may also start stopping leads in existing campaigns that stop on auto-reply.
- **C3.** Turn "Save undelivered emails in Unibox" on, asked after X9. It is off by default. Bounce notices would then appear in the Unibox for every campaign.
- **C4.** Turn `add_unsub_to_block` off, which is the spec's target: an unsubscribe stops only that campaign. The API returns no value for it, and `PATCH /workspaces/current` accepts only `name` and `org_logo_url`, so the user reads and changes it in the UI. Effect: unsubscribes from existing campaigns stop being added to the workspace block list.

### Steps only the human can do

The factory has API access but no Instantly UI access.

- **S1.** Designate 3–5 email addresses the user owns as test contacts in #28. Plus-addresses count if they are delivered.
- **S2.** Consent to pause one inbox for X7.
- **S3.** Supply an address the user controls that hard-bounces, for X9.
- **S4.** Consent to lower one inbox's daily limit for part of a day, for X8.
- **S5.** Report the "Timezone for Campaign Limit Reset" value.
- **S6.** Apply in the UI whichever of C1–C4 the user approves.

### Reported provider limitations

- No delivered state.
- No documented maximum queue time or observation delay. The `k` messages in flight per inbox are outside the app's control.
- Replies from other addresses or outside the thread go undetected. Paused or disconnected inboxes are not checked for replies.
- No proven withdrawal signal. The full no-duplicate, no-skip promise stays unverified until X5 finds one.

## Sources (re-checked 12 November 2026)

- **`api_v2.json` 2.0.0, 198 paths:**
  - `POST /emails/reply`: reply-only; `additional_recipients` is "in addition to the default recipient (the sender of the email being replied to)"; no idempotency key; responses 200, 401, 402, 404 and 429.
  - `POST /emails/forward`: requires `reply_to_uuid`, `to_address_email_list`, `eaccount` and `subject`; `include_original_body` defaults to false.
  - `POST /leads/add`: always checked against the workspace block list. The idempotency key is "permanent". The response carries `status`, `leads_uploaded`, `created_leads`, `in_blocklist`, `duplicated_leads`, `skipped_count`, `invalid_email_count` and `remaining_in_plan`.
  - `GET /emails`: `eaccount` takes a comma-separated list. It also takes `mode` (`emode_all`), `scheduled_only`, `lead`, and `search=thread:<id>`. `ue_type` 4 means Scheduled.
  - Campaign fields: `limit_emails_per_company_override.mode` takes `custom` or `disabled`. `allow_risky_contacts`, `disable_bounce_protect`, `match_lead_esp` and `provider_routing_rules` exist. `daily_max_leads` is the "daily maximum new leads". `is_evergreen` and `Campaign.status` 3 (Completed) exist, and `is_evergreen` has no documented semantics.
  - `Lead.status` −3 means Skipped. `Lead.verification_status` −2 means Risky and −3 Catch All. `Lead` has no time-zone field.
  - `GET /accounts/analytics/daily`: `sent` counts campaign emails, and the time zone of `date` is undocumented.
  - `PATCH /workspaces/current` accepts only `name` and `org_logo_url`.
- **Help centre and guides:**
  - [Rate limit](https://developer.instantly.ai/getting-started/rate-limit).
  - [Account and campaign limits](https://help.instantly.ai/en/articles/6248612-setting-account-and-campaign-limits).
  - [Add steps to an active campaign](https://help.instantly.ai/en/articles/13924383-how-to-add-new-steps-to-an-active-campaign).
  - [Preferences](https://help.instantly.ai/en/articles/11864294-preferences-settings-overview): global status sync is on by default; "Show Auto-Replies in Unibox" is enabled by default; "Save Undelivered Emails in Unibox" is disabled by default; the limit resets in UTC by default.
  - [Follow-ups after reply](https://help.instantly.ai/en/articles/13886841-why-follow-ups-are-still-being-sent-to-leads-who-replied): replies from other addresses land in Others; replies are not checked on paused or disconnected inboxes.
  - [Multiple schedules](https://help.instantly.ai/en/articles/6573695-multiple-schedules).
- **Workspace, read-only `GET`:** no `add_unsub_to_block` value is returned. Nothing was created, changed, paused, activated or sent.
