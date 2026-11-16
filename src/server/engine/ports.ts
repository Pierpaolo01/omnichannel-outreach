/**
 * The sending port (ADR 0003 5.3). Each sending channel has one. For email, the Instantly adapter
 * (`src/server/instantly/port.ts`, ticket 12c) implements it when a key is configured; otherwise
 * the running app registers `UnconnectedEmailPort`, which has no sender accounts, so every email
 * track meets launch blocker 3. For SMS no provider is provisioned or chosen (#28): the running app
 * registers `UnprovisionedSmsPort`, so every SMS track meets launch blocker 3. Tests use a fake SMS
 * provider (`test/support/fake-sms-port.ts`), which the running app never registers. For LinkedIn no session is connected
 * (#28; ADR 0004): the running app registers `UnconnectedLinkedInPort`, which lists no session, so every LinkedIn track
 * meets launch blocker 3; tests use `test/support/fake-linkedin-port.ts`, which the running app never registers.
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
  /**
   * A social step's action (ADR 0004 2.1): an invite, whose note is `rendered.body` (empty: no note, decided in the handover
   * transaction), or a message. Absent on email and SMS.
   */
  readonly action?: "invite" | "message";
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
  /**
   * A hard bounce of an email, or for SMS a number the carrier reports invalid after the send (not
   * a mobile, unallocated, permanently unreachable). It marks the detail bad for every campaign. An
   * SMS adapter must never report a transient failure (a handset off, a full queue, a carrier
   * outage, a filtered message) as `bounced`; such a failure is no event the engine acts on.
   */
  | { readonly id: string; readonly kind: "bounced"; readonly key: string; readonly providerRef: string; readonly at: number }
  /**
   * A reply: the thread it answers (`providerRef`, null when it starts a new conversation), the
   * inbox it reached and the address it came from. The adapter reduces the sender to a bare,
   * lower-case address ("Name <x@y>" becomes "x@y") before the engine matches it. An SMS reply has
   * no thread: `inbox` is the sender number it reached and `from` the mobile, both in E.164 form,
   * and the engine attributes it by the conversation's owner (ADR 0003 4.5).
   */
  | { readonly id: string; readonly kind: "reply"; readonly providerRef: string | null; readonly at: number; readonly inbox: string; readonly from: string }
  | { readonly id: string; readonly kind: "rejected"; readonly key: string; readonly providerRef: string; readonly reason: RejectReason }
  /** A LinkedIn invite accepted, at the platform's time (ADR 0004 3.3): the invite's work by its key. Never a reply. */
  | { readonly id: string; readonly kind: "accepted"; readonly key: string; readonly providerRef: string; readonly at: number };

/** A send confirmed by lookup carries the provider's reference, so its thread is known (ruling 1). */
export type LookupResult = { readonly kind: "sent"; readonly sentAt: number; readonly providerRef: string } | { readonly kind: "queued" } | { readonly kind: "not-sent" } | { readonly kind: "unknown" };

export interface AccountStatus extends SenderAccountConfig {
  /** False while the provider's quota is exhausted (402); a quota wait ends when it is confirmed again. */
  readonly quotaAvailable: boolean;
}

/** What the pre-send check asks of a port. */
export interface PresendRequest {
  readonly sender: string;
  readonly destination: string;
  readonly threadRefs: readonly string[];
  /** The replies the lead's record already holds on this channel, by the reply event's own id (`portReplyId`): not news. */
  readonly knownReplies: readonly string[];
}

/** A pre-send check's answer. `connected`: for LinkedIn, the sender is already connected to the profile (ADR 0004 3.3). */
export type PresendResult = { readonly kind: "clear" } | { readonly kind: "reply"; readonly providerRef: string; readonly at: number } | { readonly kind: "unavailable" } | { readonly kind: "connected" };

/** A LinkedIn invite withdrawal's answer (ADR 0004 3.3): withdrawn, found accepted first (with the platform's time), or unknown. */
export type InviteWithdrawal = { readonly kind: "withdrawn" } | { readonly kind: "already_accepted"; readonly at: number | null } | { readonly kind: "unknown" };

export interface SendPort {
  readonly channel: "email" | "sms" | "linkedin";
  /** Openers and follow-ups may travel differently (ADR 0002). */
  transportFor(step: { readonly threading: "new_subject" | "continue_thread" }): Transport;
  accounts(): Promise<AccountStatus[]>;
  /**
   * The provider's freshness (ADR 0003 "Ticket 20a"): the instant of its last actual round trip, and for how long that
   * stands for "it answers". A port that answers some calls from a cache (the Instantly adapter between polls) reports
   * this; for any other port the engine takes the instant a call to it resolved, fresh for ENGINE_CONTACT_FRESH_MS.
   */
  contact?(): { readonly at: number | null; readonly freshForMs: number };
  /**
   * ADR 0002's pre-send reply check: a reply in any of the lead's threads that is not one of `knownReplies` (the replies
   * the lead's record holds, by the identity the reply event carries) stops the send; `unavailable` when every thread
   * could not be read whole (ticket 17a; review bot on ca8baee, item 1).
   * A `reply` answer's `providerRef` is the id of the reply event `observe` reports (or will report) for that same reply,
   * never another form of it, so the pre-send check and the observation name one reply alike (the reply identity rule).
   * A reply's id is unique within the provider account and never reused for another reply.
   */
  presendCheck(request: PresendRequest): Promise<PresendResult>;
  handover(request: HandoverRequest): Promise<CallAnswer>;
  /** A social port's invite withdrawal (ADR 0004 2.1): asked of the invite's work after its acceptance wait ended. */
  withdrawInvite?(invite: AttemptRef): Promise<InviteWithdrawal>;
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

/**
 * The running app's LinkedIn port (ADR 0004 1.1): no LinkedIn session is connected, and the repository's rules allow no new
 * account connection (#28). It lists no session, so every LinkedIn track meets launch blocker 3, and it never acts. Nothing
 * here opens a browser or makes a network call.
 */
export class UnconnectedLinkedInPort implements SendPort {
  readonly channel = "linkedin";
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
  withdrawInvite(): Promise<InviteWithdrawal> {
    return Promise.resolve({ kind: "unknown" });
  }
  observe(checkpoint: string | null): Promise<{ events: ProviderEvent[]; checkpoint: string }> {
    return Promise.resolve({ events: [], checkpoint: checkpoint ?? "" });
  }
  lookup(): Promise<LookupResult> {
    return Promise.resolve({ kind: "unknown" });
  }
}

/** A provider call's result, as the engine classifies it (ticket 20a; review bot on 592d679). */
export type PortCallResult =
  | { readonly call: "presendCheck"; readonly result: Awaited<ReturnType<SendPort["presendCheck"]>> }
  | { readonly call: "handover"; readonly result: CallAnswer }
  | { readonly call: "withdraw"; readonly result: Awaited<ReturnType<SendPort["withdraw"]>> }
  | { readonly call: "lookup"; readonly result: LookupResult }
  | { readonly call: "withdrawInvite"; readonly result: InviteWithdrawal };

/** Whether a call reached the provider and was answered, or failed. Only `answered` is contact. */
export type CallOutcome = "answered" | "failed";

const unreachable = (value: never): never => {
  throw new Error(`a provider result the engine does not know: ${JSON.stringify(value)}`);
};

/**
 * The one classification of a provider call's result (ticket 20a; review bot on 592d679): an answer the provider gave is
 * contact; a failure resolved as a value (`unavailable`, `unknown`) is evidence of failure, never of contact, as are a
 * timeout and a thrown error, which never reach here. Exhaustive: a result kind a port adds fails typecheck until it is
 * classified.
 */
export function callOutcome(r: PortCallResult): CallOutcome {
  switch (r.call) {
    case "presendCheck":
      switch (r.result.kind) {
        case "clear":
        case "reply":
        case "connected":
          return "answered";
        case "unavailable":
          return "failed";
        default:
          return unreachable(r.result);
      }
    case "handover":
      switch (r.result.kind) {
        case "accepted":
        case "rejected":
          return "answered";
        case "unknown":
          return "failed";
        default:
          return unreachable(r.result);
      }
    case "withdraw": {
      const answer = r.result;
      switch (answer) {
        case "withdrawn":
        case "too-late":
          return "answered";
        case "unknown":
          return "failed";
        default:
          return unreachable(answer);
      }
    }
    case "withdrawInvite":
      switch (r.result.kind) {
        case "withdrawn":
        case "already_accepted":
          return "answered";
        case "unknown":
          return "failed";
        default:
          return unreachable(r.result);
      }
    case "lookup":
      switch (r.result.kind) {
        case "sent":
        case "queued":
        case "not-sent":
          return "answered";
        case "unknown":
          return "failed";
        default:
          return unreachable(r.result);
      }
    default:
      return unreachable(r);
  }
}
