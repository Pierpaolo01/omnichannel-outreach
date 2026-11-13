import { describe, expect, test } from "vitest";
import { launchCheck } from "./blockers.ts";
import { render } from "./copy.ts";
import { definitionProblems, ONE_EMAIL_TRACK_FOR_NOW, ownSubject, type CampaignDefinition, type StepDefinition, type TrackDefinition } from "./definition.ts";
import { renderStep } from "./dispatch.ts";
import { subjectState } from "../../../test/support/sequence-state.ts";

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

  test("a second track, or a track on another channel, is refused with one email track for now", () => {
    expect(definitionProblems(definition({ tracks: [emailTrack(), emailTrack({ id: "t2", steps: [step("s9", { threading: "new_subject" })] })] }))).toContain(ONE_EMAIL_TRACK_FOR_NOW);
    expect(definitionProblems(definition({ tracks: [emailTrack({ channel: "sms" })] }))).toContain(ONE_EMAIL_TRACK_FOR_NOW);
    expect(definitionProblems(definition({ tracks: [emailTrack({ branch: "win_back" })] }))).toContain(ONE_EMAIL_TRACK_FOR_NOW);
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

  test("a campaign with no track has nothing to launch, which is not a blocker", () => {
    expect(launchCheck(definition({ tracks: [] }), [lead], [inbox])).toEqual({ blockers: [], nothingToLaunch: true, canLaunch: false });
  });
});

describe("a continue-thread email has no subject of its own (PR 41 council, item 3)", () => {
  // The subject is hidden in the editor once the email continues the thread, but may still be stored.
  const hidden = step("s2", { waitDays: 2, subject: "About {{city}}", body: "Following up." });
  const def = definition({ tracks: [emailTrack({ steps: [step("s1", { threading: "new_subject" }), hidden] })] });

  test("its stored subject raises no blocker, even for a field with no fallback that a lead lacks", () => {
    expect(launchCheck(def, [{ first_name: "Pat", company: "Harbour" }], [{ id: "inbox-1", channel: "email", healthy: true }]).blockers).toEqual([]);
  });

  test("it is not rendered: the handover carries an empty subject and the thread carries the conversation", () => {
    const state = subjectState({ campaign: { ...subjectState().campaign, definition: def } });
    expect(renderStep(state, "t1", "s2")).toEqual({ subject: "", body: "Following up." });
    expect(ownSubject(hidden)).toBe("");
    expect(ownSubject(step("s1", { threading: "new_subject", subject: "Hi" }))).toBe("Hi");
  });
});
