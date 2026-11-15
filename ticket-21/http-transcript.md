# Ticket 21 demonstration: HTTP transcript on the fake providers (fictitious contacts)

## 2026-11-09T10:00:00.000Z  PUT /api/campaigns/id-1/test-contacts
```json
{
  "email": "amira@harbourlanephysio.example",
  "mobile": ""
}
```
→ 409
```json
{
  "error": {
    "code": "test_contact_is_a_lead",
    "message": "This email belongs to a lead. Test contacts must be your own.",
    "field": "email"
  }
}
```

## 2026-11-09T10:00:00.000Z  PUT /api/campaigns/id-1/test-contacts
```json
{
  "email": "alex.own@personal-mail.example",
  "mobile": "+44 7700 900456"
}
```
→ 200
```json
{
  "contacts": {
    "email": "alex.own@personal-mail.example",
    "mobile": "+44 7700 900456",
    "emailIsALead": false,
    "mobileIsALead": false
  },
  "noTestSinceEdit": true,
  "run": null
}
```

## 2026-11-09T10:00:00.000Z  POST /api/campaigns/id-1/test-runs
```json
{
  "requestId": "demo-run-1",
  "renderAs": "id-26",
  "expect": {
    "definitionVersion": 1
  }
}
```
→ 200
```json
{
  "contacts": {
    "email": "alex.own@personal-mail.example",
    "mobile": "+44 7700 900456",
    "emailIsALead": false,
    "mobileIsALead": false
  },
  "noTestSinceEdit": false,
  "run": {
    "running": true,
    "ending": null,
    "renderAs": "Amira Hassan",
    "steps": [
      "Email track · Email 1: sent 2026-11-09T10:00:00.000Z",
      "Email track · Email 2: due 2026-11-09T10:01:00.000Z",
      "SMS track · Text 1: sent 2026-11-09T10:00:00.000Z",
      "SMS track · Text 2: due 2026-11-09T10:01:00.000Z",
      "Phone track · Call: not_reached",
      "Win-back email track · Win-back email 1: not_reached"
    ]
  }
}
```

## 2026-11-09T10:00:00.000Z  POST /api/campaigns/id-1/test-runs
```json
{
  "requestId": "demo-run-2",
  "renderAs": "id-26",
  "expect": {
    "definitionVersion": 1
  }
}
```
→ 409
```json
{
  "error": {
    "code": "control_refused",
    "message": "A test is already running. Stop it to run another."
  }
}
```

> Received on the fake test email:

```json
[
  {
    "at": "2026-11-09T10:00:00.000Z",
    "step": "s1",
    "from": "outreach@northlight-mail.example",
    "subject": "Evening bookings at Harbour Lane Physio",
    "body": "Hi Amira,\n\nI came across Harbour Lane Physio while looking at clinics in London. Online booking stops at 18:00, which is when people with desk jobs go looking.\n\nWorth a 15-minute call next week?\n\nAlex Moreau\nNorthlight Bookings"
  },
  {
    "at": "2026-11-09T10:01:00.000Z",
    "step": "s2",
    "from": "outreach@northlight-mail.example",
    "subject": "",
    "body": "Hi Amira,\n\nA quick follow-up. Happy to send a two-minute video of how evening booking would look for Harbour Lane Physio.\n\nAlex"
  }
]
```

> Received on the fake test mobile:

```json
[
  {
    "at": "2026-11-09T10:00:00.000Z",
    "step": "m1",
    "from": "+447700900900",
    "subject": "",
    "body": "Hi Amira, Alex from Northlight Bookings. I emailed about evening booking at Harbour Lane Physio. OK if I call this week?"
  },
  {
    "at": "2026-11-09T10:01:00.000Z",
    "step": "m2",
    "from": "+447700900900",
    "subject": "",
    "body": "Amira, should I send the two-minute video for Harbour Lane Physio? A yes is enough."
  }
]
```

## 2026-11-09T10:03:00.000Z  GET /api/calls
→ 200
```json
[
  {
    "taskId": "att-7",
    "test": true,
    "name": "Test call",
    "campaign": "Physiotherapy, Greater London"
  }
]
```

## 2026-11-09T10:03:00.000Z  GET /api/call-tasks/att-7
→ 200
```json
{
  "numbers": [
    {
      "detailId": "test:test-att-1:mobile",
      "kind": "mobile",
      "owner": "person",
      "value": "+44 7700 900456",
      "bad": false
    }
  ],
  "declinedPath": "win_back"
}
```

## 2026-11-09T10:03:00.000Z  POST /api/call-tasks/att-7/outcome
```json
{
  "requestId": "demo-call-1",
  "outcome": "not_interested",
  "declinedPath": "win_back",
  "numberId": "test:test-att-1:mobile",
  "note": ""
}
```
→ 200
```json
"logged"
```

## 2026-11-09T10:06:00.000Z  GET /api/campaigns/id-1/test-runs
→ 200
```json
{
  "contacts": {
    "email": "alex.own@personal-mail.example",
    "mobile": "+44 7700 900456",
    "emailIsALead": false,
    "mobileIsALead": false
  },
  "noTestSinceEdit": false,
  "run": {
    "running": false,
    "ending": "finished",
    "renderAs": "Amira Hassan",
    "steps": [
      "Email track · Email 1: sent 2026-11-09T10:00:00.000Z",
      "Email track · Email 2: sent 2026-11-09T10:01:00.000Z",
      "SMS track · Text 1: sent 2026-11-09T10:00:00.000Z",
      "SMS track · Text 2: sent 2026-11-09T10:01:00.000Z",
      "Phone track · Call: logged 2026-11-09T10:03:00.000Z (not_interested)",
      "Win-back email track · Win-back email 1: sent 2026-11-09T10:03:00.000Z"
    ]
  }
}
```

> Win-back email received on the fake test email:

```json
[
  {
    "at": "2026-11-09T10:03:00.000Z",
    "step": "w1",
    "from": "outreach@northlight-mail.example",
    "subject": "One more idea for Harbour Lane Physio",
    "body": "Hi Amira,\n\nUnderstood, and thanks for your time on the phone. One idea I’ll leave with you: a booking link for evenings only.\n\nAlex"
  }
]
```

## 2026-11-09T10:06:00.000Z  PUT /api/campaigns/id-1/sequence
```json
{
  "timezone": "Europe/London",
  "callSkipLimitDays": 2,
  "emailPool": [
    "outreach@northlight-mail.example"
  ],
  "smsPool": [
    "+447700900900",
    "+447700900901"
  ],
  "callScript": "Ask for the clinic director or the practice owner.\nAsk how patients book after 18:00 today.\nIf they’re interested, offer a 20-minute walkthrough this week.",
  "tracks": [
    {
      "id": "email",
      "channel": "email",
      "branch": "main",
      "window": [
        {
          "day": 1,
          "start": 9,
          "end": 17
        },
        {
          "day": 2,
          "start": 9,
          "end": 17
        },
        {
          "day": 3,
          "start": 9,
          "end": 17
        },
        {
          "day": 4,
          "start": 9,
          "end": 17
        },
        {
          "day": 5,
          "start": 9,
          "end": 17
        }
      ],
      "steps": [
        {
          "id": "s1",
          "waitDays": 0,
          "subject": "Evening bookings for {{company}}",
          "body": "Hi {{first_name|there}},\n\nI came across {{company}} while looking at clinics in {{city|your area}}. Online booking stops at 18:00, which is when people with desk jobs go looking.\n\nWorth a 15-minute call next week?\n\nAlex Moreau\nNorthlight Bookings",
          "threading": "new_subject",
          "removed": false
        },
        {
          "id": "s2",
          "waitDays": 2,
          "subject": "",
          "body": "Hi {{first_name|there}},\n\nA quick follow-up. Happy to send a two-minute video of how evening booking would look for {{company}}.\n\nAlex",
          "threading": "continue_thread",
          "removed": false
        }
      ],
      "start": {
        "kind": "entry"
      },
      "removed": false
    },
    {
      "id": "sms",
      "channel": "sms",
      "branch": "main",
      "window": [
        {
          "day": 1,
          "start": 9,
          "end": 17
        },
        {
          "day": 2,
          "start": 9,
          "end": 17
        },
        {
          "day": 3,
          "start": 9,
          "end": 17
        },
        {
          "day": 4,
          "start": 9,
          "end": 17
        },
        {
          "day": 5,
          "start": 9,
          "end": 17
        }
      ],
      "steps": [
        {
          "id": "m1",
          "waitDays": 0,
          "subject": "",
          "body": "Hi {{first_name|there}}, Alex from Northlight Bookings. I emailed about evening booking at {{company}}. OK if I call this week?",
          "threading": "new_subject",
          "removed": false
        },
        {
          "id": "m2",
          "waitDays": 2,
          "subject": "",
          "body": "{{first_name|Hi}}, should I send the two-minute video for {{company}}? A yes is enough.",
          "threading": "continue_thread",
          "removed": false
        }
      ],
      "start": {
        "kind": "entry"
      },
      "removed": false
    },
    {
      "id": "phone",
      "channel": "call",
      "branch": "main",
      "window": [
        {
          "day": 1,
          "start": 9,
          "end": 17
        },
        {
          "day": 2,
          "start": 9,
          "end": 17
        },
        {
          "day": 3,
          "start": 9,
          "end": 17
        },
        {
          "day": 4,
          "start": 9,
          "end": 17
        },
        {
          "day": 5,
          "start": 9,
          "end": 17
        }
      ],
      "steps": [
        {
          "id": "c1",
          "waitDays": 0,
          "subject": "",
          "body": "",
          "threading": "new_subject",
          "removed": false
        }
      ],
      "start": {
        "kind": "after",
        "trackId": "email",
        "delayDays": 1
      },
      "removed": false,
      "declinedPath": "win_back"
    },
    {
      "id": "win-back",
      "channel": "email",
      "branch": "win_back",
      "window": [
        {
          "day": 1,
          "start": 9,
          "end": 17
        },
        {
          "day": 2,
          "start": 9,
          "end": 17
        },
        {
          "day": 3,
          "start": 9,
          "end": 17
        },
        {
          "day": 4,
          "start": 9,
          "end": 17
        },
        {
          "day": 5,
          "start": 9,
          "end": 17
        }
      ],
      "steps": [
        {
          "id": "w1",
          "waitDays": 0,
          "subject": "One more idea for {{company}}",
          "body": "Hi {{first_name|there}},\n\nUnderstood, and thanks for your time on the phone. One idea I’ll leave with you: a booking link for evenings only.\n\nAlex",
          "threading": "new_subject",
          "removed": false
        }
      ],
      "start": {
        "kind": "entry"
      },
      "removed": false
    }
  ]
}
```
→ 200
```json
"saved (an edit)"
```

## 2026-11-09T10:06:00.000Z  GET /api/campaigns/id-1/test-runs
→ 200
```json
{
  "contacts": {
    "email": "alex.own@personal-mail.example",
    "mobile": "+44 7700 900456",
    "emailIsALead": false,
    "mobileIsALead": false
  },
  "noTestSinceEdit": true,
  "run": {
    "running": false,
    "ending": "finished",
    "renderAs": "Amira Hassan",
    "steps": [
      "Email track · Email 1: sent 2026-11-09T10:00:00.000Z",
      "Email track · Email 2: sent 2026-11-09T10:01:00.000Z",
      "SMS track · Text 1: sent 2026-11-09T10:00:00.000Z",
      "SMS track · Text 2: sent 2026-11-09T10:01:00.000Z",
      "Phone track · Call: logged 2026-11-09T10:03:00.000Z (not_interested)",
      "Win-back email track · Win-back email 1: sent 2026-11-09T10:03:00.000Z"
    ]
  }
}
```

## 2026-11-09T10:06:00.000Z  POST /api/campaigns/id-1/test-runs
```json
{
  "requestId": "demo-run-3",
  "renderAs": "id-26",
  "expect": {
    "definitionVersion": 2
  }
}
```
→ 200
```json
{
  "contacts": {
    "email": "alex.own@personal-mail.example",
    "mobile": "+44 7700 900456",
    "emailIsALead": false,
    "mobileIsALead": false
  },
  "noTestSinceEdit": false,
  "run": {
    "running": true,
    "ending": null,
    "renderAs": "Amira Hassan",
    "steps": [
      "Email track · Email 1: sent 2026-11-09T10:06:00.000Z",
      "Email track · Email 2: due 2026-11-09T10:07:00.000Z",
      "SMS track · Text 1: sent 2026-11-09T10:06:00.000Z",
      "SMS track · Text 2: due 2026-11-09T10:07:00.000Z",
      "Phone track · Call: not_reached",
      "Win-back email track · Win-back email 1: not_reached"
    ]
  }
}
```

> The test contact replies to the test email (fake provider).

## 2026-11-09T10:08:30.000Z  GET /api/campaigns/id-1/test-runs
→ 200
```json
{
  "contacts": {
    "email": "alex.own@personal-mail.example",
    "mobile": "+44 7700 900456",
    "emailIsALead": false,
    "mobileIsALead": false
  },
  "noTestSinceEdit": false,
  "run": {
    "running": false,
    "ending": "your_reply",
    "renderAs": "Amira Hassan",
    "steps": [
      "Email track · Email 1: sent 2026-11-09T10:06:00.000Z",
      "Email track · Email 2: not_reached",
      "SMS track · Text 1: sent 2026-11-09T10:06:00.000Z",
      "SMS track · Text 2: not_reached",
      "Phone track · Call: not_reached",
      "Win-back email track · Win-back email 1: not_reached"
    ]
  }
}
```

## 2026-11-09T10:08:30.000Z  PUT /api/campaigns/id-1/sequence
```json
{
  "timezone": "Europe/London",
  "callSkipLimitDays": 2,
  "emailPool": [
    "outreach@northlight-mail.example"
  ],
  "smsPool": [
    "+447700900900",
    "+447700900901"
  ],
  "callScript": "Ask for the clinic director or the practice owner.\nAsk how patients book after 18:00 today.\nIf they’re interested, offer a 20-minute walkthrough this week.",
  "tracks": [
    {
      "id": "email",
      "channel": "email",
      "branch": "main",
      "window": [
        {
          "day": 1,
          "start": 9,
          "end": 17
        },
        {
          "day": 2,
          "start": 9,
          "end": 17
        },
        {
          "day": 3,
          "start": 9,
          "end": 17
        },
        {
          "day": 4,
          "start": 9,
          "end": 17
        },
        {
          "day": 5,
          "start": 9,
          "end": 17
        }
      ],
      "steps": [
        {
          "id": "s1",
          "waitDays": 0,
          "subject": "Evening bookings for {{company}}",
          "body": "Hi {{first_name|there}},\n\nI came across {{company}} while looking at clinics in {{city|your area}}. Online booking stops at 18:00, which is when people with desk jobs go looking.\n\nWorth a 15-minute call next week?\n\nAlex Moreau\nNorthlight Bookings",
          "threading": "new_subject",
          "removed": false
        },
        {
          "id": "s2",
          "waitDays": 2,
          "subject": "",
          "body": "Hi {{first_name|there}},\n\nA quick follow-up. Happy to send a two-minute video of how evening booking would look for {{company}}.\n\nAlex",
          "threading": "continue_thread",
          "removed": false
        }
      ],
      "start": {
        "kind": "entry"
      },
      "removed": false
    },
    {
      "id": "sms",
      "channel": "sms",
      "branch": "main",
      "window": [
        {
          "day": 1,
          "start": 9,
          "end": 17
        },
        {
          "day": 2,
          "start": 9,
          "end": 17
        },
        {
          "day": 3,
          "start": 9,
          "end": 17
        },
        {
          "day": 4,
          "start": 9,
          "end": 17
        },
        {
          "day": 5,
          "start": 9,
          "end": 17
        }
      ],
      "steps": [
        {
          "id": "m1",
          "waitDays": 0,
          "subject": "",
          "body": "Hi {{first_name|there}}, Alex from Northlight Bookings. I emailed about evening booking at {{company}}. OK if I call this week? Thanks!",
          "threading": "new_subject",
          "removed": false
        },
        {
          "id": "m2",
          "waitDays": 2,
          "subject": "",
          "body": "{{first_name|Hi}}, should I send the two-minute video for {{company}}? A yes is enough.",
          "threading": "continue_thread",
          "removed": false
        }
      ],
      "start": {
        "kind": "entry"
      },
      "removed": false
    },
    {
      "id": "phone",
      "channel": "call",
      "branch": "main",
      "window": [
        {
          "day": 1,
          "start": 9,
          "end": 17
        },
        {
          "day": 2,
          "start": 9,
          "end": 17
        },
        {
          "day": 3,
          "start": 9,
          "end": 17
        },
        {
          "day": 4,
          "start": 9,
          "end": 17
        },
        {
          "day": 5,
          "start": 9,
          "end": 17
        }
      ],
      "steps": [
        {
          "id": "c1",
          "waitDays": 0,
          "subject": "",
          "body": "",
          "threading": "new_subject",
          "removed": false
        }
      ],
      "start": {
        "kind": "after",
        "trackId": "email",
        "delayDays": 1
      },
      "removed": false,
      "declinedPath": "win_back"
    },
    {
      "id": "win-back",
      "channel": "email",
      "branch": "win_back",
      "window": [
        {
          "day": 1,
          "start": 9,
          "end": 17
        },
        {
          "day": 2,
          "start": 9,
          "end": 17
        },
        {
          "day": 3,
          "start": 9,
          "end": 17
        },
        {
          "day": 4,
          "start": 9,
          "end": 17
        },
        {
          "day": 5,
          "start": 9,
          "end": 17
        }
      ],
      "steps": [
        {
          "id": "w1",
          "waitDays": 0,
          "subject": "One more idea for {{company}}",
          "body": "Hi {{first_name|there}},\n\nUnderstood, and thanks for your time on the phone. One idea I’ll leave with you: a booking link for evenings only.\n\nAlex",
          "threading": "new_subject",
          "removed": false
        }
      ],
      "start": {
        "kind": "entry"
      },
      "removed": false
    }
  ]
}
```
→ 200
```json
"saved (an edit)"
```

## 2026-11-09T10:08:30.000Z  GET /api/campaigns/id-1/before-launch
→ 200
```json
{
  "noTestSinceEdit": true
}
```

## 2026-11-09T10:08:30.000Z  POST /api/campaigns/id-1/launch
```json
{
  "definitionVersion": 3
}
```
→ 200
```json
{
  "launchedAt": "2026-11-09T10:08:30.000Z"
}
```

