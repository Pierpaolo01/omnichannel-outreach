import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { CampaignDefinition, StepDefinition } from "../src/domain/sequence/definition.ts";
import type { Campaign, EnrollmentView } from "../src/shared/api.ts";
import { EngineHarness } from "../test/support/engine-harness.ts";
import { business, csvOf, person } from "../test/support/export-builder.ts";
import { fixture } from "./support.ts";
import { measuresWorld, type MeasuresWorld } from "../test/support/measures-world.ts";

/**
 * The app over the fake email provider (test/support/fake-email-port.ts), for the screens that
 * need a connected inbox and sent email: the running application has no provider yet and shows
 * "no connected sender". It runs in the test worker on its own port, with the built client and a
 * clock the tests advance. Nothing here reaches a real provider; all data is fictitious.
 */
export const FAKE_INBOX = "outreach@northlight-mail.example";
/** Two simulated SMS numbers (Ofcom's drama range). The fake labels them "Simulated SMS (not a provider)". */
export const FAKE_NUMBERS = ["+447700900900", "+447700900901"] as const;

/** Monday 9 November 2026, 08:00 in London. */
const MONDAY_8 = Date.parse("2026-11-09T08:00:00Z");
const H = 3_600_000;

export interface FakeProviderApp {
  readonly url: string;
  readonly harness: EngineHarness;
  /** Campaign ids by role. */
  readonly running: string;
  readonly ready: string;
  readonly blocked: string;
  /** Record ids of people in the running campaign, by name. */
  readonly person: (name: string) => string;
  readonly company: (name: string) => string;
  readonly enrollment: (name: string) => string;
  /** A new campaign of the fixture leads with the two-email sequence, ready to launch, for a test that changes it. */
  readonly freshCampaign: (name: string) => Promise<string>;
  /**
   * Ticket 13b. A running campaign on both channels: an email track and an SMS track together, and a
   * second email track a day after the SMS track. Priya texts back; Ben's number is reported
   * invalid after his first text; Lena has no mobile; Kai has no email; Owen runs the whole sequence.
   */
  readonly twoChannels: string;
  /** The same sequence, not launched, for Before launch on both channels. */
  readonly twoChannelsReady: string;
  /** Record ids of the two-channel campaigns' people, by name. */
  readonly smsPerson: (name: string) => string;
  /** A new campaign of the two-channel campaigns' people, with no sequence yet, for a test that builds one. */
  readonly freshTwoChannelCampaign: (name: string) => Promise<string>;
}

/** Ticket 13b's two-channel sequence: email and SMS together, then a second email track a day after the texts. */
export const TWO_CHANNELS: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: [FAKE_INBOX],
  smsPool: [...FAKE_NUMBERS],
  tracks: [
    {
      id: "email",
      channel: "email",
      branch: "main",
      window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })),
      start: { kind: "entry" },
      removed: false,
      steps: [
        step("s1", { subject: "Evening bookings at {{company}}", body: "Hi {{first_name|there}},\n\nOnline booking at {{company}} stops at 18:00, which is when people with desk jobs go looking.\n\nWorth a 15-minute call next week?\n\nAlex Moreau\nNorthlight Bookings", threading: "new_subject" }),
        step("s2", { waitDays: 2, body: "Hi {{first_name|there}},\n\nA quick follow-up. Happy to send a two-minute video of how evening booking would look for {{company}}.\n\nAlex" }),
      ],
    },
    {
      id: "sms",
      channel: "sms",
      branch: "main",
      window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 10, end: 18 })),
      start: { kind: "entry" },
      removed: false,
      steps: [
        step("m1", { body: "Hi {{first_name|there}}, Alex from Northlight Bookings. I emailed about evening booking at {{company}}. OK if I call this week?", threading: "new_subject" }),
        step("m2", { waitDays: 2, body: "{{first_name|Hi}}, should I send the two-minute video for {{company}}? A yes is enough.", threading: "new_subject" }),
      ],
    },
    {
      id: "email-2",
      channel: "email",
      branch: "main",
      window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })),
      start: { kind: "after", trackId: "sms", delayDays: 1 },
      removed: false,
      steps: [step("e1", { subject: "One more idea for {{company}}", body: "Hi {{first_name|there}},\n\nOne last note: clinics like {{company}} usually see evening bookings within a week.\n\nAlex", threading: "new_subject" })],
    },
  ],
};

/** Fictitious clinics and people for the two-channel campaigns. */
const RIVERSIDE = {
  businesses: [
    business({ business_id: "bz-riverside-dental-0001", business_name: "Riverside Dental", city: "Bristol", phone_e164: "+441174960101", phone_original: "0117 496 0101" }),
    business({ business_id: "bz-quayside-physio-0002", business_name: "Quayside Physio", city: "Bristol" }),
    business({ business_id: "bz-hillside-osteo-0003", business_name: "Hillside Osteopathy", city: "Bath" }),
  ],
  people: [
    person({ person_id: "pp-priya", business_id: "bz-riverside-dental-0001", full_name: "Priya Shah", title: "Practice owner", email: "priya@riversidedental.example", dial_phone: "+447700900311", dial_phone_type: "mobile" }),
    person({ person_id: "pp-owen", business_id: "bz-riverside-dental-0001", full_name: "Owen Hale", title: "Clinical director", email: "owen@riversidedental.example", dial_phone: "+447700900322", dial_phone_type: "mobile" }),
    person({ person_id: "pp-lena", business_id: "bz-quayside-physio-0002", full_name: "Lena Ford", title: "Owner", email: "lena@quaysidephysio.example" }),
    person({ person_id: "pp-ben", business_id: "bz-quayside-physio-0002", full_name: "Ben Cole", title: "Practice manager", email: "ben@quaysidephysio.example", dial_phone: "+447700900344", dial_phone_type: "mobile" }),
    person({ person_id: "pp-kai", business_id: "bz-hillside-osteo-0003", full_name: "Kai Moss", title: "Owner", dial_phone: "+447700900355", dial_phone_type: "mobile" }),
  ],
};
const HILLSIDE = {
  businesses: [
    business({ business_id: "bz-northbank-dental-0011", business_name: "Northbank Dental", city: "Leeds", general_emails: "hello@northbankdental.example" }),
    business({ business_id: "bz-elmway-physio-0012", business_name: "Elmway Physio", city: "Leeds" }),
  ],
  people: [
    person({ person_id: "pp-nadia", business_id: "bz-elmway-physio-0012", full_name: "Nadia Wells", title: "Owner", email: "nadia@elmwayphysio.example", dial_phone: "+447700900411", dial_phone_type: "mobile" }),
    person({ person_id: "pp-ravi", business_id: "bz-elmway-physio-0012", full_name: "Ravi Patel", title: "Clinic lead", dial_phone: "+447700900422", dial_phone_type: "mobile" }),
    person({ person_id: "pp-hugo", business_id: "bz-elmway-physio-0012", full_name: "Hugo Grant", title: "Practice manager", email: "hugo@elmwayphysio.example" }),
  ],
};

function step(id: string, fields: Partial<StepDefinition>): StepDefinition {
  return { id, waitDays: 0, subject: "", body: "", threading: "continue_thread", removed: false, ...fields };
}

export const COPY = {
  first: step("s1", {
    subject: "Evening bookings at {{company}}",
    body: "Hi {{first_name|there}},\n\nI came across {{company}} while looking at clinics in {{city|your area}}. Online booking stops at 18:00, which is when people with desk jobs go looking.\n\nWorth a 15-minute call next week?\n\nAlex Moreau\nNorthlight Bookings",
    threading: "new_subject",
  }),
  second: step("s2", { waitDays: 2, body: "Hi {{first_name|there}},\n\nA quick follow-up. Happy to send a two-minute video of how evening booking would look for {{company}}.\n\nAlex" }),
};

const definition = (steps: StepDefinition[]): CampaignDefinition => ({
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: [FAKE_INBOX],
  tracks: [{ id: "email", channel: "email", branch: "main", window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })), steps, start: { kind: "entry" }, removed: false }],
});

const started = new Map<string, Promise<FakeProviderApp>>();

/**
 * One app per name and test worker, seeded once. The scans share "shared" and change nothing in
 * it; a test that sends, bounces or replies takes its own, because a bounce marks an address bad
 * in the CRM for every campaign.
 */
export function fakeProviderApp(name = "shared"): Promise<FakeProviderApp> {
  let app = started.get(name);
  if (!app) started.set(name, (app = start()));
  return app;
}

async function start(): Promise<FakeProviderApp> {
  const harness = new EngineHarness({
    start: MONDAY_8,
    accounts: [{ id: FAKE_INBOX, capacity: 30, gapMs: 60_000, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    sms: { numbers: FAKE_NUMBERS.map((id) => ({ id, capacity: 40, gapMs: 60_000, k: 1, healthy: true, resetZone: "Europe/London" })) },
  });
  const csv = { businessesCsv: readFileSync(fixture("businesses-run1.csv"), "utf8"), peopleCsv: readFileSync(fixture("people-run1.csv"), "utf8") };
  const create = async (name: string) => (await harness.request<{ campaign: Campaign }>("POST", "/api/campaigns", { name, defaultTimezone: "Europe/London", ...csv })).body.campaign.id;

  const running = await create("Physio clinics, Bristol");
  const ready = await create("Chiropractors, Bath");
  const blocked = await create("Osteopaths, Cardiff");
  await harness.tick();
  await harness.defineSequence(running, definition([COPY.first, COPY.second]));
  await harness.defineSequence(ready, definition([COPY.first, COPY.second]));
  await harness.defineSequence(blocked, definition([{ ...COPY.first, body: "Hi {{first_name}}, a note for {{company}}." }, step("s2", { waitDays: 3 })]));

  // Tom's address hard-bounces; Daniel replies to his first email.
  harness.fake.bouncing.add("tom@harbourlanephysio.example");
  harness.clock = MONDAY_8 + H;
  await harness.launch(running);
  await harness.advanceTo(MONDAY_8 + 4 * H);
  harness.fake.prospectReplies("daniel@elmstreetchiro.example");
  await harness.advanceTo(MONDAY_8 + 4 * 24 * H);

  // Ticket 13b: both channels. Created after the email-only story, so that story's instants are unchanged.
  const createRows = async (name: string, rows: Parameters<typeof csvOf>[0]) => (await harness.request<{ campaign: Campaign }>("POST", "/api/campaigns", { name, defaultTimezone: "Europe/London", ...csvOf(rows) })).body.campaign.id;
  const twoChannels = await createRows("Dental clinics, Bristol", RIVERSIDE);
  const twoChannelsReady = await createRows("Physio clinics, Leeds", HILLSIDE);
  await harness.tick();
  await harness.defineSequence(twoChannels, TWO_CHANNELS);
  await harness.defineSequence(twoChannelsReady, TWO_CHANNELS);
  harness.sms.invalidAfterSend.add("+447700900344");
  const launchedAt = harness.clock;
  await harness.launch(twoChannels);
  // Priya texts back after her first text, that afternoon (the texts go from 10:00).
  await harness.advanceTo(launchedAt + 6 * H);
  harness.sms.prospectTexts("+447700900311", "STOP");
  // A week on, the same weekday morning: the sequence has finished, and a story that launches next
  // starts on a weekday, as the email story's tests expect.
  await harness.advanceTo(launchedAt + 7 * 24 * H);
  const smsRows = (await harness.request<{ rows: { id: string; name: string }[] }>("GET", `/api/leads?campaign=${twoChannels}&limit=500`)).body.rows;

  const rows = (await harness.request<{ rows: { kind: string; id: string; name: string; enrollments: EnrollmentView[] }[] }>("GET", `/api/leads?campaign=${running}&limit=500`)).body.rows;
  const row = (name: string) => {
    const found = rows.find((r) => r.name === name);
    if (!found) throw new Error(`no lead named ${name}`);
    return found;
  };

  const url = await serveHarness(harness);

  return {
    url,
    harness,
    running,
    ready,
    blocked,
    person: (name) => row(name).id,
    company: (name) => row(name).id,
    enrollment: (name) => row(name).enrollments.find((e) => e.campaign.id === running)?.id ?? "",
    twoChannels,
    twoChannelsReady,
    smsPerson: (name) => smsRows.find((r) => r.name === name)?.id ?? "",
    freshTwoChannelCampaign: (name) => createRows(name, RIVERSIDE),
    freshCampaign: async (name) => {
      const id = await create(name);
      await harness.defineSequence(id, definition([COPY.first, COPY.second]));
      return id;
    },
  };
}

/** Serves the harness's HTTP app with the built client, on a port of its own. */
async function serveHarness(harness: EngineHarness): Promise<string> {
  const web = new Hono();
  web.all("/api/*", (c) => harness.fetch(c.req.raw));
  web.use("/assets/*", serveStatic({ root: "dist" }));
  web.get("*", serveStatic({ root: "dist", path: "index.html" }));
  return new Promise<string>((resolve) => {
    const server = serve({ fetch: web.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => resolve(`http://127.0.0.1:${info.port}`));
    server.unref();
  });
}

// ---------------------------------------------------------------------------------------------
// Calls (ticket 14b). A campaign with a phone track beside the email track, and an email after
// the call, defined over HTTP: the canvas has no phone track editor yet (a later part). Nothing is
// dialled; the user dials on their own phone, and the app only lists calls and records outcomes.

export const CALL_SCRIPT = "Ask for the clinic director or the practice owner.\nAsk how patients book after 18:00 today.\nIf they’re interested, offer a 20-minute walkthrough this week.";

const WEEKDAYS_9_TO_17 = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));

/** `afterCallDelayDays`: how long the email after the call waits once the phone track has ended (ticket 15b's `delayed` scenario: 2). */
export const callsDefinition = (afterCallDelayDays = 0): CampaignDefinition => ({
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: [FAKE_INBOX],
  smsPool: [],
  callScript: CALL_SCRIPT,
  tracks: [
    { id: "email", channel: "email", branch: "main", window: WEEKDAYS_9_TO_17, steps: [COPY.first, COPY.second], start: { kind: "entry" }, removed: false },
    { id: "phone", channel: "call", branch: "main", window: WEEKDAYS_9_TO_17, steps: [step("c1", { threading: "new_subject" })], start: { kind: "entry" }, removed: false },
    {
      id: "after-call",
      channel: "email",
      branch: "main",
      window: WEEKDAYS_9_TO_17,
      steps: [step("a1", { subject: "Following up on my call", body: "Hi {{first_name|there}},\n\nThanks for picking up earlier. Here is the two-minute video I mentioned for {{company}}.\n\nAlex", threading: "new_subject" })],
      start: { kind: "after", trackId: "phone", delayDays: afterCallDelayDays },
      removed: false,
    },
  ],
});

export type CallsScenario = "ready" | "early" | "full" | "delayed" | "after-skip" | "win-back" | "continue";

/**
 * Ticket 16c's scenarios: `win-back`, the phone track set to win back, with a win-back branch of two emails two days
 * apart; `continue`, the phone track set to continue on the other channels, with no win-back branch. (`ready` has no
 * path set and no branch: a declined call stops the lead, question Q14.)
 */
export const declinedDefinition = (path: "win_back" | "continue"): CampaignDefinition => {
  const base = callsDefinition(1);
  return {
    ...base,
    tracks: [
      ...base.tracks.map((t) => (t.channel === "call" ? { ...t, declinedPath: path } : t)),
      ...(path === "win_back"
        ? [
            {
              id: "win-back",
              channel: "email" as const,
              branch: "win_back" as const,
              window: WEEKDAYS_9_TO_17,
              steps: [
                step("w1", { subject: "One more idea for {{company}}", body: "Hi {{first_name|there}},\n\nUnderstood, and thanks for your time on the phone. One idea I’ll leave with you: a booking link for evenings only.\n\nAlex", threading: "new_subject" }),
                step("w2", { waitDays: 2, body: "Hi {{first_name|there}},\n\nLast note from me. If evenings ever get busy at {{company}}, the offer stands.\n\nAlex" }),
              ],
              start: { kind: "entry" as const },
              removed: false,
            },
          ]
        : []),
    ],
  };
};

/**
 * The verifier's reproduction on 2027f24 (`after-skip`): two phone tracks with skip limits 2 and 8, the email after the
 * first phone track three days after it ends, and a win-back branch.
 */
export const afterSkipDefinition = (): CampaignDefinition => {
  const base = callsDefinition(3);
  const [email, phone, afterCall] = base.tracks;
  if (!email || !phone || !afterCall) throw new Error("the calls definition changed");
  return {
    ...base,
    tracks: [
      email,
      { ...phone, callSkipLimitDays: 2 },
      { ...phone, id: "phone2", steps: [step("c2", { threading: "new_subject" })], callSkipLimitDays: 8 },
      afterCall,
      { id: "win-back", channel: "email", branch: "win_back", window: WEEKDAYS_9_TO_17, steps: [step("w1", { subject: "One more idea", body: "Hi {{first_name|there}},\n\nOne more idea for {{company}}.\n\nAlex", threading: "new_subject" })], start: { kind: "entry" }, removed: false },
    ],
  };
};

export interface FakeCallsApp {
  readonly url: string;
  readonly harness: EngineHarness;
  readonly campaign: string;
  readonly person: (name: string) => string;
  readonly company: (name: string) => string;
}

const callsStarted = new Map<string, Promise<FakeCallsApp>>();

/**
 * One calls app per name and test worker. `ready`: Monday 10:00 London, calls ready now. `early`:
 * Monday 07:30, the calls wait for their calling hours. `full`: a daily call capacity of 2, used. `delayed`: as `ready`, with the email after the call two days after the phone track ends.
 * The scans share each scenario's app and change nothing in it; a test that logs takes its own name.
 */
export function fakeCallsApp(scenario: CallsScenario, name: string = scenario): Promise<FakeCallsApp> {
  let app = callsStarted.get(name);
  if (!app) callsStarted.set(name, (app = startCalls(scenario)));
  return app;
}

async function startCalls(scenario: CallsScenario): Promise<FakeCallsApp> {
  const harness = new EngineHarness({
    start: MONDAY_8 - 2 * H,
    accounts: [{ id: FAKE_INBOX, capacity: 30, gapMs: 60_000, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
  });
  await harness.tick();
  await harness.request("PUT", "/api/call-settings", { dailyCapacity: scenario === "full" ? 2 : 20, userZone: "Europe/London" });
  const csv = { businessesCsv: readFileSync(fixture("businesses-run1.csv"), "utf8"), peopleCsv: readFileSync(fixture("people-run1.csv"), "utf8") };
  const campaign = (await harness.request<{ campaign: Campaign }>("POST", "/api/campaigns", { name: "Clinics, London", defaultTimezone: "Europe/London", ...csv })).body.campaign.id;
  await harness.tick();
  await harness.defineSequence(campaign, scenario === "after-skip" ? afterSkipDefinition() : scenario === "win-back" ? declinedDefinition("win_back") : scenario === "continue" ? declinedDefinition("continue") : callsDefinition(scenario === "delayed" ? 2 : 0));
  harness.clock = MONDAY_8 - H;
  const launched = await harness.launch(campaign);
  if (launched.status !== 200) throw new Error(`the calls campaign did not launch: ${JSON.stringify(launched.body)}`);
  await harness.advanceTo(scenario === "early" ? MONDAY_8 - 30 * 60_000 : MONDAY_8 + 2 * H);

  const rows = (await harness.request<{ rows: { kind: string; id: string; name: string }[] }>("GET", "/api/leads?limit=500")).body.rows;
  const row = (name: string) => {
    const found = rows.find((r) => r.name === name);
    if (!found) throw new Error(`no lead named ${name}`);
    return found;
  };
  return { url: await serveHarness(harness), harness, campaign, person: (n) => row(n).id, company: (n) => row(n).id };
}

// ---------------------------------------------------------------------------------------------
// Ticket 18: lead search, bulk actions and the person page, with fictitious data. Amira Hassan is in two launched
// campaigns and one not launched; a re-import marks her newer email; her direct line is marked wrong; her colleague
// Tom's call left a note, saved as a company note. `many`: a further 120 fictitious people, for a long search.

export interface FakePeopleApp extends FakeCallsApp {
  readonly campaigns: { readonly clinics: string; readonly followUp: string; readonly draft: string };
}

const peopleStarted = new Map<string, Promise<FakePeopleApp>>();

export function fakePeopleApp(name = "people", options: { many?: boolean } = {}): Promise<FakePeopleApp> {
  let app = peopleStarted.get(name);
  if (!app) peopleStarted.set(name, (app = startPeople(options.many ?? false)));
  return app;
}

async function startPeople(many: boolean): Promise<FakePeopleApp> {
  const harness = new EngineHarness({
    start: MONDAY_8 - 2 * H,
    accounts: [{ id: FAKE_INBOX, capacity: 200, gapMs: 60_000, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
  });
  await harness.tick();
  await harness.request("PUT", "/api/call-settings", { dailyCapacity: 40, userZone: "Europe/London" });
  const run1 = { businessesCsv: readFileSync(fixture("businesses-run1.csv"), "utf8"), peopleCsv: readFileSync(fixture("people-run1.csv"), "utf8") };
  const run2 = { businessesCsv: readFileSync(fixture("businesses-run2.csv"), "utf8"), peopleCsv: readFileSync(fixture("people-run2.csv"), "utf8") };
  const create = async (campaignName: string) => (await harness.request<{ campaign: Campaign }>("POST", "/api/campaigns", { name: campaignName, defaultTimezone: "Europe/London", ...run1 })).body.campaign.id;
  const clinics = await create("Clinics, London");
  const followUp = await create("Physio follow-up");
  const draft = await create("Spring outreach");
  // A later export, a few minutes on: its new details are marked newer.
  harness.clock += 10 * 60_000;
  await harness.request("POST", `/api/campaigns/${clinics}/imports`, run2);
  await harness.defineSequence(clinics, callsDefinition());
  await harness.defineSequence(followUp, callsDefinition(1));
  await harness.defineSequence(draft, callsDefinition());
  if (many) {
    const businesses = Array.from({ length: 40 }, (_, i) => business({ business_id: `bz-wide-${i}`, business_name: `Wider Clinic ${String(i + 1).padStart(2, "0")}`, phone_e164: `+4420794610${String(i).padStart(2, "0")}` }));
    const people = Array.from({ length: 120 }, (_, i) =>
      person({ person_id: `pp-wide-${i}`, business_id: `bz-wide-${i % 40}`, full_name: `Sample Person ${String(i + 1).padStart(3, "0")}`, email: `person${i + 1}@widerclinic${i % 40}.example` }),
    );
    await harness.request("POST", "/api/campaigns", { name: "Wider list", defaultTimezone: "Europe/London", ...csvOf({ businesses, people }) });
  }
  harness.clock = MONDAY_8 - H;
  for (const id of [clinics, followUp]) {
    const launched = await harness.launch(id);
    if (launched.status !== 200) throw new Error(`the people campaign did not launch: ${JSON.stringify(launched.body)}`);
  }
  await harness.advanceTo(MONDAY_8 + 2 * H);

  const rows = (await harness.request<{ rows: { kind: string; id: string; name: string; enrollments: EnrollmentView[] }[] }>("GET", "/api/leads?limit=500")).body.rows;
  const row = (rowName: string) => {
    const found = rows.find((r) => r.name === rowName);
    if (!found) throw new Error(`no lead named ${rowName}`);
    return found;
  };
  // Amira's direct line is marked wrong (as a wrong-number call would).
  const amira = (await harness.request<{ contactDetails: { id: string; phoneKind: string | null; owner: string }[] }>("GET", `/api/people/${row("Amira Hassan").id}`)).body;
  const direct = amira.contactDetails.find((d) => d.owner === "person" && d.phoneKind !== null);
  if (direct) await harness.store.markContactDetailBad(direct.id);
  // Tom's call in Clinics, London: no answer, its note saved for everyone at Harbour Lane Physio.
  const queue = (await harness.request<{ readyNow: { taskId: string; person: { name: string } | null; campaign: { id: string } }[] }>("GET", "/api/calls")).body.readyNow;
  const tomCall = queue.find((q) => q.person?.name === "Tom" && q.campaign.id === clinics);
  if (tomCall) {
    const task = (await harness.request<{ numbers: { detailId: string; bad: boolean }[] }>("GET", `/api/call-tasks/${tomCall.taskId}`)).body;
    await harness.request("POST", `/api/call-tasks/${tomCall.taskId}/outcome`, {
      requestId: "people-tom-call",
      outcome: "no_answer",
      numberId: task.numbers.find((n) => !n.bad)?.detailId ?? null,
      note: "Front desk says the director decides on software. Best before 10:00.",
      noteScope: "company",
    });
  }
  await harness.advanceTo(harness.clock + 5 * 60_000);
  return { url: await serveHarness(harness), harness, campaign: clinics, campaigns: { clinics, followUp, draft }, person: (n) => row(n).id, company: (n) => row(n).id };
}

// ---------------------------------------------------------------------------------------------
// Ticket 20's demonstration (ticket 20b), as src/server/engine/interruption-demo.test.ts runs it: two campaigns sharing
// one inbox of capacity 4 a day and two simulated SMS numbers, each with email, SMS and a phone track, three leads each,
// one lead paused; then the application stops, and starts again. Nothing reaches a real provider; data is fictitious.

export type InterruptionScenario = "same-day" | "across-days";

export interface FakeInterruptionApp {
  readonly url: string;
  readonly harness: EngineHarness;
  /** The instants the application stopped and started again. */
  readonly stoppedAt: number;
  readonly startedAt: number;
}

const interruptionStarted = new Map<string, Promise<FakeInterruptionApp>>();

/** `same-day`: stopped Monday 12:00 to 15:00 London. `across-days`: stopped Monday 12:00 to Wednesday 12:00, then an hour running. */
export function fakeInterruptionApp(scenario: InterruptionScenario, name: string = scenario): Promise<FakeInterruptionApp> {
  let app = interruptionStarted.get(name);
  if (!app) interruptionStarted.set(name, (app = startInterruption(scenario)));
  return app;
}

async function startInterruption(scenario: InterruptionScenario): Promise<FakeInterruptionApp> {
  const MIN = 60_000;
  const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
  const WEEKDAYS = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
  const harness = new EngineHarness({
    start: MONDAY_8 + H,
    accounts: [{ id: FAKE_INBOX, capacity: 4, gapMs: 5 * MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    sms: { numbers: FAKE_NUMBERS.map((id) => ({ id, capacity: 50, gapMs: 5 * MIN, k: 2, healthy: true, resetZone: "Europe/London" })) },
  });
  await harness.tick();
  await harness.request("PUT", "/api/call-settings", { dailyCapacity: 10, userZone: "Europe/London" });
  const harbour = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101", city: "London" });
  const people = [
    person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbourlane.example", dial_phone: "+447700900101", dial_phone_type: "mobile" }),
    person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", email: "nia@harbourlane.example", dial_phone: "+447700900102", dial_phone_type: "mobile" }),
    person({ person_id: "p3", business_id: "b1", full_name: "Sam Reed", email: "sam@harbourlane.example" }),
  ];
  const email = (id: string, waitDays = 0): StepDefinition => ({ id, waitDays, subject: `A note for {{company}} ${id}`, body: `Hi {{first_name}}, a short note for {{company}} (${id}).`, threading: "new_subject", removed: false });
  const text = (id: string, waitDays = 0): StepDefinition => ({ ...email(id, waitDays), subject: "" });
  const def = (sms: string): CampaignDefinition => ({
    timezone: "Europe/London",
    callSkipLimitDays: 3,
    emailPool: [FAKE_INBOX],
    smsPool: [sms],
    callScript: CALL_SCRIPT,
    tracks: [
      { id: "e1", channel: "email", branch: "main", window: ALWAYS, steps: [email("s1"), email("s2", 1)], start: { kind: "entry" }, removed: false },
      { id: "x1", channel: "sms", branch: "main", window: ALWAYS, steps: [text("t1"), text("t2", 1)], start: { kind: "entry" }, removed: false },
      { id: "p1", channel: "call", branch: "main", window: WEEKDAYS, steps: [{ ...email("c1"), subject: "", body: "" }], start: { kind: "entry" }, removed: false },
    ],
  });
  const ids: string[] = [];
  for (const [name, sms] of [["Clinics, London", FAKE_NUMBERS[0]], ["Physios, London", FAKE_NUMBERS[1]]] as const) {
    const id = (await harness.request<{ campaign: Campaign }>("POST", "/api/campaigns", { name, defaultTimezone: "Europe/London", ...csvOf({ businesses: [harbour], people }) })).body.campaign.id;
    await harness.defineSequence(id, def(sms));
    const launched = await harness.launch(id);
    if (launched.status !== 200) throw new Error(`the demonstration campaign did not launch: ${JSON.stringify(launched.body)}`);
    ids.push(id);
  }
  await harness.advanceTo(MONDAY_8 + 4 * H);
  // Nia is paused in the first campaign before the stop.
  const rows = (await harness.request<{ rows: { name: string; enrollments: EnrollmentView[] }[] }>("GET", `/api/leads?campaign=${ids[0]}`)).body.rows;
  const nia = rows.find((r) => r.name === "Nia Cole")?.enrollments.find((e) => e.campaign.id === ids[0])?.id ?? "";
  const paused = await harness.request("POST", `/api/enrollments/${nia}/controls`, { requestId: "demo-pause", action: "pause" });
  if (paused.status !== 200) throw new Error(`pausing failed: ${JSON.stringify(paused.body)}`);
  const stoppedAt = harness.clock;
  await harness.stopFor(scenario === "same-day" ? 3 * H : 48 * H);
  const startedAt = harness.clock;
  // Running again for an hour: the rescheduled sends go, spread by pacing, until the shared inbox is full for the day.
  if (scenario === "across-days") await harness.advanceTo(startedAt + H);
  return { url: await serveHarness(harness), harness, stoppedAt, startedAt };
}

// ---------------------------------------------------------------------------------------------
// The verifier's focus case on PR 58 (ticket 20b): one inbox of capacity 1 a day, an email-only campaign with two leads,
// so the second waits for capacity until the inbox resets at midnight UTC. No call tasks. Data is fictitious.

export interface FakeCapacityApp {
  readonly url: string;
  readonly harness: EngineHarness;
}

const capacityStarted = new Map<string, Promise<FakeCapacityApp>>();

/** Monday 9 November 2026 09:10 UTC: one lead's email went, the other's waits for the inbox's capacity. One app per name. */
export function fakeCapacityApp(name: string): Promise<FakeCapacityApp> {
  let app = capacityStarted.get(name);
  if (!app) capacityStarted.set(name, (app = startCapacity()));
  return app;
}

async function startCapacity(): Promise<FakeCapacityApp> {
  const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
  const harness = new EngineHarness({ start: MONDAY_8 + H, accounts: [{ id: FAKE_INBOX, capacity: 1, gapMs: 60_000, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
  await harness.tick();
  await harness.request("PUT", "/api/call-settings", { dailyCapacity: 10, userZone: "Europe/London" });
  const harbour = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });
  const people = [
    person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbourlane.example" }),
    person({ person_id: "p2", business_id: "b1", full_name: "Sam Reed", email: "sam@harbourlane.example" }),
  ];
  const id = (await harness.request<{ campaign: Campaign }>("POST", "/api/campaigns", { name: "Clinics, London", defaultTimezone: "Europe/London", ...csvOf({ businesses: [harbour], people }) })).body.campaign.id;
  await harness.defineSequence(id, {
    timezone: "Europe/London",
    callSkipLimitDays: 3,
    emailPool: [FAKE_INBOX],
    smsPool: [],
    callScript: "",
    tracks: [{ id: "e1", channel: "email", branch: "main", window: ALWAYS, steps: [{ id: "s1", waitDays: 0, subject: "A note for {{company}}", body: "Hi {{first_name}}, a short note for {{company}}.", threading: "new_subject", removed: false }], start: { kind: "entry" }, removed: false }],
  });
  const launched = await harness.launch(id);
  if (launched.status !== 200) throw new Error(`the capacity campaign did not launch: ${JSON.stringify(launched.body)}`);
  await harness.advanceTo(MONDAY_8 + H + 10 * 60_000);
  return { url: await serveHarness(harness), harness };
}

// ---------------------------------------------------------------------------------------------
// Ticket 21: test runs. A campaign not launched, with two emails and two texts together, a phone track a day after the
// emails whose declined path is win back, and a win-back email; the fixture leads; one inbox and two simulated SMS
// numbers. The user's own test contacts are fictitious: a reserved example domain and a drama-range mobile.

export const OWN_TEST_EMAIL = "alex.own@personal-mail.example";
export const OWN_TEST_MOBILE = "+447700900456";

export const testRunDefinition = (): CampaignDefinition => ({
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: [FAKE_INBOX],
  smsPool: [...FAKE_NUMBERS],
  callScript: CALL_SCRIPT,
  tracks: [
    { id: "email", channel: "email", branch: "main", window: WEEKDAYS_9_TO_17, steps: [COPY.first, COPY.second], start: { kind: "entry" }, removed: false },
    {
      id: "sms",
      channel: "sms",
      branch: "main",
      window: WEEKDAYS_9_TO_17,
      steps: [
        step("m1", { body: "Hi {{first_name|there}}, Alex from Northlight Bookings. I emailed about evening booking at {{company}}. OK if I call this week?", threading: "new_subject" }),
        step("m2", { waitDays: 2, body: "{{first_name|Hi}}, should I send the two-minute video for {{company}}? A yes is enough." }),
      ],
      start: { kind: "entry" },
      removed: false,
    },
    { id: "phone", channel: "call", branch: "main", window: WEEKDAYS_9_TO_17, steps: [step("c1", { threading: "new_subject" })], start: { kind: "after", trackId: "email", delayDays: 1 }, removed: false, declinedPath: "win_back" },
    {
      id: "win-back",
      channel: "email",
      branch: "win_back",
      window: WEEKDAYS_9_TO_17,
      steps: [step("w1", { subject: "One more idea for {{company}}", body: "Hi {{first_name|there}},\n\nUnderstood, and thanks for your time on the phone. One idea I’ll leave with you: a booking link for evenings only.\n\nAlex", threading: "new_subject" })],
      start: { kind: "entry" },
      removed: false,
    },
  ],
});

export interface FakeTestRunApp {
  readonly url: string;
  readonly harness: EngineHarness;
  readonly campaign: string;
}

const testRunsStarted = new Map<string, Promise<FakeTestRunApp>>();

/** One test-run app per name and test worker: Monday 10:00 London, the campaign not launched. */
export function fakeTestRunApp(name: string): Promise<FakeTestRunApp> {
  let app = testRunsStarted.get(name);
  if (!app) testRunsStarted.set(name, (app = startTestRuns()));
  return app;
}

async function startTestRuns(): Promise<FakeTestRunApp> {
  const harness = new EngineHarness({
    start: MONDAY_8 + 2 * H,
    accounts: [{ id: FAKE_INBOX, capacity: 30, gapMs: 60_000, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    sms: { numbers: FAKE_NUMBERS.map((id) => ({ id, capacity: 40, gapMs: 60_000, k: 1, healthy: true, resetZone: "Europe/London" })) },
  });
  await harness.tick();
  await harness.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" });
  const csv = { businessesCsv: readFileSync(fixture("businesses-run1.csv"), "utf8"), peopleCsv: readFileSync(fixture("people-run1.csv"), "utf8") };
  const campaign = (await harness.request<{ campaign: Campaign }>("POST", "/api/campaigns", { name: "Physiotherapy, Greater London", defaultTimezone: "Europe/London", ...csv })).body.campaign.id;
  await harness.tick();
  await harness.defineSequence(campaign, testRunDefinition());
  return { url: await serveHarness(harness), harness, campaign };
}

// ---------------------------------------------------------------------------------------------
// Ticket 22: the campaign measures, on the world of test/support/measures-world.ts (four fictitious people at Harbour
// Lane Physio; an email track of two steps, a text and a call, all at launch, weekdays 09:00 to 17:00), launched on Monday
// 2 November at 07:00 London. `early`: launched, nothing sent yet.
// `running`: 09:15, Nia's email bounced, Sam's address refused, Ivo's mobile reported invalid after his text, Pat
// replied by email, Nia's call reached a gatekeeper, and Ivo asked for a callback. `paused`: the same, then paused.
// `with-test`: the same as running, then a test run to the user's own contacts (ticket 21), five minutes on.

export type MeasuresScenario = "early" | "running" | "paused" | "with-test";
export interface FakeMeasuresApp {
  readonly url: string;
  readonly world: MeasuresWorld;
}
const measuresStarted = new Map<string, Promise<FakeMeasuresApp>>();

export function fakeMeasuresApp(scenario: MeasuresScenario, name: string = scenario): Promise<FakeMeasuresApp> {
  let app = measuresStarted.get(name);
  if (!app) measuresStarted.set(name, (app = startMeasures(scenario)));
  return app;
}

async function startMeasures(scenario: MeasuresScenario): Promise<FakeMeasuresApp> {
  const world = await measuresWorld((h) => {
    h.fake.bouncing.add("nia@harbour.example");
    h.fake.invalid.add("sam@harbour.example");
    h.sms.invalidAfterSend.add("+447700900104");
  }, { start: Date.parse("2026-11-02T07:00:00Z"), weekdayHours: true });
  const launched = await world.h.launch(world.campaignId);
  if (launched.status !== 200) throw new Error(`the measures campaign did not launch: ${JSON.stringify(launched.body)}`);
  if (scenario !== "early") {
    await world.h.advanceTo(world.h.clock + 2 * H + 15 * 60_000);
    world.h.fake.prospectReplies("pat@harbour.example");
    await world.h.advanceTo(world.h.clock + 10 * 60_000);
    if ((await world.log("Nia Cole", "gatekeeper")) !== 200) throw new Error("the gatekeeper call was refused");
    if ((await world.log("Ivo Marsh", "callback_requested", { callbackAt: new Date(world.h.clock + 4 * H).toISOString() })) !== 200) throw new Error("the callback was refused");
  }
  if (scenario === "with-test") {
    // A test run to the user's own (fictitious) contacts, rendering as Pat: its sends count, said as from test runs.
    const contacts = await world.h.request("PUT", `/api/campaigns/${world.campaignId}/test-contacts`, { email: OWN_TEST_EMAIL, mobile: OWN_TEST_MOBILE });
    if (contacts.status !== 200) throw new Error(`the test contacts were refused: ${JSON.stringify(contacts.body)}`);
    const tab = (await world.h.request<{ definitionVersion: number }>("GET", `/api/campaigns/${world.campaignId}/test-runs`)).body;
    const run = await world.h.request("POST", `/api/campaigns/${world.campaignId}/test-runs`, { requestId: "measures-with-test", renderAs: world.lead("Pat Oneil"), expect: { definitionVersion: tab.definitionVersion } });
    if (run.status !== 200) throw new Error(`the test run was refused: ${JSON.stringify(run.body)}`);
    await world.h.advanceTo(world.h.clock + 5 * 60_000);
  }
  if (scenario === "paused") {
    const out = await world.h.request("POST", `/api/campaigns/${world.campaignId}/pause`, { requestId: "measures-paused" });
    if (out.status !== 200) throw new Error(`the campaign did not pause: ${JSON.stringify(out.body)}`);
  }
  return { url: await serveHarness(world.h), world };
}
