import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../src/domain/sequence/definition.ts";
import type { LeadSearchResult } from "../src/shared/api.ts";
import { linkedinAccountId } from "../src/server/engine/ports.ts";
import { EngineHarness } from "../test/support/engine-harness.ts";
import { business, person } from "../test/support/export-builder.ts";
import { FAKE_INBOX, serveHarness } from "./fake-provider.ts";

/**
 * Ticket 24b's browser world: the app over a **simulated** LinkedIn provider (test/support/fake-linkedin-port.ts), labelled
 * "Simulated LinkedIn (not a session)" wherever a sender is named, beside the fake email provider. No LinkedIn session is
 * connected anywhere: the running application registers none, and this world exists only in the test worker. Every
 * person, company and profile URL is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
/** Monday 2 November 2026, 08:00 in London (GMT). */
export const LI_MONDAY_8 = Date.parse("2026-11-02T08:00:00Z");
export const SESSION = "li-session-1";
export const SESSION_ID = linkedinAccountId(SESSION);
export const TEST_PROFILE = "https://www.linkedin.com/in/fictional-own-test-profile";
const profile = (slug: string) => `https://www.linkedin.com/in/fictional-${slug}`;
export const PROFILES = { pat: profile("pat-oneil"), nia: profile("nia-cole"), sam: profile("sam-lee"), ola: profile("ola-berg"), ivo: profile("ivo-marsh") } as const;

const BUSINESSES = [business({ business_id: "bz-harbour-li-0001", business_name: "Harbour Lane Physio", city: "Bristol", phone_e164: "+441174960301", phone_original: "0117 496 0301" })];
const PEOPLE = [
  person({ person_id: "pl-pat", business_id: "bz-harbour-li-0001", full_name: "Pat Oneil", title: "Practice owner", email: "pat@harbourlane.example", linkedin_url: PROFILES.pat }),
  person({ person_id: "pl-nia", business_id: "bz-harbour-li-0001", full_name: "Nia Cole", title: "Clinic manager", linkedin_url: PROFILES.nia }),
  person({ person_id: "pl-sam", business_id: "bz-harbour-li-0001", full_name: "Sam Lee", title: "Physiotherapist", email: "sam@harbourlane.example", linkedin_url: PROFILES.sam }),
  person({ person_id: "pl-kim", business_id: "bz-harbour-li-0001", full_name: "Kim Hart", title: "Receptionist", email: "kim@harbourlane.example", linkedin_url: "https://www.linkedin.com/company/fictional-harbour-lane" }),
  person({ person_id: "pl-ola", business_id: "bz-harbour-li-0001", full_name: "Ola Berg", title: "Physiotherapist", email: "ola@harbourlane.example", linkedin_url: PROFILES.ola }),
  person({ person_id: "pl-ivo", business_id: "bz-harbour-li-0001", full_name: "Ivo Marsh", title: "Sports therapist", email: "ivo@harbourlane.example", linkedin_url: PROFILES.ivo }),
];

const step = (id: string, waitDays: number, body: string): StepDefinition => ({ id, waitDays, subject: "", body, threading: "new_subject", removed: false });
const WEEKDAYS = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
export const LINKEDIN_TRACK: TrackDefinition = {
  id: "li",
  channel: "linkedin",
  branch: "main",
  window: WEEKDAYS,
  start: { kind: "entry" },
  removed: false,
  acceptWaitDays: 3,
  steps: [
    step("li-invite", 0, "Hi {{first_name|there}}, I work with physio clinics like {{company}} on evening bookings. Happy to connect."),
    step("li-m1", 0, "Thanks for connecting, {{first_name|there}}. Would a two-minute video of evening booking for {{company}} be useful?"),
    step("li-m2", 2, "{{first_name|Hi}}, shall I send the video over? A yes is enough."),
  ],
};
const EMAIL_AFTER: TrackDefinition = {
  id: "em",
  channel: "email",
  branch: "main",
  window: WEEKDAYS,
  start: { kind: "after", trackId: "li", delayDays: 1 },
  removed: false,
  steps: [{ id: "em-1", waitDays: 0, subject: "Evening bookings at {{company}}", body: "Hi {{first_name|there}},\n\nA short note on evening booking for {{company}}.\n\nAlex", threading: "new_subject", removed: false }],
};
export const LINKEDIN_DEFINITION: CampaignDefinition = { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: [FAKE_INBOX], smsPool: [], linkedinPool: [SESSION_ID], tracks: [LINKEDIN_TRACK, EMAIL_AFTER] };

/**
 * `fresh`: leads imported, no sequence (the canvas from empty). `ready`: the LinkedIn sequence, not launched, with the user's
 * test profile saved. `running`: launched, Wednesday noon (Pat connected, Nia and Ivo waiting for acceptance, Ola stopped
 * with her invite open, a second campaign skipping Pat). `later`: the same, Friday noon (Nia's withdrawal stuck at unknown,
 * Ivo's acceptance recorded after his track ended). `testing`: `ready`, with a test run whose invite went to the test profile
 * and waits for the user to accept it. `test-stuck`: `ready`, with a test run whose invite was never accepted and whose
 * withdrawal LinkedIn keeps answering unknown, so the run finished with its withdrawal stuck. `launched`: `running`, read on
 * Monday at 10:00, its first day.
 */
export type LinkedinScenario = "fresh" | "ready" | "testing" | "test-stuck" | "launched" | "running" | "later";

export interface FakeLinkedinApp {
  readonly url: string;
  readonly h: EngineHarness;
  readonly campaign: string;
  /** The second campaign that meets Pat on the same session after the first reached them ("running" only). */
  readonly second: string | null;
  readonly person: (name: string) => Promise<string>;
  readonly enrollment: (name: string, campaignId?: string) => Promise<string>;
}

const started = new Map<string, Promise<FakeLinkedinApp>>();

/** One app per name and test worker, seeded once. */
/** The session's allowances: the world's own unless given; `null` leaves them never set (ADR 0004 1.2: no default). */
type Allowances = { readonly invitesPerDay: number; readonly messagesPerDay: number; readonly notesPerMonth: number } | null;
const WORLD_ALLOWANCES: Allowances = { invitesPerDay: 20, messagesPerDay: 20, notesPerMonth: 1 };

export function fakeLinkedinApp(scenario: LinkedinScenario, name: string = scenario, allowances: Allowances = WORLD_ALLOWANCES): Promise<FakeLinkedinApp> {
  let app = started.get(name);
  if (!app) started.set(name, (app = start(scenario, allowances)));
  return app;
}

async function start(scenario: LinkedinScenario, allowances: Allowances): Promise<FakeLinkedinApp> {
  const h = new EngineHarness({
    start: LI_MONDAY_8 - H,
    accounts: [{ id: FAKE_INBOX, capacity: 30, gapMs: MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    linkedin: { sessions: [{ id: SESSION, gapMs: MIN, k: 1, healthy: true, resetZone: "Europe/London" }] },
  });
  await h.tick();
  // The user's allowances for the simulated session (ADR 0004 1.2: no default). One note a month, so later invites go without it.
  if (allowances !== null) {
    const set = await h.request("PUT", `/api/sender-accounts/${SESSION_ID}/allowances`, allowances);
    if (set.status !== 200) throw new Error(`allowances refused: ${JSON.stringify(set.body)}`);
  }
  h.linkedin.profiles.set(PROFILES.pat, { acceptAfterMs: 26 * H });
  h.linkedin.profiles.set(PROFILES.nia, { withdrawUnknown: 50 });
  h.linkedin.profiles.set(PROFILES.sam, { connected: true });
  // Accepted just before the wait ended, reported a day late: recorded after the track had finished.
  h.linkedin.profiles.set(PROFILES.ivo, { acceptAfterMs: 2 * DAY + 14 * H, acceptReportDelayMs: DAY });
  const { campaign } = await h.createCampaign("Clinics on LinkedIn", { businesses: BUSINESSES, people: PEOPLE });
  await h.tick();
  const rows = async () => (await h.request<LeadSearchResult>("GET", "/api/leads?limit=500")).body.rows;
  const person = async (name: string) => (await rows()).find((r) => r.name === name)?.id ?? "";
  const enrollment = async (name: string, campaignId = campaign.id) => (await rows()).find((r) => r.name === name)?.enrollments.find((e) => e.campaign.id === campaignId)?.id ?? "";
  let second: string | null = null;
  if (scenario !== "fresh") await h.defineSequence(campaign.id, LINKEDIN_DEFINITION);
  if (scenario === "ready" || scenario === "testing" || scenario === "test-stuck") {
    const contacts = await h.request("PUT", `/api/campaigns/${campaign.id}/test-contacts`, { email: "", mobile: "", linkedin: TEST_PROFILE });
    if (contacts.status !== 200) throw new Error(`test profile refused: ${JSON.stringify(contacts.body)}`);
  }
  if (scenario === "test-stuck") h.linkedin.profiles.set(TEST_PROFILE, { withdrawUnknown: 500 });
  if (scenario === "testing" || scenario === "test-stuck") {
    const tab = (await h.request<{ definitionVersion: number }>("GET", `/api/campaigns/${campaign.id}/test-runs`)).body;
    h.clock = LI_MONDAY_8 + H + 30 * MIN;
    const run = await h.request("POST", `/api/campaigns/${campaign.id}/test-runs`, { requestId: "li-test-1", renderAs: await enrollment("Pat Oneil"), expect: { definitionVersion: tab.definitionVersion } });
    if (run.status !== 200) throw new Error(`test run refused: ${JSON.stringify(run.body)}`);
    await h.advanceTo(h.clock + (scenario === "test-stuck" ? 4 * DAY : 10 * MIN));
  }
  if (scenario === "launched" || scenario === "running" || scenario === "later") {
    h.clock = LI_MONDAY_8;
    const launched = await h.launch(campaign.id);
    if (launched.status !== 200) throw new Error(`launch refused: ${JSON.stringify(launched.body)}`);
    await h.advanceTo(LI_MONDAY_8 + 2 * H);
    // Ola is stopped with her invite still open on LinkedIn (Q38).
    const ola = await enrollment("Ola Berg");
    const read = (await h.request<{ status: string; controls: { action: string; allowed: boolean; digest?: string }[] }>("GET", `/api/enrollments/${ola}`)).body;
    const stop = read.controls.find((c) => c.action === "stop");
    const stopped = await h.request("POST", `/api/enrollments/${ola}/controls`, { requestId: "stop-ola", action: "stop", expect: { status: read.status, preview: stop?.digest ?? "" } });
    if (stopped.status !== 200) throw new Error(`stop refused: ${JSON.stringify(stopped.body)}`);
    // A second campaign meets Pat on the same session: it skips its LinkedIn track, naming the first (Q41).
    const other = await h.createCampaign("Clinics, second wave", { businesses: BUSINESSES, people: PEOPLE.filter((p) => p.full_name === "Pat Oneil") });
    second = other.campaign.id;
    await h.defineSequence(second, { ...LINKEDIN_DEFINITION, tracks: [LINKEDIN_TRACK] });
    const again = await h.launch(second);
    if (again.status !== 200) throw new Error(`second launch refused: ${JSON.stringify(again.body)}`);
    // Wednesday noon: Pat accepted on Tuesday and has their first message. Through Friday noon ("later"): Nia's wait ended
    // and LinkedIn keeps answering "unknown" to the withdrawal; Ivo accepted late, after his track had ended.
    await h.advanceTo(scenario === "launched" ? LI_MONDAY_8 + 2 * H : LI_MONDAY_8 + (scenario === "later" ? 4 : 2) * DAY + 4 * H);
  }
  return { url: await serveHarness(h), h, campaign: campaign.id, second, person, enrollment };
}
