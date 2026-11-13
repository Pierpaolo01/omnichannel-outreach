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

export type SaveStatus =
  | { readonly kind: "idle" | "saving" | "saved" }
  | { readonly kind: "error"; readonly message: string }
  /** Another page changed the campaign since this one loaded it: the draft is kept, not saved. */
  | { readonly kind: "conflict"; readonly message: string };

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
  read(): { readonly draft: CampaignDefinition; readonly accountIds: readonly string[]; readonly version: number };
  /**
   * Sends one save. Rejects with `NoAnswer` when no answer came, or with an error carrying the
   * server's `code` (`superseded`, `edit_conflict`, `too_large`) when the server refused it.
   */
  put(definition: CampaignDefinition, options: { readonly keepalive?: boolean }, save: SaveIdentity): Promise<SequenceView>;
  onStatus(status: SaveStatus): void;
  /** The server confirmed a save; `current` when no edit came after the draft it carried. */
  onAccepted(view: SequenceView, current: boolean): void;
  /** The editing session's id; tests inject one. */
  session?: string;
}

/** The size of a save's JSON body, with room for its identity. */
export const saveSize = (def: CampaignDefinition): number => new TextEncoder().encode(JSON.stringify(def)).length + 200;

/** Problems the server would refuse with, caught before sending so the user sees them in place. */
export function draftProblems(def: CampaignDefinition): string[] {
  const problems: string[] = [];
  for (const track of def.tracks.filter((t) => !t.removed)) {
    if (track.window.length === 0) problems.push("Choose at least one sending day.");
    if (track.window.some((w) => w.start === w.end)) problems.push("The sending window starts and ends at the same hour.");
    track.steps
      .filter((s) => !s.removed)
      .forEach((s, i) => {
        if (i === 0 && s.waitDays !== 0) problems.push("Email 1 is the first email, so it has no wait.");
        if (i === 0 && s.threading === "continue_thread") problems.push("Email 1 is the first email, so it needs its own subject.");
        if (i > 0 && !(Number.isInteger(s.waitDays) && s.waitDays >= 0)) problems.push(`Email ${i + 1}'s wait is a whole number of days, 0 or more.`);
        if (s.body.length > STEP_BODY_MAX) problems.push(`Email ${i + 1} is longer than ${STEP_BODY_MAX.toLocaleString("en-GB")} characters.`);
        if (s.subject.length > STEP_SUBJECT_MAX) problems.push(`Email ${i + 1}'s subject is longer than ${STEP_SUBJECT_MAX.toLocaleString("en-GB")} characters.`);
      });
  }
  if (saveSize(def) > DEFINITION_MAX_BYTES) problems.push(`The sequence is larger than ${DEFINITION_MAX_BYTES / 1024} KB, so it cannot be saved safely. Shorten the emails.`);
  return problems;
}

/** How many times one save is resent after no answer before it is reported as not saved. */
const NO_ANSWER_RETRIES = 4;

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

  constructor(deps: SaveQueueDeps) {
    this.deps = deps;
    this.session = deps.session ?? crypto.randomUUID();
  }

  /** The draft changed: the next save sends it. */
  edited(): void {
    this.seq++;
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
    const { draft, accountIds, version } = this.deps.read();
    if (draftProblems(draft).length > 0) return;
    void this.send({ ...draft, emailPool: [...accountIds] }, { keepalive: true }, { session: this.session, seq: this.seq, base: version });
  }

  /** The page came back from the back-forward cache: whatever was unconfirmed is sent again. */
  restored(): Promise<SaveOutcome> {
    if (!this.confirmed() && !this.inConflict) this.deps.onStatus({ kind: "saving" });
    return this.save();
  }

  /** One request, whose outcome always reports into the queue. */
  private async send(definition: CampaignDefinition, options: { readonly keepalive?: boolean }, save: SaveIdentity): Promise<Sent> {
    try {
      const view = await this.deps.put(definition, options, save);
      if (save.seq > this.acceptedSeq) {
        this.acceptedSeq = save.seq;
        this.deps.onAccepted(view, save.seq === this.seq);
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
        this.deps.onStatus({ kind: "conflict", message });
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
      const { draft, accountIds, version } = this.deps.read();
      const problems = draftProblems(draft);
      if (problems.length > 0) {
        const message = problems.join(" ");
        this.deps.onStatus({ kind: "error", message });
        return { ok: false, reason: "invalid", message };
      }
      this.deps.onStatus({ kind: "saving" });
      const sent = await this.send({ ...draft, emailPool: [...accountIds] }, options, { session: this.session, seq, base: version });
      if (sent.kind === "accepted") return this.confirmed() ? { ok: true } : { ok: false, reason: "changed" };
      if (sent.kind === "conflict") return { ok: false, reason: "conflict", message: sent.message };
      if (sent.kind === "refused") return { ok: false, reason: "failed", message: sent.message };
      if (sent.kind === "no_answer" && tries >= NO_ANSWER_RETRIES) {
        if (this.confirmed()) return { ok: true };
        const message = "No answer from the server, so the change may not be saved. Try again.";
        this.deps.onStatus({ kind: "error", message });
        return { ok: false, reason: "failed", message };
      }
      // Superseded, or no answer yet: look again; the same save is safe to resend.
    }
  }
}
