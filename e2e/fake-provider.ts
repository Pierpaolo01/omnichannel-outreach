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

export type CallsScenario = "ready" | "early" | "full" | "delayed";

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
  await harness.defineSequence(campaign, callsDefinition(scenario === "delayed" ? 2 : 0));
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
