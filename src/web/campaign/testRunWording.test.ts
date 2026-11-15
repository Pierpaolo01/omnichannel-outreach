import { describe, expect, test } from "vitest";
import type { TestStepRow } from "../../shared/api.ts";
import { endingDetail, endingTitle, progressText, stepDetail, stepStateText, timeIn } from "./testRunWording.ts";

const row = (fields: Partial<TestStepRow>): TestStepRow => ({ trackId: "e", stepId: "e1", channel: "email", branch: "main", name: "Email 1", track: "Email track", state: "sent", at: "2026-11-02T10:41:00Z", taskId: null, outcome: null, reason: null, ...fields });
const READ = "2026-11-02T10:42:20Z";

describe("the Test run tab says only what the run's facts say (ticket 21)", () => {
  test("times are in the campaign's zone, with the weekday when not today", () => {
    expect(timeIn("Europe/London", "2026-11-02T10:41:00Z", READ)).toBe("10:41");
    expect(timeIn("Europe/London", "2026-11-03T09:00:00Z", READ)).toBe("Tue 09:00");
  });

  test("a sent email says Sent, never delivered; a due step a minute off says so; a call on the list says where it is", () => {
    expect(stepStateText(row({}), "Europe/London", READ)).toBe("Sent 10:41");
    expect(stepStateText(row({ state: "due", at: "2026-11-02T10:43:10Z" }), "Europe/London", READ)).toBe("In about 1 min");
    expect(stepStateText(row({ state: "due", at: "2026-11-02T11:30:00Z" }), "Europe/London", READ)).toBe("Due 11:30");
    expect(stepStateText(row({ channel: "call", state: "on_your_list" }), "Europe/London", READ)).toBe("On your Calls list");
    expect(stepStateText(row({ channel: "call", state: "listed_later", at: "2026-11-03T00:00:00Z" }), "Europe/London", READ)).toBe("On your list from Tue 3 Nov");
    expect(stepStateText(row({ channel: "call", state: "logged", outcome: "not_interested" }), "Europe/London", READ)).toBe("Logged 10:41: Not interested");
  });

  test("a step names where it went, and a win-back step not reached says when it would run", () => {
    const run = { email: "alex.own@personal-mail.example", mobile: "+44 7700 900456", running: true };
    expect(stepDetail(row({}), run)).toBe("To alex.own@personal-mail.example");
    expect(stepDetail(row({ channel: "sms" }), run)).toBe("To +44 7700 900456");
    expect(stepDetail(row({ branch: "win_back", state: "not_reached", at: null }), run)).toBe("Runs if you log Not interested and the path is Win back");
    // Question Q7 answered (provisional for test runs): a test mobile in another campaign's conversation is skipped, and says whose.
    expect(stepDetail(row({ channel: "sms", state: "skipped", reason: "sms_conversation_taken", owners: [{ name: "Spring clinics", test: false }] }), run)).toBe(
      "Skipped: your test mobile was already in a text conversation with campaign Spring clinics on every number this campaign can use",
    );
  });

  test("endings in their own words, and progress counts the branch only once entered", () => {
    expect(endingTitle("your_reply", null)).toBe("Stopped by your reply");
    expect(endingTitle("edited", null)).toBe("Stopped by an edit");
    const steps = [row({}), row({ stepId: "e2", state: "due" }), row({ stepId: "w1", branch: "win_back", state: "not_reached", at: null })];
    expect(progressText({ id: "t", running: true, ending: null, startedAt: READ, endedAt: null, renderAs: { id: "l", name: "Pat" }, email: null, mobile: null, mayStillSend: 0, steps })).toBe("1 of 2 steps done");
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
