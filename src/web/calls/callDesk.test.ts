import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { ApiError, CallOutcomeRefusal, CallOutcomeAnswer, CallsView, CallTaskView } from "../../shared/api.ts";
import { CallDesk, NoAnswer, Refused, type CallDeskPorts, type DeskFault, type KeyValue, type OutcomeBody } from "./callDesk.ts";
import { loggedLine, refusedRecordLine } from "./wording.ts";

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
  full = false;
  set = (k: string, v: string) => {
    if (this.full) return false;
    this.map.set(k, v);
    return true;
  };
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
  /** Task reads to fail before the next succeeds. */
  let failTaskReads = 0;
  /** Every POST the desks made, held until the test answers it. */
  const held: Held[] = [];
  const timers: (() => void)[] = [];
  let ids = 0;
  let posts = 0;
  let pressClock = 0;
  const deliver = async (x: Held) => h.request<unknown>("POST", `/api/call-tasks/${x.taskId}/outcome`, x.body);
  /** Delivers a held POST and passes its answer back, or loses the answer. */
  const answer = async (x: Held, lost = false) => {
    held.splice(held.indexOf(x), 1);
    const out = await deliver(x);
    if (lost) x.reject(new NoAnswer());
    else if (out.status === 200) x.resolve(out.body as CallOutcomeAnswer);
    else x.reject(new Refused(out.status, (out.body as ApiError).error.message, "outcome_refused", (out.body as CallOutcomeRefusal).offList));
    await flush();
  };
  const desk = (session: MapStore, faults: ReadonlySet<DeskFault> = new Set(), patch: Partial<CallDeskPorts> = {}) =>
    new CallDesk({
      faults,
      calls: async (focus) => (await h.request<CallsView>("GET", `/api/calls${focus ? `?focus=${focus}` : ""}`)).body,
      task: async (id) => {
        if (failTaskReads > 0) {
          failTaskReads--;
          throw new Error("The server answered 503.");
        }
        return (await h.request<CallTaskView>("GET", `/api/call-tasks/${id}`)).body;
      },
      post: (taskId, body) => {
        posts++;
        return new Promise((resolve, reject) => held.push({ taskId, body, resolve, reject }));
      },
      local,
      session,
      newId: () => `id-${++ids}`,
      now: () => ++pressClock,
      setTimer: (fire) => {
        timers.push(fire);
        return () => timers.splice(timers.indexOf(fire), 1);
      },
      ...patch,
    } satisfies CallDeskPorts);
  const fireTimers = async () => {
    for (const fire of timers.splice(0)) fire();
    await flush();
  };
  const outbox = () => local.keys().filter((k) => k.startsWith("outreach.calls.outbox."));
  const stored = async (requestId: string) => (await h.store.engine.callRequestTask(requestId)) !== null;
  return { h, desk, held, answer, fireTimers, outbox, stored, local, failTaskReads: (n: number) => (failTaskReads = n), posts: () => posts };
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

describe("any desk sends any entry it sees until the server answers (ADR 0003 4.4.1; review bot on e6872eb, finding 2)", () => {
  test("a tab closes with its outcome unanswered; another tab's first attempt fails, and it keeps retrying without reopening until the server answers", async () => {
    const w = await world();
    const a = w.desk(new MapStore());
    await a.start();
    await w.fireTimers();
    a.setDraft({ outcome: "interested" });
    a.log();
    await flush();
    const first = w.held[0]!;
    await w.answer(first, true);
    a.dispose();

    const b = w.desk(new MapStore());
    await b.start();
    await flush();
    const recovery = w.held.find((x) => x.body.requestId === first.body.requestId)!;
    expect(b.getSnapshot().recovering.map((e) => e.body.requestId)).toEqual([first.body.requestId]);
    w.held.splice(w.held.indexOf(recovery), 1);
    recovery.reject(new NoAnswer());
    await flush();
    expect(w.outbox()).toHaveLength(1);

    // Its own backoff, with no reopening and no user action.
    await w.fireTimers();
    const again = w.held.find((x) => x.body.requestId === first.body.requestId)!;
    await w.answer(again);
    expect(w.outbox()).toEqual([]);
    expect(await w.stored(first.body.requestId)).toBe(true);
    expect(b.getSnapshot().recovering).toEqual([]);
  });

  test("two tabs sending one entry store it once: the server answers a repeated request id with its first result", async () => {
    const w = await world();
    const a = w.desk(new MapStore());
    await a.start();
    await w.fireTimers();
    a.setDraft({ outcome: "no_answer", note: "Twice sent, once logged." });
    a.log();
    await flush();
    const b = w.desk(new MapStore());
    await b.start();
    await flush();
    const sends = w.held.filter((x) => x.body.requestId === w.held[0]!.body.requestId);
    expect(sends).toHaveLength(2);
    for (const x of [...sends]) await w.answer(x);
    const calls = (await w.h.request<CallTaskView>("GET", `/api/call-tasks/${sends[0]!.taskId}`)).body.touches.filter((t) => t.kind === "call");
    expect(calls).toHaveLength(1);
    expect(w.outbox()).toEqual([]);
  });
});

describe("a desk that is no longer on screen writes nothing but the outbox (review bot on e6872eb, finding 3; on c8fe609)", () => {
  test("a late answer to a desk left behind changes neither the tab's saved focus nor the draft of the call the user has moved on to", async () => {
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

    // The page is opened again in the same tab: it sends the entry again and its answer clears the draft
    // that press captured, still this tab's, so it shows as logged and the next call opens; the user works two calls.
    const live = w.desk(session);
    await live.start();
    await flush();
    await w.answer(w.held[0]!);
    await flush();
    expect(live.getSnapshot().logged?.requestId).toBe(stale.body.requestId);
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

describe("a refusal is kept, with its note, until dismissed (verifier on e6872eb, item 5)", () => {
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
    // The request never reaches the server, and the tab closes.
    const lost = w.held.splice(0, 1)[0]!;
    lost.reject(new NoAnswer());
    await flush();
    a.dispose();
    // The call is worked from another window before another tab opens, so the next attempt is refused.
    const closed = await w.h.request("POST", `/api/call-tasks/${taskId}/outcome`, { requestId: "elsewhere-2", outcome: "interested", numberId: snap.draft.numberId });
    expect(closed.status).toBe(200);
    const b = w.desk(new MapStore(), faults);
    await b.start();
    await flush();
    await w.answer(w.held[0]!);
    await flush();
    return { w, b };
  };

  test("an outcome refused for a call the page is not on is listed with its note and the server's reason, in the same outbox entry, until dismissed", async () => {
    const { w, b } = await recoveredRefusal();
    const records = b.getSnapshot().refusedRecords;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ body: { outcome: "no_answer", note: "Orphan refusal note must remain visible" }, refused: { offList: { reason: "logged", outcome: "interested" } } });
    expect(w.outbox()).toHaveLength(1);
    b.dismiss(records[0]!.body.requestId);
    expect(b.getSnapshot().refusedRecords).toEqual([]);
    expect(w.outbox()).toEqual([]);
  });

  test("dropping a refusal (the fault) leaves nothing to show", async () => {
    const { w, b } = await recoveredRefusal(new Set(["refusal_dropped"]));
    expect(w.outbox()).toEqual([]);
    expect(b.getSnapshot().refusedRecords).toEqual([]);
  });
});

describe("what a desk shows is derived from the server and the outbox (council on b15a769, item 1; review bot on c8fe609)", () => {
  test("a tab back on Calls while another tab sends its outcome shows it pending, then, when the server has it, what the server says", async () => {
    const w = await world();
    const sessionA = new MapStore();
    const a = w.desk(sessionA);
    await a.start();
    await w.fireTimers();
    a.setDraft({ outcome: "no_answer", note: "Rang out twice." });
    a.log();
    await flush();
    // The request never reaches the server.
    w.held.splice(0, 1)[0]!.reject(new NoAnswer());
    a.dispose();

    const b = w.desk(new MapStore());
    await b.start();
    await flush();
    const resend = w.held[0]!;

    const a2 = w.desk(sessionA);
    await a2.start();
    await flush();
    expect(a2.getSnapshot().pending).toMatchObject({ body: { requestId: resend.body.requestId } });
    expect(a2.getSnapshot().locked).toBe(true);

    // B gets the answer; A learns the outcome only from the server, on its next read.
    for (const x of [...w.held]) await w.answer(x);
    await a2.refresh();
    await flush();
    const snap = a2.getSnapshot();
    expect(snap.pending).toBeNull();
    // Its own resend got the server's replayed answer (shown as logged), or the server's read says it is logged.
    expect(snap.logged?.requestId === resend.body.requestId || snap.away?.offList.reason === "logged").toBe(true);
    expect(w.outbox()).toEqual([]);
  });

  test("a read of the call that fails once loses nothing: the next read shows the stored outcome (review bot on c8fe609)", async () => {
    const w = await world();
    const session = new MapStore();
    const a = w.desk(session);
    await a.start();
    await w.fireTimers();
    a.setDraft({ outcome: "voicemail" });
    a.log();
    await flush();
    const sent = w.held.splice(0, 1)[0]!;
    // Another desk got the answer; this desk's reads of the call fail once.
    expect((await w.h.request("POST", `/api/call-tasks/${sent.taskId}/outcome`, sent.body)).status).toBe(200);
    w.local.remove(`outreach.calls.outbox.${sent.body.requestId}`);
    sent.reject(new NoAnswer());
    await flush();
    await a.refresh();
    await flush();
    // The server's read holds this tab's press: it is shown as logged, whoever got the answer.
    expect(a.getSnapshot().logged).toMatchObject({ requestId: sent.body.requestId, body: { outcome: "voicemail" } });
    expect(a.getSnapshot().focus).not.toBe(sent.taskId);
  });
});

describe("only an answer that says the outcome was refused is a refusal (council on b15a769, item 4)", () => {
  test("a 429 is no answer: the entry stays and is sent again", async () => {
    const w = await world();
    const a = w.desk(new MapStore());
    await a.start();
    await w.fireTimers();
    a.setDraft({ outcome: "no_answer" });
    a.log();
    await flush();
    const first = w.held.splice(0, 1)[0]!;
    first.reject(new Refused(429, "Too many requests.", "rate_limited"));
    await flush();
    expect(w.outbox()).toHaveLength(1);
    expect(a.getSnapshot().pending).toMatchObject({ unconfirmed: true });
    await w.fireTimers();
    expect(w.held.map((x) => x.body.requestId)).toEqual([first.body.requestId]);
  });
});

describe("liveness: an outcome left by a tab that leaves is sent by a tab still open, with no user action (council on b15a769, item 9)", () => {
  const abandoned = async (faults: ReadonlySet<DeskFault> = new Set()) => {
    const w = await world();
    // The tab still open is on another call than the one pressed.
    const bSession = new MapStore();
    const second = (await w.h.request<CallsView>("GET", "/api/calls")).body.readyNow[1]?.taskId ?? "";
    bSession.set("outreach.calls.focus", second);
    const b = w.desk(bSession, faults);
    await b.start();
    await flush();
    const a = w.desk(new MapStore(), faults);
    await a.start();
    await w.fireTimers();
    a.setDraft({ outcome: "interested" });
    a.log();
    await flush();
    // B learns of the entry from the storage event, as the page does.
    await b.refresh();
    await flush();
    // Every attempt so far is lost; A leaves Calls.
    for (const x of w.held.splice(0)) x.reject(new NoAnswer());
    await flush();
    a.dispose();
    return { w, b };
  };

  test("the tab still on Calls keeps sending it on its own backoff", async () => {
    const { w } = await abandoned();
    await w.fireTimers();
    expect(w.held).toHaveLength(1);
    const id = w.held[0]!.body.requestId;
    await w.answer(w.held[0]!);
    expect(w.outbox()).toEqual([]);
    expect(await w.stored(id)).toBe(true);
  });

  test("a desk that retries only the entries for the call it is on (the fault) leaves it unsent", async () => {
    const { w } = await abandoned(new Set(["only_focused_entries_retried"]));
    await w.fireTimers();
    expect(w.held).toEqual([]);
    expect(w.outbox()).toHaveLength(1);
  });
});

describe("whether a note was saved is the server's fact (review bot on 9c3ad27)", () => {
  test("a voicemail saved with its note, the page left, one failed read: the page never says the saved note was not saved", async () => {
    const w = await world();
    const session = new MapStore();
    const a = w.desk(session);
    await a.start();
    await w.fireTimers();
    a.setDraft({ outcome: "voicemail", note: "Left a message about evening bookings." });
    a.log();
    await flush();
    // Saved on the server; the answer is lost and the user leaves Calls.
    await w.answer(w.held[0]!, true);
    a.dispose();
    // Back on Calls: the page sends the entry again and the server answers with the stored result; the next read of the call fails once.
    const back = w.desk(session);
    await back.start();
    await flush();
    w.failTaskReads(1);
    for (const x of [...w.held]) await w.answer(x);
    await flush();
    await back.refresh();
    await flush();
    // The same tab's draft was that press's: the answer shows it logged, with the note as the server stored it.
    const logged = back.getSnapshot().logged;
    expect(logged?.body.outcome).toBe("voicemail");
    expect(logged?.task.personNotes.map((n) => n.body)).toContain("Left a message about evening bookings.");
    expect(back.getSnapshot().away?.note ?? "").toBe("");
  });
});

describe("one path for a refusal, whichever call the page is on (review bot on 9c3ad27)", () => {
  test("another tab's outcome refused on the call this page is on keeps that tab's note on screen and in storage", async () => {
    const w = await world();
    const b = w.desk(new MapStore());
    await b.start();
    await w.fireTimers();
    const snap = b.getSnapshot();
    const view = snap.task?.state === "ready" ? snap.task.view : null;
    const mainLine = view?.numbers.find((n) => n.kind === "main_line");
    b.setDraft({ numberId: mainLine?.detailId ?? null, outcome: "no_answer", note: "Typed in the other tab." });
    b.log();
    await flush();
    // B's request never arrives, and B closes. The main line is marked bad on a colleague's call meanwhile.
    for (const x of w.held.splice(0)) x.reject(new NoAnswer());
    await flush();
    b.dispose();
    const calls = (await w.h.request<CallsView>("GET", "/api/calls")).body;
    const other = calls.readyNow.find((x) => x.taskId !== snap.focus);
    expect((await w.h.request("POST", `/api/call-tasks/${other?.taskId}/outcome`, { requestId: "elsewhere-main", outcome: "wrong_number", numberId: mainLine?.detailId })).status).toBe(200);

    // A, on that same call, sends B's entry and gets the refusal.
    const a = w.desk(new MapStore());
    await a.start();
    await flush();
    expect(a.getSnapshot().focus).toBe(snap.focus);
    await w.answer(w.held[0]!);
    await flush();
    const kept = a.getSnapshot().refusedRecords;
    expect(kept).toEqual([expect.objectContaining({ taskId: snap.focus, body: expect.objectContaining({ note: "Typed in the other tab." }) })]);
    expect(w.outbox()).toHaveLength(1);
  });
});

describe("storage is the only truth: a dismissal is final, and a press storage refuses is not pressed (re-check on 9c3ad27, B2 and B3)", () => {
  test("a refusal dismissed in one tab never comes back from another tab that had sent the entry", async () => {
    const w = await world();
    const a = w.desk(new MapStore());
    await a.start();
    await w.fireTimers();
    const taskId = a.getSnapshot().focus ?? "";
    const numberId = a.getSnapshot().draft.numberId;
    a.setDraft({ outcome: "no_answer", note: "Typed in tab A." });
    a.log();
    await flush();
    // A's request never arrives; the call is worked elsewhere, so B's resend is refused.
    for (const x of w.held.splice(0)) x.reject(new NoAnswer());
    await flush();
    expect((await w.h.request("POST", `/api/call-tasks/${taskId}/outcome`, { requestId: "elsewhere", outcome: "interested", numberId })).status).toBe(200);
    const b = w.desk(new MapStore());
    await b.start();
    await flush();
    for (const x of w.held.filter((x) => x.body.note === "Typed in tab A.")) await w.answer(x);
    await flush();
    const kept = b.getSnapshot().refusedRecords;
    expect(kept).toHaveLength(1);
    b.dismiss(kept[0]!.body.requestId);
    expect(w.outbox()).toEqual([]);
    // A comes back online and its retry timers run: nothing is sent again, nothing pending, nothing comes back.
    a.retryNow();
    await w.fireTimers();
    await a.refresh();
    await flush();
    expect(w.held.filter((x) => x.body.note === "Typed in tab A.")).toEqual([]);
    expect(a.getSnapshot().pending).toBeNull();
    expect(a.getSnapshot().refusedRecords).toEqual([]);
    expect(w.outbox()).toEqual([]);
  });

  test("a press storage refuses sends nothing, says so, keeps the draft and number, and Log works once storage has room", async () => {
    const w = await world();
    const a = w.desk(new MapStore());
    await a.start();
    await w.fireTimers();
    const numberId = a.getSnapshot().draft.numberId;
    a.setDraft({ outcome: "voicemail", note: "Left a message." });
    w.local.full = true;
    a.log();
    await flush();
    expect(w.held).toEqual([]);
    expect(a.getSnapshot()).toMatchObject({ notQueued: true, pending: null, locked: false, draft: { outcome: "voicemail", note: "Left a message.", numberId } });
    w.local.full = false;
    a.log();
    await flush();
    expect(w.held).toHaveLength(1);
    expect(a.getSnapshot().notQueued).toBe(false);
  });
});

describe("a press the server has stored is logged, whoever got its answer and whenever (council on b8c65f9, item 1; ADR 0003 4.4.1)", () => {
  for (const outcome of ["skip_for_now", "no_answer", "voicemail", "gatekeeper", "interested", "wrong_number"] as const) {
    test(`${outcome}: the user leaves Calls before the answer; back on Calls, the press shows as logged and is not offered again`, async () => {
      const w = await world();
      const session = new MapStore();
      const a = w.desk(session);
      await a.start();
      await w.fireTimers();
      const pressedOn = a.getSnapshot().focus;
      a.setDraft({ outcome, note: "Typed with the press." });
      a.log();
      await flush();
      // The user clicks Today; the request completes while this desk is gone.
      a.dispose();
      await w.answer(w.held[0]!);
      const back = w.desk(session);
      await back.start();
      await flush();
      const snap = back.getSnapshot();
      expect(snap.logged).toMatchObject({ body: { outcome, note: "Typed with the press." } });
      expect(snap.draft.pressId).toBeNull();
      // Nothing on screen offers that press again: no draft carries it, and Log on what shows stores nothing twice.
      expect(snap.focus === pressedOn ? snap.draft.note : "").not.toBe("Typed with the press.");
      back.log();
      await flush();
      for (const x of [...w.held]) await w.answer(x);
      const stored = (await w.h.request<CallTaskView>("GET", `/api/call-tasks/${pressedOn}`)).body.storedRequestIds;
      expect(stored).toHaveLength(1);
    });
  }

  test("another tab gets the answer and this tab's own answer is lost: the skip shows as logged, and its draft is not actionable", async () => {
    const w = await world();
    const a = w.desk(new MapStore());
    await a.start();
    await w.fireTimers();
    a.setDraft({ outcome: "skip_for_now", note: "Skipped once." });
    a.log();
    await flush();
    const original = w.held[0]!;
    const b = w.desk(new MapStore());
    await b.start();
    await flush();
    await w.answer(w.held.find((x) => x !== original)!);
    await w.answer(original, true);
    await a.refresh();
    await flush();
    expect(a.getSnapshot().logged).toMatchObject({ requestId: original.body.requestId, body: { outcome: "skip_for_now" } });
    expect(a.getSnapshot().draft).toMatchObject({ outcome: null, note: "", pressId: null });
  });

  test("the fault that ignores the server's stored ids leaves the stored skip as an actionable draft", async () => {
    const w = await world();
    const session = new MapStore();
    const a = w.desk(session, new Set(["stored_press_left_as_draft"]));
    await a.start();
    await w.fireTimers();
    a.setDraft({ outcome: "skip_for_now", note: "Skipped once." });
    a.log();
    await flush();
    a.dispose();
    await w.answer(w.held[0]!);
    const back = w.desk(session, new Set(["stored_press_left_as_draft"]));
    await back.start();
    await flush();
    expect(back.getSnapshot().logged).toBeNull();
  });
});

describe("an answer never touches a draft; a failed copy of it in this tab is only said (council on b8c65f9, item 6; re-check 5, R8)", () => {
  test("another tab's answer comes first, this tab's storage refuses the draft's copy, the user types, then the original answer arrives: the typing stays", async () => {
    const w = await world();
    const session = new MapStore();
    const a = w.desk(session);
    await a.start();
    await w.fireTimers();
    a.setDraft({ outcome: "skip_for_now", note: "First skipped note." });
    a.log();
    await flush();
    const original = w.held[0]!;
    const b = w.desk(new MapStore());
    await b.start();
    await flush();
    await w.answer(w.held.find((x) => x !== original)!);
    await a.refresh();
    await flush();
    // The page moved on from its stored skip; on the call now on screen the copy in this tab fails.
    const focus = a.getSnapshot().focus;
    session.full = true;
    a.setDraft({ note: "A newer note, not kept on this device." });
    expect(a.getSnapshot().draftNotKept).toBe(true);
    await w.answer(original);
    await flush();
    expect(a.getSnapshot().focus).toBe(focus);
    expect(a.getSnapshot().draft.note).toBe("A newer note, not kept on this device.");
  });

  test("the fault that lets an answer clear the draft on screen is caught", async () => {
    const w = await world();
    const a = w.desk(new MapStore(), new Set(["answer_clears_draft"]));
    await a.start();
    await w.fireTimers();
    a.setDraft({ outcome: "skip_for_now", note: "First skipped note." });
    a.log();
    await flush();
    const original = w.held[0]!;
    const b = w.desk(new MapStore());
    await b.start();
    await flush();
    await w.answer(w.held.find((x) => x !== original)!);
    await a.refresh();
    await flush();
    a.setDraft({ note: "A newer note." });
    await w.answer(original);
    await flush();
    expect(a.getSnapshot().draft.note).not.toBe("A newer note.");
  });
});

describe("every read of the call goes through the one reconciliation, and every failure counts (council on b8c65f9, item 7; re-check 5, R5 and R6)", () => {
  /** A desk whose tab is on Pat's call, which another window has already logged. */
  const onLoggedCall = async (faults: ReadonlySet<DeskFault> = new Set()) => {
    const w = await world();
    const first = (await w.h.request<CallsView>("GET", "/api/calls")).body.readyNow[0]!.taskId;
    const view = (await w.h.request<CallTaskView>("GET", `/api/call-tasks/${first}`)).body;
    expect((await w.h.request("POST", `/api/call-tasks/${first}/outcome`, { requestId: "elsewhere-1", outcome: "interested", numberId: view.numbers[0]?.detailId })).status).toBe(200);
    const session = new MapStore();
    session.set("outreach.calls.focus", first);
    const a = w.desk(session, faults);
    return { w, a, first };
  };

  test("on first opening, a named call the server has off the list is locked, with why", async () => {
    const { a, first } = await onLoggedCall();
    await a.start();
    await flush();
    expect(a.getSnapshot().focus).toBe(first);
    expect(a.getSnapshot().away).toMatchObject({ offList: { reason: "logged", outcome: "interested" } });
    expect(a.getSnapshot().locked).toBe(true);
  });

  test("on first opening, a call the queue names but the call's own read has off the list (the lead ended in between) is locked, with why", async () => {
    const w = await world();
    const queue = (await w.h.request<CallsView>("GET", "/api/calls")).body;
    const first = queue.readyNow[0]!.taskId;
    const view = (await w.h.request<CallTaskView>("GET", `/api/call-tasks/${first}`)).body;
    expect((await w.h.request("POST", `/api/call-tasks/${first}/outcome`, { requestId: "elsewhere-3", outcome: "interested", numberId: view.numbers[0]?.detailId })).status).toBe(200);
    // The queue the page reads was answered just before that: it still names the call.
    let stale = true;
    const a = w.desk(new MapStore(), new Set(), {
      calls: async (focus) => {
        if (stale) {
          stale = false;
          return queue;
        }
        return (await w.h.request<CallsView>("GET", `/api/calls${focus ? `?focus=${focus}` : ""}`)).body;
      },
    });
    await a.start();
    await flush();
    expect(a.getSnapshot().focus).toBe(first);
    expect(a.getSnapshot().away).toMatchObject({ offList: { reason: "logged", outcome: "interested" } });
    expect(a.getSnapshot().locked).toBe(true);
  });

  test("the fault that skips the reconciliation on a first read leaves it workable", async () => {
    const { a } = await onLoggedCall(new Set(["first_read_skips_reconcile"]));
    await a.start();
    await flush();
    expect(a.getSnapshot().locked).toBe(false);
  });

  test("reads of the call that fail while the queue's succeed are counted: after two, the page says it may be out of date; then the server's word locks it", async () => {
    const w = await world();
    const a = w.desk(new MapStore());
    await a.start();
    await w.fireTimers();
    const focus = a.getSnapshot().focus ?? "";
    const view = (await w.h.request<CallTaskView>("GET", `/api/call-tasks/${focus}`)).body;
    expect((await w.h.request("POST", `/api/call-tasks/${focus}/outcome`, { requestId: "elsewhere-2", outcome: "interested", numberId: view.numbers[0]?.detailId })).status).toBe(200);
    w.failTaskReads(2);
    await a.refresh();
    await flush();
    await a.refresh();
    await flush();
    expect(a.getSnapshot().freshness.stale).toBe(true);
    await a.refresh();
    await flush();
    expect(a.getSnapshot().freshness.stale).toBe(false);
    expect(a.getSnapshot().locked).toBe(true);
    expect(a.getSnapshot().away?.offList.reason).toBe("logged");
  });

  test("the fault that leaves the call's read failures uncounted is caught", async () => {
    const w = await world();
    const a = w.desk(new MapStore(), new Set(["task_failures_uncounted"]));
    await a.start();
    await w.fireTimers();
    w.failTaskReads(2);
    await a.refresh();
    await flush();
    await a.refresh();
    await flush();
    expect(a.getSnapshot().freshness.stale).toBe(false);
  });

  test("an off-list reason gives way to a later read that lists the call again, and moving on keeps the call's draft", async () => {
    const w = await world();
    let offNext = false;
    const session = new MapStore();
    const a = w.desk(session, new Set(), {
      task: async (id): Promise<CallTaskView> => {
        const view = (await w.h.request<CallTaskView>("GET", `/api/call-tasks/${id}`)).body;
        if (!offNext) return view;
        // One read says the call is off the list (its hours closed, say); the next lists it again.
        offNext = false;
        return { ...view, listed: false, offList: { reason: "not_listed_today", status: view.status } };
      },
    });
    await a.start();
    await w.fireTimers();
    const focus = a.getSnapshot().focus;
    a.setDraft({ outcome: "no_answer", note: "Typed before the hours closed." });
    offNext = true;
    await a.refresh();
    await flush();
    expect(a.getSnapshot().away?.offList.reason).toBe("not_listed_today");
    await a.refresh();
    await flush();
    expect(a.getSnapshot().away).toBeNull();
    expect(a.getSnapshot().locked).toBe(false);
    expect(a.getSnapshot().focus).toBe(focus);
    expect(a.getSnapshot().draft.note).toBe("Typed before the hours closed.");
    // Shown off the list again, the user moves on; the server still puts this call first, and its draft is there.
    offNext = true;
    await a.refresh();
    await flush();
    await a.moveOn();
    await flush();
    expect(a.getSnapshot().focus).toBe(focus);
    expect(a.getSnapshot().draft.note).toBe("Typed before the hours closed.");
  });
});

describe("a refusal this device cannot record is shown, never a reason to ask again (review bot on 12f0303; ADR 0003 4.4.1)", () => {
  async function refusedWhileFull(faults: ReadonlySet<DeskFault> = new Set()) {
    const w = await world();
    const a = w.desk(new MapStore(), faults);
    await a.start();
    await w.fireTimers();
    const snap = a.getSnapshot();
    const view = snap.task?.state === "ready" ? snap.task.view : null;
    const mainLine = view?.numbers.find((n) => n.kind === "main_line");
    a.setDraft({ numberId: mainLine?.detailId ?? null, outcome: "no_answer", note: "Typed with the refused press." });
    a.log();
    await flush();
    // The main line is marked wrong on a colleague's call before the press arrives; the device's storage is full from now.
    const other = (await w.h.request<CallsView>("GET", "/api/calls")).body.readyNow.find((x) => x.taskId !== snap.focus);
    expect((await w.h.request("POST", `/api/call-tasks/${other?.taskId}/outcome`, { requestId: "elsewhere-main", outcome: "wrong_number", numberId: mainLine?.detailId })).status).toBe(200);
    w.local.full = true;
    // A second tab is open too. Every request is answered as soon as it is made, for a long while: refresh, storage events, timers, Try again.
    const b = w.desk(new MapStore(), faults);
    await b.start();
    for (let i = 0; i < 30 && w.posts() < 50; i++) {
      for (const x of [...w.held]) await w.answer(x);
      await a.refresh();
      await b.refresh();
      if (i % 10 === 9) await w.fireTimers();
      await flush();
    }
    return { w, a, b };
  }

  test("each desk sends the entry once; the refusal is shown with its note from memory; its write is retried on the backoff, and stored once there is room", async () => {
    const { w, a, b } = await refusedWhileFull();
    // One send from the pressing desk and one from the other desk when it first saw the entry: no more.
    expect(w.posts()).toBe(2);
    for (const d of [a, b]) {
      const shown = d.getSnapshot().refusedRecords;
      expect(shown).toHaveLength(1);
      expect(shown[0]).toMatchObject({ unstored: true, body: { note: "Typed with the refused press." } });
      expect(d.getSnapshot().pending).toBeNull();
    }
    // Storage has room again: the next try on the backoff records the refusal; nothing is sent.
    w.local.full = false;
    await w.fireTimers();
    expect(w.posts()).toBe(2);
    const kept = w.outbox().map((k) => w.local.get(k) ?? "");
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain('"refused"');
    expect(kept[0]).not.toContain("unstored");
    expect(a.getSnapshot().refusedRecords[0]?.unstored).toBeUndefined();
  });

  test("the fault that sends again at once when the refusal cannot be recorded is caught by the count of requests", async () => {
    const { w } = await refusedWhileFull(new Set(["refusal_resent_at_once"]));
    expect(w.posts()).toBeGreaterThan(2);
  });
});

describe("a kept refusal is removed only by its own Dismiss (review bot on 26d4b49)", () => {
  /** Two refusals kept for the call on screen and an older one for another call; the call is then logged elsewhere. */
  const kept = async (faults: ReadonlySet<DeskFault> = new Set()) => {
    const w = await world();
    const queue = (await w.h.request<CallsView>("GET", "/api/calls")).body;
    const [onScreen, other] = [queue.readyNow[0]!.taskId, queue.readyNow[1]!.taskId];
    const refused = { message: "This call is already logged.", offList: null };
    const put = (id: string, taskId: string, note: string, pressedAt: number) =>
      w.local.set(`outreach.calls.outbox.${id}`, JSON.stringify({ v: 2, taskId, who: "Someone", body: { requestId: id, outcome: "no_answer", numberId: null, note, noteScope: "person" }, pressedAt, refused }));
    put("older-other", other, "Older note on another call.", 1);
    put("kept-1", onScreen, "First note, behind the count.", 2);
    put("kept-2", onScreen, "Second note, behind the count.", 3);
    const view = (await w.h.request<CallTaskView>("GET", `/api/call-tasks/${onScreen}`)).body;
    expect((await w.h.request("POST", `/api/call-tasks/${onScreen}/outcome`, { requestId: "elsewhere-9", outcome: "interested", numberId: view.numbers[0]?.detailId })).status).toBe(200);
    const session = new MapStore();
    session.set("outreach.calls.focus", onScreen);
    const a = w.desk(session, faults);
    await a.start();
    await flush();
    expect(a.getSnapshot().away?.offList.reason).toBe("logged");
    return { w, a };
  };

  test("moving on from the call keeps every refusal kept for it, with its note", async () => {
    const { w, a } = await kept();
    await a.moveOn();
    await flush();
    expect(a.getSnapshot().refusedRecords.map((r) => r.body.note)).toEqual(["Older note on another call.", "First note, behind the count.", "Second note, behind the count."]);
    expect(w.outbox()).toHaveLength(3);
    // Each goes only by its own Dismiss.
    a.dismiss("kept-1");
    expect(a.getSnapshot().refusedRecords.map((r) => r.body.requestId)).toEqual(["older-other", "kept-2"]);
  });

  test("the fault that removes a call's refusals on moving on is caught", async () => {
    const { a } = await kept(new Set(["refusal_removed_on_move_on"]));
    await a.moveOn();
    await flush();
    expect(a.getSnapshot().refusedRecords).toHaveLength(1);
  });
});

describe("a redial and a callback's date and time are part of the press, like the outcome (ticket 15b; ADR 0003 4.4.1)", () => {
  const ready = async (w: Awaited<ReturnType<typeof world>>, faults: ReadonlySet<DeskFault> = new Set()) => {
    const d = w.desk(new MapStore(), faults);
    await d.start();
    await w.fireTimers();
    const snap = d.getSnapshot();
    if (snap.task?.state !== "ready") throw new Error("no call on screen");
    return { d, view: snap.task.view };
  };

  test("a redial is fixed in the entry at the press, sent again unchanged after no answer, and said as the server stored it", async () => {
    const w = await world();
    const { d, view } = await ready(w);
    expect(view.redial).toEqual({ listedFor: "2026-11-03", ifUnworked: "2026-11-03" });
    d.setDraft({ outcome: "no_answer", redial: true, note: "Rang out." });
    d.log();
    await flush();
    const first = w.held[0];
    expect(first?.body).toMatchObject({ outcome: "no_answer", redial: true, note: "Rang out." });
    await w.answer(first!, true);
    await w.fireTimers();
    expect(w.held[0]?.body).toEqual(first?.body);
    await w.answer(w.held[0]!);
    await flush();
    const logged = d.getSnapshot().logged;
    expect(logged).not.toBeNull();
    expect(loggedLine(logged!, "Europe/London")).toBe("Pat Oneil: no answer logged, with a redial. The call is on the list for Tue 3 Nov, and the phone track stays open. If it isn’t worked, it is skipped at the end of Tue 3 Nov. The note is saved on Pat Oneil.");
  });

  test("the redial choice stays in the draft, and goes only with an outcome the call offers it for", async () => {
    const w = await world();
    const { d } = await ready(w);
    d.setDraft({ outcome: "no_answer", redial: true });
    d.setDraft({ outcome: "interested" });
    expect(d.getSnapshot().draft).toMatchObject({ outcome: "interested", redial: true });
    d.log();
    await flush();
    expect(w.held[0]?.body).not.toHaveProperty("redial");
  });

  test("a callback's time is entered in the prospect's time and sent as that instant with their offset; the hold is said from the server's answer", async () => {
    const w = await world();
    const { d } = await ready(w);
    d.setDraft({ outcome: "callback_requested", callbackDay: "2026-11-02", callbackTime: "15:30", note: "After clinic." });
    expect(d.getSnapshot().callback).toEqual({ at: Date.parse("2026-11-02T15:30:00Z"), problem: null });
    d.log();
    await flush();
    expect(w.held[0]?.body).toMatchObject({ outcome: "callback_requested", callbackAt: "2026-11-02T15:30:00+00:00" });
    await w.answer(w.held[0]!);
    await flush();
    expect(loggedLine(d.getSnapshot().logged!, "Europe/London")).toBe("Pat Oneil: callback requested for Mon 2 Nov at 15:30 their time, the same as yours. Their automated outreach in Desk is held until you log how the callback went. The note is saved on Pat Oneil.");
  });

  test("a callback with no time, or a time already passed as of the call's read, is refused in place: nothing is sent and the draft stays", async () => {
    const w = await world();
    const { d } = await ready(w);
    d.setDraft({ outcome: "callback_requested", callbackDay: "2026-11-02" });
    expect(d.getSnapshot().callback).toEqual({ at: null, problem: "missing" });
    d.log();
    d.setDraft({ callbackTime: "09:45" });
    expect(d.getSnapshot().callback).toEqual({ at: null, problem: "past" });
    d.log();
    await flush();
    expect(w.posts()).toBe(0);
    expect(w.outbox()).toEqual([]);
    expect(d.getSnapshot().draft).toMatchObject({ outcome: "callback_requested", callbackDay: "2026-11-02", callbackTime: "09:45" });
  });

  test("a callback pressed for a call that expires before it arrives is refused, kept with its time and note until dismissed", async () => {
    const w = await world();
    const { d } = await ready(w);
    d.setDraft({ outcome: "callback_requested", callbackDay: "2026-11-05", callbackTime: "11:00", note: "Call Thursday." });
    d.log();
    await flush();
    // The request is held while the call's skip limit passes: at the end of Tuesday it is skipped, unworked.
    await w.h.advanceTo(Date.parse("2026-11-04T10:00:00Z"));
    await w.answer(w.held[0]!);
    const kept = d.getSnapshot().refusedRecords;
    expect(kept).toHaveLength(1);
    expect(kept[0]?.body).toMatchObject({ callbackAt: "2026-11-05T11:00:00+00:00", note: "Call Thursday." });
    expect(refusedRecordLine(kept[0]!, "Europe/London")).toMatch(/^Not logged: callback requested for Thu 5 Nov at 11:00 your time for Pat Oneil\. This call was skipped at /);
  });

  test("the faults that drop a redial on a resend, reset a callback on an answer, or send a past callback are each seen", async () => {
    const lost = await world();
    const a = await ready(lost, new Set(["redial_lost_on_resend"]));
    a.d.setDraft({ outcome: "voicemail", redial: true });
    a.d.log();
    await flush();
    await lost.answer(lost.held[0]!, true);
    await lost.fireTimers();
    expect(lost.held[0]?.body).not.toHaveProperty("redial");

    const past = await world();
    const b = await ready(past, new Set(["past_callback_sent"]));
    b.d.setDraft({ outcome: "callback_requested", callbackDay: "2026-11-02", callbackTime: "09:00" });
    b.d.log();
    await flush();
    expect(past.posts()).toBe(1);
  });
});
