/**
 * The one place the editor's save state becomes words (re-check B13). The inspector's status, the
 * campaign tabs and the conflict notice all read it, so no two places can describe one state
 * differently. ADR 0003 1.1.1, invariant 3: never "Not saved" for an edit the server accepted.
 */
import type { SaveStatus } from "./saveQueue.ts";

export interface SaveWording {
  /** The short status: shown beside the inspector's title and on the Before launch tab. Null shows nothing. */
  readonly label: string | null;
  /** Something needs the user: an error or a conflict. The tab shows the label in place of its count. */
  readonly problem: boolean;
  /** What the conflict notice says beneath its heading, for a conflict; otherwise null. */
  readonly conflict: string | null;
}

const NOTHING: SaveWording = { label: null, problem: false, conflict: null };

export function saveWording(save: SaveStatus, launched: boolean): SaveWording {
  if (launched) return NOTHING;
  switch (save.kind) {
    case "idle":
      return NOTHING;
    case "saving":
      return { label: "Saving…", problem: false, conflict: null };
    case "saved":
      return { label: "Saved", problem: false, conflict: null };
    case "error":
      return { label: "Not saved", problem: true, conflict: null };
    case "conflict":
      return save.saved
        ? { label: "Changed elsewhere", problem: true, conflict: "Your last change was saved, then changed there. Load the saved version to carry on." }
        : { label: "Not saved", problem: true, conflict: "What you typed is still here, but it is not saved. Loading the saved version replaces it." };
  }
}
