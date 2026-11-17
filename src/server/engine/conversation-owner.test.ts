import { describe, expect, test } from "vitest";
import { linkedinAccountId } from "./ports.ts";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { ConversationOwnerView, EnrollmentProgress, LeadSearchResult, NeedsAttention } from "../../shared/api.ts";
import { noUsableChannelItem } from "../../web/calls/interruption.ts";

/**
 * Who owns a taken conversation, as every read says it (verifier on f2824d4, item 9): a lead of the same campaign by its
 * name, another campaign by its name, from the cause stored with the skip; never a fixed phrase. Instagram's cases are in
 * instagram.test.ts. Through the real HTTP app, SQLite store and engine against simulated providers; data is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const N1 = "+447700900001";
const SHARED_MOBILE = "+447700900101";
const SHARED_PROFILE = "https://www.linkedin.com/in/fictional-shared-desk";
const S1 = "li-session-1";

const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });
const sharing = {
  sms: [
    person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", dial_phone: SHARED_MOBILE, dial_phone_type: "mobile" }),
    person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", dial_phone: SHARED_MOBILE, dial_phone_type: "mobile" }),
  ],
  linkedin: [
    person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", linkedin_url: SHARED_PROFILE }),
    person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", linkedin_url: SHARED_PROFILE }),
  ],
} as const;

const trackOf = (channel: "sms" | "linkedin"): TrackDefinition => ({
  id: "t",
  channel,
  branch: "main",
  window: ALWAYS,
  steps: [{ id: "m1", waitDays: 0, subject: "", body: "Hello {{first_name|there}}.", threading: "new_subject", removed: false }, ...(channel === "linkedin" ? [{ id: "m2", waitDays: 0, subject: "", body: "Thanks for connecting.", threading: "new_subject" as const, removed: false }] : [])],
  start: { kind: "entry" },
  removed: false,
  ...(channel === "linkedin" ? { acceptWaitDays: 3 } : {}),
});
const definition = (channel: "sms" | "linkedin"): CampaignDefinition => ({
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: [],
  smsPool: channel === "sms" ? [N1] : [],
  ...(channel === "linkedin" ? { linkedinPool: [linkedinAccountId(S1)] } : {}),
  tracks: [trackOf(channel)],
});

async function world(channel: "sms" | "linkedin") {
  const h = new EngineHarness({
    start: MONDAY_9 - H,
    accounts: [],
    ...(channel === "sms" ? { sms: { numbers: [{ id: N1, capacity: 50, gapMs: MIN, k: 2, healthy: true, resetZone: "Europe/London" }] } } : { linkedin: { sessions: [{ id: S1, gapMs: MIN, k: 1, healthy: true, resetZone: "Europe/London" }] } }),
  });
  await h.tick();
  if (channel === "linkedin") expect((await h.request("PUT", `/api/sender-accounts/${linkedinAccountId(S1)}/allowances`, { invitesPerDay: 20, messagesPerDay: 20, notesPerMonth: 20 })).status).toBe(200);
  h.clock = MONDAY_9;
  const campaign = async (name: string, people: readonly ReturnType<typeof person>[]) => {
    const { campaign: c } = await h.createCampaign(name, { businesses: [HARBOUR], people: [...people] });
    await h.defineSequence(c.id, definition(channel));
    const launched = await h.launch(c.id);
    if (launched.status !== 200) throw new Error(`launch refused: ${JSON.stringify(launched.body)}`);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
    return (who: string) => rows.find((r) => r.name === who)?.enrollments.find((e) => e.campaign.id === c.id)?.id ?? "";
  };
  const track = async (id: string) => (await h.request<EnrollmentProgress>("GET", `/api/enrollments/${id}`)).body.tracks.find((t) => t.trackId === "t");
  const today = async (id: string) => (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body.noUsableChannel.find((x) => x.enrollmentId === id);
  const destination = channel === "sms" ? SHARED_MOBILE : SHARED_PROFILE;
  const firstTo = () => (channel === "sms" ? h.sms.deliveryLog : h.linkedin.deliveryLog).filter((d) => d.destination === destination).map((d) => d.subjectId);
  return { h, campaign, track, today, firstTo };
}

const WORDS = {
  sms: (owner: string) => `Now their mobile is in a text conversation with ${owner} on every number this campaign can use.`,
  linkedin: (owner: string) => `Now their LinkedIn profile is in a LinkedIn conversation (an invite or a message) with ${owner} on every LinkedIn session this campaign can use.`,
};

describe("an SMS conversation's owner in the same campaign", () => {
  test("cannot be a colleague: the import enrolls neither of two people sharing a mobile, so only the campaign's test run can own it, and it is named as the test run", async () => {
    const h = new EngineHarness({ start: MONDAY_9 - H, accounts: [] });
    const { import: imp } = await h.createCampaign("Spring clinics", { businesses: [HARBOUR], people: [...sharing.sms] });
    expect(imp.summary.entries.map((e) => [e.name, e.outcome, "reason" in e ? e.reason : null])).toEqual([
      ["Pat Oneil", "not_enrolled", "shares_contact"],
      ["Nia Cole", "not_enrolled", "shares_contact"],
    ]);
  });
});

describe.each(["linkedin"] as const)("a %s conversation's owner in the same campaign", (channel) => {
  test("a colleague in the same campaign: named as that lead, on the record and in Today", async () => {
    const w = await world(channel);
    const lead = await w.campaign("Spring clinics", sharing[channel]);
    await w.h.advanceTo(MONDAY_9 + 3 * H);
    expect(w.firstTo()).toHaveLength(1);
    const ownerName = w.firstTo()[0] === lead("Pat Oneil") ? "Pat Oneil" : "Nia Cole";
    const skipped = lead(ownerName === "Pat Oneil" ? "Nia Cole" : "Pat Oneil");
    const owners: ConversationOwnerView[] = [{ name: "Spring clinics", test: false, lead: ownerName }];
    expect(await w.track(skipped)).toMatchObject({ finishReason: "skipped_conversation_taken", conversationOwners: owners });
    const ended = await w.today(skipped);
    expect(ended?.channels).toEqual([{ channel, why: "conversation_taken", owners }]);
    expect(noUsableChannelItem(ended ? [ended] : [], "2026-11-02", "Europe/London")?.body).toContain(WORDS[channel](`${ownerName}, a lead of this campaign,`));
  });
});

describe.each(["sms", "linkedin"] as const)("a %s conversation's owner in another campaign", (channel) => {

  test("a lead of another campaign: that campaign named, on the record and in Today", async () => {
    const w = await world(channel);
    await w.campaign("Spring clinics", [sharing[channel][0]]);
    await w.h.advanceTo(MONDAY_9 + H);
    const second = await w.campaign("Autumn clinics", [sharing[channel][0]]);
    await w.h.advanceTo(w.h.clock + 2 * H);
    const owners: ConversationOwnerView[] = [{ name: "Spring clinics", test: false, lead: null }];
    expect(await w.track(second("Pat Oneil"))).toMatchObject({ finishReason: "skipped_conversation_taken", conversationOwners: owners });
    const ended = await w.today(second("Pat Oneil"));
    expect(ended?.channels).toEqual([{ channel, why: "conversation_taken", owners }]);
    expect(noUsableChannelItem(ended ? [ended] : [], "2026-11-02", "Europe/London")?.body).toContain(WORDS[channel]("campaign Spring clinics"));
  });
});
