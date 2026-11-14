# Evidence for ticket #14, part c

Screenshots and the demonstration recording for the pull request "Ticket 14c: the phone track in the campaign editor".
Recaptured at the head `dc9555b` (earlier sets, at `5cd8a93` and `c1eb864`, are in this branch's history). All data is
fictitious: the fixture set in `test/fixtures/scraper/`, invented clinics and people built in `e2e/fake-provider.ts`, an
invented sender inbox, and two simulated SMS numbers labelled "Simulated SMS (not a provider)". Nothing is dialled: a
call is a task on the user's list. No telephony, SMS or email provider is involved; the fake-provider screens are not
provider proof. Captured with Chrome at 1360×900 (and 1024 and 390 where named), full page, from the standing screen
list in `e2e/screens.ts`. The "too large to estimate" screen marks the answer too large in transit: a real campaign
past the bound would take minutes to build for a screenshot.
