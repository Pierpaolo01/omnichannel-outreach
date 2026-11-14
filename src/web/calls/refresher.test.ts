import { describe, expect, test } from "vitest";
import { Refresher } from "./refresher.ts";

/** Reads the test answers by hand, in any order. */
function reader(overlapFault = false) {
  const inFlight: { asOf: string; resolve: (v: { asOf: string; nextChangeAt: string | null }) => void; reject: (e: Error) => void }[] = [];
  let maxInFlight = 0;
  const applied: string[] = [];
  const timers: { ms: number }[] = [];
  let clock = 0;
  const r = new Refresher<{ asOf: string; nextChangeAt: string | null }>({
    read: () =>
      new Promise((resolve, reject) => {
        // Each read is answered as of the moment it is sent: a later read, a later instant.
        inFlight.push({ asOf: new Date(Date.UTC(2026, 10, 9, 10, 0, ++clock)).toISOString(), resolve, reject });
        maxInFlight = Math.max(maxInFlight, inFlight.length);
      }),
    onRead: (v) => void applied.push(v.asOf),
    onFailure: () => undefined,
    setTimer: (_fire, ms) => {
      timers.push({ ms });
      return () => undefined;
    },
    overlapFault,
  });
  r.start();
  const answer = async (i: number) => {
    const x = inFlight.splice(i, 1)[0]!;
    x.resolve({ asOf: x.asOf, nextChangeAt: new Date(Date.parse(x.asOf) + 60_000).toISOString() });
    for (let k = 0; k < 5; k++) await Promise.resolve();
  };
  return { r, inFlight, applied, timers, answer, maxInFlight: () => maxInFlight };
}

describe("reads are ordered (council on b8c65f9, item 8; ADR 0003 4.4.1)", () => {
  test("a refresh asked for while one runs waits for it and is one read: an older answer never lands after a newer one", async () => {
    const t = reader();
    const first = t.r.now();
    const second = t.r.now();
    const third = t.r.now();
    expect(t.inFlight).toHaveLength(1);
    await t.answer(0);
    await first;
    // The second and third requests are one read, sent after the first was applied.
    expect(t.inFlight).toHaveLength(1);
    await t.answer(0);
    await Promise.all([second, third]);
    expect(t.maxInFlight()).toBe(1);
    expect(t.applied).toEqual([...t.applied].sort());
    expect(t.r.freshness().lastReadAt).toBe(t.applied.at(-1));
    // The next read is scheduled from the newest answer.
    expect(t.timers.at(-1)?.ms).toBe(60_000);
  });

  test("the fault that lets reads overlap applies the older answer last, and the test sees it", async () => {
    const t = reader(true);
    void t.r.now();
    void t.r.now();
    expect(t.inFlight).toHaveLength(2);
    await t.answer(1);
    await t.answer(0);
    expect(t.applied).not.toEqual([...t.applied].sort());
  });
});
