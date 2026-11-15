import { StatementSync } from "node:sqlite";
import { describe, expect, test, vi } from "vitest";
import { campaignMeasures } from "./measures.ts";
import { DAY, HOUR, MIN, MONDAY_9, launch, measuresWorld } from "../../test/support/measures-world.ts";

/**
 * The campaign measures (ticket 22; ADR 0003 "Ticket 22") through the HTTP read, on the fake providers: each figure a
 * tally of what the providers and the user did, as Activity and each lead's record show it.
 */

const NO_MESSAGES = { sent: 0, failedOrBounced: 0, replies: 0 };

describe("GET /api/campaigns/:id/measures", () => {
  test("a campaign that does not exist is not found", async () => {
    const { h } = await measuresWorld();
    expect((await h.request("GET", "/api/campaigns/nope/measures")).status).toBe(404);
  });

  test("before anything is sent every lead is queued and running, nothing is counted, and neither rate is a number", async () => {
    const world = await measuresWorld();
    const m = await world.measures();
    expect(m).toEqual({
      launched: false,
      leads: 4,
      groups: { running: 4, waiting_on_you: 0, handed_to_you: 0, paused: 0, ended: 0 },
      channels: ["email", "sms", "call"],
      email: NO_MESSAGES,
      sms: NO_MESSAGES,
      calls: { made: 0, connected: 0, interested: 0, declined: 0, callbacksPending: 0 },
      replyRate: { numerator: 0, denominator: 0, percent: null },
      connectRate: { numerator: 0, denominator: 0, percent: null },
    });
  });

  test("sent counts what the provider reported sent; refused and bounced messages count once each, a bounced one as sent too", async () => {
    const world = await measuresWorld((h) => {
      h.fake.bouncing.add("nia@harbour.example");
      h.fake.invalid.add("sam@harbour.example");
      h.sms.invalidAfterSend.add("+447700900104");
    });
    await launch(world);
    await world.h.advanceTo(MONDAY_9 + 2 * HOUR);
    const m = await world.measures();
    expect(m.launched).toBe(true);
    // s1 to Pat, Nia and Ivo (Sam's was refused); t1 to all four, Ivo's reported invalid after it was sent.
    expect(m.email).toEqual({ sent: 3, failedOrBounced: 2, replies: 0 });
    expect(m.sms).toEqual({ sent: 4, failedOrBounced: 1, replies: 0 });
    // The day after, s2 goes only to Pat and Ivo: Nia's address bounced and Sam's was invalid.
    await world.h.advanceTo(MONDAY_9 + DAY + 2 * HOUR);
    expect((await world.measures()).email).toEqual({ sent: 5, failedOrBounced: 2, replies: 0 });
  });

  test("replies count each replying lead once, by the channel of the reply that stopped them; the reply rate is over the leads reached", async () => {
    const world = await measuresWorld();
    await launch(world);
    await world.h.advanceTo(MONDAY_9 + 2 * HOUR);
    world.h.fake.prospectReplies("pat@harbour.example");
    world.h.sms.prospectTexts("+447700900102");
    await world.h.advanceTo(world.h.clock + 10 * MIN);
    let m = await world.measures();
    expect(m.email.replies).toBe(1);
    expect(m.sms.replies).toBe(1);
    expect(m.groups.handed_to_you).toBe(2);
    expect(m.replyRate).toEqual({ numerator: 2, denominator: 4, percent: 50 });
    // Pat replies again, by text: still one replying lead, still on email.
    world.h.sms.prospectTexts("+447700900101");
    world.h.fake.prospectReplies("pat@harbour.example");
    await world.h.advanceTo(world.h.clock + 10 * MIN);
    m = await world.measures();
    expect([m.email.replies, m.sms.replies, m.replyRate.numerator]).toEqual([1, 1, 2]);
    // Resumed after the reply, Pat is running again and no longer counted as replied.
    expect(await world.control("Pat Oneil", "resume_from_next_step")).toBe(200);
    m = await world.measures();
    expect([m.email.replies, m.replyRate.numerator, m.groups.handed_to_you]).toEqual([0, 1, 1]);
  });

  test("calls: skip for now is not a call; connected is a conversation; a callback is pending until its outcome; the connect rate is per call", async () => {
    const world = await measuresWorld();
    await launch(world);
    await world.h.advanceTo(MONDAY_9 + 30 * MIN);
    expect(await world.log("Pat Oneil", "skip_for_now")).toBe(200);
    expect(await world.log("Nia Cole", "gatekeeper", { redial: true })).toBe(200);
    expect(await world.log("Sam Reed", "interested")).toBe(200);
    expect(await world.log("Ivo Marsh", "callback_requested", { callbackAt: new Date(MONDAY_9 + 5 * HOUR).toISOString() })).toBe(200);
    let m = await world.measures();
    expect(m.calls).toEqual({ made: 3, connected: 2, interested: 1, declined: 0, callbacksPending: 1 });
    expect(m.connectRate).toEqual({ numerator: 2, denominator: 3, percent: 67 });
    // Pat (skipped for now) and Nia (redialed) still have their calls open, Ivo waits on a callback, Sam is handed to you.
    expect(m.groups).toEqual({ running: 0, waiting_on_you: 3, handed_to_you: 1, paused: 0, ended: 0 });
    // Pat's call, then Nia's redial the next day, and Ivo's callback at its time.
    expect(await world.log("Pat Oneil", "not_interested", { declinedPath: "continue" })).toBe(200);
    await world.h.advanceTo(MONDAY_9 + 5 * HOUR + MIN);
    expect(await world.log("Ivo Marsh", "no_answer")).toBe(200);
    await world.h.advanceTo(MONDAY_9 + DAY + 30 * MIN);
    expect(await world.log("Nia Cole", "voicemail")).toBe(200);
    m = await world.measures();
    expect(m.calls).toEqual({ made: 6, connected: 3, interested: 1, declined: 1, callbacksPending: 0 });
    expect(m.connectRate.percent).toBe(50);
  });

  test("a callback is pending while its lead is paused, and not once the lead is stopped", async () => {
    const world = await measuresWorld();
    await launch(world);
    await world.h.advanceTo(MONDAY_9 + 30 * MIN);
    expect(await world.log("Ivo Marsh", "callback_requested", { callbackAt: new Date(MONDAY_9 + 5 * HOUR).toISOString() })).toBe(200);
    expect(await world.control("Ivo Marsh", "pause")).toBe(200);
    let m = await world.measures();
    // The other three wait on their calls.
    expect([m.calls.callbacksPending, m.groups.paused, m.groups.waiting_on_you]).toEqual([1, 1, 3]);
    expect(await world.control("Ivo Marsh", "stop")).toBe(200);
    m = await world.measures();
    expect([m.calls.callbacksPending, m.groups.paused, m.groups.ended]).toEqual([0, 0, 1]);
  });

  test("a campaign pause moves no lead between groups; a lead pause moves that lead to paused", async () => {
    const world = await measuresWorld();
    await launch(world);
    await world.h.advanceTo(MONDAY_9 + 30 * MIN);
    const before = (await world.measures()).groups;
    expect((await world.h.request("POST", `/api/campaigns/${world.campaignId}/pause`, { requestId: "pause-campaign" })).status).toBe(200);
    expect((await world.measures()).groups).toEqual(before);
    expect((await world.h.request("POST", `/api/campaigns/${world.campaignId}/resume`, { requestId: "resume-campaign" })).status).toBe(200);
    expect(await world.control("Pat Oneil", "pause")).toBe(200);
    expect((await world.measures()).groups.paused).toBe(1);
  });

  test("another campaign's leads and activity are not counted, and only the channels a campaign has tracks on are named", async () => {
    const world = await measuresWorld();
    const { OTHERS, KESTREL, EMAIL_ONLY } = await import("../../test/support/measures-world.ts");
    const { campaign } = await world.h.createCampaign("Dentists", { businesses: [KESTREL], people: OTHERS });
    await world.h.defineSequence(campaign.id, EMAIL_ONLY);
    expect((await world.h.launch(campaign.id)).status).toBe(200);
    await launch(world);
    await world.h.advanceTo(MONDAY_9 + 2 * HOUR);
    world.h.fake.prospectReplies("rae@kestrel.example");
    await world.h.advanceTo(world.h.clock + 10 * MIN);
    const mine = await world.measures();
    expect([mine.leads, mine.email.sent, mine.email.replies]).toEqual([4, 4, 0]);
    const theirs = await world.measures(campaign.id);
    expect([theirs.leads, theirs.email.sent, theirs.email.replies, theirs.channels]).toEqual([2, 2, 1, ["email"]]);
  });
});

describe("the read's cost is bounded (ADR 0003 \"Ticket 22\", what the read costs)", () => {
  /** SQL statements run by `read`, counted on every statement's execution, as attention.test.ts counts them. */
  async function statements(read: () => Promise<unknown>): Promise<number> {
    const spies = (["get", "all", "run", "iterate"] as const).map((m) => vi.spyOn(StatementSync.prototype, m));
    try {
      await read();
      return spies.reduce((n, s) => n + s.mock.calls.length, 0);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  }

  test("seven statements, whatever the activity: the campaign, then one per kind of fact", async () => {
    const world = await measuresWorld((h) => h.fake.bouncing.add("nia@harbour.example"));
    const read = () => campaignMeasures(world.h.store.engine, world.campaignId);
    const before = await statements(read);
    await launch(world);
    await world.h.advanceTo(MONDAY_9 + 2 * HOUR);
    world.h.fake.prospectReplies("pat@harbour.example");
    await world.h.advanceTo(world.h.clock + 10 * MIN);
    expect(await world.log("Sam Reed", "callback_requested", { callbackAt: new Date(MONDAY_9 + 6 * HOUR).toISOString() })).toBe(200);
    const after = await statements(read);
    expect([before, after]).toEqual([7, 7]);
  });
});
