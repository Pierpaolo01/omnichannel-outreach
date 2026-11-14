import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { ApiError, CallOutcomeAnswer, CallOutcomeApi, CallOutcomeRefusal, CallsView, CallTaskView, LeadSearchResult } from "../../shared/api.ts";
import { loggedLine } from "./wording.ts";
import { CallDesk, NoAnswer, Refused, type DeskFault, type KeyValue, type OutcomeBody } from "./callDesk.ts";

/**
 * Working the call list in the browser (ADR 0003 4.4.1), generated: real call desks (the object the
 * Calls page binds) in two to four tabs that reload, leave Calls, close or are duplicated, sharing one
 * localStorage (storage events reach the other tabs, as in a browser), each tab with its own
 * sessionStorage, against the real HTTP app and engine. The campaign has a phone track beside an email
 * track and an email after the call, several leads at two companies, and a daily capacity. Each run
 * mixes presses of every outcome (sometimes on a number already marked bad), requests delivered late
 * and out of order, answers lost, retries, refreshes, moving on, dismissing kept refusals, numbers
 * marked bad from outside the desks, leads replying by email, and the clock moving; reads of the
 * queue and of a call held and answered out of order or failing, and each tab's sessionStorage
 * refusing writes for a while. It then settles with no user action: storage events, coming back online
 * once, and timers due within a minute (the 20-second read interval among them).
 *
 * Invariants (ADR 0003 4.4.1, numbered as there), from an independent record of every press:
 * 1. Nothing stored twice. 2. Never more than the server said. 3. Nothing lost: every press is stored
 * or kept as a refusal with its note until its own Dismiss. 4. The focus holds. 5. One lock.
 * 6. The user's choice stands. 7. Status is derived and true. 8. A desk off screen writes only the
 * outbox. 9. Liveness: after settling nothing is unanswered and no desk shows an action pending.
 * 10. Bounded sending (checked by a count of requests in callDesk.test.ts). 11. Every sentence about
 * saved, logged or refused agrees with the server's read. 12. A stored press is never an unsent draft.
 * 13. Reads are ordered and counted. 14. What is stored is what was pressed (ticket 15b): every request and
 * the server's record of a press carry its outcome, redial and callback time, and no callback time not after
 * the read it was pressed on is sent. Ticket 15b's presses (redials, callbacks later today, on later days and
 * in the past) and nights passing (so a press on its way can meet an expired call) draw from a second stream.
 *
 * Each desk fault (callDesk.ts `DeskFault`) breaks one of them; the last block checks a known seed
 * catches each (refusal_resent_at_once is caught by its count of requests in callDesk.test.ts).
 */
const SEEDS = Number(process.env["CALL_DESK_SEEDS"] ?? 24);
const STEPS = 90;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const MIN = 60_000;
/** Monday 2 November 2026, 08:30 London (GMT). */
const MONDAY_830 = Date.parse("2026-11-02T08:30:00Z");
const WEEKDAYS_9_TO_17 = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const step = (id: string, waitDays = 0, body = `Email ${id} for {{company}}.`): StepDefinition => ({ id, waitDays, subject: "Hello", body, threading: "new_subject", removed: false });
const track = (id: string, channel: TrackDefinition["channel"], steps: StepDefinition[], start: TrackDefinition["start"], window = ALWAYS): TrackDefinition => ({ id, channel, branch: "main", window, steps, start, removed: false });
const DEFINITION: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["inbox-a"],
  smsPool: [],
  callScript: "Ask who looks after bookings.",
  tracks: [
    track("e1", "email", [step("s1"), step("s2", 1)], { kind: "entry" }),
    track("p1", "call", [{ ...step("c1", 0, ""), subject: "" }], { kind: "entry" }, WEEKDAYS_9_TO_17),
    track("e2", "email", [step("s3")], { kind: "after", trackId: "p1", delayDays: 0 }),
  ],
};
const PEOPLE = [
  person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", direct_phone: "+442079460111" }),
  person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", email: "nia@harbour.example", dial_phone: "+447700900102", dial_phone_type: "mobile" }),
  person({ person_id: "p3", business_id: "b2", full_name: "Sam Lee", email: "sam@elm.example", direct_phone: "+442079460222" }),
  person({ person_id: "p4", business_id: "b2", full_name: "Ana Ruiz", email: "ana@elm.example" }),
];
const BUSINESSES = [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" }), business({ business_id: "b2", business_name: "Elm Street Clinic", phone_e164: "+442079460202" })];
const OUTCOMES: readonly CallOutcomeApi[] = ["no_answer", "voicemail", "gatekeeper", "wrong_number", "interested", "skip_for_now"];
const REDIAL_OUTCOMES: readonly CallOutcomeApi[] = ["no_answer", "voicemail", "gatekeeper"];

/** Lets every request in flight to the in-process app finish. */
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * A desk's view of a storage, watching it: a desk no longer on screen may only remove an outbox entry
 * on a definite answer (invariant 9).
 */
function watched(store: KeyValue, owner: () => Instance, problems: string[], label: string, changed?: (key: string) => void): KeyValue {
  const gone = (what: string, key: string) => {
    // Allowed after leaving: the outbox entry an answer settles (removed when accepted, rewritten as refused).
    const allowed = key.startsWith("outreach.calls.outbox.");
    if (owner().disposed && !allowed) problems.push(`8: a desk of ${label} left behind did ${what} ${key}`);
  };
  return {
    get: (k) => store.get(k),
    keys: () => store.keys(),
    set: (k, v) => {
      gone("set", k);
      const stored = store.set(k, v);
      if (stored) changed?.(k);
      return stored;
    },
    remove: (k) => {
      gone("remove", k);
      store.remove(k);
      changed?.(k);
    },
  };
}

class MapStore implements KeyValue {
  readonly map = new Map<string, string>();
  /** While true, every write is refused, as a full or blocked browser storage refuses it. */
  full = false;
  /** Outbox keys once removed: an entry removed in any tab never reappears (ADR 0003 4.4.1). */
  readonly removed = new Set<string>();
  readonly reappeared: string[] = [];
  get = (k: string) => this.map.get(k) ?? null;
  set = (k: string, v: string) => {
    if (this.full) return false;
    if (this.removed.has(k)) this.reappeared.push(k);
    this.map.set(k, v);
    return true;
  };
  remove = (k: string) => {
    if (this.map.delete(k) && k.startsWith("outreach.calls.outbox.")) this.removed.add(k);
  };
  keys = () => [...this.map.keys()];
}

interface Instance {
  readonly desk: CallDesk;
  readonly tab: Tab;
  /** Ids this desk was answered 200 for, and refused for. */
  readonly ok: Set<string>;
  readonly refused: Set<string>;
  readonly timers: Set<() => void>;
  /** Each timer's delay: settling fires only those due within a minute, as a page left alone would see. */
  readonly timerMs: Map<() => void, number>;
  disposed: boolean;
  lastFocus: string | null;
  lastLogged: string | null;
  /** Reads of the call that failed in a row (invariant 13), and the queue's last `asOf` it applied. */
  taskFails: number;
  lastAsOf: string | null;
}

interface Tab {
  readonly label: string;
  readonly session: MapStore;
  instance: Instance;
  /** What the user chose on each call's draft in this tab (invariant 7): number, outcome and note; a new object for each edit. */
  readonly choices: Map<string, Choice>;
  /** The call whose draft this tab's storage last refused to copy: after a reload it is not there. */
  notKept: string | null;
}

interface Choice {
  readonly numberId: string | null;
  readonly outcome: string | null;
  readonly note: string;
  /** Ticket 15b: the redial choice and a callback's day and time, as the user entered them. */
  readonly redial: boolean;
  readonly callbackDay: string | null;
  readonly callbackTime: string;
}

const sameChoice = (a: Choice, b: Choice) => a.numberId === b.numberId && a.outcome === b.outcome && a.note === b.note && a.redial === b.redial && a.callbackDay === b.callbackDay && a.callbackTime === b.callbackTime;

/** London's date and time of an instant, as the callback controls take them. */
const londonDay = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
const londonTime = (t: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t);

interface Request {
  readonly from: Instance;
  readonly taskId: string;
  readonly body: OutcomeBody;
  answer: { status: number; json: unknown } | null;
  readonly resolve: (a: CallOutcomeAnswer) => void;
  readonly reject: (e: Error) => void;
}

interface Press {
  readonly tab: string;
  readonly note: string;
  readonly ids: Set<string>;
}

async function run(seed: number, faults: ReadonlySet<DeskFault> = new Set()) {
  const r = rng(seed);
  // Ticket 15b's choices draw from a stream of their own, so the 14b runs keep their shape.
  const r15 = rng(seed ^ 0x15b15b);
  const h = new EngineHarness({ start: MONDAY_830 - 30 * MIN, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
  await h.tick();
  await h.request("PUT", "/api/call-settings", { dailyCapacity: 3, userZone: "Europe/London" });
  h.clock = MONDAY_830;
  const { campaign } = await h.createCampaign("Generated calls", { businesses: BUSINESSES, people: PEOPLE });
  await h.defineSequence(campaign.id, DEFINITION);
  expect((await h.launch(campaign.id)).status).toBe(200);
  expect((await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows.length).toBe(4);
  await h.advanceTo(MONDAY_830 + 35 * MIN);

  const local = new MapStore();
  const requests: Request[] = [];
  const presses: Press[] = [];
  const pressOf = new Map<string, Press>();
  /** Reads held on the way back, answered later in any order, or failed (invariant 13). */
  const gets: { from: Instance; release: () => void; fail: () => void }[] = [];
  /** While the network settles, reads are answered at once. */
  let settling = false;
  /** One read over the network: now and then held and answered later, as it was when sent; a call's read sometimes fails. */
  const network = <T,>(from: Instance, kind: "calls" | "task", read: () => Promise<T>): Promise<T> => {
    if (settling) return read();
    const roll = r();
    if (kind === "task" && roll < 0.08) {
      seen.failedReads++;
      return Promise.reject(new Error("The server answered 503."));
    }
    if (roll < 0.22) {
      seen.heldGets++;
      return read().then((value) => new Promise<T>((resolve, reject) => gets.push({ from, release: () => resolve(value), fail: () => reject(new Error("The server answered 503.")) })));
    }
    return read();
  };
  let pressClock = 0;
  /** The tab's choice each press was made from, by request id: still the choice on screen once stored, it was never shown as logged (12). */
  const pressedChoice = new Map<string, { tab: Tab; taskId: string; choice: Choice | undefined }>();
  const problems: string[] = [];
  /** Every id some desk was refused for, and accepted for, across reloads. */
  const refusedIds = new Set<string>();
  const okIds = new Set<string>();
  /** A storage write by one desk reaches every other desk on screen, later, as the browser's storage event. */
  const storageEvent = (from: Instance, key: string) => {
    if (!key.startsWith("outreach.calls.outbox.")) return;
    for (const t of tabs) {
      const other = t.instance;
      if (other !== from && !other.disposed) setImmediate(() => void (other.disposed ? undefined : other.desk.refresh()));
    }
  };
  let ids = 0;
  /** True while log() runs: its first post is a new press, recorded right after. */
  let pressing = false;
  const stored = async (id: string) => (await h.store.engine.callRequestTask(id)) !== null;
  /** Each press's body as its entry held it at the press (invariant 14), and the presses already checked against the server. */
  const pressedBody = new Map<string, OutcomeBody>();
  const checkedStored = new Set<string>();

  const open = async (tab: Tab): Promise<Instance> => {
    const timers = new Set<() => void>();
    const timerMs = new Map<() => void, number>();
    const instance = { tab, ok: new Set<string>(), refused: new Set<string>(), timers, timerMs, disposed: false, lastFocus: null, lastLogged: null, taskFails: 0, lastAsOf: null } as Omit<Instance, "desk"> as Instance;
    // A reload: a draft whose copy this tab's storage refused is not there any more.
    if (tab.notKept !== null) tab.choices.delete(tab.notKept);
    (instance as { desk: CallDesk }).desk = new CallDesk({
      calls: (focus) => network(instance, "calls", async () => (await h.request<CallsView>("GET", `/api/calls${focus ? `?focus=${focus}` : ""}`)).body),
      task: (id) =>
        network(instance, "task", async () => {
          const out = await h.request<CallTaskView>("GET", `/api/call-tasks/${id}`);
          if (out.status !== 200) throw new Error("no task");
          return out.body;
        }).then(
          (view) => {
            instance.taskFails = 0;
            return view;
          },
          (error: unknown) => {
            instance.taskFails++;
            throw error;
          },
        ),
      post: (taskId, body) =>
        new Promise<CallOutcomeAnswer>((resolve, reject) => {
          // Invariant 14: every request of a press carries exactly what was pressed.
          const pressed = pressedBody.get(body.requestId);
          if (pressed && JSON.stringify(pressed) !== JSON.stringify(body)) problems.push(`14: a request for ${body.requestId} carries ${JSON.stringify(body)}, not the press ${JSON.stringify(pressed)}`);
          // Attribute a resend under another id (a fault) to the press pending in this tab.
          if (!pressing && !pressOf.has(body.requestId)) {
            const press = [...presses].reverse().find((p) => p.tab === tab.label);
            if (press) {
              press.ids.add(body.requestId);
              pressOf.set(body.requestId, press);
            }
          }
          requests.push({ from: instance, taskId, body, answer: null, resolve, reject });
        }),
      // Another tab's write reaches this page as a storage event, which the page answers with a refresh (useCallDesk.ts).
      local: watched(local, () => instance, problems, tab.label, (key) => storageEvent(instance, key)),
      session: watched(tab.session, () => instance, problems, tab.label),
      newId: () => `${tab.label}-${++ids}`,
      now: () => ++pressClock,
      setTimer: (fire, ms) => {
        timers.add(fire);
        timerMs.set(fire, ms);
        return () => timers.delete(fire);
      },
      faults,
    });
    tab.instance = instance;
    // As the page does: opening does not wait for its reads, which the network may hold.
    void instance.desk.start();
    await flush();
    instance.lastFocus = instance.desk.getSnapshot().focus;
    return instance;
  };
  const newTab = async (label: string): Promise<Tab> => {
    const tab = { label, session: new MapStore(), choices: new Map(), notKept: null } as Omit<Tab, "instance"> as Tab;
    await open(tab);
    return tab;
  };
  const leave = (tab: Tab, dropRequests: boolean) => {
    tab.instance.desk.dispose();
    tab.instance.disposed = true;
    tab.instance.timers.clear();
    // Its reads still on the way are answered to a page that is gone.
    for (const g of [...gets]) if (g.from === tab.instance) {
      gets.splice(gets.indexOf(g), 1);
      g.release();
    }
    // A page killed mid-request may lose requests that never left; one that left is still answered.
    if (dropRequests) for (const req of [...requests]) if (req.from === tab.instance && req.answer === null && r() < 0.5) requests.splice(requests.indexOf(req), 1);
  };

  const deliver = async (req: Request) => {
    const out = await h.request<unknown>("POST", `/api/call-tasks/${req.taskId}/outcome`, req.body);
    req.answer = { status: out.status, json: out.body };
  };
  const answer = (req: Request, lost: boolean) => {
    requests.splice(requests.indexOf(req), 1);
    if (lost || !req.answer) return req.reject(new NoAnswer());
    if (req.answer.status === 200) {
      req.from.ok.add(req.body.requestId);
      okIds.add(req.body.requestId);
      return req.resolve(req.answer.json as CallOutcomeAnswer);
    }
    if (req.answer.status >= 500) return req.reject(new NoAnswer());
    req.from.refused.add(req.body.requestId);
    refusedIds.add(req.body.requestId);
    req.reject(new Refused(req.answer.status, (req.answer.json as ApiError).error.message, "outcome_refused", (req.answer.json as CallOutcomeRefusal).offList ?? null));
  };

  /** Refused records the user dismissed (invariant 10). */
  const dismissed = new Set<string>();
  /** A refused press is kept as its outbox entry, rewritten as refused, with its note. */
  const shownRefusal = (id: string) => (local.get(`outreach.calls.outbox.${id}`) ?? "").includes('"refused"');
  /** A refused press, by any of its ids, once seen. */
  const seenRefused = new Set<Press>();
  const check = async (moved: Set<Instance>) => {
    // Invariant 14: the server's record of a press is what was pressed: its outcome, redial and callback time.
    for (const [id, body] of pressedBody) {
      if (checkedStored.has(id)) continue;
      const taskId = await h.store.engine.callRequestTask(id);
      if (taskId === null) continue;
      checkedStored.add(id);
      const record = (await h.request<CallTaskView>("GET", `/api/call-tasks/${taskId}`)).body.storedCalls.find((c) => c.requestId === id);
      const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null);
      if (!record || record.outcome !== body.outcome || record.redial !== (body.redial === true) || at(record.callbackAt) !== at(body.callbackAt)) problems.push(`14: ${id} is stored as ${JSON.stringify(record)}, not as pressed ${JSON.stringify(body)}`);
      if (body.redial) seen.redials++;
      if (body.callbackAt) seen.callbacks++;
    }
    // Storage is the only truth: an entry removed in any tab never reappears.
    for (const k of local.reappeared.splice(0)) problems.push(`3: ${k} was removed and came back`);
    // Invariant 3: a refused press keeps its record until the user presses its own Dismiss; nothing else removes it.
    for (const p of presses) {
      const refusedId = [...p.ids].find((id) => refusedIds.has(id));
      if (refusedId === undefined || dismissed.has(refusedId)) continue;
      if (shownRefusal(refusedId)) seenRefused.add(p);
      // A refusal storage would not record is shown by the desk that got it; if that desk is gone, the entry is still unanswered.
      else if (local.get(`outreach.calls.outbox.${refusedId}`) === null) problems.push(`3: press ${refusedId} was refused and is shown nowhere`);
    }
    for (const p of presses) {
      let n = 0;
      for (const id of p.ids) if (await stored(id)) n++;
      if (n > 1) problems.push(`1: press ${[...p.ids].join("/")} is logged ${n} times`);
    }
    for (const tab of tabs) {
      const i = tab.instance;
      if (i.disposed) continue;
      const snap = i.desk.getSnapshot();
      // Invariant 2: logged only once the server's read holds that request id, whoever got the answer.
      if (snap.logged && !(await stored(snap.logged.requestId))) problems.push(`2: ${tab.label} shows ${snap.logged.requestId} logged, which the server does not hold`);
      // Invariant 13: never back to an older read; failed reads of the call are counted.
      if (snap.queue.state === "ready") {
        if (i.lastAsOf !== null && snap.queue.view.asOf < i.lastAsOf) problems.push(`13: ${tab.label}'s queue went back from ${i.lastAsOf} to ${snap.queue.view.asOf}`);
        i.lastAsOf = snap.queue.view.asOf;
      }
      // With no call on screen nothing of it is read, and its count starts again.
      if (snap.focus === null) i.taskFails = 0;
      if (i.taskFails >= 2 && snap.focus !== null && !snap.freshness.stale) problems.push(`13: ${tab.label}'s call failed ${i.taskFails} reads in a row, and the page is not marked out of date`);
      if (snap.draftNotKept) seen.sessionRefused++;
      if (snap.confirming) seen.confirming++;
      tab.notKept = snap.draftNotKept ? snap.focus : null;
      // Invariant 7: pending is an unanswered outbox entry for the call on screen.
      if (snap.pending && !(local.get(`outreach.calls.outbox.${snap.pending.body.requestId}`) ?? "").startsWith("{") ) problems.push(`7: ${tab.label} shows ${snap.pending.body.requestId} pending, but it is not in the outbox`);
      if (snap.pending && shownRefusal(snap.pending.body.requestId)) problems.push(`7: ${tab.label} shows ${snap.pending.body.requestId} pending, but it was refused`);
      // One path for every refusal (ADR 0003 4.4.1): each refused entry in storage is shown by every desk on screen,
      // with its note, whichever call that desk is on (the same one, another, or none).
      for (const key of local.keys()) {
        if (!key.startsWith("outreach.calls.outbox.")) continue;
        const raw = local.get(key) ?? "";
        if (!raw.includes('"refused"')) continue;
        const entry = JSON.parse(raw) as { taskId: string; body: { requestId: string; note: string } };
        const shownHere = snap.refusedRecords.find((x) => x.body.requestId === entry.body.requestId);
        if (!shownHere) problems.push(`3: ${tab.label} does not show the kept refusal ${entry.body.requestId}`);
        else if (shownHere.body.note !== entry.body.note) problems.push(`3: ${tab.label} shows the kept refusal ${entry.body.requestId} without its note`);
        if (!refusedIds.has(entry.body.requestId)) problems.push(`2: ${entry.body.requestId} is kept as refused without a refusal`);
        const where = snap.focus === null ? "none" : snap.focus === entry.taskId ? "same" : "other";
        seen.refusalFocus.add(where);
      }
      // A logged outcome, whichever desk had its answer, consumes its call's draft.
      if (snap.logged !== null && snap.logged.requestId !== i.lastLogged) tab.choices.delete(snap.logged.task.taskId);
      // Invariant 6: the draft of the call on screen is what the user chose, or, before any choice, its first making.
      if (snap.focus !== null && snap.task?.state === "ready" && snap.task.view.taskId === snap.focus) {
        const chosen = tab.choices.get(snap.focus);
        const now: Choice = { numberId: snap.draft.numberId, outcome: snap.draft.outcome, note: snap.draft.note, redial: snap.draft.redial, callbackDay: snap.draft.callbackDay, callbackTime: snap.draft.callbackTime };
        if (!chosen) tab.choices.set(snap.focus, now);
        else if (!sameChoice(chosen, now)) problems.push(`6: ${tab.label}'s draft for ${snap.focus} became ${JSON.stringify(now)}, not the user's ${JSON.stringify(chosen)}`);
      }
      if (snap.focus !== i.lastFocus && i.lastFocus !== null) tab.choices.delete(i.lastFocus);
      const newlyLogged = snap.logged !== null && snap.logged.requestId !== i.lastLogged;
      // A press shown as logged from the server's read, though this desk never received its answer.
      if (snap.logged !== null && newlyLogged && !i.ok.has(snap.logged.requestId)) seen.loggedFromRead++;
      i.lastLogged = snap.logged?.requestId ?? null;
      if (snap.focus !== i.lastFocus && i.lastFocus !== null && !moved.has(i) && !newlyLogged) problems.push(`4: ${tab.label}'s focus moved from ${i.lastFocus} to ${snap.focus} without an outcome or moving on`);
      i.lastFocus = snap.focus;
      if (snap.refusedRecords.some((x) => x.taskId === snap.focus)) seen.refusedShown++;
      if (snap.away) seen.foundGone++;
      if (snap.pending?.unconfirmed) seen.unconfirmed++;
      if (snap.recovering.length > 0) seen.recovered++;
      if (snap.refusedRecords.length > 0) seen.records++;
      if (snap.pending !== null && !snap.locked) problems.push(`5: ${tab.label} has an action pending and is not locked`);
      if (snap.away !== null && !snap.locked) problems.push(`5: ${tab.label}'s focus left the list and it is not locked`);
    }
  };

  const seen = { redialPresses: 0, redials: 0, callbacks: 0, pastCallbacks: 0, expiredPress: 0, loggedFromRead: 0, heldGets: 0, failedReads: 0, sessionRefused: 0, confirming: 0, refusedShown: 0, foundGone: 0, unconfirmed: 0, blocked: 0, recovered: 0, dismissed: 0, records: 0, leftWithPending: 0, notQueued: 0, refusalFocus: new Set<string>() };
  let storageFullUntil = -1;
  const tabs: Tab[] = [];
  tabs.push(await newTab("a"), await newTab("b"));
  let notes = 0;
  for (let s = 0; s < STEPS; s++) {
    const roll = r();
    // Once, in the evening, nothing is ready and the user opens Calls in a fresh tab: its desk is on no call.
    if (s === 60 && r() < 0.7) {
      const evening = Date.parse("2026-11-02T17:10:00Z");
      if (h.clock < evening) await h.advanceTo(evening);
      if (tabs.length < 4) tabs.push(await newTab("evening"));
    }
    // Now and then the device's storage is full for a few steps: every write is refused.
    if (!local.full && r() < 0.03) storageFullUntil = s + 1 + Math.floor(r() * 4);
    local.full = s < storageFullUntil;
    const tab = tabs[Math.floor(r() * tabs.length)] ?? tabs[0]!;
    // Now and then a held read is answered, in any order, or fails; and a tab's own storage refuses writes for a while.
    if (gets.length > 0 && r() < 0.35) {
      const g = gets.splice(Math.floor(r() * gets.length), 1)[0]!;
      if (r() < 0.25) g.fail();
      else g.release();
    }
    if (r() < 0.04) tab.session.full = !tab.session.full;
    const desk = tab.instance.desk;
    const snap = desk.getSnapshot();
    /** Desks whose focus may move in this step: answered 200, or moving on. */
    const moved = new Set<Instance>();
    if (roll < 0.24) {
      if (!tab.instance.disposed && snap.task?.state === "ready" && !snap.locked) {
        const numbers = snap.task.view.numbers;
        let outcome = OUTCOMES[Math.floor(r() * OUTCOMES.length)] ?? "no_answer";
        const note = r() < 0.6 ? `note ${++notes}` : "";
        // Ticket 15b: a callback asked for (later today, on a later day, or now and then at a time already
        // passed, which the page refuses in place), or a redial with an outcome that offers one.
        let redial = snap.draft.redial;
        let callbackDay = snap.draft.callbackDay;
        let callbackTime = snap.draft.callbackTime;
        if (r15() < 0.3) {
          outcome = "callback_requested";
          const asOf = Date.parse(snap.task.view.asOf);
          const roll15 = r15();
          const when = roll15 < 0.25 ? asOf - 30 * MIN : roll15 < 0.5 ? asOf + (20 + Math.floor(r15() * 100)) * MIN : asOf + (1 + Math.floor(r15() * 3)) * 24 * 60 * MIN;
          callbackDay = londonDay(when);
          callbackTime = londonTime(when);
        } else if (REDIAL_OUTCOMES.includes(outcome)) redial = r15() < 0.75;
        // Often the shared main line, which another lead's call can mark bad under this draft.
        const roll2 = r();
        const numberId = roll2 < 0.3 ? (numbers.find((n) => n.kind === "main_line")?.detailId ?? snap.draft.numberId) : roll2 < 0.45 ? (numbers[Math.floor(r() * numbers.length)]?.detailId ?? null) : snap.draft.numberId;
        desk.setDraft({ outcome, note, numberId, noteScope: r() < 0.3 ? "company" : "person", redial, callbackDay, callbackTime });
        if (snap.focus !== null) tab.choices.set(snap.focus, { numberId, outcome, note, redial, callbackDay, callbackTime });
        // Now and then the user only edits the draft, and presses nothing.
        if (r() < 0.2) {
          await flush();
          await check(moved);
          continue;
        }
        const blocked = (outcome !== "skip_for_now" && desk.getSnapshot().numberProblem !== null) || (outcome === "callback_requested" && desk.getSnapshot().callback?.at === null && !faults.has("past_callback_sent"));
        if (outcome === "callback_requested" && desk.getSnapshot().callback?.problem === "past") seen.pastCallbacks++;
        const pressedOn = snap.task.view.asOf;
        const sentBefore = requests.length;
        pressing = true;
        desk.log();
        pressing = false;
        // The boundary: a press storage refused is not pressed. Nothing is sent, the page says so, and the draft stays.
        // The boundary (ticket 15b): a callback time not after the read it was pressed on is refused in place, and nothing is sent.
        const sentNow = requests.slice(sentBefore);
        for (const q of sentNow) if (q.body.callbackAt && Date.parse(q.body.callbackAt) <= Date.parse(pressedOn)) problems.push(`14: ${tab.label} sent a callback for ${q.body.callbackAt}, not after the read it was pressed on (${pressedOn})`);
        if (local.full && !blocked && (outcome === "skip_for_now" || numberId !== null)) {
          if (!desk.getSnapshot().notQueued) problems.push(`3: ${tab.label} accepted a press its storage refused`);
          if (requests.length !== sentBefore) problems.push(`3: ${tab.label} sent a press it could not store`);
          if (desk.getSnapshot().draft.note !== note) problems.push(`6: ${tab.label} lost the draft of a press it could not store`);
          seen.notQueued++;
        }
        // Invariant 7: a number that is no longer good blocks Log; nothing is sent on it or in its place.
        if (blocked && desk.getSnapshot().pending !== null) problems.push(`6: ${tab.label} logged though the chosen number is no longer good`);
        if (blocked) seen.blocked++;
        // A press is what log() made pending: recorded from the desk, not from the outbox, which a fault may skip.
        const id = desk.getSnapshot().pending?.body.requestId;
        if (id !== undefined && !pressOf.has(id)) {
          const press = { tab: tab.label, note, ids: new Set([id]) };
          const entry = local.get(`outreach.calls.outbox.${id}`);
          if (entry) pressedBody.set(id, (JSON.parse(entry) as { body: OutcomeBody }).body);
          if (pressedBody.get(id)?.redial) seen.redialPresses++;
          presses.push(press);
          pressOf.set(id, press);
          if (snap.focus !== null) pressedChoice.set(id, { tab, taskId: snap.focus, choice: tab.choices.get(snap.focus) });
        }
      }
    } else if (roll < 0.38) {
      const waiting = requests.filter((q) => q.answer === null);
      const req = waiting[Math.floor(r() * waiting.length)];
      if (req) await deliver(req);
    } else if (roll < 0.52) {
      const done = requests.filter((q) => q.answer !== null);
      const req = done[Math.floor(r() * done.length)];
      if (req) {
        answer(req, r() < 0.3);
      }
    } else if (roll < 0.6) {
      const fire = [...tab.instance.timers][0];
      if (fire) {
        tab.instance.timers.delete(fire);
        fire();
      }
    } else if (roll < 0.68) {
      void desk.refresh();
    } else if (roll < 0.73) {
      if (snap.away !== null) {
        moved.add(tab.instance);
        // Moving on dismisses nothing: every refusal kept for the call stays until its own Dismiss.
        void desk.moveOn();
      } else if (snap.refusedRecords.length > 0) {
        const first = snap.refusedRecords[0]!;
        if (first.body.note !== (pressOf.get(first.body.requestId)?.note ?? first.body.note)) problems.push(`3: the kept refusal of ${first.body.requestId} lost its note`);
        dismissed.add(first.body.requestId);
        desk.dismiss(first.body.requestId);
        seen.dismissed++;
      }
    } else if (roll < 0.78) {
      leave(tab, true);
      await open(tab);
      moved.add(tab.instance);
    } else if (roll < 0.795) {
      leave(tab, true);
      tabs.splice(tabs.indexOf(tab), 1, await newTab(`${tab.label}'`));
    } else if (roll < 0.805) {
      // The pressing tab leaves Calls; another desk takes its entry over; the tab comes back while that desk holds it.
      leave(tab, false);
      for (const t of tabs) if (t !== tab) void t.instance.desk.refresh();
      await flush();
      await open(tab);
      moved.add(tab.instance);
    } else if (roll < 0.81 && tabs.length < 4) {
      // The browser duplicates a tab: the copy starts with the same sessionStorage, tab id included.
      const copy = { label: `${tab.label}+`, session: new MapStore(), choices: new Map(), notKept: tab.notKept } as Omit<Tab, "instance"> as Tab;
      for (const [k, v] of tab.session.map) copy.session.set(k, v);
      // The copy holds the same drafts: the same choices, not new ones.
      for (const [k, v] of tab.choices) copy.choices.set(k, v);
      await open(copy);
      tabs.push(copy);
    } else if (roll < 0.83) {
      desk.retryNow();
    } else if (roll < 0.88) {
      // Another client, or a colleague's call on a shared main line, marks a number bad while the user composes.
      // Mostly a colleague's call on the shared main line, so the number goes bad under another lead's draft.
      const listed = (await h.request<CallsView>("GET", "/api/calls")).body.readyNow;
      const others = listed.filter((x) => x.taskId !== snap.focus);
      const pool = others.length > 0 && r() < 0.8 ? others : listed;
      const target = pool[Math.floor(r() * pool.length)];
      if (target) {
        const view = (await h.request<CallTaskView>("GET", `/api/call-tasks/${target.taskId}`)).body;
        const good = view.numbers.filter((n) => !n.bad);
        const mainLine = good.find((n) => n.kind === "main_line");
        const number = mainLine && r() < 0.7 ? mainLine : good[Math.floor(r() * good.length)];
        if (number) await h.request("POST", `/api/call-tasks/${target.taskId}/outcome`, { requestId: `elsewhere-${++ids}`, outcome: "wrong_number", numberId: number.detailId });
      }
      // The user comes back to the tabs: each refreshes, as showing a tab again does.
      for (const t of tabs) void t.instance.desk.refresh();
    } else if (roll < 0.89) {
      // The user leaves Calls in a tab (to Today, say) and stays there for now, if another tab is on Calls.
      const onCalls = tabs.filter((t) => !t.instance.disposed);
      if (!tab.instance.disposed && onCalls.length > 1) leave(tab, true);
      else if (tab.instance.disposed) {
        await open(tab);
        moved.add(tab.instance);
      }
    } else if (roll < 0.905) {
      const who = PEOPLE[Math.floor(r() * PEOPLE.length)]?.["email"] ?? "";
      h.fake.prospectReplies(who, true, null);
      await h.advanceTo(h.clock + MIN);
    } else if (roll < 0.94) {
      // Ticket 15b: now and then the next morning, so a callback falls due or is missed, a redial is listed, and a call
      // pressed before the night may arrive after its skip limit has passed.
      if (r15() < 0.2) {
        const pending = requests.some((q) => q.answer === null);
        await h.advanceTo(Date.parse(`${londonDay(h.clock + 24 * 60 * MIN)}T09:20:00Z`));
        if (pending) seen.expiredPress++;
      } else await h.advanceTo(h.clock + 20 * MIN);
    }
    await flush();
    // A request the desk answered may have moved its focus synchronously; the step's own desk too.
    await check(moved);
  }

  // Before settling, often: the user leaves Calls in a tab whose outcome is on its way, while another tab stays on
  // Calls (council on b15a769, item 9). That tab must take the outcome over when the lock is released.
  const holder = tabs.find((t) => !t.instance.disposed && t.instance.desk.getSnapshot().pending !== null);
  if (holder && r() < 0.7 && tabs.some((t) => t !== holder && !t.instance.disposed)) {
    leave(holder, true);
    seen.leftWithPending++;
  }
  await flush();

  local.full = false;
  settling = true;
  for (const t of tabs) t.session.full = false;
  for (const g of gets.splice(0)) g.release();
  // The network settles without reopening any tab: timers fire, the browser comes back online, the
  // tabs refresh (sending entries left by closed tabs), and every request arrives and is answered.
  for (let guard = 0; guard < 60; guard++) {
    // A page left alone gets storage events from other tabs, its own timers (retries within a minute), and coming back online once.
    if (guard === 0) for (const tab of tabs) if (!tab.instance.disposed) tab.instance.desk.retryNow();
    // Timers due within a minute (retries, backoff): a refresh hours away would hide an outcome left waiting.
    for (const tab of tabs) for (const fire of [...tab.instance.timers]) {
      if ((tab.instance.timerMs.get(fire) ?? 0) > 60_000) continue;
      tab.instance.timers.delete(fire);
      fire();
    }
    await flush();
    for (const req of [...requests]) {
      if (req.answer === null) await deliver(req);
      answer(req, false);
      await flush();
      await check(new Set());
    }
    const quiet = requests.length === 0 && local.keys().every((k) => !k.startsWith("outreach.calls.outbox.") || (local.get(k) ?? "").includes('"refused"')) && tabs.every((t) => t.instance.disposed || t.instance.desk.getSnapshot().pending === null);
    if (quiet) break;
  }
  await flush();

  // The interval's next read, as a page left open gets it within 20 seconds.
  for (const t of tabs) if (!t.instance.disposed) void t.instance.desk.refresh();
  await flush();
  for (const t of tabs) {
    if (t.instance.disposed) continue;
    const snap = t.instance.desk.getSnapshot();
    const view = snap.focus === null ? null : (await h.request<CallTaskView>("GET", `/api/call-tasks/${snap.focus}`)).body;
    // Invariant 7: a call the server has off the list is never shown workable.
    if (view?.offList && !snap.locked) problems.push(`7: ${t.label} shows ${snap.focus ?? ""} workable, which the server has off the list`);
    // Invariant 12: no tab shows as a draft a press the server has stored.
    if (snap.draft.pressId !== null && (await stored(snap.draft.pressId))) problems.push(`12: ${t.label} shows the stored press ${snap.draft.pressId} as an unsent draft`);
    for (const [id, p] of pressedChoice) {
      // Off the list counts too: the page would then say another window logged this tab's own press.
      if (p.tab !== t || p.taskId !== snap.focus || p.choice === undefined || t.choices.get(p.taskId) !== p.choice || snap.pending !== null) continue;
      if (await stored(id)) problems.push(`12: ${t.label} still shows the draft of its stored press ${id}${snap.away ? ", as logged elsewhere" : ""}`);
    }
    if (snap.confirming) problems.push(`9: ${t.label} is still confirming after the network settled`);
    // Invariant 11: the page's sentences agree with the server's read.
    if (snap.logged) {
      const line = loggedLine(snap.logged, "Europe/London");
      const now = (await h.request<CallTaskView>("GET", `/api/call-tasks/${snap.logged.task.taskId}`)).body;
      const note = snap.logged.body.note.trim();
      if (line.includes("The note is saved") && ![...now.personNotes, ...now.companyNotes].some((n) => n.body === note)) problems.push(`11: ${t.label} says the note of ${snap.logged.requestId} is saved; the server does not hold it`);
    }
    if (snap.away?.offList.reason === "logged" && view?.offList?.reason !== "logged") problems.push(`11: ${t.label} says ${snap.focus ?? ""} is already logged; the server says ${view?.offList?.reason ?? "it is listed"}`);
    for (const rec of snap.refusedRecords) if (await stored(rec.body.requestId)) problems.push(`11: ${t.label} says ${rec.body.requestId} was not logged; the server holds it`);
  }
  // Invariant 9: with the network settled, no desk on screen shows an action pending.
  for (const t of tabs) if (!t.instance.disposed && t.instance.desk.getSnapshot().pending !== null) problems.push(`9: ${t.label} still shows ${t.instance.desk.getSnapshot().pending?.body.requestId} pending after the network settled`);
  // Invariant 3 and 1's other half: nothing left, and every press logged once or refused.
  const left = local.keys().filter((k) => k.startsWith("outreach.calls.outbox.") && !(local.get(k) ?? "").includes('"refused"'));
  if (left.length > 0) problems.push(`9: the outbox still holds unanswered ${left.join(", ")}`);
  let logged = 0;
  for (const p of presses) {
    let n = 0;
    for (const id of p.ids) if (await stored(id)) n++;
    const refused = [...p.ids].some((id) => refusedIds.has(id));
    if (n === 1) logged++;
    if (n === 0 && !refused) problems.push(`3: press ${[...p.ids].join("/")} was neither logged nor refused`);
  }
  return { problems, presses: presses.length, logged, seen };
}

describe("working the call list in the browser, generated over the real call desk (ADR 0003 4.4.1)", () => {
  const counts: { presses: number; logged: number; seen: { redialPresses: number; redials: number; callbacks: number; pastCallbacks: number; expiredPress: number; loggedFromRead: number; heldGets: number; failedReads: number; sessionRefused: number; confirming: number; refusedShown: number; foundGone: number; unconfirmed: number; blocked: number; recovered: number; dismissed: number; records: number; leftWithPending: number; notQueued: number; refusalFocus: Set<string> } }[] = [];
  for (const seed of Array.from({ length: SEEDS }, (_, i) => 9100 + i)) {
    test(`run ${seed}`, async () => {
      const out = await run(seed);
      counts.push(out);
      expect(out.problems).toEqual([]);
    });
  }
  test.skipIf(!process.env["CALL_DESK_COVERAGE"])("coverage (by hand)", () => console.info("COVERAGE", JSON.stringify(counts.map((c) => c.seen))));
  test("the runs log outcomes, and reach a refusal shown, a focus found gone and an unconfirmed action", () => {
    expect(counts.reduce((n, c) => n + c.logged, 0)).toBeGreaterThan(SEEDS);
    expect(counts.filter((c) => c.seen.refusedShown > 0).length).toBeGreaterThan(0);
    expect(counts.filter((c) => c.seen.foundGone > 0).length).toBeGreaterThan(0);
    expect(counts.filter((c) => c.seen.unconfirmed > 0).length).toBeGreaterThan(0);
    expect(counts.filter((c) => c.seen.blocked > 0).length).toBeGreaterThan(0);
    expect(counts.filter((c) => c.seen.recovered > 0).length).toBeGreaterThan(0);
    expect(counts.filter((c) => c.seen.records > 0).length).toBeGreaterThan(0);
    expect(counts.filter((c) => c.seen.notQueued > 0).length).toBeGreaterThan(0);
    // A press shown as logged from the server's read; held, reordered and failed reads; a tab's storage refusing its draft.
    for (const k of ["loggedFromRead", "heldGets", "failedReads", "sessionRefused", "confirming"] as const) expect(counts.filter((c) => c.seen[k] > 0).length, k).toBeGreaterThan(0);
    // A refusal is recovered by a desk on that same call, on another call, and on none.
    for (const where of ["same", "other", "none"]) expect(counts.some((c) => c.seen.refusalFocus.has(where)), where).toBe(true);
    // Ticket 15b: redials and callbacks stored, a callback refused in place for its past time, and presses on their way across a night.
    for (const k of ["redials", "callbacks", "pastCallbacks", "expiredPress"] as const) expect(counts.filter((c) => c.seen[k] > 0).length, k).toBeGreaterThan(0);
  });
});

describe("each desk fault is caught by its known seed (ADR 0003 4.4.1)", () => {
  const KILLING: readonly [DeskFault, number, string][] = [
    ["new_id_on_resend", 9134, "7:"],
    ["logged_when_sent", 9100, "2:"],
    ["outbox_removed_when_sent", 9100, "7:"],
    ["refresh_adopts_focus", 9100, "4:"],
    ["no_lock_while_pending", 9100, "5:"],
    ["substitute_bad_number", 9100, "6:"],
    ["pending_kept_after_answer", 9100, "7:"],
    ["disposed_desk_applies", 9100, "8:"],
    ["only_focused_entries_retried", 9134, "9:"],
    ["refusal_dropped", 9100, "3:"],
    ["focused_refusal_hidden", 9101, "3:"],
    ["stale_copy_written_back", 9115, "3:"],
    ["refusal_removed_on_move_on", 9101, "3:"],
    ["stored_press_left_as_draft", 9100, "12:"],
    ["answer_clears_draft", 9100, "6:"],
    ["first_read_skips_reconcile", 9123, "3:"],
    ["task_failures_uncounted", 9108, "13:"],
    ["reads_overlap", 9100, "13:"],
    // Ticket 15b.
    ["redial_lost_on_resend", 9180, "14:"],
    ["answer_resets_callback_draft", 9105, "6:"],
    ["past_callback_sent", 9101, "14:"],
  ];
  for (const [fault, seed, invariant] of KILLING) {
    test(`${fault}, seed ${seed}, invariant ${invariant}`, async () => {
      const out = await run(seed, new Set([fault]));
      expect(out.problems.some((p) => p.startsWith(invariant))).toBe(true);
    });
  }
});

/** By hand: CALL_DESK_FAULT_SEARCH=1 prints the first seeds that catch each fault, to fill KILLING above. */
describe.skipIf(!process.env["CALL_DESK_FAULT_SEARCH"])("fault search (by hand)", () => {
  // refusal_resent_at_once needs storage full while answers keep coming; callDesk.test.ts kills it by a count of requests.
  const all: DeskFault[] = ["new_id_on_resend", "logged_when_sent", "outbox_removed_when_sent", "refresh_adopts_focus", "no_lock_while_pending", "substitute_bad_number", "pending_kept_after_answer", "disposed_desk_applies", "only_focused_entries_retried", "refusal_dropped", "focused_refusal_hidden", "stale_copy_written_back", "refusal_removed_on_move_on", "stored_press_left_as_draft", "answer_clears_draft", "first_read_skips_reconcile", "task_failures_uncounted", "reads_overlap", "redial_lost_on_resend", "answer_resets_callback_draft", "past_callback_sent"];
  for (const fault of all) {
    test(fault, async () => {
      const found: string[] = [];
      for (let seed = 9100; seed < Number(process.env["CALL_DESK_FAULT_SEARCH_TO"] ?? 9180) && found.length < 2; seed++) {
        const out = await run(seed, new Set([fault]));
        if (out.problems.length > 0) found.push(`${seed}: ${out.problems[0]}`);
      }
      console.info("FAULT", fault, JSON.stringify(found));
    }, 300_000);
  }
});
