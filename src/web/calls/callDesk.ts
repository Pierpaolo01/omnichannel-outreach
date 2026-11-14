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
  /** Why the call is off the list, as the server said when the refusal came; null if it could not be read. */
  readonly offList?: CallOffListView | null;
}

/** An accepted answer a desk other than the pressing tab's got: the pressing tab applies it as its own. */
interface AnswerRecord {
  readonly v: 1;
  readonly entry: OutboxEntry;
}

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
   * Asks, at once, for the exclusive lock `name` across the user's tabs, if no one holds it (Web
   * Locks, `ifAvailable`). Resolves to its release, or null when another holds it. A closed tab's
   * locks are released by the browser.
   */
  claim(name: string): Promise<(() => void) | null>;
  /**
   * Queues for the exclusive lock `name` and resolves to its release once granted, or to null if
   * `signal` aborts first (Web Locks with a signal). How a desk takes over an entry another desk
   * holds when that desk leaves.
   */
  wait(name: string, signal: AbortSignal): Promise<(() => void) | null>;
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
  | "refusal_dropped"
  | "pending_kept_after_answered_elsewhere"
  | "copied_tab_kept"
  | "no_wait_for_lock";

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
  /**
   * This tab's press while it is in the outbox, read from the outbox (never stored on its own):
   * `unconfirmed` after an attempt had no answer or while another tab sends it; `elsewhere` while
   * another Calls tab holds it and sends it.
   */
  readonly pending: (OutboxEntry & { readonly unconfirmed: boolean; readonly elsewhere: boolean }) | null;
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
  /** The queue as of its last successful read; `stale` after failed reads in a row, while it keeps showing (ADR 0003 4.4.1, "Freshness"). */
  readonly freshness: Freshness;
  /** Every outcome control reads this one value: an action is pending, or the focus left the list. */
  readonly locked: boolean;
  /** The note is over the server's limit; Log sends nothing. */
  readonly noteTooLong: boolean;
  /** Counts transitions that replace the controls under the user's keyboard focus, so the page can place it. */
  readonly transition: { readonly seq: number; readonly kind: "logged" | "refused" | "away" | "moved" | "focus" } | null;
}

const OUTBOX = "outreach.calls.outbox.";
const REFUSED = "outreach.calls.refused.";
const ANSWER = "outreach.calls.answer.";
const TAB_LOCK = "outreach.calls.tab.";
const DRAFT = "outreach.calls.draft.";
const FOCUS = "outreach.calls.focus";
const TAB = "outreach.calls.tab";
/** Backoff after no answer, in milliseconds; the last repeats. */
export const RETRY_MS = [1_000, 2_000, 4_000, 8_000] as const;

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

function readAnswer(raw: string | null): AnswerRecord | null {
  if (raw === null) return null;
  try {
    const x = JSON.parse(raw) as Partial<AnswerRecord> | null;
    return x?.v === 1 && x.entry && readEntry(JSON.stringify(x.entry)) ? (x as AnswerRecord) : null;
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
  private tab: string;
  private tabRelease: (() => void) | null = null;
  /** Requests whose answer this desk applied itself; any other own entry that leaves the outbox is resolved from its record. */
  private readonly answered = new Set<string>();
  private readonly resolving = new Set<string>();
  /** Requests this desk is asking the lock for, and those whose last attempt had no answer. */
  private readonly claiming = new Set<string>();
  private readonly unanswered = new Set<string>();
  /** The current opening; an answer for another life writes nothing but its outbox entry's removal. */
  private life = 0;
  private live = false;
  /** Entries this desk holds the lock of, by request id. */
  private readonly holding = new Map<string, Holding>();
  private readonly refresher: Refresher<CallsView & { readonly named: string | null; readonly life: number }>;
  private adoptAs: "focus" | "moved" = "focus";
  /** Lock requests queued for entries another desk holds, cancelled at `dispose`. */
  private readonly waiting = new Map<string, AbortController>();
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
    this.refresher = new Refresher({
      read: async (expected) => {
        const named = this.state.focus;
        const life = this.life;
        return { ...(await ports.calls(named, expected)), named, life };
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
      logged: null,
      refusal: null,
      away: null,
      refusedRecords: [],
      freshness: FRESH,
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
    const shown = new Set([next.away?.requestId, next.refusal?.requestId].filter((x): x is string => typeof x === "string"));
    // Pending is this tab's entry in the outbox, read now: never stored on its own.
    const own = this.entries().find((e) => e.tab === this.tab) ?? null;
    let pending: DeskSnapshot["pending"] = null;
    if (own) {
      const id = own.body.requestId;
      const elsewhere = !this.holding.has(id) && !this.claiming.has(id);
      pending = { ...own, unconfirmed: elsewhere || this.unanswered.has(id), elsewhere };
    } else if (this.fault("pending_kept_after_answered_elsewhere")) pending = this.state.pending;
    const previous = this.state.pending;
    if (previous && !pending && !this.answered.has(previous.body.requestId) && !this.resolving.has(previous.body.requestId)) {
      this.resolving.add(previous.body.requestId);
      queueMicrotask(() => void this.resolveElsewhere(previous, this.life));
    }
    const locked = (pending !== null && !this.fault("no_lock_while_pending")) || next.away !== null;
    this.state = {
      ...next,
      pending,
      refusedRecords: this.records().filter((x) => !shown.has(x.entry.body.requestId)),
      locked,
      numberProblem: numberProblemOf(next.draft, next.task),
      noteTooLong: next.draft.note.length > NOTE_MAX,
      transition: transition ? { seq: ++this.seq, kind: transition } : next.transition,
    };
    for (const l of this.listeners) l();
  }

  /**
   * Opens the page (again, after `dispose`). The desk first holds its tab's identity: a tab whose id
   * another desk on screen holds is a copy (a duplicated tab) and takes a new id. Then this tab's
   * unanswered press shows as pending, every entry is claimed, and the queue loads.
   */
  async start(): Promise<void> {
    this.life++;
    const life = this.life;
    if (!this.fault("copied_tab_kept")) {
      let release = await this.ports.claim(TAB_LOCK + this.tab);
      if (release === null) {
        this.tab = this.ports.newId();
        this.ports.session.set(TAB, this.tab);
        release = await this.ports.claim(TAB_LOCK + this.tab);
      }
      if (life !== this.life) {
        release?.();
        return;
      }
      this.tabRelease = release;
    }
    this.live = true;
    this.refresher.start();
    this.state = { ...this.state, focus: this.ports.session.get(FOCUS) };
    const own = this.entries().find((e) => e.tab === this.tab);
    this.claimAll();
    // An outcome of this tab answered elsewhere while it was away from Calls: applied first, as its own
    // answer, so the page never shows the call's next draft before saying the last one was logged.
    const answers: Promise<void>[] = [];
    for (const key of this.ports.local.keys()) {
      if (!key.startsWith(ANSWER)) continue;
      const record = readAnswer(this.ports.local.get(key));
      if (record && record.entry.tab === this.tab && !this.resolving.has(record.entry.body.requestId)) {
        this.resolving.add(record.entry.body.requestId);
        answers.push(this.resolveElsewhere(record.entry, life));
      }
    }
    await Promise.all(answers);
    if (!this.current(life)) return;
    if (own) {
      this.ports.session.set(FOCUS, own.taskId);
      this.set({ focus: own.taskId });
    } else this.set({});
    await this.refresh();
  }

  dispose(): void {
    this.live = false;
    this.life++;
    this.tabRelease?.();
    this.tabRelease = null;
    this.refresher.stop();
    for (const c of this.waiting.values()) c.abort();
    this.waiting.clear();
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
    for (const entry of this.entries()) {
      const id = entry.body.requestId;
      if (!this.holding.has(id) && !this.claiming.has(id) && !this.waiting.has(id)) void this.claimAndSend(entry, this.life);
    }
  }

  private async claimAndSend(entry: OutboxEntry, life: number): Promise<void> {
    const id = entry.body.requestId;
    if (this.waiting.has(id)) return;
    this.claiming.add(id);
    let release = this.fault("send_without_lock") ? () => undefined : await this.ports.claim(OUTBOX + id);
    this.claiming.delete(id);
    if (release === null) {
      if (this.current(life)) this.set({});
      if (this.fault("no_wait_for_lock") || !this.current(life)) return;
      // Another desk holds it: queue for the lock, so this desk takes it over when that desk leaves.
      const controller = new AbortController();
      this.waiting.set(id, controller);
      release = await this.ports.wait(OUTBOX + id, controller.signal);
      if (this.waiting.get(id) === controller) this.waiting.delete(id);
      if (release === null) return;
    }
    // Holding the lock, read the outbox again: an entry answered meanwhile is dropped (its answer record tells its tab).
    if (!this.current(life) || this.holding.has(id) || this.ports.local.get(OUTBOX + id) === null) {
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
    if (!this.live) return;
    this.claimAll();
    this.adoptAs = adoptAs;
    await this.refresher.now();
  }

  /** A failed read: the queue keeps showing, and says it may be out of date once the failures say so. */
  private readFailed(error: unknown, freshness: Freshness): void {
    if (!this.live) return;
    if (this.state.queue.state !== "ready") this.set({ queue: { state: "error", message: messageOf(error) }, freshness });
    else this.set({ freshness });
  }

  private async applyQueue(read: CallsView & { readonly named: string | null; readonly life: number }): Promise<void> {
    const { named, life, ...view } = read;
    const adoptAs = this.adoptAs;
    this.adoptAs = "focus";
    if (!this.current(life) || this.state.focus !== named) return;
    this.set({ queue: { state: "ready", view }, freshness: this.refresher.freshness() });
    if (named === null || this.fault("refresh_adopts_focus")) {
      if (view.focusTaskId !== named) this.focusOn(view.focusTaskId, adoptAs, life);
      else if (named !== null) await this.loadTask(named, life);
      return;
    }
    await this.loadTask(named, life);
    // The named call is no longer listed: say why, and keep showing it until the user moves on.
    const task = this.state.task;
    // While this tab's own answer is being applied from another desk's record, that answer says what happened, not this refresh.
    if (this.current(life) && this.resolving.size === 0 && view.focusTaskId !== named && this.state.focus === named && this.state.pending === null && this.state.away === null && task?.state === "ready" && task.view.offList !== null) {
      this.set({ away: { taskId: named, who: whoOf(task.view), offList: task.view.offList, requestId: null, message: null, note: this.state.draft.note } }, "away");
    }
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
    this.claiming.add(body.requestId);
    this.ports.local.set(OUTBOX + body.requestId, JSON.stringify(entry));
    if (this.fault("logged_when_sent")) this.set({ refusal: null, logged: { requestId: body.requestId, who: entry.who, body, task: task.view } });
    else this.set({ refusal: null });
    const life = this.life;
    void claimed.then((release) => {
      this.claiming.delete(body.requestId);
      if (release === null) {
        if (this.current(life)) this.set({});
        return;
      }
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
    }
    const id = entry.body.requestId;
    const key = OUTBOX + id;
    h.inFlight = true;
    const posted = this.ports.post(entry.taskId, entry.body);
    if (this.fault("outbox_removed_when_sent")) this.ports.local.remove(key);
    try {
      const answer = await posted;
      h.inFlight = false;
      const shownHere = this.current(h.life) && entry.tab === this.tab;
      // A definite answer is a fact about the action: its entry goes, whichever life sent it. One the
      // pressing tab will not see here is left as an answer record, which that tab applies as its own.
      if (shownHere) this.answered.add(id);
      else this.ports.local.set(ANSWER + id, JSON.stringify({ v: 1, entry } satisfies AnswerRecord));
      this.ports.local.remove(key);
      this.letGo(h);
      if (!this.current(h.life)) return;
      if (shownHere) this.accepted(entry, answer, h.life);
      else this.recovered(h.entry.body.requestId, h.life);
    } catch (error) {
      h.inFlight = false;
      if (isRefusal(error)) {
        const shownHere = this.current(h.life) && entry.tab === this.tab;
        if (shownHere) this.answered.add(id);
        let offList: CallOffListView | null = null;
        try {
          offList = (await this.ports.task(entry.taskId)).offList;
        } catch {
          offList = null;
        }
        // Every refusal is recorded before its entry goes, whoever answers it: the note is never dropped, even if this tab closes.
        if (!(this.fault("refusal_dropped") && entry.tab !== this.tab)) this.ports.local.set(REFUSED + id, JSON.stringify({ v: 1, entry, message: error.message, offList } satisfies RefusedRecord));
        this.ports.local.remove(key);
        this.letGo(h);
        if (!this.current(h.life)) return;
        if (shownHere) await this.refused(entry, error.message, h.life);
        else this.recovered(h.entry.body.requestId, h.life);
        return;
      }
      if (!this.current(h.life) || this.holding.get(h.entry.body.requestId) !== h) return;
      // No answer: the same action again, after the backoff, by this holder; the page says it is not confirmed yet.
      this.unanswered.add(id);
      this.set({});
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
    this.set({ logged, refusal: null, away: null });
    this.focusOn(answer.nextFocusTaskId, "logged", life);
  }

  /**
   * This tab's press left the outbox with its answer reached by another desk: applied here from that
   * desk's record, as if this desk had the answer; with no record, read from the server.
   */
  private async resolveElsewhere(entry: OutboxEntry, life: number): Promise<void> {
    const id = entry.body.requestId;
    try {
      if (!this.current(life)) return;
      const accepted = this.ports.local.get(ANSWER + id);
      const refusedRaw = this.ports.local.get(REFUSED + id);
      let view: CallTaskView | null = null;
      try {
        view = await this.ports.task(entry.taskId);
      } catch {
        view = null;
      }
      if (!this.current(life)) return;
      if (accepted !== null) {
        this.ports.local.remove(ANSWER + id);
        this.answered.add(id);
        if (view === null) return void this.refresh();
        this.ports.session.remove(DRAFT + entry.taskId);
        this.set({ logged: { requestId: id, who: entry.who, body: entry.body, task: view }, refusal: null, away: null });
        let next: CallsView;
        try {
          next = await this.ports.calls(null);
        } catch {
          return;
        }
        this.focusOn(next.focusTaskId, "logged", life);
        return;
      }
      this.answered.add(id);
      const record = refusedRaw === null ? null : (JSON.parse(refusedRaw) as RefusedRecord);
      if (this.state.focus !== entry.taskId) return void this.refresh();
      if (view !== null && view.offList === null) {
        if (record) this.set({ refusal: { requestId: id, message: record.message }, task: { state: "ready", view } }, "refused");
        return;
      }
      this.set(
        {
          away: { taskId: entry.taskId, who: entry.who, offList: view?.offList ?? record?.offList ?? null, requestId: record ? id : null, message: record?.message ?? null, note: entry.body.note },
          ...(view ? { task: { state: "ready" as const, view } } : {}),
        },
        record ? "refused" : "away",
      );
    } finally {
      this.resolving.delete(id);
    }
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
      this.set({ refusal: { requestId: entry.body.requestId, message }, task: { state: "ready", view } }, "refused");
      return;
    }
    this.set(
      {
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
