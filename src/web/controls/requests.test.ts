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
    remove: (k: string) => void data.delete(k),
    keys: () => [...data.keys()],
  };
  return kv;
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

function tab(storage: KeyValue, srv: ReturnType<typeof server>, time: ReturnType<typeof clock>, ids: string[]) {
  const results: ControlResult[] = [];
  let changes = 0;
  const requests = new ControlRequests({
    local: storage,
    newId: () => ids.shift() ?? "id-x",
    now: time.now,
    setTimer: time.setTimer,
    send: srv.send,
    onResult: (r) => results.push(r),
    onChange: () => void changes++,
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
    expect(pressed).toMatchObject({ ok: true, entry: { requestId: "id-1", action: "skip", target: PAT } });
    // Stored before the send's answer.
    expect(a.requests.pendingFor(PAT)?.requestId).toBe("id-1");
    await flush();
    expect(srv.sent.map((e) => e.requestId)).toEqual(["id-1"]);
    expect(a.requests.pendingFor(PAT)).toBeNull();
    expect(a.results).toEqual([{ kind: "accepted", entry: expect.objectContaining({ requestId: "id-1" }), body: { ok: 1 } }]);
  });

  test("with no answer is sent again with the same id on a backoff, never at once twice", async () => {
    const storage = sharedStorage();
    const srv = server();
    const time = clock();
    const a = tab(storage, srv, time, ["id-1"]);
    a.requests.press(PAT, "stop");
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
    a.requests.press(PAT, "pause");
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
    a.requests.press(PAT, "pause");
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
    expect(a.requests.press(PAT, "stop")).toEqual({ ok: false, why: "unstored" });
    await flush();
    expect(srv.sent).toEqual([]);
  });
});

describe("one press per lead or campaign at a time, across tabs and reloads", () => {
  test("a reload mid-request sends the stored press again with its id, and shows its answer", async () => {
    const storage = sharedStorage();
    const srv = server();
    const time = clock();
    const before = tab(storage, srv, time, ["id-1"]);
    before.requests.press(PAT, "skip");
    await flush();
    before.requests.stop();
    // The page reloads: a new instance on the same storage, watching the same lead.
    const after = tab(storage, srv, time, ["id-2"]);
    srv.answers.push({ kind: "accepted", body: { replayed: true } });
    after.requests.watch([PAT]);
    await flush();
    expect(srv.sent.map((e) => e.requestId)).toEqual(["id-1", "id-1"]);
    expect(after.results).toEqual([{ kind: "accepted", entry: expect.objectContaining({ requestId: "id-1", action: "skip" }), body: { replayed: true } }]);
    expect(after.requests.pendingFor(PAT)).toBeNull();
  });

  test("another tab cannot press on the same lead while one press is on its way; it sends that press with its id, and may press on another", async () => {
    const storage = sharedStorage();
    const srv = server();
    const time = clock();
    const a = tab(storage, srv, time, ["id-a"]);
    const b = tab(storage, srv, time, ["id-b", "id-b2"]);
    a.requests.press(PAT, "skip");
    await flush();
    expect(b.requests.press(PAT, "skip")).toEqual({ ok: false, why: "busy" });
    expect(b.requests.pendingFor(PAT)?.requestId).toBe("id-a");
    // B, watching Pat (a storage event), sends A's press: the same id.
    b.requests.storageChanged([PAT]);
    await flush();
    expect(srv.sent.map((e) => e.requestId)).toEqual(["id-a", "id-a"]);
    expect(b.changes()).toBeGreaterThan(0);
    srv.answers.push({ kind: "accepted", body: null });
    expect(b.requests.press(NIA, "pause")).toMatchObject({ ok: true, entry: { requestId: "id-b" } });
    await flush();
    expect(srv.sent.map((e) => e.requestId)).toEqual(["id-a", "id-a", "id-b"]);
  });

  test("an answer another tab got removes the press here too: it is not sent again", async () => {
    const storage = sharedStorage();
    const srv = server();
    const time = clock();
    const a = tab(storage, srv, time, ["id-a"]);
    const b = tab(storage, srv, time, []);
    a.requests.press(CLINICS, "pause");
    await flush();
    b.requests.watch([CLINICS]);
    await flush();
    expect(srv.sent).toHaveLength(2);
    srv.answers.push({ kind: "accepted", body: null });
    await time.advance(1_000);
    // One of them got the answer and removed the press; the other's timer finds nothing to send.
    await time.advance(30_000);
    expect(srv.sent.map((e) => e.requestId).every((id) => id === "id-a")).toBe(true);
    expect(srv.sent.length).toBeLessThanOrEqual(4);
    expect(a.requests.pendingFor(CLINICS)).toBeNull();
    expect(b.requests.pendingFor(CLINICS)).toBeNull();
  });

  test("a newer press on the target, after the first was answered, is not removed by a late answer to the first", async () => {
    const storage = sharedStorage();
    const srv = server();
    const time = clock();
    const a = tab(storage, srv, time, ["id-1", "id-2"]);
    srv.answers.push({ kind: "accepted", body: null });
    a.requests.press(PAT, "pause");
    await flush();
    a.requests.press(PAT, "resume");
    await flush();
    expect(a.requests.pendingFor(PAT)?.requestId).toBe("id-2");
  });
});
