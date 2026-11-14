import { describe, expect, test } from "vitest";
import type { ActivityEntry } from "../shared/api.ts";
import { describeEntry } from "./activity.tsx";

const campaign = { id: "c1", name: "Autumn physio" };
const at = "2026-11-02T09:05:00.000Z";
const one = (label: string) => ({ label, several: false });

describe("what the timeline says of a track that ended on a bad address (re-check B14)", () => {
  test("it says what the stored ending says, and does not claim another campaign marked the address", () => {
    // Stored: the email track failed on a bad destination, with no bounce event of this campaign's.
    // That is true of another campaign's bounce, and of this campaign's bounce observed before
    // migration 10, which kept no event. The entry claims neither.
    const said = describeEntry({ campaign, at, kind: "address_bad", channel: "email", track: one("Email track"), to: "sam@harbour.example" });
    expect(said.title).toBe("Email track ended");
    expect(said.body).toBe("sam@harbour.example is marked wrong, so nothing more is sent to it.");
  });
});

describe("what the timeline says of SMS, skipped and released tracks (ticket 13b)", () => {
  const say = (entry: ActivityEntry) => {
    const { title, body, track } = describeEntry(entry);
    return [title, body, track];
  };

  test("a text sent, its number refused or reported bad, each by its own name", () => {
    expect(say({ campaign, at, kind: "sent", channel: "sms", track: one("SMS track"), stepNumber: 1, from: "+44 7700 900001", to: "+44 7700 900211", copy: { subject: "", body: "Hi." } })).toEqual(["Text 1 sent", null, null]);
    expect(say({ campaign, at, kind: "failed", channel: "sms", track: one("SMS track"), stepNumber: 2, to: "+44 7700 900244", reason: "invalid number" })).toEqual(["Text 2 failed", "+44 7700 900244: The number was refused as invalid. It is marked wrong.", null]);
    expect(say({ campaign, at, kind: "bounced", channel: "sms", track: one("SMS track"), stepNumber: 1, to: "+44 7700 900222" })).toEqual(["Text 1: bad number", "+44 7700 900222 was reported invalid and is marked wrong. Nothing more is texted to it.", null]);
  });

  test("with two tracks on one channel, the entry names its track, never its position", () => {
    expect(say({ campaign, at, kind: "sent", channel: "email", track: { label: "Email track 2", several: true }, stepNumber: 1, from: "a", to: "b", copy: null })).toEqual(["Email 1 sent", null, "Email track 2"]);
  });

  test("skipped and released tracks are said plainly", () => {
    expect(say({ campaign, at, kind: "skipped", channel: "sms", track: one("SMS track"), stepNumber: null, reason: "no_mobile" })).toEqual(["SMS track skipped", "No mobile of their own.", null]);
    expect(say({ campaign, at, kind: "skipped", channel: "sms", track: one("SMS track"), stepNumber: null, reason: "company_lead" })).toEqual(["SMS track skipped", "A company lead is never texted: a main line isn’t a mobile.", null]);
    expect(say({ campaign, at, kind: "released", channel: "sms", track: one("SMS track"), after: one("Email track"), because: "skipped" })).toEqual(["SMS track started", "It starts after the email track, which was skipped for this lead.", null]);
    expect(say({ campaign, at, kind: "released", channel: "email", track: { label: "Email track 2", several: true }, after: one("SMS track"), because: "failed" })).toEqual(["Email track 2 started", "It starts after the SMS track, which ended on a bad number.", null]);
  });
});

describe("what the timeline says of a declined call (ticket 16)", () => {
  const say = (entry: ActivityEntry) => {
    const { title, body, track } = describeEntry(entry);
    return [title, body, track];
  };
  const number = { detailId: "d1", kind: "direct" as const, owner: "person" as const, value: "+44 20 7946 0111" };

  test("it says the path the decline took, as stored, then the number and the note", () => {
    const declined = (declinedPath: "stop" | "continue" | "win_back") => ({ campaign, at, kind: "call" as const, channel: "call" as const, track: one("Phone track"), outcome: "not_interested" as const, number, note: "Happy with their supplier.", declinedPath });
    expect(say(declined("stop"))).toEqual(["Call: not interested", "Stopped in this campaign. +44 20 7946 0111, direct. Happy with their supplier.", null]);
    expect(say(declined("continue"))).toEqual(["Call: not interested", "No more calls in this campaign; the other channels continue. +44 20 7946 0111, direct. Happy with their supplier.", null]);
    expect(say(declined("win_back"))).toEqual(["Call: not interested", "Moved to this campaign’s win-back branch, with no more calls. +44 20 7946 0111, direct. Happy with their supplier.", null]);
    // Any other call has no path.
    expect(say({ campaign, at, kind: "call", channel: "call", track: one("Phone track"), outcome: "no_answer", number, note: "", declinedPath: null })).toEqual(["Call: no answer", "+44 20 7946 0111, direct", null]);
  });
});
