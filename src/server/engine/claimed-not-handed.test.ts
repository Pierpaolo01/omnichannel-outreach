import { describe, expect, test } from "vitest";
import { linkedinAccountId, socialAccountId } from "./ports.ts";
import { Crash, EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { LeadSearchResult, RecordControls } from "../../shared/api.ts";
import { nextStepSentence, outgoingSoFar } from "../../web/controls/wording.ts";

/**
 * A claim is not a handover (the council on 5a30b9f, item 1): a step claimed and not yet handed to the provider has sent
 * nothing, and the record says so; work handed over and not yet reported is "not known yet". Each sending channel through
 * the real HTTP app, SQLite store and engine against simulated providers, one sender pacing two leads ten minutes apart.
 * Data is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const GAP = 10 * MIN;
const N1 = "+447700900001";
const LI = "li-session-1";
const IG = "ig-session-1";

const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });
const PEOPLE = ["Pat Oneil", "Nia Cole"].map((name, i) =>
  person({ person_id: `p${i}`, business_id: "b1", full_name: name, email: `p${i}@harbour.example`, dial_phone: `+44770090010${i}`, dial_phone_type: "mobile", linkedin_url: `https://www.linkedin.com/in/fictional-claimed-${i}`, instagram: `https://www.instagram.com/example_claimed_${i}` }),
);

type Channel = "email" | "sms" | "linkedin" | "instagram";
const stepOf = (id: string, channel: Channel): StepDefinition => ({ id, waitDays: 0, subject: channel === "email" ? "Hello {{first_name|there}}" : "", body: "Hello {{first_name|there}}.", threading: "new_subject", removed: false });
const FROM_TEN = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 10, end: 24 }));
const definition = (channel: Channel, window = ALWAYS): CampaignDefinition => {
  const track: TrackDefinition = {
    id: "t",
    channel,
    branch: "main",
    window,
    steps: channel === "linkedin" ? [stepOf("t1", channel), stepOf("t2", channel)] : [stepOf("t1", channel)],
    start: { kind: "entry" },
    removed: false,
    ...(channel === "linkedin" ? { acceptWaitDays: 3 } : {}),
    ...(channel === "instagram" ? { senders: [socialAccountId("instagram", IG)] } : {}),
  };
  return { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: [N1], linkedinPool: [linkedinAccountId(LI)], tracks: [track] };
};

async function world(channel: Channel, window = ALWAYS) {
  const h = new EngineHarness({
    start: MONDAY_9 - H,
    accounts: [{ id: "inbox-a", capacity: 50, gapMs: GAP, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    sms: { numbers: [{ id: N1, capacity: 50, gapMs: GAP, k: 1, healthy: true, resetZone: "Europe/London" }] },
    linkedin: { sessions: [{ id: LI, gapMs: GAP, k: 1, healthy: true, resetZone: "Europe/London" }] },
    instagram: { sessions: [{ id: IG, kind: "business", gapMs: GAP, k: 1, healthy: true, resetZone: "Europe/London" }] },
  });
  await h.tick();
  for (const id of [linkedinAccountId(LI), socialAccountId("instagram", IG)]) expect((await h.request("PUT", `/api/sender-accounts/${id}/allowances`, { invitesPerDay: 20, messagesPerDay: 20, notesPerMonth: 20 })).status).toBe(200);
  const { campaign } = await h.createCampaign("Claimed", { businesses: [HARBOUR], people: PEOPLE });
  await h.defineSequence(campaign.id, definition(channel, window));
  const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows;
  const handed = () => ({ email: h.fake.handoverLog, sms: h.sms.handoverLog, linkedin: h.linkedin.handoverLog, instagram: h.instagram.handoverLog })[channel];
  /** Each lead's record row: its sends as the record reads them, and the sentence under its status. */
  const record = async (row: (typeof rows)[number]) => {
    const r = (await h.request<RecordControls>("GET", `/api/people/${row.id}`)).body;
    const lead = r.leads.find((l) => l.campaignId === campaign.id)!;
    return { lead, sends: lead.tracks.flatMap((t) => t.steps.flatMap((s) => s.sends)), sentence: nextStepSentence(lead, r.userZone), soFar: outgoingSoFar(lead) };
  };
  return { h, campaign, rows, handed, record };
}

describe.each(["email", "sms", "linkedin", "instagram"] as const)("%s: a claim not yet handed over", (channel) => {
  test("one sender, two leads, ten minutes apart: the second's claim has sent nothing, and its record says so", async () => {
    const { h, campaign, rows, handed, record } = await world(channel);
    h.clock = MONDAY_9;
    expect((await h.launch(campaign.id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + MIN);
    // The first lead's step went to the provider; the second's is claimed and waits for the sender's next slot.
    expect(handed()).toHaveLength(1);
    const second = rows.find((r) => !handed().some((x) => x.subjectId === r.enrollments[0]!.id))!;
    const waiting = await record(second);
    expect(waiting.sends.map((s) => [s.state, s.handedAt])).toEqual([["claimed", null]]);
    expect(waiting.soFar).toEqual({ state: "nothing" });
    expect(waiting.sentence).toMatch(/^Nothing has gone out yet\./);
    // At its slot it is handed over, and from then the record no longer says nothing went.
    await h.advanceTo(MONDAY_9 + GAP + 2 * MIN);
    expect(handed()).toHaveLength(2);
    expect((await record(second)).soFar.state).not.toBe("nothing");
  });

  test("a crash between a claim and its handover: after recovery, nothing went until the step is handed over", async () => {
    // Launched an hour before the window opens: nothing is claimed at the launch; the first claim crashes the engine.
    const { h, campaign, rows, handed, record } = await world(channel, FROM_TEN);
    h.clock = MONDAY_9;
    expect((await h.launch(campaign.id)).status).toBe(200);
    let armed = true;
    h.hooks.crashPoint = (point) => {
      if (armed && point === "after_claim") {
        armed = false;
        throw new Crash(point);
      }
    };
    await h.advanceTo(MONDAY_9 + H);
    expect(armed).toBe(false);
    // Recovered on a fresh engine: whatever the claim left, no lead's record says something went before a handover.
    for (const row of rows) {
      const r = await record(row);
      const anyHanded = handed().some((x) => x.subjectId === row.enrollments[0]!.id);
      if (!anyHanded) {
        expect(r.soFar, row.name).toEqual({ state: "nothing" });
        expect(r.sentence).toMatch(/^Nothing has gone out yet\./);
      }
    }
    await h.advanceTo(MONDAY_9 + 3 * H);
    for (const row of rows) expect((await record(row)).soFar.state, row.name).not.toBe("nothing");
  });
});
