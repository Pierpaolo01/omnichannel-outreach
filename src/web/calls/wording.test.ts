import { describe, expect, test } from "vitest";
import { refusedRecordLine } from "./wording.ts";

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
