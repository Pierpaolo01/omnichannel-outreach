import { describe, expect, test } from "vitest";
import { linkedinAccountId, socialAccountId } from "./ports.ts";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { everyChannelSessions, everyPersonAccountCell } from "../../../test/support/message-request-accounts.ts";
import { MESSAGE_REQUEST_CHANNELS, SOCIAL_CHANNELS, type MessageRequestChannel } from "../../domain/social-channels.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import { defaultGap } from "../../domain/sequence/dispatch.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";

/**
 * A session's pacing comes from the tracks with leads running on it (the council on 5a30b9f, item 2): the live tracks that
 * chose it, and a removed or unticked track only while a lead it started is still fixed to the session. A session whose
 * port reports no gap takes the default gap from those tracks' windows (ADR 0003 4.1). Through the real HTTP app, SQLite
 * store and engine against simulated providers; data is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const WIDE = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 8, end: 20 }));
const NARROW = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 9, end: 10 }));
const IG = ["ig-session-1", "ig-session-2"];
const LI = ["li-session-1", "li-session-2"];
const li = (s: string) => linkedinAccountId(s);

const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });
const PAT = person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", linkedin_url: "https://www.linkedin.com/in/fictional-pacing-pat", ...everyPersonAccountCell("pacing.pat") });

const step = (id: string, waitDays: number): StepDefinition => ({ id, waitDays, subject: "", body: "Hello {{first_name|there}}.", threading: "new_subject", removed: false });

async function world() {
  const h = new EngineHarness({
    start: MONDAY_9 - H,
    accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    // No gap of their own: each takes the default from the windows of the tracks it paces (`gapMs: null` in the store).
    social: everyChannelSessions(IG.map((id) => ({ id, kind: "business" as const, gapMs: null as unknown as number, k: 1, healthy: true, resetZone: "Europe/London" }))),
    linkedin: { sessions: LI.map((id) => ({ id, gapMs: null as unknown as number, k: 1, healthy: true, resetZone: "Europe/London" })) },
  });
  await h.tick();
  for (const id of [...MESSAGE_REQUEST_CHANNELS.flatMap((c) => IG.map((s) => socialAccountId(c, s))), ...LI.map(li)]) expect((await h.request("PUT", `/api/sender-accounts/${id}/allowances`, { invitesPerDay: 20, messagesPerDay: 20, notesPerMonth: 20 })).status).toBe(200);
  const { campaign } = await h.createCampaign("Pacing", { businesses: [HARBOUR], people: [PAT] });
  const save = async (def: CampaignDefinition) => {
    const r = await h.request("PUT", `/api/campaigns/${campaign.id}/sequence`, def);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  const account = async (id: string) => (await h.store.engine.accounts(h.clock)).find((a) => a.id === id)!;
  /** The gap the given windows give this account, by the domain's own rule. */
  const gapFrom = async (id: string, windows: (typeof WIDE)[]) => defaultGap(windows, (await account(id)).dailyLimit);
  return { h, campaign, save, account, gapFrom };
}

const base = (tracks: TrackDefinition[], linkedinPool: string[] = []): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: [], ...(linkedinPool.length > 0 ? { linkedinPool } : {}), tracks });

describe.each(MESSAGE_REQUEST_CHANNELS.map((channel) => [SOCIAL_CHANNELS[channel].name, channel] as const))("%s: a session's pacing follows the tracks with leads running on it", (_name, channel: MessageRequestChannel) => {
  const ig = (s: string) => socialAccountId(channel, s);
  test("a removed track no lead started, with a short window, does not speed the session up", async () => {
    const { h, campaign, save, account, gapFrom } = await world();
    const A: TrackDefinition = { id: "a", channel, branch: "main", window: WIDE, steps: [step("a1", 0), step("a2", 3)], start: { kind: "entry" }, removed: false, senders: [ig(IG[0]!)] };
    // B starts a month after A: no lead has started it when it is removed.
    const B: TrackDefinition = { id: "b", channel, branch: "main", window: NARROW, steps: [step("b1", 0)], start: { kind: "after", trackId: "a", delayDays: 30 }, removed: false, senders: [ig(IG[0]!)] };
    await save(base([A, B]));
    h.clock = MONDAY_9;
    expect((await h.launch(campaign.id)).status).toBe(200);
    await h.tick();
    // While B is live it chose the session, so its window counts.
    expect((await account(ig(IG[0]!))).gapMs).toBe(await gapFrom(ig(IG[0]!), [WIDE, NARROW]));
    await save(base([A, { ...B, removed: true }]));
    expect((await account(ig(IG[0]!))).gapMs).toBe(await gapFrom(ig(IG[0]!), [WIDE]));
  });

  test("a session unticked from every track keeps its pace while a lead it started is still fixed to it, and loses it when that track ends", async () => {
    const { h, campaign, save, account, gapFrom } = await world();
    const A: TrackDefinition = { id: "a", channel, branch: "main", window: WIDE, steps: [step("a1", 0), step("a2", 2)], start: { kind: "entry" }, removed: false, senders: [ig(IG[0]!)] };
    await save(base([A]));
    h.clock = MONDAY_9;
    expect((await h.launch(campaign.id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + H);
    expect(h.social(channel).handoverLog.map((x) => x.sender)).toEqual([IG[0]]);
    // The user unticks it: Pat's track is still fixed to it, with a follow-up to come.
    await save(base([{ ...A, senders: [ig(IG[1]!)] }]));
    expect((await account(ig(IG[0]!))).gapMs).toBe(await gapFrom(ig(IG[0]!), [WIDE]));
    expect((await account(ig(IG[0]!))).gapMs).toBeGreaterThan(MIN);
    // The follow-up goes from it; the track then finishes, and nothing is fixed to the session any more.
    await h.advanceTo(MONDAY_9 + 4 * DAY);
    expect(h.social(channel).handoverLog.map((x) => x.sender)).toEqual([IG[0], IG[0]]);
    expect((await account(ig(IG[0]!))).gapMs).toBe(await gapFrom(ig(IG[0]!), []));
  });
});

describe("a session's pacing follows the tracks with leads running on it", () => {

  test("LinkedIn: a session removed from the pool keeps its pace while a lead it invited is still fixed to it", async () => {
    const { h, campaign, save, account, gapFrom } = await world();
    const L: TrackDefinition = { id: "l", channel: "linkedin", branch: "main", window: WIDE, steps: [step("l1", 0), step("l2", 0)], start: { kind: "entry" }, removed: false, acceptWaitDays: 3 };
    await save(base([L], [li(LI[0]!)]));
    h.clock = MONDAY_9;
    expect((await h.launch(campaign.id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + H);
    expect(h.linkedin.handoverLog.map((x) => x.sender)).toEqual([LI[0]]);
    await save(base([L], [li(LI[1]!)]));
    // Pat's invite waits for acceptance on that session: it still paces by the track's window.
    expect((await account(li(LI[0]!))).gapMs).toBe(await gapFrom(li(LI[0]!), [WIDE]));
    expect((await account(li(LI[0]!))).gapMs).toBeGreaterThan(MIN);
  });
});
