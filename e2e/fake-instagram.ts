import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../src/domain/sequence/definition.ts";
import type { LeadSearchResult } from "../src/shared/api.ts";
import { socialAccountId } from "../src/server/engine/ports.ts";
import { EngineHarness } from "../test/support/engine-harness.ts";
import { business, person } from "../test/support/export-builder.ts";
import { FAKE_INBOX, serveHarness } from "./fake-provider.ts";

/**
 * Ticket 25's browser world: the app over a **simulated** Instagram provider (test/support/fake-social-port.ts), labelled
 * "Simulated Instagram (not a session)" wherever a sender is named, beside the fake email provider. No Instagram session
 * is connected anywhere: the running application registers none, and this world exists only in the test worker. Every
 * person, company and account is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
/** Monday 2 November 2026, 08:00 in London (GMT). */
export const IG_MONDAY_8 = Date.parse("2026-11-02T08:00:00Z");
export const IG_SESSION = "ig-session-1";
export const IG_SESSION_ID = socialAccountId("instagram", IG_SESSION);
export const TEST_ACCOUNT = "https://www.instagram.com/example_my_own_test";
const account = (name: string) => `https://www.instagram.com/example_${name}`;
export const ACCOUNTS = { pat: account("pat.oneil"), harbour: account("harbour_lane_physio"), quay: account("quayside_clinic") } as const;

const BUSINESSES = [
  business({ business_id: "bz-harbour-ig-0001", business_name: "Harbour Lane Physio", city: "Bristol", phone_e164: "+441174960301", phone_original: "0117 496 0301", instagram: ACCOUNTS.harbour }),
  business({ business_id: "bz-quay-ig-0002", business_name: "Quayside Clinic", city: "Bristol", phone_e164: "+441174960302", phone_original: "0117 496 0302", instagram: ACCOUNTS.quay }),
  business({ business_id: "bz-elm-ig-0003", business_name: "Elm Street Practice", city: "Bristol", phone_e164: "+441174960303", phone_original: "0117 496 0303", instagram: "" }),
];
const PEOPLE = [
  // Their own account, from the people file's optional `instagram` column (ADR 0004 Q43).
  person({ person_id: "pi-pat", business_id: "bz-harbour-ig-0001", full_name: "Pat Oneil", title: "Practice owner", email: "pat@harbourlane.example", instagram: ACCOUNTS.pat }),
  // None of their own: their company's account.
  person({ person_id: "pi-nia", business_id: "bz-quay-ig-0002", full_name: "Nia Cole", title: "Clinic manager", email: "nia@quayside.example", instagram: "" }),
  // Neither: the Instagram track is skipped for them.
  person({ person_id: "pi-kim", business_id: "bz-elm-ig-0003", full_name: "Kim Hart", title: "Receptionist", email: "kim@elmstreet.example", instagram: "" }),
];

const step = (id: string, waitDays: number, body: string): StepDefinition => ({ id, waitDays, subject: "", body, threading: "new_subject", removed: false });
const WEEKDAYS = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
export const INSTAGRAM_TRACK: TrackDefinition = {
  id: "ig",
  channel: "instagram",
  branch: "main",
  window: WEEKDAYS,
  start: { kind: "entry" },
  removed: false,
  steps: [step("ig-m1", 0, "Hi {{first_name|there}}, I help clinics like {{company}} fill evening slots. Could I send a short video?"), step("ig-m2", 2, "{{first_name|Hi}}, shall I send the video over? A yes is enough.")],
};
export const INSTAGRAM_DEFINITION: CampaignDefinition = { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: [FAKE_INBOX], smsPool: [], instagramPool: [IG_SESSION_ID], tracks: [INSTAGRAM_TRACK] };

/**
 * `fresh`: leads imported, no sequence (the canvas from empty). `ready`: the Instagram sequence, not launched, with the user's
 * test account saved. `running`: launched, Monday 10:00 (Pat's and Nia's first messages sent, Kim skipped). `no-allowance`:
 * as `running` with the session's allowance never set, so nothing goes and the read says why. `no-session`: the sequence, with
 * no Instagram session at all, as the running application has none: launch is blocked.
 */
export type InstagramScenario = "fresh" | "ready" | "running" | "no-allowance" | "no-session";

export interface FakeInstagramApp {
  readonly url: string;
  readonly h: EngineHarness;
  readonly campaign: string;
  readonly person: (name: string) => Promise<string>;
  readonly enrollment: (name: string) => Promise<string>;
}

const started = new Map<string, Promise<FakeInstagramApp>>();

/** One app per name and test worker, seeded once. */
export function fakeInstagramApp(scenario: InstagramScenario, name: string = scenario): Promise<FakeInstagramApp> {
  let app = started.get(name);
  if (!app) started.set(name, (app = start(scenario)));
  return app;
}

async function start(scenario: InstagramScenario): Promise<FakeInstagramApp> {
  const h = new EngineHarness({
    start: IG_MONDAY_8 - H,
    accounts: [{ id: FAKE_INBOX, capacity: 30, gapMs: MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    instagram: { sessions: scenario === "no-session" ? [] : [{ id: IG_SESSION, kind: "business", gapMs: MIN, k: 1, healthy: true, resetZone: "Europe/London" }] },
  });
  await h.tick();
  // The user's allowance for the simulated session (ADR 0004 13.7: no default).
  if (scenario !== "no-allowance" && scenario !== "no-session") {
    const set = await h.request("PUT", `/api/sender-accounts/${IG_SESSION_ID}/allowances`, { invitesPerDay: 0, messagesPerDay: 20, notesPerMonth: 0 });
    if (set.status !== 200) throw new Error(`allowance refused: ${JSON.stringify(set.body)}`);
  }
  const { campaign } = await h.createCampaign("Clinics on Instagram", { businesses: BUSINESSES, people: PEOPLE });
  await h.tick();
  const rows = async () => (await h.request<LeadSearchResult>("GET", "/api/leads?limit=500")).body.rows;
  const person = async (name: string) => (await rows()).find((r) => r.name === name)?.id ?? "";
  const enrollment = async (name: string) => (await rows()).find((r) => r.name === name)?.enrollments.find((e) => e.campaign.id === campaign.id)?.id ?? "";
  if (scenario !== "fresh") await h.defineSequence(campaign.id, INSTAGRAM_DEFINITION);
  if (scenario === "ready") {
    const contacts = await h.request("PUT", `/api/campaigns/${campaign.id}/test-contacts`, { email: "", mobile: "", instagram: TEST_ACCOUNT });
    if (contacts.status !== 200) throw new Error(`test account refused: ${JSON.stringify(contacts.body)}`);
  }
  if (scenario === "running" || scenario === "no-allowance") {
    h.clock = IG_MONDAY_8;
    const launched = await h.launch(campaign.id);
    if (launched.status !== 200) throw new Error(`launch refused: ${JSON.stringify(launched.body)}`);
    await h.advanceTo(IG_MONDAY_8 + 2 * H);
  }
  return { url: await serveHarness(h), h, campaign: campaign.id, person, enrollment };
}
