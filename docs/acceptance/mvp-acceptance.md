# MVP acceptance record

Ticket [#23](https://github.com/Pierpaolo01/omnichannel-outreach/issues/23), against [the spec's acceptance story](https://github.com/Pierpaolo01/omnichannel-outreach/issues/10). Written on 15 November 2026, run on the integration branch at `440f08b`: tickets 11 to 22 merged, and the fix in pull request 63.

## How to read this

The application was run through its own screens, the way you would use it, on a fresh database in a scratch folder. Every company, person, address and number in the run is invented.

No real provider was used. The access handoff ([#28](https://github.com/Pierpaolo01/omnichannel-outreach/issues/28)) names no test contact of yours on any channel, no SMS provider is set up, and Instantly writes are switched off. Email and texts went through stand-ins ("fake providers") that behave like a provider. They accept and send, and when the test tells them to, they bounce, report an invalid number, report a disconnected number or pass on a reply. A row that passed on them shows the application does its part. It does not show that Instantly or an SMS provider would deliver.

Each sentence in the "What the test checks" column is an assertion in the test it names. Its expected value comes from the test's own record of what it did, or from the fake providers' logs, never from the application. Each row has one of four results:

- **Verified.** No provider is involved, and the test shows it.
- **Fake providers only.** The application does its part; the real provider's part is untested.
- **Unverified.** It could not be tested yet; the row says why.
- **Not met.** The test shows the application does not do what the spec says.

**Totals over the 86 rows below: 36 verified, 43 with fake providers only, 5 unverified, 2 not met.** The defects found are listed at the end.

## Reproduce it

You need Node 22, pnpm and a free port. From a clean clone:

```sh
git clone https://github.com/Pierpaolo01/omnichannel-outreach.git && cd omnichannel-outreach
git checkout ticket/23-acceptance-story
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
E2E_PORT=4399 pnpm exec playwright test e2e/acceptance.spec.ts e2e/acceptance-proofs.spec.ts e2e/acceptance-defects.spec.ts --no-deps
```

The test runner builds the application and starts its own server on `E2E_PORT` (4320 if unset), so that port must be free. The story (`e2e/acceptance.spec.ts`) takes about a minute and a half. The supporting cases (`e2e/acceptance-proofs.spec.ts`) take under a minute. The two defect tests (`e2e/acceptance-defects.spec.ts`) assert their setup normally and assert each defect as it is today on its own line, so they pass while the defects remain and that line fails once one is fixed. Run them with `SHOW_DEFECTS=1` to assert what the spec asks instead and see them fail. Each test makes its own scratch folder and deletes it afterwards. Add `EVIDENCE_DIR=<folder>` for a screenshot per step and `RECORD_DEMO=1` for a recording.

In the table, "story" means the test "the acceptance story" in `e2e/acceptance.spec.ts`, with its step number. "Proof" means a named test in `e2e/acceptance-proofs.spec.ts`.

## 1. Import

| Clause | Result | Test | What the test checks |
|---|---|---|---|
| Decision makers and company leads appear | Verified | story, 1 | The New campaign screen reports 12 new leads: 11 decision makers and 1 company lead, the counts in the test's own export. |
| Duplicates are merged | Verified | story, 1 | One person and one clinic are each listed twice in the files; search finds one of each. |

## 2. Build

| Clause | Result | Test | What the test checks |
|---|---|---|---|
| The canvas: tracks together and after, the declined path and the win-back branch | Verified | story, 2 | Built on the Sequence screen: email, SMS and phone tracks together, an email after the phone track, and a win-back email. The stored sequence lists the five tracks with the channel, branch and kind of start the test gave each. The email after the call starts after the phone track, one day after it. The phone track's declined path is win back. Each first email and text track waits two days before its second message. |
| The preview renders each step's copy for a real imported lead | Verified | story, 2 | With Ada Reyes chosen, every message the test wrote appears filled in for her and her clinic: both emails, both texts, the email after the call and the win-back email. |
| The preview switches between leads | Verified | story, 2 | Switched to the studio, a company lead with no first name, the first email reads "Hi there," (the fallback the test typed) and names the studio. |
| Channel coverage | Verified | story, 2 | 12 of 12 leads have an email, 11 of 12 a mobile and 11 of 12 a phone number: the 11 people in the test's export, and not the studio. |
| Leads with missing merge fields, and the fallback used | Verified | story, 2 | First name: 1 company lead lacks it, and gets "there" or "Hi", the two fallbacks the test typed. |
| Projected daily load per sender account | Fake providers only | story, 2 | The inbox's busiest day is 12 emails, every lead's first email on launch day, with 0 of its 60 used so far. The two numbers' busiest days add up to 11 texts, the 11 people's first texts. |
| Calls per day against call capacity | Verified | story, 2 | 11 calls a day, the 11 people, against the 30 a day the test set; 0 on the list so far. |
| About how long until all leads have started | Fake providers only | story, 2 | "All 12 leads start within 1 day of launch." With the senders' capacity, every lead's first message fits on launch day. |
| Blockers: empty copy, and a merge field with no fallback that a lead lacks | Verified | story, 2 | Before launch lists exactly three blockers, and launch is disabled. Two of them are an email with no copy and `{{first_name}}` with no fallback, which the studio (a company lead) lacks. |
| Blocker: a track whose channel has no connected sender | Fake providers only | story, 2 | The third blocker names the SMS track while the provider reports both numbers unable to send. Fixing each blocker where it is named, and connecting the numbers at the provider, gives "Ready to launch". |
| No test run since the last edit is a warning only | Verified | story, 2; `e2e/test-run.spec.ts` | Before any test run, Before launch shows "No test run since your last edit" with Launch enabled. The earlier test launches with that warning showing. |

## 3. Test run

| Clause | Result | Test | What the test checks |
|---|---|---|---|
| The user picks test contacts: their own email and mobile | Verified | story, 3 | Saved on the Test run tab. |
| Run test sends every step in order to the test contacts, and nothing to a lead | Fake providers only | story, 3 | In run A, the user's email and mobile each get every message of the main path once: the first and second email, the first and second text, and the email after the call, matched by the copy the test typed. Each track's messages arrive in its order. Every delivery up to the end of each run (A after its email after the call, B after its win-back email, C after its reply) went to the user's own email or mobile, checked on both providers' logs. |
| Each wait is cut to about a minute | Fake providers only | story, 3 | Second email after the first, and second text after the first: each between 45 and 90 seconds (they were 60). The email set for a day after the call came between 45 and 90 seconds after the call was logged. |
| Call steps put a test call on the user's list | Verified | story, 3 | The Calls page lists it "To your test mobile". |
| The test call's outcome follows the canvas: the main path | Fake providers only | story, 3 | Run A logs no answer half a minute in, before the second email and text fall due. Both, and the email after the call, then arrive after the call, and the tab says "Finished: every step ran" at the time of the last of them. |
| The declined path: win back | Fake providers only | story, 3 | Run B logs not interested, with the win-back path preselected. The win-back email arrives within a minute. The email after the call shows "Skipped: the test moved to the win-back branch". |
| The declined path: stop and continue | Fake providers only | proof "the test call's declined paths" | With the phone track set to stop, nothing more arrives after the first email. Set to continue, the second email still arrives. Neither enters win back. |
| A skipped branch is said as skipped | Verified | story, 3 | Run A lists the win-back email as "Not reached". Run B lists the email after the call as skipped, with why. |
| A reply from the test contact stops the test | Fake providers only | story, 3 | Run C: after a reply from the test email, the run had sent one email and one text, and nothing more arrived in the five minutes after. The tab says "Stopped by your reply". |
| It can be run again at any time, including on a running campaign | Fake providers only | story, 3 (three runs); proof "a test run on a running campaign" | Run again twice before launch. After launch, the Test run tab runs it again, and the test email arrives. |
| Test sends count like any other send | Fake providers only | proof "a test run on a running campaign" | With an inbox of four sends a day, three leads' emails and the test's first email use Monday's four. The test's second email goes on Tuesday. No day exceeds four. |
| From your real sender accounts, to your own email and phone | **Unverified** | none | No test contact of yours is designated, Instantly writes are off, and no SMS provider exists. |

## 4. Launch

| Clause | Result | Test | What the test checks |
|---|---|---|---|
| Email goes out through Instantly | **Unverified** | none | Nothing was written to Instantly. |
| Email and SMS go out on schedule | Fake providers only | story, 4 | After launch, every lead's first email arrives once, and no two of them less than a minute apart from the inbox. Every decision maker with a mobile gets their first text once. The company lead, with no mobile, gets no text. |
| Each message shows "sent" on the person timeline | Fake providers only | story, 4 | "Email 1 sent" and "Text 1 sent" on Ada's timeline, each at the minute the provider sent it. |
| Each message shows "failed" | Fake providers only | story, 4 | "Email 1 bounced" on Cara's timeline, at the minute the provider reported the bounce. "Text 1: bad number" on Dev's. |
| Each message shows "delivered" | **Not met** (accepted for the MVP) | story, 4 | No timeline entry says delivered. The principal decided on 15 November 2026 (issue 23): for the MVP a message shows sent or failed. Email cannot show delivered, because Instantly reports no delivered state (ADR 0002). A text's delivered state is built when a real SMS provider is connected and can be checked against its delivery receipts. Until then this row stays not met. |

## 5. Calls

| Clause | Result | Test | What the test checks |
|---|---|---|---|
| Calls appear on Today | Verified | story, 5 | Today says "11 calls are ready now". The list holds the 11 decision makers the test planned to call, and not the company lead, which has no number. |
| The focus queue opens one call at a time | Verified | story, 5 | Start calling opens a call. Each outcome is logged with "Log and open next call", and the next call opens until all 11 are done. |
| Every outcome is recorded as logged, with its note | Verified | story, 5 | Left voicemail, no answer, didn't reach them, wrong number, callback requested, interested and not interested. Each person's activity read back from the server holds exactly the outcome the test logged, and the note the test typed (four calls had one; the rest have none). |
| Wrong number marks the dialled number bad | Verified | story, 5 | Dev's mobile was already marked wrong, so the call went to his clinic's main line. That line is now marked bad. |
| Redial | Verified | story, 5 and 8 | Kim's call is listed again for Tuesday. On Tuesday, Today shows "Redial, due Mon 9 Nov". |
| Callback | Verified | story, 5 and 7 | Finn's lead shows "callback scheduled". The missed callback is overdue on Today and on the Calls list. |
| Interested | Verified | story, 5 | Gia shows "Interested on call". |
| The declined path: stop, continue and win back | Verified | story, 5 | Hal (stop) is declined on call. Ivy (continue) records the continue path. Jon (win back) is in the win-back branch. |

## 6. Reply

| Clause | Result | Test | What the test checks |
|---|---|---|---|
| An email reply stops that lead | Fake providers only | story, 6 | Ada's status is replied, on email, at the instant the test made the reply. |
| An SMS reply stops that lead | Fake providers only | story, 6 | Ben and Ivy texted back. Each is replied, on SMS, at the instant of their text. |
| "Replied, automation stopped", with the channel and date | Fake providers only | story, 6 | Each of the three records shows that label and "Replied by email" or "Replied by text" on the date and time the test made the reply. Search shows Ada as replied. |
| Only that lead: colleagues keep running | Fake providers only | story, 6 and 8 | Cara, at the same clinic as Ada, Ben and Ivy, stays active and gets her second text on Friday. |
| Only that campaign: the lead's other campaigns keep running | Fake providers only | story, 6 and 8 | Ada's lead in "Spring follow-up, Bristol" is not replied, and that campaign's email reaches her on Tuesday. |
| Nothing more is sent after a reply | Fake providers only | story, 9 | Nothing reached Ada, Ben or Ivy in this campaign after their reply, up to 20 November. |

## 7. Failures

| Clause | Result | Test | What the test checks |
|---|---|---|---|
| A bounce marks the address bad and ends its track | Fake providers only | story, 4, 7 and 9 | Cara's address is struck through as "Email, marked wrong". Her first email track is finished, with the reason "failed_bad_destination". Up to 20 November she got that one email and never the second. |
| A bad number marks the number bad and ends its track | Fake providers only | story, 4, 7 and 9 | Dev's mobile is "Mobile, marked wrong", and his timeline says nothing more is texted to it. His SMS track is finished, with the reason "failed_bad_destination". He got one text, never the second. |
| A disconnected sender account shows in Needs attention | Fake providers only | story, 7 | With the second number disconnected at the provider, Today's Needs attention names it and says "It is disconnected." Reconnected, the entry goes. |

## 8. Pause and resume

| Clause | Result | Test | What the test checks |
|---|---|---|---|
| A Paused banner with the date it was paused | Verified | story, 8 | "Paused since Tue 10 Nov at 10:00", the instant the test paused it. |
| The count of leads in each status group | Verified | story, 8 | The test works out each of the 12 leads' status at that moment from the story so far. The banner and the measures read both show 4 running, 2 waiting on you, 4 handed to you, 0 paused and 2 ended. |
| Its calls leave the list | Verified | story, 8 | The Calls queue shows ready now 0 and later today 0, names neither of its two calls, and says they are off the list while paused. (The panel beside the queue can show a call it had open with a false reason: defect 3.) |
| Clocks freeze: nothing is sent while paused | Fake providers only | story, 8 | Over the two days paused, nothing reached the campaign's leads. |
| Clocks freeze: waits | Fake providers only | story, 8 | Eve's, Dev's and the studio's second emails, and Cara's second text, each go on the day two days after the first message, moved two days later by the pause, at or after 09:00 that day. |
| Clocks freeze: the call skip limit | Verified | story, 8 | Kim's redial is still on the list after the pause. Not worked, it is skipped at the end of Thursday: its limit from Monday, moved by the two days paused. |
| Resuming continues each lead where it was | Fake providers only | story, 8 | "Resumed. Each lead continued where it was." Each follow-up came at its frozen time, as above. |
| No burst on resume | Fake providers only | proof "resume without a burst" | All four first emails and four texts fell due during the pause. The worker ticks every 15 seconds after resume, as in production. Per sender they go at the resume and then one 10-minute gap apart: the sender's configured pacing holds, and the backlog does not go at once. The proof does not show any further spreading across the rest of the window beyond that pacing. |

## 9. End

| Clause | Result | Test | What the test checks |
|---|---|---|---|
| A lead with no response ends as "sequence finished, no response" | Fake providers only | story, 9 | On 20 November every lead has the status the test wrote down from the story: seven finished with no response, three replied, one interested on a call, one declined on a call. Eve's record shows "Sequence finished, no response". |
| Nothing is sent twice | Fake providers only | story, 9 | Each lead got each step at most once, by the providers' logs. |

## Runs without the laptop

| Clause | Result | Test | What the test checks |
|---|---|---|---|
| Email and SMS keep sending while the laptop is closed | **Unverified** | none | Operation is local-only by your direction (#28). While the application is stopped, its local scheduling and its reading of provider reports stop: nothing new is handed over, and replies and bounces wait to be read. Work a provider has already accepted may still go out meanwhile. Deferred until hosting is chosen. |
| After an interruption nothing is sent twice and nothing is skipped | Fake providers only | proof "interruption recovery" | Explained below. Each lead's email arrived exactly once, the stopped one included, by the provider's own log. |
| Missed sends are spread across the sending window | Fake providers only | proof "interruption recovery" | The two emails that were due and not yet with the provider went at the restart and one 10-minute gap later: the sender's configured pacing holds after the restart, and the missed sends do not go at once. The proof does not show any further spreading across the rest of the window beyond that pacing. |
| Today's notice, "sending was interrupted from X to Y; N sends rescheduled" | Fake providers only | proof "interruption recovery" | The test expected from 09:10 (when the process died) to 12:10 (the restart), and 2 sends: the leads due and not handed over when it died. Today shows exactly that line. |
| Overdue callbacks show in Needs attention | Verified | story, 7 | "Finn Wood's callback is overdue". |
| Rolled-over calls show in Needs attention | Verified | story, 8 | "One call carried over from an earlier day": Kim's redial, the one open call from Monday. |

**What the interruption proof does.** The application runs as a separate Node process: the real HTTP app, store and engine on a database file in the system temporary folder. The test drives its clock. The email provider is a fake living in the test's process, so it carries on while the application is gone. The second email is accepted by the provider, and then the application process exits at once (`process.exit`, no clean-up), before recording the send. The test moves time on three hours, then starts a new process on the same database file. The process is started through the test harness's wiring, not `src/server/main.ts`, which has no fake-provider mode. The proof covers email only; SMS recovery is covered by the earlier engine tests (`src/server/sequence-runs-interruptions.test.ts`), not by a process exit.

## Campaign measures

| Clause | Result | Test | What the test checks |
|---|---|---|---|
| Leads in each status group | Verified | story, 8 and 9 | At the end, 4 handed to you and 8 ended, matching the statuses written down from the story, on the read and the campaign page. |
| Email and SMS: sent, failed or bounced, replies | Fake providers only | story, 9 | Each sent count equals what the fake providers delivered, test runs' sends included and said as such. One failure on each channel, the bounce and the bad number. Email replies: Ada and the test run's. SMS: Ben and Ivy. All are on the read, and the campaign page says each row exactly. |
| Calls: made, connected, interested, declined, callbacks pending | Verified | story, 9 | Made, connected, interested and declined equal the outcomes the test logged, its two test calls included. Connected means interested, not interested or a callback asked for. No callback is pending. |
| The reply rate, with its counts | Fake providers only | story, 9 | The leads and test runs that replied, out of those emailed or texted (from the providers' logs), as "N% X of the Y you emailed or texted replied (test runs: …)". |
| The connect rate, with its counts | Verified | story, 9 | Connected calls out of calls made, as "N% X of Y calls reached the prospect for a conversation (test runs: …)". |
| Opens and clicks are left out | Verified | story, 9 | The panel never mentions opens or clicks. |

## Supporting acceptance cases

| Case | Result | Test | What the test checks |
|---|---|---|---|
| Repeated imports do not duplicate or restart | Fake providers only | proof "reimport into a running campaign"; `e2e/demonstration.spec.ts` before launch | Every lead in the first file (its 11 people and the studio) is enrolled once after the second import, as the same lead. Their progress follows the providers' logs: each had its first email (and first text, for the people) before the import, never gets either again, and gets its second email once, on the day two days after its first. The import says "New 1" and "No sequence was restarted". The newcomer starts at the first email. Ada's new address shows as "Email, newer". |
| One person in several campaigns: email and calls stay independent | Fake providers only | proof "one person in two campaigns stays independent for email and calls" | Stopped in one campaign, Eve gets nothing more from it. The same day, that campaign's call has left the list and the other campaign's call is on it. She still gets the other campaign's second email, and her colleague in the first campaign is not stopped. |
| One person in several campaigns: SMS, with a second number free | Fake providers only | proof "one person in two campaigns over SMS" | The second campaign texts them from the other number. |
| One person in several campaigns: SMS, with no other number free | **Not met** (decided, change pending) | proof "one person in two campaigns over SMS" | The principal decided on 15 November 2026 (issue 23): the second campaign is to skip its SMS track for that person, with the reason shown, as for a missing channel. That change is in its own pull request. On this branch the track is held, and Needs attention says "the mobile is in another campaign's SMS conversation from every number this campaign may use". It stays held until a free number joins the campaign's pool, or the user skips the step or stops the lead. The same campaign's email arrives and its call is on the list. |
| A missing track releases what waits on it | Fake providers only | proof "a missing track releases what waits on it" | The studio has no number, so its phone track is skipped at launch. The email after the call goes on the next day. |
| A failed track releases what waits on it | Fake providers only | proof "a failed track releases what waits on it" | When a bounce ends an email track, the text track after it goes the day after the bounce. When an invalid number ends an SMS track, the email track after it goes the day after. For a lead with no failure, both go only the day after the tracks' last steps. |
| An unworked call holds only the tracks after it | Fake providers only | proof "a missing track releases what waits on it" | With Eve's call still open on Wednesday, her second email and second text went that day. The email after the call did not. |
| A callback holds the lead | Fake providers only | story, 8 and 9 | Finn's follow-ups fell due on Friday while his callback was open, and nothing went to him. The hold froze his clock as a pause does (ADR 0003 2.3). Once its outcome was logged, his follow-ups went on the first weekday window after their due time on that frozen clock. |
| A redial keeps its original skip-limit clock | Verified | story, 8; `e2e/redial-callback.spec.ts`, "a redial: the page says …" | Today shows the redial as due on its original day. The earlier test shows it skipped at the end of its original limit. |
| No declined lead is called again on this canvas | Verified | story, 8 | On Tuesday the call list holds exactly Kim's redial and Finn's callback. None of the three declined leads (stop, continue, win back) is on it. |
| A later phone track never calls a declined lead | **Unverified** | none | The story's canvas has one phone track, so nothing here tests a second phone track after a decline. |
| A campaign pause freezes the skip limit and removes calls from the queue | Verified | story, 8 | As in section 8. |
| A running edit says what it does to running leads, and applies only on Apply | Verified | `e2e/running-edits.spec.ts`, "a changed email and a removed one …" and "a paused campaign is edited …" | The screens say how many leads get changed copy and which skip a removed email. The stored sequence changes only on Apply. These pass at this head. |
| Edits respect started and finished track boundaries in what is sent | **Unverified** | none independent | No test here checks against the providers' logs that changed copy is what gets delivered, that a removed step is not received, or what is sent after a resume following an edit. The generated edit runs (`src/server/sequence-runs-edits.test.ts`) read starts and finishes from the application, so they do not count as independent evidence here. The copy push to Instantly is untested against the real service. |
| Bulk actions disclose their campaign scope | Verified | `e2e/people-bulk.spec.ts`, "the demonstration: a person in two campaigns …" | Under a campaign filter, the toolbar says the actions apply to that campaign only. Without one, the confirmation says "in every campaign they are in" and names any lead it leaves alone and why. It passes at this head. |
| Reply metadata appears without the reply's content | Fake providers only | story, 6 | Ben's text ("STOP please remove me") and Ivy's ("Auto-reply: I am away …") appear nowhere on their records. |
| Any reply stops, auto-replies and opt-outs included, without sorting | Fake providers only | story, 6 | An opt-out text and an auto-reply text each stop their lead as a reply. The fake email provider carries no message body, so email auto-replies were not tried. The application never reads a reply's content on either channel. |

## Defects found

1. **No "delivered" state.** Step 4. Accepted for the MVP by the principal on 15 November 2026: sent or failed. A text's delivered state is built when a real SMS provider is connected. The row stays not met until then.
2. **A person's campaign row, and the read behind it, can name a past due time outside the sending window.** A campaign that sends Tuesday to Friday is launched on Monday at 10:00. At 11:00 the read gives the step's due time as Monday 10:00, and the person's row says "Next: email 1 of 1, due Mon 9 Nov at 10:00": an hour in the past, on a day the window excludes. The engine sends it on Tuesday at 09:00, when the window opens. Test: `e2e/acceptance-defects.spec.ts`. It asserts the defect as it is today on its own line, so a fix makes that line fail; `SHOW_DEFECTS=1` asserts what the spec asks instead. Fixed on a separate branch, not here.
3. **On the Calls page, a paused campaign's call is shown with a false reason.** A user has a callback open on the Calls page, the campaign is paused, and they come back. The queue is rightly empty. The panel beside it still shows that call, with every outcome and Log disabled, and the server refuses a post with 409. Nothing can be logged. The defect is the message: the call "was already logged from another window or device: callback requested at …". The read's `offList.reason` is "logged", because the callback request is on the same task. Same test file and markers. Fixed on a separate branch, not here.
4. **Times on the Test run tab.** Follow-up, not blocking. A campaign made on the New campaign screen takes this computer's time zone as its default. The Test run tab shows its times in that zone without naming it, while Today and Calls use your own zone. When the two differ, the same moment reads as two different times. The run sets the campaign's zone in the editor, as you would.

## What is not proven, in one place

- **Real senders and your own contacts.** No email or text reached a real inbox or phone. Each fake-provider row needs a re-run against the real services once you designate test contacts and an SMS provider is set up.
- **SMS and calling as provider integrations.** None is provisioned. You dial calls on your own phone; the application lists them and records outcomes.
- **Delivered.** Accepted for the MVP as sent or failed; a text's delivered state waits for a real SMS provider.
- **Sending with the laptop closed.** Deferred while operation is local-only.
- **SMS in two campaigns with one number.** The decided skip is in its own pull request; on this branch the track is held.
- **A later phone track after a decline, and what a running edit sends.** Not tested here.
