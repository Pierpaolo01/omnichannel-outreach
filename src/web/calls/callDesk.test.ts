import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { ApiError, CallOutcomeAnswer, CallsView, CallTaskView } from "../../shared/api.ts";
import { CallDesk, NoAnswer, Refused, type CallDeskPorts, type DeskFault, type KeyValue, type OutcomeBody } from "./callDesk.ts";

/**
 * The call desk's rule (ADR 0003 4.4.1) on the cases the review bot found on e6872eb, each driven
 * against the real HTTP app and engine. The generated test (callDesk.generated.test.ts) reaches the
 * same rules by generated event orders; these name the cases.
 */

const MIN = 60_000;
/** Monday 2 November 2026, 10:00 London (GMT). */
const MONDAY_10 = Date.parse("2026-11-02T10:00:00Z");
const WEEKDAYS_9_TO_17 = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
const call: StepDefinition = { id: "c1", waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false };
const phone: TrackDefinition = { id: "p1", channel: "call", branch: "main", window: WEEKDAYS_9_TO_17, steps: [call], start: { kind: "entry" }, removed: false };
const DEFINITION: CampaignDefinition = { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: [], callScript: "", tracks: [phone] };

class MapStore implements KeyValue {
  readonly map = new Map<string, string>();
  get = (k: string) => this.map.get(k) ?? null;
  set = (k: string, v: string) => void this.map.set(k, v);
  remove = (k: string) => void this.map.delete(k);
  keys = () => [...this.map.keys()];
}

interface Held {
  readonly body: OutcomeBody;
  readonly taskId: string;
  readonly resolve: (a: CallOutcomeAnswer) => void;
  readonly reject: (e: Error) => void;
}

/** Lets every request in flight to the in-process app finish. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

async function world() {
  const h = new EngineHarness({ start: MONDAY_10 - 2 * 60 * MIN, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
  await h.tick();
  await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" });
  h.clock = MONDAY_10 - 30 * MIN;
  const { campaign } = await h.createCampaign("Desk", {
    businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })],
    people: [
      person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", direct_phone: "+442079460111" }),
      person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", email: "nia@harbour.example", dial_phone: "+447700900102", dial_phone_type: "mobile" }),
      person({ person_id: "p3", business_id: "b1", full_name: "Sam Lee", email: "sam@harbour.example", direct_phone: "+442079460333" }),
    ],
  });
  await h.defineSequence(campaign.id, DEFINITION);
  expect((await h.launch(campaign.id)).status).toBe(200);
  await h.advanceTo(MONDAY_10);

  const local = new MapStore();
  /** Every POST the desks made, held until the test answers it. */
  const held: Held[] = [];
  const locks = new Map<string, symbol>();
  const timers: (() => void)[] = [];
  let ids = 0;
  const deliver = async (x: Held) => h.request<unknown>("POST", `/api/call-tasks/${x.taskId}/outcome`, x.body);
  /** Delivers a held POST and passes its answer back, or loses the answer. */
  const answer = async (x: Held, lost = false) => {
    held.splice(held.indexOf(x), 1);
    const out = await deliver(x);
    if (lost) x.reject(new NoAnswer());
    else if (out.status === 200) x.resolve(out.body as CallOutcomeAnswer);
    else x.reject(new Refused(out.status, (out.body as ApiError).error.message));
    await flush();
  };
  const desk = (session: MapStore, faults: ReadonlySet<DeskFault> = new Set()) =>
    new CallDesk({
      faults,
      calls: async (focus) => (await h.request<CallsView>("GET", `/api/calls${focus ? `?focus=${focus}` : ""}`)).body,
      task: async (id) => (await h.request<CallTaskView>("GET", `/api/call-tasks/${id}`)).body,
      post: (taskId, body) => new Promise((resolve, reject) => held.push({ taskId, body, resolve, reject })),
      local,
      session,
      newId: () => `id-${++ids}`,
      setTimer: (fire) => {
        timers.push(fire);
        return () => timers.splice(timers.indexOf(fire), 1);
      },
      claim: (name) => {
        if (locks.has(name)) return Promise.resolve(null);
        const token = Symbol(name);
        locks.set(name, token);
        return Promise.resolve(() => {
          if (locks.get(name) === token) locks.delete(name);
        });
      },
    } satisfies CallDeskPorts);
  const fireTimers = async () => {
    for (const fire of timers.splice(0)) fire();
    await flush();
  };
  const outbox = () => local.keys().filter((k) => k.startsWith("outreach.calls.outbox."));
  const stored = async (requestId: string) => (await h.store.engine.callRequestTask(requestId)) !== null;
  return { h, desk, held, answer, fireTimers, outbox, stored, local };
}

describe("what the user chose is never replaced for them (review bot on e6872eb, finding 1)", () => {
  test("the main line chosen for a wrong number goes bad on a colleague's call: the choice stays, the page says so, and Log sends nothing until the user chooses", async () => {
    const w = await world();
    const d = w.desk(new MapStore());
    await d.start();
    await w.fireTimers();
    const snap = d.getSnapshot();
    const task = snap.task?.state === "ready" ? snap.task.view : null;
    const mainLine = task?.numbers.find((n) => n.kind === "main_line");
    expect(mainLine).toBeDefined();
    d.setDraft({ numberId: mainLine?.detailId ?? null, outcome: "wrong_number", note: "Fax tone." });

    // Another client logs a colleague's call as a wrong number on the shared main line.
    const calls = (await w.h.request<CallsView>("GET", "/api/calls")).body;
    const other = calls.readyNow.find((x) => x.taskId !== task?.taskId);
    const out = await w.h.request("POST", `/api/call-tasks/${other?.taskId}/outcome`, { requestId: "elsewhere-1", outcome: "wrong_number", numberId: mainLine?.detailId });
    expect(out.status).toBe(200);

    await d.refresh();
    const after = d.getSnapshot();
    expect(after.draft).toMatchObject({ numberId: mainLine?.detailId, outcome: "wrong_number", note: "Fax tone." });
    expect(after.numberProblem).toMatchObject({ kind: "bad", value: mainLine?.value });
    d.log();
    await flush();
    expect(w.held).toEqual([]);
    expect(w.outbox()).toEqual([]);

    // The user chooses the lead's own number: now Log sends it.
    const own = (after.task?.state === "ready" ? after.task.view : null)?.numbers.find((n) => n.owner === "person" && !n.bad);
    d.setDraft({ numberId: own?.detailId ?? null });
    expect(d.getSnapshot().numberProblem).toBeNull();
    d.log();
    await flush();
    expect(w.held.map((x) => x.body.numberId)).toEqual([own?.detailId]);
  });
});

describe("every outbox entry is retried until a definite answer, by one sender (review bot on e6872eb, finding 2)", () => {
  test("a tab closes with its outcome unanswered; another tab's first recovery fails, and it keeps retrying without reopening until the server answers", async () => {
    const w = await world();
    const a = w.desk(new MapStore());
    await a.start();
    await w.fireTimers();
    a.setDraft({ outcome: "interested" });
    a.log();
    await flush();
    const first = w.held[0];
    expect(first).toBeDefined();
    await w.answer(first!, true);
    // Tab A closes: its lock goes with it.
    a.dispose();

    const b = w.desk(new MapStore());
    await b.start();
    await flush();
    const recovery = w.held.find((x) => x.body.requestId === first!.body.requestId);
    expect(recovery).toBeDefined();
    expect(b.getSnapshot().recovering.map((e) => e.body.requestId)).toEqual([first!.body.requestId]);
    // The first recovery is lost too (the request reached the server, its answer did not).
    w.held.splice(w.held.indexOf(recovery!), 1);
    recovery!.reject(new NoAnswer());
    await flush();
    expect(w.outbox()).toHaveLength(1);

    // Back online and the backoff: no reopening.
    b.retryNow();
    await flush();
    const again = w.held.find((x) => x.body.requestId === first!.body.requestId);
    expect(again).toBeDefined();
    await w.answer(again!);
    expect(w.outbox()).toEqual([]);
    expect(await w.stored(first!.body.requestId)).toBe(true);
    expect(b.getSnapshot().recovering).toEqual([]);
  });

  test("two tabs on screen never both send one entry", async () => {
    const w = await world();
    const a = w.desk(new MapStore());
    await a.start();
    await w.fireTimers();
    a.setDraft({ outcome: "no_answer" });
    a.log();
    await flush();
    const b = w.desk(new MapStore());
    await b.start();
    await b.refresh();
    await flush();
    expect(w.held).toHaveLength(1);
    expect(b.getSnapshot().recovering).toEqual([]);
  });
});

describe("a desk that is no longer on screen writes nothing (review bot on e6872eb, finding 3)", () => {
  test("a late answer to a desk left behind changes neither the tab's saved focus nor its drafts", async () => {
    const w = await world();
    const session = new MapStore();
    const old = w.desk(session);
    await old.start();
    await w.fireTimers();
    old.setDraft({ outcome: "no_answer" });
    old.log();
    await flush();
    const stale = w.held[0]!;
    w.held.splice(w.held.indexOf(stale), 1);
    // It reaches the server, whose answer names the next call; the answer is held on the way back.
    const staleAnswer = await w.h.request<CallOutcomeAnswer>("POST", `/api/call-tasks/${stale.taskId}/outcome`, stale.body);
    expect(staleAnswer.status).toBe(200);
    const namedByStale = staleAnswer.body.nextFocusTaskId;
    old.dispose();

    // The page is opened again in the same tab: it sends the action again and moves on through two calls.
    const live = w.desk(session);
    await live.start();
    await flush();
    const replay = w.held[0]!;
    await w.answer(replay);
    await flush();
    expect(live.getSnapshot().task?.state).toBe("ready");
    live.setDraft({ outcome: "voicemail" });
    live.log();
    await flush();
    await w.answer(w.held[0]!);
    await flush();
    live.setDraft({ note: "Typing on the third call." });
    const focus = live.getSnapshot().focus;
    expect(focus).not.toBeNull();
    expect(focus).not.toBe(namedByStale);
    const before = new Map(session.map);

    stale.resolve(staleAnswer.body);
    await flush();
    expect(session.map).toEqual(before);
    expect(live.getSnapshot().focus).toBe(focus);
    expect(live.getSnapshot().draft.note).toBe("Typing on the third call.");
  });
});

describe("a refusal is never silent, and typed text is never discarded (verifier on e6872eb, item 5)", () => {
  const recoveredRefusal = async (faults: ReadonlySet<DeskFault> = new Set()) => {
    const w = await world();
    const a = w.desk(new MapStore(), faults);
    await a.start();
    await w.fireTimers();
    const snap = a.getSnapshot();
    const taskId = snap.focus ?? "";
    a.setDraft({ outcome: "no_answer", note: "Orphan refusal note must remain visible" });
    a.log();
    await flush();
    // The request never reaches the server.
    const lost = w.held.splice(0, 1)[0]!;
    lost.reject(new NoAnswer());
    await flush();
    // The tab closes; the call is worked from another window before another tab opens, so the recovery is refused.
    a.dispose();
    const closed = await w.h.request("POST", `/api/call-tasks/${taskId}/outcome`, { requestId: "elsewhere-2", outcome: "interested", numberId: snap.draft.numberId });
    expect(closed.status).toBe(200);
    const b = w.desk(new MapStore(), faults);
    await b.start();
    await flush();
    await w.answer(w.held[0]!);
    await flush();
    return { w, b };
  };

  test("a closed tab's outcome refused on recovery is listed on the next Calls page with its note and the server's reason, until dismissed", async () => {
    const { w, b } = await recoveredRefusal();
    expect(w.outbox()).toEqual([]);
    const records = b.getSnapshot().refusedRecords;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ entry: { body: { outcome: "no_answer", note: "Orphan refusal note must remain visible" } }, message: expect.stringContaining("no longer on the list") });
    b.dismiss(records[0]!.entry.body.requestId);
    expect(b.getSnapshot().refusedRecords).toEqual([]);
  });

  test("the old behaviour, dropping it, leaves nothing to show (the check above fails on it)", async () => {
    const { w, b } = await recoveredRefusal(new Set(["refusal_dropped"]));
    expect(w.outbox()).toEqual([]);
    expect(b.getSnapshot().refusedRecords).toEqual([]);
  });
});
