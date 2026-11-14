/**
 * The campaign editor's state, as one object the page binds to (useSequence.ts) and the generated
 * save test drives directly (saveQueue.generated.test.ts): the draft and the last view the server
 * sent, the save status, launch in flight, the conflict, the pool sync, leaving and coming back.
 * Every write goes through the save queue (saveQueue.ts); ADR 0003 1.1.1 is the rule.
 *
 * Two rules of its own (ADR 0003 1.1.1, invariants 6 and 7):
 * - No answer replaces a draft newer than the one it answered. One mechanism for every answer
 *   (save, launch, load): each is asked against an edit number, the identity of the draft on the
 *   page, and `answer` replaces the draft only if that number is still the newest. While a launch
 *   or a load of the stored version is pending, authoring is locked, so the answer it waits for is
 *   always for the draft on the page.
 * - A conflict stays visible until the user resolves it, by loading the saved version, however
 *   much they type meanwhile.
 */
import type { CampaignDefinition, SequenceView } from "../../shared/api.ts";
import { SaveQueue, draftProblems, type SaveIdentity, type SaveOutcome, type SaveStatus } from "./saveQueue.ts";

export interface EditorSnapshot {
  readonly view: SequenceView;
  readonly draft: CampaignDefinition;
  readonly save: SaveStatus;
  /** The draft differs from what the server accepted: launch waits until it is saved. */
  readonly unsaved: boolean;
  /** A launch or a load of the stored version is in flight: authoring is locked until it answers. */
  readonly pending: "launch" | "load" | null;
  /**
   * Editing is locked: the campaign has launched, or a launch or a load is pending. The one value
   * both `update` and every authoring control read, so no control can stay enabled while its edit
   * would be dropped (PR 41 review).
   */
  readonly locked: boolean;
  readonly problems: readonly string[];
}

export interface EditorDeps {
  /** One PUT: rejects with `NoAnswer`, or with an error carrying the server's `code`. */
  put(body: CampaignDefinition & { save: SaveIdentity }, options: { readonly keepalive?: boolean; readonly signal?: AbortSignal }): Promise<SequenceView>;
  /** The launch POST for the revision on the page; rejects with an error carrying the server's `code`. */
  launch(definitionVersion: number): Promise<SequenceView>;
  /** The stored sequence, for "Load the saved version". */
  load(): Promise<SequenceView>;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** The queue's backoff between tries after no answer. */
  wait?: (ms: number) => Promise<void>;
  session?: string;
}

/** The connected email inboxes: the email pool follows them; the engine's SMS numbers are not inboxes. */
export const emailInboxIds = (view: SequenceView): string[] => view.accounts.filter((a) => a.channel === "email").map((a) => a.id);
/** The connected SMS numbers: the SMS pool follows them (ticket 13b). None in the running app, which has no SMS provider. */
export const smsNumberIds = (view: SequenceView): string[] => view.accounts.filter((a) => a.channel === "sms").map((a) => a.id);

/** How long after an edit its save is sent. */
export const SAVE_DELAY_MS = 600;

export class EditorStore {
  private state: EditorSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly queue: SaveQueue;
  private readonly deps: EditorDeps;
  private timer: unknown = null;

  constructor(initial: SequenceView, deps: EditorDeps) {
    this.deps = deps;
    this.state = { view: initial, draft: initial.definition, save: { kind: "idle" }, unsaved: false, pending: null, locked: initial.launchedAt !== null, problems: draftProblems(initial.definition) };
    this.queue = new SaveQueue({
      read: () => ({ draft: this.state.draft, accountIds: emailInboxIds(this.state.view), smsNumberIds: smsNumberIds(this.state.view), version: this.state.view.definitionVersion }),
      put: (definition, options, save) => deps.put({ ...definition, save }, options),
      onStatus: (status) => this.set({ save: status, unsaved: status.kind !== "saved" && status.kind !== "idle" }),
      // Saves land in order, so each accepted view is the newest; the draft only if no edit came after.
      onAccepted: (view, seq) => {
        this.answer(view, seq);
        this.syncPool();
      },
      ...(deps.wait ? { wait: deps.wait } : {}),
      ...(deps.session ? { session: deps.session } : {}),
    });
    this.syncPool();
  }

  getSnapshot = (): EditorSnapshot => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The newest edit's number (the pool sync counts as one): the identity of the draft on the page. */
  get edit(): number {
    return this.queue.edit;
  }

  get inConflict(): boolean {
    return this.queue.inConflict;
  }

  private set(change: Partial<EditorSnapshot>): void {
    const next = { ...this.state, ...change };
    this.state = { ...next, problems: change.draft ? draftProblems(next.draft) : next.problems, locked: next.view.launchedAt !== null || next.pending !== null };
    for (const l of this.listeners) l();
  }

  /**
   * An answer to something asked when the draft's edit number was `asked`: its view always, and its
   * draft only if no edit came since. Returns whether the draft was replaced.
   */
  private answer(view: SequenceView, asked: number): boolean {
    const current = asked === this.queue.edit;
    this.set(current ? { view, draft: view.definition } : { view });
    return current;
  }

  /** Runs a launch or a load with authoring locked; one at a time. */
  private async locked(kind: "launch" | "load", run: () => Promise<void>): Promise<void> {
    if (this.state.pending !== null) return;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.set({ pending: kind });
    try {
      await run();
    } finally {
      this.set({ pending: null });
    }
  }

  private launched(): boolean {
    return this.state.view.launchedAt !== null;
  }

  /** An edit by the user. Ignored once launched, and while a launch or a load is in flight. */
  update(change: (draft: CampaignDefinition) => CampaignDefinition): void {
    if (this.state.locked) return;
    this.queue.edited();
    // Shown at once, so a change is never labelled saved while it waits; a conflict stays shown,
    // now with an edit of its own that is not saved.
    const now = this.state.save;
    const save: SaveStatus = !this.queue.inConflict ? { kind: "saving" } : now.kind === "conflict" ? { ...now, saved: false } : now;
    this.set({ draft: change(this.state.draft), unsaved: true, save });
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.queue.save();
    }, SAVE_DELAY_MS);
  }

  /** The debounce fires now (a test, or leaving the campaign inside the app). */
  saveNow(): Promise<SaveOutcome> {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    if (this.launched()) return Promise.resolve({ ok: true });
    return this.queue.save();
  }

  retrySave(): void {
    void this.saveNow();
  }

  /** Leaving the page (`pagehide`): the newest draft goes at once, with a request that outlives it. */
  leavePage(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.queue.sendNow();
  }

  /** Back from the back-forward cache (`pageshow` with `persisted`). */
  restored(): Promise<SaveOutcome> {
    return this.queue.restored();
  }

  /** The browser is online again: a save waiting after no answer tries at once. */
  online(): void {
    this.queue.wake();
  }

  /** Leaving the campaign inside the app: a change still waiting is saved through the queue. */
  dispose(): void {
    if (this.timer !== null) void this.saveNow();
  }

  /**
   * The pools follow the providers' accounts, each on its own channel: a difference from what is
   * saved, for a channel with a live track, is saved as one edit (ADR 0003, ticket 13b).
   */
  private syncPool(): void {
    const view = this.state.view;
    if (view.launchedAt !== null) return;
    const live = (channel: "email" | "sms") => view.definition.tracks.some((t) => !t.removed && t.channel === channel);
    const same = (a: readonly string[], b: readonly string[]) => [...a].sort().join("\n") === [...b].sort().join("\n");
    const emailDiffers = live("email") && !same(view.definition.emailPool, emailInboxIds(view));
    const smsDiffers = live("sms") && !same(view.definition.smsPool ?? [], smsNumberIds(view));
    if ((!emailDiffers && !smsDiffers) || this.queue.inConflict) return;
    this.queue.edited();
    void this.queue.save();
  }

  /**
   * Saves through the queue first, and launches only if that succeeded, and only the revision on
   * the page. Authoring is locked until the answer. A refusal because the campaign changed
   * elsewhere is the conflict state, with "Load the saved version".
   */
  launch(): Promise<void> {
    return this.locked("launch", async () => {
      const saved = await this.queue.save();
      if (!saved.ok) {
        throw new Error(saved.reason === "changed" ? "A newer change is still being saved. Launch again once it is saved." : `Your latest change isn’t saved, so nothing was launched. ${saved.message}`);
      }
      const asked = this.queue.edit;
      try {
        this.answer(await this.deps.launch(this.state.view.definitionVersion), asked);
      } catch (error) {
        if ((error as { code?: unknown }).code === "changed_elsewhere") this.queue.markConflict(error instanceof Error ? error.message : "Changed elsewhere.");
        throw error;
      }
    });
  }

  /** After a conflict: the stored version replaces the draft. Authoring is locked until it arrives. */
  loadStored(): Promise<void> {
    return this.locked("load", async () => {
      const asked = this.queue.edit;
      if (!this.answer(await this.deps.load(), asked)) return;
      this.queue.loadedStored();
      this.syncPool();
    });
  }
}
