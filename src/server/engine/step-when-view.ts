/**
 * When a pending step goes, as the HTTP reads say it (ADR 0003 "Reads that say when"): the engine's `stepWhen` at the
 * read's instant, mapped once. Every read that states when a step goes uses this, so none does arithmetic beside it.
 */
import type { StepWait, StepWhen } from "../../domain/sequence/dispatch.ts";
import type { StepWaitApi, StepWhenView } from "../../shared/api.ts";
import { dateOfDay } from "./call-views.ts";

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
    case "no_transport":
    case "waiting_on_provider":
    case "reply_pending":
    case "no_destination":
    case "sender_slot":
    case "sender_unavailable":
    case "sender_rate_limited":
    case "sender_busy":
    case "sending_capacity":
    case "sender_waiting":
    case "call_capacity":
    case "on_call_list":
    case "call_hours_closed":
      return why;
    default: {
      const unhandled: never = why;
      throw new Error(`A reason a step waits that the reads cannot say: ${String(unhandled)}`);
    }
  }
}

/** The read of `stepWhen(…, now)`: due now at the read's own instant, a later instant, a call's day, or why it waits. `today` is the user's day number. */
export function stepWhenView(when: StepWhen, now: number, today: number): StepWhenView {
  switch (when.kind) {
    case "waits":
      return when.channel ? { kind: "waits", why: stepWaitApi(when.why), channel: when.channel } : { kind: "waits", why: stepWaitApi(when.why) };
    case "at":
      return when.at <= now ? { kind: "now" } : { kind: "at", at: new Date(when.at).toISOString() };
    case "call_day":
      return { kind: "call_day", day: dateOfDay(when.day), today: when.day <= today, now: when.at <= now };
    case "listed_for":
      return { kind: "listed_for", day: dateOfDay(when.day) };
    default: {
      const unhandled: never = when;
      throw new Error(`A step time the reads cannot say: ${String(unhandled)}`);
    }
  }
}
