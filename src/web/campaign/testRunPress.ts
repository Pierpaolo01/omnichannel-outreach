import type { KeyValue } from "../calls/callDesk.ts";

/**
 * A Run test or Stop test press, kept with its request id at the press (ticket 21; verifier F3 on 55d6ac6), on the
 * controls' rule that a stored press is never orphaned: until the server answers that id, a reload, another visit or
 * another tab shows it as pending and sends the same request again, which the server answers once (a request id is
 * bound to its first answer and body). Only an answer, accepted or refused, clears it; a failure with no answer keeps it.
 */
export interface TestRunPress {
  readonly v: 1;
  readonly kind: "run" | "stop";
  readonly requestId: string;
  readonly path: string;
  readonly body: unknown;
  readonly pressedAt: number;
}

const PREFIX = "outreach.test-run-press.";
const keyOf = (campaignId: string) => `${PREFIX}${campaignId}`;
export const isTestRunPressKey = (key: string | null): boolean => key?.startsWith(PREFIX) ?? false;

/** Keeps the press before it is sent. False when storage refused it: the press still goes, but only this page knows it. */
export function keepPress(store: KeyValue, campaignId: string, press: TestRunPress): boolean {
  return store.set(keyOf(campaignId), JSON.stringify(press));
}

/** The campaign's press still waiting for its answer, if any. */
export function pendingPress(store: KeyValue, campaignId: string): TestRunPress | null {
  const text = store.get(keyOf(campaignId));
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const p = value as Partial<TestRunPress>;
    return p.v === 1 && (p.kind === "run" || p.kind === "stop") && typeof p.requestId === "string" && typeof p.path === "string" && typeof p.pressedAt === "number" ? (p as TestRunPress) : null;
  } catch {
    return null;
  }
}

/** Clears the press once the server answered this id; a newer press under the same campaign is left alone. */
export function answered(store: KeyValue, campaignId: string, requestId: string): void {
  if (pendingPress(store, campaignId)?.requestId === requestId) store.remove(keyOf(campaignId));
}
