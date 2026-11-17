/**
 * When a pending step goes, as the HTTP reads say it (ADR 0003 "Reads that say when"): the engine's `stepWhen` at the
 * read's instant, mapped once. Every read that states when a step goes uses this, so none does arithmetic beside it.
 */
import type { TrackChannelApi } from "../../shared/api.ts";
import type { StepWait, StepWhen } from "../../domain/sequence/dispatch.ts";
import type { StepWaitApi, StepWhenView } from "../../shared/api.ts";
import { dateOfDay } from "./call-views.ts";
import type { SubjectState } from "../../domain/sequence/state.ts";
import { noAllowanceOnAnySession } from "../../domain/sequence/dispatch.ts";

/**
 * How the reads say the engine's `sending_capacity` for a LinkedIn step no session it may use has any allowance for
 * (council on dee365d, item 15): `no_allowance`. The generated LinkedIn runs' mutation "no allowance reads as full for the
 * day" swaps it back; nothing else does.
 */
export const viewRules: { noAllowanceReadAs: "no_allowance" | "sending_capacity" } = { noAllowanceReadAs: "no_allowance" };

/** A wait as the reads say it: the engine's reason, with `sending_capacity` said as `no_allowance` where that is the cause. */
export function readWait(why: StepWait, state: SubjectState, trackId: string, now: number): StepWaitApi {
  return why === "sending_capacity" && noAllowanceOnAnySession(state, trackId, now) ? viewRules.noAllowanceReadAs : stepWaitApi(why);
}

/** A track's channel in the subject's definition in force (a removed track keeps its channel). */
export function channelOfTrack(state: SubjectState, trackId: string): TrackChannelApi {
  return state.campaign.definition.tracks.find((t) => t.id === trackId)?.channel ?? "email";
}

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
    case "sms_conversation_unsettled":
    case "no_window":
    case "no_transport":
    case "waiting_on_provider":
    case "reply_pending":
    case "no_destination":
    case "sender_slot":
    case "sender_unavailable":
    case "sender_rate_limited":
    case "sending_capacity":
    case "sender_waiting":
    case "call_capacity":
    case "on_call_list":
    case "call_hours_closed":
    case "awaiting_acceptance":
    case "invite_pending_elsewhere":
      return why;
    default: {
      const unhandled: never = why;
      throw new Error(`A reason a step waits that the reads cannot say: ${String(unhandled)}`);
    }
  }
}

/**
 * The read of `stepWhen(…, now)`: ready, a later instant, a call's day, or why it waits. `today` is the user's day number.
 * A wait carries its track's channel, so every reason is worded in that channel's words (council on b21af02, item 1): a
 * transport's wait names the transport's channel, which is the track's.
 */
export function stepWhenView(when: StepWhen, now: number, today: number, channel: TrackChannelApi, at?: { readonly state: SubjectState; readonly trackId: string }): StepWhenView {
  switch (when.kind) {
    case "waits":
      return {
        kind: "waits",
        why: at ? readWait(when.why, at.state, at.trackId, now) : stepWaitApi(when.why),
        channel: when.channel ?? channel,
        ...(when.until !== undefined ? { until: new Date(when.until).toISOString() } : {}),
      };
    case "ready":
      return { kind: "ready" };
    case "at":
      return when.at <= now ? { kind: "ready" } : { kind: "at", at: new Date(when.at).toISOString() };
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
