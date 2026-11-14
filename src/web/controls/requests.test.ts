import { describe, expect, test } from "vitest";
import type { KeyValue } from "../calls/callDesk.ts";
import { ControlRequests, NoControlAnswer, type ControlResult, type ControlTarget, type PressEntry, type SendAnswer } from "./requests.ts";

/**
 * The controls' requests (ticket 17b), on the call desk's rule (ADR 0003 4.4.1), with no lock: a press is stored, under
 * its request id and with what its confirmation showed, before its first send; any page sends any stored press for the
 * targets it shows, with that id and body, once on first sight and then on its own backoff; a definite answer removes it.
 * Two presses confirmed on one read are two requests, and the server's precondition decides between them (coordinator's
 * ruling at 8a1732a). Driven here with fake storage two "tabs" share, a fake server and a fake clock.
 */

function sharedStorage(): KeyValue & { refuse: boolean } {
  const data = new Map<string, string>();
  const kv = {
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

/**
 * Two tabs' views of localStorage as a browser may give them: each tab sees its own writes at once and the other's only
 * after `propagate()`, as Chromium carries one renderer's writes to another.
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

/** A fake server: answers from a queue per call ("hang" never answers until settled), and records every press sent. */
function server() {
  const sent: PressEntry[] = [];
  const answers: (SendAnswer | "none" | "hang")[] = [];
  const hung: ((answer: SendAnswer) => void)[] = [];
  return {
    sent,
    answers,
    send: async (entry: PressEntry): Promise<SendAnswer> => {
      sent.push(entry);
      const next = answers.shift() ?? "none";
      if (next === "none") throw new NoControlAnswer();
      if (next === "hang") return new Promise<SendAnswer>((resolve) => hung.push(resolve));
      return next;
    },
    /** Settles the oldest send left hanging. */
    settleHung: (answer: SendAnswer) => {
      hung.shift()?.(answer);
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
    onChange: () => {
      changes++;
    },
  });
  return { requests, results, changes: () => changes };
}

const PAT: ControlTarget = { kind: "lead", id: "en-pat" };
const NIA: ControlTarget = { kind: "lead", id: "en-nia" };
const CLINICS: ControlTarget = { kind: "campaign", id: "c-clinics" };
/** What a Skip confirmation on Pat's read showed: waiting on a call, the call named. */
const ON_THE_CALL = { status: "waiting_on_call", step: "c1" } as const;

describe("a press", () => {
  test("is stored before its first send, with its id and what its confirmation showed, and leaves on the accepted answer", async () => {
    const storage = sharedStorage();
    const srv = server();
    const time = clock();
    const a = tab(storage, srv, time, ["id-1"]);
    srv.answers.push("hang");
    expect(await a.requests.press(PAT, "skip", ON_THE_CALL)).toMatchObject({ ok: true, entry: { requestId: "id-1", action: "skip", target: PAT, expect: ON_THE_CALL } });
    expect(a.requests.pendingFor(PAT)).toMatchObject({ requestId: "id-1", expect: ON_THE_CALL });
    expect(srv.sent).toEqual([expect.objectContaining({ requestId: "id-1", expect: ON_THE_CALL })]);
    srv.settleHung({ kind: "accepted", body: { ok: 1 } });
    await flush();
    expect(a.requests.pendingFor(PAT)).toBeNull();
    expect(a.results).toEqual([{ kind: "accepted", entry: expect.objectContaining({ requestId: "id-1" }), body: { ok: 1 } }]);
  });

  test("with no answer is sent again with the same id and body on a backoff, never at once twice", async () => {
    const storage = sharedStorage();
    const srv = server();
    const time = clock();
    const a = tab(storage, srv, time, ["id-1"]);
    await a.requests.press(PAT, "stop", { status: "active", step: null });
    await flush();
    expect(a.requests.unconfirmed(PAT)).toBe(true);
    a.requests.watch([PAT]);
    await flush();
    expect(srv.sent).toHaveLength(1);
    await time.advance(1_000);
    expect(srv.sent).toHaveLength(2);
    srv.answers.push({ kind: "accepted", body: null });
    await time.advance(2_000);
    expect(srv.sent.map((e) => [e.requestId, e.expect])).toEqual([0, 1, 2].map(() => ["id-1", { status: "active", step: null }]));
    expect(a.requests.pendingFor(PAT)).toBeNull();
    expect(a.results.map((r) => r.kind)).toEqual(["accepted"]);
  });

  test("try again now sends at once, with the same id", async () => {
    const storage = sharedStorage();
    const srv = server();
    const time = clock();
    const a = tab(storage, srv, time, ["id-1"]);
    await a.requests.press(PAT, "pause", { status: "active", step: null });
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
    await a.requests.press(PAT, "pause", { status: "active", step: null });
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
    expect(await a.requests.press(PAT, "stop", { status: "active", step: null })).toEqual({ ok: false, why: "unstored" });
    await flush();
    expect(srv.sent).toEqual([]);
  });

  test("a page offers no second press on a target while it sees one on its way", async () => {
    const storage = sharedStorage();
    const srv = server();
    const time = clock();
    const a = tab(storage, srv, time, ["id-1", "id-2"]);
    srv.answers.push("hang");
    await a.requests.press(PAT, "skip", ON_THE_CALL);
    expect(await a.requests.press(PAT, "skip", ON_THE_CALL)).toEqual({ ok: false, why: "busy" });
    srv.answers.push({ kind: "accepted", body: null });
    expect(await a.requests.press(NIA, "pause", { status: "active", step: null })).toMatchObject({ ok: true, entry: { requestId: "id-2" } });
  });

  test("stopped and started again, as React's effect replay does in development, it still sends (review bot on 07fab27, P2)", async () => {
    const storage = sharedStorage();
    const srv = server();
    const time = clock();
    const a = tab(storage, srv, time, ["id-1"]);
    a.requests.stop();
    a.requests.start();
    srv.answers.push({ kind: "accepted", body: null });
    expect(await a.requests.press(PAT, "pause", { status: "active", step: null })).toMatchObject({ ok: true });
    await flush();
    expect(srv.sent.map((e) => e.requestId)).toEqual(["id-1"]);
    expect(a.requests.pendingFor(PAT)).toBeNull();
  });
});

describe("any page sends any stored press, with its id; nothing waits behind one", () => {
  test("a press that never answers in one tab is sent by a healthy second tab with the original id, which gets its answer (verifier B2 on 8a1732a)", async () => {
    const storage = sharedStorage();
    const srv = server();
    const time = clock();
    const a = tab(storage, srv, time, ["id-a"]);
    const b = tab(storage, srv, time, ["id-b"]);
    srv.answers.push("hang");
    await a.requests.press(PAT, "skip", ON_THE_CALL);
    await flush();
    // Tab A stays open, its send unanswered. Tab B sees the stored press and sends it at once, with A's id and body.
    srv.answers.push({ kind: "accepted", body: { skipped: "c1" } });
    b.requests.storageChanged([PAT]);
    await flush();
    expect(srv.sent.map((e) => [e.requestId, e.expect])).toEqual([
      ["id-a", ON_THE_CALL],
      ["id-a", ON_THE_CALL],
    ]);
    expect(b.results).toEqual([{ kind: "accepted", entry: expect.objectContaining({ requestId: "id-a" }), body: { skipped: "c1" } }]);
    expect(b.requests.pendingFor(PAT)).toBeNull();
    // A newer press, then A's old send settles: the newer press stays.
    srv.answers.push("hang");
    await b.requests.press(PAT, "pause", { status: "active", step: null });
    srv.settleHung({ kind: "accepted", body: null });
    await flush();
    expect(b.requests.pendingFor(PAT)?.requestId).toBe("id-b");
  });

  test("a reload mid-request sends the stored press again with its id, and shows its answer", async () => {
    const storage = sharedStorage();
    const srv = server();
    const time = clock();
    const before = tab(storage, srv, time, ["id-1"]);
    srv.answers.push("hang");
    await before.requests.press(PAT, "skip", ON_THE_CALL);
    await flush();
    before.requests.stop();
    const after = tab(storage, srv, time, ["id-2"]);
    srv.answers.push({ kind: "accepted", body: { replayed: true } });
    after.requests.watch([PAT]);
    await flush();
    expect(srv.sent.map((e) => e.requestId)).toEqual(["id-1", "id-1"]);
    expect(after.results).toEqual([{ kind: "accepted", entry: expect.objectContaining({ requestId: "id-1", action: "skip" }), body: { replayed: true } }]);
    // The stopped page's own late answer is dropped.
    srv.settleHung({ kind: "accepted", body: null });
    await flush();
    expect(before.results).toEqual([]);
  });

  test("two tabs pressing at once, before either sees the other's write, store and send two presses, each with its own id and precondition, and neither overwrites the other", async () => {
    const { a: sa, b: sb, propagate } = laggingStorage();
    const srv = server();
    const time = clock();
    const a = tab(sa, srv, time, ["id-a"]);
    const b = tab(sb, srv, time, ["id-b"]);
    srv.answers.push("hang", "hang");
    expect(await a.requests.press(PAT, "skip", ON_THE_CALL)).toMatchObject({ ok: true });
    expect(await b.requests.press(PAT, "skip", ON_THE_CALL)).toMatchObject({ ok: true });
    propagate();
    expect(srv.sent.map((e) => [e.requestId, e.expect])).toEqual([
      ["id-a", ON_THE_CALL],
      ["id-b", ON_THE_CALL],
    ]);
    // The server judges both by their precondition: one applies, the other is refused, and each is shown where it was answered.
    srv.settleHung({ kind: "accepted", body: null });
    srv.settleHung({ kind: "refused", message: "This lead changed since you confirmed this, so nothing was changed." });
    await flush();
    propagate();
    expect(a.results.map((r) => r.kind)).toEqual(["accepted"]);
    expect(b.results.map((r) => r.kind)).toEqual(["refused"]);
    expect(a.requests.pendingFor(PAT)).toBeNull();
    expect(b.requests.pendingFor(PAT)).toBeNull();
  });

  test("a campaign's press carries the pause read it was confirmed on", async () => {
    const storage = sharedStorage();
    const srv = server();
    const time = clock();
    const a = tab(storage, srv, time, ["id-1"]);
    srv.answers.push({ kind: "accepted", body: null });
    await a.requests.press(CLINICS, "resume", { pausedSince: "2026-11-09T10:00:00.000Z" });
    await flush();
    expect(srv.sent).toEqual([expect.objectContaining({ requestId: "id-1", target: CLINICS, expect: { pausedSince: "2026-11-09T10:00:00.000Z" } })]);
  });
});
