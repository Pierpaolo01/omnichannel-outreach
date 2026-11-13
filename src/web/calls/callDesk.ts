/**
 * The call focus queue's state (ADR 0003 4.4.1): one object the Calls page binds (useCallDesk.ts) and
 * the generated test drives directly (callDesk.generated.test.ts). The server decides the queue, the
 * focus it names and every outcome's effect; this object only keeps what the user did safe:
 *
 * - Pressing Log turns the draft into an action with one request id and a fixed body, written to the
 *   outbox (shared by the user's tabs) before it is sent. It leaves the outbox only on a definite
 *   answer for its id: accepted (200) or refused (4xx). Without one it is sent again, same id, same
 *   body, by whichever desk holds its lock: one sender at a time, retrying until the server answers.
 * - The page shows an action as logged only after an accepted answer for its id, and as refused only
 *   after a refusal for its id.
 * - The focus, the call the page is on, changes only on an accepted action of this tab (to the
 *   answer's next focus) or when the user chooses to move on after being told it left the list.
 * - What the user chose (number, outcome, note) is never replaced for them: a number gone bad is
 *   reported and blocks Log until they choose again.
 * - `locked` is the one value every outcome control reads: an action is pending, or the focus left
 *   the list. It refuses draft changes and a second press.
 * - Each opening of the desk is one life; an answer for an earlier life writes nothing but the
 *   removal of its own outbox entry.
 */
import type { CallNumberView, CallOffListView, CallOutcomeAnswer, CallOutcomeApi, CallsView, CallTaskView } from "../../shared/api.ts";

/** The server's limit on a call note (POST /api/call-tasks/:id/outcome). */
export const NOTE_MAX = 10_000;

export interface OutcomeBody {
  readonly requestId: string;
  readonly outcome: CallOutcomeApi;
  readonly numberId: string | null;
  readonly note: string;
  readonly noteScope: "person" | "company";
}

/** One pressed action, as it waits in the outbox. */
export interface OutboxEntry {
  readonly v: 1;
  /** The tab that pressed it; a reloaded tab shows its own entries as its pending action. */
  readonly tab: string;
  readonly taskId: string;
  /** The lead's name, so a reloaded page can say whose outcome it is logging. */
  readonly who: string;
  readonly body: OutcomeBody;
}

/** A refusal no desk on screen showed, kept until the user dismisses it. */
export interface RefusedRecord {
  readonly v: 1;
  readonly entry: OutboxEntry;
  readonly message: string;
}

/** No definite answer: the request may or may not have reached the server. */
export class NoAnswer extends Error {
  constructor() {
    super("No answer from the server.");
  }
}

/** A definite refusal (4xx) with the server's message. */
export class Refused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface KeyValue {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  keys(): string[];
}

export interface CallDeskPorts {
  calls(focus: string | null): Promise<CallsView>;
  task(taskId: string): Promise<CallTaskView>;
  /** One POST of an outcome: rejects with `NoAnswer` or `Refused`. */
  post(taskId: string, body: OutcomeBody): Promise<CallOutcomeAnswer>;
  /** Shared by the user's tabs (localStorage). */
  readonly local: KeyValue;
  /** This tab only (sessionStorage). */
  readonly session: KeyValue;
  newId(): string;
  /** Runs `fire` after `ms`; returns a cancel. */
  setTimer(fire: () => void, ms: number): () => void;
  /**
   * Asks, at once, for the exclusive lock `name` across the user's tabs, if no one holds it (Web
   * Locks, `ifAvailable`). Resolves to its release, or null when another holds it. A closed tab's
   * locks are released by the browser.
   */
  claim(name: string): Promise<(() => void) | null>;
  /**
   * Test-only faults that break the rule on purpose, so the generated test can show it catches each
   * (ADR 0003 4.4.1). Never set by the page.
   */
  readonly faults?: ReadonlySet<DeskFault>;
}

export type DeskFault =
  | "new_id_on_resend"
  | "logged_when_sent"
  | "outbox_removed_when_sent"
  | "refresh_adopts_focus"
  | "no_lock_while_pending"
  | "substitute_bad_number"
  | "send_without_lock"
  | "orphan_sent_once"
  | "disposed_desk_applies"
  | "refusal_dropped";

export interface Draft {
  readonly outcome: CallOutcomeApi | null;
  /** The number the user dials; skip for now sends none. */
  readonly numberId: string | null;
  readonly note: string;
  readonly noteScope: "person" | "company";
}

export type Load<T> = { readonly state: "loading" } | { readonly state: "error"; readonly message: string } | { readonly state: "ready"; readonly view: T };

export interface DeskSnapshot {
  readonly queue: Load<CallsView>;
  /** The call the page is on; null when the list has nothing ready now. */
  readonly focus: string | null;
  readonly task: Load<CallTaskView> | null;
  readonly draft: Draft;
  /** The action this tab pressed, sent and not yet answered; `unconfirmed` after an attempt had no answer. */
  readonly pending: (OutboxEntry & { readonly unconfirmed: boolean }) | null;
  /** Actions another tab pressed and left behind, which this desk holds and is sending until the server answers. */
  readonly recovering: readonly OutboxEntry[];
  /** The last action of this page the server accepted, with the call as the server answered. */
  readonly logged: { readonly requestId: string; readonly who: string; readonly body: OutcomeBody; readonly task: CallTaskView } | null;
  /** The server refused an action on a call still on the list (a number marked bad meanwhile): the draft stays. */
  readonly refusal: { readonly requestId: string; readonly message: string } | null;
  /** The focused call left the list: refused, or found gone on a refresh. Shown until the user moves on. */
  readonly away: { readonly taskId: string; readonly who: string; readonly offList: CallOffListView | null; readonly requestId: string | null; readonly message: string | null; readonly note: string } | null;
  /**
   * Refusals no desk on screen showed (an entry recovered from a closed tab, an answer to a desk left
   * behind), each with the outcome, the server's reason and the note typed: kept in the user's shared
   * storage and listed until dismissed. Typed text is never discarded silently.
   */
  readonly refusedRecords: readonly RefusedRecord[];
  /** The number the user chose can no longer be logged on: marked bad, or no longer the lead's. Log waits for a new choice. */
  readonly numberProblem: { readonly kind: "bad" | "gone"; readonly value: string | null } | null;
  /** Every outcome control reads this one value: an action is pending, or the focus left the list. */
  readonly locked: boolean;
  /** The note is over the server's limit; Log sends nothing. */
  readonly noteTooLong: boolean;
  /** Counts transitions that replace the controls under the user's keyboard focus, so the page can place it. */
  readonly transition: { readonly seq: number; readonly kind: "logged" | "refused" | "away" | "moved" | "focus" } | null;
}

const OUTBOX = "outreach.calls.outbox.";
const REFUSED = "outreach.calls.refused.";
const DRAFT = "outreach.calls.draft.";
const FOCUS = "outreach.calls.focus";
const TAB = "outreach.calls.tab";
/** Backoff after no answer, in milliseconds; the last repeats. */
export const RETRY_MS = [1_000, 2_000, 4_000, 8_000] as const;
/** After the server's `nextChangeAt`, how long to wait for the server's own tick before refreshing. */
const AFTER_CHANGE_MS = 1_500;

const EMPTY_DRAFT: Draft = { outcome: null, numberId: null, note: "", noteScope: "person" };

export const whoOf = (view: Pick<CallTaskView, "person" | "company">): string => view.person?.name ?? view.company.name;

function readEntry(raw: string | null): OutboxEntry | null {
  if (raw === null) return null;
  try {
    const e = JSON.parse(raw) as Partial<OutboxEntry> | null;
    const b = e?.body;
    if (e?.v !== 1 || typeof e.tab !== "string" || typeof e.taskId !== "string" || typeof e.who !== "string" || !b || typeof b.requestId !== "string" || typeof b.outcome !== "string" || typeof b.note !== "string") return null;
    return e as OutboxEntry;
  } catch {
    return null;
  }
}

function readDraft(raw: string | null): Draft | null {
  if (raw === null) return null;
  try {
    const d = JSON.parse(raw) as Partial<Draft> | null;
    if (!d || typeof d.note !== "string" || (d.noteScope !== "person" && d.noteScope !== "company")) return null;
    return { outcome: d.outcome ?? null, numberId: d.numberId ?? null, note: d.note, noteScope: d.noteScope };
  } catch {
    return null;
  }
}

/** Whether the chosen number can be logged on, from the call as the server last reported it. */
function numberProblemOf(draft: Draft, task: Load<CallTaskView> | null): DeskSnapshot["numberProblem"] {
  if (task?.state !== "ready" || draft.numberId === null) return null;
  const n: CallNumberView | undefined = task.view.numbers.find((x) => x.detailId === draft.numberId);
  if (!n) return { kind: "gone", value: null };
  return n.bad ? { kind: "bad", value: n.value } : null;
}

/** One entry this desk holds the lock of, and sends until it has a definite answer. */
interface Holding {
  readonly entry: OutboxEntry;
  readonly release: () => void;
  readonly life: number;
  tries: number;
  inFlight: boolean;
  cancelRetry: (() => void) | null;
}

export class CallDesk {
  private state: DeskSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly ports: CallDeskPorts;
  private readonly tab: string;
  /** The current opening; an answer for another life writes nothing but its outbox entry's removal. */
  private life = 0;
  private live = false;
  /** Entries this desk holds the lock of, by request id. */
  private readonly holding = new Map<string, Holding>();
  private cancelRefresh: (() => void) | null = null;
  private seq = 0;
  /** Bumped on every focus change, so a load for an earlier focus is ignored. */
  private loadGeneration = 0;

  constructor(ports: CallDeskPorts) {
    this.ports = ports;
    let tab = ports.session.get(TAB);
    if (!tab) {
      tab = ports.newId();
      ports.session.set(TAB, tab);
    }
    this.tab = tab;
    this.state = {
      queue: { state: "loading" },
      focus: ports.session.get(FOCUS),
      task: null,
      draft: EMPTY_DRAFT,
      pending: null,
      recovering: [],
      logged: null,
      refusal: null,
      away: null,
      refusedRecords: [],
      numberProblem: null,
      locked: false,
      noteTooLong: false,
      transition: null,
    };
  }

  getSnapshot = (): DeskSnapshot => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private fault(f: DeskFault): boolean {
    return this.ports.faults?.has(f) ?? false;
  }

  /** Whether `life` is the desk on screen now. */
  private current(life: number): boolean {
    return (this.live && life === this.life) || this.fault("disposed_desk_applies");
  }

  private set(patch: Partial<DeskSnapshot>, transition?: NonNullable<DeskSnapshot["transition"]>["kind"]): void {
    if (!this.live && !this.fault("disposed_desk_applies")) return;
    const next = { ...this.state, ...patch };
    const locked = (next.pending !== null && !this.fault("no_lock_while_pending")) || next.away !== null;
    const shown = new Set([next.away?.requestId, next.refusal?.requestId].filter((x): x is string => typeof x === "string"));
    this.state = {
      ...next,
      refusedRecords: this.records().filter((x) => !shown.has(x.entry.body.requestId)),
      locked,
      numberProblem: numberProblemOf(next.draft, next.task),
      noteTooLong: next.draft.note.length > NOTE_MAX,
      transition: transition ? { seq: ++this.seq, kind: transition } : next.transition,
    };
    for (const l of this.listeners) l();
  }

  /** Opens the page (again, after `dispose`): this tab's unanswered press becomes its pending action, every entry is claimed, then the queue loads. */
  async start(): Promise<void> {
    this.life++;
    this.live = true;
    this.state = { ...this.state, focus: this.ports.session.get(FOCUS) };
    const own = this.entries().find((e) => e.tab === this.tab);
    if (own) {
      this.ports.session.set(FOCUS, own.taskId);
      this.set({ focus: own.taskId, pending: { ...own, unconfirmed: true } });
    }
    this.claimAll();
    await this.refresh();
  }

  dispose(): void {
    this.live = false;
    this.life++;
    this.cancelRefresh?.();
    this.cancelRefresh = null;
    for (const h of this.holding.values()) {
      h.cancelRetry?.();
      h.release();
    }
    this.holding.clear();
  }

  /** The outbox's readable entries; one this page cannot read is discarded, with nothing sent (the boundary). */
  private entries(): OutboxEntry[] {
    const out: OutboxEntry[] = [];
    for (const key of this.ports.local.keys()) {
      if (!key.startsWith(OUTBOX)) continue;
      const entry = readEntry(this.ports.local.get(key));
      if (entry) out.push(entry);
      else this.ports.local.remove(key);
    }
    return out;
  }

  /** The refused records in the user's shared storage, oldest first; one this page cannot read is kept, not shown. */
  private records(): RefusedRecord[] {
    const out: RefusedRecord[] = [];
    for (const key of this.ports.local.keys()) {
      if (!key.startsWith(REFUSED)) continue;
      try {
        const x = JSON.parse(this.ports.local.get(key) ?? "null") as Partial<RefusedRecord> | null;
        if (x?.v === 1 && typeof x.message === "string" && x.entry && readEntry(JSON.stringify(x.entry))) out.push(x as RefusedRecord);
      } catch {
        // not ours to read
      }
    }
    return out;
  }

  /** The user has read a refused record: it goes. */
  dismiss(requestId: string): void {
    if (!this.live) return;
    this.ports.local.remove(REFUSED + requestId);
    this.set({});
  }

  /** Claims every entry no one holds, whichever tab pressed it: whoever finds it sends it. */
  private claimAll(): void {
    for (const entry of this.entries()) if (!this.holding.has(entry.body.requestId)) void this.claimAndSend(entry, this.life);
  }

  private async claimAndSend(entry: OutboxEntry, life: number): Promise<void> {
    const id = entry.body.requestId;
    const release = this.fault("send_without_lock") ? () => undefined : await this.ports.claim(OUTBOX + id);
    if (release === null) return;
    // The entry may have had its answer meanwhile; this life's own press is sent all the same, so it gets its answer.
    const ownPress = this.state.pending?.body.requestId === id;
    if (!this.current(life) || this.holding.has(id) || (this.ports.local.get(OUTBOX + id) === null && !ownPress)) {
      release();
      return;
    }
    const holding: Holding = { entry, release, life, tries: 0, inFlight: false, cancelRetry: null };
    this.holding.set(id, holding);
    if (entry.tab !== this.tab) this.set({ recovering: [...this.state.recovering.filter((e) => e.body.requestId !== id), entry] });
    void this.send(holding);
  }

  /**
   * Reloads the queue naming the focus, and the focused call. Never moves a focus it names; with none
   * named (the list was empty, or the user moved on) it takes the server's, as `adoptAs`. Every
   * refresh also claims entries left by other tabs, and schedules the next at the server's `nextChangeAt`.
   */
  async refresh(adoptAs: "focus" | "moved" = "focus"): Promise<void> {
    const life = this.life;
    if (!this.live) return;
    this.claimAll();
    const named = this.state.focus;
    let view: CallsView;
    try {
      view = await this.ports.calls(named);
    } catch (error) {
      if (this.current(life) && this.state.queue.state !== "ready") this.set({ queue: { state: "error", message: messageOf(error) } });
      return;
    }
    if (!this.current(life) || this.state.focus !== named) return;
    this.set({ queue: { state: "ready", view } });
    this.scheduleRefresh(view, life);
    if (named === null || this.fault("refresh_adopts_focus")) {
      if (view.focusTaskId !== named) this.focusOn(view.focusTaskId, adoptAs, life);
      else if (named !== null) await this.loadTask(named, life);
      return;
    }
    await this.loadTask(named, life);
    // The named call is no longer listed: say why, and keep showing it until the user moves on.
    const task = this.state.task;
    if (this.current(life) && view.focusTaskId !== named && this.state.focus === named && this.state.pending === null && this.state.away === null && task?.state === "ready" && task.view.offList !== null) {
      this.set({ away: { taskId: named, who: whoOf(task.view), offList: task.view.offList, requestId: null, message: null, note: this.state.draft.note } }, "away");
    }
  }

  /** At the server's next change by the clock, measured from its own `asOf`. */
  private scheduleRefresh(view: CallsView, life: number): void {
    this.cancelRefresh?.();
    this.cancelRefresh = null;
    if (view.nextChangeAt === null) return;
    const ms = Math.max(0, Date.parse(view.nextChangeAt) - Date.parse(view.asOf)) + AFTER_CHANGE_MS;
    this.cancelRefresh = this.ports.setTimer(() => {
      this.cancelRefresh = null;
      if (this.current(life)) void this.refresh();
    }, ms);
  }

  /** The user changes the draft of the focused call; refused while locked. The only writer of a draft but its first making. */
  setDraft(patch: Partial<Draft>): void {
    if (!this.live || this.state.locked || this.state.focus === null) return;
    // Changing the draft a refusal was shown on acknowledges it: its record goes.
    if (this.state.refusal) this.ports.local.remove(REFUSED + this.state.refusal.requestId);
    const draft = { ...this.state.draft, ...patch };
    this.ports.session.set(DRAFT + this.state.focus, JSON.stringify(draft));
    this.set({ draft, refusal: null });
  }

  /** The user presses Log: the draft becomes one action, its lock asked for and the entry stored before it is sent. */
  log(): void {
    const { draft, focus, task } = this.state;
    if (!this.live || this.state.locked || (this.state.pending !== null && !this.fault("no_lock_while_pending"))) return;
    if (focus === null || task?.state !== "ready" || draft.outcome === null || this.state.noteTooLong) return;
    const needsNumber = draft.outcome !== "skip_for_now";
    if (needsNumber && (draft.numberId === null || this.state.numberProblem !== null)) return;
    const body: OutcomeBody = {
      requestId: this.ports.newId(),
      outcome: draft.outcome,
      numberId: needsNumber ? draft.numberId : null,
      note: draft.note,
      noteScope: task.view.person === null ? "company" : draft.noteScope,
    };
    const entry: OutboxEntry = { v: 1, tab: this.tab, taskId: focus, who: whoOf(task.view), body };
    // The lock is asked for before the entry can be seen, so the pressing tab holds it first.
    const claimed = this.fault("send_without_lock") ? Promise.resolve(() => undefined) : this.ports.claim(OUTBOX + body.requestId);
    this.ports.local.set(OUTBOX + body.requestId, JSON.stringify(entry));
    if (this.fault("logged_when_sent")) this.set({ pending: { ...entry, unconfirmed: false }, refusal: null, logged: { requestId: body.requestId, who: entry.who, body, task: task.view } });
    else this.set({ pending: { ...entry, unconfirmed: false }, refusal: null });
    const life = this.life;
    void claimed.then((release) => {
      if (release === null) return;
      if (!this.current(life) || this.holding.has(body.requestId)) {
        release();
        return;
      }
      const holding: Holding = { entry, release, life, tries: 0, inFlight: false, cancelRetry: null };
      this.holding.set(body.requestId, holding);
      void this.send(holding);
    });
  }

  /** Sends every entry this desk holds and is waiting to retry, now (Try again, back online); also claims any left unheld. */
  retryNow(): void {
    if (!this.live) return;
    for (const h of this.holding.values()) {
      if (h.inFlight || (this.fault("orphan_sent_once") && h.entry.tab !== this.tab)) continue;
      h.cancelRetry?.();
      h.cancelRetry = null;
      void this.send(h);
    }
    this.claimAll();
  }

  /** After the page said the focus left the list: open the call the server puts first now. */
  async moveOn(): Promise<void> {
    const away = this.state.away;
    if (!this.live || !away || this.state.pending !== null) return;
    // Moving on acknowledges what the page said: a refusal's record goes.
    if (away.requestId) this.ports.local.remove(REFUSED + away.requestId);
    this.ports.session.remove(DRAFT + away.taskId);
    this.ports.session.remove(FOCUS);
    this.loadGeneration++;
    this.set({ away: null, focus: null, task: null, draft: EMPTY_DRAFT, refusal: null }, "moved");
    await this.refresh("moved");
  }

  private async send(h: Holding): Promise<void> {
    let entry = h.entry;
    if (this.fault("new_id_on_resend") && h.tries > 0) {
      const body = { ...entry.body, requestId: this.ports.newId() };
      this.ports.local.remove(OUTBOX + entry.body.requestId);
      entry = { ...entry, body };
      this.ports.local.set(OUTBOX + body.requestId, JSON.stringify(entry));
      if (this.state.pending?.body.requestId === h.entry.body.requestId) this.set({ pending: { ...entry, unconfirmed: true } });
    }
    const id = entry.body.requestId;
    const key = OUTBOX + id;
    h.inFlight = true;
    const posted = this.ports.post(entry.taskId, entry.body);
    if (this.fault("outbox_removed_when_sent")) this.ports.local.remove(key);
    try {
      const answer = await posted;
      h.inFlight = false;
      // A definite answer is a fact about the action: its entry goes, whichever life sent it.
      this.ports.local.remove(key);
      this.letGo(h);
      if (!this.current(h.life)) return;
      if (this.state.pending?.body.requestId === id) this.accepted(entry, answer, h.life);
      else this.recovered(h.entry.body.requestId, h.life);
    } catch (error) {
      h.inFlight = false;
      if (error instanceof Refused) {
        const shownHere = this.current(h.life) && this.state.pending?.body.requestId === id;
        // Every refusal is recorded before its entry goes, whoever answers it: the note is never dropped, even if this tab closes.
        if (!(this.fault("refusal_dropped") && entry.tab !== this.tab)) this.ports.local.set(REFUSED + id, JSON.stringify({ v: 1, entry, message: error.message } satisfies RefusedRecord));
        this.ports.local.remove(key);
        this.letGo(h);
        if (!this.current(h.life)) return;
        if (shownHere) await this.refused(entry, error.message, h.life);
        else this.recovered(h.entry.body.requestId, h.life);
        return;
      }
      if (!this.current(h.life) || this.holding.get(h.entry.body.requestId) !== h) return;
      // No answer: the same action again, after the backoff, by this holder; the page says it is not confirmed yet.
      if (this.state.pending?.body.requestId === id) this.set({ pending: { ...entry, unconfirmed: true } });
      if (this.fault("orphan_sent_once") && entry.tab !== this.tab) return;
      const delay = RETRY_MS[Math.min(h.tries, RETRY_MS.length - 1)] ?? 8_000;
      h.tries++;
      h.cancelRetry = this.ports.setTimer(() => {
        h.cancelRetry = null;
        if (this.current(h.life) && this.holding.get(h.entry.body.requestId) === h) void this.send(h);
      }, delay);
    }
  }

  /** Releases an entry's lock once it has its answer. */
  private letGo(h: Holding): void {
    h.cancelRetry?.();
    h.cancelRetry = null;
    h.release();
    if (this.holding.get(h.entry.body.requestId) === h) this.holding.delete(h.entry.body.requestId);
  }

  /** Another tab's entry has its answer: it leaves the recovery line, and the queue is read again. */
  private recovered(requestId: string, life: number): void {
    this.set({ recovering: this.state.recovering.filter((e) => e.body.requestId !== requestId) });
    if (this.current(life)) void this.refresh();
  }

  private accepted(entry: OutboxEntry, answer: CallOutcomeAnswer, life: number): void {
    if (!this.current(life)) return;
    this.ports.session.remove(DRAFT + entry.taskId);
    const logged = { requestId: entry.body.requestId, who: entry.who, body: entry.body, task: answer.task };
    this.set({ pending: null, logged, refusal: null, away: null });
    this.focusOn(answer.nextFocusTaskId, "logged", life);
  }

  private async refused(entry: OutboxEntry, message: string, life: number): Promise<void> {
    let view: CallTaskView | null = null;
    try {
      view = await this.ports.task(entry.taskId);
    } catch {
      view = null;
    }
    if (!this.current(life)) return;
    if (view !== null && view.offList === null) {
      // Still on the list (a number marked bad meanwhile, say): the draft stays, with the server's reason.
      this.set({ pending: null, refusal: { requestId: entry.body.requestId, message }, task: { state: "ready", view } }, "refused");
      return;
    }
    this.set(
      {
        pending: null,
        away: { taskId: entry.taskId, who: entry.who, offList: view?.offList ?? null, requestId: entry.body.requestId, message, note: entry.body.note },
        ...(view ? { task: { state: "ready" as const, view } } : {}),
      },
      "refused",
    );
  }

  /** The one writer of the tab's saved focus, for the desk's current life only. */
  private focusOn(taskId: string | null, kind: "logged" | "focus" | "moved", life: number): void {
    if (!this.current(life)) return;
    this.loadGeneration++;
    if (taskId === null) this.ports.session.remove(FOCUS);
    else this.ports.session.set(FOCUS, taskId);
    const draft = (taskId === null ? null : readDraft(this.ports.session.get(DRAFT + taskId))) ?? EMPTY_DRAFT;
    this.set({ focus: taskId, task: taskId === null ? null : { state: "loading" }, draft }, kind);
    if (kind === "logged") void this.refresh();
    else if (taskId !== null) void this.loadTask(taskId, life);
  }

  private async loadTask(taskId: string, life: number): Promise<void> {
    const generation = this.loadGeneration;
    try {
      const view = await this.ports.task(taskId);
      if (!this.current(life) || generation !== this.loadGeneration || this.state.focus !== taskId) return;
      let draft = this.state.draft;
      const firstLoad = this.state.task?.state !== "ready" || this.state.task.view.taskId !== taskId;
      if (firstLoad) {
        const stored = readDraft(this.ports.session.get(DRAFT + taskId));
        if (stored) draft = stored;
        else if (draft.numberId === null) {
          // The draft is made once: the first good number, as the server lists them (direct first).
          draft = { ...draft, numberId: view.numbers.find((n) => !n.bad)?.detailId ?? null, noteScope: view.person === null ? "company" : draft.noteScope };
          this.ports.session.set(DRAFT + taskId, JSON.stringify(draft));
        }
      } else if (this.fault("substitute_bad_number") && !view.numbers.some((n) => n.detailId === draft.numberId && !n.bad)) {
        draft = { ...draft, numberId: view.numbers.find((n) => !n.bad)?.detailId ?? null };
      }
      this.set({ task: { state: "ready", view }, draft });
    } catch (error) {
      if (!this.current(life) || generation !== this.loadGeneration || this.state.focus !== taskId) return;
      if (this.state.task?.state !== "ready") this.set({ task: { state: "error", message: messageOf(error) } });
    }
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : "The request failed.");
