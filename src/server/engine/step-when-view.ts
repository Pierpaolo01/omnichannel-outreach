/**
 * When a pending step goes, as the HTTP reads say it (ADR 0003 "Reads that say when"): the engine's `stepWhen` at the
 * read's instant, mapped once. Every read that states when a step goes uses this, so none does arithmetic beside it.
 */
import type { StepWait, StepWhen } from "../../domain/sequence/dispatch.ts";
import type { StepWaitApi, StepWhenView } from "../../shared/api.ts";

/** Every reason the engine has for a step with no time, in one exhaustive switch. */
export function stepWaitApi(why: StepWait): StepWaitApi {
  switch (why) {
    case "campaign_not_launched":
    case "campaign_paused":
    case "lead_paused":
    case "callback":
    case "ended":
    case "with_provider":
    case "unresolved":
    case "render_failed":
    case "provider_skipped":
    case "no_thread":
    case "sms_conversation_taken":
    case "no_window":
    case "sender_unavailable":
    case "sending_capacity":
    case "call_capacity":
    case "on_call_list":
      return why;
    default: {
      const unhandled: never = why;
      throw new Error(`A reason a step waits that the reads cannot say: ${String(unhandled)}`);
    }
  }
}

/** The read of `stepWhen(…, now)`: due now at the read's own instant, a later instant, or why it waits. */
export function stepWhenView(when: StepWhen, now: number): StepWhenView {
  if (when.kind === "waits") return { kind: "waits", why: stepWaitApi(when.why) };
  return when.at <= now ? { kind: "now" } : { kind: "at", at: new Date(when.at).toISOString() };
}
