# Evidence for ticket #16, part a

Screenshots for the pull request "Ticket 16a: declined calls take the phone track's path". Captured at the head
`f668390` (the screens did not change after it). All data is fictitious: the fixture set in `test/fixtures/scraper/`,
invented clinics and people built in `e2e/fake-provider.ts`, an invented sender inbox, and two simulated SMS numbers
labelled "Simulated SMS (not a provider)". Nothing is dialled or sent to anyone. Captured with Chrome, full page, in
the light and dark themes at 1360 and 390 px wide, from the standing screen list in `e2e/screens.ts`:

1. Before launch for a campaign with a win-back branch: the finished estimate says the branch's emails and texts are not counted.
2. The phone track's inspector with a declined path, in a campaign with a win-back branch set over HTTP.
3. A person's Activity with a declined call: the call entry says the path taken.
4. The Calls page after the call was declined in another window: off the list, with the server's reason.
