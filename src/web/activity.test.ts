import { describe, expect, test } from "vitest";
import type { ActivityEntry, DependentTrackState } from "../shared/api.ts";
import { describeEntry } from "./activity.tsx";

const campaign = { id: "c1", name: "Autumn physio" };
const at = "2026-11-02T09:05:00.000Z";
const one = (label: string) => ({ label, several: false });

describe("what the timeline says of a track that ended on a bad address (re-check B14)", () => {
  test("it says what the stored ending says, and does not claim another campaign marked the address", () => {
    // Stored: the email track failed on a bad destination, with no bounce event of this campaign's.
    // That is true of another campaign's bounce, and of this campaign's bounce observed before
    // migration 10, which kept no event. The entry claims neither.
    const said = describeEntry({ campaign, at, kind: "address_bad", channel: "email", track: one("Email track"), to: "sam@harbour.example" }, "Europe/London");
    expect(said.title).toBe("Email track ended");
    expect(said.body).toBe("sam@harbour.example is marked wrong, so nothing more is sent to it.");
  });
});

describe("what the timeline says of SMS, skipped and released tracks (ticket 13b)", () => {
  const say = (entry: ActivityEntry) => {
    const { title, body, track } = describeEntry(entry, "Europe/London");
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

describe("Activity is history; a present state or a day only from the server's read (council on 32454ea, C and D; verifier re-check, H)", () => {
  const call = (fields: Partial<Extract<ActivityEntry, { kind: "call"; channel: "call" }>>): ActivityEntry => ({
    campaign,
    at,
    kind: "call",
    channel: "call",
    track: one("Phone track"),
    outcome: "callback_requested",
    number: null,
    note: "",
    redial: false,
    callbackAt: "2026-11-02T15:00:00.000Z",
    onCallback: null,
    zone: "Europe/London",
    redialListedFrom: null,
    callbackOpen: false,
    declinedPath: null,
    afterDecline: [],
    ...fields,
  });
  const body = (entry: ActivityEntry, zone = "Europe/London") => describeEntry(entry, zone).body;

  test("a callback asked for says the hold only while the server says it is open", () => {
    expect(body(call({ callbackOpen: true }))).toBe("Callback asked for, Mon 2 Nov at 15:00 their time; their automated outreach in this campaign is held until you log how it went");
    expect(body(call({ callbackOpen: false }))).toBe("Callback asked for, Mon 2 Nov at 15:00 their time");
  });

  test("a redial names the day the engine listed it from; a skip for now on a callback is history", () => {
    expect(body(call({ outcome: "no_answer", callbackAt: null, redial: true, redialListedFrom: "2026-11-09" }))).toBe("Redial asked for: listed again from Mon 9 Nov");
    expect(body(call({ outcome: "skip_for_now", callbackAt: null, onCallback: "2026-11-02T15:00:00.000Z" }))).toBe("Skipped for now on the callback for Mon 2 Nov at 15:00 their time");
  });

  test("an unworked skip prints the engine's calendar due date as a date, and each track after it as it stands", () => {
    const skip = (after: Extract<ActivityEntry, { reason: "unworked" }>["after"]): ActivityEntry => ({ campaign, at, kind: "skipped", channel: "call", track: one("Phone track"), stepNumber: null, reason: "unworked", dueDate: "2026-11-01", limitDays: 2, after });
    // A Honolulu user: the due date is the server's 1 November, whatever the browser's zone.
    expect(body(skip([]), "Pacific/Honolulu")).toBe("Not called within 2 days of its due date, Sun 1 Nov, so the call was skipped.");
    expect(body(skip([{ track: one("Email track 2"), state: "stopped", startsAt: null }]))).toBe("Not called within 2 days of its due date, Sun 1 Nov, so the call was skipped. Email track 2 did not start: their outreach in this campaign stopped.");
    expect(body(skip([{ track: one("Email track 2"), state: "held", startsAt: null }]))).toContain("Email track 2 starts after its delay, once their outreach is no longer held.");
    expect(body(skip([{ track: one("Email track 2"), state: "waiting", startsAt: "2026-11-06T00:00:00.000Z" }]), "Pacific/Honolulu")).toContain("Email track 2 starts after its delay, on Thu 5 Nov.");
  });
});

describe("what the timeline says of a declined call (ticket 16)", () => {
  const say = (entry: ActivityEntry) => {
    const { title, body, track } = describeEntry(entry, "Europe/London");
    return [title, body, track];
  };
  const number = { detailId: "d1", kind: "direct" as const, owner: "person" as const, value: "+44 20 7946 0111" };

  test("it says the path the decline took, as stored, then the number and the note", () => {
    const declined = (declinedPath: "stop" | "continue" | "win_back") => ({ campaign, at, kind: "call" as const, channel: "call" as const, track: one("Phone track"), outcome: "not_interested" as const, number, note: "Happy with their supplier.", declinedPath, redial: false, callbackAt: null, onCallback: null, zone: "Europe/London", redialListedFrom: null, callbackOpen: false, afterDecline: [] });
    expect(say(declined("stop"))).toEqual(["Call: not interested", "Stopped in this campaign. +44 20 7946 0111, direct. Happy with their supplier.", null]);
    expect(say(declined("continue"))).toEqual(["Call: not interested", "No more calls in this campaign; the other channels were kept going. +44 20 7946 0111, direct. Happy with their supplier.", null]);
    expect(say(declined("win_back"))).toEqual(["Call: not interested", "Moved to this campaign’s win-back branch, with no more calls. +44 20 7946 0111, direct. Happy with their supplier.", null]);
    // Any other call has no path.
    expect(say({ campaign, at, kind: "call", channel: "call", track: one("Phone track"), outcome: "no_answer", number, note: "", declinedPath: null, redial: false, callbackAt: null, onCallback: null, zone: "Europe/London", redialListedFrom: null, callbackOpen: false, afterDecline: [] })).toEqual(["Call: no answer", "+44 20 7946 0111, direct", null]);
  });
});

describe("every track state the server sends after an unworked skip has its own sentence, and only a server state promises a start (verifier on 2027f24)", () => {
  test("the table walks every state", async () => {
    const { dependentLine } = await import("./activity.tsx");
    const track = { label: "Email track 2", several: false };
    const table: Record<DependentTrackState["state"], string> = {
      started: "Email track 2 started after it.",
      finished: "Email track 2 has finished.",
      waiting: "Email track 2 starts after its delay, on Sat 14 Nov.",
      held: "Email track 2 starts after its delay, once their outreach is no longer held.",
      dropped_for_win_back: "Email track 2 will not start: they moved to this campaign’s win-back branch.",
      skipped_declined: "Email track 2 was skipped: they declined on a call.",
      skipped_unworked: "Email track 2 was skipped: its call wasn’t made within its skip limit.",
      skipped_no_channel: "Email track 2 was skipped: there is nothing to reach them on for it.",
      skipped: "Email track 2 was skipped.",
      stopped: "Email track 2 did not start: their outreach in this campaign stopped.",
      stopped_after_start: "Email track 2 started after it, then stopped: their outreach in this campaign stopped.",
      no_more_calls: "Email track 2 will not call them: they declined on a call.",
      not_started: "Email track 2 has not started.",
    };
    for (const [state, sentence] of Object.entries(table) as [DependentTrackState["state"], string][]) {
      const a = (state === "waiting" ? { track, state, startsAt: "2026-11-14T01:05:00.000Z" } : { track, state, startsAt: null }) as { track: typeof track } & DependentTrackState;
      expect(dependentLine(a, "Europe/London"), state).toBe(sentence);
    }
    // Only waiting and held, states the server read, say it will start.
    expect(Object.entries(table).filter(([, s]) => s.includes("starts after")).map(([k]) => k).sort()).toEqual(["held", "waiting"]);
  });
});

describe("what a decline did to each remaining track, as the server's read holds it now (ticket 16c)", () => {
  const number = { detailId: "d1", kind: "direct" as const, owner: "person" as const, value: "+44 20 7946 0111" };
  const several = (label: string) => ({ label, several: true });
  test("history in the past tense; a present state only as the read's state says it", () => {
    const entry: ActivityEntry = {
      campaign,
      at,
      kind: "call",
      channel: "call",
      track: one("Phone track"),
      outcome: "not_interested",
      number,
      note: "",
      declinedPath: "win_back",
      redial: false,
      callbackAt: null,
      onCallback: null,
      zone: "Europe/London",
      redialListedFrom: null,
      callbackOpen: false,
      afterDecline: [
        { track: several("Email track 1"), branch: "main", state: "dropped_for_win_back", startsAt: null },
        { track: several("Phone track 2"), branch: "main", state: "dropped_for_win_back", startsAt: null },
        { track: several("Win-back email track 1"), branch: "win_back", state: "started", startsAt: null },
        { track: several("Win-back email track 2"), branch: "win_back", state: "waiting", startsAt: "2026-11-04T00:00:00.000Z" },
      ],
    };
    expect(describeEntry(entry, "Europe/London").body).toBe(
      "Moved to this campaign’s win-back branch, with no more calls. Email track 1 was dropped for the win-back branch. Phone track 2 was dropped for the win-back branch. Win-back email track 1 started, and is running. Win-back email track 2 starts after its delay, on Wed 4 Nov. +44 20 7946 0111, direct",
    );
    // After a reply in win-back the same entry reads the lead as it stands: the branch's unstarted track never starts.
    const replied = { ...entry, afterDecline: [{ track: several("Win-back email track 1"), branch: "win_back" as const, state: "finished" as const, startsAt: null }, { track: several("Win-back email track 2"), branch: "win_back" as const, state: "stopped" as const, startsAt: null }] };
    expect(describeEntry(replied, "Europe/London").body).toBe("Moved to this campaign’s win-back branch, with no more calls. Win-back email track 1 has finished. Win-back email track 2 did not start: their outreach in this campaign stopped. +44 20 7946 0111, direct");
  });
});
