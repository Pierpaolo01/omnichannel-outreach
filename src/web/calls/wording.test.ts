import { describe, expect, test } from "vitest";
import type { CallQueueItem } from "../../shared/api.ts";
import { clockLine, refusedRecordLine } from "./wording.ts";

describe("a kept refusal's reason (merge of ticket 15a)", () => {
  const record = (offList: Parameters<typeof refusedRecordLine>[0]["refused"]["offList"], message: string) => ({ who: "Amira Hassan", body: { outcome: "no_answer" as const }, refused: { message, offList } });

  test("a call that has just expired: the server's plain message is the reason", () => {
    const line = refusedRecordLine(record({ reason: "not_listed_today", status: "waiting_on_call" }, "This call was skipped at the end of Monday: its skip limit had passed."), "Europe/London");
    expect(line).toBe("Not logged: no answer for Amira Hassan. This call was skipped at the end of Monday: its skip limit had passed.");
  });

  test("a call already logged elsewhere: what was logged and when", () => {
    const line = refusedRecordLine(record({ reason: "logged", outcome: "interested", at: "2026-11-09T10:00:00.000Z", status: "interested_on_call" }, "This call is already logged."), "Europe/London");
    expect(line).toBe("Not logged: no answer for Amira Hassan. Amira Hassan’s call was already logged from another window or device: interested at 10:00.");
  });
});

describe("the sheet's calling-hours label, from the server's fact about the hours now (re-check 7, R10)", () => {
  const REASONS = ["due", "rolled_over", "redial", "callback", "overdue"] as const;
  const view = (reason: (typeof REASONS)[number], callingHoursNow: { open: boolean; opensLaterToday: string | null }) => ({
    listed: true,
    callingHoursNow,
    // The queue item's bucket and opensAt deliberately disagree with the hours: the label must not read them.
    task: { reason, bucket: "later_today" as const, opensAt: "2026-11-09T12:00:00.000Z", callbackAt: "2026-11-09T12:00:00.000Z" } as unknown as CallQueueItem,
  });
  for (const reason of REASONS) {
    const callback = reason === "callback" || reason === "overdue";
    test(`${reason}: inside the hours`, () => {
      expect(clockLine(view(reason, { open: true, opensLaterToday: null }), "Europe/London")).toEqual({ text: "Their time, inside calling hours", tone: "ok" });
    });
    test(`${reason}: outside the hours, opening later today`, () => {
      expect(clockLine(view(reason, { open: false, opensLaterToday: "2026-11-09T09:00:00.000Z" }), "Europe/London")).toEqual({ text: "Their time. Calling hours start at 09:00 your time", tone: callback ? "plain" : "warn" });
    });
    test(`${reason}: outside the hours for the rest of the day`, () => {
      expect(clockLine(view(reason, { open: false, opensLaterToday: null }), "Europe/London")).toEqual({ text: "Their time, outside calling hours", tone: callback ? "plain" : "warn" });
    });
  }
  test("a call off the list says nothing about its hours", () => {
    expect(clockLine({ ...view("due", { open: true, opensLaterToday: null }), listed: false }, "Europe/London")).toEqual({ text: "Their time", tone: "plain" });
  });
});
