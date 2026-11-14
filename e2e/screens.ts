import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { OUTREACH_STATUSES } from "../src/domain/outreach-status.ts";
import type { CampaignDefinition, CompanyRecord, ImportRecord, LeadSearchResult, PersonRecord, RecordCalls, SequenceView, SummaryEntry } from "../src/shared/api.ts";
import { refusedPair, respond, serverError } from "./mocks.ts";
import { FAKE_INBOX, FAKE_NUMBERS, TWO_CHANNELS, fakeCallsApp, fakeProviderApp, type CallsScenario, type FakeCallsApp } from "./fake-provider.ts";
import { fixture } from "./support.ts";

/** Opens a path on the app over the fake email provider. */
async function fake(page: Page, path: string): Promise<void> {
  const f = await fakeProviderApp();
  await page.goto(f.url + path);
}

let fresh = 0;
/** A calls app of its own, for a screen that logs: the scans open each screen several times. */
export const freshCalls = (scenario: CallsScenario, name: string): Promise<FakeCallsApp> => fakeCallsApp(scenario, `${name}-${++fresh}`);

/** Opens a path on a calls app (ticket 14b): the campaign has a phone track, defined over HTTP. A name gives a fresh app. */
async function calls(page: Page, scenario: CallsScenario, path: string, name?: string): Promise<FakeCallsApp> {
  const f = name ? await freshCalls(scenario, name) : await fakeCallsApp(scenario);
  // The browser's clock reads the app's, so the date and the clocks on screen agree with the calls.
  await page.clock.setFixedTime(f.harness.clock);
  await page.goto(f.url + path);
  return f;
}

/** Holds a calls app's outcome POSTs open, for the pending state. */
async function holdOutcomes(page: Page): Promise<void> {
  await page.route("**/api/call-tasks/*/outcome", () => new Promise(() => undefined));
}

/** Logs an outcome on a task over HTTP, as another tab or window would. */
export async function logElsewhere(f: FakeCallsApp, taskId: string, outcome: string, numberId: string | null): Promise<void> {
  const out = await f.harness.request("POST", `/api/call-tasks/${taskId}/outcome`, { requestId: `elsewhere-${taskId}-${Date.now()}`, outcome, numberId });
  if (out.status !== 200) throw new Error(`logging elsewhere failed: ${JSON.stringify(out.body)}`);
}

/** The focused call's task id and its first good number, from the server. */
export async function focused(f: FakeCallsApp): Promise<{ taskId: string; numberId: string | null }> {
  const view = (await f.harness.request<{ focusTaskId: string | null }>("GET", "/api/calls")).body;
  const taskId = view.focusTaskId ?? "";
  const task = (await f.harness.request<{ numbers: { detailId: string; bad: boolean }[] }>("GET", `/api/call-tasks/${taskId}`)).body;
  return { taskId, numberId: task.numbers.find((n) => !n.bad)?.detailId ?? null };
}

/** Picks an outcome and logs it with the mouse; waits for the answer. */
export async function logWithMouse(page: Page, outcome: string, note = ""): Promise<void> {
  if (note) await page.getByLabel("Notes from this call").fill(note);
  await page.getByRole("group", { name: "Call outcome" }).getByRole("button", { name: outcome, exact: true }).click();
  await page.getByRole("button", { name: "Log and open next call" }).click();
}

const NEEDS_ATTENTION = {
  stalledInboxes: [],
  heldTracks: [{ enrollmentId: "e1", trackId: "sms", reason: "sms_conversation_taken" }],
  accountWaits: [{ accountId: "outreach@northlight-mail.example", reason: "rate_limited", until: "2026-11-09T11:30:00.000Z" }],
  senderProblems: [
    { accountId: "sms-1", channel: "sms", label: "+44 7700 900999", problem: "disconnected" },
    { accountId: "inbox-2", channel: "email", label: "alex@northlight-mail.example", problem: "sending_off" },
  ],
  heldCapacity: [],
  anomalies: [],
  overdueCallbacks: [],
} as const;

/**
 * Every route and state the app can show, for the standing accessibility and layout checks.
 * Add new screens here: e2e/accessibility.spec.ts and e2e/layout.spec.ts then cover them in
 * both themes and at every width. Runs after the demonstration project, so its data exists.
 */
export interface Screen {
  readonly name: string;
  readonly open: (page: Page, data: SeedData) => Promise<void>;
}

/** The longest campaign name the server accepts, with no break opportunity. */
export const LONG_CAMPAIGN_NAME = `Long${"x".repeat(96)}`;

export interface SeedData {
  readonly campaignId: string;
  readonly unimportedCampaignId: string;
  readonly longCampaignId: string;
  readonly longImportId: string;
  readonly firstImportId: string;
  readonly reimportId: string;
  readonly person: (name: string) => string;
  readonly company: (name: string) => string;
  readonly companyOf: (personName: string) => string;
}

interface Row {
  kind: "person" | "company";
  id: string;
  name: string;
  company?: { id: string };
}

export async function seedData(request: APIRequestContext): Promise<SeedData> {
  const campaigns = (await (await request.get("/api/campaigns")).json()) as { campaigns: { id: string; name: string }[] };
  const physio = campaigns.campaigns.find((c) => c.name === "Physio clinics, London");
  let unimported = campaigns.campaigns.find((c) => c.name === "Dental clinics, Leeds");
  if (!unimported) {
    const created = await request.post("/api/campaigns", { data: { name: "Dental clinics, Leeds" } });
    unimported = ((await created.json()) as { campaign: { id: string; name: string } }).campaign;
  }
  let long = campaigns.campaigns.find((c) => c.name === LONG_CAMPAIGN_NAME);
  if (!long) {
    const created = await request.post("/api/campaigns", {
      data: { name: LONG_CAMPAIGN_NAME, businessesCsv: readFileSync(fixture("businesses-run1.csv"), "utf8"), peopleCsv: readFileSync(fixture("people-run1.csv"), "utf8") },
    });
    long = ((await created.json()) as { campaign: { id: string; name: string } }).campaign;
  }
  const longImports = (await (await request.get(`/api/campaigns/${long.id}`)).json()) as { imports: { id: string }[] };
  if (!physio) throw new Error("the demonstration project has not created its campaigns");
  const detail = (await (await request.get(`/api/campaigns/${physio.id}`)).json()) as { imports: { id: string }[] };
  const [reimport, first] = detail.imports;
  if (!reimport || !first) throw new Error("expected two imports into Physio clinics, London");
  const leads = (await (await request.get("/api/leads?limit=500")).json()) as { rows: Row[] };
  const row = (name: string) => {
    const found = leads.rows.find((r) => r.name === name);
    if (!found) throw new Error(`no lead row named ${name}`);
    return found;
  };
  return {
    campaignId: physio.id,
    unimportedCampaignId: unimported.id,
    longCampaignId: long.id,
    longImportId: longImports.imports[0]?.id ?? "",
    firstImportId: first.id,
    reimportId: reimport.id,
    person: (name) => row(name).id,
    company: (name) => row(name).id,
    companyOf: (name) => row(name).company?.id ?? "",
  };
}

/** Holds matching requests open for the rest of the test, to show a loading state. */
async function hold(page: Page, pattern: string, method?: string): Promise<void> {
  await page.route(pattern, async (route) => {
    if (method && route.request().method() !== method) return route.continue();
    await new Promise(() => undefined);
  });
}

async function fail(page: Page, pattern: string, method?: string): Promise<void> {
  await page.route(pattern, (route) => (method && route.request().method() !== method ? route.continue() : serverError(route)));
}

async function refuse(page: Page, pattern: string): Promise<void> {
  await page.route(pattern, (route) => (route.request().method() === "POST" ? refusedPair(route) : route.continue()));
}

async function readyImportAgain(page: Page, data: SeedData): Promise<void> {
  await page.goto(`/campaigns/${data.campaignId}/import`);
  await page.getByLabel("People file", { exact: true }).setInputFiles(fixture("people-run2.csv"));
  await page.getByLabel("Businesses file", { exact: true }).setInputFiles(fixture("businesses-run2.csv"));
  await settle(page, /6 businesses, matches/);
}

const BUSINESS_HEADER_ONLY_MISSING_PLACE =
  "business_id,business_name,phone_e164\nbz-1,Some Clinic,+442079460999\n";

/** A person record showing every outreach status, a bad number and a newer email. */
function galleryRecord(id: string): PersonRecord & RecordCalls {
  const statuses = OUTREACH_STATUSES;
  const e = (status: (typeof OUTREACH_STATUSES)[number]) => `e${statuses.indexOf(status)}`;
  const base = { track: { id: "p1", label: "Phone track" }, zone: "Europe/London", noGoodNumber: false, heldByCallback: false, callbackAt: null, skipLimit: null } as const;
  const limit = { dueDate: "2026-11-09", limitDays: 2, ifUnworked: "2026-11-10" } as const;
  // Ticket 15b: every state of an open call on the record (the enrollment beside each is a fixture; the record pairs them by id).
  const calls: RecordCalls["calls"] = [
    { ...base, enrollmentId: e("waiting_on_call"), taskId: "t-rolled", kind: "call", listed: true, reason: "rolled_over", listedFor: "2026-11-10", skipLimit: limit },
    { ...base, enrollmentId: e("callback_scheduled"), taskId: "t-callback", kind: "callback", listed: true, reason: "callback", listedFor: "2026-11-10", callbackAt: "2026-11-10T15:00:00.000Z" },
    { ...base, enrollmentId: e("queued"), taskId: "t-overdue", kind: "callback", listed: true, reason: "overdue", listedFor: "2026-11-09", callbackAt: "2026-11-09T11:30:00.000Z", noGoodNumber: true },
    { ...base, enrollmentId: e("active"), taskId: "t-redial", kind: "call", listed: false, reason: null, listedFor: "2026-11-11", skipLimit: { ...limit, ifUnworked: "2026-11-11" } },
    { ...base, enrollmentId: e("in_win_back"), taskId: "t-held", kind: "call", listed: false, reason: null, listedFor: "2026-11-10", heldByCallback: true, skipLimit: { ...limit, ifUnworked: null } },
  ];
  return {
    calls,
    today: "2026-11-10",
    kind: "person",
    id,
    name: "Status Gallery",
    title: "Fixture for every status",
    timezone: "Europe/London",
    company: { id: "co-gallery", name: "Gallery Clinic", city: "London" },
    companyIsLead: false,
    contactDetails: [
      { id: "d1", owner: "person", channel: "email", phoneKind: null, value: "old@gallery.example", bad: false, newer: false },
      { id: "d2", owner: "person", channel: "email", phoneKind: null, value: "new@gallery.example", bad: false, newer: true },
      { id: "d3", owner: "person", channel: "phone", phoneKind: "direct", value: "+44 20 7946 0999", bad: true, newer: false },
      { id: "d4", owner: "company", channel: "phone", phoneKind: "main_line", value: "+44 20 7946 0998", bad: false, newer: false },
    ],
    enrollments: statuses.map((status, i) => ({ id: `e${i}`, campaign: { id: `c${i}`, name: `Campaign ${i + 1}` }, status, enrolledAt: "2026-11-12T09:00:00.000Z" })),
    unenrolledReason: null,
    colleagues: [
      { id: "p2", name: "Colleague Two", title: "Manager", enrollments: statuses.slice(5, 8).map((status, i) => ({ id: `ce${i}`, campaign: { id: `c${i}`, name: `Campaign ${i + 1}` }, status, enrolledAt: "2026-11-12T09:00:00.000Z" })), unenrolledReason: null },
    ],
  };
}

/**
 * A campaign of the fixture leads on the running app with `definition` saved through the API
 * (ticket 13b): the running app has no email or SMS provider, so its tracks have no sender.
 */
async function campaignWith(page: Page, name: string, definition: CampaignDefinition = { ...TWO_CHANNELS, emailPool: [], smsPool: [] }): Promise<string> {
  const created = await page.request.post("/api/campaigns", { data: { name, businessesCsv: readFileSync(fixture("businesses-run1.csv"), "utf8"), peopleCsv: readFileSync(fixture("people-run1.csv"), "utf8") } });
  const id = ((await created.json()) as { campaign: { id: string } }).campaign.id;
  await page.request.put(`/api/campaigns/${id}/sequence`, { data: definition });
  return id;
}

/** n tracks, email and SMS in turn, each after the one before: the deepest arrangement of n tracks. */
function chainOf(n: number): CampaignDefinition {
  const template = (channel: "email" | "sms") => TWO_CHANNELS.tracks.find((t) => t.channel === channel)!;
  const tracks = Array.from({ length: n }, (_, i) => {
    const like = template(i % 2 === 0 ? "email" : "sms");
    return {
      ...like,
      id: `t${i}`,
      start: i === 0 ? { kind: "entry" as const } : { kind: "after" as const, trackId: `t${i - 1}`, delayDays: i % 3 },
      steps: like.steps.map((st) => ({ ...st, id: `t${i}-${st.id}` })),
    };
  });
  return { ...TWO_CHANNELS, emailPool: [], smsPool: [], tracks };
}

async function settle(page: Page, text: string | RegExp): Promise<void> {
  await page.getByText(text).first().waitFor();
}

async function readyForm(page: Page): Promise<void> {
  await page.goto("/campaigns/new");
  await page.getByLabel("Campaign name").fill("Physio clinics, North London");
  await page.getByLabel("People file", { exact: true }).setInputFiles(fixture("people-run1.csv"));
  await page.getByLabel("Businesses file", { exact: true }).setInputFiles(fixture("businesses-run1.csv"));
  await settle(page, /6 businesses, matches/);
}

/** An import whose rows include the ones that changed nothing and a number a colleague holds. */
function importWithUnmatchedRows(): { campaign: { id: string; name: string; defaultTimezone: null; createdAt: string }; imports: ImportRecord[] } {
  const reach = { email: false, sms: false, call: true };
  const person = (name: string, title: string, outcome: "new" | "already_enrolled" | "updated", id: string): Extract<SummaryEntry, { channels: unknown }> => ({
    outcome,
    lead: { kind: "person", personId: id },
    name,
    title,
    companyId: "co-harbour",
    companyName: "Harbour Lane Physio",
    peopleAtCompany: 4,
    channels: reach,
    via: ["direct", "main_line"],
    added: [],
    becameMobile: [],
    stillBad: [],
    heldElsewhere: [{ detail: { channel: "phone", phoneKind: "direct", value: "+44 20 7946 0166" }, holder: "Yara Glen", holderHasIt: true }],
  });
  const unmatched = (name: string, title: string, file: "people" | "businesses", rowNumbers: number[], record: "person" | "company", companyName: string) =>
    ({ outcome: "not_enrolled", reason: "ambiguous_match", lead: null, name, title, file, rowNumbers, record, companyName }) as const;
  const entries: SummaryEntry[] = [
    {
      outcome: "not_enrolled",
      reason: "shares_contact",
      lead: { kind: "person", personId: "p-ann" },
      name: "Ann Shaw",
      title: "Owner",
      companyId: "co-elm",
      companyName: "Elm Clinic",
      peopleAtCompany: 1,
      shared: { detail: { channel: "email", phoneKind: null, value: "ann@mail.example" }, lead: "Ann Shaw", companyName: "Harbour Lane Physio", enrolled: true },
      heldElsewhere: [],
    },
    {
      outcome: "not_enrolled",
      reason: "shares_contact",
      lead: { kind: "person", personId: "p-ben" },
      name: "Ben Cole",
      title: "Receptionist",
      companyId: "co-harbour",
      companyName: "Harbour Lane Physio",
      peopleAtCompany: 4,
      shared: { detail: { channel: "phone", phoneKind: "mobile", value: "+44 7700 900901" }, lead: "Alice Hart", companyName: "Harbour Lane Physio", enrolled: false },
      heldElsewhere: [{ detail: { channel: "phone", phoneKind: "mobile", value: "+44 7700 900901" }, holder: "Alice Hart", holderHasIt: false }],
    },
    { ...unmatched("Alice Cole", "Owner", "people", [7], "person", "Harbour Lane Physio"), conflict: "repeated_id", disagreeing: ["person_id", "name"] },
    { ...unmatched("Harbour Wellness", "London", "businesses", [5], "company", "Harbour Wellness"), conflict: "repeated_id", disagreeing: ["business_id", "name"] },
    { ...unmatched("Sam Lee", "Owner", "people", [3], "person", "Harbour Lane Physio"), conflict: "several_records", disagreeing: [] },
    { ...unmatched("Sam Lee", "Practice manager", "people", [4], "person", "Harbour Lane Physio"), conflict: "contradiction", disagreeing: ["person_id", "phone"] },
    { ...unmatched("Harbour Lane Physiotherapy Clinic", "London", "businesses", [2], "company", "Harbour Lane Physiotherapy Clinic"), conflict: "contradiction", disagreeing: ["name", "main_line"] },
    { ...unmatched("City Physio", "London", "businesses", [3, 4], "company", "City Physio"), conflict: "several_records", disagreeing: [] },
    { ...unmatched("Nia Cole", "Clinical lead", "people", [6], "company", "City Physio"), conflict: "another_row", disagreeing: [] },
    person("Zara Glen", "Practice manager", "new", "p-zara"),
    { ...person("Uma Dale", "Physiotherapist", "already_enrolled", "p-uma"), outcome: "updated", heldElsewhere: [], becameMobile: [{ channel: "phone", phoneKind: "mobile", value: "+44 7700 900254" }] },
    person("Yusuf Amin", "Physiotherapist", "already_enrolled", "p-yusuf"),
  ];
  return {
    campaign: { id: "c-unmatched", name: "Physio clinics, London", defaultTimezone: null, createdAt: "2026-11-12T09:00:00.000Z" },
    imports: [
      {
        id: "i-unmatched",
        campaignId: "c-unmatched",
        importedAt: "2026-11-13T09:00:00.000Z",
        fileNames: { people: "people-run3.csv", businesses: "businesses-run3.csv" },
        summary: {
          rows: { businesses: 5, people: 10 },
          counts: { new: 1, already_enrolled: 1, updated: 1, not_enrolled: 9 },
          entries,
          rowRecords: { businesses: [null, null, null, "co-harbour", null], people: ["p-ann", "p-ben", null, null, null, "p-zara", null, "p-uma", "p-yusuf", "p-ann"] },
        },
      },
      {
        id: "i-first",
        campaignId: "c-unmatched",
        importedAt: "2026-11-12T09:00:00.000Z",
        fileNames: { people: "people-run1.csv", businesses: "businesses-run1.csv" },
        summary: { rows: { businesses: 0, people: 0 }, counts: { new: 0, already_enrolled: 0, updated: 0, not_enrolled: 0 }, entries: [], rowRecords: { businesses: [], people: [] } },
      },
    ],
  };
}

/** A company lead whose decision maker a later import made reachable, enrolled in their own right. */
export const JUNIPER_LATER = {
  kind: "company",
  id: "co-juniper",
  name: "Juniper Pilates Studio",
  city: "London",
  timezone: "Europe/London",
  contactDetails: [{ id: "d1", owner: "company", channel: "email", phoneKind: null, value: "studio@juniperpilates.example", bad: false, newer: false }],
  enrollments: [{ id: "e1", campaign: { id: "c1", name: "Physio clinics, London" }, status: "queued", enrolledAt: "2026-11-12T09:00:00.000Z" }],
  unenrolledReason: null,
  people: [
    { id: "p1", name: "Marco Bianchi", title: "Studio owner", enrollments: [{ id: "e2", campaign: { id: "c1", name: "Physio clinics, London" }, status: "queued", enrolledAt: "2026-11-13T09:00:00.000Z" }], unenrolledReason: null },
    { id: "p2", name: "Lucia Neri", title: "Studio manager", enrollments: [], unenrolledReason: "no_usable_channel" },
  ],
} satisfies CompanyRecord;

export const JUNIPER_LATER_ROW = {
  rows: [{ kind: "company", id: "co-juniper", name: "Juniper Pilates Studio", city: "London", peopleOnRecord: 2, peopleReachable: 1, enrollments: JUNIPER_LATER.enrollments, unenrolledReason: null }],
  total: 1,
  people: 0,
  companies: 1,
  limit: 100,
} satisfies LeadSearchResult;

/**
 * Calls with three kept refusals from earlier presses, oldest first (council on b8c65f9, item 4): the
 * first shows, the rest wait behind a count, and the call stays on screen.
 */
export async function openWithKeptRefusals(page: Page, name: string): Promise<FakeCallsApp> {
  const f = await freshCalls("ready", name);
  const t = await focused(f);
  await page.addInitScript(([taskId, numberId]) => {
    const notes = ["Spoke to the front desk; call back after 3.", "Left with the practice manager.", "Line busy twice, try the mobile."];
    notes.forEach((note, i) => {
      const body = { requestId: `kept-${i}`, outcome: "no_answer", numberId, note, noteScope: "person" };
      const refused = { message: "That number is marked bad: choose another of the lead's numbers.", offList: null };
      window.localStorage.setItem(`outreach.calls.outbox.kept-${i}`, JSON.stringify({ v: 2, taskId, who: "Amira Hassan", body, pressedAt: 1_000 + i, refused }));
    });
  }, [t.taskId, t.numberId] as const);
  await page.clock.setFixedTime(f.harness.clock);
  await page.goto(`${f.url}/calls`);
  await settle(page, "2 more outcomes not logged");
  return f;
}


// ---------------------------------------------------------------------------------------------
// Ticket 15b: redials, callbacks, rolled-over and overdue calls, set up over HTTP as another window would.

interface QueueRead { readyNow: { taskId: string; person: { name: string } | null }[]; laterToday: { taskId: string; person: { name: string } | null }[] }

/** The task of a lead on today's list, and its numbers by kind. */
export async function callOf(f: FakeCallsApp, who: string): Promise<{ taskId: string; number: (kind: "mobile" | "main_line" | "direct") => string | null }> {
  const list = (await f.harness.request<QueueRead>("GET", "/api/calls")).body;
  const taskId = [...list.readyNow, ...list.laterToday].find((x) => x.person?.name === who)?.taskId ?? "";
  const numbers = (await f.harness.request<{ numbers: { detailId: string; kind: string }[] }>("GET", `/api/call-tasks/${taskId}`)).body.numbers;
  return { taskId, number: (kind) => numbers.find((n) => n.kind === kind)?.detailId ?? null };
}

async function logOver(f: FakeCallsApp, taskId: string, body: Record<string, unknown>): Promise<void> {
  const out = await f.harness.request("POST", `/api/call-tasks/${taskId}/outcome`, { requestId: `setup-${taskId}-${String(body["outcome"])}-${Date.now()}`, ...body });
  if (out.status !== 200) throw new Error(`setting up failed: ${JSON.stringify(out.body)}`);
}

/**
 * Monday: Amira's call redialed, Tom asks for a callback on Tuesday at 11:00, Grace's call left unworked.
 * Then Tuesday 11:30: Tom's callback is overdue, Amira's redial and Grace's rolled-over call are on their last day.
 */
export async function carriedAndOverdue(name: string): Promise<FakeCallsApp> {
  const f = await freshCalls("ready", name);
  const amira = await callOf(f, "Amira Hassan");
  const tom = await callOf(f, "Tom");
  await logOver(f, amira.taskId, { outcome: "no_answer", redial: true, numberId: amira.number("mobile"), note: "Rang out." });
  await logOver(f, tom.taskId, { outcome: "callback_requested", callbackAt: "2026-11-10T11:00:00+00:00", numberId: tom.number("main_line"), note: "Call after the morning clinic." });
  await f.harness.advanceTo(Date.parse("2026-11-10T11:30:00Z"));
  return f;
}

/** Monday 10:45: Tom's callback (10:30) is overdue, and the shared main line, his only number, was marked wrong on Amira's call (Q13). */
export async function callbackWithNoGoodNumber(name: string): Promise<FakeCallsApp> {
  const f = await freshCalls("ready", name);
  const amira = await callOf(f, "Amira Hassan");
  const tom = await callOf(f, "Tom");
  await logOver(f, tom.taskId, { outcome: "callback_requested", callbackAt: "2026-11-09T10:30:00+00:00", numberId: tom.number("main_line") });
  await logOver(f, amira.taskId, { outcome: "wrong_number", numberId: amira.number("main_line"), note: "The clinic's line is a fax." });
  await f.harness.advanceTo(Date.parse("2026-11-09T10:45:00Z"));
  return f;
}

/** Opens Calls on a fresh app at its own clock, and waits for the sheet. */
export async function openCalls(page: Page, f: FakeCallsApp, path = "/calls"): Promise<void> {
  await page.clock.setFixedTime(f.harness.clock);
  await page.goto(f.url + path);
  if (path === "/calls") await page.getByText(/^Calling hours /).waitFor();
}

export const SCREENS: readonly Screen[] = [
  { name: "today", open: async (page) => { await page.goto("/"); await settle(page, "Nothing to call right now."); } },
  { name: "calls", open: async (page) => { await page.goto("/calls"); await settle(page, "Calls appear here once a launched campaign reaches a call step."); } },
  // Today and the call focus queue with calls (ticket 14b), on a campaign with a phone track.
  { name: "today with calls ready", open: async (page) => { await calls(page, "ready", "/"); await settle(page, "4 calls are ready now."); } },
  { name: "today before calling hours", open: async (page) => { await calls(page, "early", "/"); await settle(page, "Later today:"); } },
  { name: "today with the day's call capacity used", open: async (page) => { await calls(page, "full", "/"); await settle(page, "Today’s call capacity is used."); } },
  {
    name: "today with sender accounts that can't send and tracks on hold",
    open: async (page) => {
      await page.route("**/api/needs-attention", (route) => respond(route, NEEDS_ATTENTION));
      await calls(page, "ready", "/");
      await settle(page, "Your SMS number +44 7700 900999 can’t send");
    },
  },
  { name: "today loading", open: async (page) => { await hold(page, "**/api/today"); await hold(page, "**/api/needs-attention"); await page.goto("/"); await page.getByLabel("Loading up next").waitFor(); } },
  { name: "today error", open: async (page) => { await fail(page, "**/api/today"); await fail(page, "**/api/needs-attention"); await page.goto("/"); await settle(page, "Today’s calls didn’t load."); await settle(page, "Needs attention didn’t load."); } },
  { name: "calls, the focused call", open: async (page) => { await calls(page, "ready", "/calls"); await settle(page, "Calling hours Mon–Fri, 09:00–17:00"); } },
  {
    name: "calls, a company lead's call",
    open: async (page) => {
      const f = await freshCalls("ready", "screen-company-lead");
      for (let i = 0; i < 3; i++) await logElsewhere(f, (await focused(f)).taskId, "skip_for_now", null);
      await page.goto(`${f.url}/calls`);
      await settle(page, "Company with no named decision maker");
    },
  },
  { name: "calls, before calling hours", open: async (page) => { await calls(page, "early", "/calls"); await settle(page, "Nothing to call right now"); } },
  { name: "calls, the day's capacity used", open: async (page) => { await calls(page, "full", "/calls"); await settle(page, "Today’s call capacity is used."); } },
  { name: "calls loading", open: async (page) => { const f = await fakeCallsApp("ready"); await hold(page, "**/api/calls*"); await page.goto(`${f.url}/calls`); await page.getByLabel("Loading the call").waitFor(); } },
  { name: "calls error", open: async (page) => { const f = await fakeCallsApp("ready"); await fail(page, "**/api/calls*"); await page.goto(`${f.url}/calls`); await settle(page, "The call list didn’t load."); } },
  { name: "calls, the call didn't load", open: async (page) => { const f = await fakeCallsApp("ready"); await fail(page, "**/api/call-tasks/*"); await page.goto(`${f.url}/calls`); await settle(page, "This call didn’t load."); } },
  {
    name: "calls, an outcome chosen with a note",
    open: async (page) => {
      await calls(page, "ready", "/calls");
      await page.getByLabel("Notes from this call").fill("Receptionist says she is in clinic until 3.");
      await page.getByRole("button", { name: "Interested", exact: true }).click();
      await settle(page, "You take it from here.");
    },
  },
  {
    name: "calls, an outcome being logged",
    open: async (page) => {
      await calls(page, "ready", "/calls");
      await holdOutcomes(page);
      await page.getByText(/^Calling hours /).waitFor();
      await logWithMouse(page, "No answer");
      await settle(page, "Logging no answer for");
    },
  },
  {
    name: "calls, an outcome not confirmed yet",
    open: async (page) => {
      await calls(page, "ready", "/calls");
      await page.route("**/api/call-tasks/*/outcome", (route) => route.abort());
      await page.getByText(/^Calling hours /).waitFor();
      await logWithMouse(page, "No answer");
      await settle(page, "not confirmed yet");
    },
  },
  {
    name: "calls, an outcome logged and the next call open",
    open: async (page) => {
      await calls(page, "ready", "/calls", "screen-logged");
      await page.getByText(/^Calling hours /).waitFor();
      await logWithMouse(page, "Wrong number", "Number rings out to a fax tone.");
      await settle(page, "is marked wrong.");
    },
  },
  {
    name: "calls, the call was logged in another window",
    open: async (page) => {
      const f = await calls(page, "ready", "/calls", "screen-elsewhere");
      await page.getByText(/^Calling hours /).waitFor();
      const t = await focused(f);
      await logElsewhere(f, t.taskId, "voicemail", t.numberId);
      await logWithMouse(page, "No answer", "Spoke to the front desk.");
      await settle(page, "already logged from another window or device:");
    },
  },
  {
    name: "calls, the list done",
    open: async (page) => {
      const f = await freshCalls("full", "screen-done");
      const t = await focused(f);
      await logElsewhere(f, t.taskId, "no_answer", t.numberId);
      await page.goto(`${f.url}/calls`);
      await page.getByText(/^Calling hours /).waitFor();
      await logWithMouse(page, "Interested");
      await settle(page, "List done");
    },
  },
  {
    name: "calls, the number chosen went bad",
    open: async (page) => {
      const f = await calls(page, "ready", "/calls", "screen-number-bad");
      await page.getByText(/^Calling hours /).waitFor();
      await page.getByRole("radio", { name: /7946 0101/ }).check();
      await page.getByRole("button", { name: "Wrong number", exact: true }).click();
      const tom = (await f.harness.request<{ readyNow: { taskId: string; person: { name: string } | null }[] }>("GET", "/api/calls")).body.readyNow.find((x) => x.person?.name === "Tom");
      const main = (await f.harness.request<{ numbers: { detailId: string; kind: string }[] }>("GET", `/api/call-tasks/${tom?.taskId}`)).body.numbers.find((n) => n.kind === "main_line");
      await logElsewhere(f, tom?.taskId ?? "", "wrong_number", main?.detailId ?? null);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await settle(page, "is now marked wrong");
    },
  },
  {
    name: "calls, an outcome from a closed tab not logged",
    open: async (page) => {
      const f = await freshCalls("ready", "screen-refused-record");
      const t = await focused(f);
      await logElsewhere(f, t.taskId, "interested", t.numberId);
      // What a closed tab left: its entry, refused when this page sends it.
      await page.addInitScript(([taskId, numberId]) => {
        const body = { requestId: "left-by-a-closed-tab", outcome: "no_answer", numberId, note: "Spoke to the front desk; call back after 3.", noteScope: "person" };
        window.localStorage.setItem("outreach.calls.outbox.left-by-a-closed-tab", JSON.stringify({ v: 2, taskId, who: "Amira Hassan", body }));
      }, [t.taskId, t.numberId] as const);
      await page.clock.setFixedTime(f.harness.clock);
      await page.goto(`${f.url}/calls`);
      await settle(page, "Not logged: no answer for Amira Hassan.");
    },
  },
  {
    name: "calls, three kept refusals",
    open: async (page) => {
      await openWithKeptRefusals(page, "screen-three-refusals");
    },
  },
  // Ticket 15b: redials and callbacks on the call sheet, carried and overdue calls on Today and Calls.
  {
    name: "calls, a redial chosen",
    open: async (page) => {
      await calls(page, "ready", "/calls");
      await page.getByText(/^Calling hours /).waitFor();
      await page.getByRole("button", { name: "No answer", exact: true }).click();
      await page.getByRole("checkbox", { name: /Call again tomorrow/ }).check();
      await settle(page, "The call moves to the list for Tue 10 Nov");
    },
  },
  {
    name: "calls, a callback time entered",
    open: async (page) => {
      await calls(page, "ready", "/calls");
      await page.getByText(/^Calling hours /).waitFor();
      await page.getByRole("button", { name: "Callback requested", exact: true }).click();
      await page.getByLabel("Their time", { exact: true }).fill("15:30");
      await settle(page, "Inside their calling hours.");
    },
  },
  {
    name: "calls, a callback time already passed",
    open: async (page) => {
      await calls(page, "ready", "/calls");
      await page.getByText(/^Calling hours /).waitFor();
      await page.getByRole("button", { name: "Callback requested", exact: true }).click();
      await page.getByLabel("Their time", { exact: true }).fill("09:30");
      await settle(page, "That time has passed.");
    },
  },
  {
    name: "calls, a callback on a day their calling hours never open",
    open: async (page) => {
      await calls(page, "ready", "/calls");
      await page.getByText(/^Calling hours /).waitFor();
      await page.getByRole("button", { name: "Callback requested", exact: true }).click();
      await page.getByLabel("Day", { exact: true }).selectOption("2026-11-14");
      await page.getByLabel("Their time", { exact: true }).fill("11:00");
      await settle(page, "Their calling hours never open on that day");
    },
  },
  {
    name: "calls, a callback logged and held",
    open: async (page) => {
      await calls(page, "ready", "/calls", "screen-callback-logged");
      await page.getByText(/^Calling hours /).waitFor();
      await page.getByRole("button", { name: "Callback requested", exact: true }).click();
      await page.getByLabel("Their time", { exact: true }).fill("15:30");
      await page.getByRole("button", { name: "Log and open next call" }).click();
      await settle(page, "is held until you log how the callback went.");
    },
  },
  {
    name: "calls, an overdue callback",
    open: async (page) => {
      await openCalls(page, await carriedAndOverdue("screen-overdue"));
      await settle(page, "Callback overdue since today at 11:00 their time");
    },
  },
  {
    name: "calls, a callback with no good number left",
    open: async (page) => {
      await openCalls(page, await callbackWithNoGoodNumber("screen-q13"));
      await settle(page, "nothing but skip for now can be logged on this callback");
    },
  },
  {
    name: "today with an overdue callback, a redial and a rolled-over call",
    open: async (page) => {
      await openCalls(page, await carriedAndOverdue("screen-today-carried"), "/");
      await settle(page, "Tom’s callback is overdue");
    },
  },
  {
    name: "today with a callback that has no good number left",
    open: async (page) => {
      await openCalls(page, await callbackWithNoGoodNumber("screen-today-q13"), "/");
      await settle(page, "Every number for Tom is marked wrong");
    },
  },
  {
    name: "a person's record with a redial, a callback and the call skipped unworked",
    open: async (page) => {
      const f = await carriedAndOverdue("screen-record-skipped");
      await f.harness.advanceTo(Date.parse("2026-11-11T11:00:00Z"));
      await openCalls(page, f, `/leads/people/${f.person("Amira Hassan")}`);
      await settle(page, "Phone track skipped, not called");
    },
  },
  {
    name: "a person's record with an overdue callback",
    open: async (page) => {
      const f = await carriedAndOverdue("screen-record-overdue");
      await openCalls(page, f, `/leads/people/${f.person("Tom")}`);
      await settle(page, "now overdue");
    },
  },
  {
    name: "a person's Activity with logged calls",
    open: async (page) => {
      const f = await calls(page, "ready", "/calls", "screen-activity");
      await page.getByText(/^Calling hours /).waitFor();
      await logWithMouse(page, "Skip for now", "In clinic, try after lunch.");
      await settle(page, "skipped for now");
      await logWithMouse(page, "Didn’t reach them", "Receptionist took a message.");
      await settle(page, "didn’t reach them logged");
      await page.goto(`${f.url}/leads/people/${f.person("Tom")}`);
      await settle(page, "Call: didn’t reach them");
    },
  },
  { name: "campaigns list", open: async (page) => { await page.goto("/campaigns"); await settle(page, "See result"); } },
  {
    name: "campaigns empty",
    open: async (page) => {
      await page.route("**/api/campaigns", (route) => respond(route, { campaigns: [] }));
      await page.goto("/campaigns");
      await settle(page, "Start a campaign from a scraper run");
    },
  },
  {
    name: "campaigns loading",
    open: async (page) => { await hold(page, "**/api/campaigns"); await page.goto("/campaigns"); await page.getByLabel("Loading campaigns").waitFor(); },
  },
  {
    name: "campaigns error",
    open: async (page) => { await fail(page, "**/api/campaigns"); await page.goto("/campaigns"); await settle(page, "Campaigns didn’t load."); },
  },
  { name: "new campaign", open: async (page) => { await page.goto("/campaigns/new"); await settle(page, "Name the campaign first."); } },
  {
    name: "new campaign with a file in the wrong slot",
    open: async (page) => {
      await page.goto("/campaigns/new");
      await page.getByLabel("Businesses file", { exact: true }).setInputFiles(fixture("people-run1.csv"));
      await settle(page, "This is the People file.");
    },
  },
  { name: "new campaign ready", open: readyForm },
  {
    name: "new campaign refused",
    open: async (page) => {
      await refuse(page, "**/api/campaigns");
      await readyForm(page);
      await page.getByRole("button", { name: "Create campaign and import" }).click();
      await page.getByRole("alert").waitFor();
    },
  },
  {
    name: "importing",
    open: async (page) => {
      await hold(page, "**/api/campaigns", "POST");
      await readyForm(page);
      await page.getByRole("button", { name: "Create campaign and import" }).click();
      await settle(page, "Importing into");
    },
  },
  {
    name: "import again",
    open: async (page, data) => { await page.goto(`/campaigns/${data.campaignId}/import`); await settle(page, "Import again into"); },
  },
  {
    name: "import result",
    open: async (page, data) => { await page.goto(`/campaigns/${data.campaignId}/imports/${data.firstImportId}`); await settle(page, "What happened"); },
  },
  {
    name: "import result, re-import",
    open: async (page, data) => { await page.goto(`/campaigns/${data.campaignId}/imports/${data.reimportId}`); await settle(page, "No sequence was restarted."); },
  },
  {
    name: "import result, not enrolled tab",
    open: async (page, data) => {
      await page.goto(`/campaigns/${data.campaignId}/imports/${data.firstImportId}`);
      await page.getByRole("tab", { name: /Not enrolled/ }).click();
      await settle(page, "Their company isn’t in the Businesses file.");
    },
  },
  {
    name: "import result loading",
    open: async (page, data) => {
      await hold(page, `**/api/campaigns/${data.campaignId}`);
      await page.goto(`/campaigns/${data.campaignId}/imports/${data.firstImportId}`);
      await page.getByLabel("Loading the import result").waitFor();
    },
  },
  { name: "leads", open: async (page) => { await page.goto("/leads"); await settle(page, "Amira Hassan"); } },
  { name: "leads search with no match", open: async (page) => { await page.goto("/leads?q=zzzz"); await settle(page, "No one matches"); } },
  {
    name: "leads empty",
    open: async (page) => {
      await page.route("**/api/leads?*", (route) => respond(route, { rows: [], total: 0, people: 0, companies: 0, limit: 100 }));
      await page.goto("/leads");
      await settle(page, "No leads yet.");
    },
  },
  { name: "leads loading", open: async (page) => { await hold(page, "**/api/leads?*"); await page.goto("/leads"); await page.getByLabel("Loading leads").waitFor(); } },
  { name: "leads error", open: async (page) => { await fail(page, "**/api/leads?*"); await page.goto("/leads"); await settle(page, "Leads didn’t load."); } },
  {
    name: "leads with campaign options failing",
    open: async (page) => { await fail(page, "**/api/campaigns"); await page.goto("/leads"); await settle(page, "Amira Hassan"); },
  },
  {
    name: "company record",
    open: async (page, data) => { await page.goto(`/leads?company=${data.companyOf("Daniel Price")}`); await settle(page, "of whom 1 is enrolled"); },
  },
  {
    name: "person",
    open: async (page, data) => { await page.goto(`/leads/people/${data.person("Amira Hassan")}`); await page.getByRole("heading", { level: 1 }).waitFor(); },
  },
  {
    name: "person not enrolled",
    open: async (page, data) => { await page.goto(`/leads/people/${data.person("Sofia Marin")}`); await settle(page, "Not in any campaign."); },
  },
  {
    name: "person loading",
    open: async (page, data) => { await hold(page, "**/api/people/*"); await page.goto(`/leads/people/${data.person("Amira Hassan")}`); await page.getByLabel("Loading").waitFor(); },
  },
  {
    name: "person error",
    open: async (page, data) => { await fail(page, "**/api/people/*"); await page.goto(`/leads/people/${data.person("Amira Hassan")}`); await settle(page, "This record didn’t load."); },
  },
  {
    name: "company lead",
    open: async (page, data) => { await page.goto(`/leads/companies/${data.company("Riverside Sports Clinic")}`); await settle(page, "Company lead"); },
  },
  {
    name: "company lead through its shared inbox",
    open: async (page, data) => { await page.goto(`/leads/companies/${data.company("Juniper Pilates Studio")}`); await settle(page, "People on record"); },
  },
  // States added after the second verification (recheck R3).
  {
    name: "leads refreshing with previous results",
    open: async (page) => {
      await page.goto("/leads");
      await settle(page, "Amira Hassan");
      await hold(page, "**/api/leads?q=*");
      await page.getByLabel("Search leads").fill("Amira");
      await settle(page, "Updating results.");
    },
  },
  {
    name: "leads with campaign options loading",
    open: async (page) => { await hold(page, "**/api/campaigns"); await page.goto("/leads"); await settle(page, "Amira Hassan"); },
  },
  {
    name: "leads filtered by campaign",
    open: async (page, data) => { await page.goto(`/leads?campaign=${data.campaignId}`); await settle(page, "Clear search and filters"); await settle(page, "Ravi Patel"); },
  },
  { name: "leads with a status filter that matches nobody", open: async (page) => { await page.goto("/leads?status=replied"); await settle(page, "No one matches these filters."); } },
  {
    name: "company record loading",
    open: async (page, data) => { await hold(page, "**/api/companies/*"); await page.goto(`/leads?company=${data.companyOf("Daniel Price")}`); await page.getByLabel("Loading the company").waitFor(); },
  },
  {
    name: "company record error",
    open: async (page, data) => { await fail(page, "**/api/companies/*"); await page.goto(`/leads?company=${data.companyOf("Daniel Price")}`); await settle(page, "This company didn’t load."); },
  },
  {
    name: "company lead loading",
    open: async (page, data) => { await hold(page, "**/api/companies/*"); await page.goto(`/leads/companies/${data.company("Riverside Sports Clinic")}`); await page.getByLabel("Loading").waitFor(); },
  },
  {
    name: "company lead error",
    open: async (page, data) => { await fail(page, "**/api/companies/*"); await page.goto(`/leads/companies/${data.company("Riverside Sports Clinic")}`); await settle(page, "This record didn’t load."); },
  },
  { name: "company not found", open: async (page) => { await page.goto("/leads/companies/nobody"); await settle(page, "No one found"); } },
  {
    name: "company with no usable channel",
    open: async (page, data) => { await page.goto(`/leads/companies/${data.company("Copper Kettle Osteopathy")}`); await settle(page, "Not in any campaign."); },
  },
  {
    name: "import again loading",
    open: async (page, data) => { await hold(page, "**/api/campaigns"); await page.goto(`/campaigns/${data.campaignId}/import`); await page.getByLabel("Loading").waitFor(); },
  },
  {
    name: "import again error",
    open: async (page, data) => { await fail(page, "**/api/campaigns"); await page.goto(`/campaigns/${data.campaignId}/import`); await settle(page, "This campaign didn’t load."); },
  },
  { name: "import again into a missing campaign", open: async (page) => { await page.goto("/campaigns/nope/import"); await settle(page, "No such campaign"); } },
  { name: "import again ready", open: readyImportAgain },
  {
    name: "import again refused",
    open: async (page, data) => {
      await refuse(page, "**/api/campaigns/*/imports");
      await readyImportAgain(page, data);
      await page.getByRole("button", { name: "Import", exact: true }).click();
      await page.getByRole("alert").waitFor();
    },
  },
  {
    name: "new campaign, import failed on the server",
    open: async (page) => {
      await fail(page, "**/api/campaigns", "POST");
      await readyForm(page);
      await page.getByRole("button", { name: "Create campaign and import" }).click();
      await page.getByRole("alert").waitFor();
    },
  },
  {
    name: "import again, import failed on the server",
    open: async (page, data) => {
      await fail(page, "**/api/campaigns/*/imports", "POST");
      await readyImportAgain(page, data);
      await page.getByRole("button", { name: "Import", exact: true }).click();
      await page.getByRole("alert").waitFor();
    },
  },
  {
    name: "company lead after a later import made a decision maker reachable",
    open: async (page) => {
      await page.route("**/api/companies/co-juniper", (route) => respond(route, JUNIPER_LATER));
      await page.goto("/leads/companies/co-juniper");
      await settle(page, "can now be reached too");
    },
  },
  {
    name: "Leads row of a company lead whose decision maker can now be reached",
    open: async (page) => {
      await page.route("**/api/leads?*", (route) => respond(route, JUNIPER_LATER_ROW));
      await page.goto("/leads?q=Juniper");
      await settle(page, "can now be reached");
    },
  },
  {
    name: "import result with rows that changed nothing and a number a colleague holds",
    open: async (page) => {
      await page.route("**/api/campaigns/c-unmatched", (route) => respond(route, importWithUnmatchedRows()));
      await page.goto("/campaigns/c-unmatched/imports/i-unmatched");
      await settle(page, "nothing in the row tells them apart");
    },
  },
  {
    name: "import again importing",
    open: async (page, data) => {
      await hold(page, "**/api/campaigns/*/imports", "POST");
      await readyImportAgain(page, data);
      await page.getByRole("button", { name: "Import", exact: true }).click();
      await settle(page, "Importing into");
    },
  },
  {
    name: "import result error",
    open: async (page, data) => { await fail(page, `**/api/campaigns/${data.campaignId}`); await page.goto(`/campaigns/${data.campaignId}/imports/${data.firstImportId}`); await settle(page, "This import result didn’t load."); },
  },
  {
    name: "import result for a missing import",
    open: async (page, data) => { await page.goto(`/campaigns/${data.campaignId}/imports/nope`); await settle(page, "No such import"); },
  },
  {
    name: "import result for a missing campaign",
    open: async (page) => { await page.goto("/campaigns/nope/imports/nope"); await settle(page, "This import result didn’t load."); },
  },
  ...(["New", "Already enrolled", "Updated"] as const).map(
    (tab): Screen => ({
      name: `import result, re-import, ${tab} tab`,
      open: async (page, data) => {
        await page.goto(`/campaigns/${data.campaignId}/imports/${data.reimportId}`);
        await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
        await page.getByRole("tab", { name: new RegExp(`^${tab}`), selected: true }).waitFor();
      },
    }),
  ),
  {
    name: "import result, unchanged group expanded",
    open: async (page, data) => {
      await page.goto(`/campaigns/${data.campaignId}/imports/${data.reimportId}`);
      await page.getByRole("button", { name: "Show them" }).click();
      await page.getByRole("tab", { name: /^Already enrolled/, selected: true }).waitFor();
    },
  },
  {
    name: "import result, empty outcome tab",
    open: async (page, data) => {
      await page.goto(`/campaigns/${data.campaignId}/imports/${data.firstImportId}`);
      await page.getByRole("tab", { name: /^Updated/ }).click();
      await settle(page, "None in this import.");
    },
  },
  {
    name: "new campaign checking a file",
    open: async (page) => {
      await hold(page, "**/api/scraper-files/check");
      await page.goto("/campaigns/new");
      await page.getByLabel("People file", { exact: true }).setInputFiles(fixture("people-run1.csv"));
      await settle(page, "Checking people-run1.csv");
    },
  },
  {
    name: "new campaign with a failed file check",
    open: async (page) => {
      await fail(page, "**/api/scraper-files/check");
      await page.goto("/campaigns/new");
      await page.getByLabel("People file", { exact: true }).setInputFiles(fixture("people-run1.csv"));
      await settle(page, "Something went wrong on the server.");
    },
  },
  {
    name: "new campaign with a file missing columns",
    open: async (page) => {
      await page.goto("/campaigns/new");
      await page.getByLabel("Businesses file", { exact: true }).setInputFiles({ name: "businesses-broken.csv", mimeType: "text/csv", buffer: Buffer.from(BUSINESS_HEADER_ONLY_MISSING_PLACE) });
      await settle(page, "missing these columns");
    },
  },
  {
    name: "new campaign with files from different runs",
    open: async (page) => {
      await page.goto("/campaigns/new");
      await page.getByLabel("People file", { exact: true }).setInputFiles(fixture("people-run1.csv"));
      await page.getByLabel("Businesses file", { exact: true }).setInputFiles({
        name: "businesses-other-run.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          "business_id,place_id,business_name,category,phone_e164,phone_original,general_emails,website,domain,street,neighborhood,city,state_province,postal_code,country,timezone\nbz-other,PL-other,Other Clinic,Dentist,+442079460999,,,,,,,London,,,GB,Europe/London\n",
        ),
      });
      await settle(page, "don’t belong together");
    },
  },
  {
    name: "new campaign named, one file chosen",
    open: async (page) => {
      await page.goto("/campaigns/new");
      await page.getByLabel("Campaign name").fill("Physio clinics, South London");
      await page.getByLabel("People file", { exact: true }).setInputFiles(fixture("people-run1.csv"));
      await settle(page, "Add both files.");
    },
  },
  {
    name: "creating a campaign without importing",
    open: async (page) => {
      await hold(page, "**/api/campaigns", "POST");
      await page.goto("/campaigns/new");
      await page.getByLabel("Campaign name").fill("Physio clinics, South London");
      await page.getByRole("button", { name: "Create without importing" }).click();
      await page.getByRole("button", { name: "Create without importing" }).and(page.locator("[disabled]")).waitFor();
    },
  },
  {
    name: "creating a campaign without importing fails",
    open: async (page) => {
      await fail(page, "**/api/campaigns", "POST");
      await page.goto("/campaigns/new");
      await page.getByLabel("Campaign name").fill("Physio clinics, South London");
      await page.getByRole("button", { name: "Create without importing" }).click();
      await page.getByRole("alert").waitFor();
    },
  },
  {
    name: "campaigns list with a campaign not imported yet",
    open: async (page) => { await page.goto("/campaigns"); await settle(page, "Nothing imported yet."); },
  },
  {
    name: "keyboard focus on the primary action",
    open: async (page) => {
      await readyForm(page);
      await page.getByRole("button", { name: "Create campaign and import" }).focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
    },
  },
  {
    name: "hovering a lead row",
    open: async (page) => { await page.goto("/leads"); await settle(page, "Amira Hassan"); await page.getByRole("row", { name: /Amira Hassan/ }).hover(); },
  },
  {
    name: "every outreach status, a bad number and a newer email",
    open: async (page, data) => {
      const id = data.person("Amira Hassan");
      await page.route(`**/api/people/${id}`, (route) => respond(route, galleryRecord(id)));
      await page.goto(`/leads/people/${id}`);
      await settle(page, "Finished, no usable channel");
    },
  },
  // States added after verification round 3 (D4, D5).
  {
    name: "new campaign with the Businesses file in the People slot",
    open: async (page) => {
      await page.goto("/campaigns/new");
      await page.getByLabel("People file", { exact: true }).setInputFiles(fixture("businesses-run1.csv"));
      await settle(page, "This is the Businesses file.");
    },
  },
  {
    name: "new campaign with a malformed CSV",
    open: async (page) => {
      await page.goto("/campaigns/new");
      await page.getByLabel("People file", { exact: true }).setInputFiles({ name: "people-broken.csv", mimeType: "text/csv", buffer: Buffer.from('person_id,full_name\n"pp-1,Unclosed quote\n') });
      await settle(page, "is not valid CSV");
    },
  },
  {
    name: "a file dragged over its slot",
    open: async (page) => {
      await page.goto("/campaigns/new");
      const slot = page.getByText("People file", { exact: true }).locator("..");
      await slot.dispatchEvent("dragover", { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
      await page.locator(".bg-call-soft").first().waitFor();
    },
  },
  {
    name: "hovering the primary action",
    open: async (page) => { await readyForm(page); await page.getByRole("button", { name: "Create campaign and import" }).hover(); },
  },
  {
    name: "campaigns list with the longest accepted name",
    open: async (page) => { await page.goto("/campaigns"); await settle(page, LONG_CAMPAIGN_NAME); },
  },
  {
    name: "import again into a campaign with the longest accepted name",
    open: async (page, data) => { await page.goto(`/campaigns/${data.longCampaignId}/import`); await settle(page, `Import again into ${LONG_CAMPAIGN_NAME}`); },
  },
  {
    name: "import result for a campaign with the longest accepted name",
    open: async (page, data) => { await page.goto(`/campaigns/${data.longCampaignId}/imports/${data.longImportId}`); await settle(page, "What happened"); },
  },
  {
    name: "leads filtered to a campaign with the longest accepted name",
    open: async (page, data) => { await page.goto(`/leads?campaign=${data.longCampaignId}`); await settle(page, "Amira Hassan"); },
  },
  {
    name: "a person in a campaign with the longest accepted name",
    open: async (page, data) => { await page.goto(`/leads/people/${data.person("Amira Hassan")}`); await settle(page, LONG_CAMPAIGN_NAME); },
  },
  // The campaign editor and the timeline (ticket 12c). The running app has no email provider, so
  // a sender inbox, launch and sent email are shown on the app over the fake provider.
  {
    name: "campaign with an email track and no connected sender",
    open: async (page) => {
      // Its own campaign, so the shared scan campaigns keep no track.
      const created = await page.request.post("/api/campaigns", { data: { name: "No sender yet", businessesCsv: readFileSync(fixture("businesses-run1.csv"), "utf8"), peopleCsv: readFileSync(fixture("people-run1.csv"), "utf8") } });
      const id = ((await created.json()) as { campaign: { id: string } }).campaign.id;
      await page.request.put(`/api/campaigns/${id}/sequence`, {
        data: { timezone: "Europe/London", emailPool: [], tracks: [{ id: "email", channel: "email", window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })), steps: [{ id: "s1", waitDays: 0, subject: "Evening bookings at {{company}}", body: "Hi {{first_name|there}},", threading: "new_subject" }] }] },
      });
      await page.goto(`/campaigns/${id}?track=email&step=s1`);
      await settle(page, "No email provider is set up on this machine.");
    },
  },
  { name: "campaign, no track yet", open: async (page, data) => { await page.goto(`/campaigns/${data.campaignId}`); await settle(page, "Add the first channel track"); } },
  { name: "campaign with nothing imported", open: async (page, data) => { await page.goto(`/campaigns/${data.unimportedCampaignId}`); await settle(page, "nothing imported yet"); } },
  { name: "campaign with the longest accepted name", open: async (page, data) => { await page.goto(`/campaigns/${data.longCampaignId}`); await settle(page, "Add the first channel track"); } },
  { name: "before launch, nothing to launch", open: async (page, data) => { await page.goto(`/campaigns/${data.campaignId}/before-launch`); await settle(page, "Nothing to launch yet."); } },
  { name: "before launch with no leads", open: async (page, data) => { await page.goto(`/campaigns/${data.unimportedCampaignId}/before-launch`); await settle(page, "No leads yet."); } },
  { name: "test run, not yet", open: async (page, data) => { await page.goto(`/campaigns/${data.campaignId}/test-run`); await settle(page, "Test runs arrive with a later release"); } },
  { name: "campaign leads tab", open: async (page, data) => { await page.goto(`/campaigns/${data.campaignId}/leads`); await settle(page, "Uses a fallback for"); } },
  { name: "campaign leads tab, nothing imported", open: async (page, data) => { await page.goto(`/campaigns/${data.unimportedCampaignId}/leads`); await settle(page, "No leads yet."); } },
  { name: "campaign imports tab", open: async (page, data) => { await page.goto(`/campaigns/${data.campaignId}/imports`); await settle(page, "See result"); } },
  {
    name: "campaign loading",
    open: async (page, data) => { await hold(page, "**/api/campaigns/*/sequence"); await page.goto(`/campaigns/${data.campaignId}`); await page.getByLabel("Loading the campaign").waitFor(); },
  },
  {
    name: "campaign error",
    open: async (page, data) => { await fail(page, "**/api/campaigns/*/sequence"); await page.goto(`/campaigns/${data.campaignId}`); await settle(page, "This campaign didn’t load."); },
  },
  { name: "campaign not found", open: async (page) => { await page.goto("/campaigns/nobody"); await settle(page, "No such campaign"); } },
  {
    name: "person activity loading",
    open: async (page, data) => { await hold(page, "**/api/people/*/activity"); await page.goto(`/leads/people/${data.person("Amira Hassan")}`); await page.getByLabel("Loading the activity").waitFor(); },
  },
  {
    name: "person activity error",
    open: async (page, data) => { await fail(page, "**/api/people/*/activity"); await page.goto(`/leads/people/${data.person("Amira Hassan")}`); await settle(page, "The activity didn’t load."); },
  },
  { name: "fake provider: campaigns list with a running campaign", open: async (page) => { await fake(page, "/campaigns"); await settle(page, "Running"); } },
  { name: "fake provider: email track in the inspector", open: async (page) => { const f = await fakeProviderApp(); await fake(page, `/campaigns/${f.ready}?track=email`); await settle(page, "Timing and sender"); } },
  {
    name: "fake provider: a follow-up with a new subject",
    open: async (page) => {
      const f = await fakeProviderApp();
      await fake(page, `/campaigns/${f.ready}?track=email&step=s2`);
      await page.route("**/api/campaigns/*/sequence", (route) => (route.request().method() === "PUT" ? new Promise(() => undefined) : route.continue()));
      // The save is held here, never reaching the shared app, so leaving the page cannot send it.
      const held = page.waitForRequest((r) => r.method() === "PUT");
      await page.getByText("New subject", { exact: true }).click();
      await held;
      await settle(page, "Saving…");
    },
  },
  {
    name: "fake provider: a change that wasn't saved",
    open: async (page) => {
      const f = await fakeProviderApp();
      await fake(page, `/campaigns/${f.ready}?track=email`);
      await fail(page, "**/api/campaigns/*/sequence", "PUT");
      await page.getByLabel("Email 1 subject").fill("Evening bookings");
      await settle(page, "Your last change wasn’t saved.");
    },
  },
  {
    name: "fake provider: a wait that isn't a whole number of days",
    open: async (page) => {
      const f = await fakeProviderApp();
      await fake(page, `/campaigns/${f.ready}?track=email&step=s2`);
      await page.route("**/api/campaigns/*/sequence", (route) => (route.request().method() === "PUT" ? serverError(route) : route.continue()));
      await page.getByLabel("Days to wait before Email 2").fill("");
      await settle(page, "Nothing is saved until this is fixed.");
    },
  },
  { name: "fake provider: before launch, ready", open: async (page) => { const f = await fakeProviderApp(); await fake(page, `/campaigns/${f.ready}/before-launch`); await settle(page, "Ready to launch."); await settle(page, "Evening bookings at Harbour Lane Physio"); } },
  {
    name: "fake provider: before launch, copy for a company lead with fallbacks",
    open: async (page) => {
      const f = await fakeProviderApp();
      await fake(page, `/campaigns/${f.ready}/before-launch`);
      await page.getByLabel("Preview as lead").selectOption({ label: "Riverside Sports Clinic (company lead)" });
      await settle(page, "Hi there,");
    },
  },
  { name: "fake provider: before launch, blocked", open: async (page) => { const f = await fakeProviderApp(); await fake(page, `/campaigns/${f.blocked}/before-launch`); await settle(page, "2 things block launch."); } },
  { name: "fake provider: blocked email track in the inspector", open: async (page) => { const f = await fakeProviderApp(); await fake(page, `/campaigns/${f.blocked}?track=email&step=s1`); await settle(page, "Add a fallback or remove the field."); } },
  {
    name: "fake provider: before launch loading",
    open: async (page) => { const f = await fakeProviderApp(); await hold(page, "**/api/campaigns/*/before-launch*"); await fake(page, `/campaigns/${f.ready}/before-launch`); await page.getByLabel("Loading the checks before launch").waitFor(); },
  },
  {
    name: "fake provider: before launch error",
    open: async (page) => { const f = await fakeProviderApp(); await fail(page, "**/api/campaigns/*/before-launch*"); await fake(page, `/campaigns/${f.ready}/before-launch`); await settle(page, "The checks before launch didn’t load."); },
  },
  {
    name: "fake provider: copy for a lead loading",
    open: async (page) => { const f = await fakeProviderApp(); await hold(page, "**/api/campaigns/*/preview/*"); await fake(page, `/campaigns/${f.ready}/before-launch`); await page.getByLabel("Loading the copy").waitFor(); },
  },
  {
    name: "fake provider: launch failed",
    open: async (page) => {
      const f = await fakeProviderApp();
      await fail(page, "**/api/campaigns/*/launch");
      await fake(page, `/campaigns/${f.ready}/before-launch`);
      await page.getByRole("button", { name: "Launch campaign" }).click();
      await settle(page, "The campaign didn’t launch.");
    },
  },
  {
    name: "fake provider: before launch, an email track and an SMS track that start together",
    open: async (page) => {
      const f = await fakeProviderApp("sms-screen");
      const id = await f.freshCampaign("Podiatrists, Exeter");
      const email = (await f.harness.request<SequenceView>("GET", `/api/campaigns/${id}/sequence`)).body.definition;
      const sms = { id: "sms", channel: "sms" as const, branch: "main" as const, window: email.tracks[0]!.window, steps: [{ id: "m1", waitDays: 0, subject: "", body: "Hi {{first_name|there}}, a quick text about evening booking.", threading: "new_subject" as const, removed: false }], start: { kind: "entry" as const }, removed: false };
      await f.harness.defineSequence(id, { ...email, smsPool: [...FAKE_NUMBERS], tracks: [...email.tracks, sms] });
      await page.goto(`${f.url}/campaigns/${id}/before-launch`);
      await settle(page, "start within");
    },
  },
  { name: "fake provider: running campaign", open: async (page) => { const f = await fakeProviderApp(); await fake(page, `/campaigns/${f.running}`); await settle(page, "Pausing, resuming and editing a running campaign arrive with later releases."); } },
  { name: "fake provider: running campaign's email track", open: async (page) => { const f = await fakeProviderApp(); await fake(page, `/campaigns/${f.running}?track=email`); await settle(page, "Editing a running campaign arrives with a later release."); } },
  {
    name: "fake provider: before launch with a change that isn't saved",
    open: async (page) => {
      const f = await fakeProviderApp();
      await fake(page, `/campaigns/${f.ready}?track=email`);
      await fail(page, "**/api/campaigns/*/sequence", "PUT");
      await page.getByLabel("Email 1 subject").fill("Evening bookings");
      await settle(page, "Your last change wasn’t saved.");
      await page.getByRole("link", { name: /Before launch/ }).click();
      await settle(page, "Your latest change isn’t saved, so launch waits.");
    },
  },
  {
    name: "fake provider: a running campaign's later email, read-only",
    open: async (page) => { const f = await fakeProviderApp(); await fake(page, `/campaigns/${f.running}?track=email&step=s2`); await settle(page, "Editing a running campaign arrives with a later release."); },
  },
  { name: "fake provider: a running campaign's leads, with their outreach status", open: async (page) => { const f = await fakeProviderApp(); await fake(page, `/campaigns/${f.running}/leads`); await settle(page, "Replied, automation stopped"); } },
  {
    name: "fake provider: before launch while an inbox cannot send, with no projection",
    open: async (page) => {
      // Its own app: the inbox the provider reports unable to send would block the shared campaigns.
      const f = await fakeProviderApp("cannot-send");
      f.harness.fake.accountsById.get(FAKE_INBOX)!.healthy = false;
      await f.harness.tick();
      await page.goto(`${f.url}/campaigns/${f.ready}/before-launch`);
      await settle(page, "Can’t project the load while");
    },
  },
  {
    name: "fake provider: a tab whose campaign was changed elsewhere",
    open: async (page) => {
      // Its own app: another session's save changes the campaign after this tab loaded it.
      const f = await fakeProviderApp("changed-elsewhere");
      await page.goto(`${f.url}/campaigns/${f.ready}?track=email&step=s1`);
      await page.getByLabel("Email 1 subject").waitFor();
      const current = (await f.harness.request<SequenceView>("GET", `/api/campaigns/${f.ready}/sequence`)).body;
      await f.harness.request("PUT", `/api/campaigns/${f.ready}/sequence`, { ...current.definition, save: { session: `other-${Date.now()}`, seq: 1, base: current.definitionVersion } });
      await page.getByLabel("Email 1 copy").fill("Typed here after the other tab saved.");
      await settle(page, "This campaign was changed elsewhere since this page loaded it.");
    },
  },
  { name: "fake provider: running campaign, before launch", open: async (page) => { const f = await fakeProviderApp(); await fake(page, `/campaigns/${f.running}/before-launch`); await settle(page, "The projection is for before launch."); } },
  {
    name: "fake provider: sent emails, the copy shown, and the sequence finished",
    open: async (page) => {
      const f = await fakeProviderApp();
      await fake(page, `/leads/people/${f.person("Amira Hassan")}`);
      await page.getByText("Show message").first().click();
      await settle(page, "Hide message");
    },
  },
  { name: "fake provider: a hard bounce", open: async (page) => { const f = await fakeProviderApp(); await fake(page, `/leads/people/${f.person("Tom")}`); await settle(page, "Email 1 bounced"); } },
  { name: "fake provider: replied, automation stopped", open: async (page) => { const f = await fakeProviderApp(); await fake(page, `/leads/people/${f.person("Daniel Price")}`); await settle(page, "Replied by email"); } },
  { name: "fake provider: email skipped for a missing address", open: async (page) => { const f = await fakeProviderApp(); await fake(page, `/leads/people/${f.person("Grace Okafor")}`); await settle(page, "Email track skipped"); } },
  { name: "fake provider: a company lead's activity", open: async (page) => { const f = await fakeProviderApp(); await fake(page, `/leads/companies/${f.company("Riverside Sports Clinic")}`); await settle(page, "Email 1 sent"); } },
  // Ticket 13b: every track on the canvas, SMS tracks and connections, Before launch and Activity on
  // both channels. On the running app there is no SMS provider, so SMS tracks have no sender.
  {
    name: "campaign with email and SMS tracks, and no SMS provider",
    open: async (page) => {
      const id = await campaignWith(page, "Two channels, no provider");
      await page.goto(`/campaigns/${id}?track=sms&step=m1`);
      await settle(page, "No SMS provider is set up, so no number can be connected yet.");
    },
  },
  {
    name: "before launch with an SMS track and no SMS provider",
    open: async (page) => {
      const id = await campaignWith(page, "Two channels, no provider");
      await page.goto(`/campaigns/${id}/before-launch`);
      await settle(page, "The SMS track has no connected sender number");
    },
  },
  {
    name: "a track that starts after another, in the inspector",
    open: async (page) => {
      const id = await campaignWith(page, "Two channels, no provider");
      await page.goto(`/campaigns/${id}?track=email-2&step=none`);
      await settle(page, "Counted from when that track has sent its last step");
    },
  },
  {
    name: "a connection refused because it would go in a circle",
    open: async (page) => {
      const id = await campaignWith(page, "Two channels, no provider");
      await page.goto(`/campaigns/${id}?track=sms&step=none`);
      await page.getByLabel("How this track starts").selectOption({ label: "After email track 2" });
      await settle(page, "each would wait for the other");
    },
  },
  {
    name: "removing a track another starts after, refused",
    open: async (page) => {
      const id = await campaignWith(page, "Two channels, no provider");
      await page.goto(`/campaigns/${id}?track=sms&step=none`);
      await page.getByRole("button", { name: "Remove this SMS track" }).click();
      await settle(page, "Change how it starts first.");
    },
  },
  {
    name: "a phone track, which this editor cannot edit yet",
    open: async (page) => {
      const id = await campaignWith(page, "Two channels and a call", {
        ...TWO_CHANNELS,
        emailPool: [],
        smsPool: [],
        tracks: [...TWO_CHANNELS.tracks, { id: "call", channel: "call", branch: "main", window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })), start: { kind: "after", trackId: "email", delayDays: 1 }, removed: false, steps: [{ id: "c1", waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false }] }],
      });
      await page.goto(`/campaigns/${id}?track=call`);
      await settle(page, "Phone tracks are edited with a later release.");
    },
  },
  {
    // Over the fake providers, so every track has a sender and only the call holds the figure back.
    name: "fake provider: before launch with a track that waits on a call",
    open: async (page) => {
      const f = await fakeProviderApp("a-track-after-a-call");
      const id = await f.freshTwoChannelCampaign("A track after a call");
      const call = { id: "call", channel: "call" as const, branch: "main" as const, window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })), start: { kind: "after" as const, trackId: "email", delayDays: 1 }, removed: false, steps: [{ id: "c1", waitDays: 0, subject: "", body: "", threading: "new_subject" as const, removed: false }] };
      const definition = { ...TWO_CHANNELS, tracks: [...TWO_CHANNELS.tracks.map((t) => (t.id === "email-2" ? { ...t, start: { kind: "after" as const, trackId: "call", delayDays: 0 } } : t)), call] };
      await page.request.put(`${f.url}/api/campaigns/${id}/sequence`, { data: definition });
      await page.goto(`${f.url}/campaigns/${id}/before-launch`);
      await settle(page, "which finishes only when you log the call");
    },
  },
  // Chains the outline must fit at every width (review bot on 7401eb2): four tracks deep, as the bot
  // reported, and twelve, deeper than any width indents, so every deeper chain is drawn alike.
  ...([4, 12] as const).flatMap((n) =>
    [true, false].map((open) => ({
      name: `a chain of ${n} tracks, ${open ? "the last one in the inspector" : "the inspector closed"}`,
      open: async (page: Page) => {
        const id = await campaignWith(page, `A chain of ${n}`, chainOf(n));
        await page.goto(`/campaigns/${id}${open ? `?track=t${n - 1}&step=none` : ""}`);
        await settle(page, open ? "Counted from when that track has sent its last step" : "together or after");
      },
    })),
  ),
  {
    name: "the Add track menu",
    open: async (page) => {
      const id = await campaignWith(page, "Two channels, no provider");
      await page.goto(`/campaigns/${id}`);
      await page.getByRole("button", { name: "Add track" }).click();
      await settle(page, "Phone tracks arrive with a later release.");
    },
  },
  { name: "fake provider: every track on the canvas, running", open: async (page) => { const f = await fakeProviderApp(); await fake(page, `/campaigns/${f.twoChannels}`); await settle(page, "Email track 2"); } },
  { name: "fake provider: a running campaign's SMS track, read-only", open: async (page) => { const f = await fakeProviderApp(); await fake(page, `/campaigns/${f.twoChannels}?track=sms`); await settle(page, "Editing a running campaign arrives with a later release."); } },
  { name: "fake provider: an SMS track with its numbers, in the inspector", open: async (page) => { const f = await fakeProviderApp(); await fake(page, `/campaigns/${f.twoChannelsReady}?track=sms`); await settle(page, "texts a day across campaigns"); } },
  { name: "fake provider: before launch on both channels", open: async (page) => { const f = await fakeProviderApp(); await fake(page, `/campaigns/${f.twoChannelsReady}/before-launch`); await settle(page, "Simulated SMS"); await settle(page, "Text 1"); } },
  {
    name: "fake provider: copy for a lead with no mobile, its SMS track skipped",
    open: async (page) => {
      const f = await fakeProviderApp();
      await fake(page, `/campaigns/${f.twoChannelsReady}/before-launch`);
      await page.getByLabel("Preview as lead").selectOption({ label: "Hugo Grant" });
      await settle(page, "Skipped: this lead has no mobile of their own to text.");
    },
  },
  {
    name: "fake provider: before launch while an SMS number is disconnected",
    open: async (page) => {
      // Its own app: a disconnected number would change the shared campaigns.
      const f = await fakeProviderApp("number-disconnected");
      const n = f.harness.sms.numbers.get(FAKE_NUMBERS[1]);
      if (n) n.healthy = false;
      await f.harness.tick();
      await page.goto(`${f.url}/campaigns/${f.twoChannelsReady}/before-launch`);
      await settle(page, "Can’t project the load while");
    },
  },
  { name: "fake provider: a text reply stops email and SMS", open: async (page) => { const f = await fakeProviderApp(); await fake(page, `/leads/people/${f.smsPerson("Priya Shah")}`); await settle(page, "Replied by text"); } },
  { name: "fake provider: a bad number, and the track after it released", open: async (page) => { const f = await fakeProviderApp(); await fake(page, `/leads/people/${f.smsPerson("Ben Cole")}`); await settle(page, "Text 1: bad number"); } },
  { name: "fake provider: an SMS track skipped for want of a mobile", open: async (page) => { const f = await fakeProviderApp(); await fake(page, `/leads/people/${f.smsPerson("Lena Ford")}`); await settle(page, "SMS track skipped"); } },
  {
    name: "fake provider: a sent text, shown",
    open: async (page) => {
      const f = await fakeProviderApp();
      await fake(page, `/leads/people/${f.smsPerson("Owen Hale")}`);
      await page.getByRole("listitem").filter({ hasText: "Text 2 sent" }).getByText("Show message").click();
      await settle(page, "A yes is enough.");
    },
  },
  { name: "record not found", open: async (page) => { await page.goto("/leads/people/nobody"); await settle(page, "No one found"); } },
  { name: "page not found", open: async (page) => { await page.goto("/nowhere"); await settle(page, "Page not found"); } },
];

/**
 * Standing check (e2e/focus.spec.ts): a keyboard action that removes or replaces the focused
 * control must move focus somewhere deliberate, never to the page body. Add each such transition
 * here with the control that should hold focus afterwards.
 */
export interface FocusTransition {
  readonly name: string;
  readonly open: (page: Page, data: SeedData) => Promise<void>;
  /** The keyboard action, starting from the control it focuses. */
  readonly act: (page: Page) => Promise<void>;
  /** What holds focus afterwards. */
  readonly focused: (page: Page) => Locator;
}

/** The call the "next call fails to load" transition logs, whose own reads still succeed. */
let loadErrorCall = "";

export const FOCUS_TRANSITIONS: readonly FocusTransition[] = [
  {
    name: "the chosen number invalidated under the keyboard moves focus to a number that can still be chosen (re-check on b15a769)",
    open: async (page) => {
      const f = await freshCalls("ready", "focus-number-gone");
      await page.goto(`${f.url}/calls`);
      await page.getByText(/^Calling hours /).waitFor();
      // Chosen from the keyboard: the mobile is first, the main line next.
      await page.getByRole("radio", { name: /7700 900101/ }).focus();
      await page.keyboard.press("ArrowDown");
      await page.getByRole("radio", { name: /7946 0101/, checked: true }).waitFor();
      (page as Page & { calls?: FakeCallsApp }).calls = f;
    },
    act: async (page) => {
      const f = (page as Page & { calls?: FakeCallsApp }).calls!;
      const tom = (await f.harness.request<{ readyNow: { taskId: string; person: { name: string } | null }[] }>("GET", "/api/calls")).body.readyNow.find((x) => x.person?.name === "Tom");
      const main = (await f.harness.request<{ numbers: { detailId: string; kind: string }[] }>("GET", `/api/call-tasks/${tom?.taskId}`)).body.numbers.find((n) => n.kind === "main_line");
      await logElsewhere(f, tom?.taskId ?? "", "wrong_number", main?.detailId ?? null);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.getByText("is now marked wrong").waitFor();
    },
    focused: (page) => page.getByRole("radio", { name: /7700 900101/ }),
  },
  {
    name: "a retry that succeeds after the call failed to load moves focus to the call's number (re-check on b15a769)",
    open: async (page) => {
      const f = await freshCalls("ready", "focus-retry");
      await page.route("**/api/call-tasks/*", (route) => (route.request().method() === "GET" ? serverError(route) : route.continue()));
      await page.goto(`${f.url}/calls`);
      await page.getByText("This call didn’t load.").waitFor();
    },
    act: async (page) => {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.getByRole("button", { name: "Try again" }).focus();
      await page.keyboard.press("Enter");
      await page.getByText(/^Calling hours /).waitFor();
    },
    focused: (page) => page.getByRole("group", { name: "Number you dial" }).getByRole("radio", { checked: true }),
  },
  {
    name: "dismissing the last kept refusal moves focus to the call's number (re-check on b15a769)",
    open: async (page) => {
      const f = await freshCalls("ready", "focus-dismiss");
      const t = await focused(f);
      await logElsewhere(f, t.taskId, "interested", t.numberId);
      await page.addInitScript(([taskId, numberId]) => {
        const body = { requestId: "left-by-a-closed-tab", outcome: "no_answer", numberId, note: "Front desk.", noteScope: "person" };
        window.localStorage.setItem("outreach.calls.outbox.left-by-a-closed-tab", JSON.stringify({ v: 2, taskId, who: "Amira Hassan", body }));
      }, [t.taskId, t.numberId] as const);
      await page.goto(`${f.url}/calls`);
      await page.getByRole("button", { name: "Dismiss" }).waitFor();
      await page.getByText(/^Calling hours /).waitFor();
    },
    act: async (page) => {
      await page.getByRole("button", { name: "Dismiss" }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Dismiss" }).waitFor({ state: "detached" });
    },
    focused: (page) => page.getByRole("group", { name: "Number you dial" }).getByRole("radio", { checked: true }),
  },
  {
    name: "logging an outcome when the next call fails to load moves focus to its Try again (verifier on e6872eb)",
    open: async (page) => {
      const f = await freshCalls("ready", "focus-load-error");
      loadErrorCall = (await focused(f)).taskId;
      await page.goto(`${f.url}/calls`);
      await page.getByText(/^Calling hours /).waitFor();
    },
    act: async (page) => {
      // Reads of the next call fail; the call just logged is still read, so the page learns its outcome is stored.
      await page.route("**/api/call-tasks/*", (route) => (route.request().method() === "GET" && !route.request().url().includes(loadErrorCall) ? serverError(route) : route.continue()));
      await page.getByRole("button", { name: "No answer", exact: true }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Log and open next call" }).focus();
      await page.keyboard.press("Enter");
      await page.getByText("This call didn’t load.").waitFor();
    },
    focused: (page) => page.getByRole("button", { name: "Try again" }),
  },
  // The calling loop (ticket 14b): every transition that replaces the controls under the keyboard.
  {
    name: "logging an outcome by keyboard moves focus to the next call's number",
    open: async (page) => { const f = await freshCalls("ready", "focus-logged"); await page.goto(`${f.url}/calls`); await page.getByText(/^Calling hours /).waitFor(); },
    act: async (page) => {
      await page.getByRole("button", { name: "No answer", exact: true }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Log and open next call" }).focus();
      await page.keyboard.press("Enter");
      await page.getByText("no answer logged").waitFor();
      await page.getByRole("heading", { name: "Tom" }).waitFor();
    },
    focused: (page) => page.getByRole("group", { name: "Number you dial" }).getByRole("radio", { checked: true }),
  },
  {
    name: "while an outcome is pending, focus stays on Log, which says it is logging",
    open: async (page) => { const f = await freshCalls("ready", "focus-pending"); await page.goto(`${f.url}/calls`); await page.getByText(/^Calling hours /).waitFor(); },
    act: async (page) => {
      await page.route("**/api/call-tasks/*/outcome", () => new Promise(() => undefined));
      await page.getByRole("button", { name: "Left voicemail", exact: true }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Log and open next call" }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Logging…" }).waitFor();
    },
    focused: (page) => page.getByRole("button", { name: "Logging…" }),
  },
  {
    name: "logging the last call moves focus to Back to Today",
    open: async (page) => {
      const f = await freshCalls("full", "focus-last");
      const t = await focused(f);
      await logElsewhere(f, t.taskId, "no_answer", t.numberId);
      await page.goto(`${f.url}/calls`);
      await page.getByText(/^Calling hours /).waitFor();
    },
    act: async (page) => {
      await page.getByRole("button", { name: "Skip for now", exact: true }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Log and open next call" }).focus();
      await page.keyboard.press("Enter");
      await page.getByText("skipped for now").waitFor();
      // The only call left is the one skipped: it opens again. Interested ends it.
      await page.getByRole("button", { name: "Interested", exact: true }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Log and open next call" }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("heading", { name: "List done" }).waitFor();
    },
    focused: (page) => page.getByRole("link", { name: "Back to Today" }),
  },
  {
    name: "a refused outcome moves focus to Open the next call",
    open: async (page) => { const f = await freshCalls("ready", "focus-refused"); await page.goto(`${f.url}/calls`); await page.getByText(/^Calling hours /).waitFor(); const t = await focused(f); await logElsewhere(f, t.taskId, "voicemail", t.numberId); },
    act: async (page) => {
      await page.getByRole("button", { name: "No answer", exact: true }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Log and open next call" }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Open the next call" }).waitFor();
    },
    focused: (page) => page.getByRole("button", { name: "Open the next call" }),
  },
  {
    name: "opening the next call after a refusal moves focus to its number",
    open: async (page) => {
      const f = await freshCalls("ready", "focus-move-on");
      await page.goto(`${f.url}/calls`);
      await page.getByText(/^Calling hours /).waitFor();
      const t = await focused(f);
      await logElsewhere(f, t.taskId, "voicemail", t.numberId);
      await logWithMouse(page, "No answer");
      await page.getByRole("button", { name: "Open the next call" }).waitFor();
    },
    act: async (page) => {
      await page.getByRole("button", { name: "Open the next call" }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("heading", { name: "Tom" }).waitFor();
    },
    focused: (page) => page.getByRole("group", { name: "Number you dial" }).getByRole("radio", { checked: true }),
  },
  {
    name: "removing an email moves focus to the email that takes its place",
    open: async (page) => { const f = await fakeProviderApp(); await fake(page, `/campaigns/${f.ready}?track=email&step=s2`); await settle(page, "Timing and sender"); },
    act: async (page) => {
      // Held, so the shared campaign keeps both emails.
      await page.route("**/api/campaigns/*/sequence", (route) => (route.request().method() === "PUT" ? new Promise(() => undefined) : route.continue()));
      const held = page.waitForRequest((r) => r.method() === "PUT");
      await page.getByRole("button", { name: "Remove Email 2" }).focus();
      await page.keyboard.press("Enter");
      await held;
    },
    focused: (page) => page.getByRole("button", { name: /^Email 1/ }),
  },
  {
    name: "adding the first email track moves focus into the inspector, to Email 1's subject",
    open: async (page, data) => { await page.goto(`/campaigns/${data.unimportedCampaignId}`); await settle(page, "Add the first channel track"); },
    act: async (page) => {
      // The track is not saved: the scan's campaign stays without one.
      await page.route("**/api/campaigns/*/sequence", (route) => (route.request().method() === "PUT" ? new Promise(() => undefined) : route.continue()));
      const held = page.waitForRequest((r) => r.method() === "PUT");
      await page.getByRole("button", { name: "Email track" }).focus();
      await page.keyboard.press("Enter");
      await held;
    },
    focused: (page) => page.getByLabel("Email 1 subject"),
  },
  {
    name: "closing the inspector returns focus to the track it showed",
    open: async (page) => { const f = await fakeProviderApp(); await fake(page, `/campaigns/${f.ready}?track=email`); await settle(page, "Timing and sender"); },
    act: async (page) => {
      await page.getByRole("button", { name: "Close the email track" }).focus();
      await page.keyboard.press("Enter");
    },
    focused: (page) => page.getByRole("button", { name: /^Email track: / }),
  },
  {
    name: "loading the saved version after a conflict moves focus to Email 1's subject, as the alert and its button go (re-check F8)",
    open: async (page) => {
      const f = await fakeProviderApp("focus");
      const id = await f.freshCampaign(`Focus load ${Date.now()}`);
      await page.goto(`${f.url}/campaigns/${id}?track=email&step=s1`);
      await settle(page, "Timing and sender");
      // Another page saves first; this one's edit is then refused.
      const other = (await f.harness.request<SequenceView>("GET", `/api/campaigns/${id}/sequence`)).body.definition;
      await f.harness.defineSequence(id, { ...other, tracks: other.tracks.map((t) => ({ ...t, steps: t.steps.map((s, i) => (i === 0 ? { ...s, subject: "Saved on another page" } : s)) })) });
      await page.getByLabel("Email 1 copy").fill("Typed on the stale page");
      await page.getByRole("button", { name: "Load the saved version" }).waitFor();
    },
    act: async (page) => {
      await page.getByRole("button", { name: "Load the saved version" }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Load the saved version" }).waitFor({ state: "detached" });
    },
    focused: (page) => page.getByLabel("Email 1 subject"),
  },
  {
    name: "while a keyboard launch is pending, focus stays on the Launch button, which says it is launching (re-check 4, F8)",
    open: async (page) => {
      const f = await fakeProviderApp("focus");
      const id = await f.freshCampaign(`Focus pending launch ${Date.now()}`);
      await page.goto(`${f.url}/campaigns/${id}/before-launch`);
      await page.getByRole("button", { name: "Launch campaign" }).and(page.locator(":enabled")).waitFor();
    },
    act: async (page) => {
      // The launch never answers here: this is the moment between the press and the answer.
      await page.route("**/api/campaigns/*/launch", () => undefined);
      const asked = page.waitForRequest((r) => r.url().endsWith("/launch"));
      await page.getByRole("button", { name: "Launch campaign" }).focus();
      await page.keyboard.press("Enter");
      await asked;
      await page.getByRole("button", { name: "Launching…" }).waitFor();
    },
    focused: (page) => page.getByRole("button", { name: "Launching…" }),
  },
  {
    name: "launching from the keyboard moves focus to the launch line, which says it launched, as the button goes (re-check F8)",
    open: async (page) => {
      const f = await fakeProviderApp("focus");
      const id = await f.freshCampaign(`Focus launch ${Date.now()}`);
      await page.goto(`${f.url}/campaigns/${id}/before-launch`);
      await page.getByRole("button", { name: "Launch campaign" }).and(page.locator(":enabled")).waitFor();
    },
    act: async (page) => {
      await page.getByRole("button", { name: "Launch campaign" }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Launch campaign" }).waitFor({ state: "detached" });
    },
    focused: (page) => page.locator("p[tabindex='-1']", { hasText: /^Launched / }),
  },
  {
    name: "closing a running campaign's inspector returns focus to the track",
    open: async (page) => { const f = await fakeProviderApp(); await fake(page, `/campaigns/${f.running}?track=email`); await settle(page, "Timing and sender"); },
    act: async (page) => {
      await page.getByRole("button", { name: "Close the email track" }).focus();
      await page.keyboard.press("Enter");
    },
    focused: (page) => page.getByRole("button", { name: /^Email track: / }),
  },
  // Ticket 13b: adding, removing and connecting tracks.
  {
    name: "adding an SMS track from the empty canvas moves focus to Text 1's message",
    open: async (page) => {
      const id = await campaignWith(page, "Focus: first SMS track", { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: [], smsPool: [], tracks: [] });
      await page.goto(`/campaigns/${id}`);
      await page.getByRole("button", { name: "SMS track" }).focus();
    },
    act: (page) => page.keyboard.press("Enter"),
    focused: (page) => page.getByLabel("Text 1 message"),
  },
  {
    name: "adding a track from the Add track menu moves focus into the new track",
    open: async (page) => {
      const id = await campaignWith(page, "Focus: add a track");
      await page.goto(`/campaigns/${id}`);
      await page.getByRole("button", { name: "Add track" }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: "SMS track" }).focus();
    },
    act: (page) => page.keyboard.press("Enter"),
    focused: (page) => page.getByLabel("Text 1 message"),
  },
  {
    name: "Down on Add track opens its menu on the first item (menu button pattern, council on 10121d3, item 4)",
    open: async (page) => {
      const id = await campaignWith(page, "Focus: menu opens");
      await page.goto(`/campaigns/${id}`);
      await page.getByRole("button", { name: "Add track" }).focus();
    },
    act: (page) => page.keyboard.press("ArrowDown"),
    focused: (page) => page.getByRole("menuitem", { name: "Email track" }),
  },
  {
    name: "Up on Add track opens its menu on the last item, the disabled phone track that says why",
    open: async (page) => {
      const id = await campaignWith(page, "Focus: menu opens on last");
      await page.goto(`/campaigns/${id}`);
      await page.getByRole("button", { name: "Add track" }).focus();
    },
    act: (page) => page.keyboard.press("ArrowUp"),
    focused: (page) => page.getByRole("menuitem", { name: /^Phone track/, description: "Phone tracks arrive with a later release." }),
  },
  {
    name: "Down and Up move between the menu's items, wrapping",
    open: async (page) => {
      const id = await campaignWith(page, "Focus: menu moves");
      await page.goto(`/campaigns/${id}`);
      await page.getByRole("button", { name: "Add track" }).focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("ArrowUp");
    },
    act: (page) => page.keyboard.press("ArrowDown"),
    focused: (page) => page.getByRole("menuitem", { name: "Email track" }),
  },
  {
    name: "Escape closes the Add track menu and returns focus to Add track",
    open: async (page) => {
      const id = await campaignWith(page, "Focus: add track menu");
      await page.goto(`/campaigns/${id}`);
      await page.getByRole("button", { name: "Add track" }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: "Email track" }).focus();
    },
    act: (page) => page.keyboard.press("Escape"),
    focused: (page) => page.getByRole("button", { name: "Add track" }),
  },
  {
    name: "removing a track moves focus to Add track",
    open: async (page) => {
      const id = await campaignWith(page, "Focus: remove a track");
      await page.goto(`/campaigns/${id}?track=email-2&step=none`);
      await page.getByRole("button", { name: "Remove email track 2" }).focus();
    },
    act: (page) => page.keyboard.press("Enter"),
    focused: (page) => page.getByRole("button", { name: "Add track" }),
  },
  {
    name: "a refused removal keeps focus on Remove, which the reason describes",
    open: async (page) => {
      const id = await campaignWith(page, "Focus: removal refused");
      await page.goto(`/campaigns/${id}?track=sms&step=none`);
      await page.getByRole("button", { name: "Remove this SMS track" }).focus();
    },
    act: (page) => page.keyboard.press("Enter"),
    focused: (page) => page.getByRole("button", { name: "Remove this SMS track", description: "Email track 2 starts after this one. Change how it starts first." }),
  },
  {
    name: "a connection refused as a circle keeps focus on the Starts control, which the reason describes",
    open: async (page) => {
      const id = await campaignWith(page, "Focus: circle refused");
      await page.goto(`/campaigns/${id}?track=sms&step=none`);
      await page.getByLabel("How this track starts").focus();
    },
    act: (page) => page.getByLabel("How this track starts").selectOption({ label: "After email track 2" }).then(() => undefined),
    focused: (page) => page.getByRole("combobox", { name: "How this track starts", description: /each would wait for the other/ }),
  },
  {
    name: "closing an SMS track's inspector returns focus to its track",
    open: async (page) => {
      const id = await campaignWith(page, "Focus: close SMS track");
      await page.goto(`/campaigns/${id}?track=sms&step=none`);
      await page.getByRole("button", { name: "Close the SMS track" }).focus();
    },
    act: (page) => page.keyboard.press("Enter"),
    focused: (page) => page.getByRole("button", { name: /^SMS track: / }),
  },
];
