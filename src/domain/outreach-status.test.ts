import { expect, test } from "vitest";
import { OUTREACH_STATUSES, isOutreachStatus, statusGroup } from "./outreach-status.ts";

test("every outreach status belongs to the group the spec gives it", () => {
  // Spec issue #10, "Outreach status".
  const expected = {
    running: ["queued", "active", "in_win_back"],
    waiting_on_you: ["waiting_on_call", "callback_scheduled"],
    handed_to_you: ["replied", "interested_on_call"],
    paused: ["paused"],
    ended: ["declined_on_call", "stopped_manually", "sequence_finished_no_response", "finished_no_usable_channel"],
  };
  const actual: Record<string, string[]> = {};
  for (const status of OUTREACH_STATUSES) (actual[statusGroup(status)] ??= []).push(status);
  expect(actual).toEqual(expected);
});

test("only the twelve statuses are outreach statuses", () => {
  expect(OUTREACH_STATUSES).toHaveLength(12);
  expect(isOutreachStatus("queued")).toBe(true);
  expect(isOutreachStatus("interested")).toBe(false);
  expect(isOutreachStatus(undefined)).toBe(false);
});
