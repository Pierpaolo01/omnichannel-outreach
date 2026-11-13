/**
 * The call focus queue's state (ADR 0003 4.4.1): one object the Calls page binds (useCallDesk.ts) and
 * the generated test drives directly (callDesk.generated.test.ts). The server decides the queue, the
 * focus it names and every outcome's effect; this object only keeps what the user did safe:
 *
 * - Pressing Log turns the draft into an action with one request id and a fixed body, written to the
 *   outbox (shared by the user's tabs) before it is sent. It leaves the outbox only on a definite
 *   answer for its id: accepted (200) or refused (4xx). Without one it is sent again, same id, same
 *   body, by this page or by the next Calls page any tab opens.
 * - The page shows an action as logged only after an accepted answer for its id, and as refused only
 *   after a refusal for its id.
 * - The focus, the call the page is on, changes only on an accepted action of this tab (to the
 *   answer's next focus) or when the user chooses to move on after being told it left the list.
 * - `locked` is the one value every outcome control reads: an action is pending, or the focus left
 *   the list. It refuses draft changes and a second press.
 */
import type { CallOffListView, CallOutcomeAnswer, CallOutcomeApi, CallsView, CallTaskView } from "../../shared/api.ts";

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
  /** The tab that pressed it; a reloaded tab adopts its own entries as pending. */
  readonly tab: string;
  readonly taskId: string;
  /** The lead's name, so a reloaded page can say whose outcome it is logging. */
  readonly who: string;
  readonly body: OutcomeBody;
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
   * Test-only faults that break the rule on purpose, so the generated test can show it catches each
   * (ADR 0003 4.4.1). Never set by the page.
   */
  readonly faults?: ReadonlySet<DeskFault>;
}

export type DeskFault = "new_id_on_resend" | "logged_when_sent" | "outbox_removed_when_sent" | "refresh_adopts_focus" | "no_lock_while_pending";

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
  /** The action sent and not yet answered; `unconfirmed` after an attempt had no answer. */
  readonly pending: (OutboxEntry & { readonly unconfirmed: boolean }) | null;
  /** The last action of this page the server accepted, with the call as the server answered. */
  readonly logged: { readonly requestId: string; readonly who: string; readonly body: OutcomeBody; readonly task: CallTaskView } | null;
  /** The server refused an action on a call still on the list (a number marked bad meanwhile): the draft stays. */
  readonly refusal: { readonly requestId: string; readonly message: string } | null;
  /** The focused call left the list: refused, or found gone on a refresh. Shown until the user moves on. */
  readonly away: { readonly taskId: string; readonly who: string; readonly offList: CallOffListView | null; readonly requestId: string | null; readonly message: string | null; readonly note: string } | null;
  /** Every outcome control reads this one value: an action is pending, or the focus left the list. */
  readonly locked: boolean;
  /** The note is over the server's limit; Log sends nothing. */
  readonly noteTooLong: boolean;
  /** Counts transitions that replace the controls under the user's keyboard focus, so the page can place it. */
  readonly transition: { readonly seq: number; readonly kind: "logged" | "refused" | "away" | "moved" | "focus" } | null;
}

const OUTBOX = "outreach.calls.outbox.";
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

export class CallDesk {
  private state: DeskSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly ports: CallDeskPorts;
  private readonly tab: string;
  private disposed = false;
  private cancelRetry: (() => void) | null = null;
  private tries = 0;
  private seq = 0;
  /** Bumped on every focus change, so an answer for an earlier focus is ignored. */
  private loadGeneration = 0;

  constructor(ports: CallDeskPorts) {
    this.ports = ports;
    let tab = ports.session.get(TAB);
    if (!tab) {
      tab = ports.newId();
      ports.session.set(TAB, tab);
    }
    this.tab = tab;
    this.state = { queue: { state: "loading" }, focus: ports.session.get(FOCUS), task: null, draft: EMPTY_DRAFT, pending: null, logged: null, refusal: null, away: null, locked: false, noteTooLong: false, transition: null };
  }

  getSnapshot = (): DeskSnapshot => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private fault(f: DeskFault): boolean {
    return this.ports.faults?.has(f) ?? false;
  }

  private set(patch: Partial<DeskSnapshot>, transition?: NonNullable<DeskSnapshot["transition"]>["kind"]): void {
    if (this.disposed) return;
    const next = { ...this.state, ...patch };
    const locked = (next.pending !== null && !this.fault("no_lock_while_pending")) || next.away !== null;
    this.state = { ...next, locked, noteTooLong: next.draft.note.length > NOTE_MAX, transition: transition ? { seq: ++this.seq, kind: transition } : next.transition };
    for (const l of this.listeners) l();
  }

  /** Opens the page (again, after `dispose`): resends what the outbox holds (this tab's as its pending action), then loads the queue. */
  async start(): Promise<void> {
    this.disposed = false;
    const entries: { key: string; entry: OutboxEntry }[] = [];
    for (const key of this.ports.local.keys()) {
      if (!key.startsWith(OUTBOX)) continue;
      const entry = readEntry(this.ports.local.get(key));
      // An entry this page cannot read is discarded; nothing is sent for it (the boundary).
      if (!entry) this.ports.local.remove(key);
      else entries.push({ key, entry });
    }
    const own = entries.find((e) => e.entry.tab === this.tab);
    if (own) {
      this.set({ focus: own.entry.taskId, pending: { ...own.entry, unconfirmed: true } });
      this.ports.session.set(FOCUS, own.entry.taskId);
      void this.send(own.entry);
    }
    // Another tab's actions, perhaps of a tab closed for good: sent again (the same id is logged once).
    for (const { entry } of entries) if (entry !== own?.entry) void this.flush(entry);
    await this.refresh();
  }

  dispose(): void {
    this.cancelRetry?.();
    this.disposed = true;
  }

  /**
   * Reloads the queue naming the focus, and the focused call. Never moves a focus it names; with none
   * named (the list was empty, or the user moved on) it takes the server's, as `adoptAs`.
   */
  async refresh(adoptAs: "focus" | "moved" = "focus"): Promise<void> {
    if (this.disposed) return;
    const named = this.state.focus;
    let view: CallsView;
    try {
      view = await this.ports.calls(named);
    } catch (error) {
      if (this.state.queue.state !== "ready") this.set({ queue: { state: "error", message: messageOf(error) } });
      return;
    }
    if (this.state.focus !== named) return;
    this.set({ queue: { state: "ready", view } });
    if (named === null || this.fault("refresh_adopts_focus")) {
      if (view.focusTaskId !== named) this.focusOn(view.focusTaskId, adoptAs);
      else if (named !== null) await this.loadTask(named);
      return;
    }
    await this.loadTask(named);
    // The named call is no longer listed: say why, and keep showing it until the user moves on.
    const task = this.state.task;
    if (view.focusTaskId !== named && this.state.focus === named && this.state.pending === null && this.state.away === null && task?.state === "ready" && task.view.offList !== null) {
      this.set({ away: { taskId: named, who: whoOf(task.view), offList: task.view.offList, requestId: null, message: null, note: this.state.draft.note } }, "away");
    }
  }

  /** The user changes the draft of the focused call; refused while locked. */
  setDraft(patch: Partial<Draft>): void {
    if (this.state.locked || this.state.focus === null) return;
    const draft = { ...this.state.draft, ...patch };
    this.ports.session.set(DRAFT + this.state.focus, JSON.stringify(draft));
    this.set({ draft, refusal: null });
  }

  /** The user presses Log: the draft becomes one action, stored before it is sent. */
  log(): void {
    const { draft, focus, task } = this.state;
    if (this.state.locked || this.state.pending !== null && !this.fault("no_lock_while_pending")) return;
    if (focus === null || task?.state !== "ready" || draft.outcome === null || this.state.noteTooLong) return;
    const body: OutcomeBody = {
      requestId: this.ports.newId(),
      outcome: draft.outcome,
      numberId: draft.outcome === "skip_for_now" ? null : draft.numberId,
      note: draft.note,
      noteScope: task.view.person === null ? "company" : draft.noteScope,
    };
    const entry: OutboxEntry = { v: 1, tab: this.tab, taskId: focus, who: whoOf(task.view), body };
    this.ports.local.set(OUTBOX + body.requestId, JSON.stringify(entry));
    this.tries = 0;
    if (this.fault("logged_when_sent")) this.set({ pending: { ...entry, unconfirmed: false }, refusal: null, logged: { requestId: body.requestId, who: entry.who, body, task: task.view } });
    else this.set({ pending: { ...entry, unconfirmed: false }, refusal: null });
    void this.send(entry);
  }

  /** Sends the pending action again now (Try again, back online). */
  retryNow(): void {
    const pending = this.state.pending;
    if (!pending) return;
    this.cancelRetry?.();
    this.cancelRetry = null;
    void this.send(pending);
  }

  /** After the page said the focus left the list: open the call the server puts first now. */
  async moveOn(): Promise<void> {
    const away = this.state.away;
    if (!away || this.state.pending !== null) return;
    this.ports.session.remove(DRAFT + away.taskId);
    this.ports.session.remove(FOCUS);
    this.loadGeneration++;
    this.set({ away: null, focus: null, task: null, draft: EMPTY_DRAFT, refusal: null }, "moved");
    await this.refresh("moved");
  }

  private async send(entry: OutboxEntry): Promise<void> {
    let body = entry.body;
    if (this.fault("new_id_on_resend") && this.tries > 0) {
      body = { ...body, requestId: this.ports.newId() };
      this.ports.local.remove(OUTBOX + entry.body.requestId);
      entry = { ...entry, body };
      this.ports.local.set(OUTBOX + body.requestId, JSON.stringify(entry));
      this.set({ pending: { ...entry, unconfirmed: true } });
    }
    const key = OUTBOX + body.requestId;
    const posted = this.ports.post(entry.taskId, body);
    if (this.fault("outbox_removed_when_sent")) this.ports.local.remove(key);
    try {
      const answer = await posted;
      this.ports.local.remove(key);
      if (this.state.pending?.body.requestId === body.requestId) this.accepted(entry, answer);
    } catch (error) {
      if (error instanceof Refused) {
        this.ports.local.remove(key);
        if (this.state.pending?.body.requestId === body.requestId) await this.refused(entry, error.message);
        return;
      }
      if (this.disposed || this.state.pending?.body.requestId !== body.requestId) return;
      // No answer: the same action again, after the backoff; the page says it is not confirmed yet.
      // Even if another tab has since had the answer, the same id answers this page with the same result.
      this.set({ pending: { ...entry, unconfirmed: true } });
      const delay = RETRY_MS[Math.min(this.tries, RETRY_MS.length - 1)] ?? 8_000;
      this.tries++;
      this.cancelRetry?.();
      this.cancelRetry = this.ports.setTimer(() => {
        this.cancelRetry = null;
        const current = this.state.pending;
        if (current && current.body.requestId === entry.body.requestId) void this.send(current);
      }, delay);
    }
  }

  /** Another tab's entry: sent once more; its answer only clears the outbox and refreshes the queue. */
  private async flush(entry: OutboxEntry): Promise<void> {
    try {
      await this.ports.post(entry.taskId, entry.body);
      this.ports.local.remove(OUTBOX + entry.body.requestId);
    } catch (error) {
      if (error instanceof Refused) this.ports.local.remove(OUTBOX + entry.body.requestId);
      return;
    }
    await this.refresh();
  }

  private accepted(entry: OutboxEntry, answer: CallOutcomeAnswer): void {
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.ports.session.remove(DRAFT + entry.taskId);
    const logged = { requestId: entry.body.requestId, who: entry.who, body: entry.body, task: answer.task };
    this.set({ pending: null, logged, refusal: null, away: null });
    this.focusOn(answer.nextFocusTaskId, "logged");
  }

  private async refused(entry: OutboxEntry, message: string): Promise<void> {
    this.cancelRetry?.();
    this.cancelRetry = null;
    let view: CallTaskView | null = null;
    try {
      view = await this.ports.task(entry.taskId);
    } catch {
      view = null;
    }
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

  private focusOn(taskId: string | null, kind: "logged" | "focus" | "moved"): void {
    this.loadGeneration++;
    if (taskId === null) this.ports.session.remove(FOCUS);
    else this.ports.session.set(FOCUS, taskId);
    const draft = (taskId === null ? null : readDraft(this.ports.session.get(DRAFT + taskId))) ?? EMPTY_DRAFT;
    this.set({ focus: taskId, task: taskId === null ? null : { state: "loading" }, draft }, kind);
    if (kind === "logged") void this.refresh();
    else if (taskId !== null) void this.loadTask(taskId);
  }

  private async loadTask(taskId: string): Promise<void> {
    const generation = this.loadGeneration;
    try {
      const view = await this.ports.task(taskId);
      if (generation !== this.loadGeneration || this.state.focus !== taskId) return;
      let draft = this.state.draft;
      if (this.state.task?.state !== "ready" || this.state.task.view.taskId !== taskId) draft = readDraft(this.ports.session.get(DRAFT + taskId)) ?? draft;
      // The number dialled starts at the first good one, as the server lists them (direct first).
      if (draft.numberId === null || !view.numbers.some((n) => n.detailId === draft.numberId && !n.bad)) draft = { ...draft, numberId: view.numbers.find((n) => !n.bad)?.detailId ?? null };
      if (view.person === null) draft = { ...draft, noteScope: "company" };
      this.set({ task: { state: "ready", view }, draft });
    } catch (error) {
      if (generation !== this.loadGeneration || this.state.focus !== taskId) return;
      if (this.state.task?.state !== "ready") this.set({ task: { state: "error", message: messageOf(error) } });
    }
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : "The request failed.");
