import { describe, expect, test } from "vitest";
import type { TestStepRow } from "../../shared/api.ts";
import { endingDetail, endingTitle, progressText, stepDetail, stepStateText, timeIn } from "./testRunWording.ts";

const row = (fields: Partial<TestStepRow>): TestStepRow => ({ trackId: "e", stepId: "e1", channel: "email", branch: "main", name: "Email 1", track: "Email track", state: "sent", at: "2026-11-02T10:41:00Z", taskId: null, outcome: null, reason: null, waits: null, ...fields });
const READ = "2026-11-02T10:42:20Z";

describe("the Test run tab says only what the run's facts say (ticket 21)", () => {
  test("times are in the campaign's zone, with the weekday when not today", () => {
    expect(timeIn("Europe/London", "2026-11-02T10:41:00Z", READ)).toBe("10:41");
    expect(timeIn("Europe/London", "2026-11-03T09:00:00Z", READ)).toBe("Tue 09:00");
  });

  test("a sent email says Sent, never delivered; a due step a minute off says so; a call on the list says where it is", () => {
    expect(stepStateText(row({}), "Europe/London", READ)).toBe("Sent 10:41");
    expect(stepStateText(row({ state: "due", at: "2026-11-02T10:43:10Z" }), "Europe/London", READ)).toBe("Earliest in about 1 min");
    expect(stepStateText(row({ state: "due", at: "2026-11-02T11:30:00Z" }), "Europe/London", READ)).toBe("Earliest 11:30");
    // ADR 0003 "Reads that say when": the window's opening on another day, and a reason with no time.
    expect(stepStateText(row({ state: "due", at: "2026-11-03T09:00:00Z" }), "Europe/London", READ)).toBe("Earliest Tue 09:00");
    expect(stepStateText(row({ state: "due", at: null, waits: "sending_capacity" }), "Europe/London", READ)).toBe("Waiting for sending capacity: every account it may use is full today");
    expect(stepStateText(row({ channel: "call", state: "on_your_list" }), "Europe/London", READ)).toBe("On your Calls list");
    expect(stepStateText(row({ channel: "call", state: "listed_later", at: "2026-11-03T00:00:00Z" }), "Europe/London", READ)).toBe("On your list from Tue 3 Nov");
    expect(stepStateText(row({ channel: "call", state: "logged", outcome: "not_interested" }), "Europe/London", READ)).toBe("Logged 10:41: Not interested");
  });

  test("a text held for its transport names the SMS provider, an email the email provider (the re-check of ff01571)", () => {
    expect(stepStateText(row({ channel: "sms", stepId: "m2", name: "Text 2", state: "due", at: null, waits: "no_transport" }), "Europe/London", READ)).toBe("Waiting: the SMS provider can’t send this text yet");
    expect(stepStateText(row({ state: "due", at: null, waits: "no_transport" }), "Europe/London", READ)).toBe("Waiting: the email provider can’t send a follow-up in its thread yet");
  });

  test("a step names where it went, and a win-back step not reached says when it would run", () => {
    const run = { email: "alex.own@personal-mail.example", mobile: "+44 7700 900456", running: true };
    expect(stepDetail(row({}), run)).toBe("To alex.own@personal-mail.example");
    expect(stepDetail(row({ channel: "sms" }), run)).toBe("To +44 7700 900456");
    expect(stepDetail(row({ branch: "win_back", state: "not_reached", at: null }), run)).toBe("Runs if you log Not interested and the path is Win back");
    // A held step is never said to be due: it says why, as Needs attention does (council on faac357, item 4).
    expect(stepStateText(row({ channel: "sms", state: "held", at: null, hold: "provider_skipped" }), "Europe/London", READ)).toBe("On hold");
    expect(stepDetail(row({ channel: "sms", state: "held", at: null, hold: "provider_skipped" }), run)).toBe("On hold because the provider skipped the lead. Nothing is dropped.");
    // Question Q7 answered (provisional for test runs): a test mobile in another campaign's conversation is skipped, and says whose.
    expect(stepDetail(row({ channel: "sms", state: "skipped", reason: "sms_conversation_taken", owners: [{ name: "Spring clinics", test: false }] }), run)).toBe(
      "Skipped: your test mobile was already in a text conversation with campaign Spring clinics on every number this campaign can use",
    );
  });

  test("endings in their own words, and progress counts the branch only once entered", () => {
    expect(endingTitle("your_reply", null)).toBe("Stopped by your reply");
    expect(endingTitle("edited", null)).toBe("Stopped by an edit");
    const steps = [row({}), row({ stepId: "e2", state: "due" }), row({ stepId: "w1", branch: "win_back", state: "not_reached", at: null })];
    expect(progressText({ id: "t", running: true, ending: null, startedAt: READ, endedAt: null, renderAs: { id: "l", name: "Pat" }, email: null, mobile: null, linkedin: null, status: "active", mayStillSend: 0, steps, linkedinTracks: [], replyMarks: {}, social: { instagram: null } })).toBe("1 of 2 steps done");
  });

  test("a finished test says what went and what was skipped and why, never that every step ran when some did not (council on ffa202c, item 13)", () => {
    const run = (steps: TestStepRow[]) => ({ id: "t", running: false, ending: "finished" as const, startedAt: READ, endedAt: READ, renderAs: { id: "l", name: "Pat" }, email: "alex.own@personal-mail.example", mobile: null, mayStillSend: 0, steps });
    const partial = run([row({}), row({ stepId: "m1", channel: "sms", state: "skipped", reason: "missing_channel", at: null }), row({ stepId: "c1", channel: "call", state: "skipped", reason: "missing_channel", at: null }), row({ stepId: "w1", branch: "win_back", state: "not_reached", at: null })]);
    expect(endingTitle("finished", partial)).toBe("Finished");
    expect(endingDetail("finished", partial)).toBe("1 of 3 steps went to your test contacts. The texts and the call were skipped: no test mobile was saved.");
    expect(stepDetail(partial.steps[1]!, partial)).toBe("Skipped: no test mobile saved");
    const whole = run([row({}), row({ stepId: "e2" })]);
    expect(endingTitle("finished", whole)).toBe("Finished: every step ran");
    expect(endingDetail("finished", whole)).toBe("Every step of the sequence went to your test contacts.");
  });
});

describe("a Test run row inside a repeated hour says which one (verifier on cc9bf55, item 11)", () => {
  const read = "2026-10-24T22:00:00Z";
  test("both 01:30s of 25 October 2026 in London", () => {
    expect(stepStateText(row({ state: "due", at: "2026-10-25T00:30:00Z" }), "Europe/London", read)).toBe("Earliest Sun 01:30 BST");
    expect(stepStateText(row({ state: "due", at: "2026-10-25T01:30:00Z" }), "Europe/London", read)).toBe("Earliest Sun 01:30 GMT");
  });
});

describe("a test run's LinkedIn steps (ticket 24b; ADR 0004 section 8)", () => {
  const li = (fields: Partial<TestStepRow>): TestStepRow => row({ trackId: "li", channel: "linkedin", track: "LinkedIn track", ...fields });
  const run = { email: null, mobile: null, linkedin: "https://www.linkedin.com/in/fictional-user-test-profile", running: true };
  test("the first message waits for you to accept the test invite, with the day the wait ends as a fact; the wait is not cut short (Q40)", () => {
    const waiting = li({ stepId: "m1", name: "First message", state: "due", at: null, waits: "awaiting_acceptance", until: "2026-11-16T00:00:00.000Z" });
    expect(stepStateText(waiting, "Europe/London", READ)).toBe("Waiting for you to accept the invite on your test profile; the wait ends Mon 16 Nov");
    expect(stepDetail(waiting, run)).toBe("Accept it by hand on your test profile. A test doesn’t shorten the wait for acceptance; the messages after it wait about a minute each.");
  });
  test("where it goes, with the provider's words; skips and failures in LinkedIn's terms", () => {
    expect(stepDetail(li({ name: "Connection invite" }), run)).toBe(`To ${run.linkedin}`);
    expect(stepStateText(li({ state: "with_provider" }), "Europe/London", READ)).toBe("With the LinkedIn session");
    expect(stepStateText(li({ state: "failed", reason: "profile unreachable" }), "Europe/London", READ)).toBe("Failed 10:41: profile not reachable");
    // A removed connection is not a bad profile (Q37; council on dee365d, item 13).
    expect(stepStateText(li({ stepId: "m1", state: "failed", reason: "not connected" }), "Europe/London", READ)).toBe("Failed 10:41: no longer connected on LinkedIn, so the message couldn’t go");
    expect(stepDetail(li({ state: "skipped", reason: "missing_channel" }), run)).toBe("Skipped: no test LinkedIn profile saved");
    expect(stepDetail(li({ state: "skipped", reason: "already_connected" }), run)).toBe("Skipped: your session is already connected to your test profile");
    // The expiry is said from the run's own withdrawal state, through the record's function (council on dee365d, item 2):
    // never "withdrawn" while LinkedIn only ever answered unknown, on every message row.
    const view = (withdrawal: "wanted" | "withdrawn" | "accepted_first" | "kept_by_user") => ({ ...run, linkedinTracks: [{ trackId: "li", view: { invite: "sent" as const, note: null, connection: null, connectedAt: null, acceptedAt: null, acceptedAfterFinish: false, withdrawal, withdrawalAsked: false, skipCause: null, withdrawalStuck: false, inviteOpen: withdrawal !== "withdrawn", pendingElsewhereSince: null } }] });
    for (const stepId of ["m1", "m2"]) expect(stepDetail(li({ stepId, state: "skipped", reason: "invite_not_accepted" }), view("wanted"))).toBe("Skipped: no acceptance was recorded within the track’s wait, so the LinkedIn track ended for this test. The invite is to be withdrawn; the app hasn’t asked LinkedIn yet.");
    expect(stepDetail(li({ stepId: "m1", state: "skipped", reason: "invite_not_accepted" }), view("withdrawn"))).toBe("Skipped: no acceptance was recorded within the track’s wait, so the LinkedIn track ended for this test, and the invite was withdrawn.");
    expect(stepDetail(li({ stepId: "m1", state: "skipped", reason: "invite_not_accepted" }), view("kept_by_user"))).not.toContain("and the invite was withdrawn");
  });
  test("a finished run names a missing test profile apart from a missing mobile", () => {
    const steps = [li({ state: "skipped", reason: "missing_channel" }), li({ stepId: "m1", state: "skipped", reason: "missing_channel" }), row({})];
    expect(endingDetail("finished", { steps })).toBe("1 of 3 steps went to your test contacts. The LinkedIn steps were skipped: no test LinkedIn profile was saved.");
  });
});
