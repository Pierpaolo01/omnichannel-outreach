import { describe, expect, test } from "vitest";
import type { KeyValue } from "../calls/callDesk.ts";
import { answered, keepPress, pendingPress, type TestRunPress } from "./testRunPress.ts";

const memory = (): KeyValue => {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => (m.set(k, v), true), remove: (k) => void m.delete(k), keys: () => [...m.keys()] };
};
const press = (requestId: string, kind: TestRunPress["kind"] = "run"): TestRunPress => ({ v: 1, kind, requestId, path: "/api/campaigns/c1/test-runs", body: { requestId }, pressedAt: 1 });

describe("a Run test press is kept until the server answers its id (verifier F3 on 55d6ac6)", () => {
  test("kept at the press, read back after a reload, and cleared only by its own answer", () => {
    const store = memory();
    expect(keepPress(store, "c1", press("r-1"))).toBe(true);
    expect(pendingPress(store, "c1")).toEqual(press("r-1"));
    answered(store, "c1", "r-0");
    expect(pendingPress(store, "c1")?.requestId).toBe("r-1");
    answered(store, "c1", "r-1");
    expect(pendingPress(store, "c1")).toBeNull();
  });

  test("one campaign's press is not another's, and a stored value that is not a press is none", () => {
    const store = memory();
    keepPress(store, "c1", press("r-1", "stop"));
    expect(pendingPress(store, "c2")).toBeNull();
    store.set("outreach.test-run-press.c3", "{not json");
    expect(pendingPress(store, "c3")).toBeNull();
  });
});
