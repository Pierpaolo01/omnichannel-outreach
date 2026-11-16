# Evidence: question Q7 answered (pull request 66)

Screenshots from `e2e/sms-conversation-taken.spec.ts`, light and dark, on the app over the fake providers, in London time. All data is fictitious. 01 to 03 were first taken at `bebdc06`. All five were retaken at `50788ac`, after the reviews of `faac357`, with the app's user time zone set to London so Today and the record show the same clock.

- `01-record-activity-skipped`: Pat Oneil's record. In Autumn clinics, the SMS track was skipped and names Spring clinics, which keeps the text conversation. The email track started after it.
- `02-record-no-usable-channel`: Nia Cole had no email, so her outreach in Autumn clinics ended with no usable channel.
- `03-today-needs-attention`: Today's Needs attention says why Nia could not be reached.
- `04-today-on-hold-unsettled`: Spring clinics' first text to Pat went, but the provider never reported it, and every lookup answers unknown (ADR 0003 Q7 point 10). Today lists "Pat Oneil is on hold in Autumn clinics", naming Spring clinics as the campaign whose first text is unknown, with Open record. Spring clinics' own entry, "Pat Oneil is on hold in Spring clinics", is the existing unresolved-provider hold on that text.
- `05-record-on-hold-unsettled`: Pat's record. The Autumn clinics row says "Next: text 1 of 2, on hold because the first text from campaign Spring clinics to the same mobile, on every number this campaign can use, isn’t known to have gone or not yet." and offers Skip this step.
