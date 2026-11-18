# Scraper fixtures

Fictitious paired exports with the exact headers of the real scraper (verified schema on issue #11). Every company, person, address, email and number is invented: domains use `.example`, and phone numbers come from the UK's drama ranges (`+44 20 7946 0xxx`, `+44 7700 900xxx`). Never add real prospect data here.

`run1` is a first scraper run. `run2` is a later run of the same search: Harbour Lane Physio has a new `business_id` but the same `place_id`, Amira Hassan has a new email, Riverside Sports Clinic has a second shared inbox, and Ravi Patel is new at Northgate Dental Studio.

The cases they cover:

| Case | Rows |
|---|---|
| Two decision makers at one company, both enrolled | Amira Hassan, Tom (blank last name) at Harbour Lane Physio |
| JSON array in `source_urls`, with a quoted comma | Amira Hassan |
| Decision maker with only the company main line, so phone steps only | Grace Okafor |
| Company with no named decision maker, enrolled as a company lead | Riverside Sports Clinic |
| Decision maker with no usable channel, kept on the record beside a reachable colleague | Sofia Marin, beside Daniel Price at Elm Street Chiropractic (no main line) |
| Unreachable decision maker; company enrolled through its shared inbox | Marco Bianchi, Juniper Pilates Studio |
| Company with no channel at all, not enrolled | Copper Kettle Osteopathy |
| People row whose company is missing from the Businesses file | Jordan Lee |
