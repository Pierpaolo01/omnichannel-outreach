import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../src/domain/sequence/definition.ts";
import { MESSAGE_REQUEST_CHANNELS, type MessageRequestChannel } from "../src/domain/social-channels.ts";
import type { LeadSearchResult } from "../src/shared/api.ts";
import { socialAccountId } from "../src/server/engine/ports.ts";
import { EngineHarness } from "../test/support/engine-harness.ts";
import { business, person } from "../test/support/export-builder.ts";
import type { FakeSocialSession } from "../test/support/fake-social-port.ts";
import { accountCells, exampleAccount } from "../test/support/message-request-accounts.ts";
import { FAKE_INBOX, serveHarness } from "./fake-provider.ts";

/**
 * The browser world of the message-request channels (tickets 25 and 26): the app over a **simulated** provider of one
 * channel, or of both at once (`together`), labelled "Simulated <channel> (not a session)" wherever a sender is named,
 * beside the fake email provider. No session of either channel is connected anywhere: the running application registers
 * none, and this world exists only in the test worker. Every person, company and account is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
/** Monday 2 November 2026, 08:00 in London (GMT). */
export const MR_MONDAY_8 = Date.parse("2026-11-02T08:00:00Z");
/** The same session ids on every channel: the app's account ids carry the channel. */
export const SESSION = "session-1";
/** A second simulated session, a personal profile signed out: chosen, but it cannot send (the `two-sessions` scenario). */
export const SESSION_2 = "session-2";
export const sessionIdOf = (channel: MessageRequestChannel, session = SESSION) => socialAccountId(channel, session);
export const testAccountOf = (channel: MessageRequestChannel) => exampleAccount(channel, "my.own.test");
export const accountsOf = (channel: MessageRequestChannel) => ({ pat: exampleAccount(channel, "pat.oneil"), harbour: exampleAccount(channel, "harbour.lane.physio"), quay: exampleAccount(channel, "quayside.clinic") }) as const;
/** The track of the channel in every scenario, and its steps' ids. */
export const trackIdOf = (channel: MessageRequestChannel) => `${channel}-track`;

/** The rows, with each channel's cells: Pat's own account, Nia's company's, Kim's neither. */
function rows(channels: readonly MessageRequestChannel[]) {
  const cells = (file: "people" | "businesses", pick: (a: ReturnType<typeof accountsOf>) => string | null) => accountCells(file, Object.fromEntries(channels.map((c) => [c, pick(accountsOf(c)) ?? ""])));
  const company = (pick: (a: ReturnType<typeof accountsOf>) => string | null) => cells("businesses", pick);
  const own = (pick: (a: ReturnType<typeof accountsOf>) => string | null) => cells("people", pick);
  return {
    businesses: [
      business({ business_id: "bz-harbour-mr-0001", business_name: "Harbour Lane Physio", city: "Bristol", phone_e164: "+441174960301", phone_original: "0117 496 0301", ...company((a) => a.harbour) }),
      business({ business_id: "bz-quay-mr-0002", business_name: "Quayside Clinic", city: "Bristol", phone_e164: "+441174960302", phone_original: "0117 496 0302", ...company((a) => a.quay) }),
      business({ business_id: "bz-elm-mr-0003", business_name: "Elm Street Practice", city: "Bristol", phone_e164: "+441174960303", phone_original: "0117 496 0303", ...company(() => null) }),
    ],
    people: [
      // Their own account, from the people file's optional column (ADR 0004 Q43, Q48).
      person({ person_id: "pm-pat", business_id: "bz-harbour-mr-0001", full_name: "Pat Oneil", title: "Practice owner", email: "pat@harbourlane.example", ...own((a) => a.pat) }),
      // None of their own: their company's account.
      person({ person_id: "pm-nia", business_id: "bz-quay-mr-0002", full_name: "Nia Cole", title: "Clinic manager", email: "nia@quayside.example", ...own(() => null) }),
      // Neither: the track is skipped for them.
      person({ person_id: "pm-kim", business_id: "bz-elm-mr-0003", full_name: "Kim Hart", title: "Receptionist", email: "kim@elmstreet.example", ...own(() => null) }),
    ],
  };
}

const step = (id: string, waitDays: number, body: string): StepDefinition => ({ id, waitDays, subject: "", body, threading: "new_subject", removed: false });
const WEEKDAYS = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
export function trackOf(channel: MessageRequestChannel, senders: readonly string[] = [sessionIdOf(channel)]): TrackDefinition {
  const id = trackIdOf(channel);
  return {
    id,
    channel,
    branch: "main",
    window: WEEKDAYS,
    start: { kind: "entry" },
    removed: false,
    senders,
    steps: [step(`${id}-m1`, 0, "Hi {{first_name|there}}, I help clinics like {{company}} fill evening slots. Could I send a short video?"), step(`${id}-m2`, 2, "{{first_name|Hi}}, shall I send the video over? A yes is enough.")],
  };
}
const definitionOf = (tracks: readonly TrackDefinition[]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: [FAKE_INBOX], smsPool: [], tracks: [...tracks] });

/**
 * `fresh`: leads imported, no sequence (the canvas from empty). `ready`: the sequence, not launched, with the user's test
 * account saved. `running`: launched, Monday 10:00 (Pat's and Nia's first messages sent, Kim skipped). `no-allowance`: as
 * `running` with the session's allowance never set, so nothing goes and the read says why. `no-session`: the sequence, with
 * no session of the channel at all, as the running application has none: launch is blocked. `two-sessions`: the sequence,
 * not launched, choosing two sessions, one of them signed out. `claimed`: launched at 09:00 on one session pacing its
 * messages ten minutes apart, a minute later: the first lead's message went, the second's is claimed and not yet handed over.
 */
export type MessageRequestScenario = "fresh" | "ready" | "running" | "no-allowance" | "no-session" | "two-sessions" | "claimed";
/** One channel, or both channels' tracks in one campaign (only `running` and `fresh`). */
export type ScenarioChannels = MessageRequestChannel | "together";

export interface FakeMessageRequestApp {
  readonly url: string;
  readonly h: EngineHarness;
  readonly campaign: string;
  readonly person: (name: string) => Promise<string>;
  readonly enrollment: (name: string) => Promise<string>;
}

const started = new Map<string, Promise<FakeMessageRequestApp>>();

/** One app per channel, name and test worker, seeded once. */
export function fakeMessageRequestApp(on: ScenarioChannels, scenario: MessageRequestScenario, name: string = scenario): Promise<FakeMessageRequestApp> {
  const key = `${on}|${name}`;
  let app = started.get(key);
  if (!app) started.set(key, (app = start(on, scenario)));
  return app;
}

async function start(on: ScenarioChannels, scenario: MessageRequestScenario): Promise<FakeMessageRequestApp> {
  const channels: readonly MessageRequestChannel[] = on === "together" ? MESSAGE_REQUEST_CHANNELS : [on];
  const sessions: FakeSocialSession[] =
    scenario === "no-session"
      ? []
      : [
          { id: SESSION, kind: "business", gapMs: scenario === "claimed" ? 10 * MIN : MIN, k: 1, healthy: true, resetZone: "Europe/London" },
          ...(scenario === "two-sessions" ? [{ id: SESSION_2, kind: "personal" as const, gapMs: MIN, k: 1, healthy: false, resetZone: "Europe/London" }] : []),
        ];
  const h = new EngineHarness({
    start: MR_MONDAY_8 - H,
    accounts: [{ id: FAKE_INBOX, capacity: 30, gapMs: MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    social: Object.fromEntries(channels.map((c) => [c, { sessions: sessions.map((s) => ({ ...s })) }])),
  });
  await h.tick();
  // The user's allowance for each simulated session (ADR 0004 13.7: no default).
  if (scenario !== "no-allowance" && scenario !== "no-session") {
    for (const c of channels) {
      const set = await h.request("PUT", `/api/sender-accounts/${sessionIdOf(c)}/allowances`, { invitesPerDay: 0, messagesPerDay: 20, notesPerMonth: 0 });
      if (set.status !== 200) throw new Error(`allowance refused: ${JSON.stringify(set.body)}`);
    }
  }
  const { campaign } = await h.createCampaign(on === "together" ? "Clinics on Instagram and Facebook" : `Clinics, ${on}`, rows(channels));
  await h.tick();
  const leads = async () => (await h.request<LeadSearchResult>("GET", "/api/leads?limit=500")).body.rows;
  const person = async (name: string) => (await leads()).find((r) => r.name === name)?.id ?? "";
  const enrollment = async (name: string) => (await leads()).find((r) => r.name === name)?.enrollments.find((e) => e.campaign.id === campaign.id)?.id ?? "";
  if (scenario === "two-sessions") await h.defineSequence(campaign.id, definitionOf(channels.map((c) => trackOf(c, [sessionIdOf(c), sessionIdOf(c, SESSION_2)]))));
  else if (scenario !== "fresh") await h.defineSequence(campaign.id, definitionOf(channels.map((c) => trackOf(c))));
  if (scenario === "ready") {
    const contacts = await h.request("PUT", `/api/campaigns/${campaign.id}/test-contacts`, { email: "", mobile: "", ...Object.fromEntries(channels.map((c) => [c, testAccountOf(c)])) });
    if (contacts.status !== 200) throw new Error(`test account refused: ${JSON.stringify(contacts.body)}`);
  }
  if (scenario === "running" || scenario === "no-allowance") {
    h.clock = MR_MONDAY_8;
    const launched = await h.launch(campaign.id);
    if (launched.status !== 200) throw new Error(`launch refused: ${JSON.stringify(launched.body)}`);
    await h.advanceTo(MR_MONDAY_8 + 2 * H);
  }
  if (scenario === "claimed") {
    h.clock = MR_MONDAY_8 + H;
    const launched = await h.launch(campaign.id);
    if (launched.status !== 200) throw new Error(`launch refused: ${JSON.stringify(launched.body)}`);
    await h.advanceTo(MR_MONDAY_8 + H + MIN);
  }
  return { url: await serveHarness(h), h, campaign: campaign.id, person, enrollment };
}
