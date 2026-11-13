/**
 * The sending port (ADR 0003 5.3). Each sending channel has one. For email, the Instantly adapter
 * (`src/server/instantly/port.ts`, ticket 12c) implements it when a key is configured; otherwise
 * the running app registers `UnconnectedEmailPort`, which has no sender accounts, so every email
 * track meets launch blocker 3. For SMS no provider is provisioned or chosen (#28): the running app
 * registers `UnprovisionedSmsPort`, so every SMS track meets launch blocker 3. Tests use a fake SMS
 * provider (`test/support/fake-sms-port.ts`), which the running app never registers.
 */
import type { CallAnswer } from "../../domain/sequence/attempt.ts";
import type { RenderedCopy, RejectReason } from "../../domain/sequence/state.ts";
import type { SenderAccountConfig } from "./engine-store.ts";

/** How one kind of send travels: whether a same-key repeat is safe, and whether lookup's not-sent is final. */
export interface Transport {
  readonly retryable: boolean;
  readonly notSentIsFinal: boolean;
  /**
   * False when the port has no way to send this kind of step yet, such as Instantly's continue-thread
   * follow-ups before ADR 0002's experiment X2: the engine claims no such step, so it waits, and
   * nothing is sent for it. Absent means available.
   */
  readonly available?: boolean;
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
  readonly trackId: string;
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
  /** A hard bounce of an email, or a text the SMS provider reports undeliverable to an invalid number. */
  | { readonly id: string; readonly kind: "bounced"; readonly key: string; readonly providerRef: string; readonly at: number }
  /**
   * A reply: the thread it answers (`providerRef`, null when it starts a new conversation), the
   * inbox it reached and the address it came from. The adapter reduces the sender to a bare,
   * lower-case address ("Name <x@y>" becomes "x@y") before the engine matches it. An SMS reply has
   * no thread: `inbox` is the sender number it reached and `from` the mobile, both in E.164 form,
   * and the engine attributes it by the conversation's owner (ADR 0003 4.5).
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
  readonly channel: "email" | "sms";
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

/**
 * The running app's SMS port: no SMS provider is provisioned or chosen (#28), so it has no sender
 * numbers, every SMS track meets launch blocker 3, and it never sends. Nothing here makes a
 * network call.
 */
export class UnprovisionedSmsPort implements SendPort {
  readonly channel = "sms";
  transportFor(): Transport {
    return { retryable: false, notSentIsFinal: false, available: false };
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
