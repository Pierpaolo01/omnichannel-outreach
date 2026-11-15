import { describe, expect, test } from "vitest";
import { attentionItems } from "./wording.ts";
import { capacityItems, interruptionLine, noUsableChannelItem, providerWaitItems, sendingInterruptedItem } from "./interruption.ts";

/**
 * Today's one-line interruption notice (ticket 20b; spec: "sending was interrupted from X to Y; N sends rescheduled"),
 * from GET /api/today's `interruption`, `date` and `userZone` of the one read. Expected lines are written out by hand.
 */
describe("the interruption line on Today", () => {
  const zone = "Europe/Amsterdam";

  test("an interruption within today: times only, in the user's zone", () => {
    expect(interruptionLine({ from: "2026-11-15T08:10:00Z", to: "2026-11-15T09:45:00Z", rescheduled: 14 }, "2026-11-15", zone)).toBe(
      "Sending was interrupted from 09:10 to 10:45; 14 sends rescheduled.",
    );
  });

  test("across days: the date wherever it is not today, as the user's zone counts the day", () => {
    // 22:30 UTC on the 14th is 23:30 in Amsterdam, still the 14th; 06:00 UTC on the 15th is 07:00 today.
    expect(interruptionLine({ from: "2026-11-14T22:30:00Z", to: "2026-11-15T06:00:00Z", rescheduled: 3 }, "2026-11-15", zone)).toBe(
      "Sending was interrupted from Sat 14 Nov at 23:30 to 07:00; 3 sends rescheduled.",
    );
    // 23:30 UTC on the 14th is already the 15th in Amsterdam.
    expect(interruptionLine({ from: "2026-11-14T23:30:00Z", to: "2026-11-15T06:00:00Z", rescheduled: 3 }, "2026-11-15", zone)).toBe(
      "Sending was interrupted from 00:30 to 07:00; 3 sends rescheduled.",
    );
  });

  test("a notice kept from an earlier day (question Q18's interim): both ends dated", () => {
    expect(interruptionLine({ from: "2026-11-12T13:00:00Z", to: "2026-11-12T15:20:00Z", rescheduled: 2 }, "2026-11-15", zone)).toBe(
      "Sending was interrupted from Thu 12 Nov at 14:00 to Thu 12 Nov at 16:20; 2 sends rescheduled.",
    );
  });

  test("one send, and none", () => {
    expect(interruptionLine({ from: "2026-11-15T08:10:00Z", to: "2026-11-15T08:40:00Z", rescheduled: 1 }, "2026-11-15", zone)).toBe(
      "Sending was interrupted from 09:10 to 09:40; 1 send rescheduled.",
    );
    expect(interruptionLine({ from: "2026-11-15T08:10:00Z", to: "2026-11-15T08:40:00Z", rescheduled: 0 }, "2026-11-15", zone)).toBe(
      "Sending was interrupted from 09:10 to 09:40; no sends rescheduled.",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Needs attention's ticket 20 entries (ticket 20b), from the reads' own lists. Fictitious names.

const TODAY = "2026-11-15";
const ZONE = "Europe/Amsterdam";
const CLINICS = { id: "c1", name: "Clinics, Rotterdam" };
const PHYSIO = { id: "c2", name: "Physiotherapy, Greater London" };
const HARBOUR = { id: "co1", name: "Harbour Lane Physio" };
const SAM = { id: "p1", name: "Sam Reed" };
const NIA = { id: "p2", name: "Nia Cole" };

const capacity = (enrollmentId: string, person: typeof SAM | null, campaign: typeof CLINICS, channel: "email" | "sms", resetsAt: string) => ({
  enrollmentId,
  campaignId: campaign.id,
  person,
  company: HARBOUR,
  campaign,
  trackId: "t1",
  stepId: `s-${enrollmentId}-${channel}`,
  channel,
  dueAt: "2026-11-15T08:00:00Z",
  accountIds: ["inbox-a"],
  resetsAt,
});

describe("sending not running now, by the read's cause", () => {
  test("not running: since when, what waits, and no link, since nothing on a page restarts it", () => {
    expect(sendingInterruptedItem({ since: "2026-11-15T08:10:00Z", cause: "not_running", lastFailedRead: null }, TODAY, ZONE)).toEqual({
      key: "sending-interrupted",
      tone: "crit",
      title: "Sending is not running",
      body: "No sending round has run since 09:10. Due email and texts wait, and due calls may not reach your list until it runs again; nothing is dropped.",
      action: null,
    });
  });

  test("rounds failing, dated when it began on another day", () => {
    expect(sendingInterruptedItem({ since: "2026-11-14T21:00:00Z", cause: "ticks_failing", lastFailedRead: null }, TODAY, ZONE)).toMatchObject({
      title: "Sending is failing",
      body: "Every sending round since Sat 14 Nov at 22:00 has failed. Due email and texts wait, and due calls may not reach your list until one succeeds; nothing is dropped.",
    });
  });

  test("a provider not answering: the read that failed last, and which part of the round", () => {
    expect(
      sendingInterruptedItem({ since: "2026-11-15T08:10:00Z", cause: "providers_unreachable", lastFailedRead: { channel: "email", part: "observation", at: "2026-11-15T08:42:00Z" } }, TODAY, ZONE),
    ).toMatchObject({
      title: "Sending is interrupted",
      body: "Since 09:10 not every provider has answered; Instantly’s report of replies, bounces and sends last failed at 09:42. Due sends that depend on it wait; nothing is dropped.",
    });
    expect(sendingInterruptedItem({ since: "2026-11-15T08:10:00Z", cause: "providers_unreachable", lastFailedRead: { channel: "sms", part: "accounts", at: "2026-11-15T08:42:00Z" } }, TODAY, ZONE).body).toBe(
      "Since 09:10 not every provider has answered; the SMS provider’s list of numbers last failed at 09:42. Due sends that depend on it wait; nothing is dropped.",
    );
    expect(sendingInterruptedItem({ since: "2026-11-15T08:10:00Z", cause: "providers_unreachable", lastFailedRead: { channel: "email", part: "call", at: "2026-11-15T08:42:00Z" } }, TODAY, ZONE).body).toBe(
      "Since 09:10 not every provider has answered; a request to Instantly last failed at 09:42. Due sends that depend on it wait; nothing is dropped.",
    );
    expect(sendingInterruptedItem({ since: "2026-11-15T08:10:00Z", cause: "providers_unreachable", lastFailedRead: null }, TODAY, ZONE).body).toBe(
      "Since 09:10 not every provider has answered. Due sends that depend on a provider not answering wait; nothing is dropped.",
    );
  });
});

describe("sends waiting on a provider that is not answering", () => {
  test("one entry per provider: the provider, since when, and how many sends", () => {
    expect(providerWaitItems([{ channel: "email", since: "2026-11-15T08:10:00Z", sends: 12 }, { channel: "sms", since: null, sends: 1 }], TODAY, ZONE)).toEqual([
      { key: "provider-email", tone: "crit", title: "Instantly isn’t answering", body: "It hasn’t answered since 09:10. 12 email sends wait on it; they go once it answers, and nothing is dropped." },
      { key: "provider-sms", tone: "crit", title: "The SMS provider isn’t answering", body: "It hasn’t answered yet. 1 text waits on it; it goes once it answers, and nothing is dropped." },
    ]);
  });
});

describe("leads waiting for sending capacity", () => {
  test("one lead: named, linked to their record, with when the first account resets", () => {
    expect(capacityItems([capacity("e1", SAM, CLINICS, "email", "2026-11-15T23:00:00Z")], TODAY, ZONE)).toEqual([
      {
        key: "capacity-c1",
        tone: "pause",
        title: "Sam Reed is waiting for sending capacity",
        body: "In Clinics, Rotterdam, their due email waits: every inbox it may use is full for the day. The first resets on Mon 16 Nov at 00:00; nothing is dropped.",
        action: { label: "Open record", href: "/leads/people/p1", ariaLabel: "Open Sam Reed’s record" },
      },
    ]);
  });

  test("a company lead links to the company record", () => {
    expect(capacityItems([capacity("e1", null, CLINICS, "sms", "2026-11-15T20:00:00Z")], TODAY, ZONE)[0]).toMatchObject({
      title: "Harbour Lane Physio is waiting for sending capacity",
      body: "In Clinics, Rotterdam, their due text waits: every SMS number it may use is full for the day. The first resets at 21:00; nothing is dropped.",
      action: { label: "Open record", href: "/leads/companies/co1", ariaLabel: "Open Harbour Lane Physio’s record" },
    });
  });

  test("several leads: one entry per campaign, in the read's order, counting leads, not steps; the earliest reset", () => {
    const items = capacityItems(
      [
        capacity("e1", SAM, PHYSIO, "email", "2026-11-15T23:00:00Z"),
        capacity("e2", NIA, CLINICS, "email", "2026-11-15T23:00:00Z"),
        capacity("e1", SAM, PHYSIO, "sms", "2026-11-15T20:00:00Z"),
        capacity("e3", SAM, PHYSIO, "email", "2026-11-15T23:00:00Z"),
      ],
      TODAY,
      ZONE,
    );
    expect(items.map((i) => i.key)).toEqual(["capacity-c2", "capacity-c1"]);
    expect(items[0]).toEqual({
      key: "capacity-c2",
      tone: "pause",
      title: "2 leads in Physiotherapy, Greater London are waiting for sending capacity",
      body: "Their due email and text wait: every inbox and SMS number they may use is full for the day. The first resets at 21:00; nothing is dropped.",
      action: { label: "Open campaign", href: "/campaigns/c2/leads", ariaLabel: "Open Physiotherapy, Greater London" },
    });
  });
});

describe("leads left with no usable channel (question Q20's interim: they stay listed)", () => {
  const ended = (enrollmentId: string, person: typeof SAM | null, endedAt: string, channels: { channel: "email" | "sms" | "call"; why: "missing" | "bad" | "declined" }[]) => ({
    enrollmentId,
    campaignId: CLINICS.id,
    person,
    company: HARBOUR,
    campaign: CLINICS,
    endedAt,
    channels,
  });

  test("one lead: why each channel cannot reach them, when it ended, and their record", () => {
    expect(
      noUsableChannelItem(
        [ended("e1", SAM, "2026-11-14T09:00:00Z", [{ channel: "email", why: "bad" }, { channel: "sms", why: "missing" }, { channel: "call", why: "declined" }])],
        TODAY,
        ZONE,
      ),
    ).toEqual({
      key: "no-usable-channel",
      tone: "end",
      title: "No way was left to reach Sam Reed",
      body: "In Clinics, Rotterdam, their outreach ended on Sat 14 Nov at 10:00, when no channel could reach them. Now their email address is marked wrong, they have no mobile number, and they declined on a call.",
      action: { label: "Open record", href: "/leads/people/p1", ariaLabel: "Open Sam Reed’s record" },
    });
  });

  test("each reason the read can give, said once", () => {
    const body = (channel: "email" | "sms" | "call", why: "missing" | "bad" | "declined") => noUsableChannelItem([ended("e1", SAM, "2026-11-15T08:00:00Z", [{ channel, why }])], TODAY, ZONE)?.body;
    expect(body("email", "missing")).toBe("In Clinics, Rotterdam, their outreach ended at 09:00, when no channel could reach them. Now they have no email address.");
    expect(body("sms", "bad")).toBe("In Clinics, Rotterdam, their outreach ended at 09:00, when no channel could reach them. Now their mobile number is marked wrong.");
    expect(body("call", "missing")).toBe("In Clinics, Rotterdam, their outreach ended at 09:00, when no channel could reach them. Now they have no number to call.");
    expect(body("call", "bad")).toBe("In Clinics, Rotterdam, their outreach ended at 09:00, when no channel could reach them. Now every number to call is marked wrong.");
  });

  test("details restored by a later import (review bot on 487de7c): the ending is said as past and final, with no empty reason", () => {
    expect(noUsableChannelItem([ended("e1", SAM, "2026-11-14T09:00:00Z", [])], TODAY, ZONE)).toMatchObject({
      title: "No way was left to reach Sam Reed",
      body: "In Clinics, Rotterdam, their outreach ended on Sat 14 Nov at 10:00, when no channel could reach them. Each channel this campaign uses could reach them now, but the ending is final.",
    });
  });

  test("several: one entry, the most recent named, and a link to them in Leads", () => {
    expect(noUsableChannelItem([ended("e2", NIA, "2026-11-15T08:00:00Z", [{ channel: "email", why: "missing" }]), ended("e1", null, "2026-11-12T08:00:00Z", [{ channel: "email", why: "bad" }])], TODAY, ZONE)).toEqual({
      key: "no-usable-channel",
      tone: "end",
      title: "No way was left to reach 2 leads",
      body: "Their outreach ended because no channel could reach them then: details missing or marked wrong, or a decline on a call. The most recent is Nia Cole in Clinics, Rotterdam, at 09:00.",
      action: { label: "Show them", href: "/leads?status=finished_no_usable_channel" },
    });
  });

  test("none: no entry", () => {
    expect(noUsableChannelItem([], TODAY, ZONE)).toBeNull();
  });
});

describe("the order of Needs attention (ticket 20b): the prototype's, with the new entries beside their kind", () => {
  test("calls first, then sending and providers, accounts, held work, capacity, anomalies, and leads with no way left last", () => {
    const items = attentionItems(
      {
        overdueCallbacks: [],
        stalledInboxes: [{ accountId: "inbox-b", holding: ["x"] }],
        heldTracks: [{ enrollmentId: "e9", trackId: "t1", reason: "unresolved" }],
        accountWaits: [{ accountId: "inbox-c", reason: "quota", until: null }],
        senderProblems: [{ accountId: "sms-1", channel: "sms", label: "+31 97 0102 3344", problem: "disconnected" }],
        heldCapacity: [{ accountId: "inbox-d", held: 1, capacity: 30, sentToday: 4, work: [] }],
        anomalies: [{ what: "Something odd.", at: "2026-11-15T08:00:00Z" }],
        waitingForCapacity: [capacity("e1", SAM, CLINICS, "email", "2026-11-15T23:00:00Z")],
        noUsableChannel: [{ enrollmentId: "e2", campaignId: CLINICS.id, person: NIA, company: HARBOUR, campaign: CLINICS, endedAt: "2026-11-15T08:00:00Z", channels: [{ channel: "email", why: "missing" }] }],
        waitingOnProvider: [{ channel: "email", since: "2026-11-15T08:10:00Z", sends: 3 }],
        waitingOnTransport: [],
      },
      { overdueCallbacks: [], userZone: ZONE, date: TODAY, carriedOver: 2, carriedOverLastDay: 0, sendingInterrupted: { since: "2026-11-15T08:10:00Z", cause: "providers_unreachable", lastFailedRead: null } },
    );
    expect(items.map((i) => i.key)).toEqual([
      "carried-over",
      "sending-interrupted",
      "provider-email",
      "sender-sms-1",
      "wait-inbox-c",
      "stalled-inbox-b",
      "held-inbox-d",
      "tracks-unresolved",
      "capacity-c1",
      "anomaly-0",
      "no-usable-channel",
    ]);
  });

  test("nothing in either read: no entry, so the page says nothing needs you", () => {
    const empty = { overdueCallbacks: [], stalledInboxes: [], heldTracks: [], accountWaits: [], senderProblems: [], heldCapacity: [], anomalies: [], waitingForCapacity: [], noUsableChannel: [], waitingOnProvider: [], waitingOnTransport: [] };
    expect(attentionItems(empty, { overdueCallbacks: [], userZone: ZONE, date: TODAY, carriedOver: 0, carriedOverLastDay: 0, sendingInterrupted: null })).toEqual([]);
  });
});
