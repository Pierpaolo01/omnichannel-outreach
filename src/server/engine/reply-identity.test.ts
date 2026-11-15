import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { EnrollmentRead, LeadSearchResult } from "../../shared/api.ts";

/**
 * A reply's identity (ADR 0003 "Ticket 17a"): the reply the lead's record holds is the reply the provider reports, on
 * every channel. A lead resumed from its next step after a reply is not stopped again by that same reply at the
 * pre-send check; a new reply after the resume still stops it. Through the real HTTP app, SQLite store and engine,
 * against the fake providers. Data is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
/** Monday 2 November 2026, 09:00 London (GMT). */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const NUMBER = "+447700900010";
const MOBILE = "+447700900101";

const step = (id: string, waitDays: number, channel: "email" | "sms"): StepDefinition => ({ id, waitDays, subject: channel === "email" ? `Subject ${id}` : "", body: `Message ${id} for {{company}}.`, threading: "new_subject", removed: false });
const track = (channel: "email" | "sms"): TrackDefinition => ({ id: "t1", channel, branch: "main", window: ALWAYS, steps: [step("m1", 0, channel), step("m2", 2, channel)], start: { kind: "entry" }, removed: false });

async function world(channel: "email" | "sms") {
  const h = new EngineHarness({ start: MONDAY_9, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }], sms: { numbers: [{ id: NUMBER, capacity: 50, gapMs: MIN, k: 2, healthy: true, resetZone: "Europe/London" }] } });
  await h.tick();
  const harbour = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });
  const pat = person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", dial_phone: MOBILE, dial_phone_type: "mobile" });
  const { campaign } = await h.createCampaign("Clinics", { businesses: [harbour], people: [pat] });
  const def: CampaignDefinition = { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: [NUMBER], callScript: "Ask who looks after bookings.", tracks: [track(channel)] };
  await h.defineSequence(campaign.id, def);
  expect((await h.launch(campaign.id)).status).toBe(200);
  const lead = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows[0]!.enrollments[0]!.id;
  const status = async () => (await h.request<EnrollmentRead>("GET", `/api/enrollments/${lead}`)).body.status;
  const sent = () => (channel === "sms" ? h.sms.deliveryLog : h.fake.deliveryLog).filter((d) => d.subjectId === lead).map((d) => d.stepId);
  const reply = () => (channel === "sms" ? h.sms.prospectTexts(MOBILE, "Not now", NUMBER) : h.fake.prospectReplies("pat@harbour.example"));
  // The first message goes; Pat replies, the app observes it and the lead ends replied; the user resumes it.
  await h.advanceTo(MONDAY_9 + H);
  expect(sent()).toEqual(["m1"]);
  expect(reply()).toBe(true);
  await h.advanceTo(MONDAY_9 + 2 * H);
  expect(await status()).toBe("replied");
  expect((await h.request("POST", `/api/enrollments/${lead}/controls`, { requestId: "r1", action: "resume_from_next_step" })).status).toBe(200);
  return { h, status, sent, reply };
}

describe("a lead resumed after a reply", () => {
  for (const channel of ["sms", "email"] as const) {
    test(`${channel}: the reply it was resumed after does not stop its next step`, async () => {
      const { h, status, sent } = await world(channel);
      await h.advanceTo(MONDAY_9 + 3 * DAY);
      expect(sent()).toEqual(["m1", "m2"]);
      expect(await status()).not.toBe("replied");
    });

    test(`${channel}: a new reply after the resume stops it again`, async () => {
      const { h, status, sent, reply } = await world(channel);
      await h.advanceTo(MONDAY_9 + DAY);
      expect(reply()).toBe(true);
      await h.advanceTo(MONDAY_9 + 3 * DAY);
      expect(sent()).toEqual(["m1"]);
      expect(await status()).toBe("replied");
    });
  }
});
