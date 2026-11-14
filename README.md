# Evidence for ticket #16, part b

Screenshots and a recording for the pull request "Ticket 16b: the declined path and the win-back branch in the campaign editor". The after set was recaptured at the head `8c716b2`, after the review bot's finding on the box's width (the first set, at `ff7054b`, is in this branch's history); the before set and the recording are from `ff7054b`, and the flow they show did not change. All data is fictitious: the fixture set in `test/fixtures/scraper/`, invented clinics and people built in `e2e/fake-provider.ts`, and an invented sender inbox. Nothing is dialled or sent to anyone. No email, SMS or telephony provider is involved.

Captured with Chrome, full page, in the light and dark themes, from the standing screen list in `e2e/screens.ts`. Most are at 1360 px; some also at 1024, 768 and 390 px. Where the canvas holds more than its panel shows, a second capture (`canvas-end`) has the canvas scrolled to its end, where the win-back branch is.

`ticket-16b/after/` (this pull request):

1. A phone track with no declined path chosen: nothing checked, and what a declined call does meanwhile, as the engine reads it. Win back is disabled with the definition's own clause. The empty win-back branch is on the canvas.
2. A phone track whose declined path is stop.
3. A phone track whose declined path is continue, with no branch track yet.
4. A phone track whose declined path is win back: the branch's tracks are listed, with Edit branch, and the dashed "if declined" edge runs to the branch.
5. The win-back branch, empty, below a phone track.
6. The win-back branch with an email track and an SMS track after it, at 1360, 1024, 768 and 390 px.
7. A win-back SMS track in the inspector, starting after the win-back email track.
8. Removing the branch's last track while a phone track's path is win back, refused in the definition's words.
9. A save the server still refuses (a mocked 400), with the server's sentence.
10. Before launch with a win-back branch: the branch track blockers, and the branch's messages in Copy for a lead.
11. Before launch over the fake providers for a campaign with a win-back branch (the finished estimate's note from part a, with Copy for a lead now showing the branch).
12. The review bot's case on `8147ba6`: a main sequence of one phone track with the inspector open and the branch empty, at 1360 and 1140 px. The box keeps to the width the canvas budgeted and its text wraps, so nothing scrolls sideways.

`ticket-16b/before/` (the integration branch at `2f3ef8c`, before this pull request): the phone inspector saying that choosing a path arrives with a later release, a branch set over HTTP that the canvas does not draw, and the same Before launch screen.

`ticket-16b/win-back-by-keyboard.mp4`: the browser test "by keyboard: choose a path, build the branch, arrange it, offer win back, and take it apart again" (`e2e/win-back-editor.spec.ts`), recorded with `RECORD_DEMO=1` (slowed down). It chooses continue by arrow key, adds a win-back email track from the empty branch and writes it, chooses win back, adds a win-back SMS track from the branch's menu (which offers no phone track), and starts it after the email track plus 2 days. It then removes the SMS track, is refused removing the last track while win back is chosen, chooses stop, and removes the last track.
