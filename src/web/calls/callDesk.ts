/**
 * The call focus queue's state (ADR 0003 4.4.1): one object the Calls page binds (useCallDesk.ts) and
 * the generated test drives directly (callDesk.generated.test.ts). The server decides the queue, the
 * focus it names and every outcome's effect, and answers a repeated request id with its first result.
 * This object relies on that:
 *
 * - The outbox (shared by the user's tabs) is the only shared state. Log writes an entry before the
 *   first send; any desk sends any unanswered entry it sees, with backoff, until the server answers.
 * - A definite answer is written by whichever desk got it, in one storage write: accepted removes
 *   the entry; refused rewrites it as refused, keeping the typed note until the user acknowledges it.
 * - What the page shows for a call is derived from the server's read of it and its outbox entry.
 * - A draft belongs to one task; the focus moves only on an accepted answer this desk received for
 *   the call it is on, or on Open the next call. A desk no longer on screen writes only the outbox.
 */
import type { CallNumberView, CallOffListView, CallOutcomeAnswer, CallOutcomeApi, CallsView, CallTaskView } from "../../shared/api.ts";
import { FRESH, Refresher, type Freshness } from "./refresher.ts";

/** The server's limit on a call note (POST /api/call-tasks/:id/outcome). */
export const NOTE_MAX = 10_000;

export interface OutcomeBody {
  readonly requestId: string;
  readonly outcome: CallOutcomeApi;
  readonly numberId: string | null;
  readonly note: string;
  readonly noteScope: "person" | "company";
}

/** One outbox entry: what the user chose and typed for one call, under one request id. */
export interface OutboxEntry {
  readonly v: 2;
  readonly taskId: string;
  /** The lead's name, so any page can say whose outcome it is. */
  readonly who: string;
  readonly body: OutcomeBody;
  /** Set when the server refused it: kept, with the note, until the user acknowledges it. */
  readonly refused?: { readonly message: string; readonly offList: CallOffListView | null };
}

/** A refused entry, as the page lists it. */
export type RefusedRecord = OutboxEntry & { readonly refused: NonNullable<OutboxEntry["refused"]> };

/** No definite answer: the request may or may not have reached the server. */
export class NoAnswer extends Error {
  constructor() {
    super("No answer from the server.");
  }
}

/** A 4xx answer with the server's message and code; only a refusal code makes it definite (`isRefusal`). */
export class Refused extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null = "outcome_refused") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The answers that say the action was refused; any other 4xx (408, 429…) is no answer, and the action is sent again. */
const REFUSAL_CODES: ReadonlySet<string> = new Set(["outcome_refused", "not_found", "invalid_request"]);
export const isRefusal = (error: unknown): error is Refused => error instanceof Refused && error.code !== null && REFUSAL_CODES.has(error.code);

export interface KeyValue {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  keys(): string[];
}

export interface CallDeskPorts {
  /** The queue, naming the focus; `expected` is the server's own `nextChangeAt` on the read it asked for. */
  calls(focus: string | null, expected?: string | null): Promise<CallsView>;
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
  | "pending_kept_after_answer"
  | "disposed_desk_applies"
  | "only_own_entries_retried"
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
  /** The unanswered outbox entry for the call the page is on; `unconfirmed` once an attempt here had no answer, or if another page made it. */
  readonly pending: (OutboxEntry & { readonly unconfirmed: boolean }) | null;
  /** Unanswered entries for other calls, which this page is sending too. */
  readonly recovering: readonly OutboxEntry[];
  /** Refused entries for other calls, kept with their notes until dismissed. */
  readonly refusedRecords: readonly RefusedRecord[];
  /** The last outcome this page saw accepted for the call it was on, with the call as the server answered. */
  readonly logged: { readonly requestId: string; readonly who: string; readonly body: OutcomeBody; readonly task: CallTaskView } | null;
  /** The call the page is on has a refused entry while it is still on the list (a number marked bad meanwhile): the draft stays. */
  readonly refusal: { readonly requestId: string; readonly message: string } | null;
  /** The call the page is on is off the list, or its entry was refused: why, with the note, until the user moves on. */
  readonly away: { readonly taskId: string; readonly who: string; readonly offList: CallOffListView | null; readonly requestId: string | null; readonly message: string | null; readonly note: string } | null;
  /** The number the user chose can no longer be logged on: marked bad, or no longer the lead's. Log waits for a new choice. */
  readonly numberProblem: { readonly kind: "bad" | "gone"; readonly value: string | null } | null;
  /** The queue as of its last successful read (ADR 0003 4.4.1, "Freshness"). */
  readonly freshness: Freshness;
  /** Every outcome control reads this one value: the call has an unanswered entry, or is shown off the list. */
  readonly locked: boolean;
  /** The note is over the server's limit; Log sends nothing. */
  readonly noteTooLong: boolean;
  /** Counts transitions that replace the controls under the user's keyboard focus, so the page can place it. */
  readonly transition: { readonly seq: number; readonly kind: "logged" | "refused" | "away" | "moved" | "focus" } | null;
}

const OUTBOX = "outreach.calls.outbox.";
const DRAFT = "outreach.calls.draft.";
const FOCUS = "outreach.calls.focus";
/** Backoff after no answer, in milliseconds; the last repeats. */
export const RETRY_MS = [1_000, 2_000, 4_000, 8_000] as const;

const EMPTY_DRAFT: Draft = { outcome: null, numberId: null, note: "", noteScope: "person" };

export const whoOf = (view: Pick<CallTaskView, "person" | "company">): string => view.person?.name ?? view.company.name;

function readEntry(raw: string | null): OutboxEntry | null {
  if (raw === null) return null;
  try {
    const e = JSON.parse(raw) as Partial<OutboxEntry> | null;
    const b = e?.body;
    if (e?.v !== 2 || typeof e.taskId !== "string" || typeof e.who !== "string" || !b || typeof b.requestId !== "string" || typeof b.outcome !== "string" || typeof b.note !== "string") return null;
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

/** This desk's sending of one entry. */
interface Sending {
  tries: number;
  inFlight: boolean;
  cancel: (() => void) | null;
}

export class CallDesk {
  private state: DeskSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly ports: CallDeskPorts;
  private live = false;
  private readonly refresher: Refresher<CallsView & { readonly named: string | null }>;
  private adoptAs: "focus" | "moved" = "focus";
  /** Entries this desk is sending, by request id. */
  private readonly sending = new Map<string, Sending>();
  /** Entries pressed on this page, and those whose last attempt here had no answer. */
  private readonly pressedHere = new Set<string>();
  private readonly unanswered = new Set<string>();
  private seq = 0;
  /** Bumped on every focus change, so a load for an earlier focus is ignored. */
  private loadGeneration = 0;

  constructor(ports: CallDeskPorts) {
    this.ports = ports;
    this.refresher = new Refresher({
      read: async (expected) => {
        const named = this.state.focus;
        return { ...(await ports.calls(named, expected)), named };
      },
      onRead: (read) => this.applyQueue(read),
      onFailure: (error, freshness) => this.readFailed(error, freshness),
      setTimer: (fire, ms) => ports.setTimer(fire, ms),
    });
    this.state = {
      queue: { state: "loading" },
      focus: ports.session.get(FOCUS),
      task: null,
      draft: EMPTY_DRAFT,
      pending: null,
      recovering: [],
      refusedRecords: [],
      logged: null,
      refusal: null,
      away: null,
      numberProblem: null,
      freshness: FRESH,
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

  /** Whether this desk is on screen (or, under a test fault, behaves as if it were). */
  private onScreen(): boolean {
    return this.live || this.fault("disposed_desk_applies");
  }

  /** The outbox's readable entries; one this page cannot read is discarded (the boundary). */
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

  /**
   * Every change goes through here: the snapshot's derived parts (pending, refusals, the lock) are
   * recomputed from the outbox and the last server read, never kept apart from them.
   */
  private set(patch: Partial<DeskSnapshot>, transition?: NonNullable<DeskSnapshot["transition"]>["kind"]): void {
    if (!this.onScreen()) return;
    const next = { ...this.state, ...patch };
    const entries = this.entries();
    const forFocus = entries.find((e) => e.taskId === next.focus) ?? null;
    let pending: DeskSnapshot["pending"] = forFocus && !forFocus.refused ? { ...forFocus, unconfirmed: !this.pressedHere.has(forFocus.body.requestId) || this.unanswered.has(forFocus.body.requestId) } : null;
    if (!pending && this.fault("pending_kept_after_answer") && this.state.pending?.taskId === next.focus) pending = this.state.pending;
    // A refused entry for the call on screen is shown on the call: on the list, with the draft kept; off it, with Open the next call.
    let { refusal, away } = next;
    if (forFocus?.refused && next.task?.state === "ready" && next.task.view.taskId === forFocus.taskId) {
      const id = forFocus.body.requestId;
      if (next.task.view.offList === null) refusal = { requestId: id, message: forFocus.refused.message };
      else if (away?.requestId !== id) away = { taskId: forFocus.taskId, who: forFocus.who, offList: next.task.view.offList, requestId: id, message: forFocus.refused.message, note: forFocus.body.note };
    } else if (refusal && !entries.some((e) => e.body.requestId === refusal?.requestId && e.refused)) refusal = null;
    const locked = (pending !== null && !this.fault("no_lock_while_pending")) || away !== null;
    this.state = {
      ...next,
      pending,
      refusal,
      away,
      recovering: entries.filter((e) => !e.refused && e.taskId !== next.focus),
      refusedRecords: entries.filter((e): e is RefusedRecord => e.refused !== undefined && e.taskId !== next.focus),
      locked,
      numberProblem: numberProblemOf(next.draft, next.task),
      noteTooLong: next.draft.note.length > NOTE_MAX,
      transition: transition ? { seq: ++this.seq, kind: transition } : next.transition,
    };
    for (const l of this.listeners) l();
  }

  /** Opens the page (again, after `dispose`): sends every unanswered entry it sees, then loads the queue. */
  async start(): Promise<void> {
    this.live = true;
    this.refresher.start();
    this.state = { ...this.state, focus: this.ports.session.get(FOCUS) };
    this.sendAll();
    this.set({});
    await this.refresh();
  }

  dispose(): void {
    this.live = false;
    this.refresher.stop();
    for (const s of this.sending.values()) s.cancel?.();
    this.sending.clear();
  }

  /** Starts sending every unanswered entry this desk sees and is not sending yet: any desk may send any entry. */
  private sendAll(): void {
    if (!this.live) return;
    for (const entry of this.entries()) {
      if (entry.refused || this.sending.has(entry.body.requestId)) continue;
      if (this.fault("only_own_entries_retried") && !this.pressedHere.has(entry.body.requestId)) continue;
      const s: Sending = { tries: 0, inFlight: false, cancel: null };
      this.sending.set(entry.body.requestId, s);
      void this.send(entry, s);
    }
  }

  /** Reads the queue (and the call on screen) now, and sends whatever the outbox holds. Never moves a focus it names. */
  async refresh(adoptAs: "focus" | "moved" = "focus"): Promise<void> {
    if (!this.live) return;
    this.sendAll();
    this.adoptAs = adoptAs;
    await this.refresher.now();
  }

  private readFailed(error: unknown, freshness: Freshness): void {
    if (!this.live) return;
    if (this.state.queue.state !== "ready") this.set({ queue: { state: "error", message: messageOf(error) }, freshness });
    else this.set({ freshness });
  }

  private async applyQueue(read: CallsView & { readonly named: string | null }): Promise<void> {
    const { named, ...view } = read;
    const adoptAs = this.adoptAs;
    this.adoptAs = "focus";
    if (!this.live || this.state.focus !== named) return;
    this.set({ queue: { state: "ready", view }, freshness: this.refresher.freshness() });
    if (named === null || this.fault("refresh_adopts_focus")) {
      if (view.focusTaskId !== named) this.focusOn(view.focusTaskId, adoptAs);
      else if (named !== null) await this.loadTask(named);
      return;
    }
    await this.loadTask(named);
    // The call on screen is off the list and has no entry here: say why, and keep showing it until the user moves on.
    const task = this.state.task;
    if (this.live && view.focusTaskId !== named && this.state.focus === named && this.state.pending === null && this.state.away === null && task?.state === "ready" && task.view.offList !== null) {
      this.set({ away: { taskId: named, who: whoOf(task.view), offList: task.view.offList, requestId: null, message: null, note: this.state.draft.note } }, "away");
    }
  }

  /** The user changes the draft of the call on screen; refused while locked. The only writer of a draft but its first making. */
  setDraft(patch: Partial<Draft>): void {
    if (!this.live || this.state.locked || this.state.focus === null) return;
    // Changing the draft a refusal was shown on acknowledges it.
    if (this.state.refusal) this.ports.local.remove(OUTBOX + this.state.refusal.requestId);
    const draft = { ...this.state.draft, ...patch };
    this.ports.session.set(DRAFT + this.state.focus, JSON.stringify(draft));
    this.set({ draft, refusal: null });
  }

  /** The user presses Log: the draft becomes one entry, stored before it is sent. */
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
    const entry: OutboxEntry = { v: 2, taskId: focus, who: whoOf(task.view), body };
    this.pressedHere.add(body.requestId);
    this.ports.local.set(OUTBOX + body.requestId, JSON.stringify(entry));
    if (this.fault("logged_when_sent")) this.set({ refusal: null, logged: { requestId: body.requestId, who: entry.who, body, task: task.view } });
    else this.set({ refusal: null });
    this.sendAll();
  }

  /** Sends now every entry waiting for its next try (Try again, back online), and any not yet being sent. */
  retryNow(): void {
    if (!this.live) return;
    for (const [id, s] of this.sending) {
      if (s.inFlight) continue;
      s.cancel?.();
      s.cancel = null;
      const entry = readEntry(this.ports.local.get(OUTBOX + id));
      if (entry && !entry.refused) void this.send(entry, s);
    }
    this.sendAll();
  }

  /** The user has read a refusal kept for another call: it goes. */
  dismiss(requestId: string): void {
    if (!this.live) return;
    this.ports.local.remove(OUTBOX + requestId);
    this.set({});
  }

  /** After the page said the call is off the list (or its entry was refused): open the call the server puts first now. */
  async moveOn(): Promise<void> {
    const away = this.state.away;
    if (!this.live || !away || this.state.pending !== null) return;
    // Moving on acknowledges what the page said: a refused entry for this call goes.
    if (away.requestId) this.ports.local.remove(OUTBOX + away.requestId);
    this.ports.session.remove(DRAFT + away.taskId);
    this.ports.session.remove(FOCUS);
    this.loadGeneration++;
    this.set({ away: null, focus: null, task: null, draft: EMPTY_DRAFT, refusal: null }, "moved");
    await this.refresh("moved");
  }

  private async send(entry: OutboxEntry, s: Sending): Promise<void> {
    let body = entry.body;
    if (this.fault("new_id_on_resend") && s.tries > 0) {
      this.ports.local.remove(OUTBOX + body.requestId);
      body = { ...body, requestId: this.ports.newId() };
      entry = { ...entry, body };
      this.pressedHere.add(body.requestId);
      this.ports.local.set(OUTBOX + body.requestId, JSON.stringify(entry));
      this.sending.set(body.requestId, s);
    }
    const id = body.requestId;
    const key = OUTBOX + id;
    s.inFlight = true;
    const posted = this.ports.post(entry.taskId, body);
    if (this.fault("outbox_removed_when_sent")) this.ports.local.remove(key);
    let answer: CallOutcomeAnswer;
    try {
      answer = await posted;
    } catch (error) {
      s.inFlight = false;
      if (isRefusal(error)) return this.refused(entry, error.message);
      // No answer: the same entry again after the backoff, while this desk is on screen and the entry is unanswered.
      if (!this.live || this.sending.get(id) !== s) return;
      this.unanswered.add(id);
      this.set({});
      const delay = RETRY_MS[Math.min(s.tries, RETRY_MS.length - 1)] ?? 8_000;
      s.tries++;
      s.cancel = this.ports.setTimer(() => {
        s.cancel = null;
        const current = readEntry(this.ports.local.get(key));
        if (!this.live || this.sending.get(id) !== s) return;
        if (!current || current.refused) {
          this.sending.delete(id);
          return;
        }
        void this.send(current, s);
      }, delay);
      return;
    }
    s.inFlight = false;
    // Accepted: the entry goes, whichever desk got the answer.
    this.ports.local.remove(key);
    if (this.sending.get(id) === s) this.sending.delete(id);
    this.unanswered.delete(id);
    if (!this.onScreen()) return;
    if (this.state.focus === entry.taskId) {
      // An answer this desk received, on screen, for the call it is on: shown as logged, and the focus moves on.
      this.ports.session.remove(DRAFT + entry.taskId);
      this.set({ logged: { requestId: id, who: entry.who, body, task: answer.task }, refusal: null, away: null });
      this.focusOn(answer.nextFocusTaskId, "logged");
    } else this.set({});
  }

  /** A refusal: the entry is rewritten as refused, in one write, with the off-list facts the server gives. */
  private async refused(entry: OutboxEntry, message: string): Promise<void> {
    const key = OUTBOX + entry.body.requestId;
    if (this.sending.get(entry.body.requestId)) this.sending.delete(entry.body.requestId);
    this.unanswered.delete(entry.body.requestId);
    let view: CallTaskView | null = null;
    try {
      view = await this.ports.task(entry.taskId);
    } catch {
      view = null;
    }
    const stored = readEntry(this.ports.local.get(key));
    if (this.fault("refusal_dropped")) this.ports.local.remove(key);
    else if (stored && !stored.refused) this.ports.local.set(key, JSON.stringify({ ...stored, refused: { message, offList: view?.offList ?? null } } satisfies OutboxEntry));
    if (!this.live || this.state.focus !== entry.taskId) {
      if (this.live) this.set({});
      return;
    }
    this.set(view ? { task: { state: "ready", view } } : {}, "refused");
  }

  /** The one writer of the tab's saved focus, while on screen. */
  private focusOn(taskId: string | null, kind: "logged" | "focus" | "moved"): void {
    if (!this.onScreen()) return;
    this.loadGeneration++;
    if (taskId === null) this.ports.session.remove(FOCUS);
    else this.ports.session.set(FOCUS, taskId);
    const draft = (taskId === null ? null : readDraft(this.ports.session.get(DRAFT + taskId))) ?? EMPTY_DRAFT;
    this.set({ focus: taskId, task: taskId === null ? null : { state: "loading" }, draft, away: null, refusal: null }, kind);
    if (kind === "logged") void this.refresh();
    else if (taskId !== null) void this.loadTask(taskId);
  }

  private async loadTask(taskId: string): Promise<void> {
    const generation = this.loadGeneration;
    try {
      const view = await this.ports.task(taskId);
      if (!this.live || generation !== this.loadGeneration || this.state.focus !== taskId) return;
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
      if (!this.live || generation !== this.loadGeneration || this.state.focus !== taskId) return;
      if (this.state.task?.state !== "ready") this.set({ task: { state: "error", message: messageOf(error) } });
    }
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : "The request failed.");
