import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { ApiError, CallOutcomeAnswer, CallOutcomeApi, CallsView, CallTaskView, LeadSearchResult } from "../../shared/api.ts";
import { CallDesk, NoAnswer, Refused, type DeskFault, type KeyValue, type OutcomeBody } from "./callDesk.ts";

/**
 * Working the call list in the browser (ADR 0003 4.4.1), generated: real call desks (the object the
 * Calls page binds) in two to four tabs that reload, leave Calls, close or are duplicated, sharing one
 * localStorage (storage events reach the other tabs, as in a browser), each tab with its own
 * sessionStorage, against the real HTTP app and engine. The campaign has a phone track beside an email
 * track and an email after the call, several leads at two companies, and a daily capacity. Each run
 * mixes presses of every outcome (sometimes on a number already marked bad), requests delivered late
 * and out of order, answers lost, retries, refreshes, moving on, dismissing kept refusals, numbers
 * marked bad from outside the desks, leads replying by email, and the clock moving. It then settles
 * with no user action: storage events, coming back online once, and timers due within a minute.
 *
 * Invariants (ADR 0003 4.4.1), from an independent record of every press:
 * 1. Nothing stored twice. 2. Never more than the server said. 3. Nothing lost: every press is stored
 * or kept as a refusal with its note until acknowledged. 4. The focus holds. 5. One lock.
 * 6. The user's choice stands. 7. Status is derived: pending exactly while an unanswered entry is in
 * the outbox. 8. A desk off screen writes only the outbox. 9. Liveness: after settling nothing is
 * unanswered and no desk shows an action pending.
 *
 * Each desk fault (callDesk.ts `DeskFault`) breaks one of them; the last block checks a known seed
 * catches each.
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
      store.set(k, v);
      changed?.(k);
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
  get = (k: string) => this.map.get(k) ?? null;
  set = (k: string, v: string) => void this.map.set(k, v);
  remove = (k: string) => void this.map.delete(k);
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
}

interface Tab {
  readonly label: string;
  readonly session: MapStore;
  instance: Instance;
  /** What the user chose on each call's draft in this tab (invariant 7): number, outcome and note. */
  readonly choices: Map<string, { numberId: string | null; outcome: string | null; note: string }>;
}

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
  /** The browser's Web Locks, shared by the tabs: name to holder. */
  /** True while log() runs: its first post is a new press, recorded right after. */
  let pressing = false;
  const stored = async (id: string) => (await h.store.engine.callRequestTask(id)) !== null;

  const open = async (tab: Tab): Promise<Instance> => {
    const timers = new Set<() => void>();
    const timerMs = new Map<() => void, number>();
    const instance = { tab, ok: new Set<string>(), refused: new Set<string>(), timers, timerMs, disposed: false, lastFocus: null, lastLogged: null } as Omit<Instance, "desk"> as Instance;
    (instance as { desk: CallDesk }).desk = new CallDesk({
      calls: async (focus) => (await h.request<CallsView>("GET", `/api/calls${focus ? `?focus=${focus}` : ""}`)).body,
      task: async (id) => {
        const out = await h.request<CallTaskView>("GET", `/api/call-tasks/${id}`);
        if (out.status !== 200) throw new Error("no task");
        return out.body;
      },
      post: (taskId, body) =>
        new Promise<CallOutcomeAnswer>((resolve, reject) => {
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
      setTimer: (fire, ms) => {
        timers.add(fire);
        timerMs.set(fire, ms);
        return () => timers.delete(fire);
      },
      faults,
    });
    tab.instance = instance;
    await instance.desk.start();
    await flush();
    instance.lastFocus = instance.desk.getSnapshot().focus;
    return instance;
  };
  const newTab = async (label: string): Promise<Tab> => {
    const tab = { label, session: new MapStore(), choices: new Map() } as Omit<Tab, "instance"> as Tab;
    await open(tab);
    return tab;
  };
  const leave = (tab: Tab, dropRequests: boolean) => {
    tab.instance.desk.dispose();
    tab.instance.disposed = true;
    tab.instance.timers.clear();
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
      // A logged action consumes its draft: the call's next draft is made afresh.
      if (!req.from.disposed) req.from.tab.choices.delete(req.taskId);
      return req.resolve(req.answer.json as CallOutcomeAnswer);
    }
    if (req.answer.status >= 500) return req.reject(new NoAnswer());
    req.from.refused.add(req.body.requestId);
    refusedIds.add(req.body.requestId);
    req.reject(new Refused(req.answer.status, (req.answer.json as ApiError).error.message));
  };

  /** Refused records the user dismissed (invariant 10). */
  const dismissed = new Set<string>();
  /** A refused press is kept as its outbox entry, rewritten as refused, with its note. */
  const shownRefusal = (id: string) => (local.get(`outreach.calls.outbox.${id}`) ?? "").includes('"refused"');
  /** A refused press, by any of its ids, once seen. */
  const seenRefused = new Set<Press>();
  const check = async (moved: Set<Instance>) => {
    // Invariant 10: a refused press keeps its record until the user acknowledges it.
    for (const p of presses) {
      const refusedId = [...p.ids].find((id) => refusedIds.has(id));
      if (refusedId === undefined || dismissed.has(refusedId)) continue;
      if (shownRefusal(refusedId)) seenRefused.add(p);
      else if (!movedOnFrom.has(refusedId)) problems.push(`3: press ${refusedId} was refused and is shown nowhere`);
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
      // An answer another desk had is applied from its record: logged once some desk had a 200 for it, refused once some desk had a refusal.
      if (snap.logged && !okIds.has(snap.logged.requestId)) problems.push(`2: ${tab.label} shows ${snap.logged.requestId} logged before an accepted answer`);
      // Invariant 7: pending is an unanswered outbox entry for the call on screen.
      if (snap.pending && !(local.get(`outreach.calls.outbox.${snap.pending.body.requestId}`) ?? "").startsWith("{") ) problems.push(`7: ${tab.label} shows ${snap.pending.body.requestId} pending, but it is not in the outbox`);
      if (snap.pending && shownRefusal(snap.pending.body.requestId)) problems.push(`7: ${tab.label} shows ${snap.pending.body.requestId} pending, but it was refused`);
      for (const shown of [snap.away?.requestId ?? null, snap.refusal?.requestId ?? null]) {
        if (shown === null) continue;
        if (!refusedIds.has(shown)) problems.push(`2: ${tab.label} shows ${shown} refused without a refusal`);
        const press = pressOf.get(shown);
        for (const id of press?.ids ?? []) if (await stored(id)) problems.push(`2: ${tab.label} shows a press refused though the server logged it as ${id}`);
        if (snap.away?.requestId === shown && press && snap.away.note !== press.note) problems.push(`3: ${tab.label} lost the note of its refused press`);
      }
      // A logged outcome, whichever desk had its answer, consumes its call's draft.
      if (snap.logged !== null && snap.logged.requestId !== i.lastLogged) tab.choices.delete(snap.logged.task.taskId);
      // Invariant 7: the draft of the call on screen is what the user chose, or, before any choice, its first making.
      if (snap.focus !== null && snap.task?.state === "ready" && snap.task.view.taskId === snap.focus) {
        const chosen = tab.choices.get(snap.focus);
        const now = { numberId: snap.draft.numberId, outcome: snap.draft.outcome, note: snap.draft.note };
        if (!chosen) tab.choices.set(snap.focus, now);
        else if (chosen.numberId !== now.numberId || chosen.outcome !== now.outcome || chosen.note !== now.note) problems.push(`6: ${tab.label}'s draft for ${snap.focus} became ${JSON.stringify(now)}, not the user's ${JSON.stringify(chosen)}`);
      }
      if (snap.focus !== i.lastFocus && i.lastFocus !== null) tab.choices.delete(i.lastFocus);
      const newlyLogged = snap.logged !== null && snap.logged.requestId !== i.lastLogged;
      i.lastLogged = snap.logged?.requestId ?? null;
      if (snap.focus !== i.lastFocus && i.lastFocus !== null && !moved.has(i) && !newlyLogged) problems.push(`4: ${tab.label}'s focus moved from ${i.lastFocus} to ${snap.focus} without an outcome or moving on`);
      i.lastFocus = snap.focus;
      if (snap.away?.requestId) seen.refusedShown++;
      if (snap.away && snap.away.requestId === null) seen.foundGone++;
      if (snap.pending?.unconfirmed) seen.unconfirmed++;
      if (snap.recovering.length > 0) seen.recovered++;
      if (snap.refusedRecords.length > 0) seen.records++;
      if (snap.pending !== null && !snap.locked) problems.push(`5: ${tab.label} has an action pending and is not locked`);
      if (snap.away !== null && !snap.locked) problems.push(`5: ${tab.label}'s focus left the list and it is not locked`);
    }
  };

  /** Refusals a desk showed on the call and the user moved on from (acknowledged). */
  const movedOnFrom = new Set<string>();
  const seen = { refusedShown: 0, foundGone: 0, unconfirmed: 0, blocked: 0, recovered: 0, dismissed: 0, records: 0, leftWithPending: 0 };
  const tabs: Tab[] = [];
  tabs.push(await newTab("a"), await newTab("b"));
  let notes = 0;
  for (let s = 0; s < STEPS; s++) {
    const roll = r();
    const tab = tabs[Math.floor(r() * tabs.length)] ?? tabs[0]!;
    const desk = tab.instance.desk;
    const snap = desk.getSnapshot();
    /** Desks whose focus may move in this step: answered 200, or moving on. */
    const moved = new Set<Instance>();
    if (roll < 0.24) {
      if (!tab.instance.disposed && snap.task?.state === "ready" && !snap.locked) {
        const numbers = snap.task.view.numbers;
        const outcome = OUTCOMES[Math.floor(r() * OUTCOMES.length)] ?? "no_answer";
        const note = r() < 0.6 ? `note ${++notes}` : "";
        // Often the shared main line, which another lead's call can mark bad under this draft.
        const roll2 = r();
        const numberId = roll2 < 0.3 ? (numbers.find((n) => n.kind === "main_line")?.detailId ?? snap.draft.numberId) : roll2 < 0.45 ? (numbers[Math.floor(r() * numbers.length)]?.detailId ?? null) : snap.draft.numberId;
        // Editing the draft a refusal was shown on acknowledges that refusal.
        if (snap.refusal) movedOnFrom.add(snap.refusal.requestId);
        desk.setDraft({ outcome, note, numberId, noteScope: r() < 0.3 ? "company" : "person" });
        if (snap.focus !== null) tab.choices.set(snap.focus, { numberId, outcome, note });
        const blocked = outcome !== "skip_for_now" && desk.getSnapshot().numberProblem !== null;
        pressing = true;
        desk.log();
        pressing = false;
        // Invariant 7: a number that is no longer good blocks Log; nothing is sent on it or in its place.
        if (blocked && desk.getSnapshot().pending !== null) problems.push(`6: ${tab.label} logged though the chosen number is no longer good`);
        if (blocked) seen.blocked++;
        // A press is what log() made pending: recorded from the desk, not from the outbox, which a fault may skip.
        const id = desk.getSnapshot().pending?.body.requestId;
        if (id !== undefined && !pressOf.has(id)) {
          const press = { tab: tab.label, note, ids: new Set([id]) };
          presses.push(press);
          pressOf.set(id, press);
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
        if (req.answer?.status === 200) moved.add(req.from);
        answer(req, r() < 0.3);
      }
    } else if (roll < 0.6) {
      const fire = [...tab.instance.timers][0];
      if (fire) {
        tab.instance.timers.delete(fire);
        fire();
      }
    } else if (roll < 0.68) {
      await desk.refresh();
    } else if (roll < 0.73) {
      if (snap.away !== null) {
        moved.add(tab.instance);
        if (snap.away.requestId) movedOnFrom.add(snap.away.requestId);
        await desk.moveOn();
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
      for (const t of tabs) if (t !== tab) await t.instance.desk.refresh();
      await open(tab);
      moved.add(tab.instance);
    } else if (roll < 0.81 && tabs.length < 4) {
      // The browser duplicates a tab: the copy starts with the same sessionStorage, tab id included.
      const copy = { label: `${tab.label}+`, session: new MapStore(), choices: new Map() } as Omit<Tab, "instance"> as Tab;
      for (const [k, v] of tab.session.map) copy.session.set(k, v);
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
      for (const t of tabs) await t.instance.desk.refresh();
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
      await h.advanceTo(h.clock + 20 * MIN);
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
      const moved = new Set<Instance>(req.answer?.status === 200 ? [req.from] : []);
      answer(req, false);
      await flush();
      await check(moved);
    }
    const quiet = requests.length === 0 && local.keys().every((k) => !k.startsWith("outreach.calls.outbox.") || (local.get(k) ?? "").includes('"refused"')) && tabs.every((t) => t.instance.disposed || t.instance.desk.getSnapshot().pending === null);
    if (quiet) break;
  }
  await flush();

  // Invariant 12: with the network settled, no desk on screen shows an action pending.
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
  const counts: { presses: number; logged: number; seen: { refusedShown: number; foundGone: number; unconfirmed: number; blocked: number; recovered: number; dismissed: number; records: number; leftWithPending: number } }[] = [];
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
  });
});

describe("each desk fault is caught by its known seed (ADR 0003 4.4.1)", () => {
  const KILLING: readonly [DeskFault, number, string][] = [
    ["new_id_on_resend", 9119, "7:"],
    ["logged_when_sent", 9100, "2:"],
    ["outbox_removed_when_sent", 9100, "7:"],
    ["refresh_adopts_focus", 9100, "4:"],
    ["no_lock_while_pending", 9100, "5:"],
    ["substitute_bad_number", 9100, "6:"],
    ["pending_kept_after_answer", 9100, "7:"],
    ["disposed_desk_applies", 9100, "8:"],
    ["only_own_entries_retried", 9101, "9:"],
    ["refusal_dropped", 9109, "3:"],
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
  const all: DeskFault[] = ["new_id_on_resend", "logged_when_sent", "outbox_removed_when_sent", "refresh_adopts_focus", "no_lock_while_pending", "substitute_bad_number", "pending_kept_after_answer", "disposed_desk_applies", "only_own_entries_retried", "refusal_dropped"];
  for (const fault of all) {
    test(fault, async () => {
      const found: string[] = [];
      for (let seed = 9100; seed < 9180 && found.length < 2; seed++) {
        const out = await run(seed, new Set([fault]));
        if (out.problems.length > 0) found.push(`${seed}: ${out.problems[0]}`);
      }
      console.info("FAULT", fault, JSON.stringify(found));
    }, 300_000);
  }
});
