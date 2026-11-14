/**
 * The campaign editor's one path to the server: the client half of the rule in ADR 0003 1.1.1.
 * Every way a save is sent reports its outcome here: the debounce after an edit, Try again,
 * launch, the pool following the provider's inboxes, leaving the page, and the page coming back
 * from the back-forward cache.
 *
 * The page is one editing session. Every edit takes the next number in it, and every save carries
 * the session, the number of the draft it sends, and the base: the revision the page last had
 * from the server. The server accepts a save that continues its session with a higher number or
 * that starts from the stored revision, answers a repeat of the same number and content with
 * success, and refuses the rest. So:
 *
 * - Chained saves run one at a time, each with the newest draft; saves asked for meanwhile
 *   coalesce into one more request.
 * - Leaving the page sends the newest draft at once (`keepalive`), even behind a save in flight;
 *   its answer reports here if the page survives. A draft is at most DEFINITION_MAX_BYTES, which
 *   such a request can always carry; a larger one is refused here and never sent.
 * - No answer is resent unchanged, a few times. `superseded` (an older save of this page arriving
 *   late) is not an error. `edit_conflict` means another page changed the campaign: the draft is
 *   kept and the status says so until the user loads the stored version.
 *
 * The status is "saved" exactly when the server has confirmed the newest number. Tested on its own
 * and, with the server rule, by saveQueue.generated.test.ts.
 */
import type { CampaignDefinition, SequenceView } from "../../shared/api.ts";
import { DEFINITION_MAX_BYTES, STEP_BODY_MAX, STEP_SUBJECT_MAX } from "../../shared/limits.ts";
import { trackLabel } from "../../shared/track-label.ts";

export type SaveStatus =
  | { readonly kind: "idle" | "saving" | "saved" }
  | { readonly kind: "error"; readonly message: string }
  /**
   * Another page changed the campaign since this one loaded it: the draft is kept. `saved` when this
   * page's newest edit was saved before the other change replaced it (a refused launch finds that),
   * so the page never says "Not saved" of an edit the server accepted.
   */
  | { readonly kind: "conflict"; readonly message: string; readonly saved: boolean };

export type SaveOutcome =
  | { readonly ok: true }
  /** The draft would be refused, or the server refused it: the server keeps another definition. */
  | { readonly ok: false; readonly reason: "invalid" | "failed" | "conflict"; readonly message: string }
  /** Saved, but a newer edit arrived meanwhile and is still to be sent. */
  | { readonly ok: false; readonly reason: "changed" };

/** The request got no answer: it may or may not have been stored. Resending it unchanged is safe. */
export class NoAnswer extends Error {
  constructor(message = "No answer from the server.") {
    super(message);
  }
}

/** Who sends a save (ADR 0003 1.1.1). */
export interface SaveIdentity {
  readonly session: string;
  readonly seq: number;
  readonly base: number;
}

export interface SaveQueueDeps {
  /** The draft as it stands, the inboxes the provider reports, and the revision the page last had from the server. */
  /** The draft, the connected email inboxes and SMS numbers its pools follow, and the revision the page last saw. */
  read(): { readonly draft: CampaignDefinition; readonly accountIds: readonly string[]; readonly smsNumberIds?: readonly string[]; readonly version: number };
  /**
   * Sends one save. Rejects with `NoAnswer` when no answer came, or with an error carrying the
   * server's `code` (`superseded`, `edit_conflict`, `too_large`) when the server refused it.
   */
  put(definition: CampaignDefinition, options: { readonly keepalive?: boolean; readonly signal?: AbortSignal }, save: SaveIdentity): Promise<SequenceView>;
  onStatus(status: SaveStatus): void;
  /** The server confirmed a save: its view, and the edit number it answered (see `edit`). */
  onAccepted(view: SequenceView, seq: number): void;
  /** The editing session's id; tests inject one. */
  session?: string;
  /** Waits before the next try after no answer; tests inject one that only records. */
  wait?: (ms: number) => Promise<void>;
}

/** The gaps between tries after no answer: a short drop costs one or two of them, not all at once. */
export const NO_ANSWER_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000] as const;

/** The size of a save's JSON body, with room for its identity. */
export const saveSize = (def: CampaignDefinition): number => new TextEncoder().encode(JSON.stringify(def)).length + 200;

/** Problems the server would refuse with, caught before sending so the user sees them in place. */
export function draftProblems(def: CampaignDefinition): string[] {
  const problems: string[] = [];
  const live = def.tracks.filter((t) => !t.removed);
  for (const track of live) {
    // Named by its own track and channel when the campaign has several tracks (ticket 13b).
    const where = live.length > 1 ? `${trackLabel(def, track).label}: ` : "";
    const noun = track.channel === "sms" ? "Text" : track.channel === "call" ? "Call" : "Email";
    const first = track.channel === "sms" ? "text" : track.channel === "call" ? "call" : "email";
    const call = track.channel === "call";
    if (track.window.length === 0) problems.push(`${where}Choose at least one ${call ? "calling" : "sending"} day.`);
    if (track.window.some((w) => w.start === w.end)) problems.push(`${where}${call ? "The calling hours start" : "The sending window starts"} and end${call ? "" : "s"} at the same hour.`);
    // A phone track's own skip limit (ADR 0003, ticket 14c), as the validator refuses it.
    const limit = track.callSkipLimitDays;
    if (call && limit !== undefined && !(Number.isInteger(limit) && limit >= 1)) problems.push(`${where}The call skip limit is a whole number of days, at least 1.`);
    track.steps
      .filter((s) => !s.removed)
      .forEach((s, i) => {
        if (i === 0 && s.waitDays !== 0) problems.push(`${where}${noun} 1 is the first ${first}, so it has no wait.`);
        if (i === 0 && track.channel === "email" && s.threading === "continue_thread") problems.push(`${where}Email 1 is the first email, so it needs its own subject.`);
        if (i > 0 && !(Number.isInteger(s.waitDays) && s.waitDays >= 0)) problems.push(`${where}${noun} ${i + 1}'s wait is a whole number of days, 0 or more.`);
        if (s.body.length > STEP_BODY_MAX) problems.push(`${where}${noun} ${i + 1} is longer than ${STEP_BODY_MAX.toLocaleString("en-GB")} characters.`);
        if (s.subject.length > STEP_SUBJECT_MAX) problems.push(`${where}${noun} ${i + 1}'s subject is longer than ${STEP_SUBJECT_MAX.toLocaleString("en-GB")} characters.`);
      });
  }
  if (saveSize(def) > DEFINITION_MAX_BYTES) problems.push(`The sequence is larger than ${DEFINITION_MAX_BYTES / 1024} KB, so it cannot be saved safely. Shorten the messages.`);
  return problems;
}

/** How many times one save is resent after no answer before it is reported as not saved. */
const NO_ANSWER_RETRIES = NO_ANSWER_BACKOFF_MS.length;

type Sent =
  | { readonly kind: "accepted" }
  | { readonly kind: "superseded" }
  | { readonly kind: "no_answer" }
  | { readonly kind: "conflict"; readonly message: string }
  | { readonly kind: "refused"; readonly message: string };

export class SaveQueue {
  readonly session: string;
  /** The newest edit's number in this session. */
  private seq = 0;
  /** The newest number the server confirmed. */
  private acceptedSeq = 0;
  /**
   * The number of the save another page's change refused, while no later save of this page has
   * been accepted: nothing more is sent until the stored version is loaded. A refusal of a number
   * this page has already got past, or a later accepted save, means the refusal no longer counts.
   */
  private conflictSeq: number | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly deps: SaveQueueDeps;
  /**
   * The body sent under each number: fixed when the number is first sent, so a retry is the same
   * save again (same content, same pool), never a false conflict (PR 41 council, item 4).
   */
  private sentBody: { readonly seq: number; readonly definition: CampaignDefinition } | null = null;
  /**
   * The one leave-save outstanding: the browser's 64 KiB budget covers every request that outlives
   * the page together, so a newer one cancels the one it supersedes (PR 41 council, item 11).
   */
  private leaveSave: AbortController | null = null;
  /** Ends a backoff wait early: the browser came back online. */
  private wakeUp: (() => void) | null = null;

  constructor(deps: SaveQueueDeps) {
    this.deps = deps;
    this.session = deps.session ?? crypto.randomUUID();
  }

  /** The draft changed: the next save sends it. */
  edited(): void {
    this.seq++;
  }

  /** The newest edit's number: the identity of the draft on the page, which an answer must match to replace it. */
  get edit(): number {
    return this.seq;
  }

  /** Whether the server has confirmed the newest edit. */
  get upToDate(): boolean {
    return this.confirmed();
  }

  /** Whether another page's change was found: the stored version must be loaded before saving again. */
  get inConflict(): boolean {
    return this.conflictSeq !== null;
  }

  /** A method, not the getter, inside `step`: the answer changes across each await. */
  private confirmed(): boolean {
    return this.acceptedSeq >= this.seq;
  }

  /** Another page changed the campaign, as a refused launch reports: the conflict state. */
  markConflict(message: string): void {
    this.conflictSeq = Math.max(this.conflictSeq ?? 0, this.seq, 1);
    this.deps.onStatus({ kind: "conflict", message, saved: this.confirmed() && this.seq > 0 });
  }

  /** The browser is online again: a save waiting after no answer tries at once. */
  wake(): void {
    this.wakeUp?.();
  }

  private pause(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wakeUp = resolve;
      void (this.deps.wait ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t))))(ms).then(resolve);
    }).finally(() => {
      this.wakeUp = null;
    });
  }

  /** The body for the newest number: built when it is first sent, then reused unchanged. */
  private bodyFor(seq: number): CampaignDefinition {
    if (this.sentBody?.seq === seq) return this.sentBody.definition;
    const { draft, accountIds, smsNumberIds } = this.deps.read();
    const definition = { ...draft, emailPool: [...accountIds], ...(smsNumberIds ? { smsPool: [...smsNumberIds] } : {}) };
    this.sentBody = { seq, definition };
    return definition;
  }

  /** The user loaded the stored version: what was typed before is set aside, and saving starts again from it. */
  loadedStored(): void {
    this.conflictSeq = null;
    this.acceptedSeq = this.seq;
    this.deps.onStatus({ kind: "idle" });
  }

  save(options: { readonly keepalive?: boolean } = {}): Promise<SaveOutcome> {
    const run = this.chain.then(() => this.step(options));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Leaving the page: sends the newest draft now, with a request that outlives the document, even
   * while an older save is in flight. If the page survives (kept for Back, or the navigation was
   * cancelled), its answer reports here like any other.
   */
  sendNow(): void {
    if (this.confirmed() || this.inConflict) return;
    const { draft, version } = this.deps.read();
    if (draftProblems(draft).length > 0) return;
    // At most one request that outlives the page: the newest carries everything, so the older one goes.
    this.leaveSave?.abort();
    const abort = new AbortController();
    this.leaveSave = abort;
    void this.send(this.bodyFor(this.seq), { keepalive: true, signal: abort.signal }, { session: this.session, seq: this.seq, base: version }).finally(() => {
      if (this.leaveSave === abort) this.leaveSave = null;
    });
  }

  /**
   * The page came back from the back-forward cache: whatever was unconfirmed is sent again. The
   * leave-save still outstanding is cancelled now, while the page is alive, and its save goes again
   * through the queue (the server answers a repeat unchanged). Chromium frees an aborted keepalive
   * request's share of the 64 KiB budget only once the abort has settled, so cancelling it only as
   * the next leave-save is sent would leave a large draft no room (PR 41 council, item 11).
   */
  restored(): Promise<SaveOutcome> {
    this.leaveSave?.abort();
    this.leaveSave = null;
    if (!this.confirmed() && !this.inConflict) this.deps.onStatus({ kind: "saving" });
    return this.save();
  }

  /** One request, whose outcome always reports into the queue. */
  private async send(definition: CampaignDefinition, options: { readonly keepalive?: boolean; readonly signal?: AbortSignal }, save: SaveIdentity): Promise<Sent> {
    try {
      const view = await this.deps.put(definition, options, save);
      if (save.seq > this.acceptedSeq) {
        this.acceptedSeq = save.seq;
        this.deps.onAccepted(view, save.seq);
      }
      // A later save of this page got in: an older one's conflict no longer counts.
      if (this.conflictSeq !== null && save.seq > this.conflictSeq) this.conflictSeq = null;
      if (!this.inConflict) this.deps.onStatus(this.confirmed() ? { kind: "saved" } : { kind: "saving" });
      return { kind: "accepted" };
    } catch (error) {
      if (error instanceof NoAnswer) return { kind: "no_answer" };
      const code = (error as { code?: unknown }).code;
      const message = error instanceof Error ? error.message : "The change wasn’t saved.";
      if (code === "superseded") return { kind: "superseded" };
      if (code === "edit_conflict") {
        // An older save than one already accepted: superseded, whatever it collided with.
        if (save.seq <= this.acceptedSeq) return { kind: "superseded" };
        this.conflictSeq = Math.max(this.conflictSeq ?? 0, save.seq);
        this.deps.onStatus({ kind: "conflict", message, saved: false });
        return { kind: "conflict", message };
      }
      if (save.seq === this.seq && !this.inConflict) this.deps.onStatus({ kind: "error", message });
      return { kind: "refused", message };
    }
  }

  private async step(options: { readonly keepalive?: boolean }): Promise<SaveOutcome> {
    for (let tries = 0; ; tries++) {
      if (this.inConflict) {
        return { ok: false, reason: "conflict", message: "This campaign was changed elsewhere. Load the saved version to carry on." };
      }
      if (this.confirmed()) {
        // A page with no edit of its own has saved nothing, so it claims nothing.
        if (this.seq > 0) this.deps.onStatus({ kind: "saved" });
        return { ok: true };
      }
      const seq = this.seq;
      const { draft, version } = this.deps.read();
      const problems = draftProblems(draft);
      if (problems.length > 0) {
        const message = problems.join(" ");
        this.deps.onStatus({ kind: "error", message });
        return { ok: false, reason: "invalid", message };
      }
      this.deps.onStatus({ kind: "saving" });
      const sent = await this.send(this.bodyFor(seq), options, { session: this.session, seq, base: version });
      if (sent.kind === "accepted") return this.confirmed() ? { ok: true } : { ok: false, reason: "changed" };
      if (sent.kind === "conflict") return { ok: false, reason: "conflict", message: sent.message };
      if (sent.kind === "refused") return { ok: false, reason: "failed", message: sent.message };
      if (sent.kind === "no_answer" && tries >= NO_ANSWER_RETRIES) {
        if (this.confirmed()) return { ok: true };
        const message = "No answer from the server, so the change may not be saved. Try again.";
        this.deps.onStatus({ kind: "error", message });
        return { ok: false, reason: "failed", message };
      }
      if (sent.kind === "no_answer") await this.pause(NO_ANSWER_BACKOFF_MS[tries] ?? 8_000);
      // Superseded, or no answer yet: look again; the same save is safe to resend.
    }
  }
}
