import { describe, expect, test } from "vitest";
import type { KeyValue } from "../calls/callDesk.ts";
import { BulkRequests, NoBulkAnswer, bulkPendingFor, shownBulkResult, type BulkPress, type BulkResult, type BulkSendAnswer } from "./requests.ts";

/**
 * Bulk presses on Leads (ticket 18), on the controls' request rule (17b): stored under the bulk id before the first send;
 * any Leads page sends any stored press with that id and body, once on first sight and then on its own backoff; a definite
 * answer removes it. Driven with fake storage two "tabs" share, a fake server and a fake clock. Data is fictitious.
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

function world() {
  const local = sharedStorage();
  const sent: { tab: string; bulkId: string; body: unknown }[] = [];
  const timers: { fire: () => void; ms: number; live: boolean }[] = [];
  let reply: (press: BulkPress) => Promise<BulkSendAnswer> = () => Promise.resolve({ kind: "answered", body: { ok: true } });
  let ids = 0;
  const tab = (name: string) => {
    const results: BulkResult[] = [];
    const requests = new BulkRequests({
      local,
      newId: () => `bulk-${++ids}`,
      now: () => 1_000 + ids,
      setTimer: (fire, ms) => {
        const t = { fire, ms, live: true };
        timers.push(t);
        return () => (t.live = false);
      },
      send: (press) => {
        sent.push({ tab: name, bulkId: press.bulkId, body: press.body });
        return reply(press);
      },
      onResult: (r) => results.push(r),
      onChange: () => undefined,
    });
    return { requests, results };
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { local, sent, timers, tab, settle, answerWith: (f: typeof reply) => (reply = f) };
}

const BODY = { action: "pause", campaignId: "c1", items: [{ enrollmentId: "e1", expect: { status: "active", preview: "d1" } }] };
const LABELS = { e1: { name: "Pat Oneil", campaign: "Clinics" } };

describe("a bulk press is stored before its first send, and sent with the same id and body until answered", () => {
  test("no answer: it stays stored and is sent again on its backoff with the same bulk id and body; the answer removes it", async () => {
    const w = world();
    const a = w.tab("a");
    w.answerWith(() => Promise.reject(new NoBulkAnswer()));
    const out = a.requests.press("pause", BODY, LABELS, "Clinics");
    expect(out.ok).toBe(true);
    // Stored before the send: a reload finds it.
    expect(a.requests.stored().map((p) => p.bulkId)).toEqual(["bulk-1"]);
    await w.settle();
    expect(a.requests.unconfirmed()).toBe(true);
    expect(w.timers.at(-1)?.ms).toBe(1_000);
    w.answerWith(() => Promise.resolve({ kind: "answered", body: { counts: { applied: 1, refused: 0 } } }));
    w.timers.at(-1)?.fire();
    await w.settle();
    expect(w.sent.map((s) => [s.bulkId, JSON.stringify(s.body)])).toEqual([
      ["bulk-1", JSON.stringify(BODY)],
      ["bulk-1", JSON.stringify(BODY)],
    ]);
    expect(a.requests.stored()).toEqual([]);
    expect(a.results.map((r) => r.kind)).toEqual(["answered"]);
  });

  test("a reload or another tab sends the stored press, with its id and body, and the tab that gets the answer removes it", async () => {
    const w = world();
    const a = w.tab("a");
    w.answerWith(() => new Promise(() => undefined));
    a.requests.press("pause", BODY, LABELS, "Clinics");
    a.requests.stop();
    w.answerWith(() => Promise.resolve({ kind: "answered", body: {} }));
    const b = w.tab("b");
    b.requests.watch();
    await w.settle();
    expect(w.sent.map((s) => [s.tab, s.bulkId])).toEqual([
      ["a", "bulk-1"],
      ["b", "bulk-1"],
    ]);
    expect(w.local.keys()).toEqual([]);
    expect(b.results).toHaveLength(1);
  });

  test("one bulk at a time on this device: another press waits while one is stored", async () => {
    const w = world();
    const a = w.tab("a");
    const b = w.tab("b");
    w.answerWith(() => new Promise(() => undefined));
    expect(a.requests.press("pause", BODY, LABELS, "Clinics").ok).toBe(true);
    expect(b.requests.press("stop", BODY, LABELS, "Clinics")).toEqual({ ok: false, why: "busy" });
  });

  test("storage that will not take the press: nothing is sent", () => {
    const w = world();
    w.local.refuse = true;
    const a = w.tab("a");
    expect(a.requests.press("pause", BODY, LABELS, "Clinics")).toEqual({ ok: false, why: "unstored" });
    expect(w.sent).toEqual([]);
  });

  test("a refusal of the whole bulk is definite: removed and shown", async () => {
    const w = world();
    const a = w.tab("a");
    w.answerWith(() => Promise.resolve({ kind: "refused", message: "This request id was already used for another action: send a new one." }));
    a.requests.press("pause", BODY, LABELS, "Clinics");
    await w.settle();
    expect(a.requests.stored()).toEqual([]);
    expect(a.results).toMatchObject([{ kind: "refused", message: "This request id was already used for another action: send a new one." }]);
  });

  test("a page that stops lets its send go; after it starts again, the stored press is sent and answered", async () => {
    const w = world();
    const a = w.tab("a");
    w.answerWith(() => new Promise(() => undefined));
    a.requests.press("pause", BODY, LABELS, "Clinics");
    a.requests.stop();
    a.requests.start();
    w.answerWith(() => Promise.resolve({ kind: "answered", body: {} }));
    a.requests.watch();
    await w.settle();
    expect(a.results).toHaveLength(1);
    expect(a.requests.stored()).toEqual([]);
  });
});

describe("which bulk answer a page shows (review bot on 9daf7c0)", () => {
  const answer = (bulkId: string): BulkResult => ({ kind: "answered", press: { v: 1, bulkId, action: "pause", body: {}, labels: {}, campaign: null, pressedAt: 1 }, body: {} });
  test("an answer to a press this page did not make, a reload's recovered press, shows when nothing of its own is shown", () => {
    expect(shownBulkResult(null, answer("recovered"), new Set())).toEqual(answer("recovered"));
  });
  test("an answer to this page's own press replaces what is shown; another's never replaces this page's own", () => {
    const own = new Set(["mine"]);
    expect(shownBulkResult(answer("other"), answer("mine"), own)).toEqual(answer("mine"));
    expect(shownBulkResult(answer("mine"), answer("other"), own)).toEqual(answer("mine"));
  });
});

describe("a lead named by a stored bulk press waits for it on its record (verifier B1 on 4363270)", () => {
  test("true for an enrollment among a stored press's items, from any tab, until its answer removes the press", async () => {
    const w = world();
    const a = w.tab("a");
    let answer: (a: BulkSendAnswer) => void = () => undefined;
    w.answerWith(() => new Promise((r) => (answer = r)));
    a.requests.press("pause", BODY, LABELS, "Clinics");
    expect(bulkPendingFor(w.local, "e1")).toBe(true);
    expect(bulkPendingFor(w.local, "e2")).toBe(false);
    answer({ kind: "answered", body: {} });
    await w.settle();
    expect(bulkPendingFor(w.local, "e1")).toBe(false);
  });
});
