import { describe, expect, test } from "vitest";
import { linkedinAccountId, socialAccountId } from "./ports.ts";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { everyChannelSessions, everyPersonAccountCell } from "../../../test/support/message-request-accounts.ts";
import { isMessageRequestChannel, MESSAGE_REQUEST_CHANNELS, type MessageRequestChannel } from "../../domain/social-channels.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { EnrollmentRead, LeadSearchResult } from "../../shared/api.ts";

/**
 * A track a lead has started, removed by a running edit before its first claim, keeps everything it needs to run for that
 * lead (ADR 0003's running edits; the review bot on 0922582): its chosen sessions or its channel's pool, its window and its
 * steps. Each channel through the real HTTP app, SQLite store and engine against simulated providers; data is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
/** Monday 2 November 2026, 08:00 London (GMT): an hour before the window opens. */
const MONDAY_8 = Date.parse("2026-11-02T08:00:00Z");
const NINE_TO_FIVE = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 9, end: 17 }));
const N1 = "+447700900001";
const LI = "li-session-1";
const IG = "ig-session-1";

const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });
const PAT = person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", dial_phone: "+447700900101", dial_phone_type: "mobile", linkedin_url: "https://www.linkedin.com/in/fictional-pat-removed", ...everyPersonAccountCell("pat.removed") });

type Channel = "email" | "sms" | "linkedin" | MessageRequestChannel;
const stepOf = (id: string, channel: Channel): StepDefinition => ({ id, waitDays: 0, subject: channel === "email" ? "Hello {{first_name|there}}" : "", body: "Hello {{first_name|there}}.", threading: "new_subject", removed: false });
const trackOf = (channel: Channel): TrackDefinition => ({
  id: "t",
  channel,
  branch: "main",
  window: NINE_TO_FIVE,
  steps: channel === "linkedin" ? [stepOf("t1", channel), stepOf("t2", channel)] : [stepOf("t1", channel)],
  start: { kind: "entry" },
  removed: false,
  ...(channel === "linkedin" ? { acceptWaitDays: 3 } : {}),
  ...(isMessageRequestChannel(channel) ? { senders: [socialAccountId(channel, IG)] } : {}),
});
/** A call track beside it, so the campaign keeps a live track once `t` is removed. */
const CALLS: TrackDefinition = { id: "c", channel: "call", branch: "main", window: NINE_TO_FIVE, steps: [{ id: "c1", waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false }], start: { kind: "entry" }, removed: false };
const definition = (channel: Channel, removed: boolean): CampaignDefinition => ({
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["inbox-a"],
  smsPool: [N1],
  linkedinPool: [linkedinAccountId(LI)],
  tracks: [{ ...trackOf(channel), removed }, CALLS],
});

async function run(channel: Channel) {
  const h = new EngineHarness({
    start: MONDAY_8 - H,
    accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    sms: { numbers: [{ id: N1, capacity: 50, gapMs: MIN, k: 2, healthy: true, resetZone: "Europe/London" }] },
    linkedin: { sessions: [{ id: LI, gapMs: MIN, k: 1, healthy: true, resetZone: "Europe/London" }] },
    social: everyChannelSessions([{ id: IG, kind: "business", gapMs: MIN, k: 1, healthy: true, resetZone: "Europe/London" }]),
  });
  await h.tick();
  for (const id of [linkedinAccountId(LI), ...MESSAGE_REQUEST_CHANNELS.map((c) => socialAccountId(c, IG))]) expect((await h.request("PUT", `/api/sender-accounts/${id}/allowances`, { invitesPerDay: 20, messagesPerDay: 20, notesPerMonth: 20 })).status).toBe(200);
  const { campaign } = await h.createCampaign("Removed", { businesses: [HARBOUR], people: [PAT] });
  await h.defineSequence(campaign.id, definition(channel, false));
  h.clock = MONDAY_8;
  expect((await h.launch(campaign.id)).status).toBe(200);
  await h.tick();
  const lead = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows[0]!.enrollments[0]!.id;
  const track = async () => (await h.request<EnrollmentRead>("GET", `/api/enrollments/${lead}`)).body.tracks.find((t) => t.trackId === "t");
  const log = () => (isMessageRequestChannel(channel) ? h.social(channel).handoverLog : { email: h.fake.handoverLog, sms: h.sms.handoverLog, linkedin: h.linkedin.handoverLog }[channel]).filter((x) => x.subjectId === lead);
  return { h, campaign, track, log };
}

describe.each(["email", "sms", "linkedin", ...MESSAGE_REQUEST_CHANNELS] as const)("%s: a track started, then removed before its first claim", (channel) => {
  test("still sends for the lead that started it when its window opens, from what it chose", async () => {
    const { h, campaign, track, log } = await run(channel);
    // Started at launch, its first step waiting for the window: nothing claimed yet.
    expect(await track()).toMatchObject({ started: true, finishReason: null });
    expect(log()).toEqual([]);
    // The running edit removes it; accepted.
    const edit = await h.request("PUT", `/api/campaigns/${campaign.id}/sequence`, definition(channel, true));
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    await h.advanceTo(MONDAY_8 + 2 * H);
    expect(log().map((x) => x.stepId)).toEqual(["t1"]);
  });
});
