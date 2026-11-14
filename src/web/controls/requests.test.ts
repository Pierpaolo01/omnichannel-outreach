import { describe, expect, test } from "vitest";
import type { KeyValue } from "../calls/callDesk.ts";
import { ControlRequests, NoControlAnswer, type ControlResult, type PressEntry, type SendAnswer } from "./requests.ts";

/**
 * The controls' requests (ticket 17b), on the rule the call desk keeps (ADR 0003 4.4.1): a press is stored before its
 * first send, under a request id made at the press; every send of it, a retry, a send after a reload or another tab's,
 * carries that id, so the server, which binds an id to its first answer, applies it once. One press per lead or campaign
 * is on its way at a time, across the user's tabs. A definite answer removes it. Driven here with a fake storage two
 * "tabs" share, a fake server and a fake clock.
 */

function sharedStorage(): KeyValue & { refuse: boolean; data: Map<string, string> } {
  const data = new Map<string, string>();
  const kv = {
    data,
    refuse: false,
    get: (k: string) => data.get(k) ?? null,
    set: (k: string, v: string) => {
      if (kv.refuse) return false;
      data.set(k, v);
      return true;
    },
    remove: (k: string) => {
      data.delete(k);
    },
    keys: () => [...data.keys()],
  };
  return kv;
}

/** Web Locks as the browser grants them across tabs: one holder per name; `ifAvailable` is refused while held. */
function locks() {
  const held = new Map<string, Promise<void>>();
  return async (name: string, mode: "ifAvailable" | "wait", fn: () => Promise<void>): Promise<boolean> => {
    for (let h = held.get(name); h; h = held.get(name)) {
      if (mode === "ifAvailable") return false;
      await h;
    }
    let release = (): void => undefined;
    held.set(name, new Promise<void>((r) => (release = r)));
    try {
      await fn();
    } finally {
      held.delete(name);
      release();
    }
    return true;
  };
}

/**
 * Two tabs' views of localStorage as a browser may give them: each tab sees its own writes at once and the other's only
 * after `propagate()`, as Chromium carries one renderer's writes to another (review bot on 07fab27, P1).
 */
function laggingStorage() {
  const committed = new Map<string, string>();
  const view = () => {
    const overlay = new Map<string, string | null>();
    const kv: KeyValue = {
      get: (k) => (overlay.has(k) ? (overlay.get(k) ?? null) : (committed.get(k) ?? null)),
      set: (k, v) => {
        overlay.set(k, v);
        return true;
      },
      remove: (k) => {
        overlay.set(k, null);
      },
      keys: () => [...new Set([...committed.keys(), ...overlay.keys()])].filter((k) => kv.get(k) !== null),
    };
    return { kv, overlay };
  };
  const a = view();
  const b = view();
  return {
    a: a.kv,
    b: b.kv,
    propagate: () => {
      for (const { overlay } of [a, b]) {
        for (const [k, v] of overlay) {
          if (v === null) committed.delete(k);
          else committed.set(k, v);
        }
        overlay.clear();
      }
    },
  };
}

interface Timer {
  at: number;
  fire: () => void;
  cancelled: boolean;
}

function clock() {
  let now = 0;
  const timers: Timer[] = [];
  return {
    now: () => now,
    setTimer: (fire: () => void, ms: number) => {
      const t = { at: now + ms, fire, cancelled: false };
      timers.push(t);
      return () => void (t.cancelled = true);
    },
    async advance(ms: number) {
      now += ms;
      for (const t of timers.filter((x) => !x.cancelled && x.at <= now)) {
        t.cancelled = true;
        t.fire();
      }
      await flush();
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A fake server: answers from a queue per call, records every request id and body it was sent. */
function server() {
  const sent: PressEntry[] = [];
  const answers: (SendAnswer | "none")[] = [];
  return {
    sent,
    answers,
    send: async (entry: PressEntry): Promise<SendAnswer> => {
      sent.push(entry);
      const next = answers.shift() ?? "none";
      if (next === "none") throw new NoControlAnswer();
      return next;
    },
  };
}

/** Tabs on one storage share one lock manager, as tabs of one origin do. */
const lockDomains = new WeakMap<KeyValue, ReturnType<typeof locks>>();
const domainOf = (storage: KeyValue) => {
  let l = lockDomains.get(storage);
  if (!l) lockDomains.set(storage, (l = locks()));
  return l;
};

function tab(storage: KeyValue, srv: ReturnType<typeof server>, time: ReturnType<typeof clock>, ids: string[], lock = domainOf(storage)) {
  const results: ControlResult[] = [];
  let changes = 0;
  const requests = new ControlRequests({
    local: storage,
    newId: () => ids.shift() ?? "id-x",
    now: time.now,
    setTimer: time.setTimer,
    send: srv.send,
    lock,
    onResult: (r) => results.push(r),
    onChange: () => {
      changes++;
    },
  });
  return { requests, results, changes: () => changes };
}

const PAT = { kind: "lead", id: "en-pat" } as const;
const NIA = { kind: "lead", id: "en-nia" } as const;
const CLINICS = { kind: "campaign", id: "c-clinics" } as const;

describe("a press", () => {
  test("is stored before its first send, under the id made at the press, and leaves on the accepted answer", async () => {
    const storage = sharedStorage();
    const srv = server();
    const time = clock();
    const a = tab(storage, srv, time, ["id-1"]);
    srv.answers.push({ kind: "accepted", body: { ok: 1 } });
    const pressed = a.requests.press(PAT, "skip");
    await flush();
    expect(await pressed).toMatchObject({ ok: true, entry: { requestId: "id-1", action: "skip", target: PAT } });
    expect(srv.sent.map((e) => e.requestId)).toEqual(["id-1"]);
    expect(a.requests.pendingFor(PAT)).toBeNull();
    expect(a.results).toEqual([{ kind: "accepted", entry: expect.objectContaining({ requestId: "id-1" }), body: { ok: 1 } }]);
  });

  test("is stored before its answer arrives", async () => {
    const storage = sharedStorage();
    const srv = server();
    const time = clock();
    const a = tab(storage, srv, time, ["id-1"]);
    void a.requests.press(PAT, "skip");
    await flush();
    expect(a.requests.pendingFor(PAT)?.requestId).toBe("id-1");
    expect(srv.sent.map((e) => e.requestId)).toEqual(["id-1"]);
  });

  test("with no answer is sent again with the same id on a backoff, never at once twice", async () => {
    const storage = sharedStorage();
    const srv = server();
    const time = clock();
    const a = tab(storage, srv, time, ["id-1"]);
    void a.requests.press(PAT, "stop");
    await flush();
    expect(a.requests.unconfirmed(PAT)).toBe(true);
    // Another storage event or watch does not send it again before its timer.
    a.requests.watch([PAT]);
    await flush();
    expect(srv.sent).toHaveLength(1);
    await time.advance(1_000);
    expect(srv.sent).toHaveLength(2);
    srv.answers.push({ kind: "accepted", body: null });
    await time.advance(2_000);
    expect(srv.sent.map((e) => e.requestId)).toEqual(["id-1", "id-1", "id-1"]);
    expect(a.requests.pendingFor(PAT)).toBeNull();
    expect(a.results.map((r) => r.kind)).toEqual(["accepted"]);
  });

  test("try again now sends at once, with the same id", async () => {
    const storage = sharedStorage();
    const srv = server();
    const time = clock();
    const a = tab(storage, srv, time, ["id-1"]);
    void a.requests.press(PAT, "pause");
    await flush();
    srv.answers.push({ kind: "accepted", body: null });
    a.requests.retryNow();
    await flush();
    expect(srv.sent.map((e) => e.requestId)).toEqual(["id-1", "id-1"]);
    expect(a.requests.pendingFor(PAT)).toBeNull();
  });

  test("refused: the reason is reported once and the press leaves; it is never sent again", async () => {
    const storage = sharedStorage();
    const srv = server();
    const time = clock();
    const a = tab(storage, srv, time, ["id-1"]);
    srv.answers.push({ kind: "refused", message: "They are already paused." });
    void a.requests.press(PAT, "pause");
    await flush();
    await time.advance(20_000);
    expect(srv.sent).toHaveLength(1);
    expect(a.results).toEqual([{ kind: "refused", entry: expect.objectContaining({ requestId: "id-1" }), message: "They are already paused." }]);
    expect(a.requests.pendingFor(PAT)).toBeNull();
  });

  test("storage that refuses the write: nothing is sent, and the page is told", async () => {
    const storage = sharedStorage();
    storage.refuse = true;
    const srv = server();
    const time = clock();
    const a = tab(storage, srv, time, ["id-1"]);
    expect(await a.requests.press(PAT, "stop")).toEqual({ ok: false, why: "unstored" });
    await flush();
    expect(srv.sent).toEqual([]);
  });

  test("stopped and started again, as React's effect replay does in development, it still sends (review bot on 07fab27, P2)", async () => {
    const storage = sharedStorage();
    const srv = server();
    const time = clock();
    const a = tab(storage, srv, time, ["id-1"]);
    a.requests.stop();
    a.requests.start();
    srv.answers.push({ kind: "accepted", body: null });
    expect(await a.requests.press(PAT, "pause")).toMatchObject({ ok: true });
    await flush();
    expect(srv.sent.map((e) => e.requestId)).toEqual(["id-1"]);
    expect(a.requests.pendingFor(PAT)).toBeNull();
  });
});

describe("one press per lead or campaign at a time, across tabs and reloads", () => {
  test("two tabs pressing at once, before either sees the other's write, send one request id (review bot on 07fab27, P1)", async () => {
    const { a: sa, b: sb, propagate } = laggingStorage();
    const lock = locks();
    const srv = server();
    const time = clock();
    const a = tab(sa, srv, time, ["id-a"], lock);
    const b = tab(sb, srv, time, ["id-b"], lock);
    const pa = a.requests.press(PAT, "skip");
    const pb = b.requests.press(PAT, "skip");
    await flush();
    expect(await pb).toEqual({ ok: false, why: "busy" });
    expect(await pa).toMatchObject({ ok: true });
    propagate();
    await time.advance(30_000);
    expect(new Set(srv.sent.map((e) => e.requestId))).toEqual(new Set(["id-a"]));
  });

  test("a reload mid-request sends the stored press again with its id, and shows its answer", async () => {
    const storage = sharedStorage();
    const srv = server();
    const time = clock();
    const before = tab(storage, srv, time, ["id-1"]);
    void before.requests.press(PAT, "skip");
    await flush();
    // The page unloads: its lock goes with it.
    before.requests.stop();
    await flush();
    const after = tab(storage, srv, time, ["id-2"]);
    srv.answers.push({ kind: "accepted", body: { replayed: true } });
    after.requests.watch([PAT]);
    await flush();
    expect(srv.sent.map((e) => e.requestId)).toEqual(["id-1", "id-1"]);
    expect(after.results).toEqual([{ kind: "accepted", entry: expect.objectContaining({ requestId: "id-1", action: "skip" }), body: { replayed: true } }]);
    expect(after.requests.pendingFor(PAT)).toBeNull();
  });

  test("another tab cannot press on a lead while a press on it is on its way, and does not send it while its tab is alive; it may press on another lead", async () => {
    const storage = sharedStorage();
    const srv = server();
    const time = clock();
    const a = tab(storage, srv, time, ["id-a"]);
    const b = tab(storage, srv, time, ["id-b", "id-b2"]);
    void a.requests.press(PAT, "skip");
    await flush();
    expect(await b.requests.press(PAT, "skip")).toEqual({ ok: false, why: "busy" });
    expect(b.requests.pendingFor(PAT)?.requestId).toBe("id-a");
    b.requests.storageChanged([PAT]);
    await flush();
    expect(srv.sent.map((e) => e.requestId)).toEqual(["id-a"]);
    expect(b.changes()).toBeGreaterThan(0);
    srv.answers.push({ kind: "accepted", body: null });
    expect(await b.requests.press(NIA, "pause")).toMatchObject({ ok: true, entry: { requestId: "id-b" } });
    await flush();
    expect(srv.sent.map((e) => e.requestId)).toEqual(["id-a", "id-b"]);
  });

  test("when the tab that pressed closes unanswered, the other tab sends its press with the same id", async () => {
    const storage = sharedStorage();
    const srv = server();
    const time = clock();
    const a = tab(storage, srv, time, ["id-a"]);
    const b = tab(storage, srv, time, []);
    void a.requests.press(CLINICS, "pause");
    await flush();
    b.requests.watch([CLINICS]);
    await flush();
    expect(srv.sent).toHaveLength(1);
    srv.answers.push({ kind: "accepted", body: null });
    a.requests.stop();
    await flush();
    expect(srv.sent.map((e) => e.requestId)).toEqual(["id-a", "id-a"]);
    expect(b.requests.pendingFor(CLINICS)).toBeNull();
    expect(b.results.map((r) => r.kind)).toEqual(["accepted"]);
  });

  test("a newer press on the target, after the first was answered, is not removed by a late answer to the first", async () => {
    const storage = sharedStorage();
    const srv = server();
    const time = clock();
    const a = tab(storage, srv, time, ["id-1", "id-2"]);
    srv.answers.push({ kind: "accepted", body: null });
    await a.requests.press(PAT, "pause");
    await flush();
    void a.requests.press(PAT, "resume");
    await flush();
    expect(a.requests.pendingFor(PAT)?.requestId).toBe("id-2");
  });
});
