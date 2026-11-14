import { describe, expect, test } from "vitest";
import type { CallQueueItem, CallTaskView } from "../../shared/api.ts";
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

describe("calls carried over from earlier days, in Needs attention (review bot on eac9f6c, item 4)", () => {
  test("none shows no row; one and several are said in the singular and plural, with how many are on their last day", async () => {
    const { carriedItem } = await import("./wording.ts");
    expect(carriedItem({ carriedOver: 0, carriedOverLastDay: 0 })).toBeNull();
    expect(carriedItem({ carriedOver: 1, carriedOverLastDay: 0 })).toMatchObject({ title: "One call carried over from an earlier day", body: "Rolled over or redialed, it is on your list with its original due date.", action: { label: "Open Calls", href: "/calls" } });
    expect(carriedItem({ carriedOver: 1, carriedOverLastDay: 1 })?.body).toBe("Rolled over or redialed, it is on your list with its original due date. It is on its last day before it is skipped.");
    expect(carriedItem({ carriedOver: 3, carriedOverLastDay: 1 })).toMatchObject({ title: "3 calls carried over from earlier days", body: "Rolled over or redialed, each is on your list with its own original due date. 1 of them is on its last day before it is skipped." });
    expect(carriedItem({ carriedOver: 3, carriedOverLastDay: 2 })?.body).toBe("Rolled over or redialed, each is on your list with its own original due date. 2 of them are on their last day before they are skipped.");
    expect(carriedItem({ carriedOver: 4, carriedOverLastDay: 4 })?.body).toBe("Rolled over or redialed, each is on your list with its own original due date. All 4 are on their last day before they are skipped.");
  });
});

describe("a callback's time in the user's zone and the prospect's, across the March clock change (review bot and verifier on eac9f6c)", () => {
  test("a New York user and a London prospect, Sunday 28 March 2027 at 18:30 their time: 13:30 yours, on the preview and the logged line", async () => {
    const { callbackWhen, loggedLine } = await import("./wording.ts");
    const { zonedInstants } = await import("./callbackTime.ts");
    expect(zonedInstants("2027-03-28", "18:30", "Europe/London").map((t) => new Date(t).toISOString())).toEqual(["2027-03-28T17:30:00.000Z"]);
    expect(callbackWhen("2027-03-28T17:30:00.000Z", "Europe/London", "America/New_York")).toBe("Sun 28 Mar at 18:30 their time, 13:30 your time");
    const task = {
      zone: "Europe/London",
      open: true,
      kind: "callback",
      callbackAt: "2027-03-28T17:30:00.000Z",
      campaign: { id: "c", name: "Clinics, London" },
      company: { id: "co", name: "Harbour Lane Physio" },
      storedCalls: [{ requestId: "r1", outcome: "callback_requested", redial: false, callbackAt: "2027-03-28T17:30:00.000Z", at: "2027-03-26T14:00:00.000Z", number: null, note: "" }],
      personNotes: [],
      companyNotes: [],
    } as unknown as CallTaskView;
    const logged = { requestId: "r1", who: "Ada Example", body: { requestId: "r1", outcome: "callback_requested" as const, numberId: "n", note: "", noteScope: "person" as const }, task };
    expect(loggedLine(logged, "America/New_York")).toBe("Ada Example: callback requested for Sun 28 Mar at 18:30 their time, 13:30 your time. Their automated outreach in Clinics, London is held until you log how the callback went.");
  });
});

describe("a callback's time on the queue, with the user's date when it differs, and the occurrence in a repeated hour (council on 32454ea, B and C)", () => {
  test("a Sydney user and a Los Angeles prospect: the user's day is already the next", async () => {
    const { reasonLine } = await import("./wording.ts");
    const item = { reason: "callback", bucket: "later_today", opensAt: null, callbackAt: "2026-11-09T23:00:00.000Z", zone: "America/Los_Angeles", dueAt: "2026-11-09T17:00:00.000Z", skippedTonight: false, noGoodNumber: false } as unknown as CallQueueItem;
    expect(reasonLine(item, "Australia/Sydney", "2026-11-10").text).toBe("Callback they asked for Mon 9 Nov at 15:00 their time, Tue 10 Nov at 10:00 your time");
    expect(reasonLine({ ...item, reason: "overdue" }, "Australia/Sydney", "2026-11-10").text).toBe("Callback overdue since Mon 9 Nov at 15:00 their time, Tue 10 Nov at 10:00 your time");
    // Today for both: no date.
    expect(reasonLine({ ...item, zone: "Europe/London", callbackAt: "2026-11-10T15:00:00.000Z" }, "Europe/London", "2026-11-10").text).toBe("Callback they asked for at 15:00 their time");
  });

  test("a time inside the hour the clocks repeat says which occurrence, before Log and once logged", async () => {
    const { callbackLine, callbackWhen } = await import("./wording.ts");
    const task = { zone: "Europe/London", callingHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 })) };
    expect(callbackLine({ at: Date.parse("2027-10-31T01:30:00Z"), problem: null, occurrence: "second" }, "inside", task, "Europe/London").text).toBe("Callback on Sun 31 Oct at 01:30 their time, after the clocks go back, the same as yours. Inside their calling hours.");
    expect(callbackWhen("2027-10-31T00:30:00.000Z", "Europe/London", "Europe/London")).toBe("Sun 31 Oct at 01:30 their time, before the clocks go back, the same as yours");
  });
});
