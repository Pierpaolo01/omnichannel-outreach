import { describe, expect, test } from "vitest";
import type { SaveStatus } from "./saveQueue.ts";
import { saveWording, type SaveWording } from "./saveWording.ts";

/**
 * Every editor save state against its wording (re-check B13). The table is keyed by every kind of
 * SaveStatus (`satisfies`), so a new state fails to compile here until it is worded.
 */
const STATES = {
  idle: [[{ kind: "idle" }, { label: null, problem: false, conflict: null }]],
  saving: [[{ kind: "saving" }, { label: "Saving…", problem: false, conflict: null }]],
  saved: [[{ kind: "saved" }, { label: "Saved", problem: false, conflict: null }]],
  error: [[{ kind: "error", message: "The server refused it." }, { label: "Not saved", problem: true, conflict: null }]],
  conflict: [
    [{ kind: "conflict", message: "Changed elsewhere.", saved: false }, { label: "Not saved", problem: true, conflict: "What you typed is still here, but it is not saved. Loading the saved version replaces it." }],
    // This page's change was accepted, then replaced by another page: never "Not saved" (invariant 3).
    [{ kind: "conflict", message: "Changed elsewhere.", saved: true }, { label: "Changed elsewhere", problem: true, conflict: "Your last change was saved, then changed there. Load the saved version to carry on." }],
  ],
} satisfies { [K in SaveStatus["kind"]]: [SaveStatus & { kind: K }, SaveWording][] };

describe("one wording for every save state", () => {
  for (const [kind, cases] of Object.entries(STATES)) {
    for (const [status, wording] of cases as [SaveStatus, SaveWording][]) {
      test(`${kind}${status.kind === "conflict" ? (status.saved ? ", this page's change saved" : ", not saved") : ""}`, () => {
        expect(saveWording(status, false)).toEqual(wording);
        // Once launched, no save state is shown.
        expect(saveWording(status, true)).toEqual({ label: null, problem: false, conflict: null });
      });
    }
  }
});
