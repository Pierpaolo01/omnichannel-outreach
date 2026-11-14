import { describe, expect, test } from "vitest";
import { browserStorage } from "./storage.ts";

/** A browser `Storage` shared by tabs, which can refuse writes as a full or blocked one does. */
export class FakeBrowserStorage implements Storage {
  private readonly map = new Map<string, string>();
  refuse = false;
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  setItem(k: string, v: string) {
    if (this.refuse) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    this.map.set(k, v);
  }
}

describe("browser storage is the only truth (re-check on 9c3ad27, B2 and B3)", () => {
  test("a key another tab removed reads as absent and is not listed: nothing is cached to bring it back", () => {
    const shared = new FakeBrowserStorage();
    const a = browserStorage(() => shared);
    const b = browserStorage(() => shared);
    expect(a.set("outreach.calls.outbox.r1", "{}")).toBe(true);
    expect(a.get("outreach.calls.outbox.r1")).toBe("{}");
    b.remove("outreach.calls.outbox.r1");
    expect(a.get("outreach.calls.outbox.r1")).toBeNull();
    expect(a.keys()).toEqual([]);
  });

  test("a write storage refuses is reported, and nothing is kept in its place", () => {
    const shared = new FakeBrowserStorage();
    const a = browserStorage(() => shared);
    shared.refuse = true;
    expect(a.set("outreach.calls.outbox.r1", "{}")).toBe(false);
    expect(a.get("outreach.calls.outbox.r1")).toBeNull();
    expect(a.keys()).toEqual([]);
  });

  test("storage that cannot be opened refuses every write and reads as empty", () => {
    const blocked = browserStorage(() => {
      throw new DOMException("Storage is blocked.", "SecurityError");
    });
    expect(blocked.set("k", "v")).toBe(false);
    expect(blocked.get("k")).toBeNull();
    expect(blocked.keys()).toEqual([]);
  });
});
