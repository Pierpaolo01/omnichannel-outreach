import { describe, expect, test } from "vitest";
import type { TestStepRow } from "../../shared/api.ts";
import { endingTitle, progressText, stepDetail, stepStateText, timeIn } from "./testRunWording.ts";

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
    expect(stepStateText(row({ channel: "call", state: "logged", outcome: "not_interested" }), "Europe/London", READ)).toBe("Logged 10:41: Not interested");
  });

  test("a step names where it went, and a win-back step not reached says when it would run", () => {
    const run = { email: "alex.own@personal-mail.example", mobile: "+44 7700 900456", running: true };
    expect(stepDetail(row({}), run)).toBe("To alex.own@personal-mail.example");
    expect(stepDetail(row({ channel: "sms" }), run)).toBe("To +44 7700 900456");
    expect(stepDetail(row({ branch: "win_back", state: "not_reached", at: null }), run)).toBe("Runs if you log Not interested and the path is Win back");
  });

  test("endings in their own words, and progress counts the branch only once entered", () => {
    expect(endingTitle("your_reply")).toBe("Stopped by your reply");
    expect(endingTitle("edited")).toBe("Stopped by an edit");
    const steps = [row({}), row({ stepId: "e2", state: "due" }), row({ stepId: "w1", branch: "win_back", state: "not_reached", at: null })];
    expect(progressText({ id: "t", running: true, ending: null, startedAt: READ, endedAt: null, renderAs: { id: "l", name: "Pat" }, email: null, mobile: null, mayStillSend: 0, steps })).toBe("1 of 2 steps done");
  });
});
