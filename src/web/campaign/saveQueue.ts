/**
 * The campaign editor's one ordered path to the server (ticket 12c, PR 41 review). Every write of
 * the draft goes through `save`: the debounce after an edit, leaving the page, the pool following
 * the provider's inboxes, and launch, which goes ahead only when its save succeeded.
 *
 * Saves run one at a time, in the order asked; each sends the newest draft when it starts, so an
 * older draft can never land after a newer one, and saves asked for while one is in flight
 * coalesce into one more request. A save resolves `ok` only when the server has accepted the
 * newest revision. No React here, so it is tested on its own.
 */
import type { CampaignDefinition, SequenceView } from "../../shared/api.ts";

export type SaveStatus = { readonly kind: "idle" | "saving" | "saved" } | { readonly kind: "error"; readonly message: string };

export type SaveOutcome =
  | { readonly ok: true }
  /** The draft would be refused, or the request failed: the server keeps an older definition. */
  | { readonly ok: false; readonly reason: "invalid" | "failed"; readonly message: string }
  /** Saved, but a newer edit arrived meanwhile and is still to be sent. */
  | { readonly ok: false; readonly reason: "changed" };

export interface SaveQueueDeps {
  /** The draft as it stands now, and the inboxes the provider reports (the email track's pool). */
  read(): { readonly draft: CampaignDefinition; readonly accountIds: readonly string[] };
  put(definition: CampaignDefinition, options: { readonly keepalive?: boolean }): Promise<SequenceView>;
  onStatus(status: SaveStatus): void;
  /** The server accepted a save; `current` when no edit came after the draft it carried. */
  onAccepted(view: SequenceView, current: boolean): void;
}

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
      });
  }
  return problems;
}

export class SaveQueue {
  private revision = 0;
  private accepted = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly deps: SaveQueueDeps;

  constructor(deps: SaveQueueDeps) {
    this.deps = deps;
  }

  /** The draft changed: the next save sends it. */
  edited(): void {
    this.revision++;
  }

  /** Whether the server has the newest revision. */
  get upToDate(): boolean {
    return this.accepted >= this.revision;
  }

  save(options: { readonly keepalive?: boolean } = {}): Promise<SaveOutcome> {
    const run = this.chain.then(() => this.step(options));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async step(options: { readonly keepalive?: boolean }): Promise<SaveOutcome> {
    if (this.upToDate) return { ok: true };
    const target = this.revision;
    const { draft, accountIds } = this.deps.read();
    const problems = draftProblems(draft);
    if (problems.length > 0) {
      const message = problems.join(" ");
      this.deps.onStatus({ kind: "error", message });
      return { ok: false, reason: "invalid", message };
    }
    this.deps.onStatus({ kind: "saving" });
    try {
      const view = await this.deps.put({ ...draft, emailPool: [...accountIds] }, options);
      this.accepted = Math.max(this.accepted, target);
      const current = this.revision === target;
      this.deps.onAccepted(view, current);
      this.deps.onStatus(current ? { kind: "saved" } : { kind: "saving" });
      return current ? { ok: true } : { ok: false, reason: "changed" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "The change wasn’t saved.";
      this.deps.onStatus({ kind: "error", message });
      return { ok: false, reason: "failed", message };
    }
  }
}
