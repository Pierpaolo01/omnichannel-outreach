/**
 * The call focus queue's state (ADR 0003 4.4.1): one object the Calls page binds (useCallDesk.ts) and
 * the generated test drives directly (callDesk.generated.test.ts). The server decides the queue, the
 * focus it names and every outcome's effect, answers a repeated request id with its first result, and
 * says in each read of a call which presses are stored on it. This object relies on that:
 *
 * - The outbox (shared by the user's tabs) is the only shared state. Log writes an entry before the
 *   first send; any desk sends any unanswered entry it sees, on one backoff, until the server answers.
 * - An answer only updates the outbox: accepted removes the entry; refused rewrites it as refused,
 *   keeping the typed note until the user dismisses that refusal. An answer never touches a draft.
 * - Everything shown for the call on screen is `reconcile` of three inputs: the server's latest read
 *   of the call, the outbox entries for it, and the user's draft in memory.
 * - Reads are serial per resource (refresher.ts), and every failure counts toward the page's freshness.
 */
import type { CallNumberView, CallOffListView, CallOutcomeAnswer, CallOutcomeApi, CallsView, CallTaskView } from "../../shared/api.ts";
import { callbackChoice, isoWithOffset, type CallbackProblem } from "./callbackTime.ts";
import { FRESH, REFRESH_INTERVAL_MS, Refresher, type Freshness } from "./refresher.ts";

/** The server's limit on a call note (POST /api/call-tasks/:id/outcome). */
export const NOTE_MAX = 10_000;

export interface OutcomeBody {
  readonly requestId: string;
  readonly outcome: CallOutcomeApi;
  readonly numberId: string | null;
  readonly note: string;
  readonly noteScope: "person" | "company";
  /** A redial asked for with no answer, voicemail or gatekeeper (ticket 15b): sent only as true. */
  readonly redial?: true;
  /** With a callback requested: the instant the prospect asked for, with their offset, fixed at the press. */
  readonly callbackAt?: string;
}

/** One outbox entry: what the user chose and typed for one call, under one request id. */
export interface OutboxEntry {
  readonly v: 2;
  readonly taskId: string;
  /** The lead's name, so any page can say whose outcome it is. */
  readonly who: string;
  readonly body: OutcomeBody;
  /** When it was pressed (ms since the epoch, this device's clock): kept refusals are listed oldest first. */
  readonly pressedAt?: number;
  /** Set when the server refused it: kept, with the note, until the user dismisses it (its own Dismiss only). */
  readonly refused?: { readonly message: string; readonly offList: CallOffListView | null };
}

/** A refused entry, as the page lists it; `unstored` when this device's storage would not record the refusal. */
export type RefusedRecord = OutboxEntry & { readonly refused: NonNullable<OutboxEntry["refused"]>; readonly unstored?: true };

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
  /** Why the call is off the list, as the server read it when it refused. */
  readonly offList: CallOffListView | null;
  constructor(status: number, message: string, code: string | null = "outcome_refused", offList: CallOffListView | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.offList = offList;
  }
}

/** The answers that say the action was refused; any other 4xx (408, 429…) is no answer, and the action is sent again. */
const REFUSAL_CODES: ReadonlySet<string> = new Set(["outcome_refused", "not_found", "invalid_request"]);
export const isRefusal = (error: unknown): error is Refused => error instanceof Refused && error.code !== null && REFUSAL_CODES.has(error.code);

export interface KeyValue {
  get(key: string): string | null;
  /** True once the value is stored; false when storage refused it (quota, blocked). Nothing is kept in its place. */
  set(key: string, value: string): boolean;
  remove(key: string): void;
  keys(): string[];
}

export interface CallDeskPorts {
  /** The queue, naming the focus. */
  calls(focus: string | null): Promise<CallsView>;
  task(taskId: string): Promise<CallTaskView>;
  /** One POST of an outcome: rejects with `NoAnswer` or `Refused`. */
  post(taskId: string, body: OutcomeBody): Promise<CallOutcomeAnswer>;
  /** Shared by the user's tabs (localStorage). */
  readonly local: KeyValue;
  /** This tab only (sessionStorage): a convenience copy of the focus and the draft. */
  readonly session: KeyValue;
  newId(): string;
  /** This device's clock, used only to order kept refusals. */
  now(): number;
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
  | "only_focused_entries_retried"
  | "refusal_dropped"
  | "focused_refusal_hidden"
  | "stale_copy_written_back"
  | "refusal_resent_at_once"
  | "refusal_removed_on_move_on"
  | "stored_press_left_as_draft"
  | "answer_clears_draft"
  | "first_read_skips_reconcile"
  | "task_failures_uncounted"
  | "reads_overlap"
  // Ticket 15b: the redial and the callback time are part of the press like the outcome.
  | "redial_lost_on_resend"
  | "answer_resets_callback_draft"
  | "past_callback_sent";

export interface Draft {
  readonly outcome: CallOutcomeApi | null;
  /** The number the user dials; skip for now sends none. */
  readonly numberId: string | null;
  readonly note: string;
  readonly noteScope: "person" | "company";
  /** The user asked to call again tomorrow (ticket 15b); sent only with an outcome the call offers a redial for. */
  readonly redial: boolean;
  /** A callback's day and time as the user entered them, in the prospect's own zone: YYYY-MM-DD and HH:MM. */
  readonly callbackDay: string | null;
  readonly callbackTime: string;
  /** The request id of the press made from this draft, until it is found stored or settled as not stored. */
  readonly pressId: string | null;
  /** The count of call reads started when this press's entry was found gone: a read started after it settles it. */
  readonly goneAtRead: number | null;
}

export type Load<T> = { readonly state: "loading" } | { readonly state: "error"; readonly message: string } | { readonly state: "ready"; readonly view: T };

/** What `reconcile` found stored for this tab's press: the status line shows it after moving on. */
export interface LoggedRecord {
  readonly requestId: string;
  readonly who: string;
  readonly body: OutcomeBody;
  readonly task: CallTaskView;
}

/** The call on screen, as `reconcile` decides it (ADR 0003 4.4.1, "One reconciliation"). */
export interface CallState {
  readonly kind: "stored" | "pending" | "confirming" | "off_list" | "draft";
  /** Every outcome control reads this one value. */
  readonly locked: boolean;
  /** The unanswered entry for the call; `own` when it is this tab's press, `unconfirmed` when its last attempt here had no answer. */
  readonly pending: (OutboxEntry & { readonly own: boolean; readonly unconfirmed: boolean }) | null;
  /** This tab's press, found stored. */
  readonly logged: LoggedRecord | null;
  /** Why the call is off the list, and this tab's typed note when the server does not hold it. */
  readonly away: { readonly taskId: string; readonly who: string; readonly offList: CallOffListView; readonly note: string } | null;
  /** The press's entry is gone and no read has been started since: start one. */
  readonly pressGone: boolean;
  /** A read started after the entry went does not hold the press: it was never stored. */
  readonly pressSettled: boolean;
}

/**
 * Everything the page shows for the call it is on, from exactly three inputs: the server's latest
 * read of the call (`view`, read number `readSeq`), the outbox entries, and the user's draft in
 * memory. Pure: the desk applies its decisions.
 */
export function reconcile(input: {
  readonly view: CallTaskView;
  readonly readSeq: number;
  readonly entries: readonly OutboxEntry[];
  readonly draft: Draft;
  readonly unanswered: ReadonlySet<string>;
  readonly unstored: ReadonlySet<string>;
  readonly ignoreStored?: boolean;
}): CallState {
  const { view, readSeq, entries, draft, unanswered, unstored } = input;
  const who = whoOf(view);
  const base: CallState = { kind: "draft", locked: false, pending: null, logged: null, away: null, pressGone: false, pressSettled: false };
  const press = draft.pressId;
  // 1. Stored: this tab's press is logged, whoever got the answer and whenever.
  if (press !== null && input.ignoreStored !== true && view.storedRequestIds.includes(press) && draft.outcome !== null) {
    const body: OutcomeBody = { requestId: press, outcome: draft.outcome, numberId: draft.numberId, note: draft.note, noteScope: draft.noteScope };
    return { ...base, kind: "stored", locked: true, logged: { requestId: press, who, body, task: view } };
  }
  // 2. On its way.
  const waiting = entries.find((e) => e.taskId === view.taskId && !e.refused && !unstored.has(e.body.requestId));
  if (waiting) {
    const own = waiting.body.requestId === press;
    return { ...base, kind: "pending", locked: true, pending: { ...waiting, own, unconfirmed: own && unanswered.has(waiting.body.requestId) } };
  }
  // 3. Being confirmed: the press's entry is gone, and no read started after that has answered.
  let pressSettled = false;
  if (press !== null && !entries.some((e) => e.body.requestId === press)) {
    if (draft.goneAtRead === null || readSeq <= draft.goneAtRead) return { ...base, kind: "confirming", locked: true, pressGone: draft.goneAtRead === null };
    pressSettled = true;
  }
  // 4. Off the list.
  if (view.offList !== null) {
    const typed = draft.note.trim();
    const held = typed !== "" && ([...view.personNotes, ...view.companyNotes].some((n) => n.body === typed) || view.touches.some((t) => t.kind === "call" && t.note === typed));
    const kept = typed !== "" && entries.some((e) => e.refused && e.taskId === view.taskId && e.body.note.trim() === typed);
    return { ...base, kind: "off_list", locked: true, pressSettled, away: { taskId: view.taskId, who, offList: view.offList, note: typed === "" || held || kept ? "" : draft.note } };
  }
  // 5. A draft, ready to work.
  return { ...base, pressSettled };
}

export interface DeskSnapshot {
  readonly queue: Load<CallsView>;
  /** The call the page is on; null when the list has nothing ready now. */
  readonly focus: string | null;
  readonly task: Load<CallTaskView> | null;
  readonly draft: Draft;
  /** The unanswered outbox entry for the call the page is on (`reconcile`). */
  readonly pending: CallState["pending"];
  /** This tab's press is no longer in the outbox, and the server's word on it is being read (`reconcile`). */
  readonly confirming: boolean;
  /** Unanswered entries for other calls, which this page is sending too. */
  readonly recovering: readonly OutboxEntry[];
  /** Every refused entry, oldest press first, whichever tab pressed it and whichever call the page is on. */
  readonly refusedRecords: readonly RefusedRecord[];
  /** The last press of this tab `reconcile` found stored, with the call as the server read it. */
  readonly logged: LoggedRecord | null;
  /** The call the page is on is off the list, as the server's read says (`reconcile`). */
  readonly away: CallState["away"];
  /** The number the user chose can no longer be logged on: marked bad, or no longer the lead's. Log waits for a new choice. */
  readonly numberProblem: { readonly kind: "bad" | "gone"; readonly value: string | null } | null;
  /** The queue and the call, as of their last successful reads; stale when either is failing. */
  readonly freshness: Freshness;
  readonly locked: boolean;
  /** The note is over the server's limit; Log sends nothing. */
  readonly noteTooLong: boolean;
  /** The last press could not be queued: this device's storage refused the outbox entry, so nothing was sent. */
  readonly notQueued: boolean;
  /**
   * With callback requested chosen: the instant entered, or why there is none the server would take
   * (nothing entered, a time the clocks skip, a time already passed as of the call's read). Log sends nothing without one.
   */
  readonly callback: { readonly at: number | null; readonly problem: CallbackProblem | null } | null;
  /** The draft's copy in this tab's storage failed: the note is not kept if the user leaves the page. */
  readonly draftNotKept: boolean;
  /** Counts transitions that replace the controls under the user's keyboard focus, so the page can place it. */
  readonly transition: { readonly seq: number; readonly kind: "logged" | "refused" | "away" | "moved" | "focus" } | null;
}

const OUTBOX = "outreach.calls.outbox.";
const DRAFT = "outreach.calls.draft.";
const FOCUS = "outreach.calls.focus";
/** Backoff after no answer, in milliseconds; the last repeats. */
export const RETRY_MS = [1_000, 2_000, 4_000, 8_000] as const;

const EMPTY_DRAFT: Draft = { outcome: null, numberId: null, note: "", noteScope: "person", redial: false, callbackDay: null, callbackTime: "", pressId: null, goneAtRead: null };

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
    return {
      outcome: d.outcome ?? null,
      numberId: d.numberId ?? null,
      note: d.note,
      noteScope: d.noteScope,
      redial: d.redial === true,
      callbackDay: typeof d.callbackDay === "string" ? d.callbackDay : null,
      callbackTime: typeof d.callbackTime === "string" ? d.callbackTime : "",
      pressId: typeof d.pressId === "string" ? d.pressId : null,
      goneAtRead: null,
    };
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

/** The callback time entered, judged against the call as the server last read it; null unless callback requested is chosen. */
function callbackOf(draft: Draft, task: Load<CallTaskView> | null): DeskSnapshot["callback"] {
  if (draft.outcome !== "callback_requested" || task?.state !== "ready") return null;
  return callbackChoice(draft, task.view);
}

/** The page's freshness: the queue's last read, failing or stale if either read is. */
const worse = (queue: Freshness, task: Freshness): Freshness => ({ failures: Math.max(queue.failures, task.failures), lastReadAt: queue.lastReadAt, stale: queue.stale || task.stale });

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
  private readonly queueReader: Refresher<CallsView & { readonly named: string | null }>;
  private readonly taskReader: Refresher<{ readonly view: CallTaskView | null; readonly seq: number }>;
  private adoptAs: "focus" | "moved" | "logged" = "focus";
  /** Entries this desk is sending, by request id. */
  private readonly sending = new Map<string, Sending>();
  /** Entries whose last attempt here had no answer. */
  private readonly unanswered = new Set<string>();
  /** Refusals this desk got that storage would not record: shown from here, their write retried on the backoff. */
  private readonly unstored = new Map<string, RefusedRecord>();
  /** Call reads started, and the number of the read the call on screen comes from. */
  private taskReads = 0;
  private taskSeq = 0;
  private seq = 0;

  constructor(ports: CallDeskPorts) {
    this.ports = ports;
    const overlapFault = this.fault("reads_overlap");
    const setTimer = (fire: () => void, ms: number) => ports.setTimer(fire, ms);
    this.queueReader = new Refresher({
      read: async () => {
        const named = this.state.focus;
        return { ...(await ports.calls(named)), named };
      },
      onRead: (read) => this.applyQueue(read),
      onFailure: (error) => this.readFailed("queue", error),
      setTimer,
      // The call is read with every read of the queue, so the interval covers both.
      interval: REFRESH_INTERVAL_MS,
      overlapFault,
    });
    this.taskReader = new Refresher({
      read: async () => {
        const focus = this.state.focus;
        const seq = ++this.taskReads;
        return { view: focus === null ? null : await ports.task(focus), seq };
      },
      onRead: (read) => this.applyTask(read.view, read.seq),
      onFailure: (error) => this.readFailed("task", error),
      setTimer,
      overlapFault,
    });
    this.state = {
      queue: { state: "loading" },
      focus: ports.session.get(FOCUS),
      task: null,
      draft: EMPTY_DRAFT,
      pending: null,
      confirming: false,
      recovering: [],
      refusedRecords: [],
      logged: null,
      away: null,
      numberProblem: null,
      freshness: FRESH,
      locked: false,
      noteTooLong: false,
      notQueued: false,
      callback: null,
      draftNotKept: false,
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

  /** Whether this desk is on screen (or, under a test fault, behaves as if it were); a method, since `dispose` may run while a read is awaited. */
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
   * Every change goes through here. The call's state is `reconcile` of the server's read, the outbox
   * and the draft; the rest is derived from the outbox and the reads. Then the desk acts on what
   * `reconcile` decided: a stored press moves on, a gone press is read again, a settled one is cleared.
   */
  private set(patch: Partial<DeskSnapshot>, transition?: NonNullable<DeskSnapshot["transition"]>["kind"]): void {
    if (!this.onScreen()) return;
    const next = { ...this.state, ...patch };
    const entries = this.entries();
    const task = next.task?.state === "ready" && next.task.view.taskId === next.focus ? next.task.view : null;
    const call = task
      ? reconcile({ view: task, readSeq: this.taskSeq, entries, draft: next.draft, unanswered: this.unanswered, unstored: new Set(this.unstored.keys()), ignoreStored: this.fault("stored_press_left_as_draft") })
      : null;
    let pending = call?.pending ?? null;
    if (!pending && this.fault("pending_kept_after_answer") && this.state.pending?.taskId === next.focus) pending = this.state.pending;
    const waiting = (e: OutboxEntry) => !e.refused && !this.unstored.has(e.body.requestId);
    const refused = [...entries.filter((e): e is RefusedRecord => e.refused !== undefined && !(this.fault("focused_refusal_hidden") && e.taskId === next.focus)), ...entries.flatMap((e) => this.unstored.get(e.body.requestId) ?? [])];
    const away = call?.away ?? null;
    const kind = transition ?? (away !== null && this.state.away === null ? "away" : undefined);
    this.state = {
      ...next,
      pending,
      confirming: call?.kind === "confirming",
      away,
      recovering: entries.filter((e) => waiting(e) && e.taskId !== next.focus),
      refusedRecords: refused.sort((a, b) => (a.pressedAt ?? 0) - (b.pressedAt ?? 0)),
      locked: call === null ? false : call.kind === "pending" && this.fault("no_lock_while_pending") ? false : call.locked,
      numberProblem: numberProblemOf(next.draft, next.task),
      noteTooLong: next.draft.note.length > NOTE_MAX,
      callback: callbackOf(next.draft, next.task),
      freshness: this.fault("task_failures_uncounted") ? this.queueReader.freshness() : worse(this.queueReader.freshness(), this.taskReader.freshness()),
      transition: kind ? { seq: ++this.seq, kind } : next.transition,
    };
    for (const l of this.listeners) l();
    if (call) this.act(call);
  }

  /** What the desk does on `reconcile`'s decisions, for the call on screen. */
  private act(call: CallState): void {
    const focus = this.state.focus;
    if (focus === null) return;
    if (call.logged) {
      // This tab's press is stored: show it, drop the draft and move on to the call the server puts first.
      this.ports.session.remove(DRAFT + focus);
      this.ports.session.remove(FOCUS);
      this.set({ logged: call.logged, focus: null, task: null, draft: EMPTY_DRAFT }, "logged");
      void this.refresh("logged");
    } else if (call.pressGone) {
      this.keepDraft({ ...this.state.draft, goneAtRead: this.taskReads });
      void this.taskReader.now();
    } else if (call.pressSettled) {
      this.keepDraft({ ...this.state.draft, pressId: null, goneAtRead: null });
    }
  }

  /** The draft in memory, and its convenience copy in this tab's storage; a failed copy is only said. */
  private keepDraft(draft: Draft, patch: Partial<DeskSnapshot> = {}): void {
    const focus = this.state.focus;
    if (focus === null || !this.onScreen()) return;
    const kept = this.ports.session.set(DRAFT + focus, JSON.stringify({ ...draft, goneAtRead: null }));
    this.set({ ...patch, draft, draftNotKept: !kept });
  }

  /** Opens the page (again, after `dispose`): sends every unanswered entry it sees, then loads the queue. */
  async start(): Promise<void> {
    this.live = true;
    this.queueReader.start();
    this.taskReader.start();
    this.state = { ...this.state, focus: this.ports.session.get(FOCUS), task: null, draft: EMPTY_DRAFT };
    this.sendAll();
    this.set({});
    await this.refresh();
  }

  /** The page was hidden or shown (ADR 0003 4.4.1, "Freshness"): hidden, nothing is read on a timer; shown, both are read now. */
  setVisible(visible: boolean): void {
    this.queueReader.setVisible(visible);
    this.taskReader.setVisible(visible);
  }

  dispose(): void {
    this.live = false;
    if (!this.fault("disposed_desk_applies")) {
      this.queueReader.stop();
      this.taskReader.stop();
    }
    for (const s of this.sending.values()) s.cancel?.();
    this.sending.clear();
    this.unstored.clear();
  }

  /** Starts sending every unanswered entry this desk sees and is not sending yet: any desk may send any entry. */
  private sendAll(): void {
    if (!this.live) return;
    for (const entry of this.entries()) {
      if (entry.refused || this.sending.has(entry.body.requestId)) continue;
      if (this.fault("only_focused_entries_retried") && entry.taskId !== this.state.focus) continue;
      const s: Sending = { tries: 0, inFlight: false, cancel: null };
      this.sending.set(entry.body.requestId, s);
      void this.send(entry, s);
    }
  }

  /** Reads the queue (and the call on screen) now, and sends whatever the outbox holds. Never moves a focus it names. */
  async refresh(adoptAs: "focus" | "moved" | "logged" = "focus"): Promise<void> {
    if (!this.live) return;
    this.sendAll();
    if (adoptAs !== "focus") this.adoptAs = adoptAs;
    this.set({});
    await this.queueReader.now();
  }

  private readFailed(which: "queue" | "task", error: unknown): void {
    if (!this.onScreen()) return;
    if (which === "queue" && this.state.queue.state !== "ready") this.set({ queue: { state: "error", message: messageOf(error) } });
    else if (which === "task" && this.state.focus !== null && this.state.task?.state !== "ready") this.set({ task: { state: "error", message: messageOf(error) } });
    else this.set({});
  }

  private async applyQueue(read: CallsView & { readonly named: string | null }): Promise<void> {
    const { named, ...view } = read;
    if (!this.onScreen() || this.state.focus !== named) return;
    const adoptAs = this.adoptAs;
    this.adoptAs = "focus";
    this.set({ queue: { state: "ready", view } });
    if ((named === null || this.fault("refresh_adopts_focus")) && view.focusTaskId !== named) this.focusOn(view.focusTaskId, adoptAs);
    else if (named !== null) await this.taskReader.now();
  }

  /** Every successful read of the call goes through `reconcile` (in `set`); a read for a call the page left is dropped. */
  private applyTask(view: CallTaskView | null, seq: number): void {
    if (!this.onScreen() || view === null || view.taskId !== this.state.focus) return;
    this.taskSeq = seq;
    let draft = this.state.draft;
    let draftNotKept = this.state.draftNotKept;
    const first = this.state.task?.state !== "ready" || this.state.task.view.taskId !== view.taskId;
    if (first) {
      // The draft is made once in this tab: from its copy, or with the first good number, as the server lists them (direct first).
      const copy = readDraft(this.ports.session.get(DRAFT + view.taskId));
      draft = copy ?? { ...EMPTY_DRAFT, numberId: view.numbers.find((n) => !n.bad)?.detailId ?? null, noteScope: view.person === null ? "company" : "person" };
      draftNotKept = copy === null ? !this.ports.session.set(DRAFT + view.taskId, JSON.stringify(draft)) : false;
      if (this.fault("first_read_skips_reconcile")) {
        this.state = { ...this.state, task: { state: "ready", view }, draft, away: null, locked: false };
        for (const l of this.listeners) l();
        return;
      }
    } else if (this.fault("substitute_bad_number") && !view.numbers.some((n) => n.detailId === draft.numberId && !n.bad)) {
      draft = { ...draft, numberId: view.numbers.find((n) => !n.bad)?.detailId ?? null };
    }
    this.set({ task: { state: "ready", view }, draft, draftNotKept });
  }

  /** The user changes the draft of the call on screen; refused while locked. An edit is no longer a press. */
  setDraft(patch: Partial<Pick<Draft, "outcome" | "numberId" | "note" | "noteScope" | "redial" | "callbackDay" | "callbackTime">>): void {
    if (!this.live || this.state.locked || this.state.focus === null) return;
    this.keepDraft({ ...this.state.draft, ...patch, pressId: null, goneAtRead: null }, { notQueued: false });
  }

  /** The user presses Log: the draft becomes one entry, stored before it is sent, and the draft remembers its id. */
  log(): void {
    const { draft, focus, task } = this.state;
    if (!this.live || this.state.locked || focus === null || task?.state !== "ready" || draft.outcome === null || this.state.noteTooLong) return;
    const needsNumber = draft.outcome !== "skip_for_now";
    if (needsNumber && (draft.numberId === null || this.state.numberProblem !== null)) return;
    // The boundary (ticket 15b): a callback with no time, a time the clocks skip, or one already passed as of the
    // call's read is refused in place, and nothing is sent. A time between the read and the server's now is the server's to refuse.
    const callback = draft.outcome === "callback_requested" ? callbackChoice(draft, task.view) : null;
    if (callback && callback.at === null && !(this.fault("past_callback_sent") && callback.problem === "past")) return;
    const pastAt = callback?.problem === "past" && draft.callbackDay !== null ? Date.parse(task.view.asOf) : null;
    const at = callback?.at ?? pastAt;
    // A redial goes only with an outcome the call offers it for; the choice stays in the draft whatever the outcome.
    const redial = draft.redial && task.view.redialOutcomes.includes(draft.outcome);
    const body: OutcomeBody = {
      requestId: this.ports.newId(),
      outcome: draft.outcome,
      numberId: needsNumber ? draft.numberId : null,
      note: draft.note,
      noteScope: task.view.person === null ? "company" : draft.noteScope,
      ...(redial ? { redial: true as const } : {}),
      ...(at !== null && at !== undefined ? { callbackAt: isoWithOffset(at, task.view.zone) } : {}),
    };
    const entry: OutboxEntry = { v: 2, taskId: focus, who: whoOf(task.view), body, pressedAt: this.ports.now() };
    // The boundary: an outcome is not pressed until its entry is stored. If storage refuses it, nothing is
    // sent; the page says so, and the draft and number stay for another try.
    if (!this.ports.local.set(OUTBOX + body.requestId, JSON.stringify(entry))) {
      this.set({ notQueued: true });
      return;
    }
    const pressed: Draft = { ...draft, pressId: body.requestId, goneAtRead: null };
    this.keepDraft(pressed, this.fault("logged_when_sent") ? { notQueued: false, logged: { requestId: body.requestId, who: entry.who, body, task: task.view } } : { notQueued: false });
    this.sendAll();
  }

  /**
   * Brings forward every entry's next try on the backoff (Try again, back online), and starts any not
   * yet being sent. A refusal storage would not record is written again, never sent again.
   */
  retryNow(): void {
    if (!this.live) return;
    for (const [id, s] of this.sending) {
      if (s.inFlight) continue;
      s.cancel?.();
      s.cancel = null;
      const kept = this.unstored.get(id);
      if (kept) {
        this.keepRefusal(kept, s);
        continue;
      }
      const entry = readEntry(this.ports.local.get(OUTBOX + id));
      if (entry && !entry.refused) void this.send(entry, s);
    }
    this.sendAll();
  }

  /** The user has read a kept refusal: it goes. A refused press is never stored, so its draft is a draft again. */
  dismiss(requestId: string): void {
    if (!this.live) return;
    this.ports.local.remove(OUTBOX + requestId);
    this.forgetUnstored(requestId);
    if (this.state.draft.pressId === requestId) this.keepDraft({ ...this.state.draft, pressId: null, goneAtRead: null });
    else this.set({});
  }

  /** After the page said the call is off the list: open the call the server puts first now. */
  async moveOn(): Promise<void> {
    const away = this.state.away;
    if (!this.live || !away || this.state.pending !== null) return;
    // A kept refusal goes only by its own Dismiss: moving on keeps every one, shown or behind the count (review bot on 26d4b49).
    if (this.fault("refusal_removed_on_move_on")) {
      for (const e of this.entries()) if (e.refused && e.taskId === away.taskId) this.ports.local.remove(OUTBOX + e.body.requestId);
    }
    // The call's draft stays in this tab: if the server lists the call again and puts it first, it is still there.
    this.ports.session.remove(FOCUS);
    this.set({ focus: null, task: null, draft: EMPTY_DRAFT }, "moved");
    await this.refresh("moved");
  }

  private async send(entry: OutboxEntry, s: Sending): Promise<void> {
    let body = entry.body;
    if (this.fault("redial_lost_on_resend") && s.tries > 0 && body.redial) {
      const { redial: _dropped, ...rest } = body;
      body = rest;
    }
    if (this.fault("new_id_on_resend") && s.tries > 0) {
      this.ports.local.remove(OUTBOX + body.requestId);
      body = { ...body, requestId: this.ports.newId() };
      entry = { ...entry, body };
      this.ports.local.set(OUTBOX + body.requestId, JSON.stringify(entry));
      this.sending.set(body.requestId, s);
    }
    const id = body.requestId;
    const key = OUTBOX + id;
    s.inFlight = true;
    const posted = this.ports.post(entry.taskId, body);
    if (this.fault("outbox_removed_when_sent")) this.ports.local.remove(key);
    try {
      await posted;
    } catch (error) {
      s.inFlight = false;
      if (isRefusal(error)) return this.refused(entry, error, s);
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
        if (!current && this.fault("stale_copy_written_back")) {
          // The fault: this desk's copy written back over another tab's removal.
          this.ports.local.set(key, JSON.stringify(entry));
          void this.send(entry, s);
          return;
        }
        if (!current || current.refused) {
          this.sending.delete(id);
          return;
        }
        void this.send(current, s);
      }, delay);
      return;
    }
    s.inFlight = false;
    // Accepted: the entry goes, whichever desk got the answer. The next read says the rest.
    this.ports.local.remove(key);
    if (this.sending.get(id) === s) this.sending.delete(id);
    this.unanswered.delete(id);
    if (this.fault("answer_clears_draft") && this.onScreen()) this.keepDraft({ ...EMPTY_DRAFT, numberId: this.state.draft.numberId });
    if (this.fault("answer_resets_callback_draft") && this.onScreen() && this.state.focus !== null) this.keepDraft({ ...this.state.draft, redial: false, callbackTime: "" });
    await this.refresh();
  }

  /** A refusal: the entry is rewritten as refused, in one write, with the off-list facts the server's refusal gives. */
  private async refused(entry: OutboxEntry, refusal: Refused, s: Sending): Promise<void> {
    const id = entry.body.requestId;
    const key = OUTBOX + id;
    this.unanswered.delete(id);
    const stored = readEntry(this.ports.local.get(key));
    if (this.fault("refusal_dropped")) {
      this.ports.local.remove(key);
      if (this.sending.get(id) === s) this.sending.delete(id);
    } else if (stored && !stored.refused) this.keepRefusal({ ...stored, refused: { message: refusal.message, offList: refusal.offList } }, s);
    else if (this.sending.get(id) === s) this.sending.delete(id);
    await this.refresh();
    // On the call the page is on and still listed, focus goes to the kept refusal; off the list, the server's read already said why.
    if (this.live && this.state.focus === entry.taskId && this.state.away === null) this.set({}, "refused");
  }

  /**
   * Records a refusal in its entry. If storage will not take the write, the refusal is shown from
   * this desk and the write is retried on the backoff; the entry stays this desk's, so nothing sends
   * it again from here meanwhile. A write that failed is a state the page shows, never a reason to
   * ask the server again.
   */
  private keepRefusal(record: RefusedRecord, s: Sending): void {
    const id = record.body.requestId;
    const key = OUTBOX + id;
    const current = readEntry(this.ports.local.get(key));
    const entry: OutboxEntry = { v: 2, taskId: record.taskId, who: record.who, body: record.body, refused: record.refused, ...(record.pressedAt === undefined ? {} : { pressedAt: record.pressedAt }) };
    // Gone (accepted or dismissed elsewhere) or already recorded refused: nothing left to write.
    if (!current || current.refused || this.ports.local.set(key, JSON.stringify(entry))) {
      this.forgetUnstored(id);
      if (this.sending.get(id) === s) this.sending.delete(id);
      this.set({});
      return;
    }
    if (this.fault("refusal_resent_at_once")) {
      if (this.sending.get(id) === s) this.sending.delete(id);
      return;
    }
    this.unstored.set(id, { ...record, unstored: true });
    this.sending.set(id, s);
    const delay = RETRY_MS[Math.min(s.tries, RETRY_MS.length - 1)] ?? 8_000;
    s.tries++;
    s.cancel?.();
    s.cancel = this.ports.setTimer(() => {
      s.cancel = null;
      if (!this.live || this.sending.get(id) !== s) return;
      this.keepRefusal(record, s);
    }, delay);
    this.set({});
  }

  private forgetUnstored(id: string): void {
    if (!this.unstored.delete(id)) return;
    const s = this.sending.get(id);
    s?.cancel?.();
    this.sending.delete(id);
  }

  /** The one writer of the tab's saved focus, while on screen. The new call's draft comes with its first read. */
  private focusOn(taskId: string | null, kind: "logged" | "focus" | "moved"): void {
    if (!this.onScreen()) return;
    if (taskId === null) this.ports.session.remove(FOCUS);
    else this.ports.session.set(FOCUS, taskId);
    this.set({ focus: taskId, task: taskId === null ? null : { state: "loading" }, draft: EMPTY_DRAFT }, kind);
    if (taskId !== null) void this.taskReader.now();
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : "The request failed.");
