/**
 * The sending port (ADR 0003 5.3). Each sending channel has one; ticket 12b has email only. The
 * Instantly adapter (ticket 12c) implements this interface; until then the running app registers
 * `UnconnectedEmailPort`, which has no sender accounts, so every email track meets launch blocker 3.
 */
import type { CallAnswer } from "../../domain/sequence/attempt.ts";
import type { RenderedCopy, RejectReason } from "../../domain/sequence/state.ts";
import type { SenderAccountConfig } from "./engine-store.ts";

/** How one kind of send travels: whether a same-key repeat is safe, and whether lookup's not-sent is final. */
export interface Transport {
  readonly retryable: boolean;
  readonly notSentIsFinal: boolean;
}

export interface HandoverRequest {
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly sender: string;
  readonly destination: string;
  readonly rendered: RenderedCopy;
  readonly threadRef: string | null;
  /** Openers start a thread; follow-ups continue one. They may use different transports. */
  readonly threading: "new_subject" | "continue_thread";
  /** For the provider's own records (and the fakes' logs): which lead and step this is. */
  readonly subjectId: string;
  readonly stepId: string;
}

export interface AttemptRef {
  readonly idempotencyKey: string;
  readonly providerRef: string | null;
  readonly sender: string;
  readonly destination: string;
}

/** What the provider reports, each with its own id so a repeat is recognised. */
export type ProviderEvent =
  | { readonly id: string; readonly kind: "sent"; readonly key: string; readonly providerRef: string; readonly sentAt: number }
  | { readonly id: string; readonly kind: "bounced"; readonly key: string; readonly providerRef: string; readonly at: number }
  /**
   * A reply: the thread it answers (`providerRef`, null when it starts a new conversation), the
   * inbox it reached and the address it came from. The adapter reduces the sender to a bare,
   * lower-case address ("Name <x@y>" becomes "x@y") before the engine matches it.
   */
  | { readonly id: string; readonly kind: "reply"; readonly providerRef: string | null; readonly at: number; readonly inbox: string; readonly from: string }
  | { readonly id: string; readonly kind: "rejected"; readonly key: string; readonly providerRef: string; readonly reason: RejectReason };

/** A send confirmed by lookup carries the provider's reference, so its thread is known (ruling 1). */
export type LookupResult = { readonly kind: "sent"; readonly sentAt: number; readonly providerRef: string } | { readonly kind: "queued" } | { readonly kind: "not-sent" } | { readonly kind: "unknown" };

export interface AccountStatus extends SenderAccountConfig {
  /** False while the provider's quota is exhausted (402); a quota wait ends when it is confirmed again. */
  readonly quotaAvailable: boolean;
}

export interface SendPort {
  readonly channel: "email";
  /** Openers and follow-ups may travel differently (ADR 0002). */
  transportFor(step: { readonly threading: "new_subject" | "continue_thread" }): Transport;
  accounts(): Promise<AccountStatus[]>;
  /** ADR 0002's pre-send reply check. `unavailable` when it cannot run now. */
  presendCheck(request: { readonly sender: string; readonly destination: string; readonly threadRefs: readonly string[] }): Promise<{ readonly kind: "clear" } | { readonly kind: "reply"; readonly providerRef: string; readonly at: number } | { readonly kind: "unavailable" }>;
  handover(request: HandoverRequest): Promise<CallAnswer>;
  withdraw(attempt: AttemptRef): Promise<"withdrawn" | "too-late" | "unknown">;
  observe(checkpoint: string | null): Promise<{ readonly events: readonly ProviderEvent[]; readonly checkpoint: string }>;
  lookup(attempt: AttemptRef): Promise<LookupResult>;
}

/** The running app's email port until the Instantly adapter lands: no sender accounts, so nothing can launch. */
export class UnconnectedEmailPort implements SendPort {
  readonly channel = "email";
  transportFor(): Transport {
    return { retryable: false, notSentIsFinal: false };
  }
  accounts(): Promise<AccountStatus[]> {
    return Promise.resolve([]);
  }
  presendCheck(): Promise<{ kind: "unavailable" }> {
    return Promise.resolve({ kind: "unavailable" });
  }
  handover(): Promise<CallAnswer> {
    return Promise.resolve({ kind: "unknown" });
  }
  withdraw(): Promise<"unknown"> {
    return Promise.resolve("unknown");
  }
  observe(checkpoint: string | null): Promise<{ events: ProviderEvent[]; checkpoint: string }> {
    return Promise.resolve({ events: [], checkpoint: checkpoint ?? "" });
  }
  lookup(): Promise<LookupResult> {
    return Promise.resolve({ kind: "unknown" });
  }
}
