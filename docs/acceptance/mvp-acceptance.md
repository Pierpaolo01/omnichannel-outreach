# MVP acceptance record

Ticket [#23](https://github.com/Pierpaolo01/omnichannel-outreach/issues/23), against [the spec's acceptance story](https://github.com/Pierpaolo01/omnichannel-outreach/issues/10). Written on 15 November 2026 from the integration branch at `925f7a2` (tickets 11 to 22 merged).

## How to read this

The application was run through its own screens, the way you would use it, on a fresh database in a scratch folder. Every company, person, address and number in the run is invented.

No real provider was used. The access handoff ([#28](https://github.com/Pierpaolo01/omnichannel-outreach/issues/28)) names no test contact of yours on any channel, no SMS provider is set up, and Instantly writes are switched off. Email and text sending went through stand-ins ("fake providers") that behave like a provider: they accept, send, bounce, report invalid numbers and pass on replies when the test tells them to. A row passed on them shows the application does its part. It does not show that Instantly or an SMS provider would deliver.

Each row has one of four results:

- **Verified.** The behavior involves no provider, and the run showed it.
- **Verified with fake providers only.** The application does its part; the real provider's part is untested.
- **Unverified.** It could not be tested yet, and the row says why.
- **Not met.** The run showed the application does not do what the spec says.

Totals, over the 30 rows of the story, the measures, laptop-independent running and the supporting cases (the criteria table at the end summarises them): 13 verified, 15 verified with fake providers only, 1 unverified, 1 not met. Several rows passed on fake providers also name a part that stays unverified until real providers are used; the last section lists them.

## Reproduce it

From a clean checkout of the branch, with Node 22 and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright test e2e/acceptance.spec.ts e2e/acceptance-proofs.spec.ts --no-deps
```

It builds the application, then runs the story (`e2e/acceptance.spec.ts`, about 45 seconds) and the supporting cases (`e2e/acceptance-proofs.spec.ts`). Each test creates its own scratch data folder and deletes it afterwards. Add `EVIDENCE_DIR=<folder>` for a screenshot per step and `RECORD_DEMO=1` for a recording.

## The acceptance story, step by step

All nine steps run in order in one test, "the acceptance story", in `e2e/acceptance.spec.ts`. The cast: eleven decision makers at two clinics and one studio with no named decision maker, imported into "Clinics, Bristol" and into a second campaign, "Spring follow-up, Bristol".

| # | Step | Result | What was observed |
|---|---|---|---|
| 1 | Import a CSV; decision makers and company leads appear; duplicates merge | Verified | The import said 12 new leads, 11 decision makers and 1 company lead. One person and one clinic each appeared twice in the files, and search found one of each. |
| 2 | Build the canvas; the preview and exactly three launch blockers | Verified | An email track, an SMS track and a phone track were built together, plus an email a day after the call and a win-back email. Before launch named exactly three blockers: empty copy, a first-name field with no fallback that the studio lacks, and no connected SMS number. The preview showed the copy for a real imported lead. Fixing each, and connecting the numbers at the provider, gave "Ready to launch". |
| 3 | Test run to your own contacts, test call and declined branch, reply stops it | Verified with fake providers only | Every email and text reached the test contacts a minute apart, and nothing went to a lead. The test call appeared on Calls. Logging "Not interested" took the canvas's win-back path, and the win-back email arrived. A second run stopped when the test email replied. Receipt on your real contacts is **unverified**: none is designated. |
| 4a | Launch: email through Instantly and texts on schedule | Verified with fake providers only | Each lead got its first email once, one a minute from the inbox, and each person with a mobile got their first text once. Nothing went to Instantly or a real SMS provider. |
| 4b | Each message shows sent, delivered or failed on the person timeline | **Not met** (delivered) | The timeline shows "Email 1 sent", "Text 1 sent", "Email 1 bounced" and "Text 1: bad number". It never shows "delivered". For email this is a recorded Instantly limitation: Instantly reports no delivered state (ADR 0002, "Delivered"). For texts, the application has no delivered state at all. ADR 0003 designed one, but no code reports it, and no SMS provider exists to report it. Reported to the coordinator; not built here. |
| 5 | Calls on Today and the focus queue; redial, callback, interested, every declined path | Verified | Today said "11 calls are ready now". Start calling opened the queue one call at a time. Logged in turn: left voicemail, no answer, wrong number, didn't reach them (with a note), a callback for 15:30, interested, and not interested three ways (stop, continue and win back, the first two chosen for that one lead). A redial was also logged. The server's reads matched each outcome. The studio had no number, so it had no call. You dial on your own phone, so no telephony provider is involved. |
| 6 | An email reply and an SMS reply each stop only that lead, with channel and date | Verified with fake providers only | Ada replied by email and Ben by text. Each showed "Replied, automation stopped" with the channel and date, on the record and in search. Their colleagues kept running, and so did Ada's lead in the other campaign, which emailed her the next day. This campaign sent her nothing more. Replies through a real provider are **unverified**. |
| 7a | A bounce or a bad number marks it bad and ends its track | Verified with fake providers only | Cara's address bounced: it was struck through as "marked wrong", her email track ended at its first email, and her second email was never sent. Dev's mobile was reported invalid: it was marked wrong, and his SMS track ended before text 2. |
| 7b | A disconnected sender shows in Needs attention | Verified with fake providers only | With one SMS number disconnected at the provider, Today's Needs attention said "Your SMS number … can't send. It is disconnected." It went away when the number reconnected. |
| 8a | Pause: clocks freeze; Paused banner with date and status counts | Verified | The campaign showed "Paused since Tue 10 Nov at 10:00", with the count of leads in each status group. The counts came from the same read as the figures, and "handed to you" matched the test's own tally. Its calls left the Calls list. Over two paused days nothing was sent, and the open redial was not skipped. |
| 8b | Resume continues each lead where it was, with no burst | Verified with fake providers only | "Resumed. Each lead continued where it was." A wait that had been running ended exactly two days later than before, and the redial kept its original due date. What fell due went out at least a minute apart per sender, never in a burst. |
| 9 | Unanswered leads end as "sequence finished, no response" | Verified with fake providers only | A week later, every lead had the status the test expected from the story. Eight ended as "Sequence finished, no response", including the studio, the declined lead that continued, and the declined lead that went to win back. Two ended as replied, one as interested on call, and one as declined on call. No lead got any step twice. |

## Campaign measures

| Measure | Result | What was observed |
|---|---|---|
| Leads in each status group | Verified | At the end: 3 handed to you and 9 ended, matching the story's expected statuses. Shown on the campaign page and in the Paused banner. |
| Each channel: sent, failed or bounced, replies | Verified with fake providers only | Email and SMS sent equalled what the fake providers delivered, test sends included and labelled "from test runs". One failure each, two email replies (one from a test run) and one text reply, all matching the test's own tally. |
| Calls: made, connected, interested, declined, callbacks pending | Verified | Calls made, connected, interested and declined matched every outcome the test logged, the test call included. No callback was left pending. |
| Rates: reply % and connect % | Verified with fake providers only | Each rate is shown with the counts behind it, for example "3 of the 14 you emailed or texted replied", with the test runs' share said beside it. Opens and clicks are not shown, as the spec asks. |

## Runs without the laptop, and recovery

| Requirement | Result | What was observed |
|---|---|---|
| Email and SMS keep sending while the laptop is closed | **Unverified** | Operation is local-only by your direction (#28). Nothing runs while the application is stopped. Deferred until hosting is chosen. |
| After an interruption nothing is sent twice and nothing is skipped | Verified with fake providers only | Test "interruption recovery" in `e2e/acceptance-proofs.spec.ts`. The application stopped after the provider accepted an email but before it recorded that, and stayed down for three hours. After a week, every lead had every step exactly once, checked against the providers' own logs. Earlier: `src/server/sequence-runs-interruptions.test.ts` runs generated stops and crashes. |
| Today's one-line notice of the interruption | Verified | The same test: Today said "Sending was interrupted from … ; N sends rescheduled", with N from the server. |

## Supporting acceptance cases

| Case | Result | Test | What was observed |
|---|---|---|---|
| Repeated imports do not duplicate or restart | Verified with fake providers only | `e2e/acceptance-proofs.spec.ts`, "reimport into a running campaign"; `e2e/demonstration.spec.ts` before launch | Importing again into the running campaign said "New 1" and "Already enrolled 11" and "No sequence was restarted". Ada's progress was unchanged and nothing was sent again. The new person started at email 1. Ada's new address showed as "Email, newer". |
| One person's campaigns stay independent | Verified with fake providers only | "one person in two campaigns" in the proofs; story step 6 | Stopping Eve in one campaign left her running in the other, which sent her its follow-up. A reply in one campaign did not stop the other. |
| A missing or failed track releases what waits on it | Verified with fake providers only | "a missing track releases what waits on it" in the proofs; story step 7a | The studio had no number, so its phone track was skipped, and the email after the call went a day later. An unworked call held only the email after it: the parallel email and text went on. |
| Unworked calls hold only dependent tracks; callbacks pause the lead | Verified | The proof above; `e2e/redial-callback.spec.ts`, "demonstration: a redial ages …" | As above. A callback held the lead's outreach until its outcome was logged (story step 5, then 7). |
| A redial keeps its original age | Verified | Story step 8; `e2e/redial-callback.spec.ts`, "a redial: the page says …" | Today showed Kim's redial as "Redial, due Mon 9 Nov". The earlier test shows a redial skipped at the end of its original limit, and the email after it starting. |
| Overdue callbacks | Verified | Story step 7; `e2e/redial-callback.spec.ts`, "a callback: entered in their time …" | A missed 15:30 callback showed on Today as "Finn Wood's callback is overdue" and stayed on Calls until its outcome was logged. |
| Every declined path forbids another cold call | Verified | Story step 5; `e2e/declined.spec.ts` | Stop, continue and win back each left no call for the lead afterwards. |
| Pause freezes the skip limit and removes calls from the queue | Verified | Story step 8; `e2e/controls-demonstration.spec.ts` | As step 8a. |
| Edits respect started and finished track boundaries | Verified with fake providers only | `e2e/running-edits.spec.ts`, "a changed email and a removed one …" and "a paused campaign is edited …"; `src/server/sequence-runs-edits.test.ts` (generated, over HTTP) | Changed copy reaches only messages not yet sent. A removed email is skipped by leads not there yet, and changes apply only on Apply. The generated runs check that added steps and rearranged tracks never restart a finished track. The copy push to Instantly is **unverified** against the real service. |
| Bulk actions disclose their campaign scope | Verified | `e2e/people-bulk.spec.ts`, "the demonstration: a person in two campaigns …" | Under a campaign filter the toolbar says "in Clinics, London only". Without one, the confirmation says "in every campaign they are in", and names any lead it leaves alone and why. |
| Reply metadata without content | Verified with fake providers only | Story step 6 | Replies show channel and date only, never the message. |

## Ticket 23's criteria

| Criterion | Result |
|---|---|
| Import and merge duplicates; canvas, preview and exactly three blockers | Verified (steps 1 and 2). |
| Accelerated test run to your own contacts from real senders; launch through Instantly and scheduled SMS with provider-reported states | Verified with fake providers only (steps 3 and 4a). Real senders and your own contacts are **unverified**: no test contact is designated, Instantly writes are off, and no SMS provider exists. The delivered state is **not met** (step 4b). |
| Today and focus-queue calls; email and SMS replies stop only their campaign's lead | Verified (step 5); replies verified with fake providers only (step 6). |
| Bad address and number, failed-track completion, disconnected sender, pause with frozen clocks and banner, no-burst resume | Verified with fake providers only (steps 7 and 8). |
| Sequence finished, no response; campaign, channel and call measures | Verified with fake providers only (step 9 and the measures). |
| Laptop-independent sending, interruption recovery, and the supporting cases | Laptop-independent sending is **unverified** (local-only). Recovery and every supporting case are verified, with fake providers where sending is involved. |
| Record the results and any unmet criterion without weakening the spec | This document. |

## What is not proven, in one place

- **Real senders and your own contacts.** No email or text reached a real inbox or phone. Instantly was not written to, and no SMS provider exists. Each fake-provider row needs a re-run against the real services once you designate test contacts and the SMS provider is provisioned.
- **SMS and calling as provider integrations.** None is provisioned. Calls are dialled by you on your own phone, and the application only lists them and records outcomes.
- **Delivered.** Not shown for email (Instantly reports none) and not built for SMS (step 4b).
- **Sending with the laptop closed.** Deferred while operation is local-only.
