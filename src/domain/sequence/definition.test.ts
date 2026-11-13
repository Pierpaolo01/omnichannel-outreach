import { describe, expect, test } from "vitest";
import { launchCheck } from "./blockers.ts";
import { render } from "./copy.ts";
import { definitionProblems, WIN_BACK_LATER, type CampaignDefinition, type StepDefinition, type TrackDefinition } from "./definition.ts";

const step = (id: string, fields: Partial<StepDefinition> = {}): StepDefinition => ({
  id,
  waitDays: 0,
  subject: "Hello {{first_name|there}}",
  body: "A note for {{company}}.",
  threading: "continue_thread",
  removed: false,
  ...fields,
});

const emailTrack = (fields: Partial<TrackDefinition> = {}): TrackDefinition => ({
  id: "t1",
  channel: "email",
  branch: "main",
  window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })),
  steps: [step("s1", { threading: "new_subject" }), step("s2", { waitDays: 2 })],
  start: { kind: "entry" },
  removed: false,
  ...fields,
});

const definition = (fields: Partial<CampaignDefinition> = {}): CampaignDefinition => ({
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["inbox-1"],
  tracks: [emailTrack()],
  ...fields,
});

describe("definitions refused at the boundary (ADR 0003 7.1)", () => {
  test("one email track with ordered follow-ups is accepted", () => {
    expect(definitionProblems(definition())).toEqual([]);
  });

  test("email and SMS tracks in the main sequence, together or after a delay, are accepted (ticket 13)", () => {
    const sms = emailTrack({ id: "t2", channel: "sms", steps: [step("m1", { subject: "" }), step("m2", { waitDays: 1, subject: "" })], start: { kind: "after", trackId: "t1", delayDays: 2 } });
    const together = emailTrack({ id: "t3", channel: "sms", steps: [step("m3", { subject: "" })] });
    expect(definitionProblems(definition({ smsPool: ["+447700900001"], tracks: [emailTrack(), sms, together] }))).toEqual([]);
    // An SMS step has no subject and no thread: its threading is not read.
    expect(definitionProblems(definition({ tracks: [emailTrack({ channel: "sms", steps: [step("m1")] })] }))).toEqual([]);
  });

  test("the win-back branch is refused until the ticket that builds it", () => {
    expect(definitionProblems(definition({ tracks: [emailTrack({ branch: "win_back" })] }))).toEqual([WIN_BACK_LATER]);
  });

  test("a phone track is exactly one call, with no wait and no copy, and connects together or after like any track (ticket 14)", () => {
    const call = (fields: Partial<TrackDefinition> = {}) => emailTrack({ id: "t2", channel: "call", steps: [step("c1", { subject: "", body: "" })], ...fields });
    const after = { kind: "after" as const, trackId: "t1", delayDays: 1 };
    expect(definitionProblems(definition({ callScript: "Ask who handles bookings.", tracks: [emailTrack(), call(), call({ id: "t3", steps: [step("c2", { subject: "", body: "" })], start: after })] }))).toEqual([]);
    // A call-only campaign is a campaign: its calling hours are the track's window.
    expect(definitionProblems(definition({ emailPool: [], tracks: [call({ start: { kind: "entry" } })] }))).toEqual([]);
    expect(definitionProblems(definition({ tracks: [emailTrack(), call({ steps: [step("c1"), step("c2", { waitDays: 1 })] })] }))).toEqual(["The phone track is one call with no follow-ups: give it exactly one step."]);
    expect(definitionProblems(definition({ tracks: [emailTrack(), call({ steps: [] })] }))).toEqual(["The phone track is one call with no follow-ups: give it exactly one step."]);
    // A removed step does not count, so a track may replace its call.
    expect(definitionProblems(definition({ tracks: [emailTrack(), call({ steps: [step("c0", { removed: true }), step("c1")] })] }))).toEqual([]);
    expect(definitionProblems(definition({ tracks: [emailTrack(), call({ window: [] })] }))).toEqual(["The phone track's calling hours have no days."]);
    // The declined path is set on the canvas; win-back arrives with its branch (ticket 16).
    expect(definitionProblems(definition({ tracks: [emailTrack(), call({ declinedPath: "continue" })] }))).toEqual([]);
    expect(definitionProblems(definition({ tracks: [emailTrack(), call({ declinedPath: "win_back" })] }))).toEqual([WIN_BACK_LATER]);
  });

  test("a start rule names a live track of the same branch, with a whole delay, and connections never go in a circle", () => {
    const after = (trackId: string, delayDays = 1) => ({ kind: "after" as const, trackId, delayDays });
    const second = (fields: Partial<TrackDefinition>) => emailTrack({ id: "t2", channel: "sms", steps: [step("m1")], ...fields });
    expect(definitionProblems(definition({ tracks: [emailTrack(), second({ start: after("t9") })] }))).toEqual(["The SMS track starts after a track that is not in the sequence."]);
    expect(definitionProblems(definition({ tracks: [emailTrack({ removed: true }), second({ start: after("t1") })] }))).toEqual(["The SMS track starts after a track that is not in the sequence."]);
    expect(definitionProblems(definition({ tracks: [emailTrack(), second({ start: after("t1", 1.5) })] }))).toEqual(["The delay before the SMS track is a whole number of days."]);
    expect(definitionProblems(definition({ tracks: [emailTrack(), second({ start: after("t1", -1) })] }))).toEqual(["The delay before the SMS track is a whole number of days."]);
    expect(definitionProblems(definition({ tracks: [emailTrack({ start: after("t2") }), second({ start: after("t1") })] }))).toEqual(["The tracks' connections go in a circle, so none of them could start."]);
    expect(definitionProblems(definition({ tracks: [emailTrack({ start: after("t1") })] }))).toEqual(["The tracks' connections go in a circle, so none of them could start."]);
  });

  test("two tracks on one channel are named by their order", () => {
    const def = definition({ tracks: [emailTrack(), emailTrack({ id: "t2", window: [], steps: [step("s9", { threading: "new_subject" })] })] });
    expect(definitionProblems(def)).toEqual(["Email track 2's sending window has no days."]);
  });

  test("an SMS sender is listed once", () => {
    expect(definitionProblems(definition({ smsPool: ["+447700900001", "+447700900001"] }))).toEqual(["A sender account is listed twice."]);
  });

  test("a removed second track does not count", () => {
    expect(definitionProblems(definition({ tracks: [emailTrack(), emailTrack({ id: "t2", removed: true, steps: [] })] }))).toEqual([]);
  });

  test("waits: none on the first step, whole non-negative days after it", () => {
    expect(definitionProblems(definition({ tracks: [emailTrack({ steps: [step("s1", { threading: "new_subject", waitDays: 1 })] })] }))).toEqual([
      "Step 1 is the first step, so it has no wait.",
    ]);
    expect(definitionProblems(definition({ tracks: [emailTrack({ steps: [step("s1", { threading: "new_subject" }), step("s2", { waitDays: 1.5 })] })] }))).toEqual([
      "Step 2's wait is a whole number of days.",
    ]);
    expect(definitionProblems(definition({ tracks: [emailTrack({ steps: [step("s1", { threading: "new_subject" }), step("s2", { waitDays: -1 })] })] }))).toEqual([
      "Step 2's wait is a whole number of days.",
    ]);
  });

  test("continue thread cannot be the first email", () => {
    expect(definitionProblems(definition({ tracks: [emailTrack({ steps: [step("s1")] })] }))).toEqual([
      "Step 1 is the first email, so there is no thread to continue: give it a new subject.",
    ]);
  });

  test("windows need days and different start and end hours; zones must be IANA names", () => {
    expect(definitionProblems(definition({ tracks: [emailTrack({ window: [] })] }))).toEqual(["The email track's sending window has no days."]);
    expect(definitionProblems(definition({ tracks: [emailTrack({ window: [{ day: 1, start: 9, end: 9 }] })] }))).toEqual([
      "The email track's window starts and ends at the same hour.",
    ]);
    expect(definitionProblems(definition({ timezone: "Mars/Base" }))).toEqual([
      `The campaign's time zone "Mars/Base" is not an IANA time zone such as Europe/London.`,
    ]);
  });

  test("an edit cannot change a track's channel or move a step to another track", () => {
    const before = definition();
    expect(definitionProblems(definition({ tracks: [emailTrack({ channel: "sms" })] }), before)).toContain("A track cannot change channel: remove it and add a new one.");
    const moved = definition({ tracks: [emailTrack({ removed: true }), emailTrack({ id: "t2", steps: [step("s1", { threading: "new_subject" })] })] });
    expect(definitionProblems(moved, before)).toContain("A step cannot move to another track: remove it and add a new one.");
  });

  test("ids are unique", () => {
    expect(definitionProblems(definition({ tracks: [emailTrack({ steps: [step("s1", { threading: "new_subject" }), step("s1", { waitDays: 1 })] })] }))).toContain("Two steps share the id s1.");
  });
});

describe("merge fields", () => {
  test("a fallback is used when the lead lacks the field", () => {
    expect(render("Hi {{first_name|there}}, {{ company }}", { company: "Harbour Lane" })).toEqual({ ok: true, text: "Hi there, Harbour Lane" });
  });

  test("a field without fallback that the lead lacks fails, naming the field", () => {
    expect(render("Hi {{first_name}}", { first_name: "  " })).toEqual({ ok: false, missing: ["first_name"] });
  });
});

describe("exactly three launch blockers (ADR 0003 7.2)", () => {
  const inbox = { id: "inbox-1", channel: "email" as const, healthy: true };
  const lead = { first_name: "Pat", company: "Harbour Lane" };

  test("a complete email track with a connected inbox can launch", () => {
    expect(launchCheck(definition(), [lead], [inbox])).toEqual({ blockers: [], nothingToLaunch: false, canLaunch: true });
  });

  test("empty copy: an empty body, or an empty subject on a new-subject step", () => {
    const def = definition({ tracks: [emailTrack({ steps: [step("s1", { threading: "new_subject", subject: " " }), step("s2", { waitDays: 1, body: "", subject: "" })] })] });
    expect(launchCheck(def, [lead], [inbox]).blockers.map((b) => b.message)).toEqual(["Email 1 has no subject.", "Email 2 has no message."]);
  });

  test("a merge field with no fallback that some lead lacks", () => {
    const def = definition({ tracks: [emailTrack({ steps: [step("s1", { threading: "new_subject", body: "Hi {{first_name}} at {{title|your practice}}" })] })] });
    const check = launchCheck(def, [lead, { company: "Northgate" }, { company: "Elm" }], [inbox]);
    expect(check.blockers.map((b) => b.message)).toEqual(["2 leads have no first name, and {{first_name}} has no fallback."]);
    expect(check.canLaunch).toBe(false);
  });

  test("no connected sender: an empty pool, or only unhealthy inboxes", () => {
    expect(launchCheck(definition({ emailPool: [] }), [lead], [inbox]).blockers.map((b) => b.kind)).toEqual(["no_sender"]);
    expect(launchCheck(definition(), [lead], [{ ...inbox, healthy: false }]).blockers.map((b) => b.message)).toEqual([
      "The email track has no connected sender inbox.",
    ]);
  });

  test("no connected sender is checked per channel: an SMS track needs a connected number in its pool (ticket 13)", () => {
    const sms = emailTrack({ id: "t2", channel: "sms", steps: [step("m1", { subject: "", body: "Hi {{first_name|there}}" })] });
    const number = { id: "+447700900001", channel: "sms" as const, healthy: true };
    expect(launchCheck(definition({ smsPool: [number.id], tracks: [emailTrack(), sms] }), [lead], [inbox, number])).toEqual({ blockers: [], nothingToLaunch: false, canLaunch: true });
    // No SMS provider: no number is connected, so the SMS track alone blocks launch.
    expect(launchCheck(definition({ smsPool: [number.id], tracks: [emailTrack(), sms] }), [lead], [inbox]).blockers).toEqual([
      { kind: "no_sender", trackId: "t2", channel: "sms", message: "The SMS track has no connected sender number." },
    ]);
    // An email inbox does not count for SMS, and an unhealthy number is not connected.
    expect(launchCheck(definition({ smsPool: [inbox.id], tracks: [sms] }), [lead], [inbox]).blockers.map((b) => b.kind === "no_sender" && b.channel)).toEqual(["sms"]);
    expect(launchCheck(definition({ smsPool: [number.id], tracks: [sms] }), [lead], [{ ...number, healthy: false }]).canLaunch).toBe(false);
  });

  test("an SMS step's empty message blocks launch; it has no subject to check", () => {
    const sms = emailTrack({ channel: "sms", steps: [step("m1", { subject: "", body: " " })] });
    expect(launchCheck(definition({ smsPool: ["n1"], tracks: [sms] }), [lead], [{ id: "n1", channel: "sms", healthy: true }]).blockers.map((b) => b.message)).toEqual(["Text 1 has no message."]);
  });

  test("a campaign with no track has nothing to launch, which is not a blocker", () => {
    expect(launchCheck(definition({ tracks: [] }), [lead], [inbox])).toEqual({ blockers: [], nothingToLaunch: true, canLaunch: false });
  });
});
